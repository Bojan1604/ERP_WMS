'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { FormError, useAction } from '@/components/ui/action';
import { parseNumber } from '@/domain/money';
import { createServiceQuick } from '@/app/(app)/prodaja/racuni/actions';
import { CatalogPicker } from './catalog-picker';
import { KpdInput } from './kpd-input';
import type { ServiceOpt } from './types';

/**
 * Birač usluga iz šifrarnika; s pravom uređivanja i „+ Nova usluga" — usluga
 * se sprema u šifrarnik i odmah dodaje na dokument.
 */
export function ServicePicker({
  open,
  onClose,
  services,
  onPick,
  onCreated,
  canCreate,
}: {
  open: boolean;
  onClose: () => void;
  services: ServiceOpt[];
  onPick: (s: ServiceOpt) => void;
  /** Nova usluga je spremljena u šifrarnik (editor je dodaje u svoj popis). */
  onCreated: (s: ServiceOpt) => void;
  canCreate: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: '', price: '', unit: 'kom', kpd: '' });
  const { run, pending, error } = useAction(createServiceQuick, { refresh: false });
  const save = async () => {
    const r = await run({ name: f.name, price: parseNumber(f.price || '0'), unit: f.unit, kpd: f.kpd || null });
    if (r.ok && r.data) {
      onCreated(r.data);
      onPick(r.data);
      setAdding(false);
      setF({ name: '', price: '', unit: 'kom', kpd: '' });
    }
  };
  return (
    <>
      <CatalogPicker
        open={open && !adding}
        onClose={onClose}
        title="Usluge iz šifrarnika"
        entries={services.map((s) => ({ id: s.id, label: s.name, hint: [s.unit, s.kpd && `KPD ${s.kpd}`].filter(Boolean).join(' · '), price: s.price }))}
        onPick={(id) => {
          const s = services.find((x) => x.id === id);
          if (s) onPick(s);
        }}
        empty={canCreate ? 'Nema usluga — dodajte novu.' : 'Nema usluga — dodajte ih u Postavke → Šifrarnici.'}
        footer={
          canCreate ? (
            <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)} className="mr-auto">
              Nova usluga u šifrarnik
            </Button>
          ) : undefined
        }
      />
      <Dialog
        open={open && adding}
        onClose={() => setAdding(false)}
        title="Nova usluga"
        size="sm"
        footer={
          <>
            <Button onClick={() => setAdding(false)}>Odustani</Button>
            <Button variant="primary" loading={pending} disabled={!f.name.trim()} onClick={save}>
              Spremi i dodaj
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Naziv" required>
            <Input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="npr. Produžena garancija +24 mj" />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Cijena € (bez PDV-a)">
              <Input value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} inputMode="decimal" className="text-right" />
            </Field>
            <Field label="Jedinica">
              <Input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} />
            </Field>
          </div>
          <Field label="KPD 2025" hint="Šifra za eRačun; prazno = zadana šifra usluga iz postavki.">
            <KpdInput value={f.kpd} onChange={(v) => setF({ ...f, kpd: v })} />
          </Field>
          <FormError error={error} />
        </div>
      </Dialog>
    </>
  );
}
