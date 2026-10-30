'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertOctagon,
  ArrowLeft,
  ArrowRight,
  CalendarPlus,
  Home,
  Loader2,
  MapPinned,
  MessageSquareText,
  Phone,
  RotateCcw,
  ShieldAlert,
  Stethoscope,
} from 'lucide-react';
import type { Episode, IntakeQuestion, IntakeStepResult } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { api } from '@/lib/api';
import { useMutation } from '@/lib/useApi';
import { useModal } from '@/lib/useModal';
import { cn } from '@/lib/cn';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/Button';
import { OptionButtons, Textarea } from '@/components/Field';
import { ErrorState, InlineError } from '@/components/EmptyState';
import { SkeletonCard } from '@/components/Skeleton';
import { CareLevelScale, careLevelSeverity } from '@/components/CareLevelScale';
import { AiBlock } from '@/components/AiLabel';
import { InfoTip } from '@/components/InfoTip';
import { FacilityCard } from '@/components/domain/Facility';
import { BookAppointmentDialog } from '@/components/domain/BookAppointmentDialog';
import { EpisodeFollowupForm } from '@/components/domain/EpisodeViews';
import { usePatientShell } from '@/components/patient/PatientShellContext';
import { useErrorToast, useToast } from '@/components/Toast';

type Emergency = NonNullable<IntakeStepResult['emergency']>;

/** Known intake order (database seed positions) so the progress bar is meaningful. */
const QUESTION_ORDER = ['q_red_flags', 'q_area', 'q_onset', 'q_severity', 'q_glucose_now', 'q_fever', 'q_foot', 'q_eat_drink', 'q_trend', 'q_goal', 'q_planned'];
const TOTAL = QUESTION_ORDER.length;

interface Asked {
  q: IntakeQuestion;
  answer: unknown;
}

