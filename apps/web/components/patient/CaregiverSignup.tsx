'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, UsersRound } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import type { TKey } from '@/lib/i18n';
import { Button } from '../Button';
import { CheckRow, Field, Input } from '../Field';
import { InlineError } from '../EmptyState';

/** Sign-up for a family member, with the code the patient created in "Family members". */
export function CaregiverSignup({ initialCode, onBack }: { initialCode?: string; onBack: () => void }) {
  const { t, locale } = useLocale();
  const { register } = useAuth();
  const router = useRouter();
  const [code, setCode] = useState(initialCode ?? '');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [relationship, setRelationship] = useState('');
  const [terms, setTerms] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [local, setLocal] = useState<TKey | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) return setLocal('err.weakPassword');
    if (!terms) return setLocal('fam.termsRequired');
    setLocal(null);
    setPending(true);
    try {
      await register({
        account_type: 'caregiver',
        email: email.trim(),
        password,
        full_name: name.trim(),
        preferred_language: locale,
        invite_code: code.trim(),
        relationship: relationship.trim() || undefined,
        consents: { terms: true },
      });
      router.replace('/app/today');
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
        <UsersRound className="size-7 text-primary" aria-hidden />
        {t('fam.signupTitle')}
      </h1>
      <p className="text-base leading-7 text-fg-muted">{t('fam.signupIntro')}</p>
      <Field label={t('fam.code')} hint={t('fam.codeHint')}>
        <Input required dir="ltr" autoCapitalize="characters" className="font-mono tracking-widest uppercase" value={code} onChange={(e) => setCode(e.target.value)} maxLength={12} />
      </Field>
      <Field label={t('reg.fullName')}>
        <Input required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={`${t('fam.relationship')} (${t('common.optional')})`} hint={t('fam.relationshipHint')}>
        <Input value={relationship} onChange={(e) => setRelationship(e.target.value)} maxLength={60} />
      </Field>
      <Field label={t('auth.email')}>
        <Input required type="email" autoComplete="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label={t('reg.password')} hint={t('reg.passwordHint')}>
        <div className="relative">
          <Input required type={showPw ? 'text' : 'password'} autoComplete="new-password" dir="ltr" className="pe-12" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button type="button" onClick={() => setShowPw((x) => !x)} className="absolute end-1 top-1/2 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-lg text-fg-muted" aria-label={t(showPw ? 'auth.hidePassword' : 'auth.showPassword')}>
            {showPw ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
          </button>
        </div>
      </Field>
      <CheckRow checked={terms} onChange={setTerms} title={t('fam.terms')} />
      <InlineError error={error} message={local ? t(local) : null} />
      <Button type="submit" size="xl" className="w-full" loading={pending}>
        {t('fam.signupButton')}
      </Button>
      <button type="button" onClick={onBack} className="min-h-11 w-full text-center text-base font-semibold text-primary-strong hover:underline">
        {t('fam.patientSignup')}
      </button>
    </form>
  );
}
