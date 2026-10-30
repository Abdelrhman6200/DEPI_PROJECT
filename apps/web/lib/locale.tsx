'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Locale } from '@health/api-client';
import { translate, translateEnum, type TKey } from './i18n';
import { makeFormatters, type Formatters } from './format';

interface LocaleContextValue {
  locale: Locale;
  dir: 'rtl' | 'ltr';
  setLocale: (l: Locale) => void;
  toggle: () => void;
  t: (key: TKey, vars?: Record<string, string | number>) => string;
  /** translate an enum value under a prefix, e.g. te('cl.', 'self_care') */
  te: (prefix: string, value: string | null | undefined) => string;
  /** pick the right side of a bilingual pair */
  pick: (en: string | null | undefined, ar: string | null | undefined) => string;
  fmt: Formatters;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);
const STORAGE_KEY = 'locale';

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('ar');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'en' || saved === 'ar') setLocaleState(saved);
    } catch {
      /* storage unavailable */
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const el = document.documentElement;
    el.lang = locale;
    el.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [locale, loaded]);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      dir: locale === 'ar' ? 'rtl' : 'ltr',
      setLocale,
      toggle: () => setLocale(locale === 'ar' ? 'en' : 'ar'),
      t: (key, vars) => translate(locale, key, vars),
      te: (prefix, v) => translateEnum(locale, prefix, v),
      pick: (en, ar) => (locale === 'ar' ? ar || en || '' : en || ar || ''),
      fmt: makeFormatters(locale),
    }),
    [locale, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useLocale must be used inside <LocaleProvider>');
  return ctx;
}
