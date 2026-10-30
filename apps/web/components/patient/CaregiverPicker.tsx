'use client';

import { ChevronDown, UserRound, Users } from 'lucide-react';
import type { UUID } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { cn } from '@/lib/cn';
import { EmptyState } from '../EmptyState';

/** Names of the caregiver's linked patients, provided by the session (auth.login / auth.me). */
function usePatientNames() {
  const { user } = useAuth();
  const ids = user?.caregiver_patient_ids ?? [];
  const names: Record<UUID, { full_name: string; full_name_ar: string | null } | null> = {};
  for (const id of ids) names[id] = user?.caregiver_patients?.find((p) => p.id === id) ?? null;
  return { ids, names };
}

/** Full-page chooser shown when a caregiver has not picked a person yet. */
export function CaregiverChooser() {
  const { setActivePatientId } = useAuth();
  const { t, pick } = useLocale();
  const { ids, names } = usePatientNames();

  return (
    <div className="mx-auto max-w-md py-8">
      <span className="mx-auto mb-4 flex size-16 items-center justify-center rounded-3xl bg-primary-soft text-primary" aria-hidden>
        <Users className="size-8" />
      </span>
      <h1 className="mb-6 text-center text-2xl font-bold">{t('cg.choosePatient')}</h1>
      {ids.length === 0 ? (
        <EmptyState title={t('cg.noPatients')} />
      ) : (
        <ul className="space-y-3">
          {ids.map((id) => {
            const p = names[id];
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => setActivePatientId(id)}
                  className="flex min-h-16 w-full items-center gap-3 rounded-2xl border-2 border-line bg-surface p-4 text-start hover:border-primary"
                >
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary" aria-hidden>
                    <UserRound className="size-6" />
                  </span>
                  <span className="min-w-0 truncate text-lg font-semibold">{p ? pick(p.full_name, p.full_name_ar) : t('common.patient')}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Compact header switcher for caregivers. */
export function CaregiverSwitcher({ className }: { className?: string }) {
  const { user, activePatientId, setActivePatientId } = useAuth();
  const { t, pick } = useLocale();
  const { ids, names } = usePatientNames();
  if (user?.role !== 'caregiver') return null;
  return (
    <label className={cn('relative inline-flex items-center gap-2 text-sm', className)}>
      <span className="shrink-0 text-sm text-fg-muted">{t('cg.caringFor')}</span>
      <select
        value={activePatientId ?? ''}
        onChange={(e) => setActivePatientId(e.target.value || null)}
        className="h-11 min-w-0 flex-1 appearance-none truncate rounded-xl border border-line-strong bg-surface ps-3 pe-8 text-base font-semibold sm:max-w-[12rem]"
      >
        <option value="">{t('cg.choose')}</option>
        {ids.map((id) => (
          <option key={id} value={id}>
            {names[id] ? pick(names[id]!.full_name, names[id]!.full_name_ar) : t('common.patient')}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute end-2.5 size-4 text-fg-muted" aria-hidden />
    </label>
  );
}
