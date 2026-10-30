'use client';

import { BadgeCheck, CircleAlert, Clock, ShieldAlert, XCircle } from 'lucide-react';
import type { VerificationStatus } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { useNow } from '@/lib/useApi';
import { Badge, type BadgeTone } from './Badge';

export function VerificationBadge({ status }: { status: VerificationStatus }) {
  const { te } = useLocale();
  const tone: BadgeTone = status === 'verified' ? 'ok' : status === 'refuted' ? 'danger' : 'neutral';
  const icon =
    status === 'verified' ? (
      <BadgeCheck className="size-3" />
    ) : status === 'refuted' ? (
      <XCircle className="size-3" />
    ) : (
      <CircleAlert className="size-3" />
    );
  return (
    <Badge tone={tone} icon={icon}>
      {te('ver.', status)}
    </Badge>
  );
}

export function DataQualityBadge({ quality }: { quality: 'good' | 'sparse' | 'stale' | 'none' }) {
  const { te } = useLocale();
  const tone: BadgeTone = quality === 'good' ? 'ok' : quality === 'none' ? 'neutral' : 'warn';
  return <Badge tone={tone}>{te('dq.', quality)}</Badge>;
}

const SEVERITY_TONE: Record<string, BadgeTone> = {
  info: 'info',
  low: 'info',
  mild: 'info',
  attention: 'warn',
  moderate: 'warn',
  medium: 'warn',
  major: 'danger',
  high: 'danger',
  urgent: 'danger',
  severe: 'danger',
  contraindicated: 'solid-danger',
  critical: 'solid-danger',
};

export function severityTone(sev: string | null | undefined): BadgeTone {
  return (sev && SEVERITY_TONE[sev]) || 'neutral';
}

export function SeverityBadge({ severity }: { severity: string }) {
  const { te } = useLocale();
  const tone = severityTone(severity);
  return (
    <Badge tone={tone} icon={tone === 'danger' || tone === 'solid-danger' ? <ShieldAlert className="size-3" /> : undefined}>
      {te('sev.', severity)}
    </Badge>
  );
}

/**
 * Data freshness: "Last reading 3 hours ago" + stale badge past the threshold.
 * Pass `at` (the reading time) so the text keeps moving while the page stays open; `ageMinutes` is a snapshot
 * taken when the data was fetched and is only used when no time is known.
 */
export function Freshness({
  at,
  ageMinutes,
  staleAfterMin,
  label,
  forceStale,
}: {
  at?: string | null;
  ageMinutes?: number | null;
  staleAfterMin: number;
  label?: 'common.updated' | 'net.updated';
  forceStale?: boolean;
}) {
  const { t, fmt } = useLocale();
  const now = useNow(30_000);
  let age: number | null = null;
  if (at) {
    const ms = new Date(at).getTime();
    if (!Number.isNaN(ms)) age = Math.max(0, Math.round((now - ms) / 60000));
  }
  if (age === null) age = ageMinutes ?? null;
  if (age === null) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-fg-subtle">
        <Clock className="size-3" />
        {t('common.noData')}
      </span>
    );
  }
  const stale = forceStale || age > staleAfterMin;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
      <Clock className="size-3" aria-hidden />
      {label ? t(label, { t: fmt.relative(new Date(now - age * 60000), now) }) : fmt.relative(new Date(now - age * 60000), now)}
      {stale && <Badge tone="warn">{t('common.stale')}</Badge>}
    </span>
  );
}

const GLYCEMIC_TONE: Record<string, BadgeTone> = {
  in_range: 'ok',
  improving: 'ok',
  worsening_pattern: 'warn',
  hypo_risk: 'danger',
  insufficient_data: 'neutral',
};

export function GlycemicStateChip({ state }: { state: string }) {
  const { te } = useLocale();
  return <Badge tone={GLYCEMIC_TONE[state] ?? 'neutral'}>{te('gs.', state)}</Badge>;
}

const URGENCY_TONE: Record<string, BadgeTone> = {
  info: 'neutral',
  low: 'info',
  medium: 'warn',
  high: 'danger',
  critical: 'solid-danger',
};

export function UrgencyBadge({ urgency }: { urgency: string }) {
  const { te } = useLocale();
  return <Badge tone={URGENCY_TONE[urgency] ?? 'neutral'}>{te('sev.', urgency)}</Badge>;
}

export function ExclusionBadges({ exclusions }: { exclusions: string[] | null | undefined }) {
  const { te } = useLocale();
  // withheld for reception staff
  if (!exclusions?.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {exclusions.map((x) => (
        <Badge key={x} tone="warn" icon={<ShieldAlert className="size-3" aria-hidden />}>
          {te('excl.', x)}
        </Badge>
      ))}
    </span>
  );
}
