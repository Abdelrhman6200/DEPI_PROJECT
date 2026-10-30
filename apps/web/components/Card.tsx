import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'default' | 'danger' | 'warn' | 'ok' | 'primary' | 'muted';

const TONES: Record<Tone, string> = {
  default: 'bg-surface border-line',
  danger: 'bg-danger-soft border-danger/40',
  warn: 'bg-warn-soft border-warn/40',
  ok: 'bg-ok-soft border-ok/40',
  primary: 'bg-primary-soft border-primary/30',
  muted: 'bg-surface-2 border-line',
};

export function Card({
  className,
  tone = 'default',
  padded = true,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { tone?: Tone; padded?: boolean }) {
  return <div className={cn('rounded-2xl border', TONES[tone], padded && 'p-4 sm:p-5', className)} {...rest} />;
}

export function CardHeader({
  title,
  subtitle,
  icon,
  action,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-2', className)}>
      <div className="flex min-w-0 items-start gap-2.5">
        {icon && <span className="mt-0.5 shrink-0 text-primary">{icon}</span>}
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold leading-6 text-fg">{title}</h3>
          {subtitle && <div className="text-xs text-fg-muted">{subtitle}</div>}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 mt-1 flex items-center justify-between gap-3">
      <h2 className="text-lg font-semibold text-fg">{children}</h2>
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-fg-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
