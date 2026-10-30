'use client';

import Link from 'next/link';
import { ArrowLeft, ArrowRight, Printer } from 'lucide-react';
import type { GlucoseMetrics, HealthSummary, LabResult, Patient } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useApi } from '@/lib/useApi';
import { Button } from '@/components/Button';
import { ErrorState } from '@/components/EmptyState';
import { SkeletonCard } from '@/components/Skeleton';
import { CarePlanView } from '@/components/domain/CarePlanView';
import { CriticalLabBadge, labName } from '@/components/domain/HealthLists';

/**
 * "Summary to share with my doctor": one printable page from the data the app already has (profile, sugar
 * numbers, medicines, allergies, latest lab results and the care plan). Nothing new is calculated here.
 */
export default function SummaryPage() {
  const { scope } = useAuth();
  const { t, dir, fmt } = useLocale();
  const profile = useApi('profile', 'get', scope);
  const health = useApi('clinical', 'summary', scope);
  const m14 = useApi('glucose', 'metrics', { ...scope, days: 14 });
  const m90 = useApi('glucose', 'metrics', { ...scope, days: 90 });
  const plan = useApi('care', 'plan', scope);
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;

  const states = [profile, health, m14, m90, plan];
  const failed = states.find((s) => s.error && !s.data);
  const ready = profile.data && health.data && m14.data && m90.data && plan.data;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="print-hidden flex flex-wrap items-center justify-between gap-2">
        <Link href="/app/account" className="-ms-2 inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-base text-fg-muted hover:text-fg">
          <Back className="size-4" aria-hidden />
          {t('acc.title')}
        </Link>
        <Button icon={<Printer className="size-4" />} disabled={!ready} onClick={() => window.print()}>
          {t('common.print')}
        </Button>
      </div>
      <p className="print-hidden text-base leading-7 text-fg-muted">{t('summary.intro')}</p>

      {failed ? (
        <ErrorState error={failed.error} onRetry={() => states.forEach((s) => void s.reload())} />
      ) : !ready ? (
        <SkeletonCard lines={10} />
      ) : (
        <article className="space-y-6 rounded-2xl border border-line bg-surface p-5 sm:p-8 print:border-0 print:p-0">
          <Header p={profile.data!} printedAt={fmt.dateTime(new Date())} />
          <GlucoseSection a={m14.data!} b={m90.data!} />
          <MedsSection h={health.data!} />
          <LabsSection labs={health.data!.labs} />
          <section className="print-block">
            <h2 className="mb-2 border-b border-line pb-1 text-lg font-semibold">{t('care.plan')}</h2>
            {plan.data!.active ? <CarePlanView plan={plan.data!.active} showWhatChanged={false} /> : <p className="text-fg-muted">{t('care.noPlan')}</p>}
          </section>
          <p className="border-t border-line pt-3 text-xs leading-5 text-fg-muted">{t('summary.footer')}</p>
        </article>
      )}
    </div>
  );
}

function Header({ p, printedAt }: { p: Patient; printedAt: string }) {
  const { t, te, pick } = useLocale();
  return (
    <div className="print-block space-y-1">
      <h1 className="text-2xl font-bold">{t('summary.title')}</h1>
      <p className="text-lg font-semibold">{pick(p.full_name, p.full_name_ar)}</p>
      <p className="text-sm text-fg-muted">
        {t('common.years', { n: p.age })} · {p.sex === 'female' ? t('common.female') : t('common.male')} · {te('dt.', p.diabetes_type)}
        {p.diagnosis_year ? ` · ${t('pv.dx', { y: p.diagnosis_year })}` : ''}
      </p>
      <p className="text-sm text-fg-muted">
        {t('pv.mrn')}: <span className="num">{p.mrn}</span> · {t('summary.printed', { d: printedAt })}
      </p>
    </div>
  );
}

