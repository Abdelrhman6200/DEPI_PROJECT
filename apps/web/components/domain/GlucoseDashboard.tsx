'use client';

import { useState, type ReactNode } from 'react';
import { Activity, BarChart3, LineChart as LineIcon, Waves, Radar, Plus, ListOrdered, Trash2 } from 'lucide-react';
import type { GlucoseMetrics, GlucoseReading, UUID } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import { BAND_TEXT, glucoseBand } from '@/lib/glucose';
import { GLUCOSE_STALE_MIN_CGM, GLUCOSE_STALE_MIN_MANUAL } from '@/lib/glucose';
import { Card, CardHeader } from '../Card';
import { Segmented } from '../Tabs';
import { Async } from '../Async';
import { EmptyState } from '../EmptyState';
import { SkeletonCard, SkeletonChart, SkeletonList } from '../Skeleton';
import { StatTile } from '../StatTile';
import { TirBar } from '../TirBar';
import { AgpChart, DailyTirChart, GlucoseChart } from '../LazyCharts';
import { DataQualityBadge, Freshness } from '../StatusBadges';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { InfoTip } from '../InfoTip';
import { PatternRow } from './Rows';
import { Dialog } from '../Dialog';
import { ShowMoreList } from '../ShowMoreList';
import { useErrorToast, useToast } from '../Toast';
import { usePage } from '@/lib/pageBundle';
import type { Group } from '@health/api-client';

export const RANGES = [7, 14, 30, 90] as const;
export type RangeDays = (typeof RANGES)[number];

/**
 * Full glucose view: metrics, readings chart, AGP ("your typical day"), daily time in range and patterns.
 * `pro` switches to clinician wording and density (provider workspace); otherwise plain language for people.
 */
