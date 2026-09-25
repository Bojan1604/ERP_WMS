import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SearchCheck } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { can, canUseDanger } from '@/domain/permissions';
import { listBackups } from '@/server/jobs/backups';
import { databaseStats, integrityCheck } from '@/server/services/maintenance';
import { Badge, Card, Notice, PageHeader } from '@/components/ui/misc';
import { Backups } from '@/components/settings/backups';
import { DangerZone, IntegrityFix, Maintenance } from '@/components/settings/danger-zone';
import { buttonClass } from '@/components/ui/button';
import { integer } from '@/lib/format';

export const metadata = { title: 'Podaci i kopije' };

type Params = Record<string, string | string[] | undefined>;

/** Sigurnosne kopije, stanje baze, provjera dosljednosti, održavanje i opasna zona (F10–F12). */
export default async function DataPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('settings');
  const isAdmin = user.role === 'ADMIN';
  const danger = canUseDanger({ role: user.role, canDanger: user.canDanger });
  if (!isAdmin && !danger) redirect('/zabranjeno?modul=settings');
  const sp = await searchParams;
  const check = sp.provjera === '1';
  const [company, backups, stats, findings] = await Promise.all([
    db.company.findUniqueOrThrow({ where: { id: user.companyId }, select: { name: true, isDemo: true, autoBackup: true, backupKeep: true, backupReminderDays: true, lastBackupAt: true } }),
    listBackups(user.companyId),
    databaseStats(user.companyId),
    check ? integrityCheck(user.companyId) : null,
  ]);
  const auditTotal = stats.rows.find((r) => r[0] === 'Zapisa u dnevniku')?.[1] ?? 0;
  return (
    <>
      <PageHeader title="Podaci i kopije" subtitle={`${company.name} · sigurnosne kopije, provjera dosljednosti, održavanje i opasna zona`} />
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Backups
            rows={backups}
            settings={{ autoBackup: company.autoBackup, backupKeep: company.backupKeep, backupReminderDays: company.backupReminderDays }}
            canEdit={can(user.perms, 'settings', 'edit')}
            isAdmin={isAdmin}
            canDanger={danger}
            lastBackupAt={company.lastBackupAt?.toISOString() ?? null}
          />
          <Card
            title="Provjera dosljednosti"
            actions={
              <div className="flex gap-2">
                <Link prefetch={false} href="/postavke/podaci?provjera=1" className={buttonClass('secondary', 'sm')}>
                  <SearchCheck className="size-3.5" /> {check ? 'Provjeri ponovno' : 'Provjeri'}
                </Link>
                {isAdmin && findings?.some((f) => f.fixable) && <IntegrityFix />}
              </div>
            }
          >
            <p className="mb-2 text-sm text-fg-3">
              Traži uređaje u nemogućem stanju (u najmu bez ugovora, prodan bez računa, na skladištu vezan uz partnera), ugovore bez uređaja, duple serijske brojeve, brojače iza izdanih brojeva i trošak robe po narudžbenici koji ne odgovara pravilu (dvostruko knjiženje primke i računa). Nalazi „auto" popravljaju se jednim klikom; ostale treba pogledati ručno.
            </p>
            {findings === null ? null : findings.length === 0 ? (
              <Notice tone="ok">Sve je dosljedno — nema nalaza.</Notice>
            ) : (
              <ul className="divide-y divide-line">
                {findings.map((f) => (
                  <li key={f.code} className="py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{f.label}</span>
                      <Badge tone="warn">{integer(f.count)}</Badge>
                      {f.fixable ? <Badge tone="ok">auto</Badge> : <Badge>ručno</Badge>}
                    </div>
                    <p className="text-xs text-fg-3">{f.hint}</p>
                    <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-sm">
                      {f.samples.map((s, i) =>
                        s.href ? (
                          <Link prefetch={false} key={i} href={s.href} className="text-brand hover:underline">
                            {s.label}
                          </Link>
                        ) : (
                          <span key={i}>{s.label}</span>
                        ),
                      )}
                      {f.count > f.samples.length && <span className="text-fg-3">… i još {integer(f.count - f.samples.length)}</span>}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <DangerZone companyName={company.name} isDemo={company.isDemo} canDanger={danger} />
        </div>
        <div className="space-y-4">
          <Card title="Stanje baze" padded={false}>
            <table className="data-table no-stack">
              <tbody>
                {stats.rows.map(([k, v]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td className="num font-medium">{integer(v)}</td>
                  </tr>
                ))}
                <tr>
                  <td>Veličina priloga</td>
                  <td className="num font-medium">{(stats.attachmentBytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB</td>
                </tr>
              </tbody>
            </table>
          </Card>
          <Maintenance isAdmin={isAdmin} canCleanLog={danger && can(user.perms, 'log')} auditTotal={auditTotal} />
        </div>
      </div>
    </>
  );
}
