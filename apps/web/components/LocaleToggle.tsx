'use client';

import { Languages } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useLocale } from '@/lib/locale';

export function LocaleToggle({ className }: { className?: string }) {
  const { t, toggle, locale } = useLocale();
  return (
    <button
      type="button"
      onClick={toggle}
      lang={locale === 'ar' ? 'en' : 'ar'}
      className={cn(
        'inline-flex h-11 items-center gap-1.5 rounded-xl border border-line-strong bg-surface px-3 text-base font-medium text-fg hover:bg-surface-2',
        className,
      )}
      aria-label={`${t('common.language')}: ${t('common.switchLang')}`}
    >
      <Languages className="size-4" aria-hidden />
      <span>{t('common.switchLang')}</span>
    </button>
  );
}
