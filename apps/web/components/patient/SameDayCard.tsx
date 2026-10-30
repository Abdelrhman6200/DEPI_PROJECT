'use client';

import Link from 'next/link';
import { AlertTriangle, Phone, Stethoscope } from 'lucide-react';
import { useLocale } from '@/lib/locale';
import { cn } from '@/lib/cn';

/** "This needs a doctor today": a same-day problem (not an emergency) found in a message, with the way to get care. */
export function SameDayCard({ message, className, onNavigate, call123 }: { message: string; className?: string; onNavigate?: () => void; call123?: boolean }) {
  const { t } = useLocale();
  return (
    <div role="alert" className={cn('space-y-3 rounded-2xl border-2 border-warn/60 bg-warn-soft p-4', className)}>
      <p className="flex items-start gap-2 text-lg font-bold text-warn-fg">
        <AlertTriangle className="mt-1 size-5 shrink-0" aria-hidden />
        {t('urgent.title')}
      </p>
      <p dir="auto" className="text-base leading-7 text-fg">
        {message}
      </p>
      <div className="flex flex-wrap gap-2">
        <Link
          href="/app/care-access"
          onClick={onNavigate}
          className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-primary px-4 text-base font-semibold text-primary-fg hover:bg-primary-strong"
        >
          <Stethoscope className="size-5" aria-hidden />
          {t('nav.needCare')}
        </Link>
        {call123 && (
          <a href="tel:123" className="inline-flex min-h-12 items-center gap-2 rounded-xl border border-line-strong bg-surface px-4 text-base font-semibold text-fg hover:bg-surface-2">
            <Phone className="size-5" aria-hidden />
            {t('ca.callNow')}
          </a>
        )}
      </div>
    </div>
  );
}
