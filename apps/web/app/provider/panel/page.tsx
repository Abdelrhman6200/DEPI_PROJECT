'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ClipboardCheck, Gauge, Lock } from 'lucide-react';
import { useLocale } from '@/lib/locale';
import { useAuth } from '@/lib/auth';
import { hasRole } from '@/lib/roles';
import { useApi } from '@/lib/useApi';
import { Card, CardHeader, PageHeader } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Tabs } from '@/components/Tabs';
import { Async } from '@/components/Async';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonList } from '@/components/Skeleton';

type Tab = 'gaps' | 'risk';

/** The clinician's panel: overdue screenings (care gaps, with coverage per screening) and patients ranked by a
 *  rule-based risk score with its reasons (engine 25_care_gaps.js). Deterministic; not a diagnosis. */
export default function PanelPage() {
  const { t } = useLocale();
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('risk');
  // provider.care_gaps and provider.panel_risk are for the clinical team (doctor, nurse, clinic administrator).
  if (user && !hasRole(user.role, ['doctor', 'nurse', 'clinic_admin'])) {
    return <EmptyState title={t('panel.forbidden')} icon={<Lock className="size-7" />} />;
  }
  return (
    <div className="space-y-4">
      <PageHeader title={t('panel.title')} />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'risk', label: t('panel.risk'), icon: <Gauge className="size-4" /> },
          { id: 'gaps', label: t('panel.gaps'), icon: <ClipboardCheck className="size-4" /> },
        ]}
      />
      {tab === 'risk' ? <Risk /> : <Gaps />}
    </div>
  );
}

function Risk() {
  const { t, pick, fmt } = useLocale();
  const q = useApi('provider', 'panel_risk', { limit: 30 });
  return (
    <Card>
      <CardHeader title={t('panel.risk')} subtitle={t('panel.riskHint')} />
      <Async state={q} skeleton={<SkeletonList rows={6} />}>
        {(d) =>
          d.patients.length ? (
            <ol className="divide-y divide-line">
              {d.patients.map((p, i) => (
                <li key={p.id} className="flex flex-wrap items-start gap-3 py-3">
                  <span className="w-6 shrink-0 text-end font-semibold tabular-nums text-fg-muted">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{pick(p.full_name, p.full_name_ar)}</span>
                      {p.mrn && <span className="text-xs text-fg-muted" dir="ltr">{p.mrn}</span>}
                      <Badge tone={p.score >= 8 ? 'danger' : p.score >= 4 ? 'warn' : 'neutral'}>{t('panel.score', { n: fmt.number(p.score, 1) })}</Badge>
                    </div>
                    <ul className="mt-1 flex flex-wrap gap-1.5">
                      {p.reasons.map((r, j) => (
                        <li key={j} className="rounded-full bg-surface-2 px-2 py-0.5 text-xs">
                          {pick(r.en, r.ar)} <span className="text-fg-muted">+{fmt.number(r.points, 1)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <Link href={`/provider/patients/${p.id}`} className="min-h-11 shrink-0 content-center text-sm font-semibold text-primary-strong hover:underline">
                    {t('panel.open')}
                  </Link>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState compact title={t('panel.noRisk')} />
          )
        }
      </Async>
    </Card>
  );
}

function Gaps() {
  const { t, pick, fmt } = useLocale();
  const q = useApi('provider', 'care_gaps', {});
  return (
    <Async state={q} skeleton={<SkeletonList rows={6} />}>
      {(d) => (
        <div className="space-y-4">
          <Card>
            <CardHeader title={t('panel.coverage')} subtitle={t('panel.withGaps', { n: d.patients_with_gaps })} />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {d.coverage.map((c) => (
                <div key={c.type} className="rounded-xl border border-line p-3">
                  <div className="text-sm font-medium">{pick(c.title, c.title_ar)}</div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-2">
                    <div className={c.percent !== null && c.percent < 60 ? 'h-full bg-warn' : 'h-full bg-ok'} style={{ width: `${c.percent ?? 0}%` }} />
                  </div>
                  <div className="mt-1 text-xs text-fg-muted">{t('panel.upToDate', { a: c.up_to_date, b: c.total })} · {fmt.pct(c.percent)}</div>
                </div>
              ))}
            </div>
          </Card>
          <Card>
            <CardHeader title={t('panel.gaps')} subtitle={t('panel.gapsHint')} />
            {d.patients.length ? (
              <ul className="divide-y divide-line">
                {d.patients.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-start gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <span className="font-semibold">{pick(p.full_name, p.full_name_ar)}</span>
                      <ul className="mt-1 flex flex-wrap gap-1.5">
                        {p.gaps.map((g) => (
                          <li key={g.type}>
                            <Badge tone={(g.days_overdue ?? 0) > 90 ? 'danger' : 'warn'}>
                              {pick(g.title, g.title_ar)} · {g.last_done ? t('panel.overdue', { n: g.days_overdue ?? 0 }) : t('panel.never')}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <Link href={`/provider/patients/${p.id}`} className="min-h-11 shrink-0 content-center text-sm font-semibold text-primary-strong hover:underline">
                      {t('panel.open')}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState compact title={t('panel.noGaps')} />
            )}
          </Card>
        </div>
      )}
    </Async>
  );
}
