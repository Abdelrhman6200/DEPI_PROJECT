'use client';

import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import type { Referral, UUID } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { Field, Input, Select, Textarea } from '../Field';
import { InlineError } from '../EmptyState';
import { SPECIALTIES } from '../domain/Facility';
import { useErrorToast, useToast } from '../Toast';

export const REFERRAL_STATUSES: Referral['status'][] = ['CREATED', 'MATCHING', 'SELECTED', 'BOOKED', 'CONSULTED', 'REPORT_RETURNED', 'CLOSED'];

export function CreateReferralDialog({
  open,
  onClose,
  patientId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  patientId: UUID;
  onCreated: (r: Referral) => void;
}) {
  const { t, te, pick } = useLocale();
  const toast = useToast();
  const { mutate, pending, error } = useMutation();
  const [specialty, setSpecialty] = useState('endocrinology');
  const [urgency, setUrgency] = useState<Referral['urgency']>('routine');
  const [reason, setReason] = useState('');
  const [facilityId, setFacilityId] = useState('');
  const facilities = useApi('network', 'search', open ? { specialty, limit: 30 } : null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await mutate('network', 'create_referral', {
        patient_id: patientId,
        to_specialty: specialty,
        urgency,
        reason: reason.trim(),
        to_facility_id: facilityId || undefined,
      });
      toast(t('common.saved'));
      onCreated(r);
      setReason('');
      onClose();
    } catch {
      /* inline */
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('ref.create')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="create-ref" loading={pending}>
            {t('common.submit')}
          </Button>
        </>
      }
    >
      <form id="create-ref" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label={t('ref.toSpecialty')}>
          <Select
            value={specialty}
            onChange={(e) => {
              setSpecialty(e.target.value);
              setFacilityId('');
            }}
          >
            {SPECIALTIES.map((s) => (
              <option key={s} value={s}>
                {te('spec.', s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('ref.urgency')}>
          <Select value={urgency} onChange={(e) => setUrgency(e.target.value as Referral['urgency'])}>
            {(['routine', 'soon', 'urgent'] as const).map((u) => (
              <option key={u} value={u}>
                {te('ref.', u)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`${t('ref.toFacility')} (${t('common.optional')})`} className="sm:col-span-2">
          <Select value={facilityId} onChange={(e) => setFacilityId(e.target.value)} disabled={facilities.loading}>
            <option value="">—</option>
            {(facilities.data ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {pick(f.name, f.name_ar)} · {f.city}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('common.reason')} className="sm:col-span-2">
          <Textarea required value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="sm:col-span-2">
          <InlineError error={error} />
        </div>
      </form>
    </Dialog>
  );
}

/** Status selector + optional report text, calls network.update_referral. */
export function ReferralStatusControl({ r, onUpdated }: { r: Referral; onUpdated: (r: Referral) => void }) {
  const { t, te } = useLocale();
  const toast = useToast();
  const errorToast = useErrorToast();
  const { mutate, pending } = useMutation();
  const [status, setStatus] = useState<Referral['status']>(r.status);
  const [report, setReport] = useState(r.report ?? '');
  const [expanded, setExpanded] = useState(false);
  const dirty = status !== r.status || (report || '') !== (r.report ?? '');

  async function save() {
    try {
      const next = await mutate('network', 'update_referral', { referral_id: r.id, status, report: report.trim() || undefined });
      onUpdated(next);
      toast(t('common.saved'));
      setExpanded(false);
    } catch (e) {
      errorToast(e);
    }
  }

  return (
    <div className="flex w-full flex-col gap-2 sm:w-64">
      <div className="flex gap-1.5">
        <Select value={status} onChange={(e) => setStatus(e.target.value as Referral['status'])} className="h-8 text-xs" aria-label={t('ref.updateStatus')}>
          {REFERRAL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {te('rs.', s)}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="ghost" onClick={() => setExpanded((x) => !x)}>
          {t('ref.report')}
        </Button>
      </div>
      {expanded && <Input placeholder={t('ref.report')} value={report} onChange={(e) => setReport(e.target.value)} />}
      {dirty && (
        <Button size="xs" loading={pending} onClick={() => void save()}>
          {t('common.save')}
        </Button>
      )}
    </div>
  );
}

export function NewReferralButton({ onClick }: { onClick: () => void }) {
  const { t } = useLocale();
  return (
    <Button size="sm" icon={<Plus className="size-4" />} onClick={onClick}>
      {t('ref.create')}
    </Button>
  );
}
