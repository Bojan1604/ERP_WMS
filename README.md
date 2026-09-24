# ERP · WMS

Web aplikacija za tvrtku koja **prodaje, iznajmljuje i servisira opremu praćenu po
serijskim brojevima** (POS uređaji, printeri, KDS, kiosci, tableti…). Pokriva cijeli
tok: nabava → skladište → ponuda → račun ili ugovor o najmu → naplata → servis →
izvještaji.

Novi program, napisan ispočetka po uzoru na raniju verziju (Vite + Supabase, cijela
firma u jednom JSON zapisu). Poslovna pravila su ista, ali je temelj drugačiji:

| Ranije | Sada |
|---|---|
| cijela firma u jednom JSON zapisu, sudari pri spremanju | prave relacijske tablice (PostgreSQL), svaka izmjena u transakciji |
| sve se učitava u preglednik, filtrira u JavaScriptu | filtriranje, straničenje i zbrojevi u bazi — brzo i s 300.000+ uređaja |
| broj računa računa preglednik | broj dodjeljuje baza atomski — nema duplih ni kad dvoje izdaju istovremeno |
| „čistač" provjerava dosljednost naknadno | pravila se primjenjuju pri svakoj promjeni (jedno mjesto za status uređaja) |
| prava provjerava preglednik | prava i izolacija firmi provjeravaju se na poslužitelju |
| datoteke od 2.000+ linija | slojevi: domena (čista logika) · servisi · upiti · ekrani |

---

## Pokretanje

Potrebno: **Node.js 20.9+** i **PostgreSQL 14+**.

```bash
cp .env.example .env        # upišite lozinku baze u DATABASE_URL i nasumični AUTH_SECRET
npm install
npm run setup               # stvara tablice (migracije) i demo podatke
npm run dev                 # http://localhost:3000
```

Demo prijave (lozinka za sve: `admin123`):

| Korisnik | Uloga |
|---|---|
| `admin@demo.hr` | Administrator — sve |
| `maja@demo.hr` | Voditelj — sve osim korisnika |
| `luka@demo.hr` | Prodaja — računi, ponude, najam, partneri, servis |
| `ana@demo.hr` | Skladište — operativno (promjene statusa idu na odobrenje) |
| `iva@demo.hr` | Knjigovodstvo — pregled, troškovi, nabava |

### Windows — korak po korak

