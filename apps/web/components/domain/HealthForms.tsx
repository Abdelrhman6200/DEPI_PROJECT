'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, Plus, X } from 'lucide-react';
import type { Allergy, Medication, SafetyFinding, UUID, Vital } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { useMutation } from '@/lib/useApi';
import { isoDate, localInputToIso, nowLocalInput } from '@/lib/format';
import { Dialog } from '../Dialog';
import { Button } from '../Button';
import { Chips, Field, Input, Select } from '../Field';
import { InlineError } from '../EmptyState';
import { SafetyFindingCard } from './Rows';
import { useToast } from '../Toast';
import type { TKey } from '@/lib/i18n';

export type RecordKind = 'condition' | 'medication' | 'allergy' | 'lab' | 'vital';

const TITLES: Record<RecordKind, TKey> = {
  condition: 'health.addCondition',
  medication: 'health.addMedication',
  allergy: 'health.addAllergy',
  lab: 'health.addLab',
  vital: 'health.addVital',
};

/**
 * The lab tests the service knows (database lab_catalog), with the standard unit and the other units it converts.
 * `code` is sent to clinical.add_lab as test_code.
 */
export const LAB_TESTS: { code: string; label: string; label_ar: string; unit: string; other?: string[] }[] = [
  { code: 'hba1c', label: 'HbA1c (3-month sugar average)', label_ar: 'السكر التراكمي', unit: '%', other: ['mmol/mol'] },
  { code: 'fpg', label: 'Fasting sugar (lab test)', label_ar: 'سكر صائم (معمل)', unit: 'mg/dL', other: ['mmol/L'] },
  { code: 'creatinine', label: 'Creatinine (kidney)', label_ar: 'الكرياتينين (الكلى)', unit: 'mg/dL', other: ['µmol/L'] },
  { code: 'egfr', label: 'eGFR (kidney function)', label_ar: 'وظائف الكلى (eGFR)', unit: 'mL/min/1.73m2' },
  { code: 'uacr', label: 'Urine albumin (UACR)', label_ar: 'زلال البول (UACR)', unit: 'mg/g', other: ['mg/mmol'] },
  { code: 'ldl', label: 'LDL cholesterol', label_ar: 'الكوليسترول الضار', unit: 'mg/dL', other: ['mmol/L'] },
  { code: 'hdl', label: 'HDL cholesterol', label_ar: 'الكوليسترول النافع', unit: 'mg/dL', other: ['mmol/L'] },
  { code: 'tg', label: 'Triglycerides', label_ar: 'الدهون الثلاثية', unit: 'mg/dL', other: ['mmol/L'] },
  { code: 'potassium', label: 'Potassium', label_ar: 'البوتاسيوم', unit: 'mmol/L', other: ['mEq/L'] },
  { code: 'alt', label: 'ALT (liver)', label_ar: 'إنزيم الكبد ALT', unit: 'U/L' },
  { code: 'b12', label: 'Vitamin B12', label_ar: 'فيتامين ب12', unit: 'pg/mL', other: ['pmol/L'] },
];

type Frequency = 'once' | 'twice' | 'three' | 'as_needed' | 'other';
/** Suggested times for each choice; the person can change them. */
const FREQ_TIMES: Record<Frequency, string[]> = { once: ['08:00'], twice: ['08:00', '20:00'], three: ['08:00', '14:00', '20:00'], as_needed: [], other: ['08:00'] };

