'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Activity, BedDouble, CalendarRange, Clock, Flame, Minus, Plus, Search, Smile, Trash2, Utensils } from 'lucide-react';
import type { EnergySummary, Food, MealLog } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import { cairoHour, isoDate, localInputToIso, nowLocalInput } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { TKey } from '@/lib/i18n';
import { Card, CardHeader, PageHeader } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/Button';
import { Chips, Field, Input, Textarea } from '@/components/Field';
import { Segmented, Tabs } from '@/components/Tabs';
import { Async } from '@/components/Async';
import { EmptyState, InlineError } from '@/components/EmptyState';
import { SkeletonCard, SkeletonList } from '@/components/Skeleton';
import { StatTile } from '@/components/StatTile';
import { useToast } from '@/components/Toast';
import { FoodProfileCard } from '@/components/patient/FoodProfile';
import { usePage } from '@/lib/pageBundle';

type MealType = MealLog['meal_type'];
type Tab = 'meal' | 'activity' | 'sleep' | 'feeling';

function defaultMealType(): MealType {
  const h = cairoHour();
  if (h < 11) return 'breakfast';
  if (h < 17) return 'lunch';
  if (h < 22) return 'dinner';
  return 'snack';
}

export default function LifestylePage() {
  const { scope } = useAuth();
  const { t } = useLocale();
  const [tab, setTab] = useState<Tab>('meal');
  usePage('lifestyle', 'page', scope, [
    ['lifestyle', 'summary', { ...scope, days: 7 }, 'summary'],
    ['lifestyle', 'food_profile', { ...(scope.patient_id ? { patient_id: scope.patient_id } : {}), days: 90 }, 'food_profile'],
  ]);
  const summary = useApi('lifestyle', 'summary', { ...scope, days: 7 });
  const reload = () => void summary.reload(true);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader title={t('life.title')} />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'meal', label: t('life.logMeal'), icon: <Utensils className="size-4" aria-hidden /> },
          { id: 'activity', label: t('life.activity'), icon: <Activity className="size-4" aria-hidden /> },
          { id: 'sleep', label: t('life.sleep'), icon: <BedDouble className="size-4" aria-hidden /> },
          { id: 'feeling', label: t('life.feeling'), icon: <Smile className="size-4" aria-hidden /> },
        ]}
      />
      {tab === 'meal' && <MealLogger onSaved={reload} />}
      {tab === 'activity' && <ActivityForm onSaved={reload} />}
      {tab === 'sleep' && <SleepForm onSaved={reload} />}
      {tab === 'feeling' && <CheckinForm onSaved={reload} />}
      <WeeklySummary state={summary} />
      <FoodProfileCard patientId={scope.patient_id} />
    </div>
  );
}

/* ------------------------------------------------------------ meal logger */

