'use client';

import { AlertTriangle, Inbox, RotateCw, WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useLocale } from '@/lib/locale';
import { errorKey, errorMessage, isAborted } from '@/lib/api';
import { Button } from './Button';

export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
  compact = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-2xl border border-dashed border-line-strong/70 text-center',
        compact ? 'gap-1.5 px-4 py-5' : 'gap-2 px-6 py-10',
        className,
      )}
    >
      <span className="text-fg-subtle" aria-hidden>
        {icon ?? <Inbox className={compact ? 'size-6' : 'size-8'} />}
      </span>
      <p className={cn('font-medium text-fg', compact ? 'text-sm' : 'text-base')}>{title}</p>
      {description && <p className="max-w-sm text-sm leading-6 text-fg-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Friendly error with a retry button. Never shows raw error codes; details go to the console only. */
export function ErrorState({
  error,
  onRetry,
  className,
  compact = false,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
  compact?: boolean;
}) {
  const { t } = useLocale();
  const key = errorKey(error);
  if (error && typeof console !== 'undefined') console.warn('[api]', errorMessage(error));
  const Icon = key === 'err.network' ? WifiOff : AlertTriangle;
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-2xl border border-danger/30 bg-danger-soft text-center',
        compact ? 'px-4 py-4' : 'px-6 py-8',
        className,
      )}
    >
      <Icon className="size-6 text-danger" aria-hidden />
      <p className="max-w-md text-sm leading-6 font-medium text-danger-fg">{t(key)}</p>
      {onRetry && (
        <Button size="md" variant="outline" icon={<RotateCw className="size-4" />} onClick={onRetry} className="mt-1">
          {t('common.retry')}
        </Button>
      )}
    </div>
  );
}

/** Inline error line for forms (announced to screen readers). */
export function InlineError({ error, message }: { error?: unknown; message?: string | null }) {
  const { t } = useLocale();
  // a request the person cancelled is not an error
  if ((!error || isAborted(error)) && !message) return null;
  return (
    <p role="alert" className="flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2.5 text-sm leading-6 text-danger-fg">
      <AlertTriangle className="mt-1 size-4 shrink-0" aria-hidden />
      <span>{message ?? t(errorKey(error))}</span>
    </p>
  );
}
