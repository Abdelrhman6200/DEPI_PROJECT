'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  AlertOctagon,
  ArrowDown,
  ArrowDownRight,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  ClipboardCheck,
  Clock,
  Droplet,
  Info,
  Lightbulb,
  MessageSquareText,
  Pill,
  PackageOpen,
  Plus,
  ScanSearch,
  Sparkles,
  Stethoscope,
  Utensils,
  WifiOff,
  X,
} from 'lucide-react';
import { DOSE_REASONS, type DoseReason, type TodayPayload } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation, useNow, useVisibleInterval } from '@/lib/useApi';
import { errorKey, isNetworkError } from '@/lib/api';
import { cairoEndOfDay, cairoHour, minutesSince } from '@/lib/format';
import { BAND_TEXT, computeTrend, glucoseBand, GLUCOSE_STALE_MIN_CGM, GLUCOSE_STALE_MIN_MANUAL, type Trend } from '@/lib/glucose';
import { cn } from '@/lib/cn';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/Button';
import { ErrorState } from '@/components/EmptyState';
import { Skeleton, SkeletonCard } from '@/components/Skeleton';
import { InfoTip } from '@/components/InfoTip';
import { severityTone } from '@/components/StatusBadges';
import { AppointmentRow, InsightCard } from '@/components/domain/Rows';
import { useToast } from '@/components/Toast';
import { usePatientShell } from '@/components/patient/PatientShellContext';
import { useSuggestedAction } from '@/components/patient/useSuggestedAction';
import { ConnectClinicCard } from '@/components/patient/ConnectClinicCard';
import { LowGlucoseCard } from '@/components/patient/LogGlucoseDialog';
import { TodayNotices } from '@/components/patient/TodayNotices';
import { TodayExtras } from '@/components/patient/TodayExtras';
import { usePage } from '@/lib/pageBundle';

/** Today is refreshed this often while it is on screen (and when the person comes back to it). */
const REFRESH_MS = 3 * 60_000;

export default function TodayPage() {
  const { scope, user } = useAuth();
  const { t, pick } = useLocale();
  // One request for the screen (lib/pageBundle.ts): today's payload and the notifications.
  usePage('today', 'page', scope, [['today', 'get', scope, 'today'], ['insights', 'notifications', {}, 'notifications', 2], ['glucose', 'list', { ...scope, days: 1 }, 'recent']]);
  const q = useApi('today', 'get', scope);
  const now = useNow(30000);
  useVisibleInterval(() => void q.reload(true), REFRESH_MS);

  if (q.loading && !q.data) return <TodaySkeleton />;
  if (q.error && !q.data) return isNetworkError(q.error) ? <OfflineToday onRetry={() => void q.reload()} /> : <ErrorState error={q.error} onRetry={() => void q.reload()} />;
  if (!q.data) return <TodaySkeleton />;
  const d = q.data;
  const reload = () => void q.reload(true);
  const alerts = isRecentLow(d, now) ? d.safety_alerts.filter((a) => !(GLUCOSE_ALERT.includes(a.severity) && !isLabAlert(a))) : d.safety_alerts;

  // Phones and tablets: one column. Wide screens: the day's actions on one side, the summary on the other.
  return (
    <div className="mx-auto max-w-2xl space-y-5 lg:max-w-5xl">
      {/* A low in the last hour has its own card below (what to do now); its sugar alert is not repeated here. */}
      <RecentLowCard data={d} now={now} />

      {alerts.length > 0 && <SafetyAlerts alerts={alerts} linked={d.patient.tier === 'linked'} />}

      {!!d.unread_messages && (
        <Link href="/app/care#messages" className="flex items-center gap-3 rounded-2xl border-2 border-primary/40 bg-primary-soft p-4 hover:border-primary">
          <MessageSquareText className="size-6 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 flex-1 text-base font-semibold text-fg">{t('team.unread', { n: d.unread_messages })}</span>
          <ChevronRight className="size-5 shrink-0 text-primary rtl:-scale-x-100" aria-hidden />
        </Link>
      )}

      {/* A family member is greeted by their own name; the page then says whose day it shows. */}
      <Greeting
        name={user?.role === 'caregiver' ? user.full_name : d.patient.full_name}
        nameAr={user?.role === 'caregiver' ? user.full_name_ar : d.patient.full_name_ar}
        forName={user?.role === 'caregiver' ? pick(d.patient.full_name, d.patient.full_name_ar) : null}
      />

      <TodayNotices />

      <TodayExtras data={d} />

      <div className="space-y-5 lg:grid lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:items-start lg:gap-5 lg:space-y-0">
        <div className="space-y-5">
          <GlucoseHero data={d} now={now} onLogged={reload} />

          <AfterMealPrompt data={d} now={now} onLogged={reload} />

          {d.patient.exclusions.length > 0 && <ExclusionNote />}

          {d.patient.tier === 'unlinked' && <ConnectClinicCard compact />}

          {d.focus && d.focus.action !== 'log_glucose' && <FocusCard focus={d.focus} onDone={reload} />}

          <Checklist data={d} setData={q.setData} />
        </div>

        <div className="space-y-5">
          {d.appointments.length > 0 && (
            <section aria-labelledby="next-appt">
              <h2 id="next-appt" className="mb-2 flex items-center gap-2 text-lg font-semibold">
                <CalendarDays className="size-5 text-primary" aria-hidden />
                {t('today.appointments')}
              </h2>
              <AppointmentRow appt={[...d.appointments].sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0]} />
            </section>
          )}

          <Insights data={d} setData={q.setData} />

          <NeedCareCard />
        </div>
      </div>
    </div>
  );
}


