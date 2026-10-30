'use client';

import { useState } from 'react';
import { BarChart3, Pencil, Plus } from 'lucide-react';
import type { ClinicCatalogPage, ClinicService, UUID } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { hasRole } from '@/lib/roles';
import { useApi, useMutation } from '@/lib/useApi';
import { Card, CardHeader, PageHeader } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/Button';
import { Field, Input, Select } from '@/components/Field';
import { Dialog } from '@/components/Dialog';
import { Segmented, Tabs } from '@/components/Tabs';
import { Async } from '@/components/Async';
import { SkeletonCard } from '@/components/Skeleton';
import { useErrorToast, useToast } from '@/components/Toast';
import { Money, useClinicNames } from '@/components/clinic/ClinicBits';

type Tab = 'numbers' | 'catalog';

/** Polyclinic administration: the clinic's numbers (from the records only) and the catalog of specialties, doctors and services. */
export default function ClinicAdminPage() {
  const { t } = useLocale();
  const [tab, setTab] = useState<Tab>('numbers');
  return (
    <div className="space-y-5">
      <PageHeader title={t('clinic.a.title')} />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: 'numbers', label: t('clinic.a.numbers') }, { id: 'catalog', label: t('clinic.a.catalog') }]} />
      {tab === 'numbers' ? <Numbers /> : <Catalog />}
    </div>
  );
}

const KPI_ORDER = ['requests', 'ai_triaged', 'routing_kept', 'minutes_to_decision', 'visits', 'revenue_egp', 'no_shows', 'waitlist_recoveries', 'referrals_kept_in_clinic'];

