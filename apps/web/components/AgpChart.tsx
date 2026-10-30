'use client';

import {
  Area,
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
import type { AgpHour } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { TARGET_HIGH, TARGET_LOW } from '@/lib/glucose';

/**
 * Ambulatory Glucose Profile: p10-p90 and p25-p75 bands, median line, x = hour of day 0-23,
 * target band 70-180 shaded.
 */
export function AgpChart({ data, height = 280 }: { data: AgpHour[]; height?: number }) {
  const { fmt, t } = useLocale();
  const rows = [...data].sort((a, b) => a.hour - b.hour);
  const yMax = Math.max(300, ...rows.map((r) => r.p90 + 20));

  return (
    <div dir="ltr" style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <ReferenceArea y1={TARGET_LOW} y2={TARGET_HIGH} fill="var(--chart-target)" stroke="none" ifOverflow="extendDomain" />
          <ReferenceLine y={TARGET_LOW} stroke="var(--g-low)" strokeDasharray="4 4" strokeOpacity={0.7} />
          <ReferenceLine y={TARGET_HIGH} stroke="var(--g-high)" strokeDasharray="4 4" strokeOpacity={0.7} />
          <XAxis
            dataKey="hour"
            type="number"
            domain={[0, 23]}
            ticks={[0, 3, 6, 9, 12, 15, 18, 21]}
            tickFormatter={(h: number) => fmt.hour(h)}
            tickLine={false}
            axisLine={false}
          />
          <YAxis domain={[40, yMax]} ticks={[54, 70, 180, 250]} tickLine={false} axisLine={false} width={44} />
          <Tooltip
            cursor={{ stroke: 'var(--line-strong)' }}
            content={(p) => {
              const row = (p.payload?.[0] as { payload?: AgpHour } | undefined)?.payload;
              if (!p.active || !row) return null;
              return (
                <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-sm">
                  <div className="mb-1 font-semibold text-fg">{fmt.hour(row.hour)}</div>
                  <div className="grid grid-cols-2 gap-x-3 text-fg-muted">
                    <span>p90</span><span className="text-end">{row.p90}</span>
                    <span>p75</span><span className="text-end">{row.p75}</span>
                    <span className="font-semibold text-fg">p50</span><span className="text-end font-semibold text-fg">{row.p50}</span>
                    <span>p25</span><span className="text-end">{row.p25}</span>
                    <span>p10</span><span className="text-end">{row.p10}</span>
                    <span>n</span><span className="text-end">{row.n}</span>
                  </div>
                  <div className="mt-1 text-fg-subtle">{t('common.mgdl')}</div>
                </div>
              );
            }}
          />
          <Area
            type="monotone"
            dataKey={(d: AgpHour) => [d.p10, d.p90]}
            stroke="none"
            fill="var(--chart-band-outer)"
            isAnimationActive={false}
            activeDot={false}
          />
          <Area
            type="monotone"
            dataKey={(d: AgpHour) => [d.p25, d.p75]}
            stroke="none"
            fill="var(--chart-band-inner)"
            isAnimationActive={false}
            activeDot={false}
          />
          <Line type="monotone" dataKey="p50" stroke="var(--primary-strong)" strokeWidth={2.25} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
