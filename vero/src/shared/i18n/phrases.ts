// Phrase-keyed translations for screens written before i18n keys existed
// (privacy, linked devices, backup/restore, app lock). The English text is the
// key; tx() returns the translation for the current language, or the English.
// Rows line up across languages: EN[i] -> HI[i], BN[i], ...
import i18n from './index';
import { EN, TABLES } from './phraseTables';

const MAPS = new Map<string, Map<string, string>>();
for (const [lang, rows] of Object.entries(TABLES)) {
  MAPS.set(lang, new Map(EN.map((en, i) => [en, rows[i] ?? en])));
}

/** Translates an English phrase; `{{name}}` placeholders are filled from vars. */
export function tx(english: string, vars?: Record<string, string | number>): string {
  const lang = (i18n.language || 'en').split('-')[0];
  const text = MAPS.get(lang)?.get(english) ?? english;
  return vars ? text.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? '')) : text;
}

