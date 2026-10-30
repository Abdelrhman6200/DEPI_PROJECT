'use client';

import { Fragment, useEffect, useState } from 'react';
import Link from 'next/link';
import { CalendarDays, ChevronRight, ClipboardList, HeartHandshake, MapPinned, MessageSquareText, MoonStar, Plus, ScanSearch, Send, Stethoscope, Thermometer, UsersRound } from 'lucide-react';
import type { Appointment } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import { Card, CardHeader, PageHeader } from '@/components/Card';
import { Button, ButtonLink } from '@/components/Button';
import { Async } from '@/components/Async';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCard, SkeletonList } from '@/components/Skeleton';
import { CarePlanView } from '@/components/domain/CarePlanView';
import { AppointmentRow, ReferralRow, ScreeningRow } from '@/components/domain/Rows';
import { BookAppointmentDialog } from '@/components/domain/BookAppointmentDialog';
import { EpisodeFollowupForm, EpisodeRow } from '@/components/domain/EpisodeViews';
import { ConnectClinicCard } from '@/components/patient/ConnectClinicCard';
import { ShareFamilyTest } from '@/components/patient/TodayExtras';
import { MyDiabetesDoctor } from '@/components/patient/MyDiabetesDoctor';
import { usePatientShell } from '@/components/patient/PatientShellContext';
import { useErrorToast, useToast } from '@/components/Toast';
import { ConfirmDialog, useConfirm } from '@/components/ConfirmDialog';

/** Screenings that are confirmed by a lab result, not by the person. */
const LAB_SCREENINGS = ['uacr', 'lipids', 'hba1c'];
import { ShowMoreList } from '@/components/ShowMoreList';
import { CareTeamThread, CaregiverManager } from '@/components/patient/People';
import { usePage } from '@/lib/pageBundle';

