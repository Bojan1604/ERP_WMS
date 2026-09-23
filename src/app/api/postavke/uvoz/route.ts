import { z } from 'zod';
import { requireAdmin } from '@/server/auth';
import { AuthError, DomainError } from '@/server/errors';
import { db } from '@/server/db';
import { analyzePlan, planFromJson } from '@/server/import/analyze';
import { runImport } from '@/server/import/run';
import { ENTITY_LABEL } from '@/server/import/plan';
import { readUpload, removeUpload, withUserLock } from '@/server/import/upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 1800;

const input = z.object({
  mode: z.enum(['analyze', 'import']),
  uploadId: z.string().regex(/^[a-f0-9]{32}$/),
  fileName: z.string().max(300).default(''),
  target: z.enum(['new', 'current']).default('new'),
  name: z.string().trim().max(200).default(''),
  confirm: z.boolean().default(false),
});

const json = (data: unknown, status = 200) => Response.json(data, { status });

/**
 * Analiza i uvoz datoteke koja je prethodno poslana u dijelovima (/api/postavke/uvoz/dio).
 *   mode=analyze → prepoznati oblik, brojevi po entitetu, upozorenja, primjeri
 *   mode=import  → upis u novu firmu ili u trenutnu (uz potvrdu ako nije prazna)
 * Ruta umjesto server akcije: datoteke do 256 MB i dugotrajan upis.
 */
export async function POST(req: Request) {
  const mode = { current: 'analyze' as 'analyze' | 'import' };
  try {
    const user = await requireAdmin();
    const o = input.parse(await req.json());
    mode.current = o.mode;
    return await withUserLock(user.id, async () => {
      const t0 = Date.now();
      const { plan, notes } = planFromJson(await readUpload(user.id, o.uploadId));

      if (o.mode === 'analyze') {
        const analysis = await analyzePlan(plan, notes, user.companyId);
        return json({ ok: true, analysis, parseMs: Date.now() - t0 });
      }

      if (o.target === 'current') {
        if (plan.source.format === 'erp-wms-backup') throw new DomainError('Sigurnosna kopija se vraća samo u novu firmu.');
        const [items, invoices, partners] = await Promise.all([
          db.item.count({ where: { companyId: user.companyId } }),
          db.invoice.count({ where: { companyId: user.companyId } }),
          db.partner.count({ where: { companyId: user.companyId } }),
        ]);
        if ((items || invoices || partners) && !o.confirm) {
          return json({ error: 'Trenutna firma već ima podatke — potvrdite uvoz u nju (postojeći zapisi se preskaču).' }, 409);
        }
      }
      const result = await runImport(plan, {
        target: o.target === 'new' ? { kind: 'new', name: o.name } : { kind: 'current' },
        actor: { id: user.id, name: user.name, email: user.email, companyId: user.companyId },
        summary: plan.source.format === 'erp-wms-backup' ? 'Vraćanje iz sigurnosne kopije' : `Uvoz iz stare verzije${o.fileName ? ` (${o.fileName})` : ''}`,
      });
      await removeUpload(user.id, o.uploadId);
      return json({
        ok: true,
        result,
        labels: { ...ENTITY_LABEL, expenseCategories: 'Kategorije troškova' },
        warningTotal: Object.values(plan.warningCounts).reduce((a, b) => a + b, 0),
      });
    });
  } catch (e) {
    if (e instanceof AuthError) return json({ error: e.message }, e.status);
    if (e instanceof DomainError) return json({ error: e.message }, 400);
    if (e instanceof z.ZodError) return json({ error: 'Neispravan zahtjev.' }, 400);
    console.error('[uvoz]', e);
    const msg = e instanceof Error ? e.message.split('\n').filter(Boolean).slice(-1)[0] : 'nepoznata greška';
    return json({ error: mode.current === 'import' ? `Uvoz nije uspio: ${msg}. Ništa nije upisano.` : `Analiza nije uspjela: ${msg}.` }, 500);
  }
}