1. Instalirajte **Node.js LTS** (<https://nodejs.org>) i **PostgreSQL** (<https://www.postgresql.org/download/windows/>).
   Zapamtite lozinku za korisnika `postgres`. Nakon instalacije otvorite **novi** Command Prompt.
2. U mapi projekta:
   ```bat
   copy .env.example .env
   ```
3. Otvorite `.env` u Notepadu:
   - u `DATABASE_URL` zamijenite `postgres:postgres` s `postgres:VASA_LOZINKA`
   - u `AUTH_SECRET` upišite bilo koji niz od barem 32 znaka
4. Zatim:
   ```bat
   npm install
   npm run setup
   npm run dev
   ```
5. Otvorite <http://localhost:3000>. Bazu `wms` ne treba ručno stvarati.

> **`Error: P3005 The database schema is not empty`** — baza `wms` već ima tablice (npr. od ranijeg
> pokretanja s `db:push`). Ako u njoj nema podataka koje trebate, obrišite je i napravite ispočetka:
> `npm run db:reset` (briše sve tablice, primjenjuje migracije i puni demo podatke).

> Poruka `npm install` o „vulnerabilities" odnosi se na alate za izgradnju (postcss, deepmerge-ts), ne na
> sam program. **Ne pokrećite `npm audit fix --force`** — ono spušta verzije paketa i kvari program.

Program ima vlastitu bazu (`wms`) i ne dijeli ništa s drugim programima na istom PostgreSQL-u.

### Brzi način rada (svakodnevno korištenje)

`npm run dev` je **razvojni** način: svaka stranica se pri prvom otvaranju prevodi (1–2 s). Za
svakodnevni rad pokrenite **`pokreni.bat`** (dvoklik) ili:

```bat
npm run serve        :: izgradi i pokreni — stranice se otvaraju za 0,01–0,1 s
```

### Nadogradnja na novu verziju (bez gubitka podataka)

1. Raspakirajte novu verziju preko stare mape (datoteku `.env` zadržite).
2. `npm install`
3. `npx prisma migrate deploy` — nadograđuje bazu novim migracijama, podaci ostaju.
4. `npm run serve` (ili `pokreni.bat`, koji radi korake 2–4 sam).

Ne pokrećite `db:reset` ni `db:seed` na bazi sa stvarnim podacima — brišu je.

### Mobitel i skeniranje kamerom

Otvorite program s mobitela preko adrese računala u lokalnoj mreži (npr. `http://192.168.1.20:3000`)
i u pregledniku odaberite „Dodaj na početni zaslon" — otvara se kao aplikacija. **Kamera za
skeniranje radi samo preko HTTPS-a** (ili na `localhost`): za probu na mreži pokrenite
`npm run dev:https`, a za stalni rad stavite ispred programa HTTPS (npr. Caddy:
`caddy reverse-proxy --from wms.firma.hr --to localhost:3000`). USB/Bluetooth skeneri barkoda
rade bez HTTPS-a — program sam prepoznaje njihov unos.

### Produkcija

```bash
npm run build
npm run db:deploy           # primjena migracija
npm run start               # port 3000 (drugi: npx next start -p 8080)
```

Ili Docker: `docker build -t erp-wms . && docker run -p 3000:3000 --env-file .env erp-wms`
(migracije se primjenjuju pri pokretanju). Lokalna baza za razvoj: `docker compose up -d`.

Za produkciju obavezno postavite vlastiti `AUTH_SECRET` (`openssl rand -base64 48`) i
ne pokrećite `db:seed` — on briše i ponovno stvara demo firmu.

---

## Moduli

**Nadzorna ploča** — prihod, bruto dobit i marža, potraživanja i dospjelo, vrijednost zalihe,
mjesečni najam; graf prihoda po mjesecima; zadaci: rate za izdati, računi koji kasne, izlaz
i povrat, odobrenja, dugi servisi, niska zaliha, garancije koje istječu. Prikaz prema pravima.

**Skladište**
- Popis uređaja s filtrima (pretraga, status, model, kategorija, skladište, dobavljač, kupac, godina uvoza), brojevima po stanju, vrijednošću i CSV izvozom
- Grupne radnje: promjena statusa (skladištar šalje na odobrenje), međuskladišnica, „Izašlo iz skladišta", otpis (uz trošak), grupna izmjena
- Kartica uređaja: podaci, povijest, zarada naspram nabavne cijene, jamstvo, ugovor, servisi; dupli serijski samo uz razlikovnu napomenu
- Zaprimanje: lijepljenje stupca serijskih ili generiranje raspona — tisuće komada jednom primkom, s knjiženjem troška
- Izlaz i povrat: izašlo → račun / ugovor / natrag; uređaji za povrat (istek ugovora, kraj sezone, raskid); u dolasku → zaprimi; ručni povrat
- Međuskladišnice s ispisom, odobrenja promjena statusa i zaprimanja (skladištar šalje skenirano, administrator provjerava)
- **Skeniranje** kamerom mobitela (barkod, QR, DataMatrix) i USB/Bluetooth skenerom: kartica uređaja s brzim radnjama ili skupni način za više uređaja odjednom
- **Inventura**: skeniranje stvarnog stanja (i više ljudi istovremeno), nedostaje / pronađeno / višak, zatvaranje s prijenosom ili otpisom, izvještaj
- **Naljepnice** s barkodom i QR-om (A4 listovi i printeri naljepnica 50×25, 62×29, 100×50 mm). QR nosi poveznicu
  `APP_URL/skladiste/<id>` ako je u `.env` postavljen `APP_URL` (npr. `https://erp.firma.hr`), inače samo putanju
  `/skladiste/<id>` — skener u aplikaciji je prepoznaje u oba slučaja, a kamera mobitela otvara samo punu poveznicu
- Fotografije naljepnica pri izlazu iz skladišta i prilozi na kartici uređaja

**Prodaja**
- Računi: nacrt → izdavanje (broj `12/ZG1/1` po pravilima Porezne uprave, redni broj prati datum), uređaji sa skladišta s prijedlogom cijene (dogovoreni cjenik → cijena modela → marža), usluge, ručne stavke, popusti po stavci i na račun, neoporezive naknade, PDV prema državi kupca (HR / EU / izvoz)
- Izdan račun se ne mijenja: **storno** (vraća robu na skladište) i **knjižno odobrenje**; djelomične uplate, „plaćeno u cijelosti", povrat u neplaćeno
- Popis s bojama naplate (kasni / nije dospjelo / plaćeno), zadani poredak „kasni prvo", brojač dana koji staje plaćanjem, zbrojevi, CSV
- Ispis A4 s HUB3 2D barkodom za plaćanje, otpremnica sa serijskim brojevima i jamstvom, **eRačun XML** (UBL 2.1, HR CIUS 2025: 380/381/384/386)
- Način plaćanja, **fiskalizacija** (ZKI, JIR, QR kod, naknadna dostava) i slanje **eRačuna** posredniku — vidi [Fiskalizacija](#fiskalizacija)
- Ponude: stavke po modelu bez serijskih, istek valjanosti, stanja, ispis, pretvaranje u račun uz odabir konkretnih uređaja

**Najam**
- Ugovori: početak, kraj, odgoda prve rate, dan naplate, učestalost (mjesečno → godišnje, jednokratno), naplata unaprijed ili unatrag, sezona
- **Plan naplate po uređaju** — niz razdoblja s vlastitom cijenom, učestalošću i sezonom (npr. rujan jednokratno, od listopada kvartalno)
- Dodavanje uređaja sa skladišta ili s terena, grupne izmjene cijene i plana, pauza, uklanjanje (→ povrat), otkaz ugovora
- Raspored naplate kroz godinu (rate i mjesečni obračun), računi ugovora, povijest
- **Rate za izdati**: sve dospjele rate po uređaju i razdoblju, izdavanje više njih odjednom (i odmah plaćeno), „već izdano izvan programa"
- Pregled najma kao Excel mreža (uređaji × mjeseci) s ručnim ispravcima ćelija

**Nabava** — narudžbenice (niska zaliha → prijedlog narudžbe), zaprimanje po stavci, primke sa stornom, ulazni računi (knjiga URA) s knjiženjem troška.

**Servis (RMA)** — nalozi (i automatski kad uređaj dobije status kvara), tijek statusa, dijagnoza i trošak, povrat uređaja u prethodno stanje (i natrag u najam), zamjenski uređaj koji preuzima kupca, jamstvo i mjesto na ugovoru, ispis naloga.

**Troškovi** — ručni i ponavljajući (mjesečno…godišnje; pojedini mjesec se mijenja ili preskače), automatski iz primki, otpisa i ulaznih računa; po mjesecima i kategorijama.

**Partneri** — kupci i dobavljači, provjera OIB-a, isključivanje iz obračuna, napomena na računu, dogovoreni cjenik, uređaji kod klijenta (ispis popisa), ugovori, kartica s tekućim saldom.

**Izvještaji (21)** — prihod, profit, top kupci, marža po modelu, prodaja po kategorijama, zarada po uređaju, starost potraživanja, nenaplaćeno, brzina naplate, najam po mjesecima i klijentima, istek ugovora, nabava po dobavljačima, zaliha po statusu / kategoriji / skladištu / starosti, garancije, otpisi, servis po modelu, troškovi, neto rezultat. Svaki s filtrima, ispisom i CSV-om.

**Postavke** — podaci firme i logo, PDV, rokovi, marže, numeracija računa, šifrarnici (skladišta, kategorije, modeli, statusi, usluge, kategorije troškova), korisnici s ulogama i iznimkama prava po modulu, dnevnik svih promjena.

Globalna pretraga (serijski broj vodi ravno na uređaj), svijetla i tamna tema, rad na mobitelu.

---

## MDM — upravljanje uređajima

Web konzola za Windows računala, Android računala i Android handheldove (po uzoru na
Orderman SystemCenter Next, bez Orderman radio uređaja). Izbornik **MDM** u aplikaciji.

**Tko što vidi**

| Račun | Vidi |
|---|---|
| Korisnici vaše firme (Administrator) | sve distributere, sve klijente i sve uređaje |
| Distributer (račun se otvara u MDM → Organizacije) | svoju organizaciju, svoje klijente i njihove uređaje |
| Klijent | samo svoju organizaciju i svoje uređaje |

Distributer i klijent ne vide ERP dio (računi, skladište…), samo MDM.

**Mogućnosti:** nadzorna ploča (online/offline, baterija, prostor, upozorenja) · popis uređaja s filtrima i
skupnim naredbama · detalji uređaja (telemetrija, instalirane aplikacije, zaslon uživo, zapisnici, naredbe,
događaji, bilješke, veza na uređaj u skladištu) · naredbe: ponovno pokretanje, primjena konfiguracije,
instalacija/uklanjanje aplikacije, snimka zaslona, prikupljanje zapisnika, zaključavanje, poruka, slanje datoteke,
zaključani način (kiosk), brisanje (Android, samo vlasnik), PowerShell skripta (Windows, samo vlasnik), zaboravi
uređaj · konfiguracije (profili) po lokaciji ili uređaju: aplikacije, kiosk, ograničenja, Wi-Fi, zaslon, zvuk,
vremenska zona, PIN za održavanje · knjižnica aplikacija (APK, MSI, EXE s verzijama) · datoteke · dokumenti
· upis uređaja 6-znamenkastim kodom ili ključem (Android QR, Windows naredba).

**Demo:** `npx tsx scripts/mdm-demo.ts` stvara distributere, klijente, lokacije i uređaje na čekanju
(`distributor@demo.hr`, `distributor2@demo.hr`, `klijent@demo.hr`, lozinka `admin123`).
`node scripts/mdm-agent-sim.mjs --help` — simulator uređaja (bez pravih uređaja).

**Za prave uređaje treba:**

1. Poslužitelj dostupan uređajima preko **HTTPS-a** (javna adresa ili VPN) i `APP_URL` u `.env`.
2. Agenti u `agents/dist/` (poslužitelj ih nudi na `/api/mdm/agent/download/*`):
   - Windows: već je u paketu (`agents/dist/windows`). Na računalu kao administrator pokrenite naredbu s
     *MDM → Upis uređaja*.
   - Android: GitHub → Actions → *MDM agenti* → zadnji zeleni run → preuzmite `mdm-agent-android` i
     raspakirajte u `agents/dist/android/` (ili `agents/build-dist.sh`). Upis: tvornički reset uređaja,
     6× dodir početnog zaslona, skeniranje QR koda s *Upis uređaja*.
3. Za stalan Android QR: potpisni ključ u GitHub tajnama `ANDROID_KEYSTORE_BASE64`,
   `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` (bez njih se gradi debug APK
   čiji se potpis mijenja svakom izgradnjom). Checksum se čita iz `agents/dist/android/signature-checksum.txt`
   ili `MDM_ANDROID_SIGNATURE_CHECKSUM`.

Neobavezno u `.env`: `MDM_STORAGE_DIR` (mapa za aplikacije, snimke i zapisnike; zadano `storage/mdm`),
`MDM_AGENT_DIR`, `MDM_DEFAULT_COMPANY_ID` (firma za uređaje upisane kodom). Protokol agenta:
`docs/mdm-agent-protocol.md`; agenti: `agents/README.md`.

## Arhitektura

Next.js 15 (App Router, server komponente, server akcije) · TypeScript · Prisma 6 · PostgreSQL · Tailwind 4.
Pravila koda i raspored slojeva: **[CLAUDE.md](CLAUDE.md)**.

- `src/domain/` — čista poslovna logika (iznosi, PDV, numeracija, marže, motor naplate najma, eRačun XML…), bez baze, potpuno testirana
- `src/server/services/` — operacije nad bazom u transakcijama; `changeItemStatus` je jedino mjesto promjene statusa uređaja
- `src/server/queries/` — čitanja za ekrane: filtriranje, straničenje i agregacije u bazi
- `src/app/` — ekrani i server akcije s provjerom prava i validacijom (zod)

Skalabilnost: sve tablice nose `companyId` (više firmi u istoj bazi), svaki strani ključ ima indeks, pretraga po
dijelu teksta koristi trigram (GIN) indekse, zbrojevi dokumenata spremaju se na zaglavlje pa izvještaji rade
agregacijom u bazi. Provjereno s 300.000 uređaja i 100.000 računa: popisi i pretraga 0,05–0,3 s po stranici.

## Testovi

```bash
npm test          # domena: iznosi, PDV, marže, motor naplate, plan, serijski, eRačun XML
npm run test:db   # servisi nad testnom bazom `wms_test` (izdavanje, istovremena numeracija, storno, uplate, najam, statusi, izolacija firmi)
npm run typecheck
```

`test:db` očekuje bazu `wms_test` (`createdb wms_test && DATABASE_URL=…/wms_test npx prisma db push`) ili
`TEST_DATABASE_URL`. GitHub Actions (`.github/workflows/ci.yml`) pokreće sve to i produkcijski build.

## Fiskalizacija

Pripremljeno je sve za **Fiskalizaciju 1.0** (CIS Porezne uprave) i **eRačun / Fiskalizaciju 2.0** (preko
informacijskog posrednika). Postavke: **Postavke → Fiskalizacija** (popis „Spremnost za produkciju" pokazuje što još nedostaje).

- **Koji račun kamo:** gotovina, kartica i „ostalo" → CIS (ZKI pri izdavanju, JIR od CIS-a); transakcijski račun
  domaćem kupcu s OIB-om → eRačun (UBL) posredniku; transakcijski račun kupcu bez OIB-a u RH → CIS; strani kupac → ništa.
  Način plaćanja bira se na računu (zadano: transakcijski račun); storno i odobrenje ga nasljeđuju.
- **Izdavanje** računa izračuna ZKI u transakciji; slanje u CIS/posredniku ide tek nakon nje i nikad ne ruši izdavanje —
  neuspjeh ostavlja račun izdan sa ZKI-jem, stanjem „Greška" i porukom. „Ponovi fiskalizaciju" na računu ili
  „Naknadna fiskalizacija" u postavkama (do 50 računa odjednom, najviše 60 s; nedostupan CIS ili posrednik prekida
  svoje račune) šalju ga ponovno s oznakom naknadne dostave. Prije slanja račun se atomski „zauzme" (oznaka
  `sending` s vremenom u `Invoice.eInvoice`), pa istodobni pozivi ne šalju isti račun dvaput; zauzimanje napušteno
  zbog pada procesa zastari nakon 5 min. Drugi JIR nikad ne prepisuje prvi. eRačun čije je slanje isteklo bez
  odgovora dobiva stanje „nepoznato" — naknadna dostava ga ne šalje sama (provjerite kod posrednika, pa „Pošalji eRačun").
  Ispis nosi način plaćanja, operatera (ime i OIB), ZKI, JIR i QR kod za provjeru. Svaki poziv je u dnevniku (zadnjih 50).
