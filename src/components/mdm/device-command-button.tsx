'use client';

import { useState, type ReactNode } from 'react';
import { Camera, FileText, Lock, LogOut, MessageSquare, Power, RefreshCw, Eraser } from 'lucide-react';
import { COMMANDS } from '@/domain/mdm';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/field';
import { useAction } from '@/components/ui/action';
import { sendCommandAction } from '@/app/(app)/mdm/uredaji/actions';

export type UiCommand = 'REBOOT' | 'FORGET' | 'SCREENSHOT' | 'UPLOAD_LOGS' | 'LOCK' | 'WIPE' | 'MESSAGE' | 'APPLY_CONFIG';

const ICON: Record<UiCommand, ReactNode> = {
  REBOOT: <Power className="size-4" />,
  FORGET: <LogOut className="size-4" />,
  SCREENSHOT: <Camera className="size-4" />,
  UPLOAD_LOGS: <FileText className="size-4" />,
  LOCK: <Lock className="size-4" />,
  WIPE: <Eraser className="size-4" />,
  MESSAGE: <MessageSquare className="size-4" />,
  APPLY_CONFIG: <RefreshCw className="size-4" />,
};

const SHORT: Record<UiCommand, string> = {
  REBOOT: 'Reboot',
  FORGET: 'Forget',
  SCREENSHOT: 'Snimka zaslona',
  UPLOAD_LOGS: 'Zapisnici',
  LOCK: 'Zaključaj',
  WIPE: 'Tvorničke postavke',
  MESSAGE: 'Poruka',
  APPLY_CONFIG: 'Primijeni konfiguraciju',
};

/**
 * Gumb naredbe za jedan ili više uređaja; potvrda s tekstom iz `COMMANDS`,
 * poruka na zaslon traži tekst. Prava ponovno provjerava `queueCommands`.
 */
export function CommandButton({
  ids,
  type,
  label,
  onDone,
  variant = 'secondary',
  size,
  className,
}: {
  ids: string[];
  type: UiCommand;
  label?: string;
  onDone?: () => void;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  className?: string;
}) {
  const def = COMMANDS[type];
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const { run, pending } = useAction(sendCommandAction, { onSuccess: () => onDone?.() });
  const needsDialog = !!def.confirm || type === 'MESSAGE';
  const danger = type === 'WIPE' || type === 'FORGET';
  const send = async () => {
    const r = await run({ ids, type, text: type === 'MESSAGE' ? text : undefined });
    if (r.ok) {
      setOpen(false);
      setText('');
    }
  };
  return (
    <>
      <Button variant={variant} size={size} className={className} icon={ICON[type]} loading={pending && !open} onClick={() => (needsDialog ? setOpen(true) : send())}>
        {label ?? SHORT[type]}
      </Button>
      {needsDialog && (
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          title={def.label}
          size="sm"
          footer={
            <>
              <Button onClick={() => setOpen(false)}>Odustani</Button>
              <Button variant={danger ? 'danger' : 'primary'} loading={pending} disabled={type === 'MESSAGE' && !text.trim()} onClick={send}>
                {type === 'MESSAGE' ? 'Pošalji' : 'Potvrdi'}
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-base text-fg-2">
            {def.confirm && <p>{def.confirm}</p>}
            {ids.length > 1 && <p>Odabrano uređaja: <b>{ids.length}</b></p>}
            {type === 'MESSAGE' && (
              <Field label="Poruka na zaslonu uređaja" required>
                <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={500} rows={4} autoFocus />
              </Field>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
