'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { HeartPulse } from 'lucide-react';
import { useLocale } from '@/lib/locale';
import { cn } from '@/lib/cn';
import { LocaleToggle } from '@/components/LocaleToggle';

type Q = [string, string];
type Opt = { label: Q; points: number };

// FINDRISC (Finnish Diabetes Risk Score), validated in Arabic-speaking populations. The score is worked out on this
// device only: nothing typed here is sent or stored, and no account is needed.
const AGE: Opt[] = [
  { label: ['Under 45', 'أقل من 45'], points: 0 }, { label: ['45-54', '45-54'], points: 2 },
  { label: ['55-64', '55-64'], points: 3 }, { label: ['65 or older', '65 أو أكثر'], points: 4 },
];
const YESNO = (yes: number, no = 0): Opt[] => [{ label: ['Yes', 'نعم'], points: yes }, { label: ['No', 'لا'], points: no }];
const FAMILY: Opt[] = [
  { label: ['No', 'لا'], points: 0 },
  { label: ['Grandparent, aunt, uncle or cousin', 'جد أو جدة أو عم أو خال أو عمة أو خالة أو أبناؤهم'], points: 3 },
  { label: ['Parent, brother, sister or child', 'أب أو أم أو أخ أو أخت أو ابن أو ابنة'], points: 5 },
];
const BANDS: { max: number; key: 'low' | 'slight' | 'moderate' | 'high' | 'very_high'; en: string; ar: string; tone: string }[] = [
  { max: 6, key: 'low', en: 'Low risk: about 1 in 100 will develop diabetes in 10 years.', ar: 'خطر منخفض: حوالي 1 من كل 100 يصاب بالسكري خلال 10 سنوات.', tone: 'bg-ok-soft text-ok-fg' },
  { max: 11, key: 'slight', en: 'Slightly raised risk: about 1 in 25 in 10 years.', ar: 'خطر مرتفع قليلًا: حوالي 1 من كل 25 خلال 10 سنوات.', tone: 'bg-ok-soft text-ok-fg' },
  { max: 14, key: 'moderate', en: 'Moderate risk: about 1 in 6 in 10 years. A blood sugar test is a good idea.', ar: 'خطر متوسط: حوالي 1 من كل 6 خلال 10 سنوات. يُنصح بعمل تحليل سكر.', tone: 'bg-warn-soft text-warn-fg' },
  { max: 20, key: 'high', en: 'High risk: about 1 in 3 in 10 years. Get a fasting sugar or HbA1c test soon.', ar: 'خطر مرتفع: حوالي 1 من كل 3 خلال 10 سنوات. اعمل تحليل سكر صائم أو سكر تراكمي قريبًا.', tone: 'bg-danger-soft text-danger-fg' },
  { max: 99, key: 'very_high', en: 'Very high risk: about 1 in 2 in 10 years. Get a sugar test this week.', ar: 'خطر مرتفع جدًا: حوالي 1 من كل 2 خلال 10 سنوات. اعمل تحليل سكر هذا الأسبوع.', tone: 'bg-danger-soft text-danger-fg' },
];

