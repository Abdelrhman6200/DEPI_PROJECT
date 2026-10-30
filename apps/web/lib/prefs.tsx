'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemePref = 'light' | 'dark' | 'system';
export type TextSize = 'normal' | 'large';
/** 'system' follows the device setting (prefers-reduced-motion); 'reduce' turns animations off in the app. */
export type MotionPref = 'system' | 'reduce';

const THEME_KEY = 'pref.theme';
const TEXT_KEY = 'pref.text';
const MOTION_KEY = 'pref.motion';

interface PrefsValue {
  theme: ThemePref;
  setTheme: (t: ThemePref) => void;
  textSize: TextSize;
  setTextSize: (s: TextSize) => void;
  motion: MotionPref;
  setMotion: (m: MotionPref) => void;
}

const PrefsContext = createContext<PrefsValue | null>(null);

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

/** Applied before paint by the inline script in app/layout.tsx; kept in sync here. */
function apply(theme: ThemePref, text: TextSize, motion: MotionPref) {
  const el = document.documentElement;
  if (theme === 'system') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', theme);
  el.setAttribute('data-text', text);
  if (motion === 'reduce') el.setAttribute('data-motion', 'reduce');
  else el.removeAttribute('data-motion');
}

/** True when animations should be skipped (the app setting, or the device setting). */
export function prefersReducedMotion(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.documentElement.getAttribute('data-motion') === 'reduce') return true;
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Inline script (stringified) that applies stored preferences before first paint to avoid a flash. */
export const PREFS_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_KEY}');var s=localStorage.getItem('${TEXT_KEY}');var m=localStorage.getItem('${MOTION_KEY}');var l=localStorage.getItem('locale');var e=document.documentElement;if(t==='light'||t==='dark')e.setAttribute('data-theme',t);e.setAttribute('data-text',s==='large'?'large':'normal');if(m==='reduce')e.setAttribute('data-motion','reduce');if(l==='en'||l==='ar'){e.lang=l;e.dir=l==='ar'?'rtl':'ltr';}}catch(_){}})();`;

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePref>('system');
  const [textSize, setTextState] = useState<TextSize>('normal');
  const [motion, setMotionState] = useState<MotionPref>('system');

  useEffect(() => {
    const t = read(THEME_KEY);
    const s = read(TEXT_KEY);
    const m = read(MOTION_KEY);
    const theme0: ThemePref = t === 'light' || t === 'dark' ? t : 'system';
    const text0: TextSize = s === 'large' ? 'large' : 'normal';
    const motion0: MotionPref = m === 'reduce' ? 'reduce' : 'system';
    setThemeState(theme0);
    setTextState(text0);
    setMotionState(motion0);
    apply(theme0, text0, motion0);
  }, []);

  const setTheme = useCallback(
    (t: ThemePref) => {
      setThemeState(t);
      write(THEME_KEY, t);
      apply(t, textSize, motion);
    },
    [textSize, motion],
  );
  const setTextSize = useCallback(
    (s: TextSize) => {
      setTextState(s);
      write(TEXT_KEY, s);
      apply(theme, s, motion);
    },
    [theme, motion],
  );
  const setMotion = useCallback(
    (m: MotionPref) => {
      setMotionState(m);
      write(MOTION_KEY, m);
      apply(theme, textSize, m);
    },
    [theme, textSize],
  );

  const value = useMemo(
    () => ({ theme, setTheme, textSize, setTextSize, motion, setMotion }),
    [theme, setTheme, textSize, setTextSize, motion, setMotion],
  );
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): PrefsValue {
  const ctx = useContext(PrefsContext);
  if (!ctx) throw new Error('usePrefs must be used inside <PrefsProvider>');
  return ctx;
}

/* ------------------------------------------------------------------ install prompt */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

const InstallContext = createContext<{ available: boolean; prompt: () => Promise<void> }>({ available: false, prompt: async () => {} });

/**
 * The browser offers "install this app" once per page load, usually right after the first page opens. It is
 * caught here at the root, so the Install button in Account works even when that page is opened later.
 */
export function InstallPromptProvider({ children }: { children: ReactNode }) {
  const [event, setEvent] = useState<BeforeInstallPromptEvent | null>(null);
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setEvent(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  const value = useMemo(
    () => ({
      available: !!event,
      prompt: async () => {
        if (!event) return;
        await event.prompt().catch(() => undefined);
        setEvent(null); // the same event cannot be used twice
      },
    }),
    [event],
  );
  return <InstallContext.Provider value={value}>{children}</InstallContext.Provider>;
}

export function useInstallPrompt() {
  return useContext(InstallContext);
}
