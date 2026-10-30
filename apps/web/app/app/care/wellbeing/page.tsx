'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, HeartHandshake, Phone } from 'lucide-react';
import type { CheckinKind, CheckinSubmitted } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import { cn } from '@/lib/cn';
import { Card, CardHeader, PageHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { SkeletonCard } from '@/components/Skeleton';
import { useErrorToast } from '@/components/Toast';

type Q = [string, string];
// PAID-5 (Problem Areas in Diabetes, short form; Arabic version validated in Egyptian primary care), PHQ-9 (the first two
// items are the PHQ-2), and the five STOP-BANG questions the record cannot answer. Screening only, not a diagnosis.
const ITEMS: Record<CheckinKind, { intro: Q; items: Q[]; options: Q[] }> = {
  paid5: {
    intro: ['Which of these diabetes issues are a problem for you right now?', 'أي من هذه الأمور المتعلقة بالسكري تمثل مشكلة لك حاليًا؟'],
    items: [
      ['Feeling scared when you think about living with diabetes', 'الشعور بالخوف عندما تفكر في العيش مع السكري'],
      ['Feeling depressed when you think about living with diabetes', 'الشعور بالاكتئاب عندما تفكر في العيش مع السكري'],
      ['Worrying about the future and the possibility of serious complications', 'القلق بشأن المستقبل واحتمال حدوث مضاعفات خطيرة'],
      ['Feeling that diabetes takes up too much of your mental and physical energy every day', 'الشعور بأن السكري يستهلك الكثير من طاقتك النفسية والجسدية كل يوم'],
      ['Coping with complications of diabetes', 'التعامل مع مضاعفات السكري'],
    ],
    options: [['Not a problem', 'ليست مشكلة'], ['Minor problem', 'مشكلة بسيطة'], ['Moderate problem', 'مشكلة متوسطة'], ['Somewhat serious', 'مشكلة جدية إلى حد ما'], ['Serious problem', 'مشكلة خطيرة']],
  },
  phq2: { intro: ['Over the last 2 weeks, how often have you been bothered by:', 'خلال الأسبوعين الماضيين، كم مرة ضايقتك هذه الأمور:'], items: [], options: [] },
  phq9: {
    intro: ['Over the last 2 weeks, how often have you been bothered by:', 'خلال الأسبوعين الماضيين، كم مرة ضايقتك هذه الأمور:'],
    items: [
      ['Little interest or pleasure in doing things', 'قلة الاهتمام أو المتعة في عمل الأشياء'],
      ['Feeling down, depressed, or hopeless', 'الشعور بالحزن أو الاكتئاب أو اليأس'],
      ['Trouble falling or staying asleep, or sleeping too much', 'صعوبة في النوم أو الاستمرار فيه، أو النوم أكثر من اللازم'],
      ['Feeling tired or having little energy', 'الشعور بالتعب أو قلة الطاقة'],
      ['Poor appetite or overeating', 'ضعف الشهية أو الإفراط في الأكل'],
      ['Feeling bad about yourself, or that you are a failure or have let yourself or your family down', 'الشعور بعدم الرضا عن نفسك، أو أنك فاشل أو خذلت نفسك أو عائلتك'],
      ['Trouble concentrating on things, such as reading or watching television', 'صعوبة في التركيز، مثل القراءة أو مشاهدة التلفزيون'],
      ['Moving or speaking so slowly that others noticed, or being so restless that you moved around a lot more than usual', 'التحرك أو الكلام ببطء لاحظه الآخرون، أو العكس: التململ والحركة أكثر من المعتاد'],
      ['Thoughts that you would be better off dead, or of hurting yourself in some way', 'أفكار بأنه من الأفضل لو كنت ميتًا، أو بإيذاء نفسك بأي شكل'],
    ],
    options: [['Not at all', 'إطلاقًا'], ['Several days', 'عدة أيام'], ['More than half the days', 'أكثر من نصف الأيام'], ['Nearly every day', 'تقريبًا كل يوم']],
  },
  stopbang: {
    intro: ['A short sleep check. Answer yes or no:', 'فحص قصير للنوم. أجب بنعم أو لا:'],
    items: [
      ['Do you snore loudly (heard through a closed door or by the person next to you)?', 'هل تشخر بصوت عالٍ (يُسمع من وراء باب مغلق أو يسمعه من بجانبك)؟'],
      ['Do you often feel tired or sleepy during the day?', 'هل تشعر كثيرًا بالتعب أو النعاس أثناء النهار؟'],
      ['Has anyone seen you stop breathing or choke during sleep?', 'هل لاحظ أحد أنك تتوقف عن التنفس أو تختنق أثناء النوم؟'],
      ['Do you have high blood pressure, or take medicine for it?', 'هل عندك ضغط مرتفع أو تأخذ دواء له؟'],
      ['Is your neck size more than 40 cm (shirt collar)?', 'هل محيط رقبتك أكثر من 40 سم (مقاس الياقة)؟'],
    ],
    options: [['No', 'لا'], ['Yes', 'نعم']],
  },
};
ITEMS.phq2 = { ...ITEMS.phq9, items: ITEMS.phq9.items.slice(0, 2) };
const ELEVATED = ['high', 'moderate', 'moderately_severe', 'severe', 'intermediate'];

/** Wellbeing check-ins: diabetes distress (PAID-5), mood (PHQ-2, then PHQ-9 when needed) and a sleep apnea screen. */
export default function WellbeingPage() {
  const { t, te, pick, dir } = useLocale();
  const { user } = useAuth();
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  const status = useApi('care', 'wellbeing', {});
  const [kind, setKind] = useState<CheckinKind | null>(null);
  const [answers, setAnswers] = useState<(number | null)[]>([]);
  const [result, setResult] = useState<CheckinSubmitted | null>(null);
  const { mutate, pending } = useMutation();
  const errorToast = useErrorToast();

  function start(k: CheckinKind) {
    setKind(k);
    setAnswers(ITEMS[k].items.map(() => null));
    setResult(null);
  }
  async function submit() {
    if (!kind || answers.some((a) => a === null)) return;
    try {
      const r = await mutate('care', 'wellbeing_submit', { kind, answers: answers as number[] });
      setResult(r);
      setKind(null);
      void status.reload(true);
      if (r.next === 'phq9' && !r.crisis) start('phq9');
    } catch (e) {
      errorToast(e);
    }
  }

  if (user && user.role !== 'patient') {
    return <p className="text-base text-fg-muted">{t('wb.patientOnly')}</p>;
  }
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Link href="/app/care" className="inline-flex min-h-11 items-center gap-1 text-base text-fg-muted hover:text-fg">
        <Back className="size-4" />
        {t('nav.care')}
      </Link>
      <PageHeader title={t('wb.title')} subtitle={t('wb.subtitle')} />

      {result?.crisis && (
        <div className="rounded-2xl border-2 border-danger/60 bg-danger-soft p-5" role="alert">
          <p className="text-lg leading-8 font-medium">{pick(result.message_en ?? '', result.message_ar ?? '')}</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <a href="tel:123" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-danger-solid px-4 font-semibold text-white"><Phone className="size-5" />123</a>
            <a href="tel:16328" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-danger/60 px-4 font-semibold"><Phone className="size-5" />16328</a>
          </div>
        </div>
      )}
      {result && !result.crisis && !kind && (
        <Card>
          <p className="text-base leading-7">{t(ELEVATED.includes(result.band) ? (result.kind === 'stopbang' ? 'wb.resultSleep' : 'wb.resultElevated') : 'wb.resultOk')}</p>
          {ELEVATED.includes(result.band) && <p className="mt-2 text-base leading-7 text-fg-muted">{t('wb.teamTold')}</p>}
        </Card>
      )}

      {kind ? (
        <Card>
          <CardHeader title={te('wb.kind.', kind)} subtitle={pick(...ITEMS[kind].intro)} />
          <ol className="space-y-4">
            {ITEMS[kind].items.map((q, i) => (
              <li key={i}>
                <p className="mb-2 text-base font-medium">{i + 1}. {pick(...q)}</p>
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={pick(...q)}>
                  {ITEMS[kind].options.map((o, v) => (
                    <button key={v} type="button" role="radio" aria-checked={answers[i] === v}
                      onClick={() => setAnswers((a) => a.map((x, j) => (j === i ? v : x)))}
                      className={cn('min-h-11 rounded-xl border px-3 text-sm font-medium', answers[i] === v ? 'border-primary bg-primary-soft text-primary-strong' : 'border-line hover:bg-surface-2')}>
                      {pick(...o)}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-5 flex gap-2">
            <Button onClick={() => void submit()} loading={pending} disabled={answers.some((a) => a === null)}>{t('common.save')}</Button>
            <Button variant="ghost" onClick={() => setKind(null)}>{t('common.cancel')}</Button>
          </div>
        </Card>
      ) : status.loading && !status.data ? (
        <SkeletonCard lines={3} />
      ) : status.data ? (
        <div className="grid gap-3">
          {(['paid5', 'phq2', 'stopbang'] as const).map((k) => {
            const last = k === 'phq2' ? status.data!.latest.phq9 ?? status.data!.latest.phq2 : status.data!.latest[k];
            const due = status.data!.due.includes(k);
            return (
              <Card key={k} className={cn(due && 'border-primary/40')}>
                <div className="flex flex-wrap items-center gap-3">
                  <HeartHandshake className="size-6 text-primary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{te('wb.kind.', k)}</p>
                    <p className="text-sm text-fg-muted">{last ? t('wb.lastDone', { d: new Date(last.at).toLocaleDateString() }) : t('wb.never')}</p>
                  </div>
                  <Button variant={due ? 'primary' : 'outline'} onClick={() => start(k)}>{t(due ? 'wb.start' : 'wb.again')}</Button>
                </div>
              </Card>
            );
          })}
          <p className="text-sm leading-6 text-fg-muted">{t('wb.privacy')}</p>
        </div>
      ) : null}
    </div>
  );
}
