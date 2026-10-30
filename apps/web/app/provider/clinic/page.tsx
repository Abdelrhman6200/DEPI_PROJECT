'use client';

import { useState } from 'react';
import { Check, Inbox, ListOrdered, Plus, UserPlus, Users, X } from 'lucide-react';
import type { ClinicAppointment, ClinicDispatchPage, ClinicRequest, ClinicUrgency, UUID } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation, useVisibleInterval } from '@/lib/useApi';
import { Card, CardHeader, PageHeader } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/Button';
import { Field, Input, Select, Textarea } from '@/components/Field';
import { Dialog } from '@/components/Dialog';
import { Async } from '@/components/Async';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCard } from '@/components/Skeleton';
import { useErrorToast, useToast } from '@/components/Toast';
import { ClinicUrgencyBadge, useClinicNames } from '@/components/clinic/ClinicBits';

/**
 * Reception dispatch board (polyclinic). At the top, the four numbers that matter; then the requests waiting for a
 * decision, grouped by urgency (most urgent first, as the server sorts them), with one main action each; today's
 * appointments; folded: offers waiting for the patient and the waitlist. One request for the screen, refreshed every 30 s.
 */
export default function DispatchBoardPage() {
  const { t } = useLocale();
  const q = useApi('clinic', 'dispatch_page', {});
  useVisibleInterval(() => void q.reload(true), 30_000);
  const [walkIn, setWalkIn] = useState(false);
  const reload = () => void q.reload(true);
  return (
    <div className="space-y-5">
      <PageHeader
        title={t('clinic.d.title')}
        subtitle={t('clinic.d.subtitle')}
        action={<Button icon={<UserPlus className="size-4" />} onClick={() => setWalkIn(true)}>{t('clinic.d.walkIn')}</Button>}
      />
      <Async state={q} skeleton={<SkeletonCard lines={6} />} isEmpty={() => false}>
        {(d) => (
          <>
            <Board d={d} reload={reload} />
            <WalkInDialog open={walkIn} onClose={() => setWalkIn(false)} d={d} onDone={reload} />
          </>
        )}
      </Async>
    </div>
  );
}

