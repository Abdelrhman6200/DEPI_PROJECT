'use client';

import { useEffect, useState } from 'react';
import type { Medication } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { useMutation } from '@/lib/useApi';
import { Dialog } from '../Dialog';
import { Button } from '../Button';
import { Field, Input } from '../Field';
import { useErrorToast, useToast } from '../Toast';

/**
 * "Count what's left" of a medicine: the person (or family member, or clinician) enters how many tablets, pens or units
 * are left, and how many make one dose. The app then counts down every scheduled dose and reminds before it runs out
 * (engine 28_adherence.js).
 */
export function SupplyDialog({ med, patientId, onClose, onSaved }: { med: Medication | null; patientId?: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useLocale();
  const { mutate, pending: busy } = useMutation();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [count, setCount] = useState('');
  const [per, setPer] = useState('1');

  useEffect(() => {
    if (!med) return;
    setCount(med.supply ? String(Math.round(med.supply.remaining)) : '');
    setPer(String(med.supply?.units_per_dose ?? 1));
  }, [med]);

  const n = Number(count), p = Number(per);
  const valid = count.trim() !== '' && n >= 0 && n <= 10000 && p > 0 && p <= 20;
  const perDay = med ? med.times.length * (p || 1) : 0;
  const days = valid && perDay > 0 ? Math.floor(n / perDay) : null;

  async function save() {
    if (!med || !valid) return;
    try {
      await mutate('clinical', 'set_supply', { ...(patientId ? { patient_id: patientId } : {}), medication_id: med.id, supply_count: n, units_per_dose: p });
      toast(t('common.saved'));
      onSaved();
      onClose();
    } catch (e) {
      errorToast(e);
    }
  }

  return (
    <Dialog
      open={!!med}
      onClose={onClose}
      size="sm"
      title={t('supply.title')}
      description={med ? <bdi>{med.name}</bdi> : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={!valid} loading={busy}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('supply.count')} hint={t('supply.countHint')}>
          <Input inputMode="decimal" className="num" value={count} onChange={(e) => setCount(e.target.value.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))))} autoFocus />
        </Field>
        <Field label={t('supply.perDose')} hint={t('supply.perDoseHint')}>
          <Input inputMode="decimal" className="num" value={per} onChange={(e) => setPer(e.target.value)} />
        </Field>
        {days !== null && (
          <p className="rounded-xl bg-surface-2 px-4 py-3 text-base" role="status">
            {t('supply.enoughFor', { n: days })}
          </p>
        )}
        {med && med.times.length === 0 && <p className="text-sm text-fg-muted">{t('supply.noTimes')}</p>}
      </div>
    </Dialog>
  );
}