export function AddRecordDialog({
  kind,
  onClose,
  patientId,
  onSaved,
  activeMedications,
}: {
  kind: RecordKind | null;
  onClose: () => void;
  patientId?: UUID;
  onSaved: () => void;
  /** Used to warn before the same medicine is added twice. */
  activeMedications?: { name: string; generic?: string | null }[];
}) {
  const { t, pick } = useLocale();
  const [freq, setFreq] = useState<Frequency | null>(null);
  const [times, setTimes] = useState<string[]>([]);
  const [duplicateOk, setDuplicateOk] = useState(false);
  const toast = useToast();
  const { mutate, pending, error, clearError } = useMutation();
  const pid = patientId ? { patient_id: patientId } : {};

  // shared form state (simple and explicit)
  const [f, setF] = useState<Record<string, string>>({});
  const [findings, setFindings] = useState<SafetyFinding[] | null>(null);
  const set = (k: string) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  // Same medicine already on the list? (same name, or the new name starts with / contains an existing one)
  const typedName = (f.name ?? '').trim().toLowerCase();
  const duplicate =
    kind === 'medication' && typedName.length >= 3
      ? (activeMedications ?? []).find((m) => {
          const names = [m.name, m.generic ?? ''].map((x) => x.trim().toLowerCase().replace(/_/g, ' ')).filter((x) => x.length >= 3);
          return names.some((n) => n === typedName || n.startsWith(typedName + ' ') || typedName.startsWith(n + ' '));
        })
      : undefined;

  useEffect(() => {
    setFindings(null);
    setFreq(null);
    setTimes([]);
    setDuplicateOk(false);
    clearError();
    if (kind === 'lab') setF({ test_code: 'hba1c', unit: '%', observed_at: isoDate() });
    else if (kind === 'vital') setF({ type: 'blood_pressure', measured_at: nowLocalInput() });
    else if (kind === 'allergy') setF({ severity: 'moderate' });
    else setF({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const num = (k: string) => (f[k] !== undefined && f[k] !== '' ? Number(f[k]) : undefined);
  const str = (k: string) => (f[k] ? f[k].trim() || undefined : undefined);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      switch (kind) {
        case 'condition':
          await mutate('clinical', 'add_condition', { ...pid, display: f.display.trim(), code: str('code'), onset_date: str('onset_date') });
          break;
        case 'allergy':
          await mutate('clinical', 'add_allergy', {
            ...pid,
            substance: f.substance.trim(),
            substance_class: str('substance_class'),
            reaction: str('reaction'),
            severity: (f.severity as Allergy['severity']) ?? 'moderate',
          });
          break;
        case 'medication': {
          if (duplicate && !duplicateOk) return; // the warning with its two choices is on screen
          const clean = Array.from(new Set(times.filter((x) => /^\d{2}:\d{2}$/.test(x)))).sort();
          const res = await mutate('clinical', 'add_medication', {
            ...pid,
            name: f.name.trim(),
            dose_text: str('dose_text'),
            frequency: freq === 'other' ? str('frequency') : freq ? t(`health.freq.${freq}`) : undefined,
            times: clean.length ? clean : undefined,
          });
          onSaved();
          // Keep the dialog open to show safety findings prominently.
          setFindings(res.safety_findings);
          toast(t('health.medAdded'));
          return;
        }
        case 'lab':
          await mutate('clinical', 'add_lab', {
            ...pid,
            test_code: f.test_code,
            value: Number(f.value),
            unit: str('unit'),
            observed_at: f.observed_at ? new Date(f.observed_at).toISOString() : undefined,
          });
          break;
        case 'vital': {
          const type = f.type as Vital['type'];
          await mutate('clinical', 'add_vital', {
            ...pid,
            type,
            systolic: type === 'blood_pressure' ? num('systolic') : undefined,
            diastolic: type === 'blood_pressure' ? num('diastolic') : undefined,
            value: type !== 'blood_pressure' ? num('value') : undefined,
            unit: type === 'weight' ? 'kg' : type === 'heart_rate' ? 'bpm' : 'mmHg',
            measured_at: localInputToIso(f.measured_at ?? ''),
          });
          break;
        }
        default:
          return;
      }
      toast(t('common.saved'));
      onSaved();
      onClose();
    } catch {
      /* shown inline */
    }
  }

  if (!kind) return null;

  const showingFindings = kind === 'medication' && findings !== null;

  return (
    <Dialog
      open={!!kind}
      onClose={onClose}
      title={t(TITLES[kind])}
      footer={
        showingFindings ? (
          <Button onClick={onClose}>{t('common.done')}</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form="add-record" loading={pending}>
              {t('common.save')}
            </Button>
          </>
        )
      }
    >
      {showingFindings ? (
        findings.length === 0 ? (
          <div className="flex items-center gap-2 rounded-xl bg-ok-soft p-4 text-ok-fg">
            <CheckCircle2 className="size-5" />
            {t('health.noFindings')}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-xl border-2 border-danger/50 bg-danger-soft p-4">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" />
              <div>
                <div className="font-semibold text-danger-fg">{t('health.safetyFindings')}</div>
                <p className="text-sm text-fg">{t('health.findingsAfterAdd')}</p>
              </div>
            </div>
            {findings.map((x) => (
              <SafetyFindingCard key={x.id} f={x} />
            ))}
          </div>
        )
      ) : (
        <form id="add-record" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          {kind === 'condition' && (
            <>
              <Field label={t('health.conditionName')} className="sm:col-span-2">
                <Input required value={f.display ?? ''} onChange={set('display')} />
              </Field>
              <Field label={`${t('health.code')} (${t('common.optional')})`}>
                <Input dir="ltr" value={f.code ?? ''} onChange={set('code')} placeholder="E11.9" />
              </Field>
              <Field label={t('health.onset')}>
                <Input type="date" dir="ltr" value={f.onset_date ?? ''} onChange={set('onset_date')} />
              </Field>
            </>
          )}
          {kind === 'medication' && (
            <>
              {/* Examples are written as hints under the field: a grey placeholder inside it looks like a filled-in value. */}
              <Field label={t('health.medName')} hint={t('health.medNameHint')} className="sm:col-span-2">
                <Input
                  required
                  value={f.name ?? ''}
                  onChange={(e) => {
                    setDuplicateOk(false);
                    set('name')(e);
                  }}
                />
              </Field>
              {duplicate && !duplicateOk && (
                <div role="alert" className="rounded-xl border-2 border-warn/60 bg-warn-soft p-3 sm:col-span-2">
                  <p className="text-base leading-7 font-medium text-fg">{t('health.duplicateMed', { name: duplicate.name })}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button variant="outline" size="md" onClick={onClose}>
                      {t('health.duplicateCancel')}
                    </Button>
                    <Button variant="ghost" size="md" onClick={() => setDuplicateOk(true)}>
                      {t('health.duplicateAdd')}
                    </Button>
                  </div>
                </div>
              )}
              <Field label={`${t('health.dose')} (${t('common.optional')})`} hint={t('health.doseHint')} className="sm:col-span-2">
                <Input value={f.dose_text ?? ''} onChange={set('dose_text')} />
              </Field>
              <div className="space-y-1.5 sm:col-span-2">
                <span className="block text-sm font-medium text-fg">{t('health.frequency')}</span>
                <Chips<Frequency>
                  label={t('health.frequency')}
                  options={(['once', 'twice', 'three', 'as_needed', 'other'] as Frequency[]).map((v) => ({ value: v, label: t(`health.freq.${v}`) }))}
                  value={freq ? [freq] : []}
                  onToggle={(v) => {
                    setFreq(v);
                    setTimes(FREQ_TIMES[v]);
                  }}
                />
              </div>
              {freq === 'other' && (
                <Field label={t('health.freqOther')} className="sm:col-span-2">
                  <Input value={f.frequency ?? ''} onChange={set('frequency')} />
                </Field>
              )}
              {freq && freq !== 'as_needed' && (
                <fieldset className="space-y-1.5 sm:col-span-2">
                  <legend className="text-sm font-medium text-fg">{t('health.timesLabel')}</legend>
                  <div className="flex flex-wrap items-center gap-2">
                    {times.map((tm, i) => (
                      <span key={i} className="inline-flex items-center gap-1">
                        <Input
                          type="time"
                          lang="en"
                          dir="ltr"
                          className="w-32"
                          aria-label={`${t('health.timesLabel')} ${i + 1}`}
                          value={tm}
                          onChange={(e) => setTimes((xs) => xs.map((x, k) => (k === i ? e.target.value : x)))}
                        />
                        {freq === 'other' && times.length > 1 && (
                          <Button variant="ghost" size="md" className="px-2" aria-label={t('common.remove')} onClick={() => setTimes((xs) => xs.filter((_, k) => k !== i))}>
                            <X className="size-4" aria-hidden />
                          </Button>
                        )}
                      </span>
                    ))}
                    {freq === 'other' && times.length < 6 && (
                      <Button variant="outline" size="md" icon={<Plus className="size-4" />} onClick={() => setTimes((xs) => [...xs, '12:00'])}>
                        {t('health.addTime')}
                      </Button>
                    )}
                  </div>
                  <p className="text-sm text-fg-muted">{t('health.timesHint')}</p>
                </fieldset>
              )}
            </>
          )}
          {kind === 'allergy' && (
            <>
              <Field label={t('health.substance')}>
                <Input required value={f.substance ?? ''} onChange={set('substance')} />
              </Field>
              <Field label={`${t('health.substanceClass')} (${t('common.optional')})`}>
                <Input value={f.substance_class ?? ''} onChange={set('substance_class')} />
              </Field>
              <Field label={t('health.reaction')}>
                <Input value={f.reaction ?? ''} onChange={set('reaction')} />
              </Field>
              <Field label={t('health.severity')}>
                <Select value={f.severity ?? 'moderate'} onChange={set('severity')}>
                  <option value="mild">{t('sev.mild')}</option>
                  <option value="moderate">{t('sev.moderate')}</option>
                  <option value="severe">{t('sev.severe')}</option>
                </Select>
              </Field>
            </>
          )}
          {kind === 'lab' && (
            <>
              <Field label={t('health.test')} className="sm:col-span-2">
                <Select
                  value={f.test_code}
                  onChange={(e) => {
                    const tst = LAB_TESTS.find((x) => x.code === e.target.value);
                    setF((s) => ({ ...s, test_code: e.target.value, unit: tst?.unit ?? s.unit }));
                  }}
                >
                  {LAB_TESTS.map((x) => (
                    <option key={x.code} value={x.code}>
                      {pick(x.label, x.label_ar)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('common.value')}>
                <Input type="number" step="any" required dir="ltr" value={f.value ?? ''} onChange={set('value')} />
              </Field>
              {/* Only the units the service can convert are offered, so a result is never stored in the wrong unit. */}
              <Field label={t('common.unit')} hint={t('health.unitHint')}>
                <Select dir="ltr" value={f.unit ?? ''} onChange={set('unit')}>
                  {(() => {
                    const tst = LAB_TESTS.find((x) => x.code === f.test_code);
                    return [tst?.unit ?? '', ...(tst?.other ?? [])].map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ));
                  })()}
                </Select>
              </Field>
              <Field label={t('health.observed')} className="sm:col-span-2">
                <Input type="date" dir="ltr" value={f.observed_at ?? ''} onChange={set('observed_at')} />
              </Field>
            </>
          )}
          {kind === 'vital' && (
            <>
              <Field label={t('common.type')} className="sm:col-span-2">
                <Select value={f.type} onChange={set('type')}>
                  <option value="blood_pressure">{t('vital.blood_pressure')}</option>
                  <option value="weight">{t('vital.weight')}</option>
                  <option value="heart_rate">{t('vital.heart_rate')}</option>
                </Select>
              </Field>
              {f.type === 'blood_pressure' ? (
                <>
                  <Field label={`${t('health.systolic')} (mmHg)`}>
                    <Input type="number" required dir="ltr" value={f.systolic ?? ''} onChange={set('systolic')} />
                  </Field>
                  <Field label={`${t('health.diastolic')} (mmHg)`}>
                    <Input type="number" required dir="ltr" value={f.diastolic ?? ''} onChange={set('diastolic')} />
                  </Field>
                </>
              ) : (
                <Field label={`${t('common.value')} (${f.type === 'weight' ? 'kg' : 'bpm'})`} className="sm:col-span-2">
                  <Input type="number" step="any" required dir="ltr" value={f.value ?? ''} onChange={set('value')} />
                </Field>
              )}
              <Field label={t('glu.measuredAt')} className="sm:col-span-2">
                <Input type="datetime-local" dir="ltr" value={f.measured_at ?? ''} onChange={set('measured_at')} />
              </Field>
            </>
          )}
          <div className="sm:col-span-2">
            <InlineError error={error} />
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** Change the dose, how often, or the times of a medicine. A patient's dose change goes back to the clinician to confirm. */
export function EditMedicationDialog({ med, onClose, patientId, onSaved }: { med: Medication | null; onClose: () => void; patientId?: UUID; onSaved: () => void }) {
  const { t } = useLocale();
  const toast = useToast();
  const { mutate, pending, error, clearError } = useMutation();
  const [dose, setDose] = useState('');
  const [frequency, setFrequency] = useState('');
  const [times, setTimes] = useState<string[]>([]);
  useEffect(() => {
    if (!med) return;
    setDose(med.dose_text ?? '');
    setFrequency(med.frequency ?? '');
    setTimes(med.times.length ? med.times : []);
    clearError();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [med]);
  if (!med) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!med) return;
    try {
      const clean = Array.from(new Set(times.filter((x) => /^\d{2}:\d{2}$/.test(x)))).sort();
      await mutate('clinical', 'update_medication', {
        ...(patientId ? { patient_id: patientId } : {}),
        medication_id: med.id,
        dose_text: dose.trim() || null,
        frequency: frequency.trim() || null,
        times: clean,
      });
      toast(t('common.saved'));
      onSaved();
      onClose();
    } catch {
      /* inline */
    }
  }

  return (
    <Dialog
      open={!!med}
      onClose={onClose}
      title={t('health.editMed', { name: med.name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="edit-med" loading={pending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id="edit-med" onSubmit={submit} className="space-y-4">
        {med.verification_status === 'verified' && <p className="rounded-xl bg-info-soft px-4 py-3 text-sm leading-6 text-info-fg">{t('health.editMedNote')}</p>}
        <Field label={t('health.dose')} hint={t('health.doseHint')}>
          <Input value={dose} onChange={(e) => setDose(e.target.value)} />
        </Field>
        <Field label={t('health.frequency')}>
          <Input value={frequency} onChange={(e) => setFrequency(e.target.value)} />
        </Field>
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium text-fg">{t('health.timesLabel')}</legend>
          <div className="flex flex-wrap items-center gap-2">
            {times.map((tm, i) => (
              <span key={i} className="inline-flex items-center gap-1">
                <Input type="time" lang="en" dir="ltr" className="w-32" aria-label={`${t('health.timesLabel')} ${i + 1}`} value={tm}
                  onChange={(e) => setTimes((xs) => xs.map((x, k) => (k === i ? e.target.value : x)))} />
                <Button variant="ghost" size="md" className="px-2" aria-label={t('common.remove')} onClick={() => setTimes((xs) => xs.filter((_, k) => k !== i))}>
                  <X className="size-4" aria-hidden />
                </Button>
              </span>
            ))}
            {times.length < 6 && (
              <Button variant="outline" size="md" icon={<Plus className="size-4" />} onClick={() => setTimes((xs) => [...xs, '12:00'])}>
                {t('health.addTime')}
              </Button>
            )}
          </div>
          <p className="text-sm text-fg-muted">{t('health.timesHint')}</p>
        </fieldset>
        <InlineError error={error} />
      </form>
    </Dialog>
  );
}
