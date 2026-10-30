'use client';

import { useState } from 'react';
import { Activity, HeartHandshake, Target, Stethoscope, Utensils, UserCog, Wand2 } from 'lucide-react';
import type { CarePlanTargets, Preferences, TherapyDecision, TherapyItem, UUID } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import { useAuth } from '@/lib/auth';
import { CLINICIAN_ROLES, hasRole } from '@/lib/roles';
import { Card, CardHeader } from '../Card';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { Field, Select, Textarea } from '../Field';
import { SkeletonCard } from '../Skeleton';
import { ErrorState } from '../EmptyState';
import { useErrorToast, useToast } from '../Toast';
import { FoodProfileView } from '../patient/FoodProfile';

const DECISIONS: TherapyDecision[] = ['started', 'not_appropriate', 'patient_declined', 'cost', 'later'];

/**
 * Personalized care for the clinician (engine 32_personal.js): suggested personal targets, treatment considerations,
 * the person's food response and preferences. Rule outputs that support the clinician's decision; nothing here reaches
 * the patient unless the doctor puts it in the care plan.
 */
export function PersonalizationPanel({ patientId }: { patientId: UUID }) {
  const { t, pick, te, fmt } = useLocale();
  const { user } = useAuth();
  const q = useApi('provider', 'personalization', { patient_id: patientId });
  const [deciding, setDeciding] = useState<TherapyItem | null>(null);
  if (q.loading && !q.data) return <SkeletonCard lines={6} />;
  if (q.error && !q.data) return <ErrorState compact error={q.error} onRetry={() => void q.reload()} />;
  const d = q.data;
  if (!d) return null;
  const canDecide = hasRole(user?.role, CLINICIAN_ROLES);
  const hidden = Array.isArray(d.therapy.hidden) ? d.therapy.hidden : [];
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader title={<span className="inline-flex items-center gap-2"><Target className="size-5 text-primary" aria-hidden />{t('pers.targets')}</span>}
          subtitle={t('pers.targetsHint')} action={<Badge tone={d.targets.tier === 'standard' ? 'neutral' : 'info'}>{te('pers.tier.', d.targets.tier)}</Badge>} />
        {d.targets.suggested ? (
          <div className="grid grid-cols-3 gap-2 text-center">
            {([['hba1c_target', 'HbA1c <', '%'], ['tir_target', 'TIR >', '%'], ['tbr_max', 'TBR <', '%']] as const).map(([k, label, unit]) => (
              <div key={k} className="rounded-xl bg-surface-2 px-2 py-2">
                <div className="text-xs text-fg-muted">{label}</div>
                <div className="num text-lg font-bold">{d.targets.suggested![k]}{unit}</div>
                {d.targets.current[k as keyof CarePlanTargets] !== undefined && d.targets.current[k as keyof CarePlanTargets] !== d.targets.suggested![k] && (
                  <div className="num text-xs text-fg-subtle">{t('pers.now', { v: String(d.targets.current[k as keyof CarePlanTargets]) })}</div>
                )}
              </div>
            ))}
          </div>
        ) : null}
        <ul className="mt-3 list-disc space-y-1 ps-5 text-sm">
          {d.targets.reasons.map((r) => (
            <li key={r.key}>{pick(r.en, r.ar)} <span className="text-fg-subtle">({r.ref})</span></li>
          ))}
        </ul>
        {d.targets.differs_from_plan && <p className="mt-2 text-sm font-medium text-info-fg">{t('pers.differs')}</p>}
      </Card>

      <Card>
        <CardHeader title={<span className="inline-flex items-center gap-2"><Stethoscope className="size-5 text-primary" aria-hidden />{t('pers.therapy')}</span>}
          subtitle={t('pers.therapyHint')} />
        {d.therapy.items.length === 0 ? (
          <p className="text-sm text-fg-muted">{d.therapy.not_applicable ? t('pers.therapyNA') : t('pers.therapyNone')}</p>
        ) : (
          <ul className="space-y-2">
            {d.therapy.items.map((x) => (
              <li key={x.code} className="rounded-xl border border-line p-3">
                <div className="flex flex-wrap items-start gap-2">
                  <Badge tone={x.kind === 'review' ? 'warn' : 'info'}>{te('pers.kind.', x.kind)}</Badge>
                  <span className="min-w-0 flex-1 text-sm font-medium">{pick(x.title_en, x.title_ar)}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-fg-muted">
                  <span>{x.ref}{x.cost_band ? ` · ${t('pers.cost')}: ${te('pers.costBand.', x.cost_band)}` : ''}</span>
                  {canDecide && <Button size="xs" variant="soft" onClick={() => setDeciding(x)}>{t('pers.decide')}</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {hidden.length > 0 && (
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-fg-muted">{t('pers.decided', { n: hidden.length })}</summary>
            <ul className="mt-2 space-y-1">
              {hidden.map((x) => (
                <li key={x.code} className="text-fg-muted">
                  {pick(x.title_en, x.title_ar)} — <span className="font-medium">{x.review ? te('pers.decision.', x.review.decision) : ''}</span>
                  {x.review?.at ? ` (${fmt.date(x.review.at)})` : ''}{x.review?.note ? `: ${x.review.note}` : ''}
                </li>
              ))}
            </ul>
          </details>
        )}
        <p className="mt-3 text-xs leading-5 text-fg-subtle">{t('pers.therapyDisclaimer')}</p>
      </Card>

      <Card>
        <CardHeader title={<span className="inline-flex items-center gap-2"><Utensils className="size-5 text-primary" aria-hidden />{t('food.titlePro')}</span>} subtitle={t('food.subtitle', { n: d.food.days })} />
        <FoodProfileView profile={d.food} compact pro />
      </Card>

      <Card>
        <CardHeader title={<span className="inline-flex items-center gap-2"><UserCog className="size-5 text-primary" aria-hidden />{t('prefs.titlePro')}</span>} subtitle={t('prefs.clinicianHint')} />
        <PreferencesSummary p={d.preferences} />
      </Card>

      <Card>
        <CardHeader title={<span className="inline-flex items-center gap-2"><Activity className="size-5 text-primary" aria-hidden />{t('kfre.title')}</span>} subtitle={d.kidney_risk.ref ?? t('kfre.hint')} />
        {d.kidney_risk.eligible ? (
          <>
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="rounded-xl bg-surface-2 p-2"><div className="text-xs text-fg-muted">{t('kfre.two')}</div><div className="num text-lg font-bold">{d.kidney_risk.two_year_pct}%</div></div>
              <div className="rounded-xl bg-surface-2 p-2"><div className="text-xs text-fg-muted">{t('kfre.five')}</div><div className="num text-lg font-bold">{d.kidney_risk.five_year_pct}%</div></div>
            </div>
            <p className="num mt-2 text-xs text-fg-muted">eGFR {d.kidney_risk.inputs?.egfr} · ACR {d.kidney_risk.inputs?.uacr} mg/g · {d.kidney_risk.inputs?.age}</p>
            {d.kidney_risk.refer && <p className="mt-2 text-sm font-medium text-warn-fg">{t('kfre.refer')}</p>}
          </>
        ) : <p className="text-sm text-fg-muted">{t('kfre.na')}</p>}
      </Card>

      <Card>
        <CardHeader title={<span className="inline-flex items-center gap-2"><HeartHandshake className="size-5 text-primary" aria-hidden />{t('wb.clinTitle')}</span>} subtitle={t('wb.clinHint')} />
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {(['paid5', 'phq9', 'phq2', 'stopbang'] as const).map((k) => {
            const x = d.wellbeing[k];
            return (
              <div key={k} className="contents">
                <dt className="text-fg-muted">{te('wb.kind.', k)}</dt>
                <dd>{x ? <><span className="num font-semibold">{x.score}</span> · {x.band} · {fmt.date(x.at)}</> : '—'}</dd>
              </div>
            );
          })}
        </dl>
        {d.sick_day.active && (
          <p className="mt-3 rounded-xl bg-warn-soft px-3 py-2 text-sm font-medium text-warn-fg">{t('sick.clinActive', { d: fmt.dateTime(d.sick_day.started_at!) })}</p>
        )}
      </Card>

      <DecisionDialog item={deciding} patientId={patientId} onClose={() => setDeciding(null)} onDone={() => void q.reload(true)} />
    </div>
  );
}

function PreferencesSummary({ p }: { p: Preferences }) {
  const { t, te } = useLocale();
  const rows: [string, string | null][] = [
    [t('prefs.simple'), p.simple_words === null ? null : p.simple_words ? t('common.yes') : t('common.no')],
    [t('prefs.voice'), p.prefers_voice === null ? null : p.prefers_voice ? t('common.yes') : t('common.no')],
    [t('prefs.meals'), p.meal_pattern ? te('prefs.meal.', p.meal_pattern) : null],
    [t('prefs.shift'), p.work_shift ? te('prefs.shiftV.', p.work_shift) : null],
    [t('prefs.sleep'), p.sleep_time && p.wake_time ? `${p.sleep_time} – ${p.wake_time}` : null],
    [t('prefs.budget'), p.budget_sensitive === null ? null : p.budget_sensitive ? t('common.yes') : t('common.no')],
    [t('prefs.cooks'), p.who_cooks ? te('prefs.cook.', p.who_cooks) : null],
    [t('prefs.fasting'), p.fasting_days && p.fasting_days.length ? p.fasting_days.map((x) => te('prefs.day.', x)).join('، ') : null],
    [t('prefs.goals'), p.goals_text],
  ];
  const filled = rows.filter(([, v]) => v);
  if (!filled.length) return <p className="text-sm text-fg-muted">{t('prefs.none')}</p>;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {filled.map(([k, v]) => (
        <div key={k} className="contents"><dt className="text-fg-muted">{k}</dt><dd><bdi>{v}</bdi></dd></div>
      ))}
    </dl>
  );
}

function DecisionDialog({ item, patientId, onClose, onDone }: { item: TherapyItem | null; patientId: UUID; onClose: () => void; onDone: () => void }) {
  const { t, te, pick } = useLocale();
  const { mutate, pending } = useMutation();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [decision, setDecision] = useState<TherapyDecision>('started');
  const [note, setNote] = useState('');
  async function save() {
    if (!item) return;
    try {
      await mutate('provider', 'therapy_review', { patient_id: patientId, code: item.code, decision, note: note.trim() || undefined });
      toast(t('common.saved'));
      setNote('');
      onDone();
      onClose();
    } catch (e) {
      errorToast(e);
    }
  }
  return (
    <Dialog open={!!item} onClose={onClose} title={t('pers.decide')} description={item ? pick(item.title_en, item.title_ar) : undefined}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button loading={pending} onClick={() => void save()}>{t('common.save')}</Button></>}>
      <div className="space-y-4">
        <Field label={t('pers.decisionLabel')}>
          <Select value={decision} onChange={(e) => setDecision(e.target.value as TherapyDecision)}>
            {DECISIONS.map((x) => <option key={x} value={x}>{te('pers.decision.', x)}</option>)}
          </Select>
        </Field>
        <Field label={t('pers.note')} hint={t('pers.noteHint')}>
          <Textarea rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/** Care plan builder: fill the targets with the suggested personal targets (the doctor can still edit them). */
export function SuggestedTargetsButton({ patientId, onUse }: { patientId: UUID; onUse: (s: CarePlanTargets) => void }) {
  const { t, te } = useLocale();
  const q = useApi('provider', 'personalization', { patient_id: patientId });
  const s = q.data?.targets.suggested;
  if (!s) return null;
  return (
    <Button size="xs" variant="soft" icon={<Wand2 className="size-3.5" />} onClick={() => onUse({
      hba1c_target: s.hba1c_target, tir_target: s.tir_target, tbr_max: s.tbr_max, fasting_low: s.fasting_low, fasting_high: s.fasting_high, post_meal_high: s.post_meal_high,
    })}>
      {t('pers.useSuggested', { tier: te('pers.tier.', q.data!.targets.tier) })}
    </Button>
  );
}
