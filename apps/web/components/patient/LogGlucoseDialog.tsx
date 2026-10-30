'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { AlertTriangle, BellRing, Camera, CheckCircle2, Clock, CloudOff, Droplet, HeartPulse, Info, ListChecks, Mic, MicOff } from 'lucide-react';
import type { GlucoseContext, GlucoseReading, UUID } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useMutation } from '@/lib/useApi';
import { isNetworkError } from '@/lib/api';
import { enqueueReading } from '@/lib/offline';
import { cairoHour, localInputToIso, nowLocalInput } from '@/lib/format';
import { glucoseBand, GLUCOSE_MAX, GLUCOSE_MIN, BAND_COLOR, BAND_TEXT, type GlucoseBand } from '@/lib/glucose';
import { cn } from '@/lib/cn';
import { translate } from '@/lib/i18n';
import { parseVoiceReading } from '@/lib/voiceGlucose';
import { Dialog } from '../Dialog';
import { Button } from '../Button';
import { Chips, Input } from '../Field';
import { InlineError } from '../EmptyState';
import { useToast } from '../Toast';
import { usePatientShell } from './PatientShellContext';

const CONTEXTS: GlucoseContext[] = ['fasting', 'pre_meal', 'post_meal', 'bedtime', 'night', 'random'];

function defaultContext(): GlucoseContext {
  const h = cairoHour();
  if (h >= 4 && h < 10) return 'fasting';
  if (h >= 22 || h < 1) return 'bedtime';
  if (h >= 1 && h < 4) return 'night';
  return 'random';
}

type GlucoseEvent = { type: string; message_en: string; message_ar: string };

