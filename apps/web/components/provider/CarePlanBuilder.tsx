'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, History, Plus, Save, Send, Trash2 } from 'lucide-react';
import type { CarePlan, CarePlanItem, CarePlanTargets, UUID } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { CLINICIAN_ROLES, hasRole } from '@/lib/roles';
import { useAuth } from '@/lib/auth';
import { SuggestedTargetsButton } from './PersonalCards';
import { useApi, useMutation } from '@/lib/useApi';
import type { TKey } from '@/lib/i18n';
import { Card, CardHeader } from '../Card';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { Field, Input, Select, Textarea } from '../Field';
import { Async } from '../Async';
import { EmptyState, InlineError } from '../EmptyState';
import { SkeletonList } from '../Skeleton';
import { CarePlanView } from '../domain/CarePlanView';
import { ConfirmDialog } from '../ConfirmDialog';
import { useToast } from '../Toast';

const ITEM_KINDS: CarePlanItem['kind'][] = ['monitoring', 'medication', 'lifestyle', 'education', 'screening', 'appointment'];

const TARGET_FIELDS: { key: keyof CarePlanTargets; label: TKey; step?: number }[] = [
  { key: 'fasting_low', label: 'plan.fastingLow' },
  { key: 'fasting_high', label: 'plan.fastingHigh' },
  { key: 'post_meal_high', label: 'plan.postMealHigh' },
  { key: 'tir_target', label: 'plan.tirTarget' },
  { key: 'hba1c_target', label: 'plan.a1cTarget', step: 0.1 },
  { key: 'bp_systolic', label: 'plan.bpSys' },
  { key: 'bp_diastolic', label: 'plan.bpDia' },
  { key: 'steps_target', label: 'plan.steps' },
  { key: 'tbr_max', label: 'plan.tbrMax', step: 0.5 },
];

const DEFAULT_TARGETS: CarePlanTargets = {
  fasting_low: 80,
  fasting_high: 130,
  post_meal_high: 180,
  tir_target: 70,
  hba1c_target: 7,
  bp_systolic: 130,
  bp_diastolic: 80,
  steps_target: 7000,
};

/**
 * Care plan builder for clinicians: targets form, item list editor, save draft, publish,
 * and version history.
 */
