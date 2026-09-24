import { Card } from '@/components/ui/misc';
import { CHECKIN_SEC } from '@/domain/mdm';

/**
 * „Mreža": što agenti trebaju od mreže, preporuke za Wi-Fi instalaciju i
 * rješavanje problema. Statičan sadržaj (bez podataka iz baze).
 */

const WIFI: [string, string][] = [
  ['Bežični standard', 'Wireless AC (Wi-Fi 5) ili AX (Wi-Fi 6)'],
  ['Frekvencijski pojas', '5 GHz kao primarni'],
  ['Širina kanala', '20 MHz i u 2,4 GHz i u 5 GHz pojasu'],
  ['Mreža za goste', 'Gosti na 2,4 GHz ili na zasebnom Wi-Fi sustavu'],
  ['Mesh', 'Ne koristiti bežično povezivanje pristupnih točaka (mesh)'],
  ['Kontroler', 'Centralno (cloud) upravljan Wi-Fi sustav'],
  ['Kanali', 'Upravljani odabir kanala radi što manje smetnji'],
  ['Multimedija', 'Uključen WMM'],
  ['Više korisnika', 'Uključen MU-MIMO'],
  ['Planiranje', 'Izraditi toplinsku kartu (heat map) pokrivenosti prije i nakon postavljanja'],
];

const TROUBLE: { title: string; steps: string[] }[] = [
  {
    title: 'Uređaj je „offline"',
    steps: [
      'Provjerite je li uređaj uključen i spojen na Wi-Fi / mrežu (ikona mreže, jačina signala).',
      'Provjerite datum i vrijeme na uređaju — pogrešno vrijeme ruši HTTPS vezu (certifikat „nije valjan").',
      'U agentu provjerite adresu poslužitelja (mora biti ista kao gore, s https://).',
      'Otvorite adresu poslužitelja u pregledniku na uređaju — ako se ne otvara, blokira je vatrozid ili proxy.',
      'Android: agent mora imati iznimku od štednje baterije; Windows: servis MDM agenta mora biti pokrenut (services.msc).',
    ],
  },
  {
    title: 'Konfiguracija se ne primjenjuje',
    steps: [
      'Na kartici Konfiguracija uređaja usporedite „primijenjenu" i „trenutnu" verziju.',
      'Pogledajte kartice Događaji i Naredbe — agent javlja greške pri primjeni (npr. Wi-Fi lozinka, nedostaje aplikacija).',
      'Android: zaključani način i zabrane traže da je agent vlasnik uređaja (Device Owner) — upis QR kodom nakon tvorničkih postavki.',
    ],
  },
  {
    title: 'Aplikacija se ne instalira',
    steps: [
      'Provjerite ima li uređaj dovoljno slobodnog prostora (Pregled).',
      'Android: novija verzija mora biti potpisana istim ključem; niža verzija (versionCode) se ne može instalirati preko više bez uklanjanja.',
      'Windows: provjerite argumente tihe instalacije (MSI /qn, NSIS /S) — instalacija koja čeka korisnika ne završava.',
    ],
  },
];

export function NetworkInfo({ serverUrl }: { serverUrl: string }) {
  const url = new URL(serverUrl);
  const host = url.hostname;
  const port = url.port || (url.protocol === 'http:' ? '80' : '443');
  return (
    <div className="space-y-4">
      <Card title="Potrebne mrežne veze">
        <p className="mb-3 text-base text-fg-2">
          Agenti (Android i Windows) se sami javljaju poslužitelju svakih {CHECKIN_SEC} s. Veza uvijek ide <b>od uređaja prema poslužitelju</b> — na uređajima i u lokalnoj mreži ne treba
          otvarati nijedan dolazni port ni prosljeđivanje portova.
        </p>
        <div className="overflow-x-auto scroll-slim rounded-lg border border-line">
          <table className="data-table">
            <thead>
              <tr>
                <th>Smjer</th>
                <th>Odredište</th>
                <th>Protokol / port</th>
                <th>Namjena</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>odlazno</td>
                <td className="font-mono text-sm">{host}</td>
                <td>{url.protocol === 'http:' ? 'HTTP' : 'HTTPS'}, TCP {port}</td>
                <td>javljanje, naredbe, konfiguracija, preuzimanje aplikacija i datoteka, slanje snimki zaslona i zapisnika</td>
              </tr>
              <tr>
                <td>odlazno</td>
                <td>DNS poslužitelj mreže</td>
                <td>UDP/TCP 53</td>
                <td>razrješavanje naziva poslužitelja</td>
              </tr>
              <tr>
                <td>odlazno</td>
                <td>NTP (npr. pool.ntp.org, time.windows.com)</td>
                <td>UDP 123</td>
                <td>točno vrijeme — bez njega HTTPS ne radi</td>
              </tr>
              <tr>
                <td>dolazno</td>
                <td colSpan={3} className="text-fg-3">
                  ne treba
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-sm text-fg-3">
          Adresa poslužitelja za agente: <span className="font-mono">{serverUrl}</span>. Ako mreža koristi proxy s pregledom HTTPS-a, izuzmite ovu adresu (agent provjerava certifikat).
        </p>
      </Card>

      <Card title="Preporuke za Wi-Fi instalaciju" padded={false}>
        <div className="overflow-x-auto scroll-slim">
          <table className="data-table">
            <thead>
              <tr>
                <th className="w-56">Tema</th>
                <th>Preporuka</th>
              </tr>
            </thead>
            <tbody>
              {WIFI.map(([t, r]) => (
                <tr key={t}>
                  <td className="font-medium">{t}</td>
                  <td>{r}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Rješavanje problema">
        <div className="grid gap-4 md:grid-cols-3">
          {TROUBLE.map((t) => (
            <div key={t.title}>
              <h3 className="mb-1 font-semibold">{t.title}</h3>
              <ol className="list-decimal space-y-1 pl-5 text-sm text-fg-2">
                {t.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
