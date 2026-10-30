'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Building2, Clock, LocateFixed, MapPin, Navigation, Phone, Search, X } from 'lucide-react';
import type { FacilityMatch } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { useApi } from '@/lib/useApi';
import { cn } from '@/lib/cn';
import { Badge, type BadgeTone } from '../Badge';
import { Button } from '../Button';
import { Card } from '../Card';
import { useToast } from '../Toast';
import { Input, Select } from '../Field';
import { Async } from '../Async';
import { EmptyState } from '../EmptyState';
import { SkeletonList } from '../Skeleton';

export const FACILITY_TYPES = ['hospital', 'clinic', 'polyclinic', 'emergency_department', 'urgent_care', 'laboratory', 'imaging', 'pharmacy'];
export const SPECIALTIES = [
  'endocrinology',
  'internal_medicine',
  'family_medicine',
  'nephrology',
  'cardiology',
  'ophthalmology',
  'diabetic_foot',
  'neurology',
  'orthopedics',
  'nutrition',
  'emergency_medicine',
];

const CAP_TONE: Record<FacilityMatch['capacity'][number]['status'], BadgeTone> = {
  available: 'ok',
  limited: 'warn',
  full: 'danger',
  unknown: 'neutral',
};

/** A single capacity cell. Stale capacity is always shown as "unknown". */
export function CapacityCell({ c }: { c: FacilityMatch['capacity'][number] }) {
  const { t, te, fmt } = useLocale();
  const status = c.stale ? 'unknown' : c.status;
  return (
    <div className={cn('rounded-lg border px-2.5 py-1.5', c.stale ? 'border-dashed border-line bg-surface-2' : 'border-line bg-surface')}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-fg">{te('res.', c.resource)}</span>
        <Badge tone={CAP_TONE[status]}>{c.stale ? t('net.staleUnknown') : te('cap.', status)}</Badge>
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-fg-muted">
        <span className="num">{c.stale || c.available === null ? '—' : `${c.available}${c.total !== null ? ` / ${c.total}` : ''}`}</span>
        <span className="inline-flex items-center gap-1">
          <Clock className="size-3" />
          {c.updated_at ? t('net.updated', { t: fmt.relative(c.updated_at) }) : t('net.noUpdate')}
        </span>
      </div>
    </div>
  );
}

/**
 * Map coordinates of a facility when the service sends them (not part of the shared contract yet; read defensively
 * as lat/lng or latitude/longitude).
 */