function MealLogger({ onSaved }: { onSaved: () => void }) {
  const { scope } = useAuth();
  const { t, te, pick, fmt, locale } = useLocale();
  const toast = useToast();
  const { mutate, pending, error } = useMutation();
  const [mealType, setMealType] = useState<MealType>(defaultMealType);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState<{ food: Food; portions: number }[]>([]);
  const [eatenAt, setEatenAt] = useState(nowLocalInput());
  const [showTime, setShowTime] = useState(false);
  const [notes, setNotes] = useState('');

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(id);
  }, [query]);

  const foods = useApi('lifestyle', 'foods', { q: debounced || undefined });
  const total = useMemo(() => selected.reduce((s, x) => s + x.food.carbs_g * x.portions, 0), [selected]);
  const totalKcal = useMemo(() => selected.reduce((s, x) => s + (x.food.kcal ?? 0) * x.portions, 0), [selected]);

  function add(food: Food) {
    setSelected((xs) => {
      const i = xs.findIndex((x) => x.food.id === food.id);
      if (i >= 0) return xs.map((x, j) => (j === i ? { ...x, portions: x.portions + 1 } : x));
      return [...xs, { food, portions: 1 }];
    });
  }
  function step(id: string, delta: number) {
    setSelected((xs) => xs.map((x) => (x.food.id === id ? { ...x, portions: Math.max(0, Math.round((x.portions + delta) * 2) / 2) } : x)).filter((x) => x.portions > 0));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!selected.length) return;
    try {
      await mutate('lifestyle', 'log_meal', {
        ...scope,
        meal_type: mealType,
        eaten_at: showTime ? localInputToIso(eatenAt) : new Date().toISOString(),
        items: selected.map((x) => ({ food_id: x.food.id, portions: x.portions })),
        notes: notes.trim() || undefined,
      });
      toast(t('life.logged'));
      setSelected([]);
      setNotes('');
      setQuery('');
      setShowTime(false);
      setEatenAt(nowLocalInput());
      onSaved();
    } catch {
      /* inline */
    }
  }

  const giTone = (g: Food['gi_category']) => (g === 'low' ? 'ok' : g === 'medium' ? 'warn' : 'danger');

  return (
    <Card>
      <form onSubmit={save} className="space-y-4">
        <Segmented<MealType>
          size="lg"
          label={t('life.mealType')}
          options={(['breakfast', 'lunch', 'dinner', 'snack'] as MealType[]).map((m) => ({ value: m, label: te('meal.', m) }))}
          value={mealType}
          onChange={setMealType}
          className="flex w-full [&>button]:flex-1"
        />

        <label className="relative block">
          <span className="sr-only">{t('life.searchFood')}</span>
          <Search className="pointer-events-none absolute start-3 top-1/2 size-5 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input type="search" className="h-12 ps-10" placeholder={t('life.searchFood')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>

        <div className="max-h-72 overflow-y-auto rounded-2xl border border-line">
          <Async state={foods} compact skeleton={<SkeletonList rows={3} className="p-2" />} empty={<EmptyState compact className="m-2" title={t('life.noFoods')} />}>
            {(list) => (
              <ul className="divide-y divide-line">
                {list.slice(0, 40).map((food) => (
                  <li key={food.id} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-base font-medium" lang={locale === 'ar' ? 'ar' : 'en'}>
                          {pick(food.name, food.name_ar)}
                        </span>
                        <Badge tone={giTone(food.gi_category)}>{te('gi.', food.gi_category)}</Badge>
                      </div>
                      <div className="text-sm text-fg-muted">
                        {pick(food.portion_desc, food.portion_desc_ar)} · {t('life.carbsG', { n: fmt.number(food.carbs_g) })} · {t('life.kcalN', { n: fmt.number(food.kcal) })}
                      </div>
                    </div>
                    <Button
                      size="md"
                      variant="soft"
                      className="size-11 shrink-0 px-0"
                      icon={<Plus className="size-5" />}
                      onClick={() => add(food)}
                      aria-label={`${t('common.add')}: ${pick(food.name, food.name_ar)}`}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Async>
        </div>

        <div>
          <h3 className="mb-2 text-base font-semibold">{t('life.selected')}</h3>
          {selected.length === 0 ? (
            <EmptyState compact title={t('life.noSelected')} icon={<Utensils className="size-6" />} />
          ) : (
            <ul className="space-y-2" aria-live="polite">
              {selected.map(({ food, portions }) => (
                <li key={food.id} className="flex items-center gap-3 rounded-2xl bg-surface-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-base font-medium">{pick(food.name, food.name_ar)}</div>
                    <div className="text-sm text-fg-muted">
                      {t('life.carbsG', { n: fmt.number(food.carbs_g * portions, 1) })} · {t('life.kcalN', { n: fmt.number(food.kcal * portions) })}
                    </div>
                  </div>
                  <div className="flex items-center gap-1" dir="ltr">
                    <button
                      type="button"
                      onClick={() => step(food.id, -0.5)}
                      className="flex size-11 items-center justify-center rounded-xl border border-line-strong bg-surface hover:bg-surface-2"
                      aria-label={`− ${pick(food.name, food.name_ar)}`}
                    >
                      {portions <= 0.5 ? <Trash2 className="size-4 text-danger" /> : <Minus className="size-4" />}
                    </button>
                    <span className="num w-10 text-center text-lg font-bold">{portions}</span>
                    <button
                      type="button"
                      onClick={() => step(food.id, 0.5)}
                      className="flex size-11 items-center justify-center rounded-xl border border-line-strong bg-surface hover:bg-surface-2"
                      aria-label={`+ ${pick(food.name, food.name_ar)}`}
                    >
                      <Plus className="size-4" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 rounded-2xl bg-primary-soft px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="text-base font-medium text-primary-strong">{t('life.totalCarbs')}</span>
              <span className="num text-2xl font-bold text-primary-strong">{t('common.grams', { n: fmt.number(total, 1) })}</span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-base font-medium text-primary-strong">{t('life.totalKcal')}</span>
              <span className="num text-xl font-bold text-primary-strong">{t('life.kcalN', { n: fmt.number(totalKcal) })}</span>
            </div>
            <p className="mt-1 text-sm text-fg-muted">{t('life.carbsHelp')}</p>
          </div>
        </div>

        {showTime ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('common.time')}>
              <Input type="datetime-local" dir="ltr" value={eatenAt} max={nowLocalInput()} onChange={(e) => setEatenAt(e.target.value)} />
            </Field>
            <Field label={`${t('common.notes')} (${t('common.optional')})`}>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
        ) : (
          <button type="button" onClick={() => setShowTime(true)} className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary-strong hover:underline">
            <Clock className="size-4" aria-hidden />
            {t('life.changeTime')}
          </button>
        )}
        <InlineError error={error} />
        <Button type="submit" size="xl" className="w-full" loading={pending} disabled={!selected.length}>
          {t('life.saveMeal')}
        </Button>
      </form>
    </Card>
  );
}

/* ------------------------------------------------------------ quick forms */

const ACTIVITY_TYPES: { value: string; label: TKey }[] = [
  { value: 'walking', label: 'life.walking' },
  { value: 'housework', label: 'life.housework' },
  { value: 'prayer_walk', label: 'life.prayerWalk' },
  { value: 'exercise', label: 'life.exercise' },
  { value: 'other', label: 'life.other' },
];

function NumberField({ label, value, onChange, max }: { label: string; value: string; onChange: (v: string) => void; max?: number }) {
  return (
    <Field label={label}>
      <Input
        inputMode="numeric"
        dir="ltr"
        className="h-12 text-center text-xl font-semibold"
        value={value}
        onChange={(e) => {
          const v = e.target.value.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[^0-9.]/g, '');
          if (max === undefined || Number(v) <= max) onChange(v);
        }}
      />
    </Field>
  );
}

function ActivityForm({ onSaved }: { onSaved: () => void }) {
  const { scope } = useAuth();
  const { t } = useLocale();
  const toast = useToast();
  const { mutate, pending, error } = useMutation();
  const [steps, setSteps] = useState('');
  const [minutes, setMinutes] = useState('');
  const [type, setType] = useState('walking');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!steps && !minutes) return;
    try {
      await mutate('lifestyle', 'log_activity', {
        ...scope,
        date: isoDate(),
        steps: steps ? Number(steps) : undefined,
        minutes: minutes ? Number(minutes) : undefined,
        type,
      });
      toast(t('life.logged'));
      setSteps('');
      setMinutes('');
      onSaved();
    } catch {
      /* inline */
    }
  }
  return (
    <Card>
      <CardHeader title={t('life.activity')} icon={<Activity className="size-5" />} />
      <form onSubmit={submit} className="space-y-4">
        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t('life.activityType')}</legend>
          <Chips options={ACTIVITY_TYPES.map((a) => ({ value: a.value, label: t(a.label) }))} value={[type]} onToggle={setType} />
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <NumberField label={t('life.steps')} value={steps} onChange={setSteps} max={100000} />
          <NumberField label={t('life.minutes')} value={minutes} onChange={setMinutes} max={1440} />
        </div>
        <InlineError error={error} />
        <Button type="submit" size="xl" loading={pending} className="w-full" disabled={!steps && !minutes}>
          {t('common.save')}
        </Button>
      </form>
    </Card>
  );
}

function SleepForm({ onSaved }: { onSaved: () => void }) {
  const { scope } = useAuth();
  const { t } = useLocale();
  const toast = useToast();
  const { mutate, pending, error } = useMutation();
  const [hours, setHours] = useState(7);
  const [quality, setQuality] = useState<number | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await mutate('lifestyle', 'log_sleep', { ...scope, date: isoDate(), hours, quality: quality ?? undefined });
      toast(t('life.logged'));
      onSaved();
    } catch {
      /* inline */
    }
  }
  return (
    <Card>
      <CardHeader title={t('life.sleep')} icon={<BedDouble className="size-5" />} />
      <form onSubmit={submit} className="space-y-5">
        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t('life.hours')}</legend>
          <div className="flex items-center justify-center gap-4" dir="ltr">
            <Button variant="outline" size="xl" className="size-14 px-0" onClick={() => setHours((h) => Math.max(0, h - 0.5))} aria-label={t('life.lessSleep')}>
              <Minus className="size-6" />
            </Button>
            <output className="flex w-28 flex-col items-center" aria-live="polite">
              <span className="num text-4xl font-bold">{hours}</span>
              <span className="text-sm text-fg-muted">{t('life.hoursUnit')}</span>
            </output>
            <Button variant="outline" size="xl" className="size-14 px-0" onClick={() => setHours((h) => Math.min(24, h + 0.5))} aria-label={t('life.moreSleep')}>
              <Plus className="size-6" />
            </Button>
          </div>
        </fieldset>
        <Scale label={t('life.quality')} value={quality} onChange={setQuality} low={t('life.sleepPoor')} high={t('life.sleepGreat')} />
        <InlineError error={error} />
        <Button type="submit" size="xl" loading={pending} className="w-full">
          {t('common.save')}
        </Button>
      </form>
    </Card>
  );
}

