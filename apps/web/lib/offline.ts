'use client';

import { useEffect, useState } from 'react';
import type { GlucoseContext, OutputOf, UUID } from '@health/api-client';
import { api, isNetworkError } from './api';

/** A glucose reading saved on the device while offline, sent with its original time once back online. */
export interface QueuedReading {
  id: string;
  /** The signed-in account that saved it: another account on the same device never sends (or sees) it. */
  user_id: UUID;
  /** The record it belongs to (a caregiver's chosen patient); absent for a patient's own record. */
  patient_id?: UUID;
  value_mgdl: number;
  context?: GlucoseContext;
  measured_at: string;
  queued_at: string;
}

export type GlucoseEvent = NonNullable<OutputOf<'glucose', 'add'>['event']>;

/** Result of sending the queue: how many readings were saved, how many the server refused, and any guidance. */
export interface FlushResult {
  sent: number;
  rejected: number;
  /** Guidance returned for queued readings (for example a low reading saved while offline). */
  events: { reading: QueuedReading; event: GlucoseEvent }[];
}

const KEY = 'queue.glucose';
export const QUEUE_EVENT = 'health:glucose-queue';

function readAll(): QueuedReading[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as QueuedReading[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Readings waiting for this account (all accounts when no id is given). Items without an owner are never sent. */
export function readQueue(userId?: UUID | null): QueuedReading[] {
  const all = readAll();
  return userId === undefined ? all : all.filter((r) => !!userId && r.user_id === userId);
}

function writeQueue(list: QueuedReading[]) {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new Event(QUEUE_EVENT));
}

export function enqueueReading(r: Omit<QueuedReading, 'id' | 'queued_at'>): QueuedReading {
  const item: QueuedReading = { ...r, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, queued_at: new Date().toISOString() };
  writeQueue([...readAll(), item]);
  return item;
}

/** Forget every queued reading (sign-out, or another account signing in on this device). */
export function clearQueue() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(QUEUE_EVENT));
}

/** Delete the service worker's page caches (public/sw.js) so pages seen in this session do not stay on the device. */
export async function clearOfflineCaches(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('dc-')).map((k) => caches.delete(k)));
  } catch {
    /* not available (private mode, older browser) */
  }
}

let flushing = false;

/**
 * Send this account's queued readings in order, each to the record it was saved for. Stops at the first network
 * failure; drops readings the server rejects (counted in `rejected`) so they do not block the rest.
 */
export async function flushQueue(userId: UUID): Promise<FlushResult> {
  const result: FlushResult = { sent: 0, rejected: 0, events: [] };
  if (flushing || typeof navigator === 'undefined' || navigator.onLine === false) return result;
  flushing = true;
  try {
    let queue = readQueue(userId);
    while (queue.length) {
      const r = queue[0];
      try {
        const res = await api.call('glucose', 'add', {
          ...(r.patient_id ? { patient_id: r.patient_id } : {}),
          value_mgdl: r.value_mgdl,
          context: r.context,
          measured_at: r.measured_at,
        });
        result.sent++;
        if (res.event) result.events.push({ reading: r, event: res.event });
      } catch (e) {
        if (isNetworkError(e)) break;
        // rejected by the server (e.g. out of range, or no longer allowed for this record)
        result.rejected++;
      }
      writeQueue(readAll().filter((x) => x.id !== r.id));
      queue = readQueue(userId);
    }
  } finally {
    flushing = false;
  }
  return result;
}

/** Number of this account's readings waiting to be sent; re-renders when the queue changes. */
export function useQueuedCount(userId: UUID | null | undefined): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const update = () => setN(userId ? readQueue(userId).length : 0);
    update();
    window.addEventListener(QUEUE_EVENT, update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(QUEUE_EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, [userId]);
  return n;
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

/** True when the page is visible (used to pause polling in background tabs). */
export function useVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}
