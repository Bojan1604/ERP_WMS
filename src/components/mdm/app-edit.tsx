'use client';

import { useState } from 'react';
import { Pencil, StickyNote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { ActionForm, FormError, type ServerAction } from '@/components/ui/action';

/** Izmjena naziva, opisa i (Windows) argumenata tihe instalacije. */
export function AppEditButton({ app, action }: { app: { id: string; name: string; description: string | null; installArgs: string | null; platform: string }; action: ServerAction<FormData> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon={<Pencil className="size-4" />} onClick={() => setOpen(true)}>
        Uredi
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Uredi aplikaciju">
        <ActionForm action={action} onSuccess={() => setOpen(false)} className="space-y-3">
          {({ pending, error, fields }) => (
            <>
              <FormError error={error} />
              <input type="hidden" name="id" value={app.id} />
              <Field label="Naziv" required error={fields.name}>
                <Input name="name" defaultValue={app.name} maxLength={120} />
              </Field>
              <Field label="Opis">
                <Textarea name="description" defaultValue={app.description ?? ''} rows={3} />
              </Field>
              {app.platform === 'WINDOWS' && (
                <Field label="Argumenti tihe instalacije" hint="MSI: /qn · NSIS: /S · Inno Setup: /VERYSILENT /NORESTART">
                  <Input name="installArgs" defaultValue={app.installArgs ?? ''} className="font-mono" maxLength={500} />
                </Field>
              )}
              <div className="flex justify-end gap-2">
                <Button onClick={() => setOpen(false)}>Odustani</Button>
                <Button type="submit" variant="primary" loading={pending}>
                  Spremi
                </Button>
              </div>
            </>
          )}
        </ActionForm>
      </Dialog>
    </>
  );
}

export function VersionNotesButton({ id, notes, version, action }: { id: string; notes: string | null; version: string; action: ServerAction<FormData> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" icon={<StickyNote className="size-3.5" />} title="Bilješke" onClick={() => setOpen(true)} />
      <Dialog open={open} onClose={() => setOpen(false)} title={`Bilješke — verzija ${version}`} size="sm">
        <ActionForm action={action} onSuccess={() => setOpen(false)} className="space-y-3">
          {({ pending, error }) => (
            <>
              <FormError error={error} />
              <input type="hidden" name="id" value={id} />
              <Textarea name="notes" defaultValue={notes ?? ''} rows={5} maxLength={2000} placeholder="Što je novo, poznati problemi…" />
              <div className="flex justify-end gap-2">
                <Button onClick={() => setOpen(false)}>Odustani</Button>
                <Button type="submit" variant="primary" loading={pending}>
                  Spremi
                </Button>
              </div>
            </>
          )}
        </ActionForm>
      </Dialog>
    </>
  );
}
