'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { CheckCircle2, KeyRound } from 'lucide-react';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/locale';
import type { TKey } from '@/lib/i18n';
import { Button, ButtonLink } from '@/components/Button';
import { Field, Input } from '@/components/Field';
import { InlineError } from '@/components/EmptyState';
import { LocaleToggle } from '@/components/LocaleToggle';

/** Opened from the link in the reset email: choose a new password. */
export default function ResetPasswordPage() {
  const { t } = useLocale();
  const [token, setToken] = useState<string | null>(null);
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [local, setLocal] = useState<TKey | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setToken(params.get('token'));
    // keep the one-time token out of the address bar, history and anything the page later shares (Referer)
    if (params.has('token')) {
      params.delete('token');
      const rest = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
    }
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < 8 || !/[A-Za-z]/.test(next) || !/\d/.test(next)) return setLocal('err.weakPassword');
    if (next !== next2) return setLocal('reg.passwordMismatch');
    setLocal(null);
    setPending(true);
    try {
      await api.call('auth', 'reset_with_token', { token: token ?? '', new_password: next });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="min-h-dvh">
      <header className="flex justify-end px-4 py-4 sm:px-8">
        <LocaleToggle />
      </header>
      <main className="mx-auto w-full max-w-md px-4 pb-16">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <KeyRound className="size-7 text-primary" aria-hidden />
          {t('pwreset.title')}
        </h1>
        {done ? (
          <div className="mt-6 space-y-4" role="status">
            <p className="flex items-start gap-2 text-lg leading-8">
              <CheckCircle2 className="mt-1 size-6 shrink-0 text-ok" aria-hidden />
              {t('forgot.done')}
            </p>
            <ButtonLink href="/login" size="xl" className="w-full">
              {t('auth.signIn')}
            </ButtonLink>
          </div>
        ) : token === null ? null : !token ? (
          <p className="mt-6 text-lg leading-8">
            {t('err.resetLink')}{' '}
            <Link href="/forgot-password" className="font-semibold text-primary-strong underline">
              {t('forgot.again')}
            </Link>
          </p>
        ) : (
          <form onSubmit={submit} className="mt-6 space-y-4">
            <Field label={t('acc.newPassword')} hint={t('reg.passwordHint')}>
              <Input type="password" autoComplete="new-password" dir="ltr" required value={next} onChange={(e) => setNext(e.target.value)} />
            </Field>
            <Field label={t('reg.passwordAgain')}>
              <Input type="password" autoComplete="new-password" dir="ltr" required value={next2} onChange={(e) => setNext2(e.target.value)} />
            </Field>
            <InlineError error={error} message={local ? t(local) : null} />
            <Button type="submit" size="xl" className="w-full" loading={pending}>
              {t('pwreset.save')}
            </Button>
            <Link href="/forgot-password" className="block min-h-11 text-center text-base font-semibold text-primary-strong hover:underline">
              {t('forgot.again')}
            </Link>
          </form>
        )}
      </main>
    </div>
  );
}
