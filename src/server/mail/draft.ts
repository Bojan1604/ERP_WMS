import 'server-only';
import { db } from '../db';
import { assert, DomainError } from '../errors';
import type { SessionUser } from '../auth';
import { accountantRowsByIds } from '../queries/accountant';
import { can } from '@/domain/permissions';
import { ACCOUNTANT_ROW_CAP, parseKeys } from '@/domain/accountant';
import { fillTemplate, readTemplates, type MailTemplateKind } from '@/domain/mail';
import { quoteDocTitle, type MailKind, type PdfKind } from '@/domain/documents';
import { INVOICE_KIND_LABEL } from '@/domain/invoice';
import { formatDate, toISO } from '@/domain/dates';
import { num, r2 } from '@/domain/money';
import { eur } from '@/lib/format';
import { SERVICE_STATUS, isOpenService } from '@/components/service/labels';
import { isMailConfigured } from './transport';

/**
 * Prijedlog poruke za dijalog slanja: primatelj (e-adresa partnera ili
 * knjigovođe), naslov i tekst iz predloška firme s popunjenim varijablama,
 * vrsta PDF-a za privitak i je li SMTP podešen (inače mailto + preuzimanje).
 */
export interface EmailDraft {
  to: string;
  subject: string;
  body: string;
  /** SMTP je podešen — inače dijalog nudi mailto i preuzimanje PDF-a. */
  configured: boolean;
  /** PDF koji ide u privitak (null: partner / ZIP knjigovođi). */
  pdf: { kind: PdfKind; id: string } | null;
  /** Naziv dokumenta za prikaz („Račun 12-PP1-1"). */
  title: string;
}

/** Dokument koji se šalje, s varijablama predloška — zapis se traži samo u firmi korisnika. */
export interface ResolvedDoc {
  kind: MailKind;
  entityId: string;
  to: string;
  title: string;
  template: MailTemplateKind | null;
  vars: Record<string, string>;
  pdf: { kind: PdfKind; id: string } | null;
  /** accountant-zip: ključevi i dozvoljeni smjerovi. */
  zip?: { keys: string[]; allowed: { out: boolean; in: boolean } };
}

const d = (v: Date | null | undefined) => (v ? formatDate(toISO(v)) : '');

