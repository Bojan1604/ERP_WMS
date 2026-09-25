'use client';

import { useState } from 'react';
import { Download, HardDriveDownload, RotateCcw, Save, Trash2 } from 'lucide-react';
import { ActionButton, ActionForm, FormError, useAction } from '@/components/ui/action';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, FormGrid, Input } from '@/components/ui/field';
import { Badge, Card, Notice, TableWrap } from '@/components/ui/misc';
import { Dialog } from '@/components/ui/dialog';
import { dateTime } from '@/lib/format';
import { backupNowAction, backupSettingsAction, deleteBackupAction, restoreBackupAction } from '@/app/(app)/postavke/podaci/actions';

export interface BackupRow { name: string; at: string; kind: 'auto' | 'rucna'; size: number }

const size = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

function Restore({ row, onClose }: { row: BackupRow; onClose: () => void }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [done, setDone] = useState<{ companyName: string; admin: { email: string; password: string } | null } | null>(null);
  const { run, pending, error } = useAction(restoreBackupAction, { onSuccess: (d) => setDone(d as typeof done) });
  if (done) {
    return (
      <Dialog open onClose={onClose} title="Kopija je vraćena" size="sm" footer={<Button variant="primary" onClick={onClose}>Zatvori</Button>}>
        <p className="text-sm text-fg-2">
          Podaci su vraćeni u novu firmu <b className="text-fg">„{done.companyName}"</b>. Prebacite se u nju u zaglavlju (izbornik firmi).
        </p>
        {done.admin && (
          <div className="mt-3 rounded-md bg-panel-2 p-3 text-sm">
            <p className="mb-1 text-fg-3">Administrator nove firme (lozinka se prikazuje samo sada):</p>
            <p className="font-mono">{done.admin.email}</p>
            <p className="font-mono">{done.admin.password}</p>
          </div>
        )}
      </Dialog>
    );
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Vratiti kopiju od ${dateTime(row.at)}?`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Odustani</Button>
          <Button variant="primary" loading={pending} disabled={!password} onClick={() => run({ name: row.name, newName: name, password })}>
            Vrati u novu firmu
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-fg-2">
        Kopija se vraća u <b>novu firmu</b> — trenutni podaci ostaju netaknuti. Nova firma dobiva vlastitog administratora, a vi pristup njoj (prebacivanje u zaglavlju).
      </p>
      <div className="space-y-3">
        <Field label="Naziv nove firme" hint="Prazno = naziv iz kopije s datumom.">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Vaša lozinka" required>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </Field>
        <FormError error={error} />
      </div>
    </Dialog>
  );
}

export function Backups({
  rows,
  settings,
  canEdit,
  isAdmin,
  canDanger,
  lastBackupAt,
}: {
  rows: BackupRow[];
  settings: { autoBackup: boolean; backupKeep: number; backupReminderDays: number };
  canEdit: boolean;
  isAdmin: boolean;
  canDanger: boolean;
  lastBackupAt: string | null;
}) {
  const [restore, setRestore] = useState<BackupRow | null>(null);
  return (
    <Card
      title="Sigurnosne kopije"
      padded={false}
      actions={
        isAdmin ? (
          <div className="flex gap-2">
            <a href="/api/postavke/izvoz" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-sm hover:bg-muted">
              <HardDriveDownload className="size-4" /> Preuzmi odmah
            </a>
            <ActionButton action={backupNowAction} input={{}} size="sm" variant="primary" icon={<Save className="size-4" />}>
              Napravi kopiju
            </ActionButton>
          </div>
        ) : null
      }
    >
      <div className="space-y-3 border-b border-line p-4">
        <p className="text-sm text-fg-3">
          Kopija je cijela firma u JSON obliku (isti kao „Preuzmi kopiju"), spremljena na poslužitelju. Zadnja kopija: <b className="text-fg">{lastBackupAt ? dateTime(lastBackupAt) : 'nikad'}</b>. Za pravu sigurnost kopiju redovito preuzmite i spremite izvan poslužitelja.
        </p>
        <ActionForm action={backupSettingsAction} successMessage="Postavke kopija spremljene.">
          {({ pending, error, fields }) => (
            <fieldset disabled={!canEdit} className="flex flex-wrap items-end gap-3">
              <Checkbox name="autoBackup" defaultChecked={settings.autoBackup} label="Automatska dnevna kopija (noću)" className="mb-2" />
              <FormGrid cols={2} className="w-full max-w-sm sm:w-auto">
                <Field label="Čuvaj automatskih" error={fields.backupKeep}>
                  <Input name="backupKeep" type="number" min={1} max={365} defaultValue={settings.backupKeep} className="w-24" />
                </Field>
                <Field label="Podsjetnik (dana)" hint="0 = bez" error={fields.backupReminderDays}>
                  <Input name="backupReminderDays" type="number" min={0} max={365} defaultValue={settings.backupReminderDays} className="w-24" />
                </Field>
              </FormGrid>
              {canEdit && (
                <Button type="submit" loading={pending} className="mb-0.5">
                  Spremi
                </Button>
              )}
              <FormError error={error} />
            </fieldset>
          )}
        </ActionForm>
      </div>
      {rows.length ? (
        <TableWrap className="rounded-none shadow-none">
          <table className="data-table">
            <thead>
              <tr>
                <th>Nastala</th>
                <th>Vrsta</th>
                <th className="num">Veličina</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td className="whitespace-nowrap tnum">{dateTime(r.at)}</td>
                  <td>{r.kind === 'auto' ? <Badge>automatska</Badge> : <Badge tone="info">ručna</Badge>}</td>
                  <td className="num">{size(r.size)}</td>
                  <td className="whitespace-nowrap text-right">
                    {isAdmin && (
                      <span className="inline-flex gap-1">
                        <a href={`/api/postavke/kopije/${r.name}`} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-sm text-brand hover:bg-muted">
                          <Download className="size-3.5" /> Preuzmi
                        </a>
                        {canDanger && (
                          <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => setRestore(r)}>
                            Vrati
                          </Button>
                        )}
                        <ActionButton action={deleteBackupAction} input={{ name: r.name }} size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} confirm="Obrisati ovu kopiju s poslužitelja?" confirmLabel="Obriši" aria-label="Obriši kopiju" />
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      ) : (
        <div className="p-4">
          <Notice tone="info">Na poslužitelju još nema kopija. Uključite automatsku dnevnu kopiju ili napravite kopiju sada.</Notice>
        </div>
      )}
      {restore && <Restore row={restore} onClose={() => setRestore(null)} />}
    </Card>
  );
}
