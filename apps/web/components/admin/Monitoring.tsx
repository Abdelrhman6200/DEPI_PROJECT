'use client';

import { useState } from 'react';
import { Activity, AlertOctagon, Gauge, Info, Scale, Siren, Timer, UserRound, Users } from 'lucide-react';
import type { CalibrationItem, JudgeDim, MonitoringKpi, StaffUser } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import { cn } from '@/lib/cn';
import { Card, CardHeader } from '../Card';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { Field, Textarea } from '../Field';
import { SkeletonCard } from '../Skeleton';
import { ErrorState } from '../EmptyState';
import { useErrorToast, useToast } from '../Toast';

const DIMS: JudgeDim[] = ['factual_accuracy', 'grounded', 'safety', 'format_adherence', 'bias'];

type Owner = 'W1' | 'W2' | 'W3' | 'W4' | 'W5';
const OWNERS: Owner[] = ['W1', 'W2', 'W3', 'W4', 'W5'];
/** A KPI with its workflow owner (engine 35_monitoring.js); the optional fields keep an older engine's answer readable. */
type Kpi = MonitoringKpi & { owner?: Owner; lower_is_better?: boolean; met?: boolean | null; baseline_note?: string | null; target_note?: string | null };
/** Owner of a KPI from an older engine that did not send one. */
const LEGACY_OWNER: Record<string, Owner> = { patients_logging_weekly: 'W1', medicines_taken: 'W1', answers_with_sources: 'W2', brief_ready_before_visit: 'W3', red_flags_routed: 'W5', urgent_ack_minutes: 'W5' };
const ownerOf = (key: string): Owner => LEGACY_OWNER[key] ?? 'W5';

/**
 * The monitoring dashboard (engine 35_monitoring.js): KPIs against baseline and target (one compact table per workflow owner, W1-W5), the judge's five rubric scores,
 * failed runs, response time, escalations, the nurse review queue, the five workflows, alerts and judge calibration.
 */
