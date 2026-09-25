/**
 * Zakrpa Reacta koji dolazi uz Next 15.5 (next/dist/compiled/react-dom, 19.2 canary).
 *
 * Greška: kad se tijekom hidracije (Next hidrira dok RSC podaci još stižu) djeca HTML elementa
 * suspendiraju na lijenom dijelu RSC toka (Flight dijeli retke > 3200 B u `$L` dijelove, npr. usred
 * <table>) i taj dio stigne prije sljedećeg odsječka, React ponovno pokreće (replay) taj element, ali ne
 * vraća kursor hidracije — element se uspoređuje s vlastitim prvim djetetom i javlja
 * „Hydration failed … server rendered HTML didn't match" (#418, args HTML), a stranica se iscrta iznova.
 * Rijetko, ovisno o brzini toka (češće pod opterećenjem), na svim stranicama s velikim tablicama.
 *
 * Ispravak je preuzet iz Reacta 19.3 (replayBeginWork, `case 5`): prije ponovnog pokretanja vrati kursor
 * na sam element. https://github.com/react/react/issues/37584
 * Pokreće se kao `postinstall`; ponovno pokretanje ne mijenja ništa. Kad Next donese React s ispravkom,
 * uzorak se više ne nalazi i skripta samo javi da zakrpa nije potrebna.
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.cwd(), 'node_modules/next/dist/compiled/react-dom/cjs');
const MARK = '/* erp-wms: replay hydration cursor */';
const fix = (v) =>
  `${MARK} ${v} === hydrationParentFiber && (isHydrating ? (popToNextHostParent(${v}), null != ${v}.stateNode && (nextHydratableInstance = ${v}.stateNode)) : (popToNextHostParent(${v}), (isHydrating = !0)));`;

// case 5 (HostComponent) u replaySuspendedUnitOfWork / replayBeginWork
const targets = [
  { file: 'react-dom-client.production.js', re: /(case 5:\n(\s*)resetHooksOnUnwind\((next)\);)(\n\s*default:\n\s*unwindInterruptedWork\(current, next\))/ },
  { file: 'react-dom-client.development.js', re: /(case 5:\n(\s*)resetHooksOnUnwind\((unitOfWork)\);)(\n\s*default:\n\s*unwindInterruptedWork\(current, unitOfWork\))/ },
];

for (const { file, re } of targets) {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) continue;
  const src = fs.readFileSync(full, 'utf8');
  if (src.includes(MARK)) continue;
  if (/fiber === hydrationParentFiber &&\s*\(isHydrating/.test(src)) {
    console.log(`patch-react-hydration: ${file} već ima ispravak, zakrpa nije potrebna`);
    continue;
  }
  const m = src.match(re);
  if (!m) {
    console.warn(`patch-react-hydration: uzorak nije pronađen u ${file} — provjerite verziju Nexta/Reacta`);
    continue;
  }
  fs.writeFileSync(full, src.replace(re, (_, head, indent, v, tail) => `${head}\n${indent}${fix(v)}${tail}`));
  console.log(`patch-react-hydration: zakrpan ${file}`);
}
