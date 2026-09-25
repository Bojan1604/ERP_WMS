'use client';

import { useState } from 'react';
import { Copy, KeyRound, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, FormGrid, Input } from '@/components/ui/field';
import { ActionButton, FormError, useAction } from '@/components/ui/action';
import { Badge, Card, Empty, TableWrap } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { dateTime } from '@/lib/format';
import {
  createPortalUserAction,
  deletePortalUserAction,
  resetPortalPasswordAction,
  setPortalUserActiveAction,
  updatePortalUserAction,
} from '@/app/(app)/partneri/[id]/portal/actions';

export interface PortalUserRow {
  id: string;
  name: string | null;
  email: string;
  active: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

async function copy(text: string, toast: ReturnType<typeof useToast>) {
  try {
    await navigator.clipboard.writeText(text);
    toast('ok', 'Kopirano.');
  } catch {
    toast('bad', 'Kopiranje nije uspjelo — označite tekst i kopirajte ga ručno.');
  }
}

/** Pristupi portalu za klijente na kartici partnera. */
export function PortalUsers({ partnerId, users, url, canEdit }: { partnerId: string; users: PortalUserRow[]; url: string; canEdit: boolean }) {
  const toast = useToast();
  const [edit, setEdit] = useState<PortalUserRow | 'new' | null>(null);
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);

  return (
    <div className="space-y-3">
      <Card>
        <div className="space-y-2 text-base">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-fg-3">Klijent se prijavljuje na</span>
            <span className="font-mono font-medium break-all">{url}</span>
            <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => copy(url, toast)}>
              Kopiraj poveznicu
            </Button>
          </div>
          <p className="text-sm text-fg-3">
            Vidi samo uređaje vezane na ovog partnera (naziv, serijski broj, datum, jamstvo do) i njegove servisne naloge. Prijava kvara
            otvara servisni nalog sa statusom „Prijavljeno” — vidite ga na nadzornoj ploči i u Servisu. Ovi računi nemaju nikakva prava u
            programu.
          </p>
        </div>
      </Card>

      <div className="flex items-center justify-between gap-2">
        <h2 className="text-md font-semibold">Pristupi ({users.length})</h2>
        {canEdit && (
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit('new')}>
            Pristup za klijenta
          </Button>
        )}
      </div>

      <TableWrap>
        {users.length ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Ime</th>
                <th>E-adresa</th>
                <th>Status</th>
                <th>Zadnja prijava</th>
                <th>Otvoren</th>
                {canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="font-medium">{u.name || <span className="text-fg-4">—</span>}</td>
                  <td className="font-mono break-all">{u.email}</td>
                  <td>{u.active ? <Badge tone="ok">aktivan</Badge> : <Badge>isključen</Badge>}</td>
                  <td>{u.lastLoginAt ? dateTime(u.lastLoginAt) : <span className="text-fg-4">nikad</span>}</td>
                  <td>{dateTime(u.createdAt)}</td>
                  {canEdit && (
                    <td className="text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        <ActionButton size="sm" variant="ghost" action={setPortalUserActiveAction} input={{ id: u.id, partnerId, active: !u.active }}>
                          {u.active ? 'Isključi' : 'Uključi'}
                        </ActionButton>
                        <Button size="sm" variant="ghost" onClick={() => setEdit(u)}>
                          Uredi
                        </Button>
                        <ActionButton
                          size="sm"
                          variant="ghost"
                          icon={<KeyRound className="size-3.5" />}
                          action={resetPortalPasswordAction}
                          input={{ id: u.id, partnerId }}
                          confirm={<>Postaviti novu lozinku za <b>{u.email}</b>? Stara lozinka prestaje vrijediti i klijent se odjavljuje.</>}
                          confirmTitle="Nova lozinka"
                          confirmLabel="Postavi novu lozinku"
                          onSuccess={(d) => setSecret(d as { email: string; password: string })}
                        >
                          Nova lozinka
                        </ActionButton>
                        <ActionButton
                          size="sm"
                          variant="danger"
                          action={deletePortalUserAction}
                          input={{ id: u.id, partnerId }}
                          confirm={<>Obrisati pristup portalu za <b>{u.email}</b>? Prijave kvara ostaju sačuvane.</>}
                          confirmTitle="Brisanje pristupa"
                          confirmLabel="Obriši"
                        >
                          Obriši
                        </ActionButton>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="Partner još nema pristup portalu" description="Dodajte pristup i klijentu pošaljite poveznicu, e-adresu i lozinku." />
        )}
      </TableWrap>

      {edit && (
        <PortalUserDialog
          partnerId={partnerId}
          user={edit === 'new' ? null : edit}
          onClose={() => setEdit(null)}
          onCreated={(s) => {
            setEdit(null);
            setSecret(s);
          }}
        />
      )}
      {secret && <PasswordDialog secret={secret} url={url} onClose={() => setSecret(null)} />}
    </div>
  );
}

function PortalUserDialog({
  partnerId,
  user,
  onClose,
  onCreated,
}: {
  partnerId: string;
  user: PortalUserRow | null;
  onClose: () => void;
  onCreated: (s: { email: string; password: string }) => void;
}) {
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const create = useAction(createPortalUserAction, { onSuccess: (d) => d && onCreated(d) });
  const update = useAction(updatePortalUserAction, { onSuccess: onClose });
  const a = user ? update : create;
  const submit = () => (user ? update.run({ id: user.id, partnerId, name, email }) : create.run({ partnerId, name, email }));
  return (
    <Dialog
      open
      onClose={onClose}
      title={user ? 'Pristup portalu' : 'Novi pristup portalu'}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Odustani</Button>
          <Button variant="primary" loading={a.pending} onClick={submit}>
            {user ? 'Spremi' : 'Otvori pristup'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <FormGrid cols={1}>
          <Field label="Ime i prezime">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
          </Field>
          <Field label="E-adresa za prijavu" required error={a.fields.email}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} />
          </Field>
          {!user && <p className="text-sm text-fg-3">Lozinka se generira automatski i prikazuje se samo jednom.</p>}
          {user && email.trim().toLowerCase() !== user.email && <p className="text-sm text-fg-3">Promjena e-adrese odjavljuje klijenta.</p>}
          <FormError error={a.error} />
        </FormGrid>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function PasswordDialog({ secret, url, onClose }: { secret: { email: string; password: string }; url: string; onClose: () => void }) {
  const toast = useToast();
  const text = `Portal za klijente: ${url}\nE-adresa: ${secret.email}\nLozinka: ${secret.password}`;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Podaci za prijavu"
      size="sm"
      footer={
        <>
          <Button icon={<Copy className="size-4" />} onClick={() => copy(text, toast)}>
            Kopiraj sve
          </Button>
          <Button variant="primary" onClick={onClose}>
            Gotovo
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-bad-strong">Lozinka se prikazuje samo sada — kopirajte je i pošaljite klijentu.</p>
      <dl className="space-y-2">
        <div>
          <dt className="text-xs text-fg-3">Adresa portala</dt>
          <dd className="font-mono break-all">{url}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-3">E-adresa</dt>
          <dd className="font-mono break-all">{secret.email}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-3">Lozinka</dt>
          <dd className="flex items-center gap-2">
            <span className="select-all rounded bg-muted px-2 py-1 font-mono text-lg tracking-wider">{secret.password}</span>
            <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => copy(secret.password, toast)}>
              Kopiraj
            </Button>
          </dd>
        </div>
      </dl>
    </Dialog>
  );
}
