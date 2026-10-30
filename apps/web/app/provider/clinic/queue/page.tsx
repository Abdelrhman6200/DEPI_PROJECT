'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, ClipboardList, FileSignature, Lightbulb, Save } from 'lucide-react';
import type { ClinicQueuePage, UUID } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { cn } from '@/lib/cn';
import { useApi, useMutation, useVisibleInterval } from '@/lib/useApi';
import { Card, CardHeader, PageHeader } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/Button';
import { Field, Input, Select, Textarea } from '@/components/Field';
import { Dialog } from '@/components/Dialog';
import { Segmented } from '@/components/Tabs';
import { Async } from '@/components/Async';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCard } from '@/components/Skeleton';
import { useErrorToast, useToast } from '@/components/Toast';
import { AiDraftPanel, ClinicUrgencyBadge, Money, useClinicNames } from '@/components/clinic/ClinicBits';

type Selected = NonNullable<ClinicQueuePage['selected']>;

/** YYYY-MM-DD in Cairo, `plus` days from today (the clinic's day). */
function localDate(plus: number) {
  return new Date(Date.now() + plus * 864e5).toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
}

/**
 * Doctor: today's polyclinic queue and the open visit. The patient's key safety facts first, the AI brief and AI ideas
 * as labelled drafts (never copied into the doctor's fields), then the visit form, the invoice and "sign and send".
 * One request for the screen (clinic.queue_page); it refreshes while the brief or the ideas are being written.
 */
export default function ClinicQueuePage() {
  const { t } = useLocale();
  const [selectedId, setSelectedId] = useState<UUID | null>(null);
  const [day, setDay] = useState<'today' | 'tomorrow'>('today');
  const date = day === 'tomorrow' ? localDate(1) : undefined;
  const q = useApi('clinic', 'queue_page', { ...(date ? { date } : {}), ...(selectedId ? { appointment_id: selectedId } : {}) });
  const sel = q.data?.selected ?? null;
  const writing = !!sel && (sel.brief === null || sel.visit?.ai_hints?.status === 'writing');
  useVisibleInterval(() => void q.reload(true), 20_000, writing);
  return (
    <div className="space-y-5">
      <PageHeader title={t('clinic.q.title')} subtitle={t('clinic.q.subtitle')}
        action={<Segmented label={t('clinic.q.day')} options={[{ value: 'today', label: t('clinic.q.today') }, { value: 'tomorrow', label: t('clinic.q.tomorrow') }]} value={day} onChange={(v) => { setDay(v); setSelectedId(null); }} />} />
      <Async state={q} skeleton={<SkeletonCard lines={6} />} isEmpty={() => false}>
        {(d) => (
          <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
            <Queue d={d} activeId={sel?.appointment.id ?? null} onPick={setSelectedId} />
            {sel ? <Visit key={sel.appointment.id} d={d} sel={sel} reload={() => void q.reload(true)} /> : <Card><EmptyState title={t('clinic.q.empty')} /></Card>}
          </div>
        )}
      </Async>
    </div>
  );
}