export function GlucoseDashboard({
  patientId,
  refreshKey = 0,
  headerAction,
  initialDays = 14,
  pro = false,
  onLog,
}: {
  patientId?: UUID;
  refreshKey?: number;
  headerAction?: ReactNode;
  initialDays?: RangeDays;
  pro?: boolean;
  onLog?: () => void;
}) {
  const { t } = useLocale();
  const [days, setDays] = useState<RangeDays>(initialDays);
  const input = { ...(patientId ? { patient_id: patientId } : {}), days };
  // One request for the screen (lib/pageBundle.ts); the clinician view includes the charts' data.
  const own = patientId ? { patient_id: patientId } : {};
  usePage('glucose', 'page', pro ? { ...input, charts: true } : input, [
    ['glucose', 'metrics', input, 'metrics'], ['glucose', 'list', input, 'list'], ['glucose', 'patterns', input, 'patterns'],
    ['glucose', 'nightscout_status', own, 'nightscout'],
    ...(pro ? ([['glucose', 'agp', input, 'agp'], ['glucose', 'daily', input, 'daily']] as [Group, string, unknown, string][]) : []),
  ]);

  const metrics = useApi('glucose', 'metrics', input, [refreshKey]);
  const readings = useApi('glucose', 'list', input, [refreshKey]);
  // People see the charts only after opening "Show charts", so those two are fetched then (fewer calls on open).
  const [charts, setCharts] = useState(pro);
  const agp = useApi('glucose', 'agp', charts ? input : null, [refreshKey]);
  const daily = useApi('glucose', 'daily', pro ? input : null, [refreshKey]);
  const patterns = useApi('glucose', 'patterns', input, [refreshKey]);
  // Staff always get the profile; people get it only with sensor data (it is drawn from readings round the clock).
  const showAgp = pro || !!metrics.data?.cgm;

  const noReadings = (
    <EmptyState
      compact={pro}
      title={t('glu.noReadings')}
      description={pro ? undefined : t('glu.noReadingsHint')}
      action={
        !pro && onLog ? (
          <Button size="lg" icon={<Plus className="size-5" />} onClick={onLog}>
            {t('today.logReading')}
          </Button>
        ) : undefined
      }
    />
  );

  const rangePicker = (
    <Segmented
      size={pro ? 'md' : 'lg'}
      label={t('common.dayRange', { n: days })}
      options={RANGES.map((d) => ({ value: d, label: t('common.dayRange', { n: d }) }))}
      value={days}
      onChange={setDays}
    />
  );

  // People: a plain-language answer first ("how has my sugar been?"); the charts are there for those who want them.
  if (!pro) {
    const reload = () => { void readings.reload(true); void metrics.reload(true); void daily.reload(true); void agp.reload(true); void patterns.reload(true); };
    return (
      <div className="space-y-4">
        <Async state={metrics} skeleton={<SkeletonCard lines={4} />} isEmpty={(m) => !m.readings} empty={noReadings}>
          {(m) => <PatientSummary m={m} lows={(readings.data ?? []).filter((r) => r.value_mgdl < 70).length} />}
        </Async>
        {readings.data && readings.data.length > 0 && <RecentReadings rows={readings.data} patientId={patientId} onDeleted={reload} />}
        {patterns.data && patterns.data.length > 0 && (
          <Card>
            <CardHeader title={t('glu.patterns')} icon={<Radar className="size-5" />} />
            <div className="grid gap-2">
              {patterns.data.slice(0, 3).map((p, i) => (
                <PatternRow key={`${p.type}-${i}`} p={p} />
              ))}
            </div>
          </Card>
        )}
        <details className="group rounded-2xl border border-line bg-surface" onToggle={(e) => setCharts((e.currentTarget as HTMLDetailsElement).open)}>
          <summary className="flex min-h-12 cursor-pointer items-center gap-2 px-4 text-base font-medium text-primary-strong">
            <LineIcon className="size-5" aria-hidden />
            {t('glu.s.showCharts')}
          </summary>
          <div className="space-y-4 p-4 pt-0">
            {rangePicker}
            <Async state={readings} skeleton={<SkeletonChart />} empty={noReadings}>
              {(rows) => <GlucoseChart readings={rows} />}
            </Async>
            {charts && showAgp && (
              <div>
                <h3 className="mb-1 text-base font-semibold">{t('glu.agp')}</h3>
                <p className="mb-2 text-sm text-fg-muted">{t('glu.agpHint')}</p>
                <Async state={agp} skeleton={<SkeletonChart />} empty={<EmptyState compact title={t('glu.noReadings')} />}>
                  {(rows) => <AgpChart data={rows} />}
                </Async>
              </div>
            )}
          </div>
        </details>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          size={pro ? 'md' : 'lg'}
          label={t('common.dayRange', { n: days })}
          options={RANGES.map((d) => ({ value: d, label: t('common.dayRange', { n: d }) }))}
          value={days}
          onChange={setDays}
        />
        {headerAction}
      </div>

      <Async state={metrics} skeleton={<SkeletonCard lines={4} />} isEmpty={() => false}>
        {(m) => <MetricsPanel m={m} />}
      </Async>

      <Card>
        <CardHeader title={pro ? t('glu.readingsPro') : t('glu.readings')} icon={<LineIcon className="size-5" />} />
        <Async state={readings} skeleton={<SkeletonChart />} empty={noReadings}>
          {(rows) => <GlucoseChart readings={rows} />}
        </Async>
      </Card>

      <div className={showAgp ? 'grid gap-4 xl:grid-cols-2' : undefined}>
        {showAgp && (
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-1">
                {pro ? t('glu.agpPro') : t('glu.agp')}
                {!pro && <InfoTip text="help.agp" />}
              </span>
            }
            subtitle={pro ? t('glu.agpProHint') : t('glu.agpHint')}
            icon={<Waves className="size-5" />}
          />
          <Async state={agp} skeleton={<SkeletonChart />} empty={<EmptyState compact title={t('glu.noReadings')} />}>
            {(rows) => <AgpChart data={rows} />}
          </Async>
        </Card>
        )}
        <Card>
          <CardHeader title={t('glu.daily')} icon={<BarChart3 className="size-5" />} />
          <Async state={daily} skeleton={<SkeletonChart />} empty={<EmptyState compact title={t('glu.noReadings')} />}>
            {(rows) => <DailyTirChart data={rows} />}
          </Async>
        </Card>
      </div>

      {!pro && readings.data && readings.data.length > 0 && (
        <RecentReadings rows={readings.data} patientId={patientId} onDeleted={() => { void readings.reload(true); void metrics.reload(true); void daily.reload(true); void agp.reload(true); void patterns.reload(true); }} />
      )}

      <Card>
        <CardHeader title={t('glu.patterns')} icon={<Radar className="size-5" />} />
        <Async state={patterns} skeleton={<SkeletonList rows={2} />} empty={<EmptyState compact title={t('glu.noPatterns')} />}>
          {(rows) => (
            <div className="grid gap-2 md:grid-cols-2">
              {rows.map((p, i) => (
                <PatternRow key={`${p.type}-${i}`} p={p} />
              ))}
            </div>
          )}
        </Async>
      </Card>
    </div>
  );
}

