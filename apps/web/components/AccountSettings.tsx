'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, Download, KeyRound, LogOut, Monitor, Moon, Palette, RotateCcw, ShieldCheck, Sparkles, Sun, Type, UserRound, Waves } from 'lucide-react';
import type { Locale, Patient } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useInstallPrompt, usePrefs } from '@/lib/prefs';
import { useApi, useMutation } from '@/lib/useApi';
import { isPatientRole } from '@/lib/roles';
import { GOVERNORATES, type TKey } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { Card } from './Card';
import { Badge } from './Badge';
import { Button } from './Button';
import { Field, Input, OptionButtons, Select } from './Field';
import { ErrorState, InlineError } from './EmptyState';
import { SkeletonCard } from './Skeleton';
import { useToast } from './Toast';
import { resetOnboarding } from './patient/Onboarding';
import { MyDataSettings, RedeemInviteCard } from './patient/People';
import { ConsentSettings } from './patient/ConsentSettings';
import { PrivacyRights } from './patient/PrivacyRights';
import { PushSettings } from './PushSettings';
import { PreferencesSettings } from './patient/Preferences';

function Section({ title, icon, children, id }: { title: string; icon: ReactNode; children: ReactNode; id?: string }) {
  return (
    <Card id={id} aria-labelledby={id ? `${id}-title` : undefined}>
      <h2 id={id ? `${id}-title` : undefined} className="mb-4 flex items-center gap-2 text-lg font-semibold">
        <span className="text-primary" aria-hidden>
          {icon}
        </span>
        {title}
      </h2>
      {children}
    </Card>
  );
}

/** Account & settings for every role: display preferences, profile (patients), password, two-factor (staff), sign out. */
export function AccountSettings() {
  const { user, logout } = useAuth();
  const { t, pick, te } = useLocale();
  const router = useRouter();
  // /app/account#privacy (from the assistant): the section renders after sign-in is read, so scroll once it exists
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const id = setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
    return () => clearTimeout(id);
  }, []);
  if (!user) return null;
  const patient = user.role === 'patient';
  const staff = !isPatientRole(user.role);

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-center gap-4">
        <span className="flex size-16 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary" aria-hidden>
          <UserRound className="size-8" />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold">{pick(user.full_name, user.full_name_ar)}</h1>
          <p className="truncate text-base text-fg-muted">
            {te('role.', user.role)} ·{' '}
            <span dir="ltr" className="inline-block">
              {user.email}
            </span>
          </p>
        </div>
      </div>

      <DisplaySettings />
      {patient && <ProfileSettings />}
      <PasswordSettings />
      {staff && <MfaSettings />}
      {user.role === 'caregiver' && <RedeemInviteCard />}
      {!staff && <PreferencesSettings />}
      <PushSettings />
      {!staff && <AppSettings />}
      {!staff && (
        <div id="privacy" className="scroll-mt-24 space-y-5">
          {patient && <ConsentSettings />}
          {patient && <PrivacyRights />}
          <MyDataSettings />
        </div>
      )}

      <Button
        variant="outline"
        size="xl"
        className="w-full border-danger/40 text-danger hover:bg-danger-soft"
        icon={<LogOut className="size-5 rtl:-scale-x-100" />}
        onClick={() => void logout().then(() => router.replace('/login'))}
      >
        {t('common.logout')}
      </Button>
    </div>
  );
}