export function CarePlanBuilder({
  patientId,
  active,
  draft,
  onChanged,
  onDirtyChange,
}: {
  patientId: UUID;
  active: CarePlan | null;
  draft: CarePlan | null;
  onChanged: () => void;
  /** Called when the form gets (or loses) changes that are not saved yet. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t, te } = useLocale();
  const { user } = useAuth();
  // Drafts: doctors and nurses (care.save_plan_draft); publishing: the doctor (care.publish_plan).
  const canDraft = hasRole(user?.role, CLINICIAN_ROLES);
  const canPublish = user?.role === 'doctor';
  const toast = useToast();
  const { mutate, pending, error } = useMutation();
  const history = useApi('care', 'plan_history', { patient_id: patientId });
  const base = draft ?? active;
  const defaultTitle = t('plan.defaultTitle');
  const [confirmPublish, setConfirmPublish] = useState(false);
  // the form as last loaded or saved; any difference from it is an unsaved change
  const savedSnapshot = useRef('');

  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [summaryAr, setSummaryAr] = useState('');
  const [targets, setTargets] = useState<CarePlanTargets>(DEFAULT_TARGETS);
  const [items, setItems] = useState<CarePlanItem[]>([]);
  const [savedDraft, setSavedDraft] = useState<CarePlan | null>(draft);
  const [action, setAction] = useState<'save' | 'publish' | null>(null);

  useEffect(() => {
    const next = {
      title: base?.title ?? defaultTitle,
      summary: base?.summary ?? '',
      summaryAr: base?.summary_ar ?? '',
      targets: base?.targets ?? DEFAULT_TARGETS,
      items: base?.items.map((i) => ({ ...i })) ?? [],
    };
    setTitle(next.title);
    setSummary(next.summary);
    setSummaryAr(next.summaryAr);
    setTargets(next.targets);
    setItems(next.items);
    setSavedDraft(draft);
    savedSnapshot.current = JSON.stringify(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base?.id, base?.version]);

  const snapshot = useMemo(() => JSON.stringify({ title, summary, summaryAr, targets, items }), [title, summary, summaryAr, targets, items]);
  const dirty = savedSnapshot.current !== '' && snapshot !== savedSnapshot.current;

  // Tell the workspace (tab switch guard) and guard closing the page or following a link while changes are unsaved.
  const dirtyCb = useRef(onDirtyChange);
  dirtyCb.current = onDirtyChange;
  useEffect(() => {
    dirtyCb.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => dirtyCb.current?.(false), []);
  const leaveText = t('plan.leaveBody');
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    // in-app links (side menu, patient list): ask before leaving the page
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || a.origin !== window.location.origin) return;
      if (a.pathname === window.location.pathname) return;
      if (!window.confirm(leaveText)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty, leaveText]);

  const setItem = (i: number, patch: Partial<CarePlanItem>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i: number, d: -1 | 1) =>
    setItems((xs) => {
      const j = i + d;
      if (j < 0 || j >= xs.length) return xs;
      const copy = [...xs];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });

  async function saveDraft(): Promise<CarePlan | null> {
    setAction('save');
    try {
      const plan = await mutate('care', 'save_plan_draft', {
        patient_id: patientId,
        title: title.trim() || defaultTitle,
        summary: summary.trim() || undefined,
        summary_ar: summaryAr.trim() || undefined,
        targets,
        items: items.filter((i) => i.title.trim()),
      });
      setSavedDraft(plan);
      savedSnapshot.current = snapshot;
      toast(t('plan.draftSaved'));
      onChanged();
      return plan;
    } catch {
      return null;
    } finally {
      setAction(null);
    }
  }

  async function publish() {
    const plan = await saveDraft();
    if (!plan) return;
    setAction('publish');
    try {
      await mutate('care', 'publish_plan', { plan_id: plan.id });
      toast(t('plan.published'));
      onChanged();
      void history.reload(true);
    } catch {
      /* inline */
    } finally {
      setAction(null);
    }
  }

  return (
    <div className="grid gap-4 2xl:grid-cols-[1fr_24rem]">
      <Card>
        <CardHeader
          title={t('plan.builder')}
          action={savedDraft ? <Badge tone="warn">{t('care.planVersion', { v: savedDraft.version })} · {te('plan.status.', savedDraft.status)}</Badge> : undefined}
        />
        <div className="space-y-5">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t('plan.title')} className="md:col-span-2">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label={t('plan.summary')}>
              <Textarea dir="ltr" className="min-h-20" value={summary} onChange={(e) => setSummary(e.target.value)} />
            </Field>
            <Field label={t('plan.summaryAr')}>
              <Textarea dir="rtl" className="min-h-20" value={summaryAr} onChange={(e) => setSummaryAr(e.target.value)} />
            </Field>
          </div>

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold">{t('care.targets')}</span>
              <SuggestedTargetsButton patientId={patientId} onUse={(s) => setTargets((cur) => ({ ...cur, ...s }))} />
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {TARGET_FIELDS.map((f) => (
                <Field key={f.key} label={t(f.label)}>
                  <Input
                    type="number"
                    step={f.step ?? 1}
                    dir="ltr"
                    value={targets[f.key] ?? ''}
                    onChange={(e) =>
                      setTargets((s) => ({ ...s, [f.key]: e.target.value === '' ? undefined : Number(e.target.value) }))
                    }
                  />
                </Field>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold">{t('care.items')}</span>
              <Button size="xs" variant="soft" icon={<Plus className="size-3.5" />} onClick={() => setItems((xs) => [...xs, { kind: 'monitoring', title: '', title_ar: '', detail: '' }])}>
                {t('plan.addItem')}
              </Button>
            </div>
            {items.length === 0 ? (
              <EmptyState compact title={t('plan.noItems')} />
            ) : (
              <ul className="space-y-2">
                {items.map((it, i) => {
                  // dense row: placeholders are not labels, so each field also has a hidden label with the item number
                  const n = i + 1;
                  return (
                    <li key={i} className="grid gap-2 rounded-xl border border-line p-3 md:grid-cols-[9rem_1fr_1fr_6rem_auto]">
                      <label>
                        <span className="visually-hidden">{t('plan.itemKindN', { n })}</span>
                        <Select value={it.kind} onChange={(e) => setItem(i, { kind: e.target.value as CarePlanItem['kind'] })}>
                          {ITEM_KINDS.map((k) => (
                            <option key={k} value={k}>
                              {te('item.', k)}
                            </option>
                          ))}
                        </Select>
                      </label>
                      <label>
                        <span className="visually-hidden">{t('plan.itemTitleN', { n })}</span>
                        <Input placeholder={t('plan.itemTitle')} dir="ltr" value={it.title} onChange={(e) => setItem(i, { title: e.target.value })} />
                      </label>
                      <label>
                        <span className="visually-hidden">{t('plan.itemTitleArN', { n })}</span>
                        <Input placeholder={t('plan.itemTitleAr')} dir="rtl" value={it.title_ar ?? ''} onChange={(e) => setItem(i, { title_ar: e.target.value })} />
                      </label>
                      <label>
                        <span className="visually-hidden">{t('plan.timesPerDayN', { n })}</span>
                        <Input
                          type="number"
                          min={0}
                          dir="ltr"
                          placeholder={t('plan.timesPerDay')}
                          value={it.schedule?.times_per_day ?? ''}
                          onChange={(e) =>
                            setItem(i, { schedule: e.target.value ? { ...(it.schedule ?? {}), times_per_day: Number(e.target.value) } : null })
                          }
                        />
                      </label>
                      <div className="flex items-center gap-0.5">
                        <Button size="xs" variant="ghost" aria-label={t('plan.moveUpN', { n })} disabled={i === 0} onClick={() => move(i, -1)} icon={<ArrowUp className="size-3.5" />} />
                        <Button size="xs" variant="ghost" aria-label={t('plan.moveDownN', { n })} disabled={i === items.length - 1} onClick={() => move(i, 1)} icon={<ArrowDown className="size-3.5" />} />
                        <Button size="xs" variant="ghost" aria-label={t('plan.removeN', { n })} onClick={() => setItems((xs) => xs.filter((_, j) => j !== i))} icon={<Trash2 className="size-3.5 text-danger" />} />
                      </div>
                      <label className="md:col-span-5">
                        <span className="visually-hidden">{t('plan.itemDetailN', { n })}</span>
                        <Input placeholder={t('plan.itemDetail')} value={it.detail ?? ''} onChange={(e) => setItem(i, { detail: e.target.value })} />
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <InlineError error={error} />
          <div className="flex flex-wrap items-center justify-end gap-2">
            {dirty && <span className="me-auto text-sm font-medium text-warn-fg">{t('plan.unsaved')}</span>}
            {!canDraft && <span className="me-auto text-sm text-fg-muted">{t('plan.readOnly')}</span>}
            {canDraft && (
              <Button variant="outline" icon={<Save className="size-4" />} loading={pending && action === 'save'} onClick={() => void saveDraft()}>
                {t('plan.saveDraft')}
              </Button>
            )}
            {canPublish && (
              <Button icon={<Send className="size-4" />} loading={pending && action === 'publish'} onClick={() => setConfirmPublish(true)}>
                {t('plan.publish')}
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* Publishing replaces the plan the patient sees: show exactly what they will see first. */}
      <ConfirmDialog
        open={confirmPublish}
        onClose={() => setConfirmPublish(false)}
        title={t('plan.publishTitle')}
        body={t('plan.publishBody')}
        confirmLabel={t('plan.publish')}
        danger={false}
        onConfirm={publish}
      >
        <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-line p-3">
          <CarePlanView plan={previewPlan(patientId, savedDraft ?? base, { title: title.trim() || defaultTitle, summary, summaryAr, targets, items })} />
        </div>
      </ConfirmDialog>

      <div className="space-y-4">
        <Card>
          <CardHeader title={t('plan.current')} />
          {active ? <CarePlanView plan={active} /> : <EmptyState compact title={t('care.noPlan')} />}
        </Card>
        <Card>
          <CardHeader title={t('plan.history')} icon={<History className="size-5" />} />
          <Async state={history} skeleton={<SkeletonList rows={3} />} empty={<EmptyState compact title={t('plan.noHistory')} />}>
            {(list) => <PlanHistory list={list} />}
          </Async>
        </Card>
      </div>
    </div>
  );
}

/** The form as a plan object, for the publish preview (CarePlanView). */
function previewPlan(
  patientId: UUID,
  base: CarePlan | null,
  f: { title: string; summary: string; summaryAr: string; targets: CarePlanTargets; items: CarePlanItem[] },
): CarePlan {
  return {
    id: base?.id ?? 'preview',
    patient_id: patientId,
    version: (base?.version ?? 0) + (base?.status === 'DRAFT' ? 0 : 1),
    status: 'DRAFT',
    title: f.title,
    summary: f.summary.trim() || null,
    summary_ar: f.summaryAr.trim() || null,
    targets: f.targets,
    items: f.items.filter((i) => i.title.trim()),
    authored_by: base?.authored_by ?? null,
    published_at: null,
    what_changed: null,
  };
}

function PlanHistory({ list }: { list: CarePlan[] }) {
  const { t, te, fmt } = useLocale();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="space-y-2">
      {[...list]
        .sort((a, b) => b.version - a.version)
        .map((p) => (
          <li key={p.id} className="rounded-xl border border-line">
            <button type="button" className="flex w-full items-center justify-between gap-2 p-3 text-start" onClick={() => setOpen(open === p.id ? null : p.id)}>
              <div>
                <div className="text-sm font-medium">
                  {t('care.planVersion', { v: p.version })} · {p.title}
                </div>
                <div className="text-xs text-fg-muted">
                  {p.published_at ? fmt.date(p.published_at) : '—'}
                  {p.authored_by && <> · {p.authored_by}</>}
                </div>
              </div>
              <Badge tone={p.status === 'ACTIVE' ? 'ok' : p.status === 'DRAFT' ? 'warn' : 'neutral'}>{te('plan.status.', p.status)}</Badge>
            </button>
            {open === p.id && (
              <div className="border-t border-line p-3">
                <CarePlanView plan={p} />
              </div>
            )}
          </li>
        ))}
    </ul>
  );
}
