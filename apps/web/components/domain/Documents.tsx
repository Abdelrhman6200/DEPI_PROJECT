'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AlertTriangle, Camera, CheckCircle2, FileText, FileUp, FlaskConical, ImageIcon, Loader2, Pill, ShieldAlert, Stethoscope, Upload, XCircle } from 'lucide-react';
import type { DocumentRecord, UUID } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { CLINICIAN_ROLES, hasRole } from '@/lib/roles';
import { useAuth } from '@/lib/auth';
import { useApi, useMutation } from '@/lib/useApi';
import { cn } from '@/lib/cn';
import { isoDate } from '@/lib/format';
import { Card } from '../Card';
import { Badge, type BadgeTone } from '../Badge';
import { Button } from '../Button';
import { Field, Input, Select, Textarea } from '../Field';
import { Async } from '../Async';
import { EmptyState, InlineError } from '../EmptyState';
import { SkeletonList } from '../Skeleton';
import { AiLabel } from '../AiLabel';
import { labName } from './HealthLists';
import { useErrorToast, useToast } from '../Toast';

const MAX_BYTES = 4 * 1024 * 1024;
const KINDS: DocumentRecord['kind'][] = ['lab_report', 'prescription', 'discharge_summary', 'imaging', 'other'];
const STATUS_TONE: Record<DocumentRecord['status'], BadgeTone> = {
  uploaded: 'info',
  extracting: 'info',
  extracted: 'primary',
  extraction_failed: 'warn',
  verified: 'ok',
  rejected: 'neutral',
};
const SETTLING = new Set<DocumentRecord['status']>(['uploaded', 'extracting']);

/** Poll the list every 4 s while any document is still being read. */
function useDocuments(patientId?: UUID) {
  const q = useApi('clinical', 'documents', patientId ? { patient_id: patientId } : {});
  const busy = (q.data ?? []).some((d) => SETTLING.has(d.status));
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => void q.reload(true), 4000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);
  return q;
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result ?? '');
      resolve(s.slice(s.indexOf(',') + 1)); // strip the "data:...;base64," prefix
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function DocumentStatusBadge({ status }: { status: DocumentRecord['status'] }) {
  const { te } = useLocale();
  return (
    <Badge tone={STATUS_TONE[status]} icon={SETTLING.has(status) ? <Loader2 className="size-3 animate-spin" aria-hidden /> : undefined}>
      {te('ds.', status)}
    </Badge>
  );
}

/* ------------------------------------------------------------ patient / caregiver */

export function PatientDocuments({ patientId }: { patientId?: UUID }) {
  const { t } = useLocale();
  const q = useDocuments(patientId);
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-base leading-7 text-fg-muted">{t('doc.subtitle')}</p>
        {!showForm && (
          <Button size="lg" icon={<FileUp className="size-5" />} onClick={() => setShowForm(true)}>
            {t('doc.upload')}
          </Button>
        )}
      </div>
      {showForm && (
        <UploadForm
          patientId={patientId}
          onCancel={() => setShowForm(false)}
          onUploaded={(d) => {
            q.setData((xs) => [d, ...(xs ?? []).filter((x) => x.id !== d.id)]);
            setShowForm(false);
          }}
        />
      )}
      <div aria-live="polite">
        <Async
          state={q}
          skeleton={<SkeletonList rows={2} />}
          empty={
            showForm ? (
              <></>
            ) : (
              <EmptyState
                title={t('doc.empty')}
                description={t('doc.emptyHint')}
                icon={<FileText className="size-8" />}
                action={
                  <Button size="lg" icon={<FileUp className="size-5" />} onClick={() => setShowForm(true)}>
                    {t('doc.upload')}
                  </Button>
                }
              />
            )
          }
        >
          {(docs) => (
            <ul className="space-y-3">
              {[...docs]
                .sort((a, b) => b.created_at.localeCompare(a.created_at))
                .map((d) => (
                  <li key={d.id}>
                    <DocumentCard d={d} />
                  </li>
                ))}
            </ul>
          )}
        </Async>
      </div>
    </div>
  );
}

