'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ArrowLeftRight, Building2, Check, ChevronDown, Clock, Plus, X } from 'lucide-react';
import type { FacilityMatch, Transfer } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import { CLINICIAN_ROLES, TRANSFER_ROLES, hasRole } from '@/lib/roles';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/Card';
import { Badge, type BadgeTone } from '@/components/Badge';
import { Button } from '@/components/Button';
import { Dialog } from '@/components/Dialog';
import { Field, Select, Textarea } from '@/components/Field';
import { Tabs } from '@/components/Tabs';
import { Async } from '@/components/Async';
import { EmptyState, InlineError } from '@/components/EmptyState';
import { SkeletonList } from '@/components/Skeleton';
import { CapacityCell, SPECIALTIES } from '@/components/domain/Facility';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useErrorToast, useToast } from '@/components/Toast';

type Status = Transfer['status'];
type Filter = 'active' | 'all' | Status;

const FLOW: Status[] = ['REQUESTED', 'UNDER_REVIEW', 'ACCEPTED', 'BED_RESERVED', 'IN_TRANSPORT', 'ARRIVED'];
/** Mirrors the backend state machine (app.api_update_transfer). */
const NEXT: Record<Status, Status[]> = {
  REQUESTED: ['UNDER_REVIEW', 'CANCELLED'],
  UNDER_REVIEW: ['ACCEPTED', 'DECLINED', 'CANCELLED'],
  ACCEPTED: ['BED_RESERVED', 'CANCELLED'],
  DECLINED: ['UNDER_REVIEW', 'CANCELLED'],
  BED_RESERVED: ['IN_TRANSPORT', 'CANCELLED'],
  IN_TRANSPORT: ['ARRIVED'],
  ARRIVED: [],
  CANCELLED: [],
};
const NEEDS_DESTINATION = new Set<Status>(['ACCEPTED', 'BED_RESERVED']);
const RESOURCES = ['icu', 'ccu', 'ward', 'dialysis', 'cath_lab', 'ct', 'mri', 'er_accepting'];
const URGENCY_TONE: Record<Transfer['requirements']['urgency'], BadgeTone> = { routine: 'neutral', urgent: 'warn', emergent: 'solid-danger' };
const STATUS_TONE: Partial<Record<Status, BadgeTone>> = { ARRIVED: 'ok', DECLINED: 'danger', CANCELLED: 'neutral', IN_TRANSPORT: 'info', BED_RESERVED: 'primary' };

export default function TransfersPage() {
  const { user } = useAuth();
  const { t, te } = useLocale();
  const [filter, setFilter] = useState<Filter>('active');
  const [creating, setCreating] = useState(false);
  const q = useApi('network', 'transfers', { status: filter });

  if (!hasRole(user?.role, TRANSFER_ROLES)) return <EmptyState title={t('err.forbidden')} />;

  return (
    <div>
      <PageHeader
        title={t('tr.title')}
        action={
          // A transfer is requested by the treating doctor or nurse; coordinators and admins work the existing ones.
          hasRole(user?.role, CLINICIAN_ROLES) ? (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              {t('tr.new')}
            </Button>
          ) : undefined
        }
      />
      <Tabs<Filter>
        variant="pills"
        className="mb-4"
        value={filter}
        onChange={setFilter}
        tabs={[{ id: 'active', label: t('tr.active') }, { id: 'all', label: t('common.all') }, ...[...FLOW, 'DECLINED' as Status, 'CANCELLED' as Status].map((s) => ({ id: s as Filter, label: te('ts.', s) }))]}
      />
      <Async state={q} skeleton={<SkeletonList rows={4} />} empty={<EmptyState title={t('tr.empty')} icon={<ArrowLeftRight className="size-7" />} />}>
        {(list) => (
          <ul className="space-y-3">
            {list.map((tr) => (
              <li key={tr.id}>
                <TransferCard tr={tr} onChange={(next) => q.setData((xs) => (xs ? xs.map((x) => (x.id === next.id ? next : x)) : xs))} />
              </li>
            ))}
          </ul>
        )}
      </Async>
      <CreateTransferDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(tr) => {
          q.setData((xs) => [tr, ...(xs ?? [])]);
          setCreating(false);
        }}
      />
    </div>
  );
}

