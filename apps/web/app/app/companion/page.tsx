'use client';

import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import {
  AlertOctagon,
  Bot,
  Clock,
  Info,
  Lock,
  Mic,
  MicOff,
  MessageSquarePlus,
  Phone,
  RotateCw,
  SendHorizontal,
  Server,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  UsersRound,
  X,
} from 'lucide-react';
import type { ChatMessage, CompanionReply } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useApi, useNow } from '@/lib/useApi';
import { api, errorCode, errorKey, isAborted } from '@/lib/api';
import { isoDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { hasKey, humanize, type TKey } from '@/lib/i18n';
import { looksLikeEmergency } from '@/lib/redFlags';
import { Button } from '@/components/Button';
import { AiLabel } from '@/components/AiLabel';
import { Citations } from '@/components/Citations';
import { ErrorState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/components/Toast';
import { usePatientShell } from '@/components/patient/PatientShellContext';
import { useSuggestedAction } from '@/components/patient/useSuggestedAction';
import { SameDayCard } from '@/components/patient/SameDayCard';
import { useActivePatientName } from '@/components/patient/ManageHint';

const STARTERS: TKey[] = ['comp.s1', 'comp.s4', 'comp.s3', 'comp.s5', 'comp.s2'];
/** Earlier messages are shown in steps of this size (the newest first). */
const PAGE = 30;
/** How long the composer stays closed after the service said "too many messages". */
const RATE_LIMIT_MS = 2 * 60_000;

type UiMessage = ChatMessage & { failed?: boolean };


/* ------------------------------------------------------------ voice input (Web Speech API) */

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
}
type SpeechCtor = new () => SpeechRecognitionLike;

function getSpeechCtor(): SpeechCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Speech to text. What is heard is added after the text already typed (`getBase` at the start), not instead of it. */
function useVoiceInput(getBase: () => string, onText: (text: string) => void, onError: (denied: boolean) => void) {
  const { locale } = useLocale();
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const rec = useRef<SpeechRecognitionLike | null>(null);
  const cb = useRef({ getBase, onText, onError });
  cb.current = { getBase, onText, onError };

  useEffect(() => setSupported(!!getSpeechCtor()), []);

  function toggle() {
    if (listening) {
      rec.current?.stop();
      return;
    }
    const Ctor = getSpeechCtor();
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = locale === 'ar' ? 'ar-EG' : 'en-US';
    r.interimResults = true;
    r.continuous = false;
    const base = cb.current.getBase();
    const prefix = base && !/\s$/.test(base) ? `${base} ` : base;
    r.onresult = (e) => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      cb.current.onText(prefix + text);
    };
    r.onend = () => setListening(false);
    r.onerror = (e) => {
      setListening(false);
      // "no-speech" and "aborted" are normal endings, not problems to report
      if (e?.error === 'no-speech' || e?.error === 'aborted') return;
      cb.current.onError(e?.error === 'not-allowed' || e?.error === 'service-not-allowed');
    };
    rec.current = r;
    try {
      r.start();
      setListening(true);
    } catch {
      setListening(false);
      cb.current.onError(false);
    }
  }

  useEffect(() => () => rec.current?.stop(), []);
  return { supported, listening, toggle };
}

/* ------------------------------------------------------------ page */

