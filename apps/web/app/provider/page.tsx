'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUp, Check, CheckCheck, ChevronRight, Eye, Inbox as InboxIcon, UserPlus, X } from 'lucide-react';
import type { InboxItem, LinkRequest } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { AiReviewQueue } from '@/components/provider/AiReviewQueue';
import { api } from '@/lib/api';
import { useApi, useMutation, useVisibleInterval } from '@/lib/useApi';
import { INBOX_ROLES, LINK_DECIDER_ROLES, hasRole } from '@/lib/roles';
import { cn } from '@/lib/cn';
import { inboxTarget, STATS_EVENT } from '@/lib/inbox';
import { plainCodes } from '@/lib/format';
import { PageHeader } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/Button';
import { Select } from '@/components/Field';
import { Segmented, Tabs } from '@/components/Tabs';
import { Async } from '@/components/Async';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonList } from '@/components/Skeleton';
import { UrgencyBadge } from '@/components/StatusBadges';
import { ConfirmDialog, useConfirm } from '@/components/ConfirmDialog';
import { useErrorToast, useToast } from '@/components/Toast';
import { usePage } from '@/lib/pageBundle';

/** The inbox looks for new items this often while it is on screen. */
const POLL_MS = 45_000;
const PAGE = 20; // rows shown before "Show more"

type StatusFilter = InboxItem['status'] | 'active';
type CatFilter = InboxItem['category'] | 'all';
type View = 'inbox' | 'join';
const CATEGORIES: InboxItem['category'][] = ['safety', 'glucose', 'result', 'question', 'verification', 'referral', 'care_plan', 'episode', 'ai_review'];
const STATUSES: StatusFilter[] = ['active', 'OPEN', 'ROUTED', 'ACKNOWLEDGED', 'ACTIONED', 'RESOLVED'];

export default function InboxPage() {
  const { user } = useAuth();
  const { t } = useLocale();
  const [view, setView] = useState<View>('inbox');
  const canDecide = hasRole(user?.role, LINK_DECIDER_ROLES);
  // One request for the clinician home (lib/pageBundle.ts): inbox, join requests, held answers, header counts, bell.
  usePage('provider', 'home', {}, [
    ['provider', 'inbox', { status: 'active' }, 'inbox'], ['provider', 'link_requests', {}, 'link_requests'],
    ['provider', 'ai_reviews', {}, 'ai_reviews'], ['provider', 'stats', {}, 'stats'], ['insights', 'notifications', {}, 'notifications', 2],
  ]);
  const requests = useApi('provider', 'link_requests', canDecide ? {} : null);
  const pendingCount = (requests.data ?? []).filter((r) => r.status === 'pending').length;

  useEffect(() => {
    if (canDecide && new URLSearchParams(window.location.search).get('view') === 'join') setView('join');
  }, [canDecide]);

  // operations roles have no clinical inbox; the layout sends them to their own home page
  if (!hasRole(user?.role, INBOX_ROLES)) return null;

  return (
    <div>
      {view === 'inbox' && <div className="mb-4"><AiReviewQueue /></div>}
      <PageHeader
        title={view === 'inbox' ? t('pv.inbox') : t('pv.joinRequests')}
        action={
          canDecide ? (
            <Segmented<View>
              value={view}
              onChange={setView}
              options={[
                { value: 'inbox', label: t('pv.inbox') },
                {
                  value: 'join',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      {t('pv.joinRequests')}
                      {pendingCount > 0 && <span className="num rounded-full bg-danger-solid px-1.5 text-xs leading-5 font-bold text-white">{pendingCount}</span>}
                    </span>
                  ),
                },
              ]}
            />
          ) : undefined
        }
      />
      {view === 'inbox' ? <InboxList /> : <JoinRequests state={requests} />}
    </div>
  );
}

