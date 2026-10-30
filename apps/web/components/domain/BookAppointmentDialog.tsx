'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { CalendarPlus } from 'lucide-react';
import type { Appointment, FacilityMatch, UUID } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { useMutation } from '@/lib/useApi';
import { localInputToIso, nowLocalInput } from '@/lib/format';
import { Dialog } from '../Dialog';
import { Button } from '../Button';
import { Chips, Field, Input, Select } from '../Field';
import { InlineError } from '../EmptyState';
import { useToast } from '../Toast';

export function BookAppointmentDialog({
  open,
  onClose,
  patientId,
  facilities,
  defaultFacilityId,
  episodeId,
  referralId,
  defaultReason,
  onBooked,
}: {
  open: boolean;
  onClose: () => void;
  patientId?: UUID;
  facilities?: FacilityMatch[];
  defaultFacilityId?: UUID;
  episodeId?: UUID;
  referralId?: UUID;
  defaultReason?: string;
  onBooked?: (a: Appointment) => void;
}) {
  const { t, te, pick } = useLocale();
  const toast = useToast();
  const { mutate, pending, error, clearError } = useMutation();
  const [startsAt, setStartsAt] = useState('');
  const [channel, setChannel] = useState<Appointment['channel']>('in_person');
  const [reason, setReason] = useState('');
  const [facilityId, setFacilityId] = useState('');

  useEffect(() => {
    if (!open) return;
    clearError();
    // default: tomorrow 10:00
    const d = new Date(Date.now() + 86400000);
    d.setHours(10, 0, 0, 0);
    setStartsAt(nowLocalInput(Math.round((d.getTime() - Date.now()) / 60000)));
    setReason(defaultReason ?? '');
    setFacilityId(defaultFacilityId ?? '');
    setChannel('in_person');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const iso = localInputToIso(startsAt);
    if (!iso) return;
    try {
      const appt = await mutate('care', 'book_appointment', {
        ...(patientId ? { patient_id: patientId } : {}),
        starts_at: iso,
        channel,
        reason: reason.trim() || undefined,
        facility_id: facilityId || undefined,
        episode_id: episodeId,
        referral_id: referralId,
      });
      toast(t('care.booked'));
      onBooked?.(appt);
      onClose();
    } catch {
      /* inline */
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('care.book')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="book-appt" loading={pending} icon={<CalendarPlus className="size-4" />}>
            {t('care.book')}
          </Button>
        </>
      }
    >
      <form id="book-appt" onSubmit={submit} className="space-y-4">
        <Field label={t('care.startsAt')}>
          <Input type="datetime-local" required dir="ltr" value={startsAt} min={nowLocalInput()} onChange={(e) => setStartsAt(e.target.value)} />
        </Field>
        <Field label={t('care.channel')}>
          <Chips<Appointment['channel']>
            options={(['in_person', 'video', 'phone'] as const).map((c) => ({ value: c, label: te('ch.', c) }))}
            value={[channel]}
            onToggle={setChannel}
          />
        </Field>
        {facilities && facilities.length > 0 && (
          <Field label={t('care.facility')}>
            <Select value={facilityId} onChange={(e) => setFacilityId(e.target.value)}>
              <option value="">—</option>
              {facilities.map((f) => (
                <option key={f.id} value={f.id}>
                  {pick(f.name, f.name_ar)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={t('common.reason')}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <InlineError error={error} />
      </form>
    </Dialog>
  );
}
