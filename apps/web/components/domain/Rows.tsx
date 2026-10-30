'use client';

import { CalendarClock, Phone, MapPin, Video, Building2, FileCheck2, Bell, CheckCheck } from 'lucide-react';
import type { Appointment, GlucosePattern, Insight, Referral, SafetyFinding, Screening } from '@health/api-client';
import Link from 'next/link';
import { useLocale } from '@/lib/locale';
import { cn } from '@/lib/cn';
import { cairoParts } from '@/lib/format';
import type { TKey } from '@/lib/i18n';
import { Badge, type BadgeTone } from '../Badge';
import { Button } from '../Button';
import { AiBlock } from '../AiLabel';
import { SeverityBadge } from '../StatusBadges';
import type { ReactNode } from 'react';

const APPT_TONE: Record<Appointment['status'], BadgeTone> = {
  requested: 'warn',
  booked: 'primary',
  checked_in: 'info',
  completed: 'ok',
  cancelled: 'neutral',
  no_show: 'danger',
};

/** `pro` adds staff-only details (for example that a pre-visit brief is ready). */
export function AppointmentRow({ appt, showPatient, action, pro }: { appt: Appointment; showPatient?: boolean; action?: ReactNode; pro?: boolean }) {
  const { te, fmt, t } = useLocale();
  const ChannelIcon = appt.channel === 'video' ? Video : appt.channel === 'phone' ? Phone : MapPin;
  const d = new Date(appt.starts_at);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-3">
      <div className="flex w-14 shrink-0 flex-col items-center rounded-xl bg-primary-soft py-1.5 text-primary-strong" aria-hidden>
        <span className="text-xs font-medium">{fmt.month(d)}</span>
        <span className="num text-xl leading-6 font-bold">{cairoParts(d).day}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-base font-semibold text-fg">{showPatient ? appt.patient_name : appt.provider_name || appt.facility_name || te('apptType.', appt.type)}</span>
          <Badge tone={APPT_TONE[appt.status]}>{te('appt.', appt.status)}</Badge>
          {pro && appt.has_brief && <Badge tone="info">{t('pv.hasBrief')}</Badge>}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-fg-muted">
          <span className="inline-flex items-center gap-1">
            <CalendarClock className="size-4" aria-hidden />
            {fmt.weekday(appt.starts_at)} · {fmt.time(appt.starts_at)}
          </span>
          <span className="inline-flex items-center gap-1">
            <ChannelIcon className="size-4" aria-hidden />
            {te('ch.', appt.channel)}
          </span>
          {appt.facility_name && (showPatient || appt.provider_name) && (
            <span className="inline-flex items-center gap-1">
              <Building2 className="size-4" aria-hidden />
              {appt.facility_name}
            </span>
          )}
        </div>
        {appt.reason && (
          <p dir="auto" className="mt-1 truncate text-sm text-fg-subtle">
            {appt.reason}
          </p>
        )}
      </div>
      {action && <div className="flex w-full justify-end sm:w-auto">{action}</div>}
    </div>
  );
}

