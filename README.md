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
- Međuskladišnice s ispisom, odobrenja promjena statusa

**Prodaja**
- Računi: nacrt → izdavanje (broj `12/ZG1/1` po pravilima Porezne uprave, redni broj prati datum), uređaji sa skladišta s prijedlogom cijene (dogovoreni cjenik → cijena modela → marža), usluge, ručne stavke, popusti po stavci i na račun, neoporezive naknade, PDV prema državi kupca (HR / EU / izvoz)
- Izdan račun se ne mijenja: **storno** (vraća robu na skladište) i **knjižno odobrenje**; djelomične uplate, „plaćeno u cijelosti", povrat u neplaćeno
- Popis s bojama naplate (kasni / nije dospjelo / plaćeno), zadani poredak „kasni prvo", brojač dana koji staje plaćanjem, zbrojevi, CSV
- Ispis A4 s HUB3 2D barkodom za plaćanje, otpremnica sa serijskim brojevima i jamstvom, **eRačun XML** (UBL 2.1, HR CIUS 2025: 380/381/384/386)
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

## Nije (još) napravljeno

- izravno slanje eRačuna posredniku i fiskalizacija (XML se generira; potreban je ugovor s posrednikom i API ključ)
- portal za klijente (prijava kvara s njihove strane)
- čitanje naljepnica kamerom i OCR (pretraga radi s ručnim ili USB/Bluetooth skenerom barkoda)
- slanje dokumenata e-poštom iz programa (ispis → „Spremi kao PDF")
