'use client';

import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import type { ActionOf, CallOptions, Group, InputOf, OutputOf } from '@health/api-client';
import { api } from './api';
import { callKey, takeBundled } from './pageBundle';
import { useVisible } from './offline';

export interface ApiState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** Re-run the call. `silent` keeps current data visible (no skeleton). */
  reload: (silent?: boolean) => Promise<void>;
  /** Locally patch the cached data (optimistic updates). */
  setData: (updater: T | null | ((prev: T | null) => T | null)) => void;
}

/**
 * Fetch `group.action` with `data`. Re-fetches whenever the serialized input or `deps` change.
 * Pass `null` as data to skip the call (e.g. while a caregiver has not chosen a patient yet).
 * Data is remembered together with the input it was fetched for: when the input changes (another patient,
 * another range) the old answer is never shown for the new input; callers see `null` (a skeleton) instead.
 */
export function useApi<G extends Group, A extends ActionOf<G>>(
  group: G,
  action: A,
  data: InputOf<G, A> | null,
  deps: DependencyList = [],
  /** keepPrevious: keep showing the last answer while a new input loads ("Load more" on staff lists). */
  opts: { keepPrevious?: boolean } = {},
): ApiState<OutputOf<G, A>> {
  type Out = OutputOf<G, A>;
  const key = data === null ? null : JSON.stringify(data);
  const [result, setResult] = useState<{ key: string; data: Out } | null>(null);
  const [error, setError] = useState<{ key: string | null; error: Error } | null>(null);
  const [loading, setLoading] = useState<boolean>(data !== null);
  const seq = useRef(0);
  const dataRef = useRef(data);
  dataRef.current = data;
  const keyRef = useRef(key);
  keyRef.current = key;

  const run = useCallback(
    async (silent = false) => {
      const input = dataRef.current;
      const runKey = keyRef.current;
      const id = ++seq.current;
      if (input === null || runKey === null) {
        setLoading(false);
        return;
      }
      if (!silent) setLoading(true);
      setError(null);
      try {
        // Taken from the screen's page action when it started one (lib/pageBundle.ts); otherwise, or if it failed, asked alone.
        const bundled = takeBundled(callKey(group, action, input));
        const out = bundled ? ((await bundled.catch(() => api.call(group, action, input))) as Out) : await api.call(group, action, input);
        if (id === seq.current) setResult({ key: runKey, data: out });
      } catch (e) {
        if (id === seq.current) setError({ key: runKey, error: e instanceof Error ? e : new Error(String(e)) });
      } finally {
        if (id === seq.current) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [group, action, key, ...deps],
  );

  useEffect(() => {
    void run();
  }, [run]);

  const setData = useCallback((updater: Out | null | ((prev: Out | null) => Out | null)) => {
    setResult((prev) => {
      const k = keyRef.current;
      if (k === null) return prev;
      const current = prev && prev.key === k ? prev.data : null;
      const next = typeof updater === 'function' ? (updater as (p: Out | null) => Out | null)(current) : updater;
      return next === null ? null : { key: k, data: next };
    });
  }, []);

  const current = result && (result.key === key || (opts.keepPrevious && key !== null)) ? result.data : null;
  const currentError = error && error.key === key ? error.error : null;
  // A new input whose first answer has not arrived yet is loading, even before the effect has started the call.
  const pendingFirst = key !== null && current === null && currentError === null;
  return { data: current, error: currentError, loading: loading || pendingFirst, reload: run, setData };
}

/** Imperative call helper with pending/error tracking for buttons and forms. */
export function useMutation() {
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<Error | null>(null);

  const mutate = useCallback(
    async <G extends Group, A extends ActionOf<G>>(group: G, action: A, data: InputOf<G, A>, opts?: CallOptions): Promise<OutputOf<G, A>> => {
      setPending((n) => n + 1);
      setError(null);
      try {
        return await api.call(group, action, data, opts);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      } finally {
        setPending((n) => n - 1);
      }
    },
    [],
  );

  /** Same as `mutate` for an action that the shared contract does not list yet (answer shape unchecked). */
  const mutateLoose = useCallback(async <T = unknown>(group: Group, action: string, data: unknown, opts?: CallOptions): Promise<T> => {
    setPending((n) => n + 1);
    setError(null);
    try {
      return await api.callLoose<T>(group, action, data, opts);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      throw err;
    } finally {
      setPending((n) => n - 1);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);
  return { mutate, mutateLoose, pending: pending > 0, error, clearError };
}

/** Re-render periodically so relative times ("3 min ago") stay fresh. */
export function useNow(intervalMs = 60000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now()); // a new pace starts from the current time
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * Run `cb` every `ms` while the page is visible, and once more as soon as a hidden tab becomes visible again
 * (phones suspend timers in the background, so data would otherwise be old when the person comes back).
 */
export function useVisibleInterval(cb: () => void, ms: number, enabled = true) {
  const visible = useVisible();
  const ref = useRef(cb);
  ref.current = cb;
  const wasVisible = useRef(visible);

  useEffect(() => {
    if (!enabled || !visible) return;
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms, enabled, visible]);

  useEffect(() => {
    if (enabled && visible && !wasVisible.current) ref.current();
    wasVisible.current = visible;
  }, [visible, enabled]);
}
