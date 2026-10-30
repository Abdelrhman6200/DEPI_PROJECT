'use client';

import type { GlucoseMetrics } from '@health/api-client';
import { cn } from '@/lib/cn';
import { useLocale } from '@/lib/locale';
import type { TKey } from '@/lib/i18n';

const SEGMENTS: { key: keyof GlucoseMetrics; label: TKey; color: string }[] = [
  { key: 'tar_level2', label: 'glu.tar2', color: 'var(--g-vhigh)' },
  { key: 'tar_level1', label: 'glu.tar1', color: 'var(--g-high)' },
  { key: 'tir', label: 'glu.tir1', color: 'var(--g-in)' },
  { key: 'tbr_level1', label: 'glu.tbr1', color: 'var(--g-low)' },
  { key: 'tbr_level2', label: 'glu.tbr2', color: 'var(--g-vlow)' },
];

/** Stacked TIR / TAR / TBR bar (vertical, as in the international consensus report) with legend. */
export function TirBar({ metrics, className }: { metrics: GlucoseMetrics; className?: string }) {
  const { t, fmt } = useLocale();
  const values = SEGMENTS.map((s) => ({ ...s, v: (metrics[s.key] as number | null) ?? 0 }));
  const total = values.reduce((a, b) => a + b.v, 0);
  if (!total) {
    return <p className="text-sm text-fg-subtle">{t('common.noData')}</p>;
  }
  return (
    <div className={cn('flex items-stretch gap-4', className)}>
      <div className="flex h-44 w-9 shrink-0 flex-col overflow-hidden rounded-lg border border-line">
        {values.map((s) => (
          <div
            key={s.key}
            style={{ height: `${(s.v / total) * 100}%`, background: s.color }}
            title={`${t(s.label)}: ${fmt.pct(s.v)}`}
          />
        ))}
      </div>
      <ul className="flex flex-1 flex-col justify-between py-0.5 text-sm">
        {values.map((s) => (
          <li key={s.key} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-fg-muted">
              <span className="size-2.5 rounded-full" style={{ background: s.color }} />
              {t(s.label)}
            </span>
            <span className={cn('num font-semibold', s.key === 'tir' ? 'text-fg' : 'text-fg-muted')}>{fmt.pct(s.v)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Compact horizontal variant for tables and headers. */
export function TirStrip({ metrics, className }: { metrics: GlucoseMetrics; className?: string }) {
  const { t, fmt } = useLocale();
  const values = [...SEGMENTS].reverse().map((s) => ({ ...s, v: (metrics[s.key] as number | null) ?? 0 }));
  const total = values.reduce((a, b) => a + b.v, 0);
  if (!total) return <div className={cn('h-2.5 rounded-full bg-surface-2', className)} />;
  return (
    <div className={cn('flex h-2.5 overflow-hidden rounded-full', className)} dir="ltr">
      {values.map((s) => (
        <div key={s.key} style={{ width: `${(s.v / total) * 100}%`, background: s.color }} title={`${t(s.label)}: ${fmt.pct(s.v)}`} />
      ))}
    </div>
  );
}

/** Ring showing time-in-range percentage. */
export function TirRing({ value, size = 112, target = 70 }: { value: number | null; size?: number; target?: number }) {
  const { fmt, t } = useLocale();
  const stroke = 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value));
  const color = value === null ? 'var(--line)' : pct >= target ? 'var(--g-in)' : pct >= 50 ? 'var(--g-high)' : 'var(--g-low)';
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="num text-2xl font-semibold text-fg">{value === null ? '—' : fmt.pct(value)}</span>
        <span className="text-xs text-fg-muted">{t('glu.tir')}</span>
      </div>
    </div>
  );
}
