'use client';

import { useState } from 'react';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import type { AdminDataRequest, Breach } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import { Card, CardHeader } from '../Card';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { Field, Select, Textarea } from '../Field';
import { Async } from '../Async';
import { EmptyState } from '../EmptyState';
import { SkeletonList } from '../Skeleton';
import { useErrorToast, useToast } from '../Toast';

/**
 * Personal data (Egypt's Personal Data Protection Law): the patients' requests (correct, erase, object, restrict, ask)
 * with their answer deadline, and personal-data breaches with the 72-hour deadline to tell the Personal Data Protection
 * Centre. The register of processing and the breach procedure are in docs/privacy/egypt-pdpl.md.
 */
export function PrivacyTab() {
  const { user } = useAuth();
  return (
    <div className="space-y-4">
      {user?.role === 'platform_admin' && <DataRequests />}
      <Breaches />
    </div>
  );
}

function DataRequests() {
  const { t, te, fmt } = useLocale();
  const q = useApi('admin', 'data_requests', {});
  const [answering, setAnswering] = useState<AdminDataRequest | null>(null);
  return (
    <Card>
      <CardHeader title={t('priv.requests')} subtitle={t('priv.requestsHint')} />
      <Async state={q} skeleton={<SkeletonList rows={3} />} isEmpty={(d) => d.length === 0} empty={<EmptyState compact title={t('priv.noRequests')} />}>
        {(rows) => (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start gap-3 py-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{te('rights.type.', r.type)}</span>
                    <Badge tone={r.status === 'completed' ? 'ok' : r.status === 'rejected' ? 'neutral' : r.overdue ? 'danger' : 'info'}>
                      {r.overdue ? t('priv.overdue') : te('rights.status.', r.status)}
                    </Badge>
                    <bdi className="text-sm text-fg-muted">{r.patient_name} · {r.mrn}</bdi>
                  </div>
                  {r.details && <p className="text-base"><bdi>{r.details}</bdi></p>}
                  <p className="text-sm text-fg-muted">
                    {fmt.dateTime(r.created_at)} · {t('rights.dueBy', { d: fmt.date(r.due_at) })}
                  </p>
                  {r.resolution && <p className="rounded-xl bg-surface-2 px-3 py-2 text-sm"><bdi>{r.resolution}</bdi></p>}
                </div>
                {(r.status === 'open' || r.status === 'in_progress') && (
                  <Button size="sm" variant="soft" onClick={() => setAnswering(r)}>
                    {t('priv.answer')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Async>
      <AnswerDialog req={answering} onClose={() => setAnswering(null)} onDone={() => void q.reload(true)} />
    </Card>
  );
}

function AnswerDialog({ req, onClose, onDone }: { req: AdminDataRequest | null; onClose: () => void; onDone: () => void }) {
  const { t, te } = useLocale();
  const { mutate, pending } = useMutation();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [status, setStatus] = useState<'in_progress' | 'completed' | 'rejected'>('completed');
  const [text, setText] = useState('');
  async function save() {
    if (!req) return;
    try {
      await mutate('admin', 'data_request_resolve', { id: req.id, status, resolution: text.trim() || undefined });
      toast(t('common.saved'));
      setText('');
      onDone();
      onClose();
    } catch (e) {
      errorToast(e);
    }
  }
  return (
    <Dialog
      open={!!req}
      onClose={onClose}
      title={t('priv.answer')}
      description={req ? te('rights.type.', req.type) : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button loading={pending} disabled={status !== 'in_progress' && text.trim().length < 5} onClick={() => void save()}>{t('common.save')}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('priv.newStatus')}>
          <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            {(['in_progress', 'completed', 'rejected'] as const).map((s) => (
              <option key={s} value={s}>{te('rights.status.', s)}</option>
            ))}
          </Select>
        </Field>
        <Field label={t('priv.answerText')} hint={t('priv.answerHint')}>
          <Textarea rows={4} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function Breaches() {
  const { t, te, fmt } = useLocale();
  const q = useApi('admin', 'breaches', {});
  const { mutate, pending } = useMutation();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const [sev, setSev] = useState<Breach['severity']>('high');

  async function report() {
    try {
      await mutate('admin', 'report_breach', { message: msg.trim(), severity: sev });
      toast(t('priv.breachLogged'));
      setMsg('');
      setOpen(false);
      void q.reload(true);
    } catch (e) {
      errorToast(e);
    }
  }
  async function notified(b: Breach) {
    try {
      await mutate('admin', 'breach_notified', { id: b.id });
      void q.reload(true);
    } catch (e) {
      errorToast(e);
    }
  }

  return (
    <Card>
      <CardHeader
        title={t('priv.breaches')}
        subtitle={t('priv.breachesHint')}
        action={
          <Button size="sm" variant="outline" icon={<ShieldAlert className="size-4" />} onClick={() => setOpen(true)}>
            {t('priv.reportBreach')}
          </Button>
        }
      />
      <Async state={q} skeleton={<SkeletonList rows={2} />} isEmpty={(d) => d.length === 0} empty={<EmptyState compact title={t('priv.noBreaches')} />}>
        {(rows) => (
          <ul className="divide-y divide-line">
            {rows.map((b) => (
              <li key={b.id} className="flex flex-wrap items-start gap-3 py-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={b.severity === 'high' ? 'danger' : b.severity === 'medium' ? 'warn' : 'neutral'}>{te('sev.', b.severity)}</Badge>
                    <span className="text-sm text-fg-muted">{fmt.dateTime(b.at)}</span>
                    {b.reported_at ? (
                      <Badge tone="ok">{t('priv.reportedOn', { d: fmt.dateTime(b.reported_at) })}</Badge>
                    ) : (
                      <Badge tone={b.report_overdue ? 'solid-danger' : 'warn'}>
                        <AlertTriangle className="me-1 inline size-3.5" aria-hidden />
                        {t(b.report_overdue ? 'priv.reportOverdue' : 'priv.reportBy', { d: fmt.dateTime(b.report_due_at) })}
                      </Badge>
                    )}
                  </div>
                  <p className="text-base"><bdi>{b.message}</bdi></p>
                </div>
                {!b.reported_at && (
                  <Button size="sm" variant="soft" loading={pending} onClick={() => void notified(b)}>
                    {t('priv.markReported')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Async>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('priv.reportBreach')}
        description={t('priv.reportBreachHint')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={pending} disabled={msg.trim().length < 10} onClick={() => void report()}>{t('priv.reportBreach')}</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label={t('priv.whatHappened')}>
            <Textarea rows={4} value={msg} maxLength={2000} onChange={(e) => setMsg(e.target.value)} />
          </Field>
          <Field label={t('priv.severity')}>
            <Select value={sev} onChange={(e) => setSev(e.target.value as Breach['severity'])}>
              {(['high', 'medium', 'low'] as const).map((s) => (
                <option key={s} value={s}>{te('sev.', s)}</option>
              ))}
            </Select>
          </Field>
        </div>
      </Dialog>
    </Card>
  );
}
