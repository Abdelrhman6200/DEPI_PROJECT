'use client';

import { Utensils } from 'lucide-react';
import type { FoodProfile } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { useApi } from '@/lib/useApi';
import { cn } from '@/lib/cn';
import { Card, CardHeader } from '../Card';
import { SkeletonCard } from '../Skeleton';

const BAND_CLASS = { gentle: 'bg-ok-soft text-ok-fg', moderate: 'bg-warn-soft text-warn-fg', high: 'bg-danger-soft text-danger-fg' } as const;

/**
 * How this person's sugar rose after meals with each food (engine 32_personal.js): facts from their own readings, highest
 * average rise first. A rise belongs to the whole meal, so a food eaten with bread carries the bread's rise too.
 */
export function FoodProfileView({ profile, compact, pro }: { profile: FoodProfile; compact?: boolean; pro?: boolean }) {
  const { t, te, pick } = useLocale();
  const foods = profile.foods ?? [];
  return (
    <div className="space-y-3">
      {foods.length === 0 ? (
        <p className="rounded-xl bg-surface-2 px-4 py-3 text-base text-fg-muted">{t(profile.note === 'few_readings' ? 'food.fewReadings' : 'food.notEnough')}</p>
      ) : (
        <ul className="divide-y divide-line rounded-2xl border border-line">
          {foods.slice(0, compact ? 5 : 12).map((f) => (
            <li key={f.food_id ?? f.name} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <bdi className="font-semibold">{pick(f.name, f.name_ar)}</bdi>
                <div className="text-sm text-fg-muted">{t('food.meals', { n: f.meals })}</div>
              </div>
              <span className={cn('num rounded-full px-2.5 py-0.5 text-sm font-semibold', BAND_CLASS[f.band ?? 'moderate'])}>
                +{f.mean_rise} {t('common.mgdl')}
              </span>
            </li>
          ))}
        </ul>
      )}
      {profile.by_meal.length > 0 && (
        <div className="flex flex-wrap gap-2 text-sm">
          {profile.by_meal.map((m) => (
            <span key={m.meal_type} className="rounded-full bg-surface-2 px-3 py-1">
              {te('meal.', m.meal_type)}: <span className="num font-semibold">+{m.mean_rise}</span>
            </span>
          ))}
        </div>
      )}
      <p className="text-sm leading-6 text-fg-muted">{t(pro ? 'food.notePro' : 'food.note')}</p>
    </div>
  );
}

/** The patient's own card (lifestyle page). */
export function FoodProfileCard({ patientId }: { patientId?: string }) {
  const { t } = useLocale();
  const q = useApi('lifestyle', 'food_profile', { ...(patientId ? { patient_id: patientId } : {}), days: 90 });
  if (q.loading && !q.data) return <SkeletonCard lines={4} />;
  if (!q.data) return null;
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><Utensils className="size-5 text-primary" aria-hidden />{t('food.title')}</span>} subtitle={t('food.subtitle', { n: q.data.days })} />
      <FoodProfileView profile={q.data} />
    </Card>
  );
}