/** How has my sugar been? One sentence, a picture of 10 readings, lows, the last reading, and two everyday numbers in words. */
function PatientSummary({ m, lows }: { m: GlucoseMetrics; lows: number }) {
  const { t, fmt } = useLocale();
  const tir = m.tir ?? 0;
  const high = Math.round(((m.tar_level1 ?? 0) + (m.tar_level2 ?? 0)) / 10);
  const tbr = (m.tbr_level1 ?? 0) + (m.tbr_level2 ?? 0);
  const low = tbr > 0 ? Math.max(1, Math.round(tbr / 10)) : 0;
  const inR = Math.max(0, 10 - high - low);
  const tone = tir >= 70 ? 'ok' : tir >= 50 ? 'warn' : 'danger';
  const head = tone === 'ok' ? t('glu.s.good') : tone === 'warn' ? t('glu.s.some') : t('glu.s.many');
  const dots = [...Array(inR).fill('in'), ...Array(high).fill('high'), ...Array(low).fill('low')];
  const color: Record<string, string> = { in: 'var(--g-in)', high: 'var(--g-high)', low: 'var(--g-low)' };
  const word = (v: number | null, top: number) => (v === null ? null : v < 70 ? ['danger', t('glu.s.low')] : v <= top ? ['ok', t('glu.s.ok')] : ['warn', t('glu.s.high')]);
  const daily: [string, number | null, number][] = [[t('glu.s.fasting'), m.fasting_mean, 130], [t('glu.s.afterMeal'), m.post_meal_mean, 180]];
  return (
    <Card>
      <h2 className="text-lg font-semibold">{t('glu.s.title')}</h2>
      <p className="text-sm text-fg-muted">{t('glu.s.period', { n: m.days, r: fmt.number(m.readings) })}</p>
      <p className={`mt-3 text-xl font-semibold leading-8 ${tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : 'text-danger'}`}>{head}</p>
      <div className="mt-3 flex gap-1.5" role="img" aria-label={t('glu.s.dots', { n: inR })}>
        {dots.map((d, i) => <span key={i} className="size-6 rounded-full" style={{ background: color[d] }} />)}
      </div>
      <p className="mt-2 text-base">{t('glu.s.dots', { n: inR })}</p>
      <p className="mt-1 flex flex-wrap gap-x-4 text-sm text-fg-muted">
        <span><span className="me-1 inline-block size-3 rounded-full align-middle" style={{ background: color.in }} />{t('glu.s.inLabel')}</span>
        <span><span className="me-1 inline-block size-3 rounded-full align-middle" style={{ background: color.high }} />{t('glu.s.high')}</span>
        <span><span className="me-1 inline-block size-3 rounded-full align-middle" style={{ background: color.low }} />{t('glu.s.low')}</span>
      </p>
      <p className={`mt-3 rounded-xl p-3 text-base leading-7 ${lows ? 'bg-danger/10 text-danger' : 'bg-surface-2'}`}>
        {lows ? t('glu.s.lows', { n: lows }) : t('glu.s.noLows')}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3 text-center">
        <div>
          <div className="text-sm text-fg-muted">{t('glu.s.last')}</div>
          <div className="num text-2xl font-bold" style={m.latest ? { color: BAND_TEXT[glucoseBand(m.latest.value_mgdl)] } : undefined}>{m.latest?.value_mgdl ?? '—'}</div>
          <div className="text-xs text-fg-muted">{m.latest ? fmt.relative(m.latest.measured_at) : ''}</div>
        </div>
        {daily.map(([label, v, top]) => {
          const w = word(v, top);
          return (
            <div key={label}>
              <div className="text-sm text-fg-muted">{label}</div>
              <div className="num text-2xl font-bold">{v === null ? '—' : fmt.number(v)}</div>
              {w && <div className={`text-xs font-medium ${w[0] === 'ok' ? 'text-ok' : w[0] === 'warn' ? 'text-warn' : 'text-danger'}`}>{w[1]}</div>}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** Dense clinician metrics panel. */
export function MetricsPanel({ m }: { m: GlucoseMetrics }) {
  const { t, fmt } = useLocale();
  const staleAfter = m.cgm ? GLUCOSE_STALE_MIN_CGM : GLUCOSE_STALE_MIN_MANUAL;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_1fr]">
      <Card>
        <CardHeader
          title={t('glu.metrics')}
          icon={<Activity className="size-5" />}
          action={
            <div className="flex gap-1">
              <Badge tone={m.cgm ? 'primary' : 'neutral'}>{m.cgm ? t('glu.cgmShort') : t('glu.smbgShort')}</Badge>
              <DataQualityBadge quality={m.data_quality} />
            </div>
          }
        />
        <TirBar metrics={m} />
        <div className="mt-3 border-t border-line pt-3">
          <Freshness at={m.latest?.measured_at ?? null} ageMinutes={m.latest?.age_minutes ?? null} staleAfterMin={staleAfter} forceStale={m.data_quality === 'stale'} />
          <div className="mt-1 text-xs text-fg-subtle">{t('glu.readingsN', { n: fmt.number(m.readings) })}</div>
        </div>
      </Card>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label={t('glu.tirPro')} value={fmt.pct(m.tir)} tone={m.tir === null ? 'default' : m.tir >= 70 ? 'ok' : m.tir >= 50 ? 'warn' : 'danger'} />
        <StatTile label={t('glu.mean')} value={fmt.number(m.mean)} unit={t('common.mgdl')} />
        <StatTile label={t('glu.gmiPro')} value={m.gmi === null ? '—' : fmt.number(m.gmi, 1)} unit="%" />
        <StatTile label={t('glu.cvPro')} value={fmt.pct(m.cv, 1)} tone={m.cv !== null && m.cv > 36 ? 'warn' : 'default'} hint={t('glu.cvGoal')} />
        <StatTile label={t('glu.fastingMean')} value={fmt.number(m.fasting_mean)} unit={t('common.mgdl')} />
        <StatTile label={t('glu.postMealMean')} value={fmt.number(m.post_meal_mean)} unit={t('common.mgdl')} />
        {m.cgm && <StatTile label={t('glu.coverage')} value={fmt.pct(m.coverage_pct)} tone={m.coverage_pct !== null && m.coverage_pct < 70 ? 'warn' : 'default'} />}
      </div>
    </div>
  );
}

/** Latest readings, newest first. Readings the person typed in during the last 7 days can be removed if they were a mistake. */
function RecentReadings({ rows, patientId, onDeleted }: { rows: GlucoseReading[]; patientId?: UUID; onDeleted: () => void }) {
  const { t, te, fmt } = useLocale();
  const toast = useToast();
  const errorToast = useErrorToast();
  const { mutate, pending } = useMutation();
  const [removing, setRemoving] = useState<GlucoseReading | null>(null);
  const weekAgo = Date.now() - 7 * 864e5;
  const list = [...rows].sort((a, b) => b.measured_at.localeCompare(a.measured_at)).slice(0, 50);

  async function remove() {
    if (!removing) return;
    try {
      await mutate('glucose', 'delete', { ...(patientId ? { patient_id: patientId } : {}), reading_id: removing.id });
      toast(t('glu.readingRemoved'));
      setRemoving(null);
      onDeleted();
    } catch (e) {
      errorToast(e);
    }
  }

  return (
    <Card>
      <CardHeader title={t('glu.recent')} icon={<ListOrdered className="size-5" />} />
      <ShowMoreList
        as="ul"
        limit={6}
        className="divide-y divide-line"
        items={list}
        render={(r) => (
          <li key={r.id} className="flex items-center gap-3 py-2.5">
            <span className="num w-14 text-xl font-bold" style={{ color: BAND_TEXT[glucoseBand(r.value_mgdl)] }}>
              {r.value_mgdl}
            </span>
            <span className="min-w-0 flex-1 text-sm text-fg-muted">
              {fmt.dateTime(r.measured_at)}
              {r.context ? ` · ${te('ctx.', r.context)}` : ''} · {te('src.', r.source)}
            </span>
            {r.source === 'patient' && new Date(r.measured_at).getTime() > weekAgo && (
              <Button size="sm" variant="ghost" aria-label={t('glu.removeReading')} icon={<Trash2 className="size-4" />} onClick={() => setRemoving(r)}>
                <span className="sr-only sm:not-sr-only">{t('common.remove')}</span>
              </Button>
            )}
          </li>
        )}
      />
      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        size="sm"
        title={t('glu.removeTitle', { v: removing?.value_mgdl ?? '' })}
        footer={
          <>
            <Button variant="ghost" size="lg" onClick={() => setRemoving(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" size="lg" loading={pending} onClick={() => void remove()}>
              {t('common.remove')}
            </Button>
          </>
        }
      >
        <p className="text-base leading-7">{t('glu.removeBody')}</p>
      </Dialog>
    </Card>
  );
}
