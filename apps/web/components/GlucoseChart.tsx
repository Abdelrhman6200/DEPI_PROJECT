'use client';

import { useMemo } from 'react';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { GlucoseReading } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { BAND_COLOR, glucoseBand, TARGET_HIGH, TARGET_LOW } from '@/lib/glucose';
import { cairoStartOfDay } from '@/lib/format';

interface Row {
  t: number;
  v: number;
  ctx: string | null;
}

/** Most points drawn at once; a 90-day sensor history has about 26,000 readings. */
const MAX_POINTS = 1500;

/**
 * Min/max bucketing: split the time range into buckets and keep each bucket's lowest and highest reading
 * (in time order). Unlike averaging, a short low between normal readings is never smoothed away.
 */
export function downsample(rows: Row[], max = MAX_POINTS): Row[] {
  if (rows.length <= max) return rows;
  const buckets = Math.floor(max / 2);
  const t0 = rows[0].t;
  const span = rows[rows.length - 1].t - t0 || 1;
  const out: Row[] = [];
  let i = 0;
  for (let b = 0; b < buckets && i < rows.length; b++) {
    const end = t0 + ((b + 1) * span) / buckets;
    let lo: Row | null = null;
    let hi: Row | null = null;
    while (i < rows.length && (rows[i].t <= end || b === buckets - 1)) {
      const r = rows[i++];
      if (!lo || r.v < lo.v) lo = r;
      if (!hi || r.v > hi.v) hi = r;
    }
    if (lo && hi) {
      if (lo === hi) out.push(lo);
      else out.push(...(lo.t <= hi.t ? [lo, hi] : [hi, lo]));
    }
  }
  return out;
}

/** Line chart of glucose readings over time with the 70-180 target band shaded. */
export function GlucoseChart({ readings, height = 260 }: { readings: GlucoseReading[]; height?: number }) {
  const { fmt, te, t } = useLocale();
  const all = useMemo<Row[]>(
    () =>
      readings
        .map((r) => ({ t: new Date(r.measured_at).getTime(), v: r.value_mgdl, ctx: r.context }))
        .filter((r) => !Number.isNaN(r.t))
        .sort((a, b) => a.t - b.t),
    [readings],
  );
  const spanDays = all.length > 1 ? (all[all.length - 1].t - all[0].t) / 86400000 : 0;
  // Long ranges are thinned for drawing; short ranges keep every reading.
  const rows = useMemo(() => (spanDays > 14 ? downsample(all) : all), [all, spanDays]);
  const showDots = rows.length <= 200;
  // a loop, not Math.max(...rows): spreading tens of thousands of arguments can overflow the call stack
  const yMax = useMemo(() => {
    let m = 300;
    for (const r of rows) if (r.v + 20 > m) m = r.v + 20;
    return m;
  }, [rows]);
  // For multi-day ranges put one tick per Cairo midnight (thinned to at most ~10 ticks).
  const dayTicks = useMemo(() => {
    if (spanDays <= 2 || rows.length < 2) return undefined;
    const first = cairoStartOfDay(rows[0].t) + 86400000;
    const step = Math.max(1, Math.ceil(spanDays / 10));
    const out: number[] = [];
    // re-align each tick to midnight so summer-time changes do not shift it by an hour
    for (let d = first; d <= rows[rows.length - 1].t; d = cairoStartOfDay(d + step * 86400000 + 3 * 3600000)) out.push(d);
    return out;
  }, [rows, spanDays]);

  return (
    <div dir="ltr" style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <ReferenceArea y1={TARGET_LOW} y2={TARGET_HIGH} fill="var(--chart-target)" stroke="none" ifOverflow="extendDomain" />
          <ReferenceLine y={TARGET_LOW} stroke="var(--g-low)" strokeDasharray="4 4" strokeOpacity={0.6} />
          <ReferenceLine y={TARGET_HIGH} stroke="var(--g-high)" strokeDasharray="4 4" strokeOpacity={0.6} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            ticks={dayTicks}
            tickFormatter={(v: number) => (spanDays > 2 ? fmt.shortDate(new Date(v)) : fmt.time(new Date(v)))}
            tickLine={false}
            axisLine={false}
            minTickGap={24}
          />
          <YAxis domain={[40, yMax]} tickLine={false} axisLine={false} width={44} ticks={[54, 70, 180, 250]} />
          <Tooltip
            cursor={{ stroke: 'var(--line-strong)' }}
            content={(p) => {
              const row = (p.payload?.[0] as { payload?: Row } | undefined)?.payload;
              if (!p.active || !row) return null;
              return (
                <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-sm">
                  <div className="font-semibold text-fg" style={{ color: BAND_COLOR[glucoseBand(row.v)] }}>
                    {row.v} {t('common.mgdl')}
                  </div>
                  <div className="text-fg-muted">{fmt.dateTime(new Date(row.t))}</div>
                  {row.ctx && <div className="text-fg-subtle">{te('ctx.', row.ctx)}</div>}
                </div>
              );
            }}
          />
          <Line
            type="monotone"
            dataKey="v"
            stroke="var(--primary)"
            strokeWidth={1.75}
            isAnimationActive={false}
            dot={
              showDots
                ? (props: { cx?: number; cy?: number; payload?: Row; index?: number }) => (
                    <circle
                      key={`d-${props.index}`}
                      cx={props.cx}
                      cy={props.cy}
                      r={3}
                      fill={props.payload ? BAND_COLOR[glucoseBand(props.payload.v)] : 'var(--primary)'}
                      stroke="var(--surface)"
                      strokeWidth={1}
                    />
                  )
                : false
            }
            activeDot={{ r: 4 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
