'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { Frown, Meh, Smile } from 'lucide-react';
import type { Episode, EpisodeStatus } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { useMutation } from '@/lib/useApi';
import { cn } from '@/lib/cn';
import { Badge, type BadgeTone } from '../Badge';
import { Button } from '../Button';
import { Input } from '../Field';
import { InlineError } from '../EmptyState';
import { careLevelSeverity } from '../CareLevelScale';
import { useToast } from '../Toast';
import { usePatientShell } from '../patient/PatientShellContext';

const EP_TONE: Partial<Record<EpisodeStatus, BadgeTone>> = {
  INTAKE_IN_PROGRESS: 'info',
  ASSESSED: 'primary',
  ROUTED: 'primary',
  ACTION_SELECTED: 'primary',
  FOLLOW_UP: 'warn',
  ESCALATED: 'danger',
  RESOLVED: 'ok',
  CLOSED: 'neutral',
};

export function EpisodeStatusBadge({ status }: { status: EpisodeStatus }) {
  const { te } = useLocale();
  return <Badge tone={EP_TONE[status] ?? 'neutral'}>{te('ep.', status)}</Badge>;
}

export function EpisodeRow({ ep, action, children }: { ep: Episode; action?: ReactNode; children?: ReactNode }) {
  const { te, t, fmt } = useLocale();
  const level = ep.assessment?.care_level;
  const sev = level ? careLevelSeverity(level) : null;
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <EpisodeStatusBadge status={ep.status} />
            {level && <Badge tone={sev === 'danger' ? 'danger' : sev === 'warn' ? 'warn' : 'ok'}>{te('cl.', level)}</Badge>}
          </div>
          <p dir="auto" className="mt-1 text-base font-medium text-fg">{ep.chief_complaint}</p>
          <p className="text-sm text-fg-muted">{t('care.started', { d: fmt.dateTime(ep.started_at) })}</p>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

/** better / same / worse follow-up form for episodes in FOLLOW_UP. */
export function EpisodeFollowupForm({ episode, onDone }: { episode: Episode; onDone: (e: Episode) => void }) {
  const { t } = useLocale();
  const toast = useToast();
  const { openEmergency } = usePatientShell();
  const { mutate, pending, error } = useMutation();
  const [status, setStatus] = useState<'better' | 'same' | 'worse' | null>(null);
  const [symptoms, setSymptoms] = useState('');
  const [careObtained, setCareObtained] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!status) return;
    try {
      const ep = await mutate('episodes', 'followup', {
        episode_id: episode.id,
        status,
        new_symptoms: symptoms.trim() || undefined,
        care_obtained: careObtained,
      });
      toast(t('common.saved'));
      onDone(ep);
      // Emergency warning signs in the answer: show the emergency steps at once.
      if (ep.emergency) openEmergency();
    } catch {
      /* inline */
    }
  }

  const opts = [
    { v: 'better' as const, label: t('care.better'), icon: Smile, cls: 'border-ok bg-ok-soft text-ok-fg' },
    { v: 'same' as const, label: t('care.same'), icon: Meh, cls: 'border-warn bg-warn-soft text-warn-fg' },
    { v: 'worse' as const, label: t('care.worse'), icon: Frown, cls: 'border-danger bg-danger-soft text-danger-fg' },
  ];

  return (
    <form onSubmit={submit} className="mt-3 space-y-3 rounded-xl bg-surface-2 p-3">
      <div className="text-base font-semibold">{t('care.followup')}</div>
      <div className="grid grid-cols-3 gap-2">
        {opts.map((o) => (
          <button
            key={o.v}
            type="button"
            onClick={() => setStatus(o.v)}
            aria-pressed={status === o.v}
            className={cn(
              'flex min-h-16 flex-col items-center justify-center gap-1 rounded-2xl border-2 py-2.5 text-base font-medium',
              status === o.v ? o.cls : 'border-line bg-surface text-fg-muted',
            )}
          >
            <o.icon className="size-5" />
            {o.label}
          </button>
        ))}
      </div>
      <Input placeholder={t('care.newSymptoms')} value={symptoms} onChange={(e) => setSymptoms(e.target.value)} />
      <label className="flex min-h-11 items-center gap-2 text-base">
        <input type="checkbox" checked={careObtained} onChange={(e) => setCareObtained(e.target.checked)} className="size-5 accent-[var(--primary)]" />
        {t('care.careObtained')}
      </label>
      <InlineError error={error} />
      <Button type="submit" size="lg" loading={pending} disabled={!status}>
        {t('care.sendFollowup')}
      </Button>
    </form>
  );
}
