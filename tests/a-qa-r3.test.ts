/** QA prodaja, krug 3 (t1): predložak e-pošte za stornirani račun i račun podmiren predujmom. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceMailTemplate, MAIL_DEFAULTS, fillTemplate } from '../src/domain/mail';

test('C: stornirani račun — iznos računa i „storniran", ne „za platiti 0,00"', () => {
  const pick = invoiceMailTemplate({ kind: 'INVOICE', stornoed: true, total: 125, advance: 0, open: 0 });
  assert.deepEqual(pick, { template: 'invoiceStornoed', amount: 125 });
  const body = fillTemplate(MAIL_DEFAULTS.invoiceStornoed.body, { broj: '5-P1-1', datum: '10.03.2026.', iznos: '125,00 €', veza: '6-P1-1', firma: 'F' });
  assert.match(body, /storniran \(storno 6-P1-1\)/);
  assert.doesNotMatch(body, /za platiti|rok/i);
});

test('C: račun u cijelosti podmiren predujmom — iznos računa i „podmiren predujmom"', () => {
  assert.deepEqual(invoiceMailTemplate({ kind: 'INVOICE', stornoed: false, total: 125, advance: 125, open: 0 }), { template: 'invoiceCovered', amount: 125 });
  // djelomično predujmom, ostatak plaćen: kao i prije (plaćeni račun, iznos umanjen za predujam)
  assert.deepEqual(invoiceMailTemplate({ kind: 'INVOICE', stornoed: false, total: 125, advance: 25, open: 0 }), { template: 'invoicePaid', amount: 100 });
  // otvoreni dio nakon predujma: otvoreni iznos
  assert.deepEqual(invoiceMailTemplate({ kind: 'INVOICE', stornoed: false, total: 125, advance: 25, open: 100 }), { template: 'invoice', amount: 100 });
  assert.match(MAIL_DEFAULTS.invoiceCovered.body, /podmiren uplaćenim predujmom/);
  assert.doesNotMatch(MAIL_DEFAULTS.invoiceCovered.body, /Iznos za platiti/);
});