- **Demo način:** okruženje TEST bez učitanog certifikata — ZKI se računa privremenim ključem, JIR je izmišljen, ništa
  se ne šalje; posrednik „Demo" prihvaća svaki eRačun. U dnevniku su takvi zapisi označeni „demo".

**Odlazak u produkciju:**

1. **Postavke → Firma:** ispravan OIB firme, oznaka poslovnog prostora (prijavljena u ePoreznoj) i naplatnog uređaja (brojka).
2. **Postavke → Korisnici:** OIB svakom korisniku koji izdaje račune (bez njega se račun za gotovinu/karticu ne izdaje).
3. **Postavke → Fiskalizacija:** učitati FINA fiskalizacijski certifikat (.p12 i lozinka — program ga otvara, provjerava
   OIB i rok, lozinku čuva šifriranu AES-256-GCM ključem iz `AUTH_SECRET`); „Testiraj vezu" u okruženju TEST
   (cistest.apis-it.hr); zatim okruženje **PROD** i uključiti fiskalizaciju.
4. eRačun: ugovor s posrednikom (ePoslovanje.hr), u ePoreznoj ovlastiti posrednika, upisati API ključ (sprema se
   šifriran i ne vraća se u preglednik), „Testiraj vezu". Uplate na poslani eRačun prijavljuju se posredniku (eIzvještavanje o naplati).

