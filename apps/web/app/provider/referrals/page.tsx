'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Send } from 'lucide-react';
import type { Referral } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useApi } from '@/lib/useApi';
import { INBOX_ROLES, hasRole } from '@/lib/roles';
import { PageHeader } from '@/components/Card';
import { Tabs } from '@/components/Tabs';
import { Async } from '@/components/Async';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonList } from '@/components/Skeleton';
import { ReferralRow } from '@/components/domain/Rows';
import { REFERRAL_STATUSES, ReferralStatusControl } from '@/components/provider/ReferralsPanel';

type Filter = 'open' | 'all' | Referral['status'];

export default function ReferralsPage() {
  const { t, te } = useLocale();
  const { user } = useAuth();
  // reception staff manage bookings only: no patient record
  const canOpenRecord = hasRole(user?.role, INBOX_ROLES);
  const q = useApi('network', 'referrals', {});
  const [filter, setFilter] = useState<Filter>('open');

  return (
    <div>
      <PageHeader title={t('pv.referrals')} />
      <Tabs<Filter>
        variant="pills"
        className="mb-4"
        value={filter}
        onChange={setFilter}
        tabs={[
          { id: 'open', label: t('inbox.active') },
          { id: 'all', label: t('common.all') },
          ...REFERRAL_STATUSES.map((s) => ({ id: s as Filter, label: te('rs.', s) })),
        ]}
      />
      <Async state={q} skeleton={<SkeletonList rows={5} />} empty={<EmptyState title={t('care.noReferrals')} icon={<Send className="size-7" />} />}>
        {(list) => {
          const rows = list
            .filter((r) => (filter === 'all' ? true : filter === 'open' ? r.status !== 'CLOSED' : r.status === filter))
            .sort((a, b) => {
              const u: Record<string, number> = { urgent: 0, soon: 1, routine: 2 };
              return (u[a.urgency] ?? 3) - (u[b.urgency] ?? 3) || b.created_at.localeCompare(a.created_at);
            });
          if (!rows.length) return <EmptyState title={t('care.noReferrals')} />;
          return (
            <div className="space-y-2">
              {rows.map((r) => (
                <ReferralRow
                  pro
                  key={r.id}
                  r={r}
                  showPatient
                  action={
                    <div className="flex flex-col items-end gap-2">
                      <ReferralStatusControl r={r} onUpdated={(n) => q.setData((xs) => (xs ? xs.map((x) => (x.id === n.id ? n : x)) : xs))} />
                      {canOpenRecord && (
                        <Link href={`/provider/patients/${r.patient_id}`} className="inline-flex min-h-6 items-center text-sm font-medium text-primary-strong hover:underline">
                          {t('pv.openWorkspace')}
                        </Link>
                      )}
                    </div>
                  }
                />
              ))}
            </div>
          );
        }}
      </Async>
    </div>
  );
}
