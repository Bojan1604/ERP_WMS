import 'server-only';
import type { Series } from '@prisma/client';
import type { Tx } from './db';
import { formatDocNumber } from '@/domain/invoice';

/**
 * Sljedeći redni broj u seriji — atomski u bazi (INSERT … ON CONFLICT … RETURNING),
 * pa dva istovremena izdavanja nikad ne dobiju isti broj. Brojač samo raste.
 */
export async function nextSeq(tx: Tx, companyId: string, series: Series, year: number): Promise<number> {
  const rows = await tx.$queryRaw<{ last: number }[]>`
    INSERT INTO "DocumentCounter" ("companyId", "series", "year", "last")
    VALUES (${companyId}, ${series}::"Series", ${year}, 1)
    ON CONFLICT ("companyId", "series", "year")
    DO UPDATE SET "last" = "DocumentCounter"."last" + 1
    RETURNING "last"`;
  return Number(rows[0].last);
}

const PREFIX: Record<Exclude<Series, 'INVOICE'>, string> = {
  QUOTE: 'PON',
  CONTRACT: 'UG',
  ORDER: 'NAR',
  RECEIPT: 'PRI',
  TRANSFER: 'MSK',
  SERVICE: 'RMA',
  SUPPLIER_INVOICE: 'URA',
};

export async function nextDocNumber(tx: Tx, companyId: string, series: Exclude<Series, 'INVOICE'>, year: number) {
  return formatDocNumber(PREFIX[series], year, await nextSeq(tx, companyId, series, year));
}
