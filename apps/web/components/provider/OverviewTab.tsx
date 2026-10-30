'use client';

import { useState, type ReactNode } from 'react';
import type { GlucoseMetrics, PatientState, Workspace } from '@health/api-client';
import { Button } from '../Button';
import { useLocale } from '@/lib/locale';
import { useAuth } from '@/lib/auth';
import { CLINICIAN_ROLES, hasRole } from '@/lib/roles';
import { cn } from '@/lib/cn';
import type { TKey } from '@/lib/i18n';
import { Badge, type BadgeTone } from '../Badge';
import { Card, CardHeader } from '../Card';
import { EmptyState } from '../EmptyState';
import { DataQualityBadge, Freshness, GlycemicStateChip } from '../StatusBadges';
import { TirStrip } from '../TirBar';
import { AppointmentRow, PatternRow, SafetyFindingCard, ScreeningRow } from '../domain/Rows';
import { GLUCOSE_STALE_MIN_CGM, GLUCOSE_STALE_MIN_MANUAL } from '@/lib/glucose';

function stateTone(key: keyof PatientState, v: string | null): BadgeTone {
  if (!v) return 'neutral';
  switch (key) {
    case 'medication_state':
      return v === 'adherent' ? 'ok' : v === 'partially_adherent' ? 'warn' : v === 'non_adherent' ? 'danger' : 'neutral';
    case 'care_plan_state':
      return v === 'active' ? 'ok' : v === 'draft' ? 'warn' : 'neutral';
    case 'screening_state':
      return v === 'up_to_date' ? 'ok' : 'warn';
    case 'safety_state':
      return v === 'stable' ? 'ok' : v === 'severe_hypoglycemia' ? 'solid-danger' : 'danger';
    case 'engagement_state':
      return v === 'active' ? 'ok' : v === 'low' ? 'warn' : 'danger';
    case 'episode_state':
      return 'warn';
    default:
      return 'neutral';
  }
}

export function StateChips({ s }: { s: PatientState }) {
  const { t, te } = useLocale();
  const rows: { label: TKey; node: ReactNode }[] = [
    { label: 'state.glycemic', node: <GlycemicStateChip state={s.glycemic_state} /> },
    { label: 'state.medication', node: <Badge tone={stateTone('medication_state', s.medication_state)}>{te('ms.', s.medication_state)}</Badge> },
    { label: 'state.carePlan', node: <Badge tone={stateTone('care_plan_state', s.care_plan_state)}>{te('cps.', s.care_plan_state)}</Badge> },
    { label: 'state.screening', node: <Badge tone={stateTone('screening_state', s.screening_state)}>{te('scr.', s.screening_state)}</Badge> },
    { label: 'state.safety', node: <Badge tone={stateTone('safety_state', s.safety_state)}>{te('ss.', s.safety_state)}</Badge> },
    { label: 'state.episode', node: s.episode_state ? <Badge tone="warn">{te('ep.', s.episode_state)}</Badge> : <Badge>{t('common.none')}</Badge> },
    { label: 'state.engagement', node: <Badge tone={stateTone('engagement_state', s.engagement_state)}>{te('es.', s.engagement_state)}</Badge> },
    { label: 'state.dataQuality', node: <DataQualityBadge quality={s.data_quality} /> },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {rows.map((r) => (
        <div key={r.label} className="rounded-xl border border-line bg-surface p-2.5">
          <div className="mb-1 text-xs text-fg-muted">{t(r.label)}</div>
          {r.node}
        </div>
      ))}
    </div>
  );
}

