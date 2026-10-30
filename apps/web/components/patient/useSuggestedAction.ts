'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { usePatientShell } from './PatientShellContext';

/**
 * Maps action identifiers coming from the backend (companion suggested actions, focus card actions)
 * to UI navigation. Unknown actions that look like paths are navigated to; anything else is ignored.
 */
export function useSuggestedAction() {
  const router = useRouter();
  const { openEmergency, openHypoPlan, openLogGlucose, openMessageTeam } = usePatientShell();
  return useCallback(
    (action: string | null | undefined, onGlucoseSaved?: () => void) => {
      switch (action) {
        case 'open_care_access':
          router.push('/app/care-access');
          return;
        case 'log_glucose':
          openLogGlucose(onGlucoseSaved);
          return;
        case 'book_appointment':
          router.push('/app/care?book=1');
          return;
        case 'view_plan':
          router.push('/app/care');
          return;
        case 'call_emergency':
          openEmergency();
          return;
        // Reviewing the low-sugar plan is a calm reminder, not an emergency.
        case 'emergency_plan':
        case 'hypo_plan':
          openHypoPlan();
          return;
        case 'health':
        case 'medications':
          router.push('/app/health');
          return;
        case 'activity':
          router.push('/app/lifestyle');
          return;
        case 'message_team':
          openMessageTeam();
          return;
        case 'log_meal':
          router.push('/app/lifestyle');
          return;
        case 'view_glucose':
          router.push('/app/health/glucose');
          return;
        case 'screenings':
          router.push('/app/care#screenings');
          return;
        default:
          if (action && action.startsWith('/')) router.push(action);
      }
    },
    [router, openEmergency, openHypoPlan, openLogGlucose, openMessageTeam],
  );
}
