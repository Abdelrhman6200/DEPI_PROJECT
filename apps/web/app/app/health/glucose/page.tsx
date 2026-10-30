'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Plus } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { PageHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { GlucoseDashboard } from '@/components/domain/GlucoseDashboard';
import { NightscoutCard } from '@/components/patient/NightscoutCard';
import { usePatientShell } from '@/components/patient/PatientShellContext';

export default function GlucosePage() {
  const { scope } = useAuth();
  const { t, dir } = useLocale();
  const { openLogGlucose } = usePatientShell();
  const [refresh, setRefresh] = useState(0);
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  const log = () => openLogGlucose(() => setRefresh((n) => n + 1));

  // deep link: /app/health/glucose?log=1 opens the log dialog
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('log') === '1') openLogGlucose(() => setRefresh((n) => n + 1));
  }, [openLogGlucose]);

  return (
    <div className="space-y-5">
      <Link href="/app/health" className="-ms-2 inline-flex min-h-11 items-center gap-1.5 rounded-xl px-2 text-base font-medium text-fg-muted hover:bg-surface-2 hover:text-fg">
        <Back className="size-5" aria-hidden />
        {t('nav.health')}
      </Link>
      <PageHeader
        title={t('glu.title')}
        action={
          <Button size="lg" icon={<Plus className="size-5" />} onClick={log}>
            {t('today.logReading')}
          </Button>
        }
      />
      <GlucoseDashboard patientId={scope.patient_id} refreshKey={refresh} onLog={log} />
      <NightscoutCard onChanged={() => setRefresh((n) => n + 1)} />
    </div>
  );
}
