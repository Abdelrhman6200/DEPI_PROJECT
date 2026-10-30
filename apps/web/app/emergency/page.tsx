'use client';

import { useRouter } from 'next/navigation';
import { EmergencyScreen } from '@/components/EmergencyScreen';
import { LocaleToggle } from '@/components/LocaleToggle';

/** Public emergency page: no sign-in, no API calls. */
export default function EmergencyPage() {
  const router = useRouter();
  return (
    <div className="relative min-h-dvh">
      <EmergencyScreen onClose={() => (window.history.length > 1 ? router.back() : router.push('/'))} />
      <div className="mx-auto max-w-2xl px-4 pb-8 sm:px-6">
        <LocaleToggle />
      </div>
    </div>
  );
}
