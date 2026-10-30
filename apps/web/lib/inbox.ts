import type { InboxItem } from '@health/api-client';

/** Tells the header statistics (provider layout) to refresh after an inbox item changed. */
export const STATS_EVENT = 'health:stats-changed';

/** Workspace tab that best answers an inbox item, from its payload (falls back to the category). */
export function inboxTarget(it: InboxItem): string {
  const p = (it.payload ?? {}) as Record<string, unknown>;
  const entity = typeof p.entity === 'string' ? p.entity : null;
  let tab = 'overview';
  if (p.finding_id) tab = 'meds';
  else if (p.episode_id) tab = 'episodes';
  else if (p.document_id || entity === 'document') tab = 'documents';
  else if (p.pattern_id || p.pattern || p.glucose_event_id) tab = 'glucose';
  else if (p.referral_id) tab = 'referrals';
  else if (entity === 'lab') tab = 'labs';
  else if (entity === 'condition' || entity === 'allergy' || entity === 'medication') tab = 'meds';
  else
    tab =
      (
        {
          safety: 'meds',
          glucose: 'glucose',
          result: 'labs',
          verification: 'meds',
          referral: 'referrals',
          care_plan: 'plan',
          episode: 'episodes',
          ai_review: 'brief',
          question: 'messages',
        } as Record<InboxItem['category'], string>
      )[it.category] ?? 'overview';
  return `/provider/patients/${it.patient_id}?tab=${tab}`;
}
