'use client';

import { useState, type ReactNode } from 'react';
import { AlertOctagon, BadgeCheck, Clock, Gauge, PackageOpen, XCircle } from 'lucide-react';
import type { Allergy, Condition, HealthSummary, LabResult, Medication, TimelineEvent, Vital } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { useMutation } from '@/lib/useApi';
import { useAuth } from '@/lib/auth';
import { CLINICIAN_ROLES, hasRole } from '@/lib/roles';
import { cn } from '@/lib/cn';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { Card } from '../Card';
import { EmptyState } from '../EmptyState';
import { SeverityBadge, VerificationBadge } from '../StatusBadges';
import { InfoTip } from '../InfoTip';
import { useErrorToast } from '../Toast';
import { ShowMoreList } from '../ShowMoreList';
import { hasKey, type TKey } from '@/lib/i18n';

type VerifyEntity = 'condition' | 'allergy' | 'medication' | 'lab';

/** Verify / refute buttons for clinicians (clinical.verify). */
export function VerifyButtons({
  entity,
  id,
  onDone,
}: {
  entity: VerifyEntity;
  id: string;
  onDone: (status: 'verified' | 'refuted') => void;
}) {
  const { t } = useLocale();
  const { user } = useAuth();
  const { mutate } = useMutation();
  const errorToast = useErrorToast();
  const [busy, setBusy] = useState<string | null>(null);
  async function run(status: 'verified' | 'refuted') {
    setBusy(status);
    try {
      await mutate('clinical', 'verify', { entity, id, status });
      onDone(status);
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(null);
    }
  }
  if (!hasRole(user?.role, CLINICIAN_ROLES)) return null; // only doctors and nurses confirm clinical facts
  return (
    <div className="flex gap-1">
      <Button size="xs" variant="soft" icon={<BadgeCheck className="size-3.5" />} loading={busy === 'verified'} onClick={() => void run('verified')}>
        {t('ver.verify')}
      </Button>
      <Button size="xs" variant="ghost" icon={<XCircle className="size-3.5" />} loading={busy === 'refuted'} onClick={() => void run('refuted')}>
        {t('ver.refute')}
      </Button>
    </div>
  );
}

function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-3', className)}>{children}</div>;
}

export function ConditionList({
  items,
  verifiable,
  onVerified,
  onToggle,
}: {
  items: Condition[];
  verifiable?: boolean;
  onVerified?: (id: string, s: 'verified' | 'refuted') => void;
  /** Marks a condition as no longer present (or present again). */
  onToggle?: (c: Condition) => void;
}) {
  const { t, pick, fmt, te } = useLocale();
  if (!items.length) return <EmptyState compact title={t('health.noConditions')} />;
  return (
    <div className="space-y-2">
      {items.map((c) => (
        <Row key={c.id}>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-base font-medium">{pick(c.display, c.display_ar)}</span>
              {/* diagnosis codes are for staff */}
              {verifiable && c.code && <Badge>{c.code}</Badge>}
              <Badge tone={c.status === 'active' ? 'primary' : 'neutral'}>{c.status === 'active' ? t('health.active') : t('health.resolved')}</Badge>
              <VerificationBadge status={c.verification_status} />
            </div>
            <div className="mt-0.5 text-sm text-fg-muted">
              {c.onset_date && <>{t('health.onset')}: {fmt.date(c.onset_date)} · </>}
              {te('src.', c.source)}
            </div>
          </div>
          {verifiable && c.verification_status === 'unverified' && (
            <VerifyButtons entity="condition" id={c.id} onDone={(s) => onVerified?.(c.id, s)} />
          )}
          {onToggle && (
            <Button size="sm" variant="ghost" onClick={() => onToggle(c)}>
              {t(c.status === 'active' ? 'health.conditionResolve' : 'health.conditionReactivate')}
            </Button>
          )}
        </Row>
      ))}
    </div>
  );
}

