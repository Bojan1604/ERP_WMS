#!/usr/bin/env node
/*
 * Mali lažni MDM poslužitelj za dimni test agenata (bez ovisnosti).
 * Implementira register / checkin / commands/:id / upload / files/:id prema
 * docs/mdm-agent-protocol.md, plus upravljačke rute /_control/* za test:
 *   POST /_control/enroll   {deviceId?}          upis uređaja (PENDING → ENROLLED)
 *   POST /_control/command  {type, payload}      naredba u red
 *   POST /_control/config   {settings, apps}     nova verzija konfiguracije
 *   POST /_control/file     {name, contentBase64} datoteka za preuzimanje
 *   GET  /_control/state                          stanje (uređaji, rezultati, prijenosi)
 * Pokretanje: node mock-server.js [port]
 */
'use strict';
const http = require('http');
const crypto = require('crypto');

const port = Number(process.argv[2] || process.env.PORT || 18080);
const devices = []; // { id, token, status, enrollCode, hardwareId, platform, configVersion, settings, apps, applied, commands[], telemetry, checkins }
const results = []; // { id, type, deviceId, body }
const uploads = []; // { fileId, kind, commandId, size, sha256 }
const files = new Map(); // id → { name, data, sha256 }
let seq = 1;
const id = (p) => `${p}${(seq++).toString(36)}${crypto.randomBytes(3).toString('hex')}`;

