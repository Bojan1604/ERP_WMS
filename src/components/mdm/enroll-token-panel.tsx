// podpaket „node" nosi tipove; glavni ulaz ih u TS-u s moduleResolution bundler ne izlaže
import bwipjs from 'bwip-js/node';
import { Download, TriangleAlert } from 'lucide-react';
import { androidProvisioning, windowsInstallCommand } from '@/server/mdm/enroll';
import { Card, Notice } from '@/components/ui/misc';
import { buttonClass } from '@/components/ui/button';
import { CopyButton } from './enroll-forms';

/** QR (SVG, na poslužitelju) s bijelom podlogom i rubom — čitljiv i u tamnoj temi. */
function qrSvg(text: string) {
  const opts = { bcid: 'qrcode', text, eclevel: 'M', paddingwidth: 4, paddingheight: 4, backgroundcolor: 'FFFFFF' };
  return bwipjs.toSVG(opts as Parameters<typeof bwipjs.toSVG>[0]);
}

/** Upute za automatski upis s ključem: Android QR (Device Owner) i Windows PowerShell. */
export function EnrollTokenPanel({ appUrl, token, title, checksum }: { appUrl: string; token: string; title: string; checksum: string | null }) {
  const json = JSON.stringify(androidProvisioning(appUrl, token, checksum));
  const pretty = JSON.stringify(androidProvisioning(appUrl, token, checksum), null, 2);
  const ps = windowsInstallCommand(appUrl, token);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title={`Android — QR za upis (${title})`}>
        {!checksum && (
          <Notice tone="warn">
            <span className="inline-flex items-start gap-1.5">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span>
                Nije postavljen <code className="font-mono">MDM_ANDROID_SIGNATURE_CHECKSUM</code> (SHA-256 potpisa APK-a agenta, base64url). Bez njega Android odbija
                QR upis.
              </span>
            </span>
          </Notice>
        )}
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="w-full max-w-64 shrink-0 self-center rounded-lg bg-white p-1 [&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: qrSvg(json) }} />
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-fg-2">
            <li>Uređaj vratite na tvorničke postavke (novi uređaj je već u tom stanju).</li>
            <li>Na zaslonu dobrodošlice dodirnite <b>6 puta</b> isto mjesto na zaslonu — otvara se čitač QR koda.</li>
            <li>Spojite uređaj na Wi-Fi kad to zatraži (potreban je internet).</li>
            <li>Skenirajte ovaj QR kod.</li>
            <li>Prihvatite uvjete („Accept & continue") — uređaj preuzima i instalira agenta kao upravitelja uređaja.</li>
            <li>Agent se javlja poslužitelju i uređaj se upisuje automatski u odabranu organizaciju i lokaciju.</li>
          </ol>
        </div>
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-fg-3">Sadržaj QR koda (JSON)</summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs scroll-slim">{pretty}</pre>
          <div className="mt-2">
            <CopyButton text={json} label="Kopiraj JSON" />
          </div>
        </details>
        <div className="mt-3 flex flex-wrap gap-2">
          <a href="/api/mdm/agent/download/android" className={buttonClass('secondary', 'sm')}>
            <Download className="size-4" /> APK agenta
          </a>
        </div>
        <p className="mt-2 text-xs text-fg-3">
          Ručna instalacija (bez QR-a): instalirajte APK, pokrenite agenta, upišite adresu poslužitelja {appUrl} — agent prikazuje kod za upis.
        </p>
      </Card>

      <Card title="Windows — instalacija agenta">
        <p className="mb-2 text-sm text-fg-2">U PowerShellu pokrenutom kao administrator zalijepite i pokrenite:</p>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2.5 font-mono text-xs scroll-slim">{ps}</pre>
        <div className="mt-2 flex flex-wrap gap-2">
          <CopyButton text={ps} label="Kopiraj naredbu" />
          <a href="/api/mdm/agent/download/windows" className={buttonClass('secondary', 'sm')}>
            <Download className="size-4" /> Agent (ZIP)
          </a>
        </div>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-fg-2">
          <li>Skripta preuzima agenta, instalira ga kao Windows servis i pokreće ga.</li>
          <li>Agent se javlja s ključem i uređaj se upisuje automatski.</li>
          <li>Za ručni upis (bez ključa) izostavite <code className="font-mono">-Token</code> — agent tada prikazuje kod za upis.</li>
        </ol>
      </Card>
    </div>
  );
}