export function MedicationList({
  items,
  verifiable,
  onVerified,
  onStop,
  onEdit,
  onCount,
}: {
  items: Medication[];
  verifiable?: boolean;
  onVerified?: (id: string, s: 'verified' | 'refuted') => void;
  onStop?: (m: Medication) => void;
  onEdit?: (m: Medication) => void;
  /** "Count what's left": opens the supply dialog (SupplyDialog). */
  onCount?: (m: Medication) => void;
}) {
  const { t, te, fmt } = useLocale();
  const [showStopped, setShowStopped] = useState(false);
  if (!items.length) return <EmptyState compact title={t('health.noMeds')} />;
  const all = [...items].sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1));
  // People see current medicines first; stopped ones stay one tap away.
  const stoppedCount = all.filter((m) => m.status === 'stopped').length;
  const sorted = verifiable || showStopped ? all : all.filter((m) => m.status === 'active');
  return (
    <div className="space-y-2">
      {sorted.map((m) => (
        <Row key={m.id} className={m.status === 'stopped' ? 'opacity-60' : undefined}>
          <div className="min-w-0 flex-1 basis-full sm:basis-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <bdi className="text-base font-semibold">{m.name}</bdi>
              {m.generic && m.generic.toLowerCase() !== m.name.toLowerCase() && <bdi className="text-sm text-fg-muted">({m.generic})</bdi>}
              {verifiable && m.drug_class && <Badge>{m.drug_class.replace(/_/g, ' ')}</Badge>}
              {m.status === 'stopped' && <Badge tone="neutral">{t('health.stopped')}</Badge>}
              <VerificationBadge status={m.verification_status} />
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-fg-muted">
              {m.dose_text && <bdi>{m.dose_text}</bdi>}
              {m.frequency && <bdi>{m.frequency}</bdi>}
              {m.times.length > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3" />
                  <span className="num">{m.times.join(' · ')}</span>
                </span>
              )}
              <span>{te('src.', m.source)}</span>
            </div>
            {m.status === 'active' && m.supply && (
              <div className={cn('mt-1 flex items-center gap-1 text-sm', m.supply.refill_due ? 'font-semibold text-warn-fg' : 'text-fg-muted')}>
                <PackageOpen className="size-3.5" aria-hidden />
                {m.supply.days_left === null
                  ? t('supply.left', { n: m.supply.remaining })
                  : m.supply.days_left <= 0
                    ? t('refill.today')
                    : t('supply.leftDays', { n: m.supply.days_left, date: m.supply.runs_out_on ? fmt.date(m.supply.runs_out_on) : '' })}
              </div>
            )}
          </div>
          {m.adherence_7d !== null && (
            <div className="w-full min-w-0 flex-1 sm:w-48 sm:flex-none">
              <div className="flex items-baseline justify-between gap-2 text-sm text-fg-muted">
                <span>{t('health.adherence')}</span>
                <span className="num shrink-0 font-semibold text-fg">{fmt.pct(m.adherence_7d)}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div
                  className={cn('h-full rounded-full', m.adherence_7d >= 80 ? 'bg-ok' : m.adherence_7d >= 50 ? 'bg-warn' : 'bg-danger-solid')}
                  style={{ width: `${m.adherence_7d}%` }}
                />
              </div>
            </div>
          )}
          <div className="flex gap-1">
            {verifiable && m.verification_status === 'unverified' && (
              <VerifyButtons entity="medication" id={m.id} onDone={(s) => onVerified?.(m.id, s)} />
            )}
            {onCount && m.status === 'active' && (
              <Button size="sm" variant="ghost" onClick={() => onCount(m)}>
                {t('supply.countBtn')}
              </Button>
            )}
            {onEdit && m.status === 'active' && (
              <Button size="sm" variant="ghost" onClick={() => onEdit(m)}>
                {t('common.edit')}
              </Button>
            )}
            {onStop && m.status === 'active' && (
              <Button size="sm" variant="ghost" onClick={() => onStop(m)}>
                {t('health.stop')}
              </Button>
            )}
          </div>
        </Row>
      ))}
      {!verifiable && stoppedCount > 0 && (
        <button type="button" onClick={() => setShowStopped((x) => !x)} aria-expanded={showStopped} className="min-h-11 text-base font-semibold text-primary-strong hover:underline">
          {showStopped ? t('common.less') : t('health.showStopped', { n: stoppedCount })}
        </button>
      )}
    </div>
  );
}