function send(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-MDM-Protocol': '1', 'Content-Length': data.length, ...headers });
  res.end(data);
}
const err = (res, status, code, error, extra = {}) => send(res, status, { error, code, ...extra });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const json = (buf) => {
  try { return buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch { return null; }
};

function auth(req, res) {
  const h = req.headers.authorization || '';
  const m = /^Device (.+)$/.exec(h);
  if (!m) { err(res, 401, 'UNAUTHORIZED', 'Nedostaje ključ uređaja'); return null; }
  const d = devices.find((x) => x.token === m[1]);
  if (!d) { err(res, 401, 'UNAUTHORIZED', 'Nepoznat ključ uređaja'); return null; }
  if (d.status === 'RETIRED') { err(res, 410, 'RETIRED', 'Uređaj je uklonjen', { status: 'RETIRED' }); return null; }
  return d;
}

function effectiveConfig(d) {
  return { version: d.configVersion, settings: d.settings, apps: d.apps };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const p = url.pathname;
  const body = await readBody(req);
  try {
    // ------------------------------------------------ upravljanje (samo test)
    if (p === '/_control/state') return send(res, 200, { devices, results, uploads });
    if (p === '/_control/enroll') {
      const b = json(body) || {};
      const d = b.deviceId ? devices.find((x) => x.id === b.deviceId) : devices.find((x) => x.status === 'PENDING');
      if (!d) return err(res, 404, 'NOT_FOUND', 'Nema uređaja na čekanju');
      d.status = 'ENROLLED'; d.enrollCode = null; d.name = b.name || 'Testno računalo';
      return send(res, 200, { id: d.id });
    }
    if (p === '/_control/command') {
      const b = json(body) || {};
      const d = b.deviceId ? devices.find((x) => x.id === b.deviceId) : devices.find((x) => x.status === 'ENROLLED');
      if (!d) return err(res, 404, 'NOT_FOUND', 'Nema upisanog uređaja');
      const c = { id: id('cmd'), type: b.type, payload: b.payload || {}, status: 'PENDING' };
      d.commands.push(c);
      return send(res, 200, c);
    }
    if (p === '/_control/config') {
      const b = json(body) || {};
      for (const d of devices.filter((x) => x.status === 'ENROLLED')) {
        d.configVersion += 1; d.settings = b.settings || {}; d.apps = b.apps || [];
      }
      return send(res, 200, { ok: true });
    }
    if (p === '/_control/file') {
      const b = json(body) || {};
      const data = Buffer.from(b.contentBase64 || '', 'base64');
      const fid = id('file');
      const sha256 = crypto.createHash('sha256').update(data).digest('hex');
      files.set(fid, { name: b.name || 'file.bin', data, sha256 });
      return send(res, 200, { fileId: fid, sha256, downloadPath: `/api/mdm/agent/files/${fid}`, size: data.length });
    }

    // ------------------------------------------------ protokol agenta
    if (req.method === 'POST' && p === '/api/mdm/agent/register') {
      const b = json(body);
      if (!b || !b.hardwareId || !['ANDROID', 'WINDOWS'].includes(b.platform)) return err(res, 400, 'BAD_REQUEST', 'Neispravan zahtjev');
      if (b.protocol !== 1) return err(res, 400, 'PROTOCOL_UNSUPPORTED', 'Protokol nije podržan');
      if (b.enrollToken === 'bad-token') return err(res, 403, 'ENROLL_TOKEN_INVALID', 'Ključ upisa ne vrijedi');
      let d = devices.find((x) => x.hardwareId === b.hardwareId && x.platform === b.platform && x.status !== 'ENROLLED');
      if (!d) {
        d = { id: id('dev'), hardwareId: b.hardwareId, platform: b.platform, configVersion: 1, settings: {}, apps: [], commands: [], checkins: 0 };
        devices.push(d);
      }
      d.token = crypto.randomBytes(32).toString('base64url');
      d.register = b;
      d.applied = 0;
      if (b.enrollToken === 'valid-token') { d.status = 'ENROLLED'; d.enrollCode = null; d.name = b.name || 'Uređaj'; }
      else { d.status = 'PENDING'; d.enrollCode = String(100000 + Math.floor(Math.random() * 900000)); d.name = b.name || 'Novi uređaj'; }
      return send(res, 200, { deviceId: d.id, token: d.token, status: d.status, enrollCode: d.enrollCode, checkinSec: 60 });
    }
    if (req.method === 'POST' && p === '/api/mdm/agent/checkin') {
      const d = auth(req, res); if (!d) return;
      const b = json(body);
      if (!b || typeof b.telemetry !== 'object') return err(res, 400, 'BAD_REQUEST', 'Nedostaje telemetry');
      d.checkins += 1;
      d.telemetry = b.telemetry;
      d.events = (d.events || []).concat(b.events || []);
      d.applied = Number(b.appliedConfigVersion || 0);
      if (d.status !== 'ENROLLED') {
        return send(res, 200, { status: d.status, enrollCode: d.enrollCode, deviceName: d.name, checkinSec: 60, config: null, commands: [] });
      }
      const cmds = d.commands.filter((c) => c.status === 'PENDING').slice(0, 20);
      cmds.forEach((c) => { c.status = 'SENT'; });
      const forced = cmds.some((c) => c.type === 'APPLY_CONFIG');
      const config = d.applied !== d.configVersion || forced ? effectiveConfig(d) : null;
      return send(res, 200, { status: d.status, enrollCode: null, deviceName: d.name, checkinSec: 60, config, commands: cmds.map((c) => ({ id: c.id, type: c.type, payload: c.payload })) });
    }
    let m;
    if (req.method === 'POST' && (m = /^\/api\/mdm\/agent\/commands\/([^/]+)$/.exec(p))) {
      const d = auth(req, res); if (!d) return;
      const c = d.commands.find((x) => x.id === decodeURIComponent(m[1]));
      if (!c) return err(res, 404, 'NOT_FOUND', 'Nema naredbe');
      const b = json(body);
      if (!b || typeof b.ok !== 'boolean') return err(res, 400, 'BAD_REQUEST', 'Nedostaje ok');
      const duplicate = c.status === 'SUCCEEDED' || c.status === 'FAILED';
      if (!duplicate) {
        c.status = b.ok ? 'SUCCEEDED' : 'FAILED';
        results.push({ id: c.id, type: c.type, deviceId: d.id, body: b });
        if (b.ok && (c.type === 'FORGET' || c.type === 'WIPE')) { d.status = 'RETIRED'; d.token = 'rotated-' + crypto.randomBytes(8).toString('hex'); }
      }
      return send(res, 200, { id: c.id, status: c.status, deviceStatus: d.status, duplicate });
    }
    if (req.method === 'POST' && p === '/api/mdm/agent/upload') {
      const d = auth(req, res); if (!d) return;
      if (d.status !== 'ENROLLED') return err(res, 403, 'FORBIDDEN', 'Uređaj nije upisan');
      const kind = url.searchParams.get('kind');
      if (!['SCREENSHOT', 'LOGS'].includes(kind)) return err(res, 400, 'BAD_REQUEST', 'kind');
      const isPng = body.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const isZip = body.slice(0, 2).toString() === 'PK';
      const isGz = body[0] === 0x1f && body[1] === 0x8b;
      if (kind === 'SCREENSHOT' && !isPng) return err(res, 415, 'UNSUPPORTED_TYPE', 'Samo PNG/JPEG');
      if (kind === 'LOGS' && !(isZip || isGz || !body.includes(0))) return err(res, 415, 'UNSUPPORTED_TYPE', 'Samo tekst/zip/gzip');
      const u = { fileId: id('up'), kind, commandId: url.searchParams.get('commandId'), name: req.headers['x-file-name'] || null, size: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') };
      uploads.push(u);
      return send(res, 201, { fileId: u.fileId, size: u.size, sha256: u.sha256, mime: kind === 'SCREENSHOT' ? 'image/png' : 'application/zip' });
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && (m = /^\/api\/mdm\/agent\/files\/([^/]+)$/.exec(p))) {
      const d = auth(req, res); if (!d) return;
      const f = files.get(m[1]);
      if (!f) return err(res, 404, 'NOT_FOUND', 'Nema datoteke');
      let start = 0; let status = 200;
      const range = req.headers.range;
      const ifRange = req.headers['if-range'];
      if (range && (!ifRange || ifRange === `"${f.sha256}"`)) {
        const r = /^bytes=(\d+)-$/.exec(range);
        if (!r || Number(r[1]) >= f.data.length) { res.writeHead(416, { 'Content-Range': `bytes */${f.data.length}` }); return res.end(); }
        start = Number(r[1]); status = 206;
      }
      const chunk = f.data.subarray(start);
      const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': chunk.length, 'Accept-Ranges': 'bytes', ETag: `"${f.sha256}"`, 'X-Content-SHA256': f.sha256 };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${f.data.length - 1}/${f.data.length}`;
      res.writeHead(status, headers);
      return res.end(req.method === 'HEAD' ? undefined : chunk);
    }
    return err(res, 404, 'NOT_FOUND', `Nepoznata ruta ${req.method} ${p}`);
  } catch (e) {
    return err(res, 500, 'SERVER_ERROR', String(e && e.stack || e));
  }
});

server.listen(port, '127.0.0.1', () => console.log(`READY ${port}`));
