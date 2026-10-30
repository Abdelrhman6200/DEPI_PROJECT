import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import type { TKey } from '@/lib/i18n';
import { InfoTip } from './InfoTip';

type Tone = 'default' | 'danger' | 'warn' | 'ok' | 'primary';

const ACCENT: Record<Tone, string> = {
  default: 'text-fg',
  danger: 'text-danger',
  warn: 'text-warn',
  ok: 'text-ok',
  primary: 'text-primary-strong',
};

export function StatTile({
  label,
  value,
  unit,
  hint,
  icon,
  help,
  tone = 'default',
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  /** one-sentence explanation shown from a "?" button */
  help?: TKey;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div className={cn('rounded-2xl border border-line bg-surface p-4', className)}>
      <div className="flex items-start justify-between gap-2 text-sm font-medium text-fg-muted">
        <span className="flex min-w-0 items-center gap-1">
          <span>{label}</span>
          {help && <InfoTip text={help} />}
        </span>
        {icon && (
          <span className="text-fg-subtle" aria-hidden>
            {icon}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className={cn('num text-2xl font-bold tracking-tight', ACCENT[tone])}>{value}</span>
        {unit && <span className="text-sm text-fg-muted">{unit}</span>}
      </div>
      {hint && <div className="mt-1 text-sm text-fg-muted">{hint}</div>}
    </div>
  );
}
