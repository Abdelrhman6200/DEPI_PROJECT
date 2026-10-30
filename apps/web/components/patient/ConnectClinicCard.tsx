'use client';

import { useState, type FormEvent } from 'react';
import { Building2, CheckCircle2, Clock, Hospital } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import { errorCode } from '@/lib/api';
import { Card } from '../Card';
import { Button } from '../Button';
import { Field, OptionButtons, Textarea } from '../Field';
import { InlineError } from '../EmptyState';
import { Skeleton } from '../Skeleton';
import { useToast } from '../Toast';
import { ManageHint } from './ManageHint';

/**
 * "Connect with a clinic" for unlinked patients: pick a clinic, send a join request, see its status.
 * Hidden entirely while the backend does not offer these actions yet.
 */
export function ConnectClinicCard({ compact = false }: { compact?: boolean }) {
  const { scope, canManageRecord } = useAuth();
  const { t, pick, te } = useLocale();
  const toast = useToast();
  const requests = useApi('care', 'link_requests', scope);
  const [choosing, setChoosing] = useState(false);
  const orgs = useApi('care', 'organizations', choosing ? {} : null);
  const { mutate, pending, error } = useMutation();
  const [orgId, setOrgId] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  if (requests.error && errorCode(requests.error) === 'unknown_action') return null;

  const list = requests.data ?? [];
  const pendingReq = list.find((r) => r.status === 'pending');
  const accepted = list.find((r) => r.status === 'accepted');
  const lastDeclined = !pendingReq ? list.find((r) => r.status === 'declined') : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!orgId) return;
    try {
      const req = await mutate('care', 'request_link', { ...scope, organization_id: orgId, message: message.trim() || undefined });
      requests.setData((xs) => [req, ...(xs ?? [])]);
      toast(t('link.sent'));
      setChoosing(false);
      setMessage('');
    } catch {
      /* inline */
    }
  }


  return (
    <Card id="connect" tone="primary" className="scroll-mt-24">
      <div className="flex items-start gap-3">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-fg" aria-hidden>
          <Hospital className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-fg">{t('link.title')}</h2>
          {!compact && !pendingReq && <p className="mt-1 text-base leading-7 text-fg-muted">{t('link.body')}</p>}
        </div>
      </div>

      {requests.loading && !requests.data ? (
        <Skeleton className="mt-4 h-12 w-full rounded-xl" />
      ) : pendingReq ? (
        <p className="mt-4 flex items-start gap-2 rounded-xl bg-surface px-4 py-3 text-base leading-7 text-fg" aria-live="polite">
          <Clock className="mt-1 size-5 shrink-0 text-warn" aria-hidden />
          {t('link.pending', { org: pendingReq.organization_name })}
        </p>
      ) : accepted ? (
        <p className="mt-4 flex items-start gap-2 rounded-xl bg-surface px-4 py-3 text-base text-fg">
          <CheckCircle2 className="mt-1 size-5 shrink-0 text-ok" aria-hidden />
          {te('lrs.', 'accepted')} · {accepted.organization_name}
        </p>
      ) : choosing ? (
        <form onSubmit={submit} className="mt-4 space-y-4">
          {lastDeclined && <p className="text-sm text-fg-muted">{t('link.declined', { org: lastDeclined.organization_name })}</p>}
          <fieldset>
            <legend className="mb-2 text-base font-semibold">{t('link.choose')}</legend>
            {orgs.loading && !orgs.data ? (
              <div className="space-y-2">
                <Skeleton className="h-14 w-full rounded-2xl" />
                <Skeleton className="h-14 w-full rounded-2xl" />
              </div>
            ) : orgs.data && orgs.data.length === 0 ? (
              <p className="text-sm text-fg-muted">{t('link.noOrgs')}</p>
            ) : (
              <OptionButtons
                value={orgId}
                onChange={setOrgId}
                name={t('link.choose')}
                options={(orgs.data ?? []).map((o) => ({
                  value: o.id,
                  label: pick(o.name, o.name_ar),
                  hint: [te('ftype.', o.type), o.city].filter(Boolean).join(' · '),
                  icon: <Building2 className="size-5" />,
                }))}
              />
            )}
            <InlineError error={orgs.error} />
          </fieldset>
          <Field label={`${t('link.message')} (${t('common.optional')})`}>
            <Textarea className="min-h-20" placeholder={t('link.messagePh')} value={message} onChange={(e) => setMessage(e.target.value)} />
          </Field>
          <InlineError error={error} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="lg" loading={pending} disabled={!orgId}>
              {t('link.send')}
            </Button>
            <Button variant="ghost" size="lg" onClick={() => setChoosing(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      ) : !canManageRecord ? (
        // asking a clinic to take over care is the patient's decision (or a family member they allowed)
        <ManageHint className="mt-4" />
      ) : (
        <div className="mt-4">
          {lastDeclined && <p className="mb-3 text-sm text-fg-muted">{t('link.declined', { org: lastDeclined.organization_name })}</p>}
          <Button size="lg" className="w-full sm:w-auto" onClick={() => setChoosing(true)} icon={<Building2 className="size-5" />}>
            {t('link.choose')}
          </Button>
        </div>
      )}
    </Card>
  );
}
