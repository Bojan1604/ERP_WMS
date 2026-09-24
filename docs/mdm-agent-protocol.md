# MDM agent protocol — v1

This is the contract between the device agents (Android / Kotlin, Windows / PowerShell) and the server.
Server implementation: `src/app/api/mdm/agent/**`, `src/server/mdm/agent.ts`, `src/server/mdm/agent-auth.ts`.
Shared TypeScript types: `src/domain/mdm.ts` (`Agent*`). Reference client: `scripts/mdm-agent-sim.mjs`.

Everything in this document is normative for protocol `1`. Words MUST / SHOULD / MAY as in RFC 2119.

---

## 1. Basics

| | |
|---|---|
| Base URL | `{server}/api/mdm/agent` — `{server}` is e.g. `https://erp.example.com` (no trailing slash). |
| Transport | HTTPS in production (plain HTTP only for local development). Agents MUST validate TLS certificates. |
| Encoding | JSON, UTF-8. Requests with a JSON body send `Content-Type: application/json`. |
| Auth | Every endpoint except `/register` and `/download/*` requires `Authorization: Device <token>`. |
| Protocol version | Sent in the register body (`"protocol": 1`). Every response carries `X-MDM-Protocol: 1`. |
| Time | ISO-8601 UTC strings (`2026-09-24T12:00:00.000Z`). |
| Caching | All JSON responses are `Cache-Control: no-store`. |
| Request size | JSON bodies: max **2 MiB** (`413` above). Uploads: see §7. |

### 1.1 Errors

All error responses are JSON:

```json
{ "error": "human readable message (Croatian)", "code": "MACHINE_CODE" }
```

| HTTP | `code` | Meaning / what the agent does |
|---|---|---|
| 400 | `BAD_REQUEST` | Body/params invalid. Do **not** retry the same request unchanged; log it. |
| 400 | `PROTOCOL_UNSUPPORTED` | `protocol` is not `1`. Agent must be updated. |
| 401 | `UNAUTHORIZED` | Missing/unknown device token (device deleted in the portal, or token rotated by FORGET). See §9. |
| 403 | `ENROLL_TOKEN_INVALID` | `/register`: enroll token unknown, expired or used up. See §3. |
| 403 | `FORBIDDEN` | Operation not allowed (e.g. upload while PENDING, file not assigned to this device). |
| 404 | `NOT_FOUND` | Command / file / artifact does not exist (for this device). |
| 409 | `COMMAND_CLOSED` | Result posted for a command that was cancelled / expired before delivery. Drop it. |
| 410 | `RETIRED` | Device is retired. Body additionally contains `"status": "RETIRED"`. Agent MUST stop (§9). |
| 413 | `TOO_LARGE` | Body exceeds the limit. |
| 415 | `UNSUPPORTED_TYPE` | Upload content (sniffed from bytes) not allowed for this `kind`. |
| 416 | `RANGE_NOT_SATISFIABLE` | Bad `Range` on a download. Header `Content-Range: bytes */<size>`. |
| 429 | `RATE_LIMITED` | Too many requests. Header `Retry-After: <seconds>`. |
| 5xx | `SERVER_ERROR` (or none) | Server problem. Retry with backoff (§10). |

---

## 2. Device lifecycle

```
             register (no enroll token)                portal: "enroll by code"
  (none) ─────────────────────────────────► PENDING ───────────────────────────► ENROLLED
     │                                         ▲                                    │
     │  register (valid enroll token)          │ register again (same hardwareId)   │ FORGET / WIPE succeeded,
     └─────────────────────────────────────────┼───────────────────────────► ENROLLED│ or retired in the portal
                                               │                                    ▼
                                               └──────────────────────────────── RETIRED
```

* **PENDING** — the agent shows the 6-digit `enrollCode` full-screen (Android) / in the tray + log (Windows) until an
  operator enters it in the portal. A PENDING device gets **no config and no commands**; it only checks in.
* **ENROLLED** — belongs to an organisation (and usually a site). Receives config and commands.
* **RETIRED** — agent MUST stop working for this server (§9).