export default function CompanionPage() {
  const { scope, user } = useAuth();
  const patientName = useActivePatientName();
  const { t, locale, fmt } = useLocale();
  const toast = useToast();
  const history = useApi('companion', 'history', scope);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [shown, setShown] = useState(PAGE);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  // newest assistant answer, read out once by screen readers (history is not re-announced)
  const [announce, setAnnounce] = useState('');
  const [blockedUntil, setBlockedUntil] = useState<number | null>(null);
  const [noConsent, setNoConsent] = useState(false);
  // client-side backup to the server pre-screen: the message reads like an emergency (shown before any reply)
  const [redFlag, setRedFlag] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputValue = useRef(input);
  inputValue.current = input;
  const voice = useVoiceInput(
    () => inputValue.current,
    (text) => setInput(text),
    (denied) => toast(t(denied ? 'comp.micDenied' : 'comp.micError'), 'error'),
  );
  // tick every second only while the composer is closed (for the countdown)
  const now = useNow(blockedUntil ? 1000 : 3_600_000);
  const blocked = blockedUntil !== null && blockedUntil > now;
  const secondsLeft = blocked ? Math.ceil((blockedUntil! - now) / 1000) : 0;

  // Another person's record (a family member switched): start from that person's conversation, nothing carried over.
  const patientKey = scope.patient_id ?? 'self';
  useEffect(() => {
    abortRef.current?.abort();
    setMessages([]);
    setConversationId(undefined);
    setShown(PAGE);
    setAnnounce('');
    setNoConsent(false);
    setBlockedUntil(null);
    setRedFlag(false);
  }, [patientKey]);

  useEffect(() => {
    if (history.data) {
      setMessages(history.data.messages);
      setConversationId(history.data.conversation_id ?? undefined);
      setShown(PAGE);
    }
  }, [history.data]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, pending]);

  useEffect(() => {
    if (!pending) return;
    setElapsed(0);
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [pending]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // grow the textarea with its content
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  async function send(text: string, retryId?: string) {
    const msg = text.trim();
    if (!msg || pending || blocked) return;
    // At once and whatever the server does (it may be down): the server pre-screen still decides the reply.
    if (looksLikeEmergency(msg)) setRedFlag(true);
    // a retry re-sends an earlier message: whatever is being typed stays in the box
    if (!retryId) setInput('');
    const localId = retryId ?? `local-${Date.now()}`;
    setMessages((xs) =>
      retryId
        ? xs.map((m) => (m.id === retryId ? { ...m, failed: false } : m))
        : [...xs, { id: localId, role: 'user', content: msg, created_at: new Date().toISOString(), meta: null }],
    );
    setPending(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await api.call('companion', 'send', { ...scope, conversation_id: conversationId, message: msg, locale }, { signal: ctrl.signal });
      setConversationId(res.conversation_id);
      const assistant: UiMessage =
        res.message && res.message.role === 'assistant'
          ? { ...res.message, meta: { ...res.reply, ...(res.message.meta ?? {}) } }
          : { id: `reply-${Date.now()}`, role: 'assistant', content: res.reply.content, created_at: new Date().toISOString(), meta: res.reply };
      setMessages((xs) => [...xs, assistant]);
      setAnnounce(assistant.content);
      const gate = res.reply.blocked ?? res.message?.meta?.blocked;
      if (gate === 'rate_limited') setBlockedUntil(Date.now() + RATE_LIMIT_MS);
      if (gate === 'no_consent') setNoConsent(true);
    } catch (e) {
      if (!isAborted(e)) console.warn('[companion]', e);
      // the service may also refuse with an error instead of a reply: the composer rests the same way
      if (errorCode(e) === 'too_many_requests') setBlockedUntil(Date.now() + RATE_LIMIT_MS);
      setMessages((xs) => xs.map((m) => (m.id === localId ? { ...m, failed: true, meta: { safety_notice: isAborted(e) ? 'err.cancelled' : errorKey(e) } } : m)));
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setPending(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(input);
  }

  function newConversation() {
    abortRef.current?.abort();
    setConversationId(undefined);
    setMessages([]);
    setShown(PAGE);
    setAnnounce('');
    setRedFlag(false);
    inputRef.current?.focus();
  }

  const showStarters = !pending && messages.length < 2;
  const hidden = Math.max(0, messages.length - shown);
  const visible = messages.slice(hidden);
  const today = isoDate();
  const yesterday = isoDate(new Date(Date.now() - 86_400_000));
  const dayLabel = (iso: string) => {
    const d = isoDate(new Date(iso));
    return d === today ? t('comp.today') : d === yesterday ? t('comp.yesterday') : fmt.weekday(iso);
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col">
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-fg" aria-hidden>
          <Bot className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold">{t('comp.title')}</h1>
          <p className="mt-1 flex items-start gap-1.5 text-sm leading-6 text-fg-muted">
            <ShieldCheck className="mt-1 size-4 shrink-0 text-primary" aria-hidden />
            {t('comp.disclaimer')}
          </p>
        </div>
        {messages.length > 0 && (
          <Button variant="outline" size="md" icon={<MessageSquarePlus className="size-4" />} onClick={newConversation} aria-label={t('comp.newConversation')}>
            <span className="sr-only sm:not-sr-only">{t('comp.newConversation')}</span>
          </Button>
        )}
      </div>

      <div className="min-h-[45dvh] flex-1 space-y-4 pb-4">
        {history.loading && !history.data ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="ms-auto h-12 w-2/3 rounded-2xl" />
            <Skeleton className="h-24 w-3/4 rounded-2xl" />
          </div>
        ) : history.error && !history.data ? (
          <ErrorState error={history.error} onRetry={() => void history.reload()} />
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <span className="flex size-16 items-center justify-center rounded-3xl bg-primary-soft text-primary" aria-hidden>
              <Sparkles className="size-8" />
            </span>
            <p className="mt-2 text-xl font-semibold text-fg">{t('comp.empty')}</p>
            <p className="text-base text-fg-muted">{t('comp.emptyHint')}</p>
          </div>
        ) : (
          <>
            {hidden > 0 && (
              <div className="flex justify-center">
                <Button variant="ghost" size="md" onClick={() => setShown((n) => n + PAGE)}>
                  {t('comp.showEarlier', { n: Math.min(PAGE, hidden) })}
                </Button>
              </div>
            )}
            {visible.map((m, i) => {
              const prev = i > 0 ? visible[i - 1] : hidden > 0 ? messages[hidden - 1] : null;
              const newDay = !prev || isoDate(new Date(prev.created_at)) !== isoDate(new Date(m.created_at));
              const idx = hidden + i;
              return (
                <Fragment key={m.id}>
                  {newDay && (
                    <div className="flex items-center gap-3 py-1" role="separator" aria-label={dayLabel(m.created_at)}>
                      <span className="h-px flex-1 bg-line" aria-hidden />
                      <span className="text-xs font-medium text-fg-muted">{dayLabel(m.created_at)}</span>
                      <span className="h-px flex-1 bg-line" aria-hidden />
                    </div>
                  )}
                  <Bubble
                    m={m}
                    question={m.role === 'assistant' ? [...messages.slice(0, idx)].reverse().find((x) => x.role === 'user')?.content : undefined}
                    onRetry={m.failed && !blocked ? () => void send(m.content, m.id) : undefined}
                  />
                </Fragment>
              );
            })}
          </>
        )}

        {pending && (
          <div className="flex justify-start" role="status">
            <div className="flex flex-wrap items-center gap-3 rounded-2xl rounded-ss-md border border-line bg-surface px-4 py-3">
              <span className="flex gap-1" aria-hidden>
                <span className="typing-dot size-2 rounded-full bg-primary" />
                <span className="typing-dot size-2 rounded-full bg-primary" />
                <span className="typing-dot size-2 rounded-full bg-primary" />
              </span>
              <span className="text-sm text-fg-muted">{t('comp.typing')}</span>
              {elapsed >= 5 && <span className="num text-sm text-fg-subtle">{elapsed}s</span>}
              <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={() => abortRef.current?.abort()}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        )}
        <div ref={endRef} />
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {announce}
        </p>
      </div>

      <div className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-10 -mx-4 border-t border-line bg-bg/95 px-4 pt-3 pb-3 backdrop-blur sm:-mx-6 sm:px-6 md:bottom-0">
        {redFlag && <EmergencyLine text={t('comp.redFlag')} onClose={() => setRedFlag(false)} className="mb-3" />}
        {noConsent && (
          <p className="mb-3 flex items-start gap-2 rounded-xl bg-info-soft px-3 py-2 text-sm leading-6 text-info-fg" role="status">
            <Lock className="mt-1 size-4 shrink-0" aria-hidden />
            {user?.role === 'caregiver' ? (
              // only the patient can agree to AI help for their own record
              <span>{t('comp.noConsentCaregiver', { name: patientName ?? t('common.patient') })}</span>
            ) : (
              <span>
                {t('comp.noConsent')}{' '}
                <Link href="/app/account#privacy" className="font-semibold underline underline-offset-4">
                  {t('comp.noConsentLink')}
                </Link>
              </span>
            )}
          </p>
        )}
        {blocked && (
          <p className="mb-3 flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2 text-sm leading-6 text-warn-fg" role="status">
            <Clock className="mt-1 size-4 shrink-0" aria-hidden />
            {t('comp.rateLimited', { s: secondsLeft })}
          </p>
        )}
        {showStarters && !blocked && (
          <div className="mb-3 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
            {STARTERS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => void send(t(k))}
                className="min-h-11 shrink-0 rounded-full border border-primary/40 bg-surface px-4 text-base text-primary-strong hover:bg-primary-soft"
              >
                {t(k)}
              </button>
            ))}
          </div>
        )}
        {voice.listening && (
          <p className="mb-2 flex items-center gap-2 text-sm font-medium text-danger" role="status">
            <span className="pulse-ring size-2.5 rounded-full bg-danger-solid" aria-hidden />
            {t('comp.listening')}
          </p>
        )}
        <form onSubmit={onSubmit} className="flex items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">{t('comp.placeholder')}</span>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              rows={1}
              dir="auto"
              disabled={blocked}
              placeholder={t('comp.placeholder')}
              className="block max-h-40 min-h-12 w-full resize-none rounded-2xl border border-line-strong bg-surface px-4 py-2.5 text-base leading-7 focus:border-primary focus:ring-3 focus:ring-primary/25 focus:outline-none disabled:opacity-60"
            />
          </label>
          {voice.supported && (
            <Button
              type="button"
              variant={voice.listening ? 'danger' : 'outline'}
              className="size-12 shrink-0 rounded-2xl px-0"
              onClick={voice.toggle}
              disabled={blocked}
              aria-label={t('comp.voice')}
              aria-pressed={voice.listening}
            >
              {voice.listening ? <MicOff className="size-5" /> : <Mic className="size-5" />}
            </Button>
          )}
          <Button type="submit" className="size-12 shrink-0 rounded-2xl px-0" disabled={!input.trim() || pending || blocked} aria-label={t('comp.send')}>
            <SendHorizontal className="size-5 rtl:-scale-x-100" />
          </Button>
        </form>
      </div>
    </div>
  );
}

