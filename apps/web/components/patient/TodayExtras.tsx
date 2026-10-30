'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Car, HeartHandshake, Thermometer, Users } from 'lucide-react';
import type { DriveCheck, TodayPayload } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useMutation } from '@/lib/useApi';
import { Card } from '../Card';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { useErrorToast } from '../Toast';

/** On Today: sick-day mode, a due check-in and the before-driving check (insulin or a sulfonylurea). */
export function TodayExtras({ data }: { data: TodayPayload }) {
  const { t } = useLocale();
  const { user } = useAuth();
  const [drive, setDrive] = useState(false);
  const due = (data.wellbeing_due ?? []).filter((k) => k === 'paid5' || k === 'phq2');
  const showCheckin = user?.role === 'patient' && due.length > 0;
  return (
    <div className="space-y-3">
      {data.sick_day && (
        <Link href="/app/care/sick" className="flex items-center gap-3 rounded-2xl border-2 border-warn/60 bg-warn-soft p-4 text-warn-fg">
          <Thermometer className="size-6 shrink-0" aria-hidden />
          <span className="text-base font-semibold">{t('sick.todayBanner')}</span>
        </Link>
      )}
      <div className="flex flex-wrap gap-2">
        {data.drive_check && (
          <Button variant="outline" icon={<Car className="size-4" />} onClick={() => setDrive(true)}>{t('drive.button')}</Button>
        )}
        {!data.sick_day && (
          <Link href="/app/care/sick" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line px-4 text-sm font-medium hover:bg-surface-2">
            <Thermometer className="size-4" aria-hidden />{t('sick.imSick')}
          </Link>
        )}
      </div>
      {showCheckin && (
        <Card>
          <div className="flex flex-wrap items-center gap-3">
            <HeartHandshake className="size-6 text-primary" aria-hidden />
            <p className="min-w-0 flex-1 text-base">{t('wb.todayPrompt')}</p>
            <Link href="/app/care/wellbeing" className="inline-flex min-h-11 items-center rounded-xl bg-primary px-4 font-semibold text-primary-fg">{t('wb.start')}</Link>
          </div>
        </Card>
      )}
      <DriveDialog open={drive} onClose={() => setDrive(false)} />
    </div>
  );
}

/** Shares the public family diabetes-risk test (/check); shown on the Care page, not on Today. */
export function ShareFamilyTest() {
  const { t } = useLocale();
  async function share() {
    const url = `${window.location.origin}/check`;
    const text = t('famrisk.shareText');
    try {
      if (navigator.share) await navigator.share({ title: t('famrisk.title'), text, url });
      else { await navigator.clipboard.writeText(`${text} ${url}`); alert(t('famrisk.copied')); }
    } catch { /* cancelled */ }
  }
  return <Button variant="outline" icon={<Users className="size-4" />} onClick={() => void share()}>{t('famrisk.share')}</Button>;
}

function DriveDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useLocale();
  const { scope } = useAuth();
  const { mutate, pending } = useMutation();
  const errorToast = useErrorToast();
  const [r, setR] = useState<DriveCheck | null>(null);
  async function check() {
    try { setR(await mutate('glucose', 'drive_check', { ...scope })); } catch (e) { errorToast(e); }
  }
  return (
    <Dialog open={open} onClose={() => { setR(null); onClose(); }} title={t('drive.title')}
      footer={<Button onClick={() => void check()} loading={pending}>{t(r ? 'drive.again' : 'drive.check')}</Button>}>
      {!r ? (
        <p className="text-base leading-7">{t('drive.intro')}</p>
      ) : r.verdict === 'ok' ? (
        <div className="rounded-2xl bg-ok-soft p-4 text-ok-fg">
          <p className="text-lg font-semibold">{t('drive.ok', { v: r.value ?? '' })}</p>
          <p className="mt-1 text-base">{t('drive.okMore', { h: r.recheck_hours })}</p>
        </div>
      ) : r.verdict === 'eat_first' ? (
        <div className="rounded-2xl bg-danger-soft p-4 text-danger-fg" role="alert">
          <p className="text-lg font-semibold">{t('drive.low', { v: r.value ?? '', min: r.min_mgdl })}</p>
          <p className="mt-1 text-base">{t('drive.lowMore', { m: r.wait_after_low_min })}</p>
        </div>
      ) : (
        <div className="rounded-2xl bg-warn-soft p-4 text-warn-fg">
          <p className="text-lg font-semibold">{t('drive.measure')}</p>
          <p className="mt-1 text-base">{t('drive.measureMore', { min: r.min_mgdl })}</p>
        </div>
      )}
    </Dialog>
  );
}
