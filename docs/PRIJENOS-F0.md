# Prijenos — faza 0 (zajednički temelji)

Što je napravljeno prije faze 1 (područja A–F). **Shema i package.json su zaključani** — sve
promjene sheme su u `prisma/migrations/0008_prijenos/migration.sql`. Testne baze: `wms_test_a` … `wms_test_f`
(`TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/wms_test_X?schema=public npm run test:db`).

## 1. Shema (migracija 0008_prijenos)

Sve je dodano kao nullable ili sa zadanom vrijednošću; postojeći podaci se ne mijenjaju
(osim preslike stanja eRačuna u `Invoice.eInvoiceStatus`, vidi dolje).

### Nove enumeracije
| Enum | Vrijednosti | Namjena |
|---|---|---|
| `QuoteKind` | `QUOTE`, `PROFORMA` | vrsta ponude (B1) |
| `ServiceSource` | `INTERNAL`, `PORTAL` | izvor servisnog naloga (D3) |
| `EmailStatus` | `SENT`, `FAILED` | dnevnik e-pošte (A3) |
| `Series` + `PROFORMA` | prefiks broja `PRED` (`nextDocNumber(tx, cid, 'PROFORMA', god)`) | brojač predračuna (B1) |

`ServiceStatus.REPORTED` je već postojao.

### Company (postavke firme)
| Polje | Tip / zadano | Značenje (vlasnik) |
|---|---|---|
| `eInvoiceAttachPdf` | Bool, true | prilaži PDF u UBL (A4, UI F9) |
| `eReportingEnabled` | Bool, true | uplate na eRačun → eIzvještavanje (B2, UI F9) |
| `eInvoicePaymentMeans` | String, "30" | UNCL4461: 30 ili 58 (UBL, F9) |
| `paymentModel` | String, "HR00" | model poziva na broj (HUB3/UBL — sada je HR00 upisan u kodu: ubl-source.ts, hub3 ruta, invoice-document.tsx) |
| `swift` | String? | SWIFT/BIC na računu |
| `proformaTitle` | String, "Predračun" | naslov predračuna (B1) |
| `operatorName`, `operatorOib` | String? | zadani operater kad korisnik nema OIB |
| `vatTextEuGoods`, `vatTextEuService`, `vatTextThirdGoods`, `vatTextThirdService` | String? | tekstovi oslobođenja PDV-a (prazno = zadano; F dodaje `exemptText(company, region, kind)` u domain/tax) |
| `legalFooter` | String? | pravni podaci u podnožju dokumenata |
| `autoIssueRent` | Bool, false | automatsko izdavanje rata (F9) |
| `vatOnPayment` | Bool, false | PDV po naplaćenoj naknadi |
| `kpdRent`, `kpdSale`, `kpdService` | String? | zadane KPD šifre (B5) |
| `isDemo` | Bool, false | samo demo firma smije „Vrati demo podatke" (F11) |
| `smtpHost`, `smtpPort` (Int?), `smtpSecure` (Bool, false = STARTTLS), `smtpUser`, `smtpPassword` (šifrirano s `encryptSecret` iz server/fiscal/crypto), `mailFrom`, `mailReplyTo`, `mailBccSelf` (Bool) | | SMTP (A3) |
| `mailTemplates` | Json, `{}` | `{ invoice: {subject, body}, quote, proforma, delivery, accountant, reminder }` (A3) |
| `autoBackup` (Bool, false), `backupKeep` (Int, 14), `backupReminderDays` (Int, 7), `lastBackupAt` (DateTime?) | | sigurnosne kopije (F10) |

**Početni broj računa** (F9) nema polje: brojač je `DocumentCounter(companyId, 'INVOICE', godina).last` —
postavka „sljedeći broj N" upisuje `last = N-1` (samo ako je veći od trenutnog).
`smtpPassword` je izostavljen iz `getCompany()` i iz JSON sigurnosne kopije.