export function MonitoringTab() {
  const { t, te, fmt } = useLocale();
  const [days, setDays] = useState(7);
  const q = useApi('admin', 'monitoring', { days }, [days]);
  const [calibrating, setCalibrating] = useState<'A' | 'B' | null>(null);
  if (q.loading && !q.data) return <SkeletonCard lines={8} />;
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={() => void q.reload()} />;
  const m = q.data!;
  const tile = (icon: React.ReactNode, label: string, value: string, hint: string, warn?: boolean) => (
    <div className={cn('rounded-2xl border p-4', warn ? 'border-danger/40 bg-danger-soft' : 'border-line bg-surface')}>
      <div className="flex items-center gap-2 text-sm text-fg-muted">{icon}{label}</div>
      <div className="num mt-1 text-2xl font-bold">{value}</div>
      <p className="mt-1 text-xs text-fg-muted">{hint}</p>
    </div>
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {[1, 7, 30].map((d) => (
          <Button key={d} size="sm" variant={days === d ? 'primary' : 'outline'} onClick={() => setDays(d)}>{t('mon.days', { n: d })}</Button>
        ))}
      </div>
      <Card>
        <div className="flex gap-3 text-sm">
          <Info className="mt-0.5 size-5 shrink-0 text-primary" />
          <div className="space-y-1">
            <p className="font-semibold">{t('mon.howTitle')}</p>
            <p className="text-fg-muted">{t('mon.how1')}</p>
            <p className="text-fg-muted">{t('mon.how2')}</p>
            <p className="text-fg-muted">{t('mon.how3')}</p>
          </div>
        </div>
      </Card>
      {m.alerts.companion_paused && <ResumeCompanion onDone={() => void q.reload(true)} />}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {tile(<Scale className="size-4" />, t('mon.judged'), `${m.judge.judged} · ${m.judge.pass_rate ?? '—'}%`, t('mon.judgedHint'))}
        {tile(<AlertOctagon className="size-4" />, t('mon.failed'), `${m.failed_runs.ai}/${m.failed_runs.total} (${m.failed_runs.rate ?? 0}%)`, t('mon.failedHint'), (m.failed_runs.rate ?? 0) > 20)}
        {tile(<Timer className="size-4" />, t('mon.latency'), m.response_time_ms.companion_p50 ? `${(m.response_time_ms.companion_p50 / 1000).toFixed(1)} s · ${((m.response_time_ms.companion_p90 ?? 0) / 1000).toFixed(1)} s` : '—', t('mon.latencyHint'))}
        {tile(<Siren className="size-4" />, t('mon.escalations'), `${m.escalations.total} (${m.escalations.critical} ${t('mon.critical')})`, t('mon.escalationsHint'))}
        {tile(<Users className="size-4" />, t('mon.reviews'), `${m.reviews.pending} · ${m.reviews.overdue} ${t('mon.overdue')}`, t('mon.reviewsHint'), m.reviews.overdue > 0)}
      </div>

      <Card>
        <CardHeader title={t('mon.kpis')} icon={<Gauge className="size-5" />} subtitle={t('mon.kpisHint')} />
        <div className="grid gap-4 lg:grid-cols-2">
          {OWNERS.map((w) => {
            const rows = (m.kpis as Kpi[]).filter((k) => (k.owner ?? ownerOf(k.key)) === w);
            if (!rows.length) return null;
            return (
              <div key={w} className="overflow-x-auto rounded-xl border border-line">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-surface-2"><th colSpan={5} className="px-2 py-1.5 text-start font-semibold">{t(`mon.owner.${w}`)}<span className="block text-xs font-normal text-fg-muted">{t(`mon.ownerHint.${w}`)}</span></th></tr>
                    <tr className="text-fg-muted"><th className="px-2 py-1 text-start font-medium">KPI</th><th className="num px-2 py-1 font-medium">{t('mon.baseline')}</th><th className="num px-2 py-1 font-medium">{t('mon.target')}</th><th className="num px-2 py-1 font-medium">{t('mon.actual')}</th><th className="num px-2 py-1 font-medium">n</th></tr>
                  </thead>
                  <tbody>
                    {rows.map((k) => {
                      const lowerBetter = k.lower_is_better ?? k.key === 'urgent_ack_minutes';
                      const met = k.met !== undefined ? k.met : k.actual === null ? null : lowerBetter ? k.actual <= k.target : k.actual >= k.target;
                      return (
                        <tr key={k.key} className="border-t border-line align-top">
                          <td className="px-2 py-1.5 font-medium">
                            {te('mon.kpi.', k.key)}
                            <span className="block text-xs font-normal text-fg-muted">{te('mon.lens.', k.lens)}</span>
                            {k.self_care ? <span className="block text-xs font-normal text-fg-muted">{t('mon.selfCare', { n: k.self_care })}</span> : null}
                            {k.baseline_note ? <span className="block text-xs font-normal text-fg-muted" dir="ltr">{t('mon.baseline')}: {k.baseline_note}</span> : null}
                          </td>
                          <td className="num px-2 py-1.5 text-center" title={k.baseline_note ?? undefined}>{k.baseline ?? '—'}</td>
                          <td className="num px-2 py-1.5 text-center" title={k.target_note ?? undefined}>{lowerBetter ? '≤' : '≥'} {k.target} {k.unit}</td>
                          <td className={cn('num px-2 py-1.5 text-center font-semibold', met === false && 'text-danger')}>{k.actual ?? '—'} {met === null ? '' : met ? '✓' : '✗'}</td>
                          <td className="num px-2 py-1.5 text-center text-fg-muted">{k.n}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title={t('mon.judgeScores')} icon={<Scale className="size-5" />} subtitle={t('mon.judgeHint')} />
          <div className="grid grid-cols-5 gap-2 text-center">
            {DIMS.map((k) => (
              <div key={k} className={cn('rounded-xl p-2', (m.judge.scores[k] ?? 5) < 4 ? 'bg-warn-soft' : 'bg-surface-2')}>
                <div className="text-xs text-fg-muted">{te('mon.dim.', k)}</div>
                <div className="num text-lg font-bold">{m.judge.scores[k] ?? '—'}</div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-sm text-fg-muted">{t('mon.lowSafety', { n: m.judge.low_safety })}</p>
        </Card>
        <Card>
          <CardHeader title={t('mon.workflows')} icon={<Activity className="size-5" />} subtitle={t('mon.workflowsHint')} />
          <ul className="divide-y divide-line text-sm">
            {Object.entries(m.by_workflow).sort().map(([w, x]) => (
              <li key={w} className="flex justify-between py-1.5"><span>{w}</span><span className="num">{x.runs} {t('mon.runs')}{x.failed ? ` · ${x.failed} ${t('mon.failedShort')}` : ''}</span></li>
            ))}
          </ul>
        </Card>
      </div>

      <PeopleCard patients={(m.kpis as Kpi[]).find((k) => k.key === 'patients_logging_weekly')?.n ?? null} />

      <Card>
        <CardHeader title={t('mon.alerts')} icon={<Siren className="size-5" />} subtitle={t('mon.alertsHint', {
          soft: String(m.alerts.rules.soft_safety_avg), hard: String(m.alerts.rules.hard_safety_score), rate: String(Number(m.alerts.rules.failed_rate) * 100) })} />
        {m.alerts.recent.length === 0 ? <p className="text-sm text-fg-muted">{t('mon.noAlerts')}</p> : (
          <ul className="space-y-2 text-sm">
            {m.alerts.recent.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start gap-2">
                <Badge tone={a.severity === 'high' ? 'danger' : 'warn'}>{a.node}</Badge>
                <span className="min-w-0 flex-1">{a.message}</span>
                <span className="text-fg-muted">{fmt.dateTime(a.at)} · {a.status}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title={t('mon.calibration')} icon={<Scale className="size-5" />}
          subtitle={`${m.calibration.calibrated ? t('mon.calibrated', { n: m.calibration.pairs }) : t('mon.notCalibrated', { n: m.calibration.pairs, min: m.calibration.min_pairs })} ${t('mon.calibrationHint')}`}
          action={<div className="flex gap-2"><Button size="sm" variant="soft" onClick={() => setCalibrating('A')}>{t('mon.scoreAs', { r: 'A' })}</Button><Button size="sm" variant="soft" onClick={() => setCalibrating('B')}>{t('mon.scoreAs', { r: 'B' })}</Button></div>} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-fg-muted"><th className="px-2 py-1 text-start">{t('mon.dimension')}</th><th className="px-2 py-1">A ↔ judge</th><th className="px-2 py-1">B ↔ judge</th><th className="px-2 py-1">A ↔ B</th></tr></thead>
            <tbody>
              {DIMS.map((k) => {
                const d = m.calibration.dimensions[k];
                const cell = (x: typeof d.rater_a_vs_judge) => (x.n ? `${Math.round((x.exact ?? 0) * 100)}% · ±1 ${Math.round((x.within1 ?? 0) * 100)}% · κ ${x.kappa ?? '—'}` : '—');
                return <tr key={k} className="border-t border-line"><td className="px-2 py-1.5">{te('mon.dim.', k)}</td><td className="num px-2 py-1.5 text-center">{cell(d.rater_a_vs_judge)}</td><td className="num px-2 py-1.5 text-center">{cell(d.rater_b_vs_judge)}</td><td className="num px-2 py-1.5 text-center">{cell(d.rater_a_vs_b)}</td></tr>;
              })}
            </tbody>
          </table>
        </div>
        {calibrating && <CalibrationScoring rater={calibrating} onClose={() => { setCalibrating(null); void q.reload(true); }} />}
      </Card>
    </div>
  );
}

/** Who uses the system: active staff accounts per role (the Users tab's list) and the number of patients. */
function PeopleCard({ patients }: { patients: number | null }) {
  const { t, te, fmt } = useLocale();
  const q = useApi('admin', 'users', {});
  const users = ((q.data ?? []) as StaffUser[]).filter((u) => u.active);
  const roles = Object.entries(users.reduce<Record<string, number>>((a, u) => ({ ...a, [u.role]: (a[u.role] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);
  return (
    <Card>
      <CardHeader title={t('mon.people')} icon={<UserRound className="size-5" />} subtitle={t('mon.peopleHint')} />
      <div className="flex flex-wrap gap-2 text-sm">
        {patients !== null && <Badge tone="primary">{te('role.', 'patient')} · {patients}</Badge>}
        {roles.map(([r, n]) => <Badge key={r}>{te('role.', r)} · {n}</Badge>)}
      </div>
      {users.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-medium text-primary">{t('mon.peopleList', { n: users.length })}</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-t border-line">
                    <td className="px-2 py-1.5 font-medium">{u.full_name}</td>
                    <td className="px-2 py-1.5">{te('role.', u.role)}</td>
                    <td className="px-2 py-1.5 text-fg-muted">{fmt.list(u.organizations) || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </Card>
  );
}

function ResumeCompanion({ onDone }: { onDone: () => void }) {
  const { t } = useLocale();
  const { mutate, pending } = useMutation();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [note, setNote] = useState('');
  return (
    <Card tone="danger">
      <p className="text-base font-semibold">{t('mon.paused')}</p>
      <Field label={t('mon.resumeNote')} className="mt-3"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <Button className="mt-2" loading={pending} disabled={note.trim().length < 5} onClick={() => void mutate('admin', 'companion_resume', { note }).then(() => { toast(t('mon.resumed')); onDone(); }).catch(errorToast)}>{t('mon.resume')}</Button>
    </Card>
  );
}

function CalibrationScoring({ rater, onClose }: { rater: 'A' | 'B'; onClose: () => void }) {
  const { t, te } = useLocale();
  const q = useApi('admin', 'calibration_queue', { rater });
  const { mutate, pending } = useMutation();
  const errorToast = useErrorToast();
  const [i, setI] = useState(0);
  const [scores, setScores] = useState<Partial<Record<JudgeDim, number>>>({});
  const items: CalibrationItem[] = q.data ?? [];
  const item = items[i];
  async function save() {
    if (!item) return;
    try {
      await mutate('admin', 'calibration_score', { rater, trial_id: item.trial_id, scores: scores as Record<JudgeDim, number> });
      setScores({});
      setI((x) => x + 1);
    } catch (e) { errorToast(e); }
  }
  if (q.loading && !q.data) return <SkeletonCard lines={3} />;
  if (!item) return <div className="mt-4 flex items-center gap-3"><p className="text-sm">{t('mon.calDone')}</p><Button size="sm" onClick={onClose}>{t('common.close')}</Button></div>;
  return (
    <div className="mt-4 space-y-3 rounded-2xl border border-primary/40 p-4">
      <p className="text-sm text-fg-muted">{t('mon.calRater', { r: rater, i: i + 1, n: items.length })}</p>
      <div className="rounded-xl bg-surface-2 p-3 text-sm"><p className="font-semibold">{t('mon.question')}</p><p dir="auto">{item.question || '—'}</p></div>
      <div className="rounded-xl bg-surface-2 p-3 text-sm"><p className="font-semibold">{t('mon.answer')}</p><p dir="auto">{item.answer}</p></div>
      {DIMS.map((k) => (
        <div key={k} className="flex flex-wrap items-center gap-2">
          <span className="w-40 text-sm font-medium">{te('mon.dim.', k)}</span>
          {[1, 2, 3, 4, 5].map((v) => (
            <button key={v} type="button" aria-pressed={scores[k] === v} onClick={() => setScores((s) => ({ ...s, [k]: v }))}
              className={cn('size-10 rounded-lg border text-sm font-semibold', scores[k] === v ? 'border-primary bg-primary-soft' : 'border-line')}>{v}</button>
          ))}
        </div>
      ))}
      <p className="text-xs text-fg-muted">{t('mon.calHint')}</p>
      <div className="flex gap-2">
        <Button loading={pending} disabled={DIMS.some((k) => !scores[k])} onClick={() => void save()}>{t('common.save')}</Button>
        <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
      </div>
    </div>
  );
}