function Stepper({ status }: { status: Status }) {
  const { te } = useLocale();
  const declined = status === 'DECLINED';
  const cancelled = status === 'CANCELLED';
  const idx = declined ? FLOW.indexOf('ACCEPTED') : FLOW.indexOf(status);
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-2 text-xs" aria-label={te('ts.', status)}>
      {FLOW.map((s, i) => {
        const done = !cancelled && i < idx;
        const current = !cancelled && i === idx;
        const bad = declined && current;
        return (
          <li key={s} className="flex items-center gap-1">
            <span
              aria-current={current ? 'step' : undefined}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium',
                done && 'border-ok/40 bg-ok-soft text-ok-fg',
                current && !bad && 'border-primary bg-primary text-primary-fg',
                bad && 'border-danger bg-danger-soft text-danger-fg',
                !done && !current && 'border-line text-fg-subtle',
              )}
            >
              {done && <Check className="size-3" aria-hidden />}
              {bad && <X className="size-3" aria-hidden />}
              {bad ? te('ts.', 'DECLINED') : te('ts.', s)}
            </span>
            {i < FLOW.length - 1 && <span className="h-px w-3 bg-line-strong" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

function TransferCard({ tr, onChange }: { tr: Transfer; onChange: (t: Transfer) => void }) {
  const { t, te, fmt, pick } = useLocale();
  const toast = useToast();
  const errorToast = useErrorToast();
  const { mutate } = useMutation();
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(tr.status === 'UNDER_REVIEW' || (tr.status === 'REQUESTED' && !tr.to_facility_id));
  // declining or cancelling a transfer stops it for the patient: asked once more
  const [confirming, setConfirming] = useState<'DECLINED' | 'CANCELLED' | null>(null);

  async function update(status: Status, to_facility_id?: string) {
    setBusy(status + (to_facility_id ?? ''));
    try {
      const next = await mutate('network', 'update_transfer', { transfer_id: tr.id, status, to_facility_id });
      onChange(next);
      toast(t('tr.updated'));
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(null);
    }
  }

  const nexts = NEXT[tr.status] ?? [];
  const forward = nexts.filter((s) => s !== 'CANCELLED' && s !== 'DECLINED');
  const req = tr.requirements;

  return (
    <article className="rounded-2xl border border-line bg-surface">
      <div className="flex flex-wrap items-start gap-3 p-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Link href={`/provider/patients/${tr.patient_id}`} className="text-base font-semibold hover:underline">
              {tr.patient_name}
            </Link>
            <Badge tone={URGENCY_TONE[req.urgency]}>{te('tu.', req.urgency)}</Badge>
            <Badge tone={STATUS_TONE[tr.status] ?? 'primary'}>{te('ts.', tr.status)}</Badge>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-fg-muted">
            <span>
              {t('tr.resource')}: <span className="font-medium text-fg">{te('res.', req.resource)}</span>
            </span>
            {req.specialty && (
              <span>
                {t('tr.specialty')}: <span className="font-medium text-fg">{te('spec.', req.specialty)}</span>
              </span>
            )}
            <span>
              {t('tr.from')}: {tr.from_facility_name ?? '—'} → {t('tr.to')}:{' '}
              <span className={cn('font-medium', tr.to_facility_name ? 'text-fg' : 'text-warn')}>{tr.to_facility_name ?? t('tr.noDestination')}</span>
            </span>
          </div>
          <p dir="auto" className="text-sm text-fg">
            {req.reason}
          </p>
          <p className="flex items-center gap-1 text-xs text-fg-subtle">
            <Clock className="size-3" aria-hidden />
            {fmt.dateTime(tr.created_at)}
            {tr.created_by_name && <> · {t('tr.createdBy', { n: tr.created_by_name })}</>}
            {tr.updated_at !== tr.created_at && <> · {t('common.updated', { t: fmt.relative(tr.updated_at) })}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {forward.map((s) => {
            const blocked = NEEDS_DESTINATION.has(s) && !tr.to_facility_id;
            return (
              <Button
                key={s}
                size="sm"
                disabled={blocked}
                title={blocked ? t('tr.chooseFirst') : undefined}
                loading={busy === s}
                onClick={() => void update(s)}
              >
                {t('tr.advance', { s: te('ts.', s) })}
              </Button>
            );
          })}
          {nexts.includes('DECLINED') && (
            <Button size="sm" variant="outline" loading={busy === 'DECLINED'} onClick={() => setConfirming('DECLINED')}>
              {t('tr.decline')}
            </Button>
          )}
          {nexts.includes('CANCELLED') && (
            <Button size="sm" variant="ghost" loading={busy === 'CANCELLED'} onClick={() => setConfirming('CANCELLED')}>
              {t('tr.cancel')}
            </Button>
          )}
          <ConfirmDialog
            open={!!confirming}
            onClose={() => setConfirming(null)}
            title={confirming === 'DECLINED' ? t('tr.declineTitle', { name: tr.patient_name }) : t('tr.cancelTitle', { name: tr.patient_name })}
            body={confirming === 'DECLINED' ? t('tr.declineBody') : t('tr.cancelBody')}
            confirmLabel={confirming === 'DECLINED' ? t('tr.decline') : t('tr.cancel')}
            cancelLabel={t('common.back')}
            onConfirm={() => (confirming ? update(confirming) : undefined)}
          />
        </div>
      </div>
      <div className="border-t border-line px-4 py-3">
        <Stepper status={tr.status} />
        {forward.some((s) => NEEDS_DESTINATION.has(s)) && !tr.to_facility_id && <p className="mt-2 text-xs font-medium text-warn">{t('tr.chooseFirst')}</p>}
      </div>
      <div className="border-t border-line">
        <button
          type="button"
          onClick={() => setOpen((x) => !x)}
          aria-expanded={open}
          className="flex min-h-10 w-full items-center justify-between px-4 text-sm font-medium text-fg-muted hover:bg-surface-2"
        >
          <span className="inline-flex items-center gap-2">
            <Building2 className="size-4" aria-hidden />
            {t('tr.eligible')} ({tr.eligible_facilities.length})
          </span>
          <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} aria-hidden />
        </button>
        {open && (
          <div className="px-4 pb-4">
            {tr.eligible_facilities.length === 0 ? (
              <p className="rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn-fg">{t('tr.noEligible')}</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-line">
                <table className="w-full min-w-[40rem] text-sm">
                  <thead className="bg-surface-2 text-xs text-fg-muted">
                    <tr>
                      <th className="px-3 py-2 text-start font-medium">{t('net.facility')}</th>
                      <th className="px-3 py-2 text-start font-medium">{t('net.capacity')}</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {tr.eligible_facilities.map((f: FacilityMatch) => {
                      const cap = f.capacity.find((c) => c.resource === req.resource);
                      const chosen = tr.to_facility_id === f.id;
                      return (
                        <tr key={f.id} className={cn(chosen && 'bg-primary-soft/50')}>
                          <td className="px-3 py-2">
                            <div className="font-medium">{pick(f.name, f.name_ar)}</div>
                            <div className="text-xs text-fg-muted">
                              {te('ftype.', f.type)} · {fmt.list([f.city, f.governorate ? te('gov.', f.governorate) : null])}
                              {f.distance_km !== null && <> · {t('net.km', { n: fmt.number(f.distance_km, 1) })}</>}
                            </div>
                          </td>
                          <td className="w-64 px-3 py-2">{cap ? <CapacityCell c={cap} /> : <span className="text-xs text-fg-subtle">{t('cap.unknown')}</span>}</td>
                          <td className="px-3 py-2 text-end">
                            {chosen ? (
                              <Badge tone="primary" icon={<Check className="size-3" aria-hidden />}>
                                {t('tr.chosen')}
                              </Badge>
                            ) : (
                              !['ARRIVED', 'CANCELLED', 'IN_TRANSPORT'].includes(tr.status) && (
                                <Button size="xs" variant="soft" loading={busy === tr.status + f.id} onClick={() => void update(tr.status, f.id)}>
                                  {t('tr.choose')}
                                </Button>
                              )
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function CreateTransferDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (t: Transfer) => void }) {
  const { t, te, pick } = useLocale();
  const toast = useToast();
  const { mutate, pending, error } = useMutation();
  const panel = useApi('provider', 'panel', open ? {} : null);
  const [patientId, setPatientId] = useState('');
  const [resource, setResource] = useState('icu');
  const [specialty, setSpecialty] = useState('');
  const [reason, setReason] = useState('');
  const [urgency, setUrgency] = useState<Transfer['requirements']['urgency']>('urgent');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!patientId || !reason.trim()) return;
    try {
      const tr = await mutate('network', 'create_transfer', { patient_id: patientId, resource, specialty: specialty || undefined, reason: reason.trim(), urgency });
      toast(t('tr.created'));
      onCreated(tr);
      setReason('');
      setPatientId('');
    } catch {
      /* inline */
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('tr.new')}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="create-transfer" loading={pending} disabled={!patientId || !reason.trim()}>
            {t('common.submit')}
          </Button>
        </>
      }
    >
      <form id="create-transfer" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label={t('tr.pickPatient')} className="sm:col-span-2">
          <Select required value={patientId} onChange={(e) => setPatientId(e.target.value)} disabled={panel.loading}>
            <option value="">—</option>
            {(panel.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {pick(p.full_name, p.full_name_ar)} · {t('common.years', { n: p.age })}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('tr.resource')}>
          <Select value={resource} onChange={(e) => setResource(e.target.value)}>
            {RESOURCES.map((r) => (
              <option key={r} value={r}>
                {te('res.', r)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`${t('tr.specialty')} (${t('common.optional')})`}>
          <Select value={specialty} onChange={(e) => setSpecialty(e.target.value)}>
            <option value="">—</option>
            {[...SPECIALTIES, 'critical_care', 'cardiac_surgery', 'general_surgery'].map((s) => (
              <option key={s} value={s}>
                {te('spec.', s)}
              </option>
            ))}
          </Select>
        </Field>
        <fieldset className="sm:col-span-2">
          <legend className="mb-1.5 text-sm font-medium">{t('tr.urgency')}</legend>
          <div className="flex gap-2">
            {(['routine', 'urgent', 'emergent'] as const).map((u) => (
              <button
                key={u}
                type="button"
                aria-pressed={urgency === u}
                onClick={() => setUrgency(u)}
                className={cn(
                  'min-h-10 flex-1 rounded-xl border-2 px-3 text-sm font-semibold',
                  urgency === u ? (u === 'emergent' ? 'border-danger bg-danger-soft text-danger-fg' : 'border-primary bg-primary-soft text-primary-strong') : 'border-line',
                )}
              >
                {te('tu.', u)}
              </button>
            ))}
          </div>
        </fieldset>
        <Field label={t('tr.reason')} className="sm:col-span-2">
          <Textarea required value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="sm:col-span-2">
          <InlineError error={error} />
        </div>
      </form>
    </Dialog>
  );
}
