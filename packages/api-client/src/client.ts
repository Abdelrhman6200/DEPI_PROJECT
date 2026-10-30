import type { ActionOf, ApiResponse, Group, InputOf, OutputOf } from './types';

export class ApiCallError extends Error {
  /** The backend's Arabic version of the message, when it has one. */
  constructor(public code: string, message: string, public messageAr?: string) {
    super(message);
  }
}

export interface ClientOptions {
  /** Base URL that maps to n8n's /webhook path. In the web app this is the same-origin proxy "/n8n". */
  baseUrl: string;
  getToken: () => string | null;
  onUnauthorized?: () => void;
}

/** Per-call options: a caller's AbortSignal (Cancel buttons) and a time limit. */
export interface CallOptions {
  signal?: AbortSignal;
  /** Milliseconds before the call fails with code 'timeout'. Defaults: 120 s for AI actions, 30 s otherwise. */
  timeoutMs?: number;
}

/** Actions that run a model or a long upload; everything else answers within seconds. */
const SLOW_ACTIONS = new Set([
  'companion.send',
  'provider.generate_brief',
  'intake.start',
  'intake.answer',
  'intake.free_text',
  'admin.guideline_check',
  'clinical.upload_document',
  'glucose.read_meter',
]);
export const AI_TIMEOUT_MS = 120_000;
export const DEFAULT_TIMEOUT_MS = 30_000;

export function defaultTimeout(group: string, action: string): number {
  return SLOW_ACTIONS.has(`${group}.${action}`) ? AI_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

export function createClient(opts: ClientOptions) {
  async function send(group: string, action: string, data: unknown, callOpts: CallOptions = {}): Promise<unknown> {
    const token = opts.getToken();
    const timeoutMs = callOpts.timeoutMs ?? defaultTimeout(group, action);
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    const onAbort = () => ctrl.abort();
    if (callOpts.signal) {
      if (callOpts.signal.aborted) ctrl.abort();
      else callOpts.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      let res: Response;
      try {
        res = await fetch(`${opts.baseUrl}/api/v1/${group}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ action, data: data ?? {} }),
          signal: ctrl.signal,
        });
      } catch (e) {
        if (timedOut) throw new ApiCallError('timeout', 'The server did not answer in time.');
        if (callOpts.signal?.aborted) throw new ApiCallError('aborted', 'The request was cancelled.');
        throw e; // network failure (TypeError): the caller may queue or retry
      }
      let json: ApiResponse<unknown>;
      try {
        json = await res.json();
      } catch {
        if (timedOut) throw new ApiCallError('timeout', 'The server did not answer in time.');
        if (callOpts.signal?.aborted) throw new ApiCallError('aborted', 'The request was cancelled.');
        // A proxy or gateway page (502/503/504) instead of the API's JSON: the backend is down or restarting.
        if (res.status === 502 || res.status === 503 || res.status === 504) {
          throw new ApiCallError('unavailable', `The service is not reachable right now (HTTP ${res.status}).`);
        }
        throw new ApiCallError('server_error', `Backend returned HTTP ${res.status} without JSON. Is the n8n workflow active?`);
      }
      if (!json || typeof json !== 'object' || json.ok !== true) {
        const error = (json as { error?: { code?: string; message?: string; message_ar?: string } } | null)?.error;
        const code = error?.code ?? (res.status === 503 || res.status === 502 || res.status === 504 ? 'unavailable' : 'server_error');
        if (code === 'unauthorized') opts.onUnauthorized?.();
        throw new ApiCallError(code, error?.message ?? `The server returned HTTP ${res.status}.`, error?.message_ar);
      }
      return json.data;
    } finally {
      clearTimeout(timer);
      callOpts.signal?.removeEventListener('abort', onAbort);
    }
  }

  function call<G extends Group, A extends ActionOf<G>>(
    group: G,
    action: A,
    data?: InputOf<G, A>,
    callOpts?: CallOptions,
  ): Promise<OutputOf<G, A>> {
    return send(group, action, data, callOpts) as Promise<OutputOf<G, A>>;
  }

  /**
   * Untyped call for actions the backend has added but the shared contract does not list yet.
   * Callers must treat the answer as untrusted shape and handle 'unknown_action'.
   */
  function callLoose<T = unknown>(group: string, action: string, data?: unknown, callOpts?: CallOptions): Promise<T> {
    return send(group, action, data, callOpts) as Promise<T>;
  }

  return { call, callLoose };
}

export type ApiClient = ReturnType<typeof createClient>;