function MetricsCompare({ a, b }: { a: GlucoseMetrics; b: GlucoseMetrics }) {
  const { t, fmt } = useLocale();
  const tbr = (m: GlucoseMetrics) => (m.tbr_level1 === null && m.tbr_level2 === null ? null : (m.tbr_level1 ?? 0) + (m.tbr_level2 ?? 0));
  // `v` is the number compared between the two periods (when it is not simply the metric under `key`)
  const rows: { label: TKey; f: (m: GlucoseMetrics) => string; better?: 'up' | 'down'; key: keyof GlucoseMetrics; v?: (m: GlucoseMetrics) => number | null }[] = [
    { label: 'pvm.tir', f: (m) => fmt.pct(m.tir), better: 'up', key: 'tir' },
    { label: 'pvm.tbr', f: (m) => fmt.pct(tbr(m)), better: 'down', key: 'tbr_level1', v: tbr },
    { label: 'pvm.mean', f: (m) => fmt.number(m.mean), better: 'down', key: 'mean' },
    { label: 'pvm.gmi', f: (m) => (m.gmi === null ? '—' : `${fmt.number(m.gmi, 1)}%`), better: 'down', key: 'gmi' },
    { label: 'pvm.cv', f: (m) => fmt.pct(m.cv, 1), better: 'down', key: 'cv' },
    { label: 'pvm.fasting', f: (m) => fmt.number(m.fasting_mean), better: 'down', key: 'fasting_mean' },
    { label: 'pvm.coverage', f: (m) => fmt.pct(m.coverage_pct), key: 'coverage_pct' },
    { label: 'pvm.readings', f: (m) => fmt.number(m.readings), key: 'readings' },
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-fg-muted">
          <tr>
            <th className="py-1.5 text-start font-medium">{t('pv.metric')}</th>
            <th className="py-1.5 text-end font-medium">{t('pv.d14')}</th>
            <th className="py-1.5 text-end font-medium">{t('pv.d90')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => {
            const va = r.v ? r.v(a) : (a[r.key] as number | null);
            const vb = r.v ? r.v(b) : (b[r.key] as number | null);
            let tone = '';
            if (r.better && typeof va === 'number' && typeof vb === 'number' && va !== vb) {
              const improved = r.better === 'up' ? va > vb : va < vb;
              tone = improved ? 'text-ok' : 'text-warn';
            }
            return (
              <tr key={r.label}>
                <td className="py-1.5 text-fg-muted">{t(r.label)}</td>
                <td className={cn('tabular-nums py-1.5 text-end font-semibold', tone)}>{r.f(a)}</td>
                <td className="tabular-nums py-1.5 text-end text-fg-muted">{r.f(b)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-3 space-y-1.5">
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <span className="w-10">{t('pv.d14')}</span>
          <TirStrip metrics={a} className="flex-1" />
        </div>
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <span className="w-10">{t('pv.d90')}</span>
          <TirStrip metrics={b} className="flex-1" />
        </div>
      </div>
    </div>
  );
}

export function OverviewTab({ ws, onAckFinding }: { ws: Workspace; onAckFinding: (id: string) => Promise<void> }) {
  const { t, pick, fmt } = useLocale();
  const open = ws.health.safety_findings.filter((f) => f.status === 'open');
  const m = ws.metrics_14d;
  return (
    <div className="space-y-4">
      <StateChips s={ws.state} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            title={t('pv.metrics14v90')}
            action={<Freshness at={m.latest?.measured_at ?? null} ageMinutes={m.latest?.age_minutes ?? null} staleAfterMin={m.cgm ? GLUCOSE_STALE_MIN_CGM : GLUCOSE_STALE_MIN_MANUAL} />}
          />
          <MetricsCompare a={ws.metrics_14d} b={ws.metrics_90d} />
        </Card>
        <Card tone={open.length ? 'warn' : 'default'}>
          <CardHeader title={t('pv.openFindings')} />
          {open.length === 0 ? (
            <EmptyState compact title={t('pv.noFindings')} />
          ) : (
            <div className="space-y-2">
              {open.map((f) => (
                <SafetyFindingCard key={f.id} pro f={f} action={<AckButton onClick={() => onAckFinding(f.id)} />} />
              ))}
            </div>
          )}
        </Card>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title={t('glu.patterns')} />
          {ws.patterns.length === 0 ? (
            <EmptyState compact title={t('glu.noPatterns')} />
          ) : (
            <div className="space-y-2">
              {ws.patterns.map((p, i) => (
                <PatternRow key={`${p.type}-${i}`} p={p} />
              ))}
            </div>
          )}
        </Card>
        <Card>
          <CardHeader title={t('care.screenings')} />
          {ws.screenings.length === 0 ? (
            <EmptyState compact title={t('care.noScreenings')} />
          ) : (
            <div className="space-y-2">
              {ws.screenings.filter((s) => s.overdue).map((s) => (
                <ScreeningRow key={s.type} s={s} />
              ))}
              {ws.screenings.some((s) => !s.overdue) && (
                <p className="text-sm text-fg-muted">{t('care.screeningsOk', { n: ws.screenings.filter((s) => !s.overdue).length })}</p>
              )}
            </div>
          )}
        </Card>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title={t('pv.upcoming')} />
          {ws.appointments.filter((a) => a.status !== 'cancelled').length === 0 ? (
            <EmptyState compact title={t('care.noAppts')} />
          ) : (
            <div className="space-y-2">
              {ws.appointments.filter((a) => a.status !== 'cancelled').slice(0, 3).map((a) => (
                <AppointmentRow key={a.id} pro appt={a} />
              ))}
            </div>
          )}
        </Card>
        <Card>
          <CardHeader title={t('pv.recentInsights')} />
          {ws.insights.length === 0 ? (
            <EmptyState compact title={t('today.noInsights')} />
          ) : (
            <ul className="divide-y divide-line">
              {ws.insights.slice(0, 4).map((i) => (
                <li key={i.id} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                  <span dir="auto" className="min-w-0 font-medium">{pick(i.title, i.title_ar)}</span>
                  <span className="shrink-0 text-xs text-fg-subtle">{fmt.relative(i.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}


export function AckButton({ onClick }: { onClick: () => Promise<void> }) {
  const { t } = useLocale();
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  if (!hasRole(user?.role, CLINICIAN_ROLES)) return null; // acknowledging is a clinical act
  return (
    <Button
      size="xs"
      variant="outline"
      loading={busy}
      onClick={() => {
        setBusy(true);
        void onClick().finally(() => setBusy(false));
      }}
    >
      {t('pv.acknowledge')}
    </Button>
  );
}