export default function CareAccessPage() {
  const { scope } = useAuth();
  const { t, dir } = useLocale();
  const { mutate, pending, error, clearError } = useMutation();
  const [episode, setEpisode] = useState<Episode | null>(null);
  const [question, setQuestion] = useState<IntakeQuestion | null>(null);
  const [asked, setAsked] = useState<Asked[]>([]);
  const [revisit, setRevisit] = useState<Asked | null>(null);
  const [emergency, setEmergency] = useState<Emergency | null>(null);
  const [takeoverShown, setTakeoverShown] = useState<string | null>(null);
  const [complaint, setComplaint] = useState('');
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<unknown>(null);
  const [aiPending, setAiPending] = useState(false);
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;

  // resume an existing episode: /app/care-access?episode=<id>
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('episode');
    if (!id) return;
    setResuming(true);
    api
      .call('episodes', 'get', { episode_id: id })
      .then((ep) => {
        setEpisode(ep);
        setQuestion(ep.next_question ?? null);
        setComplaint(ep.chief_complaint);
      })
      .catch((e) => setResumeError(e))
      .finally(() => setResuming(false));
  }, []);

  function handle(r: IntakeStepResult) {
    setEpisode(r.episode);
    setQuestion(r.next_question);
    setRevisit(null);
    if (r.emergency) setEmergency(r.emergency);
    window.scrollTo({ top: 0 });
  }

  async function start(text: string) {
    clearError();
    try {
      setAsked([]);
      setComplaint(text);
      handle(await mutate('intake', 'start', { ...scope, complaint_text: text }));
    } catch {
      /* inline */
    }
  }
  async function answer(q: IntakeQuestion, value: unknown) {
    if (!episode) return;
    clearError();
    try {
      const r = await mutate('intake', 'answer', { episode_id: episode.id, question_id: q.id, answer: value as string | number | boolean | string[] });
      setAsked((xs) => (xs.some((x) => x.q.id === q.id) ? xs.map((x) => (x.q.id === q.id ? { q, answer: value } : x)) : [...xs, { q, answer: value }]));
      handle(r);
    } catch {
      /* inline */
    }
  }
  async function freeText(text: string) {
    if (!episode) return;
    clearError();
    setAiPending(true);
    try {
      handle(await mutate('intake', 'free_text', { episode_id: episode.id, text }));
    } catch {
      /* inline */
    } finally {
      setAiPending(false);
    }
  }

  function goBack() {
    clearError();
    const current = revisit ?? (question ? { q: question, answer: undefined } : null);
    const idx = current ? asked.findIndex((x) => x.q.id === current.q.id) : asked.length;
    const prevIdx = (idx === -1 ? asked.length : idx) - 1;
    if (prevIdx >= 0) setRevisit(asked[prevIdx]);
    else reset();
  }

  function reset() {
    setEpisode(null);
    setQuestion(null);
    setAsked([]);
    setRevisit(null);
    setEmergency(null);
    clearError();
    window.history.replaceState(null, '', '/app/care-access');
  }

  if (resuming) return <SkeletonCard lines={4} className="mx-auto max-w-xl" />;
  if (resumeError) return <ErrorState error={resumeError} onRetry={() => window.location.reload()} />;

  const shownQ = revisit?.q ?? question;
  const assessed = !!episode && !question && !revisit && !!episode.assessment;
  const stillIntake = !!episode && !question && !revisit && !episode.assessment;
  const level = episode?.assessment?.care_level;
  const emergencyLevel = level === 'emergency_services' || level === 'emergency_department';
  const showTakeover = !!emergency || (assessed && emergencyLevel && takeoverShown !== episode!.id);

  const pos = shownQ ? QUESTION_ORDER.indexOf(shownQ.id) : -1;
  const answeredCount = asked.length;
  const progress = assessed ? 100 : shownQ ? Math.round(((pos >= 0 ? pos : answeredCount) / TOTAL) * 100) : 5;

  return (
    <div className="mx-auto max-w-xl space-y-5">
      {/* header with back + progress */}
      <div>
        <div className="flex items-center justify-between gap-2">
          {episode && !assessed ? (
            <Button variant="ghost" size="md" icon={<Back className="size-5" />} onClick={goBack} className="-ms-3">
              {t('common.back')}
            </Button>
          ) : (
            <span />
          )}
          {episode && (
            <Button variant="ghost" size="md" icon={<RotateCcw className="size-4" />} onClick={reset} className="-me-3">
              {t('ca.newRequest')}
            </Button>
          )}
        </div>
        {!episode && (
          <>
            <h1 className="text-3xl font-bold tracking-tight">{t('ca.title')}</h1>
            <p className="mt-1 text-base leading-7 text-fg-muted">{t('ca.subtitle')}</p>
          </>
        )}
        {episode && (
          <div className="mt-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label={t('ca.title')}>
            <div className="h-2.5 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${Math.max(6, progress)}%` }} />
            </div>
          </div>
        )}
      </div>

      {showTakeover && (
        <EmergencyTakeover
          message={emergency ? emergency : null}
          matched={emergency?.matched ?? episode?.assessment?.red_flags ?? []}
          onDismiss={() => {
            setEmergency(null);
            if (episode) setTakeoverShown(episode.id);
          }}
        />
      )}

      {!episode && <ComplaintStep initial={complaint} onSubmit={start} pending={pending} error={error} />}

      {episode && shownQ && (
        <QuestionStep
          key={`${shownQ.id}-${revisit ? 'r' : 'n'}`}
          q={shownQ}
          initial={revisit?.answer}
          pending={pending}
          aiPending={aiPending}
          error={error}
          onAnswer={(v) => void answer(shownQ, v)}
          onFreeText={(x) => void freeText(x)}
        />
      )}

      {stillIntake && (
        <Card>
          <FreeTextBox pending={pending} aiPending={aiPending} onSubmit={(x) => void freeText(x)} />
          <div className="mt-2">
            <InlineError error={error} />
          </div>
        </Card>
      )}

      {assessed && <AssessmentView episode={episode!} onEpisode={setEpisode} />}

      <p className="text-center text-sm leading-6 text-fg-muted">{t('ca.disclaimer')}</p>
    </div>
  );
}

/* --------------------------------------------------------------- steps */

