'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, KeyRound, MailCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/locale';
import { Button } from '@/components/Button';
import { Field, Input } from '@/components/Field';
import { InlineError } from '@/components/EmptyState';
import { LocaleToggle } from '@/components/LocaleToggle';

/** Ask for a reset link by email. The answer is the same whether or not the address has an account. */
export default function ForgotPasswordPage() {
  const { t, dir } = useLocale();
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{ email_enabled: boolean } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const r = await api.call('auth', 'forgot_password', { email: email.trim() });
      setResult({ email_enabled: r.email_enabled });
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="min-h-dvh">
      <header className="flex items-center justify-between px-4 py-4 sm:px-8">
        <Link href="/login" className="inline-flex min-h-11 items-center gap-1 text-base font-medium text-fg-muted hover:text-fg">
          <Back className="size-5" aria-hidden />
          {t('auth.signIn')}
        </Link>
        <LocaleToggle />
      </header>
      <main className="mx-auto w-full max-w-md px-4 pb-16">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <KeyRound className="size-7 text-primary" aria-hidden />
          {t('forgot.title')}
        </h1>
        {result ? (
          <div className="mt-6 space-y-3 rounded-2xl bg-surface p-5" role="status">
            <MailCheck className="size-8 text-primary" aria-hidden />
            <p className="text-lg leading-8">{t(result.email_enabled ? 'forgot.sent' : 'forgot.noEmail')}</p>
            <Link href="/login" className="inline-flex min-h-11 items-center font-semibold text-primary-strong underline-offset-4 hover:underline">
              {t('auth.signIn')}
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-6 space-y-4">
            <p className="text-base leading-7 text-fg-muted">{t('forgot.intro')}</p>
            <Field label={t('auth.email')}>
              <Input required type="email" autoComplete="email" inputMode="email" dir="ltr" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <InlineError error={error} />
            <Button type="submit" size="xl" className="w-full" loading={pending}>
              {t('forgot.send')}
            </Button>
          </form>
        )}
      </main>
    </div>
  );
}