---

## 3. `POST /register` — first contact (no auth)

Called when the agent has no stored token (first start, after 401, after re-install).

Request (`AgentRegisterRequest`):

```json
{
  "protocol": 1,
  "platform": "ANDROID",                   // "ANDROID" | "WINDOWS"
  "enrollToken": "k7Qm…",                  // optional; from QR code / installer parameter
  "hardwareId": "8f14e45fceea167a",        // REQUIRED, stable per device: Android: Settings.Secure.ANDROID_ID
                                           //   (or serial when device owner); Windows: Win32_ComputerSystemProduct.UUID
  "serial": "V2S123456",                   // optional
  "manufacturer": "SUNMI",                 // optional
  "model": "V2s",                          // optional
  "osVersion": "Android 11 (SDK 30)",      // optional
  "agentVersion": "1.0.0",                 // optional
  "name": "Blagajna 1"                     // optional suggested display name
}
```

Limits: `hardwareId` 1–200 chars, other strings ≤ 100 chars (`name` ≤ 80), `enrollToken` ≤ 200.

Response `200` (`AgentRegisterResponse`):

```json
{
  "deviceId": "cmuf…",
  "token": "q2V…43 chars…",      // 32 random bytes, base64url, no padding. Store securely (Android: EncryptedSharedPreferences /
                                  // Keystore; Windows: DPAPI LocalMachine or ACL'd file readable by SYSTEM only).
  "status": "PENDING",           // or "ENROLLED" when a valid enrollToken was given
  "enrollCode": "483920",        // 6 digits while PENDING, null when ENROLLED
  "checkinSec": 60
}
```

Server rules:

* **With `enrollToken`**: the token decides company, organisation and site. The device is created (or re-used, see
  below) directly as **ENROLLED**. Every successful use increments `uses`; tokens with `maxUses` reached or
  `expiresAt` in the past → `403 ENROLL_TOKEN_INVALID`. The agent SHOULD then show the error and MAY fall back to
  registering without a token (becomes PENDING, shows a code).
