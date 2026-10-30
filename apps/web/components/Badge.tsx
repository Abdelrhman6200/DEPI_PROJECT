import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type BadgeTone = 'neutral' | 'primary' | 'ok' | 'warn' | 'danger' | 'info' | 'solid-danger';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-fg-muted border-line',
  primary: 'bg-primary-soft text-primary-strong border-primary/25',
  ok: 'bg-ok-soft text-ok-fg border-ok/25',
  warn: 'bg-warn-soft text-warn-fg border-warn/30',
  danger: 'bg-danger-soft text-danger-fg border-danger/30',
  info: 'bg-info-soft text-info-fg border-info/25',
  'solid-danger': 'bg-danger-solid text-white border-danger',
};

export function Badge({
  tone = 'neutral',
  children,
  icon,
  className,
  title,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium leading-4',
        TONES[tone],
        className,
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}
