import 'server-only';
import { db } from '../db';
import { assert } from '../errors';
import { invoiceUbl } from '../fiscal/ubl-source';
import { renderDocumentPdf } from '../pdf';
import { ZipTooLargeError, ZipWriter, ZIP_MAX_BYTES, uniqueName } from '../zip';
import { accountantRowsByIds, NOT_GOODS_INVOICE, type AccountantAccess } from './accountant';
import { ACCOUNTANT_CSV_COLUMNS, ACCOUNTANT_ROW_CAP, fileStem, parseKeys } from '@/domain/accountant';
import { toCsv } from '@/lib/csv';

/**
 * ZIP za knjigovođu: popis.csv, eRačun XML i PDF svakog izdanog izlaznog računa i
 * spremljeni prilozi (izlazni/prilozi/…, ulazni/<broj>/… uz priloge knjiženog troška). Svaki ključ se
 * provjerava na firmu korisnika; nepostojeći se ne tiho preskaču. Bez prava `costs` iznosi računa za
 * robu nisu u popisu, a njihovi prilozi (i prilozi njihova troška) ne idu u arhivu.
 */
export async function buildAccountantZip(companyId: string, keys: string[], maxBytes = ZIP_MAX_BYTES, allowed: AccountantAccess = { out: true, in: true }) {
  const ids = parseKeys(keys);
  assert((allowed.out || !ids.out.length) && (allowed.in || !ids.in.length), 'Nemate pravo na neke od označenih dokumenata.');
  assert(ids.out.length + ids.in.length > 0, 'Označite barem jedan dokument.');
  assert(ids.out.length <= ACCOUNTANT_ROW_CAP && ids.in.length <= ACCOUNTANT_ROW_CAP, `Najviše ${ACCOUNTANT_ROW_CAP} dokumenata po smjeru u jednoj arhivi.`);
  const costs = allowed.costs !== false;
  const rows = await accountantRowsByIds(companyId, ids, costs);
  assert(rows.length === ids.out.length + ids.in.length, 'Neki dokumenti ne postoje.');

  // veličina priloga provjerava se prije učitavanja sadržaja
  // troškovi knjiženi iz označenih ulaznih računa — njihovi prilozi idu u mapu ulaznog računa
  // bez prava `costs` prilozi računa za robu (i njihova troška) otkrivaju nabavnu vrijednost — ne idu u arhivu
  const inAttIds = !ids.in.length
    ? []
    : costs
      ? ids.in
      : (await db.supplierInvoice.findMany({ where: { companyId, id: { in: ids.in }, ...NOT_GOODS_INVOICE }, select: { id: true } })).map((r) => r.id);
  const expenses = inAttIds.length
    ? await db.expense.findMany({ where: { companyId, supplierInvoiceId: { in: inAttIds } }, select: { id: true, supplierInvoiceId: true } })
    : [];
  const expenseOf = new Map(expenses.map((e) => [e.id, e.supplierInvoiceId!]));
  const attWhere = {
    companyId,
    OR: [
      ...(ids.out.length ? [{ entity: 'invoice', entityId: { in: ids.out } }] : []),
      ...(inAttIds.length ? [{ entity: 'supplierInvoice', entityId: { in: inAttIds } }] : []),
      ...(expenses.length ? [{ entity: 'expense', entityId: { in: expenses.map((e) => e.id) } }] : []),
    ],
  };
  const attSize = await db.attachment.aggregate({ where: attWhere, _sum: { size: true } });
  if ((attSize._sum.size ?? 0) > maxBytes) {
    throw new ZipTooLargeError(`Prilozi označenih dokumenata imaju više od ${Math.round(maxBytes / 1024 / 1024)} MB — označite manje dokumenata.`);
  }

  const zip = new ZipWriter(maxBytes);
  zip.add('popis.csv', toCsv(rows, ACCOUNTANT_CSV_COLUMNS));

  // mape po dokumentu (jedinstvene i kad dva dobavljača imaju isti broj računa)
  const folders = new Set<string>();
  const stem = new Map<string, string>();
  for (const r of rows) {
    const base = r.dir === 'out' ? fileStem(r.number, r.id) : fileStem(r.number, r.internalNo ?? r.id);
    stem.set(`${r.dir}:${r.id}`, uniqueName(folders, `${r.dir}/${base}`).slice(r.dir.length + 1));
  }

  // eRačun XML — po nekoliko računa odjednom (svaki je jedan upit s recima)
  const outs = rows.filter((r) => r.dir === 'out');
  let xmlCount = 0;
  for (let i = 0; i < outs.length; i += 8) {
    const part = await Promise.all(outs.slice(i, i + 8).map((r) => invoiceUbl(companyId, r.id)));
    part.forEach((u, j) => {
      if (u?.xml) {
        zip.add(`izlazni/${stem.get(`out:${outs[i + j].id}`)}.xml`, u.xml);
        xmlCount++;
      }
    });
  }

  // PDF izlaznih računa (isti predložak kao pregled/ispis) — po nekoliko odjednom
  let pdfCount = 0;
  for (let i = 0; i < outs.length; i += 4) {
    const part = await Promise.all(outs.slice(i, i + 4).map((r) => renderDocumentPdf('invoice', r.id, companyId)));
    part.forEach((p, j) => {
      zip.add(`izlazni/${stem.get(`out:${outs[i + j].id}`)}.pdf`, p.buffer);
      pdfCount++;
    });
  }

  // prilozi — u manjim dijelovima da se u memoriji ne drže svi odjednom
  let attCount = 0;
  const metas = await db.attachment.findMany({ where: attWhere, select: { id: true, entity: true, entityId: true, fileName: true, createdAt: true }, orderBy: { createdAt: 'asc' } });
  for (let i = 0; i < metas.length; i += 20) {
    const chunk = metas.slice(i, i + 20);
    const data = await db.attachment.findMany({ where: { companyId, id: { in: chunk.map((m) => m.id) } }, select: { id: true, data: true } });
    const byId = new Map(data.map((d) => [d.id, d.data]));
    for (const m of chunk) {
      const bytes = byId.get(m.id);
      if (!bytes) continue;
      const path =
        m.entity === 'invoice'
          ? `izlazni/prilozi/${stem.get(`out:${m.entityId}`)} - ${m.fileName}`
          : m.entity === 'expense'
            ? `ulazni/${stem.get(`in:${expenseOf.get(m.entityId)}`)}/trošak - ${m.fileName}`
            : `ulazni/${stem.get(`in:${m.entityId}`)}/${m.fileName}`;
      zip.add(path, bytes as Uint8Array, m.createdAt);
      attCount++;
    }
  }

  return { buffer: zip.toBuffer(), rows, xmlCount, pdfCount, attCount };
}
