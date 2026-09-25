import 'server-only';
import { PrismaClient, type Prisma } from '@prisma/client';

const g = globalThis as unknown as { prisma?: PrismaClient };

/**
 * JIT PostgreSQL-a isključen za veze programa: upiti popisa i izvještaja su kratki, a JIT
 * na velikoj bazi dodaje stotine ms kompilacije po upitu. `options` u DATABASE_URL-u ima prednost.
 */
export function withJitOff(url: string | undefined) {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (!u.searchParams.has('options')) u.searchParams.set('options', '-c jit=off');
    return u.toString();
  } catch {
    return url;
  }
}

export const db =
  g.prisma ??
  new PrismaClient({
    datasourceUrl: withJitOff(process.env.DATABASE_URL),
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') g.prisma = db;

export type Tx = Prisma.TransactionClient;

/** Transakcija s razumnim vremenskim ograničenjima za skupne radnje. */
export function transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(fn, { maxWait: 10_000, timeout: 60_000 });
}
