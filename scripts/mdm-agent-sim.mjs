#!/usr/bin/env node
/**
 * Simulator MDM agenata (protokol v1, docs/mdm-agent-protocol.md) — bez ovisnosti, samo Node ≥ 20.
 *
 *   node scripts/mdm-agent-sim.mjs --url http://localhost:3100 --count 25 --token <enrollToken>
 *   node scripts/mdm-agent-sim.mjs --help
 *
 * Mješavina Android ručnih terminala (Sunmi V2s, Zebra TC27, Urovo DT50), Android POS računala
 * (Sunmi T2s, Sunmi D3 Pro) i Windows računala. Uređaji se registriraju (s ključem upisa ili kao
 * PENDING), javljaju se s promjenjivom telemetrijom i izvršavaju naredbe (REBOOT, SCREENSHOT → PNG
 * s nazivom uređaja i vremenom, UPLOAD_LOGS, INSTALL_APP s provjerom sha256, konfiguracija, FORGET…).
 * Ključevi uređaja čuvaju se u datoteci stanja pa ponovno pokretanje koristi iste uređaje.
 *
 * Mjerenje opterećenja: --bench <javljanja/min> --duration <s> (npr. --count 200 --bench 1000 --duration 120).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

// ---------------------------------------------------------------- argumenti

const HELP = `Simulator MDM agenata (protokol v1)

  node scripts/mdm-agent-sim.mjs [opcije]

  --url <adresa>        poslužitelj (zadano http://localhost:3100 ili MDM_SIM_URL)
  --count <n>           broj uređaja (zadano 25)
  --token <ključ>       ključ upisa (MdmEnrollToken.token) ili MDM_ENROLL_TOKEN; bez njega uređaji čekaju upis (PENDING)
  --interval <s>        razmak javljanja u sekundama (zadano 5; pravi agent koristi checkinSec = 60)
  --duration <s>        radi toliko sekundi pa izađi (zadano: do Ctrl+C)
  --once                registriraj, javi se jednom i izađi (brzo stvaranje demo uređaja)
  --state <datoteka>    datoteka stanja (zadano storage/mdm-sim-state.json)
  --prefix <tekst>      prefiks naziva uređaja (zadano "Sim")
  --no-xff              ne šalji X-Forwarded-For (inače svaka „trgovina" ima svoju javnu IP adresu)
  --bench <n/min>       mjerenje: ukupno n javljanja u minuti ravnomjerno po uređajima; ispisuje kašnjenja
  --quiet               bez ispisa pojedinačnih naredbi
  --help
`;

function parseArgs(argv) {
  const o = {
    url: process.env.MDM_SIM_URL || 'http://localhost:3100',
    count: 25,
    token: process.env.MDM_ENROLL_TOKEN || null,
    interval: 5,
    duration: 0,
    once: false,
    state: path.join('storage', 'mdm-sim-state.json'),
    prefix: 'Sim',
    xff: true,
    bench: 0,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Nedostaje vrijednost za ${a}`);
      return v;
    };
    if (a === '--help' || a === '-h') {
      console.log(HELP);
      process.exit(0);
    } else if (a === '--url') o.url = next().replace(/\/+$/, '');
    else if (a === '--count') o.count = Math.max(1, Number(next()) | 0);
    else if (a === '--token') o.token = next();
    else if (a === '--interval') o.interval = Math.max(1, Number(next()));
    else if (a === '--duration') o.duration = Math.max(1, Number(next()));
    else if (a === '--once') o.once = true;
    else if (a === '--state') o.state = next();
    else if (a === '--prefix') o.prefix = next();
    else if (a === '--no-xff') o.xff = false;
    else if (a === '--bench') o.bench = Math.max(1, Number(next()));
    else if (a === '--quiet') o.quiet = true;
    else throw new Error(`Nepoznata opcija ${a} (--help)`);
  }
  return o;
}

const opt = parseArgs(process.argv.slice(2));
const API = `${opt.url}/api/mdm/agent`;

// ---------------------------------------------------------------- vrste uređaja

const ANDROID_BASE_APPS = [
  { packageName: 'com.android.chrome', name: 'Chrome', version: '128.0.6613.146', versionCode: 661314633 },
  { packageName: 'com.google.android.webview', name: 'Android System WebView', version: '128.0.6613.146', versionCode: 661314634 },
  { packageName: 'hr.wms.mdm.agent', name: 'WMS MDM agent', version: '1.0.0', versionCode: 100 },
];
const WINDOWS_BASE_APPS = [
  { packageName: '{A7C4F5B1-0D3E-4F7A-9C1B-5E2D8F6A3B90}', name: 'Microsoft Edge', version: '128.0.2739.79' },
  { packageName: '{90160000-008C-0000-1000-0000000FF1CE}', name: 'Microsoft Visual C++ 2015-2022 Redistributable (x64)', version: '14.40.33810' },
  { packageName: 'WmsMdmAgent', name: 'WMS MDM agent', version: '1.0.0' },
];

/** kind: HANDHELD (baterija, Wi-Fi), POS (napajanje, Ethernet/Wi-Fi), PC (Windows) */
const SPECS = [
  { key: 'v2s', platform: 'ANDROID', kind: 'HANDHELD', manufacturer: 'SUNMI', model: 'V2s', os: 'Android 11 (SDK 30)', ram: 2048, storage: 16384, screen: [240, 426], patch: '2024-03-05', label: 'Konobar' },
  { key: 'tc27', platform: 'ANDROID', kind: 'HANDHELD', manufacturer: 'Zebra Technologies', model: 'TC27', os: 'Android 13 (SDK 33)', ram: 4096, storage: 32768, screen: [240, 426], patch: '2024-07-01', label: 'Skladište' },
  { key: 'dt50', platform: 'ANDROID', kind: 'HANDHELD', manufacturer: 'Urovo', model: 'DT50', os: 'Android 11 (SDK 30)', ram: 3072, storage: 32768, screen: [240, 426], patch: '2023-11-05', label: 'Narudžbe' },
  { key: 't2s', platform: 'ANDROID', kind: 'POS', manufacturer: 'SUNMI', model: 'T2s', os: 'Android 9 (SDK 28)', ram: 2048, storage: 16384, screen: [480, 270], patch: '2023-05-01', label: 'Blagajna' },
  { key: 'd3pro', platform: 'ANDROID', kind: 'POS', manufacturer: 'SUNMI', model: 'D3 Pro', os: 'Android 13 (SDK 33)', ram: 4096, storage: 65536, screen: [480, 270], patch: '2024-06-05', label: 'Blagajna' },
  { key: 'optiplex', platform: 'WINDOWS', kind: 'PC', manufacturer: 'Dell Inc.', model: 'OptiPlex 3000', os: 'Windows 11 Pro 23H2 (22631.4169)', ram: 8192, storage: 243000, screen: [480, 270], cpu: 'Intel Core i3-12100T', label: 'Ured' },
  { key: 'prodesk', platform: 'WINDOWS', kind: 'PC', manufacturer: 'HP', model: 'ProDesk 400 G7 SFF', os: 'Windows 10 Pro 22H2 (19045.4894)', ram: 8192, storage: 476000, screen: [480, 270], cpu: 'Intel Core i5-10500', label: 'Back office' },
  { key: 'm70q', platform: 'WINDOWS', kind: 'PC', manufacturer: 'LENOVO', model: 'ThinkCentre M70q Gen 4', os: 'Windows 11 Pro 23H2 (22631.4169)', ram: 16384, storage: 476000, screen: [480, 270], cpu: 'Intel Core i5-13400T', label: 'Blagajna PC' },
];
// raspodjela za 25: 3+3+2 ručna, 5+4 POS, 3+3+2 PC
const MIX = ['v2s', 'v2s', 'v2s', 'tc27', 'tc27', 'tc27', 'dt50', 'dt50', 't2s', 't2s', 't2s', 't2s', 't2s', 'd3pro', 'd3pro', 'd3pro', 'd3pro', 'optiplex', 'optiplex', 'optiplex', 'prodesk', 'prodesk', 'prodesk', 'm70q', 'm70q'];
const specOf = (key) => SPECS.find((s) => s.key === key);

