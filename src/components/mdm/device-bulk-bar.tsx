'use client';

import type { Platform } from '@/domain/mdm';
import { SelectionBar } from '@/components/ui/selection';
import { CommandButton } from './device-command-button';
import { AssignProfileButton, MoveDevicesButton, type OrgOpt, type ProfileOpt, type SiteOpt } from './device-assign';

/** Skupne radnje nad označenim uređajima. */
export function DeviceBulkBar({
  platforms,
  canEdit,
  orgs,
  sites,
  profiles,
}: {
  /** Platforma po id-u uređaja na stranici. */
  platforms: Record<string, Platform>;
  canEdit: boolean;
  orgs: OrgOpt[];
  sites: SiteOpt[];
  profiles: ProfileOpt[];
}) {
  return (
    <SelectionBar>
      {(ids, clear) => {
        const plats = [...new Set(ids.map((id) => platforms[id]).filter(Boolean))];
        const p = { ids, onDone: clear, size: 'sm' as const, variant: 'secondary' as const };
        return (
          <>
            <CommandButton {...p} type="REBOOT" />
            <CommandButton {...p} type="SCREENSHOT" label="Snimka" />
            <CommandButton {...p} type="UPLOAD_LOGS" />
            <CommandButton {...p} type="MESSAGE" />
            <CommandButton {...p} type="LOCK" />
            {canEdit && (
              <>
                <MoveDevicesButton {...p} orgs={orgs} sites={sites} />
                <AssignProfileButton {...p} profiles={profiles} platforms={plats} />
                <CommandButton {...p} type="FORGET" variant="danger" />
              </>
            )}
          </>
        );
      }}
    </SelectionBar>
  );
}