Ako Node ne vjeruje FINA-inom TLS certifikatu CIS-a, postavite `FISCAL_CA_FILE=/put/do/fina-ca.pem` (ili
`NODE_EXTRA_CA_CERTS`). **Algoritam XML potpisa** poruke za CIS bira `FISCAL_SIGNATURE=sha256|sha1` (zadano `sha256`,
RSA-SHA256 + SHA-256 sažetak). Primjeri u Tehničkoj specifikaciji Fiskalizacije 1.x koriste RSA-SHA1/SHA1 — ako CIS
na testnom okruženju vrati grešku s004 „Neispravan digitalni potpis", postavite `FISCAL_SIGNATURE=sha1` (ZKI se
uvijek računa RSA-SHA1 + MD5, neovisno o tome). Promjena `AUTH_SECRET`-a znači ponovni upis lozinke certifikata i API ključa. Kod je u
`src/domain/fiscal.ts` (pravila, oblikovanje, QR) i `src/server/fiscal/` (certifikat, ZKI, CIS poruka i potpis, posrednici).

## Uvoz podataka iz stare verzije

Stara verzija (Vite/Supabase) čuva cijelu firmu kao jedan JSON. Prijenos:

1. U staroj verziji: **Postavke → Sigurnosna kopija → Preuzmi kopiju (JSON)**. Prihvaćaju se i dnevne kopije
   (`backup:<firma>:<datum>` → `{ date, savedAt, data }`), omotači `{ data }` / `{ db }` i zapisi po kolekciji
   (`db:<firma>:items`, … — i kao redci `[{ key, value }]` iz tablice `app_kv`).