function coordsOf(f: FacilityMatch): { lat: number; lng: number } | null {
  const x = f as FacilityMatch & { lat?: unknown; lng?: unknown; latitude?: unknown; longitude?: unknown };
  const lat = Number(x.lat ?? x.latitude);
  const lng = Number(x.lng ?? x.longitude);
  if (x.lat == null && x.latitude == null) return null;
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

/** `patient` replaces the bed and equipment grid (staff information) with one plain line about the emergency department. */
export function FacilityCard({ f, action, patient }: { f: FacilityMatch; action?: ReactNode; patient?: boolean }) {
  const { t, te, pick, fmt } = useLocale();
  const coords = coordsOf(f);
  const er = f.capacity.find((c) => c.resource === 'er_accepting');
  const erState = !er || er.stale ? null : er.status === 'full' ? 'full' : er.status === 'unknown' ? null : 'open';
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Building2 className="size-5 text-primary" aria-hidden />
            <span className="text-base font-semibold">{pick(f.name, f.name_ar)}</span>
            <Badge>{te('ftype.', f.type)}</Badge>
            {f.open_now !== null && <Badge tone={f.open_now ? 'ok' : 'neutral'}>{f.open_now ? t('net.openNow') : t('net.closed')}</Badge>}
            {f.verified === false && <Badge tone="warn" title={t('net.directoryHint')}>{t('net.directoryListing')}</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 text-sm text-fg-muted">
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-4" aria-hidden />
              {fmt.list([f.city !== f.governorate ? f.city : null, f.governorate ? te('gov.', f.governorate) : null])}
              {f.distance_km !== null && <> · {t('net.km', { n: fmt.number(f.distance_km, 1) })}</>}
            </span>
            {f.address && <span dir="auto">{f.address}</span>}
          </div>
          {f.specialties.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {f.specialties.map((s) => (
                <Badge key={s} tone="primary">
                  {te('spec.', s)}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {f.phone && (
            <a href={`tel:${f.phone}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-line-strong px-3 text-base font-medium hover:bg-surface-2">
              <Phone className="size-4" aria-hidden />
              {t('net.call')}
            </a>
          )}
          {coords && (
            <a
              href={`https://www.google.com/maps/dir/?api=1&destination=${coords.lat},${coords.lng}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-line-strong px-3 text-base font-medium hover:bg-surface-2"
            >
              <Navigation className="size-4" aria-hidden />
              {t('net.directions')}
              <span className="sr-only"> ({t('common.opensNewTab')})</span>
            </a>
          )}
          {action}
        </div>
      </div>
      {patient && erState && (
        <p className={cn('text-sm font-medium', erState === 'full' ? 'text-danger' : 'text-ok-fg')}>
          {t(erState === 'full' ? 'net.erFull' : 'net.erOpen')} · {t('net.updated', { t: fmt.relative(er!.updated_at) })}
        </p>
      )}
      {!patient && f.capacity.length > 0 && (
        <div>
          <div className="mb-1.5 text-sm font-medium text-fg-muted">{t('net.capacity')}</div>
          <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {f.capacity.map((c) => (
              <CapacityCell key={c.resource} c={c} />
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

/** Search box + type/specialty filters over network.search. */
export function FacilitySearch({
  initialSpecialty,
  initialType,
  renderAction,
  refreshKey = 0,
  variant = 'cards',
  patient,
  directory = false,
}: {
  /** also search the OpenStreetMap directory (unverified doctors, pharmacies, hospitals, labs in Cairo and Giza) */
  directory?: boolean;
  initialSpecialty?: string;
  initialType?: string;
  renderAction?: (f: FacilityMatch, reload: () => void) => ReactNode;
  refreshKey?: number;
  variant?: 'cards' | 'table';
  patient?: boolean;
}) {
  const { t, te } = useLocale();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [type, setType] = useState(initialType ?? '');
  const [specialty, setSpecialty] = useState(initialSpecialty ?? '');
  // the person's position, only when they ask for it ("Use my location"); results are then sorted by distance
  const [here, setHere] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(id);
  }, [q]);

  const res = useApi(
    'network',
    'search',
    {
      q: debounced || undefined,
      type: type || undefined,
      specialty: specialty || undefined,
      // rounded to about 100 m: enough to sort by distance, less precise than the device gives
      ...(here ? { lat: Math.round(here.lat * 1000) / 1000, lng: Math.round(here.lng * 1000) / 1000 } : {}),
      limit: 50,
      ...(directory ? { include_directory: true } : {}),
    },
    [refreshKey],
  );

  function locate() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      toast(t('net.locationUnavailable'), 'error');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setHere({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        toast(t(err.code === err.PERMISSION_DENIED ? 'net.locationDenied' : 'net.locationUnavailable'), 'error');
      },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * 60_000 },
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {here ? (
          <>
            <Badge tone="primary" icon={<LocateFixed className="size-3.5" aria-hidden />}>
              {t('net.nearYou')}
            </Badge>
            <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={() => setHere(null)}>
              {t('net.clearLocation')}
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" icon={<LocateFixed className="size-4" />} loading={locating} onClick={locate}>
            {t('net.useLocation')}
          </Button>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_12rem_12rem]">
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input type="search" className="ps-9" placeholder={t('net.search')} aria-label={t('net.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select value={type} onChange={(e) => setType(e.target.value)} aria-label={t('net.type')}>
          <option value="">{t('net.type')}: {t('common.all')}</option>
          {FACILITY_TYPES.map((x) => (
            <option key={x} value={x}>
              {te('ftype.', x)}
            </option>
          ))}
        </Select>
        <Select value={specialty} onChange={(e) => setSpecialty(e.target.value)} aria-label={t('net.specialty')}>
          <option value="">{t('net.specialty')}: {t('common.all')}</option>
          {SPECIALTIES.map((x) => (
            <option key={x} value={x}>
              {te('spec.', x)}
            </option>
          ))}
        </Select>
      </div>
      <Async state={res} skeleton={<SkeletonList rows={4} />} empty={<EmptyState title={t('net.noResults')} />}>
        {(list) =>
          variant === 'table' ? (
            <FacilityTable list={list} renderAction={(f) => renderAction?.(f, () => void res.reload(true))} />
          ) : (
            <div className="space-y-3">
              {list.map((f) => (
                <FacilityCard key={f.id} f={f} patient={patient} action={renderAction?.(f, () => void res.reload(true))} />
              ))}
              {list.some((f) => f.verified === false) && <p className="text-xs text-fg-muted">{t('net.directoryCredit')}</p>}
            </div>
          )
        }
      </Async>
    </div>
  );
}

/** Dense table variant for the provider Care Network page. */
export function FacilityTable({ list, renderAction }: { list: FacilityMatch[]; renderAction?: (f: FacilityMatch) => ReactNode }) {
  const { t, te, pick, fmt } = useLocale();
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
      <table className="w-full min-w-[60rem] text-sm">
        <thead className="sticky top-0 z-10 bg-surface-2 text-xs text-fg-muted">
          <tr>
            <th className="px-4 py-2.5 text-start font-medium">{t('net.facility')}</th>
            <th className="px-3 py-2.5 text-start font-medium">{t('net.type')}</th>
            <th className="px-3 py-2.5 text-start font-medium">{t('net.specialty')}</th>
            <th className="px-3 py-2.5 text-start font-medium">{t('net.capacity')}</th>
            <th className="px-3 py-2.5" />
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {list.map((f) => (
            <tr key={f.id} className="align-top">
              <td className="px-4 py-3">
                <div className="font-medium">{pick(f.name, f.name_ar)}</div>
                <div className="text-xs text-fg-muted">{fmt.list([f.city !== f.governorate ? f.city : null, f.governorate ? te('gov.', f.governorate) : null])}</div>
                {f.phone && (
                  <a href={`tel:${f.phone}`} className="inline-flex min-h-6 items-center text-xs text-primary-strong" dir="ltr">
                    {f.phone}
                  </a>
                )}
              </td>
              <td className="px-3 py-3">
                <Badge>{te('ftype.', f.type)}</Badge>
                {f.open_now !== null && (
                  <div className="mt-1">
                    <Badge tone={f.open_now ? 'ok' : 'neutral'}>{f.open_now ? t('net.openNow') : t('net.closed')}</Badge>
                  </div>
                )}
              </td>
              <td className="px-3 py-3">
                <div className="flex max-w-[14rem] flex-wrap gap-1">
                  {f.specialties.map((s) => (
                    <Badge key={s} tone="primary">
                      {te('spec.', s)}
                    </Badge>
                  ))}
                </div>
              </td>
              <td className="px-3 py-3">
                {f.capacity.length === 0 ? (
                  <span className="text-xs text-fg-subtle">{t('cap.unknown')}</span>
                ) : (
                  <div className="grid min-w-[22rem] gap-1.5 xl:grid-cols-2">
                    {f.capacity.map((c) => (
                      <CapacityCell key={c.resource} c={c} />
                    ))}
                  </div>
                )}
              </td>
              <td className="px-3 py-3 text-end">{renderAction?.(f)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
