'use client';

import { useEffect, useState } from 'react';
import { Button, LinkButton } from '@/components/ui/button';
import { Checkbox, Field, FormGrid, Input, Select, Textarea } from '@/components/ui/field';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { PartnerCombobox } from '@/components/partners/partner-combobox';
import type { PartnerOpt } from '@/lib/partner-option';
import { FormError, useAction, type ServerAction } from '@/components/ui/action';
import { Card } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { supplierVat } from '@/domain/tax';
import { r2 } from '@/domain/money';
import { defaultGoodsInvoice, vatPctOf, type InvoiceExpenseMode } from '@/domain/purchase-links';
import { goodsRuleAction, supplierDocsAction } from '@/app/(app)/nabava/ulazni/actions';
import { eur } from '@/lib/format';

export interface SupplierInvoiceValue {
  id: string | null;
  internalNo: string | null;
  supplierId: string | null;
  /** Slobodni unos dobavljača (kad nije odabran partner). */
  supplierName: string | null;
  supplierOib: string | null;
  number: string;
  issueDate: string;
  dueDate: string | null;
  netAmount: number;
  vatAmount: number;
  total: number;
  vatPct: number | null;
  currency: string;
  category: string | null;
  note: string | null;
  paidDate: string | null;
  book: boolean;
  /** „Ovo je račun za robu" (zadano s poslužitelja po pravilu). */
  goods: boolean;
  orderId: string | null;
  receiptId: string | null;
}

type SaveInput = Omit<SupplierInvoiceValue, 'internalNo' | 'goods'> & { goods: boolean | null };

/** Pravilo zadane kvačice „račun za robu": vrijednosti robe, broj i zbroj drugih računa za robu. */
export interface GoodsRule {
  refs: number[];
  others: number;
  otherNet: number;
}

/** Ono što se o vezi s nabavom zna unaprijed (za prikaz odabranog). */
export interface LinkOptions {
  order: ComboOption | null;
  receipt: ComboOption | null;
}

/**
 * Unos i izmjena ulaznog računa; PDV se predlaže po državi dobavljača.
 * Dobavljač se bira među partnerima ili upisuje slobodno (naziv + OIB) — tada
 * se partner otvara pri spremanju. Veza s narudžbenicom/primkom: trošak robe po
 * narudžbenici = max(primke, računi za robu) — račun za robu knjiži samo razliku iznad primki.
 * eRačun: dobavljač, broj, datum i iznosi dolaze iz XML-a i ne mijenjaju se
 * (`lockDocument`); odbijeni račun se ne plaća ni knjiži (`rejected`);
 * zaprimljeni eRačun se ne plaća prije prihvaćanja (`payLocked`); `readOnly` za korisnike bez prava izmjene.
 */
