/**
 * Područje F — čista logika: tekstovi oslobođenja PDV-a, nastavak numeracije,
 * odobrenje promjene statusa po korisniku, postavke firme iz kopije, razdoblja
 * izvještaja, rezervni kodovi i potpis izazova prijave u dva koraka.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXEMPT_DEFAULTS, exemptText } from '../src/domain/tax';
import { checkCounterStart, isPaymentModel, sanitizeCompanySettings } from '../src/domain/company';
import { needsStatusApproval, resolvePermissions } from '../src/domain/permissions';
import { periodBounds, periodLabel } from '../src/server/queries/reports/types';

process.env.AUTH_SECRET ??= 'test-secret-test-secret-test-secret-123456';
process.env.DATABASE_URL ??= 'postgresql://localhost/nepostojeca';

test('exemptText: domaći bez teksta, strani po regiji i vrsti, vlastiti tekst ima prednost', () => {
  assert.equal(exemptText({}, 'DOMESTIC', 'SALE'), null);
  assert.equal(exemptText({}, 'EU', 'SALE'), EXEMPT_DEFAULTS.euGoods);
  assert.equal(exemptText({}, 'EU', 'RENT'), EXEMPT_DEFAULTS.euService);
  assert.equal(exemptText({}, 'NON_EU', 'goods'), EXEMPT_DEFAULTS.thirdGoods);
  assert.equal(exemptText({}, 'NON_EU', 'SERVICE'), EXEMPT_DEFAULTS.thirdService);
  assert.equal(exemptText({ vatTextEuService: '  Prijenos porezne obveze  ' }, 'EU', 'service'), 'Prijenos porezne obveze');
  // prazan vlastiti tekst = zadani
  assert.equal(exemptText({ vatTextThirdGoods: '   ' }, 'NON_EU', 'SALE'), EXEMPT_DEFAULTS.thirdGoods);
});

test('checkCounterStart: samo naprijed, nikad ispod izdanih', () => {
  assert.equal(checkCounterStart(120, 0, 0), null);
  assert.equal(checkCounterStart(121, 120, 0), null);
  assert.match(checkCounterStart(100, 120, 0)!, /ne može biti manji od 121/);
  assert.match(checkCounterStart(50, 10, 60)!, /61/);
  assert.equal(checkCounterStart(61, 10, 60), null);
  assert.match(checkCounterStart(0, 0, 0)!, /veći od 0/);
  assert.match(checkCounterStart(1.5, 0, 0)!, /cijeli broj/);
});

test('needsStatusApproval: korisnik nadjačava firmu, administrator nikad', () => {
  const ops = resolvePermissions('WAREHOUSE', {});
  const mgr = resolvePermissions('MANAGER', {});
  assert.equal(needsStatusApproval({ role: 'WAREHOUSE', perms: ops, requireApproval: null }, true), true);
  assert.equal(needsStatusApproval({ role: 'WAREHOUSE', perms: ops, requireApproval: null }, false), false);
  assert.equal(needsStatusApproval({ role: 'WAREHOUSE', perms: ops, requireApproval: false }, true), false);
  assert.equal(needsStatusApproval({ role: 'MANAGER', perms: mgr, requireApproval: null }, true), false);
  assert.equal(needsStatusApproval({ role: 'MANAGER', perms: mgr, requireApproval: true }, false), true);
  assert.equal(needsStatusApproval({ role: 'ADMIN', perms: resolvePermissions('ADMIN', {}), requireApproval: true }, true), false);
});

test('sanitizeCompanySettings: nova polja F9 prolaze, automatsko izdavanje se ne preuzima', () => {
  const { company } = sanitizeCompanySettings({
    swift: 'PBZGHR2X', proformaTitle: 'Proforma', vatTextEuGoods: 'EU tekst', paymentModel: 'HR01', eInvoicePaymentMeans: '58',
    vatOnPayment: true, eInvoiceAttachPdf: false, autoIssueRent: true, isDemo: true, backupKeep: 999, kpdRent: '77.39.19',
  });
  assert.equal(company.swift, 'PBZGHR2X');
  assert.equal(company.proformaTitle, 'Proforma');
  assert.equal(company.paymentModel, 'HR01');
  assert.equal(company.eInvoicePaymentMeans, '58');
  assert.equal(company.vatOnPayment, true);
  assert.equal(company.eInvoiceAttachPdf, false);
  assert.equal(company.backupKeep, 365);
  assert.equal(company.kpdRent, '77.39.19');
  assert.ok(!('autoIssueRent' in company));
  assert.ok(!('isDemo' in company));
  assert.equal(sanitizeCompanySettings({ paymentModel: 'XX99', eInvoicePaymentMeans: '42' }).company.paymentModel, undefined);
  assert.ok(isPaymentModel('HR00') && !isPaymentModel('HR1'));
});

test('izvještaji: razdoblje je presjek godine i raspona', () => {
  assert.deepEqual(periodBounds({ year: 2026, from: null, to: null }), { from: '2026-01-01', to: '2026-12-31' });
  assert.deepEqual(periodBounds({ year: 2026, from: '2026-03-01', to: '2027-02-01' }), { from: '2026-03-01', to: '2026-12-31' });
  assert.deepEqual(periodBounds({ year: null, from: '2025-05-01', to: null }), { from: '2025-05-01', to: null });
  assert.deepEqual(periodBounds({ year: null, from: null, to: null }), { from: null, to: null });
  assert.equal(periodLabel({ year: null, from: null, to: null }), 'sve godine');
  assert.equal(periodLabel({ year: 2026, from: null, to: null }), '2026.');
  assert.equal(periodLabel({ year: null, from: '2026-03-01', to: '2026-05-31' }), '1. 3. 2026. – 31. 5. 2026.');
});

test('2FA: rezervni kodovi, TOTP i potpisan izazov', async () => {
  const tf = await import('../src/server/services/two-factor');
  const { plain, hashes } = tf.generateBackupCodes();
  assert.equal(plain.length, 10);
  assert.equal(new Set(plain).size, 10);
  assert.ok(plain.every((c) => /^[0-9a-f]{5}-[0-9a-f]{5}$/.test(c)));
  assert.ok(hashes.every((h) => /^[0-9a-f]{64}$/.test(h) && !plain.includes(h)));
  assert.equal(tf.normalizeBackupCode(' AB12C-3D4E5 '), 'ab12c3d4e5');

  const { generateSecret, generate } = await import('otplib');
  const secret = generateSecret();
  const code = await generate({ secret });
  assert.equal(await tf.verifyTotpCode(secret, code), true);
  assert.equal(await tf.verifyTotpCode(secret, '000000') && code !== '000000', false);
  assert.equal(await tf.verifyTotpCode(secret, 'abc'), false);
  // kod od prije 5 minuta više ne vrijedi
  const old = await generate({ secret, epoch: Math.floor(Date.now() / 1000) - 300 });
  assert.equal(await tf.verifyTotpCode(secret, old), old === code);
  // zaštita od ponovne uporabe: kod koraka ≤ zadnjeg iskorištenog se odbija
  const step = await tf.verifyTotpStep(secret, code);
  assert.ok(step && step === Math.floor(Date.now() / 30_000) || step === Math.floor(Date.now() / 30_000) - 1);
  assert.equal(await tf.verifyTotpStep(secret, code, { after: step }), null);
  assert.equal(await tf.verifyTotpStep(secret, code, { after: step! - 1 }), step);

  const token = tf.signChallenge('user-1');
  assert.equal(tf.readChallenge(token), 'user-1');
  assert.equal(tf.readChallenge(`${token}x`), null);
  assert.equal(tf.readChallenge(token.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))), null);
  assert.equal(tf.readChallenge(token, Date.now() + tf.CHALLENGE_TTL_MS + 1000), null);
  assert.equal(tf.readChallenge(undefined), null);
});