2. Ovdje: **Postavke → Uvoz i izvoz**, ispustite datoteku (do 256 MB; šalje se u dijelovima). Prvo se prikaže analiza:
   prepoznati oblik, broj zapisa po vrsti, upozorenja (nepostojeće veze, dupli serijski, nečitljivi datumi i brojevi,
   nepoznati statusi, država „EU" bez ISO oznake…) i primjer preslikavanja. Ništa se ne upisuje dok ne potvrdite.
3. **Uvezi u novu firmu** (preporučeno): stvara se firma i u njoj novi administrator (`vaše-ime+naziv-firme@domena`)
   s nasumičnom lozinkom koja se prikaže samo jednom — korisnik pripada jednoj firmi, pa se sadašnji račun ne premješta.
   **Uvoz u trenutnu firmu** traži potvrdu ako firma nije prazna; postojeći zapisi se preskaču po prirodnom ključu
   (serijski + razlikovna napomena, OIB ili naziv partnera, proizvođač + model, godina + redni broj računa, broj dokumenta).

Što se prenosi: skladišta, kategorije, modeli, statusi (zastavice `inStock/sold/rented/rma/returning/reserved/writtenOff`
→ vrsta statusa), usluge, partneri, dogovorene cijene, uređaji (stanje po statusu, uz pravilo „uređaj na skladištu je čist"),
računi (račun/predujam/storno/odobrenje, stavke, uplate ili stari `paidDate`, naknade, veza na ugovor i razdoblje —
brojevi ostaju, zbrojevi se preračunaju, brojač se podiže pa nova numeracija nastavlja), ugovori (cijene, plan naplate i
status po uređaju, sezona, preskočena razdoblja), ručni upisi najma, ponude, narudžbenice, primke, međuskladišnice,
servisni nalozi, ulazni računi, troškovi (ponavljanje i izmjene po mjesecu) i stari dnevnik. Korisnici se samo
popisuju (stara verzija čuva lozinke kao tekst) — dodajte ih u Postavke → Korisnici. Uvoz je jedna transakcija
(uspije sve ili ništa); 20.000 uređaja i 12.000 računa upišu se za ~6 s. Kod: `src/server/import/`
(`legacy*.ts` pretvorba, `run*.ts` upis, `backup.ts` kopija).

**Sigurnosna kopija ove aplikacije** (isti ekran): „Izvoz sigurnosne kopije" preuzima cijelu firmu kao
`{ format: 'erp-wms-backup', version: 1, … }` (bez lozinki, sesija i fiskalnog certifikata; prilozi u base64),
a „Vrati iz sigurnosne kopije" je vraća u **novu** firmu. Vratiti se može datoteka do 256 MB (`MAX_UPLOAD_BYTES`
u `src/server/import/upload.ts`); ekran upozori ako bi kopija bila veća (najčešće zbog priloga). Pri vraćanju se
prilozi provjeravaju kao pri slanju (vrsta po sadržaju, do 2 MB, samo uz uređaje), a postavke firme (valuta, logo,
brojevi) svode na dopuštene vrijednosti — odbačeno je u upozorenjima analize. Ogledna stara baza: `scripts/fixtures/legacy-sample.json`.

## Nije (još) napravljeno

- posrednik Moj-eRačun (sučelje postoji, provedba nije), provjera kupca u AMS-u, primanje ulaznih eRačuna
- portal za klijente (prijava kvara s njihove strane)
- OCR teksta s naljepnica bez barkoda (barkodovi i QR se čitaju kamerom i skenerom)
- slanje dokumenata e-poštom iz programa (ispis → „Spremi kao PDF")