export default function FamilyCheckPage() {
  const { pick, locale } = useLocale();
  const [age, setAge] = useState<number | null>(null);
  const [sex, setSex] = useState<'m' | 'f' | null>(null);
  const [height, setHeight] = useState('');
  const [weight, setWeight] = useState('');
  const [waist, setWaist] = useState('');
  const [answers, setAnswers] = useState<Record<string, number | null>>({ active: null, veg: null, bp: null, sugar: null, family: null });

  const bmi = useMemo(() => {
    const h = Number(height) / 100, w = Number(weight);
    return h > 1 && h < 2.3 && w > 25 && w < 300 ? w / (h * h) : null;
  }, [height, weight]);
  const bmiPts = bmi === null ? null : bmi > 30 ? 3 : bmi >= 25 ? 1 : 0;
  const w = Number(waist);
  const waistPts = !sex || !(w > 40 && w < 250) ? null : sex === 'm' ? (w > 102 ? 4 : w >= 94 ? 3 : 0) : (w > 88 ? 4 : w >= 80 ? 3 : 0);
  const parts = [age, bmiPts, waistPts, ...Object.values(answers)];
  const complete = parts.every((x) => x !== null && x !== undefined);
  const score = complete ? (parts as number[]).reduce((s, x) => s + x, 0) : null;
  const band = score === null ? null : BANDS.find((b) => score <= b.max)!;

  const Choice = ({ opts, value, onPick, name }: { opts: Opt[]; value: number | null; onPick: (p: number) => void; name: Q }) => (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-base font-semibold">{pick(...name)}</legend>
      <div className="flex flex-wrap gap-2">
        {opts.map((o, i) => (
          <button key={i} type="button" aria-pressed={value === o.points && value !== null}
            onClick={() => onPick(o.points)}
            className={cn('min-h-11 rounded-xl border px-3 text-sm font-medium', value === o.points ? 'border-primary bg-primary-soft text-primary-strong' : 'border-line hover:bg-surface-2')}>
            {pick(...o.label)}
          </button>
        ))}
      </div>
    </fieldset>
  );
  const set = (k: string) => (p: number) => setAnswers((a) => ({ ...a, [k]: p }));
  const input = 'h-12 w-full rounded-xl border border-line-strong bg-surface px-3 text-base';

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-8" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <header className="flex items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-bold"><HeartPulse className="size-7 text-primary" aria-hidden />{pick('Check your diabetes risk', 'اعرف خطر إصابتك بالسكري')}</h1>
        <LocaleToggle />
      </header>
      <p className="text-base leading-7 text-fg-muted">
        {pick('Eight questions, two minutes. Diabetes runs in families: if someone close to you has it, check yourself. Your answers stay on this phone; nothing is sent or saved.',
          'ثمانية أسئلة في دقيقتين. السكري بيتكرر في العائلات: لو حد قريب منك عنده سكر، اطمئن على نفسك. إجاباتك بتفضل على الموبايل ده؛ مفيش حاجة بتتبعت أو بتتحفظ.')}
      </p>
      <Choice name={['Your age', 'سنك']} opts={AGE} value={age} onPick={setAge} />
      <fieldset className="space-y-2">
        <legend className="mb-1 text-base font-semibold">{pick('Sex (for the waist size)', 'النوع (لمقاس الوسط)')}</legend>
        <div className="flex gap-2">
          {(['m', 'f'] as const).map((x) => (
            <button key={x} type="button" aria-pressed={sex === x} onClick={() => setSex(x)}
              className={cn('min-h-11 rounded-xl border px-4 text-sm font-medium', sex === x ? 'border-primary bg-primary-soft text-primary-strong' : 'border-line')}>
              {x === 'm' ? pick('Man', 'رجل') : pick('Woman', 'امرأة')}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1"><span className="text-sm font-medium">{pick('Height (cm)', 'الطول (سم)')}</span><input className={input} inputMode="numeric" dir="ltr" value={height} onChange={(e) => setHeight(e.target.value.replace(/[^0-9.]/g, ''))} /></label>
        <label className="space-y-1"><span className="text-sm font-medium">{pick('Weight (kg)', 'الوزن (كجم)')}</span><input className={input} inputMode="numeric" dir="ltr" value={weight} onChange={(e) => setWeight(e.target.value.replace(/[^0-9.]/g, ''))} /></label>
        <label className="space-y-1"><span className="text-sm font-medium">{pick('Waist at the navel (cm)', 'محيط الوسط عند السرة (سم)')}</span><input className={input} inputMode="numeric" dir="ltr" value={waist} onChange={(e) => setWaist(e.target.value.replace(/[^0-9.]/g, ''))} /></label>
      </div>
      <Choice name={['At least 30 minutes of activity every day (walking counts)?', 'نشاط 30 دقيقة على الأقل كل يوم (المشي يُحسب)؟']} opts={YESNO(0, 2)} value={answers.active} onPick={set('active')} />
      <Choice name={['Vegetables or fruit every day?', 'خضار أو فاكهة كل يوم؟']} opts={YESNO(0, 1)} value={answers.veg} onPick={set('veg')} />
      <Choice name={['Ever taken medicine for high blood pressure?', 'أخدت قبل كده دواء للضغط المرتفع؟']} opts={YESNO(2)} value={answers.bp} onPick={set('bp')} />
      <Choice name={['Ever been told your blood sugar was high (a check-up, illness, pregnancy)?', 'حد قالك قبل كده إن السكر عندك عالي (كشف، مرض، حمل)؟']} opts={YESNO(5)} value={answers.sugar} onPick={set('sugar')} />
      <Choice name={['Does anyone in your family have diabetes?', 'حد في عيلتك عنده سكر؟']} opts={FAMILY} value={answers.family} onPick={set('family')} />

      {band ? (
        <section className={cn('rounded-2xl p-5', band.tone)} aria-live="polite">
          <p className="text-lg font-bold">{pick('Your score', 'نتيجتك')}: <span className="num">{score}</span> / 26</p>
          <p className="mt-1 text-base leading-7">{pick(band.en, band.ar)}</p>
          {score! >= 12 && (
            <p className="mt-2 text-base leading-7">
              {pick('Any lab can do a fasting blood sugar or HbA1c test. Walking, less sugar and white bread, and losing a little weight lower the risk a lot.',
                'أي معمل يقدر يعمل تحليل سكر صائم أو سكر تراكمي. المشي وتقليل السكر والعيش الأبيض وخسارة شوية وزن بيقللوا الخطر كتير.')}
            </p>
          )}
        </section>
      ) : (
        <p className="text-sm text-fg-muted">{pick('Answer every question to see your result.', 'جاوب على كل الأسئلة علشان تشوف نتيجتك.')}</p>
      )}
      <p className="text-xs leading-5 text-fg-subtle">
        {pick('FINDRISC risk score. A screening estimate, not a diagnosis. ', 'مقياس خطر FINDRISC. تقدير للفحص وليس تشخيصًا. ')}
        <Link href="/login" className="underline underline-offset-4">{pick('MediCare app', 'تطبيق ميديكير')}</Link>
      </p>
    </main>
  );
}