* **Without `enrollToken`**: the device is created **PENDING** in the server's default company with a fresh random
  6-digit `enrollCode` (unique among the company's PENDING devices).
* **Re-use**: if a device with the same `hardwareId` + `platform` already exists in that company and is PENDING or
  RETIRED (or, with an enroll token, ENROLLED in the same organisation), that row is re-used: new token (the old one
  stops working), new code, pending commands of the old installation are cancelled, config is re-sent.
  Otherwise a new row is created.
* The agent MUST reset its locally stored `appliedConfigVersion` to `0` after every successful register.
* Rate limit: 20 registrations per client IP per 10 minutes → `429 RATE_LIMITED` with `Retry-After`.

---

## 4. `POST /checkin` — periodic check-in (auth)

The heart of the protocol. The agent calls it every `checkinSec` seconds (from the last response; currently 60), and
additionally **immediately** after: start-up, network reconnect, finishing a command, applying config.

Request (`AgentCheckinRequest`):

```json
{
  "appliedConfigVersion": 7,          // the config version the agent has applied successfully; 0 = none. ALWAYS send it.
  "telemetry": {
    "serial": "V2S123456",
    "manufacturer": "SUNMI",
    "model": "V2s",
    "osVersion": "Android 11 (SDK 30)",
    "agentVersion": "1.0.0",
    "imei": "356938035643809",
    "macAddress": "02:00:00:12:34:56",
    "ipAddress": "192.168.1.23",       // LAN address; the server records the public address itself
    "wifiSsid": "Lokal-5G",
    "wifiSignal": -58,                 // dBm, clamped to -150..0
    "batteryLevel": 83,                // percent 0..100 (omit/null for desktops without battery)
    "charging": true,
    "storageFreeMb": 10240,
    "storageTotalMb": 32768,
    "ramTotalMb": 3072,
    "uptimeSec": 86400,
    "apps": [                          // installed apps (see note), max 2000 entries (extra entries are dropped)
      { "packageName": "hr.example.pos", "name": "POS", "version": "2.4.1", "versionCode": 241 }
    ],
    "extra": {                         // free-form object, ≤ 16 KiB serialized (larger → dropped)
      "securityPatch": "2024-05-05",   // Android examples
      "domain": "WORKGROUP", "user": "blagajna", "cpu": "Intel N100"   // Windows examples
    }
  },
  "events": [                          // log since last successful check-in, max 50 (extra are dropped)
    { "at": "2026-09-24T11:59:02Z", "level": "warn", "type": "INSTALL", "message": "Install of hr.example.pos failed: …" }
  ]
}
```

Field rules:

* Every telemetry field is optional. Omitted = unchanged on the server; `null` = clear. Invalid values of a single
  field are ignored (the check-in still succeeds). Numbers are clamped (`batteryLevel` 0–100, sizes 0–2147483647),
  strings are truncated (`serial/manufacturer/model/osVersion` 100, `agentVersion` 50, `imei/macAddress` 40,
  `ipAddress` 64, `wifiSsid` 64).
* `apps` is large — the agent SHOULD send it on the first check-in after start, whenever the installed set/versions
  change, and at least once per hour; it MAY omit it otherwise (the server keeps the last list). Apps entries:
  `packageName` (Windows: MSI ProductCode or display name) ≤ 200, `name` ≤ 200, `version` ≤ 100, `versionCode` int.
* `events`: `level` ∈ `info|warn|error` (default `info`), `type` ≤ 64 chars (UPPER_SNAKE, e.g. `INSTALL`, `KIOSK`,
  `CRASH`), `message` ≤ 1000. `at` outside [now − 7 days, now + 5 min] is replaced by the server time. The agent MUST
  drop sent events only after a `200`.

Response `200` (`AgentCheckinResponse`):

```json
{
  "status": "ENROLLED",               // "PENDING" | "ENROLLED"  (RETIRED never comes here — you get 410)
  "enrollCode": null,                 // the code to show while PENDING
  "deviceName": "Blagajna 1",         // display name set in the portal (show it in the agent UI)
  "checkinSec": 60,
  "config": { … EffectiveConfig … } | null,
  "commands": [ { "id": "cmug…", "type": "SCREENSHOT", "payload": {} } ]
}
```

* `config` is non-null when the device is ENROLLED **and** the server's config version differs from the
  `appliedConfigVersion` you sent (or an `APPLY_CONFIG` command is delivered in the same response). See §6.
* `commands`: at most 20, oldest first. Each command is delivered **once** (atomically marked SENT). A command that was
  delivered but has no result after 10 minutes is delivered again (the agent may have crashed) — so the agent MUST
  de-duplicate by `id` (§5).
* When the status changes from PENDING to ENROLLED the agent hides the enrollment code and continues normally.

---

## 5. Commands

### 5.1 Execution rules

1. Execute commands **in the order received**, one at a time (except long downloads MAY run in the background while
   later quick commands execute).
2. Keep a persistent set of command ids (last ~500) with their final result. If an id arrives again:
   still running → ignore; already finished → re-post the stored result.
3. After finishing, `POST /commands/{id}` with the result (§5.3), then check in immediately.
4. Unknown `type` → post `{ "ok": false, "error": "UNSUPPORTED: <type>" }`.
5. A command the platform cannot do (e.g. `WIPE` on Windows) → `ok: false` with an explanation.

### 5.2 Command types and payloads

`downloadPath` values are **relative** to `{server}` (e.g. `/api/mdm/agent/files/cmuh…`); download them with the
device token (§8). `sha256` is lowercase hex of the whole file; the agent MUST verify it before using the file.

| type | payload | agent behaviour | `result` on success |
|---|---|---|---|
| `REBOOT` | `{}` | Post result **first**, then reboot (Android device owner: `DevicePolicyManager.reboot`; Windows: `shutdown /r /t 5`). | `{}` |
| `FORGET` | `{}` | Post result **first**. On `2xx`, remove device-owner/admin rights and policies set by the agent, delete the token and local state, stop the service (Windows: remove scheduled task/service). Server marks the device RETIRED and invalidates the token. | `{}` |
| `APPLY_CONFIG` | `{}` | Re-apply the `config` included in the same check-in response (it is always included when this command is delivered), even if the version equals the applied one. | `{ "configVersion": 7 }` |
| `INSTALL_APP` | `{ "appId", "packageName", "name", "version", "versionCode", "downloadPath", "sha256", "installArgs"? }` | Download (resume with `Range`), verify sha256, install silently (Android: `PackageInstaller` session as device owner; Windows: `msiexec /i file.msi /qn <installArgs>` or run exe with `installArgs`). Skip download if the same `versionCode`/`version` is already installed (→ `ok: true`, `result.skipped: true`). | `{ "packageName", "version", "versionCode" }` |
| `UNINSTALL_APP` | `{ "packageName" }` | Uninstall silently. Not installed → `ok: true` with `result.notInstalled: true`. | `{ "packageName" }` |
| `SCREENSHOT` | `{}` | Capture the screen as PNG (or JPEG), `POST /upload?kind=SCREENSHOT&commandId={id}`, then post the result with the returned `fileId`. | `{ "fileId" }` |
| `UPLOAD_LOGS` | `{}` | Collect agent logs (+ logcat / Windows event log excerpt), plain text or zip/gzip, `POST /upload?kind=LOGS&commandId={id}`, then post the result. | `{ "fileId" }` |
| `LOCK` | `{}` | Lock the screen now (Android: `lockNow`; Windows: `rundll32 user32.dll,LockWorkStation` in the user session). | `{}` |
| `WIPE` | `{}` | Android only. Post result **first**, then factory reset (`wipeData`). Server marks the device RETIRED. | `{}` |
| `MESSAGE` | `{ "text": "…" }` (≤ 2000 chars) | Show the text in a dialog/notification (Windows: `msg *` or toast) until dismissed. | `{}` |
| `PUSH_FILE` | `{ "fileId", "name", "downloadPath", "sha256", "size", "targetPath" }` | Download, verify, write to `targetPath` (Android: relative to the agent's external files dir unless absolute & allowed; Windows: absolute path, create directories). | `{ "path" }` |
| `RUN_SCRIPT` | `{ "script": "…", "shell": "powershell" }` | Windows only. Run as SYSTEM with a 10-minute timeout. | `{ "exitCode", "stdout", "stderr" }` (each output truncated to 32 KiB) |
| `SET_KIOSK` | `{ "enabled": true, "packageName"?: "hr.example.pos" }` | Enter/leave kiosk (lock-task / assigned access). Without `packageName`, use `config.settings.startApp`. | `{ "enabled" }` |

Portal code may queue `INSTALL_APP` as just `{ "appId", "versionId"? }` and `PUSH_FILE` as `{ "fileId", "targetPath" }`;
the server fills in the remaining fields (package, version, `downloadPath`, `sha256`, …) at delivery time, so the
agent always receives the full payloads above. If an app/file no longer exists the command is delivered with an
`error` field in the payload — post `ok: false` with that error.

### 5.3 `POST /commands/{id}` — command result (auth)

Request (`AgentCommandResult`):

```json
{ "ok": true, "error": null, "result": { "fileId": "cmuh…" } }
```

`error` ≤ 2000 chars; `result` any JSON object ≤ 64 KiB serialized.

Response `200`:

```json
{ "id": "cmug…", "status": "SUCCEEDED", "deviceStatus": "ENROLLED", "duplicate": false }
```

* Only the device the command was delivered to may post (`404 NOT_FOUND` otherwise).
* Posting again for a finished command returns `200` with `"duplicate": true` (safe to retry).
* Command cancelled/expired **before** delivery → `409 COMMAND_CLOSED`. A command that expired while the agent was
  executing it still accepts the result.
* `FORGET` or `WIPE` with `ok: true` → `"deviceStatus": "RETIRED"`; the device token is invalid from now on.

---

## 6. Configuration

`config` (`EffectiveConfig`) = profile of the device (own profile, else the site's profile) merged with per-device
overrides:

```json
{
  "version": 7,
  "settings": {
    "kiosk": true,
    "startApp": "hr.example.pos",            // package name (already resolved)
    "adb": false,
    "restrictions": { "noInstallApps": true, "noSettings": true, "noPlayStore": true, "noUsbFileTransfer": true,
                      "noFactoryReset": true, "noCamera": false, "noStatusBar": true },
    "wifi": [ { "ssid": "Lokal", "security": "WPA2", "password": "…", "hidden": false } ],
    "maintenancePin": "1234",
    "screenTimeoutSec": 120,
    "timezone": "Europe/Zagreb",
    "volumePct": 60,
    "systemUpdates": "WINDOWED"               // AUTOMATIC | WINDOWED (02–04 h) | POSTPONE
  },
  "apps": [
    { "appId": "cmuh…", "packageName": "hr.example.pos", "name": "POS", "version": "2.4.1", "versionCode": 241,
      "downloadPath": "/api/mdm/agent/files/cmuh…", "sha256": "9f86d0…", "installArgs": null,
      "config": { "serverUrl": "https://…" }, "hidden": false, "autoStart": true, "remove": false }
  ]
}
```

Applying config (idempotent — applying the same config twice must be harmless):

1. `settings`: apply every known key; ignore unknown keys (forward compatibility). A missing key means "leave the
   platform default" — the agent SHOULD revert a setting it previously set when the key disappears.
2. `apps`: for each entry with `remove: true` → uninstall if present. Otherwise install when missing or when the
   installed `versionCode` (Android) / `version` (Windows) differs, downloading `downloadPath` and verifying `sha256`.
   `downloadPath: null` = no binary uploaded yet → skip with a `warn` event. Apply `config` (Android: managed
   configuration / app restrictions; Windows: `HKLM\SOFTWARE\WmsMdm\Apps\<packageName>` string values), `hidden`,
   `autoStart`.
3. Apps installed by the agent earlier but no longer in the list are **not** removed automatically (only `remove: true`
   removes).
4. When everything succeeded, store `appliedConfigVersion = config.version` and check in immediately. If a step fails,
   keep the old `appliedConfigVersion`, send an `error` event describing what failed; the server re-sends the config at
   every check-in until the version is reported (so retries are automatic, bounded by the check-in interval). The agent
   SHOULD back off app downloads that fail repeatedly (1, 5, 15, 60 min).

---

## 7. `POST /upload?kind=SCREENSHOT|LOGS[&commandId=…]` — upload a file (auth)

* Body: the raw file bytes (not multipart). `Content-Type` SHOULD be set but is not trusted: the server sniffs the
  bytes.
* `kind=SCREENSHOT`: PNG or JPEG only, max **10 MiB**.
* `kind=LOGS`: plain UTF-8 text (no NUL bytes), zip, or gzip, max **50 MiB**.
* Optional header `X-File-Name` (≤ 100 chars, used only as a display name).
* `commandId` (optional) must be a command of type `SCREENSHOT`/`UPLOAD_LOGS` (matching `kind`) delivered to this
  device; the server links the file to it (`result.fileId`).
* Only ENROLLED devices can upload (`403` while PENDING).
* The server keeps the 20 newest screenshots and 20 newest log uploads per device.

Response `201`:

```json
{ "fileId": "cmuh…", "size": 48213, "sha256": "…", "mime": "image/png" }
```

Errors: `413 TOO_LARGE` (checked against `Content-Length` and while reading), `415 UNSUPPORTED_TYPE`,
`404 NOT_FOUND` (bad `commandId`).

---

## 8. `GET /files/{id}` — download an app/file (auth)

Downloads a file referenced by the device's current `config.apps[].downloadPath` or by an `INSTALL_APP`/`PUSH_FILE`
command delivered to this device and not yet finished. Anything else → `403 FORBIDDEN` / `404 NOT_FOUND`.

Response headers: `Content-Length`, `Content-Type`, `Accept-Ranges: bytes`, `ETag: "<sha256>"`,
`X-Content-SHA256: <sha256 hex>`, `Content-Disposition: attachment; filename*=UTF-8''<name>`.

* `HEAD` is supported (same headers, no body).
* Resume: `Range: bytes=<start>-` (also `start-end` and `-suffix`; a single range only) → `206 Partial Content` with
  `Content-Range: bytes <start>-<end>/<size>`. Invalid → `416`. The agent SHOULD send `If-Range: "<sha256>"`
  when resuming; if the file changed the server answers `200` with the full body.
* Always verify the sha256 of the complete file.

---

## 9. Token loss, 401 and 410

* `401 UNAUTHORIZED` on any authenticated endpoint: the token is not valid any more (device deleted in the portal,
  or re-registered by another installation). The agent deletes the token and calls `/register` again (with the
  enroll token if it still has one), with backoff (§10). It MUST NOT loop faster than once per minute.
* `410 RETIRED` (`{"status":"RETIRED"}`): the device was retired in the portal. The agent MUST do the same cleanup as
  for `FORGET` and stop contacting the server. (Re-enrollment only by re-installing / re-provisioning.)
* After a successful `FORGET` result the token is rotated server-side: later requests give `401`; the agent has
  already cleaned up by then.

---

## 10. Retry / backoff

* Network errors, timeouts (client timeout: 30 s for JSON, none for streamed transfers but abort on 60 s of no
  progress), `429` and `5xx`: retry with exponential backoff **with jitter**: `min(checkinSec, 5 s × 2^n) × random(0.5..1.5)`,
  then keep checking in every `checkinSec`. Honour `Retry-After` when present.
* Queue events and command results locally (persistently) while offline; send results first when back online,
  then check in.
* Add random jitter of ±10 % to the regular check-in interval so a fleet does not synchronise after a server restart.
* `4xx` other than 401/408/410/429: do not retry the same request unchanged.

---

## 11. Agent binaries (public, no auth)

| URL | File (server side: `$MDM_AGENT_DIR` or `agents/dist/`) | Content-Type |
|---|---|---|
| `GET /download/android` | `android/app-release.apk` | `application/vnd.android.package-archive` |
| `GET /download/windows` | `windows/wms-agent.zip` | `application/zip` |
| `GET /download/windows-install[?token=<enrollToken>]` | `windows/install.ps1` | `text/plain; charset=utf-8` |
| `GET /download/info` | — | JSON: per artifact `{ available, size, sha256, sha256Base64Url, url }` |

* `install.ps1` is served with two placeholders replaced: `__MDM_SERVER_URL__` → the public server URL
  (`MDM_PUBLIC_URL` env, else derived from the request), `__MDM_ENROLL_TOKEN__` → the `token` query parameter
  (only `[A-Za-z0-9_-]{1,128}` accepted, else empty). One-liner for technicians:
  `irm "https://erp.example.com/api/mdm/agent/download/windows-install?token=XXXX" | iex`
* Missing artifact → `404 NOT_FOUND` with a message that the agent has not been built yet.
* `sha256Base64Url` is the value for Android QR provisioning
  (`android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM`).
* Downloads support `HEAD` and `Range`, and carry `X-Content-SHA256`.

---

## 12. Security notes

* The device token is the only credential: 256 bits of randomness, the server stores only its SHA-256. Never log it,
  never put it in a URL. Keep it readable only by the agent (Android app-private storage, Windows SYSTEM-only ACL).
* Enroll tokens (QR / installer) enroll devices straight into an organisation — treat them as secrets, give them
  `maxUses`/`expiresAt`. A leaked enroll token can only add devices, it cannot control existing ones.
* The 6-digit enrollment code is only a pairing code shown on the device; enrolling by code requires a logged-in
  portal user. Registration is rate-limited per IP to make code farming impractical.
* Agents MUST verify `sha256` of every downloaded binary/file before installing or writing it and MUST only follow
  `downloadPath`s on the same server (relative paths). Never execute anything received outside `RUN_SCRIPT`.
* `RUN_SCRIPT` and `WIPE` can only be queued by users of the system owner (not distributors/clients).
* `X-Forwarded-For` is used for the recorded public IP and the register rate limit: the reverse proxy in front of the
  app MUST overwrite (not append to) that header.
* Uploaded content type is determined from the bytes, never from the header; uploads are stored outside the database
  under random keys.

---

## 13. Quick reference / example session (curl)

```sh
S=http://localhost:3100/api/mdm/agent
# register (PENDING)
curl -s -XPOST $S/register -H 'content-type: application/json' \
  -d '{"protocol":1,"platform":"ANDROID","hardwareId":"test-1","manufacturer":"SUNMI","model":"V2s"}'
# → {"deviceId":"…","token":"TOKEN","status":"PENDING","enrollCode":"483920","checkinSec":60}
curl -s -XPOST $S/checkin -H 'authorization: Device TOKEN' -H 'content-type: application/json' \
  -d '{"appliedConfigVersion":0,"telemetry":{"batteryLevel":80}}'
curl -s -XPOST $S/commands/CMDID -H 'authorization: Device TOKEN' -H 'content-type: application/json' -d '{"ok":true}'
curl -s -XPOST "$S/upload?kind=SCREENSHOT&commandId=CMDID" -H 'authorization: Device TOKEN' \
  -H 'content-type: image/png' --data-binary @screen.png
curl -s -H 'authorization: Device TOKEN' -H 'range: bytes=1048576-' -o part.bin $S/files/FILEID
```

Simulator (creates realistic demo devices):

```sh
node scripts/mdm-agent-sim.mjs --url http://localhost:3100 --count 25 --token <enrollToken>
node scripts/mdm-agent-sim.mjs --help
```

---

## 14. Server-side data (for portal developers)

What the agent API writes, so the portal can show it:

* `MdmDevice` telemetry columns (`batteryLevel`, `wifiSignal`, …), `lastSeenAt`, `onlineSince` (set when the device
  comes back after more than `ONLINE_GRACE_SEC`), `publicIp`, `appliedConfigVersion` (never above `configVersion`).
* `MdmDevice.telemetry` JSON: `{ "apps": [{packageName, name?, version?, versionCode?}], "appsAt": "<ISO>", "extra": {…} }`
  — merged per key, so `apps` survives check-ins that omit it.
* `MdmEvent.type` written by the server: `REGISTERED`, `ENROLLED` (via enroll token), `ONLINE`, `BOOT` (uptime went
  down), `BATTERY_LOW` / `STORAGE_LOW` (level `warn`, on crossing the threshold of `deviceAlerts`), `AGENT_UPDATED`,
  `OS_UPDATED`, `CONFIG_APPLIED`, `COMMAND_RESULT` (`data.commandId`), `UPLOAD` (`data.fileId`), `RETIRED`. Agent
  events are stored with the agent's own `type`/`level`.
* `MdmCommand`: `PENDING → SENT (sentAt) → SUCCEEDED | FAILED (doneAt, result, error)`; `EXPIRED` via `expireCommands`;
  `CANCELLED` when the device re-registers or is retired. `SCREENSHOT` / `UPLOAD_LOGS` get `result.fileId` as soon as
  the upload arrives. Short `INSTALL_APP` / `PUSH_FILE` payloads are completed in place on delivery (§5.2).
* Uploads: `MdmFile` (`kind` `SCREENSHOT` | `LOGS`, `orgId` = device org, `createdBy` = `Uređaj: <name>`) + `MdmUpload`;
  only the newest 20 per device and kind are kept (older rows and files are deleted).
* Enrolling by code in the portal: set `status: 'ENROLLED'`, `orgId`, `siteId`, `enrolledAt`, `enrollCode: null`.
  New devices start with `configVersion: 1` and `appliedConfigVersion: 0`, so the config is delivered at the next
  check-in without a bump (bumping does no harm).
