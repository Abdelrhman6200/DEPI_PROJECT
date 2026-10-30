'use client';

import { useState } from 'react';
import { Bot, CheckCircle2, CircleSlash, Server } from 'lucide-react';
import type { ConsentState } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import { cn } from '@/lib/cn';
import type { TKey } from '@/lib/i18n';
import { Card } from '../Card';
import { ConfirmDialog } from '../ConfirmDialog';
import { ErrorState } from '../EmptyState';
import { SkeletonCard } from '../Skeleton';
import { useErrorToast, useToast } from '../Toast';

type ConsentRow = ConsentState['consents'][number];

const LABEL: Record<ConsentRow['type'], TKey> = {
  terms: 'consent.terms',
  data_processing: 'consent.data',
  ai_processing: 'consent.ai',
};

/**
 * Privacy choices (patients only). AI help can be switched on and off here; the terms of use and the processing of
 * health data are needed to use the service and are shown read-only with the date they were agreed.
 */
export function ConsentSettings() {
  const { t, fmt } = useLocale();
  const toast = useToast();
  const errorToast = useErrorToast();
  const q = useApi('profile', 'consents', {});
  const { mutate, pending } = useMutation();
  const [confirmOff, setConfirmOff] = useState(false);

  async function setAi(granted: boolean) {
    try {
      q.setData(await mutate('profile', 'set_consent', { type: 'ai_processing', granted }));
      toast(t(granted ? 'consent.aiOnDone' : 'consent.aiOffDone'));
    } catch (e) {
      errorToast(e);
    }
  }

  if (q.loading && !q.data) return <SkeletonCard lines={4} />;
  if (q.error && !q.data) return <ErrorState compact error={q.error} onRetry={() => void q.reload()} />;
  const c = q.data;
  if (!c) return null;
  const ai = c.consents.find((x) => x.type === 'ai_processing');
  const aiOn = c.ai_state === 'granted';
  const fixed = c.consents.filter((x) => x.type !== 'ai_processing');

  return (
    <Card aria-labelledby="ai-consent-title">
      <h2 id="ai-consent-title" className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <Bot className="size-5 text-primary" aria-hidden />
        {t('consent.aiTitle')}
      </h2>
      <p className="mb-4 text-base leading-7 text-fg-muted">{t('consent.aiBody')}</p>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line p-4">
        <div className="min-w-0 flex-1">
          <p id="ai-switch-label" className="text-base font-semibold">
            {t('consent.ai')}
          </p>
          <p className="text-sm text-fg-muted">
            {c.ai_state === 'granted'
              ? t('consent.onSince', { d: ai?.at ? fmt.date(ai.at) : '—' })
              : c.ai_state === 'withdrawn'
                ? t('consent.offSince', { d: ai?.at ? fmt.date(ai.at) : '—' })
                : t('consent.notAnswered')}
          </p>
        </div>
        {(ai?.changeable ?? true) && (
          <button
            type="button"
            role="switch"
            aria-checked={aiOn}
            aria-labelledby="ai-switch-label"
            disabled={pending}
            onClick={() => (aiOn ? setConfirmOff(true) : void setAi(true))}
            className={cn(
              'relative inline-flex h-8 w-14 shrink-0 items-center rounded-full border-2 transition-colors disabled:opacity-60',
              aiOn ? 'border-primary bg-primary' : 'border-line-strong bg-surface-2',
            )}
          >
            <span className="sr-only">{aiOn ? t('consent.on') : t('consent.off')}</span>
            <span
              aria-hidden
              className={cn(
                'absolute top-0.5 size-6 rounded-full bg-white shadow transition-[inset-inline-start]',
                aiOn ? 'start-[calc(100%-1.625rem)]' : 'start-0.5',
              )}
            />
          </button>
        )}
      </div>

      {!c.cloud_ai_enabled && (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-info-soft px-3 py-2 text-sm leading-6 text-info-fg">
          <Server className="mt-1 size-4 shrink-0" aria-hidden />
          {t('consent.localOnly')}
        </p>
      )}

      <h3 className="mt-5 mb-2 text-sm font-semibold text-fg-muted">{t('consent.required')}</h3>
      <ul className="divide-y divide-line rounded-2xl border border-line">
        {fixed.map((x) => (
          <li key={x.type} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <span className="text-base">{t(LABEL[x.type])}</span>
            <span className="inline-flex items-center gap-1.5 text-sm text-fg-muted">
              {x.granted ? <CheckCircle2 className="size-4 text-ok" aria-hidden /> : <CircleSlash className="size-4" aria-hidden />}
              {x.granted ? t('consent.agreedOn', { d: x.at ? fmt.date(x.at) : '—' }) : t('consent.notAnswered')}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-sm leading-6 text-fg-muted">{t('consent.requiredHint')}</p>

      <ConfirmDialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        title={t('consent.offTitle')}
        body={t('consent.offBody')}
        confirmLabel={t('consent.offConfirm')}
        onConfirm={() => setAi(false)}
      />
    </Card>
  );
}