export function AllergyList({
  items,
  verifiable,
  onVerified,
  onRemove,
}: {
  items: Allergy[];
  verifiable?: boolean;
  onVerified?: (id: string, s: 'verified' | 'refuted') => void;
  onRemove?: (a: Allergy) => void;
}) {
  const { t, te } = useLocale();
  const shown = verifiable ? items : items.filter((a) => (a.status ?? 'active') === 'active');
  if (!shown.length) return <EmptyState compact title={t('health.noAllergies')} />;
  return (
    <div className="space-y-2">
      {shown.map((a) => (
        <Row key={a.id}>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-base font-semibold">{a.substance}</span>
              {a.substance_class && <Badge>{a.substance_class}</Badge>}
              <SeverityBadge severity={a.severity} />
              <VerificationBadge status={a.verification_status} />
              {a.status === 'inactive' && <Badge tone="neutral">{t('health.allergyRemoved')}</Badge>}
            </div>
            <div className="mt-0.5 text-sm text-fg-muted">
              {a.reaction && <span className="text-fg">{a.reaction} · </span>}
              {te('src.', a.source)}
            </div>
          </div>
          {verifiable && a.verification_status === 'unverified' && a.status !== 'inactive' && (
            <VerifyButtons entity="allergy" id={a.id} onDone={(s) => onVerified?.(a.id, s)} />
          )}
          {onRemove && (
            <Button size="sm" variant="ghost" onClick={() => onRemove(a)}>
              {t('common.remove')}
            </Button>
          )}
        </Row>
      ))}
    </div>
  );
}

