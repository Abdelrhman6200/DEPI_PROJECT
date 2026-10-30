'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CaregiverRegisterInput, RegisterInput, SessionUser, UUID } from '@health/api-client';
import { api, TOKEN_KEY, UNAUTHORIZED_EVENT, USER_KEY } from './api';
import { clearOfflineCaches, clearQueue } from './offline';

const CAREGIVER_PATIENT_KEY = 'session.caregiverPatient';
/** Id of the last account that signed in on this device: a different account starts with a clean device. */
const LAST_USER_KEY = 'session.lastUser';
/** Re-read the session user at most this often when the tab becomes visible again. */
const REFRESH_EVERY_MS = 5 * 60_000;
const REFRESH_AT_KEY = 'session.userReadAt';
function readRefreshAt(): number {
  try { return typeof window === 'undefined' ? 0 : Number(sessionStorage.getItem(REFRESH_AT_KEY)) || 0; } catch { return 0; }
}
function writeRefreshAt(at: number) {
  try { sessionStorage.setItem(REFRESH_AT_KEY, String(at)); } catch { /* private mode: ask again next time */ }
}

/** Result of the first sign-in step: a session, or a request for a two-factor code. */
export type LoginStep = { user: SessionUser; mfaToken?: undefined } | { user?: undefined; mfaToken: string };

interface AuthContextValue {
  /** true once the stored session has been read from localStorage */
  ready: boolean;
  user: SessionUser | null;
  token: string | null;
  login: (email: string, password: string) => Promise<LoginStep>;
  verifyMfa: (mfaToken: string, code: string) => Promise<SessionUser>;
  register: (input: RegisterInput | CaregiverRegisterInput) => Promise<SessionUser>;
  /** Re-read the session user (auth.me), e.g. after enabling two-factor. */
  refreshUser: () => Promise<void>;
  logout: () => Promise<void>;
  /** The patient whose record the patient app shows (self for patients, chosen patient for caregivers). */
  activePatientId: UUID | null;
  setActivePatientId: (id: UUID | null) => void;
  /**
   * Spread into patient-scoped API inputs. Patients omit patient_id (their own record is used);
   * caregivers pass the selected patient's id.
   */
  scope: { patient_id?: UUID };
  /**
   * False for a family member whose access to the chosen person does not include changing the record
   * (medicines, conditions, allergies, profile, sensor, clinic links). Patients always manage their own record.
   */
  canManageRecord: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [caregiverPatient, setCaregiverPatient] = useState<UUID | null>(null);

  // When the signed-in user was last re-read, kept for the tab: a reload or a new page does not ask again within 5 minutes.
  const lastRefresh = useRef(readRefreshAt());

  useEffect(() => {
    const tk = safeGet(TOKEN_KEY);
    const raw = safeGet(USER_KEY);
    if (tk && raw) {
      try {
        setUser(JSON.parse(raw) as SessionUser);
        setToken(tk);
      } catch {
        safeSet(TOKEN_KEY, null);
        safeSet(USER_KEY, null);
      }
    }
    setCaregiverPatient(safeGet(CAREGIVER_PATIENT_KEY));
    setReady(true);
  }, []);

  /**
   * End the session. `wipeDevice` (sign-out) also forgets readings saved offline and the offline page caches.
   * An expired session keeps them: the queue belongs to this account and is sent after the next sign-in.
   */
  const clear = useCallback((wipeDevice = false) => {
    safeSet(TOKEN_KEY, null);
    safeSet(USER_KEY, null);
    safeSet(CAREGIVER_PATIENT_KEY, null);
    if (wipeDevice) {
      safeSet(LAST_USER_KEY, null);
      clearQueue();
      void clearOfflineCaches();
    }
    setUser(null);
    setToken(null);
    setCaregiverPatient(null);
  }, []);

