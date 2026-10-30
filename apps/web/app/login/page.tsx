'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Activity,
  AlertOctagon,
  ArrowLeftRight,
  ChevronDown,
  ConciergeBell,
  Eye,
  EyeOff,
  HeartPulse,
  KeyRound,
  LogIn,
  ShieldAlert,
  ShieldCheck,
  Stethoscope,
  UserPlus,
  UserRound,
  Users,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { homeFor } from '@/lib/roles';
import type { TKey } from '@/lib/i18n';
import { Button, ButtonLink } from '@/components/Button';
import { Field, Input } from '@/components/Field';
import { InlineError } from '@/components/EmptyState';
import { LocaleToggle } from '@/components/LocaleToggle';
import { cn } from '@/lib/cn';

// Demo servers set NEXT_PUBLIC_DEMO_PASSWORD; without it (public servers) the demo accounts are not listed at all.
const DEMO_PASSWORD = process.env.NEXT_PUBLIC_DEMO_PASSWORD ?? '';

const PATIENTS: { email: string; label: TKey }[] = [
  { email: 'p1@demo.health', label: 'demo.p1' },
  { email: 'p2@demo.health', label: 'demo.p2' },
  { email: 'p3@demo.health', label: 'demo.p3' },
  { email: 'p4@demo.health', label: 'demo.p4' },
  { email: 'p5@demo.health', label: 'demo.p5' },
  { email: 'p6@demo.health', label: 'demo.p6' },
  { email: 'p7@demo.health', label: 'demo.p7' },
];

const STAFF: { email: string; label: TKey; icon: typeof UserRound }[] = [
  { email: 'caregiver@demo.health', label: 'role.caregiver', icon: Users },
  { email: 'dr.hassan@demo.health', label: 'role.doctor', icon: Stethoscope },
  { email: 'dr.mona@demo.health', label: 'role.doctor', icon: Stethoscope },
  { email: 'nurse.salma@demo.health', label: 'role.nurse', icon: HeartPulse },
  { email: 'reception@demo.health', label: 'role.receptionist', icon: ConciergeBell },
  { email: 'admin@demo.health', label: 'role.clinic_admin', icon: ShieldCheck },
  { email: 'safety@demo.health', label: 'role.safety_officer', icon: ShieldAlert },
  { email: 'capacity@demo.health', label: 'role.capacity_operator', icon: Activity },
  { email: 'platform@demo.health', label: 'role.platform_admin', icon: ArrowLeftRight },
];

