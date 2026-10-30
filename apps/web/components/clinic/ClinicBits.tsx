'use client';

import type { ReactNode } from 'react';
import { Sparkles } from 'lucide-react';
import type { ClinicDoctorRef, ClinicSpecialty, ClinicUrgency } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { Badge, type BadgeTone } from '../Badge';

/** Polyclinic screens (docs/integration/clinic-module.md): small shared pieces. */

const URGENCY_TONE: Record<ClinicUrgency, BadgeTone> = { urgent: 'solid-danger', priority: 'warn', routine: 'neutral' };

export function ClinicUrgencyBadge({ urgency }: { urgency: ClinicUrgency | null | undefined }) {
  const { te } = useLocale();
  if (!urgency) return null;
  return <Badge tone={URGENCY_TONE[urgency] ?? 'neutral'}>{te('clinic.urgency.', urgency)}</Badge>;
}

/** The specialty's name in the reader's language (a code when the catalog has no name). */
export function useClinicNames() {
  const { pick } = useLocale();
  return {
    specialty: (s: ClinicSpecialty | string | null | undefined) => (!s ? '' : typeof s === 'string' ? s : pick(s.name, s.name_ar)),
    doctor: (d: ClinicDoctorRef | null | undefined) => (d ? pick(d.full_name, d.full_name_ar) : ''),
    person: (p: { full_name: string; full_name_ar?: string | null } | null | undefined) => (p ? pick(p.full_name, p.full_name_ar ?? null) : ''),
  };
}

/**
 * Anything the model wrote for the doctor (ai_draft: true): a muted panel with a visible "AI draft, check before use"
 * label, kept apart from the doctor's own fields. Nothing in it is ever copied into the diagnosis or prescription.
 */
export function AiDraftPanel({ title, children, action }: { title: ReactNode; children: ReactNode; action?: ReactNode }) {
  const { t } = useLocale();
  return (
    <section className="rounded-2xl border border-dashed border-line-strong bg-surface-2/60 p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold">{title}</h3>
        <Badge tone="info">
          <Sparkles className="me-1 inline size-3.5" aria-hidden />
          {t('clinic.aiDraft')}
        </Badge>
        {action && <span className="ms-auto">{action}</span>}
      </div>
      <div className="text-sm leading-6 text-fg-muted">{children}</div>
    </section>
  );
}

export function Money({ egp }: { egp: number | null | undefined }) {
  const { t, fmt } = useLocale();
  if (egp === null || egp === undefined) return <>–</>;
  return <span className="num">{t('clinic.egp', { n: fmt.number(egp) })}</span>;
}
