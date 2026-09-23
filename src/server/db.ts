import 'server-only';
import { PrismaClient, type Prisma } from '@prisma/client';

const g = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  g.prisma ??
  new PrismaClient({ log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'] });

if (process.env.NODE_ENV !== 'production') g.prisma = db;

export type Tx = Prisma.TransactionClient;

/** Transakcija s razumnim vremenskim ograničenjima za skupne radnje. */
export function transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(fn, { maxWait: 10_000, timeout: 60_000 });
}
