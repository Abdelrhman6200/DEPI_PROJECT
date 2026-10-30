'use client';

import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { AiReview, UUID } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import { CLINICIAN_ROLES, hasRole } from '@/lib/roles';
import { Card, CardHeader } from '../Card';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { Textarea } from '../Field';
import { useErrorToast, useToast } from '../Toast';

/**
 * Companion answers held for a person (engine 36_reviews.js): the patient's question, the AI draft and why it was held.
 * A doctor or nurse approves it, edits it, or rejects it with a note; the patient then sees the result.
 */
export function AiReviewQueue({ patientId }: { patientId?: UUID }) {
  const { t, pick, te, fmt } = useLocale();
  const { user } = useAuth();
  const q = useApi('provider', 'ai_reviews', patientId ? { patient_id: patientId } : {});
  const pending = (q.data ?? []).filter((r) => r.status === 'pending');
  if (!q.data || pending.length === 0) return null;
  const canDecide = hasRole(user?.role, CLINICIAN_ROLES);
  return (
    <Card tone="warn">
      <CardHeader title={t('rev.title', { n: pending.length })} icon={<ShieldCheck className="size-5" />} subtitle={t('rev.hint')} />
      <ul className="space-y-3">
        {pending.map((r) => (
          <ReviewItem key={r.id} r={r} canDecide={canDecide} onDone={() => void q.reload(true)}
            who={pick(r.patient_name ?? '', r.patient_name_ar)} signals={r.signals.map((s) => te('rev.signal.', s)).join(' · ')} due={fmt.dateTime(r.due_at)} />
        ))}
      </ul>
    </Card>
  );
}

function ReviewItem({ r, canDecide, onDone, who, signals, due }: { r: AiReview; canDecide: boolean; onDone: () => void; who: string; signals: string; due: string }) {
  const { t } = useLocale();
  const { mutate, pending } = useMutation();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [mode, setMode] = useState<'view' | 'edit' | 'reject'>('view');
  const [text, setText] = useState(r.draft);
  const [note, setNote] = useState('');
  async function decide(decision: 'approve' | 'edit' | 'reject') {
    try {
      await mutate('provider', 'ai_review_decide', { review_id: r.id, decision, content: decision === 'edit' ? text : undefined, note: decision === 'reject' ? note : undefined });
      toast(t('rev.done'));
      onDone();
    } catch (e) { errorToast(e); }
  }
  return (
    <li className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <bdi className="font-semibold">{who}</bdi><span className="text-fg-muted">{r.mrn}</span>
        <Badge tone={r.overdue ? 'danger' : 'warn'}>{r.overdue ? t('rev.overdue') : t('rev.due', { d: due })}</Badge>
        <span className="text-fg-muted">{signals}</span>
      </div>
      <p className="mt-2 text-sm text-fg-muted">{t('rev.question')}</p>
      <p className="text-base" dir="auto">{r.question || '—'}</p>
      <p className="mt-2 text-sm text-fg-muted">{t('rev.draft')}</p>
      {mode === 'edit' ? <Textarea rows={5} dir="auto" value={text} onChange={(e) => setText(e.target.value)} /> : <p className="rounded-xl bg-surface-2 p-3 text-base" dir="auto">{r.draft}</p>}
      {mode === 'reject' && <Textarea className="mt-2" rows={2} dir="auto" placeholder={t('rev.notePh')} value={note} onChange={(e) => setNote(e.target.value)} />}
      {canDecide && (
        <div className="mt-3 flex flex-wrap gap-2">
          {mode === 'view' && <>
            <Button size="sm" loading={pending} onClick={() => void decide('approve')}>{t('rev.approve')}</Button>
            <Button size="sm" variant="outline" onClick={() => setMode('edit')}>{t('rev.edit')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('reject')}>{t('rev.reject')}</Button>
          </>}
          {mode === 'edit' && <><Button size="sm" loading={pending} disabled={text.trim().length < 5} onClick={() => void decide('edit')}>{t('rev.sendEdited')}</Button><Button size="sm" variant="ghost" onClick={() => setMode('view')}>{t('common.cancel')}</Button></>}
          {mode === 'reject' && <><Button size="sm" variant="danger" loading={pending} onClick={() => void decide('reject')}>{t('rev.sendReject')}</Button><Button size="sm" variant="ghost" onClick={() => setMode('view')}>{t('common.cancel')}</Button></>}
        </div>
      )}
    </li>
  );
}
