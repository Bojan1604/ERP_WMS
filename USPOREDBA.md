# Nova verzija u odnosu na staru (wms-erp-v2.zip)

| Područje | Stara verzija | Nova verzija |
|---|---|---|
| **Pohrana podataka** | Cijela firma je jedan JSON zapis (Supabase `app_kv` / IndexedDB) | PostgreSQL s pravim tablicama, stranim ključevima, indeksima i transakcijama |
| **Više korisnika istovremeno** | Sudari verzija („ponovite zadnju izmjenu"), spremanje šalje cijelu kolekciju | Svaka izmjena je zasebna transakcija — nema gubitka tuđeg rada |
| **Brzina** | Sve se učitava u preglednik i filtrira u JavaScriptu; usporava s rastom podataka | Filtriranje, straničenje i zbrojevi u bazi; stranice 0,01–0,08 s; provjereno s 300.000 uređaja i 100.000 računa (0,05–0,3 s) |
| **Pretraga** | Po učitanim podacima u pregledniku | Trigram indeksi u bazi, globalna pretraga (serijski broj vodi ravno na uređaj) |
| **Brojevi računa** | Računa ih preglednik, brojač u postavkama, mogući duplikati | Dodjeljuje ih baza atomski; provjereno 8 istovremenih izdavanja bez duplog broja |
| **Dosljednost podataka** | „Čistač" i provjera dosljednosti naknadno | Pravila se primjenjuju pri svakoj promjeni (jedno mjesto za status uređaja) + strani ključevi |
| **Sigurnost** | Prava provjerava preglednik; lozinke u JSON-u kao običan tekst | Prava i izolacija firmi na poslužitelju, bcrypt lozinke, sesije u bazi, zaštita od pogađanja lozinke, dnevnik svih promjena |
| **Organizacija koda** | JavaScript, datoteke do 2.200 linija (`AppProvider`, `Settings`, `Reports`) | TypeScript (strict), slojevi domena · servisi · upiti · ekrani, datoteke ~400 linija |
| **Testovi** | E2E kroz jsdom (~4 min) | 74 jedinična + 27 integracijskih testova nad pravom bazom, GitHub Actions CI |
| **Fiskalizacija** | Samo eRačun XML i slanje posredniku preko Edge funkcije | Gotovina/kartica: ZKI, JIR, potpisani zahtjev CIS-u, QR kod na računu, naknadna dostava; certifikat i ključevi šifrirani; demo način za probu |
| **eRačun (Fiskalizacija 2.0)** | UBL XML, ePoslovanje | UBL 2.1 HR CIUS (račun, predujam, storno 384, odobrenje 381) s testovima; adapteri za posrednike, prijava naplate |
| **Uvoz podataka** | Uvoz vlastite JSON kopije | Uvoz JSON baze stare verzije (sve kolekcije, provjera i upozorenja prije uvoza) + izvoz i vraćanje sigurnosne kopije; 20.000 uređaja za ~6 s |
| **Skeniranje** | Kamera, uparivanje sa skladištem, zaprimanje na odobrenje, slike naljepnica, OCR | Kamera (ugrađeni čitač ili ZXing) i USB/Bluetooth skener, skupni način, brze radnje, zaprimanje skeniranjem, zaprimanje na odobrenje s fotografijama naljepnica (bez OCR-a) |
| **Inventura** | Nije postojala | Skeniranje stvarnog stanja (i više ljudi istovremeno), nedostaje / pronađeno / višak, zatvaranje s prijenosom ili otpisom, izvještaj |
| **Naljepnice** | Nisu postojale | Barkod + QR, A4 listovi i printeri naljepnica (50×25, 62×29, 100×50 mm) |
| **Mobitel** | Skladištarski prikaz; ostalo desktop | Cijela aplikacija: donja traka, kartice umjesto tablica, filtri iza gumba, prozori s dna ekrana, instalacija na početni zaslon |
| **Računi** | Račun, storno, odobrenje, predujam, uplate | Isto + nacrt prije izdavanja, izdani račun zaključan, gotovina/kartica naplaćene pri izdavanju, HUB3 barkod, otpremnica |
| **Najam** | Plan naplate po uređaju, rate za izdati | Isti motor naplate, napisan ispočetka s testovima; ispravljena greška (razdoblje iza kraja ugovora se naplaćivalo) |
| **Servis (RMA)** | Nalozi, zamjenski uređaj | Isto + zamjenski uređaj pravilno nastavlja najam (ugovor, cijena, plan) |
| **Izvještaji** | 31 izvještaj | 21 izvještaj (neki spojeni), svi računati u bazi, s CSV-om i ispisom |
| **Ispis i PDF** | Pravi PDF (pdfmake), slanje e-poštom s privitkom | Ispis A4 iz preglednika („Spremi kao PDF"); slanje e-poštom još nije |
| **Portal za klijente** | Postojao (prijava kvara) | Još nije prenesen |
| **Pokretanje** | Vite + Supabase, GitHub Pages | Node.js + PostgreSQL; `pokreni.bat`, Docker, migracije baze (nadogradnja bez gubitka podataka) |