export default function LoginPage() {
  const { t } = useLocale();
  const { login, verifyMfa, user, ready } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');

  useEffect(() => {
    if (ready && user) router.replace(homeFor(user.role));
  }, [ready, user, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const step = await login(email.trim(), password);
      if (step.mfaToken) {
        setMfaToken(step.mfaToken);
        setCode('');
      } else if (step.user) {
        router.replace(homeFor(step.user.role));
      }
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  }

  async function onVerify(e: FormEvent) {
    e.preventDefault();
    if (!mfaToken || code.length !== 6) return;
    setPending(true);
    setError(null);
    try {
      const u = await verifyMfa(mfaToken, code);
      router.replace(homeFor(u.role));
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  }

  const fill = (em: string) => {
    setEmail(em);
    setPassword(DEMO_PASSWORD);
    setError(null);
  };

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      {/* brand panel */}
      <aside className="relative hidden overflow-hidden bg-brand p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="absolute -end-24 -top-24 size-96 rounded-full bg-white/10" aria-hidden />
        <div className="absolute -bottom-32 -start-16 size-[28rem] rounded-full bg-white/5" aria-hidden />
        <div className="relative flex items-center gap-3">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-white/15" aria-hidden>
            <HeartPulse className="size-7" />
          </span>
          <span className="text-2xl font-bold">{t('app.name')}</span>
        </div>
        <div className="relative max-w-md">
          <p className="text-4xl leading-tight font-bold">{t('app.tagline')}</p>
        </div>
        <Link href="/emergency" className="relative inline-flex w-fit items-center gap-2 rounded-xl bg-white/15 px-4 py-3 text-base font-medium hover:bg-white/25">
          <AlertOctagon className="size-5" aria-hidden />
          {t('auth.emergencyNoLogin')}
        </Link>
      </aside>

      {/* form */}
      <main className="flex flex-col px-4 py-5 sm:px-8">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 lg:invisible">
            <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-fg" aria-hidden>
              <HeartPulse className="size-5" />
            </span>
            <span className="text-lg font-bold">{t('app.name')}</span>
          </div>
          <LocaleToggle />
        </div>

        <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-8">
          {mfaToken ? (
            <>
              <span className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-primary-soft text-primary" aria-hidden>
                <KeyRound className="size-7" />
              </span>
              <h1 className="text-2xl font-bold tracking-tight">{t('auth.mfaTitle')}</h1>
              <p className="mt-1 text-base text-fg-muted">{t('auth.mfaHint')}</p>
              <form onSubmit={onVerify} className="mt-6 space-y-4">
                <label className="block">
                  <span className="sr-only">{t('auth.mfaTitle')}</span>
                  <input
                    autoFocus
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    dir="ltr"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    className="h-16 w-full rounded-2xl border-2 border-line-strong bg-surface text-center text-3xl font-semibold tracking-[0.5em] focus:border-primary focus:outline-none"
                    placeholder="••••••"
                  />
                </label>
                <InlineError error={error} />
                <Button type="submit" size="lg" className="w-full" loading={pending} disabled={code.length !== 6}>
                  {t('auth.verify')}
                </Button>
                <button
                  type="button"
                  onClick={() => {
                    setMfaToken(null);
                    setError(null);
                  }}
                  className="min-h-11 w-full text-base font-medium text-fg-muted hover:text-fg"
                >
                  {t('auth.useOther')}
                </button>
              </form>
            </>
          ) : (
            <>
              <h1 className="text-3xl font-bold tracking-tight">{t('auth.signIn')}</h1>
              <p className="mt-1 text-base text-fg-muted">{t('auth.subtitle')}</p>

              <form onSubmit={onSubmit} className="mt-6 space-y-4">
                <Field label={t('auth.email')}>
                  <Input type="email" autoComplete="username" inputMode="email" dir="ltr" required value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
                <Field label={t('auth.password')}>
                  <div className="relative">
                    <Input
                      type={showPw ? 'text' : 'password'}
                      autoComplete="current-password"
                      dir="ltr"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="pe-12"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPw((x) => !x)}
                      className="absolute end-0 top-0 inline-flex size-11 items-center justify-center text-fg-muted hover:text-fg"
                      aria-label={showPw ? t('auth.hidePassword') : t('auth.showPassword')}
                      aria-pressed={showPw}
                    >
                      {showPw ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
                    </button>
                  </div>
                </Field>
                <Link href="/forgot-password" className="-mt-1 inline-flex min-h-11 items-center text-base font-semibold text-primary-strong underline-offset-4 hover:underline">
                  {t('forgot.link')}
                </Link>
                <InlineError error={error} />
                <Button type="submit" size="lg" className="w-full" loading={pending} icon={<LogIn className="size-5 rtl:-scale-x-100" />}>
                  {pending ? t('auth.signingIn') : t('auth.signIn')}
                </Button>
              </form>

              <div className="mt-6 rounded-2xl border border-line bg-surface p-4 text-center">
                <p className="text-base text-fg-muted">{t('auth.noAccount')}</p>
                <ButtonLink href="/register" variant="outline" size="lg" className="mt-2 w-full" icon={<UserPlus className="size-5" />}>
                  {t('auth.createAccount')}
                </ButtonLink>
              </div>

              <Link
                href="/emergency"
                className="mt-4 inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-danger/30 bg-danger-soft px-4 py-2.5 text-base font-semibold text-danger-fg lg:hidden"
              >
                <AlertOctagon className="size-5" aria-hidden />
                {t('auth.emergencyNoLogin')}
              </Link>

              {DEMO_PASSWORD && (
              <details className="group mt-6 rounded-2xl border border-line bg-surface">
                <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 px-4 text-base font-semibold">
                  {t('auth.demo')}
                  <ChevronDown className="size-5 text-fg-muted transition-transform group-open:rotate-180" aria-hidden />
                </summary>
                <div className="border-t border-line p-4">
                  <p className="text-sm text-fg-muted">{t('auth.demoHint')}</p>
                  <p className="mt-4 mb-2 text-sm font-semibold text-fg-muted">{t('auth.patients')}</p>
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {PATIENTS.map((p) => (
                      <DemoButton key={p.email} active={email === p.email} onClick={() => fill(p.email)} email={p.email} label={t(p.label)} icon={UserRound} />
                    ))}
                  </div>
                  <p className="mt-4 mb-2 text-sm font-semibold text-fg-muted">{t('auth.staff')}</p>
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {STAFF.map((s) => (
                      <DemoButton key={s.email} active={email === s.email} onClick={() => fill(s.email)} email={s.email} label={t(s.label)} icon={s.icon} />
                    ))}
                  </div>
                </div>
              </details>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function DemoButton({ email, label, onClick, active, icon: Icon }: { email: string; label: string; onClick: () => void; active: boolean; icon: typeof UserRound }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex min-h-12 items-center gap-2.5 rounded-xl border px-3 py-2 text-start transition-colors',
        active ? 'border-primary bg-primary-soft' : 'border-line hover:border-line-strong hover:bg-surface-2',
      )}
    >
      <Icon className="size-4 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-fg">{label}</span>
        <span className="block truncate text-xs text-fg-muted" dir="ltr">
          {email}
        </span>
      </span>
    </button>
  );
}
