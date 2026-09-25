'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { portalLogin } from '../actions';

export function PortalLoginForm() {
  const [state, action, pending] = useActionState(portalLogin, {});
  return (
    <form action={action} className="space-y-3">
      <Field label="E-adresa">
        <Input name="email" type="email" inputMode="email" autoComplete="username" autoCapitalize="none" autoFocus required className="h-10" />
      </Field>
      <Field label="Lozinka">
        <Input name="password" type="password" autoComplete="current-password" required className="h-10" />
      </Field>
      {state.error && <p className="rounded-md bg-bad-soft px-3 py-2 text-sm text-bad-strong">{state.error}</p>}
      <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
        Prijava
      </Button>
    </form>
  );
}