/** Without a connection people can still log a reading (saved on the phone) and open emergency help. */
function OfflineToday({ onRetry }: { onRetry: () => void }) {
  const { t } = useLocale();
  const { openLogGlucose, openEmergency } = usePatientShell();
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card tone="warn" className="flex items-start gap-3">
        <WifiOff className="mt-0.5 size-6 shrink-0 text-warn" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-base leading-7 font-medium">{t('common.offline')}</p>
          <Button variant="outline" size="md" className="mt-2" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        </div>
      </Card>
      <Button size="xl" className="w-full" icon={<Plus className="size-6" />} onClick={() => openLogGlucose()}>
        {t('today.logReading')}
      </Button>
      <Button size="xl" variant="danger" className="w-full" onClick={openEmergency}>
        {t('em.title')}
      </Button>
    </div>
  );
}

function TodaySkeleton() {
  return (
    <div className="mx-auto max-w-2xl space-y-5" aria-busy="true">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-52 w-full rounded-3xl" />
      <SkeletonCard lines={4} />
      <SkeletonCard lines={2} />
    </div>
  );
}

function Greeting({ name, nameAr, forName }: { name: string; nameAr: string | null; forName: string | null }) {
  const { t, pick, fmt } = useLocale();
  const first = pick(name, nameAr).split(' ')[0];
  // the clinical day is the Cairo day, whatever clock the phone is set to
  const h = cairoHour();
  const key = h < 12 ? 'today.greetingMorning' : h >= 17 ? 'today.greetingEvening' : 'today.greeting';
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t(key, { name: first })}</h1>
      <p className="mt-0.5 text-base text-fg-muted">
        {fmt.weekday(new Date())}
        {forName && <> · {t('today.forPerson', { name: forName })}</>}
      </p>
    </div>
  );
}

function isRecentLow(data: TodayPayload, now: number) {
  const latest = data.glucose.latest;
  if (!latest) return false;
  const band = glucoseBand(latest.value_mgdl);
  const age = minutesSince(latest.measured_at, now) ?? latest.age_minutes;
  return (band === 'low' || band === 'vlow') && age < 60;
}

/** A low reading in the last hour: what to do now comes first on the page (low-sugar plan, Emergency, reminder). */
function RecentLowCard({ data, now }: { data: TodayPayload; now: number }) {
  const { t } = useLocale();
  const { openEmergency } = usePatientShell();
  const latest = data.glucose.latest;
  if (!latest || !isRecentLow(data, now)) return null;
  const band = glucoseBand(latest.value_mgdl);
  return (
    <section aria-labelledby="recent-low-title" className="space-y-2">
      <h2 id="recent-low-title" className="text-lg font-bold text-danger-fg">
        {t(band === 'vlow' ? 'today.veryLowNow' : 'today.lowNow', { v: latest.value_mgdl })}
      </h2>
      <LowGlucoseCard compact message={t('glu.lowWarn')} onEmergency={openEmergency} />
    </section>
  );
}

