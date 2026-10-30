import type { Role } from '@health/api-client';

export const PATIENT_ROLES: Role[] = ['patient', 'caregiver'];
export const PROVIDER_ROLES: Role[] = [
  'doctor',
  'nurse',
  'receptionist',
  'clinic_admin',
  'safety_officer',
  'platform_admin',
  'capacity_operator',
  'transfer_coordinator',
];
export const ADMIN_ROLES: Role[] = ['clinic_admin', 'safety_officer', 'platform_admin'];
export const CAPACITY_ROLES: Role[] = ['capacity_operator', 'clinic_admin', 'platform_admin'];

export function isPatientRole(r: Role | undefined | null): boolean {
  return !!r && PATIENT_ROLES.includes(r);
}

/** Clinic staff: patient list, schedule and referrals. */
export const CLINICAL_ROLES: Role[] = ['doctor', 'nurse', 'receptionist', 'clinic_admin'];
/** Staff who may read clinical details: the inbox and the patient record. Reception staff may not. */
export const INBOX_ROLES: Role[] = ['doctor', 'nurse', 'clinic_admin'];
/** Staff who verify facts, acknowledge safety findings and write referrals. */
export const CLINICIAN_ROLES: Role[] = ['doctor', 'nurse'];
/** Cross-clinic operations data (event queue, incidents). */
export const PLATFORM_ROLES: Role[] = ['safety_officer', 'platform_admin'];

/** Landing page per role (operations roles do not have a clinical inbox). */
export function homeFor(r: Role): string {
  if (isPatientRole(r)) return '/app/today';
  switch (r) {
    case 'capacity_operator':
      return '/provider/network';
    case 'safety_officer':
      return '/provider/admin?tab=audit';
    case 'platform_admin':
      return '/provider/admin';
    case 'transfer_coordinator':
      return '/provider/transfers';
    case 'receptionist':
      return '/provider/appointments';
    default:
      return '/provider';
  }
}

export function hasRole(r: Role | undefined | null, list: Role[]): boolean {
  return !!r && list.includes(r);
}

/** Who can see and work transfers between facilities (platform administrators do not see patient transfers). */
export const TRANSFER_ROLES: Role[] = ['doctor', 'nurse', 'transfer_coordinator', 'clinic_admin'];
/** Who may use break-glass emergency access. */
export const BREAK_GLASS_ROLES: Role[] = ['doctor', 'nurse'];
/** Who can accept or decline patient join requests. */
export const LINK_DECIDER_ROLES: Role[] = ['doctor', 'clinic_admin'];
/** Who may approve or retire knowledge-base documents. */
export const KB_APPROVER_ROLES: Role[] = ['safety_officer', 'clinic_admin'];
/** Who may approve or reject a new guideline edition (the backend allows only the safety officer). */
export const GUIDELINE_APPROVER_ROLES: Role[] = ['safety_officer'];
/** Who manages staff accounts: create, deactivate, reset passwords. */
export const USER_ADMIN_ROLES: Role[] = ['clinic_admin', 'platform_admin'];
