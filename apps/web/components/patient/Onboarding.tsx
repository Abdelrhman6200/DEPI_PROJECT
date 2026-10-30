'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Bot, CalendarCheck, HeartHandshake, Siren } from 'lucide-react';
import { useLocale } from '@/lib/locale';
import { useModal } from '@/lib/useModal';
import type { TKey } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { Button } from '../Button';

const KEY = 'onboarding.v1.done';
const CAREGIVER_KEY = 'onboarding.caregiver.v1.done';

export function onboardingDone(caregiver = false): boolean {
  try {
    return localStorage.getItem(caregiver ? CAREGIVER_KEY : KEY) === '1';
  } catch {
    return true;
  }
}
const REPLAY_EVENT = 'health:onboarding';

export function resetOnboarding() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(CAREGIVER_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(REPLAY_EVENT));
}

type Slide = { title: TKey; body: TKey; icon: typeof Siren; tone: string };

const SLIDES: Slide[] = [
  { title: 'ob.1title', body: 'ob.1body', icon: CalendarCheck, tone: 'bg-primary text-primary-fg' },
  { title: 'ob.2title', body: 'ob.2body', icon: Siren, tone: 'bg-danger-solid text-white' },
  { title: 'ob.3title', body: 'ob.3body', icon: Bot, tone: 'bg-info text-white' },
];

/** Family members see a shorter tour about helping someone else, not the patient's own slides. */
const CAREGIVER_SLIDES: Slide[] = [
  { title: 'ob.cg1title', body: 'ob.cg1body', icon: HeartHandshake, tone: 'bg-primary text-primary-fg' },
  { title: 'ob.2title', body: 'ob.cg2body', icon: Siren, tone: 'bg-danger-solid text-white' },
];

/** Welcome screens after the first sign-in or registration. Dismissal is remembered on the device. */
export function Onboarding({ forceOpen = false, onClose, caregiver = false }: { forceOpen?: boolean; onClose?: () => void; caregiver?: boolean }) {
  const { t, dir } = useLocale();
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const slides = caregiver ? CAREGIVER_SLIDES : SLIDES;

  useEffect(() => {
    if (forceOpen || !onboardingDone(caregiver)) {
      setI(0);
      setOpen(true);
    }
    const replay = () => {
      setI(0);
      setOpen(true);
    };
    window.addEventListener(REPLAY_EVENT, replay);
    return () => window.removeEventListener(REPLAY_EVENT, replay);
  }, [forceOpen, caregiver]);

  const done = () => {
    try {
      localStorage.setItem(caregiver ? CAREGIVER_KEY : KEY, '1');
    } catch {
      /* ignore */
    }
    setOpen(false);
    onClose?.();
  };

  // focus inside, Tab kept inside, page scroll locked; Escape skips the tour
  useModal(panelRef, open, done);

  if (!open) return null;

  const s = slides[Math.min(i, slides.length - 1)];
  const last = i >= slides.length - 1;
  const Next = dir === 'rtl' ? ArrowLeft : ArrowRight;
  const Prev = dir === 'rtl' ? ArrowRight : ArrowLeft;

  return (
    <div className="fixed inset-0 z-[65] flex items-end justify-center bg-black/50 sm:items-center sm:p-4" role="presentation">
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ob-title"
        className="fade-up w-full max-w-md rounded-t-3xl bg-surface p-6 pb-8 shadow-xl outline-none sm:rounded-3xl"
      >
        <div className="flex items-center justify-between">
          <div className="flex gap-1.5" aria-hidden>
            {slides.map((_, j) => (
              <span key={j} className={cn('h-2 rounded-full transition-all', j === i ? 'w-6 bg-primary' : 'w-2 bg-line-strong')} />
            ))}
          </div>
          <button type="button" onClick={done} className="min-h-11 rounded-xl px-3 text-base font-medium text-fg-muted hover:bg-surface-2">
            {t('ob.skip')}
          </button>
        </div>
        <div key={i} className="fade-up mt-6 text-center">
          <span className={cn('mx-auto flex size-20 items-center justify-center rounded-3xl', s.tone)} aria-hidden>
            <s.icon className="size-10" />
          </span>
          <h2 id="ob-title" className="mt-6 text-2xl font-bold text-fg">
            {t(s.title)}
          </h2>
          <p className="mt-3 text-lg leading-8 text-fg-muted">{t(s.body)}</p>
          <p className="sr-only" aria-live="polite">
            {t('common.step', { n: i + 1, total: slides.length })}
          </p>
        </div>
        <div className="mt-8 flex gap-3">
          {i > 0 && (
            <Button variant="outline" size="xl" onClick={() => setI(i - 1)} aria-label={t('common.back')} icon={<Prev className="size-5" />} />
          )}
          <Button size="xl" className="flex-1" onClick={() => (last ? done() : setI(i + 1))} data-autofocus>
            {last ? t('ob.start') : t('common.next')}
            {!last && <Next className="size-5" aria-hidden />}
          </Button>
        </div>
      </div>
    </div>
  );
}
