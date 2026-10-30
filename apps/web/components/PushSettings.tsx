'use client';

import { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';
import { useLocale } from '@/lib/locale';
import { disablePush, enablePush, pushState, type PushState } from '@/lib/push';
import { Card } from './Card';
import { Button } from './Button';
import { useErrorToast, useToast } from './Toast';

/**
 * Notifications on this device (web push): medicine reminders, "did you take it?", refills, sugar alerts and messages
 * reach the phone even when the app is closed. The text says only what kind of update it is; details stay in the app.
 */
export function PushSettings() {
  const { t, locale } = useLocale();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void pushState().then(setState).catch(() => setState('unsupported'));
  }, []);

  async function toggle() {
    setBusy(true);
    try {
      const s = state === 'on' ? await disablePush() : await enablePush(locale);
      setState(s);
      toast(t(s === 'on' ? 'push.onDone' : s === 'denied' ? 'push.denied' : 'push.offDone'));
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  }

  if (state === null) return null;
  return (
    <Card aria-labelledby="push-title">
      <h2 id="push-title" className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <BellRing className="size-5 text-primary" aria-hidden />
        {t('push.title')}
      </h2>
      <p className="mb-4 text-base leading-7 text-fg-muted">{t('push.body')}</p>
      {state === 'unsupported' || state === 'unavailable' ? (
        <p className="rounded-xl bg-surface-2 px-4 py-3 text-base text-fg-muted">{t(state === 'unsupported' ? 'push.unsupported' : 'push.unavailable')}</p>
      ) : state === 'denied' ? (
        <p className="rounded-xl bg-warn-soft px-4 py-3 text-base text-warn-fg">{t('push.blocked')}</p>
      ) : (
        <Button variant={state === 'on' ? 'outline' : 'primary'} loading={busy} onClick={() => void toggle()}>
          {t(state === 'on' ? 'push.turnOff' : 'push.turnOn')}
        </Button>
      )}
      <p className="mt-3 text-sm leading-6 text-fg-muted">{t('push.privacy')}</p>
    </Card>
  );
}
