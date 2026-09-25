# Razvoj — zajednički dijelovi i dogovori

Kratki vodič uz [CLAUDE.md](../CLAUDE.md) (pravila koda). Opisuje zajedničku infrastrukturu koju koriste
svi moduli; pojedinosti su u komentarima navedenih datoteka.

## Baza i migracije

- Shema: `prisma/schema.prisma`; migracije `prisma/migrations/0001…0009` (`npm run db:deploy`). Nova polja se dodaju
  **samo aditivno** (nullable ili sa zadanom vrijednošću), svaka promjena sheme je nova migracija.
- Tekstualna pretraga (`contains`, `mode: 'insensitive'`) ide samo na stupce s trigram (GIN) indeksom:
  `Item.serial/note/dupNote`, `Partner.name/email`, `InvoiceLine.description`, `EmailLog.to/subject`, `MdmDevice.name/serial/imei`.
  Pretraga po povezanoj tablici razrješava se unaprijed u id-eve (`resolveSearch` u `queries/warehouse.ts`).
- Svaki novi filtar ili sortiranje popisa treba indeks `(companyId, stupac)` — provjera: `EXPLAIN` nad bazom s
  ~200.000 uređaja u testnoj bazi.
  Sortiranje „najnoviji prvi" s praznima na kraju (`{ sort: 'desc', nulls: 'last' }`) treba indeks `DESC NULLS LAST` —
  Prisma ga ne zna izraziti, pa se u shemi piše `(sort: Desc)` s imenom (`map`), a u migraciji ručno `DESC NULLS LAST`
  (primjer: `Item_companyId_importDate_desc_idx` u 0009).
- Testne baze: `wms_test` (CI) i `wms_test_a…f`:
  `DATABASE_URL=…/wms_test_a npx prisma db push --skip-generate`, zatim
  `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/wms_test_a npm run test:db`.

## Popisi, filtri, izvoz

- `src/lib/list-params.ts`: `paramStr`, `parseMulti` (više vrijednosti zarezom), `inOrAll`, `parseSort`/`sortOrderBy`
  (`?sort=kolona&dir=asc|desc`), `parseDateRange`/`dateRangeWhere` (`?od=&do=`).
- UI (`src/components/ui/`): `FilterBar`, `SearchFilter`, `MultiSelectFilter`, `DateRangeFilter`, `SortHeader`,
  `Pagination` + `readPage()`, `ExportButtons` (Excel / CSV / PDF).
- Izvoz: API ruta vraća `csvOrXlsx(req, rows, columns, fileName, sheet?, opts?)` (`src/server/xlsx.ts`) — `?format=xlsx`
  Excel, `?format=pdf` PDF tablica (`renderTablePdf`, najviše 5.000 redaka), inače CSV. Iznosi: `type: 'money'`.
- Nabavne cijene, marže i profit samo uz `canSeeCost(user.perms)` (pravo `costs`) — i na ekranu i u izvozu.

## Dokumenti: PDF, ispis, e-pošta

- `renderDocumentPdf(kind, id, companyId)` (`src/server/pdf/index.ts`) — sve vrste iz `PDF_KINDS`
  (`src/domain/documents.ts`); ruta `GET /api/pdf/[kind]/[id]` (`?preuzmi`), klijent `<PdfButton>`.
- Naslov ponude/predračuna: `quoteDocTitle(quote, company)` — predračun ima vlastiti naslov (`Quote.title`),
  inače `Company.proformaTitle`. Koriste ga ekran, ispis, PDF, HUB-3 i e-pošta.
- PDV po naplaćenoj naknadi (`Company.vatOnPayment`): napomena `VAT_ON_PAYMENT_NOTE` na ispisu, PDF-u i kao
  `cbc:Note` eRačuna, plus `HRObracunPDVPoNaplati` u HR proširenju UBL-a (`src/domain/tax.ts`, `src/domain/ubl.ts`).
