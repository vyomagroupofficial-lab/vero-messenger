import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import { FONT_SETS, FontSet, Palette, TypeSet, buildType, dark, light } from './theme';
import { useAppearance } from './appearance';
import { LanguageCode, applyLanguage, loadScriptFonts, resolveLanguage, scriptFor, scriptFontsLoaded } from '../i18n';

export interface Theme {
  c: Palette;
  f: FontSet;
  type: TypeSet;
  isDark: boolean;
  language: LanguageCode;
  key: string;
}

function makeTheme(c: Palette, f: FontSet, language: LanguageCode): Theme {
  return { c, f, type: buildType(c, f), isDark: c.name === 'dark', language, key: `${c.name}-${f.script}` };
}

const ThemeContext = createContext<Theme>(makeTheme(dark, FONT_SETS.latin, 'en'));

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const themePref = useAppearance((s) => s.theme);
  const langPref = useAppearance((s) => s.language);

  const language = resolveLanguage(langPref);
  const script = scriptFor(language);
  const [fontsReady, setFontsReady] = useState(() => scriptFontsLoaded(script));

  useEffect(() => {
    applyLanguage(language);
    if (scriptFontsLoaded(script)) {
      setFontsReady(true);
      return;
    }
    setFontsReady(false);
    let live = true;
    loadScriptFonts(script).then((ok) => live && setFontsReady(ok));
    return () => {
      live = false;
    };
  }, [language, script]);

  const isDark = themePref === 'system' ? system !== 'light' : themePref === 'dark';
  // Until a script's fonts arrive, Latin fonts render (the OS falls back for the glyphs).
  const f = fontsReady ? FONT_SETS[script] : FONT_SETS.latin;

  const value = useMemo(() => makeTheme(isDark ? dark : light, f, language), [isDark, f, language]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/**
 * Theme-aware StyleSheet: `const useStyles = makeStyles((c, t, f) => ({...}))`,
 * then `const s = useStyles()` in the component. Cached per theme + script.
 */
export function makeStyles<T extends StyleSheet.NamedStyles<T>>(build: (c: Palette, t: TypeSet, f: FontSet) => T) {
  const cache = new Map<string, T>();
  return function useStyles(): T {
    const theme = useTheme();
    let styles = cache.get(theme.key);
    if (!styles) {
      styles = StyleSheet.create(build(theme.c, theme.type, theme.f)) as T;
      cache.set(theme.key, styles);
    }
    return styles;
  };
}
