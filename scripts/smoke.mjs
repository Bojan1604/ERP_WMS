/**
 * Prolaz kroz aplikaciju u pregledniku: prijava i otvaranje zadanih stranica.
 * Javlja greške na stranici i u konzoli.  Upotreba:
 *   node scripts/smoke.mjs [baseUrl] [--shots dir] [putanja …]
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const base = args[0]?.startsWith('http') ? args.shift() : 'http://localhost:3000';
const shotsIdx = args.indexOf('--shots');
const shots = shotsIdx >= 0 ? args.splice(shotsIdx, 2)[1] : null;
const paths = args.length ? args : ['/'];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));

await page.goto(`${base}/login`);
await page.fill('input[name=email]', process.env.EMAIL || 'admin@demo.hr');
await page.fill('input[name=password]', 'admin123');
await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }), page.click('button[type=submit]')]);

let failed = 0;
for (const p of paths) {
  const before = errors.length;
  const res = await page.goto(`${base}${p}`, { waitUntil: 'networkidle', timeout: 60000 });
  const status = res?.status();
  const text = await page.locator('main').innerText().catch(() => '');
  const bad = status >= 400 || /Nešto je pošlo krivo|Unhandled Runtime Error|Application error/.test(text);
  if (bad || errors.length > before) failed++;
  console.log(`${bad ? 'FAIL' : errors.length > before ? 'WARN' : ' ok '} ${status} ${p}${errors.length > before ? `\n      ${errors.slice(before).join('\n      ')}` : ''}${bad ? `\n      ${text.slice(0, 300)}` : ''}`);
  if (shots) await page.screenshot({ path: `${shots}/${p.replace(/\W+/g, '_') || 'root'}.png`, fullPage: false });
}
await browser.close();
process.exit(failed ? 1 : 0);
