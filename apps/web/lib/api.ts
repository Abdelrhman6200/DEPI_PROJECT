'use client';

import { ApiCallError, createClient, type ApiClient } from '@health/api-client';
import type { TKey } from './i18n';

export const TOKEN_KEY = 'session.token';
export const USER_KEY = 'session.user';
export const UNAUTHORIZED_EVENT = 'health:unauthorized';

function readToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Single shared API client. Browser calls go same-origin to /n8n, proxied to n8n by next.config rewrites. */
export const api: ApiClient = createClient({
  baseUrl: '/n8n',
  getToken: readToken,
  onUnauthorized: () => {
    // A failed sign-in also answers "unauthorized"; only end the session when one exists.
    if (typeof window !== 'undefined' && readToken()) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  },
});

/** True when the error means the device could not reach the server (offline, DNS, proxy down). */
export function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  return false;
}

export function errorCode(err: unknown): string | null {
  return err instanceof ApiCallError ? err.code : null;
}

/** True when the person cancelled the request (Cancel button, page change): show nothing. */
export function isAborted(err: unknown): boolean {
  return err instanceof ApiCallError ? err.code === 'aborted' : err instanceof DOMException && err.name === 'AbortError';
}

/**
 * Map any error to a friendly, translatable message key. Raw codes, backend messages and stack traces are
 * never shown to people; a few well-known backend messages get a specific, human explanation.
 */
export function errorKey(err: unknown): TKey {
  if (!err) return 'common.error';
  if (isNetworkError(err)) return 'err.network';
  if (err instanceof ApiCallError) {
    const msg = (err.message || '').toLowerCase();
    switch (err.code) {
      case 'unauthorized':
        if (/invalid email|password/.test(msg)) return 'err.badLogin';
        if (/expired/.test(msg)) return 'err.signInExpired';
        if (/code is not correct|mfa|totp/.test(msg)) return 'err.badCode';
        return 'err.unauthorized';
      case 'too_many_requests':
        if (/record searches/.test(msg)) return 'err.tooManySearches';
        return 'err.tooMany';
      case 'mfa_required':
        return 'err.mfaRequired';
      case 'password_change_required':
        return 'err.passwordChange';
      case 'unavailable':
        return 'err.unavailable';
      case 'timeout':
        return 'err.timeout';
      case 'aborted':
        return 'err.cancelled';
      case 'forbidden':
        if (/doctor or nurse/.test(msg)) return 'err.clinicianOnly';
        if (/family access/.test(msg)) return 'err.familyScope';
        if (/daily limit of emergency access/.test(msg)) return 'err.bgDailyLimit';
        if (/second person must approve/.test(msg)) return 'err.kbSecondApprover';
        return 'err.forbidden';
      case 'not_found':
        return 'err.notFound';
      case 'unknown_action':
        return 'err.notAvailable';
      case 'bad_request':
      case 'conflict':
        // Specific sentences first; the broad word matches further down would otherwise catch them.
        if (/already been reviewed/.test(msg)) return 'err.docReviewed';
        if (/emergency reason/.test(msg)) return 'err.bgReason';
        if (/invitation code/.test(msg)) return 'err.inviteCode';
        if (/reset link/.test(msg)) return 'err.resetLink';
        if (/5 open invitations|up to 5 family/.test(msg)) return 'err.inviteLimit';
        if (/only readings you typed/.test(msg)) return 'err.readingLocked';
        if (/date of the test|does not show the date/.test(msg)) return 'err.docDate';
        if (/already connected with this clinic/.test(msg)) return 'err.alreadyLinked';
        if (/two-factor sign-in is already on/.test(msg)) return 'err.mfaAlreadyOn';
        if (/in the future/.test(msg)) return 'err.futureDate';
        if (/outside the possible range|is not a number|must be a number/.test(msg) && !/target/.test(msg)) return 'err.labRange';
        if (/unit .* is not supported/.test(msg)) return 'err.labUnit';
        if (/times must be written|scheduled_time/.test(msg)) return 'err.timeFormat';
        if (/no confirmed free place/.test(msg)) return 'err.noCapacity';
        if (/cannot move from|cannot be changed after a bed/.test(msg)) return 'err.transferStep';
        if (/receiving facility first/.test(msg)) return 'err.transferFacility';
        if (/available cannot be more|whole numbers/.test(msg)) return 'err.capacityNumbers';
        if (/address must start|address cannot be used|standard https port|only the site address/.test(msg)) return 'err.nightscoutUrl';
        if (/finish the questions/.test(msg)) return 'err.finishQuestions';
        if (/report first/.test(msg)) return 'err.reportFirst';
        if (/no longer be changed/.test(msg)) return 'err.referralLocked';
        if (/\btarget\b|fasting range/.test(msg)) return 'err.planTarget';
        if (/email .*(already|exists)|already used|already exists/.test(msg)) return 'err.emailTaken';
        if (/\b18\b|adults aged/.test(msg)) return 'err.under18';
        if (/current password/.test(msg)) return 'err.wrongPassword';
        if (/password/.test(msg)) return 'err.weakPassword';
        if (/code is not correct|mfa|totp/.test(msg)) return 'err.badCode';
        if (/value_mgdl|glucose value|reading time/.test(msg)) return 'err.glucoseRange';
        if (/4 ?mb|too large/.test(msg)) return 'err.fileTooBig';
        return 'err.badRequest';
      default:
        return 'err.server';
    }
  }
  if (err instanceof Error && /fetch|network|failed to load/i.test(err.message)) return 'err.network';
  return 'err.server';
}

/**
 * The backend's own sentence for a refusal (validation, conflict, permission), in the person's language, when it has
 * one. Use it where errorKey() falls back to a generic message: the backend sentences are written for people.
 */
export function backendMessage(err: unknown, locale: 'ar' | 'en'): string | null {
  if (!(err instanceof ApiCallError) || !['bad_request', 'conflict', 'forbidden'].includes(err.code)) return null;
  return locale === 'ar' ? (err.messageAr ?? null) : (err.message || null);
}

/** Developer-facing detail (for console logs only). */
export function errorMessage(err: unknown): string {
  if (!err) return '';
  if (err instanceof ApiCallError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
