'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Gauge, RefreshCw, Scale, Timer } from 'lucide-react';
import type { AiTrial, Incident, IncidentKind, IncidentStatus, QualityGroupStats, QualityRecommendation } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import type { TKey } from '@/lib/i18n';
import { Card, CardHeader } from '@/components/Card';
import { Badge, type BadgeTone } from '@/components/Badge';
import { Button } from '@/components/Button';
import { Dialog } from '@/components/Dialog';
import { Field, Select, Textarea } from '@/components/Field';
import { Async } from '@/components/Async';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCard, SkeletonList } from '@/components/Skeleton';
import { StatTile } from '@/components/StatTile';
import { useErrorToast, useToast } from '@/components/Toast';

const VERDICT_TONE: Record<AiTrial['verdict'], BadgeTone> = { pass: 'ok', minor: 'warn', fail: 'danger' };
const PRIORITY_TONE: Record<QualityRecommendation['priority'], BadgeTone> = { high: 'danger', medium: 'warn', low: 'neutral' };
const SEVERITY_TONE: Record<Incident['severity'], BadgeTone> = { high: 'danger', medium: 'warn', low: 'neutral' };
const STATUS_TONE: Record<IncidentStatus, BadgeTone> = { open: 'warn', resolved: 'ok', dismissed: 'neutral' };
const KINDS: IncidentKind[] = ['workflow_error', 'ai_hallucination', 'ai_unsafe', 'ai_over_refusal', 'ai_quality', 'eval_failure', 'privacy_breach'];

/** A rate (0-1) as a percentage. */
const pct = (fmt: { pct: (n: number | null | undefined, d?: number) => string }, r: number | null | undefined) => fmt.pct(r === null || r === undefined ? null : r * 100, 1);

/* ------------------------------------------------------------ AI quality (LLM-as-a-judge) */

