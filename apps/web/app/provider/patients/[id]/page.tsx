'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, ArrowRight, Plus, ShieldAlert } from 'lucide-react';
import type { Medication, Workspace } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import { hasKey, type TKey } from '@/lib/i18n';
import { Card, CardHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Tabs, tabPanelProps } from '@/components/Tabs';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Async } from '@/components/Async';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { Skeleton, SkeletonCard, SkeletonList } from '@/components/Skeleton';
import { GlucoseDashboard } from '@/components/domain/GlucoseDashboard';
import { AllergyList, ConditionList, EgfrCard, LabTable, MedicationList, TimelineList, VitalList } from '@/components/domain/HealthLists';
import { AddRecordDialog, type RecordKind } from '@/components/domain/HealthForms';
import { SupplyDialog } from '@/components/domain/SupplyDialog';
import { ReferralRow, SafetyFindingCard } from '@/components/domain/Rows';
import { EpisodeRow } from '@/components/domain/EpisodeViews';
import { ProviderDocuments } from '@/components/domain/Documents';
import { CareLevelScale } from '@/components/CareLevelScale';
import { AiBlock } from '@/components/AiLabel';
import { WorkspaceHeader } from '@/components/provider/WorkspaceHeader';
import { AckButton, OverviewTab } from '@/components/provider/OverviewTab';
import { CarePlanBuilder } from '@/components/provider/CarePlanBuilder';
import { CreateReferralDialog, NewReferralButton, ReferralStatusControl } from '@/components/provider/ReferralsPanel';
import { BriefPanel } from '@/components/provider/BriefPanel';
import { PersonalizationPanel } from '@/components/provider/PersonalCards';
import { useErrorToast } from '@/components/Toast';
import { ProviderThread } from '@/components/patient/People';
import { useAuth } from '@/lib/auth';
import { CLINICIAN_ROLES, hasRole } from '@/lib/roles';

const TABS = ['overview', 'personal', 'messages', 'glucose', 'meds', 'labs', 'plan', 'episodes', 'referrals', 'documents', 'timeline', 'brief'] as const;
type Tab = (typeof TABS)[number];