  useEffect(() => {
    const onUnauthorized = () => clear();
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [clear]);

  const startSession = useCallback((tk: string, u: SessionUser) => {
    const last = safeGet(LAST_USER_KEY);
    if (last && last !== u.id) {
      // another person signs in on this device: nothing of the previous account may be sent or shown
      clearQueue();
      void clearOfflineCaches();
    }
    safeSet(LAST_USER_KEY, u.id);
    lastRefresh.current = Date.now(); // the answer we just got is fresh
    safeSet(TOKEN_KEY, tk);
    safeSet(USER_KEY, JSON.stringify(u));
    setToken(tk);
    setUser(u);
    if (u.role === 'caregiver') {
      const first = u.caregiver_patient_ids.length === 1 ? u.caregiver_patient_ids[0] : null;
      safeSet(CAREGIVER_PATIENT_KEY, first);
      setCaregiverPatient(first);
    }
    return u;
  }, []);

  const login = useCallback(
    async (email: string, password: string): Promise<LoginStep> => {
      const res = await api.call('auth', 'login', { email, password });
      if ('mfa_required' in res && res.mfa_required) return { mfaToken: res.mfa_token };
      const ok = res as { token: string; user: SessionUser };
      return { user: startSession(ok.token, ok.user) };
    },
    [startSession],
  );

  const verifyMfa = useCallback(
    async (mfaToken: string, code: string) => {
      const res = await api.call('auth', 'verify_mfa', { mfa_token: mfaToken, code });
      return startSession(res.token, res.user);
    },
    [startSession],
  );

  const register = useCallback(
    async (input: RegisterInput | CaregiverRegisterInput) => {
      const res = await api.call('auth', 'register', input);
      return startSession(res.token, res.user);
    },
    [startSession],
  );

  const refreshUser = useCallback(async () => {
    lastRefresh.current = Date.now();
    writeRefreshAt(lastRefresh.current);
    const me = await api.call('auth', 'me', {});
    safeSet(USER_KEY, JSON.stringify(me));
    setUser(me);
    if (me.role === 'caregiver') {
      // access to a person can be withdrawn while signed in: drop a choice that is no longer allowed
      setCaregiverPatient((cur) => {
        if (cur && me.caregiver_patient_ids.includes(cur)) return cur;
        const next = me.caregiver_patient_ids.length === 1 ? me.caregiver_patient_ids[0] : null;
        safeSet(CAREGIVER_PATIENT_KEY, next);
        return next;
      });
    }
  }, []);

  // The stored user can be out of date (role, linked people, password reset): re-read it on start and when the
  // person comes back to the tab (at most every 5 minutes). Network errors are ignored; "unauthorized" ends the session.
  useEffect(() => {
    if (!ready || !token) return;
    if (Date.now() - lastRefresh.current > REFRESH_EVERY_MS) void refreshUser().catch(() => undefined);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRefresh.current > REFRESH_EVERY_MS) {
        void refreshUser().catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, token]);

  const logout = useCallback(async () => {
    try {
      await api.call('auth', 'logout', {});
    } catch {
      /* best effort */
    }
    clear(true);
  }, [clear]);

  const setActivePatientId = useCallback((id: UUID | null) => {
    safeSet(CAREGIVER_PATIENT_KEY, id);
    setCaregiverPatient(id);
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    let activePatientId: UUID | null = null;
    let scope: { patient_id?: UUID } = {};
    let canManageRecord = true;
    if (user?.role === 'patient') {
      activePatientId = user.patient_id;
    } else if (user?.role === 'caregiver') {
      const valid = caregiverPatient && user.caregiver_patient_ids.includes(caregiverPatient) ? caregiverPatient : null;
      activePatientId = valid;
      scope = valid ? { patient_id: valid } : {};
      // a session saved before access levels existed has no scopes: the service still checks every change
      const scopes = user.caregiver_patients?.find((p) => p.id === valid)?.scopes;
      canManageRecord = !scopes || scopes.includes('manage');
    }
    return { ready, user, token, login, verifyMfa, register, refreshUser, logout, activePatientId, setActivePatientId, scope, canManageRecord };
  }, [ready, user, token, login, verifyMfa, register, refreshUser, logout, caregiverPatient, setActivePatientId]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