function InboxList() {
  const { t, te, fmt } = useLocale();
  const errorToast = useErrorToast();
  const [status, setStatus] = useState<StatusFilter>('active');
  const [category, setCategory] = useState<CatFilter>('all');
  const input = { status, category: category === 'all' ? undefined : category };
  const q = useApi('provider', 'inbox', input);
  const { mutate } = useMutation();
  const [busy, setBusy] = useState<string | null>(null);
  // a newer copy of the list found by the background check; shown when the clinician asks for it
  const [fresh, setFresh] = useState<{ key: string; items: InboxItem[] } | null>(null);
  const resolve = useConfirm<InboxItem>();
  const inputKey = JSON.stringify(input);
  const [showAll, setShowAll] = useState(false);
  // Repeats (the same patient, kind and title) are one row with a count, so a burst of alerts does not bury the rest.
  const groups: InboxItem[][] = [];
  const groupOf = new Map<string, InboxItem[]>();
  {
    const byKey = new Map<string, InboxItem[]>();
    for (const it of [...(q.data ?? [])].sort((a, b) => a.priority - b.priority || b.created_at.localeCompare(a.created_at))) {
      const key = `${it.patient_id}|${it.category}|${plainCodes(it.title)}`;
      const g = byKey.get(key);
      if (g) g.push(it);
      else { const n = [it]; byKey.set(key, n); groups.push(n); }
    }
    for (const g of groups) groupOf.set(g[0].id, g);
  }

  // Check for new items in the background. The list on screen does not jump while someone reads or acts on it;
  // a banner says how many new items there are instead.
  useVisibleInterval(() => {
    if (!q.data) return;
    const key = inputKey;
    void api
      .call('provider', 'inbox', input)
      .then((items) => setFresh({ key, items }))
      .catch(() => undefined);
  }, POLL_MS);
  const known = new Set((q.data ?? []).map((x) => x.id));
  const newCount = fresh && fresh.key === inputKey ? fresh.items.filter((x) => !known.has(x.id)).length : 0;

  function showNew() {
    if (fresh && fresh.key === inputKey) q.setData(fresh.items);
    setFresh(null);
    window.dispatchEvent(new Event(STATS_EVENT));
  }

  /** Updates one row: the newest item and its repeats (same patient, kind and title) together. */
  async function update(item: InboxItem, next: InboxItem['status']) {
    const group = groupOf.get(item.id) ?? [item];
    setBusy(item.id + next);
    try {
      const done = new Map<string, InboxItem>();
      for (const it of group) {
        if (it.status === next || it.status === 'RESOLVED') continue;
        done.set(it.id, await mutate('provider', 'update_inbox', { item_id: it.id, status: next }));
      }
      q.setData((xs) => {
        if (!xs) return xs;
        if (status === 'active' && next === 'RESOLVED') return xs.filter((x) => !done.has(x.id));
        return xs.map((x) => done.get(x.id) ?? x);
      });
      // open and critical counts in the header follow the change
      window.dispatchEvent(new Event(STATS_EVENT));
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(null);
    }
  }

  /** Closing a critical or high-urgency item is confirmed first: it leaves the clinician's list. */
  function askResolve(item: InboxItem) {
    if (item.urgency === 'critical' || item.urgency === 'high') resolve.ask(item);
    else void update(item, 'RESOLVED');
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs<CatFilter>
          variant="pills"
          className="min-w-0 flex-1"
          value={category}
          onChange={setCategory}
          tabs={[{ id: 'all', label: t('common.all') }, ...CATEGORIES.map((c) => ({ id: c, label: te('cat.', c) }))]}
        />
        <label className="flex items-center gap-2 text-sm text-fg-muted">
          {t('common.status')}
          <Select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className="h-10 w-40 text-sm">
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {te('inbox.', s)}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <p className="mb-2 flex flex-wrap items-center gap-3 text-xs text-fg-muted">
        <span className="inline-flex items-center gap-1">
          <span className="num rounded-md border border-fg/30 bg-fg px-1.5 font-semibold text-bg">P1</span> {t('pv.priority')}
        </span>
        <span className="inline-flex items-center gap-1">
          <UrgencyBadge urgency="high" /> {t('pv.urgency')}
        </span>
      </p>

      {newCount > 0 && (
        <div className="sticky top-16 z-10 mb-3 flex justify-center">
          <Button size="sm" icon={<ArrowUp className="size-4" />} onClick={showNew} className="shadow-md" aria-live="polite">
            {t('pv.newItems', { n: newCount })}
          </Button>
        </div>
      )}
      <Async state={q} skeleton={<SkeletonList rows={6} />} empty={<EmptyState title={t('pv.inboxEmpty')} icon={<InboxIcon className="size-7" />} />}>
        {() => (
          <>
          <div className="overflow-hidden rounded-2xl border border-line bg-surface">
            <ul className="divide-y divide-line">
              {(showAll ? groups : groups.slice(0, PAGE)).map((g) => g[0]).map((it) => (
                  <li
                    key={it.id}
                    className={cn(
                      'flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-surface-2/60',
                      it.urgency === 'critical' && 'border-s-4 border-s-danger',
                      it.urgency === 'high' && 'border-s-4 border-s-danger/60',
                    )}
                  >
                    <Link href={inboxTarget(it)} className="group flex min-w-0 flex-1 items-start gap-3 rounded-lg text-start">
                      <div className="flex w-20 shrink-0 flex-col items-start gap-1">
                        <span
                          title={t('pv.priority')}
                          className={cn('num rounded-md border px-1.5 text-xs font-semibold', it.priority <= 2 ? 'border-fg/30 bg-fg text-bg' : 'border-line-strong text-fg-muted')}
                        >
                          {t('pv.priorityN', { n: it.priority })}
                        </span>
                        <span title={t('pv.urgency')}>
                          <UrgencyBadge urgency={it.urgency} />
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-semibold text-fg group-hover:underline">{it.patient_name}</span>
                          {(groupOf.get(it.id)?.length ?? 1) > 1 && <Badge tone="warn">{t('pv.repeats', { n: groupOf.get(it.id)!.length })}</Badge>}
                          <Badge>{te('cat.', it.category)}</Badge>
                          <Badge tone={it.status === 'OPEN' ? 'primary' : it.status === 'RESOLVED' ? 'ok' : 'neutral'}>{te('inbox.', it.status)}</Badge>
                        </div>
                        <div dir="auto" className="mt-0.5 text-sm text-fg">
                          {plainCodes(it.title)}
                        </div>
                        {it.body && (
                          <div dir="auto" className="line-clamp-2 text-xs text-fg-muted">
                            {plainCodes(it.body)}
                          </div>
                        )}
                        <div className="mt-0.5 text-xs text-fg-subtle">{fmt.relative(it.created_at)}</div>
                      </div>
                      <ChevronRight className="mt-1 hidden size-4 shrink-0 text-fg-subtle sm:block rtl:-scale-x-100" aria-hidden />
                    </Link>
                    <div className="flex shrink-0 gap-1.5">
                      {(it.status === 'OPEN' || it.status === 'ROUTED') && (
                        <Button size="xs" variant="outline" icon={<Eye className="size-3.5" />} loading={busy === it.id + 'ACKNOWLEDGED'} onClick={() => void update(it, 'ACKNOWLEDGED')}>
                          {t('pv.acknowledge')}
                        </Button>
                      )}
                      {it.status !== 'ACTIONED' && it.status !== 'RESOLVED' && (
                        <Button size="xs" variant="soft" icon={<Check className="size-3.5" />} loading={busy === it.id + 'ACTIONED'} onClick={() => void update(it, 'ACTIONED')}>
                          {t('pv.action')}
                        </Button>
                      )}
                      {it.status !== 'RESOLVED' && (
                        <Button size="xs" variant="primary" icon={<CheckCheck className="size-3.5" />} loading={busy === it.id + 'RESOLVED'} onClick={() => askResolve(it)}>
                          {t('pv.resolve')}
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
            </ul>
          </div>
          {!showAll && groups.length > PAGE && (
            <Button variant="ghost" className="mt-2" onClick={() => setShowAll(true)}>{t('pv.showAllRows', { n: groups.length - PAGE })}</Button>
          )}
          </>
        )}
      </Async>
      <ConfirmDialog
        open={resolve.open}
        onClose={resolve.close}
        title={t('pv.resolveTitle')}
        body={
          resolve.target ? (
            <>
              <p className="font-semibold">{resolve.target.patient_name}</p>
              <p dir="auto" className="mt-1">
                {plainCodes(resolve.target.title)}
              </p>
              <p className="mt-2 text-fg-muted">{t('pv.resolveBody')}</p>
            </>
          ) : null
        }
        confirmLabel={t('pv.resolve')}
        onConfirm={() => (resolve.target ? update(resolve.target, 'RESOLVED') : undefined)}
      />
    </>
  );
}

function JoinRequests({ state }: { state: ReturnType<typeof useApi<'provider', 'link_requests'>> }) {
  const { t, te, fmt } = useLocale();
  const toast = useToast();
  const errorToast = useErrorToast();
  const { mutate } = useMutation();
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(r: LinkRequest, decision: 'accept' | 'decline') {
    setBusy(r.id + decision);
    try {
      const next = await mutate('provider', 'decide_link', { request_id: r.id, decision });
      state.setData((xs) => (xs ? xs.map((x) => (x.id === r.id ? next : x)) : xs));
      toast(decision === 'accept' ? t('pv.joinAccepted') : t('pv.joinDeclined'));
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Async state={state} skeleton={<SkeletonList rows={3} />} empty={<EmptyState title={t('pv.noJoinRequests')} icon={<UserPlus className="size-7" />} />}>
      {(list) => (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {[...list]
            .sort((a, b) => Number(a.status !== 'pending') - Number(b.status !== 'pending') || b.created_at.localeCompare(a.created_at))
            .map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary" aria-hidden>
                  <UserPlus className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-semibold">{r.patient_name}</span>
                    <Badge tone={r.status === 'pending' ? 'warn' : r.status === 'accepted' ? 'ok' : 'neutral'}>{te('lrs.', r.status)}</Badge>
                  </div>
                  <div className="text-xs text-fg-muted">
                    {t('pv.to', { org: r.organization_name })} · {fmt.relative(r.created_at)}
                  </div>
                  {r.message && (
                    <p dir="auto" className="mt-1 text-sm text-fg">
                      “{r.message}”
                    </p>
                  )}
                </div>
                {r.status === 'pending' && (
                  <div className="flex gap-1.5">
                    <Button size="sm" icon={<Check className="size-4" />} loading={busy === r.id + 'accept'} onClick={() => void decide(r, 'accept')}>
                      {t('common.accept')}
                    </Button>
                    <Button size="sm" variant="outline" icon={<X className="size-4" />} loading={busy === r.id + 'decline'} onClick={() => void decide(r, 'decline')}>
                      {t('common.decline')}
                    </Button>
                  </div>
                )}
              </li>
            ))}
        </ul>
      )}
    </Async>
  );
}