const rnd = (a, b) => a + Math.random() * (b - a);
const rint = (a, b) => Math.floor(rnd(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const SSIDS = ['Lokal-5G', 'Caffe_Bar', 'Restoran-Staff', 'WMS-Skladiste', 'Trgovina_POS'];

function newDevice(index) {
  const spec = specOf(MIX[index % MIX.length]);
  const shop = Math.floor(index / 5);
  const serialPrefix = { v2s: 'V2S', tc27: '23', dt50: 'DT5', t2s: 'T2S', d3pro: 'D3P', optiplex: 'CN0', prodesk: 'CZC', m70q: 'PF4' }[spec.key];
  return {
    index,
    spec: spec.key,
    hardwareId: spec.platform === 'WINDOWS' ? randomUUID().toUpperCase() : randomBytes(8).toString('hex'),
    serial: `${serialPrefix}${randomBytes(4).toString('hex').toUpperCase()}`,
    name: `${opt.prefix} ${spec.label} ${String(index + 1).padStart(2, '0')}`,
    imei: spec.kind === 'HANDHELD' ? `35${String(rint(1e12, 9.99e12))}` : null,
    macAddress: Array.from({ length: 6 }, (_, i) => (i === 0 ? 0x02 : rint(0, 255)).toString(16).padStart(2, '0')).join(':').toUpperCase(),
    ipAddress: `192.168.${10 + shop}.${20 + (index % 5)}`,
    publicIp: `${pick([78, 89, 93, 95, 188])}.${rint(1, 254)}.${rint(1, 254)}.${rint(1, 254)}`,
    wifiSsid: spec.kind === 'PC' && index % 2 ? null : SSIDS[shop % SSIDS.length],
    battery: spec.kind === 'HANDHELD' ? rint(35, 100) : null,
    charging: false,
    storageFree: Math.round(spec.storage * rnd(0.25, 0.7)),
    agentVersion: '1.0.0',
    apps: (spec.platform === 'WINDOWS' ? WINDOWS_BASE_APPS : ANDROID_BASE_APPS).map((a) => ({ ...a })),
    appliedConfigVersion: 0,
    token: null,
    deviceId: null,
    status: null,
    done: {},
    bootAt: Date.now() - rint(600, 14 * 86400) * 1000,
  };
}

// ---------------------------------------------------------------- stanje na disku

function loadState() {
  try {
    return JSON.parse(readFileSync(opt.state, 'utf8'));
  } catch {
    return {};
  }
}
let saveTimer = null;
function saveState(now = false) {
  const write = () => {
    saveTimer = null;
    const all = loadState();
    all[opt.url] = { savedAt: new Date().toISOString(), devices: devices.map(({ busy, offlineUntil, stopped, lastAppsAt, events, ...d }) => d) };
    mkdirSync(path.dirname(path.resolve(opt.state)), { recursive: true });
    const tmp = `${opt.state}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 1), { mode: 0o600 });
    renameSync(tmp, opt.state);
  };
  if (now) return write();
  if (!saveTimer) saveTimer = setTimeout(write, 1000);
}

// ---------------------------------------------------------------- HTTP

const stats = { checkins: 0, errors: 0, lat: [], commands: 0, registered: 0, byStatus: {} };

async function call(d, method, p, { json, body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (d.token) h.authorization = `Device ${d.token}`;
  if (opt.xff) h['x-forwarded-for'] = d.publicIp;
  if (json !== undefined) {
    h['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(`${API}${p}`, { method, headers: h, body, signal: AbortSignal.timeout(60_000) });
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text.slice(0, 200) };
  }
  return { status: res.status, data, headers: res.headers };
}

const log = (d, msg) => {
  if (!opt.quiet) console.log(`${new Date().toISOString().slice(11, 19)} [${d.name}] ${msg}`);
};

// ---------------------------------------------------------------- registracija

async function register(d) {
  const spec = specOf(d.spec);
  const body = {
    protocol: 1,
    platform: spec.platform,
    enrollToken: opt.token,
    hardwareId: d.hardwareId,
    serial: d.serial,
    manufacturer: spec.manufacturer,
    model: spec.model,
    osVersion: spec.os,
    agentVersion: d.agentVersion,
    name: d.name,
  };
  for (let attempt = 0; ; attempt++) {
    d.token = null;
    const r = await call(d, 'POST', '/register', { json: body });
    if (r.status === 200) {
      Object.assign(d, { token: r.data.token, deviceId: r.data.deviceId, status: r.data.status, appliedConfigVersion: 0, done: {} });
      stats.registered++;
      log(d, `registriran: ${r.data.status}${r.data.enrollCode ? ` — kod za upis ${r.data.enrollCode}` : ''}`);
      saveState();
      return true;
    }
    if (r.status === 403 && r.data?.code === 'ENROLL_TOKEN_INVALID' && body.enrollToken) {
      log(d, 'ključ upisa ne vrijedi — registracija bez ključa (PENDING)');
      body.enrollToken = null;
      continue;
    }
    if (r.status === 429) {
      const wait = Number(r.headers.get('retry-after') || 60);
      log(d, `previše registracija, čekam ${wait} s`);
      await sleep(wait * 1000);
      continue;
    }
    stats.errors++;
    log(d, `registracija neuspjela: ${r.status} ${r.data?.error ?? ''}`);
    if (attempt >= 3) return false;
    await sleep(2000 * 2 ** attempt);
  }
}

// ---------------------------------------------------------------- telemetrija

function tick(d, dtSec) {
  const spec = specOf(d.spec);
  if (d.battery !== null) {
    if (d.charging) {
      d.battery = clamp(d.battery + rnd(0.3, 1.2) * (dtSec / 5), 0, 100);
      if (d.battery >= 100 || Math.random() < 0.01) d.charging = false;
    } else {
      d.battery = clamp(d.battery - rnd(0.05, 0.6) * (dtSec / 5), 0, 100);
      if (d.battery < 20 ? Math.random() < 0.15 : Math.random() < 0.005) d.charging = true;
    }
  }
  d.storageFree = clamp(Math.round(d.storageFree + rnd(-8, 5) * (dtSec / 5)), 200, spec.storage);
  d.wifiSignal = clamp(Math.round((d.wifiSignal ?? -60) + rnd(-4, 4)), -88, -38);
}

function telemetry(d, withApps) {
  const spec = specOf(d.spec);
  const t = {
    serial: d.serial,
    manufacturer: spec.manufacturer,
    model: spec.model,
    osVersion: spec.os,
    agentVersion: d.agentVersion,
    imei: d.imei,
    macAddress: d.macAddress,
    ipAddress: d.ipAddress,
    wifiSsid: d.wifiSsid,
    wifiSignal: d.wifiSsid ? d.wifiSignal : null,
    batteryLevel: d.battery === null ? null : Math.round(d.battery),
    charging: d.battery === null ? null : d.charging,
    storageFreeMb: d.storageFree,
    storageTotalMb: spec.storage,
    ramTotalMb: spec.ram,
    uptimeSec: Math.round((Date.now() - d.bootAt) / 1000),
    extra:
      spec.platform === 'WINDOWS'
        ? { domain: 'WORKGROUP', user: 'blagajna', cpu: spec.cpu, ramFreeMb: Math.round(spec.ram * rnd(0.3, 0.6)), defender: 'up-to-date' }
        : { securityPatch: spec.patch, sdk: Number(/SDK (\d+)/.exec(spec.os)?.[1] ?? 0), kiosk: !!d.kiosk },
  };
  if (withApps) t.apps = d.apps;
  return t;
}

// ---------------------------------------------------------------- javljanje

async function checkin(d) {
  if (d.stopped || d.busy || (d.offlineUntil && Date.now() < d.offlineUntil)) return;
  if (d.offlineUntil) {
    d.offlineUntil = 0;
    d.bootAt = Date.now() - rint(20, 40) * 1000;
    (d.events ??= []).push({ at: new Date().toISOString(), level: 'info', type: 'BOOT', message: 'Agent pokrenut nakon ponovnog pokretanja.' });
    d.lastAppsAt = 0;
  }
  if (!d.token && !(await register(d))) return;
  d.busy = true;
  try {
    const withApps = !d.lastAppsAt || Date.now() - d.lastAppsAt > 3600_000 || d.appsChanged;
    const events = (d.events ?? []).splice(0, 50);
    const t0 = performance.now();
    let r;
    try {
      r = await call(d, 'POST', '/checkin', { json: { appliedConfigVersion: d.appliedConfigVersion, telemetry: telemetry(d, withApps), events } });
    } catch (e) {
      d.events = [...events, ...(d.events ?? [])];
      stats.errors++;
      log(d, `javljanje neuspjelo: ${e.message}`);
      return;
    }
    stats.lat.push(performance.now() - t0);
    stats.checkins++;
    if (r.status === 401) {
      log(d, '401 — ključ ne vrijedi, ponovna registracija');
      d.token = null;
      return;
    }
    if (r.status === 410) {
      log(d, 'uređaj odjavljen (410) — agent se gasi');
      retire(d);
      return;
    }
    if (r.status !== 200) {
      d.events = [...events, ...(d.events ?? [])];
      stats.errors++;
      log(d, `javljanje: ${r.status} ${r.data?.error ?? ''}`);
      return;
    }
    if (withApps) {
      d.lastAppsAt = Date.now();
      d.appsChanged = false;
    }
    const res = r.data;
    if (res.status !== d.status) {
      if (d.status && !opt.quiet) log(d, `status ${d.status} → ${res.status}`);
      d.status = res.status;
      saveState();
    }
    d.serverName = res.deviceName;
    stats.byStatus[d.deviceId] = res.status;
    if (res.config) await applyConfig(d, res.config, res.commands.some((c) => c.type === 'APPLY_CONFIG'));
    for (const c of res.commands) {
      if (d.stopped) break;
      await runCommand(d, c, res.config);
    }
  } finally {
    d.busy = false;
  }
}

function retire(d) {
  d.stopped = true;
  d.token = null;
  d.retired = true;
  saveState();
}

// ---------------------------------------------------------------- konfiguracija i aplikacije

async function download(d, downloadPath, expectSha) {
  if (!downloadPath?.startsWith('/api/mdm/agent/')) throw new Error('downloadPath nije na ovom poslužitelju');
  const res = await call(d, 'GET', downloadPath.slice('/api/mdm/agent'.length), { raw: true });
  if (res.status !== 200) throw new Error(`preuzimanje ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (expectSha && got !== expectSha) throw new Error(`sha256 se ne podudara (${got.slice(0, 12)}…)`);
  if (res.headers.get('x-content-sha256') && res.headers.get('x-content-sha256') !== got) throw new Error('X-Content-SHA256 se ne podudara');
  return buf;
}

async function installApp(d, a) {
  const have = d.apps.find((x) => x.packageName === a.packageName);
  const sameVersion = have && (a.versionCode != null ? have.versionCode === a.versionCode : have.version === a.version);
  if (sameVersion) return { skipped: true };
  if (!a.downloadPath) throw new Error('aplikacija nema datoteku za preuzimanje');
  const buf = await download(d, a.downloadPath, a.sha256);
  await sleep(rint(300, 1500)); // „instalacija"
  d.apps = d.apps.filter((x) => x.packageName !== a.packageName);
  d.apps.push({ packageName: a.packageName, name: a.name ?? a.packageName, version: a.version ?? '1.0', ...(a.versionCode != null ? { versionCode: a.versionCode } : {}) });
  d.appsChanged = true;
  return { bytes: buf.length };
}

async function applyConfig(d, cfg, forced) {
  const errors = [];
  for (const a of cfg.apps ?? []) {
    try {
      if (a.remove) {
        if (d.apps.some((x) => x.packageName === a.packageName)) {
          d.apps = d.apps.filter((x) => x.packageName !== a.packageName);
          d.appsChanged = true;
        }
      } else if (!a.downloadPath) {
        (d.events ??= []).push({ level: 'warn', type: 'CONFIG', message: `Aplikacija ${a.packageName} nema datoteku, preskočeno.` });
      } else {
        const r = await installApp(d, a);
        if (!r.skipped) log(d, `konfiguracija: instalirano ${a.packageName} ${a.version ?? ''}`);
      }
    } catch (e) {
      errors.push(`${a.packageName}: ${e.message}`);
    }
  }
  d.kiosk = !!cfg.settings?.kiosk;
  if (errors.length) {
    (d.events ??= []).push({ level: 'error', type: 'CONFIG', message: `Konfiguracija v${cfg.version} nije primijenjena: ${errors.join('; ')}`.slice(0, 1000) });
    log(d, `konfiguracija v${cfg.version} NIJE primijenjena: ${errors.join('; ')}`);
    return false;
  }
  if (d.appliedConfigVersion !== cfg.version || forced) log(d, `konfiguracija v${cfg.version} primijenjena${d.kiosk ? ' (kiosk)' : ''}`);
  d.appliedConfigVersion = cfg.version;
  saveState();
  return true;
}

// ---------------------------------------------------------------- naredbe

async function postResult(d, id, body) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await call(d, 'POST', `/commands/${id}`, { json: body });
      if (r.status < 500) return r;
    } catch {}
    await sleep(1000 * 2 ** i);
  }
  return null;
}

