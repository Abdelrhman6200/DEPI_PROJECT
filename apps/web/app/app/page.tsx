'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function PatientIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/app/today');
  }, [router]);
  return null;
}
