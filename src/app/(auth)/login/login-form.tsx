'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { login } from './actions';

export function LoginForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState(login, {});
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="next" value={next ?? ''} />
      <Field label="E-pošta">
        <Input name="email" type="email" autoComplete="username" autoFocus required />
      </Field>
      <Field label="Lozinka">
        <Input name="password" type="password" autoComplete="current-password" required />
      </Field>
      {state.error && <p className="rounded-md bg-bad-soft px-3 py-2 text-sm text-bad-strong">{state.error}</p>}
      <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
        Prijava
      </Button>
    </form>
  );
}
