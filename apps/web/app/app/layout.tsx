'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { BellRing, Eye, HeartPulse, Home, Leaf, Loader2, MessageCircleHeart, Stethoscope, ClipboardList, Siren, WifiOff, CloudUpload, UserRound } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { isPatientRole } from '@/lib/roles';
import { cn } from '@/lib/cn';
import type { TKey } from '@/lib/i18n';
import { flushQueue, useOnline, useQueuedCount } from '@/lib/offline';
import { useModal } from '@/lib/useModal';
import { useVisibleInterval } from '@/lib/useApi';
import { EmergencyScreen } from '@/components/EmergencyScreen';
import { PasswordChangeGate } from '@/components/PasswordChangeGate';
import { Dialog } from '@/components/Dialog';
import { Button } from '@/components/Button';
import { NotificationBell } from '@/components/NotificationBell';
import { useToast } from '@/components/Toast';
import { LogGlucoseDialog, LowGlucoseCard, isLowGuidance } from '@/components/patient/LogGlucoseDialog';
import { MessageTeamDialog } from '@/components/patient/MessageTeamDialog';
import { Onboarding } from '@/components/patient/Onboarding';
import { PatientShellContext, type PatientShellApi } from '@/components/patient/PatientShellContext';
import { CaregiverChooser, CaregiverSwitcher } from '@/components/patient/CaregiverPicker';

const NAV: { href: string; label: TKey; icon: typeof Home }[] = [
  { href: '/app/today', label: 'nav.today', icon: Home },
  { href: '/app/health', label: 'nav.health', icon: HeartPulse },
  { href: '/app/lifestyle', label: 'nav.lifestyle', icon: Leaf },
  { href: '/app/care', label: 'nav.care', icon: ClipboardList },
  { href: '/app/companion', label: 'nav.companion', icon: MessageCircleHeart },
];

const RECHECK_KEY = 'reminder.recheck';

/**
 * "Remind me to check again in 15 minutes" after a low reading. The due time is kept on the device so a reload
 * does not lose it. When the person allowed notifications the phone shows one; the app always shows a message too.
 */
function useRecheckReminder(userId: string | null, onDue: () => void) {
  const dueRef = useRef(onDue);
  dueRef.current = onDue;
  const [due, setDue] = useState<number | null>(null);

  useEffect(() => {
    if (!userId) return;
    try {
      const raw = localStorage.getItem(RECHECK_KEY);
      const saved = raw ? (JSON.parse(raw) as { due: number; user: string }) : null;
      if (saved && saved.user === userId && saved.due > Date.now() - 10 * 60000) setDue(saved.due);
      else if (saved) localStorage.removeItem(RECHECK_KEY);
    } catch {
      /* storage unavailable */
    }
  }, [userId]);

  useEffect(() => {
    if (due === null) return;
    const id = setTimeout(() => {
      setDue(null);
      try {
        localStorage.removeItem(RECHECK_KEY);
      } catch {
        /* ignore */
      }
      dueRef.current();
    }, Math.max(0, due - Date.now()));
    return () => clearTimeout(id);
  }, [due]);

  return useCallback(
    (minutes: number) => {
      const at = Date.now() + minutes * 60000;
      setDue(at);
      try {
        if (userId) localStorage.setItem(RECHECK_KEY, JSON.stringify({ due: at, user: userId }));
      } catch {
        /* ignore */
      }
      // asked from the button press, the only moment browsers allow the question
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission().catch(() => undefined);
    },
    [userId],
  );
}

/** Phone notification when allowed (through the service worker where there is one). Returns false when not shown. */
async function showSystemNotification(title: string, body: string): Promise<boolean> {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (reg) await reg.showNotification(title, { body, icon: '/icon-192.png', tag: 'recheck' });
    else new Notification(title, { body, icon: '/icon-192.png', tag: 'recheck' });
    return true;
  } catch {
    return false;
  }
}

