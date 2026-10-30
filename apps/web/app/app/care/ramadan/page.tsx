'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, MoonStar, ShieldAlert } from 'lucide-react';
import { RAMADAN_ANSWERS, type RamadanAnswers, type RamadanAssessment, type RamadanCategory } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import type { TKey } from '@/lib/i18n';
import { Card, CardHeader, PageHeader } from '@/components/Card';
import { Badge, type BadgeTone } from '@/components/Badge';
import { Button } from '@/components/Button';
import { Async } from '@/components/Async';
import { SkeletonCard } from '@/components/Skeleton';
import { useErrorToast, useToast } from '@/components/Toast';

const TONE: Record<RamadanCategory, BadgeTone> = { low: 'ok', moderate: 'warn', high: 'danger' };
type Key = keyof typeof RAMADAN_ANSWERS;
const KEYS = Object.keys(RAMADAN_ANSWERS) as Key[];

/** Ramadan: the IDF-DAR 2021 risk check (record + a few answers), today's fasting window, and the fasting choice.
 *  The score is deterministic; whether to fast is agreed with the doctor before Ramadan. */
export default function RamadanPage() {
  const { scope } = useAuth();
  const { t, dir, pick, fmt } = useLocale();
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  const q = useApi('care', 'ramadan', scope);
  const { mutate, pending } = useMutation();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [answers, setAnswers] = useState<RamadanAnswers>({});
  const [result, setResult] = useState<RamadanAssessment | null>(null);
  const [redo, setRedo] = useState(false);

  async function assess() {
    try {
      const r = await mutate('care', 'ramadan_assess', { ...scope, answers });
      setResult(r);
      setRedo(false);
      void q.reload(true);
    } catch (e) {
      errorToast(e);
    }
  }
  async function setFasting(fasting: boolean) {
    try {
      await mutate('care', 'ramadan_fasting', { ...scope, fasting });
      toast(t('common.saved'));
      void q.reload(true);
    } catch (e) {
      errorToast(e);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Link href="/app/care" className="inline-flex min-h-11 items-center gap-1 text-base text-fg-muted hover:text-fg">
        <Back className="size-4" />
        {t('nav.care')}
      </Link>
      <PageHeader title={t('ram.title')} />
      <Async state={q} skeleton={<SkeletonCard />}>
        {(d) => {
          const latest = result ?? d.assessment;
          const showForm = !latest || redo;
          return (
            <div className="space-y-5">
              <Card className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <MoonStar className="size-5 text-primary" aria-hidden />
                  <span className="text-base font-semibold">{t('ram.dates', { from: fmt.date(d.ramadan.start), to: fmt.date(d.ramadan.end) })}</span>
                  {d.ramadan.active && <Badge tone="primary">{t('ram.now')}</Badge>}
                </div>
                <p className="text-base text-fg-muted">{t('ram.window', { from: d.ramadan.fasting_from, to: d.ramadan.fasting_to })}</p>
                <div className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger-soft p-3">
                  <ShieldAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
                  <p className="text-base leading-7">{t('ram.breakRule', { low: d.ramadan.break_below, high: d.ramadan.break_above })}</p>
                </div>
              </Card>

              {latest && !showForm && (
                <Card className="space-y-3">
                  <CardHeader title={t('ram.result')} />
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={TONE[latest.category]}>{t(`ram.cat.${latest.category}` as TKey)}</Badge>
                    <span className="text-base text-fg-muted">{t('ram.score', { n: fmt.number(latest.score, 1) })}</span>
                  </div>
                  <p className="text-base leading-7">
                    {(latest as Partial<RamadanAssessment>).advice_en ? pick((latest as Partial<RamadanAssessment>).advice_en!, (latest as Partial<RamadanAssessment>).advice_ar ?? null) : t(`ram.advice.${latest.category}` as TKey)}
                  </p>
                  {latest.items.filter((i) => i.points > 0).length > 0 && (
                    <ul className="list-disc space-y-1 ps-5 text-sm text-fg-muted">
                      {latest.items.filter((i) => i.points > 0).map((i) => (
                        <li key={i.key}>{t(`ram.item.${i.key}` as TKey)} (+{fmt.number(i.points, 1)})</li>
                      ))}
                    </ul>
                  )}
                  <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
                    {latest.category === 'high' ? (
                      <p className="text-base font-medium text-danger-fg">{t('ram.highNoFast')}</p>
                    ) : d.fasting ? (
                      <>
                        <Badge tone="ok">{t('ram.fasting')}</Badge>
                        <Button size="sm" variant="outline" disabled={pending} onClick={() => void setFasting(false)}>{t('ram.notFasting')}</Button>
                      </>
                    ) : (
                      <Button size="sm" disabled={pending} onClick={() => void setFasting(true)}>{t('ram.planFast')}</Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setRedo(true)}>{t('ram.redo')}</Button>
                  </div>
                  <p className="text-sm text-fg-muted">{t('ram.doctor')}</p>
                </Card>
              )}

              {showForm && (
                <Card className="space-y-4">
                  <CardHeader title={t('ram.check')} subtitle={t('ram.checkHint')} />
                  {KEYS.map((k) => (
                    <fieldset key={k} className="space-y-2">
                      <legend className="text-base font-semibold">{t(`ram.q.${k}` as TKey)}</legend>
                      <div className="flex flex-wrap gap-2">
                        {(RAMADAN_ANSWERS[k] as readonly (string | boolean)[]).map((v) => {
                          const on = answers[k] === v;
                          return (
                            <button
                              key={String(v)}
                              type="button"
                              aria-pressed={on}
                              onClick={() => setAnswers((a) => ({ ...a, [k]: v }))}
                              className={`min-h-11 rounded-xl border px-3 text-base ${on ? 'border-primary bg-primary-soft font-semibold text-primary-strong' : 'border-line-strong hover:bg-surface-2'}`}
                            >
                              {t(`ram.a.${k}.${String(v)}` as TKey)}
                            </button>
                          );
                        })}
                      </div>
                    </fieldset>
                  ))}
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => void assess()} disabled={pending}>{t('ram.calculate')}</Button>
                    {latest && <Button variant="ghost" onClick={() => setRedo(false)}>{t('common.cancel')}</Button>}
                  </div>
                  <p className="text-sm text-fg-muted">{t('ram.unanswered')}</p>
                </Card>
              )}
            </div>
          );
        }}
      </Async>
    </div>
  );
}