export default function WorkspacePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const { t, dir, fmt } = useLocale();
  const { user } = useAuth();
  const ws = useApi('provider', 'workspace', id ? { patient_id: id } : null);
  const [tab, setTab] = useState<Tab>('overview');
  const [bgUntil, setBgUntil] = useState<string | null>(null);
  // unsaved care-plan edits: leaving the plan tab asks first
  const [planDirty, setPlanDirty] = useState(false);
  const [leaveTo, setLeaveTo] = useState<Tab | null>(null);
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  const { mutate } = useMutation();
  const errorToast = useErrorToast();

  // deep links from the inbox: /provider/patients/<id>?tab=meds
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const tb = p.get('tab');
    if (tb && (TABS as readonly string[]).includes(tb)) setTab(tb as Tab);
    setBgUntil(p.get('bg'));
  }, []);

  function showTab(next: Tab) {
    setTab(next);
    const p = new URLSearchParams(window.location.search);
    p.set('tab', next);
    window.history.replaceState(null, '', `${window.location.pathname}?${p.toString()}`);
  }

  function changeTab(next: Tab) {
    if (tab === 'plan' && next !== 'plan' && planDirty) setLeaveTo(next);
    else showTab(next);
  }

  async function ackFinding(findingId: string) {
    try {
      await mutate('clinical', 'acknowledge_finding', { finding_id: findingId });
      ws.setData((w) =>
        w ? { ...w, health: { ...w.health, safety_findings: w.health.safety_findings.map((f) => (f.id === findingId ? { ...f, status: 'acknowledged' } : f)) } } : w,
      );
    } catch (e) {
      errorToast(e);
    }
  }

  const reload = () => void ws.reload(true);

  return (
    <div className="space-y-4">
      <Link href="/provider/patients" className="print-hidden -ms-2 inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-sm text-fg-muted hover:bg-surface-2 hover:text-fg">
        <Back className="size-4" aria-hidden />
        {t('pv.patients')}
      </Link>

      {bgUntil && (
        <p role="status" className="print-hidden flex items-center gap-2 rounded-xl border border-danger/40 bg-danger-soft px-4 py-2.5 text-sm font-medium text-danger-fg">
          <ShieldAlert className="size-4 shrink-0" aria-hidden />
          {t('bg.granted', { t: fmt.dateTime(bgUntil) })} · {t('bg.warnTitle')}
        </p>
      )}

      {ws.loading && !ws.data ? (
        <div className="space-y-4" aria-busy="true">
          <Skeleton className="h-28 w-full rounded-2xl" />
          <Skeleton className="h-10 w-full" />
          <SkeletonCard lines={6} />
        </div>
      ) : ws.error && !ws.data ? (
        <ErrorState error={ws.error} onRetry={reload} />
      ) : ws.data ? (
        <>
          <WorkspaceHeader ws={ws.data} />
          <div className="print-hidden sticky top-14 z-20 -mx-4 bg-bg/95 px-4 backdrop-blur lg:top-14 lg:-mx-8 lg:px-8">
            <Tabs<Tab>
              idBase="ws"
              label={t('pv.workspaceTabs')}
              value={tab}
              onChange={changeTab}
              tabs={[
                { id: 'overview', label: t('pv.overview') },
                { id: 'personal', label: t('pers.tab') },
                { id: 'messages', label: t('pv.messages') },
                { id: 'glucose', label: t('pv.glucose') },
                { id: 'meds', label: t('pv.medsSafety'), count: ws.data.health.safety_findings.filter((f) => f.status === 'open').length || undefined },
                { id: 'labs', label: t('pv.labs') },
                { id: 'plan', label: t('pv.carePlan') },
                { id: 'episodes', label: t('pv.episodes'), count: ws.data.episodes.length || undefined },
                { id: 'referrals', label: t('pv.referrals'), count: ws.data.referrals.length || undefined },
                { id: 'documents', label: t('pv.documents') },
                { id: 'timeline', label: t('pv.timeline') },
                { id: 'brief', label: t('pv.brief') },
              ]}
            />
          </div>
          <div {...tabPanelProps('ws', tab)} className="outline-none">
            {tab === 'overview' && <OverviewTab ws={ws.data} onAckFinding={ackFinding} />}
            {tab === 'personal' && <PersonalizationPanel patientId={ws.data.patient.id} />}
            {tab === 'messages' && <ProviderThread patientId={ws.data.patient.id} canReply={hasRole(user?.role, CLINICIAN_ROLES)} />}
            {tab === 'glucose' && <GlucoseDashboard pro patientId={ws.data.patient.id} />}
            {tab === 'meds' && <MedsTab ws={ws.data} onAck={ackFinding} onChanged={reload} />}
            {tab === 'labs' && <LabsTab ws={ws.data} onChanged={reload} />}
            {tab === 'plan' && (
              <CarePlanBuilder patientId={ws.data.patient.id} active={ws.data.plan} draft={ws.data.plan_draft} onChanged={reload} onDirtyChange={setPlanDirty} />
            )}
            {tab === 'episodes' && <EpisodesTab ws={ws.data} />}
            {tab === 'referrals' && <ReferralsTab ws={ws.data} onChanged={reload} />}
            {tab === 'documents' && (
              <Card>
                <CardHeader title={t('pv.documents')} />
                <ProviderDocuments patientId={ws.data.patient.id} onChanged={reload} />
              </Card>
            )}
            {tab === 'timeline' && <TimelineTab ws={ws.data} />}
            {/* Always mounted (hidden on other tabs): a brief being generated keeps going while the doctor reads
                another tab, and a new brief is kept in the workspace data, so it is still there when they come back. */}
            <div hidden={tab !== 'brief'}>
              <BriefPanel
                patientId={ws.data.patient.id}
                brief={ws.data.brief}
                onGenerated={(b) => ws.setData((w) => (w ? { ...w, brief: b } : w))}
                appointmentId={ws.data.appointments.find((a) => new Date(a.starts_at).getTime() > Date.now() - 3600000)?.id}
              />
            </div>
          </div>
        </>
      ) : null}
      <ConfirmDialog
        open={!!leaveTo}
        onClose={() => setLeaveTo(null)}
        title={t('plan.leaveTitle')}
        body={t('plan.leaveBody')}
        confirmLabel={t('plan.leaveConfirm')}
        cancelLabel={t('plan.keepEditing')}
        onConfirm={() => {
          if (leaveTo) {
            setPlanDirty(false);
            showTab(leaveTo);
          }
        }}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- tabs */

function MedsTab({ ws, onAck, onChanged }: { ws: Workspace; onAck: (id: string) => Promise<void>; onChanged: () => void }) {
  const { t } = useLocale();
  const [adding, setAdding] = useState<RecordKind | null>(null);
  const [counting, setCounting] = useState<Medication | null>(null);
  const findings = [...ws.health.safety_findings].sort((a, b) => Number(a.status !== 'open') - Number(b.status !== 'open'));
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={t('health.safetyFindings')} />
        {findings.length === 0 ? (
          <EmptyState compact title={t('pv.noFindings')} />
        ) : (
          <div className="grid gap-2 lg:grid-cols-2">
            {findings.map((f) => (
              <SafetyFindingCard key={f.id} pro f={f} action={f.status === 'open' ? <AckButton onClick={() => onAck(f.id)} /> : undefined} />
            ))}
          </div>
        )}
      </Card>
      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader
            title={t('health.medications')}
            action={
              <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAdding('medication')}>
                {t('health.addMedication')}
              </Button>
            }
          />
          <MedicationList items={ws.health.medications} verifiable onVerified={onChanged} onCount={(m) => setCounting(m)} />
          <SupplyDialog med={counting} patientId={ws.patient.id} onClose={() => setCounting(null)} onSaved={onChanged} />
        </Card>
        <EgfrCard pro egfr={ws.health.egfr} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            title={t('health.conditions')}
            action={
              <Button size="sm" variant="soft" icon={<Plus className="size-4" />} onClick={() => setAdding('condition')}>
                {t('common.add')}
              </Button>
            }
          />
          <ConditionList items={ws.health.conditions} verifiable onVerified={onChanged} />
        </Card>
        <Card>
          <CardHeader
            title={t('health.allergies')}
            action={
              <Button size="sm" variant="soft" icon={<Plus className="size-4" />} onClick={() => setAdding('allergy')}>
                {t('common.add')}
              </Button>
            }
          />
          <AllergyList items={ws.health.allergies} verifiable onVerified={onChanged} />
        </Card>
      </div>
      <AddRecordDialog kind={adding} onClose={() => setAdding(null)} patientId={ws.patient.id} onSaved={onChanged} />
    </div>
  );
}

