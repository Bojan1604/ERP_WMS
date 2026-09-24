import { requireAccess } from '@/server/auth';
import { db, transaction } from '@/server/db';
import { toError } from '@/server/action';
import { AuthError, DomainError } from '@/server/errors';
import { getMdmScope } from '@/server/mdm/scope';
import { removeFile, saveBuffer } from '@/server/mdm/storage';
import { cleanFileName, createFileRecord, MAX_BYTES, uploadOrg, type LibraryKind } from '@/server/mdm/files';
import { addAppVersion, findApp } from '@/server/mdm/apps';
import { ApkError, defaultInstallArgs, parseApk } from '@/domain/apk';

/**
 * Prijenos u MDM knjižnicu (do 200 MB): instalacijski paket (APP), datoteka za
 * uređaje (FILE) ili dokument (DOC).
 *
 * Tijelo je sama datoteka (`fetch(url, { body: file })`) s podacima u query
 * stringu — tako se veličina provjerava dok se čita, bez međuspremanja cijelog
 * multiparta. Podržan je i multipart/form-data (polje `file` + ista polja) za
 * manje datoteke. Ruta je izuzeta iz middlewarea (ograničenje od 10 MB).
 *
 * Polja: kind (APP|FILE|DOC), name (naziv datoteke), orgId, te za APP: platform,
 * appId (nova verzija postojeće), appName, version, versionCode, packageName, installArgs, notes.
 */
export const maxDuration = 300;

const MIME: Record<string, string> = {
  apk: 'application/vnd.android.package-archive',
  msi: 'application/x-msi',
  exe: 'application/vnd.microsoft.portable-executable',
  pdf: 'application/pdf',
};

class TooLarge extends Error {}

async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new TooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

const str = (v: FormDataEntryValue | string | null | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export async function POST(req: Request) {
  let savedKey: string | null = null;
  try {
    const user = await requireAccess('mdm', 'edit');
    const scope = await getMdmScope(user);
    const url = new URL(req.url);
    let fields: (k: string) => string | null = (k) => str(url.searchParams.get(k));
    const kind = (fields('kind') ?? 'FILE').toUpperCase() as LibraryKind;
    if (!['APP', 'FILE', 'DOC'].includes(kind)) throw new DomainError('Nepoznata vrsta datoteke.');
    const max = MAX_BYTES[kind];
    const declared = Number(req.headers.get('content-length') ?? 0);
    if (declared > max + 64 * 1024) throw new TooLarge();

    let buf: Buffer;
    let fileName: string | null;
    let mime = req.headers.get('content-type') ?? '';
    if (mime.startsWith('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('file');
      if (!file || typeof file === 'string') throw new DomainError('Niste odabrali datoteku.');
      if (file.size > max) throw new TooLarge();
      buf = Buffer.from(await file.arrayBuffer());
      const q = fields;
      fields = (k) => str(form.get(k)) ?? q(k);
      fileName = fields('name') ?? file.name;
      mime = file.type;
    } else {
      buf = await readCapped(req.body, max);
      fileName = fields('name');
    }
    if (!buf.length) throw new DomainError('Datoteka je prazna.');
    const name = cleanFileName(fileName ?? 'datoteka');
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
    mime = MIME[ext] ?? (mime && !mime.startsWith('multipart/') ? mime.split(';')[0].trim() : 'application/octet-stream');

    // podaci paketa se čitaju prije spremanja — neispravan APK se ni ne sprema
    let app: Parameters<typeof addAppVersion>[3] | null = null;
    if (kind === 'APP') {
      const appId = fields('appId');
      const existing = appId ? await findApp(db, scope, appId) : null;
      const platform = existing?.platform ?? (fields('platform') === 'WINDOWS' ? 'WINDOWS' : 'ANDROID');
      const versionCodeRaw = fields('versionCode');
      const base = { appId, platform, notes: fields('notes'), fileId: '' } as const;
      if (platform === 'ANDROID') {
        if (ext !== 'apk') throw new DomainError('Za Android odaberite .apk datoteku.');
        const info = parseApk(buf);
        app = {
          ...base,
          orgId: existing?.orgId ?? null,
          packageName: info.packageName,
          name: fields('appName') ?? existing?.name ?? info.label ?? info.packageName,
          version: fields('version') ?? info.versionName ?? String(info.versionCode ?? '1'),
          versionCode: info.versionCode,
          installArgs: null,
        };
      } else {
        if (ext !== 'msi' && ext !== 'exe') throw new DomainError('Za Windows odaberite .msi ili .exe instalacijski paket.');
        const appName = fields('appName') ?? existing?.name;
        const version = fields('version');
        if (!appName) throw new DomainError('Upišite naziv aplikacije.');
        if (!version) throw new DomainError('Upišite verziju.');
        if (versionCodeRaw && !/^\d{1,9}$/.test(versionCodeRaw)) throw new DomainError('Broj verzije mora biti cijeli broj.');
        app = {
          ...base,
          orgId: existing?.orgId ?? null,
          packageName: existing?.packageName ?? fields('packageName') ?? appName,
          name: appName,
          version: version.slice(0, 50),
          versionCode: versionCodeRaw ? Number(versionCodeRaw) : null,
          installArgs: fields('installArgs') ?? existing?.installArgs ?? defaultInstallArgs(name),
        };
      }
      if (app.name.length > 120 || app.packageName.length > 200) throw new DomainError('Naziv ili paket je predug.');
    }

    const stored = await saveBuffer(buf);
    savedKey = stored.key;
    const result = await transaction(async (tx) => {
      const orgId = app?.appId ? app.orgId : await uploadOrg(tx, scope, fields('orgId'));
      const file = await createFileRecord(tx, scope, user, { kind, orgId, name, mime, size: stored.size, sha256: stored.sha256, storageKey: stored.key });
      if (!app) return { fileId: file.id, name };
      const v = await addAppVersion(tx, scope, user, { ...app, orgId, fileId: file.id });
      return { fileId: file.id, ...v };
    });
    savedKey = null;
    return Response.json({ ok: true, data: result });
  } catch (e) {
    if (savedKey) await removeFile(savedKey).catch(() => {});
    if (e instanceof TooLarge) return Response.json({ ok: false, error: 'Datoteka je prevelika.' }, { status: 413 });
    if (e instanceof ApkError) return Response.json({ ok: false, error: `APK: ${e.message}` }, { status: 400 });
    const err = toError(e);
    const status = e instanceof AuthError ? e.status : err.error.startsWith('Došlo je do neočekivane') ? 500 : 400;
    return Response.json(err, { status });
  }
}
