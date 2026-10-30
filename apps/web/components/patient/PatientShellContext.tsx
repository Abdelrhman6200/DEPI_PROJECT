'use client';

import { createContext, useContext } from 'react';

export interface PatientShellApi {
  openEmergency: () => void;
  /** Calm reminder of the low-sugar (15-15) plan; not the full-screen emergency page. */
  openHypoPlan: () => void;
  openLogGlucose: (onSaved?: () => void) => void;
  /** Open "Message my care team", optionally pre-filled (e.g. with a Companion question). */
  openMessageTeam: (prefill?: string) => void;
  /** Remind the person to measure again after a low (a phone notification when allowed, otherwise in the app). */
  remindRecheck: (minutes: number) => void;
}

export const PatientShellContext = createContext<PatientShellApi>({
  openEmergency: () => {},
  openHypoPlan: () => {},
  openLogGlucose: () => {},
  openMessageTeam: () => {},
  remindRecheck: () => {},
});

export function usePatientShell() {
  return useContext(PatientShellContext);
}
