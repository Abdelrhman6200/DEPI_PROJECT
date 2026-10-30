'use client';

import { MapPin, Phone, Stethoscope } from 'lucide-react';
import type { UUID } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { useApi } from '@/lib/useApi';
import { Card } from '../Card';
import { Badge } from '../Badge';

/**
 * "Your diabetes doctor" (care.my_doctor, 41_doctor_match.js). A patient without a diabetes doctor of their own sees the
 * doctor matched for them from the directory and who covers their alerts meanwhile. Everyone sees the emergency number.
 */
export function MyDiabetesDoctor({ scope }: { scope: { patient_id?: UUID } }) {
  const { t, te, pick } = useLocale();
  const q = useApi('care', 'my_doctor', scope);
  const d = q.data;
  if (!d) return null;
  const m = d.matched;
  const place = m?.locations.find((l) => l.name) ?? m?.locations[0];
  return (
    <Card>
      {m && (
        <>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Stethoscope className="size-5 text-primary" aria-hidden />
            {t('mydoc.title')}
          </h2>
          <p className="mt-1 text-base text-fg-muted">{d.linked.length ? t('mydoc.otherSpecialty') : t('mydoc.notLinked')}</p>
          <div className="mt-3 rounded-xl border border-line p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span dir="auto" className="text-lg font-semibold">{pick(m.name_en ?? m.name_ar, m.name_ar)}</span>
              <Badge tone="primary">{te('mydoc.spec.', m.specialty)}</Badge>
            </div>
            {place && (
              <p className="mt-1 flex items-start gap-1.5 text-base">
                <MapPin className="mt-1 size-4 shrink-0 text-fg-muted" aria-hidden />
                <span dir="auto">{[place.name, place.address].filter(Boolean).join(' · ')}</span>
              </p>
            )}
            {m.areas.length > 0 && <p className="mt-1 text-sm text-fg-muted">{m.areas.join(' · ')}</p>}
            {m.phone && <a href={`tel:${m.phone}`} className="mt-1 inline-block text-base font-semibold text-primary-strong">{m.phone}</a>}
          </div>
          {d.covered_by && <p className="mt-2 text-sm text-fg-muted">{t('mydoc.covered', { clinic: pick(d.covered_by.name, d.covered_by.name_ar) })}</p>}
        </>
      )}
      <a href={`tel:${d.emergency_number}`}
        className={`${m ? 'mt-3 ' : ''}flex min-h-12 items-center gap-3 rounded-xl border-2 border-danger/60 bg-danger-soft px-4 text-base font-semibold text-danger-fg`}>
        <Phone className="size-5 shrink-0" aria-hidden />
        {t('mydoc.emergency', { n: d.emergency_number })}
      </a>
    </Card>
  );
}
