'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AlertOctagon, ArrowLeft, ArrowRight, CalendarDays, Clock, Send, Stethoscope } from 'lucide-react';
import type { ClinicPatientPage, ClinicRequest, ClinicWaitEntry } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation, useNow, useVisibleInterval } from '@/lib/useApi';
import { Card, CardHeader, PageHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Textarea } from '@/components/Field';
import { Async } from '@/components/Async';
import { SkeletonCard } from '@/components/Skeleton';
import { useErrorToast, useToast } from '@/components/Toast';
import { usePatientShell } from '@/components/patient/PatientShellContext';
import { ClinicUrgencyBadge, Money, useClinicNames } from '@/components/clinic/ClinicBits';

/**
 * Specialist visit (polyclinic): describe the problem in your own words, then answer when the clinic offers times.
 * What needs the person's answer comes first; past visits are folded. One request for the screen (clinic.patient_page).
 */
export default function ClinicPatientPage() {
  const { scope } = useAuth();
  const { t, dir } = useLocale();
  const q = useApi('clinic', 'patient_page', scope);
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  // While the clinic is routing a request or an offer is open, the answer can change at any moment.
  const waiting = !!q.data && (q.data.requests.some((r) => ['triaging', 'pending', 'escalated', 'offered'].includes(r.status)) || q.data.waitlist.some((w) => w.status === 'offered'));
  useVisibleInterval(() => void q.reload(true), 20_000, waiting);

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Link href="/app/care" className="-ms-2 inline-flex min-h-11 items-center gap-1.5 rounded-xl px-2 text-base font-medium text-fg-muted hover:bg-surface-2 hover:text-fg">
        <Back className="size-5" aria-hidden />
        {t('nav.care')}
      </Link>
      <PageHeader title={t('clinic.p.title')} subtitle={t('clinic.p.subtitle')} />
      <Async state={q} skeleton={<SkeletonCard lines={4} />} isEmpty={() => false}>
        {(d) => <PatientClinic d={d} reload={() => void q.reload(true)} />}
      </Async>
    </div>
  );
}