function UploadForm({ patientId, onUploaded, onCancel }: { patientId?: UUID; onUploaded: (d: DocumentRecord) => void; onCancel: () => void }) {
  const { t, te } = useLocale();
  const toast = useToast();
  const { mutate, pending, error } = useMutation();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<DocumentRecord['kind']>('lab_report');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [local, setLocal] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  function pick(f: File | undefined) {
    setLocal(null);
    if (!f) return;
    if (!/^image\//.test(f.type) && f.type !== 'application/pdf') return setLocal(t('err.fileType'));
    if (f.size > MAX_BYTES) return setLocal(t('err.fileTooBig'));
    setFile(f);
    setPreview(/^image\//.test(f.type) ? URL.createObjectURL(f) : null);
    if (!title) setTitle(f.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 80));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file && !text.trim()) return setLocal(t('doc.needInput'));
    try {
      const content_base64 = file ? await readBase64(file) : undefined;
      const d = await mutate('clinical', 'upload_document', {
        ...(patientId ? { patient_id: patientId } : {}),
        title: title.trim() || te('dk.', kind),
        kind,
        file_name: file?.name,
        mime_type: file?.type,
        content_base64,
        text: !file ? text.trim() : text.trim() || undefined,
      });
      toast(t('doc.uploaded'));
      onUploaded(d);
    } catch {
      /* inline */
    }
  }

  return (
    <Card className="p-5">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <p className="mb-2 text-base font-semibold">{t('doc.takePhoto')}</p>
          <input ref={cameraRef} type="file" accept="image/*,application/pdf" capture="environment" className="sr-only" tabIndex={-1} onChange={(e) => pick(e.target.files?.[0])} />
          <input ref={fileRef} type="file" accept="image/*,application/pdf" className="sr-only" tabIndex={-1} onChange={(e) => pick(e.target.files?.[0])} />
          {file ? (
            <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface-2 p-3">
              {preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={preview} alt="" className="size-16 shrink-0 rounded-xl object-cover" />
              ) : (
                <span className="flex size-16 shrink-0 items-center justify-center rounded-xl bg-surface text-fg-muted" aria-hidden>
                  <FileText className="size-7" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm text-fg-muted">{t('doc.chosen', { name: '' }).replace(/[:：]\s*$/, '')}</p>
                <p className="truncate text-base font-medium" dir="ltr" title={file.name}>
                  {file.name}
                </p>
                <button type="button" onClick={() => fileRef.current?.click()} className="min-h-11 text-sm font-semibold text-primary-strong hover:underline">
                  {t('doc.change')}
                </button>
              </div>
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              <Button variant="outline" size="xl" icon={<Camera className="size-6" />} onClick={() => cameraRef.current?.click()}>
                {t('doc.camera')}
              </Button>
              <Button variant="outline" size="xl" icon={<ImageIcon className="size-6" />} onClick={() => fileRef.current?.click()}>
                {t('doc.chooseFile')}
              </Button>
            </div>
          )}
          <p className="mt-1.5 text-sm text-fg-muted">{t('doc.fileHint')}</p>
        </div>

        {!file && (
          <Field label={t('doc.orPaste')}>
            <Textarea className="min-h-24" placeholder={t('doc.pastePh')} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('doc.docTitle')}>
            <Input placeholder={t('doc.docTitlePh')} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
          </Field>
          <Field label={t('doc.kind')}>
            <Select value={kind} onChange={(e) => setKind(e.target.value as DocumentRecord['kind'])}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {te('dk.', k)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <InlineError error={error} message={local} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="lg" loading={pending} icon={<Upload className="size-5" />} disabled={!file && !text.trim()}>
            {t('doc.send')}
          </Button>
          <Button variant="ghost" size="lg" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function DocumentCard({ d, review }: { d: DocumentRecord; review?: ReactNode }) {
  const { t, te, fmt, pick } = useLocale();
  const x = d.extracted;
  const warnings = x?.warnings ?? [];
  const summary = x ? pick(x.summary, x.summary_ar ?? null) : '';
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary" aria-hidden>
            <FileText className="size-5" />
          </span>
          <div className="min-w-0">
            <h3 dir="auto" className="text-base font-semibold">
              {d.title}
            </h3>
            <p className="text-sm text-fg-muted">
              {te('dk.', d.kind)} · {fmt.dateTime(d.created_at)}
            </p>
          </div>
        </div>
        <DocumentStatusBadge status={d.status} />
      </div>

      {SETTLING.has(d.status) && (
        <p className="flex items-center gap-2 rounded-xl bg-info-soft px-3 py-2 text-sm text-info-fg" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t('doc.readingHint')}
        </p>
      )}
      {d.status === 'extraction_failed' && <p className="rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn-fg">{t('doc.failedHint')}</p>}

      {/* Before a clinician accepts anything: text aimed at an AI inside the document, or a mostly unreadable scan. */}
      {review && warnings.includes('contains_instructions') && (
        <p role="alert" className="flex items-start gap-2 rounded-xl border-2 border-danger/60 bg-danger-soft px-3 py-2.5 text-sm font-medium leading-6 text-danger-fg">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t('doc.warnInstructions')}
        </p>
      )}
      {review && warnings.includes('illegible') && (
        <p className="flex items-start gap-2 rounded-xl border border-warn/50 bg-warn-soft px-3 py-2.5 text-sm leading-6 text-warn-fg">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t('doc.warnIllegible')}
        </p>
      )}

      {x && (summary || x.labs.length || x.medications.length || x.conditions.length) ? (
        <div className="space-y-3 rounded-xl border border-primary/25 bg-primary-soft/40 p-3">
          <p className="text-sm font-semibold text-primary-strong">{review ? t('doc.foundPro') : t('doc.found')}</p>
          {summary && (
            <p dir="auto" className="text-base leading-7">
              {summary}
            </p>
          )}
          {!review && x.labs.length > 0 && (
            <div>
              <h4 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                <FlaskConical className="size-4" aria-hidden />
                {t('doc.labs')}
              </h4>
              <ul className="space-y-1">
                {x.labs.map((l, i) => (
                  <li key={i} className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg bg-surface px-3 py-2 text-base">
                    <span dir="auto">{labName(l.test_code, l.display, t)}</span>
                    <span className="num font-semibold">
                      {l.value} <span className="text-sm font-normal text-fg-muted">{l.unit}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {x.medications.length > 0 && (
            <div>
              <h4 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                <Pill className="size-4" aria-hidden />
                {t('doc.meds')}
              </h4>
              <ul className="space-y-1 text-base">
                {x.medications.map((m, i) => (
                  <li key={i} dir="auto">
                    <bdi className="font-medium">{m.name}</bdi> {[m.dose_text, m.frequency].filter(Boolean).join(' · ')}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {x.conditions.length > 0 && (
            <div>
              <h4 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                <Stethoscope className="size-4" aria-hidden />
                {t('doc.conditions')}
              </h4>
              <p dir="auto" className="text-base">
                {fmt.list(x.conditions.map((c) => c.display))}
              </p>
            </div>
          )}
          <AiLabel pro={!!review} extra={x.model ?? undefined} />
        </div>
      ) : null}
      {review}
    </Card>
  );
}

/* ------------------------------------------------------------ provider review */

export function ProviderDocuments({ patientId, onChanged }: { patientId: UUID; onChanged?: () => void }) {
  const { t } = useLocale();
  // Accepting or rejecting extracted values is for doctors and nurses (clinical.review_document).
  const canReview = hasRole(useAuth().user?.role, CLINICIAN_ROLES);
  const q = useDocuments(patientId);
  return (
    <Async state={q} skeleton={<SkeletonList rows={3} />} empty={<EmptyState title={t('doc.empty')} icon={<FileText className="size-8" />} />}>
      {(docs) => (
        <ul className="space-y-3">
          {[...docs]
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .map((d) => (
              <li key={d.id}>
                <DocumentCard
                  d={d}
                  review={
                    canReview && <ReviewControls
                      d={d}
                      onDone={(next) => {
                        q.setData((xs) => (xs ? xs.map((x) => (x.id === next.id ? next : x)) : xs));
                        onChanged?.();
                      }}
                    />
                  }
                />
              </li>
            ))}
        </ul>
      )}
    </Async>
  );
}

function ReviewControls({ d, onDone }: { d: DocumentRecord; onDone: (d: DocumentRecord) => void }) {
  const { t, fmt } = useLocale();
  const toast = useToast();
  const errorToast = useErrorToast();
  const { mutate, pending } = useMutation();
  const labs = d.extracted?.labs ?? [];
  const [selected, setSelected] = useState<number[]>(() => labs.map((_, i) => i));
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null);
  const reviewable = d.status === 'extracted' || d.status === 'extraction_failed';
  // Results without a date in the document need the date of the test before they can be filed.
  const needsDate = d.status === 'extracted' && selected.some((i) => !labs[i]?.observed_at);
  const [defaultDate, setDefaultDate] = useState('');

  async function decide(decision: 'accept' | 'reject') {
    setBusy(decision);
    try {
      const next = await mutate('clinical', 'review_document', {
        document_id: d.id,
        decision,
        lab_indexes: decision === 'accept' ? selected : undefined,
        default_date: decision === 'accept' && needsDate ? defaultDate : undefined,
      });
      toast(decision === 'accept' ? t('doc.accepted') : t('doc.rejected'));
      onDone(next);
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {labs.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[28rem] text-sm">
            <thead className="bg-surface-2 text-xs text-fg-muted">
              <tr>
                <th className="w-10 px-3 py-2" />
                <th className="px-3 py-2 text-start font-medium">{t('health.test')}</th>
                <th className="px-3 py-2 text-end font-medium">{t('common.value')}</th>
                <th className="px-3 py-2 text-start font-medium">{t('health.observed')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {labs.map((l, i) => (
                <tr key={i} className={cn(!selected.includes(i) && 'opacity-60')}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={l.display}
                      disabled={!reviewable}
                      checked={selected.includes(i)}
                      onChange={(e) => setSelected((xs) => (e.target.checked ? [...xs, i] : xs.filter((x) => x !== i)))}
                      className="size-4 accent-[var(--primary)]"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{l.display}</div>
                    <div className="text-xs text-fg-subtle">{l.test_code}</div>
                  </td>
                  <td className="num px-3 py-2 text-end font-semibold">
                    {l.value} <span className="text-xs font-normal text-fg-muted">{l.unit}</span>
                  </td>
                  <td className="px-3 py-2 text-xs text-fg-muted">{l.observed_at ? fmt.date(l.observed_at) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {reviewable && needsDate && (
        <label className="block max-w-xs space-y-1">
          <span className="block text-sm font-medium text-fg">{t('doc.testDate')}</span>
          <Input type="date" dir="ltr" max={isoDate()} value={defaultDate} onChange={(e) => setDefaultDate(e.target.value)} />
          <span className="block text-xs text-fg-muted">{t('doc.testDateHint')}</span>
        </label>
      )}
      {reviewable ? (
        <div className="flex flex-wrap gap-2">
          {labs.length > 0 && d.status === 'extracted' && (
            <Button
              size="sm"
              icon={<CheckCircle2 className="size-4" />}
              loading={pending && busy === 'accept'}
              disabled={!selected.length || (needsDate && !defaultDate)}
              onClick={() => void decide('accept')}
            >
              {t('doc.acceptLabs')} ({selected.length})
            </Button>
          )}
          <Button size="sm" variant="outline" icon={<XCircle className="size-4" />} loading={pending && busy === 'reject'} onClick={() => void decide('reject')}>
            {t('common.reject')}
          </Button>
          {labs.length === 0 && <span className="self-center text-xs text-fg-muted">{t('doc.noLabs')}</span>}
        </div>
      ) : null}
    </div>
  );
}