### User
| Polje | Značenje |
|---|---|
| `lastSeenAt` DateTime? | zadnja aktivnost; `getUser()` ga osvježava najviše jednom u minuti (F14 „tko je prijavljen": `lastSeenAt > now-5min`) |
| `totpSecret` String? | TOTP tajna, šifrirana `encryptSecret` (F6) |
| `totpEnabled` Bool=false | 2FA uključena |
| `backupCodes` String[] | sha256 sažeci rezervnih kodova |
| `requireApproval` Bool? | null = prati `Company.statusChangeNeedsApproval` (F8) |
| `canDanger` Bool=false | opasna zona (administrator uvijek) — helper `canUseDanger(u)` u domain/permissions |

`SessionUser` (server/auth.ts) ima nova neobavezna polja `canDanger` (ADMIN → true) i `requireApproval`.

### UserCompany (više firmi, F13)
`UserCompany(userId, companyId, createdAt)`, PK (userId, companyId). **Odluka:** `User.companyId` ostaje
*trenutno odabrana* firma — sve postojeće provjere `companyId: user.companyId` rade bez izmjene.
Prebacivanje firme = provjera da korisnik ima redak u `UserCompany` (ili da mu je to matična firma) pa
`user.update({ companyId })` + `revalidatePath('/')`. Uloga i prava vrijede u svim firmama. E-adresa
korisnika ostaje jedinstvena globalno (jedan račun, više firmi).

### Partner (C8)
`endpointId` (eRačun „shema:id", prazno = OIB 9934), `vatCategoryOverride` (S/AE/E/Z/O ili null),
`branchCode`, `branchName`.

### DeviceModel / Item (E2, E6, B5)
- `DeviceModel.cpu`, `screen`, `os` (zadano za nove uređaje), `DeviceModel.kpdRent` (KPD za najam; prazno = `Company.kpdRent`).
- `Item.cpu`, `screen`, `os`; `Item.categoryId` (Category?, SetNull, indeks) — kategorija po komadu, null = kategorija modela.

### Quote / QuoteLine (B1, B6)
- `Quote.kind QuoteKind @default(QUOTE)` + indeks (companyId, kind, date). Predračun: `kind=PROFORMA`, broj iz serije `PROFORMA`.
- `Quote.contractId` (Contract?, SetNull) — ugovor nastao iz ponude.
- `QuoteLine.lineType InvoiceType?` (SALE/RENT; null = prodaja), `QuoteLine.monthly Decimal?` (mjesečni najam).

### Invoice / InvoiceLine (B2, B3, B7)
- `Invoice.eInvoiceStatus String?` + indeks (companyId, eInvoiceStatus): null = nije poslan · `SENT` · `DELIVERED` ·
  `ACCEPTED` · `REJECTED` · `PAID` · `FISCALIZED` (IR bez slanja) · `REPORTED` (eIzvještavanje) · `ERROR`.
  Preslika za filtre popisa; `Invoice.eInvoice` JSON ostaje izvor detalja. Migracija je postojeće poslane
  (`eInvoice.route=EINVOICE`) postavila na SENT/ERROR. **B održava stupac** pri svakom slanju/osvježavanju
  (i u `server/fiscal/index.ts` gdje se piše `eInvoice.status`).
- `Invoice.eInvoiceStatusAt`, `Invoice.eReportedAt` DateTime?.
- `InvoiceLine.lineType InvoiceType?` — vrsta stavke na miješanom računu (null = `Invoice.type`).

### Nabava (E13, E14)
- `SupplierInvoice.orderId` (PurchaseOrder?), `receiptId` (GoodsReceipt?) — SetNull, indeksirano.
- `SupplierInvoice.supplierName`, `supplierOib` (kako je upisano), `vatPct Decimal(5,2)?`, `currency` (default EUR).
  **`supplierId` ostaje obavezan** — kod slobodnog unosa E otvara partnera pri spremanju (naziv/OIB se čuvaju i u ova polja).
- `PurchaseOrder.supplierInvoiceNo`, `supplierInvoiceDate`, `supplierInvoiceDueDate` (Date), `supplierInvoiceCurrency`,
  `supplierInvoiceNet`, `supplierInvoiceVat`, `supplierInvoiceTotal` (Decimal?).

### Servis i portal (D1, D3)
- `ServiceOrder.source ServiceSource @default(INTERNAL)`, `portalUserId` (PortalUser?, SetNull), `contact String?`;
  indeks (companyId, source, status) za brojač novih prijava.
- `PortalUser(id, companyId, partnerId, email @unique, name?, passwordHash, active, lastLoginAt, createdAt, updatedAt)` — Cascade s partnerom.
- `PortalSession(id, portalUserId, tokenHash @unique, expiresAt, revokedAt, ip, userAgent, createdAt)` — kao `Session` (u bazi samo sha256 tokena).

### EmailLog (A3)
`EmailLog(id, companyId, kind, entityId?, to, cc?, subject, status EmailStatus, error?, messageId?, sentBy?, at)`,
indeksi (companyId, at) i (companyId, kind, entityId).

Ugovor: ručni broj ugovora (C5) ne traži shemu (`Contract.number` je već slobodan tekst, jedinstven po firmi).

## 2. Ovisnosti
`nodemailer`, `pdfmake` 0.3, `exceljs`, `otplib` 13, `qrcode`, `tesseract.js` 7 (samo klijent, učitati lazy s `import()`),
tipovi `@types/nodemailer`, `@types/pdfmake`, `@types/qrcode`. `pdfmake`, `exceljs`, `nodemailer` su u
`serverExternalPackages` (next.config.ts).

## 3. Zajednički UI i čitanje parametara

### `src/lib/list-params.ts` (čisto, radi i na klijentu)
```ts
type SearchParams = Record<string, string | string[] | undefined>
paramStr(sp, name): string
parseMulti<T>(sp, name, allowed?: readonly T[]): T[]          // ?status=a,b → ['a','b'] (whitelist, bez duplikata, max 200)
inOrAll(values) → { in: values } | undefined                   // Prisma uvjet, undefined = bez filtra
parseSort<K>(sp, allowed: readonly K[], fallback?) → { sort: K, dir: 'asc'|'desc' } | null
sortOrderBy<K, O>(s, map: Record<K, (dir) => O | O[]>, tieBreak?) → O[] | undefined
parseDateRange(sp, fromName='od', toName='do') → { from: string|null, to: string|null }  // YYYY-MM-DD, obrnuto se okreće
dateRangeWhere(range) → { gte?: Date, lte?: Date } | undefined // za @db.Date stupce
queryWithout(sp, drop=['page']) → URLSearchParams
```

### Komponente (`src/components/ui/`)
- `filters.tsx` → **`<MultiSelectFilter name label options searchable? className? />`** — vrijednosti u jednom parametru odvojene
  zarezom; na mobitelu je iza gumba „Filtri" u `FilterBar`. **`<DateRangeFilter label from?='od' to?='do' />`** (`label` obavezan).
  `FilterBar` više ne broji `dir` i `format` kao aktivne filtre.
- `sort-header.tsx` → **`<SortHeader label field params basePath defaultDir?='asc' align? className? title? />`** — `<th>` s
  poveznicom `?sort=field&dir=asc|desc` (`prefetch={false}`, zadržava ostale parametre, briše `page`). Server i klijent.
  Poslužitelj: `parseSort(sp, ['broj','datum',…] as const, zadano)`. (Postojeći `SortHeader` u components/sales/list-bits.tsx
  koristi stari oblik `?sort=-polje`; B ga može prebaciti.)
- `export-buttons.tsx` → **`<ExportButtons href pdf?=true csv?=true pdfHref? size? label?='Izvoz' />`** (klijentska) — gumb
  „Izvoz" s Excel / CSV / PDF; `href` je API ruta izvoza s filtrima, Excel/PDF dodaju `format=xlsx|pdf`. Zamijenio je sve
  postojeće CSV gumbe. `withFormat(href, fmt)`.
- `attachments.tsx` → **`<Attachments entity id canEdit initial? empty? className? onChange?(count) />`** — prilozi dokumenta
  (`entity`: `'contract' | 'invoice' | 'supplierInvoice' | 'purchaseOrder' | 'receipt' | 'expense' | 'serviceOrder'`).
  Više datoteka odjednom, PDF i slike do 10 MB (slike se smanjuju na 2400 px), sličice, pregled, preuzimanje, brisanje uz potvrdu.
  Bez `initial` učitava `GET /api/prilozi?entity=&entityId=`; s poslužitelja: `listAttachments(db, user.companyId, entity, [id])`.
- `pdf-button.tsx` → **`<PdfButton kind id label? title? variant? size? extra? />`** — dijalog s iframeom `/api/pdf/kind/id`,
  Spremi PDF / Ispis / Otvori; `extra` = dodatne radnje (npr. `<SendEmailButton>`). `pdfUrl(kind, id, download?)`.
- `send-email-button.tsx` → **`<SendEmailButton kind id defaultTo? defaultSubject? defaultBody? label? variant? size? icon? />`**
  — dijalog Prima / CC / Naslov / Poruka / Priloži PDF → server akcija `sendDocumentEmail`.

## 4. Izvoz Excel / CSV / PDF popisa
- `src/lib/csv.ts`: `ExportColumn<T> = { label, value(row), type?: 'text'|'int'|'number'|'money'|'date'|'pct', width? }`
  (isto što `CsvColumn`), `inferColumnType(values)`, `toCsv`, `csvResponse`. Bez `type`: cijeli brojevi → int, decimalni → money,
  „YYYY-MM-DD" / „DD.MM.YYYY." → datum. **Stupce s iznosima označite `type: 'money'`** (inače iznosi bez decimala izlaze kao cijeli broj).
- `src/server/xlsx.ts`: `toXlsx(columns, rows, sheetName) → Promise<Buffer>` (podebljano i zamrznuto zaglavlje, autofiltar,
  širine, formati `#,##0.00`, `dd.mm.yyyy.`), `xlsxResponse(buf, name)`, `wantsXlsx(req)`,
  **`csvOrXlsx(req, rows, columns, fileName, sheetName?, { subtitle?, companyName?, landscape? }) → Response`**
  (`?format=xlsx` Excel, `?format=pdf` PDF tablica — najviše `PDF_MAX_ROWS`=5000 redaka, inače CSV). Alias `exportResponse`.
- Prebačene rute: `/api/prodaja/racuni/csv`, `/api/skladiste/izvoz`, `/api/skladiste/inventura/[id]`, `/api/nabava/ulazni`,
  `/api/servis`, `/api/partneri`, `/api/partneri/[id]/uredaji`, `/api/troskovi`, `/api/najam/ugovori`, `/api/najam/pregled`,
  `/api/izvjestaji/[slug]`. (ZIP knjigovođe i dalje ima `popis.csv` — E17.)
- **Nabavne cijene/marže u izvozu** svako područje samo izbacuje iz `columns` kad `!canSeeCost(user.perms)`.

## 5. PDF (`src/server/pdf/`, vlasnik A)
- `engine.ts`: `renderPdf(docDefinition) → Promise<Buffer>` (pdfmake, font Roboto iz `node_modules/pdfmake/fonts/Roboto` —
  čćžšđ i € provjereni; bold = Roboto Medium; vanjski URL-ovi i datoteke zabranjeni, slike kao data URL),
  `BASE_DOC` (A4, 9 pt), `pdfResponse(buf, fileName, inline=true)`.
- `table.ts`: `renderTablePdf({ title, subtitle?, columns: ExportColumn[], rows, totals?: Record<label, value>, landscape?, companyName? })`
  → Buffer (ponavljanje zaglavlja, brojevi stranica, ležeće kad > 7 stupaca), `tableDocDefinition`, `formatCell`.
- `index.ts`: **`renderDocumentPdf(kind: PdfKind, id, companyId) → Promise<{ buffer, fileName }>`** — STUB, baca
  `PdfNotImplementedError` (DomainError). Ne postoji zapis → baciti `DomainError` (ruta → 404).
- `src/domain/documents.ts`: `PDF_KINDS = invoice | quote | proforma | delivery | service | service-delivery | order | receipt | contract-list`,
  `PDF_KIND_LABEL`, `PDF_KIND_MODULE` (pravo pregleda po vrsti), `isPdfKind`; `MAIL_KINDS`, `MAIL_KIND_ACCESS`, `SendDocumentEmailInput`.
- Ruta **`GET /api/pdf/[kind]/[id]`** (`?preuzmi` = download): prijava, vrsta s popisa, pravo `PDF_KIND_MODULE[kind]` view,
  501 dok vrsta nema predložak. Samo `/api/pdf/*` smije u iframe (X-Frame-Options SAMEORIGIN, next.config.ts).

## 6. E-pošta (`src/server/mail/`, vlasnik A)
- `actions.ts` (`'use server'`): **`sendDocumentEmail({ kind, id, to, cc?, subject, body, attachPdf }) → ActionResult<{ messageId }>`**
  — konačan potpis; zod provjera adresa (više adresa zarezom), pravo po vrsti (`MAIL_KIND_ACCESS`: dokumenti prodaje → sales edit,
  service → service edit, partner → partners view, accountant-zip → reports ops), zatim `sendDocumentEmailImpl`.
- `index.ts`: **`sendDocumentEmailImpl(user, input) → Promise<{ messageId: string | null }>`** — STUB: baca
  „Slanje e-pošte još nije podešeno.". A ovdje implementira SMTP, PDF privitak, `EmailLog`.

## 7. Prilozi (`src/server/services/attachments.ts`)
`ATTACHMENT_ENTITIES[entity] = { module, view, add, remove, max, maxBytes, label }`:
| entity | modul | dodaj / briši | max. veličina |
|---|---|---|---|
| item | warehouse | ops / edit | 2 MB |
| request | warehouse | edit / edit | 2 MB |
| contract | rentals | edit / edit | 10 MB |
| invoice | sales | edit / edit | 10 MB |
| supplierInvoice | purchasing | edit / edit | 10 MB |
| purchaseOrder | purchasing | edit / edit | 10 MB |
| receipt | purchasing | edit / edit | 10 MB |
| expense | expenses | edit / edit | 10 MB |
| serviceOrder | service | edit / edit | 10 MB |

Pregled traži `view` modula. Novo: `canAttachment(perms, entity, 'view'|'add'|'remove')`,
`attachmentCounts(db, companyId, entity, ids) → Map<id, broj>` (oznaka spajalice/PDF u popisima — jedan groupBy),
`isProtectedAttachment` (izvorni XML eRačuna na ulaznom računu se ne briše). API: `GET /api/prilozi?entity=&entityId=` (popis),
`POST /api/prilozi` (multipart `entity`, `entityId`, `file`…), `GET|DELETE /api/prilozi/[id]` — sve po pravilima vrste i firmi
korisnika. `prepareUpload(file, { maxBytes?, maxSide? })` (components/warehouse/image-tools.ts).
Vraćanje kopije prihvaća priloge do 10 MB (`ATTACHMENT_MAX_FILE_BYTES`) i vrstu `purchaseOrder`.

## 8. Prava (`src/domain/permissions.ts`)
- Novi moduli: **`costs`** („Nabavne cijene i marže") i **`log`** („Dnevnik promjena"); oba samo `none`/`view`
  (`MODULE_LEVELS`, `levelsOf(m)`; viša razina se svodi na `view`). Uređivač prava u /postavke/korisnici prikazuje „—" za nepostojeće razine.
- Zadano: ADMIN, MANAGER → costs+log; ACCOUNTANT → costs (knjiži nabavu i troškove), bez loga; SALES, WAREHOUSE → ništa.
- `canSeeCost(perms)` — **svako područje skriva nabavne cijene, maržu i profit na ekranima i u izvozima kad je false**.
- `canUseDanger({ role, canDanger })`.
- /postavke/dnevnik i stavka u izborniku sada traže `log` (prije `settings`).
- Zasebno pravo `contracts` nije uvedeno — ugovori ostaju pod `rentals`.

## 9. Ostalo za fazu 1
- JSON sigurnosna kopija (server/import/backup.ts) još ne izvozi nove tablice (`EmailLog`, `PortalUser`, `UserCompany`) — F10 po potrebi.
- `paymentModel`/`eInvoicePaymentMeans` su u shemi, ali kod još koristi HR00/30 izravno (B/F).
- Testovi faze 0: `tests/prijenos-f0.test.ts`, `tests/integration/attachments-docs.test.ts`.