async function runCommand(d, c, cfg) {
  const prev = d.done[c.id];
  if (prev) {
    await postResult(d, c.id, prev); // ponovljena isporuka: rezultat se samo ponovno šalje
    return;
  }
  stats.commands++;
  const spec = specOf(d.spec);
  let out;
  try {
    if (c.payload?.error) throw new Error(String(c.payload.error));
    out = { ok: true, result: await execute(d, spec, c, cfg) };
  } catch (e) {
    out = { ok: false, error: String(e.message ?? e).slice(0, 2000) };
  }
  d.done[c.id] = out;
  const ids = Object.keys(d.done);
  if (ids.length > 500) delete d.done[ids[0]];
  log(d, `${c.type} → ${out.ok ? 'OK' : `GREŠKA: ${out.error}`}`);
  const r = await postResult(d, c.id, out);
  if (out.ok && (c.type === 'FORGET' || c.type === 'WIPE') && r && r.status < 300) {
    log(d, c.type === 'WIPE' ? 'tvorničke postavke — agent uklonjen' : 'odjavljen (Forget) — agent se gasi');
    retire(d);
    return;
  }
  if (out.ok && c.type === 'REBOOT') {
    d.offlineUntil = Date.now() + rint(4, 10) * 1000;
    log(d, 'ponovno pokretanje…');
  }
  saveState();
}