- E-pošta: `sendDocumentEmail` (`src/server/mail/actions.ts`) → SMTP iz postavki, PDF privitak, dnevnik `EmailLog`;
  klijent `<SendEmailButton kind id />`.

## Prilozi

`<Attachments entity id canEdit />` + `/api/prilozi` (`src/server/services/attachments.ts`, `ATTACHMENT_ENTITIES`
određuje modul i razine po vrsti). Sadržaj je u bazi (`Attachment.data`). Prilog servisnog naloga je vidljiv
klijentu na portalu samo uz `Attachment.public` (fotografije s prijave kvara automatski; osoblje prekidačem
„Vidljivo klijentu", `PATCH /api/prilozi/[id]`).

## Prodaja i najam

- Račun za najam iz Prodaje: ugovor klijenta ili „+ Novi ugovor"; uređaji se vežu uz ugovor pri izdavanju
  (`applyRent` u `services/invoices.ts`) s planom `invoiceRentPlan` (`src/domain/sales-lines.ts`) — po želji
  „Zatim naplata prelazi u" (`Invoice.rentNextBilling/rentNextFrom`) kao drugo razdoblje plana.
- Paketi (Marže → Paketi): `Package`/`PackageItem`, `services/packages.ts`; cijena paketa se pri izradi ponude,
  predračuna ili nacrta računa raspoređuje po `distributePackagePrice`, zbrojevi `packageTotals` (`domain/pricing.ts`).
- Automatsko izdavanje rata (`src/server/jobs/auto-issue.ts`): samo rate s dospijećem od `Company.autoIssueSince`
  (dan uključivanja), bez zaostataka.

- eRačun — kategorije PDV-a K i G (`ublTreatment`, `src/domain/ubl.ts`): **namjerno** se šalju kao `E`
  (oslobođeno) s razlogom oslobođenja iz računa, kao u starom programu, jer ih posrednik tako prihvaća. U XML-u je to E; na ispisu
  i u bazi račun zadržava K/G (i razlog oslobođenja). Zakonska osnova koja ide u `TaxExemptionReason`:
  isporuka dobara unutar EU → čl. 41. st. 1. Zakona o PDV-u (NN 73/13 i izmj.); izvoz → čl. 45. st. 1. istog zakona.
  EN 16931 predviđa kodove `K` (intra-community supply, uz PDV ID kupca, BR-IC-*) i `G` (izvoz, BR-G-*) — ako
  knjigovođa ili posrednik zatraže točne kodove, promjena je jedan redak u `ublTreatment` (uz testove u
  `tests/ubl.test.ts`). **Knjigovođa treba potvrditi** da je E s navedenim razlogom prihvatljiv za PDV-S/ZP obrazac.
- Uračunati predujam na konačnom računu: najviše do ukupnog iznosa računa (`assertAdvancesWithinTotal`,
  `clampAdvanceUses`); u UBL-u `PayableAmount = TaxInclusiveAmount − PrepaidAmount ≥ 0` (BR-CO-16).
- E-pošta izdanog računa: predložak po vrsti i stanju (`invoiceMailTemplate`, `src/domain/mail.ts`) — račun
  (otvoreni iznos), plaćeni račun, račun za predujam, odobrenje, storno; predračun i ponuda imaju svoje.

## Trošak robe u nabavi (narudžbenica, primka, ulazni račun)

Jedno pravilo po **narudžbenici** (skupini): ukupni knjiženi trošak robe = **max(R, I)**, nikad R + I.

- **R** = zbroj troškova „Nabava robe" proknjiženih primki skupine (primka s kvačicom „Knjiži nabavu u troškove";
  storno briše trošak primke).