export function LabTable({
  items,
  verifiable,
  onVerified,
}: {
  items: LabResult[];
  verifiable?: boolean;
  onVerified?: (id: string, s: 'verified' | 'refuted') => void;
}) {
  const { t, te, fmt, locale } = useLocale();
  if (!items.length) return <EmptyState compact title={t('health.noLabs')} />;
  const sorted = [...items].sort((a, b) => b.observed_at.localeCompare(a.observed_at));
  const ar = locale === 'ar';
  if (!verifiable) {
    // People see one card per test: the latest result in plain words, how it moved, and earlier results one tap away.
    const groups = Array.from(new Set(sorted.map((l) => l.test_code))).map((code) => sorted.filter((l) => l.test_code === code));
    return (
      <ul className="grid gap-2 sm:grid-cols-2">
        {groups.map((g) => {
          const l = g[0];
          const prev = g[1];
          const delta = prev ? l.value - prev.value : 0;
          // The lab's "normal" HbA1c range is for people without diabetes; with diabetes the usual goal is below 7%.
          const a1c = l.test_code === 'hba1c';
          const flagged = !a1c && !!l.flag && l.flag !== 'normal';
          const helpKey = `help.${l.test_code}`;
          const range =
            l.ref_low !== null && l.ref_high !== null
              ? `${l.ref_low}–${l.ref_high}`
              : l.ref_high !== null
                ? t('health.rangeBelow', { n: l.ref_high })
                : l.ref_low !== null
                  ? t('health.rangeAbove', { n: l.ref_low })
                  : null;
          return (
            <li key={l.test_code} className={cn('rounded-2xl border bg-surface p-4', l.critical ? 'border-2 border-danger/60' : 'border-line')}>
              <div className="flex items-start justify-between gap-2">
                <span className="flex items-center gap-1 text-base font-semibold">
                  {labName(l.test_code, l.display, t, l.display_ar, ar)}
                  {hasKey(helpKey) && <InfoTip text={helpKey} />}
                </span>
                <span className="flex flex-wrap justify-end gap-1">
                  {l.critical && <CriticalLabBadge />}
                  {flagged && <Badge tone={l.flag === 'high' ? 'warn' : 'danger'}>{te('flag.', l.flag!)}</Badge>}
                </span>
              </div>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className={cn('num text-2xl font-bold', flagged && (l.flag === 'high' ? 'text-warn-fg' : 'text-danger'))}>{fmt.number(l.value, 2)}</span>
                <span className="text-sm text-fg-muted">{l.unit}</span>
              </div>
              {a1c && <p className="mt-1 text-base leading-7 text-fg">{t(l.value < 7 ? 'health.a1cAtGoal' : l.value <= 8 ? 'health.a1cNearGoal' : 'health.a1cAboveGoal')}</p>}
              <div className="mt-1 text-sm text-fg-muted">
                {!a1c && range && (
                  <>
                    {t('health.refRange')}: <span className="num">{range}</span> ·{' '}
                  </>
                )}
                {fmt.date(l.observed_at)}
              </div>
              {prev && delta !== 0 && (
                <p className="mt-1 text-sm text-fg">
                  {t(delta > 0 ? 'health.labUp' : 'health.labDown', { n: fmt.number(Math.abs(delta), 2), d: fmt.date(prev.observed_at) })}
                </p>
              )}
              {g.length > 1 && (
                <details className="mt-1">
                  <summary className="inline-flex min-h-9 cursor-pointer items-center text-sm font-semibold text-primary-strong">
                    {t('health.earlierResults', { n: g.length - 1 })}
                  </summary>
                  <ul className="mt-1 space-y-1 text-sm text-fg-muted">
                    {g.slice(1).map((x) => (
                      <li key={x.id} className="flex justify-between gap-3">
                        <span className="num text-fg">
                          {fmt.number(x.value, 2)} {x.unit}
                        </span>
                        <span>{fmt.date(x.observed_at)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="mt-2">
                <VerificationBadge status={l.verification_status} />
              </div>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[36rem] text-sm">
        <thead className="bg-surface-2 text-xs text-fg-muted">
          <tr>
            <th className="px-3 py-2 text-start font-medium">{t('health.test')}</th>
            <th className="px-3 py-2 text-start font-medium">{t('common.value')}</th>
            <th className="px-3 py-2 text-start font-medium">{t('health.refRange')}</th>
            <th className="px-3 py-2 text-start font-medium">{t('health.observed')}</th>
            <th className="px-3 py-2 text-start font-medium">{t('common.status')}</th>
            {verifiable && <th className="px-3 py-2" />}
          </tr>
        </thead>
        <tbody className="divide-y divide-line bg-surface">
          {sorted.map((l) => (
            <tr key={l.id} className={cn(l.critical && 'bg-danger-soft/50')}>
              <td className="px-3 py-2.5">
                <div className="font-medium">{ar && l.display_ar ? l.display_ar : l.display}</div>
                <div className="text-xs text-fg-subtle">{l.test_code}</div>
                {l.critical && <CriticalLabBadge className="mt-1" />}
              </td>
              <td className="px-3 py-2.5">
                <span className={cn('num font-semibold', l.flag === 'high' && 'text-warn', l.flag === 'low' && 'text-danger')}>
                  {fmt.number(l.value, 2)}
                </span>{' '}
                <span className="text-xs text-fg-muted">{l.unit}</span>
                {l.flag && l.flag !== 'normal' && (
                  <Badge tone={l.flag === 'high' ? 'warn' : 'danger'} className="ms-1.5">
                    {te('flag.', l.flag)}
                  </Badge>
                )}
              </td>
              <td className="tabular-nums px-3 py-2.5 text-xs text-fg-muted">
                {l.ref_low !== null && l.ref_high !== null ? `${l.ref_low} – ${l.ref_high}` : l.ref_high !== null ? `< ${l.ref_high}` : l.ref_low !== null ? `> ${l.ref_low}` : '—'}
              </td>
              <td className="px-3 py-2.5 text-xs text-fg-muted">
                {fmt.date(l.observed_at)}
                <div className={cn(l.age_days > 180 && 'text-warn')}>{t('health.daysOld', { n: l.age_days })}</div>
              </td>
              <td className="px-3 py-2.5">
                <VerificationBadge status={l.verification_status} />
              </td>
              {verifiable && (
                <td className="px-3 py-2.5">
                  {l.verification_status === 'unverified' && <VerifyButtons entity="lab" id={l.id} onDone={(s) => onVerified?.(l.id, s)} />}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** `pro` keeps the dense mixed list for staff. People see one section per measurement with the latest value on top. */
export function VitalList({ items, pro }: { items: Vital[]; pro?: boolean }) {
  const { t, te, fmt } = useLocale();
  if (!items.length) return <EmptyState compact title={t('health.noVitals')} />;
  const sorted = [...items].sort((a, b) => b.measured_at.localeCompare(a.measured_at));
  const show = (v: Vital) => (v.type === 'blood_pressure' ? `${v.systolic ?? '—'}/${v.diastolic ?? '—'}` : fmt.number(v.value, 1));
  const unitOf = (v: Vital) => v.unit ?? (v.type === 'blood_pressure' ? 'mmHg' : '');
  if (!pro) {
    const types = Array.from(new Set(sorted.map((v) => v.type)));
    return (
      <div className="space-y-5">
        {types.map((tp) => {
          const list = sorted.filter((v) => v.type === tp);
          const last = list[0];
          const first = list[list.length - 1];
          const sys = last.systolic ?? 0;
          const dia = last.diastolic ?? 0;
          const bp = tp === 'blood_pressure' && sys > 0;
          const bpLevel = !bp ? null : sys >= 180 || dia >= 120 ? 'veryHigh' : sys >= 140 || dia >= 90 ? 'high' : sys < 90 || dia < 60 ? 'low' : 'ok';
          const change = tp === 'weight' && list.length > 1 && last.value !== null && first.value !== null ? last.value - first.value : null;
          return (
            <section key={tp}>
              <h3 className="mb-2 text-base font-semibold">{te('vital.', tp)}</h3>
              <div className="rounded-2xl border border-line bg-surface p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="num text-2xl font-bold">
                    {show(last)} <span className="text-sm font-normal text-fg-muted">{unitOf(last)}</span>
                  </div>
                  {bpLevel && <Badge tone={bpLevel === 'ok' ? 'ok' : bpLevel === 'veryHigh' ? 'danger' : 'warn'}>{t(`health.bp.${bpLevel}`)}</Badge>}
                </div>
                <p className="mt-0.5 text-sm text-fg-muted">{fmt.dateTime(last.measured_at)}</p>
                {bpLevel === 'veryHigh' && <p className="mt-1 text-base leading-7 text-fg">{t('health.bp.veryHighHint')}</p>}
                {change !== null && change !== 0 && (
                  <p className="mt-1 text-sm text-fg">
                    {t(change > 0 ? 'health.weightUp' : 'health.weightDown', { n: fmt.number(Math.abs(change), 1), d: fmt.date(first.measured_at) })}
                  </p>
                )}
              </div>
              {list.length > 1 && (
                <ShowMoreList
                  as="ul"
                  limit={3}
                  className="mt-2 divide-y divide-line rounded-2xl border border-line bg-surface px-4"
                  items={list.slice(1)}
                  render={(v) => (
                    <li key={v.id} className="flex items-baseline justify-between gap-3 py-2 text-base">
                      <span className="num font-medium">
                        {show(v)} <span className="text-sm font-normal text-fg-muted">{unitOf(v)}</span>
                      </span>
                      <span className="text-sm text-fg-muted">{fmt.dateTime(v.measured_at)}</span>
                    </li>
                  )}
                />
              )}
            </section>
          );
        })}
      </div>
    );
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {sorted.map((v) => (
        <Row key={v.id}>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-fg-muted">{te('vital.', v.type)}</div>
            <div className="num text-lg font-semibold">
              {v.type === 'blood_pressure' ? `${v.systolic ?? '—'}/${v.diastolic ?? '—'}` : fmt.number(v.value, 1)}{' '}
              <span className="text-xs font-normal text-fg-muted">{v.unit ?? (v.type === 'blood_pressure' ? 'mmHg' : '')}</span>
            </div>
          </div>
          <div className="text-end text-xs text-fg-muted">
            <div>{fmt.dateTime(v.measured_at)}</div>
            <div>{te('src.', v.source)}</div>
          </div>
        </Row>
      ))}
    </div>
  );
}

export function TimelineList({ items }: { items: TimelineEvent[] }) {
  const { t, te, fmt } = useLocale();
  if (!items.length) return <EmptyState compact title={t('health.noTimeline')} />;
  // The service sends record codes (follow_up, MATCHING, "uacr: 210 mg/g"); they are put into words here.
  const words = (e: TimelineEvent): { title: string; detail: string | null } => {
    const d = e.detail ?? '';
    switch (e.kind) {
      case 'appointment':
        return { title: te('apptType.', e.title), detail: d ? te('appt.', d) : null };
      case 'referral':
        return { title: t('tl.referralTo', { s: te('spec.', e.title.replace(/^Referral:\s*/, '')) }), detail: d ? te('rs.', d) : null };
      case 'lab': {
        const [code, ...rest] = e.title.split(': ');
        return { title: `${labName(code, code, t)}: ${rest.join(': ')}`, detail: d ? te('ver.', d) : null };
      }
      case 'glucose_event': {
        const m = e.title.match(/^(\w+) \((\d+(?:\.\d+)?) mg\/dL\)$/);
        return { title: m ? `${te('ge.', m[1])} · ${m[2]} ${t('common.mgdl')}` : e.title, detail: null };
      }
      case 'care_plan':
        return { title: e.title.replace(/ v(\d+)$/, (_, n: string) => ` · ${t('tl.version', { n })}`), detail: d ? te('plan.status.', d) : null };
      case 'medication':
        return { title: e.title, detail: d === 'stopped' ? t('health.stopped') : d === 'active' ? t('health.active') : null };
      case 'condition':
        return { title: e.title, detail: d ? te('ver.', d) : null };
      case 'episode':
        return { title: e.title, detail: d ? te('ep.', d) : null };
      case 'safety_finding':
        return { title: e.title, detail: d ? te('sev.', d) : null };
      default:
        return { title: e.title, detail: e.detail };
    }
  };
  return (
    <ol className="relative space-y-4 border-s-2 border-line ps-5">
      {items.map((e, i) => {
        const w = words(e);
        return (
          <li key={`${e.at}-${i}`} className="relative">
            <span className="absolute -start-[27px] top-1.5 size-3 rounded-full border-2 border-surface bg-primary" />
            <div className="flex flex-wrap items-center gap-2">
              <span dir="auto" className="text-base font-medium">
                {w.title}
              </span>
              <Badge>{te('tl.', e.kind)}</Badge>
            </div>
            {w.detail && <p className="mt-0.5 text-sm text-fg-muted">{w.detail}</p>}
            <p className="text-sm text-fg-muted">{fmt.dateTime(e.at)}</p>
          </li>
        );
      })}
    </ol>
  );
}

/** Plain-language lab test name when we know the code; otherwise the name from the lab. */
/** Name of a lab test: our translation when we have one, otherwise the lab's own name (its Arabic name in Arabic). */
export function labName(code: string, display: string, t: (k: TKey) => string, displayAr?: string | null, arabic?: boolean): string {
  const key = `lab.${code}`;
  if (hasKey(key)) return t(key);
  return arabic && displayAr ? displayAr : display;
}

/** A result at a critical limit (or a large change): the service has asked a doctor to look at it today. */
export function CriticalLabBadge({ className }: { className?: string }) {
  const { t } = useLocale();
  return (
    <Badge tone="solid-danger" icon={<AlertOctagon className="size-3" aria-hidden />} className={className}>
      {t('health.labCritical')}
    </Badge>
  );
}

/** `pro` shows the unit and CKD stage; people get the meaning in plain words instead. */
export function EgfrCard({ egfr, pro }: { egfr: HealthSummary['egfr']; pro?: boolean }) {
  const { t, fmt } = useLocale();
  const v = egfr.value;
  const tone = v === null ? 'muted' : v < 30 ? 'danger' : v < 60 ? 'warn' : 'default';
  const band = v === null ? null : v >= 90 ? 'normal' : v >= 60 ? 'mild' : v >= 30 ? 'moderate' : v >= 15 ? 'severe' : 'veryLow';
  return (
    <Card tone={tone} className="flex items-center gap-4">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-surface text-primary">
        <Gauge className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 text-base font-semibold">
          {t('health.egfr')}
          <InfoTip text="help.egfr" />
        </div>
        {!pro && band && <p className="text-base leading-6 text-fg">{t(`health.egfrBand.${band}`)}</p>}
        <div className="text-sm text-fg-muted">{egfr.observed_at ? fmt.date(egfr.observed_at) : t(pro ? 'common.noData' : 'health.egfrNone')}</div>
      </div>
      <div className="text-end">
        <div className="num text-2xl font-semibold">{v === null ? '—' : fmt.number(v)}</div>
        {pro && <div className="text-xs text-fg-muted">mL/min/1.73m²</div>}
        {pro && egfr.stage && <Badge tone={v !== null && v < 60 ? 'warn' : 'neutral'}>{t('health.egfrStage', { s: egfr.stage })}</Badge>}
      </div>
    </Card>
  );
}
