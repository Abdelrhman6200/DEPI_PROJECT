'use client';

import { Lock } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { cn } from '@/lib/cn';

/** Name of the person a family member is looking after (the active record). */
export function useActivePatientName(): string | null {
  const { user, activePatientId } = useAuth();
  const { pick } = useLocale();
  if (user?.role !== 'caregiver' || !activePatientId) return null;
  const p = user.caregiver_patients?.find((x) => x.id === activePatientId);
  return p ? pick(p.full_name, p.full_name_ar) : null;
}

/**
 * Shown instead of record-changing buttons when a family member may view and log but not change the record:
 * says who can allow it and where.
 */
export function ManageHint({ className }: { className?: string }) {
  const { canManageRecord } = useAuth();
  const { t } = useLocale();
  const name = useActivePatientName();
  if (canManageRecord) return null;
  return (
    <p className={cn('flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm leading-6 text-fg-muted', className)}>
      <Lock className="mt-1 size-4 shrink-0" aria-hidden />
      {t('fam.askManage', { name: name ?? t('common.patient') })}
    </p>
  );
}
