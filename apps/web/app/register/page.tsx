'use client';

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, CheckCircle2, Eye, EyeOff, HeartPulse, Info, PartyPopper } from 'lucide-react';
import type { Locale, Patient, RegisterInput } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { homeFor } from '@/lib/roles';
import { GOVERNORATES, type TKey } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { Button } from '@/components/Button';
import { CheckRow, Field, Input, OptionButtons, Select } from '@/components/Field';
import { InlineError } from '@/components/EmptyState';
import { LocaleToggle } from '@/components/LocaleToggle';
import { CaregiverSignup } from '@/components/patient/CaregiverSignup';

type Step = 0 | 1 | 2 | 3 | 4;
const STEPS: TKey[] = ['reg.stepAccount', 'reg.stepAbout', 'reg.stepDiabetes', 'reg.stepConsent'];

interface FormState {
  email: string;
  password: string;
  password2: string;
  full_name: string;
  full_name_ar: string;
  dobDay: string;
  dobMonth: string;
  dobYear: string;
  sex: 'male' | 'female' | null;
  phone: string;
  governorate: string;
  city: string;
  preferred_language: Locale;
  diabetes_type: Patient['diabetes_type'] | null;
  pregnant: boolean | null;
  pump: boolean | null;
  terms: boolean;
  data: boolean;
  ai: boolean;
}

function ageFrom(y: number, m: number, d: number): number {
  const now = new Date();
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age--;
  return age;
}

