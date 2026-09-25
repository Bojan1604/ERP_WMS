'use client';

import { useMemo, useState } from 'react';
import { PackagePlus, ScanLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, FormGrid, Input, Select, Textarea } from '@/components/ui/field';
import { FormError, useAction, type ServerAction } from '@/components/ui/action';
import { eur } from '@/lib/format';
import { r2 } from '@/domain/money';
import { receiptEffect, type GoodsInvoiceRow } from '@/domain/purchase-links';
import { parseSerials } from './labels';
import { ScanDialog } from '@/components/scan/scan-input';

interface ReceiveInput {
  orderId: string;
  lineId: string;
  warehouseId: string;
  date: string;
  unitCost: number;
  supplierDocNumber: string;
  serials: string;
  bookExpense: boolean;
}

/** „Zaprimi robu" na stavci narudžbenice: serijski brojevi (jedan po retku), skladište i datum. */
export function ReceiveDialog({
  orderId,
  line,
  warehouses,
  today,
  action,
  goodsPlan = null,
  canSeeCost = true,
}: {
  orderId: string;
  line: { id: string; model: string; remaining: number; unitCost: number };
  warehouses: Array<{ value: string; label: string }>;
  today: string;
  action: ServerAction<ReceiveInput>;
  /**
   * Stanje troška robe narudžbenice (troškovi primki i ulazni računi) — iz njega isto pravilo
   * kao na poslužitelju (`receiptEffect`) pokazuje što primka radi s računima za robu.
   */
  goodsPlan?: { receiptsBooked: number; invoices: GoodsInvoiceRow[] } | null;
  canSeeCost?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.value ?? '');
  const [date, setDate] = useState(today);
  const [unitCost, setUnitCost] = useState(line.unitCost);
  const [doc, setDoc] = useState('');
  const [book, setBook] = useState(true);
  const [scanOpen, setScanOpen] = useState(false);
  const { run, pending, error } = useAction(action, {
    onSuccess: () => {
      setOpen(false);
      setText('');
    },
  });
  const serials = useMemo(() => parseSerials(text), [text]);
  // isto pravilo troška robe kao na poslužitelju: max(primke, računi za robu)
  const effect = goodsPlan ? receiptEffect(goodsPlan.receiptsBooked, goodsPlan.invoices, r2(serials.length * (unitCost || 0))) : null;
  const dups = useMemo(() => {
    const seen = new Set<string>();
    return [...new Set(serials.filter((s) => (seen.has(s) ? true : (seen.add(s), false))))];
  }, [serials]);
  const over = serials.length > line.remaining;

  return (
    <>
      <Button size="sm" variant="subtle" icon={<PackagePlus className="size-3.5" />} onClick={() => setOpen(true)}>
        Zaprimi robu
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Zaprimi robu — ${line.model}`}
        size="lg"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={!serials.length || over || dups.length > 0 || !warehouseId}
              onClick={() => run({ orderId, lineId: line.id, warehouseId, date, unitCost, supplierDocNumber: doc, serials: text, bookExpense: book })}
            >
              Zaprimi {serials.length || ''} kom
            </Button>
          </>
        }
      >
        <FormGrid cols={4}>
          <Field label="Skladište" required className="sm:col-span-2">
            <Select options={warehouses} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} />
          </Field>
          <Field label="Datum uvoza" required>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          {canSeeCost && (
            <Field label="Nabavna cijena (kom)">
              <Input type="number" step="0.01" min={0} value={unitCost} onChange={(e) => setUnitCost(Number(e.target.value))} />
            </Field>
          )}
          <Field label="Broj dokumenta dobavljača" hint="Otpremnica ili račun — po želji" className="sm:col-span-2">
            <Input value={doc} onChange={(e) => setDoc(e.target.value)} />
          </Field>
          <Field
            label={`Serijski brojevi (${serials.length} / preostalo ${line.remaining})`}
            className="sm:col-span-4"
            error={over ? `Upisano je više serijskih brojeva nego što je preostalo na stavci (${line.remaining}).` : dups.length ? `Ponovljeni: ${dups.join(', ')}` : null}
            hint="Zalijepite iz Excela ili skenirajte (ručni čitač ili kamera) — jedan serijski broj po retku."
          >
            <Textarea rows={10} className="font-mono text-sm" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          </Field>
          <div className="sm:col-span-4">
            <Button size="sm" variant="subtle" icon={<ScanLine className="size-3.5" />} onClick={() => setScanOpen(true)}>
              Skeniraj kamerom
            </Button>
          </div>
        </FormGrid>
        {canSeeCost && (
          <div className="mt-3 space-y-1 text-sm text-fg-3">
            <p>
              Vrijednost primke: <b className="text-fg">{eur(r2(serials.length * (unitCost || 0)))}</b>
            </p>
            <Checkbox checked={book} onChange={(e) => setBook(e.target.checked)} label={'Knjiži nabavu u troškove („Nabava robe")'} />
            {book && effect && effect.invoiceReduced > 0 && (
              <p>
                Račun za robu ove narudžbenice već je knjižen — primka knjiži nabavnu vrijednost, a trošak računa se umanjuje za{' '}
                <b className="text-fg">{eur(effect.invoiceReduced)}</b> (roba se ne knjiži dvaput; ukupni trošak robe raste za {eur(effect.totalIncrease)}).
              </p>
            )}
          </div>
        )}
        <div className="mt-2">
          <FormError error={error} />
        </div>
      </Dialog>
      <ScanDialog
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        onCode={(code) => setText((t) => (t && !t.endsWith('\n') ? `${t}\n${code}` : `${t}${code}`))}
        title="Skeniranje serijskih brojeva"
        hint="Svaki očitani kod dodaje se u popis serijskih brojeva primke."
      />
    </>
  );
}