export function QualityTab() {
  const { t, fmt } = useLocale();
  const [days, setDays] = useState(7);
  const q = useApi('admin', 'quality', { days });
  const { mutate, pending } = useMutation();
  const toast = useToast();
  const errorToast = useErrorToast();

  async function buildReport() {
    try {
      await mutate('admin', 'quality_report', { days });
      toast(t('q.reportBuilt'));
      void q.reload();
    } catch (e) {
      errorToast(e);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={t('q.title')}
          subtitle={t('q.intro')}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Select aria-label={t('q.period')} value={days} onChange={(e) => setDays(Number(e.target.value))} className="h-9 w-auto">
                {[1, 7, 30, 90].map((d) => <option key={d} value={d}>{t('q.lastDays', { n: d })}</option>)}
              </Select>
              <Button size="sm" variant="outline" onClick={() => void q.reload()}><RefreshCw className="size-4" />{t('common.refresh')}</Button>
              <Button size="sm" onClick={() => void buildReport()} disabled={pending}>{t('q.buildReport')}</Button>
            </div>
          }
        />
        <Async state={q} skeleton={<SkeletonCard />}>
          {(d) => {
            const J = d.metrics.judge, R = d.metrics.runs;
            return (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <StatTile label={t('q.judged')} value={fmt.number(J.judged)} hint={t('q.byReason', { f: J.by_reason.flagged ?? 0, s: J.by_reason.sample ?? 0 })} icon={<Scale className="size-4" />} />
                <StatTile label={t('q.passRate')} value={pct(fmt, J.pass_rate)} tone={J.pass_rate !== null && J.pass_rate < 0.8 ? 'warn' : 'ok'} icon={<CheckCircle2 className="size-4" />} />
                <StatTile label={t('q.hallucinations')} value={pct(fmt, J.hallucination_rate)} hint={t('q.unsafeN', { n: J.unsafe })} tone={(J.hallucination_rate ?? 0) > 0.02 || J.unsafe > 0 ? 'danger' : 'default'} icon={<AlertTriangle className="size-4" />} />
                <StatTile label={t('q.overRefusal')} value={pct(fmt, J.over_refusal_rate)} tone={(J.over_refusal_rate ?? 0) > 0.15 ? 'warn' : 'default'} />
                <StatTile label={t('q.scores')} value={`${fmt.number(J.mean_scores.grounded, 1)} · ${fmt.number(J.mean_scores.safety, 1)} · ${fmt.number(J.mean_scores.helpfulness, 1)}`} hint={t('q.scoresHint')} icon={<Gauge className="size-4" />} />
                <StatTile label={t('q.withheld')} value={pct(fmt, R.withheld_rate)} hint={t('q.fallbackRate', { v: pct(fmt, R.fallback_rate) })} />
                <StatTile label={t('q.latency')} value={R.companion_latency_ms.p50 === null ? '—' : fmt.number(R.companion_latency_ms.p50 / 1000, 1)} unit="s"
                  hint={t('q.latencyHint', { p90: R.companion_latency_ms.p90 === null ? '—' : fmt.number(R.companion_latency_ms.p90 / 1000, 1), n: R.companion_latency_ms.n })} icon={<Timer className="size-4" />} />
                <StatTile label={t('q.openIncidents')} value={fmt.number(d.metrics.incidents.open)} tone={d.metrics.incidents.open ? 'warn' : 'default'} />
              </div>
            );
          }}
        </Async>
      </Card>

      {q.data && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title={t('q.recommendations')} subtitle={q.data.latest_report ? t('q.reportOf', { at: fmt.dateTime(q.data.latest_report.created_at) }) : t('q.noReport')} />
            {q.data.latest_report && q.data.latest_report.recommendations.length ? (
              <ul className="space-y-2">
                {q.data.latest_report.recommendations.map((r, i) => (
                  <li key={i} className="flex gap-2 text-sm">
                    <Badge tone={PRIORITY_TONE[r.priority]}>{r.area}</Badge>
                    <span className="min-w-0" dir="ltr">{r.text}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState compact title={t('q.noRecommendations')} />
            )}
          </Card>
          <Card>
            <CardHeader title={t('q.evaluation')} subtitle={q.data.latest_eval ? q.data.latest_eval.eval_run : t('q.noEval')} />
            {q.data.latest_eval && (
              <div className="space-y-2 text-sm">
                <p>{t('q.evalPassed', { p: q.data.latest_eval.passed, n: q.data.latest_eval.cases, r: pct(fmt, q.data.latest_eval.pass_rate) })}</p>
                {q.data.latest_eval.failed.map((f) => (
                  <p key={f.case_id} className="text-xs text-fg-muted" dir="ltr"><span className="font-mono">{f.case_id}</span> {f.category ?? ''}: {(f.failed_checks ?? []).join(', ')}</p>
                ))}
              </div>
            )}
          </Card>
          <GroupTable title={t('q.byPrompt')} rows={q.data.metrics.judge.by_prompt_version} />
          <GroupTable title={t('q.byModel')} rows={q.data.metrics.judge.by_model} />
        </div>
      )}

      <Card>
        <CardHeader title={t('q.trials')} subtitle={t('q.trialsHint')} />
        <Async state={q} skeleton={<SkeletonList rows={5} />} empty={<EmptyState compact title={t('q.noTrials')} />}>
          {(d) => (d.trials.length ? <TrialsTable rows={d.trials} /> : <EmptyState compact title={t('q.noTrials')} />)}
        </Async>
      </Card>
    </div>
  );
}

function GroupTable({ title, rows }: { title: string; rows: Record<string, QualityGroupStats> }) {
  const { t, fmt } = useLocale();
  const entries = Object.entries(rows).sort((a, b) => b[1].judged - a[1].judged);
  return (
    <Card>
      <CardHeader title={title} />
      {entries.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-sm">
            <thead className="text-xs text-fg-muted">
              <tr className="border-b border-line">
                <th className="py-2 text-start font-medium">{t('q.name')}</th>
                <th className="py-2 text-end font-medium">{t('q.judged')}</th>
                <th className="py-2 text-end font-medium">{t('q.passRate')}</th>
                <th className="py-2 text-end font-medium">{t('q.hallucinations')}</th>
                <th className="py-2 text-end font-medium">{t('q.overRefusal')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {entries.map(([k, v]) => (
                <tr key={k}>
                  <td className="py-2 pe-3 font-mono text-xs break-all" dir="ltr">{k}</td>
                  <td className="tabular-nums py-2 text-end">{fmt.number(v.judged)}</td>
                  <td className="tabular-nums py-2 text-end">{pct(fmt, v.pass_rate)}</td>
                  <td className="tabular-nums py-2 text-end">{pct(fmt, v.hallucination_rate)}</td>
                  <td className="tabular-nums py-2 text-end">{pct(fmt, v.over_refusal_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState compact title={t('q.noTrials')} />
      )}
    </Card>
  );
}

function TrialsTable({ rows }: { rows: AiTrial[] }) {
  const { t, fmt } = useLocale();
  return (
    <div className="max-h-[70vh] overflow-auto rounded-xl border border-line">
      <table className="w-full min-w-[60rem] text-sm">
        <thead className="sticky top-0 z-10 bg-surface-2 text-xs text-fg-muted">
          <tr>
            <th className="px-3 py-2 text-start font-medium">{t('q.judgedAt')}</th>
            <th className="px-3 py-2 text-start font-medium">{t('adm.workflow')}</th>
            <th className="px-3 py-2 text-start font-medium">{t('q.verdict')}</th>
            <th className="px-3 py-2 text-start font-medium" title={t('q.scoresHint')}>{t('q.scores')}</th>
            <th className="px-3 py-2 text-start font-medium">{t('q.summary')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={r.id} className="align-top">
              <td className="px-3 py-2 text-xs whitespace-nowrap text-fg-muted">{fmt.dateTime(r.judged_at)}<div>{t(`q.reason.${r.reason}` as TKey)}</div></td>
              <td className="px-3 py-2 text-xs"><div className="font-medium">{r.workflow}</div><div className="font-mono text-fg-muted" dir="ltr">{r.model ?? '—'} · {r.prompt_version ?? ''}</div></td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  <Badge tone={VERDICT_TONE[r.verdict]}>{t(`q.verdict.${r.verdict}` as TKey)}</Badge>
                  {r.hallucination && <Badge tone="danger">{t('q.hallucination')}</Badge>}
                  {r.over_refusal && <Badge tone="warn">{t('q.overRefusalShort')}</Badge>}
                </div>
              </td>
              <td className="tabular-nums px-3 py-2 text-xs whitespace-nowrap">{r.grounded ?? '—'} · {r.safety ?? '—'} · {r.helpfulness ?? '—'}</td>
              <td className="max-w-xl px-3 py-2 text-xs">
                <p className="break-words" dir="auto">{r.summary ?? ''}</p>
                {(r.question_excerpt || r.answer_excerpt) && (
                  <details className="mt-1 text-fg-muted">
                    <summary className="cursor-pointer">{t('q.showExchange')}</summary>
                    <p className="mt-1 break-words" dir="auto"><b>{t('q.question')}:</b> {r.question_excerpt ?? '—'}</p>
                    <p className="mt-1 break-words" dir="auto"><b>{t('q.answer')}:</b> {r.answer_excerpt ?? '—'}</p>
                    <p className="mt-1 font-mono" dir="ltr">{r.ai_run_id} · {r.judge_model}</p>
                  </details>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------ incidents (workflow errors + AI quality) */

export function IncidentsTab() {
  const { t, fmt } = useLocale();
  const [kind, setKind] = useState<IncidentKind | ''>('');
  const [status, setStatus] = useState<IncidentStatus | ''>('open');
  const q = useApi('admin', 'incidents', { limit: 200, ...(kind ? { kind } : {}), ...(status ? { status } : {}) });
  const [closing, setClosing] = useState<Incident | null>(null);
  return (
    <Card>
      <CardHeader
        title={t('adm.incidents')}
        subtitle={t('q.incidentsIntro')}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label={t('q.kind')} value={kind} onChange={(e) => setKind(e.target.value as IncidentKind | '')} className="h-9 w-auto">
              <option value="">{t('q.allKinds')}</option>
              {KINDS.map((k) => <option key={k} value={k}>{t(`q.kind.${k}` as TKey)}</option>)}
            </Select>
            <Select aria-label={t('common.status')} value={status} onChange={(e) => setStatus(e.target.value as IncidentStatus | '')} className="h-9 w-auto">
              <option value="">{t('q.allStatuses')}</option>
              {(['open', 'resolved', 'dismissed'] as IncidentStatus[]).map((s) => <option key={s} value={s}>{t(`q.status.${s}` as TKey)}</option>)}
            </Select>
            <Button size="sm" variant="outline" onClick={() => void q.reload()}>{t('common.refresh')}</Button>
          </div>
        }
      />
      <Async state={q} skeleton={<SkeletonList rows={5} />} empty={<EmptyState compact title={t('adm.noIncidents')} />}>
        {(rows) => (
          <div className="max-h-[70vh] overflow-auto rounded-xl border border-line">
            <table className="w-full min-w-[56rem] text-sm">
              <thead className="sticky top-0 z-10 bg-surface-2 text-xs text-fg-muted">
                <tr>
                  <th className="px-3 py-2 text-start font-medium">{t('adm.occurred')}</th>
                  <th className="px-3 py-2 text-start font-medium">{t('q.kind')}</th>
                  <th className="px-3 py-2 text-start font-medium">{t('adm.workflow')}</th>
                  <th className="px-3 py-2 text-start font-medium">{t('adm.message')}</th>
                  <th className="px-3 py-2 text-start font-medium">{t('common.status')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="px-3 py-2 text-xs whitespace-nowrap text-fg-muted">{fmt.dateTime(r.at)}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1"><Badge tone={SEVERITY_TONE[r.severity]}>{t(`q.kind.${r.kind}` as TKey)}</Badge></div>
                    </td>
                    <td className="px-3 py-2 text-xs"><div className="font-medium">{r.workflow ?? '—'}</div><div className="text-fg-muted">{r.node ?? ''}</div></td>
                    <td className="max-w-md px-3 py-2 text-xs break-words" dir="auto">
                      {r.message ?? ''}
                      {r.resolution && <p className="mt-1 text-fg-muted">{t('q.resolution')}: {r.resolution}</p>}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={STATUS_TONE[r.status]}>{t(`q.status.${r.status}` as TKey)}</Badge>
                      {r.status === 'open' && (
                        <Button size="sm" variant="outline" className="mt-1 block" onClick={() => setClosing(r)}>{t('q.close')}</Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Async>
      <CloseIncidentDialog incident={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); void q.reload(); }} />
    </Card>
  );
}

function CloseIncidentDialog({ incident, onClose, onDone }: { incident: Incident | null; onClose: () => void; onDone: () => void }) {
  const { t } = useLocale();
  const [status, setStatus] = useState<'resolved' | 'dismissed'>('resolved');
  const [note, setNote] = useState('');
  const { mutate, pending } = useMutation();
  const errorToast = useErrorToast();
  async function save() {
    if (!incident || !note.trim()) return;
    try {
      await mutate('admin', 'incident_resolve', { id: incident.id, status, resolution: note.trim() });
      setNote('');
      onDone();
    } catch (e) {
      errorToast(e);
    }
  }
  return (
    <Dialog
      open={!!incident}
      onClose={onClose}
      title={t('q.closeTitle')}
      description={incident?.message ?? ''}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={() => void save()} disabled={pending || !note.trim()}>{t('common.save')}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('common.status')}>
          <Select value={status} onChange={(e) => setStatus(e.target.value as 'resolved' | 'dismissed')}>
            <option value="resolved">{t('q.status.resolved')}</option>
            <option value="dismissed">{t('q.status.dismissed')}</option>
          </Select>
        </Field>
        <Field label={t('q.resolution')} hint={t('q.resolutionHint')}>
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
      </div>
    </Dialog>
  );
}
