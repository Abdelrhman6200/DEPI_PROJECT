'use client';

import { useState, type FormEvent } from 'react';
import { Link2, Link2Off, RadioTower } from 'lucide-react';
import type { NightscoutStatus } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import { Card, CardHeader } from '../Card';
import { Badge, type BadgeTone } from '../Badge';
import { Button } from '../Button';
import { Field, Input } from '../Field';
import { ErrorState, InlineError } from '../EmptyState';
import { SkeletonCard } from '../Skeleton';
import { ConfirmDialog } from '../ConfirmDialog';
import { ManageHint } from './ManageHint';

const STATUS_TONE: Record<NightscoutStatus['status'], BadgeTone> = {
  DISCONNECTED: 'neutral',
  VALIDATING: 'info',
  ACTIVE: 'ok',
  DEGRADED: 'warn',
  STALE: 'warn',
  REVOKED: 'danger',
};

export function NightscoutCard({ onChanged }: { onChanged?: () => void }) {
  const { scope, canManageRecord } = useAuth();
  const { t, te, fmt } = useLocale();
  const q = useApi('glucose', 'nightscout_status', scope);
  const { mutate, pending, error } = useMutation();
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function connect(e: FormEvent) {
    e.preventDefault();
    try {
      const s = await mutate('glucose', 'nightscout_connect', { ...scope, url: url.trim(), token: token.trim() || undefined });
      q.setData(s);
      setToken('');
      onChanged?.();
    } catch {
      /* inline */
    }
  }
  async function disconnect() {
    try {
      const s = await mutate('glucose', 'nightscout_disconnect', scope);
      q.setData(s);
      onChanged?.();
    } catch {
      /* inline */
    }
  }

  if (q.loading && !q.data) return <SkeletonCard />;
  if (q.error && !q.data) return <ErrorState compact error={q.error} onRetry={() => void q.reload()} />;
  const s = q.data;
  if (!s) return null;

  if (!s.connected && (!expanded || !canManageRecord)) {
    return (
      <Card className="flex flex-wrap items-center gap-3">
        <RadioTower className="size-5 shrink-0 text-fg-muted" aria-hidden />
        <p className="min-w-0 flex-1 text-base text-fg">{t('ns.short')}</p>
        {canManageRecord ? (
          <Button variant="outline" size="md" onClick={() => setExpanded(true)}>
            {t('ns.connect')}
          </Button>
        ) : (
          <ManageHint className="w-full" />
        )}
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title={t('ns.title')}
        subtitle={t('ns.desc')}
        icon={<RadioTower className="size-5" />}
        action={<Badge tone={STATUS_TONE[s.status]}>{te('nss.', s.status)}</Badge>}
      />
      {s.connected ? (
        <div className="space-y-2">
          <div className="truncate rounded-lg bg-surface-2 px-3 py-2 text-sm" dir="ltr">
            {s.url}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
            <span>{t('ns.lastSync', { t: fmt.relative(s.last_sync_at) })}</span>
            <span>{t('ns.lastReading', { t: fmt.relative(s.last_reading_at) })}</span>
          </div>
          <InlineError error={error} />
          {canManageRecord ? (
            <Button variant="outline" size="sm" icon={<Link2Off className="size-4" />} loading={pending} onClick={() => setConfirming(true)}>
              {t('ns.disconnect')}
            </Button>
          ) : (
            <ManageHint />
          )}
          <ConfirmDialog
            open={confirming}
            onClose={() => setConfirming(false)}
            title={t('ns.disconnectTitle')}
            body={t('ns.disconnectBody')}
            confirmLabel={t('ns.disconnect')}
            onConfirm={disconnect}
          />
        </div>
      ) : (
        <form onSubmit={connect} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label={t('ns.url')} hint={t('ns.urlHint')}>
            <Input type="url" required dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Field label={`${t('ns.token')} (${t('common.optional')})`}>
            <Input dir="ltr" value={token} onChange={(e) => setToken(e.target.value)} />
          </Field>
          <Button type="submit" loading={pending} icon={<Link2 className="size-4" />}>
            {t('ns.connect')}
          </Button>
          <div className="sm:col-span-3">
            <InlineError error={error} />
          </div>
        </form>
      )}
    </Card>
  );
}
