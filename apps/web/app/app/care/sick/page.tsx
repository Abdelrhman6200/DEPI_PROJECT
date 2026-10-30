'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft, ArrowRight, Droplets, Pill, Thermometer } from 'lucide-react';
import type { SickSymptom } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import { Card, CardHeader, PageHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Badge } from '@/components/Badge';
import { CheckRow } from '@/components/Field';
import { SkeletonCard } from '@/components/Skeleton';
import { useErrorToast, useToast } from '@/components/Toast';

const SYMPTOMS: SickSymptom[] = ['vomiting', 'diarrhea', 'fever', 'not_eating', 'not_drinking'];

/**
 * Sick-day mode (engine 33_wellbeing.js): the person says they are ill; the care team is told at once. The page shows
 * the medicines that usually need sick-day advice (the app never decides a pause), a glucose check every few hours,
 * fluids, and when to seek care now.
 */
export default function SickDayPage() {
  const { t, te, dir, fmt } = useLocale();
  const { scope } = useAuth();
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  const q = useApi('care', 'sick_status', { ...scope });
  const { mutate, pending } = useMutation();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [sym, setSym] = useState<Partial<Record<SickSymptom, boolean>>>({});

  async function start() {
    try { q.setData(await mutate('care', 'sick_start', { ...scope, symptoms: sym })); toast(t('sick.started')); } catch (e) { errorToast(e); }
  }
  async function end() {
    try { q.setData(await mutate('care', 'sick_end', { ...scope })); toast(t('sick.ended')); } catch (e) { errorToast(e); }
  }

  const s = q.data;
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Link href="/app/care" className="inline-flex min-h-11 items-center gap-1 text-base text-fg-muted hover:text-fg">
        <Back className="size-4" />
        {t('nav.care')}
      </Link>
      <PageHeader title={t('sick.title')} subtitle={t('sick.subtitle')} />
      {!s ? <SkeletonCard lines={4} /> : !s.active ? (
        <Card>
          <CardHeader title={t('sick.how')} icon={<Thermometer className="size-5" />} />
          <div className="space-y-2">
            {SYMPTOMS.map((k) => (
              <CheckRow key={k} checked={!!sym[k]} onChange={(v) => setSym((x) => ({ ...x, [k]: v }))} title={te('sick.sym.', k)} />
            ))}
          </div>
          <Button className="mt-4 w-full" size="lg" loading={pending} onClick={() => void start()}>{t('sick.start')}</Button>
        </Card>
      ) : (
        <>
          <Card tone="warn">
            <p className="text-base font-semibold">{t('sick.activeSince', { d: fmt.dateTime(s.started_at!) })}</p>
            <ul className="mt-2 list-disc space-y-1 ps-5 text-base leading-7">
              <li>{t('sick.checkEvery', { n: s.check_hours })}</li>
              <li>{t('sick.fluids')}</li>
              <li>{t('sick.eat')}</li>
              <li>{t('sick.teamTold')}</li>
            </ul>
            {s.readings && s.readings.count > 0 && (
              <p className="num mt-2 text-sm text-fg-muted">{t('sick.readings', { n: s.readings.count, lo: s.readings.lowest ?? '—', hi: s.readings.highest ?? '—' })}</p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <Link href="/app/today" className="inline-flex min-h-11 items-center gap-1 rounded-xl bg-primary px-4 font-semibold text-primary-fg"><Droplets className="size-4" />{t('sick.logReading')}</Link>
              <Button variant="outline" loading={pending} onClick={() => void end()}>{t('sick.end')}</Button>
            </div>
          </Card>
          {s.medicines.length > 0 && (
            <Card>
              <CardHeader title={t('sick.meds')} icon={<Pill className="size-5" />} subtitle={t('sick.medsHint')} />
              <ul className="divide-y divide-line">
                {s.medicines.map((m) => (
                  <li key={m.medication_id} className="flex flex-wrap items-center gap-2 py-2.5">
                    <bdi className="min-w-0 flex-1 font-semibold">{m.name}</bdi>
                    <Badge tone={m.note === 'never_stop' ? 'danger' : m.note === 'often_paused' ? 'warn' : 'neutral'}>{te('sick.note.', m.note)}</Badge>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card tone="danger">
            <CardHeader title={t('sick.seekNow')} icon={<AlertTriangle className="size-5" />} />
            <ul className="list-disc space-y-1 ps-5 text-base leading-7">
              {(['vomit', 'high', 'low', 'breath', 'drowsy', 'days'] as const).map((k) => <li key={k}>{te('sick.red.', k)}</li>)}
            </ul>
            <Link href="/app/care-access" className="mt-3 inline-flex min-h-11 items-center font-semibold text-danger underline-offset-4 hover:underline">{t('nav.needCare')}</Link>
          </Card>
        </>
      )}
    </div>
  );
}