function Numbers() {
  const { t, te, fmt } = useLocale();
  const names = useClinicNames();
  const [days, setDays] = useState(30);
  const q = useApi('clinic', 'analytics_page', { days });
  return (
    <div className="space-y-4">
      <Segmented label={t('common.dayRange', { n: days })} options={[7, 30, 90].map((n) => ({ value: n, label: t('common.dayRange', { n }) }))} value={days} onChange={setDays} />
      <Async state={q} skeleton={<SkeletonCard lines={4} />} isEmpty={() => false}>
        {(d) => (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              {[...d.kpis].sort((a, b) => KPI_ORDER.indexOf(a.key) - KPI_ORDER.indexOf(b.key)).map((k) => (
                <div key={k.key} className="rounded-2xl border border-line bg-surface p-4">
                  <div className="text-sm text-fg-muted">{te('clinic.kpi.', k.key)}</div>
                  <div className="num mt-1 text-2xl font-bold">
                    {k.actual === null ? '–' : k.key === 'revenue_egp' ? <Money egp={k.actual} /> : k.unit === '%' ? fmt.pct(k.actual) : fmt.number(k.actual)}
                  </div>
                  {k.n !== undefined && <div className="text-xs text-fg-subtle">n = {k.n}</div>}
                </div>
              ))}
            </div>
            {d.by_specialty.length > 0 && (
              <Card>
                <CardHeader title={t('clinic.a.bySpecialty')} icon={<BarChart3 className="size-5" />} />
                <table className="w-full text-sm">
                  <thead><tr className="text-fg-muted"><th className="py-1 text-start font-medium">{t('clinic.a.specialty')}</th><th className="py-1 text-end font-medium">{t('clinic.a.requests')}</th><th className="py-1 text-end font-medium">{t('clinic.a.accepted')}</th></tr></thead>
                  <tbody>
                    {d.by_specialty.map((r) => (
                      <tr key={r.specialty.code} className="border-t border-line">
                        <td className="py-1.5">{r.specialty.code === 'untriaged' ? t('clinic.a.untriaged') : names.specialty(r.specialty)}</td>
                        <td className="num py-1.5 text-end">{r.requests}</td>
                        <td className="num py-1.5 text-end">{r.accepted}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </>
        )}
      </Async>
    </div>
  );
}

function Catalog() {
  const { t, pick } = useLocale();
  const { user } = useAuth();
  const names = useClinicNames();
  const canEdit = hasRole(user?.role, ['clinic_admin', 'platform_admin']);
  const q = useApi('clinic', 'catalog_page', {});
  const [doctor, setDoctor] = useState<ClinicCatalogPage['doctors'][number] | null>(null);
  const [service, setService] = useState<Partial<ClinicService> | null>(null);
  return (
    <Async state={q} skeleton={<SkeletonCard lines={6} />} isEmpty={() => false}>
      {(d) => (
        <div className="space-y-4">
          <Card>
            <CardHeader title={t('clinic.a.doctors')} />
            <ul className="divide-y divide-line">
              {[...d.doctors].sort((a, b) => Number(!a.profile) - Number(!b.profile)).map((x) => (
                <li key={x.user_id} className="flex flex-wrap items-center gap-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{pick(x.full_name, x.full_name_ar)}</span>
                    {x.profile ? (
                      <span className="block text-sm text-fg-muted">
                        {names.specialty(d.specialties.find((s) => s.code === x.profile!.specialty) ?? x.profile.specialty)} · <Money egp={x.profile.fee_egp} /> · {t('clinic.a.slotsN', { n: x.profile.daily_slots.length })}
                      </span>
                    ) : <span className="block text-sm text-fg-subtle">{t('clinic.a.notInClinic')}</span>}
                  </span>
                  {x.profile && !x.profile.active && <Badge>{t('clinic.a.inactive')}</Badge>}
                  {canEdit && <Button size="xs" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setDoctor(x)}>{x.profile ? t('common.edit') : t('clinic.a.addToClinic')}</Button>}
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <CardHeader title={t('clinic.a.services')} action={canEdit ? <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setService({ specialty: d.specialties[0]?.code, active: true, fasting_required: false, duration_min: 15 })}>{t('common.add')}</Button> : undefined} />
            {d.specialties.map((s) => {
              const list = d.services.filter((x) => x.specialty === s.code);
              if (!list.length) return null;
              return (
                <details key={s.code} className="border-t border-line py-1 first:border-t-0">
                  <summary className="flex min-h-11 cursor-pointer items-center text-base font-medium">{names.specialty(s)} · {list.length}</summary>
                  <ul className="mb-2 space-y-1">
                    {list.map((x) => (
                      <li key={x.id} className="flex items-center gap-2 text-sm">
                        <span className="min-w-0 flex-1">{pick(x.name, x.name_ar)}{x.fasting_required ? ` · ${t('clinic.a.fasting')}` : ''}{x.active === false ? ` · ${t('clinic.a.inactive')}` : ''}</span>
                        <Money egp={x.price_egp} />
                        {canEdit && <Button size="xs" variant="ghost" aria-label={t('common.edit')} icon={<Pencil className="size-3.5" />} onClick={() => setService(x)} />}
                      </li>
                    ))}
                  </ul>
                </details>
              );
            })}
          </Card>
          {doctor && <DoctorDialog doc={doctor} d={d} onClose={() => setDoctor(null)} onSaved={() => { setDoctor(null); void q.reload(true); }} />}
          {service && <ServiceDialog svc={service} d={d} onClose={() => setService(null)} onSaved={() => { setService(null); void q.reload(true); }} />}
        </div>
      )}
    </Async>
  );
}

function DoctorDialog({ doc, d, onClose, onSaved }: { doc: ClinicCatalogPage['doctors'][number]; d: ClinicCatalogPage; onClose: () => void; onSaved: () => void }) {
  const { t, pick } = useLocale();
  const names = useClinicNames();
  const { mutate, pending } = useMutation();
  const errorToast = useErrorToast();
  const toast = useToast();
  const p = doc.profile;
  const [f, setF] = useState({ specialty: p?.specialty ?? d.specialties[0]?.code ?? '', fee: String(p?.fee_egp ?? ''), slots: (p?.daily_slots ?? []).join(', '), minutes: String(p?.slot_minutes ?? 20), active: p?.active ?? true });
  async function save() {
    try {
      await mutate('clinic', 'doctor_save', { user_id: doc.user_id as UUID, specialty: f.specialty, fee_egp: Number(f.fee) || 0, daily_slots: f.slots, slot_minutes: Number(f.minutes) || 20, active: f.active });
      toast(t('common.saved'));
      onSaved();
    } catch (e) { errorToast(e); }
  }
  return (
    <Dialog open onClose={onClose} title={pick(doc.full_name, doc.full_name_ar)} footer={<Button loading={pending} onClick={() => void save()}>{t('common.save')}</Button>}>
      <div className="space-y-3">
        <Field label={t('clinic.a.specialty')}>
          <Select value={f.specialty} onChange={(e) => setF({ ...f, specialty: e.target.value })}>
            {d.specialties.map((s) => <option key={s.code} value={s.code}>{names.specialty(s)}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('clinic.a.fee')}><Input inputMode="numeric" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} /></Field>
          <Field label={t('clinic.a.slotMinutes')}><Input inputMode="numeric" value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })} /></Field>
        </div>
        <Field label={t('clinic.a.dailySlots')} hint={t('clinic.a.dailySlotsHint')}><Input dir="ltr" value={f.slots} onChange={(e) => setF({ ...f, slots: e.target.value })} /></Field>
        <label className="flex min-h-10 items-center gap-2"><input type="checkbox" className="size-4" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />{t('clinic.a.activeLabel')}</label>
      </div>
    </Dialog>
  );
}

function ServiceDialog({ svc, d, onClose, onSaved }: { svc: Partial<ClinicService>; d: ClinicCatalogPage; onClose: () => void; onSaved: () => void }) {
  const { t } = useLocale();
  const names = useClinicNames();
  const { mutate, pending } = useMutation();
  const errorToast = useErrorToast();
  const toast = useToast();
  const [f, setF] = useState({ specialty: svc.specialty ?? '', name: svc.name ?? '', name_ar: svc.name_ar ?? '', price: String(svc.price_egp ?? ''), minutes: String(svc.duration_min ?? 15), fasting: !!svc.fasting_required, active: svc.active !== false });
  const ok = f.name.trim().length > 1 && f.name_ar.trim().length > 1 && Number(f.price) >= 0 && f.price !== '';
  async function save() {
    try {
      await mutate('clinic', 'service_save', { ...(svc.id ? { id: svc.id } : {}), specialty: f.specialty, name: f.name.trim(), name_ar: f.name_ar.trim(), price_egp: Number(f.price), duration_min: Number(f.minutes) || 15, fasting_required: f.fasting, active: f.active });
      toast(t('common.saved'));
      onSaved();
    } catch (e) { errorToast(e); }
  }
  return (
    <Dialog open onClose={onClose} title={svc.id ? t('clinic.a.editService') : t('clinic.a.newService')} footer={<Button disabled={!ok} loading={pending} onClick={() => void save()}>{t('common.save')}</Button>}>
      <div className="space-y-3">
        <Field label={t('clinic.a.specialty')}>
          <Select value={f.specialty} onChange={(e) => setF({ ...f, specialty: e.target.value })}>
            {d.specialties.map((s) => <option key={s.code} value={s.code}>{names.specialty(s)}</option>)}
          </Select>
        </Field>
        <Field label={t('clinic.a.nameEn')}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={t('clinic.a.nameAr')}><Input dir="rtl" value={f.name_ar} onChange={(e) => setF({ ...f, name_ar: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('clinic.a.price')}><Input inputMode="numeric" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
          <Field label={t('clinic.a.duration')}><Input inputMode="numeric" value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })} /></Field>
        </div>
        <label className="flex min-h-10 items-center gap-2"><input type="checkbox" className="size-4" checked={f.fasting} onChange={(e) => setF({ ...f, fasting: e.target.checked })} />{t('clinic.a.fastingLabel')}</label>
        <label className="flex min-h-10 items-center gap-2"><input type="checkbox" className="size-4" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />{t('clinic.a.activeLabel')}</label>
      </div>
    </Dialog>
  );
}
