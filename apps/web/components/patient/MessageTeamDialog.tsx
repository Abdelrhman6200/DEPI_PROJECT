'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, HeartPulse, Info, Send } from 'lucide-react';
import type { UUID } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { usePatientShell } from './PatientShellContext';
import { SameDayCard } from './SameDayCard';
import { useMutation } from '@/lib/useApi';
import { Dialog } from '../Dialog';
import { Button } from '../Button';
import { Textarea } from '../Field';
import { InlineError } from '../EmptyState';

/** "Message my care team" (care.message_team). Tells the person whether the message reached a clinician. */
export function MessageTeamDialog({
  open,
  onClose,
  patientId,
  patientName,
  prefill,
}: {
  open: boolean;
  onClose: () => void;
  patientId?: UUID;
  /** Shown in the title when a family member writes about someone else. */
  patientName?: string | null;
  prefill?: string;
}) {
  const { t, pick } = useLocale();
  const { openEmergency } = usePatientShell();
  const { mutate, pending, error, clearError } = useMutation();
  const [text, setText] = useState('');
  // `emergency` holds the fixed guidance when the message contains emergency warning signs.
  const [result, setResult] = useState<{ routed: boolean; emergency: string | null; urgent: string | null } | null>(null);

  useEffect(() => {
    if (open) {
      setText(prefill ?? '');
      setResult(null);
      clearError();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const msg = text.trim();
    if (!msg) return;
    try {
      const res = await mutate('care', 'message_team', { ...(patientId ? { patient_id: patientId } : {}), text: msg });
      setResult({
        routed: !!res.routed,
        emergency: res.emergency ? pick(res.emergency.message_en, res.emergency.message_ar) : null,
        // a same-day problem (e.g. an infected foot wound): a doctor today, not an emergency
        urgent: !res.emergency && res.urgent ? pick(res.urgent.message_en, res.urgent.message_ar) : null,
      });
    } catch {
      /* shown inline */
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={patientName ? t('msg.titleFor', { name: patientName }) : t('msg.title')}
      footer={
        result ? (
          <Button size="lg" onClick={onClose}>
            {t('common.done')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="lg" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form="msg-team" size="lg" loading={pending} disabled={!text.trim()} icon={<Send className="size-5 rtl:-scale-x-100" />}>
              {t('msg.send')}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div aria-live="polite" className="space-y-3">
          {result.emergency && (
            <div role="alert" className="space-y-3 rounded-2xl border-2 border-danger/60 bg-danger-soft p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-1 size-6 shrink-0 text-danger" aria-hidden />
                <p className="text-lg leading-8 font-medium text-fg">{result.emergency}</p>
              </div>
              <Button
                variant="danger"
                size="lg"
                className="w-full"
                icon={<HeartPulse className="size-5" />}
                onClick={() => {
                  onClose();
                  openEmergency();
                }}
              >
                {t('ca.showSafety')}
              </Button>
              <p className="text-base leading-7 text-fg">{t('msg.emergencyNote')}</p>
            </div>
          )}
          {result.urgent && <SameDayCard message={result.urgent} onNavigate={onClose} />}
          {result.routed ? (
            <div className="flex items-start gap-3 rounded-2xl bg-ok-soft p-4 text-ok-fg">
              <CheckCircle2 className="mt-0.5 size-6 shrink-0" aria-hidden />
              <p className="text-base leading-7 font-medium">{t('msg.routed')}</p>
            </div>
          ) : (
            <div className="space-y-3 rounded-2xl bg-warn-soft p-4 text-warn-fg">
              <div className="flex items-start gap-3">
                <Info className="mt-0.5 size-6 shrink-0" aria-hidden />
                <p className="text-base leading-7 font-medium">{t('msg.notRouted')}</p>
              </div>
              <Link href="/app/care#connect" onClick={onClose} className="inline-flex min-h-11 items-center font-semibold text-primary-strong underline underline-offset-4">
                {t('link.title')}
              </Link>
            </div>
          )}
        </div>
      ) : (
        <form id="msg-team" onSubmit={submit} className="space-y-3">
          <p className="text-sm leading-6 text-fg-muted">{t('msg.hint')}</p>
          <label className="block">
            <span className="sr-only">{t('msg.title')}</span>
            <Textarea autoFocus className="min-h-36" placeholder={t('msg.placeholder')} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} />
          </label>
          <InlineError error={error} />
        </form>
      )}
    </Dialog>
  );
}
