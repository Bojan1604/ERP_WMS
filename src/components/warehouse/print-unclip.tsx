/**
 * Ljuska aplikacije je visoka koliko zaslon i klizi unutar <main>, pa bi ispis
 * dao samo prvu stranicu. Za višestranične ispise (naljepnice, izvještaj
 * inventure) roditelji <main> se pri ispisu „odmotaju".
 */
export function PrintUnclip() {
  return (
    <style>{`@media print {
  body div:has(main), main { display: block !important; height: auto !important; min-height: 0 !important; overflow: visible !important; }
  main { padding: 0 !important; }
}`}</style>
  );
}