function Bubble({ m, question, onRetry }: { m: UiMessage; question?: string; onRetry?: () => void }) {
  const { t, fmt } = useLocale();
  const run = useSuggestedAction();
  const { openEmergency, openMessageTeam } = usePatientShell();

  if (m.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <div
          dir="auto"
          className={cn(
            'max-w-[85%] rounded-2xl rounded-se-md px-4 py-2.5 text-base leading-7 whitespace-pre-line',
            m.failed ? 'border border-danger/40 bg-danger-soft text-fg' : 'bg-primary text-primary-fg',
          )}
        >
          {m.content}
          <div className="mt-0.5 text-end text-xs opacity-75">{fmt.time(m.created_at)}</div>
        </div>
        {m.failed && (
          <div className="flex flex-wrap items-center justify-end gap-2 text-sm text-danger-fg" role="alert">
            <span>
              {t('comp.failed')} {m.meta?.safety_notice ? t(m.meta.safety_notice as TKey) : ''}
            </span>
            {onRetry && (
              <Button size="sm" variant="outline" icon={<RotateCw className="size-4" />} onClick={onRetry}>
                {t('common.retry')}
              </Button>
            )}
          </div>
        )}
        {/* No answer came back (outage, quota, network): the emergency line is always shown, in the person's language. */}
        {m.failed && <EmergencyLine text={t('comp.failedEmergency')} className="w-full max-w-[85%]" />}
      </div>
    );
  }

  const meta: Partial<CompanionReply> = m.meta ?? {};
  const actions = (meta.suggested_actions ?? []).filter((a) => a.type !== 'call_emergency' || !meta.emergency);
  // A fixed text from the service (safety message, standard answer, a question stopped by a gate) is not labelled
  // as written by AI.
  const fixed = meta.source === 'fixed' || !!meta.blocked;
  const localNote = meta.local === true;
  // same-day problem (not an emergency): a doctor today, shown in amber with the ways to get care
  const urgent = !!meta.urgent && !meta.emergency;
  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] space-y-2">
        {meta.emergency && (
          <div role="alert" className="rounded-2xl border-2 border-danger bg-danger-soft p-4">
            <div className="flex items-start gap-3">
              <AlertOctagon className="mt-0.5 size-6 shrink-0 text-danger" aria-hidden />
              <div className="font-semibold text-danger-fg">{t('comp.emergency')}</div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <a href="tel:123" className="inline-flex min-h-12 items-center justify-center rounded-xl bg-danger-solid px-3 text-lg font-bold text-white">
                123
              </a>
              <Button size="lg" variant="outline" onClick={openEmergency}>
                {t('nav.emergency')}
              </Button>
            </div>
          </div>
        )}
        {urgent && <SameDayCard message={m.content} call123 />}
        <div className={cn('rounded-2xl rounded-ss-md border bg-surface px-4 py-3', meta.emergency ? 'border-danger/40' : 'border-line')}>
          {/* the same-day card above already shows the text */}
          {!urgent && (
            <div dir="auto" className="text-base leading-8 whitespace-pre-line text-fg">
              {m.content}
            </div>
          )}
          {/* The amber box is for safety messages. A simpler answer while the main assistant is busy is not one,
              and neither is the note that the on-site model answered (shown as plain information below). */}
          {meta.safety_notice && !meta.fallback && !localNote && (
            <p dir="auto" className="mt-2 flex items-start gap-1.5 rounded-lg bg-warn-soft px-3 py-2 text-sm leading-6 text-warn-fg">
              <Info className="mt-1 size-4 shrink-0" aria-hidden />
              {meta.safety_notice}
            </p>
          )}
          {localNote && (
            <p dir="auto" className="mt-2 flex items-start gap-1.5 text-sm text-fg-muted">
              <Server className="mt-0.5 size-4 shrink-0" aria-hidden />
              {meta.safety_notice || t('comp.localModel')}
            </p>
          )}
          {meta.fallback && (
            <p className="mt-2 flex items-start gap-1.5 text-sm text-fg-muted">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              {t('comp.limited')}
            </p>
          )}
          {meta.held && (
            <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-info-soft px-3 py-2 text-sm font-medium text-info-fg">
              <UsersRound className="mt-0.5 size-4 shrink-0" aria-hidden />
              {t('comp.held')}
            </p>
          )}
          {meta.reviewed && (
            <p className="mt-2 flex items-start gap-1.5 text-sm font-medium text-ok-fg">
              <UsersRound className="mt-0.5 size-4 shrink-0" aria-hidden />
              {t(meta.reviewed === 'approved' ? 'comp.reviewedOk' : 'comp.reviewedTeam')}
            </p>
          )}
          {meta.routed && !meta.held && (
            <p className="mt-2 flex items-start gap-1.5 text-sm font-medium text-ok-fg">
              <UsersRound className="mt-0.5 size-4 shrink-0" aria-hidden />
              {t('comp.routed')}
            </p>
          )}
          <div className={cn('flex flex-wrap items-center justify-between gap-2', !urgent && 'mt-2')}>
            {fixed ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-fg-muted">
                <ShieldCheck className="size-3.5 text-primary" aria-hidden />
                {meta.emergency || meta.safety_notice ? t('comp.safetyMessage') : t('comp.standardMessage')}
              </span>
            ) : (
              <AiLabel />
            )}
            <span className="text-xs text-fg-subtle">{fmt.time(m.created_at)}</span>
          </div>
          {meta.citations && meta.citations.length > 0 && <Citations citations={meta.citations} className="mt-2" />}
        </div>
        <div className="flex flex-wrap gap-2">
          {actions.map((a, i) => (
            <Button
              key={`${a.type}-${i}`}
              size="md"
              variant={a.type === 'call_emergency' ? 'danger' : 'soft'}
              icon={a.type === 'open_care_access' ? <Stethoscope className="size-4" /> : undefined}
              onClick={() => run(a.type)}
            >
              {hasKey(`act.${a.type}`) ? t(`act.${a.type}` as TKey) : a.label || humanize(a.type)}
            </Button>
          ))}
          {!meta.routed && (
            <Button size="md" variant="outline" icon={<UsersRound className="size-4" />} onClick={() => openMessageTeam(question)}>
              {t('msg.askTeam')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** "Call 123" with a link to the public emergency page (no sign-in, no API calls), for when the Companion cannot answer. */
function EmergencyLine({ text, onClose, className }: { text: string; onClose?: () => void; className?: string }) {
  const { t } = useLocale();
  return (
    <div role="alert" className={cn('rounded-2xl border-2 border-danger bg-danger-soft p-3', className)}>
      <div className="flex items-start gap-2">
        <AlertOctagon className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
        <p className="flex-1 text-base leading-7 font-semibold text-danger-fg">{text}</p>
        {onClose && (
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="-m-1 rounded-lg p-1 text-danger-fg hover:bg-danger/10">
            <X className="size-4" aria-hidden />
          </button>
        )}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <a href="tel:123" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-danger-solid px-3 text-base font-bold text-white">
          <Phone className="size-4" aria-hidden />
          {t('comp.call123')}
        </a>
        <Link
          href="/emergency"
          className="inline-flex min-h-12 items-center justify-center rounded-xl border border-danger/40 bg-surface px-3 text-base font-semibold text-danger-fg hover:bg-danger-soft"
        >
          {t('nav.emergency')}
        </Link>
      </div>
    </div>
  );
}
