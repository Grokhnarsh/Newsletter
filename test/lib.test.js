import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseCsv, csvToObjects, toCsv } from '../src/lib/csv.js';
import { extractLinks, htmlToText, mergeTags, renderEmail, rewriteLinks } from '../src/lib/render.js';
import { hashPassword, verifyPassword } from '../src/lib/security.js';
import { isEmail, validate } from '../src/lib/validate.js';

describe('mergeTags', () => {
  test('ersetzt und escaped Platzhalter', () => {
    assert.equal(mergeTags('Hallo {{first_name}}!', { first_name: '<b>Anna</b>' }), 'Hallo &lt;b&gt;Anna&lt;/b&gt;!');
  });

  test('nutzt Standardwerte bei leeren Feldern', () => {
    assert.equal(mergeTags('Hallo {{first_name | "Leser"}}', { first_name: '' }), 'Hallo Leser');
    assert.equal(mergeTags("Hallo {{ first_name|'Freund' }}", {}), 'Hallo Freund');
    assert.equal(mergeTags('Hallo {{first_name|Gast}}', {}), 'Hallo Gast');
  });

  test('unterstützt verschachtelte Attribute und Rohausgabe', () => {
    assert.equal(mergeTags('{{attributes.firma}}', { attributes: { firma: 'A & B' } }), 'A &amp; B');
    assert.equal(mergeTags('{{{html}}}', { html: '<i>x</i>' }), '<i>x</i>');
  });

  test('lässt {{{content}}} unangetastet', () => {
    assert.equal(mergeTags('{{{content}}}', {}), '{{{content}}}');
  });
});

describe('Links', () => {
  const html = '<a href="https://a.de/x?y=1&amp;z=2">A</a> <a href="mailto:x@y.de">M</a> <a href="{{unsubscribe_url}}">U</a> <a class="b" href=\'http://b.de\'>B</a>';

  test('extractLinks findet nur trackbare http(s)-Links', () => {
    assert.deepEqual(extractLinks(html), ['https://a.de/x?y=1&z=2', 'http://b.de']);
  });

  test('rewriteLinks ersetzt nur bekannte Links', () => {
    const out = rewriteLinks(html, (url) => (url.startsWith('https://a.de') ? 'https://t/1' : null));
    assert.match(out, /href="https:\/\/t\/1"/);
    assert.match(out, /href='http:\/\/b.de'/);
    assert.match(out, /mailto:x@y.de/);
  });
});

describe('renderEmail', () => {
  test('ergänzt fehlenden Abmeldelink, Preheader und Pixel', () => {
    const r = renderEmail({
      campaign: { subject: 'Hi {{first_name}}', preheader: 'Vorschau', content_html: '<p>Text</p>', content_text: '' },
      layout: '<html><body>{{{content}}}</body></html>',
      vars: { first_name: 'Max', unsubscribe_url: 'https://x/u' },
      openPixelUrl: 'https://x/o.gif',
    });
    assert.equal(r.subject, 'Hi Max');
    assert.match(r.html, /href="https:\/\/x\/u"/);
    assert.match(r.html, /Vorschau/);
    assert.match(r.html, /src="https:\/\/x\/o.gif"/);
    assert.match(r.text, /Text/);
    assert.doesNotMatch(r.text, /Vorschau/);
  });
});

test('htmlToText', () => {
  const text = htmlToText('<h1>Titel</h1><p>Hallo <a href="https://x.de">Link</a></p><ul><li>Eins</li></ul>');
  assert.equal(text, 'Titel\n\nHallo Link (https://x.de)\n\n• Eins');
});

describe('CSV', () => {
  test('parst Anführungszeichen, Semikolons und Zeilenumbrüche', () => {
    assert.deepEqual(parseCsv('a;b\n"x;1";"y ""z"""\r\n'), [
      ['a', 'b'],
      ['x;1', 'y "z"'],
    ]);
    assert.deepEqual(csvToObjects('Email,Vorname\nA@b.de,Anna'), [{ email: 'A@b.de', vorname: 'Anna' }]);
  });

  test('toCsv schützt vor Formel-Injection', () => {
    assert.equal(toCsv(['a'], [['=SUM(1)'], ['x,y']]), "a\r\n'=SUM(1)\r\n\"x,y\"\r\n");
  });
});

test('Passwort-Hashing', () => {
  const hash = hashPassword('geheim1234');
  assert.ok(verifyPassword('geheim1234', hash));
  assert.ok(!verifyPassword('falsch', hash));
});

describe('validate', () => {
  test('prüft E-Mails', () => {
    assert.ok(isEmail('a.b+c@example.co'));
    assert.ok(!isEmail('kein@mail'));
    assert.ok(!isEmail('a b@example.com'));
  });

  test('liefert Fehlerdetails', () => {
    assert.throws(
      () => validate({ email: 'x' }, { email: { type: 'email', required: true }, name: { type: 'string', required: true } }),
      (err) => err.status === 400 && Boolean(err.details.email && err.details.name),
    );
  });

  test('partial ignoriert fehlende Felder', () => {
    assert.deepEqual(validate({ name: 'x' }, { name: { type: 'string' }, n: { type: 'int' } }, { partial: true }), { name: 'x' });
  });
});