interface SpeechLike { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null }
function speechCtor(): (new () => SpeechLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: new () => SpeechLike; webkitSpeechRecognition?: new () => SpeechLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** True for guidance about a low reading (the backend's hypo / severe_hypo, or the app's own low message). */
export function isLowGuidance(type: string): boolean {
  return /hypo|low/i.test(type) && !/hyper/i.test(type);
}

/**
 * What to do now after a low reading: the guidance text, the low-sugar plan, Emergency, and a reminder to measure
 * again in 15 minutes. Shared by the log dialog, readings sent after being saved offline, and Today.
 */
export function LowGlucoseCard({ message, onEmergency, compact }: { message: string; onEmergency?: () => void; compact?: boolean }) {
  const { t } = useLocale();
  const { openHypoPlan, remindRecheck } = usePatientShell();
  const [reminded, setReminded] = useState(false);
  return (
    <div className="space-y-3">
      <div className="rounded-2xl border-2 border-danger/60 bg-danger-soft p-5" role="alert">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-1 size-6 shrink-0 text-danger" aria-hidden />
          <p dir="auto" className={cn('font-medium text-fg', compact ? 'text-base leading-7' : 'text-lg leading-8')}>
            {message}
          </p>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {onEmergency && (
          <Button variant="danger" size="lg" className="w-full" icon={<HeartPulse className="size-5" />} onClick={onEmergency}>
            {t('ca.showSafety')}
          </Button>
        )}
        <Button variant="outline" size="lg" className="w-full" icon={<ListChecks className="size-5" />} onClick={openHypoPlan}>
          {t('hypo.openPlan')}
        </Button>
      </div>
      <Button
        variant="soft"
        size="lg"
        className="w-full"
        icon={<BellRing className="size-5" />}
        disabled={reminded}
        onClick={() => {
          remindRecheck(15);
          setReminded(true);
        }}
      >
        {reminded ? t('recheck.set') : t('recheck.button')}
      </Button>
    </div>
  );
}

/**
 * "Log reading" in three taps: type the number, pick when (pre-selected), Save.
 * Shows the backend's immediate guidance (hypo / hyper event) in a calm, prominent card.
 * Offline readings are saved on the device and sent later.
 */
export function LogGlucoseDialog({
  open,
  onClose,
  patientId,
  patientName,
  onSaved,
  onEmergency,
}: {
  open: boolean;
  onClose: () => void;
  patientId?: UUID;
  /** Shown in the title when a family member logs for someone else. */
  patientName?: string | null;
  onSaved?: (r: GlucoseReading | null) => void;
  onEmergency?: () => void;
}) {
  const { t, te, locale } = useLocale();
  const { user } = useAuth();
  const toast = useToast();
  const { mutate, pending, error, clearError } = useMutation();
  const [value, setValue] = useState('');
  const [ctx, setCtx] = useState<GlucoseContext>('random');
  const [at, setAt] = useState('');
  const [showTime, setShowTime] = useState(false);
  const [event, setEvent] = useState<GlucoseEvent | null>(null);
  const [savedValue, setSavedValue] = useState<number | null>(null);
  const [rangeError, setRangeError] = useState(false);
  // A meter that shows HI / LO (or a number outside what meters can measure) needs guidance, not a format error.
  const [extreme, setExtreme] = useState<'hi' | 'lo' | null>(null);
  // the low reading was saved on this phone (offline), not yet on the server
  const [queuedLow, setQueuedLow] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Say the reading (browser speech recognition, Egyptian Arabic or English): the number and "after breakfast" fill the
  // form; the person checks and saves. Nothing is saved without the Save button.
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState<{ text: string; ok: boolean } | null>(null);
  const recRef = useRef<SpeechLike | null>(null);
  const canSpeak = typeof window !== 'undefined' && !!speechCtor();
  // Photo of the meter's screen: read by the local model (WF-028), shown in the box for the person to check.
  const photoRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [photoMsg, setPhotoMsg] = useState<{ text: string; ok: boolean } | null>(null);
  async function readPhoto(file: File) {
    setReading(true);
    setPhotoMsg(null);
    try {
      const image_base64 = await shrinkPhoto(file);
      const r = await mutate('glucose', 'read_meter', { ...(patientId ? { patient_id: patientId } : {}), image_base64, mime_type: 'image/jpeg' });
      if (r.read && r.hi_lo) {
        setExtreme(r.hi_lo === 'HI' ? 'hi' : 'lo');
      } else if (r.read && r.value_mgdl !== null) {
        setValue(String(r.value_mgdl));
        setRangeError(false);
        setPhotoMsg({ text: t(r.converted_from_mmol ? 'glu.photoConverted' : 'glu.photoRead', { n: r.value_mgdl }), ok: true });
      } else if (!r.read) {
        setPhotoMsg({ text: te('glu.photoFail.', r.reason), ok: false });
      }
    } catch {
      setPhotoMsg({ text: te('glu.photoFail.', 'no_reading'), ok: false });
      clearError();
    } finally {
      setReading(false);
      if (photoRef.current) photoRef.current.value = '';
    }
  }
  function listen() {
    const C = speechCtor();
    if (!C) return;
    if (listening) { recRef.current?.stop(); return; }
    const rec = new C();
    rec.lang = locale === 'ar' ? 'ar-EG' : 'en-US';
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (e) => {
      const text = Array.from(e.results).map((r) => r[0]?.transcript ?? '').join(' ').trim();
      const r = parseVoiceReading(text);
      if (r.value !== null) { setValue(String(r.value)); setRangeError(false); }
      if (r.context) setCtx(r.context);
      setHeard({ text, ok: r.value !== null });
    };
    rec.onerror = (e) => { if (e.error === 'not-allowed') toast(t('comp.micDenied'), 'error'); };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    setHeard(null);
    setListening(true);
    try { rec.start(); } catch { setListening(false); }
  }

  useEffect(() => {
    if (open) {
      setValue('');
      setCtx(defaultContext());
      setAt(nowLocalInput());
      setShowTime(false);
      setEvent(null);
      setSavedValue(null);
      setRangeError(false);
      setExtreme(null);
      setQueuedLow(false);
      setHeard(null);
      setPhotoMsg(null);
      clearError();
    } else {
      recRef.current?.stop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const v = Number(value);
  const valid = !!value && Number.isFinite(v) && v >= GLUCOSE_MIN && v <= GLUCOSE_MAX;
  const band: GlucoseBand | null = valid ? glucoseBand(v) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) {
      if (value && Number.isFinite(v) && v > GLUCOSE_MAX) setExtreme('hi');
      else if (value && Number.isFinite(v) && v < GLUCOSE_MIN) setExtreme('lo');
      else {
        setRangeError(true);
        inputRef.current?.focus();
      }
      return;
    }
    const measured_at = showTime ? localInputToIso(at) : new Date().toISOString();
    const input = { ...(patientId ? { patient_id: patientId } : {}), value_mgdl: Math.round(v), context: ctx, measured_at };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      queue(input.value_mgdl, measured_at);
      return;
    }
    try {
      const res = await mutate('glucose', 'add', input);
      onSaved?.(res.reading);
      setSavedValue(input.value_mgdl);
      if (res.event) {
        setEvent(res.event);
      } else if (res.ramadan) {
        // During fasting hours a reading outside the safe range means the fast must be broken now (fixed text).
        setEvent({ type: 'ramadan_break_fast', message_en: res.ramadan.message_en, message_ar: res.ramadan.message_ar });
      } else if (res.prediction) {
        // A falling trend that will cross 70 soon: a warning, not low treatment (the type name has no "low" in it).
        setEvent({ type: 'trend_warning', message_en: res.prediction.message_en, message_ar: res.prediction.message_ar });
      } else if (input.value_mgdl < 70) {
        // The backend de-duplicates low-glucose events; a low reading always gets guidance here.
        setEvent({ type: 'hypo_local', message_en: translate('en', 'glu.lowWarn'), message_ar: translate('ar', 'glu.lowWarn') });
      } else {
        toast(t('glu.saved'));
        onClose();
      }
    } catch (err) {
      if (isNetworkError(err)) queue(input.value_mgdl, measured_at);
    }
  }

  function queue(value_mgdl: number, measured_at: string | undefined) {
    if (!user) return;
    enqueueReading({ user_id: user.id, patient_id: patientId, value_mgdl, context: ctx, measured_at: measured_at ?? new Date().toISOString() });
    clearError();
    onSaved?.(null);
    if (value_mgdl < 70) {
      // Offline, a low reading still needs guidance now: the server's advice can only come once it is sent.
      setSavedValue(value_mgdl);
      setQueuedLow(true);
      setEvent({ type: 'hypo_local', message_en: translate('en', 'glu.lowWarn'), message_ar: translate('ar', 'glu.lowWarn') });
      return;
    }
    toast(
      <span className="inline-flex items-center gap-2">
        <CloudOff className="size-4 shrink-0" aria-hidden />
        {t('glu.queued')}
      </span>,
      'info',
    );
    onClose();
  }

  const isLowEvent = !!event && isLowGuidance(event.type);
  const title = event || extreme ? t('glu.whatNow') : patientName ? t('glu.logFor', { name: patientName }) : t('glu.log');

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        extreme ? (
          <Button variant="ghost" size="lg" onClick={() => setExtreme(null)}>
            {t('glu.enterNumber')}
          </Button>
        ) : event ? (
          <Button size="lg" className="w-full sm:w-auto" onClick={onClose}>
            {t('common.done')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="lg" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form="log-glucose" size="lg" loading={pending} icon={<Droplet className="size-5" />} className="min-w-32 flex-1 sm:flex-none">
              {t('common.save')}
            </Button>
          </>
        )
      }
    >
      {extreme ? (
        <div className="space-y-4" aria-live="assertive">
          <div className="rounded-2xl border-2 border-danger/60 bg-danger-soft p-5" role="alert">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-1 size-6 shrink-0 text-danger" aria-hidden />
              <p className="text-lg leading-8 font-medium text-fg">{t(extreme === 'hi' ? 'glu.hiWarn' : 'glu.loWarn')}</p>
            </div>
          </div>
          {onEmergency && (
            <Button variant="danger" size="lg" className="w-full" icon={<HeartPulse className="size-5" />} onClick={onEmergency}>
              {t('ca.showSafety')}
            </Button>
          )}
          <p className="text-sm leading-6 text-fg-muted">{t('glu.extremeNotSaved')}</p>
        </div>
      ) : event ? (
        <div className="space-y-4" aria-live="assertive">
          {savedValue !== null && (
            <div className="flex items-center gap-2 text-sm text-fg-muted">
              {queuedLow ? <CloudOff className="size-4 text-info" aria-hidden /> : <CheckCircle2 className="size-4 text-ok" aria-hidden />}
              {queuedLow ? t('glu.savedOnPhone') : t('glu.saved')}:{' '}
              <span className="num font-semibold text-fg">
                {savedValue} {t('common.mgdl')}
              </span>
            </div>
          )}
          {isLowEvent ? (
            <LowGlucoseCard message={locale === 'ar' ? event.message_ar : event.message_en} onEmergency={onEmergency} />
          ) : (
            <div className="rounded-2xl border-2 border-warn/60 bg-warn-soft p-5">
              <div className="flex items-start gap-3">
                <Info className="mt-1 size-6 shrink-0 text-warn" aria-hidden />
                <p className="text-lg leading-8 font-medium text-fg">{locale === 'ar' ? event.message_ar : event.message_en}</p>
              </div>
            </div>
          )}
          {!isLowEvent && (
            <Link href="/app/care-access" onClick={onClose} className="block text-center text-base font-semibold text-primary-strong underline-offset-4 hover:underline">
              {t('today.needCareCard')} {t('nav.needCare')}
            </Link>
          )}
        </div>
      ) : (
        <form id="log-glucose" onSubmit={submit} className="space-y-5" noValidate>
          <div>
            <label htmlFor="glucose-value" className="mb-2 block text-base font-semibold text-fg">
              {t('glu.value')}
            </label>
            <div className="relative">
              <input
                id="glucose-value"
                ref={inputRef}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="off"
                autoFocus
                dir="ltr"
                placeholder={t('glu.valuePh')}
                aria-invalid={rangeError && !valid}
                aria-describedby="glucose-band"
                value={value}
                onChange={(e) => {
                  // accept Arabic-Indic digits too
                  const ascii = e.target.value.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[^0-9]/g, '').slice(0, 3);
                  setValue(ascii);
                  setRangeError(false);
                }}
                className={cn(
                  'h-20 w-full rounded-2xl border-2 bg-surface px-4 text-center text-5xl font-semibold tracking-tight text-fg placeholder:text-2xl placeholder:font-normal placeholder:text-fg-subtle focus:outline-none',
                  band ? 'border-current' : 'border-line-strong focus:border-primary',
                )}
                style={band ? { color: BAND_TEXT[band] } : undefined}
              />
              <span className="pointer-events-none absolute end-4 top-1/2 -translate-y-1/2 text-sm text-fg-muted">{t('common.mgdl')}</span>
            </div>
            <div id="glucose-band" aria-live="polite" className="mt-2 min-h-6 text-center text-base font-semibold">
              {band && (
                <span className="inline-flex items-center gap-1.5" style={{ color: BAND_TEXT[band] }}>
                  <span className="size-2.5 rounded-full" style={{ background: BAND_COLOR[band] }} aria-hidden />
                  {t(`band.${band}`)}
                </span>
              )}
              {rangeError && !valid && <span className="text-danger">{t('err.glucoseRange')}</span>}
            </div>
            <div className="mt-2 flex flex-col items-center gap-1">
              <div className="flex flex-wrap justify-center gap-2">
                {canSpeak && (
                  <Button type="button" variant={listening ? 'primary' : 'soft'} size="md" icon={listening ? <MicOff className="size-4" /> : <Mic className="size-4" />} onClick={listen} aria-pressed={listening}>
                    {t(listening ? 'glu.voiceListening' : 'glu.voice')}
                  </Button>
                )}
                <Button type="button" variant="soft" size="md" icon={<Camera className="size-4" />} loading={reading} onClick={() => photoRef.current?.click()}>
                  {t(reading ? 'glu.photoReading' : 'glu.photo')}
                </Button>
                <input ref={photoRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void readPhoto(f); }} />
              </div>
              {photoMsg && (
                <p className={cn('text-center text-sm', photoMsg.ok ? 'text-fg-muted' : 'text-warn-fg')} aria-live="polite">{photoMsg.text}</p>
              )}
              {canSpeak && (<>
                {heard && (
                  <p className={cn('text-center text-sm', heard.ok ? 'text-fg-muted' : 'text-warn-fg')} aria-live="polite">
                    {heard.ok ? t('glu.voiceHeard', { text: heard.text }) : t('glu.voiceNoNumber', { text: heard.text })}
                  </p>
                )}
              </>)}
            </div>
            <div className="mt-1 flex flex-wrap justify-center gap-x-5">
              <button type="button" onClick={() => setExtreme('hi')} className="min-h-11 text-sm font-medium text-fg-muted underline underline-offset-4 hover:text-fg">
                {t('glu.meterHi')}
              </button>
              <button type="button" onClick={() => setExtreme('lo')} className="min-h-11 text-sm font-medium text-fg-muted underline underline-offset-4 hover:text-fg">
                {t('glu.meterLo')}
              </button>
            </div>
          </div>

          {band && (band === 'low' || band === 'vlow') && (
            <p role="alert" className="flex items-start gap-2 rounded-2xl bg-danger-soft px-4 py-3 text-base leading-7 text-danger-fg">
              <AlertTriangle className="mt-1 size-5 shrink-0" aria-hidden />
              {t('glu.lowWarn')}
            </p>
          )}

          <fieldset>
            <legend className="mb-2 text-base font-semibold text-fg">{t('glu.context')}</legend>
            <Chips options={CONTEXTS.map((c) => ({ value: c, label: te('ctx.', c) }))} value={[ctx]} onToggle={(c) => setCtx(c)} />
          </fieldset>

          {showTime ? (
            <label className="block space-y-1.5">
              <span className="block text-sm font-medium text-fg">{t('glu.measuredAt')}</span>
              <Input type="datetime-local" value={at} max={nowLocalInput()} onChange={(e) => setAt(e.target.value)} dir="ltr" />
            </label>
          ) : (
            <button type="button" onClick={() => setShowTime(true)} className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary-strong hover:underline">
              <Clock className="size-4" aria-hidden />
              {t('glu.changeTime')}
            </button>
          )}
          <InlineError error={error} />
        </form>
      )}
    </Dialog>
  );
}

/** A phone photo made small enough to send (longest side 1024 px, JPEG): the meter's digits stay sharp. */
async function shrinkPhoto(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const k = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85).split(',')[1] ?? '';
  } finally {
    URL.revokeObjectURL(url);
  }
}
