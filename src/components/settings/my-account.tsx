'use client';

import { useState } from 'react';
import { Copy, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';
import { ActionForm, FormError, useAction } from '@/components/ui/action';
import { Button } from '@/components/ui/button';
import { Field, FormGrid, Input } from '@/components/ui/field';
import { Badge, Card } from '@/components/ui/misc';
import { Dialog } from '@/components/ui/dialog';
import { changePasswordAction, confirmTotpAction, disableTotpAction, regenerateCodesAction, saveProfileAction, startTotpAction } from '@/app/(app)/postavke/moj-racun/actions';

/** Rezervni kodovi — prikazuju se samo jednom, s kopiranjem i preuzimanjem. */
function BackupCodes({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const text = codes.join('\n');
  return (
    <Dialog
      open
      onClose={onClose}
      title="Rezervni kodovi"
      size="sm"
      footer={
        <>
          <Button icon={<Copy className="size-4" />} onClick={() => navigator.clipboard?.writeText(text)}>
            Kopiraj
          </Button>
          <Button
            onClick={() => {
              const a = document.createElement('a');
              a.href = URL.createObjectURL(new Blob([`Rezervni kodovi — ERP · WMS\n\n${text}\n`], { type: 'text/plain' }));
              a.download = 'rezervni-kodovi.txt';
              a.click();
            }}
          >
            Preuzmi
          </Button>
          <Button variant="primary" onClick={onClose}>
            Spremio sam ih
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-fg-2">
        Spremite ih na sigurno mjesto (ispis, upravitelj lozinki). Svaki kod vrijedi <b>jednom</b> — koristite ga za prijavu ako izgubite mobitel. Kodovi se više neće prikazati.
      </p>
      <ul className="grid grid-cols-2 gap-2 rounded-md bg-panel-2 p-3 font-mono text-md tnum">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </Dialog>
  );
}

function TwoFactor({ enabled, backupLeft }: { enabled: boolean; backupLeft: number }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disable, setDisable] = useState(false);
  const [password, setPassword] = useState('');
  const [regen, setRegen] = useState(false);
  const start = useAction(startTotpAction, { refresh: false, onSuccess: (d) => setSetup(d as { secret: string; qr: string }) });
  const confirm = useAction(confirmTotpAction, {
    onSuccess: (d) => {
      setSetup(null);
      setCode('');
      setCodes((d as { codes: string[] }).codes);
    },
  });
  const renew = useAction(regenerateCodesAction, {
    onSuccess: (d) => {
      setRegen(false);
      setCode('');
      setCodes((d as { codes: string[] }).codes);
    },
  });
  const off = useAction(disableTotpAction, { onSuccess: () => { setDisable(false); setPassword(''); } });

  return (
    <Card title="Prijava u dva koraka (2FA)" actions={enabled ? <Badge tone="ok">uključena</Badge> : <Badge>isključena</Badge>}>
      <p className="mb-3 text-sm text-fg-3">
        Uz lozinku se pri svakoj prijavi traži i šesteroznamenkasti kod iz aplikacije na mobitelu (Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden…). Preporučeno za administratore.
      </p>
      {enabled ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-auto text-sm text-fg-2">
            Preostalo rezervnih kodova: <b className={backupLeft < 3 ? 'text-bad-strong' : 'text-fg'}>{backupLeft}</b>
          </span>
          <Button icon={<KeyRound className="size-4" />} onClick={() => setRegen(true)}>
            Novi rezervni kodovi
          </Button>
          <Button variant="danger" icon={<ShieldOff className="size-4" />} onClick={() => setDisable(true)}>
            Isključi
          </Button>
        </div>
      ) : setup ? (
        <div className="space-y-3">
          <p className="text-sm">1. U aplikaciji odaberite „Dodaj račun" i skenirajte kod (ili ručno upišite ključ).</p>
          <div className="flex flex-wrap items-center gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setup.qr} alt="QR kod za aplikaciju" className="size-44 rounded-md bg-white p-1" />
            <code className="max-w-full break-all rounded-md bg-panel-2 px-2 py-1 font-mono text-sm">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
          </div>
          <p className="text-sm">2. Upišite kod koji aplikacija pokazuje:</p>
          <form
            className="flex flex-wrap items-start gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              confirm.run({ code });
            }}
          >
            <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" className="w-36 text-center font-mono tracking-widest" autoFocus />
            <Button type="submit" variant="primary" loading={confirm.pending} disabled={code.length !== 6}>
              Potvrdi i uključi
            </Button>
            <Button onClick={() => setSetup(null)}>Odustani</Button>
          </form>
          <FormError error={confirm.error} />
        </div>
      ) : (
        <Button variant="primary" icon={<ShieldCheck className="size-4" />} loading={start.pending} onClick={() => start.run({})}>
          Uključi prijavu u dva koraka
        </Button>
      )}

      {codes && <BackupCodes codes={codes} onClose={() => setCodes(null)} />}
      <Dialog
        open={disable}
        onClose={() => setDisable(false)}
        title="Isključiti prijavu u dva koraka?"
        size="sm"
        footer={
          <>
            <Button onClick={() => setDisable(false)}>Odustani</Button>
            <Button variant="danger" loading={off.pending} onClick={() => off.run({ password })}>
              Isključi
            </Button>
          </>
        }
      >
        <Field label="Vaša lozinka" error={off.error ?? undefined}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
        </Field>
      </Dialog>
      <Dialog
        open={regen}
        onClose={() => setRegen(false)}
        title="Novi rezervni kodovi"
        size="sm"
        footer={
          <>
            <Button onClick={() => setRegen(false)}>Odustani</Button>
            <Button variant="primary" loading={renew.pending} disabled={code.length !== 6} onClick={() => renew.run({ code })}>
              Izdaj nove kodove
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-fg-2">Stari rezervni kodovi prestaju vrijediti. Za potvrdu upišite kod iz aplikacije.</p>
        <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" placeholder="123456" className="w-36 text-center font-mono tracking-widest" autoFocus />
        <FormError error={renew.error} />
      </Dialog>
    </Card>
  );
}

