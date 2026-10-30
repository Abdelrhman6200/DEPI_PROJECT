'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Droplet, Plus, ShieldAlert } from 'lucide-react';
import type { Allergy, Condition, Medication } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import type { TKey } from '@/lib/i18n';
import { Card, PageHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Tabs } from '@/components/Tabs';
import { Async } from '@/components/Async';
import { EmptyState } from '@/components/EmptyState';

import { SkeletonCard, SkeletonList } from '@/components/Skeleton';
import { AllergyList, ConditionList, EgfrCard, LabTable, MedicationList, TimelineList, VitalList } from '@/components/domain/HealthLists';
import { AddRecordDialog, EditMedicationDialog, type RecordKind } from '@/components/domain/HealthForms';
import { SupplyDialog } from '@/components/domain/SupplyDialog';
import { SafetyFindingCard } from '@/components/domain/Rows';
import { PatientDocuments } from '@/components/domain/Documents';
import { useErrorToast, useToast } from '@/components/Toast';
import { Dialog } from '@/components/Dialog';
import { ShowMoreList } from '@/components/ShowMoreList';
import { usePatientShell } from '@/components/patient/PatientShellContext';
import { ManageHint } from '@/components/patient/ManageHint';
import { LOCATION_EVENT } from '@/components/NotificationBell';

type Tab = 'medications' | 'labs' | 'conditions' | 'allergies' | 'vitals' | 'documents' | 'timeline';
const TABS: Tab[] = ['medications', 'labs', 'documents', 'conditions', 'allergies', 'vitals', 'timeline'];
const TAB_KIND: Record<Tab, RecordKind | null> = {
  conditions: 'condition',
  medications: 'medication',
  allergies: 'allergy',
  labs: 'lab',
  vitals: 'vital',
  documents: null,
  timeline: null,
};
/** Changing these is "managing the record": a family member needs the patient's permission (labs and vitals are logging). */
const MANAGED_KINDS: RecordKind[] = ['medication', 'condition', 'allergy'];
const ADD_LABEL: Partial<Record<Tab, TKey>> = {
  conditions: 'health.addCondition',
  medications: 'health.addMedication',
  allergies: 'health.addAllergy',
  labs: 'health.addLab',
  vitals: 'health.addVital',
};

