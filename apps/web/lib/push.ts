'use client';

import { api } from './api';
import type { Locale } from '@health/api-client';

/**
 * Web push on this device: the browser asks the person, then subscribes with the platform's public key, and the
 * subscription is saved for the signed-in user (profile.push_subscribe). What arrives is a generic text ("medicine
 * reminder", "sugar alert") that opens the app; health details stay in the app.
 */
export type PushState = 'unsupported' | 'unavailable' | 'denied' | 'off' | 'on';

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function publicKey(): Promise<string | null> {
  try {
    const r = await fetch('/api/push-key', { cache: 'no-store' });
    const j = (await r.json()) as { key: string | null };
    return j.key;
  } catch {
    return null;
  }
}

function keyBytes(b64u: string): Uint8Array {
  const s = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64u.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await registration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) return 'on';
  return (await publicKey()) ? 'off' : 'unavailable';
}

export async function enablePush(locale: Locale): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  const key = await publicKey();
  if (!key) return 'unavailable';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';
  const reg = (await registration()) ?? (await navigator.serviceWorker.ready);
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) as BufferSource });
  const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  await api.call('profile', 'push_subscribe', {
    endpoint: j.endpoint ?? '',
    keys: { p256dh: j.keys?.p256dh ?? '', auth: j.keys?.auth ?? '' },
    locale,
    user_agent: navigator.userAgent.slice(0, 200),
  });
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  const reg = await registration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => false);
    await api.call('profile', 'push_unsubscribe', { endpoint }).catch(() => undefined);
  }
  return 'off';
}
