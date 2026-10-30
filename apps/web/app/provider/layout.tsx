'use client';

import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeftRight,
  Building2,
  CalendarDays,
  HeartPulse,
  Inbox,
  Loader2,
  Send,
  Settings2,
  ShieldAlert,
  Target,
  UserRound,
  Users,
  CalendarCheck,
  Gauge,
  ClipboardList,
  ConciergeBell,
  Stethoscope,
  Store,
} from 'lucide-react';
import type { Role } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useApi, useVisibleInterval } from '@/lib/useApi';
import { STATS_EVENT } from '@/lib/inbox';
import { ADMIN_ROLES, BREAK_GLASS_ROLES, CLINICAL_ROLES, INBOX_ROLES, TRANSFER_ROLES, hasRole, homeFor, isPatientRole } from '@/lib/roles';
import { cn } from '@/lib/cn';
import type { TKey } from '@/lib/i18n';
import { LocaleToggle } from '@/components/LocaleToggle';
import { NotificationBell } from '@/components/NotificationBell';
import { Skeleton } from '@/components/Skeleton';
import { PasswordChangeGate } from '@/components/PasswordChangeGate';

const NAV: { href: string; label: TKey; icon: typeof Inbox; roles?: Role[]; exact?: boolean }[] = [
  { href: '/provider', label: 'pv.inbox', icon: Inbox, exact: true, roles: INBOX_ROLES },
  { href: '/provider/patients', label: 'pv.patients', icon: Users, roles: CLINICAL_ROLES },
  { href: '/provider/panel', label: 'panel.title', icon: Gauge, roles: INBOX_ROLES },
  { href: '/provider/appointments', label: 'pv.appointments', icon: CalendarDays, roles: CLINICAL_ROLES },
  { href: '/provider/referrals', label: 'pv.referrals', icon: Send, roles: CLINICAL_ROLES },
  // Polyclinic (docs/integration/clinic-module.md): reception board, the doctor's clinic queue, the catalog and numbers.
  { href: '/provider/clinic', label: 'clinic.nav.dispatch', icon: ConciergeBell, exact: true, roles: ['receptionist', 'clinic_admin', 'nurse'] },
  { href: '/provider/clinic/queue', label: 'clinic.nav.queue', icon: Stethoscope, roles: ['doctor'] },
  { href: '/provider/clinic/catalog', label: 'clinic.nav.admin', icon: Store, roles: ['clinic_admin', 'platform_admin'] },
  { href: '/provider/transfers', label: 'pv.transfers', icon: ArrowLeftRight, roles: TRANSFER_ROLES },
  { href: '/provider/network', label: 'pv.network', icon: Building2 },
  { href: '/provider/emergency-access', label: 'pv.emergencyAccess', icon: ShieldAlert, roles: BREAK_GLASS_ROLES },
  { href: '/provider/admin', label: 'pv.admin', icon: Settings2, roles: ADMIN_ROLES },
];

