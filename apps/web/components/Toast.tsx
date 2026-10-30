'use client';

import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { backendMessage, errorKey, errorMessage, isAborted } from '@/lib/api';
import { useLocale } from '@/lib/locale';

type Kind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: Kind;
  message: ReactNode;
}

const ToastContext = createContext<(message: ReactNode, kind?: Kind) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (message: ReactNode, kind: Kind = 'success') => {
      const id = Date.now() + Math.random();
      setItems((xs) => [...xs.slice(-2), { id, kind, message }]);
      setTimeout(() => dismiss(id), kind === 'error' ? 7000 : 4000);
    },
    [dismiss],
  );

  const errors = items.filter((x) => x.kind === 'error');
  const others = items.filter((x) => x.kind !== 'error');
  const render = (it: ToastItem) => (
    <div
      key={it.id}
      className={cn(
        'fade-up pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-2xl border px-4 py-3 text-base shadow-lg',
        it.kind === 'success' && 'border-ok/40 bg-surface text-fg',
        it.kind === 'error' && 'border-danger/40 bg-danger-soft text-danger-fg',
        it.kind === 'info' && 'border-line bg-surface text-fg',
      )}
    >
      {it.kind === 'success' && <CheckCircle2 className="size-5 shrink-0 text-ok" aria-hidden />}
      {it.kind === 'error' && <AlertTriangle className="size-5 shrink-0 text-danger" aria-hidden />}
      {it.kind === 'info' && <Info className="size-5 shrink-0 text-info" aria-hidden />}
      <span className="min-w-0 flex-1">{it.message}</span>
      <button
        type="button"
        onClick={() => dismiss(it.id)}
        className="-me-1 inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:text-fg"
        aria-label={t('common.close')}
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );

  return (
    <ToastContext.Provider value={push}>
      {children}
      {/* Phones: at the bottom, above the tab bar, so the header (and its Emergency button) stays visible.
          Larger screens: top centre. Errors are announced at once (alert), other messages politely (status). */}
      <div
        className="print-hidden pointer-events-none fixed inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-[70] flex flex-col items-center px-4 sm:top-3 sm:bottom-auto"
      >
        <div role="alert" aria-live="assertive" className="flex w-full flex-col items-center gap-2">
          {errors.map(render)}
        </div>
        <div role="status" aria-live="polite" className={cn('flex w-full flex-col items-center gap-2', errors.length > 0 && others.length > 0 && 'mt-2')}>
          {others.map(render)}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/** Toast a friendly, translated message for any error (never raw codes). A cancelled request shows nothing. */
export function useErrorToast() {
  const push = useContext(ToastContext);
  const { t, locale } = useLocale();
  return useCallback(
    (err: unknown) => {
      if (isAborted(err)) return;
      console.warn('[api]', errorMessage(err));
      // A specific translation first; where only a generic one exists, the backend's own sentence in this language.
      const key = errorKey(err);
      const generic = key === 'err.badRequest' || key === 'err.forbidden';
      push((generic && backendMessage(err, locale)) || t(key), 'error');
    },
    [push, t, locale],
  );
}
