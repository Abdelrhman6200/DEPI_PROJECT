export type GlucoseBand = 'vlow' | 'low' | 'in' | 'high' | 'vhigh';

export function glucoseBand(v: number): GlucoseBand {
  if (v < 54) return 'vlow';
  if (v < 70) return 'low';
  if (v <= 180) return 'in';
  if (v <= 250) return 'high';
  return 'vhigh';
}

export const BAND_COLOR: Record<GlucoseBand, string> = {
  vlow: 'var(--g-vlow)',
  low: 'var(--g-low)',
  in: 'var(--g-in)',
  high: 'var(--g-high)',
  vhigh: 'var(--g-vhigh)',
};

/** Same bands for text and icons: the high bands use darker shades so labels stay readable on light cards. */
export const BAND_TEXT: Record<GlucoseBand, string> = {
  vlow: 'var(--g-vlow)',
  low: 'var(--g-low)',
  in: 'var(--g-in)',
  high: 'var(--g-high-fg)',
  vhigh: 'var(--g-vhigh-fg)',
};

/** Tone used by Badge for a glucose value. */
export function glucoseTone(v: number | null | undefined): 'danger' | 'warn' | 'ok' | 'neutral' {
  if (v === null || v === undefined) return 'neutral';
  const b = glucoseBand(v);
  if (b === 'vlow' || b === 'low') return 'danger';
  if (b === 'in') return 'ok';
  return 'warn';
}

/** Minutes after which a glucose reading is considered stale for display purposes. */
export const GLUCOSE_STALE_MIN_CGM = 60;
export const GLUCOSE_STALE_MIN_MANUAL = 60 * 24;

export const TARGET_LOW = 70;
export const TARGET_HIGH = 180;

export type Trend = 'rising_fast' | 'rising' | 'steady' | 'falling' | 'falling_fast';

/**
 * Direction of change from sensor readings: compares the latest reading with one 10-35 minutes earlier.
 * Returns null when there is no recent pair (e.g. finger-prick readings hours apart).
 */
export function computeTrend(readings: { value_mgdl: number; measured_at: string }[]): Trend | null {
  const rows = readings
    .map((r) => ({ v: r.value_mgdl, t: new Date(r.measured_at).getTime() }))
    .filter((r) => !Number.isNaN(r.t))
    .sort((a, b) => b.t - a.t);
  if (rows.length < 2) return null;
  const latest = rows[0];
  if (Date.now() - latest.t > 45 * 60000) return null;
  const prev = rows.find((r) => {
    const m = (latest.t - r.t) / 60000;
    return m >= 10 && m <= 35;
  });
  if (!prev) return null;
  const slope = (latest.v - prev.v) / ((latest.t - prev.t) / 60000); // mg/dL per minute
  if (slope >= 2) return 'rising_fast';
  if (slope >= 1) return 'rising';
  if (slope <= -2) return 'falling_fast';
  if (slope <= -1) return 'falling';
  return 'steady';
}

/** Valid manual-entry range accepted by the backend. */
export const GLUCOSE_MIN = 20;
export const GLUCOSE_MAX = 600;
