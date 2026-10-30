'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound, LogOut } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useMutation } from '@/lib/useApi';
import type { TKey } from '@/lib/i18n';
import { Card } from './Card';
import { Button } from './Button';
import { Field, Input } from './Field';
import { InlineError } from './EmptyState';

/**
 * After an administrator issued a temporary password, the person must choose their own before using the app.
 * (The API refuses everything else until then; this screen makes that clear instead of showing errors.)
 */
export function PasswordChangeGate({ children }: { children: ReactNode }) {
  const { user, refreshUser, logout } = useAuth();
  const { t } = useLocale();
  const { mutate, pending, error, clearError } = useMutation();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [local, setLocal] = useState<TKey | null>(null);
  if (!user?.must_change_password) return <>{children}</>;

  async function submit(e: FormEvent) {
    e.preventDefault();
    clearError();
    if (next.length < 8 || !/[A-Za-z]/.test(next) || !/\d/.test(next)) return setLocal('err.weakPassword');
    if (next !== next2) return setLocal('reg.passwordMismatch');
    setLocal(null);
    try {
      await mutate('auth', 'change_password', { current_password: cur, new_password: next });
      await refreshUser();
    } catch {
      /* inline */
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg p-4">
      <Card className="w-full max-w-md">
        <h1 className="mb-1 flex items-center gap-2 text-xl font-bold">
          <KeyRound className="size-6 text-primary" aria-hidden />
          {t('pwreset.title')}
        </h1>
        <p className="mb-4 text-base leading-7 text-fg-muted">{t('pwreset.body')}</p>
        <form onSubmit={submit} className="space-y-4">
          <Field label={t('pwreset.temporary')}>
            <Input type="password" autoComplete="current-password" dir="ltr" required value={cur} onChange={(e) => setCur(e.target.value)} />
          </Field>
          <Field label={t('acc.newPassword')} hint={t('reg.passwordHint')}>
            <Input type="password" autoComplete="new-password" dir="ltr" required value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label={t('reg.passwordAgain')}>
            <Input type="password" autoComplete="new-password" dir="ltr" required value={next2} onChange={(e) => setNext2(e.target.value)} />
          </Field>
          <InlineError error={error} message={local ? t(local) : null} />
          <Button type="submit" size="lg" className="w-full" loading={pending}>
            {t('pwreset.save')}
          </Button>
        </form>
        <Button variant="ghost" className="mt-3 w-full" icon={<LogOut className="size-4 rtl:-scale-x-100" />} onClick={() => void logout().then(() => window.location.replace('/login'))}>
          {t('common.logout')}
        </Button>
      </Card>
    </div>
  );
}
