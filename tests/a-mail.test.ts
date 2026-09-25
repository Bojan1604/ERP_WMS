/** Predlošci e-pošte i mailto (područje A). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillTemplate, mailtoHref, MAIL_DEFAULTS, MAIL_TEMPLATE_KINDS, readTemplates, splitAddresses } from '../src/domain/mail';

test('predlošci: zamjena varijabli, sinonim {rok}, nepoznato prazno', () => {
  assert.equal(fillTemplate('Račun {broj} za {kupac}, rok {rok}, {x}.', { broj: '1/PP1/1', kupac: 'Čćžšđ d.o.o.', dospijece: '25.03.2026.' }), 'Račun 1/PP1/1 za Čćžšđ d.o.o., rok 25.03.2026., .');
  assert.equal(fillTemplate('{iznos}', { iznos: 12.5 }), '12.5');
});

test('predlošci: spremljeni + zadani, prazno i neispravno = zadano', () => {
  const t = readTemplates({ invoice: { subject: 'Moj {broj}', body: '  ' }, quote: 'x', nepoznato: { subject: 'a' } });
  assert.equal(t.invoice.subject, 'Moj {broj}');
  assert.equal(t.invoice.body, MAIL_DEFAULTS.invoice.body);
  assert.deepEqual(t.quote, MAIL_DEFAULTS.quote);
  assert.deepEqual(Object.keys(t).sort(), [...MAIL_TEMPLATE_KINDS].sort());
  assert.deepEqual(readTemplates(null), MAIL_DEFAULTS);
});

test('mailto: više primatelja, CC, CRLF u tijelu', () => {
  assert.deepEqual(splitAddresses(' a@b.hr; c@d.hr ,, '), ['a@b.hr', 'c@d.hr']);
  const h = mailtoHref({ to: 'a@b.hr, c@d.hr', cc: 'e@f.hr', subject: 'Račun 1/PP1/1', body: 'Red 1\nRed 2' });
  assert.equal(h, 'mailto:a@b.hr,c@d.hr?cc=e%40f.hr&subject=Ra%C4%8Dun%201%2FPP1%2F1&body=Red%201%0D%0ARed%202');
});
