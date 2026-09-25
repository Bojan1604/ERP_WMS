'use client';

import { useActionState, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { login, verifyLoginCode, type LoginState } from './actions';

export function LoginForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState(login, {} as LoginState);
  const [codeState, codeAction, codePending] = useActionState(verifyLoginCode, {} as LoginState);
  const [backup, setBackup] = useState(false);
  // izazov drugog koraka je istekao → natrag na lozinku (do sljedeće prijave lozinkom)
  const [expiredFor, setExpiredFor] = useState<LoginState | null>(null);
  useEffect(() => {
    if (codeState.error && !codeState.step) setExpiredFor(state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeState]);
  if (state.step === 'totp' && expiredFor !== state) {
    return (
      <form action={codeAction} className="space-y-3">
        <input type="hidden" name="next" value={next ?? ''} />
        <div className="flex items-start gap-2.5 rounded-md bg-panel-2 px-3 py-2.5 text-sm text-fg-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand" />
          <span>
            Prijava u dva koraka za <b className="text-fg">{state.email}</b>.{' '}
            {backup ? 'Upišite jedan od rezervnih kodova (svaki vrijedi jednom).' : 'Upišite šesteroznamenkasti kod iz aplikacije na mobitelu.'}
          </span>
        </div>
        <Field label={backup ? 'Rezervni kod' : 'Kod iz aplikacije'}>
          <Input
            key={backup ? 'b' : 't'}
            name="code"
            autoComplete="one-time-code"
            inputMode={backup ? 'text' : 'numeric'}
            maxLength={backup ? 20 : 6}
            placeholder={backup ? 'abcde-12345' : '123456'}
            autoFocus
            required
            className="text-center font-mono text-lg tracking-widest"
          />
        </Field>
        {codeState.error && <p className="rounded-md bg-bad-soft px-3 py-2 text-sm text-bad-strong">{codeState.error}</p>}
        <Button type="submit" variant="primary" size="lg" loading={codePending} className="w-full">
          Potvrdi
        </Button>
        <button type="button" onClick={() => setBackup(!backup)} className="w-full text-center text-sm text-brand hover:underline">
          {backup ? 'Koristi kod iz aplikacije' : 'Nemam mobitel — koristi rezervni kod'}
        </button>
      </form>
    );
  }
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="next" value={next ?? ''} />
      <Field label="E-pošta">
        <Input name="email" type="email" autoComplete="username" autoFocus required defaultValue={state.email} />
      </Field>
      <Field label="Lozinka">
        <Input name="password" type="password" autoComplete="current-password" required />
      </Field>
      {(state.error || (expiredFor && codeState.error)) && <p className="rounded-md bg-bad-soft px-3 py-2 text-sm text-bad-strong">{state.error ?? codeState.error}</p>}
      <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
        Prijava
      </Button>
    </form>
  );
}