export default function RegisterPage() {
  const { t, locale, dir } = useLocale();
  // Family members sign up with an invitation code (link: /register?invite=CODE).
  const [family, setFamily] = useState<{ code?: string } | null>(null);
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('invite');
    if (code) setFamily({ code });
  }, []);
  const { register, user, ready } = useAuth();
  const router = useRouter();
  const [step, setStep] = useState<Step>(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [f, setF] = useState<FormState>({
    email: '',
    password: '',
    password2: '',
    full_name: '',
    full_name_ar: '',
    dobDay: '',
    dobMonth: '',
    dobYear: '',
    sex: null,
    phone: '',
    governorate: '',
    city: '',
    preferred_language: locale,
    diabetes_type: null,
    pregnant: null,
    pump: null,
    terms: false,
    data: false,
    ai: false,
  });
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  // signed-in people (but not someone who just finished this flow) go home
  useEffect(() => {
    if (ready && user && step !== 4) router.replace(homeFor(user.role));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useEffect(() => {
    setF((s) => ({ ...s, preferred_language: locale }));
  }, [locale]);

  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  const Next = dir === 'rtl' ? ArrowLeft : ArrowRight;

  /* ------------------------------------------------ validation per step */
  const errors = useMemo(() => {
    const e: Partial<Record<string, TKey>> = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email.trim())) e.email = 'reg.invalidEmail';
    if (f.password.length < 8 || !/[A-Za-z]/.test(f.password) || !/\d/.test(f.password)) e.password = 'err.weakPassword';
    if (f.password2 !== f.password) e.password2 = 'reg.passwordMismatch';
    if (!f.full_name.trim()) e.full_name = 'reg.nameRequired';
    const y = Number(f.dobYear);
    const m = Number(f.dobMonth);
    const d = Number(f.dobDay);
    if (!y || !m || !d) e.dob = 'reg.invalidDob';
    else {
      const date = new Date(y, m - 1, d);
      if (date.getMonth() !== m - 1) e.dob = 'reg.invalidDob';
      else if (ageFrom(y, m, d) < 18) e.dob = 'reg.adultsOnly';
    }
    if (!f.sex) e.sex = 'common.required';
    if (!f.diabetes_type) e.diabetes_type = 'common.required';
    if (f.sex === 'female' && f.pregnant === null) e.pregnant = 'common.required';
    if (f.pump === null) e.pump = 'common.required';
    if (!(f.terms && f.data && f.ai)) e.consent = 'reg.consentAll';
    return e;
  }, [f]);

  const stepFields: Record<number, string[]> = {
    0: ['email', 'password', 'password2'],
    1: ['full_name', 'dob', 'sex'],
    2: ['diabetes_type', 'pregnant', 'pump'],
    3: ['consent'],
  };
  const stepValid = (s: number) => (stepFields[s] ?? []).every((k) => !errors[k]);
  const err = (k: string): ReactNode => (showErrors && errors[k] ? t(errors[k]!) : undefined);

  function next(e: FormEvent) {
    e.preventDefault();
    if (!stepValid(step)) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    if (step < 3) setStep((step + 1) as Step);
    else void submit();
  }

  async function submit() {
    setPending(true);
    setError(null);
    const dob = `${f.dobYear}-${f.dobMonth.padStart(2, '0')}-${f.dobDay.padStart(2, '0')}`;
    const input: RegisterInput = {
      email: f.email.trim().toLowerCase(),
      password: f.password,
      full_name: f.full_name.trim(),
      full_name_ar: f.full_name_ar.trim() || undefined,
      date_of_birth: dob,
      sex: f.sex!,
      phone: f.phone.trim() || undefined,
      governorate: f.governorate || undefined,
      city: f.city.trim() || undefined,
      preferred_language: f.preferred_language,
      diabetes_type: f.diabetes_type!,
      pregnant: f.sex === 'female' ? !!f.pregnant : false,
      uses_insulin_pump: !!f.pump,
      consents: { terms: f.terms, data_processing: f.data, ai_processing: f.ai },
    };
    try {
      await register(input);
      setStep(4);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }

  const years = useMemo(() => {
    const max = new Date().getFullYear() - 18;
    return Array.from({ length: max - 1919 }, (_, i) => String(max - i));
  }, []);
  const monthName = (m: number) => new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', { month: 'long' }).format(new Date(2000, m - 1, 1));
  const generalOnly = f.diabetes_type === 'type1' || f.pregnant === true || f.pump === true;

  return (
    <div className="min-h-dvh">
      <header className="flex items-center justify-between px-4 py-4 sm:px-8">
        <Link href="/login" className="flex items-center gap-2">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-fg" aria-hidden>
            <HeartPulse className="size-5" />
          </span>
          <span className="text-lg font-bold">{t('app.name')}</span>
        </Link>
        <LocaleToggle />
      </header>

      <main className="mx-auto w-full max-w-lg px-4 pb-16">
        {family ? (
          <CaregiverSignup initialCode={family.code} onBack={() => setFamily(null)} />
        ) : step === 4 ? (
          <div className="fade-up py-10 text-center" aria-live="polite">
            <span className="mx-auto flex size-20 items-center justify-center rounded-3xl bg-ok-soft text-ok" aria-hidden>
              <PartyPopper className="size-10" />
            </span>
            <h1 className="mt-6 text-3xl font-bold">{t('reg.doneTitle', { name: (f.full_name_ar && locale === 'ar' ? f.full_name_ar : f.full_name).split(' ')[0] })}</h1>
            <p className="mt-3 text-lg leading-8 text-fg-muted">{t('reg.doneBody')}</p>
            <Button size="xl" className="mt-8 w-full" onClick={() => router.replace('/app/today')}>
              {t('reg.start')}
            </Button>
          </div>
        ) : (
          <>
            <h1 className="text-3xl font-bold tracking-tight">{t('reg.title')}</h1>
            <p className="mt-1 text-base text-fg-muted">{t('reg.subtitle')}</p>
            <button type="button" onClick={() => setFamily({})} className="mt-2 min-h-11 text-base font-semibold text-primary-strong underline-offset-4 hover:underline">
              {t('fam.haveCode')}
            </button>

            {/* progress */}
            <div className="mt-6" aria-label={t('common.step', { n: step + 1, total: STEPS.length })}>
              <div className="flex items-center justify-between text-sm font-medium">
                <span className="text-primary-strong">{t(STEPS[step])}</span>
                <span className="text-fg-muted">{t('common.step', { n: step + 1, total: STEPS.length })}</span>
              </div>
              <div className="mt-2 grid grid-cols-4 gap-1.5" aria-hidden>
                {STEPS.map((s, i) => (
                  <span key={s} className={cn('h-2 rounded-full', i <= step ? 'bg-primary' : 'bg-line')} />
                ))}
              </div>
            </div>

            <form onSubmit={next} noValidate className="mt-6 space-y-5">
              {step === 0 && (
                <>
                  <Field label={t('auth.email')} error={err('email')}>
                    <Input type="email" autoComplete="email" inputMode="email" dir="ltr" autoFocus value={f.email} onChange={(e) => set('email', e.target.value)} aria-invalid={!!err('email')} />
                  </Field>
                  <Field label={t('reg.password')} hint={t('reg.passwordHint')} error={err('password')}>
                    <div className="relative">
                      <Input
                        type={showPw ? 'text' : 'password'}
                        autoComplete="new-password"
                        dir="ltr"
                        value={f.password}
                        onChange={(e) => set('password', e.target.value)}
                        aria-invalid={!!err('password')}
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
                  <Field label={t('reg.passwordAgain')} error={err('password2')}>
                    <Input type={showPw ? 'text' : 'password'} autoComplete="new-password" dir="ltr" value={f.password2} onChange={(e) => set('password2', e.target.value)} aria-invalid={!!err('password2')} />
                  </Field>
                </>
              )}

              {step === 1 && (
                <>
                  <Field label={t('reg.fullName')} error={err('full_name')}>
                    <Input autoComplete="name" autoFocus value={f.full_name} onChange={(e) => set('full_name', e.target.value)} aria-invalid={!!err('full_name')} />
                  </Field>
                  <Field label={`${t('reg.fullNameAr')} (${t('common.optional')})`}>
                    <Input dir="rtl" lang="ar" value={f.full_name_ar} onChange={(e) => set('full_name_ar', e.target.value)} />
                  </Field>
                  <fieldset>
                    <legend className="mb-1.5 text-sm font-medium">{t('reg.dob')}</legend>
                    <div className="grid grid-cols-[1fr_1.6fr_1.3fr] gap-2">
                      <Select aria-label={t('common.date')} value={f.dobDay} onChange={(e) => set('dobDay', e.target.value)} aria-invalid={!!err('dob')}>
                        <option value="">—</option>
                        {Array.from({ length: 31 }, (_, i) => String(i + 1)).map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </Select>
                      <Select aria-label={t('reg.dob')} value={f.dobMonth} onChange={(e) => set('dobMonth', e.target.value)} aria-invalid={!!err('dob')}>
                        <option value="">—</option>
                        {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                          <option key={m} value={String(m)}>
                            {monthName(m)}
                          </option>
                        ))}
                      </Select>
                      <Select aria-label={t('reg.dob')} value={f.dobYear} onChange={(e) => set('dobYear', e.target.value)} aria-invalid={!!err('dob')}>
                        <option value="">—</option>
                        {years.map((y) => (
                          <option key={y} value={y}>
                            {y}
                          </option>
                        ))}
                      </Select>
                    </div>
                    {err('dob') && (
                      <p role="alert" className="mt-1.5 text-sm font-medium text-danger">
                        {err('dob')}
                      </p>
                    )}
                  </fieldset>
                  <fieldset>
                    <legend className="mb-1.5 text-sm font-medium">{t('reg.sex')}</legend>
                    <OptionButtons
                      columns={2}
                      name={t('reg.sex')}
                      value={f.sex}
                      onChange={(v) => set('sex', v)}
                      options={[
                        { value: 'female', label: t('common.female') },
                        { value: 'male', label: t('common.male') },
                      ]}
                    />
                    {err('sex') && <p className="mt-1.5 text-sm font-medium text-danger">{err('sex')}</p>}
                  </fieldset>
                  <Field label={`${t('reg.phone')} (${t('common.optional')})`}>
                    <Input type="tel" inputMode="tel" autoComplete="tel" dir="ltr" placeholder="+20 1xx xxx xxxx" value={f.phone} onChange={(e) => set('phone', e.target.value)} />
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={`${t('reg.governorate')} (${t('common.optional')})`}>
                      <Select value={f.governorate} onChange={(e) => set('governorate', e.target.value)}>
                        <option value="">—</option>
                        {GOVERNORATES.map((g) => (
                          <option key={g} value={g}>
                            {t(`gov.${g}` as TKey)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={`${t('reg.city')} (${t('common.optional')})`}>
                      <Input autoComplete="address-level2" value={f.city} onChange={(e) => set('city', e.target.value)} />
                    </Field>
                  </div>
                  <fieldset>
                    <legend className="mb-1.5 text-sm font-medium">{t('reg.language')}</legend>
                    <OptionButtons
                      columns={2}
                      name={t('reg.language')}
                      value={f.preferred_language}
                      onChange={(v) => set('preferred_language', v)}
                      options={[
                        { value: 'ar', label: 'العربية' },
                        { value: 'en', label: 'English' },
                      ]}
                    />
                  </fieldset>
                </>
              )}

              {step === 2 && (
                <>
                  <fieldset>
                    <legend className="mb-2 text-lg font-semibold">{t('reg.diabetesType')}</legend>
                    <OptionButtons
                      name={t('reg.diabetesType')}
                      value={f.diabetes_type}
                      onChange={(v) => set('diabetes_type', v)}
                      options={(['type2', 'type1', 'prediabetes', 'none'] as const).map((v) => ({ value: v, label: t(`dt.${v}`) }))}
                    />
                    {err('diabetes_type') && <p className="mt-1.5 text-sm font-medium text-danger">{err('diabetes_type')}</p>}
                  </fieldset>
                  {f.sex === 'female' && (
                    <YesNo label={t('reg.pregnant')} value={f.pregnant} onChange={(v) => set('pregnant', v)} error={err('pregnant')} />
                  )}
                  <YesNo label={t('reg.pump')} value={f.pump} onChange={(v) => set('pump', v)} error={err('pump')} />
                  {generalOnly && (
                    <p className="fade-up flex items-start gap-2 rounded-2xl bg-info-soft p-4 text-base leading-7 text-info-fg" role="status">
                      <Info className="mt-1 size-5 shrink-0" aria-hidden />
                      {t('reg.generalOnly')}
                    </p>
                  )}
                </>
              )}

              {step === 3 && (
                <>
                  <p className="text-base text-fg-muted">{t('reg.consentIntro')}</p>
                  <CheckRow checked={f.terms} onChange={(v) => set('terms', v)} title={t('reg.consentTerms')} body={t('reg.consentTermsBody')} />
                  <CheckRow checked={f.data} onChange={(v) => set('data', v)} title={t('reg.consentData')} body={t('reg.consentDataBody')} />
                  <CheckRow checked={f.ai} onChange={(v) => set('ai', v)} title={t('reg.consentAi')} body={t('reg.consentAiBody')} />
                  {err('consent') && (
                    <p role="alert" className="text-sm font-medium text-danger">
                      {err('consent')}
                    </p>
                  )}
                </>
              )}

              <InlineError error={error} />

              <div className="flex gap-3 pt-2">
                {step > 0 && (
                  <Button variant="outline" size="xl" onClick={() => setStep((step - 1) as Step)} icon={<Back className="size-5" />} aria-label={t('common.back')}>
                    <span className="hidden sm:inline">{t('common.back')}</span>
                  </Button>
                )}
                <Button type="submit" size="xl" className="flex-1" loading={pending}>
                  {step === 3 ? (pending ? t('reg.creating') : t('reg.create')) : t('common.next')}
                  {step < 3 && <Next className="size-5" aria-hidden />}
                  {step === 3 && !pending && <CheckCircle2 className="size-5" aria-hidden />}
                </Button>
              </div>
            </form>

            <p className="mt-8 text-center text-base text-fg-muted">
              {t('auth.haveAccount')}{' '}
              <Link href="/login" className="inline-flex min-h-11 items-center font-semibold text-primary-strong underline-offset-4 hover:underline">
                {t('auth.signIn')}
              </Link>
            </p>
          </>
        )}
      </main>
    </div>
  );
}

function YesNo({ label, value, onChange, error }: { label: string; value: boolean | null; onChange: (v: boolean) => void; error?: ReactNode }) {
  const { t } = useLocale();
  return (
    <fieldset>
      <legend className="mb-2 text-lg font-semibold">{label}</legend>
      <OptionButtons
        columns={2}
        name={label}
        value={value === null ? null : value ? 'yes' : 'no'}
        onChange={(v) => onChange(v === 'yes')}
        options={[
          { value: 'no', label: t('common.no') },
          { value: 'yes', label: t('common.yes') },
        ]}
      />
      {error && <p className="mt-1.5 text-sm font-medium text-danger">{error}</p>}
    </fieldset>
  );
}
