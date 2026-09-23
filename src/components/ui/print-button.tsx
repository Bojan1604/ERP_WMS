'use client';

import { Printer } from 'lucide-react';
import { Button } from './button';

export function PrintButton({ label = 'Ispis / PDF' }: { label?: string }) {
  return (
    <Button icon={<Printer className="size-4" />} onClick={() => window.print()}>
      {label}
    </Button>
  );
}