function CheckinForm({ onSaved }: { onSaved: () => void }) {
  const { scope } = useAuth();
  const { t } = useLocale();
  const toast = useToast();
  const { mutate, pending, error } = useMutation();
  const [mood, setMood] = useState<number | null>(null);
  const [stress, setStress] = useState<number | null>(null);
  const [energy, setEnergy] = useState<number | null>(null);
  const complete = mood !== null && stress !== null && energy !== null;
  const [note, setNote] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (mood === null || stress === null || energy === null) return;
    try {
      await mutate('lifestyle', 'checkin', { ...scope, mood, stress, energy, note: note.trim() || undefined });
      toast(t('life.logged'));
      setNote('');
      onSaved();
    } catch {
      /* inline */
    }
  }
  return (
    <Card>
      <CardHeader title={t('life.checkin')} icon={<Smile className="size-5" />} />
      <form onSubmit={submit} className="space-y-5">
        <Scale label={t('life.mood')} value={mood} onChange={setMood} low={t('life.moodLow')} high={t('life.moodHigh')} />
        <Scale label={t('life.stress')} value={stress} onChange={setStress} low={t('life.stressLow')} high={t('life.stressHigh')} />
        <Scale label={t('life.energy')} value={energy} onChange={setEnergy} low={t('life.energyLow')} high={t('life.energyHigh')} />
        <Field label={`${t('common.notes')} (${t('common.optional')})`}>
          <Textarea className="min-h-20" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <InlineError error={error} />
        <Button type="submit" size="xl" loading={pending} disabled={!complete} className="w-full">
          {t('common.save')}
        </Button>
      </form>
    </Card>
  );
}

