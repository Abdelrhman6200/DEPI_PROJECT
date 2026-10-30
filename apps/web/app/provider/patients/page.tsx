'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Search, Users } from 'lucide-react';
import { useLocale } from '@/lib/locale';
import { useApi, useNow } from '@/lib/useApi';
import { minutesSince } from '@/lib/format';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/Card';
import { Input } from '@/components/Field';
import { Async } from '@/components/Async';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonList } from '@/components/Skeleton';
import { ExclusionBadges, GlycemicStateChip } from '@/components/StatusBadges';
import { Badge } from '@/components/Badge';

export default function PanelPage() {
  const { t, pick, fmt } = useLocale();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useNow();

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(id);
  }, [q]);

  const panel = useApi('provider', 'panel', { q: debounced || undefined });

  return (
    <div>
      <PageHeader
        title={t('pv.patients')}
        action={
          <div className="relative w-full sm:w-80">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
            <Input className="ps-9" aria-label={t('pv.searchPatients')} placeholder={t('pv.searchPatients')} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        }
      />
      <Async state={panel} skeleton={<SkeletonList rows={8} />} empty={<EmptyState title={t('pv.noPatients')} icon={<Users className="size-7" />} />}>
        {(rows) =>
          rows[0]?.restricted ? (
            <div className="overflow-auto rounded-2xl border border-line bg-surface">
              <p className="border-b border-line px-4 py-2.5 text-sm text-fg-muted">{t('pv.restrictedPanel')}</p>
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-xs text-fg-muted">
                  <tr>
                    <th className="px-4 py-2.5 text-start font-medium">{t('common.patient')}</th>
                    <th className="px-3 py-2.5 text-start font-medium">{t('pv.nextAppt')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((p) => (
                    <tr key={p.id}>
                      <td className="px-4 py-3">
                        <span className="font-medium text-fg">{pick(p.full_name, p.full_name_ar)}</span>
                        {/* reception staff may get fewer details: show only what was sent */}
                        <div className="text-xs text-fg-muted">
                          {[
                            typeof p.age === 'number' ? t('common.years', { n: p.age }) : null,
                            p.sex === 'female' ? t('common.female') : p.sex === 'male' ? t('common.male') : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-fg-muted">{p.next_appointment ? fmt.dateTime(p.next_appointment) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
          <div className="max-h-[calc(100dvh-15rem)] overflow-auto rounded-2xl border border-line bg-surface">
            <table className="w-full min-w-[56rem] text-sm">
              <thead className="sticky top-0 z-10 bg-surface-2 text-xs text-fg-muted">
                <tr>
                  <th className="px-4 py-2.5 text-start font-medium">{t('common.patient')}</th>
                  <th className="px-3 py-2.5 text-start font-medium">{t('state.glycemic')}</th>
                  <th className="px-3 py-2.5 text-end font-medium">{t('pv.tir14')}</th>
                  <th className="px-3 py-2.5 text-end font-medium">{t('pv.mean14')}</th>
                  <th className="px-3 py-2.5 text-start font-medium">{t('pv.lastReading')}</th>
                  <th className="px-3 py-2.5 text-end font-medium">{t('pv.openItems')}</th>
                  <th className="px-3 py-2.5 text-start font-medium">{t('pv.nextAppt')}</th>
                  <th className="px-3 py-2.5 text-start font-medium">{t('excl.label')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((p) => {
                  const age = minutesSince(p.last_reading_at);
                  const stale = age === null || age > 60 * 24 * 3;
                  return (
                    <tr key={p.id} onClick={() => router.push(`/provider/patients/${p.id}`)} className="cursor-pointer hover:bg-surface-2/60">
                      <td className="px-4 py-3">
                        <Link href={`/provider/patients/${p.id}`} onClick={(e) => e.stopPropagation()} className="inline-flex min-h-6 items-center font-medium text-fg hover:underline">
                          {pick(p.full_name, p.full_name_ar)}
                        </Link>
                        <div className="text-xs text-fg-muted">
                          {t('common.years', { n: p.age })} · {p.sex === 'female' ? t('common.female') : t('common.male')}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <GlycemicStateChip state={p.glycemic_state ?? 'insufficient_data'} />
                      </td>
                      <td
                        className={cn(
                          'tabular-nums px-3 py-3 text-end font-semibold',
                          p.tir_14d === null ? 'text-fg-subtle' : p.tir_14d >= 70 ? 'text-ok' : p.tir_14d >= 50 ? 'text-warn' : 'text-danger',
                        )}
                      >
                        {fmt.pct(p.tir_14d)}
                      </td>
                      <td className="tabular-nums px-3 py-3 text-end">{fmt.number(p.mean_14d)}</td>
                      <td className="px-3 py-3 text-xs">
                        <span className={cn(stale ? 'text-warn' : 'text-fg-muted')}>{p.last_reading_at ? fmt.relative(p.last_reading_at) : '—'}</span>
                        {stale && p.last_reading_at && <Badge tone="warn" className="ms-1.5">{t('common.stale')}</Badge>}
                      </td>
                      <td className="px-3 py-3 text-end">
                        {p.open_items > 0 ? <Badge tone="primary">{p.open_items}</Badge> : <span className="text-fg-subtle">0</span>}
                      </td>
                      <td className="px-3 py-3 text-xs text-fg-muted">{p.next_appointment ? fmt.dateTime(p.next_appointment) : '—'}</td>
                      <td className="px-3 py-3">
                        <ExclusionBadges exclusions={p.exclusions} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          )
        }
      </Async>
    </div>
  );
}
