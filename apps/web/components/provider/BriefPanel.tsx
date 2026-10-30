'use client';

import { useEffect, useRef, useState } from 'react';
import { FileText, Loader2, Printer, Sparkles, X } from 'lucide-react';
import type { PreVisitBrief, UUID } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { useAuth } from '@/lib/auth';
import { CLINICIAN_ROLES, hasRole } from '@/lib/roles';
import { useMutation } from '@/lib/useApi';
import { isAborted } from '@/lib/api';
import type { TKey } from '@/lib/i18n';
import { Card, CardHeader } from '../Card';
import { Button } from '../Button';
import { AiLabel } from '../AiLabel';
import { Citations } from '../Citations';
import { EmptyState, InlineError } from '../EmptyState';

/**
 * AI pre-visit brief: generate (long-running, 10-60 s) and render every section with sources.
 * The brief lives in the workspace data (`onGenerated`), so switching tabs does not lose a new one.
 */
export function BriefPanel({
  patientId,
  brief,
  onGenerated,
  appointmentId,
}: {
  patientId: UUID;
  brief: PreVisitBrief | null;
  onGenerated: (b: PreVisitBrief) => void;
  appointmentId?: UUID;
}) {
  const { t, fmt } = useLocale();
  // Generating a brief is for doctors and nurses (provider.generate_brief); others read the stored one.
  const canGenerate = hasRole(useAuth().user?.role, CLINICIAN_ROLES);
  const { mutate, pending, error, clearError } = useMutation();
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // leaving the patient stops a brief still being written
  useEffect(() => () => abortRef.current?.abort(), []);

  async function generate() {
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      onGenerated(await mutate('provider', 'generate_brief', { patient_id: patientId, appointment_id: appointmentId }, { signal: ctrl.signal }));
    } catch {
      /* inline (a cancelled brief shows nothing) */
    } finally {
      clearInterval(timer);
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  }

  return (
    <Card className="print-block">
      <CardHeader
        title={t('pv.brief')}
        icon={<FileText className="size-5" />}
        subtitle={brief ? `${fmt.dateTime(brief.created_at)} · ${t('brief.model', { m: brief.model })}` : undefined}
        action={
          <div className="print-hidden flex flex-wrap gap-2">
            {brief && !pending && (
              <Button variant="outline" icon={<Printer className="size-4" />} onClick={() => window.print()}>
                {t('common.print')}
              </Button>
            )}
            {canGenerate && (
              <Button icon={<Sparkles className="size-4" />} loading={pending} onClick={() => void generate()}>
                {brief ? t('pv.regenerate') : t('pv.generateBrief')}
              </Button>
            )}
          </div>
        }
      />
      {pending && (
        <div className="print-hidden mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-primary/30 bg-primary-soft p-4" role="status">
          <Loader2 className="size-5 animate-spin text-primary" aria-hidden />
          <span className="text-sm text-primary-strong">{t('pv.generating')}</span>
          <span className="num ms-auto text-sm text-fg-muted">{elapsed}s</span>
          <Button
            size="sm"
            variant="ghost"
            icon={<X className="size-4" />}
            onClick={() => {
              abortRef.current?.abort();
              clearError();
            }}
          >
            {t('common.cancel')}
          </Button>
        </div>
      )}
      {!isAborted(error) && <InlineError error={error} />}
      {!brief && !pending ? (
        <EmptyState title={t('pv.noBrief')} icon={<FileText className="size-7" />} />
      ) : brief ? (
        <BriefContent brief={brief} />
      ) : null}
    </Card>
  );
}

function BriefContent({ brief }: { brief: PreVisitBrief }) {
  const { t } = useLocale();
  const c = brief.content;
  const lists: { key: TKey; items: string[] }[] = [
    { key: 'brief.changes', items: c.changes_since_last_visit },
    { key: 'brief.events', items: c.important_events },
    { key: 'brief.labs', items: c.labs },
    { key: 'brief.screenings', items: c.overdue_screenings },
    { key: 'brief.gaps', items: c.data_gaps },
    { key: 'brief.questions', items: c.patient_questions },
    ...(c.considerations && c.considerations.length ? [{ key: 'brief.considerations' as TKey, items: c.considerations }] : []),
    ...(c.guideline_points && c.guideline_points.length ? [{ key: 'brief.guidelines' as TKey, items: c.guideline_points }] : []),
  ];
  return (
    <div className="space-y-4" dir="auto">
      <AiLabel pro />
      <Section title={t('brief.reason')}>{c.reason_for_visit}</Section>
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={t('brief.glucose')}>{c.glucose_summary}</Section>
        <Section title={t('brief.adherence')}>{c.medication_adherence}</Section>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {lists.map((l) => (
          <div key={l.key} className="rounded-xl border border-line p-3">
            <h4 className="mb-1.5 text-sm font-semibold">{t(l.key)}</h4>
            {l.items.length === 0 ? (
              <p className="text-sm text-fg-subtle">—</p>
            ) : (
              <ul className="space-y-1">
                {l.items.map((x, i) => (
                  <li key={i} className="flex gap-2 text-sm leading-6">
                    <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-primary" />
                    {x}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-info/30 bg-info-soft/60 p-4">
        <h4 className="mb-1.5 text-sm font-semibold text-info-fg">{t('brief.interpretation')}</h4>
        <p className="text-sm leading-7 whitespace-pre-line">{c.clinical_interpretation}</p>
        <AiLabel pro className="mt-2" extra={brief.model} />
      </div>
      {brief.sources.length > 0 && <Citations citations={brief.sources} />}
    </div>
  );
}

function Section({ title, children }: { title: string; children: string }) {
  return (
    <div className="rounded-xl border border-line p-3">
      <h4 className="mb-1 text-sm font-semibold">{title}</h4>
      <p className="text-sm leading-7 whitespace-pre-line text-fg">{children || '—'}</p>
    </div>
  );
}
