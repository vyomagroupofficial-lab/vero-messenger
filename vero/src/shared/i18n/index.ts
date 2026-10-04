/**
 * Vero i18n: i18next + react-i18next, bundled locale files, system language by default.
 * Indic scripts load their Noto fonts on demand (see loadScriptFonts).
 */

import i18n from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import { getLocales } from 'expo-localization';
import * as Font from 'expo-font';
import dayjs from 'dayjs';
import 'dayjs/locale/hi';
import 'dayjs/locale/bn';
import 'dayjs/locale/ta';
import 'dayjs/locale/te';
import 'dayjs/locale/mr';
import { shouldPolyfill } from '@formatjs/intl-pluralrules/should-polyfill.js';
import type { LanguagePreference } from '../theme/appearance';
import type { Script } from '../theme/theme';

import en from './locales/en.json';
import hi from './locales/hi.json';
import bn from './locales/bn.json';
import ta from './locales/ta.json';
import te from './locales/te.json';
import mr from './locales/mr.json';

export type LanguageCode = Exclude<LanguagePreference, 'system'>;

export const LANGUAGES: { code: LanguageCode; native: string; english: string; script: Script }[] = [
  { code: 'en', native: 'English', english: 'English', script: 'latin' },
  { code: 'hi', native: 'हिन्दी', english: 'Hindi', script: 'deva' },
  { code: 'bn', native: 'বাংলা', english: 'Bengali', script: 'beng' },
  { code: 'ta', native: 'தமிழ்', english: 'Tamil', script: 'taml' },
  { code: 'te', native: 'తెలుగు', english: 'Telugu', script: 'telu' },
  { code: 'mr', native: 'मराठी', english: 'Marathi', script: 'deva' },
];

const SUPPORTED = new Set<string>(LANGUAGES.map((l) => l.code));

export function scriptFor(code: LanguageCode): Script {
  return LANGUAGES.find((l) => l.code === code)?.script ?? 'latin';
}

export function systemLanguage(): LanguageCode {
  try {
    for (const l of getLocales()) {
      if (l.languageCode && SUPPORTED.has(l.languageCode)) return l.languageCode as LanguageCode;
    }
  } catch {}
  return 'en';
}

export function resolveLanguage(pref: LanguagePreference): LanguageCode {
  return pref === 'system' ? systemLanguage() : pref;
}

// Hermes and some browsers lack Intl.PluralRules data; i18next needs it for _one/_other keys.
function ensurePluralRules() {
  const need = (loc: string) => {
    try {
      return !!shouldPolyfill(loc);
    } catch {
      return true;
    }
  };
  if (LANGUAGES.some((l) => need(l.code))) {
    require('@formatjs/intl-pluralrules/polyfill-force.js');
    require('@formatjs/intl-pluralrules/locale-data/en.js');
    require('@formatjs/intl-pluralrules/locale-data/hi.js');
    require('@formatjs/intl-pluralrules/locale-data/bn.js');
    require('@formatjs/intl-pluralrules/locale-data/ta.js');
    require('@formatjs/intl-pluralrules/locale-data/te.js');
    require('@formatjs/intl-pluralrules/locale-data/mr.js');
  }
}

ensurePluralRules();

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    hi: { translation: hi },
    bn: { translation: bn },
    ta: { translation: ta },
    te: { translation: te },
    mr: { translation: mr },
  },
  lng: systemLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
});

export function applyLanguage(code: LanguageCode) {
  if (i18n.language !== code) void i18n.changeLanguage(code);
  dayjs.locale(code);
}

// ── Script fonts, loaded on demand ──────────────────────────────────────────

const loaded = new Set<Script>(['latin']);

const LOADERS: Record<Exclude<Script, 'latin'>, () => Record<string, any>> = {
  deva: () => {
    const m = require('@expo-google-fonts/noto-sans-devanagari');
    return {
      NotoSansDevanagari_400Regular: m.NotoSansDevanagari_400Regular,
      NotoSansDevanagari_500Medium: m.NotoSansDevanagari_500Medium,
      NotoSansDevanagari_600SemiBold: m.NotoSansDevanagari_600SemiBold,
      NotoSansDevanagari_700Bold: m.NotoSansDevanagari_700Bold,
      NotoSansDevanagari_800ExtraBold: m.NotoSansDevanagari_800ExtraBold,
    };
  },
  beng: () => {
    const m = require('@expo-google-fonts/noto-sans-bengali');
    return {
      NotoSansBengali_400Regular: m.NotoSansBengali_400Regular,
      NotoSansBengali_500Medium: m.NotoSansBengali_500Medium,
      NotoSansBengali_600SemiBold: m.NotoSansBengali_600SemiBold,
      NotoSansBengali_700Bold: m.NotoSansBengali_700Bold,
      NotoSansBengali_800ExtraBold: m.NotoSansBengali_800ExtraBold,
    };
  },
  taml: () => {
    const m = require('@expo-google-fonts/noto-sans-tamil');
    return {
      NotoSansTamil_400Regular: m.NotoSansTamil_400Regular,
      NotoSansTamil_500Medium: m.NotoSansTamil_500Medium,
      NotoSansTamil_600SemiBold: m.NotoSansTamil_600SemiBold,
      NotoSansTamil_700Bold: m.NotoSansTamil_700Bold,
      NotoSansTamil_800ExtraBold: m.NotoSansTamil_800ExtraBold,
    };
  },
  telu: () => {
    const m = require('@expo-google-fonts/noto-sans-telugu');
    return {
      NotoSansTelugu_400Regular: m.NotoSansTelugu_400Regular,
      NotoSansTelugu_500Medium: m.NotoSansTelugu_500Medium,
      NotoSansTelugu_600SemiBold: m.NotoSansTelugu_600SemiBold,
      NotoSansTelugu_700Bold: m.NotoSansTelugu_700Bold,
      NotoSansTelugu_800ExtraBold: m.NotoSansTelugu_800ExtraBold,
    };
  },
};

export function scriptFontsLoaded(script: Script) {
  return loaded.has(script);
}

export async function loadScriptFonts(script: Script): Promise<boolean> {
  if (loaded.has(script)) return true;
  try {
    await Font.loadAsync(LOADERS[script as Exclude<Script, 'latin'>]());
    loaded.add(script);
    return true;
  } catch (e) {
    console.warn('[i18n] could not load fonts for', script, e);
    return false;
  }
}

export { useTranslation };
export const useT = () => useTranslation().t;
export default i18n;