function DisplaySettings() {
  const { t, locale, setLocale } = useLocale();
  const { user } = useAuth();
  const { theme, setTheme, textSize, setTextSize, motion, setMotion } = usePrefs();
  return (
    <Section title={t('acc.display')} icon={<Palette className="size-5" />}>
      <div className="space-y-5">
        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t('acc.appLanguage')}</legend>
          <p className="-mt-1 mb-2 text-sm text-fg-muted">
            {t('acc.appLanguageHint')}
            {user?.role === 'patient' && <> {t('acc.appLanguageVsMessages')}</>}
          </p>
          <OptionButtons<Locale>
            columns={2}
            name={t('common.language')}
            value={locale}
            onChange={setLocale}
            options={[
              { value: 'ar', label: <span lang="ar">العربية</span> },
              { value: 'en', label: <span lang="en">English</span> },
            ]}
          />
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t('acc.theme')}</legend>
          <OptionButtons
            columns={3}
            name={t('acc.theme')}
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'light', label: t('acc.themeLight'), icon: <Sun className="size-5" /> },
              { value: 'dark', label: t('acc.themeDark'), icon: <Moon className="size-5" /> },
              { value: 'system', label: t('acc.themeSystem'), icon: <Monitor className="size-5" /> },
            ]}
            className="[&_button]:flex-col [&_button]:items-start [&_button]:gap-1 sm:[&_button]:flex-row sm:[&_button]:items-center"
          />
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t('acc.textSize')}</legend>
          <OptionButtons
            columns={2}
            name={t('acc.textSize')}
            value={textSize}
            onChange={setTextSize}
            options={[
              { value: 'normal', label: t('acc.textNormal'), icon: <Type className="size-4" /> },
              { value: 'large', label: <span className="text-lg">{t('acc.textLarge')}</span>, icon: <Type className="size-6" /> },
            ]}
          />
          <p className="mt-2 rounded-xl bg-surface-2 px-4 py-3 text-base">{t('acc.textPreview')}</p>
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t('acc.motion')}</legend>
          <p className="-mt-1 mb-2 text-sm text-fg-muted">{t('acc.motionHint')}</p>
          <OptionButtons
            columns={2}
            name={t('acc.motion')}
            value={motion}
            onChange={setMotion}
            options={[
              { value: 'system', label: t('acc.motionSystem'), icon: <Sparkles className="size-5" /> },
              { value: 'reduce', label: t('acc.motionReduce'), icon: <Waves className="size-5" /> },
            ]}
          />
        </fieldset>
      </div>
    </Section>
  );
}