function GlucoseSection({ a, b }: { a: GlucoseMetrics; b: GlucoseMetrics }) {
  const { t, fmt } = useLocale();
  const tbr = (m: GlucoseMetrics) => (m.tbr_level1 === null && m.tbr_level2 === null ? null : (m.tbr_level1 ?? 0) + (m.tbr_level2 ?? 0));
  const rows: { label: string; f: (m: GlucoseMetrics) => string }[] = [
    { label: t('glu.tir'), f: (m) => fmt.pct(m.tir) },
    { label: t('glu.tbr'), f: (m) => fmt.pct(tbr(m)) },
    { label: t('glu.mean'), f: (m) => (m.mean === null ? '—' : `${fmt.number(m.mean)} ${t('common.mgdl')}`) },
    { label: t('glu.gmi'), f: (m) => (m.gmi === null ? '—' : `${fmt.number(m.gmi, 1)}%`) },
    { label: t('glu.fastingMean'), f: (m) => (m.fasting_mean === null ? '—' : `${fmt.number(m.fasting_mean)} ${t('common.mgdl')}`) },
    { label: t('summary.readings'), f: (m) => fmt.number(m.readings) },
  ];
  return (
    <section className="print-block">
      <h2 className="mb-2 border-b border-line pb-1 text-lg font-semibold">{t('summary.sugar')}</h2>
      <p className="mb-2 text-sm text-fg-muted">{a.cgm ? t('glu.cgm') : t('glu.manual')}</p>
      <table className="w-full table-fixed text-sm">
        <thead className="text-xs text-fg-muted">
          <tr>
            <th className="w-1/2 py-1.5 text-start font-medium" scope="col" />
            <th className="py-1.5 ps-3 text-end font-medium whitespace-nowrap" scope="col">
              {t('common.dayRange', { n: 14 })}
            </th>
            <th className="py-1.5 ps-3 text-end font-medium whitespace-nowrap" scope="col">
              {t('common.dayRange', { n: 90 })}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row" className="py-1.5 text-start font-normal text-fg-muted">
                {r.label}
              </th>
              <td className="num py-1.5 ps-3 text-end font-semibold whitespace-nowrap">{r.f(a)}</td>
              <td className="num py-1.5 ps-3 text-end whitespace-nowrap">{r.f(b)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function MedsSection({ h }: { h: HealthSummary }) {
  const { t, te, pick } = useLocale();
  const meds = h.medications.filter((m) => m.status === 'active');
  const allergies = h.allergies.filter((a) => a.status !== 'inactive');
  const conditions = h.conditions.filter((c) => c.status === 'active');
  return (
    <section className="print-block grid gap-5 sm:grid-cols-2 print:grid-cols-2">
      <div>
        <h2 className="mb-2 border-b border-line pb-1 text-lg font-semibold">{t('health.medications')}</h2>
        {meds.length === 0 ? (
          <p className="text-sm text-fg-muted">{t('common.none')}</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {meds.map((m) => (
              <li key={m.id}>
                <bdi className="font-medium">{m.name}</bdi>
                {(m.dose_text || m.frequency) && (
                  <span className="text-fg-muted">
                    {' '}
                    · <bdi>{[m.dose_text, m.frequency].filter(Boolean).join(' · ')}</bdi>
                  </span>
                )}
                {m.times.length > 0 && <span className="num ms-1 text-fg-muted">({m.times.join(', ')})</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-4">
        <div>
          <h2 className="mb-2 border-b border-line pb-1 text-lg font-semibold">{t('health.allergies')}</h2>
          {allergies.length === 0 ? (
            <p className="text-sm text-fg-muted">{t('common.none')}</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {allergies.map((a) => (
                <li key={a.id}>
                  <bdi className="font-medium">{a.substance}</bdi>
                  <span className="text-fg-muted">
                    {' '}
                    · {te('sev.', a.severity)}
                    {a.reaction ? (
                      <>
                        {' · '}
                        <bdi>{a.reaction}</bdi>
                      </>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h2 className="mb-2 border-b border-line pb-1 text-lg font-semibold">{t('health.conditions')}</h2>
          {conditions.length === 0 ? (
            <p className="text-sm text-fg-muted">{t('common.none')}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {conditions.map((c) => (
                <li key={c.id}>
                  <bdi>{pick(c.display, c.display_ar)}</bdi>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

/** The newest result of each test. */
function LabsSection({ labs }: { labs: LabResult[] }) {
  const { t, fmt, locale } = useLocale();
  const latest = new Map<string, LabResult>();
  for (const l of [...labs].sort((a, b) => b.observed_at.localeCompare(a.observed_at))) if (!latest.has(l.test_code)) latest.set(l.test_code, l);
  const rows = [...latest.values()];
  return (
    <section className="print-block">
      <h2 className="mb-2 border-b border-line pb-1 text-lg font-semibold">{t('summary.labs')}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('common.none')}</p>
      ) : (
        <table className="w-full text-sm">
          <tbody className="divide-y divide-line">
            {rows.map((l) => (
              <tr key={l.id}>
                <th scope="row" className="py-1.5 text-start font-normal">
                  {labName(l.test_code, l.display, t, l.display_ar, locale === 'ar')}
                  {l.critical && <CriticalLabBadge className="ms-2" />}
                </th>
                <td className="num py-1.5 text-end font-semibold">
                  {l.value} <span className="text-xs font-normal text-fg-muted">{l.unit}</span>
                </td>
                <td className="py-1.5 text-end text-xs text-fg-muted">{fmt.date(l.observed_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
