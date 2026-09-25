import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from '../../db';

/**
 * Upit izvještaja: u vlastitoj kratkoj transakciji s više radne memorije (sortiranje i
 * grupiranje stotina tisuća stavki ostaje u memoriji, bez prelijevanja na disk) i bez JIT-a
 * (procjena troška podupita po stavci je prenapuhana pa bi JIT prevođenje trajalo dulje od upita).
 * Koristi se kao `db.$queryRaw`: reportSql<T>`SELECT …`.
 */
export function reportSql<T = unknown>(strings: TemplateStringsArray | Prisma.Sql, ...values: unknown[]): Promise<T> {
  const sql = Array.isArray(strings) ? Prisma.sql(strings as TemplateStringsArray, ...values) : (strings as Prisma.Sql);
  return db
    .$transaction([
      db.$queryRaw`SELECT set_config('work_mem', '64MB', true), set_config('jit', 'off', true)`,
      db.$queryRaw<T>(sql),
    ])
    .then((r) => r[1] as T);
}