export default function PatientLayout({ children }: { children: ReactNode }) {
  const { ready, user, activePatientId, scope } = useAuth();
  const { t, pick, locale } = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const online = useOnline();
  const queued = useQueuedCount(user?.id);
  const toast = useToast();
  const [emergency, setEmergency] = useState(false);
  const [hypoPlan, setHypoPlan] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [msg, setMsg] = useState<{ open: boolean; prefill?: string }>({ open: false });
  // guidance for a low reading that was saved offline and has just been sent
  const [syncedLow, setSyncedLow] = useState<{ value: number; message: string } | null>(null);
  const onSavedRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    if (!ready) return;
    if (!user) router.replace('/login');
    else if (!isPatientRole(user.role)) router.replace('/provider');
  }, [ready, user, router]);

  // Send glucose readings saved while offline as soon as the connection is back (only this account's readings),
  // and retry every minute while some are still waiting (the phone may report "online" with no working network).
  const userId = user?.id ?? null;
  const flush = () => {
    if (!online || !userId) return;
    void flushQueue(userId).then((r) => {
      if (r.sent > 0) {
        toast(t('glu.synced', { n: r.sent }));
        onSavedRef.current?.();
      }
      if (r.rejected > 0) toast(t('glu.syncRejected', { n: r.rejected }), 'error');
      // a low reading sent late still gets the service's guidance (the newest one if there were several)
      const low = [...r.events].reverse().find((e) => isLowGuidance(e.event.type));
      if (low) setSyncedLow({ value: low.reading.value_mgdl, message: locale === 'ar' ? low.event.message_ar : low.event.message_en });
    });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(flush, [online, userId]);
  useVisibleInterval(flush, 60_000, online && queued > 0);

  const openEmergency = useCallback(() => {
    setLogOpen(false);
    setHypoPlan(false);
    setSyncedLow(null);
    setEmergency(true);
  }, []);
  // one dialog at a time: the plan replaces the log dialog or the guidance it was opened from
  const openHypoPlan = useCallback(() => {
    setLogOpen(false);
    setSyncedLow(null);
    setHypoPlan(true);
  }, []);
  const openLogGlucose = useCallback((onSaved?: () => void) => {
    onSavedRef.current = onSaved;
    setLogOpen(true);
  }, []);
  const openMessageTeam = useCallback((prefill?: string) => setMsg({ open: true, prefill }), []);
  const remindRecheck = useRecheckReminder(userId, () => {
    const title = t('recheck.dueTitle');
    const body = t('recheck.dueBody');
    void showSystemNotification(title, body);
    toast(
      <span className="flex flex-wrap items-center gap-2">
        <BellRing className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">{body}</span>
        <button type="button" className="min-h-9 font-semibold text-primary-strong underline" onClick={() => setLogOpen(true)}>
          {t('today.logReading')}
        </button>
      </span>,
      'info',
    );
  });
  const scheduleRecheck = useCallback(
    (minutes: number) => {
      remindRecheck(minutes);
      toast(t('recheck.setToast', { n: minutes }), 'info');
    },
    [remindRecheck, toast, t],
  );
  const shell = useMemo<PatientShellApi>(
    () => ({ openEmergency, openHypoPlan, openLogGlucose, openMessageTeam, remindRecheck: scheduleRecheck }),
    [openEmergency, openHypoPlan, openLogGlucose, openMessageTeam, scheduleRecheck],
  );

  if (!ready || !user || !isPatientRole(user.role)) {
    return (
      <div className="flex min-h-dvh items-center justify-center" aria-busy="true">
        <Loader2 className="size-7 animate-spin text-primary" aria-label={t('common.loading')} />
      </div>
    );
  }

  const needsPatient = user.role === 'caregiver' && !activePatientId;
  const isActive = (href: string) => !!pathname?.startsWith(href);
  // A family member works on someone else's record: name that person wherever an action is taken.
  const viewed = user.role === 'caregiver' && activePatientId ? user.caregiver_patients?.find((p) => p.id === activePatientId) : null;
  const patientName = viewed ? pick(viewed.full_name, viewed.full_name_ar) : null;

  // After a password reset by an administrator, nothing else is shown until a new password is chosen.
  if (user.must_change_password) return <PasswordChangeGate>{null}</PasswordChangeGate>;

  return (
    <PatientShellContext.Provider value={shell}>
      <a href="#main" className="skip-link">
        {t('common.skipToContent')}
      </a>
      <div className="min-h-dvh md:flex">
        {/* desktop side nav */}
        <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-e border-line bg-surface px-3 py-5 md:flex">
          <Link href="/app/today" className="mb-6 flex items-center gap-2.5 px-2">
            <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-fg" aria-hidden>
              <HeartPulse className="size-5" />
            </span>
            <span className="text-lg font-bold">{t('app.name')}</span>
          </Link>
          <nav aria-label={t('app.name')} className="flex flex-col gap-1">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={isActive(n.href) ? 'page' : undefined}
                className={cn(
                  'flex min-h-12 items-center gap-3 rounded-xl px-3 text-base font-medium transition-colors',
                  isActive(n.href) ? 'bg-primary-soft text-primary-strong' : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
                )}
              >
                <n.icon className="size-5" aria-hidden />
                {t(n.label)}
              </Link>
            ))}
          </nav>
          <Link
            href="/app/care-access"
            className="mt-4 flex min-h-12 items-center gap-3 rounded-xl border-2 border-primary/40 px-3 text-base font-semibold text-primary-strong hover:bg-primary-soft"
          >
            <Stethoscope className="size-5" aria-hidden />
            {t('nav.needCare')}
          </Link>
          <div className="mt-auto border-t border-line pt-3">
            <Link
              href="/app/account"
              aria-current={isActive('/app/account') ? 'page' : undefined}
              className={cn(
                'flex min-h-12 items-center gap-3 rounded-xl px-3 text-start hover:bg-surface-2',
                isActive('/app/account') && 'bg-primary-soft',
              )}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-fg-muted" aria-hidden>
                <UserRound className="size-5" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-fg">{pick(user.full_name, user.full_name_ar)}</span>
                <span className="block text-xs text-fg-muted">{t('acc.title')}</span>
              </span>
            </Link>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* header: Emergency is always visible */}
          <header className="sticky top-0 z-30 border-b border-line bg-bg/95 backdrop-blur">
            <div className="mx-auto flex h-16 max-w-5xl items-center gap-2 px-4 sm:px-6">
              <Link href="/app/today" className="flex items-center gap-2 md:hidden" aria-label={t('app.name')}>
                <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-fg" aria-hidden>
                  <HeartPulse className="size-5" />
                </span>
              </Link>
              <div className="hidden sm:block">
                <CaregiverSwitcher />
              </div>
              <div className="ms-auto flex items-center gap-1.5 sm:gap-2">
                <Link
                  href="/app/care-access"
                  className="hidden h-11 items-center gap-1.5 rounded-xl bg-primary px-3.5 text-base font-semibold text-primary-fg hover:bg-primary-strong sm:inline-flex"
                >
                  <Stethoscope className="size-5" aria-hidden />
                  <span>{t('nav.needCare')}</span>
                </Link>
                <button
                  type="button"
                  onClick={openEmergency}
                  className="inline-flex h-11 items-center gap-1.5 rounded-xl bg-danger-solid px-3.5 text-base font-bold text-white hover:bg-danger-solid-hover"
                >
                  <Siren className="size-5" aria-hidden />
                  <span>{t('nav.emergency')}</span>
                </button>
                <NotificationBell />
                <Link
                  href="/app/account"
                  className="inline-flex size-11 items-center justify-center rounded-xl text-fg-muted hover:bg-surface-2 hover:text-fg md:hidden"
                  aria-label={t('acc.title')}
                >
                  <UserRound className="size-5" aria-hidden />
                </Link>
              </div>
            </div>
            {user.role === 'caregiver' && (
              <div className="border-t border-primary/20 bg-primary-soft">
                <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 sm:px-6">
                  <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-primary-strong" role="status">
                    <Eye className="size-4 shrink-0" aria-hidden />
                    <span className="truncate">{patientName ? t('cg.viewing', { name: patientName }) : t('cg.choosePatient')}</span>
                  </p>
                  <CaregiverSwitcher className="w-full sm:hidden" />
                </div>
              </div>
            )}
            {!online && (
              <div role="status" className="flex items-center justify-center gap-2 bg-warn-soft px-4 py-2 text-sm font-medium text-warn-fg">
                <WifiOff className="size-4 shrink-0" aria-hidden />
                <span>{t('common.offline')}</span>
                <button type="button" onClick={openEmergency} className="min-h-8 shrink-0 font-bold underline">
                  {t('nav.emergency')}
                </button>
              </div>
            )}
            {queued > 0 && (
              <div role="status" className="flex items-center justify-center gap-2 bg-info-soft px-4 py-1.5 text-sm font-medium text-info-fg">
                <CloudUpload className="size-4 shrink-0" aria-hidden />
                {t('glu.pendingSync', { n: queued })}
              </div>
            )}
          </header>

          {/* keyed by the person shown: switching person remounts the pages, so nothing of the previous record stays */}
          <main key={activePatientId ?? 'self'} id="main" tabIndex={-1} className="mx-auto w-full max-w-5xl flex-1 px-4 pt-5 pb-32 outline-none sm:px-6 md:pb-12">
            {needsPatient ? <CaregiverChooser /> : children}
          </main>
        </div>

        {/* mobile bottom tab bar */}
        <nav aria-label={t('app.name')} className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur md:hidden">
          <div className="grid grid-cols-5">
            {NAV.map((n) => {
              const active = isActive(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex min-h-16 flex-col items-center justify-center gap-1 px-1 text-[0.8rem] leading-4 font-medium',
                    active ? 'text-primary-strong' : 'text-fg-muted',
                  )}
                >
                  <span className={cn('flex h-7 w-12 items-center justify-center rounded-full', active && 'bg-primary-soft')} aria-hidden>
                    <n.icon className={cn('size-5', active && 'stroke-[2.25]')} />
                  </span>
                  <span className="max-w-full truncate">{t(n.label)}</span>
                </Link>
              );
            })}
          </div>
        </nav>
      </div>

      <Dialog
        open={hypoPlan}
        onClose={() => setHypoPlan(false)}
        title={t('em.hypoTitle')}
        description={t('hypo.planIntro')}
        footer={
          <>
            <Button variant="outline" size="lg" onClick={openEmergency}>
              {t('nav.emergency')}
            </Button>
            <Button
              variant="soft"
              size="lg"
              icon={<BellRing className="size-5" />}
              onClick={() => {
                scheduleRecheck(15);
                setHypoPlan(false);
              }}
            >
              {t('recheck.button')}
            </Button>
            <Button size="lg" onClick={() => setHypoPlan(false)}>
              {t('common.done')}
            </Button>
          </>
        }
      >
        <ol className="space-y-3">
          {(['em.hypo1', 'em.hypo2', 'em.hypo3', 'em.hypo4', 'em.hypo5'] as TKey[]).map((k, i) => (
            <li key={k} className="flex gap-3 text-base leading-7 text-fg">
              <span className="num flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-bold text-primary-strong">{i + 1}</span>
              <span>{t(k)}</span>
            </li>
          ))}
        </ol>
      </Dialog>

      <LogGlucoseDialog
        open={logOpen}
        onClose={() => setLogOpen(false)}
        patientId={scope.patient_id}
        patientName={patientName}
        onSaved={() => onSavedRef.current?.()}
        onEmergency={openEmergency}
      />
      <MessageTeamDialog open={msg.open} prefill={msg.prefill} onClose={() => setMsg({ open: false })} patientId={scope.patient_id} patientName={patientName} />
      <Dialog
        open={!!syncedLow}
        onClose={() => setSyncedLow(null)}
        title={t('glu.whatNow')}
        description={syncedLow ? t('glu.syncedLow', { v: syncedLow.value }) : undefined}
        footer={
          <Button size="lg" onClick={() => setSyncedLow(null)}>
            {t('common.done')}
          </Button>
        }
      >
        {syncedLow && <LowGlucoseCard message={syncedLow.message} onEmergency={openEmergency} />}
      </Dialog>
      {!needsPatient && <Onboarding caregiver={user.role === 'caregiver'} />}
      {/* last in the page and above everything else (onboarding, dialogs): emergency help is never covered */}
      {emergency && <EmergencyOverlay onClose={() => setEmergency(false)} />}
    </PatientShellContext.Provider>
  );
}

/** Full-screen emergency help. Focus moves in and stays in; Escape does not close it (only the Back button does). */
function EmergencyOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useLocale();
  const ref = useRef<HTMLDivElement>(null);
  useModal(ref, true);
  return (
    <div ref={ref} tabIndex={-1} className="fixed inset-0 z-[80] overflow-y-auto outline-none" role="dialog" aria-modal="true" aria-label={t('em.title')}>
      <EmergencyScreen onClose={onClose} />
    </div>
  );
}