const MEAL_DISMISS_KEY = 'today.mealPrompt.dismissed';

/**
 * Two hours after a logged meal with no reading since, a gentle suggestion to measure (the after-meal value
 * shows how that meal works for the person). Uses the time of the last meal sent with Today; nothing without it.
 */
function AfterMealPrompt({ data, now, onLogged }: { data: TodayPayload; now: number; onLogged: () => void }) {
  const { t, fmt } = useLocale();
  const { openLogGlucose } = usePatientShell();
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return typeof window === 'undefined' ? null : localStorage.getItem(MEAL_DISMISS_KEY);
    } catch {
      return null;
    }
  });
  const mealAt = data.last_meal_at ?? null;
  // a sensor already shows the after-meal curve
  if (!mealAt || data.glucose.cgm || dismissed === mealAt) return null;
  const at = new Date(mealAt).getTime();
  const mins = (now - at) / 60000;
  const latestReading = data.glucose.latest ? new Date(data.glucose.latest.measured_at).getTime() : 0;
  if (Number.isNaN(at) || mins < 120 || mins > 300 || latestReading > at) return null;
  const dismiss = () => {
    setDismissed(mealAt);
    try {
      localStorage.setItem(MEAL_DISMISS_KEY, mealAt);
    } catch {
      /* ignore */
    }
  };
  return (
    <Card tone="primary" className="flex flex-wrap items-start gap-3">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-fg" aria-hidden>
        <Utensils className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-base font-semibold text-fg">{t('today.afterMealTitle')}</p>
        <p className="mt-0.5 text-base leading-7 text-fg-muted">{t('today.afterMealBody', { time: fmt.time(mealAt) })}</p>
      </div>
      <div className="flex w-full gap-2 sm:w-auto">
        <Button size="md" className="flex-1 sm:flex-none" icon={<Plus className="size-4" />} onClick={() => openLogGlucose(onLogged)}>
          {t('today.logReading')}
        </Button>
        <Button size="md" variant="ghost" onClick={dismiss}>
          {t('today.notNow')}
        </Button>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------ safety */

/** Sugar alerts use these levels; medicine safety notes use "major" / "contraindicated". */
const GLUCOSE_ALERT = ['critical', 'emergency', 'urgent', 'high'];
/** A critical lab result is also "critical" but needs a doctor today, not the low-sugar emergency steps. */
const isLabAlert = (a: TodayPayload['safety_alerts'][number]) => a.kind ? a.kind === 'critical_lab' : /^Result needs a doctor/i.test(a.title);
const ALERT_RANK: Record<string, number> = { critical: 0, emergency: 0, urgent: 1, high: 1, contraindicated: 2, major: 3 };

function SafetyAlerts({ alerts, linked }: { alerts: TodayPayload['safety_alerts']; linked: boolean }) {
  const { t, fmt, pick } = useLocale();
  const { openEmergency, openMessageTeam } = usePatientShell();
  const [showAll, setShowAll] = useState(false);
  // One card per distinct alert (its newest copy), the most serious first, so a red alert is never hidden behind "Show more".
  const newestFirst = [...alerts].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const unique = newestFirst.filter((a, i) => newestFirst.findIndex((x) => x.title === a.title && x.body === a.body) === i);
  const sorted = unique.sort((a, b) => (ALERT_RANK[a.severity] ?? 9) - (ALERT_RANK[b.severity] ?? 9) || b.created_at.localeCompare(a.created_at));
  const shown = showAll ? sorted : sorted.slice(0, 1);
  return (
    <section aria-label={t('today.safetyAlerts')} className="space-y-2">
      {shown.map((a) => {
        const lab = isLabAlert(a);
        const aboutSugar = GLUCOSE_ALERT.includes(a.severity) && !lab;
        const tone = severityTone(a.severity);
        const critical = lab || aboutSugar || tone === 'danger' || tone === 'solid-danger';
        const title = pick(a.title, a.title_ar);
        return (
          <div
            key={a.id}
            role="alert"
            className={cn('rounded-2xl border-2 p-4', critical ? 'border-danger/70 bg-danger-soft' : 'border-warn/60 bg-warn-soft')}
          >
            <div className="flex items-start gap-3">
              <AlertOctagon className={cn('mt-0.5 size-6 shrink-0', critical ? 'text-danger' : 'text-warn')} aria-hidden />
              <div className="min-w-0 flex-1">
                <h2 dir="auto" className="text-lg font-bold text-fg">
                  {title}
                </h2>
                <p dir="auto" className="mt-1 text-base leading-7 text-fg">
                  {pick(a.body, a.body_ar)}
                </p>
                <p className="mt-1 text-sm text-fg-muted">{fmt.relative(a.created_at)}</p>
              </div>
            </div>
            {lab ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <Link
                  href="/app/care-access"
                  className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-danger-solid px-4 text-base font-semibold text-white hover:bg-danger-solid-hover"
                >
                  <Stethoscope className="size-5" aria-hidden />
                  {t('nav.needCare')}
                </Link>
                <Link
                  href="/app/health?tab=labs"
                  className="inline-flex min-h-12 items-center rounded-xl border border-line-strong bg-surface px-4 text-base font-semibold text-fg hover:bg-surface-2"
                >
                  {t('today.seeResult')}
                </Link>
                {linked && (
                  <Button variant="outline" size="lg" onClick={() => openMessageTeam(t('safety.askTeamPrefill', { title }))}>
                    {t('safety.askTeam')}
                  </Button>
                )}
              </div>
            ) : aboutSugar ? (
              <Button variant="danger" size="lg" className="mt-3 w-full sm:w-auto" onClick={openEmergency}>
                {t('ca.showSafety')}
              </Button>
            ) : linked ? (
              <Button variant="outline" size="lg" className="mt-3 w-full sm:w-auto" onClick={() => openMessageTeam(t('safety.askTeamPrefill', { title }))}>
                {t('safety.askTeam')}
              </Button>
            ) : (
              <p className="mt-2 text-base font-medium text-fg">{t('safety.askPharmacist')}</p>
            )}
          </div>
        );
      })}
      {sorted.length > 1 && (
        <button type="button" onClick={() => setShowAll((x) => !x)} className="min-h-11 text-sm font-semibold text-fg-muted underline-offset-4 hover:underline">
          {showAll ? t('common.less') : `${t('common.more')} (${sorted.length - 1})`}
        </button>
      )}
    </section>
  );
}

