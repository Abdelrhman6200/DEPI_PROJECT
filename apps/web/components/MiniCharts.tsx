'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DailyGlucose } from '@health/api-client';
import { useLocale } from '@/lib/locale';

type DayRow = { day: string; tir: number | null; n: number; mean: number | null; min: number | null; max: number | null; bar: number };

/**
 * Daily time-in-range bars. Every day in the period gets a slot: a day at 0% still shows a short red bar,
 * and a day without readings shows a grey stub, so bad days and gaps are not hidden.
 */
export function DailyTirChart({ data, height = 200, target = 70 }: { data: DailyGlucose[]; height?: number; target?: number }) {
  const { fmt, t } = useLocale();
  const sorted = [...data].sort((a, b) => a.day.localeCompare(b.day));
  const byDay = new Map(sorted.map((r) => [r.day.slice(0, 10), r]));
  const rows: DayRow[] = [];
  if (sorted.length) {
    const end = new Date(sorted[sorted.length - 1].day.slice(0, 10) + 'T00:00:00Z');
    for (const d = new Date(sorted[0].day.slice(0, 10) + 'T00:00:00Z'); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const k = d.toISOString().slice(0, 10);
      const r = byDay.get(k);
      rows.push(r ? { ...r, day: k, bar: r.tir === null ? 3 : Math.max(r.tir, 3) } : { day: k, tir: null, n: 0, mean: null, min: null, max: null, bar: 3 });
    }
  }
  return (
    <div dir="ltr" style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="day" tickFormatter={(d: string) => fmt.shortDate(d)} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
          <YAxis domain={[0, 100]} ticks={[0, 50, target, 100]} tickLine={false} axisLine={false} width={36} />
          <ReferenceLine y={target} stroke="var(--g-in)" strokeDasharray="4 4" />
          <Tooltip
            cursor={{ fill: 'var(--surface-2)' }}
            content={(p) => {
              const row = (p.payload?.[0] as { payload?: DayRow } | undefined)?.payload;
              if (!p.active || !row) return null;
              return (
                <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-sm">
                  <div className="font-semibold text-fg">{fmt.weekday(row.day)}</div>
                  {row.n === 0 || row.tir === null ? (
                    <div className="text-fg-muted">{t('glu.noReadingsDay')}</div>
                  ) : (
                    <>
                      <div className="text-fg-muted">
                        {t('glu.tir')}: {fmt.pct(row.tir)}
                      </div>
                      <div className="text-fg-muted">
                        {t('glu.mean')}: {fmt.number(row.mean)} · {row.min}–{row.max}
                      </div>
                      <div className="text-fg-muted">{t('glu.readingsN', { n: row.n })}</div>
                    </>
                  )}
                </div>
              );
            }}
          />
          <Bar dataKey="bar" radius={[6, 6, 0, 0]} isAnimationActive={false}>
            {rows.map((r) => (
              <Cell
                key={r.day}
                fill={r.tir === null ? 'var(--line-strong)' : r.tir >= target ? 'var(--g-in)' : r.tir >= 50 ? 'var(--g-high)' : 'var(--g-low)'}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Generic small bar chart (e.g. steps per day). */
export function MiniBarChart({
  data,
  xKey,
  yKey,
  height = 150,
  color = 'var(--primary)',
  target,
  xFormat,
}: {
  data: Record<string, unknown>[];
  xKey: string;
  yKey: string;
  height?: number;
  color?: string;
  target?: number | null;
  xFormat?: (v: string) => string;
}) {
  const { fmt } = useLocale();
  return (
    <div dir="ltr" style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey={xKey} tickFormatter={xFormat} tickLine={false} axisLine={false} minTickGap={8} />
          <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => fmt.number(v)} />
          {target ? <ReferenceLine y={target} stroke="var(--g-in)" strokeDasharray="4 4" /> : null}
          <Tooltip
            cursor={{ fill: 'var(--surface-2)' }}
            formatter={(v) => fmt.number(Number(v))}
            labelFormatter={(l) => (xFormat ? xFormat(String(l)) : String(l))}
            contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, fontSize: '0.75rem' }}
          />
          <Bar dataKey={yKey} fill={color} radius={[5, 5, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Generic multi-line chart (e.g. mood / stress / energy check-ins). */
export function MiniLineChart({
  data,
  xKey,
  lines,
  height = 150,
  yDomain,
  xFormat,
}: {
  data: Record<string, unknown>[];
  xKey: string;
  lines: { key: string; color: string; label: string }[];
  height?: number;
  yDomain?: [number, number];
  xFormat?: (v: string) => string;
}) {
  const DASH = [undefined, '6 4', '2 4'];
  // Several entries on one day would repeat the same date under the chart: label a day once.
  const tick = (v: string, i: number) => {
    const label = xFormat ? xFormat(String(v)) : String(v);
    const prev = i > 0 ? data[i - 1]?.[xKey] : undefined;
    return prev !== undefined && (xFormat ? xFormat(String(prev)) : String(prev)) === label ? '' : label;
  };
  return (
    <div className="w-full">
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-fg-muted">
        {lines.map((l, i) => (
          <li key={l.key} className="inline-flex items-center gap-1.5">
            <svg width="22" height="8" aria-hidden>
              <line x1="0" y1="4" x2="22" y2="4" stroke={l.color} strokeWidth="3" strokeDasharray={DASH[i % DASH.length]} />
            </svg>
            {l.label}
          </li>
        ))}
      </ul>
    <div dir="ltr" style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey={xKey} tickFormatter={tick} tickLine={false} axisLine={false} interval={0} />
          <YAxis domain={yDomain ?? ["auto", "auto"]} tickLine={false} axisLine={false} width={28} allowDecimals={false} />
          <Tooltip
            labelFormatter={(l) => (xFormat ? xFormat(String(l)) : String(l))}
            contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, fontSize: '0.75rem' }}
          />
          {lines.map((l, i) => (
            <Line key={l.key} type="monotone" dataKey={l.key} name={l.label} stroke={l.color} strokeWidth={2} strokeDasharray={DASH[i % DASH.length]} dot={{ r: 2.5 }} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
    </div>
  );
}