/** 1-5 tap scale with its own end labels. Nothing is chosen until the person chooses; arrow keys work as in any radio group. */
function Scale({ label, value, onChange, low, high }: { label: string; value: number | null; onChange: (v: number) => void; low: string; high: string }) {
  const { dir } = useLocale();
  function onKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const fwd = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const back = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    let next: number | null = null;
    if (e.key === fwd || e.key === 'ArrowDown') next = Math.min(5, (value ?? 0) + 1);
    if (e.key === back || e.key === 'ArrowUp') next = Math.max(1, (value ?? 2) - 1);
    if (next === null) return;
    e.preventDefault();
    onChange(next);
    (e.currentTarget.querySelectorAll<HTMLButtonElement>('[role=radio]')[next - 1])?.focus();
  }
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium">{label}</legend>
      <div className="flex gap-1.5" role="radiogroup" aria-label={label} onKeyDown={onKey}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            tabIndex={value === n || (value === null && n === 1) ? 0 : -1}
            onClick={() => onChange(n)}
            aria-checked={value === n}
            aria-label={n === 1 ? `1 · ${low}` : n === 5 ? `5 · ${high}` : String(n)}
            className={cn(
              'flex h-12 flex-1 items-center justify-center rounded-xl border-2 text-lg font-bold',
              value === n ? 'border-primary bg-primary text-primary-fg' : 'border-line bg-surface text-fg-muted hover:bg-surface-2',
            )}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-sm text-fg-muted">
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </fieldset>
  );
}

/* ------------------------------------------------------------ weekly summary */

