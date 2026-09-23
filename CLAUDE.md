# ERP/WMS — pravila koda

Web aplikacija za tvrtku koja prodaje, iznajmljuje i servisira opremu praćenu po
serijskim brojevima. Next.js 15 (App Router, server komponente i server akcije),
TypeScript (strict), Prisma 6 + PostgreSQL, Tailwind 4. Sučelje i poruke su na
hrvatskom.

## Slojevi

```
src/domain/        čista poslovna logika — bez baze, Reacta i `server-only`; 100 % testabilno
                   (invoice, billing, plan, pricing, tax, expenses, dates, money, hub3, ubl, warehouse, permissions)
src/server/        samo na poslužitelju
  db.ts            Prisma klijent, `transaction(fn)`
  auth.ts          sesija, `pageAccess(modul, razina)` za stranice, `requireAccess` za API
  action.ts        `action({ module, level }, zodShema, handler)` — omotač server akcija
  zod.ts           sheme za polja obrazaca (zMoney, zDate, zOptId, zBool, zIds…)
  numbering.ts     `nextSeq`, `nextDocNumber` — atomski brojevi dokumenata
  audit.ts         `audit(tx, user, {...})` — dnevnik promjena, u istoj transakciji
  plain.ts         `plain(zapis)` — Decimal→number, Date→ISO, za klijentske komponente
  services/        poslovne operacije nad bazom (uvijek primaju `tx` i `actor`)
  queries/         čitanja za stranice (lookups.ts: šifrarnici, partneri, firma)
src/app/(app)/<modul>/   stranice modula; `actions.ts` ('use server') uz stranice
src/components/ui/       zajednički UI (button, field, misc, filters, pagination, selection, dialog, action, combobox, tabs, toast)
src/components/doc/      A4 dokument za ispis (DocumentShell, DocTable, DocTotals)
src/components/<modul>/  klijentske komponente pojedinog modula
```

## Pravila

1. **Formula ide u `src/domain/`**, nikad u ekran ni u servis. Iznosi računa → `documentTotals`,
   najam → `billing.ts`, marže → `pricing.ts`, porez → `tax.ts`, datumi → `dates.ts` (nizovi `YYYY-MM-DD`).
2. **Svaka promjena statusa uređaja ide kroz `changeItemStatus`** (`server/services/items.ts`). On čuva
   pravila: uređaj na skladištu je „čist", uređaj izvan najma/povrata skida se s ugovora, status vrste
   SERVICE otvara servisni nalog, svaka promjena piše povijest uređaja (ItemEvent). Nikad ne mijenjajte
   `statusId`/`state` izravno.
3. **Svaki upit je sužen na firmu** (`companyId: user.companyId`). Id iz URL-a ili obrasca nikad se ne
   koristi bez te provjere.
4. **Popisi se filtriraju i straniče u bazi.** Filtri žive u URL-u (`SearchFilter`, `SelectFilter`…),
   stranica čita `searchParams`, gradi Prisma `where`, koristi `readPage()` + `<Pagination>`. Nikad
   ne učitavajte sve zapise da biste filtrirali u JS-u. Zbrojevi → `aggregate`/`groupBy`/`$queryRaw`.
5. **Mutacije su server akcije** u `actions.ts` pokraj stranice:
   ```ts
   'use server';
   export const saveX = action({ module: 'sales', level: 'edit' }, schema, async (input, user) =>
     transaction(async (tx) => { …; await audit(tx, user, {...}); return { message: 'Spremljeno.', redirect: '/…' }; }));
   ```
   Handler vraća podatke ili `{ message, redirect, data }`. Greška za korisnika: `throw new DomainError('…')`
   ili `assert(uvjet, '…')`. Klijent zove akciju kroz `useAction`, `<ActionForm>` ili `<ActionButton>`.
6. **Izdani račun se ne mijenja** — ispravak je storno ili odobrenje. Brojeve dokumenata dodjeljuje
   `nextSeq`/`nextDocNumber` unutar transakcije.
7. **Stranice su server komponente**; klijentske samo gdje treba interakcija. U klijent se šalju obični
   objekti (`plain()`), nikad Prisma Decimal ili Date.
8. **Prava**: stranica počinje s `const user = await pageAccess('modul', 'view')`; akcija navodi modul i
   razinu. Moduli i razine: `src/domain/permissions.ts`.
9. **Datoteka preko ~400 linija se dijeli.**
10. **Poveznice u tablicama imaju `prefetch={false}`** — inače svaki redak pokreće renderiranje na poslužitelju.
11. **Svaki strani ključ ima indeks** (`@@index([stupac])`); tekstualna pretraga ide na stupce s trigram (GIN) indeksom,
     a pretraga po povezanoj tablici se razrješava unaprijed u id-eve (vidi `resolveSearch` u queries/warehouse.ts).
12. Nazivi ruta i sučelja na hrvatskom, kod (identifikatori) na engleskom, komentari na hrvatskom.

## Naredbe

```bash
npm run dev            # razvoj (http://localhost:3000)
npm run typecheck      # tsc --noEmit
npm test               # testovi domene i servisa (node:test)
npm run db:push        # shema → baza (razvoj)
npm run db:deploy      # migracije → baza (produkcija)
npm run test:db        # integracijski testovi servisa (baza wms_test)
npm run db:seed        # demo firma (admin@demo.hr / admin123)
node scripts/smoke.mjs http://localhost:3000 / /skladiste …   # prolaz kroz stranice u pregledniku
```