export async function resolveDoc(user: Pick<SessionUser, 'companyId' | 'perms'>, kind: MailKind, id: string, reminder = false): Promise<ResolvedDoc> {
  const companyId = user.companyId;
  const company = await db.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true, currency: true, proformaTitle: true, accountantEmail: true } });
  const cur = !company.currency || company.currency === 'EUR' ? '€' : company.currency;
  const base = { firma: company.name };

  switch (kind) {
    case 'invoice':
    case 'delivery': {
      const inv = await db.invoice.findFirst({
        where: { id, companyId },
        select: { id: true, status: true, kind: true, number: true, date: true, dueDate: true, grandTotal: true, advanceAmount: true, openAmount: true, partner: { select: { name: true, email: true } } },
      });
      if (!inv) throw new DomainError('Račun ne postoji.');
      assert(inv.status === 'ISSUED', 'Nacrt računa se ne šalje — prvo izdajte račun.');
      const payable = r2(num(inv.grandTotal) - num(inv.advanceAmount));
      const amount = reminder || num(inv.openAmount) > 0 ? num(inv.openAmount) : payable;
      return {
        kind,
        entityId: inv.id,
        to: inv.partner.email ?? '',
        title: kind === 'delivery' ? `Otpremnica uz račun ${inv.number}` : `${INVOICE_KIND_LABEL[inv.kind]} ${inv.number}`,
        template: kind === 'delivery' ? 'delivery' : reminder ? 'reminder' : 'invoice',
        vars: { ...base, broj: inv.number ?? '', kupac: inv.partner.name, iznos: eur(amount, cur), datum: d(inv.date), dospijece: d(inv.dueDate) || d(inv.date) },
        pdf: { kind: kind === 'delivery' ? 'delivery' : 'invoice', id: inv.id },
      };
    }
    case 'quote':
    case 'proforma': {
      const q = await db.quote.findFirst({
        where: { id, companyId },
        select: { id: true, kind: true, title: true, number: true, date: true, validUntil: true, grandTotal: true, partner: { select: { name: true, email: true } } },
      });
      if (!q) throw new DomainError('Ponuda ne postoji.');
      const proforma = q.kind === 'PROFORMA';
      const naslov = quoteDocTitle({ kind: 'PROFORMA', title: q.title }, company);
      return {
        kind,
        entityId: q.id,
        to: q.partner.email ?? '',
        title: `${proforma ? naslov : 'Ponuda'} ${q.number}`,
        template: proforma ? 'proforma' : 'quote',
        vars: { ...base, broj: q.number, kupac: q.partner.name, iznos: eur(num(q.grandTotal), cur), datum: d(q.date), vrijedi: d(q.validUntil), naslov },
        pdf: { kind: proforma ? 'proforma' : 'quote', id: q.id },
      };
    }
    case 'service': {
      const o = await db.serviceOrder.findFirst({
        where: { id, companyId },
        select: { id: true, number: true, status: true, reportedAt: true, partner: { select: { name: true, email: true } } },
      });
      if (!o) throw new DomainError('Servisni nalog ne postoji.');
      return {
        kind,
        entityId: o.id,
        to: o.partner?.email ?? '',
        title: `Servisni nalog ${o.number}`,
        template: 'service',
        vars: { ...base, broj: o.number, kupac: o.partner?.name ?? '', status: SERVICE_STATUS[o.status].label, datum: d(o.reportedAt) },
        // zatvoreni nalog ide kao nalog za dostavu (dijagnoza, rješenje, zamjena)
        pdf: { kind: isOpenService(o.status) ? 'service' : 'service-delivery', id: o.id },
      };
    }
    case 'partner': {
      const p = await db.partner.findFirst({ where: { id, companyId }, select: { id: true, name: true, email: true } });
      if (!p) throw new DomainError('Partner ne postoji.');
      return { kind, entityId: p.id, to: p.email ?? '', title: p.name, template: null, vars: { ...base, kupac: p.name }, pdf: null };
    }
    case 'accountant-zip': {
      const keys = id.split(',').map((k) => k.trim()).filter(Boolean);
      const ids = parseKeys(keys);
      assert(ids.out.length + ids.in.length > 0, 'Označite barem jedan dokument.');
      assert(ids.out.length <= ACCOUNTANT_ROW_CAP && ids.in.length <= ACCOUNTANT_ROW_CAP, `Najviše ${ACCOUNTANT_ROW_CAP} dokumenata po smjeru u jednoj arhivi.`);
      const allowed = { out: can(user.perms, 'sales', 'view'), in: can(user.perms, 'purchasing', 'view') };
      assert((allowed.out || !ids.out.length) && (allowed.in || !ids.in.length), 'Nemate pravo na neke od označenih dokumenata.');
      const rows = await accountantRowsByIds(companyId, ids);
      assert(rows.length === ids.out.length + ids.in.length, 'Neki dokumenti ne postoje.');
      const dates = rows.map((r) => r.date).sort();
      const list = rows.slice(0, 60).map((r) => `- ${r.dir === 'out' ? 'Izlazni' : 'Ulazni'} ${r.number} · ${r.partner} · ${eur(r.total, cur)}`);
      if (rows.length > 60) list.push(`… i još ${rows.length - 60}`);
      return {
        kind,
        entityId: `${ids.out.length} izlaznih, ${ids.in.length} ulaznih`,
        to: company.accountantEmail ?? '',
        title: `Dokumenti za knjigovodstvo (${rows.length})`,
        template: 'accountant',
        vars: { ...base, od: formatDate(dates[0]), do: formatDate(dates[dates.length - 1]), broj: String(rows.length), popis: list.join('\n') },
        pdf: null,
        zip: { keys: [...ids.out.map((x) => `out:${x}`), ...ids.in.map((x) => `in:${x}`)], allowed },
      };
    }
    default:
      throw new DomainError('Nepoznata vrsta poruke.');
  }
}

export async function buildEmailDraft(user: Pick<SessionUser, 'companyId' | 'perms'>, kind: MailKind, id: string, reminder = false): Promise<EmailDraft> {
  const [doc, c] = await Promise.all([
    resolveDoc(user, kind, id, reminder),
    db.company.findUniqueOrThrow({ where: { id: user.companyId }, select: { mailTemplates: true, smtpHost: true, mailFrom: true, email: true } }),
  ]);
  const tpl = doc.template ? readTemplates(c.mailTemplates)[doc.template] : null;
  return {
    to: doc.to,
    subject: tpl ? fillTemplate(tpl.subject, doc.vars) : '',
    body: tpl ? fillTemplate(tpl.body, doc.vars) : `Poštovani,\n\n\n\nLijep pozdrav,\n${doc.vars.firma}`,
    configured: isMailConfigured(c),
    pdf: doc.pdf,
    title: doc.title,
  };
}