function LabsTab({ ws, onChanged }: { ws: Workspace; onChanged: () => void }) {
  const { t } = useLocale();
  const [adding, setAdding] = useState<RecordKind | null>(null);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={t('health.labs')}
          action={
            <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAdding('lab')}>
              {t('health.addLab')}
            </Button>
          }
        />
        <LabTable items={ws.health.labs} verifiable onVerified={onChanged} />
      </Card>
      <Card>
        <CardHeader
          title={t('health.vitals')}
          action={
            <Button size="sm" variant="soft" icon={<Plus className="size-4" />} onClick={() => setAdding('vital')}>
              {t('health.addVital')}
            </Button>
          }
        />
        <VitalList pro items={ws.health.vitals} />
      </Card>
      <AddRecordDialog kind={adding} onClose={() => setAdding(null)} patientId={ws.patient.id} onSaved={onChanged} />
    </div>
  );
}

/** Answer values are codes or numbers; show the option label when we know it. */
function answerText(v: unknown, te: (p: string, v: string) => string): string {
  if (Array.isArray(v)) return v.map((x) => answerText(x, te)).join(', ');
  if (typeof v === 'boolean') return te('common.', v ? 'yes' : 'no');
  if (v === 'yes' || v === 'no') return te('common.', v);
  if (typeof v === 'string') return hasKey(`rf.${v}`) ? te('rf.', v) : v.replace(/_/g, ' ');
  if (v === null || v === undefined) return '—';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function EpisodesTab({ ws }: { ws: Workspace }) {
  const { t, te, pick, fmt } = useLocale();
  if (!ws.episodes.length) return <EmptyState title={t('pv.noEpisodes')} />;
  return (
    <div className="space-y-3">
      {[...ws.episodes]
        .sort((a, b) => b.started_at.localeCompare(a.started_at))
        .map((ep) => (
          <EpisodeRow key={ep.id} ep={ep}>
            {ep.assessment && (
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                <div className="space-y-3 rounded-xl bg-surface-2 p-3">
                  <CareLevelScale level={ep.assessment.care_level} showLabel />
                  {ep.assessment.specialty && <div className="text-xs text-fg-muted">{te('spec.', ep.assessment.specialty)}</div>}
                  {ep.assessment.rules_fired.length > 0 && (
                    <div className="text-xs text-fg-muted">
                      <span className="font-medium">{t('pv.rulesFired')}:</span>{' '}
                      {ep.assessment.rules_fired.map((r) => (
                        <span key={r} title={r} className="me-1 inline-block rounded bg-surface px-1.5 py-0.5">
                          {te('rule.', r)}
                        </span>
                      ))}
                    </div>
                  )}
                  {ep.assessment.red_flags.length > 0 && (
                    <div className="text-xs text-danger-fg">
                      <span className="font-medium">{t('ca.redFlags')}:</span> {fmt.list(ep.assessment.red_flags.map((f) => te('rf.', f)))}
                    </div>
                  )}
                  {ep.assessment.explanation && <AiBlock pro>{pick(ep.assessment.explanation.en, ep.assessment.explanation.ar)}</AiBlock>}
                </div>
                <div className="rounded-xl bg-surface-2 p-3">
                  <div className="mb-1.5 text-xs font-medium text-fg-muted">{t('pv.answers')}</div>
                  <dl className="space-y-1 text-xs">
                    {Object.entries(ep.answers).map(([k, v]) => (
                      <div key={k} className="flex gap-2">
                        <dt className="shrink-0 text-fg-muted">{hasKey(`q.${k}`) ? t(`q.${k}` as TKey) : k.replace(/_/g, ' ')}:</dt>
                        <dd className="font-medium break-words">
                          <bdi>{answerText(v, te)}</bdi>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </div>
            )}
          </EpisodeRow>
        ))}
    </div>
  );
}

function ReferralsTab({ ws, onChanged }: { ws: Workspace; onChanged: () => void }) {
  const { t } = useLocale();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState(ws.referrals);
  // follow the workspace when it reloads (another tab changed something, or a referral was created)
  useEffect(() => setList(ws.referrals), [ws.referrals]);
  return (
    <Card>
      <CardHeader title={t('pv.referrals')} action={hasRole(user?.role, CLINICIAN_ROLES) ? <NewReferralButton onClick={() => setOpen(true)} /> : undefined} />
      {list.length === 0 ? (
        <EmptyState compact title={t('care.noReferrals')} />
      ) : (
        <div className="space-y-2">
          {list.map((r) => (
            <ReferralRow key={r.id} pro r={r} action={<ReferralStatusControl r={r} onUpdated={(n) => setList((xs) => xs.map((x) => (x.id === n.id ? n : x)))} />} />
          ))}
        </div>
      )}
      <CreateReferralDialog
        open={open}
        onClose={() => setOpen(false)}
        patientId={ws.patient.id}
        onCreated={(r) => {
          setList((xs) => [r, ...xs]);
          onChanged();
        }}
      />
    </Card>
  );
}

function TimelineTab({ ws }: { ws: Workspace }) {
  const { t } = useLocale();
  const timeline = useApi('clinical', 'timeline', { patient_id: ws.patient.id, limit: 200 });
  return (
    <Card>
      <CardHeader title={t('pv.timeline')} />
      <Async state={timeline} skeleton={<SkeletonList rows={5} />} empty={<EmptyState compact title={t('health.noTimeline')} />}>
        {(items) => <TimelineList items={items} />}
      </Async>
    </Card>
  );
}
