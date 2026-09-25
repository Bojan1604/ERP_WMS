'use client';

import { useState } from 'react';
import { ArrowRightLeft, Building2, Plus, Trash2 } from 'lucide-react';
import { FormError, useAction } from '@/components/ui/action';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, FormGrid, Input, Select } from '@/components/ui/field';
import { Badge, Card, TableWrap } from '@/components/ui/misc';
import { Dialog } from '@/components/ui/dialog';
import { integer } from '@/lib/format';
import { companyAccessAction, createCompanyAction, deleteCompanyAction, switchCompanyAction } from '@/app/(app)/postavke/firme/actions';

interface CompanyRow { id: string; name: string; country: string; currency: string; items: number; invoices: number; partners: number }
interface UserRow { id: string; name: string; email: string; active: boolean; isAdmin: boolean; currentId: string; access: string[] }

const COUNTRIES = [
  { value: 'HR', label: 'Hrvatska' },
  { value: 'RS', label: 'Srbija' },
  { value: 'BA', label: 'Bosna i Hercegovina' },
  { value: 'SI', label: 'Slovenija' },
  { value: 'ME', label: 'Crna Gora' },
  { value: 'MK', label: 'Sjeverna Makedonija' },
  { value: 'AT', label: 'Austrija' },
  { value: 'DE', label: 'Njemačka' },
];
const CURRENCY_BY_COUNTRY: Record<string, string> = { RS: 'RSD', BA: 'BAM', MK: 'MKD' };

function NewCompany({ onClose }: { onClose: () => void }) {
  const [v, setV] = useState({ name: '', country: 'HR', currency: 'EUR', copyLookups: true, switchTo: true });
  const { run, pending, error } = useAction(createCompanyAction, { onSuccess: onClose });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Nova firma"
      footer={
        <>
          <Button onClick={onClose}>Odustani</Button>
          <Button variant="primary" loading={pending} onClick={() => run(v)}>
            Otvori firmu
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Naziv firme" required>
          <Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="npr. Firma d.o.o. Beograd" autoFocus />
        </Field>
        <FormGrid>
          <Field label="Država">
            <Select value={v.country} onChange={(e) => setV({ ...v, country: e.target.value, currency: CURRENCY_BY_COUNTRY[e.target.value] ?? 'EUR' })} options={COUNTRIES} />
          </Field>
          <Field label="Valuta">
            <Input value={v.currency} onChange={(e) => setV({ ...v, currency: e.target.value.toUpperCase().slice(0, 3) })} maxLength={3} />
          </Field>
        </FormGrid>
        <Checkbox label="Preslikaj statuse, kategorije, modele, usluge i skladišta iz trenutne firme" checked={v.copyLookups} onChange={(e) => setV({ ...v, copyLookups: e.target.checked })} />
        <Checkbox label="Odmah prijeđi u novu firmu" checked={v.switchTo} onChange={(e) => setV({ ...v, switchTo: e.target.checked })} />
        <p className="text-xs text-fg-3">Nova firma kreće bez uređaja, računa, partnera i troškova. Vi dobivate pristup; ostalim korisnicima ga dodijelite u tablici ispod. Stopa PDV-a postavlja se prema državi i mijenja u postavkama firme.</p>
        <FormError error={error} />
      </div>
    </Dialog>
  );
}

function DeleteCompany({ company, onClose }: { company: CompanyRow; onClose: () => void }) {
  const [name, setName] = useState('');
  const { run, pending, error } = useAction(deleteCompanyAction, { onSuccess: onClose });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Obrisati firmu „${company.name}"?`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Odustani</Button>
          <Button variant="danger" loading={pending} disabled={name.trim() !== company.name} onClick={() => run({ companyId: company.id, confirmName: name })}>
            Obriši firmu
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-fg-2">
        Briše se samo prazna firma (bez uređaja, dokumenata i partnera). Firmu s podacima najprije ispraznite u njenoj opasnoj zoni („Obriši sve"). Za potvrdu upišite točan naziv firme.
      </p>
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={company.name} autoFocus />
      <FormError error={error} />
    </Dialog>
  );
}

