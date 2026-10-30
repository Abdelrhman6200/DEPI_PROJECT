'use client';

import type { Group } from '@health/api-client';
import { useRef } from 'react';
import { api } from './api';

/**
 * One request per screen. n8n answers one request at a time, so a screen whose parts each asked for their own data
 * waited for them in a queue. A screen starts its page action (e.g. glucose.page) while it renders, before any part has
 * asked; each part's useApi then takes its answer from that request instead of calling. When the page action fails
 * (an older server without it) or a part comes back as { error }, that part simply asks on its own, as before.
 */
const pending = new Map<string, { at: number; promise: Promise<unknown>; uses: number }>();
const started = new Map<string, number>();
const FRESH_MS = 20_000;

export const callKey = (group: string, action: string, input: unknown) => `${group}.${action}|${JSON.stringify(input)}`;

/** The answer for this call from a page action started in the last few seconds, or null (then call as usual). Used once. */
export function takeBundled(key: string): Promise<unknown> | null {
  const p = pending.get(key);
  if (!p) return null;
  if (--p.uses <= 0) pending.delete(key);
  return Date.now() - p.at < FRESH_MS ? p.promise : null;
}

/**
 * Start `group.action` with `input` and offer its parts to the calls listed in `parts` ([group, action, input, field,
 * uses]: how many callers may take it, e.g. 2 for notifications shown by the bell and by the page).
 * Safe to call on every render: the same page with the same input is started at most once per few seconds.
 */
export function startPage(group: Group, action: string, input: unknown, parts: ([Group, string, unknown, string] | [Group, string, unknown, string, number])[]) {
  const k = callKey(group, action, input);
  const now = Date.now();
  if (now - (started.get(k) ?? 0) < 3000) return;
  started.set(k, now);
  const all = api.callLoose<Record<string, unknown>>(group, action, input);
  for (const [g, a, i, field, uses = 1] of parts) {
    const promise = all.then((out) => {
      const v = out ? out[field] : undefined;
      if (v === undefined || (v !== null && typeof v === 'object' && !Array.isArray(v) && 'error' in v && Object.keys(v).length === 1)) {
        throw new Error('part not available');
      }
      return v;
    });
    promise.catch(() => undefined); // a part nobody takes must not be an unhandled rejection
    pending.set(callKey(g, a, i), { at: now, promise, uses });
  }
}

/**
 * startPage once per screen and input: when the screen first renders and again only when its input changes (another
 * patient, another range), never on the re-renders in between.
 */
export function usePage(group: Group, action: string, input: unknown, parts: Parameters<typeof startPage>[3]) {
  const last = useRef<string | null>(null);
  const k = callKey(group, action, input);
  if (last.current !== k) {
    last.current = k;
    startPage(group, action, input, parts);
  }
}