export default function HealthPage() {
  const { scope, canManageRecord } = useAuth();
  const { t, dir } = useLocale();
  const errorToast = useErrorToast();
  const [tab, setTab] = useState<Tab>('medications');
  const [adding, setAdding] = useState<RecordKind | null>(null);
  const [stopping, setStopping] = useState<Medication | null>(null);
  const [editing, setEditing] = useState<Medication | null>(null);
  const [counting, setCounting] = useState<Medication | null>(null);
  const [removingAllergy, setRemovingAllergy] = useState<Allergy | null>(null);
  const [stopBusy, setStopBusy] = useState(false);
  const toast = useToast();
  const { openMessageTeam } = usePatientShell();
  const summary = useApi('clinical', 'summary', scope);
  const timeline = useApi('clinical', 'timeline', tab === 'timeline' ? { ...scope, limit: 100 } : null);
  const { mutate } = useMutation();
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;

  // deep link: /app/health?tab=documents (also when a notification opens another tab of this page)
  useEffect(() => {
    const read = () => {
      const p = new URLSearchParams(window.location.search).get('tab');
      if (p && (TABS as string[]).includes(p)) setTab(p as Tab);
    };
    read();
    window.addEventListener(LOCATION_EVENT, read);
    return () => window.removeEventListener(LOCATION_EVENT, read);
  }, []);

  function changeTab(next: Tab) {
    setTab(next);
    window.history.replaceState(null, '', next === 'medications' ? '/app/health' : `/app/health?tab=${next}`);
  }

  // Stopping a medicine is confirmed first: one stray tap must not change the medicine list.
  async function confirmStop() {
    const m = stopping;
    if (!m) return;
    setStopBusy(true);
    try {
      await mutate('clinical', 'stop_medication', { ...scope, medication_id: m.id });
      toast(t('health.stopDone', { name: m.name }));
      setStopping(null);
      void summary.reload(true);
    } catch (e) {
      errorToast(e);
    } finally {
      setStopBusy(false);
    }
  }

  async function toggleCondition(c: Condition) {
    try {
      await mutate('clinical', 'resolve_condition', { ...scope, condition_id: c.id, active: c.status !== 'active' });
      toast(t('common.saved'));
      void summary.reload(true);
    } catch (e) {
      errorToast(e);
    }
  }
  async function removeAllergy() {
    const a = removingAllergy;
    if (!a) return;
    setStopBusy(true);
    try {
      await mutate('clinical', 'remove_allergy', { ...scope, allergy_id: a.id });
      toast(t('health.allergyRemovedToast', { name: a.substance }));
      setRemovingAllergy(null);
      void summary.reload(true);
    } catch (e) {
      errorToast(e);
    } finally {
      setStopBusy(false);
    }
  }

  const s = summary.data;
  // One card per distinct note (the newest copy, with a count), most serious first.
  const SEV: Record<string, number> = { contraindicated: 0, major: 1, moderate: 2, info: 3 };
  const open = (s?.safety_findings.filter((f) => f.status === 'open') ?? []).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const findingGroups = open
    .filter((f, i) => open.findIndex((x) => x.kind === f.kind && x.title === f.title) === i)
    .map((f) => ({ f, count: open.filter((x) => x.kind === f.kind && x.title === f.title).length }))
    .sort((a, b) => (SEV[a.f.severity] ?? 9) - (SEV[b.f.severity] ?? 9));
  const kind = TAB_KIND[tab];
  const mayAdd = !!kind && (canManageRecord || !MANAGED_KINDS.includes(kind));

  return (
    <div className="space-y-5">
      <PageHeader title={t('health.title')} />

      <div className="grid gap-3 md:grid-cols-2">
        <Link href="/app/health/glucose" className="block rounded-2xl">
          <Card tone="primary" className="flex h-full items-center gap-4 transition-colors hover:border-primary">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-fg" aria-hidden>
              <Droplet className="size-6" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-lg font-semibold">{t('glu.title')}</div>
              <div className="text-sm text-fg-muted">{t('health.glucoseCard')}</div>
            </div>
            <Chevron className="size-6 shrink-0 text-primary" aria-hidden />
          </Card>
        </Link>
        {s ? <EgfrCard egfr={s.egfr} /> : <SkeletonCard lines={1} />}
      </div>

      {findingGroups.length > 0 && (
        <Card tone="warn">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <ShieldAlert className="size-5 text-warn" aria-hidden />
            {t('health.safetyFindings')}
          </h2>
          <p className="mt-1 mb-3 text-base leading-7">{t('health.safetyFindingsHint')}</p>
          <ShowMoreList
            className="space-y-2"
            limit={2}
            items={findingGroups}
            render={({ f, count }) => (
              <SafetyFindingCard key={f.id} f={f} count={count} onAskTeam={() => openMessageTeam(t('safety.askTeamPrefill', { title: f.title }))} />
            )}
          />
        </Card>
      )}

      <Card>
        <Tabs<Tab>
          value={tab}
          onChange={changeTab}
          className="mb-4"
          tabs={[
            { id: 'medications', label: t('health.medications'), count: s?.medications.filter((m) => m.status === 'active').length },
            { id: 'labs', label: t('health.labs'), count: s?.labs.length },
            { id: 'documents', label: t('health.documents') },
            { id: 'conditions', label: t('health.conditions'), count: s?.conditions.length },
            { id: 'allergies', label: t('health.allergies'), count: s?.allergies.length },
            { id: 'vitals', label: t('health.vitals') },
            { id: 'timeline', label: t('health.timeline') },
          ]}
        />

        {kind && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1 text-sm text-fg-muted">
              {t('help.verified')}
            </p>
            {mayAdd ? (
              <Button size="lg" icon={<Plus className="size-5" />} onClick={() => setAdding(kind)}>
                {t(ADD_LABEL[tab]!)}
              </Button>
            ) : (
              <ManageHint className="w-full sm:w-auto" />
            )}
          </div>
        )}

        {tab === 'documents' ? (
          <PatientDocuments patientId={scope.patient_id} />
        ) : tab === 'timeline' ? (
          <Async state={timeline} skeleton={<SkeletonList rows={4} />} isEmpty={() => false}>
            {(items) => <TimelineList items={items} />}
          </Async>
        ) : (
          <Async state={summary} skeleton={<SkeletonList rows={4} />} isEmpty={() => false}>
            {(d) => (
              <>
                {tab === 'conditions' && <ConditionList items={d.conditions} onToggle={canManageRecord ? (c) => void toggleCondition(c) : undefined} />}
                {tab === 'medications' &&
                  (d.medications.length ? (
                    <MedicationList
                      items={d.medications}
                      onStop={canManageRecord ? (m) => setStopping(m) : undefined}
                      onEdit={canManageRecord ? (m) => setEditing(m) : undefined}
                      onCount={(m) => setCounting(m)}
                    />
                  ) : (
                    <EmptyState title={t('health.noMeds')} description={t('health.noMedsHint')} />
                  ))}
                {tab === 'allergies' && <AllergyList items={d.allergies} onRemove={canManageRecord ? (a) => setRemovingAllergy(a) : undefined} />}
                {tab === 'labs' &&
                  (d.labs.length ? (
                    <LabTable items={d.labs} />
                  ) : (
                    <EmptyState
                      title={t('health.noLabs')}
                      description={t('health.noLabsHint')}
                      action={
                        <Button variant="outline" onClick={() => changeTab('documents')}>
                          {t('doc.upload')}
                        </Button>
                      }
                    />
                  ))}
                {tab === 'vitals' && <VitalList items={d.vitals} />}
              </>
            )}
          </Async>
        )}
      </Card>

      <Dialog
        open={!!stopping}
        onClose={() => setStopping(null)}
        size="sm"
        title={t('health.stopConfirmTitle', { name: stopping?.name ?? '' })}
        footer={
          <>
            <Button variant="ghost" size="lg" onClick={() => setStopping(null)}>
              {t('health.stopKeep')}
            </Button>
            <Button variant="danger" size="lg" loading={stopBusy} onClick={() => void confirmStop()}>
              {t('health.stopConfirm')}
            </Button>
          </>
        }
      >
        <p className="text-base leading-7 text-fg">{t('health.stopConfirmBody')}</p>
      </Dialog>

      <Dialog
        open={!!removingAllergy}
        onClose={() => setRemovingAllergy(null)}
        size="sm"
        title={t('health.allergyRemoveTitle', { name: removingAllergy?.substance ?? '' })}
        footer={
          <>
            <Button variant="ghost" size="lg" onClick={() => setRemovingAllergy(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" size="lg" loading={stopBusy} onClick={() => void removeAllergy()}>
              {t('common.remove')}
            </Button>
          </>
        }
      >
        <p className="text-base leading-7 text-fg">{t('health.allergyRemoveBody')}</p>
      </Dialog>

      <SupplyDialog med={counting} patientId={scope.patient_id} onClose={() => setCounting(null)} onSaved={() => void summary.reload(true)} />
      <EditMedicationDialog med={editing} onClose={() => setEditing(null)} patientId={scope.patient_id} onSaved={() => void summary.reload(true)} />

      <AddRecordDialog
        kind={adding}
        onClose={() => setAdding(null)}
        activeMedications={s?.medications.filter((m) => m.status === 'active')}
        patientId={scope.patient_id}
        onSaved={() => {
          void summary.reload(true);
          if (tab === 'timeline') void timeline.reload(true);
        }}
      />
    </div>
  );
}
