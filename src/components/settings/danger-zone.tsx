'use client';

import { useState } from 'react';
import { Eraser, RotateCcw, ShieldAlert, Trash2, Wrench } from 'lucide-react';
import { ActionButton, FormError, useAction, type ServerAction } from '@/components/ui/action';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Card } from '@/components/ui/misc';
import { Dialog } from '@/components/ui/dialog';
import { integer } from '@/lib/format';
import {
  cleanLogAction, deleteEverythingAction, deleteTransactionsAction, fixIntegrityAction, resetDemoAction, resetStatusesAction,
} from '@/app/(app)/postavke/podaci/actions';

type Confirmed = ServerAction<{ password: string; companyName: string }>;

/** Dvostruka potvrda: lozinka + upis točnog naziva firme. */
function ConfirmDanger({ title, detail, label, action, companyName, onClose }: { title: string; detail: string; label: string; action: Confirmed; companyName: string; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const { run, pending, error } = useAction(action, { onSuccess: onClose });
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Odustani</Button>
          <Button variant="danger" loading={pending} disabled={!password || name.trim() !== companyName} onClick={() => run({ password, companyName: name })}>
            {label}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-fg-2">{detail}</p>
      <div className="space-y-3">
        <Field label={`Upišite naziv firme: ${companyName}`} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Vaša lozinka" required>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </Field>
        <FormError error={error} />
      </div>
    </Dialog>
  );
}

function CleanLog({ total, onClose }: { total: number; onClose: () => void }) {
  const [days, setDays] = useState('365');
  const [password, setPassword] = useState('');
  const { run, pending, error } = useAction(cleanLogAction, { onSuccess: onClose });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Očisti dnevnik promjena"
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Odustani</Button>
          <Button variant="danger" loading={pending} disabled={!password} onClick={() => run({ days: days === '' ? null : Number(days), password })}>
            {days === '' ? `Obriši sve (${integer(total)})` : `Obriši starije od ${days} dana`}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-fg-2">
        Dnevnik s vremenom naraste. Prije brisanja ga po potrebi izvezite — zapisi se ne mogu vratiti. Brisanje ne dira uređaje, račune ni druge podatke i ostaje zabilježeno u dnevniku.
      </p>
      <div className="space-y-3">
        <Field label="Obriši zapise starije od (dana)" hint="Prazno = cijeli dnevnik.">
          <Input type="number" min={0} value={days} onChange={(e) => setDays(e.target.value)} className="w-32" />
        </Field>
        <Field label="Vaša lozinka" required>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </Field>
        <FormError error={error} />
      </div>
    </Dialog>
  );
}

/** canCleanLog = opasna zona + pravo na dnevnik promjena. */
export function Maintenance({ isAdmin, canCleanLog, auditTotal }: { isAdmin: boolean; canCleanLog: boolean; auditTotal: number }) {
  const [clean, setClean] = useState(false);
  return (
    <Card title="Održavanje">
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-fg-2">Dnevnik promjena: {integer(auditTotal)} zapisa</span>
          {canCleanLog && (
            <Button size="sm" icon={<Eraser className="size-3.5" />} onClick={() => setClean(true)}>
              Očisti dnevnik
            </Button>
          )}
        </div>
        {isAdmin && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-fg-2">Sistemski statusi s ispravnim vrstama (vlastiti statusi i uređaji ostaju)</span>
            <ActionButton action={resetStatusesAction} input={{}} size="sm" icon={<RotateCcw className="size-3.5" />} confirm="Vratiti zadane nazive i boje sistemskih statusa i dodati nedostajuće?" confirmLabel="Vrati">
              Vrati zadane statuse
            </ActionButton>
          </div>
        )}
      </div>
      {clean && <CleanLog total={auditTotal} onClose={() => setClean(false)} />}
    </Card>
  );
}

export function IntegrityFix() {
  return (
    <ActionButton action={fixIntegrityAction} input={{}} size="sm" variant="primary" icon={<Wrench className="size-3.5" />} confirm="Automatski popraviti nalaze označene kao sigurne?" confirmLabel="Popravi">
      Popravi automatski
    </ActionButton>
  );
}

export function DangerZone({ companyName, isDemo, canDanger }: { companyName: string; isDemo: boolean; canDanger: boolean }) {
  const [open, setOpen] = useState<'promet' | 'sve' | 'demo' | null>(null);
  return (
    <Card title="Opasna zona">
      <div className="mb-3 flex items-start gap-2 text-sm text-fg-3">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-bad-strong" />
        <span>
          Prije brisanja napravite i preuzmite sigurnosnu kopiju. Svaka radnja traži vašu lozinku i upis naziva firme; tko smije ovamo određuje se u Postavke → Korisnici („Opasna zona")
          {canDanger ? '.' : ' — vi trenutno nemate to pravo.'}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {isDemo && (
          <Button disabled={!canDanger} icon={<RotateCcw className="size-4" />} onClick={() => setOpen('demo')}>
            Vrati demo podatke
          </Button>
        )}
        <Button variant="danger" disabled={!canDanger} icon={<Trash2 className="size-4" />} onClick={() => setOpen('promet')}>
          Obriši promet
        </Button>
        <Button variant="danger" disabled={!canDanger} icon={<Trash2 className="size-4" />} onClick={() => setOpen('sve')}>
          Obriši sve podatke
        </Button>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-fg-3">
        <b>Obriši promet</b> — uklanja uređaje, račune, ponude, pakete, ugovore, servisne naloge, troškove, nabavu, priloge i dnevnik; brojači dokumenata kreću ispočetka. Partneri, šifrarnici (modeli, kategorije, statusi,
        skladišta, usluge), korisnici i postavke ostaju.
        <br />
        <b>Obriši sve podatke</b> — uz promet briše i partnere, šifrarnike, ostale korisnike i sve MDM podatke (organizacije, uređaje, profile, aplikacije i datoteke). Ostaju vaš korisnički račun i postavke firme.
      </p>
      {open === 'promet' && (
        <ConfirmDanger
          title="Obrisati promet?"
          detail="Brišu se uređaji, računi, ponude, ugovori, servisni nalozi, troškovi, nabava, prilozi i dnevnik. Partneri, šifrarnici i korisnici ostaju. Radnja se ne može poništiti."
          label="Obriši promet"
          action={deleteTransactionsAction}
          companyName={companyName}
          onClose={() => setOpen(null)}
        />
      )}
      {open === 'sve' && (
        <ConfirmDanger
          title="Obrisati baš sve podatke?"
          detail="Trajno se briše promet, svi partneri, modeli, kategorije, statusi, skladišta, usluge, ostali korisnici i svi MDM podaci s datotekama. Ostaju vaš račun i postavke firme. Radnja se ne može poništiti."
          label="Obriši sve"
          action={deleteEverythingAction}
          companyName={companyName}
          onClose={() => setOpen(null)}
        />
      )}
      {open === 'demo' && (
        <ConfirmDanger
          title="Vratiti demo podatke?"
          detail="Demo firma se briše i ponovno stvara s početnim podacima i demo korisnicima (lozinka admin123). Svi korisnici se moraju ponovno prijaviti."
          label="Vrati demo"
          action={resetDemoAction}
          companyName={companyName}
          onClose={() => setOpen(null)}
        />
      )}
    </Card>
  );
}
