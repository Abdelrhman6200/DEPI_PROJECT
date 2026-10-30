'use client';

import { Activity, BookOpen, CalendarCheck, Footprints, Pill, ScanSearch, Target, type LucideIcon } from 'lucide-react';
import type { CarePlan, CarePlanItem } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { Badge } from '../Badge';
import { Card } from '../Card';
import { AiBlock } from '../AiLabel';
import { EmptyState } from '../EmptyState';
import type { TKey } from '@/lib/i18n';

const ITEM_ICON: Record<CarePlanItem['kind'], LucideIcon> = {
  monitoring: Activity,
  medication: Pill,
  lifestyle: Footprints,
  education: BookOpen,
  screening: ScanSearch,
  appointment: CalendarCheck,
};

export function CarePlanTargetsGrid({ plan }: { plan: CarePlan }) {
  const { t, fmt } = useLocale();
  const tg = plan.targets;
  const rows: { label: TKey; value: string }[] = [];
  const unit = t('common.mgdl');
  if (tg.fasting_low !== undefined || tg.fasting_high !== undefined)
    rows.push({
      label: 'care.targetFasting',
      value:
        tg.fasting_low !== undefined && tg.fasting_high !== undefined
          ? `${tg.fasting_low}–${tg.fasting_high} ${unit}`
          : tg.fasting_high !== undefined
            ? `< ${tg.fasting_high} ${unit}`
            : `> ${tg.fasting_low} ${unit}`,
    });
  if (tg.post_meal_high !== undefined) rows.push({ label: 'care.targetPostMeal', value: `${tg.post_meal_high} ${unit}` });
  if (tg.tir_target !== undefined) rows.push({ label: 'care.targetTir', value: fmt.pct(tg.tir_target) });
  if (tg.hba1c_target !== undefined) rows.push({ label: 'care.targetA1c', value: `${fmt.number(tg.hba1c_target, 1)}%` });
  if (tg.bp_systolic !== undefined) rows.push({ label: 'care.targetBp', value: `${tg.bp_systolic}/${tg.bp_diastolic ?? '—'} mmHg` });
  if (tg.steps_target !== undefined) rows.push({ label: 'care.targetSteps', value: fmt.number(tg.steps_target) });
  if (!rows.length) return null;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {rows.map((r) => (
        <div key={r.label} className="rounded-xl bg-surface-2 p-3">
          <div className="text-sm text-fg-muted">{t(r.label)}</div>
          <div className="num mt-0.5 text-lg font-semibold">{r.value}</div>
        </div>
      ))}
    </div>
  );
}

export function CarePlanItems({ items }: { items: CarePlanItem[] }) {
  const { t, te, pick } = useLocale();
  if (!items.length) return <EmptyState compact title={t('plan.noItems')} />;
  return (
    <ul className="space-y-2">
      {items.map((it, i) => {
        const Icon = ITEM_ICON[it.kind] ?? Target;
        return (
          <li key={it.id ?? i} className="flex items-start gap-3 rounded-2xl border border-line p-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary" aria-hidden>
              <Icon className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-base font-medium">{pick(it.title, it.title_ar)}</span>
                <Badge>{te('item.', it.kind)}</Badge>
              </div>
              {it.detail && (
                <p dir="auto" className="mt-0.5 text-sm text-fg-muted">
                  {it.detail}
                </p>
              )}
              {it.schedule && (it.schedule.times?.length || it.schedule.times_per_day) ? (
                <p className="mt-0.5 text-sm text-fg-muted">
                  {it.schedule.times?.length ? <span className="num">{it.schedule.times.join(' · ')}</span> : it.schedule.times_per_day === 1 ? t('care.oncePerDay') : t('care.timesPerDay', { n: it.schedule.times_per_day ?? 0 })}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function CarePlanView({ plan, showWhatChanged = true }: { plan: CarePlan; showWhatChanged?: boolean }) {
  const { t, pick, fmt, te } = useLocale();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold">{plan.title}</h3>
        <Badge tone="primary">{t('care.planVersion', { v: plan.version })}</Badge>
        <Badge tone={plan.status === 'ACTIVE' || plan.status === 'PUBLISHED' ? 'ok' : 'neutral'}>{te('plan.status.', plan.status)}</Badge>
      </div>
      <div className="flex flex-wrap gap-x-3 text-sm text-fg-muted">
        {plan.published_at && <span>{t('care.publishedAt', { d: fmt.date(plan.published_at) })}</span>}
        {plan.authored_by && <span>{t('care.authoredBy', { n: plan.authored_by })}</span>}
      </div>
      {(plan.summary || plan.summary_ar) && (
        <p dir="auto" className="text-base leading-7 text-fg">
          {pick(plan.summary, plan.summary_ar)}
        </p>
      )}

      {showWhatChanged && plan.what_changed && (
        <Card tone="primary">
          <div className="mb-1.5 text-sm font-semibold text-primary-strong">{t('care.whatChanged')}</div>
          <AiBlock>{pick(plan.what_changed.en, plan.what_changed.ar)}</AiBlock>
        </Card>
      )}

      <div>
        <h3 className="mb-2 text-base font-semibold">{t('care.targets')}</h3>
        <CarePlanTargetsGrid plan={plan} />
      </div>
      <div>
        <h3 className="mb-2 text-base font-semibold">{t('care.items')}</h3>
        <CarePlanItems items={plan.items} />
      </div>
    </div>
  );
}
