'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, CalendarPlus } from 'lucide-react';
import type { FacilityMatch } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { PageHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { FacilitySearch } from '@/components/domain/Facility';
import { BookAppointmentDialog } from '@/components/domain/BookAppointmentDialog';

export default function FindCarePage() {
  const { scope } = useAuth();
  const { t, dir } = useLocale();
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  const [params, setParams] = useState<{ specialty?: string; type?: string; episode?: string } | null>(null);
  const [booking, setBooking] = useState<FacilityMatch | null>(null);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setParams({
      specialty: p.get('specialty') ?? undefined,
      type: p.get('type') ?? undefined,
      episode: p.get('episode') ?? undefined,
    });
  }, []);

  return (
    <div className="space-y-5">
      <Link href="/app/care" className="inline-flex min-h-11 items-center gap-1 text-base text-fg-muted hover:text-fg">
        <Back className="size-4" />
        {t('nav.care')}
      </Link>
      <PageHeader title={t('net.title')} />
      {params && (
        <FacilitySearch
          patient
          directory
          initialSpecialty={params.specialty}
          initialType={params.type}
          // Emergency departments, urgent care and pharmacies are visited without an appointment.
          // Directory listings have no booking agreement with the app: the card shows their phone number instead.
          renderAction={(f) =>
            ['emergency_department', 'urgent_care', 'pharmacy'].includes(f.type) || f.verified === false ? undefined : (
              <Button size="sm" variant="soft" icon={<CalendarPlus className="size-4" />} onClick={() => setBooking(f)}>
                {t('care.book')}
              </Button>
            )
          }
        />
      )}
      <BookAppointmentDialog
        open={!!booking}
        onClose={() => setBooking(null)}
        patientId={scope.patient_id}
        facilities={booking ? [booking] : undefined}
        defaultFacilityId={booking?.id}
        episodeId={params?.episode}
      />
    </div>
  );
}
