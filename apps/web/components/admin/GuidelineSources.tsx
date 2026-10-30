'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, Library, RefreshCw, XCircle } from 'lucide-react';
import type { GuidelineSource } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import { GUIDELINE_APPROVER_ROLES, hasRole } from '@/lib/roles';
import { Card, CardHeader } from '@/components/Card';
import { Badge, type BadgeTone } from '@/components/Badge';
import { Button } from '@/components/Button';
import { Dialog } from '@/components/Dialog';
import { Field, Textarea } from '@/components/Field';
import { Async } from '@/components/Async';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonList } from '@/components/Skeleton';
import { useErrorToast, useToast } from '@/components/Toast';

const STATUS_TONE: Record<string, BadgeTone> = {
  unchanged: 'ok', new_edition: 'warn', watch_update: 'warn', not_licensed: 'neutral', retracted: 'danger', error: 'danger', never: 'neutral',
};

type Review = { source: GuidelineSource; mode: 'approve' | 'dismiss' };

/**
 * Accredited guideline sources (WF-024): what each source is, the edition in use, and a new edition waiting for review.
 * A fetched edition is approved as a whole with its license confirmed; a watched edition is marked reviewed once the
 * knowledge-base summaries were checked against it. Nothing fetched reaches AI answers before that.
 */
