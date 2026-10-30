import type { Locale } from '@health/api-client';

/** The clinical day is the Cairo day: dates, times and "today" follow Egypt time whatever the device clock says. */
export const CLINIC_TZ = 'Africa/Cairo';

/** Intl locale tag. Arabic uses Egyptian conventions with Latin digits so clinical numbers match charts and devices. */
export function intlLocale(locale: Locale): string {
  return locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB';
}

function toDate(v: string | number | Date | null | undefined): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: CLINIC_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Calendar parts of an instant in Cairo time. */
export function cairoParts(d: Date = new Date()): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = partsFmt.formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') };
}

/** The hour (0-23) in Cairo now. */
export function cairoHour(d: Date = new Date()): number {
  return cairoParts(d).hour;
}

/** The instant a Cairo calendar day ends (23:59:59.999 Cairo time). */
export function cairoEndOfDay(d: Date = new Date()): Date {
  const p = cairoParts(d);
  // Cairo offset at that moment (+2 or +3 with summer time), from the difference between wall time and UTC
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const offsetMs = wallAsUtc - Math.floor(d.getTime() / 60000) * 60000;
  return new Date(Date.UTC(p.year, p.month - 1, p.day, 23, 59, 59, 999) - offsetMs);
}

/** Midnight that starts the Cairo day containing `ms` (used for chart day ticks). */
export function cairoStartOfDay(ms: number): number {
  return cairoEndOfDay(new Date(ms)).getTime() + 1 - 86_400_000;
}

export function makeFormatters(locale: Locale) {
  const tag = intlLocale(locale);
  const nf = (digits = 0) => new Intl.NumberFormat(tag, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  const rtf = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });
  const dtf = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(tag, { timeZone: CLINIC_TZ, ...o });

  function relative(v: string | Date | null | undefined, now: number = Date.now()): string {
    const d = toDate(v);
    if (!d) return '—';
    const diffSec = Math.round((d.getTime() - now) / 1000);
    const abs = Math.abs(diffSec);
    if (abs < 45) return rtf.format(0, 'second');
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour');
    if (abs < 86400 * 30) return rtf.format(Math.round(diffSec / 86400), 'day');
    if (abs < 86400 * 365) return rtf.format(Math.round(diffSec / (86400 * 30)), 'month');
    return rtf.format(Math.round(diffSec / (86400 * 365)), 'year');
  }

  return {
    number(n: number | null | undefined, digits = 0): string {
      if (n === null || n === undefined || Number.isNaN(n)) return '—';
      return nf(digits).format(n);
    },
    pct(n: number | null | undefined, digits = 0): string {
      if (n === null || n === undefined || Number.isNaN(n)) return '—';
      return `${nf(digits).format(n)}%`;
    },
    date(v: string | Date | null | undefined): string {
      const d = toDate(v);
      return d ? dtf({ day: 'numeric', month: 'short', year: 'numeric' }).format(d) : '—';
    },
    shortDate(v: string | Date | null | undefined): string {
      const d = toDate(v);
      return d ? dtf({ day: 'numeric', month: 'short' }).format(d) : '—';
    },
    month(v: string | Date | null | undefined): string {
      const d = toDate(v);
      return d ? dtf({ month: 'short' }).format(d) : '—';
    },
    weekday(v: string | Date | null | undefined): string {
      const d = toDate(v);
      return d ? dtf({ weekday: 'short', day: 'numeric', month: 'short' }).format(d) : '—';
    },
    time(v: string | Date | null | undefined): string {
      const d = toDate(v);
      return d ? dtf({ hour: 'numeric', minute: '2-digit' }).format(d) : '—';
    },
    dateTime(v: string | Date | null | undefined): string {
      const d = toDate(v);
      return d ? dtf({ day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(d) : '—';
    },
    /** "3 hours ago", "in 2 days" */
    relative,
    /**
     * Relative time from an age in minutes. Prefer `relative(measured_at, now)`: an age is a snapshot from the
     * moment the data was fetched and does not move on while the page stays open.
     */
    ageMinutes(min: number | null | undefined): string {
      if (min === null || min === undefined) return '—';
      return relative(new Date(Date.now() - min * 60000));
    },
    /** An hour of the day (0-23) as a clock label; not tied to any date, so no time zone applies. */
    hour(h: number): string {
      return new Intl.DateTimeFormat(tag, { hour: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, 0, 1, h, 0, 0)));
    },
    /** Join names or places with the comma of the current language (Arabic comma only in Arabic). */
    list(parts: (string | null | undefined | false)[]): string {
      return parts.filter(Boolean).join(locale === 'ar' ? '، ' : ', ');
    },
  };
}

export type Formatters = ReturnType<typeof makeFormatters>;

/** Minutes since an ISO timestamp, or null. Pass `now` from useNow() so the value keeps moving. */
export function minutesSince(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now - t) / 60000));
}

/** Convert a datetime-local input value ("2026-10-08T14:30") to ISO, or undefined. */
export function localInputToIso(v: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local time formatted for <input type="datetime-local">. */
export function nowLocalInput(offsetMinutes = 0): string {
  const d = new Date(Date.now() + offsetMinutes * 60000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Calendar date YYYY-MM-DD of the Cairo day (the clinical day), e.g. "today" for date inputs and daily logs. */
export function isoDate(d: Date = new Date()): string {
  const p = cairoParts(d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * Inbox titles and bodies are written by the service and may quote rule codes ("Red flags: chest_pain",
 * 'Matched: ["chest_pain"]'). Staff see them as words: lists unwrapped, underscores as spaces.
 */
export function plainCodes(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/\[((?:\s*"[^"]*"\s*,?)+)\]/g, (_, inner: string) => inner.replace(/"/g, '').split(/\s*,\s*/).filter(Boolean).join(', '))
    .replace(/\b([a-z]+(?:_[a-z0-9]+)+)\b/g, (m) => m.replace(/_/g, ' '));
}
