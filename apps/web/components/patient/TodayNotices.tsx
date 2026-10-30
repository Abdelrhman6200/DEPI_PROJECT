'use client';

import { useState } from 'react';
import { AlertTriangle, CalendarRange, MoonStar, Sun, Thermometer, TrendingDown, X } from 'lucide-react';
import type { Notification } from '@health/api-client';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import { cn } from '@/lib/cn';
import { Card } from '@/components/Card';
import { Button } from '@/components/Button';

// Warnings the engine sends after a reading or in the evening (deterministic, fixed texts): a predicted low, a risky
// night (insulin or a sulfonylurea with exercise, a low evening reading or a night low), or "break your fast now".
// hours: how long a warning stays relevant (a predicted low is about the next half hour; the night warning is for tonight).
const URGENT: Record<string, { icon: typeof AlertTriangle; danger: boolean; hours: number }> = {
  ramadan_break_fast: { icon: AlertTriangle, danger: true, hours: 3 },
  low_predicted: { icon: TrendingDown, danger: false, hours: 1 },
  night_low_risk: { icon: MoonStar, danger: false, hours: 12 },
  heat_alert: { icon: Sun, danger: false, hours: 14 },
  sick_check: { icon: Thermometer, danger: false, hours: 4 },
};
const DIGEST_DAYS = 8;

/** On Today: the latest unread warning while it is relevant, and the latest weekly digest ("Your week"). */
export function TodayNotices() {
  const { t, pick } = useLocale();
  const q = useApi('insights', 'notifications', {});
  const { mutate } = useMutation();
  const [hidden, setHidden] = useState<string[]>([]);
  const items = (q.data || []).filter((n) => !hidden.includes(n.id));
  const now = Date.now();
  const urgent = items.find((n) => URGENT[n.kind] && !n.read_at && now - Date.parse(n.created_at) < URGENT[n.kind].hours * 3600e3);
  const digest = items.find((n) => n.kind === 'weekly_digest' && !n.read_at && now - Date.parse(n.created_at) < DIGEST_DAYS * 86400e3);

  async function dismiss(n: Notification) {
    setHidden((h) => [...h, n.id]);
    try { await mutate('insights', 'mark_notification_read', { notification_id: n.id }); } catch { /* shown again next time */ }
  }

  if (!urgent && !digest) return null;
  return (
    <div className="space-y-3">
      {urgent && (() => {
        const u = URGENT[urgent.kind];
        const Icon = u.icon;
        return (
          <div role="alert" className={cn('rounded-2xl border-2 p-4', u.danger ? 'border-danger/60 bg-danger-soft' : 'border-warn/60 bg-warn-soft')}>
            <div className="flex items-start gap-3">
              <Icon className={cn('mt-0.5 size-6 shrink-0', u.danger ? 'text-danger' : 'text-warn')} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-base font-semibold">{pick(urgent.title, urgent.title_ar)}</p>
                <p className="mt-1 text-base leading-7" dir="auto">{pick(urgent.body, urgent.body_ar)}</p>
              </div>
              <Button size="sm" variant="ghost" aria-label={t('notices.gotIt')} onClick={() => void dismiss(urgent)}><X className="size-4" /></Button>
            </div>
          </div>
        );
      })()}
      {digest && (
        <Card className="space-y-2">
          <div className="flex items-start gap-3">
            <CalendarRange className="mt-0.5 size-6 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-lg font-semibold">{pick(digest.title, digest.title_ar)}</p>
              <p className="mt-1 whitespace-pre-line text-base leading-7 text-fg-muted" dir="auto">{pick(digest.body, digest.body_ar)}</p>
            </div>
          </div>
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={() => void dismiss(digest)}>{t('notices.gotIt')}</Button>
          </div>
        </Card>
      )}
    </div>
  );
}