function ProfileSettings() {
  const { t } = useLocale();
  const toast = useToast();
  const q = useApi('profile', 'get', {});
  const { mutate, pending, error } = useMutation();
  const [f, setF] = useState({ phone: '', governorate: '', city: '', preferred_language: 'ar' as Locale, height_cm: '' });

  useEffect(() => {
    if (q.data) {
      setF({
        phone: q.data.phone ?? '',
        governorate: q.data.governorate ?? '',
        city: q.data.city ?? '',
        preferred_language: q.data.preferred_language,
        height_cm: q.data.height_cm ? String(q.data.height_cm) : '',
      });
    }
  }, [q.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      const p: Patient = await mutate('profile', 'update', {
        phone: f.phone.trim() || undefined,
        governorate: f.governorate || undefined,
        city: f.city.trim() || undefined,
        preferred_language: f.preferred_language,
        height_cm: f.height_cm ? Number(f.height_cm) : undefined,
      });
      q.setData(p);
      toast(t('acc.profileSaved'));
    } catch {
      /* inline */
    }
  }

  return (
    <Section title={t('acc.profile')} icon={<UserRound className="size-5" />} id="profile">
      {q.loading && !q.data ? (
        <SkeletonCard lines={3} className="border-0 p-0" />
      ) : q.error && !q.data ? (
        <ErrorState compact error={q.error} onRetry={() => void q.reload()} />
      ) : (
        <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
          <Field label={t('reg.phone')}>
            <Input type="tel" inputMode="tel" dir="ltr" autoComplete="tel" value={f.phone} onChange={(e) => setF((s) => ({ ...s, phone: e.target.value }))} />
          </Field>
          <Field label={t('acc.height')}>
            <Input
              inputMode="numeric"
              dir="ltr"
              value={f.height_cm}
              onChange={(e) => setF((s) => ({ ...s, height_cm: e.target.value.replace(/[^0-9]/g, '').slice(0, 3) }))}
            />
          </Field>
          <Field label={t('reg.governorate')}>
            <Select value={f.governorate} onChange={(e) => setF((s) => ({ ...s, governorate: e.target.value }))}>
              <option value="">—</option>
              {f.governorate && !(GOVERNORATES as readonly string[]).includes(f.governorate) && <option value={f.governorate}>{f.governorate}</option>}
              {GOVERNORATES.map((g) => (
                <option key={g} value={g}>
                  {t(`gov.${g}` as TKey)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('reg.city')}>
            <Input value={f.city} onChange={(e) => setF((s) => ({ ...s, city: e.target.value }))} />
          </Field>
          <fieldset className="sm:col-span-2">
            <legend className="mb-1.5 text-sm font-medium">{t('reg.language')}</legend>
            <p className="-mt-0.5 mb-2 text-sm text-fg-muted">{t('acc.messageLanguageHint')}</p>
            <OptionButtons<Locale>
              columns={2}
              name={t('reg.language')}
              value={f.preferred_language}
              onChange={(v) => setF((s) => ({ ...s, preferred_language: v }))}
              options={[
                { value: 'ar', label: 'العربية' },
                { value: 'en', label: 'English' },
              ]}
            />
          </fieldset>
          <div className="space-y-3 sm:col-span-2">
            <InlineError error={error} />
            <Button type="submit" size="lg" loading={pending} className="w-full sm:w-auto">
              {t('common.save')}
            </Button>
          </div>
        </form>
      )}
    </Section>
  );
}

function PasswordSettings() {
  const { t } = useLocale();
  const toast = useToast();
  const { mutate, pending, error, clearError } = useMutation();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [local, setLocal] = useState<TKey | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    clearError();
    if (next.length < 8 || !/[A-Za-z]/.test(next) || !/\d/.test(next)) return setLocal('err.weakPassword');
    if (next !== next2) return setLocal('reg.passwordMismatch');
    setLocal(null);
    try {
      await mutate('auth', 'change_password', { current_password: cur, new_password: next });
      toast(t('acc.passwordChanged'));
      setCur('');
      setNext('');
      setNext2('');
    } catch {
      /* inline */
    }
  }

  return (
    <Section title={t('acc.security')} icon={<KeyRound className="size-5" />}>
      <form onSubmit={submit} className="space-y-4">
        <h3 className="text-base font-semibold">{t('acc.changePassword')}</h3>
        <Field label={t('acc.currentPassword')}>
          <Input type="password" autoComplete="current-password" dir="ltr" required value={cur} onChange={(e) => setCur(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('acc.newPassword')} hint={t('reg.passwordHint')}>
            <Input type="password" autoComplete="new-password" dir="ltr" required value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label={t('reg.passwordAgain')}>
            <Input type="password" autoComplete="new-password" dir="ltr" required value={next2} onChange={(e) => setNext2(e.target.value)} />
          </Field>
        </div>
        <InlineError error={error} message={local ? t(local) : null} />
        <Button type="submit" size="lg" variant="outline" loading={pending} disabled={!cur || !next} className="w-full sm:w-auto">
          {t('acc.changePassword')}
        </Button>
      </form>
    </Section>
  );
}

function MfaSettings() {
  const { t } = useLocale();
  const { user, refreshUser } = useAuth();
  const toast = useToast();
  const { mutate, pending, error, clearError } = useMutation();
  const [setup, setSetup] = useState<{ secret: string; otpauth_url: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const enabled = !!user?.mfa_enabled;

  async function start() {
    clearError();
    try {
      const s = await mutate('auth', 'mfa_setup', {});
      // the QR code library is only needed here: loaded on demand, not with every account page
      const { toDataURL } = await import('qrcode');
      const qr = await toDataURL(s.otpauth_url, { margin: 1, width: 220, errorCorrectionLevel: 'M' });
      setSetup({ ...s, qr });
      setCode('');
    } catch {
      /* inline */
    }
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    if (code.length !== 6) return;
    try {
      if (enabled) {
        await mutate('auth', 'mfa_disable', { code });
        toast(t('acc.mfaDisabled'));
      } else {
        await mutate('auth', 'mfa_enable', { code });
        toast(t('acc.mfaEnabled'));
      }
      setSetup(null);
      setCode('');
      await refreshUser().catch(() => undefined);
    } catch {
      /* inline */
    }
  }

  const codeInput = (
    <input
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      dir="ltr"
      aria-label={t('auth.mfaTitle')}
      value={code}
      onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
      className="h-12 w-44 rounded-xl border-2 border-line-strong bg-surface text-center text-2xl font-semibold tracking-[0.35em] focus:border-primary focus:outline-none"
      placeholder="000000"
    />
  );

  return (
    <Section title={t('acc.mfa')} icon={<ShieldCheck className="size-5" />}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-md text-sm leading-6 text-fg-muted">{t('acc.mfaDesc')}</p>
        <Badge tone={enabled ? 'ok' : 'neutral'}>{enabled ? t('acc.mfaOn') : t('acc.mfaOff')}</Badge>
      </div>

      {enabled ? (
        <form onSubmit={confirm} className="mt-4 space-y-3">
          <p className="text-sm text-fg-muted">{t('acc.mfaDisableHint')}</p>
          <div className="flex flex-wrap items-center gap-2">
            {codeInput}
            <Button type="submit" variant="outline" loading={pending} disabled={code.length !== 6}>
              {t('acc.mfaDisable')}
            </Button>
          </div>
          <InlineError error={error} />
        </form>
      ) : setup ? (
        <form onSubmit={confirm} className="mt-4 space-y-4">
          <p className="text-sm font-medium">{t('acc.mfaScan')}</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={setup.qr} alt={t('acc.mfaQrAlt')} width={220} height={220} className="rounded-xl border border-line bg-white p-2" />
          <div>
            <p className="text-sm text-fg-muted">{t('acc.mfaManual')}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <code dir="ltr" className="rounded-lg bg-surface-2 px-3 py-2 font-mono text-sm break-all select-all">
                {setup.secret}
              </code>
              <Button
                size="sm"
                variant="ghost"
                icon={<Copy className="size-4" />}
                onClick={() => {
                  void navigator.clipboard?.writeText(setup.secret).then(() => setCopied(true));
                }}
              >
                {copied ? t('acc.copied') : t('acc.copy')}
              </Button>
            </div>
          </div>
          <p className="text-sm font-medium">{t('acc.mfaEnter')}</p>
          <div className="flex flex-wrap items-center gap-2">
            {codeInput}
            <Button type="submit" loading={pending} disabled={code.length !== 6}>
              {t('acc.mfaEnable')}
            </Button>
            <Button variant="ghost" onClick={() => setSetup(null)}>
              {t('common.cancel')}
            </Button>
          </div>
          <InlineError error={error} />
        </form>
      ) : (
        <div className="mt-4 space-y-3">
          <Button icon={<ShieldCheck className="size-4" />} loading={pending} onClick={() => void start()}>
            {t('acc.mfaSetup')}
          </Button>
          <InlineError error={error} />
        </div>
      )}
    </Section>
  );
}

function AppSettings() {
  const { t } = useLocale();
  const router = useRouter();
  // captured once for the whole app (the browser offers it only once, often before this page is opened)
  const install = useInstallPrompt();

  return (
    <Section title={t('common.settings')} icon={<Download className="size-5" />}>
      <div className="space-y-4">
        <div className={cn('rounded-2xl bg-surface-2 p-4')}>
          <p className="text-base font-semibold">{t('acc.installApp')}</p>
          <p className="mt-1 text-sm leading-6 text-fg-muted">{t('acc.installHint')}</p>
          {install.available && (
            <Button className="mt-3" icon={<Download className="size-4" />} onClick={() => void install.prompt()}>
              {t('acc.install')}
            </Button>
          )}
        </div>
        <Button
          variant="ghost"
          size="lg"
          icon={<RotateCcw className="size-5" />}
          onClick={() => {
            resetOnboarding();
            router.push('/app/today');
          }}
        >
          {t('acc.replayTour')}
        </Button>
      </div>
    </Section>
  );
}