async function execute(d, spec, c, cfg) {
  const p = c.payload ?? {};
  switch (c.type) {
    case 'REBOOT':
    case 'FORGET':
    case 'LOCK':
      return {};
    case 'WIPE':
      if (spec.platform !== 'ANDROID') throw new Error('WIPE nije podržan na Windowsu');
      return {};
    case 'MESSAGE':
      (d.events ??= []).push({ type: 'MESSAGE', message: `Prikazana poruka: ${String(p.text ?? '').slice(0, 200)}` });
      await sleep(rint(200, 800));
      return {};
    case 'SET_KIOSK':
      d.kiosk = !!p.enabled;
      return { enabled: d.kiosk };
    case 'APPLY_CONFIG':
      if (!cfg) throw new Error('konfiguracija nije primljena');
      if (d.appliedConfigVersion !== cfg.version) throw new Error('konfiguracija nije primijenjena');
      return { configVersion: cfg.version };
    case 'INSTALL_APP': {
      const r = await installApp(d, p);
      return { packageName: p.packageName, version: p.version, versionCode: p.versionCode, ...(r.skipped ? { skipped: true } : {}) };
    }
    case 'UNINSTALL_APP': {
      const had = d.apps.some((x) => x.packageName === p.packageName);
      d.apps = d.apps.filter((x) => x.packageName !== p.packageName);
      d.appsChanged = true;
      return { packageName: p.packageName, ...(had ? {} : { notInstalled: true }) };
    }
    case 'PUSH_FILE': {
      const buf = await download(d, p.downloadPath, p.sha256);
      const target = p.targetPath || p.name;
      (d.events ??= []).push({ type: 'PUSH_FILE', message: `Datoteka zapisana: ${target} (${buf.length} B)` });
      return { path: target };
    }
    case 'RUN_SCRIPT': {
      if (spec.platform !== 'WINDOWS') throw new Error('RUN_SCRIPT je samo za Windows');
      await sleep(rint(300, 1500));
      const script = String(p.script ?? '');
      return { exitCode: 0, stdout: `PS C:\\Windows\\system32> ${script.split('\n')[0].slice(0, 200)}\n(simulirano) OK\n`, stderr: '' };
    }
    case 'SCREENSHOT': {
      const img = screenshot(d, spec);
      const r = await call(d, 'POST', `/upload?kind=SCREENSHOT&commandId=${c.id}`, { body: img, headers: { 'content-type': 'image/png' } });
      if (r.status !== 201) throw new Error(`slanje snimke: ${r.status} ${r.data?.error ?? ''}`);
      return { fileId: r.data.fileId, width: spec.screen[0] * SCALE, height: spec.screen[1] * SCALE };
    }
    case 'UPLOAD_LOGS': {
      const text = logText(d, spec);
      const r = await call(d, 'POST', `/upload?kind=LOGS&commandId=${c.id}`, { body: Buffer.from(text, 'utf8'), headers: { 'content-type': 'text/plain; charset=utf-8', 'x-file-name': `agent-${d.serial}.log` } });
      if (r.status !== 201) throw new Error(`slanje zapisnika: ${r.status} ${r.data?.error ?? ''}`);
      return { fileId: r.data.fileId, lines: text.split('\n').length };
    }
    default:
      throw new Error(`UNSUPPORTED: ${c.type}`);
  }
}