export function SupplierInvoiceForm({
  initial,
  supplier: initialSupplier,
  categories,
  company,
  action,
  links,
  lockDocument = false,
  rejected = false,
  payLocked = false,
  readOnly = false,
  expense = null,
  goodsRule = null,
  hideAmounts = false,
}: {
  initial: SupplierInvoiceValue;
  /** Trenutni dobavljač (ostali se traže pretragom na poslužitelju). */
  supplier: PartnerOpt | null;
  categories: string[];
  company: { vatRate: number; country: string };
  action: ServerAction<SaveInput, { warning?: string | null } | unknown>;
  links?: LinkOptions;
  lockDocument?: boolean;
  rejected?: boolean;
  payLocked?: boolean;
  readOnly?: boolean;
  /** Kako spremljeni račun stoji s troškom po pravilu (iznosi samo uz pravo `costs`). */
  expense?: { mode: InvoiceExpenseMode; covered: number | null; ownNet: number | null } | null;
  /** Pravilo zadane kvačice „račun za robu" za početnu vezu (null = odluka je spremljena). */
  goodsRule?: GoodsRule | null;
  /** Račun za robu bez prava `costs`: iznosi (nabavna vrijednost) se ne šalju ni prikazuju; obrazac je samo za čitanje. */
  hideAmounts?: boolean;
}) {
  const [v, setV] = useState(initial);
  const [free, setFree] = useState(!initial.supplierId && !!(initial.supplierName || initial.supplierOib));
  const [vatTouched, setVatTouched] = useState(!!initial.id);
  const [totalTouched, setTotalTouched] = useState(!!initial.id && r2(initial.netAmount + initial.vatAmount) !== initial.total);
  const [localError, setLocalError] = useState<string | null>(null);
  // kvačica „račun za robu": dok je korisnik ne dira, a veza se promijeni, odlučuje pravilo na poslužitelju
  const [goodsTouched, setGoodsTouched] = useState(false);
  const [docs, setDocs] = useState<{ orders: ComboOption[]; receipts: Array<ComboOption & { orderId: string | null }> }>({
    orders: links?.order ? [links.order] : [],
    receipts: links?.receipt ? [{ ...links.receipt, orderId: null }] : [],
  });
  const toast = useToast();
  const { run, pending, error } = useAction(action, {
    onSuccess: (d) => {
      const w = (d as { warning?: string | null } | undefined)?.warning;
      if (w) toast('bad', w);
    },
  });

  // narudžbenice i primke odabranog dobavljača (za vezu s nabavom)
  useEffect(() => {
    if (!v.supplierId || free) return;
    let live = true;
    void supplierDocsAction({ supplierId: v.supplierId }).then((r) => {
      if (live && r.ok && r.data) setDocs(r.data);
    });
    return () => {
      live = false;
    };
  }, [v.supplierId, free]);

  const [picked, setPicked] = useState<PartnerOpt | null>(initialSupplier);
  const supplier = picked?.id === v.supplierId ? picked : null;
  const vatInfo = supplierVat(free ? company.country : supplier?.country, company);
  const recompute = (patch: Partial<SupplierInvoiceValue>, s = v, country = supplier?.country) => {
    const next = { ...s, ...patch };
    if (!vatTouched) next.vatAmount = r2((next.netAmount * supplierVat(country, company).rate) / 100);
    if (!totalTouched) next.total = r2(next.netAmount + next.vatAmount);
    setV(next);
  };
  const linked = !!(v.orderId || v.receiptId);
  const sameLinks = v.orderId === initial.orderId && v.receiptId === initial.receiptId;
  // pravilo zadane kvačice za TRENUTNU vezu: početna s poslužitelja, a pri promjeni veze dohvaća se iznova
  const [rule, setRule] = useState<{ key: string; rule: GoodsRule | null }>({ key: `${initial.orderId}|${initial.receiptId}`, rule: goodsRule });
  const linkKey = `${v.orderId}|${v.receiptId}`;
  useEffect(() => {
    if (rule.key === linkKey) return;
    if (sameLinks || !linked) return setRule({ key: linkKey, rule: sameLinks ? goodsRule : null });
    let live = true;
    void goodsRuleAction({ id: v.id, orderId: v.orderId, receiptId: v.receiptId }).then((r) => {
      if (live && r.ok) setRule({ key: linkKey, rule: r.data ?? null });
    });
    return () => {
      live = false;
    };
  }, [linkKey, rule.key, sameLinks, linked, goodsRule, v.id, v.orderId, v.receiptId]);
  const current = rule.key === linkKey ? rule.rule : null;
  // dok korisnik ne dira kvačicu, zadano se računa iz upisane osnovice i kategorije (prijevoz nije račun za robu,
  // djelomični račun „Nabava robe" do nefakturirane vrijednosti jest) — isto pravilo kao na poslužitelju
  const goods =
    goodsTouched || !current
      ? v.goods
      : defaultGoodsInvoice({ net: v.netAmount, category: v.category, refs: current.refs, otherGoodsNet: current.otherNet, otherGoodsInvoices: current.others });

  const submit = () => {
    if (!free && !v.supplierId) return setLocalError('Odaberite dobavljača ili ga upišite slobodno (naziv i OIB).');
    if (free && !v.supplierName?.trim()) return setLocalError('Upišite naziv dobavljača.');
    if (!v.number.trim()) return setLocalError('Upišite broj računa dobavljača.');
    setLocalError(null);
    const { internalNo: _ignored, goods: _goods, ...rest } = v;
    void _ignored;
    void _goods;
    // neizričita odluka (null): poslužitelj zadržava spremljenu ili odlučuje po pravilu iz stvarne osnovice
    const payload = { ...rest, goods: linked && goodsTouched ? v.goods : null };
    run(free ? { ...payload, supplierId: null } : { ...payload, supplierName: null, supplierOib: null });
  };

  return (
    <div className="space-y-4">
      <Card title={v.internalNo ? `Ulazni račun ${v.internalNo}` : 'Novi ulazni račun'}>
        <fieldset disabled={readOnly} className="contents">
          <FormGrid cols={4}>
            {free ? (
              <>
                <Field label="Naziv dobavljača" required hint="Dobavljač se otvara u partnerima pri spremanju">
                  <Input value={v.supplierName ?? ''} onChange={(e) => setV({ ...v, supplierName: e.target.value })} />
                </Field>
                <Field label="OIB dobavljača">
                  <Input value={v.supplierOib ?? ''} inputMode="numeric" maxLength={13} onChange={(e) => setV({ ...v, supplierOib: e.target.value.trim() })} className="font-mono" />
                </Field>
              </>
            ) : (
              <Field label="Dobavljač" required className="sm:col-span-2">
                <PartnerCombobox
                  role="supplier"
                  initial={initialSupplier}
                  value={v.supplierId}
                  onChange={(id, p) => {
                    setPicked(p ?? null);
                    recompute({ supplierId: id, orderId: null, receiptId: null }, v, p?.country);
                  }}
                  placeholder="Odaberite dobavljača…"
                  disabled={lockDocument || readOnly}
                />
              </Field>
            )}
            <Field label="Broj računa dobavljača" required>
              <Input value={v.number} disabled={lockDocument} onChange={(e) => setV({ ...v, number: e.target.value })} />
            </Field>
            <Field label="Interni broj" hint={v.internalNo ? undefined : 'Dodjeljuje se pri spremanju'}>
              <Input value={v.internalNo ?? ''} disabled placeholder="URA-…" />
            </Field>
            {!lockDocument && !readOnly && (
              <div className="sm:col-span-4 -mt-1">
                <button
                  type="button"
                  className="text-sm text-brand hover:underline"
                  onClick={() => {
                    setFree(!free);
                    setV({ ...v, supplierId: free ? v.supplierId : null, orderId: null, receiptId: null });
                  }}
                >
                  {free ? 'Odaberi dobavljača iz partnera' : 'Dobavljača nema u partnerima? Upiši naziv i OIB'}
                </button>
              </div>
            )}
            <Field label="Datum računa" required>
              <Input type="date" value={v.issueDate} disabled={lockDocument} onChange={(e) => setV({ ...v, issueDate: e.target.value })} />
            </Field>
            <Field label="Dospijeće">
              <Input type="date" value={v.dueDate ?? ''} onChange={(e) => setV({ ...v, dueDate: e.target.value || null })} />
            </Field>
            <Field label="Kategorija troška" className="sm:col-span-2">
              <Select placeholder="— bez kategorije —" options={categories.map((c) => ({ value: c, label: c }))} value={v.category ?? ''} onChange={(e) => setV({ ...v, category: e.target.value || null })} />
            </Field>
            {hideAmounts ? (
              <p className="self-end pb-2 text-sm text-fg-3 sm:col-span-4">Iznosi računa za robu (nabavna vrijednost) vidljivi su samo uz pravo na nabavne cijene.</p>
            ) : (
              <>
              <Field label="Osnovica (bez PDV-a)" required>
                <Input type="number" step="0.01" value={v.netAmount} disabled={lockDocument} onChange={(e) => recompute({ netAmount: Number(e.target.value) })} />
              </Field>
              <Field label="PDV" hint={vatTouched ? 'Upisano ručno' : vatInfo.label}>
                <Input
                  type="number"
                  step="0.01"
                  value={v.vatAmount}
                  disabled={lockDocument || readOnly}
                  onChange={(e) => {
                    setVatTouched(true);
                    const vat = Number(e.target.value);
                    setV({ ...v, vatAmount: vat, total: totalTouched ? v.total : r2(v.netAmount + vat) });
                  }}
                />
              </Field>
              <Field label="PDV %" hint={v.vatPct === null ? `Iz iznosa: ${vatPctOf(v.netAmount, v.vatAmount) ?? '—'} %` : undefined}>
                <Input
                  inputMode="decimal"
                  value={v.vatPct ?? ''}
                  disabled={readOnly}
                  onChange={(e) => {
                    const pct = e.target.value === '' ? null : Number(e.target.value.replace(',', '.'));
                    const next = { ...v, vatPct: pct };
                    if (pct !== null && Number.isFinite(pct) && !lockDocument) {
                      next.vatAmount = r2((v.netAmount * pct) / 100);
                      if (!totalTouched) next.total = r2(v.netAmount + next.vatAmount);
                      setVatTouched(true);
                    }
                    setV(next);
                  }}
                />
              </Field>
              <Field label="Ukupno">
                <Input
                  type="number"
                  step="0.01"
                  value={v.total}
                  disabled={lockDocument || readOnly}
                  onChange={(e) => {
                    setTotalTouched(true);
                    setV({ ...v, total: Number(e.target.value) });
                  }}
                />
              </Field>
              </>
            )}
            <Field label="Valuta">
              <Input value={v.currency} maxLength={3} disabled={lockDocument} onChange={(e) => setV({ ...v, currency: e.target.value.toUpperCase() })} className="font-mono" />
            </Field>
            <Field label="Plaćeno dana" hint={payLocked && !v.paidDate ? 'Plaća se nakon prihvaćanja eRačuna' : 'Prazno = nije plaćeno'}>
              <Input type="date" value={v.paidDate ?? ''} disabled={rejected || (payLocked && !v.paidDate)} onChange={(e) => setV({ ...v, paidDate: e.target.value || null })} />
            </Field>
            {!free && (
              <>
                <Field label="Narudžbenica" className="sm:col-span-2" hint="Veza s nabavom — trošak robe se ne knjiži dvaput">
                  <Combobox options={docs.orders} value={v.orderId} onChange={(id) => setV({ ...v, orderId: id })} placeholder="— bez narudžbenice —" allowEmpty disabled={readOnly || !v.supplierId} />
                </Field>
                <Field label="Primka" className="sm:col-span-2">
                  <Combobox
                    options={docs.receipts}
                    value={v.receiptId}
                    onChange={(id) => {
                      const r = docs.receipts.find((x) => x.value === id);
                      setV({ ...v, receiptId: id, orderId: v.orderId ?? r?.orderId ?? null });
                    }}
                    placeholder="— bez primke —"
                    allowEmpty
                    disabled={readOnly || !v.supplierId}
                  />
                </Field>
              </>
            )}
            <Field label="Napomena" className="sm:col-span-4">
              <Textarea rows={2} value={v.note ?? ''} onChange={(e) => setV({ ...v, note: e.target.value })} />
            </Field>
          </FormGrid>
          <div className="mt-3">
            {linked && !free && (
              <div className="mb-2">
                <Checkbox
                  label="Ovo je račun za robu s primke"
                  checked={goods}
                  disabled={rejected}
                  onChange={(e) => {
                    setGoodsTouched(true);
                    setV({ ...v, goods: e.target.checked });
                  }}
                />
                <p className="mt-1 text-xs text-fg-3">
                  Trošak robe narudžbenice knjiži se jednom: ukupno je veći od troška primki i zbroja računa za robu, nikad njihov zbroj — račun
                  za robu knjiži samo iznos iznad primki. Zadano uključeno za račun kategorije „Nabava robe" do još nefakturirane vrijednosti robe
                  (i djelomične račune) ili kad osnovica odgovara vrijednosti primke/narudžbenice. Za prijevoz i dodatne troškove odaberite drugu
                  kategoriju ili isključite — knjiže se zasebno.
                </p>
              </div>
            )}
            <Checkbox label="Knjiži kao trošak" checked={v.book} disabled={rejected} onChange={(e) => setV({ ...v, book: e.target.checked })} />
            <p className="mt-1 text-xs text-fg-3">
              {linked
                ? goods
                  ? 'Račun za robu knjiži samo iznos iznad troška primki narudžbenice (trošak se ne zbraja dvaput).'
                  : 'Račun nije račun za robu — knjiži se kao zaseban trošak.'
                : 'Za račun robe koja je zaprimljena primkom povežite primku ili narudžbenicu — trošak robe je tada već knjižen primkom.'}
            </p>
            {expense && sameLinks && v.book && linked && (
              <p className="mt-1 text-sm text-fg-2">
                {expense.mode === 'receipt'
                  ? 'Trošak robe knjižen je primkom — račun ga ne knjiži ponovno.'
                  : expense.mode === 'partial'
                    ? `Primke nose ${expense.covered === null ? 'dio troška' : eur(expense.covered)} — račun knjiži samo razliku${expense.ownNet === null ? '' : ` (${eur(expense.ownNet)})`}.`
                    : null}
              </p>
            )}
            {lockDocument && <p className="mt-1 text-xs text-fg-3">Dobavljač, broj, datum i iznosi eRačuna preuzeti su iz XML-a i ne mijenjaju se.</p>}
          </div>
        </fieldset>
      </Card>
      {!readOnly && (
        <>
          <FormError error={localError ?? error} />
          <div className="flex justify-end gap-2">
            <LinkButton href="/nabava/ulazni">Odustani</LinkButton>
            <Button variant="primary" loading={pending} onClick={submit}>
              Spremi
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
