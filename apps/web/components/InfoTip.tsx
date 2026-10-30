'use client';

import { HelpCircle } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { useLocale } from '@/lib/locale';
import type { TKey } from '@/lib/i18n';

/**
 * Small "?" button that opens a one-sentence explanation of a term (TIR, GMI, eGFR…).
 * Works with touch, mouse and keyboard; closes on outside tap or Escape.
 */
export function InfoTip({ text, label, className }: { text: TKey; label?: string; className?: string }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  return (
    <span ref={ref} className={cn('relative inline-flex align-middle', className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label ?? t('common.whatIsThis')}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          const w = Math.min(272, window.innerWidth - 32);
          const left = Math.max(16, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - 16 - w));
          setPos({ left, top: r.bottom + 8 });
          setOpen((o) => !o);
        }}
        className="-m-2 inline-flex size-9 items-center justify-center rounded-full text-fg-subtle hover:text-primary-strong"
      >
        <HelpCircle className="size-[1.1rem]" aria-hidden />
      </button>
      {open && pos && (
        <span
          id={id}
          role="tooltip"
          style={{ left: pos.left, top: pos.top, width: Math.min(272, typeof window === 'undefined' ? 272 : window.innerWidth - 32) }}
          className="fade-up fixed z-[80] rounded-xl border border-line bg-surface p-3 text-start text-sm leading-6 font-normal text-fg shadow-lg"
        >
          {t(text)}
        </span>
      )}
    </span>
  );
}
