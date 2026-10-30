'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Search, ShieldAlert, UserRound } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useMutation } from '@/lib/useApi';
import { BREAK_GLASS_ROLES, hasRole } from '@/lib/roles';
import { cn } from '@/lib/cn';
import { Card, PageHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Field, Input, Textarea } from '@/components/Field';
import { EmptyState, InlineError } from '@/components/EmptyState';

type Match = { id: string; full_name: string; mrn: string; age: number };

/** The service asks for a real description of the emergency (the same minimum is checked there). */
const REASON_MIN = 20;

/** Break-glass: find any patient by MRN / exact name, give a reason, open the record for 4 audited hours. */
export default function EmergencyAccessPage() {
  const { user } = useAuth();
  const { t } = useLocale();
  const router = useRouter();
  const find = useMutation();
  const grant = useMutation();
  const [q, setQ] = useState('');
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [chosen, setChosen] = useState<Match | null>(null);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [showErr, setShowErr] = useState(false);

  if (!hasRole(user?.role, BREAK_GLASS_ROLES)) return <EmptyState title={t('err.forbidden')} />;

  async function search(e: FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setChosen(null);
    try {
      setMatches(await find.mutate('provider', 'find_patient', { q: q.trim() }));
    } catch {
      setMatches(null);
    }
  }

  async function open(e: FormEvent) {
    e.preventDefault();
    if (!chosen) return;
    if (reason.trim().length < REASON_MIN || !confirm) {
      setShowErr(true);
      return;
    }
    try {
      const res = await grant.mutate('provider', 'break_glass', { patient_id: chosen.id, reason: reason.trim() });
      router.push(`/provider/patients/${chosen.id}?bg=${encodeURIComponent(res.expires_at)}`);
    } catch {
      /* inline */
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={t('bg.title')} subtitle={t('bg.subtitle')} />

      <div role="note" className="mb-5 flex items-start gap-3 rounded-2xl border-2 border-danger/50 bg-danger-soft p-4">
        <ShieldAlert className="mt-0.5 size-6 shrink-0 text-danger" aria-hidden />
        <div>
          <p className="font-bold text-danger-fg">{t('bg.warnTitle')}</p>
          <p className="mt-1 text-sm leading-6 text-fg">{t('bg.warnBody')}</p>
        </div>
      </div>

      <Card>
        <form onSubmit={search} className="flex flex-wrap items-end gap-2">
          <Field label={t('bg.search')} className="min-w-0 flex-1">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="MRN-1003" autoComplete="off" />
          </Field>
          <Button type="submit" icon={<Search className="size-4" />} loading={find.pending} disabled={!q.trim()}>
            {t('bg.find')}
          </Button>
        </form>
        <div className="mt-3">
          <InlineError error={find.error} />
        </div>
        {matches && matches.length === 0 && <p className="mt-3 text-sm text-fg-muted">{t('bg.noMatch')}</p>}
        {matches && matches.length > 0 && (
          <ul className="mt-3 space-y-2" role="listbox" aria-label={t('bg.search')}>
            {matches.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={chosen?.id === m.id}
                  onClick={() => setChosen(m)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-xl border-2 px-3 py-2.5 text-start',
                    chosen?.id === m.id ? 'border-danger bg-danger-soft' : 'border-line hover:border-line-strong',
                  )}
                >
                  <UserRound className="size-5 text-fg-muted" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{m.full_name}</span>
                    <span className="block text-xs text-fg-muted">
                      <span className="num">{m.mrn}</span> · {t('common.years', { n: m.age })}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {chosen && (
        <Card className="mt-4 border-danger/40">
          <form onSubmit={open} className="space-y-4">
            <p className="text-sm">
              {t('common.patient')}: <span className="font-semibold">{chosen.full_name}</span> · <span className="num">{chosen.mrn}</span>
            </p>
            <Field
              label={t('bg.reason')}
              hint={t('bg.reasonCount', { n: reason.trim().length, min: REASON_MIN })}
              error={showErr && reason.trim().length < REASON_MIN ? t('bg.reasonMin') : undefined}
            >
              <Textarea required placeholder={t('bg.reasonPh')} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={showErr && reason.trim().length < REASON_MIN} />
            </Field>
            <label className={cn('flex items-start gap-2 rounded-xl border p-3 text-sm', showErr && !confirm ? 'border-danger' : 'border-line')}>
              <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-0.5 size-4 accent-[var(--danger-solid)]" />
              {t('bg.confirm')}
            </label>
            <InlineError error={grant.error} />
            <Button type="submit" variant="danger" size="lg" icon={<ShieldAlert className="size-5" />} loading={grant.pending} className="w-full">
              {t('bg.open')}
            </Button>
          </form>
        </Card>
      )}
    </div>
  );
}