function PatientClinic({ d, reload }: { d: ClinicPatientPage; reload: () => void }) {
  const { t, fmt } = useLocale();
  const names = useClinicNames();
  const offered = d.requests.filter((r) => r.status === 'offered' && r.offered_slots.length > 0);
  const waitOffers = d.waitlist.filter((w) => w.status === 'offered' && w.offer_expires_at);
  const open = d.requests.filter((r) => ['triaging', 'pending', 'escalated'].includes(r.status));
  const upcoming = [...d.appointments].sort((a, b) => a.starts_at.localeCompare(b.starts_at));

  return (
    <>
      {/* What needs an answer from the person */}
      {offered.map((r) => <OfferCard key={r.id} r={r} onDone={reload} />)}
      {waitOffers.map((w) => <WaitOfferCard key={w.id} w={w} onDone={reload} />)}

      <RequestForm onSent={reload} />

      {open.length > 0 && (
        <Card>
          <CardHeader title={t('clinic.p.yourRequests')} icon={<Clock className="size-5" />} />
          <ul className="space-y-2">
            {open.map((r) => (
              <li key={r.id} className="rounded-xl border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-medium">{r.specialty ? names.specialty(r.specialty) : t('clinic.p.findingDoctor')}</span>
                  <ClinicUrgencyBadge urgency={r.urgency} />
                </div>
                <p className="mt-1 text-sm text-fg-muted">{t(`clinic.p.status.${r.status}` as 'clinic.p.status.pending')}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {upcoming.length > 0 && (
        <Card>
          <CardHeader title={t('clinic.p.upcoming')} icon={<CalendarDays className="size-5" />} />
          <ul className="space-y-2">
            {upcoming.map((a) => (
              <li key={a.id} className="flex items-center gap-3 rounded-xl border border-line p-3">
                <div className="min-w-0 flex-1">
                  <div className="text-base font-semibold">{fmt.weekday(a.starts_at)} · {fmt.time(a.starts_at)}</div>
                  <div className="text-sm text-fg-muted">{names.doctor(a.doctor ?? null)}{a.specialty ? ` · ${names.specialty(a.specialty)}` : ''}</div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {d.visits.length > 0 && (
        <Card>
          <CardHeader title={t('clinic.p.visits')} icon={<Stethoscope className="size-5" />} />
          <ul className="space-y-2">
            {d.visits.map((v, i) => (
              <li key={`${v.signed_at}-${i}`}>
                <details className="rounded-xl border border-line p-3" open={i === 0}>
                  <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-2 text-base font-medium">
                    {fmt.date(v.signed_at)} · {names.doctor(v.doctor)}
                  </summary>
                  <div className="mt-2 space-y-2 text-base leading-7">
                    {v.diagnosis && <p><span className="text-fg-muted">{t('clinic.p.diagnosis')}: </span><span dir="auto">{v.diagnosis}</span></p>}
                    {v.prescription_ar && (
                      <div className="rounded-xl bg-surface-2 p-3">
                        <div className="text-sm font-semibold text-fg-muted">{t('clinic.p.prescription')}</div>
                        <p dir="auto" className="whitespace-pre-line">{v.prescription_ar}</p>
                      </div>
                    )}
                    {v.follow_up_date && <p>{t('clinic.p.followUp', { d: fmt.date(v.follow_up_date) })}</p>}
                    {v.invoice_total_egp !== null && <p className="text-sm text-fg-muted">{t('clinic.p.total')}: <Money egp={v.invoice_total_egp} /></p>}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

/** Free text: the clinic finds the right specialist. Emergency signs get the fixed emergency text at once. */
function RequestForm({ onSent }: { onSent: () => void }) {
  const { t, pick } = useLocale();
  const { scope } = useAuth();
  const { openEmergency } = usePatientShell();
  const { mutate, pending } = useMutation();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [text, setText] = useState('');
  const [emergency, setEmergency] = useState<string | null>(null);

  async function send() {
    try {
      const r = await mutate('clinic', 'request', { ...scope, message: text.trim() });
      setText('');
      if (r.emergency) setEmergency(pick(r.message_en, r.message_ar));
      else toast(pick(r.message_en, r.message_ar));
      onSent();
    } catch (e) {
      errorToast(e);
    }
  }

  return (
    <>
      {emergency && (
        <div role="alert" className="rounded-2xl border-2 border-danger/70 bg-danger-soft p-4">
          <div className="flex items-start gap-3">
            <AlertOctagon className="mt-0.5 size-6 shrink-0 text-danger" aria-hidden />
            <div className="min-w-0 flex-1">
              <p dir="auto" className="text-lg font-bold leading-7 text-fg">{emergency}</p>
              <Button variant="danger" size="lg" className="mt-3 w-full sm:w-auto" onClick={openEmergency}>{t('clinic.p.emergencyHelp')}</Button>
            </div>
          </div>
        </div>
      )}
      <Card>
        <CardHeader title={t('clinic.p.ask')} subtitle={t('clinic.p.askHint')} />
        <Textarea rows={3} dir="auto" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('clinic.p.askPlaceholder')} />
        <Button size="lg" className="mt-3 w-full sm:w-auto" icon={<Send className="size-5" />} loading={pending} disabled={text.trim().length < 3} onClick={() => void send()}>
          {t('clinic.p.send')}
        </Button>
      </Card>
    </>
  );
}

/** The clinic offered times: one tap books one. */
function OfferCard({ r, onDone }: { r: ClinicRequest; onDone: () => void }) {
  const { t, fmt } = useLocale();
  const { scope } = useAuth();
  const names = useClinicNames();
  const { mutate } = useMutation();
  const errorToast = useErrorToast();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  async function choose(slot: string) {
    setBusy(slot);
    try {
      await mutate('clinic', 'choose_slot', { ...scope, request_id: r.id, slot });
      toast(t('clinic.p.booked', { d: `${fmt.weekday(slot)} ${fmt.time(slot)}` }));
      onDone();
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(null);
    }
  }
  return (
    <Card tone="primary">
      <h2 className="text-lg font-semibold">{t('clinic.p.chooseTime')}</h2>
      <p className="mt-1 text-base text-fg-muted">{names.doctor(r.doctor)}{r.specialty ? ` · ${names.specialty(r.specialty)}` : ''}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {r.offered_slots.map((s) => (
          <Button key={s.starts_at} size="lg" variant="outline" loading={busy === s.starts_at} onClick={() => void choose(s.starts_at)}>
            {fmt.weekday(s.starts_at)} · {fmt.time(s.starts_at)}
          </Button>
        ))}
      </div>
    </Card>
  );
}

/** A freed time from the waitlist, held for a few minutes. */
function WaitOfferCard({ w, onDone }: { w: ClinicWaitEntry; onDone: () => void }) {
  const { t, fmt } = useLocale();
  const { scope } = useAuth();
  const names = useClinicNames();
  const now = useNow(15_000);
  const { mutate, pending } = useMutation();
  const errorToast = useErrorToast();
  const left = Math.max(0, Math.round((new Date(w.offer_expires_at!).getTime() - now) / 60000));
  async function answer(accept: boolean) {
    try {
      await mutate('clinic', 'waitlist_answer', { ...scope, entry_id: w.id, accept });
      onDone();
    } catch (e) {
      errorToast(e);
      onDone();
    }
  }
  if (left <= 0) return null;
  return (
    <Card tone="primary">
      <h2 className="text-lg font-semibold">{t('clinic.p.waitOffer')}</h2>
      <p className="mt-1 text-base">
        {w.offered_at_slot ? `${fmt.weekday(w.offered_at_slot)} · ${fmt.time(w.offered_at_slot)}` : ''}
        {w.doctor ? ` · ${names.doctor(w.doctor)}` : ''}
      </p>
      <p className="mt-1 text-sm text-fg-muted">{t('clinic.p.minutesLeft', { n: left })}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="lg" loading={pending} onClick={() => void answer(true)}>{t('clinic.p.takeIt')}</Button>
        <Button size="lg" variant="ghost" disabled={pending} onClick={() => void answer(false)}>{t('clinic.p.notThisTime')}</Button>
      </div>
    </Card>
  );
}
