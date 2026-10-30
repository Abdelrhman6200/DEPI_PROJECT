'use client';

import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { useLocale } from '@/lib/locale';
import { cn } from '@/lib/cn';

/** Renders the first `limit` items and a "Show more (n)" toggle for the rest — keeps long lists calm. */
export function ShowMoreList<T>({
  items,
  limit = 3,
  render,
  className,
  as = 'div',
}: {
  items: T[];
  limit?: number;
  render: (item: T, index: number) => ReactNode;
  className?: string;
  as?: 'div' | 'ul';
}) {
  const { t } = useLocale();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, limit);
  const Tag = as;
  return (
    <>
      <Tag className={className}>{shown.map(render)}</Tag>
      {items.length > limit && (
        <div>
        <button
          type="button"
          onClick={() => setAll((x) => !x)}
          aria-expanded={all}
          className="mt-2 inline-flex min-h-11 items-center gap-1.5 text-base font-semibold text-primary-strong hover:underline"
        >
          {all ? t('common.less') : `${t('common.more')} (${items.length - limit})`}
          <ChevronDown className={cn('size-4 transition-transform', all && 'rotate-180')} aria-hidden />
        </button>
        </div>
      )}
    </>
  );
}