function Queue({ d, activeId, onPick }: { d: ClinicQueuePage; activeId: UUID | null; onPick: (id: UUID) => void }) {
  const { t, te, fmt } = useLocale();
  const names = useClinicNames();
  return (
    <Card className="h-fit">
      <CardHeader title={t('clinic.q.queue', { n: d.queue.length })} icon={<ClipboardList className="size-5" />} />
      {d.queue.length === 0 ? (
        <EmptyState compact title={t('clinic.q.noQueue')} />
      ) : (
        <ul className="space-y-1">
          {d.queue.map((a) => {
            const done = ['completed', 'no_show', 'cancelled'].includes(a.status);
            return (
              <li key={a.id}>
                <button type="button" onClick={() => onPick(a.id)}
                  className={cn('flex w-full items-center gap-2 rounded-xl px-3 py-2 text-start hover:bg-surface-2', a.id === activeId && 'bg-primary-soft', done && 'opacity-60')}>
                  <span className="num w-12 text-sm font-semibold">{fmt.time(a.starts_at)}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{names.person(a.patient)}</span>
                  {a.urgency && a.urgency !== 'routine' && <ClinicUrgencyBadge urgency={a.urgency} />}
                  {done && <span className="text-xs text-fg-muted">{te('clinic.appt.', a.status)}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

const label = (x: unknown): string => {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    return String(o.display ?? o.name ?? o.substance ?? o.title ?? o.code ?? '');
  }
  return '';
};

function Visit({ d, sel, reload }: { d: ClinicQueuePage; sel: Selected; reload: () => void }) {
  const { t, te, fmt } = useLocale();
  const names = useClinicNames();
  const p = sel.patient;
  const signed = !!sel.visit && sel.visit.status !== 'draft';
  return (
    <div className="space-y-4">
      {/* Who, and the facts that change what a doctor may prescribe */}
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold">{names.person(sel.appointment.patient ?? d.queue.find((x) => x.id === sel.appointment.id)?.patient)}</h2>
          <span className="text-sm text-fg-muted">{[p.age !== null ? t('clinic.d.age', { n: p.age }) : null, p.sex ? te('clinic.sex.', p.sex) : null].filter(Boolean).join(' · ')}</span>
          <ClinicUrgencyBadge urgency={sel.appointment.urgency} />
          {p.has_diabetes && <Badge tone="primary">{t('clinic.q.diabetes')}</Badge>}
        </div>
        {p.allergies.length > 0 && (
          <p className="mt-2 flex flex-wrap items-center gap-1.5 text-sm">
            <AlertTriangle className="size-4 text-danger" aria-hidden />
            <span className="font-semibold text-danger">{t('clinic.q.allergies')}:</span>
            {p.allergies.map((a, i) => <Badge key={i} tone="danger">{label(a)}</Badge>)}
          </p>
        )}
        <details className="mt-2 text-sm">
          <summary className="inline-flex min-h-9 cursor-pointer items-center font-medium text-primary-strong">{t('clinic.q.record')}</summary>
          <div className="mt-1 space-y-1 text-fg-muted">
            {p.conditions.length > 0 && <p><span className="font-medium text-fg">{t('clinic.q.conditions')}: </span>{p.conditions.map(label).filter(Boolean).join(', ')}</p>}
            {p.medicines.length > 0 && <p><span className="font-medium text-fg">{t('clinic.q.medicines')}: </span>{p.medicines.map(label).filter(Boolean).join(', ')}</p>}
            {p.recent_labs.length > 0 && (
              <ul>
                {p.recent_labs.map((l, i) => (
                  <li key={i}>{l.test}: <span className="num">{String(l.value ?? '–')} {l.unit ?? ''}</span> · {fmt.date(l.at)}{l.verified ? '' : ` · ${t('clinic.q.unverified')}`}</li>
                ))}
              </ul>
            )}
          </div>
        </details>
      </Card>

      <AiDraftPanel title={t('clinic.q.brief')}>
        {sel.brief ? (
          <dl className="space-y-1">
            {(['cc', 's', 'o', 'a', 'p'] as const).map((k) => sel.brief![k] ? (
              <div key={k}><dt className="inline font-semibold text-fg">{t(`clinic.q.soap.${k}` as 'clinic.q.soap.cc')}: </dt><dd className="inline" dir="auto">{sel.brief![k]}</dd></div>
            ) : null)}
            {sel.brief.lab_flags.length > 0 && <div className="flex flex-wrap gap-1.5 pt-1">{sel.brief.lab_flags.map((f) => <Badge key={f} tone="warn">{f}</Badge>)}</div>}
          </dl>
        ) : (
          <p>{t('clinic.q.briefWriting')}</p>
        )}
      </AiDraftPanel>

      {signed ? <SignedVisit sel={sel} /> : <VisitForm d={d} sel={sel} reload={reload} />}
    </div>
  );
}

function VisitForm({ d, sel, reload }: { d: ClinicQueuePage; sel: Selected; reload: () => void }) {
  const { t, pick } = useLocale();
  const names = useClinicNames();
  const { mutate, pending } = useMutation();
  const toast = useToast();
  const errorToast = useErrorToast();
  const v = sel.visit;
  const initialIds = (v?.services ?? []).map((s) => (typeof s === 'string' ? s : s.id));
  const [diagnosis, setDiagnosis] = useState(v?.diagnosis ?? '');
  const [rx, setRx] = useState(v?.prescription ?? '');
  const [ids, setIds] = useState<string[]>(initialIds);
  const [follow, setFollow] = useState(v?.follow_up_date ?? '');
  const [signing, setSigning] = useState(false);
  useEffect(() => { setDiagnosis(v?.diagnosis ?? ''); setRx(v?.prescription ?? ''); }, [v?.diagnosis, v?.prescription]);
  const spec = sel.appointment.specialty?.code;
  const services = d.services.filter((s) => s.active !== false && (!spec || s.specialty === spec));
  const total = (d.fee_egp ?? 0) + services.filter((s) => ids.includes(s.id)).reduce((n, s) => n + s.price_egp, 0);
  const hints = v?.ai_hints ?? null;

  async function save(quiet = false) {
    try {
      await mutate('clinic', 'visit_save', { appointment_id: sel.appointment.id, diagnosis: diagnosis.trim(), prescription: rx.trim(), service_ids: ids as UUID[], follow_up_date: follow || null });
      if (!quiet) toast(t('clinic.q.saved'));
      reload();
      return true;
    } catch (e) {
      errorToast(e);
      return false;
    }
  }
  async function askHints() {
    try {
      await mutate('clinic', 'visit_hints', { appointment_id: sel.appointment.id });
      reload();
    } catch (e) {
      errorToast(e);
    }
  }

  return (
    <>
      <Card>
        <CardHeader title={t('clinic.q.visit')} />
        <div className="space-y-3">
          <Field label={t('clinic.q.diagnosis')}><Textarea rows={2} dir="auto" value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} /></Field>
          <Field label={t('clinic.q.prescription')} hint={t('clinic.q.prescriptionHint')}><Textarea rows={4} dir="auto" value={rx} onChange={(e) => setRx(e.target.value)} /></Field>
          {services.length > 0 && (
            <fieldset>
              <legend className="mb-1 text-sm font-medium">{t('clinic.q.services')}</legend>
              <div className="space-y-1">
                {services.map((s) => (
                  <label key={s.id} className="flex min-h-10 items-center gap-2 rounded-lg px-2 hover:bg-surface-2">
                    <input type="checkbox" className="size-4" checked={ids.includes(s.id)} onChange={(e) => setIds((xs) => (e.target.checked ? [...xs, s.id] : xs.filter((x) => x !== s.id)))} />
                    <span className="min-w-0 flex-1">{pick(s.name, s.name_ar)}</span>
                    <Money egp={s.price_egp} />
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <Field label={t('clinic.q.followUp')}><Input type="date" value={follow ?? ''} onChange={(e) => setFollow(e.target.value)} /></Field>
          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
            <span className="text-base">{t('clinic.q.invoice')}: <strong><Money egp={total} /></strong></span>
            <span className="ms-auto flex flex-wrap gap-2">
              <Button variant="outline" icon={<Save className="size-4" />} loading={pending} onClick={() => void save()}>{t('clinic.q.saveDraft')}</Button>
              <Button icon={<FileSignature className="size-4" />} disabled={diagnosis.trim().length < 2} onClick={() => setSigning(true)}>{t('clinic.q.sign')}</Button>
            </span>
          </div>
        </div>
      </Card>

      {/* Doctor-only ideas: a draft to read, never copied into the fields above */}
      <AiDraftPanel
        title={t('clinic.q.ideas')}
        action={!hints || hints.status === 'unavailable'
          ? <Button size="xs" variant="outline" icon={<Lightbulb className="size-3.5" />} loading={pending} onClick={() => void askHints()}>{t('clinic.q.askIdeas')}</Button>
          : undefined}
      >
        {!hints ? <p>{t('clinic.q.ideasHint')}</p>
          : hints.status === 'writing' ? <p>{t('clinic.q.ideasWriting')}</p>
            : hints.status === 'unavailable' ? <p>{t('clinic.q.ideasUnavailable')}</p>
              : (
                <ul className="space-y-1.5">
                  {hints.items.map((h, i) => (
                    <li key={i}><span className="font-medium text-fg" dir="auto">{h.text}</span>{h.why ? <span className="block text-xs" dir="auto">{h.why}</span> : null}</li>
                  ))}
                  {hints.note && <li className="text-xs" dir="auto">{hints.note}</li>}
                </ul>
              )}
      </AiDraftPanel>

      <SignDialog open={signing} onClose={() => setSigning(false)} sel={sel} d={d} save={save} onSigned={() => { setSigning(false); reload(); }} names={names} />
    </>
  );
}

/** Sign and send: the visit becomes final, the patient gets the summary; an optional referral is booked in the clinic. */
function SignDialog({ open, onClose, sel, d, save, onSigned, names }: {
  open: boolean; onClose: () => void; sel: Selected; d: ClinicQueuePage; save: (quiet?: boolean) => Promise<boolean>; onSigned: () => void;
  names: ReturnType<typeof useClinicNames>;
}) {
  const { t, fmt } = useLocale();
  const { mutate, pending } = useMutation();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [refer, setRefer] = useState('');
  const [reason, setReason] = useState('');
  async function sign() {
    if (!(await save(true))) return;
    try {
      const r = await mutate('clinic', 'visit_sign', { appointment_id: sel.appointment.id, ...(refer ? { referral: { specialty: refer, reason: reason.trim() } } : {}) });
      toast(r.referral_appointment ? t('clinic.q.signedReferral', { d: `${fmt.weekday(r.referral_appointment.starts_at)} ${fmt.time(r.referral_appointment.starts_at)}` }) : t('clinic.q.signed'));
      onSigned();
    } catch (e) {
      errorToast(e);
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title={t('clinic.q.signTitle')} description={t('clinic.q.signBody')}
      footer={<Button icon={<FileSignature className="size-4" />} loading={pending} disabled={!!refer && reason.trim().length < 3} onClick={() => void sign()}>{t('clinic.q.signSend')}</Button>}>
      <div className="space-y-3">
        <Field label={t('clinic.q.referTo')}>
          <Select value={refer} onChange={(e) => setRefer(e.target.value)}>
            <option value="">{t('clinic.q.noReferral')}</option>
            {d.specialties.filter((s) => s.code !== sel.appointment.specialty?.code).map((s) => <option key={s.code} value={s.code}>{names.specialty(s)}</option>)}
          </Select>
        </Field>
        {refer && <Field label={t('clinic.q.referReason')}><Input dir="auto" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
      </div>
    </Dialog>
  );
}

function SignedVisit({ sel }: { sel: Selected }) {
  const { t } = useLocale();
  const v = sel.visit!;
  return (
    <Card tone="ok">
      <CardHeader title={t('clinic.q.signedTitle')} />
      <div className="space-y-2 text-base leading-7">
        <p><span className="text-fg-muted">{t('clinic.q.diagnosis')}: </span><span dir="auto">{v.diagnosis}</span></p>
        {v.prescription && <p className="whitespace-pre-line" dir="auto"><span className="text-fg-muted">{t('clinic.q.prescription')}: </span>{v.prescription}</p>}
        <p className="text-sm text-fg-muted">{t('clinic.q.invoice')}: <Money egp={v.invoice_total_egp} /></p>
        {v.prescription_patient_ar && (
          <details className="text-sm">
            <summary className="inline-flex min-h-9 cursor-pointer items-center font-medium text-primary-strong">{t('clinic.q.patientSees')}</summary>
            <p dir="auto" className="mt-1 whitespace-pre-line rounded-xl bg-surface-2 p-3">{v.prescription_patient_ar}</p>
            <p className="mt-1 text-xs text-fg-muted">{v.rx_check === 'numbers_match' ? t('clinic.q.rxChecked') : t('clinic.q.rxDoctorText')}</p>
          </details>
        )}
      </div>
    </Card>
  );
}
