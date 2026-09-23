'use client';

import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { ActionButton, FormError, useAction, type ServerAction } from '@/components/ui/action';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Dialog } from '@/components/ui/dialog';
import { Field, FormGrid, Input } from '@/components/ui/field';
import { Empty, TableWrap } from '@/components/ui/misc';
import { amount } from '@/lib/format';

export interface PriceRow {
  id: string;
  modelId: string;
  model: string;
  salePrice: number | null;
  rentPrice: number | null;
  listSale: number | null;
  listRent: number | null;
}

type Draft = { id: string | null; modelId: string | null; salePrice: string; rentPrice: string };

export function PriceEditor({
  partnerId,
  rows,
  models,
  save,
  remove,
  canEdit,
}: {
  partnerId: string;
  rows: PriceRow[];
  models: Array<{ value: string; label: string; hint?: string }>;
  save: ServerAction<Record<string, unknown>>;
  remove: ServerAction<{ id: string }>;
  canEdit: boolean;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const { run, pending, error } = useAction(save, { onSuccess: () => setDraft(null) });
  const fmt = (v: number | null) => (v === null ? '' : String(v).replace('.', ','));

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-3">Dogovorene cijene imaju prednost pred cjenikom modela pri izradi računa, ponuda i ugovora.</p>
        {canEdit && (
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setDraft({ id: null, modelId: null, salePrice: '', rentPrice: '' })}>
            Dodaj cijenu
          </Button>
        )}
      </div>
      <TableWrap>
        {rows.length ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Model</th>
                <th className="num">Prodajna (bez PDV-a)</th>
                <th className="num">Cjenik</th>
                <th className="num">Najam mjesečno</th>
                <th className="num">Cjenik</th>
                {canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="font-medium">{r.model}</td>
                  <td className="num">{r.salePrice !== null ? amount(r.salePrice) : <span className="text-fg-4">—</span>}</td>
                  <td className="num text-fg-3">{r.listSale !== null ? amount(r.listSale) : '—'}</td>
                  <td className="num">{r.rentPrice !== null ? amount(r.rentPrice) : <span className="text-fg-4">—</span>}</td>
                  <td className="num text-fg-3">{r.listRent !== null ? amount(r.listRent) : '—'}</td>
                  {canEdit && (
                    <td className="w-px whitespace-nowrap text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label="Uredi"
                        icon={<Pencil className="size-3.5" />}
                        onClick={() => setDraft({ id: r.id, modelId: r.modelId, salePrice: fmt(r.salePrice), rentPrice: fmt(r.rentPrice) })}
                      />
                      <ActionButton
                        size="sm"
                        variant="ghost"
                        aria-label="Obriši"
                        icon={<Trash2 className="size-3.5" />}
                        action={remove}
                        input={{ id: r.id }}
                        confirm={`Obrisati dogovorenu cijenu za ${r.model}?`}
                        confirmLabel="Obriši"
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="Nema dogovorenih cijena" description="Za ovog partnera vrijede cijene iz šifrarnika modela." />
        )}
      </TableWrap>

      <Dialog
        open={!!draft}
        onClose={() => setDraft(null)}
        title={draft?.id ? 'Uredi dogovorenu cijenu' : 'Nova dogovorena cijena'}
        size="sm"
        footer={
          <>
            <Button onClick={() => setDraft(null)}>Odustani</Button>
            <Button variant="primary" loading={pending} onClick={() => draft && run({ ...draft, partnerId })}>
              Spremi
            </Button>
          </>
        }
      >
        {draft && (
          <div className="space-y-3">
            <Field label="Model" required>
              <Combobox options={models} value={draft.modelId} onChange={(v) => setDraft({ ...draft, modelId: v })} placeholder="Odaberite model…" />
            </Field>
            <FormGrid>
              <Field label="Prodajna cijena (bez PDV-a)">
                <Input inputMode="decimal" value={draft.salePrice} onChange={(e) => setDraft({ ...draft, salePrice: e.target.value })} className="text-right" />
              </Field>
              <Field label="Najam mjesečno">
                <Input inputMode="decimal" value={draft.rentPrice} onChange={(e) => setDraft({ ...draft, rentPrice: e.target.value })} className="text-right" />
              </Field>
            </FormGrid>
            <FormError error={error} />
          </div>
        )}
      </Dialog>
    </>
  );
}
