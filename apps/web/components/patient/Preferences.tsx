'use client';

import { useEffect, useState } from 'react';
import { UserCog } from 'lucide-react';
import type { Preferences } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import { Card } from '../Card';
import { Button } from '../Button';
import { CheckRow, Field, Input, Select, Textarea } from '../Field';
import { SkeletonCard } from '../Skeleton';
import { useErrorToast, useToast } from '../Toast';

const DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];

/**
 * How the person likes to be helped (engine 32_personal.js): the AI helper adapts its wording, meal examples and timing,
 * and notifications respect their own sleep times. Nothing medical changes.
 */
export function PreferencesSettings() {
  const { t, te } = useLocale();
  const { scope } = useAuth();
  const toast = useToast();
  const errorToast = useErrorToast();
  const q = useApi('profile', 'preferences', { ...scope });
  const { mutate, pending } = useMutation();
  const [f, setF] = useState<Preferences | null>(null);
  useEffect(() => { if (q.data) setF(q.data); }, [q.data]);
  if (q.loading && !f) return <SkeletonCard lines={5} />;
  if (!f) return null;
  const set = <K extends keyof Preferences>(k: K, v: Preferences[K]) => setF((x) => (x ? { ...x, [k]: v } : x));

  async function save() {
    if (!f) return;
    try {
      const { updated_at: _u, ...rest } = f;
      q.setData(await mutate('profile', 'set_preferences', { ...scope, ...rest, goals_text: rest.goals_text || null }));
      toast(t('common.saved'));
    } catch (e) {
      errorToast(e);
    }
  }

  return (
    <Card aria-labelledby="prefs-title">
      <h2 id="prefs-title" className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <UserCog className="size-5 text-primary" aria-hidden />
        {t('prefs.title')}
      </h2>
      <p className="mb-4 text-base leading-7 text-fg-muted">{t('prefs.body')}</p>
      <div className="space-y-3">
        <CheckRow checked={!!f.simple_words} onChange={(v) => set('simple_words', v)} title={t('prefs.simple')} body={t('prefs.simpleHint')} />
        <CheckRow checked={!!f.prefers_voice} onChange={(v) => set('prefers_voice', v)} title={t('prefs.voice')} body={t('prefs.voiceHint')} />
        <CheckRow checked={!!f.budget_sensitive} onChange={(v) => set('budget_sensitive', v)} title={t('prefs.budget')} body={t('prefs.budgetHint')} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('prefs.meals')}>
            <Select value={f.meal_pattern ?? ''} onChange={(e) => set('meal_pattern', (e.target.value || null) as Preferences['meal_pattern'])}>
              <option value="">—</option>
              {(['three_meals', 'two_meals_snacks', 'irregular'] as const).map((x) => <option key={x} value={x}>{te('prefs.meal.', x)}</option>)}
            </Select>
          </Field>
          <Field label={t('prefs.shift')}>
            <Select value={f.work_shift ?? ''} onChange={(e) => set('work_shift', (e.target.value || null) as Preferences['work_shift'])}>
              <option value="">—</option>
              {(['day', 'night', 'rotating', 'none'] as const).map((x) => <option key={x} value={x}>{te('prefs.shiftV.', x)}</option>)}
            </Select>
          </Field>
          <Field label={t('prefs.sleepTime')}>
            <Input type="time" dir="ltr" value={f.sleep_time ?? ''} onChange={(e) => set('sleep_time', e.target.value || null)} />
          </Field>
          <Field label={t('prefs.wakeTime')}>
            <Input type="time" dir="ltr" value={f.wake_time ?? ''} onChange={(e) => set('wake_time', e.target.value || null)} />
          </Field>
          <Field label={t('prefs.cooks')}>
            <Select value={f.who_cooks ?? ''} onChange={(e) => set('who_cooks', (e.target.value || null) as Preferences['who_cooks'])}>
              <option value="">—</option>
              {(['self', 'family', 'eats_out'] as const).map((x) => <option key={x} value={x}>{te('prefs.cook.', x)}</option>)}
            </Select>
          </Field>
        </div>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t('prefs.fasting')}</legend>
          <div className="flex flex-wrap gap-2">
            {DAYS.map((d) => {
              const on = (f.fasting_days ?? []).includes(d);
              return (
                <Button key={d} size="sm" variant={on ? 'primary' : 'outline'} aria-pressed={on}
                  onClick={() => set('fasting_days', on ? (f.fasting_days ?? []).filter((x) => x !== d) : [...(f.fasting_days ?? []), d])}>
                  {te('prefs.day.', d)}
                </Button>
              );
            })}
          </div>
        </fieldset>
        <Field label={t('prefs.goals')} hint={t('prefs.goalsHint')}>
          <Textarea rows={2} maxLength={300} value={f.goals_text ?? ''} onChange={(e) => set('goals_text', e.target.value)} />
        </Field>
        <Button onClick={() => void save()} loading={pending}>{t('common.save')}</Button>
      </div>
    </Card>
  );
}
