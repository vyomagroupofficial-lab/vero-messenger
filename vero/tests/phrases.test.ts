import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHRASE_TABLES } from '../src/shared/i18n/phraseTables';

test('every phrase table lines up with English, placeholders preserved', () => {
  const { EN, ...rest } = PHRASE_TABLES;
  for (const [lang, rows] of Object.entries(rest)) {
    assert.equal(rows.length, EN.length, `${lang} has ${rows.length} rows, English has ${EN.length}`);
    EN.forEach((en, i) => {
      const want = (en.match(/\{\{\w+\}\}/g) ?? []).sort().join();
      const got = (rows[i].match(/\{\{\w+\}\}/g) ?? []).sort().join();
      assert.equal(got, want, `${lang}[${i}] placeholders for "${en}"`);
    });
  }
});
