'use client';

import type { CareLevel } from '@health/api-client';
import { cn } from '@/lib/cn';
import { useLocale } from '@/lib/locale';

export const CARE_LEVELS: CareLevel[] = [
  'self_care',
  'routine_appointment',
  'primary_care',
  'specialist',
  'same_day',
  'urgent_care',
  'emergency_department',
  'emergency_services',
];

/** Colour for each level: calm -> attention -> emergency. */
const LEVEL_COLOR: Record<CareLevel, string> = {
  self_care: 'var(--g-in)',
  routine_appointment: '#14b8a6',
  primary_care: '#0ea5e9',
  specialist: '#6366f1',
  same_day: 'var(--g-high)',
  urgent_care: 'var(--g-vhigh)',
  emergency_department: 'var(--g-low)',
  emergency_services: 'var(--g-vlow)',
};

export function careLevelSeverity(level: CareLevel): 'ok' | 'warn' | 'danger' {
  const i = CARE_LEVELS.indexOf(level);
  if (i >= 6) return 'danger';
  if (i >= 4) return 'warn';
  return 'ok';
}

/** Visual scale from self care to emergency services with the selected level highlighted (plus text, never colour alone). */
export function CareLevelScale({ level, className, showLabel = false }: { level: CareLevel; className?: string; showLabel?: boolean }) {
  const { te, t } = useLocale();
  const idx = CARE_LEVELS.indexOf(level);
  return (
    <div className={cn('space-y-2', className)} role="img" aria-label={`${idx + 1} / ${CARE_LEVELS.length}: ${te('cl.', level)}`}>
      <div className="flex gap-1" aria-hidden>
        {CARE_LEVELS.map((l, i) => (
          <div
            key={l}
            className={cn('flex-1 rounded-full transition-all', i === idx ? 'h-4 ring-2 ring-fg ring-offset-2 ring-offset-surface' : 'h-2.5 self-center')}
            style={{ background: LEVEL_COLOR[l], opacity: i === idx ? 1 : i < idx ? 0.5 : 0.2 }}
            title={te('cl.', l)}
          />
        ))}
      </div>
      <div className="flex justify-between gap-4 text-xs text-fg-muted" aria-hidden>
        <span>{t('cl.self_care')}</span>
        <span className="text-end">{t('cl.emergency_services')}</span>
      </div>
      {showLabel && (
        <div className="flex items-center gap-2">
          <span className="size-3 rounded-full" style={{ background: LEVEL_COLOR[level] }} aria-hidden />
          <span className="text-lg font-semibold text-fg">{te('cl.', level)}</span>
        </div>
      )}
    </div>
  );
}