function Board({ d, reload }: { d: ClinicDispatchPage; reload: () => void }) {
  const { t } = useLocale();
  const tiles: [string, number, typeof Inbox, boolean][] = [
    [t('clinic.d.waiting'), d.counts.waiting_decision, Inbox, d.counts.waiting_decision > 0],
    [t('clinic.d.offered'), d.counts.offered, ListOrdered, false],
    [t('clinic.d.booked'), d.counts.today_booked, Check, false],
    [t('clinic.d.waitlist'), d.counts.waitlist, Users, false],
  ];
  const groups: ClinicUrgency[] = ['urgent', 'priority', 'routine'];
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map(([label, n, Icon, hot]) => (
          <div key={label} className={`rounded-2xl border p-4 ${hot ? 'border-warn/60 bg-warn-soft' : 'border-line bg-surface'}`}>
            <div className="flex items-center gap-2 text-sm text-fg-muted"><Icon className="size-4" aria-hidden />{label}</div>
            <div className="num mt-1 text-3xl font-bold">{n}</div>
          </div>
        ))}
      </div>

      <Card>
        <CardHeader title={t('clinic.d.decide')} icon={<Inbox className="size-5" />} />
        {d.requests.length === 0 ? (
          <EmptyState compact title={t('clinic.d.none')} />
        ) : (
          <div className="space-y-4">
            {groups.map((u) => {
              const rows = d.requests.filter((r) => (r.urgency ?? 'routine') === u);
              if (!rows.length) return null;
              return (
                <section key={u}>
                  <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg-muted"><ClinicUrgencyBadge urgency={u} /> {rows.length}</h3>
                  <ul className="space-y-2">
                    {rows.map((r) => <RequestRow key={r.id} r={r} d={d} onDone={reload} />)}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title={t('clinic.d.today')} />
        {d.appointments.length === 0 ? (
          <EmptyState compact title={t('clinic.d.noAppointments')} />
        ) : (
          <ul className="divide-y divide-line">
            {[...d.appointments].sort((a, b) => a.starts_at.localeCompare(b.starts_at)).map((a) => <AppointmentRow key={a.id} a={a} onDone={reload} />)}
          </ul>
        )}
      </Card>

      {(d.offered.length > 0 || d.waitlist.length > 0) && <FoldedLists d={d} onDone={reload} />}
    </>
  );
}

/** One request: who, what, the suggested routing, and the main action (accept); the other choices in a dialog. */
function RequestRow({ r, d, onDone }: { r: ClinicRequest; d: ClinicDispatchPage; onDone: () => void }) {
  const { t, te, pick, fmt } = useLocale();
  const names = useClinicNames();
  const { mutate, pending } = useMutation();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [more, setMore] = useState(false);
  const p = r.patient;
  const routing = r.status === 'triaging';
  async function accept() {
    try {
      const res = await mutate('clinic', 'accept', { request_id: r.id });
      toast(t('clinic.d.acceptedAt', { d: `${fmt.weekday(res.starts_at)} ${fmt.time(res.starts_at)}` }));
      onDone();
    } catch (e) {
      errorToast(e);
      onDone();
    }
  }
  return (
    <li className={`rounded-2xl border p-3 ${r.urgency === 'urgent' ? 'border-danger/60' : 'border-line'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{names.person(p)}</span>
        {p && <span className="text-sm text-fg-muted">{[p.age !== null ? t('clinic.d.age', { n: p.age }) : null, p.sex ? te('clinic.sex.', p.sex) : null, p.mrn].filter(Boolean).join(' · ')}</span>}
        {r.status === 'escalated' && <Badge tone="danger">{t('clinic.d.personDecides')}</Badge>}
        {routing ? <Badge tone="info">{t('clinic.d.routing')}</Badge> : <Badge tone={r.triaged_by === 'model' ? 'info' : 'neutral'}>{r.triaged_by === 'model' ? t('clinic.d.aiSuggestion') : t('clinic.d.needsRouting')}</Badge>}
      </div>
      {(r.chief_complaint || r.chief_complaint_ar) && <p dir="auto" className="mt-1 text-base">{pick(r.chief_complaint ?? '', r.chief_complaint_ar ?? null)}</p>}
      {((r.red_flags?.length ?? 0) > 0 || (r.review_reasons?.length ?? 0) > 0) && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {r.red_flags?.map((f) => <Badge key={f} tone="danger">{f}</Badge>)}
          {r.review_reasons?.filter((x) => x !== 'red_flag').map((x) => <Badge key={x} tone="warn">{te('clinic.review.', x)}</Badge>)}
        </div>
      )}
      {!routing && (
        <p className="mt-1 text-sm text-fg-muted">
          {r.specialty ? names.specialty(r.specialty) : t('clinic.d.noSpecialty')}
          {r.doctor ? ` · ${names.doctor(r.doctor)}` : ''}
          {r.proposed_at ? ` · ${fmt.weekday(r.proposed_at)} ${fmt.time(r.proposed_at)}` : ''}
        </p>
      )}
      {(r.routing_reason || r.confidence !== null && r.confidence !== undefined) && (
        <details className="mt-1 text-sm text-fg-muted">
          <summary className="inline-flex min-h-9 cursor-pointer items-center font-medium text-primary-strong">{t('clinic.d.why')}</summary>
          {r.routing_reason && <p dir="auto" className="leading-6">{pick(r.routing_reason, r.routing_reason_ar ?? null)}</p>}
          {r.confidence !== null && r.confidence !== undefined && <p>{t('clinic.d.confidence', { n: Math.round(r.confidence * 100) })}</p>}
        </details>
      )}
      {!routing && (
        <div className="mt-2 flex flex-wrap gap-2">
          {r.doctor && r.proposed_at && r.status !== 'escalated' && (
            <Button size="sm" icon={<Check className="size-4" />} loading={pending} onClick={() => void accept()}>{t('clinic.d.accept')}</Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setMore(true)}>{t('clinic.d.otherChoices')}</Button>
        </div>
      )}
      <ChoicesDialog open={more} onClose={() => setMore(false)} r={r} d={d} onDone={() => { setMore(false); onDone(); }} />
    </li>
  );
}

/** Another doctor or times, the waitlist, or decline. */
function ChoicesDialog({ open, onClose, r, d, onDone }: { open: boolean; onClose: () => void; r: ClinicRequest; d: ClinicDispatchPage; onDone: () => void }) {
  const { t, fmt } = useLocale();
  const names = useClinicNames();
  const { mutate, pending } = useMutation();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [doctorId, setDoctorId] = useState<string>(r.doctor?.user_id ?? d.doctors[0]?.user_id ?? '');
  const [slots, setSlots] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const doc = d.doctors.find((x) => x.user_id === doctorId);
  async function run(f: () => Promise<unknown>, done: string) {
    try { await f(); toast(done); onDone(); } catch (e) { errorToast(e); }
  }
  return (
    <Dialog open={open} onClose={onClose} title={t('clinic.d.otherChoices')} description={names.person(r.patient)}>
      <div className="space-y-4">
        <Field label={t('clinic.d.doctor')}>
          <Select value={doctorId} onChange={(e) => { setDoctorId(e.target.value); setSlots([]); }}>
            {d.doctors.map((x) => <option key={x.user_id} value={x.user_id}>{names.doctor(x)} · {names.specialty(x.specialty ?? '')}</option>)}
          </Select>
        </Field>
        {doc && doc.next_slots.length > 0 && (
          <div>
            <p className="mb-1 text-sm text-fg-muted">{t('clinic.d.pickTimes')}</p>
            <div className="flex flex-wrap gap-2">
              {doc.next_slots.map((s) => {
                const on = slots.includes(s);
                return (
                  <Button key={s} size="sm" variant={on ? 'primary' : 'outline'} onClick={() => setSlots((xs) => (on ? xs.filter((x) => x !== s) : [...xs, s].slice(0, 3)))}>
                    {fmt.weekday(s)} {fmt.time(s)}
                  </Button>
                );
              })}
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button disabled={!doc || slots.length === 0} loading={pending} onClick={() => void run(() => mutate('clinic', 'offer', { request_id: r.id, doctor_user_id: doctorId as UUID, slots }), t('clinic.d.offerSent'))}>
            {t('clinic.d.offerTimes')}
          </Button>
          <Button variant="outline" disabled={!doc} loading={pending} onClick={() => void run(() => mutate('clinic', 'reassign', { request_id: r.id, doctor_user_id: doctorId as UUID }), t('clinic.d.reassigned'))}>
            {t('clinic.d.reassign')}
          </Button>
          {r.patient && (r.specialty || doc?.specialty) && (
            <Button variant="ghost" loading={pending}
              onClick={() => void run(() => mutate('clinic', 'waitlist_add', { patient_id: r.patient!.id, specialty: doc?.specialty ?? r.specialty!.code, doctor_user_id: doctorId as UUID }), t('clinic.d.addedToWaitlist'))}>
              {t('clinic.d.toWaitlist')}
            </Button>
          )}
        </div>
        <details className="border-t border-line pt-3">
          <summary className="inline-flex min-h-9 cursor-pointer items-center text-sm font-medium text-danger">{t('clinic.d.decline')}</summary>
          <Textarea className="mt-2" rows={2} dir="auto" placeholder={t('clinic.d.declineReason')} value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button className="mt-2" variant="danger" size="sm" icon={<X className="size-4" />} loading={pending}
            onClick={() => void run(() => mutate('clinic', 'decline', { request_id: r.id, reason: reason.trim() || undefined }), t('clinic.d.declined'))}>
            {t('clinic.d.decline')}
          </Button>
        </details>
      </div>
    </Dialog>
  );
}

/** Today's appointment with the next step it can take. */
function AppointmentRow({ a, onDone }: { a: ClinicAppointment; onDone: () => void }) {
  const { t, te, fmt } = useLocale();
  const names = useClinicNames();
  const { mutate, pending } = useMutation();
  const errorToast = useErrorToast();
  const toast = useToast();
  async function set(status: 'checked_in' | 'completed' | 'no_show' | 'cancelled') {
    try {
      const r = await mutate('clinic', 'set_status', { appointment_id: a.id, status });
      if (r && r.waitlist_offer) toast(t('clinic.d.slotOffered'));
      onDone();
    } catch (e) {
      errorToast(e);
    }
  }
  const open = ['booked', 'confirmed', 'requested'].includes(a.status);
  return (
    <li className="flex flex-wrap items-center gap-3 py-2.5">
      <span className="num w-14 text-base font-semibold">{fmt.time(a.starts_at)}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{names.person(a.patient)}</span>
          <ClinicUrgencyBadge urgency={a.urgency} />
          <Badge tone={a.status === 'completed' ? 'ok' : a.status === 'checked_in' ? 'primary' : a.status === 'no_show' || a.status === 'cancelled' ? 'danger' : 'neutral'}>{te('clinic.appt.', a.status)}</Badge>
        </div>
        <div className="text-sm text-fg-muted">{names.doctor(a.doctor ?? null)}{a.specialty ? ` · ${names.specialty(a.specialty)}` : ''}</div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {open && <Button size="xs" loading={pending} onClick={() => void set('checked_in')}>{t('clinic.d.checkIn')}</Button>}
        {a.status === 'checked_in' && <Button size="xs" variant="soft" loading={pending} onClick={() => void set('completed')}>{t('clinic.d.done')}</Button>}
        {open && <Button size="xs" variant="ghost" disabled={pending} onClick={() => void set('no_show')}>{t('clinic.d.noShow')}</Button>}
        {open && <Button size="xs" variant="ghost" disabled={pending} onClick={() => void set('cancelled')}>{t('clinic.d.cancel')}</Button>}
      </div>
    </li>
  );
}

/** Secondary: offers waiting for the patient, and the waitlist. */
function FoldedLists({ d, onDone }: { d: ClinicDispatchPage; onDone: () => void }) {
  const { t, fmt } = useLocale();
  const names = useClinicNames();
  const { mutate, pending } = useMutation();
  const errorToast = useErrorToast();
  return (
    <Card>
      {d.offered.length > 0 && (
        <details>
          <summary className="flex min-h-11 cursor-pointer items-center text-base font-medium">{t('clinic.d.offeredN', { n: d.offered.length })}</summary>
          <ul className="mt-1 space-y-1 text-sm">
            {d.offered.map((r) => (
              <li key={r.id}>{names.person(r.patient)} · {names.doctor(r.doctor)} · {r.offered_slots.map((s) => fmt.time(s.starts_at)).join(', ')}</li>
            ))}
          </ul>
        </details>
      )}
      {d.waitlist.length > 0 && (
        <details className={d.offered.length > 0 ? 'mt-2 border-t border-line pt-2' : ''}>
          <summary className="flex min-h-11 cursor-pointer items-center text-base font-medium">{t('clinic.d.waitlistN', { n: d.waitlist.length })}</summary>
          <ul className="mt-1 divide-y divide-line text-sm">
            {d.waitlist.map((w) => (
              <li key={w.id} className="flex items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1">{names.person(w.patient)} · {names.specialty(w.specialty)}{w.status === 'offered' ? ` · ${t('clinic.d.offeredSlot')}` : ''}</span>
                <Button size="xs" variant="ghost" disabled={pending} onClick={() => void mutate('clinic', 'waitlist_remove', { entry_id: w.id }).then(onDone, errorToast)}>{t('common.remove')}</Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

/** Walk-in: a patient already on today's board, or a new patient; the doctor's next free time unless one is chosen. */
function WalkInDialog({ open, onClose, d, onDone }: { open: boolean; onClose: () => void; d: ClinicDispatchPage; onDone: () => void }) {
  const { t, fmt } = useLocale();
  const names = useClinicNames();
  const { mutate, pending } = useMutation();
  const toast = useToast();
  const errorToast = useErrorToast();
  const known = new Map<string, { id: UUID; full_name: string; full_name_ar?: string | null }>();
  for (const x of [...d.requests.map((r) => r.patient), ...d.appointments.map((a) => a.patient), ...d.waitlist.map((w) => w.patient)]) {
    if (x && 'id' in x && x.id) known.set(x.id, x as { id: UUID; full_name: string; full_name_ar?: string | null });
  }
  const [patientId, setPatientId] = useState('');
  const [f, setF] = useState({ full_name: '', phone: '', date_of_birth: '', sex: 'female' as 'male' | 'female', reason: '' });
  const [doctorId, setDoctorId] = useState(d.doctors[0]?.user_id ?? '');
  const doc = d.doctors.find((x) => x.user_id === doctorId);
  const ready = !!doctorId && (patientId !== '' || (f.full_name.trim().length > 1 && f.phone.trim().length > 6 && /^\d{4}-\d{2}-\d{2}$/.test(f.date_of_birth)));
  async function save() {
    try {
      await mutate('clinic', 'walk_in', patientId
        ? { patient_id: patientId as UUID, doctor_user_id: doctorId as UUID }
        : { full_name: f.full_name.trim(), phone: f.phone.trim(), date_of_birth: f.date_of_birth, sex: f.sex, doctor_user_id: doctorId as UUID, reason: f.reason.trim() || undefined });
      toast(t('clinic.d.walkInDone'));
      onClose();
      onDone();
    } catch (e) {
      errorToast(e);
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title={t('clinic.d.walkIn')}
      footer={<Button icon={<Plus className="size-4" />} disabled={!ready} loading={pending} onClick={() => void save()}>{t('clinic.d.book')}</Button>}>
      <div className="space-y-3">
        <Field label={t('clinic.d.doctor')} hint={doc?.next_slots[0] ? t('clinic.d.nextFree', { d: `${fmt.weekday(doc.next_slots[0])} ${fmt.time(doc.next_slots[0])}` }) : undefined}>
          <Select value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
            {d.doctors.map((x) => <option key={x.user_id} value={x.user_id}>{names.doctor(x)} · {names.specialty(x.specialty ?? '')}</option>)}
          </Select>
        </Field>
        {known.size > 0 && (
          <Field label={t('clinic.d.knownPatient')}>
            <Select value={patientId} onChange={(e) => setPatientId(e.target.value)}>
              <option value="">{t('clinic.d.newPatient')}</option>
              {[...known.values()].map((p) => <option key={p.id} value={p.id}>{names.person(p)}</option>)}
            </Select>
          </Field>
        )}
        {!patientId && (
          <>
            <Field label={t('clinic.d.fullName')}><Input dir="auto" value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></Field>
            <Field label={t('clinic.d.phone')}><Input inputMode="tel" dir="ltr" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('clinic.d.birthDate')}><Input type="date" value={f.date_of_birth} onChange={(e) => setF({ ...f, date_of_birth: e.target.value })} /></Field>
              <Field label={t('clinic.d.sex')}>
                <Select value={f.sex} onChange={(e) => setF({ ...f, sex: e.target.value as 'male' | 'female' })}>
                  <option value="female">{t('clinic.d.female')}</option>
                  <option value="male">{t('clinic.d.male')}</option>
                </Select>
              </Field>
            </div>
            <Field label={t('clinic.d.reason')}><Input dir="auto" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
          </>
        )}
      </div>
    </Dialog>
  );
}
