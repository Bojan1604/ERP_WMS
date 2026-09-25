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
| **Testovi** | E2E kroz jsdom (~4 min) | 259 jediničnih + 253 integracijska testa nad pravom bazom + test demo podataka na praznoj bazi, GitHub Actions CI; tri kruga ručnog E2E testiranja u pregledniku |
| **Fiskalizacija** | Samo eRačun XML i slanje posredniku preko Edge funkcije | Gotovina/kartica: ZKI, JIR, potpisani zahtjev CIS-u, QR kod na računu, naknadna dostava; certifikat i ključevi šifrirani; demo način za probu |
| **eRačun (Fiskalizacija 2.0)** | UBL XML, ePoslovanje | UBL 2.1 HR CIUS (račun, predujam, storno 384, odobrenje 381) s testovima; adapteri za posrednike, prijava naplate |
| **Uvoz podataka** | Uvoz vlastite JSON kopije | Uvoz JSON baze stare verzije (sve kolekcije, provjera i upozorenja prije uvoza) + izvoz i vraćanje sigurnosne kopije; 20.000 uređaja za ~6 s |
| **Skeniranje** | Kamera, uparivanje sa skladištem, zaprimanje na odobrenje, slike naljepnica, OCR | Kamera (ugrađeni čitač ili ZXing) i USB/Bluetooth skener, skupni način, brze radnje, zaprimanje skeniranjem, zaprimanje na odobrenje s fotografijama naljepnica i odobravanjem po retku, čitanje barkoda iz slike, OCR serijskog broja |
| **Inventura** | Nije postojala | Skeniranje stvarnog stanja (i više ljudi istovremeno), nedostaje / pronađeno / višak, zatvaranje s prijenosom ili otpisom, izvještaj |
| **Naljepnice** | Nisu postojale | Barkod + QR, A4 listovi i printeri naljepnica (50×25, 62×29, 100×50 mm) |
| **Mobitel** | Skladištarski prikaz; ostalo desktop | Cijela aplikacija: donja traka, kartice umjesto tablica, filtri iza gumba, prozori s dna ekrana, instalacija na početni zaslon |
| **Računi** | Račun, predračun, storno, odobrenje, predujam, uplate | Isto + nacrt prije izdavanja, izdani račun zaključan, predujmovi vezani uz konačni račun, najam i prodaja na istom računu, KPD tražilica i provjera, gotovina/kartica naplaćene pri izdavanju, HUB3 barkod, otpremnica, radnje eRačuna (provjera, status, IR, eIzvještavanje) |
| **Najam** | Plan naplate po uređaju, rate za izdati | Isti motor naplate, napisan ispočetka s testovima; ispravljena greška (razdoblje iza kraja ugovora se naplaćivalo) |
| **Servis (RMA)** | Nalozi, zamjenski uređaj | Isto + zamjenski uređaj pravilno nastavlja najam (ugovor, cijena, plan) |
| **Izvještaji** | 31 izvještaj | 28 izvještaja (neki spojeni) s filtrima više vrijednosti i rasponom datuma, računati u bazi, izvoz Excel/CSV/PDF i ispis |
| **Ispis i PDF** | Pravi PDF (pdfmake), slanje e-poštom s privitkom | Pravi PDF (pdfmake) svih dokumenata i popisa, pregled u aplikaciji, slanje e-poštom (SMTP) s predlošcima po vrsti dokumenta i dnevnikom slanja, PDF ugrađen u eRačun |
| **Portal za klijente** | Postojao (prijava kvara) | Zasebna prijava klijenta, uređaji s jamstvom, prijava kvara s fotografijama, praćenje naloga i otpremnica; strogo odvojeni podaci po klijentu |
| **Sigurnost i korisnici** | Prava u pregledniku, 2FA, promjena vlastite lozinke | Prava na poslužitelju uključujući „nabavne cijene i marže" i „dnevnik", prijava u dva koraka (TOTP + rezervni kodovi), Moj račun, zaštita od preuzimanja računa s većim pravima, ograničenje pokušaja prijave u bazi |
| **Više firmi, kopije, održavanje** | Više firmi, sigurnosne kopije, opasna zona, provjera dosljednosti | Isto: više firmi s prebacivanjem, automatske kopije s vraćanjem, opasna zona (obriši promet / sve), provjera dosljednosti s popravkom, čišćenje dnevnika |
| **Upravljanje uređajima (MDM)** | Nije postojalo | Web konzola za Windows i Android uređaje: vi vidite sve, distributer svoje klijente, klijent samo svoje; upis kodom ili QR-om, konfiguracije, aplikacije (APK/MSI/EXE), datoteke, naredbe, zaslon, zapisnici; Android i Windows agent |
| **Pokretanje** | Vite + Supabase, GitHub Pages | Node.js + PostgreSQL; `pokreni.bat`, Docker, migracije baze (nadogradnja bez gubitka podataka) |