function AccessToggle({ user, companyId }: { user: UserRow; companyId: string }) {
  const on = user.access.includes(companyId);
  const { run, pending } = useAction(companyAccessAction);
  const current = user.currentId === companyId;
  return (
    <input
      type="checkbox"
      className="size-4 accent-[var(--color-brand)] disabled:opacity-50"
      checked={on}
      disabled={pending || (on && current)}
      title={current ? 'Korisnik trenutno radi u ovoj firmi' : on ? 'Oduzmi pristup' : 'Dodaj pristup'}
      aria-label={`${user.name}: pristup`}
      onChange={() => run({ userId: user.id, companyId, grant: !on })}
    />
  );
}

export function CompaniesManager({ companies, users, currentId, meId }: { companies: CompanyRow[]; users: UserRow[]; currentId: string; meId: string }) {
  const [adding, setAdding] = useState(false);
  const [del, setDel] = useState<CompanyRow | null>(null);
  const sw = useAction(switchCompanyAction);
  return (
    <div className="space-y-4">
      <Card
        title={`Firme (${companies.length})`}
        padded={false}
        actions={
          <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
            Nova firma
          </Button>
        }
      >
        <TableWrap className="rounded-none shadow-none">
          <table className="data-table">
            <thead>
              <tr>
                <th>Naziv</th>
                <th>Država</th>
                <th>Valuta</th>
                <th className="num">Uređaja</th>
                <th className="num">Računa</th>
                <th className="num">Partnera</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id}>
                  <td data-label="" className="font-medium">
                    <Building2 className="mr-1.5 inline size-4 text-fg-3" />
                    {c.name}
                  </td>
                  <td data-label="Država">{c.country}</td>
                  <td data-label="Valuta">{c.currency}</td>
                  <td data-label="Uređaja" className="num">{integer(c.items)}</td>
                  <td data-label="Računa" className="num">{integer(c.invoices)}</td>
                  <td data-label="Partnera" className="num">{integer(c.partners)}</td>
                  <td data-label="" className="whitespace-nowrap text-right">
                    {c.id === currentId ? (
                      <Badge tone="ok">trenutno odabrana</Badge>
                    ) : (
                      <span className="inline-flex gap-1">
                        <Button size="sm" icon={<ArrowRightLeft className="size-3.5" />} loading={sw.pending} onClick={() => sw.run({ companyId: c.id })}>
                          Prebaci se
                        </Button>
                        <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setDel(c)} aria-label={`Obriši ${c.name}`} />
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      {companies.length > 1 && (
        <Card title="Pristup korisnika po firmama" padded={false}>
          <p className="border-b border-line px-4 py-2.5 text-sm text-fg-3">
            Uloga i prava korisnika vrijede u svim firmama kojima ima pristup. Korisnik bira firmu u zaglavlju; pristup firmi u kojoj trenutno radi ne može se oduzeti.
          </p>
          <TableWrap className="rounded-none shadow-none">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Korisnik</th>
                  {companies.map((c) => (
                    <th key={c.id} className="text-center!">
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className={u.active ? '' : 'opacity-60'}>
                    <td data-label="">
                      <span className="font-medium">{u.name}</span>
                      {u.id === meId && <span className="ml-1 text-xs text-fg-3">(vi)</span>}
                      {u.isAdmin && <Badge tone="brand" className="ml-1.5">admin</Badge>}
                      <span className="block text-xs text-fg-3">{u.email}</span>
                    </td>
                    {companies.map((c) => (
                      <td key={c.id} data-label={c.name} className="text-center">
                        <AccessToggle user={u} companyId={c.id} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}
      {adding && <NewCompany onClose={() => setAdding(false)} />}
      {del && <DeleteCompany company={del} onClose={() => setDel(null)} />}
    </div>
  );
}
