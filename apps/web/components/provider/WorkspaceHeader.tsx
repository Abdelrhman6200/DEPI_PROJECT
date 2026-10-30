'use client';

import { MapPin, Phone, UserRound } from 'lucide-react';
import type { Workspace } from '@health/api-client';
import { useLocale } from '@/lib/locale';

import { Badge } from '../Badge';
import { Card } from '../Card';
import { ExclusionBadges } from '../StatusBadges';

export function WorkspaceHeader({ ws }: { ws: Workspace }) {
  const { t, te, pick, fmt } = useLocale();
  const p = ws.patient;
  return (
    <Card className="flex flex-wrap items-start gap-4">
      <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-primary-soft text-primary">
        <UserRound className="size-7" />
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">{pick(p.full_name, p.full_name_ar)}</h1>
          {p.full_name_ar && p.full_name !== p.full_name_ar && (
            <span className="text-sm text-fg-muted">{pick(p.full_name_ar, p.full_name)}</span>
          )}
          <Badge tone={p.tier === 'linked' ? 'primary' : 'neutral'}>{te('tier.', p.tier)}</Badge>
          <ExclusionBadges exclusions={p.exclusions} />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-fg-muted">
          <span>
            {t('pv.mrn')}: <span className="num font-medium text-fg">{p.mrn}</span>
          </span>
          <span>
            {t('common.years', { n: p.age })} · {p.sex === 'female' ? t('common.female') : t('common.male')}
          </span>
          <span>
            {te('dt.', p.diabetes_type)}
            {p.diagnosis_year && <> · {t('pv.dx', { y: p.diagnosis_year })}</>}
          </span>
          {(p.city || p.governorate) && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-3.5" aria-hidden />
              {fmt.list([p.city, p.governorate ? te('gov.', p.governorate) : null])}
            </span>
          )}
          {p.phone && (
            <a href={`tel:${p.phone}`} className="inline-flex min-h-6 items-center gap-1 hover:text-fg" dir="ltr">
              <Phone className="size-3.5" />
              {p.phone}
            </a>
          )}
          <span>
            {t('common.language')}: {p.preferred_language === 'ar' ? 'العربية' : 'English'}
          </span>
        </div>
      </div>
      {p.care_team.length > 0 && (
        <div className="w-full shrink-0 sm:w-auto sm:max-w-xs">
          <div className="mb-1 text-xs font-medium text-fg-muted">{t('pv.careTeam')}</div>
          <ul className="space-y-0.5 text-sm">
            {p.care_team.map((m) => (
              <li key={m.user_id} className="flex items-center gap-2">
                <span className="font-medium">{m.full_name}</span>
                <span className="text-xs text-fg-muted">
                  {te('role.', m.role)}
                  {m.organization ? ` · ${m.organization}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