export function MyAccount({ name, email, totpEnabled, backupLeft }: { name: string; email: string; totpEnabled: boolean; backupLeft: number }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="space-y-4">
        <Card title="Podaci">
          <ActionForm action={saveProfileAction} successMessage="Ime spremljeno.">
            {({ pending, error, fields }) => (
              <div className="space-y-3">
                <Field label="Ime i prezime" required error={fields.name}>
                  <Input name="name" defaultValue={name} required />
                </Field>
                <Field label="E-adresa (prijava)" hint="E-adresu mijenja administrator u Postavke → Korisnici.">
                  <Input value={email} disabled readOnly />
                </Field>
                <FormError error={error} />
                <Button type="submit" variant="primary" loading={pending}>
                  Spremi
                </Button>
              </div>
            )}
          </ActionForm>
        </Card>
        <Card title="Promjena lozinke">
          <ActionForm action={changePasswordAction} successMessage="Lozinka promijenjena." resetOnSuccess>
            {({ pending, error, fields }) => (
              <div className="space-y-3">
                <Field label="Trenutna lozinka" required error={fields.current}>
                  <Input name="current" type="password" autoComplete="current-password" required />
                </Field>
                <FormGrid>
                  <Field label="Nova lozinka" required hint="Najmanje 8 znakova." error={fields.next}>
                    <Input name="next" type="password" autoComplete="new-password" required minLength={8} />
                  </Field>
                  <Field label="Ponovite novu lozinku" required error={fields.next2}>
                    <Input name="next2" type="password" autoComplete="new-password" required />
                  </Field>
                </FormGrid>
                <p className="text-xs text-fg-3">Nakon promjene odjavljuju se svi ostali uređaji.</p>
                <FormError error={error} />
                <Button type="submit" variant="primary" loading={pending}>
                  Promijeni lozinku
                </Button>
              </div>
            )}
          </ActionForm>
        </Card>
      </div>
      <TwoFactor enabled={totpEnabled} backupLeft={backupLeft} />
    </div>
  );
}
