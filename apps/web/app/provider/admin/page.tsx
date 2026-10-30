'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Archive, BookOpen, Bot, CheckCircle2, CircleDashed, ExternalLink, Eye, FileJson, History, Lock, Plus, Radio, Scale, ShieldCheck, Siren, UserCog, XCircle } from 'lucide-react';
import type { AiRun, Locale, RagDocument, Role, StaffUser } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import { ADMIN_ROLES, KB_APPROVER_ROLES, PLATFORM_ROLES, USER_ADMIN_ROLES, hasRole } from '@/lib/roles';
import { cn } from '@/lib/cn';
import { Card, CardHeader, PageHeader } from '@/components/Card';
import { Badge, type BadgeTone } from '@/components/Badge';
import { Button } from '@/components/Button';
import { Dialog } from '@/components/Dialog';
import { Field, Input, Select, Textarea } from '@/components/Field';
import { Tabs } from '@/components/Tabs';
import { Async } from '@/components/Async';
import { EmptyState, InlineError } from '@/components/EmptyState';
import { SkeletonCard, SkeletonList } from '@/components/Skeleton';
import { GuidelineSources } from '@/components/admin/GuidelineSources';
import { IncidentsTab, QualityTab } from '@/components/admin/Quality';
import { PrivacyTab } from '@/components/admin/Privacy';
import { MonitoringTab } from '@/components/admin/Monitoring';
import { LOCATION_EVENT } from '@/components/NotificationBell';
import { ConfirmDialog, useConfirm } from '@/components/ConfirmDialog';
import { useErrorToast, useToast } from '@/components/Toast';

type Tab = 'users' | 'audit' | 'monitoring' | 'incidents' | 'quality' | 'privacy' | 'kb' | 'runs' | 'rules' | 'outbox';
const TABS: Tab[] = ['users', 'audit', 'monitoring', 'incidents', 'quality', 'privacy', 'kb', 'runs', 'rules', 'outbox'];

export default function AdminPage() {
  const { user } = useAuth();
  const { t } = useLocale();
  const [tab, setTab] = useState<Tab>('users');

  // ?tab=kb (links, notifications). Also re-read when a notification opens another tab of this same page.
  useEffect(() => {
    const read = () => {
      const p = new URLSearchParams(window.location.search).get('tab');
      if (p && (TABS as string[]).includes(p)) setTab(p as Tab);
    };
    read();
    window.addEventListener(LOCATION_EVENT, read);
    window.addEventListener('popstate', read);
    return () => {
      window.removeEventListener(LOCATION_EVENT, read);
      window.removeEventListener('popstate', read);
    };
  }, []);

  if (!hasRole(user?.role, ADMIN_ROLES)) {
    return <EmptyState title={t('adm.forbidden')} icon={<Lock className="size-7" />} />;
  }

  const platform = hasRole(user?.role, PLATFORM_ROLES);
  return (
    <div>
      <PageHeader title={t('pv.admin')} />
      <Tabs<Tab>
        className="mb-4"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'users', label: t('adm.users'), icon: <UserCog className="size-4" /> },
          { id: 'audit', label: t('adm.audit'), icon: <History className="size-4" /> },
          { id: 'monitoring' as Tab, label: t('mon.tab'), icon: <Radio className="size-4" /> },
          ...(platform ? [{ id: 'incidents' as Tab, label: t('adm.incidents'), icon: <Siren className="size-4" /> }] : []),
          ...(platform ? [{ id: 'quality' as Tab, label: t('q.tab'), icon: <Scale className="size-4" /> }] : []),
          ...(platform ? [{ id: 'privacy' as Tab, label: t('priv.tab'), icon: <ShieldCheck className="size-4" /> }] : []),
          { id: 'kb', label: t('adm.kb'), icon: <BookOpen className="size-4" /> },
          { id: 'runs', label: t('adm.aiRuns'), icon: <Bot className="size-4" /> },
          { id: 'rules', label: t('adm.rules'), icon: <FileJson className="size-4" /> },
          ...(platform ? [{ id: 'outbox' as Tab, label: t('adm.outbox'), icon: <Radio className="size-4" /> }] : []),
        ]}
      />
      {tab === 'users' && <Users />}
      {tab === 'audit' && <Audit />}
      {tab === 'monitoring' && <MonitoringTab />}
      {tab === 'incidents' && platform && <IncidentsTab />}
      {tab === 'quality' && platform && <QualityTab />}
      {tab === 'privacy' && platform && <PrivacyTab />}
      {tab === 'kb' && <KnowledgeBaseTab />}
      {tab === 'runs' && <AiRuns />}
      {tab === 'rules' && <Rules />}
      {tab === 'outbox' && platform && <Outbox />}
    </div>
  );
}

/* ------------------------------------------------------------ knowledge base */

const RAG_TONE: Record<RagDocument['status'], BadgeTone> = { draft: 'warn', approved: 'ok', retired: 'neutral' };

function KnowledgeBaseTab() {
  const [version, setVersion] = useState(0);
  return (
    <div className="space-y-4">
      <GuidelineSources onChanged={() => setVersion((v) => v + 1)} />
      <KnowledgeBase key={version} />
    </div>
  );
}

