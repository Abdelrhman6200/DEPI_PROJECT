'use client';

import type { ReactNode } from 'react';
import { useLocale } from '@/lib/locale';
import type { ApiState } from '@/lib/useApi';
import { EmptyState, ErrorState } from './EmptyState';
import { SkeletonList } from './Skeleton';

/**
 * Renders the loading / error / empty / data states of a useApi() result consistently.
 */
export function Async<T>({
  state,
  children,
  skeleton,
  empty,
  isEmpty,
  compact,
}: {
  state: Pick<ApiState<T>, 'data' | 'error' | 'loading' | 'reload'>;
  children: (data: T) => ReactNode;
  skeleton?: ReactNode;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  compact?: boolean;
}) {
  if (state.loading && state.data === null) return <>{skeleton ?? <SkeletonList />}</>;
  if (state.error && state.data === null)
    return <ErrorState error={state.error} onRetry={() => void state.reload()} compact={compact} />;
  if (state.data === null) return <>{skeleton ?? <SkeletonList />}</>;
  const d = state.data;
  const emptyNow = isEmpty ? isEmpty(d) : Array.isArray(d) && d.length === 0;
  if (emptyNow) return <>{empty ?? <DefaultEmpty compact={compact} />}</>;
  return <>{children(d)}</>;
}

function DefaultEmpty({ compact }: { compact?: boolean }) {
  const { t } = useLocale();
  return <EmptyState title={t('common.empty')} compact={compact} />;
}
