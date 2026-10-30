'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Appointment } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import { useAuth } from '@/lib/auth';
import { INBOX_ROLES, hasRole } from '@/lib/roles';
import { useErrorToast } from '@/components/Toast';
import { cairoStartOfDay, isoDate } from '@/lib/format';
import { PageHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Segmented } from '@/components/Tabs';
import { Async } from '@/components/Async';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonList } from '@/components/Skeleton';
import { AppointmentRow } from '@/components/domain/Rows';
import { ConfirmDialog, useConfirm } from '@/components/ConfirmDialog';

type Mode = 'day' | 'week';

/** Days follow the clinic's calendar (Cairo), whatever time zone the computer is set to. */
function startOfDay(d: Date) {
  return new Date(cairoStartOfDay(d.getTime()));
}
function addDays(d: Date, n: number) {
  // noon-safe step, then back to midnight: a summer-time change never shifts the day
  return new Date(cairoStartOfDay(d.getTime() + n * 86_400_000 + 3 * 3_600_000));
}
/** 0 = Sunday ... 6 = Saturday, on the Cairo calendar. */
function cairoWeekday(d: Date) {
  return new Date(`${isoDate(d)}T12:00:00Z`).getUTCDay();
}

export default function SchedulePage() {
  const { t, fmt, dir } = useLocale();
  const [mode, setMode] = useState<Mode>('day');
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));

  const { from, to } = useMemo(() => {
    const f = mode === 'week' ? addDays(anchor, -((cairoWeekday(anchor) + 1) % 7)) : anchor; // week starts Saturday (Egypt)
    const e = addDays(f, mode === 'week' ? 7 : 1);
    return { from: f, to: e };
  }, [anchor, mode]);

  const q = useApi('provider', 'schedule', { from: from.toISOString(), to: to.toISOString() });

  const shift = (n: number) => setAnchor((a) => addDays(a, n * (mode === 'week' ? 7 : 1)));

  const Prev = dir === 'rtl' ? ChevronRight : ChevronLeft;
  const Next = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const lastDay = new Date(to.getTime() - 1);

  return (
    <div>
      <PageHeader
        title={t('pv.schedule')}
        subtitle={mode === 'day' ? fmt.weekday(from) : `${fmt.shortDate(from)} – ${fmt.shortDate(lastDay)}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented<Mode>
              options={[
                { value: 'day', label: t('pv.day') },
                { value: 'week', label: t('pv.week') },
              ]}
              value={mode}
              onChange={setMode}
            />
            <div className="flex items-center gap-1">
              <Button size="sm" variant="outline" onClick={() => shift(-1)} aria-label={t('pv.prev')} icon={<Prev className="size-4" />} />
              <Button size="sm" variant="outline" onClick={() => setAnchor(startOfDay(new Date()))}>
                {t('pv.today')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => shift(1)} aria-label={t('pv.next')} icon={<Next className="size-4" />} />
            </div>
          </div>
        }
      />
      <Async state={q} skeleton={<SkeletonList rows={5} />} empty={<EmptyState title={t('pv.noAppts')} icon={<CalendarDays className="size-7" />} />}>
        {(list) => <Grouped list={list} onChanged={() => void q.reload(true)} />}
      </Async>
    </div>
  );
}

/** The next sensible steps for an appointment in each state. */
const NEXT_STEPS: Partial<Record<Appointment['status'], ('booked' | 'checked_in' | 'completed' | 'no_show' | 'cancelled')[]>> = {
  requested: ['booked', 'cancelled'],
  booked: ['checked_in', 'no_show', 'cancelled'],
  checked_in: ['completed'],
};

function Grouped({ list, onChanged }: { list: Appointment[]; onChanged: () => void }) {
  const { fmt, t } = useLocale();
  const { user } = useAuth();
  const { mutate } = useMutation();
  const errorToast = useErrorToast();
  const [busy, setBusy] = useState<string | null>(null);
  const canOpenRecord = hasRole(user?.role, INBOX_ROLES);
  // "did not come" and "cancel" end the appointment: confirmed first
  const ending = useConfirm<{ a: Appointment; status: 'no_show' | 'cancelled' }>();
  async function setStatus(a: Appointment, status: 'booked' | 'checked_in' | 'completed' | 'no_show' | 'cancelled') {
    setBusy(`${a.id}-${status}`);
    try {
      await mutate('care', 'update_appointment', { appointment_id: a.id, status });
      onChanged();
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(null);
    }
  }
  const groups = useMemo(() => {
    const m = new Map<string, Appointment[]>();
    for (const a of [...list].sort((x, y) => x.starts_at.localeCompare(y.starts_at))) {
      const k = isoDate(new Date(a.starts_at));
      m.set(k, [...(m.get(k) ?? []), a]);
    }
    return [...m.entries()];
  }, [list]);
  return (
    <div className="space-y-5">
      {groups.map(([day, appts]) => (
        <section key={day}>
          <h2 className="mb-2 text-sm font-semibold text-fg-muted">{fmt.weekday(day + 'T12:00:00Z')}</h2>
          <div className="space-y-2">
            {appts.map((a) => (
              <AppointmentRow
                pro
                key={a.id}
                appt={a}
                showPatient
                action={
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    {(NEXT_STEPS[a.status] ?? []).map((s) => (
                      <Button
                        key={s}
                        size="sm"
                        variant={s === 'cancelled' || s === 'no_show' ? 'ghost' : 'soft'}
                        loading={busy === `${a.id}-${s}`}
                        onClick={() => (s === 'no_show' || s === 'cancelled' ? ending.ask({ a, status: s }) : void setStatus(a, s))}
                      >
                        {t(`pv.apptDo.${s}`)}
                      </Button>
                    ))}
                    {canOpenRecord && (
                      <Link href={`/provider/patients/${a.patient_id}`} className="shrink-0 text-sm font-medium text-primary-strong hover:underline">
                        {t('pv.openWorkspace')}
                      </Link>
                    )}
                  </div>
                }
              />
            ))}
          </div>
        </section>
      ))}
      <ConfirmDialog
        open={ending.open}
        onClose={ending.close}
        title={
          ending.target
            ? t(ending.target.status === 'no_show' ? 'pv.noShowTitle' : 'pv.cancelApptTitle', { name: ending.target.a.patient_name })
            : ''
        }
        body={
          ending.target ? (
            <>
              {fmt.weekday(ending.target.a.starts_at)} · {fmt.time(ending.target.a.starts_at)}
              <p className="mt-2 text-fg-muted">{t(ending.target.status === 'no_show' ? 'pv.noShowBody' : 'pv.cancelApptBody')}</p>
            </>
          ) : null
        }
        confirmLabel={ending.target ? t(`pv.apptDo.${ending.target.status}`) : ''}
        cancelLabel={t('common.back')}
        onConfirm={() => (ending.target ? setStatus(ending.target.a, ending.target.status) : undefined)}
      />
    </div>
  );
}