function KnowledgeBase() {
  const { t, te, fmt } = useLocale();
  const { user } = useAuth();
  const toast = useToast();
  const errorToast = useErrorToast();
  const q = useApi('admin', 'rag_list', {});
  const { mutate } = useMutation();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [viewing, setViewing] = useState<RagDocument | null>(null);
  const retire = useConfirm<RagDocument>();
  // approving or retiring changes what AI answers are based on: safety officers and clinic administrators only
  const canDecide = hasRole(user?.role, KB_APPROVER_ROLES);

  async function act(doc: RagDocument, action: 'rag_approve' | 'rag_retire') {
    setBusy(doc.id + action);
    try {
      const next = action === 'rag_approve' ? await mutate('admin', 'rag_approve', { document_id: doc.id }) : await mutate('admin', 'rag_retire', { document_id: doc.id });
      q.setData((xs) => (xs ? xs.map((x) => (x.id === next.id ? next : x)) : xs));
      toast(t('common.saved'));
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader
        title={t('adm.kb')}
        action={
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            {t('adm.newDoc')}
          </Button>
        }
      />
      <Async state={q} skeleton={<SkeletonList rows={4} />} empty={<EmptyState compact title={t('adm.noDocs')} />}>
        {(docs) => (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <thead className="text-xs text-fg-muted">
                <tr className="border-b border-line">
                  <th className="py-2 text-start font-medium">{t('common.title')}</th>
                  <th className="py-2 text-start font-medium">{t('common.source')}</th>
                  <th className="py-2 text-start font-medium">{t('common.version')}</th>
                  <th className="py-2 text-start font-medium">{t('common.language')}</th>
                  <th className="py-2 text-end font-medium">{t('adm.chunks')}</th>
                  <th className="py-2 text-start font-medium">{t('adm.reviewDate')}</th>
                  <th className="py-2 text-start font-medium">{t('common.status')}</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td className="py-2.5 pe-3">
                      <div className="font-medium">{d.title}</div>
                      <div className="text-xs text-fg-subtle">
                        {[d.region, d.population].filter(Boolean).join(' · ')} {fmt.date(d.created_at)}
                      </div>
                      {d.origin === 'fetched' && (
                        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs">
                          <Badge tone="info">{t('gl.fetchedBadge')}</Badge>
                          {d.screening && d.screening.verdict !== 'clean' && <Badge tone="danger">{t('gl.flaggedShort')}</Badge>}
                          {d.source_url && (
                            <a href={d.source_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                              {d.external_ids?.doi ? 'doi:' + d.external_ids.doi : d.publisher}
                            </a>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 pe-3 text-fg-muted">{d.source}</td>
                    <td className="tabular-nums py-2.5 pe-3">{d.version}</td>
                    <td className="py-2.5 pe-3 uppercase">{d.language}</td>
                    <td className="tabular-nums py-2.5 pe-3 text-end">{d.chunks}</td>
                    <td className={cn('py-2.5 pe-3 text-xs', d.review_date && new Date(d.review_date) < new Date() ? 'text-warn' : 'text-fg-muted')}>
                      {d.review_date ? fmt.date(d.review_date) : '—'}
                    </td>
                    <td className="py-2.5 pe-3">
                      <Badge tone={RAG_TONE[d.status]}>{te('rag.', d.status)}</Badge>
                    </td>
                    <td className="py-2.5 text-end">
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button size="xs" variant="ghost" icon={<Eye className="size-3.5" />} onClick={() => setViewing(d)}>
                          {t('common.view')}
                        </Button>
                        {canDecide && d.status === 'draft' && d.origin !== 'fetched' && (
                          // four eyes: the person who added a document cannot approve it
                          <span className="inline-flex flex-col items-end gap-0.5">
                            <Button
                              size="xs"
                              icon={<CheckCircle2 className="size-3.5" />}
                              loading={busy === d.id + 'rag_approve'}
                              disabled={!!d.created_by && d.created_by === user?.id}
                              aria-describedby={d.created_by && d.created_by === user?.id ? `own-${d.id}` : undefined}
                              onClick={() => void act(d, 'rag_approve')}
                            >
                              {t('adm.approve')}
                            </Button>
                            {d.created_by && d.created_by === user?.id && (
                              <span id={`own-${d.id}`} className="max-w-[12rem] text-end text-[0.7rem] leading-4 text-fg-muted">
                                {t('adm.secondApprover')}
                              </span>
                            )}
                          </span>
                        )}
                        {d.status === 'draft' && d.origin === 'fetched' && <span className="text-xs text-fg-muted">{t('gl.approveEditionFirst')}</span>}
                        {canDecide && d.status !== 'retired' && (
                          <Button size="xs" variant="ghost" icon={<Archive className="size-3.5" />} loading={busy === d.id + 'rag_retire'} onClick={() => retire.ask(d)}>
                            {t('adm.retire')}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Async>
      <CreateDocDialog open={creating} onClose={() => setCreating(false)} onCreated={(d) => q.setData((xs) => [d, ...(xs ?? [])])} />
      <DocumentViewer doc={viewing} onClose={() => setViewing(null)} />
      <ConfirmDialog
        open={retire.open}
        onClose={retire.close}
        title={t('adm.retireTitle', { title: retire.target?.title ?? '' })}
        body={t('adm.retireBody')}
        confirmLabel={t('adm.retire')}
        onConfirm={() => (retire.target ? act(retire.target, 'rag_retire') : undefined)}
      />
    </Card>
  );
}

/** What `admin.rag_get` answers: the document with its full text (the list holds metadata only). */
type RagDocumentWithContent = RagDocument & { content?: string | null };

/** Read-only view of a knowledge-base document: where it comes from, how it was screened, and its text. */
function DocumentViewer({ doc, onClose }: { doc: RagDocument | null; onClose: () => void }) {
  const { t, te, fmt } = useLocale();
  const { mutate, pending, error, clearError } = useMutation();
  const [full, setFull] = useState<RagDocumentWithContent | null>(null);

  useEffect(() => {
    setFull(null);
    clearError();
    if (!doc) return;
    let live = true;
    mutate('admin', 'rag_get', { document_id: doc.id })
      .then((d) => {
        if (live && d && typeof d === 'object') setFull(d);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id]);

  const d: RagDocumentWithContent | null = full ?? doc;
  const content = full && typeof full.content === 'string' ? full.content : null;
  return (
    <Dialog
      open={!!doc}
      onClose={onClose}
      size="xl"
      title={d?.title ?? ''}
      description={d ? `${d.source} · ${t('common.version')} ${d.version} · ${d.language.toUpperCase()}` : undefined}
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}
    >
      {d && (
        <div className="space-y-4 text-sm">
          <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[10rem_1fr]">
            <dt className="text-fg-muted">{t('common.status')}</dt>
            <dd>
              <Badge tone={RAG_TONE[d.status]}>{te('rag.', d.status)}</Badge>
            </dd>
            {d.publisher && (
              <>
                <dt className="text-fg-muted">{t('adm.publisher')}</dt>
                <dd>{d.publisher}</dd>
              </>
            )}
            {(d.source_version || d.version) && (
              <>
                <dt className="text-fg-muted">{t('common.version')}</dt>
                <dd className="tabular-nums">{d.source_version ?? d.version}</dd>
              </>
            )}
            {d.source_url && (
              <>
                <dt className="text-fg-muted">{t('adm.sourceUrl')}</dt>
                <dd className="min-w-0">
                  <a href={d.source_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 break-all text-primary hover:underline" dir="ltr">
                    <ExternalLink className="size-3.5 shrink-0" aria-hidden />
                    {d.external_ids?.doi ? `doi:${d.external_ids.doi}` : d.source_url}
                  </a>
                </dd>
              </>
            )}
            <dt className="text-fg-muted">{t('adm.license')}</dt>
            <dd>
              {d.license ?? '—'}
              {d.license_confirmed_at && <span className="text-fg-muted"> · {t('adm.licenseConfirmedOn', { d: fmt.date(d.license_confirmed_at) })}</span>}
            </dd>
            {d.screening && (
              <>
                <dt className="text-fg-muted">{t('adm.screening')}</dt>
                <dd className="space-y-1">
                  <Badge tone={d.screening.verdict === 'clean' ? 'ok' : d.screening.verdict === 'block' ? 'danger' : 'warn'}>{te('adm.verdict.', d.screening.verdict)}</Badge>
                  {d.screening.signals.length > 0 && (
                    <ul className="list-inside list-disc text-xs text-fg-muted">
                      {d.screening.signals.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  )}
                </dd>
              </>
            )}
            {!!d.quarantined_chunks && (
              <>
                <dt className="text-fg-muted">{t('adm.quarantined')}</dt>
                <dd className="text-danger">{d.quarantined_chunks}</dd>
              </>
            )}
            <dt className="text-fg-muted">{t('adm.reviewDate')}</dt>
            <dd>{d.review_date ? fmt.date(d.review_date) : '—'}</dd>
          </dl>
          <div>
            <h3 className="mb-1.5 text-sm font-semibold">{t('adm.content')}</h3>
            {pending && !full ? (
              <SkeletonCard lines={6} />
            ) : content !== null ? (
              <pre dir="auto" className="max-h-[50vh] overflow-auto rounded-xl bg-surface-2 p-3 text-[13px] leading-6 whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
                {content}
              </pre>
            ) : (
              <div className="rounded-xl bg-surface-2 p-3 text-fg-muted">
                <InlineError error={error} />
                {!error && t('adm.contentUnavailable')}
              </div>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

function CreateDocDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (d: RagDocument) => void }) {
  const { t } = useLocale();
  const toast = useToast();
  const { mutate, pending, error } = useMutation();
  const [f, setF] = useState({ title: '', source: '', version: '1.0', language: 'en' as Locale, region: 'Egypt', population: 'adults_t2d', review_date: '', content: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const d = await mutate('admin', 'rag_create', {
        title: f.title.trim(),
        source: f.source.trim(),
        version: f.version.trim(),
        language: f.language,
        region: f.region.trim() || undefined,
        population: f.population.trim() || undefined,
        review_date: f.review_date || undefined,
        content: f.content,
      });
      toast(t('adm.created'));
      onCreated(d);
      setF((s) => ({ ...s, title: '', content: '' }));
      onClose();
    } catch {
      /* inline */
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title={t('adm.newDoc')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="rag-form" loading={pending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id="rag-form" onSubmit={submit} className="grid gap-4 md:grid-cols-3">
        <Field label={t('common.title')} className="md:col-span-2">
          <Input required value={f.title} onChange={set('title')} />
        </Field>
        <Field label={t('common.source')}>
          <Input required value={f.source} onChange={set('source')} placeholder="ADA Standards of Care 2026" />
        </Field>
        <Field label={t('common.version')}>
          <Input required dir="ltr" value={f.version} onChange={set('version')} />
        </Field>
        <Field label={t('common.language')}>
          <Select value={f.language} onChange={set('language')}>
            <option value="en">English</option>
            <option value="ar">العربية</option>
          </Select>
        </Field>
        <Field label={t('adm.reviewDate')}>
          <Input type="date" dir="ltr" value={f.review_date} onChange={set('review_date')} />
        </Field>
        <Field label={t('adm.region')}>
          <Input value={f.region} onChange={set('region')} />
        </Field>
        <Field label={t('adm.population')} className="md:col-span-2">
          <Input value={f.population} onChange={set('population')} />
        </Field>
        <Field label={t('adm.content')} className="md:col-span-3">
          <Textarea required dir="auto" className="min-h-80 font-mono text-[13px]" value={f.content} onChange={set('content')} />
        </Field>
        <div className="md:col-span-3">
          <InlineError error={error} />
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------ AI runs */

const RUN_TONE: Record<AiRun['status'], BadgeTone> = {
  BLOCKED: 'warn',
  QUEUED: 'neutral',
  PROCESSING: 'info',
  VERIFYING: 'info',
  COMPLETED: 'ok',
  FAILED: 'danger',
  FALLBACK: 'warn',
};

const RUN_STATUSES: AiRun['status'][] = ['COMPLETED', 'FALLBACK', 'BLOCKED', 'FAILED', 'VERIFYING', 'PROCESSING', 'QUEUED'];

/**
 * How an answer was released: verified (green), stopped or replaced (red), released without a verifier (amber),
 * fixed text instead of a model answer (grey).
 */
function releaseTone(release: string): BadgeTone {
  if (release === 'approved') return 'ok';
  if (release === 'rejected' || release === 'replaced_by_guard' || release.startsWith('withheld_')) return 'danger';
  if (release.startsWith('released_unverified') || release === 'released_local_unverified') return 'warn';
  return 'neutral'; // fixed_*, static_fallback
}
const PAGE_SIZE = 100;

function AiRuns() {
  const { t, te, fmt } = useLocale();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [status, setStatus] = useState('');
  const [workflow, setWorkflow] = useState('');
  const [release, setRelease] = useState('');
  const q = useApi('admin', 'ai_runs', { limit }, [], { keepPrevious: true });
  const workflows = [...new Set((q.data ?? []).map((r) => r.workflow))].sort();
  const releases = [...new Set((q.data ?? []).map((r) => r.release).filter((x): x is string => !!x))].sort();
  // fixed_local_<route>: one label for every route
  const releaseLabel = (x: string) => (x.startsWith('fixed_local_') ? t('release.fixed_local') : te('release.', x));
  return (
    <Card>
      <CardHeader title={t('adm.aiRuns')} action={<Button size="sm" variant="outline" onClick={() => void q.reload(true)}>{t('common.refresh')}</Button>} />
      <div className="mb-3 flex flex-wrap gap-2">
        <Select className="h-10 w-48 text-sm" aria-label={t('common.status')} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('common.status')}: {t('common.all')}</option>
          {RUN_STATUSES.map((x) => (
            <option key={x} value={x}>
              {te('run.', x)}
            </option>
          ))}
        </Select>
        <Select className="h-10 w-56 text-sm" aria-label={t('adm.workflow')} value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
          <option value="">{t('adm.workflow')}: {t('common.all')}</option>
          {workflows.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </Select>
        <Select className="h-10 w-56 text-sm" aria-label={t('adm.release')} value={release} onChange={(e) => setRelease(e.target.value)}>
          <option value="">{t('adm.release')}: {t('common.all')}</option>
          {releases.map((x) => (
            <option key={x} value={x}>
              {releaseLabel(x)}
            </option>
          ))}
        </Select>
      </div>
      <Async state={q} skeleton={<SkeletonList rows={6} />} empty={<EmptyState compact title={t('adm.noRuns')} />}>
        {(all) => {
          const runs = all.filter((r) => (!status || r.status === status) && (!workflow || r.workflow === workflow) && (!release || r.release === release));
          return (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[64rem] text-sm">
                <thead className="text-xs text-fg-muted">
                  <tr className="border-b border-line">
                    <th className="py-2 text-start font-medium">{t('common.created')}</th>
                    <th className="py-2 text-start font-medium">{t('adm.workflow')}</th>
                    <th className="py-2 text-start font-medium">{t('common.status')}</th>
                    <th className="py-2 text-start font-medium">{t('adm.release')}</th>
                    <th className="py-2 text-start font-medium">{t('adm.model')}</th>
                    <th className="py-2 text-end font-medium">{t('adm.latency')}</th>
                    <th className="py-2 text-start font-medium">{t('adm.verifier')}</th>
                    <th className="py-2 text-start font-medium">{t('adm.lastError')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {runs.map((r) => (
                    <tr key={r.id} className="align-top">
                      <td className="py-2.5 pe-3 text-xs text-fg-muted">{fmt.dateTime(r.created_at)}</td>
                      <td className="py-2.5 pe-3 font-medium">{r.workflow}</td>
                      <td className="py-2.5 pe-3">
                        <Badge tone={RUN_TONE[r.status]}>{te('run.', r.status)}</Badge>
                      </td>
                      <td className="py-2.5 pe-3">
                        {r.release ? <Badge tone={releaseTone(r.release)}>{releaseLabel(r.release)}</Badge> : <span className="text-fg-subtle">—</span>}
                        {r.risk && r.risk.length > 0 && (
                          <div className="mt-1 flex max-w-[14rem] flex-wrap gap-1" aria-label={t('adm.risk')}>
                            {r.risk.map((x) => (
                              <span key={x} className="rounded bg-surface-2 px-1.5 py-0.5 text-[0.7rem] leading-4 text-fg-muted">
                                {te('risk.', x)}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 pe-3 text-xs">{r.model ?? '—'}</td>
                      <td className="tabular-nums py-2.5 pe-3 text-end">{r.latency_ms === null ? '—' : `${fmt.number(r.latency_ms / 1000, 1)} s`}</td>
                      <td className="py-2.5 pe-3">
                        {r.verifier === null ? (
                          <span className="text-fg-subtle">—</span>
                        ) : (
                          <div>
                            {/* approved: the verifier checked and passed it; rejected: it failed; null: it was not checked */}
                            {r.verifier.approved === true ? (
                              <Badge tone="ok" icon={<CheckCircle2 className="size-3" />}>
                                {t('adm.approved')}
                              </Badge>
                            ) : r.verifier.approved === false ? (
                              <Badge tone="danger" icon={<XCircle className="size-3" />}>
                                {t('adm.rejected')}
                              </Badge>
                            ) : (
                              <Badge tone="neutral" icon={<CircleDashed className="size-3" />}>
                                {t('adm.notVerified')}
                              </Badge>
                            )}
                            {r.verifier.issues.length > 0 && (
                              <ul className="mt-1 list-inside list-disc text-xs text-fg-muted">
                                {r.verifier.issues.map((x, i) => (
                                  <li key={i}>{x}</li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="max-w-xs py-2.5 text-xs break-words text-danger-fg">{r.error ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {runs.length === 0 && <EmptyState compact className="mt-3" title={t('adm.noRuns')} />}
              {all.length >= limit && (
                <div className="mt-3 flex justify-center">
                  <Button size="sm" variant="outline" loading={q.loading} onClick={() => setLimit((n) => n + PAGE_SIZE)}>
                    {t('common.loadMore')}
                  </Button>
                </div>
              )}
            </div>
          );
        }}
      </Async>
    </Card>
  );
}

/* ------------------------------------------------------------ rules */

function Rules() {
  const { t } = useLocale();
  const q = useApi('admin', 'rules', {});
  return (
    <Async state={q} skeleton={<SkeletonCard lines={8} />} isEmpty={() => false}>
      {(r) => (
        <div className="space-y-4">
          <p className="text-sm text-fg-muted">{t('adm.readOnly')}</p>
          <div className="grid gap-4 xl:grid-cols-2">
            <JsonCard title={`${t('adm.safetyRules')} (${r.safety_rules.length})`} value={r.safety_rules} />
            <JsonCard title={`${t('adm.careLevelRules')} (${r.care_level_rules.length})`} value={r.care_level_rules} />
          </div>
        </div>
      )}
    </Async>
  );
}

function JsonCard({ title, value }: { title: string; value: unknown }) {
  // min-w-0: a grid item may shrink below its longest JSON line, which then scrolls inside the card.
  return (
    <Card className="min-w-0">
      <CardHeader title={title} icon={<FileJson className="size-5" />} />
      <pre dir="ltr" className="max-h-[32rem] max-w-full overflow-auto rounded-xl bg-surface-2 p-3 text-xs leading-5 whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
        {JSON.stringify(value, null, 2)}
      </pre>
    </Card>
  );
}

/* ------------------------------------------------------------ outbox */

function Outbox() {
  const { t, te, fmt } = useLocale();
  const q = useApi('admin', 'outbox', { limit: 100 });
  return (
    <Card>
      <CardHeader title={t('adm.outbox')} action={<Button size="sm" variant="outline" onClick={() => void q.reload()}>{t('common.retry')}</Button>} />
      <Async state={q} skeleton={<SkeletonList rows={6} />} empty={<EmptyState compact title={t('adm.noEvents')} />}>
        {(rows) => (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-sm">
              <thead className="text-xs text-fg-muted">
                <tr className="border-b border-line">
                  <th className="py-2 text-start font-medium">{t('adm.occurred')}</th>
                  <th className="py-2 text-start font-medium">{t('adm.event')}</th>
                  <th className="py-2 text-start font-medium">{t('common.status')}</th>
                  <th className="py-2 text-end font-medium">{t('adm.attempts')}</th>
                  <th className="py-2 text-start font-medium">{t('adm.lastError')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.event_id}>
                    <td className="py-2.5 pe-3 text-xs text-fg-muted">{fmt.dateTime(r.occurred_at)}</td>
                    <td className="py-2.5 pe-3 font-mono text-xs">{r.event_type}</td>
                    <td className="py-2.5 pe-3">
                      <Badge tone={r.status === 'published' || r.status === 'done' || r.status === 'sent' ? 'ok' : r.status === 'failed' || r.status === 'dead' ? 'danger' : 'neutral'}>
                        {te('outbox.', r.status)}
                      </Badge>
                    </td>
                    <td className={cn('tabular-nums py-2.5 pe-3 text-end', r.attempts > 3 && 'text-warn')}>{r.attempts}</td>
                    <td className="max-w-sm py-2.5 text-xs break-words text-danger-fg">{r.last_error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Async>
    </Card>
  );
}

/* ------------------------------------------------------------ users */

const STAFF_ROLES: Role[] = ['doctor', 'nurse', 'receptionist', 'clinic_admin', 'capacity_operator', 'transfer_coordinator', 'safety_officer', 'platform_admin'];

function Users() {
  const { t, te, fmt, pick } = useLocale();
  const toast = useToast();
  const errorToast = useErrorToast();
  const q = useApi('admin', 'users', {});
  const { mutate, mutateLoose } = useMutation();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const { user: me } = useAuth();
  // staff accounts are managed by clinic and platform administrators; a safety officer only reads the list
  const canManage = hasRole(me?.role, USER_ADMIN_ROLES);
  const canReset = canManage;
  const [resetFor, setResetFor] = useState<StaffUser | null>(null);
  const [tempPw, setTempPw] = useState<string | null>(null);
  const [resetReason, setResetReason] = useState('');
  const deactivate = useConfirm<StaffUser>();

  async function resetPassword() {
    if (!resetFor) return;
    setBusy(`reset-${resetFor.id}`);
    try {
      // the reason is recorded with the reset and shown to the person (the shared contract does not list it yet)
      const r = await mutateLoose<{ user_id: string; email: string; temporary_password: string }>('admin', 'reset_password', {
        user_id: resetFor.id,
        ...(resetReason.trim() ? { reason: resetReason.trim() } : {}),
      });
      setTempPw(r.temporary_password);
    } catch (e) {
      errorToast(e);
      setResetFor(null);
    } finally {
      setBusy(null);
    }
  }

  async function setActive(u: StaffUser, active: boolean) {
    setBusy(u.id);
    try {
      const next = await mutate('admin', 'set_user_active', { user_id: u.id, active });
      q.setData((xs) => (xs ? xs.map((x) => (x.id === next.id ? next : x)) : xs));
      toast(t('common.saved'));
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader
        title={t('adm.users')}
        action={
          canManage ? (
            <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              {t('adm.newUser')}
            </Button>
          ) : undefined
        }
      />
      <Input className="mb-3 h-10 max-w-xs text-sm" placeholder={t('common.search')} aria-label={t('common.search')} value={filter} onChange={(e) => setFilter(e.target.value)} />
      <Async state={q} skeleton={<SkeletonList rows={6} />} empty={<EmptyState compact title={t('adm.noUsers')} />}>
        {(users) => {
          const f = filter.trim().toLowerCase();
          const rows = users.filter((u) => !f || `${u.full_name} ${u.full_name_ar ?? ''} ${u.email} ${u.role}`.toLowerCase().includes(f));
          return (
            <div className="max-h-[70vh] overflow-auto rounded-xl border border-line">
              <table className="w-full min-w-[52rem] text-sm">
                <thead className="sticky top-0 z-10 bg-surface-2 text-xs text-fg-muted">
                  <tr>
                    <th className="px-3 py-2 text-start font-medium">{t('common.name')}</th>
                    <th className="px-3 py-2 text-start font-medium">{t('auth.email')}</th>
                    <th className="px-3 py-2 text-start font-medium">{t('common.role')}</th>
                    <th className="px-3 py-2 text-start font-medium">{t('adm.orgs')}</th>
                    <th className="px-3 py-2 text-start font-medium">{t('adm.mfa')}</th>
                    <th className="px-3 py-2 text-start font-medium">{t('common.status')}</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((u) => (
                    <tr key={u.id} className={cn(!u.active && 'opacity-60')}>
                      <td className="px-3 py-2">
                        <div className="font-medium">{pick(u.full_name, u.full_name_ar)}</div>
                        <div className="text-xs text-fg-subtle">{fmt.date(u.created_at)}</div>
                      </td>
                      <td className="px-3 py-2 text-xs" dir="ltr">
                        {u.email}
                      </td>
                      <td className="px-3 py-2">
                        <Badge>{te('role.', u.role)}</Badge>
                      </td>
                      <td className="px-3 py-2 text-xs text-fg-muted">{fmt.list(u.organizations) || '—'}</td>
                      <td className="px-3 py-2">
                        <Badge tone={u.mfa_enabled ? 'ok' : 'neutral'} icon={u.mfa_enabled ? <ShieldCheck className="size-3" aria-hidden /> : undefined}>
                          {u.mfa_enabled ? t('acc.mfaOn') : t('acc.mfaOff')}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={u.active ? 'ok' : 'neutral'}>{u.active ? t('adm.active') : t('adm.inactive')}</Badge>
                      </td>
                      <td className="px-3 py-2 text-end">
                        <div className="flex justify-end gap-1">
                          {canReset && u.active && u.id !== me?.id && u.role !== 'platform_admin' && (
                            <Button size="xs" variant="ghost" onClick={() => { setTempPw(null); setResetReason(''); setResetFor(u); }}>
                              {t('adm.resetPassword')}
                            </Button>
                          )}
                          {canManage && u.id !== me?.id && (
                            <Button
                              size="xs"
                              variant={u.active ? 'ghost' : 'soft'}
                              loading={busy === u.id}
                              onClick={() => (u.active ? deactivate.ask(u) : void setActive(u, true))}
                            >
                              {u.active ? t('adm.deactivate') : t('adm.activate')}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </Async>
      <Dialog
        open={!!resetFor}
        onClose={() => { setResetFor(null); setTempPw(null); }}
        size="sm"
        title={t('adm.resetTitle', { name: resetFor ? pick(resetFor.full_name, resetFor.full_name_ar) : '' })}
        footer={
          tempPw ? (
            <Button onClick={() => { setResetFor(null); setTempPw(null); }}>{t('common.done')}</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setResetFor(null)}>
                {t('common.cancel')}
              </Button>
              <Button variant="danger" loading={busy === `reset-${resetFor?.id}`} onClick={() => void resetPassword()}>
                {t('adm.resetConfirm')}
              </Button>
            </>
          )
        }
      >
        {tempPw ? (
          <div className="space-y-3">
            <p className="text-base leading-7">{t('adm.resetDone')}</p>
            <p className="num rounded-xl bg-surface-2 py-3 text-center font-mono text-2xl font-bold tracking-wider" dir="ltr">
              {tempPw}
            </p>
            <p className="text-sm text-fg-muted">{t('adm.resetShownOnce')}</p>
            <p className="text-sm text-fg-muted">{t('adm.resetNotified')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-base leading-7">{t('adm.resetBody')}</p>
            <Field label={`${t('adm.resetReason')} (${t('common.optional')})`} hint={t('adm.resetNotified')}>
              <Textarea rows={2} className="min-h-16" value={resetReason} onChange={(e) => setResetReason(e.target.value)} maxLength={300} />
            </Field>
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        open={deactivate.open}
        onClose={deactivate.close}
        title={t('adm.deactivateTitle', { name: deactivate.target ? pick(deactivate.target.full_name, deactivate.target.full_name_ar) : '' })}
        body={t('adm.deactivateBody')}
        confirmLabel={t('adm.deactivate')}
        onConfirm={() => (deactivate.target ? setActive(deactivate.target, false) : undefined)}
      />
      {canManage && (
        <CreateUserDialog open={creating} roles={STAFF_ROLES} onClose={() => setCreating(false)} onCreated={(u) => q.setData((xs) => [u, ...(xs ?? [])])} />
      )}
    </Card>
  );
}

function CreateUserDialog({ open, onClose, onCreated, roles }: { open: boolean; onClose: () => void; onCreated: (u: StaffUser) => void; roles: Role[] }) {
  const { t, te, pick } = useLocale();
  const toast = useToast();
  const { mutate, pending, error } = useMutation();
  const orgs = useApi('care', 'organizations', open ? {} : null);
  const [f, setF] = useState({ email: '', full_name: '', full_name_ar: '', role: 'nurse' as Role, organization_id: '', password: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const u = await mutate('admin', 'create_user', {
        email: f.email.trim().toLowerCase(),
        full_name: f.full_name.trim(),
        full_name_ar: f.full_name_ar.trim() || undefined,
        role: f.role,
        organization_id: f.organization_id || undefined,
        password: f.password,
      });
      toast(t('adm.userCreated'));
      onCreated(u);
      setF({ email: '', full_name: '', full_name_ar: '', role: 'nurse', organization_id: '', password: '' });
      onClose();
    } catch {
      /* inline */
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('adm.newUser')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="user-form" loading={pending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id="user-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label={t('reg.fullName')}>
          <Input required value={f.full_name} onChange={set('full_name')} />
        </Field>
        <Field label={`${t('reg.fullNameAr')} (${t('common.optional')})`}>
          <Input dir="rtl" value={f.full_name_ar} onChange={set('full_name_ar')} />
        </Field>
        <Field label={t('auth.email')} className="sm:col-span-2">
          <Input type="email" required dir="ltr" autoComplete="off" value={f.email} onChange={set('email')} />
        </Field>
        <Field label={t('common.role')}>
          <Select value={f.role} onChange={set('role')}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {te('role.', r)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`${t('adm.orgId')} (${t('common.optional')})`}>
          <Select value={f.organization_id} onChange={set('organization_id')} disabled={!orgs.data}>
            <option value="">—</option>
            {(orgs.data ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {pick(o.name, o.name_ar)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('adm.tempPassword')} hint={t('reg.passwordHint')} className="sm:col-span-2">
          <Input required dir="ltr" minLength={8} autoComplete="new-password" value={f.password} onChange={set('password')} />
        </Field>
        <div className="sm:col-span-2">
          <InlineError error={error} />
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------ audit */

const AUDIT_PAGE = 200;

function Audit() {
  const { t, fmt, te } = useLocale();
  const [patient, setPatient] = useState('');
  const [applied, setApplied] = useState('');
  const [limit, setLimit] = useState(AUDIT_PAGE);
  const [actionFilter, setActionFilter] = useState('');
  const q = useApi('admin', 'audit', { patient_id: applied || undefined, limit }, [], { keepPrevious: true });
  return (
    <Card>
      <CardHeader title={t('adm.audit')} action={<Button size="sm" variant="outline" onClick={() => void q.reload()}>{t('common.refresh')}</Button>} />
      <form
        className="mb-3 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(patient.trim());
        }}
      >
        <Input className="h-10 max-w-sm text-sm" dir="ltr" placeholder={t('adm.filterPatient')} aria-label={t('adm.filterPatient')} value={patient} onChange={(e) => setPatient(e.target.value)} />
        <Button type="submit" size="sm" variant="soft" className="h-10">
          {t('common.search')}
        </Button>
        {applied && (
          <Button size="sm" variant="ghost" className="h-10" onClick={() => { setPatient(''); setApplied(''); }}>
            {t('common.all')}
          </Button>
        )}
        <Input
          className="h-10 max-w-xs text-sm"
          placeholder={t('adm.filterAction')}
          aria-label={t('adm.filterAction')}
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
        />
      </form>
      <Async state={q} skeleton={<SkeletonList rows={6} />} empty={<EmptyState compact title={t('adm.noAudit')} />}>
        {(all) => {
          const f = actionFilter.trim().toLowerCase();
          const rows = f ? all.filter((r) => `${r.action} ${r.entity ?? ''} ${r.actor ?? ''}`.toLowerCase().includes(f)) : all;
          return (
            <>
              <div className="max-h-[70vh] overflow-auto rounded-xl border border-line">
                <table className="w-full min-w-[56rem] text-sm">
                  <thead className="sticky top-0 z-10 bg-surface-2 text-xs text-fg-muted">
                    <tr>
                      <th className="px-3 py-2 text-start font-medium">{t('common.time')}</th>
                      <th className="px-3 py-2 text-start font-medium">{t('adm.actor')}</th>
                      <th className="px-3 py-2 text-start font-medium">{t('adm.action')}</th>
                      <th className="px-3 py-2 text-start font-medium">{t('adm.entity')}</th>
                      <th className="px-3 py-2 text-start font-medium">{t('common.patient')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {rows.map((r, i) => (
                      <tr key={`${r.at}-${i}`} className={cn(/break|glass/i.test(r.action) && 'bg-danger-soft/60')}>
                        <td className="px-3 py-2 text-xs whitespace-nowrap text-fg-muted">{fmt.dateTime(r.at)}</td>
                        <td className="px-3 py-2">
                          <div className="font-medium">{r.actor ?? '—'}</div>
                          {r.role && <div className="text-xs text-fg-subtle">{te('role.', r.role)}</div>}
                        </td>
                        <td className="px-3 py-2 text-xs" title={r.action}>{r.action.replace(/[._]/g, ' ')}</td>
                        <td className="px-3 py-2 text-xs text-fg-muted">{r.entity ? r.entity.replace(/_/g, ' ') : '—'}</td>
                        <td className="px-3 py-2 text-xs">
                          {r.patient_id ? (
                            <span className="flex flex-wrap gap-2">
                              <button type="button" className="inline-flex min-h-6 items-center font-mono text-primary-strong hover:underline" onClick={() => { setPatient(r.patient_id!); setApplied(r.patient_id!); }} dir="ltr">
                                {r.patient_id.slice(0, 8)}…
                              </button>
                              <Link href={`/provider/patients/${r.patient_id}`} className="inline-flex min-h-6 items-center text-fg-muted hover:underline">
                                {t('pv.openWorkspace')}
                              </Link>
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {all.length >= limit && (
                <div className="mt-3 flex justify-center">
                  <Button size="sm" variant="outline" loading={q.loading} onClick={() => setLimit((n) => n + AUDIT_PAGE)}>
                    {t('common.loadMore')}
                  </Button>
                </div>
              )}
            </>
          );
        }}
      </Async>
    </Card>
  );
}