function ComplaintStep({ initial, onSubmit, pending, error }: { initial: string; onSubmit: (text: string) => void; pending: boolean; error: unknown }) {
  const { t } = useLocale();
  const [text, setText] = useState(initial);
  return (
    <Card className="p-5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) onSubmit(text.trim());
        }}
        className="space-y-4"
      >
        <label className="block">
          <span className="mb-2 block text-xl font-semibold">{t('ca.complaintLabel')}</span>
          <Textarea autoFocus className="min-h-36 text-lg" placeholder={t('ca.complaintPh')} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <InlineError error={error} />
        <Button type="submit" size="xl" className="w-full" loading={pending} disabled={!text.trim()} icon={<Stethoscope className="size-6" />}>
          {pending ? t('ca.thinking') : t('ca.start')}
        </Button>
      </form>
    </Card>
  );
}

function QuestionStep({
  q,
  initial,
  pending,
  aiPending,
  error,
  onAnswer,
  onFreeText,
}: {
  q: IntakeQuestion;
  initial?: unknown;
  pending: boolean;
  aiPending: boolean;
  error: unknown;
  onAnswer: (v: unknown) => void;
  onFreeText: (text: string) => void;
}) {
  const { t, pick, dir } = useLocale();
  const [multi, setMulti] = useState<string[]>(Array.isArray(initial) ? (initial as string[]) : []);
  const [single, setSingle] = useState<string | null>(typeof initial === 'string' ? initial : null);
  const [num, setNum] = useState(typeof initial === 'number' ? String(initial) : '');
  const [text, setText] = useState(typeof initial === 'string' ? initial : '');
  const [ownWords, setOwnWords] = useState(false);
  const Next = dir === 'rtl' ? ArrowLeft : ArrowRight;
  const options = (q.options ?? []).map((o) => ({ value: o.value, label: pick(o.label_en, o.label_ar) }));
  // "None of these" is always a choice the person makes, never assumed: add it when the question does not list it.
  if (q.type === 'multi' && !options.some((o) => o.value === 'none')) options.push({ value: 'none', label: t('ca.noneOfThese') });
  const isSeverity = q.id === 'q_severity';
  const isGlucose = q.id === 'q_glucose_now';

  function submit(e: FormEvent) {
    e.preventDefault();
    if (q.type === 'multi') {
      if (multi.length) onAnswer(multi);
    }
    else if (q.type === 'number' && num !== '') onAnswer(Number(num));
    else if (q.type === 'text' && text.trim()) onAnswer(text.trim());
  }

  function toggleMulti(v: string) {
    setMulti((xs) => {
      if (v === 'none') return xs.includes('none') ? [] : ['none'];
      const base = xs.filter((x) => x !== 'none');
      return base.includes(v) ? base.filter((x) => x !== v) : [...base, v];
    });
  }

  return (
    <Card className={cn('fade-up p-5', q.red_flag && 'border-2 border-warn/60')}>
      {q.red_flag && (
        <Badge tone="warn" icon={<ShieldAlert className="size-3.5" aria-hidden />} className="mb-3">
          {t('ca.redFlagQ')}
        </Badge>
      )}
      <h2 className="mb-5 text-2xl leading-9 font-bold" id={`q-${q.id}`}>
        {pick(q.text_en, q.text_ar)}
      </h2>

      {q.type === 'yesno' && (
        <div className="grid grid-cols-2 gap-3" role="group" aria-labelledby={`q-${q.id}`}>
          {/* the backend accepts the strings 'yes' / 'no' for yes-no questions */}
          {(['yes', 'no'] as const).map((v) => (
            <Button
              key={v}
              size="xl"
              variant={initial === v || initial === (v === 'yes') ? 'primary' : 'outline'}
              className="h-16 text-xl"
              disabled={pending}
              onClick={() => onAnswer(v)}
            >
              {v === 'yes' ? t('common.yes') : t('common.no')}
            </Button>
          ))}
        </div>
      )}

      {q.type === 'single' && (
        <OptionButtons
          name={pick(q.text_en, q.text_ar)}
          value={single}
          disabled={pending}
          onChange={(v) => {
            setSingle(v);
            onAnswer(v);
          }}
          options={options}
        />
      )}

      {q.type !== 'yesno' && q.type !== 'single' && (
        <form onSubmit={submit} className="space-y-5">
          {q.type === 'multi' && (
            <div className="space-y-2" role="group" aria-labelledby={`q-${q.id}`}>
              <p id={`q-${q.id}-hint`} className="text-sm text-fg-muted">
                {t('ca.chooseAllOrNone')}
              </p>
              {options.map((o) => {
                const on = multi.includes(o.value);
                return (
                  <label
                    key={o.value}
                    className={cn(
                      'flex min-h-14 cursor-pointer items-center gap-3 rounded-2xl border-2 px-4 py-3 text-base font-medium',
                      on ? (o.value === 'none' ? 'border-ok bg-ok-soft' : 'border-danger/60 bg-danger-soft') : 'border-line bg-surface',
                    )}
                  >
                    <input type="checkbox" checked={on} onChange={() => toggleMulti(o.value)} className="size-5 shrink-0 accent-[var(--primary)]" />
                    {o.label}
                  </label>
                );
              })}
            </div>
          )}

          {q.type === 'number' && isSeverity && (
            <div>
              <div className="grid grid-cols-6 gap-2 sm:grid-cols-11" role="radiogroup" aria-labelledby={`q-${q.id}`} dir="ltr">
                {Array.from({ length: 11 }, (_, i) => i).map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={num === String(n)}
                    onClick={() => setNum(String(n))}
                    className={cn(
                      'flex h-12 items-center justify-center rounded-xl border-2 text-lg font-bold',
                      num === String(n) ? 'border-primary bg-primary text-primary-fg' : 'border-line bg-surface',
                    )}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex justify-between text-sm text-fg-muted" dir="ltr">
                <span>0 · {t('ca.severityLow')}</span>
                <span>10 · {t('ca.severityHigh')}</span>
              </div>
            </div>
          )}

          {q.type === 'number' && !isSeverity && (
            <div className="space-y-3">
              <input
                type="text"
                inputMode="decimal"
                dir="ltr"
                autoFocus
                aria-labelledby={`q-${q.id}`}
                placeholder={t('ca.numberPh')}
                value={num}
                onChange={(e) => setNum(e.target.value.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[^0-9.]/g, '').slice(0, 5))}
                className="h-16 w-full rounded-2xl border-2 border-line-strong bg-surface px-4 text-center text-4xl font-semibold placeholder:text-xl placeholder:font-normal placeholder:text-fg-subtle focus:border-primary focus:outline-none"
              />
              {isGlucose && (
                <Button variant="outline" size="lg" className="w-full" disabled={pending} onClick={() => onAnswer(0)}>
                  {t('ca.cantMeasure')}
                </Button>
              )}
            </div>
          )}

          {q.type === 'text' && <Textarea autoFocus aria-labelledby={`q-${q.id}`} value={text} onChange={(e) => setText(e.target.value)} />}

          <Button
            type="submit"
            size="xl"
            className="w-full"
            loading={pending}
            disabled={(q.type === 'number' && num === '') || (q.type === 'text' && !text.trim()) || (q.type === 'multi' && multi.length === 0)}
            aria-describedby={q.type === 'multi' && multi.length === 0 ? `q-${q.id}-hint` : undefined}
          >
            {t('common.next')}
            <Next className="size-5" aria-hidden />
          </Button>
        </form>
      )}

      {pending && !aiPending && (q.type === 'yesno' || q.type === 'single') && (
        <p className="mt-4 flex items-center justify-center gap-2 text-base text-fg-muted" role="status">
          <Loader2 className="size-5 animate-spin" aria-hidden />
          {t('ca.thinking')}
        </p>
      )}
      <div className="mt-3">
        <InlineError error={error} />
      </div>

      <div className="mt-5 border-t border-line pt-4">
        {ownWords ? (
          <FreeTextBox pending={pending} aiPending={aiPending} onSubmit={onFreeText} />
        ) : (
          <button type="button" onClick={() => setOwnWords(true)} className="inline-flex min-h-11 items-center gap-2 text-base font-medium text-primary-strong hover:underline">
            <MessageSquareText className="size-5" aria-hidden />
            {t('ca.ownWords')}
          </button>
        )}
      </div>
    </Card>
  );
}