function logText(d, spec) {
  const lines = [];
  const now = Date.now();
  const msgs = [
    'I/WmsAgent: checkin ok (200)',
    'I/WmsAgent: telemetry sent',
    'D/WmsAgent: wifi rssi changed',
    'I/PolicyManager: config verified',
    'W/WmsAgent: slow response from server (2.1 s)',
    'I/KioskService: lock task active',
    'D/BatteryMonitor: level update',
  ];
  for (let i = 200; i > 0; i--) {
    const t = new Date(now - i * 17_000).toISOString().replace('T', ' ').slice(0, 23);
    lines.push(`${t} ${pick(msgs)}`);
  }
  return `WMS MDM agent ${d.agentVersion} — ${spec.manufacturer} ${spec.model} (${spec.os})\nserial ${d.serial}, uređaj ${d.serverName ?? d.name}\n\n${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- PNG (čisti JS)

const SCALE = 2;
const FONT = {
  0: [14, 17, 19, 21, 25, 17, 14], 1: [4, 12, 4, 4, 4, 4, 14], 2: [14, 17, 1, 2, 4, 8, 31], 3: [31, 2, 4, 2, 1, 17, 14], 4: [2, 6, 10, 18, 31, 2, 2],
  5: [31, 16, 30, 1, 1, 17, 14], 6: [6, 8, 16, 30, 17, 17, 14], 7: [31, 1, 2, 4, 8, 8, 8], 8: [14, 17, 17, 14, 17, 17, 14], 9: [14, 17, 17, 15, 1, 2, 12],
  A: [14, 17, 17, 17, 31, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [28, 18, 17, 17, 17, 18, 28], E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31], M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17], Y: [17, 17, 17, 10, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31], ':': [0, 12, 12, 0, 12, 12, 0], '.': [0, 0, 0, 0, 0, 12, 12], '-': [0, 0, 0, 31, 0, 0, 0], '/': [0, 1, 2, 4, 8, 16, 0],
  '%': [24, 25, 2, 4, 8, 19, 3], '(': [2, 4, 8, 8, 8, 4, 2], ')': [8, 4, 2, 2, 2, 4, 8], '+': [0, 4, 4, 31, 4, 4, 0], ',': [0, 0, 0, 0, 12, 4, 8],
  ' ': [0, 0, 0, 0, 0, 0, 0], '?': [14, 17, 1, 2, 4, 0, 4], '€': [7, 8, 30, 8, 30, 8, 7],
};

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = Buffer.alloc(w * h * 3);
  }
  rect(x, y, w, h, [r, g, b]) {
    [x, y, w, h] = [x, y, w, h].map(Math.round);
    for (let j = Math.max(0, y); j < Math.min(this.h, y + h); j++)
      for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) {
        const o = (j * this.w + i) * 3;
        this.px[o] = r;
        this.px[o + 1] = g;
        this.px[o + 2] = b;
      }
  }
  gradient(top, bottom) {
    for (let j = 0; j < this.h; j++) {
      const t = j / this.h;
      this.rect(0, j, this.w, 1, top.map((c, k) => Math.round(c + (bottom[k] - c) * t)));
    }
  }
  text(s, x, y, size, color) {
    const clean = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'D').toUpperCase();
    for (const ch of clean) {
      const g = FONT[ch] ?? FONT['?'];
      for (let row = 0; row < 7; row++) for (let col = 0; col < 5; col++) if (g[row] & (16 >> col)) this.rect(x + col * size, y + row * size, size, size, color);
      x += 6 * size;
    }
    return x;
  }
  textWidth(s, size) {
    return s.length * 6 * size;
  }
  png() {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
    for (let j = 0; j < this.h; j++) this.px.copy(raw, j * (this.w * 3 + 1) + 1, j * this.w * 3, (j + 1) * this.w * 3);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr.set([8, 2, 0, 0, 0], 8);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  }
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function screenshot(d, spec) {
  const [w0, h0] = spec.screen;
  const W = w0 * SCALE;
  const H = h0 * SCALE;
  const c = new Canvas(W, H);
  const now = new Date();
  const time = now.toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const date = now.toLocaleDateString('hr-HR');
  const name = d.serverName ?? d.name;
  const white = [255, 255, 255];
  if (spec.platform === 'WINDOWS') {
    c.gradient([16, 60, 130], [40, 120, 200]);
    c.rect(0, H - 40, W, 40, [32, 32, 36]);
    c.rect(12, H - 32, 24, 24, [0, 120, 215]);
    c.text(time, W - c.textWidth(time, 2) - 12, H - 27, 2, white);
    const x = 60, y = 40, ww = W - 120, hh = H - 120;
    c.rect(x, y, ww, hh, [245, 246, 248]);
    c.rect(x, y, ww, 30, [225, 228, 234]);
    c.text('WMS BLAGAJNA', x + 10, y + 8, 2, [40, 40, 40]);
    c.text(name, x + 20, y + 50, 3, [20, 60, 130]);
    c.text(`${spec.manufacturer} ${spec.model}`, x + 20, y + 90, 2, [80, 80, 80]);
    c.text(`${date} ${time}`, x + 20, y + 120, 2, [80, 80, 80]);
    for (let i = 0; i < 6; i++) c.rect(x + 20 + (i % 3) * ((ww - 40) / 3), y + 160 + Math.floor(i / 3) * 70, (ww - 40) / 3 - 10, 60, [[0, 150, 136], [255, 152, 0], [63, 81, 181]][i % 3]);
  } else {
    c.gradient([250, 250, 252], [225, 232, 240]);
    c.rect(0, 0, W, 36, [33, 33, 33]);
    c.text(time.slice(0, 5), 10, 11, 2, white);
    const status = d.battery === null ? 'AC' : `${Math.round(d.battery)}%${d.charging ? '+' : ''}`;
    c.text(status, W - c.textWidth(status, 2) - 10, 11, 2, white);
    c.rect(0, 36, W, 56, [0, 121, 107]);
    c.text('WMS POS', 16, 52, 3, white);
    const size = W > 600 ? 4 : 3;
    c.text(name, 16, 112, size, [33, 33, 33]);
    c.text(`${spec.manufacturer} ${spec.model}`.slice(0, Math.floor((W - 32) / 12)), 16, 112 + 10 * size, 2, [90, 90, 90]);
    c.text(`${date} ${time}`, 16, 136 + 10 * size, 2, [90, 90, 90]);
    const top = 180 + 10 * size;
    const cols = W > 600 ? 4 : 2;
    const tw = (W - 16 * (cols + 1)) / cols;
    const colors = [[239, 83, 80], [255, 167, 38], [102, 187, 106], [66, 165, 245], [171, 71, 188], [38, 166, 154]];
    for (let i = 0; i < cols * 3; i++) {
      const tx = 16 + (i % cols) * (tw + 16), ty = top + Math.floor(i / cols) * 76;
      if (ty + 64 > H) break;
      c.rect(Math.round(tx), ty, Math.round(tw), 64, colors[i % colors.length]);
      c.text(['KAVA', 'PIVO', 'SOK', 'VODA', 'CAJ', 'VINO', 'PIZZA', 'SENDVIC', 'TORTA', 'SALATA', 'JUHA', 'DESERT'][i], Math.round(tx) + 8, ty + 24, 2, white);
    }
  }
  return c.png();
}

// ---------------------------------------------------------------- pokretanje

const saved = loadState()[opt.url]?.devices ?? [];
const devices = [];
for (let i = 0; i < opt.count; i++) {
  const s = saved[i];
  devices.push(s && !s.retired ? { ...newDevice(i), ...s, busy: false } : newDevice(i));
}
console.log(`MDM simulator → ${opt.url}: ${devices.length} uređaja (${saved.length ? `${Math.min(saved.length, opt.count)} iz ${opt.state}` : 'novi'})${opt.token ? ', s ključem upisa' : ', bez ključa (PENDING)'}`);

let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  saveState(true);
  report(true);
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
let lastReport = { at: Date.now(), n: 0 };
function report(final = false) {
  const lat = [...stats.lat].sort((a, b) => a - b);
  const st = Object.values(stats.byStatus);
  const perMin = ((stats.checkins - lastReport.n) / ((Date.now() - lastReport.at) / 60000)).toFixed(0);
  lastReport = { at: Date.now(), n: stats.checkins };
  console.log(
    `${final ? '== ukupno' : '--'} javljanja ${stats.checkins} (${perMin}/min), greške ${stats.errors}, naredbe ${stats.commands}, ` +
      `ENROLLED ${st.filter((x) => x === 'ENROLLED').length} / PENDING ${st.filter((x) => x === 'PENDING').length}, ` +
      `kašnjenje ms p50 ${pct(lat, 50).toFixed(0)} p95 ${pct(lat, 95).toFixed(0)} p99 ${pct(lat, 99).toFixed(0)} max ${(lat.at(-1) ?? 0).toFixed(0)}`,
  );
  if (!final) stats.lat = [];
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

async function main() {
  // registracija i prvo javljanje (po 8 istovremeno)
  await pool(devices, 8, async (d) => {
    if (!d.token) await register(d);
    await checkin(d);
  });
  saveState(true);
  if (opt.once) return shutdown(0);

  if (opt.duration) setTimeout(() => shutdown(0), opt.duration * 1000);
  setInterval(() => report(), opt.bench ? 10_000 : 30_000).unref();
  stats.lat = [];
  lastReport = { at: Date.now(), n: stats.checkins };

  if (opt.bench) {
    // ravnomjerno: jedno javljanje svakih 60000/bench ms, redom po uređajima
    const every = 60_000 / opt.bench;
    let k = 0;
    const start = performance.now();
    for (;;) {
      const d = devices[k++ % devices.length];
      checkin(d).catch((e) => {
        stats.errors++;
        console.error(e);
      });
      const due = start + k * every;
      await sleep(Math.max(0, due - performance.now()));
    }
  }

  for (const d of devices) {
    // svaki uređaj u svom ritmu (±10 % jitter), početak razmaknut
    const loop = async () => {
      if (d.stopped) return;
      tick(d, opt.interval);
      await checkin(d).catch((e) => {
        stats.errors++;
        log(d, `greška: ${e.message}`);
      });
      if (!d.stopped) setTimeout(loop, opt.interval * 1000 * rnd(0.9, 1.1));
    };
    setTimeout(loop, rnd(0, opt.interval * 1000));
  }
}

main().catch((e) => {
  console.error(e);
  shutdown(1);
});