export default function CarePage() {
  const { scope, user } = useAuth();
  const { t, te, pick, fmt } = useLocale();
  const errorToast = useErrorToast();
  const toast = useToast();
  usePatientShell();
  // One request for the screen (lib/pageBundle.ts); each card still asks alone if its part is missing.
  usePage('care', 'page', scope, [
    ['profile', 'get', scope, 'profile'], ['care', 'plan', scope, 'plan'], ['care', 'screenings', scope, 'screenings'],
    ['care', 'appointments', scope, 'appointments'], ['network', 'referrals', scope, 'referrals'], ['episodes', 'list', scope, 'episodes'],
    ['care', 'messages', scope, 'messages'], ['care', 'caregivers', {}, 'caregivers'], ['care', 'my_doctor', scope, 'my_doctor'],
  ]);
  const profile = useApi('profile', 'get', scope);
  const plan = useApi('care', 'plan', scope);
  const screenings = useApi('care', 'screenings', scope);
  const appts = useApi('care', 'appointments', scope);
  const referrals = useApi('network', 'referrals', scope);
  const episodes = useApi('episodes', 'list', scope);
  const { mutate } = useMutation();
  const [bookOpen, setBookOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const cancelling = useConfirm<Appointment>();
  const unlinked = profile.data?.tier === 'unlinked';

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('book') === '1') setBookOpen(true);
  }, []);

  // /app/care#messages, #family, #screenings: the sections fill in after loading, so scroll once they exist
  const loaded = !!appts.data && !!plan.data;
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash || !loaded) return;
    const id = setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
    return () => clearTimeout(id);
  }, [loaded]);

  async function markScreening(type: string) {
    setBusy(`scr-${type}`);
    try {
      const list = await mutate('care', 'record_screening', { ...scope, type });
      screenings.setData(() => list);
      toast(t('common.saved'));
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(null);
    }
  }

  async function cancelAppt(id: string) {
    setBusy(id);
    try {
      await mutate('care', 'cancel_appointment', { appointment_id: id });
      void appts.reload(true);
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title={t('care.title')}
        action={
          <ButtonLink href="/app/care-access" size="lg" className="sm:hidden" icon={<Stethoscope className="size-5" />}>
            {t('nav.needCare')}
          </ButtonLink>
        }
      />

      {unlinked && <ConnectClinicCard />}

      {/* care team + message */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <UsersRound className="size-5 text-primary" aria-hidden />
              {t('care.myTeam')}
            </h2>
            {profile.data && profile.data.care_team.length > 0 ? (
              <ul className="mt-2 space-y-1">
                {profile.data.care_team.map((m) => (
                  <li key={m.user_id} className="text-base">
                    <span className="font-medium">{m.full_name}</span>
                    <span className="text-fg-muted">
                      {' '}
                      · {te('role.', m.role)}
                      {m.organization ? ` · ${m.organization}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-base text-fg-muted">{profile.loading ? t('common.loading') : t('msg.noTeamBody')}</p>
            )}
          </div>
        </div>
        <p className="mt-3 text-base leading-7 text-fg-muted">{t('msg.cardBody')}</p>
        <Button size="lg" variant="outline" className="mt-3 w-full sm:w-auto" icon={<MessageSquareText className="size-5" />} onClick={() => document.getElementById('messages')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
          {t('msg.title')}
        </Button>
      </Card>

      {/* the diabetes doctor (own, or matched with on-call cover) and the emergency number */}
      <MyDiabetesDoctor scope={scope} />

      {/* care plan */}
      <Card>
        <CardHeader title={t('care.plan')} icon={<ClipboardList className="size-5" />} />
        <Async state={plan} skeleton={<SkeletonCard lines={5} className="border-0 p-0" />} isEmpty={() => false}>
          {(p) => (p.active ? <CarePlanView plan={p.active} /> : <EmptyState compact title={unlinked ? t('care.noPlanUnlinked') : t('care.noPlan')} />)}
        </Async>
      </Card>

      <Card>
        <CardHeader
          title={t('care.appointments')}
          icon={<CalendarDays className="size-5" />}
          action={
            <Button size="md" icon={<Plus className="size-4" />} onClick={() => setBookOpen(true)}>
              {t('care.book')}
            </Button>
          }
        />
        <Async state={appts} skeleton={<SkeletonList rows={2} />} empty={<EmptyState compact title={t('care.noAppts')} />}>
          {(list) => {
            const now = Date.now();
            const upcoming = list.filter((a) => new Date(a.starts_at).getTime() >= now && a.status !== 'cancelled').sort((a, b) => a.starts_at.localeCompare(b.starts_at));
            const rest = list.filter((a) => !upcoming.includes(a)).sort((a, b) => b.starts_at.localeCompare(a.starts_at));
            return (
            <ShowMoreList
              className="space-y-2"
              limit={Math.max(2, upcoming.length)}
              items={[...upcoming, ...rest]}
              render={(a) => (
                  <AppointmentRow
                    key={a.id}
                    appt={a}
                    action={
                      (a.status === 'requested' || a.status === 'booked') && new Date(a.starts_at).getTime() > Date.now() ? (
                        <Button size="md" variant="ghost" loading={busy === a.id} onClick={() => cancelling.ask(a)}>
                          {t('care.cancelAppt')}
                        </Button>
                      ) : undefined
                    }
                  />
              )}
            />
            );
          }}
        </Async>
      </Card>

      <Card>
        <CardHeader title={t('care.moreHelp')} />
        <Link href="/app/care/clinic" className="flex min-h-11 items-center gap-2 text-base font-semibold text-primary-strong hover:underline">
          <Stethoscope className="size-5" aria-hidden />
          {t('clinic.careLink')}
          <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden />
        </Link>
        <Link href="/app/care/find" className="inline-flex min-h-11 items-center gap-2 text-base font-semibold text-primary-strong hover:underline">
          <MapPinned className="size-5" aria-hidden />
          {t('net.title')}
          <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden />
        </Link>
        <Link href="/app/care/ramadan" className="mt-1 flex min-h-11 items-center gap-2 text-base font-semibold text-primary-strong hover:underline">
          <MoonStar className="size-5" aria-hidden />
          {t('ram.nav')}
          <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden />
        </Link>
        <Link href="/app/care/sick" className="mt-1 flex min-h-11 items-center gap-2 text-base font-semibold text-primary-strong hover:underline">
          <Thermometer className="size-5" aria-hidden />
          {t('sick.title')}
          <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden />
        </Link>
        <Link href="/app/care/wellbeing" className="mt-1 flex min-h-11 items-center gap-2 text-base font-semibold text-primary-strong hover:underline">
          <HeartHandshake className="size-5" aria-hidden />
          {t('wb.title')}
          <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden />
        </Link>
        <div className="mt-2"><ShareFamilyTest /></div>
      </Card>

      {(episodes.data?.length ?? 0) > 0 && (
      <Card>
        <CardHeader title={t('care.episodes')} icon={<Stethoscope className="size-5" />} />
        <Async state={episodes} skeleton={<SkeletonList rows={2} />} empty={<EmptyState compact title={t('care.noEpisodes')} />}>
          {(list) => (
            <ShowMoreList
              className="space-y-2"
              items={[...list].sort((a, b) => b.started_at.localeCompare(a.started_at))}
              render={(ep) => (
                  <EpisodeRow
                    key={ep.id}
                    ep={ep}
                    action={
                      ['INTAKE_IN_PROGRESS', 'ASSESSED', 'ROUTED', 'DRAFT'].includes(ep.status) ? (
                        <ButtonLink href={`/app/care-access?episode=${ep.id}`} variant="soft" size="md">
                          {t('care.continueRequest')}
                        </ButtonLink>
                      ) : undefined
                    }
                  >
                    {ep.status === 'FOLLOW_UP' && (
                      <EpisodeFollowupForm episode={ep} onDone={(next) => episodes.setData((xs) => (xs ? xs.map((x) => (x.id === next.id ? next : x)) : xs))} />
                    )}
                  </EpisodeRow>
              )}
            />
          )}
        </Async>
      </Card>
      )}

      {(referrals.data?.length ?? 0) > 0 && (
      <Card>
        <CardHeader title={t('care.referrals')} icon={<Send className="size-5" />} />
        <Async state={referrals} skeleton={<SkeletonList rows={2} />} empty={<EmptyState compact title={t('care.noReferrals')} />}>
          {(list) => <ShowMoreList className="space-y-2" items={list} render={(r) => <ReferralRow key={r.id} r={r} />} />}
        </Async>
      </Card>
      )}

      <Card id="screenings" className="scroll-mt-24">
        <CardHeader title={t('care.screenings')} icon={<ScanSearch className="size-5" />} />
        <Async state={screenings} skeleton={<SkeletonList rows={2} />} empty={<EmptyState compact title={t('care.noScreenings')} />}>
          {(list) => {
            const row = (s: (typeof list)[number]) => (
                  <ScreeningRow
                    key={s.type}
                    s={s}
                    action={
                      // Check-ups that are not lab tests are ticked off by the person; lab-based ones follow the results.
                      s.overdue && !LAB_SCREENINGS.includes(s.type) ? (
                        <Button size="md" variant="soft" loading={busy === `scr-${s.type}`} onClick={() => void markScreening(s.type)}>
                          {t('care.screeningDone')}
                        </Button>
                      ) : undefined
                    }
                  />
            );
            const due = list.filter((x) => x.overdue), ok = list.filter((x) => !x.overdue);
            return (
              <div className="space-y-2">
                {due.length ? due.map((s) => <Fragment key={s.type}>{row(s)}</Fragment>) : <p className="text-base text-ok">{t('care.screeningsAllOk')}</p>}
                {ok.length > 0 && (
                  <details>
                    <summary className="flex min-h-11 cursor-pointer items-center text-base font-medium text-primary-strong">{t('care.screeningsOk', { n: ok.length })}</summary>
                    <div className="mt-2 space-y-2">{ok.map((s) => <Fragment key={s.type}>{row(s)}</Fragment>)}</div>
                  </details>
                )}
              </div>
            );
          }}
        </Async>
      </Card>

      <CareTeamThread />

      {user?.role === 'patient' && <CaregiverManager />}

      {user?.role === 'caregiver' && (
      <Card tone="muted" className="flex items-start gap-3">
        <HeartHandshake className="mt-0.5 size-6 shrink-0 text-primary" aria-hidden />
        <div>
          <h2 className="text-base font-semibold">{t('care.caregiverNote')}</h2>
          <p className="mt-0.5 text-base leading-7 text-fg-muted">{t('care.caregiverNoteBody')}</p>
        </div>
      </Card>
      )}

      <BookAppointmentDialog open={bookOpen} onClose={() => setBookOpen(false)} patientId={scope.patient_id} onBooked={() => void appts.reload(true)} />
      <ConfirmDialog
        open={cancelling.open}
        onClose={cancelling.close}
        title={t('care.cancelApptTitle')}
        body={
          cancelling.target ? (
            <>
              <span className="font-semibold">
                {fmt.weekday(cancelling.target.starts_at)} · {fmt.time(cancelling.target.starts_at)}
              </span>
              {cancelling.target.facility_name && <span> · {cancelling.target.facility_name}</span>}
              <p className="mt-2 text-fg-muted">{t('care.cancelApptBody')}</p>
            </>
          ) : null
        }
        confirmLabel={t('care.cancelApptConfirm')}
        cancelLabel={t('care.keepAppt')}
        onConfirm={() => (cancelling.target ? cancelAppt(cancelling.target.id) : undefined)}
      />
    </div>
  );
}