export function InsightCard({ insight, onMarkRead, marking, pro }: { insight: Insight; onMarkRead?: () => void; marking?: boolean; pro?: boolean }) {
  const { pick, fmt, t, te, locale } = useLocale();
  const unread = !insight.read_at;
  // Older notes may have an English title only; in Arabic show the translated kind instead of an English sentence.
  const localTitle = pick(insight.title, insight.title_ar);
  const title = locale === 'ar' && !/[؀-ۿ]/.test(localTitle) ? te('ik.', insight.kind) : localTitle;
  // Where the person can see what the note is about.
  const more: { href: string; label: TKey } | null = pro
    ? null
    : insight.kind === 'plan_change'
      ? { href: '/app/care', label: 'ins.seePlan' }
      : insight.kind === 'lab'
        ? { href: '/app/health?tab=labs', label: 'ins.seeResults' }
        : insight.kind === 'safety'
          ? { href: '/app/health', label: 'ins.seeMedicines' }
          : { href: '/app/health/glucose', label: 'today.moreDetails' };
  return (
    <article className={cn('rounded-2xl border p-4', unread ? 'border-primary/30 bg-primary-soft/50' : 'border-line bg-surface')}>
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          {unread ? <Bell className="mt-1 size-4 shrink-0 text-primary" aria-hidden /> : <CheckCheck className="mt-1 size-4 shrink-0 text-fg-subtle" aria-hidden />}
          <h3 dir="auto" className="text-base font-semibold text-fg">
            {title}
          </h3>
        </div>
        <span className="shrink-0 text-xs text-fg-subtle">{fmt.relative(insight.created_at)}</span>
      </div>
      {insight.ai_written === false ? (
        <div dir="auto" className="text-base leading-7 whitespace-pre-line text-fg">
          {pick(insight.body, insight.body_ar)}
        </div>
      ) : (
        <AiBlock citations={insight.citations} pro={pro}>
          {pick(insight.body, insight.body_ar)}
        </AiBlock>
      )}
      {(more || (unread && onMarkRead)) && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          {more ? (
            <Link href={more.href} className="inline-flex min-h-11 items-center text-base font-semibold text-primary-strong underline-offset-4 hover:underline">
              {t(more.label)}
            </Link>
          ) : (
            <span />
          )}
          {unread && onMarkRead && (
            <Button size="md" variant="ghost" onClick={onMarkRead} loading={marking} icon={<CheckCheck className="size-4" />}>
              {t('today.markRead')}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

export function ScreeningRow({ s, action }: { s: Screening; action?: ReactNode }) {
  const { pick, fmt, t } = useLocale();
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-3">
      <div className="min-w-0">
        <div className="text-base font-medium">{pick(s.title, s.title_ar)}</div>
        <div className="text-sm text-fg-muted">
          {s.last_done ? t('care.lastDone', { d: fmt.date(s.last_done) }) : t('care.neverDone')}
          {s.next_due && <> · {t('care.nextDue', { d: fmt.date(s.next_due) })}</>}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        {s.overdue ? <Badge tone="warn">{t('care.overdue')}</Badge> : <Badge tone="ok">{t('care.upToDate')}</Badge>}
        {action}
      </div>
    </div>
  );
}

const REF_TONE: Record<Referral['urgency'], BadgeTone> = { routine: 'neutral', soon: 'warn', urgent: 'danger' };

/** `pro` shows the clinician's wording as written; patients get it behind "Note from your doctor". */
export function ReferralRow({ r, showPatient, action, pro }: { r: Referral; showPatient?: boolean; action?: ReactNode; pro?: boolean }) {
  const { te, fmt, t } = useLocale();
  return (
    <div className="rounded-2xl border border-line bg-surface p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {showPatient && <span className="text-sm font-semibold">{r.patient_name}</span>}
            <span className="text-base font-medium">{te('spec.', r.to_specialty)}</span>
            {/* reception staff get referrals without clinical details (urgency, reason) */}
            {r.urgency && <Badge tone={REF_TONE[r.urgency]}>{te('ref.', r.urgency)}</Badge>}
            <Badge tone="primary">{te('rs.', r.status)}</Badge>
          </div>
          <div className="mt-0.5 text-sm text-fg-muted">
            {r.to_facility_name && <>{r.to_facility_name} · </>}
            {fmt.date(r.created_at)}
          </div>
          {pro ? (
            r.reason ? (
              <p dir="auto" className="mt-1 text-sm text-fg-muted">
                {r.reason}
              </p>
            ) : null
          ) : (
            <>
              <p className="mt-1 text-base leading-7 text-fg">{te('refNext.', r.status)}</p>
              {r.reason && (
                <details className="mt-1 text-sm text-fg-muted">
                  <summary className="inline-flex min-h-9 cursor-pointer items-center font-medium text-primary-strong">{t('ref.doctorNote')}</summary>
                  <p dir="auto" className="mt-1 leading-6">
                    {r.reason}
                  </p>
                </details>
              )}
            </>
          )}
          {r.report && (
            <div className="mt-2 rounded-lg bg-surface-2 p-2 text-sm">
              <span className="inline-flex items-center gap-1 font-medium">
                <FileCheck2 className="size-4" aria-hidden />
                {t('ref.report')}
              </span>
              <p dir="auto" className="mt-0.5 whitespace-pre-line text-fg-muted">
                {r.report}
              </p>
            </div>
          )}
        </div>
        {action}
      </div>
    </div>
  );
}

const PATTERN_TONE: Record<GlucosePattern['severity'], BadgeTone> = { info: 'info', attention: 'warn', urgent: 'danger' };

export function PatternRow({ p }: { p: GlucosePattern }) {
  const { pick, te, t } = useLocale();
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-2xl border p-3',
        p.severity === 'urgent' ? 'border-danger/40 bg-danger-soft' : p.severity === 'attention' ? 'border-warn/30 bg-warn-soft/60' : 'border-line bg-surface',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-base font-medium">{pick(p.title, p.title_ar)}</span>
          <Badge tone={PATTERN_TONE[p.severity]}>{te('sev.', p.severity)}</Badge>
        </div>
        <div className="mt-0.5 text-sm text-fg-muted">{t('glu.evidence', { n: p.evidence_count })}</div>
      </div>
    </div>
  );
}

export function SafetyFindingCard({
  f,
  action,
  pro,
  count,
  onAskTeam,
}: {
  f: SafetyFinding;
  action?: ReactNode;
  pro?: boolean;
  /** How many identical notes this card stands for (patients see one card per distinct note). */
  count?: number;
  /** Patients: opens "Message my care team" about this note. */
  onAskTeam?: () => void;
}) {
  const { te, t, fmt, pick } = useLocale();
  const severe = f.severity === 'major' || f.severity === 'contraindicated';
  // The stored explanation is either written by AI or a fixed sentence that repeats the note. Patients only see
  // it when it adds something, and it is labelled as AI-written only when it is.
  const explanation = pick(f.explanation ?? '', f.explanation_ar) || null;
  const restates = !!explanation && (/^(A safety check flagged|رصد فحص السلامة)/.test(explanation) || explanation.includes(f.detail));
  const showExplanation = !!explanation && (pro || !restates);
  return (
    <div
      className={cn(
        'rounded-2xl border p-3',
        severe ? 'border-danger/40 bg-danger-soft' : f.severity === 'moderate' ? 'border-warn/40 bg-warn-soft' : 'border-line bg-surface',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {/* "Should not be combined" describes two medicines; an allergy gets its own wording. */}
            {f.kind === 'allergy' ? <Badge tone="danger">{t('sev.allergyAvoid')}</Badge> : <SeverityBadge severity={f.severity} />}
            <Badge>{te('kind.', f.kind)}</Badge>
            {f.status !== 'open' && <Badge tone="ok">{te('fs.', f.status)}</Badge>}
            {!!count && count > 1 && <Badge>{t('health.seenTimes', { n: count })}</Badge>}
          </div>
          <h4 dir="auto" className="mt-1.5 text-base font-semibold text-fg">
            {f.title}
          </h4>
          <p dir="auto" className={cn('mt-0.5 leading-6', pro ? 'text-sm text-fg-muted' : 'text-base text-fg')}>
            {f.detail}
          </p>
          {showExplanation && (
            <AiBlock pro={pro} className="mt-2 rounded-lg bg-surface/70 p-2">
              {explanation}
            </AiBlock>
          )}
          <p className="mt-1 text-xs text-fg-muted">{fmt.dateTime(f.created_at)}</p>
          {onAskTeam && f.status === 'open' && (
            <Button variant="outline" size="md" className="mt-2" onClick={onAskTeam}>
              {t('safety.askTeam')}
            </Button>
          )}
        </div>
        {action}
      </div>
    </div>
  );
}