function WeeklySummary({ state }: { state: ReturnType<typeof useApi<'lifestyle', 'summary'>> }) {
  const { t, fmt, pick, te } = useLocale();
  return (
    <Async state={state} skeleton={<SkeletonCard lines={5} />} isEmpty={() => false}>
      {(s) => (
        <div className="space-y-4">
          {s.energy && <EnergyCard e={s.energy} />}
          {(() => {
            // Only what has data; no charts (a number with a word is easier to read than a graph).
            const tiles = [
              s.steps_avg !== null && <StatTile key="st" label={t('life.stepsAvg')} value={fmt.number(s.steps_avg)} unit={t('life.unitSteps')} />,
              s.active_minutes_avg !== null && <StatTile key="ac" label={t('life.activeAvg')} value={fmt.number(s.active_minutes_avg)} unit={t('life.unitMin')} />,
              s.sleep_hours_avg !== null && <StatTile key="sl" label={t('life.sleepAvg')} value={fmt.number(s.sleep_hours_avg, 1)} unit={t('life.unitHours')} />,
              s.weight_latest !== null && (
                <StatTile key="wt" label={t('life.weight')} value={fmt.number(s.weight_latest, 1)} unit={t('life.unitKg')}
                  hint={s.weight_change_30d !== null ? t('life.weightChange', { n: `${s.weight_change_30d > 0 ? '+' : ''}${fmt.number(s.weight_change_30d, 1)}` }) : undefined} />
              ),
            ].filter(Boolean);
            return tiles.length ? (
              <Card>
                <CardHeader title={t('life.weekly')} icon={<CalendarRange className="size-5" />} />
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{tiles}</div>
              </Card>
            ) : null;
          })()}

          {s.meals.length > 0 && (
          <Card>
            <CardHeader title={t('life.meals')} icon={<Utensils className="size-5" />} />
              <ul className="space-y-2">
                {[...s.meals]
                  .sort((a, b) => b.eaten_at.localeCompare(a.eaten_at))
                  .slice(0, 3)
                  .map((m) => (
                    <li key={m.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-line p-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone="primary">{te('meal.', m.meal_type)}</Badge>
                          <span className="text-sm text-fg-muted">{fmt.dateTime(m.eaten_at)}</span>
                        </div>
                        <div dir="auto" className="mt-1 text-base">{fmt.list(m.items.map((i) => pick(i.name, i.name_ar)))}</div>
                        <div className="text-sm text-fg-muted">
                          {t('life.carbsG', { n: fmt.number(m.est_carbs_g) })}
                          {m.est_kcal != null && <> · {t('life.kcalN', { n: fmt.number(m.est_kcal) })}</>}
                        </div>
                      </div>
                      <MealResponse r={m.response} />
                    </li>
                  ))}
              </ul>
          </Card>
          )}
        </div>
      )}
    </Async>
  );
}

/** Calories eaten today against the estimated daily needs, calories burned by activity, and the last days' intake. */
function EnergyCard({ e }: { e: EnergySummary }) {
  const { t, fmt } = useLocale();
  const needs = e.needs.kcal;
  const pct = needs ? Math.round((e.eaten_today_kcal / needs) * 100) : null;
  const note: TKey =
    e.needs.note === 'pregnancy' ? 'life.needsPregnancy' : e.needs.note === 'needs_weight_height' ? 'life.needsMissing' : 'life.needsNote';
  return (
    <Card>
      <CardHeader title={t('life.energyTitle')} icon={<Flame className="size-5" />} />
      <p className="text-xl font-semibold">
        {needs ? t('life.eatenOfNeeds', { a: fmt.number(e.eaten_today_kcal), b: fmt.number(needs) }) : `${fmt.number(e.eaten_today_kcal)} ${t('life.unitKcal')}`}
      </p>
      {needs !== null && pct !== null && (
        <div className="mt-2 h-3 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`${pct}%`}>
          <div className={cn('h-full rounded-full', pct > 110 ? 'bg-warn' : 'bg-primary')} style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} />
        </div>
      )}
      {e.burned_today_kcal > 0 && <p className="mt-2 text-base text-fg-muted">{t('life.burnedLine', { n: fmt.number(e.burned_today_kcal) })}</p>}
      <p className="mt-2 text-sm leading-6 text-fg-muted">{t(note)}</p>
    </Card>
  );
}

function MealResponse({ r }: { r: MealLog['response'] }) {
  const { t, fmt } = useLocale();
  if (!r || !r.sensor_ok) return <span className="text-sm text-fg-muted">{t('life.noSensor')}</span>;
  const riseTone = r.rise === null ? 'neutral' : r.rise > 60 ? 'danger' : r.rise > 40 ? 'warn' : 'ok';
  return (
    <div className="w-full sm:w-auto">
      <div className="mb-1 text-xs font-medium text-fg-muted">{t('life.mealResponse')}</div>
      <div className="flex gap-4 text-center text-sm">
        <div>
          <div className="text-fg-muted">{t('life.pre')}</div>
          <div className="num font-semibold">{fmt.number(r.pre)}</div>
        </div>
        <div>
          <div className="text-fg-muted">{t('life.peak')}</div>
          <div className="num font-semibold">{fmt.number(r.peak)}</div>
        </div>
        <div>
          <div className="text-fg-muted">{t('life.rise')}</div>
          <Badge tone={riseTone}>{r.rise === null ? '—' : `+${fmt.number(r.rise)}`}</Badge>
        </div>
      </div>
    </div>
  );
}
