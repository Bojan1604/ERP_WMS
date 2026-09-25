'use client';

import { FileDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAction, type ServerAction } from '@/components/ui/action';

/** „PDF posrednika" (eRačun): dohvat na zahtjev, spremanje uz račun i otvaranje. */
export function ProviderPdfButton({ id, action }: { id: string; action: ServerAction<{ id: string }, { url: string }> }) {
  const { run, pending } = useAction(action);
  return (
    <Button
      icon={<FileDown className="size-4" />}
      loading={pending}
      onClick={async () => {
        const r = await run({ id });
        if (r.ok && r.data?.url) window.open(r.data.url, '_blank', 'noopener');
      }}
    >
      PDF posrednika
    </Button>
  );
}