function FreeTextBox({ pending, aiPending, onSubmit }: { pending: boolean; aiPending: boolean; onSubmit: (text: string) => void }) {
  const { t } = useLocale();
  const [text, setText] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onSubmit(text.trim());
      }}
      className="space-y-3"
    >
      <label className="block">
        <span className="mb-1.5 block text-base font-semibold">{t('ca.ownWords')}</span>
        <Textarea placeholder={t('ca.ownWordsPh')} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {aiPending && (
        <p className="flex items-center gap-2 text-sm text-fg-muted" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t('ca.thinkingLong')}
        </p>
      )}
      <Button type="submit" size="lg" variant="soft" loading={pending} disabled={!text.trim()}>
        {t('ca.send')}
      </Button>
    </form>
  );
}

/* --------------------------------------------------------------- emergency */

function EmergencyTakeover({ message, matched, onDismiss }: { message: Emergency | null; matched: string[]; onDismiss: () => void }) {
  const { t, te, pick } = useLocale();
  const { openEmergency } = usePatientShell();
  const ref = useRef<HTMLDivElement>(null);
  // focus moves in and stays in, the page behind does not scroll; Escape does not dismiss an emergency
  useModal(ref, true);
  // Thoughts of self-harm get the crisis guidance the service sends with the alert (it names the help lines),
  // not the medical "go to the emergency department" wording.
  const selfHarm = matched.includes('self_harm');
  const serviceText = message ? pick(message.message_en, message.message_ar) : '';
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="fixed inset-0 z-[80] flex flex-col overflow-y-auto bg-[#7f1d1d] text-white outline-none"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="em-takeover-title"
      aria-describedby="em-takeover-text"
    >
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-5 px-5 py-10">
        <span className="flex size-16 items-center justify-center rounded-full bg-white/15" aria-hidden>
          <AlertOctagon className="size-9" />
        </span>
        <h1 id="em-takeover-title" className="text-3xl font-bold">
          {selfHarm ? t('ca.selfHarmTitle') : t('ca.emergencyTitle')}
        </h1>
        {selfHarm ? (
          <div id="em-takeover-text" className="space-y-3 rounded-2xl bg-white/10 p-4">
            <p dir="auto" className="text-xl leading-9">
              {serviceText || t('ca.selfHarmFallback')}
            </p>
            <p className="text-lg leading-8 text-white/90">{t('ca.selfHarmStay')}</p>
          </div>
        ) : (
          <>
            <p id="em-takeover-text" dir="auto" className="text-xl leading-9">
              {serviceText || t('ca.goingToEr')}
            </p>
            <p className="text-lg leading-8 text-white/90">{t('ca.emergencyCalm')}</p>
          </>
        )}
        {matched.filter((m) => m !== 'none').length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {matched
              .filter((m) => m !== 'none')
              .map((m) => (
                <li key={m} className="rounded-full bg-white/15 px-3 py-1 text-base">
                  {te('rf.', m)}
                </li>
              ))}
          </ul>
        )}
        <a href="tel:123" data-autofocus className="pulse-ring flex min-h-20 items-center justify-center gap-3 rounded-3xl bg-white px-5 py-5 text-3xl font-bold text-[#991b1b] shadow-lg">
          <Phone className="size-8" aria-hidden />
          {t('ca.callNow')}
        </a>
        {!selfHarm && (
          <button type="button" onClick={openEmergency} className="min-h-14 rounded-2xl bg-white/15 px-4 py-3 text-lg font-semibold hover:bg-white/25">
            {t('ca.showSafety')}
          </button>
        )}
        <button type="button" onClick={onDismiss} className="min-h-12 text-base text-white/85 underline underline-offset-4">
          {t('ca.emergencyDismiss')}
        </button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- assessment */

