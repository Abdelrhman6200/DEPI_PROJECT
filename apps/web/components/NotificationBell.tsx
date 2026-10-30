'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeftRight,
  Bell,
  BellOff,
  BookOpen,
  CalendarDays,
  CheckCheck,
  Droplet,
  FileText,
  FlaskConical,
  MessageSquareText,
  Pill,
  ShieldAlert,
  Sparkles,
  UserPlus,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import type { Notification } from '@health/api-client';
import { api, errorCode } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useVisible } from '@/lib/offline';
import { isPatientRole } from '@/lib/roles';
import { cn } from '@/lib/cn';
import { Dialog } from './Dialog';
import { Button } from './Button';
import { EmptyState, ErrorState } from './EmptyState';
import { SkeletonList } from './Skeleton';
import { callKey, takeBundled } from '@/lib/pageBundle';

const POLL_MS = 60_000;
/** Fired after a notification navigates, so a page that is already open can read its new ?tab= or #section. */
export const LOCATION_EVENT = 'health:location';

/** Notifications (insights.notifications), polled every 60 s while the tab is visible. */
// One fetch shared by every bell on the screen and by the page's notices: from the screen's page action when it brought
// them (lib/pageBundle.ts), otherwise one request reused for a few seconds.
let shared: { at: number; promise: Promise<Notification[]> } | null = null;
function fetchNotifications(): Promise<Notification[]> {
  if (shared && Date.now() - shared.at < 5000) return shared.promise;
  const bundled = takeBundled(callKey('insights', 'notifications', {}));
  const promise = (bundled
    ? bundled.catch(() => api.call('insights', 'notifications', {}))
    : api.call('insights', 'notifications', {})) as Promise<Notification[]>;
  shared = { at: Date.now(), promise };
  promise.catch(() => { shared = null; });
  return promise;
}

export function useNotifications() {
  const { token } = useAuth();
  const visible = useVisible();
  const [items, setItems] = useState<Notification[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [unsupported, setUnsupported] = useState(false);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current || !token) return;
    busy.current = true;
    try {
      setItems(await fetchNotifications());
      setError(null);
    } catch (e) {
      if (errorCode(e) === 'unknown_action') setUnsupported(true);
      setError(e);
    } finally {
      busy.current = false;
    }
  }, [token]);

  useEffect(() => {
    if (!visible || unsupported || !token) return;
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [visible, unsupported, token, load]);

  const markRead = useCallback(async (id: string) => {
    setItems((xs) => (xs ? xs.map((n) => (n.id === id ? { ...n, read_at: n.read_at ?? new Date().toISOString() } : n)) : xs));
    try {
      await api.call('insights', 'mark_notification_read', { notification_id: id });
    } catch {
      /* non-critical; the next poll restores the true state */
    }
  }, []);

  /**
   * One request (insights.mark_all_read); a service without it gets one request per notification, at most 10 at
   * a time, instead of 50 at once.
   */
  const markAllRead = useCallback(async () => {
    const ids = (items ?? []).filter((n) => !n.read_at).map((n) => n.id);
    if (!ids.length) return;
    const at = new Date().toISOString();
    setItems((xs) => (xs ? xs.map((n) => (n.read_at ? n : { ...n, read_at: at })) : xs));
    try {
      await api.call('insights', 'mark_all_read', {});
      return;
    } catch (e) {
      if (errorCode(e) !== 'unknown_action' && errorCode(e) !== 'bad_request') return; // the next poll shows the true state
    }
    for (let i = 0; i < ids.length; i += 10) {
      await Promise.all(ids.slice(i, i + 10).map((id) => api.call('insights', 'mark_notification_read', { notification_id: id }).catch(() => undefined)));
    }
  }, [items]);

  const unread = (items ?? []).filter((n) => !n.read_at).length;
  return { items, error, unsupported, unread, reload: load, markRead, markAllRead };
}

/** Where a notification leads, so tapping it opens the thing it talks about. Unknown kinds are only marked read. */
function targetFor(kind: string, patient: boolean): string | null {
  if (kind === 'security') return patient ? '/app/account' : '/provider/account';
  if (!patient) {
    if (kind === 'critical_lab') return '/provider';
    if (kind === 'link_request') return '/provider?view=join';
    if (kind === 'transfer') return '/provider/transfers';
    if (kind === 'capacity') return '/provider/network';
    if (kind === 'break_glass') return '/provider/admin?tab=audit';
    if (kind === 'guideline') return '/provider/admin?tab=kb';
    if (kind === 'data_request' || kind === 'privacy_breach') return '/provider/admin?tab=privacy';
    return null;
  }
  if (kind.startsWith('glucose_')) return '/app/health/glucose';
  if (kind === 'medication_reminder' || kind === 'medication_missed' || kind === 'refill_due' || kind === 'insight') return '/app/today';
  if (kind === 'data_request') return '/app/account#privacy';
  if (kind === 'sick_day' || kind === 'sick_check') return '/app/care/sick';
  if (kind === 'heat_alert') return '/app/today';
  if (kind === 'screening_reminder') return '/app/care#screenings';
  if (kind === 'document') return '/app/health?tab=documents';
  if (kind === 'critical_lab') return '/app/health?tab=labs';
  if (kind === 'team_message') return '/app/care#messages';
  if (kind === 'caregiver_joined') return '/app/care#family';
  if (/^(appointment|care_plan|referral|episode_followup|link_|transfer)/.test(kind)) return '/app/care';
  return null;
}