- **I** = zbroj osnovica **računa za robu** skupine koji se knjiže (prihvaćeni — ne zaprimljeni eRačun, ne odbijeni —
  s uključenim „Knjiži kao trošak", `SupplierInvoice.bookExpense`).
- Skupina: narudžbenica (sve njene primke i računi); primka bez narudžbenice je sama svoja skupina; nepovezani račun
  je sam svoja skupina (R = 0).
- Primka **uvijek** knjiži svoju nabavnu vrijednost (usklađivanje nikad ne mijenja trošak primke). Računi za robu,
  redom po datumu računa pa upisu, „troše" R: pokriveni dio ne knjiže, knjiže samo razliku iznad primki
  (način `own` / `partial` / `receipt` / `none`, PDV razmjerno). Zato je R + Σ vlastitih = max(R, I).
- Računi koji **nisu roba** (prijevoz, usluge, dodatni troškovi) uvijek knjiže cijelu osnovicu zasebno i ne troše R.
- Zadano „račun za robu" (dok korisnik ne odluči kvačicom; odluka se pamti u `goodsInvoice`): račun skupine
  kategorije „Nabava robe" čija osnovica stane u još nefakturiranu vrijednost robe (i djelomični računi), ili prvi
  povezani račun bez druge kategorije čija osnovica odgovara vrijednosti primki/narudžbenice (±1 % ili 1 €).
  Druga kategorija (npr. „Prijevoz") nije roba. Obrazac računa isto pravilo računa i pri promjeni veze (`goodsRuleAction`).
- Pravilo: `src/domain/purchase-links.ts` (`allocateGoodsExpense`, `defaultGoodsInvoice`, `receiptEffect` za dijalog
  zaprimanja). Zapis: `reconcileOrderGoodsExpense` (`src/server/services/goods-expense.ts`) iz stanja baze ponovno
  zapiše vlastiti trošak svih računa skupine; zove se nakon **svake** promjene — primka, storno primke, naknadno
  knjiženje troška primke, spremanje / (pre)povezivanje / brisanje računa (i stara skupina), prihvaćanje i odbijanje
  eRačuna, „Knjiži ponovno", podaci računa na narudžbenici. Rezultat ne ovisi o redoslijedu radnji — matrica
  redoslijeda u `tests/integration/b-goods-expense.test.ts`.
- Podaci računa na narudžbenici stvaraju račun za robu samo ako stane u nefakturiranu vrijednost robe (inače greška —
  već postoji račun za istu robu).
- Plaćenost računa za robu koji troši primke prelazi na troškove primki (`mirrorReceiptPaid`, `COVERING_GOODS_INVOICE`).
- Bez prava `costs` troškovi primki, otpisa i računa za robu nisu na `/troskovi` (ni u zbrojevima ni izvozu), a iznosi
  računa za robu na `/nabava/ulazni` su skriveni.

## Sigurnost i sustav

- Prava: `src/domain/permissions.ts` (moduli, razine, `canSeeCost`, `canUseDanger`); stranica `pageAccess`, akcija `action({ module, level })`.
- 2FA (`services/two-factor.ts`): TOTP šifriran u bazi, rezervni kodovi kao sažeci, zaštita od ponovne uporabe koda
  (`User.totpLastStep`). `LoginAttempt` je tablica za ograničenje pokušaja prijave zajedničko svim procesima.
- Opasna zona (`services/danger.ts`): „Obriši promet" i „Obriši sve" (uključuje sve MDM podatke — `mdm/wipe.ts`;
  datoteke s diska brišu se tek nakon potvrđene transakcije).
- Datoteke izvan baze: `storage/mdm` (`MDM_STORAGE_DIR`) i `storage/backups` (`BACKUP_DIR`) — u produkciji na
  Docker volumenima (`deploy/docker-compose.yml`), u noćnoj kopiji `deploy/backup.sh`.
- Pozadinski poslovi (`src/server/jobs/scheduler.ts`, pokreće `instrumentation.ts`): automatsko izdavanje rata i
  sigurnosne kopije, jednom dnevno, zaključavanje advisory lockom.

## Uvoz

Stara baza (JSON) → plan (`src/server/import/legacy*.ts`, `plan.ts`) → upis (`run*.ts`). Uređaji nose procesor,
ekran, OS (zadano s modela) i kategoriju po komadu kad odstupa od modela. Sigurnosna kopija ovog programa:
`backup.ts` (izvoz i vraćanje u novu firmu).