export function GuidelineSources({ onChanged }: { onChanged?: () => void }) {
  const { t, te, fmt } = useLocale();
  const { user } = useAuth();
  const toast = useToast();
  const errorToast = useErrorToast();
  const q = useApi('admin', 'guideline_sources', {});
  const { mutate } = useMutation();
  const [busy, setBusy] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [licenseOk, setLicenseOk] = useState(false);
  // flagged sections must have been read before a fetched edition can go live
  const [flaggedRead, setFlaggedRead] = useState(false);
  const [note, setNote] = useState('');
  // a new edition changes what AI answers cite: only the safety officer decides
  const canDecide = hasRole(user?.role, GUIDELINE_APPROVER_ROLES);

  function replace(next: GuidelineSource) {
    q.setData((xs) => (xs ? xs.map((x) => (x.key === next.key ? next : x)) : xs));
  }

  async function check(s: GuidelineSource) {
    setBusy(s.key + ':check');
    try {
      const r = await mutate('admin', 'guideline_check', { source_key: s.key });
      toast(t('gl.checked', { status: te('gl.status.', r.status) }));
      await q.reload();
      onChanged?.();
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(null);
    }
  }

  function open(source: GuidelineSource, mode: Review['mode']) {
    setLicenseOk(false);
    setFlaggedRead(false);
    setNote('');
    setReview({ source, mode });
  }

  async function submit() {
    if (!review) return;
    const { source, mode } = review;
    setBusy(source.key + ':' + mode);
    try {
      const next =
        mode === 'approve'
          ? await mutate('admin', 'guideline_approve', { source_key: source.key, version: source.pending_version ?? undefined, license_confirmed: licenseOk, note: note.trim() || undefined })
          : await mutate('admin', 'guideline_dismiss', { source_key: source.key, version: source.pending_version ?? undefined, note: note.trim() });
      replace(next);
      toast(t('common.saved'));
      setReview(null);
      onChanged?.();
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(null);
    }
  }

  const fetchedReview = !!review && review.source.pending_documents > 0;
  const flagged = review?.source.pending_flagged ?? 0;
  const canSubmit = !review
    ? false
    : review.mode === 'dismiss'
      ? note.trim().length >= 5
      : !fetchedReview || (licenseOk && (flagged === 0 || flaggedRead));

  return (
    <Card>
      <CardHeader title={t('gl.title')} />
      <p className="mb-3 text-sm text-fg-muted">{t('gl.intro')}</p>
      <Async state={q} skeleton={<SkeletonList rows={4} />} empty={<EmptyState compact title={t('gl.empty')} icon={<Library className="size-6" />} />}>
        {(sources) => (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {sources.map((s) => {
              const status = s.last_status ?? 'never';
              return (
                <li key={s.key} className="space-y-2 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium">
                        {s.publisher} · {s.title}
                      </div>
                      <div className="text-xs text-fg-subtle">{s.accreditation}</div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{te('gl.status.', status)}</Badge>
                      <Badge tone="neutral">{te('gl.method.', s.method)}</Badge>
                      {s.ingest === 'watch_only' && <Badge tone="neutral">{t('gl.watchOnly')}</Badge>}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
                    <span>{s.current_version ? t('gl.current', { v: s.current_version }) : t('gl.none')}</span>
                    <span>{s.last_checked_at ? t('gl.lastChecked', { when: fmt.relative(s.last_checked_at) }) : t('gl.neverChecked')}</span>
                    {s.approved_documents > 0 && <span>{t('gl.approvedDocs', { n: s.approved_documents })}</span>}
                    {s.license && <span className="truncate">{s.license}</span>}
                  </div>
                  {status === 'error' && s.last_error && <p className="text-xs text-danger">{s.last_error}</p>}

                  {s.pending_version && (
                    <div className="space-y-2 rounded-lg border border-warn/30 bg-warn-soft/40 p-2.5 text-sm">
                      <div className="font-medium">{t('gl.pending', { v: s.pending_version })}</div>
                      {s.pending_documents > 0 ? (
                        <p className="text-xs text-fg-muted">{t('gl.pendingDocs', { n: s.pending_documents })}</p>
                      ) : (
                        <p className="text-xs text-fg-muted">{t('gl.watchHint')}</p>
                      )}
                      {s.pending_flagged > 0 && (
                        <p className="flex items-center gap-1 text-xs font-medium text-danger">
                          <AlertTriangle className="size-3.5" /> {t('gl.flagged', { n: s.pending_flagged })}
                        </p>
                      )}
                      {s.open_updates.flatMap((u) => u.items).slice(0, 6).map((it, i) => (
                        <a key={i} href={it.url} target="_blank" rel="noopener noreferrer" className="flex items-start gap-1 text-xs text-primary hover:underline">
                          <ExternalLink className="mt-0.5 size-3 shrink-0" />
                          <span>{it.title}{it.journal ? ` (${it.journal}${it.pubdate ? ', ' + it.pubdate : ''})` : ''}</span>
                        </a>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap justify-end gap-1">
                    <Button size="xs" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={busy === s.key + ':check'} onClick={() => void check(s)}>
                      {t('gl.checkNow')}
                    </Button>
                    {s.pending_version && canDecide && (
                      <>
                        <Button size="xs" variant="ghost" icon={<XCircle className="size-3.5" />} onClick={() => open(s, 'dismiss')}>
                          {t('gl.reject')}
                        </Button>
                        <Button size="xs" icon={<CheckCircle2 className="size-3.5" />} onClick={() => open(s, 'approve')}>
                          {s.pending_documents > 0 ? t('gl.approve') : t('gl.acknowledge')}
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Async>

      <Dialog
        open={!!review}
        onClose={() => setReview(null)}
        size="md"
        title={review ? `${review.mode === 'approve' ? (fetchedReview ? t('gl.approve') : t('gl.acknowledge')) : t('gl.reject')}: ${review.source.title}` : ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => setReview(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant={review?.mode === 'dismiss' ? 'danger' : undefined}
              disabled={!canSubmit}
              loading={!!review && busy === review.source.key + ':' + review.mode}
              onClick={() => void submit()}
            >
              {review?.mode === 'dismiss' ? t('gl.reject') : fetchedReview ? t('gl.approve') : t('gl.acknowledge')}
            </Button>
          </>
        }
      >
        {review && (
          <div className="space-y-3 text-sm">
            <p className="text-fg-muted">{t('gl.pending', { v: review.source.pending_version ?? '' })}</p>
            {review.mode === 'approve' && fetchedReview && (
              <>
                <p className="text-fg-muted">{t('gl.approveHint')}</p>
                <p className="text-fg-muted">{t('gl.pendingDocs', { n: review.source.pending_documents })}</p>
                {flagged > 0 && (
                  <p className="flex items-start gap-1.5 rounded-lg bg-danger-soft px-3 py-2 font-medium text-danger-fg" role="alert">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                    {t('gl.flagged', { n: flagged })}
                  </p>
                )}
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1" checked={licenseOk} onChange={(e) => setLicenseOk(e.target.checked)} />
                  <span>{t('gl.licenseConfirm', { license: review.source.license ?? t('gl.licenseUnknown') })}</span>
                </label>
                {flagged > 0 && (
                  <label className="flex items-start gap-2">
                    <input type="checkbox" className="mt-1" checked={flaggedRead} onChange={(e) => setFlaggedRead(e.target.checked)} />
                    <span>{t('gl.flaggedConfirm', { n: flagged })}</span>
                  </label>
                )}
              </>
            )}
            {review.mode === 'approve' && !fetchedReview && <p className="text-fg-muted">{t('gl.watchHint')}</p>}
            <Field label={review.mode === 'dismiss' ? t('gl.reason') : t('gl.note')}>
              <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
        )}
      </Dialog>
    </Card>
  );
}