/** A small picture per kind so the list can be scanned; security and critical results stand out in red. */
function kindIcon(kind: string): { Icon: LucideIcon; tone: string } {
  if (kind === 'security' || kind === 'break_glass') return { Icon: ShieldAlert, tone: 'text-danger' };
  if (kind === 'critical_lab') return { Icon: FlaskConical, tone: 'text-danger' };
  if (kind.startsWith('glucose_')) return { Icon: Droplet, tone: 'text-primary' };
  if (kind === 'team_message') return { Icon: MessageSquareText, tone: 'text-primary' };
  if (kind === 'caregiver_joined') return { Icon: UsersRound, tone: 'text-primary' };
  if (kind === 'link_request') return { Icon: UserPlus, tone: 'text-primary' };
  if (kind === 'guideline') return { Icon: BookOpen, tone: 'text-primary' };
  if (kind === 'medication_reminder' || kind === 'medication_missed' || kind === 'refill_due') return { Icon: Pill, tone: 'text-primary' };
  if (kind === 'document') return { Icon: FileText, tone: 'text-primary' };
  if (kind === 'insight') return { Icon: Sparkles, tone: 'text-primary' };
  if (kind === 'transfer') return { Icon: ArrowLeftRight, tone: 'text-primary' };
  if (/^(appointment|screening)/.test(kind)) return { Icon: CalendarDays, tone: 'text-primary' };
  return { Icon: Bell, tone: 'text-fg-muted' };
}

export function NotificationBell({ className }: { className?: string }) {
  const { t, fmt, pick } = useLocale();
  const { user } = useAuth();
  const router = useRouter();
  const n = useNotifications();
  const [open, setOpen] = useState(false);
  if (n.unsupported) return null;

  const sorted = [...(n.items ?? [])].sort((a, b) => Number(!!a.read_at) - Number(!!b.read_at) || b.created_at.localeCompare(a.created_at));

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          void n.reload();
        }}
        className={cn('relative inline-flex size-11 items-center justify-center rounded-xl text-fg-muted hover:bg-surface-2 hover:text-fg', className)}
        aria-label={t('notif.open', { n: n.unread })}
      >
        {/* The count sits on the corner of the bell, not over it. */}
        <span className="relative inline-flex">
          <Bell className="size-5" aria-hidden />
          {n.unread > 0 && (
            <span className="num absolute -top-2 -end-2.5 flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-danger-solid px-1 text-[0.65rem] leading-none font-bold text-white ring-2 ring-bg" aria-hidden>
              {n.unread > 9 ? '9+' : n.unread}
            </span>
          )}
        </span>
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('notif.title')}
        description={n.unread > 0 ? t('notif.unread', { n: n.unread }) : undefined}
        footer={
          n.unread > 0 ? (
            <Button variant="outline" icon={<CheckCheck className="size-4" />} onClick={() => void n.markAllRead()}>
              {t('notif.markAll')}
            </Button>
          ) : undefined
        }
      >
        {n.items === null && !n.error ? (
          <SkeletonList rows={3} />
        ) : n.items === null ? (
          <ErrorState compact error={n.error} onRetry={() => void n.reload()} />
        ) : sorted.length === 0 ? (
          <EmptyState title={t('notif.empty')} icon={<BellOff className="size-7" />} />
        ) : (
          <ul className="space-y-2" aria-live="polite">
            {sorted.map((x) => (
              <li key={x.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (!x.read_at) void n.markRead(x.id);
                    const to = targetFor(x.kind, isPatientRole(user?.role));
                    if (to) {
                      setOpen(false);
                      router.push(to);
                      // the same page with a new ?tab= or #section: Next neither remounts it nor scrolls there by itself
                      const hash = to.split('#')[1];
                      setTimeout(() => {
                        window.dispatchEvent(new Event(LOCATION_EVENT));
                        if (hash) document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }, 400);
                    }
                  }}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-2xl border p-3 text-start transition-colors',
                    x.read_at ? 'border-line bg-surface' : 'border-primary/30 bg-primary-soft/60 hover:bg-primary-soft',
                  )}
                  aria-label={x.read_at ? undefined : `${t('notif.markRead')}: ${pick(x.title, x.title_ar)}`}
                >
                  <span className={cn('mt-2 size-2.5 shrink-0 rounded-full', x.read_at ? 'bg-transparent' : 'bg-primary')} aria-hidden />
                  {(() => {
                    const { Icon, tone } = kindIcon(x.kind);
                    return <Icon className={cn('mt-0.5 size-5 shrink-0', tone)} aria-hidden />;
                  })()}
                  <span className="min-w-0 flex-1">
                    <span dir="auto" className={cn('block text-base text-fg', !x.read_at && 'font-semibold')}>
                      {pick(x.title, x.title_ar)}
                    </span>
                    {x.body && (
                      <span dir="auto" className="mt-0.5 block text-sm leading-6 text-fg-muted">
                        {pick(x.body, x.body_ar)}
                      </span>
                    )}
                    <span className="mt-1 block text-xs text-fg-muted">{fmt.relative(x.created_at)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </>
  );
}
