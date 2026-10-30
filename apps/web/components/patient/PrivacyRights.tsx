'use client';

import { useState } from 'react';
import { Eye, Scale } from 'lucide-react';
import type { DataRequestType } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import { Card } from '../Card';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { Field, OptionButtons, Textarea } from '../Field';
import { ErrorState } from '../EmptyState';
import { SkeletonCard } from '../Skeleton';
import { useErrorToast, useToast } from '../Toast';

const TYPES: DataRequestType[] = ['correction', 'erasure', 'objection', 'restriction', 'question'];

/**
 * The patient's rights over their personal data (Egypt's Personal Data Protection Law): ask to correct, erase, object
 * to or restrict processing, or ask a question; see the answers; and see who opened or changed the record.
 */
export function PrivacyRights() {
  const { t, fmt, te, pick } = useLocale();
  const toast = useToast();
  const errorToast = useErrorToast();
  const reqs = useApi('profile', 'data_requests', {});
  const { mutate, pending } = useMutation();
  const [type, setType] = useState<DataRequestType>('correction');
  const [details, setDetails] = useState('');
  const [showLog, setShowLog] = useState(false);
  const log = useApi('profile', 'access_log', showLog ? { limit: 50 } : null);

  async function send() {
    try {
      await mutate('profile', 'data_request', { type, details: details.trim() || undefined });
      setDetails('');
      toast(t('rights.sent'));
      void reqs.reload(true);
    } catch (e) {
      errorToast(e);
    }
  }

  const canSend = type === 'erasure' || details.trim().length >= 5;
  return (
    <Card aria-labelledby="rights-title">
      <h2 id="rights-title" className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <Scale className="size-5 text-primary" aria-hidden />
        {t('rights.title')}
      </h2>
      <p className="mb-4 text-base leading-7 text-fg-muted">{t('rights.body')}</p>

      <div className="space-y-3 rounded-2xl border border-line p-4">
        <OptionButtons<DataRequestType> value={type} onChange={setType} options={TYPES.map((x) => ({ value: x, label: te('rights.type.', x) }))} />
        <p className="text-sm text-fg-muted">{te('rights.typeHint.', type)}</p>
        <Field label={t('rights.details')}>
          <Textarea rows={3} value={details} maxLength={2000} onChange={(e) => setDetails(e.target.value)} />
        </Field>
        <Button onClick={() => void send()} disabled={!canSend} loading={pending}>
          {t('rights.send')}
        </Button>
      </div>

      {reqs.error && !reqs.data ? (
        <ErrorState compact error={reqs.error} onRetry={() => void reqs.reload()} />
      ) : reqs.loading && !reqs.data ? (
        <SkeletonCard lines={2} />
      ) : reqs.data && reqs.data.length > 0 ? (
        <ul className="mt-4 divide-y divide-line rounded-2xl border border-line">
          {reqs.data.map((r) => (
            <li key={r.id} className="space-y-1 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{te('rights.type.', r.type)}</span>
                <Badge tone={r.status === 'completed' ? 'ok' : r.status === 'rejected' ? 'danger' : 'info'}>{te('rights.status.', r.status)}</Badge>
                <span className="text-sm text-fg-muted">{fmt.date(r.created_at)}</span>
              </div>
              {r.details && <p className="text-sm text-fg-muted"><bdi>{r.details}</bdi></p>}
              {r.resolution ? (
                <p className="rounded-xl bg-surface-2 px-3 py-2 text-base"><bdi>{r.resolution}</bdi></p>
              ) : (
                <p className="text-sm text-fg-muted">{t('rights.dueBy', { d: fmt.date(r.due_at) })}</p>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-5">
        <Button variant="ghost" icon={<Eye className="size-4" />} aria-expanded={showLog} onClick={() => setShowLog((x) => !x)}>
          {t(showLog ? 'rights.hideLog' : 'rights.showLog')}
        </Button>
        {showLog &&
          (log.loading && !log.data ? (
            <SkeletonCard lines={3} />
          ) : log.data && log.data.length ? (
            <ul className="mt-2 max-h-80 divide-y divide-line overflow-y-auto rounded-2xl border border-line text-sm">
              {log.data.map((l, i) => (
                <li key={`${l.at}-${i}`} className="flex flex-wrap items-baseline gap-x-2 px-4 py-2">
                  <span className="num text-fg-muted">{fmt.dateTime(l.at)}</span>
                  <span className="font-semibold">{te('rights.actor.', l.actor)}</span>
                  {l.organization && <bdi className="text-fg-muted">{pick(l.organization, l.organization_ar)}</bdi>}
                  <code className="text-xs text-fg-subtle" dir="ltr">{l.action}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-fg-muted">{t('rights.logEmpty')}</p>
          ))}
      </div>
    </Card>
  );
}