function ExclusionNote() {
  const { t } = useLocale();
  return (
    <p className="flex items-start gap-2 rounded-2xl bg-info-soft px-4 py-3 text-sm leading-6 text-info-fg">
      <Info className="mt-0.5 size-5 shrink-0" aria-hidden />
      {t('excl.patientNote')}
    </p>
  );
}

/* ------------------------------------------------------------ glucose hero */

const TREND_ICON: Record<Trend, typeof ArrowUp> = {
  rising_fast: ArrowUp,
  rising: ArrowUpRight,
  steady: ArrowRight,
  falling: ArrowDownRight,
  falling_fast: ArrowDown,
};

function GlucoseHero({ data, now, onLogged }: { data: TodayPayload; now: number; onLogged: () => void }) {
  const { t, te, fmt } = useLocale();
  const { scope } = useAuth();
  const { openLogGlucose } = usePatientShell();
  const latest = data.glucose.latest;
  const recent = useApi('glucose', 'list', data.glucose.cgm && latest ? { ...scope, days: 1 } : null);
  const trend = recent.data ? computeTrend(recent.data) : null;
  const band = latest ? glucoseBand(latest.value_mgdl) : null;
  const staleAfter = data.glucose.cgm ? GLUCOSE_STALE_MIN_CGM : GLUCOSE_STALE_MIN_MANUAL;
  // age from the reading time and a ticking clock: the server's age_minutes is frozen at fetch time
  const age = latest ? (minutesSince(latest.measured_at, now) ?? latest.age_minutes) : null;
  const stale = age !== null ? age > staleAfter : false;
  const TrendIcon = trend ? TREND_ICON[trend] : null;

  return (
    <Card className="rounded-3xl p-5 sm:p-6" aria-labelledby="glucose-hero-title">
      <div className="flex items-center justify-between gap-2">
        <h2 id="glucose-hero-title" className="flex items-center gap-2 text-base font-semibold text-fg-muted">
          <Droplet className="size-5 text-primary" aria-hidden />
          {t('today.currentGlucose')}
        </h2>
        {latest && <Badge tone={data.glucose.cgm ? 'primary' : 'neutral'}>{te('src.', latest.source)}</Badge>}
      </div>

      {latest && band ? (
        <div className="mt-3" aria-live="polite">
          <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
            <span className="num text-6xl leading-none font-bold tracking-tight sm:text-7xl" style={{ color: BAND_TEXT[band] }}>
              {latest.value_mgdl}
            </span>
            <span className="mb-1 text-base text-fg-muted">{t('common.mgdl')}</span>
            {TrendIcon && trend && (
              <span className="mb-1 inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-sm font-semibold text-fg">
                <TrendIcon className={cn('size-4', trend.includes('fast') && 'stroke-[3]')} aria-hidden />
                {t(`trend.${trend}`)}
              </span>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="inline-flex items-center gap-1.5 text-base font-semibold" style={{ color: BAND_TEXT[band] }}>
              {band === 'in' ? <Check className="size-5" aria-hidden /> : <AlertOctagon className="size-5" aria-hidden />}
              {t(`band.${band}`)}
            </span>
            <span className="inline-flex items-center gap-1 text-base text-fg-muted">
              <Clock className="size-4" aria-hidden />
              {fmt.relative(latest.measured_at, now)}
            </span>
            {stale && <Badge tone="warn">{t('common.stale')}</Badge>}
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-xl font-semibold text-fg">{t('today.noGlucose')}</p>
          <p className="mt-1 text-base text-fg-muted">{t('today.noGlucoseHint')}</p>
        </div>
      )}

      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Button size="xl" className="w-full sm:w-auto" icon={<Plus className="size-6" />} onClick={() => openLogGlucose(onLogged)}>
          {t('today.logReading')}
        </Button>
        <Link
          href="/app/health/glucose"
          className="inline-flex min-h-12 items-center justify-center gap-1 rounded-xl px-3 text-base font-semibold text-primary-strong hover:bg-primary-soft"
        >
          {t('today.moreDetails')}
          <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden />
        </Link>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------ focus */

function FocusCard({ focus, onDone }: { focus: NonNullable<TodayPayload['focus']>; onDone: () => void }) {
  const { t, pick } = useLocale();
  const run = useSuggestedAction();
  return (
    <Card tone="primary" className="flex flex-wrap items-center gap-3">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-fg" aria-hidden>
        <Lightbulb className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-primary-strong">{t('today.focus')}</div>
        <div className="text-base font-semibold text-fg">{pick(focus.title, focus.title_ar)}</div>
      </div>
      {focus.action && (
        <Button size="md" onClick={() => run(focus.action, onDone)} className="w-full sm:w-auto">
          {t('common.open')}
        </Button>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------ checklist */

type SetData = (u: (prev: TodayPayload | null) => TodayPayload | null) => void;

function Checklist({ data, setData }: { data: TodayPayload; setData: SetData }) {
  const { t, te, pick, fmt } = useLocale();
  const { scope } = useAuth();
  const { mutate } = useMutation();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  // The dose whose "Missed" was tapped: the reason chooser opens under it (the reason can be skipped).
  const [asking, setAsking] = useState<string | null>(null);

  const meds = data.medications_due;
  const refills = data.refills_due ?? [];
  // Today's list holds what is due today (or overdue). Tasks for later are shown separately and are not counted.
  const endOfToday = cairoEndOfDay();
  const tasks = data.tasks.filter((x) => !x.due_at || new Date(x.due_at) <= endOfToday);
  const later = data.tasks.filter((x) => x.due_at && new Date(x.due_at) > endOfToday);
  const total = meds.length + tasks.length;
  // Only what was really done counts as done: a missed dose is not a finished item.
  const missed = meds.filter((m) => m.status === 'missed' || m.status === 'skipped').length;
  const done = meds.filter((m) => m.status === 'taken').length + tasks.filter((x) => x.status === 'done').length;
  const open = meds.filter((m) => m.status === 'due').length + tasks.filter((x) => x.status === 'pending').length;

  async function logDose(m: TodayPayload['medications_due'][number], status: 'taken' | 'missed', reason?: DoseReason) {
    const key = `${m.medication_id}-${m.time}-${status}`;
    setBusy(key);
    try {
      await mutate('clinical', 'log_dose', { ...scope, medication_id: m.medication_id, status, scheduled_time: m.time, ...(reason ? { reason } : {}) });
      setData((prev) =>
        prev ? { ...prev, medications_due: prev.medications_due.map((x) => (x.medication_id === m.medication_id && x.time === m.time ? { ...x, status } : x)) } : prev,
      );
      setAsking(null);
      // Not available, too expensive or side effects: the care team sees it in their inbox.
      toast(reason === 'not_available' || reason === 'cost' || reason === 'side_effects' ? t('dose.teamTold') : t('common.saved'));
    } catch (e) {
      toast(<ErrorText error={e} />, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function completeTask(id: string) {
    setBusy(id);
    try {
      await mutate('care', 'complete_task', { task_id: id, status: 'done' });
      setData((prev) => (prev ? { ...prev, tasks: prev.tasks.map((x) => (x.id === id ? { ...x, status: 'done' } : x)) } : prev));
      toast(t('common.done'));
    } catch (e) {
      toast(<ErrorText error={e} />, 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card aria-labelledby="checklist-title">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id="checklist-title" className="flex items-center gap-2 text-lg font-semibold">
          <ClipboardCheck className="size-5 text-primary" aria-hidden />
          {t('today.checklist')}
        </h2>
        {total > 0 && (
          <span className="num rounded-full bg-surface-2 px-2.5 py-0.5 text-sm font-semibold text-fg-muted">
            {done}/{total}
          </span>
        )}
      </div>

      {total === 0 ? (
        <p className="flex items-center gap-2 rounded-xl bg-ok-soft px-4 py-3 text-base text-ok-fg">
          <Check className="size-5" aria-hidden />
          {t('today.checklistEmpty')}
        </p>
      ) : (
        <>
        {meds.length > 0 && tasks.length > 0 && <h3 className="mb-1 text-sm font-semibold text-fg-muted">{t('today.medsDue')}</h3>}
        <ul className="divide-y divide-line">
          {meds.map((m) => {
            const key = `${m.medication_id}-${m.time}`;
            return (
              <li key={key} className="py-3 first:pt-0">
                <div className="flex items-start gap-3">
                  <StatusDot status={m.status === 'taken' ? 'done' : m.status === 'due' ? 'todo' : 'missed'} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className={cn('text-base font-semibold', m.status !== 'due' && 'text-fg-muted')}>
                        <Pill className="me-1 inline size-4 text-fg-subtle" aria-hidden />
                        <bdi>{m.name}</bdi>
                      </span>
                      {m.dose_text && (
                        <span className="text-sm text-fg-muted">
                          <bdi>{m.dose_text}</bdi>
                        </span>
                      )}
                    </div>
                    <div className="num text-sm text-fg-muted">{m.time}</div>
                  </div>
                  {m.status === 'taken' && <Badge tone="ok">{t('today.taken')}</Badge>}
                  {(m.status === 'missed' || m.status === 'skipped') && (
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Badge tone="warn">{t(m.status === 'skipped' ? 'task.skipped' : 'today.missed')}</Badge>
                      <Button size="sm" variant="ghost" loading={busy === `${key}-taken`} onClick={() => void logDose(m, 'taken')} className="text-primary-strong">
                        {t('today.tookLate')}
                      </Button>
                    </div>
                  )}
                </div>
                {m.status === 'due' && (
                  <div className="mt-2 grid grid-cols-2 gap-2 ps-9">
                    <Button size="md" icon={<Check className="size-4" />} loading={busy === `${key}-taken`} onClick={() => void logDose(m, 'taken')}>
                      {t('today.taken')}
                    </Button>
                    <Button size="md" variant="outline" icon={<X className="size-4" />} aria-expanded={asking === key} onClick={() => setAsking(asking === key ? null : key)}>
                      {t('today.missed')}
                    </Button>
                  </div>
                )}
                {m.status === 'due' && asking === key && (
                  <div className="mt-2 ps-9" role="group" aria-label={t('dose.why')}>
                    <p className="mb-2 text-sm font-medium text-fg-muted">{t('dose.why')}</p>
                    <div className="flex flex-wrap gap-2">
                      {DOSE_REASONS.map((r) => (
                        <Button key={r} size="sm" variant="soft" disabled={busy === `${key}-missed`} onClick={() => void logDose(m, 'missed', r)}>
                          {te('dose.reason.', r)}
                        </Button>
                      ))}
                      <Button size="sm" variant="ghost" loading={busy === `${key}-missed`} onClick={() => void logDose(m, 'missed')}>
                        {t('dose.noReason')}
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {meds.length > 0 && tasks.length > 0 && <h3 className="mt-3 mb-1 border-t border-line pt-3 text-sm font-semibold text-fg-muted">{t('today.tasks')}</h3>}
        <ul className="divide-y divide-line">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-center gap-3 py-3 first:pt-0">
              <StatusDot status={task.status === 'pending' ? 'todo' : task.status === 'done' ? 'done' : 'missed'} />
              <div className="min-w-0 flex-1">
                <div className={cn('text-base font-semibold', task.status !== 'pending' && 'text-fg-muted line-through decoration-1')}>{pick(task.title, task.title_ar)}</div>
                {task.due_at && <div className="text-sm text-fg-muted">{fmt.time(task.due_at)}</div>}
              </div>
              {task.status === 'pending' ? (
                <Button size="md" variant="soft" icon={<Check className="size-4" />} loading={busy === task.id} onClick={() => void completeTask(task.id)}>
                  {t('today.complete')}
                </Button>
              ) : (
                <Badge tone={task.status === 'done' ? 'ok' : 'neutral'}>{t(task.status === 'done' ? 'task.done' : 'task.skipped')}</Badge>
              )}
            </li>
          ))}
        </ul>
        </>
      )}
      {refills.length > 0 && (
        <div className="mt-3 rounded-xl border border-warn/40 bg-warn-soft px-4 py-3" role="status">
          <p className="flex items-center gap-2 text-base font-semibold text-warn-fg">
            <PackageOpen className="size-5 shrink-0" aria-hidden />
            {t('refill.title')}
          </p>
          <ul className="mt-1 space-y-0.5 text-base">
            {refills.map((r) => (
              <li key={r.medication_id}>
                <bdi className="font-medium">{r.name}</bdi>{' '}
                <span className="text-fg-muted">
                  {r.days_left === null ? '' : r.days_left <= 0 ? t('refill.today') : r.days_left === 1 ? t('refill.tomorrow') : t('refill.days', { n: r.days_left })}
                </span>
              </li>
            ))}
          </ul>
          <Link href="/app/care/find?type=pharmacy" className="mt-2 inline-flex min-h-11 items-center gap-1 text-base font-semibold text-primary-strong hover:underline">
            {t('refill.findPharmacy')}
          </Link>
        </div>
      )}
      {total > 0 && done === total && (
        <p className="mt-3 flex items-center gap-2 rounded-xl bg-ok-soft px-4 py-3 text-base font-medium text-ok-fg" role="status">
          <Sparkles className="size-5" aria-hidden />
          {t('today.checklistDone')}
        </p>
      )}
      {total > 0 && open === 0 && missed > 0 && (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-surface-2 px-4 py-3 text-base leading-7 text-fg" role="status">
          <Info className="mt-1 size-5 shrink-0 text-fg-muted" aria-hidden />
          {t('today.checklistMissed', { n: missed })}
        </p>
      )}
      {later.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <h3 className="mb-1 text-sm font-semibold text-fg-muted">{t('today.tomorrow')}</h3>
          <ul className="space-y-1">
            {later.map((task) => (
              <li key={task.id} className="flex items-baseline justify-between gap-3 text-base text-fg-muted">
                <span>{pick(task.title, task.title_ar)}</span>
                {task.due_at && <span className="num shrink-0 text-sm">{fmt.time(task.due_at)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.screenings_overdue.length > 0 && (
        <details className="mt-4 border-t border-line pt-3">
          <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-base font-medium text-fg">
            <ScanSearch className="size-5 text-warn" aria-hidden />
            {t('today.screeningsN', { n: data.screenings_overdue.length })}
          </summary>
          <ul className="mt-1 space-y-1.5">
            {data.screenings_overdue.map((s) => (
              <li key={s.type} className="flex items-start gap-2 text-base">
                <Circle className="mt-1.5 size-3 shrink-0 fill-warn text-warn" aria-hidden />
                <span>
                  <span className="font-medium">{pick(s.title, s.title_ar)}</span>
                  <span className="text-fg-muted"> · {t('today.screeningDue')}</span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

function ErrorText({ error }: { error: unknown }) {
  const { t } = useLocale();
  return <>{t(errorKey(error))}</>;
}

function StatusDot({ status }: { status: 'todo' | 'done' | 'missed' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border-2',
        status === 'done' && 'border-ok bg-ok text-white',
        status === 'missed' && 'border-warn bg-warn-soft text-warn',
        status === 'todo' && 'border-line-strong',
      )}
    >
      {status === 'done' && <Check className="size-4 stroke-[3]" />}
      {status === 'missed' && <X className="size-3.5 stroke-[3]" />}
    </span>
  );
}

/* ------------------------------------------------------------ insights */

function Insights({ data, setData }: { data: TodayPayload; setData: SetData }) {
  const { t } = useLocale();
  const { mutate } = useMutation();
  const [busy, setBusy] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const sorted = [...data.insights].sort((a, b) => Number(!!a.read_at) - Number(!!b.read_at) || b.created_at.localeCompare(a.created_at));
  if (!sorted.length) return null;
  const shown = all ? sorted : sorted.slice(0, 1);

  async function mark(id: string) {
    setBusy(id);
    try {
      await mutate('insights', 'mark_read', { insight_id: id });
      setData((prev) => (prev ? { ...prev, insights: prev.insights.map((i) => (i.id === id ? { ...i, read_at: new Date().toISOString() } : i)) } : prev));
    } catch {
      /* non-critical */
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="insights-title">
      <h2 id="insights-title" className="mb-2 flex items-center gap-2 text-lg font-semibold">
        <Sparkles className="size-5 text-primary" aria-hidden />
        {t('today.insights')}
      </h2>
      <div className="space-y-2.5">
        {shown.map((i) => (
          <InsightCard key={i.id} insight={i} marking={busy === i.id} onMarkRead={() => void mark(i.id)} />
        ))}
      </div>
      {sorted.length > 1 && (
        <button type="button" onClick={() => setAll((x) => !x)} className="mt-2 min-h-11 text-base font-semibold text-primary-strong hover:underline">
          {all ? t('common.less') : `${t('common.more')} (${sorted.length - 1})`}
        </button>
      )}
    </section>
  );
}

/* ------------------------------------------------------------ need care */

function NeedCareCard() {
  const { t, dir } = useLocale();
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;
  return (
    <Link href="/app/care-access" className="block rounded-2xl border-2 border-line bg-surface p-4 transition-colors hover:border-primary">
      <div className="flex items-center gap-3">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary-soft text-primary" aria-hidden>
          <Stethoscope className="size-6" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-lg font-semibold text-fg">{t('today.needCareCard')}</span>
          <span className="block text-base leading-6 text-fg-muted">{t('today.needCareBody')}</span>
        </span>
        <Chevron className="size-6 shrink-0 text-fg-subtle" aria-hidden />
      </div>
    </Link>
  );
}
