'use client';

import { Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Citation } from '@health/api-client';
import { cn } from '@/lib/cn';
import { useLocale } from '@/lib/locale';
import { Citations } from './Citations';
import { numberCitations } from '@/lib/citations';

/** Small label shown on every AI-generated text block. `pro` uses clinician wording. */
export function AiLabel({ className, extra, pro = false }: { className?: string; extra?: ReactNode; pro?: boolean }) {
  const { t } = useLocale();
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-fg-muted', className)}>
      <Sparkles className="size-3.5 text-primary" aria-hidden />
      {t(pro ? 'ai.labelPro' : 'ai.label')}
      {extra && <span className="text-fg-subtle"> · {extra}</span>}
    </span>
  );
}

/** Wrapper for AI-generated text: content + AI label + citations. */
export function AiBlock({
  children,
  citations,
  className,
  extra,
  pro,
}: {
  children: ReactNode;
  citations?: Citation[] | null;
  className?: string;
  extra?: ReactNode;
  pro?: boolean;
}) {
  return (
    <div className={cn('space-y-2', className)}>
      <div dir="auto" className="text-base leading-7 whitespace-pre-line text-fg">
        {typeof children === 'string' ? numberCitations(children, citations) : children}
      </div>
      <AiLabel extra={extra} pro={pro} />
      {citations && citations.length > 0 && <Citations citations={citations} />}
    </div>
  );
}