export default function ProviderLayout({ children }: { children: ReactNode }) {
  const { ready, user } = useAuth();
  const { t, pick, te } = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!ready) return;
    if (!user) router.replace('/login');
    else if (isPatientRole(user.role)) router.replace('/app/today');
    else if (pathname === '/provider' && !hasRole(user.role, INBOX_ROLES)) router.replace(homeFor(user.role));
  }, [ready, user, router, pathname]);

  if (!ready || !user || isPatientRole(user.role)) {
    return (
      <div className="flex min-h-dvh items-center justify-center" aria-busy="true">
        <Loader2 className="size-6 animate-spin text-primary" aria-label={t('common.loading')} />
      </div>
    );
  }

  const nav = NAV.filter((n) => !n.roles || hasRole(user.role, n.roles));
  const isActive = (n: (typeof NAV)[number]) => (n.exact ? pathname === n.href : !!pathname?.startsWith(n.href));

  if (user.must_change_password) return <PasswordChangeGate>{null}</PasswordChangeGate>;

  return (
    <div className="min-h-dvh lg:flex">
      <a href="#main" className="skip-link">
        {t('common.skipToContent')}
      </a>
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-e border-line bg-surface px-3 py-5 lg:flex">
        <Link href={homeFor(user.role)} className="mb-6 flex items-center gap-2 px-2">
          <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-fg" aria-hidden>
            <HeartPulse className="size-5" />
          </span>
          <span className="font-semibold">{t('app.name')}</span>
        </Link>
        <nav aria-label={t('app.name')} className="flex flex-col gap-0.5">
          {nav.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={isActive(n) ? 'page' : undefined}
              className={cn(
                'flex min-h-10 items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors',
                isActive(n) ? 'bg-primary-soft text-primary-strong' : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
                n.href === '/provider/emergency-access' && !isActive(n) && 'text-danger hover:text-danger',
              )}
            >
              <n.icon className="size-[18px]" aria-hidden />
              {t(n.label)}
            </Link>
          ))}
        </nav>
        <div className="mt-auto space-y-2 border-t border-line pt-3">
          <Link
            href="/provider/account"
            aria-current={pathname === '/provider/account' ? 'page' : undefined}
            className={cn('flex items-center gap-2.5 rounded-xl px-2 py-2 hover:bg-surface-2', pathname === '/provider/account' && 'bg-primary-soft')}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-fg-muted" aria-hidden>
              <UserRound className="size-4" />
            </span>
            <span className="min-w-0 text-xs">
              <span className="block truncate font-semibold text-fg">{pick(user.full_name, user.full_name_ar)}</span>
              <span className="block truncate text-fg-muted">{te('role.', user.role)}</span>
            </span>
          </Link>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
          <div className="flex h-14 items-center gap-2 px-4 lg:px-8">
            <Link href="/provider" className="flex items-center gap-2 lg:hidden">
              <HeartPulse className="size-5 text-primary" aria-hidden />
              <span className="text-sm font-semibold">{t('app.name')}</span>
            </Link>
            <div className="ms-auto flex items-center gap-1.5">
              <LocaleToggle className="h-10" />
              <NotificationBell />
              <Link
                href="/provider/account"
                className="inline-flex size-11 items-center justify-center rounded-xl text-fg-muted hover:bg-surface-2 hover:text-fg lg:hidden"
                aria-label={t('acc.title')}
              >
                <UserRound className="size-5" aria-hidden />
              </Link>
            </div>
          </div>
          <nav aria-label={t('app.name')} className="flex gap-1 overflow-x-auto px-3 pb-2 [scrollbar-width:none] lg:hidden">
            {nav.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={isActive(n) ? 'page' : undefined}
                className={cn(
                  'flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium',
                  isActive(n) ? 'bg-primary-soft text-primary-strong' : 'text-fg-muted',
                )}
              >
                <n.icon className="size-4" aria-hidden />
                {t(n.label)}
              </Link>
            ))}
          </nav>
        </header>

        {pathname !== '/provider/account' && hasRole(user.role, CLINICAL_ROLES) && <StatsBar />}
        <main id="main" tabIndex={-1} className="w-full flex-1 px-4 py-5 outline-none lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}

function StatsBar() {
  const { t, fmt } = useLocale();
  const q = useApi('provider', 'stats', {});
  // kept current: every 45 s while visible, and right after an inbox item was acknowledged or closed
  useVisibleInterval(() => void q.reload(true), 45_000);
  useEffect(() => {
    const onChange = () => void q.reload(true);
    window.addEventListener(STATS_EVENT, onChange);
    return () => window.removeEventListener(STATS_EVENT, onChange);
  }, [q.reload]);
  const items: { label: TKey; value: string; icon: typeof Inbox; tone?: string }[] = q.data
    ? [
        { label: 'pv.stat.patients', value: fmt.number(q.data.patients), icon: Users },
        { label: 'pv.stat.open', value: fmt.number(q.data.open_items), icon: ClipboardList },
        { label: 'pv.stat.critical', value: fmt.number(q.data.critical_items), icon: AlertTriangle, tone: q.data.critical_items > 0 ? 'text-danger' : undefined },
        { label: 'pv.stat.apptsToday', value: fmt.number(q.data.appointments_today), icon: CalendarCheck },
        { label: 'pv.stat.avgTir', value: fmt.pct(q.data.avg_tir), icon: Target },
      ]
    : [];
  if (q.error && !q.data) return null; // stats are not available to every role
  return (
    <div className="print-hidden border-b border-line bg-bg px-4 py-3 lg:px-8">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        {q.loading && !q.data
          ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-xl" />)
          : items.map((s) => (
              <div key={s.label} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2">
                <s.icon className={cn('size-4 text-fg-subtle', s.tone)} aria-hidden />
                <div className="min-w-0">
                  <div className="truncate text-xs text-fg-muted">{t(s.label)}</div>
                  <div className={cn('num text-lg leading-6 font-semibold', s.tone)}>{s.value}</div>
                </div>
              </div>
            ))}
      </div>
    </div>
  );
}
