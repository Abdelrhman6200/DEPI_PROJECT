'use client';

import { useState } from 'react';
import { BookOpen, ExternalLink, FileText } from 'lucide-react';
import type { Citation } from '@health/api-client';
import { cn } from '@/lib/cn';
import { useLocale } from '@/lib/locale';

/** Sources behind an AI answer, NotebookLM style: numbered chips matching the [n] markers in the answer (record = your
 *  data, guideline = medical guidance). Opening a chip shows the cited passage; accredited guideline sources also link
 *  to the publisher or DOI. */
export function Citations({ citations, className }: { citations: Citation[]; className?: string }) {
  const { t } = useLocale();
  const [open, setOpen] = useState<number | null>(null);
  if (!citations.length) return null;
  const shown = open === null ? null : citations[open];
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium text-fg-muted">{t('ai.sources')}:</span>
        {citations.map((c, i) => (
          <button
            key={`${c.id}-${i}`}
            type="button"
            aria-expanded={open === i}
            title={`${c.title} — ${c.source}`}
            onClick={() => setOpen(open === i ? null : i)}
            className={cn(
              'inline-flex min-h-7 max-w-[16rem] items-center gap-1 rounded-full border px-2 py-0.5 text-xs hover:underline',
              c.kind === 'guideline' ? 'border-info/30 bg-info-soft text-info-fg' : 'border-primary/25 bg-primary-soft text-primary-strong',
              open === i && 'ring-2 ring-primary/40',
            )}
          >
            <span className="font-semibold tabular-nums">{i + 1}</span>
            {c.kind === 'guideline' ? <BookOpen className="size-3 shrink-0" aria-hidden /> : <FileText className="size-3 shrink-0" aria-hidden />}
            <span className="truncate">{c.title}</span>
          </button>
        ))}
      </div>
      {shown && (
        <div className="mt-2 rounded-xl border border-line bg-surface-2 p-3 text-xs">
          <p className="font-medium">
            [{(open ?? 0) + 1}] {shown.title} <span className="font-normal text-fg-muted">· {shown.source}</span>
          </p>
          {shown.excerpt && <p className="mt-1 whitespace-pre-line text-fg-muted" dir="auto">{shown.excerpt}</p>}
          {shown.url && (
            <a href={shown.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-primary-strong hover:underline">
              {t('ai.openSource')} <ExternalLink className="size-3" aria-hidden />
            </a>
          )}
        </div>
      )}
    </div>
  );
}
