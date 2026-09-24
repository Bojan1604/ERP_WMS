'use client';

import { useState } from 'react';
import { ArrowRightLeft, SlidersHorizontal } from 'lucide-react';
import { PLATFORM_LABEL, type Platform } from '@/domain/mdm';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select } from '@/components/ui/field';
import { useAction } from '@/components/ui/action';
import { assignProfileAction, moveDevicesAction } from '@/app/(app)/mdm/uredaji/actions';

export interface OrgOpt {
  id: string;
  label: string;
}
export interface SiteOpt {
  id: string;
  name: string;
  orgId: string;
}
export interface ProfileOpt {
  id: string;
  name: string;
  platform: Platform;
}

/** Premještaj uređaja na organizaciju/lokaciju. */
export function MoveDevicesButton({
  ids,
  orgs,
  sites,
  current,
  onDone,
  variant = 'secondary',
  size,
}: {
  ids: string[];
  orgs: OrgOpt[];
  sites: SiteOpt[];
  current?: { orgId: string | null; siteId: string | null };
  onDone?: () => void;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
}) {
  const [open, setOpen] = useState(false);
  const [orgId, setOrgId] = useState(current?.orgId ?? '');
  const [siteId, setSiteId] = useState(current?.siteId ?? '');
  const { run, pending } = useAction(moveDevicesAction, { onSuccess: () => onDone?.() });
  const orgSites = sites.filter((s) => s.orgId === orgId);
  return (
    <>
      <Button variant={variant} size={size} icon={<ArrowRightLeft className="size-4" />} onClick={() => setOpen(true)}>
        Premjesti
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Premještaj uređaja"
        size="sm"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={!orgId}
              onClick={async () => {
                const r = await run({ ids, orgId, siteId: siteId || null });
                if (r.ok) setOpen(false);
              }}
            >
              Premjesti
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {ids.length > 1 && <p className="text-base text-fg-2">Odabrano uređaja: <b>{ids.length}</b></p>}
          <Field label="Organizacija" required>
            <Select
              value={orgId}
              onChange={(e) => {
                setOrgId(e.target.value);
                setSiteId('');
              }}
              placeholder="— odaberite —"
              options={orgs.map((o) => ({ value: o.id, label: o.label }))}
            />
          </Field>
          <Field label="Lokacija" hint={orgId && !orgSites.length ? 'Organizacija nema lokacija.' : 'Profil lokacije vrijedi za uređaje bez vlastitog profila.'}>
            <Select value={siteId} onChange={(e) => setSiteId(e.target.value)} placeholder="— bez lokacije —" options={orgSites.map((s) => ({ value: s.id, label: s.name }))} disabled={!orgId} />
          </Field>
        </div>
      </Dialog>
    </>
  );
}

/** Dodjela profila (konfiguracije); prazno = profil lokacije. */
export function AssignProfileButton({
  ids,
  profiles,
  platforms,
  current,
  onDone,
  variant = 'secondary',
  size,
}: {
  ids: string[];
  profiles: ProfileOpt[];
  /** Platforme odabranih uređaja (za sužavanje popisa). */
  platforms?: Platform[];
  current?: string | null;
  onDone?: () => void;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
}) {
  const [open, setOpen] = useState(false);
  const [profileId, setProfileId] = useState(current ?? '');
  const { run, pending } = useAction(assignProfileAction, { onSuccess: () => onDone?.() });
  const list = platforms?.length === 1 ? profiles.filter((p) => p.platform === platforms[0]) : profiles;
  return (
    <>
      <Button variant={variant} size={size} icon={<SlidersHorizontal className="size-4" />} onClick={() => setOpen(true)}>
        Konfiguracija
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Dodjela konfiguracije (profila)"
        size="sm"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            <Button
              variant="primary"
              loading={pending}
              onClick={async () => {
                const r = await run({ ids, profileId: profileId || null });
                if (r.ok) setOpen(false);
              }}
            >
              Dodijeli
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {ids.length > 1 && <p className="text-base text-fg-2">Odabrano uređaja: <b>{ids.length}</b></p>}
          {platforms && platforms.length > 1 && <p className="text-sm text-warn">Odabrani su uređaji različitih platformi — profil vrijedi samo za jednu.</p>}
          <Field label="Profil" hint="Promjena podiže verziju konfiguracije; agent je preuzima pri sljedećem javljanju.">
            <Select
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
              placeholder="— profil lokacije —"
              options={list.map((p) => ({ value: p.id, label: `${p.name} (${PLATFORM_LABEL[p.platform]})` }))}
            />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