const SELF_CARE_OK = new Set(['self_care', 'routine_appointment', 'primary_care', 'specialist']);

function AssessmentView({ episode, onEpisode }: { episode: Episode; onEpisode: (e: Episode) => void }) {
  const { t, te, pick } = useLocale();
  const { scope } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const errorToast = useErrorToast();
  const { mutate, pending } = useMutation();
  const [bookOpen, setBookOpen] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const a = episode.assessment!;
  const sev = careLevelSeverity(a.care_level);
  const isEmergency = a.channel === 'emergency' || sev === 'danger';

  async function select(action: 'book' | 'find_care' | 'self_care' | 'emergency') {
    setChosen(action);
    try {
      const ep = await mutate('episodes', 'select_action', { episode_id: episode.id, action });
      onEpisode(ep);
      if (action === 'self_care') toast(t('ca.actionSaved'));
      if (action === 'find_care') {
        const qs = new URLSearchParams({ episode: episode.id, ...(a.specialty ? { specialty: a.specialty } : {}) });
        router.push(`/app/care/find?${qs.toString()}`);
      }
      if (action === 'book') setBookOpen(true);
    } catch (e) {
      errorToast(e);
    } finally {
      setChosen(null);
    }
  }

  return (
    <div className="fade-up space-y-4" aria-live="polite">
      <Card tone={sev === 'danger' ? 'danger' : sev === 'warn' ? 'warn' : 'ok'} className="p-5">
        <p className="flex items-center gap-1 text-base font-semibold text-fg-muted">
          {t('ca.assessment')}
          <InfoTip text="help.careLevel" />
        </p>
        <h2 className="mt-1 text-2xl font-bold">{te('cl.', a.care_level)}</h2>
        <p className="mt-1 text-lg leading-8">{te('clDesc.', a.care_level)}</p>
        <CareLevelScale level={a.care_level} className="mt-5" />
        <div className="mt-4 flex flex-wrap gap-2">
          {a.specialty && <Badge tone="primary">{te('spec.', a.specialty)}</Badge>}
          <Badge tone={a.channel === 'emergency' ? 'solid-danger' : 'neutral'}>{te('ch.', a.channel)}</Badge>
        </div>
        {a.red_flags.length > 0 && (
          <div className="mt-4">
            <div className="mb-1.5 flex items-center gap-1.5 text-base font-semibold text-danger-fg">
              <ShieldAlert className="size-5" aria-hidden />
              {t('ca.redFlags')}
            </div>
            <ul className="space-y-1">
              {a.red_flags.map((f) => (
                <li key={f} className="flex gap-2 text-base">
                  <span className="mt-2.5 size-2 shrink-0 rounded-full bg-danger-solid" aria-hidden />
                  {te('rf.', f)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {a.explanation && (
          <div className="mt-4 rounded-xl bg-surface/80 p-3">
            <AiBlock>{pick(a.explanation.en, a.explanation.ar)}</AiBlock>
          </div>
        )}
      </Card>

      <h3 className="text-lg font-semibold">{t('ca.whatNext')}</h3>
      {isEmergency ? (
        <a href="tel:123" onClick={() => void select('emergency')} className="flex min-h-16 items-center justify-center gap-3 rounded-2xl bg-danger-solid px-5 py-4 text-2xl font-bold text-white">
          <Phone className="size-7" aria-hidden />
          {t('ca.callNow')}
        </a>
      ) : (
        <div className="grid gap-2">
          <Button size="xl" icon={<CalendarPlus className="size-6" />} loading={pending && chosen === 'book'} onClick={() => void select('book')}>
            {t('ca.book')}
          </Button>
          <Button size="xl" variant="outline" icon={<MapPinned className="size-6" />} loading={pending && chosen === 'find_care'} onClick={() => void select('find_care')}>
            {t('ca.findCare')}
          </Button>
          {SELF_CARE_OK.has(a.care_level) && (
            <Button size="lg" variant="ghost" icon={<Home className="size-5" />} loading={pending && chosen === 'self_care'} onClick={() => void select('self_care')}>
              {t('ca.selfCare')}
            </Button>
          )}
        </div>
      )}

      {episode.status === 'FOLLOW_UP' && <EpisodeFollowupForm episode={episode} onDone={onEpisode} />}

      {episode.recommended_facilities.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-lg font-semibold">{t('ca.facilities')}</h3>
          {episode.recommended_facilities.map((f) => (
            <FacilityCard key={f.id} f={f} patient />
          ))}
        </div>
      )}

      <BookAppointmentDialog
        open={bookOpen}
        onClose={() => setBookOpen(false)}
        patientId={scope.patient_id}
        facilities={episode.recommended_facilities}
        defaultFacilityId={episode.recommended_facilities[0]?.id}
        episodeId={episode.id}
        defaultReason={episode.chief_complaint}
      />
    </div>
  );
}
