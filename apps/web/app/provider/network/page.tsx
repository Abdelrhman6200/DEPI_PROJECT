'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Pencil } from 'lucide-react';
import type { FacilityMatch } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useMutation } from '@/lib/useApi';
import { CAPACITY_ROLES, hasRole } from '@/lib/roles';
import { PageHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Dialog } from '@/components/Dialog';
import { Field, Input, Select } from '@/components/Field';
import { InlineError } from '@/components/EmptyState';
import { FacilitySearch } from '@/components/domain/Facility';
import { useToast } from '@/components/Toast';

type CapStatus = FacilityMatch['capacity'][number]['status'];
const DEFAULT_RESOURCES = ['er_accepting', 'icu', 'ccu', 'ward', 'dialysis', 'cath_lab', 'ct', 'mri'];

export default function NetworkPage() {
  const { user } = useAuth();
  const { t } = useLocale();
  const canEdit = hasRole(user?.role, CAPACITY_ROLES);
  const [editing, setEditing] = useState<{ f: FacilityMatch; reload: () => void } | null>(null);

  return (
    <div>
      <PageHeader title={t('pv.network')} />
      <FacilitySearch
        variant="table"
        renderAction={
          canEdit
            ? (f, reload) => (
                <Button size="sm" variant="soft" icon={<Pencil className="size-3.5" />} onClick={() => setEditing({ f, reload })}>
                  {t('net.updateCapacity')}
                </Button>
              )
            : undefined
        }
      />
      {editing && <CapacityDialog facility={editing.f} onClose={() => setEditing(null)} onSaved={editing.reload} />}
    </div>
  );
}

function CapacityDialog({ facility, onClose, onSaved }: { facility: FacilityMatch; onClose: () => void; onSaved: () => void }) {
  const { t, te, pick } = useLocale();
  const toast = useToast();
  const { mutate, pending, error } = useMutation();
  const resources = Array.from(new Set([...facility.capacity.map((c) => c.resource), ...DEFAULT_RESOURCES]));
  const [resource, setResource] = useState(facility.capacity[0]?.resource ?? resources[0]);
  const [available, setAvailable] = useState('');
  const [total, setTotal] = useState('');
  const [status, setStatus] = useState<CapStatus>('available');

  useEffect(() => {
    const c = facility.capacity.find((x) => x.resource === resource);
    setAvailable(c?.available != null ? String(c.available) : '');
    setTotal(c?.total != null ? String(c.total) : '');
    setStatus(c && c.status !== 'unknown' ? c.status : 'available');
  }, [resource, facility]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await mutate('network', 'update_capacity', {
        facility_id: facility.id,
        resource,
        available: Number(available),
        total: total === '' ? undefined : Number(total),
        status,
      });
      toast(t('common.saved'));
      onSaved();
      onClose();
    } catch {
      /* inline */
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${t('net.updateCapacity')} · ${pick(facility.name, facility.name_ar)}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="cap-form" loading={pending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id="cap-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label={t('net.resource')} className="sm:col-span-2">
          <Select value={resource} onChange={(e) => setResource(e.target.value)}>
            {resources.map((r) => (
              <option key={r} value={r}>
                {te('res.', r)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('net.available')}>
          <Input type="number" min={0} required dir="ltr" value={available} onChange={(e) => setAvailable(e.target.value)} />
        </Field>
        <Field label={t('net.total')}>
          <Input type="number" min={0} dir="ltr" value={total} onChange={(e) => setTotal(e.target.value)} />
        </Field>
        <Field label={t('common.status')} className="sm:col-span-2">
          <Select value={status} onChange={(e) => setStatus(e.target.value as CapStatus)}>
            {(['available', 'limited', 'full', 'unknown'] as const).map((s) => (
              <option key={s} value={s}>
                {te('cap.', s)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="sm:col-span-2">
          <InlineError error={error} />
        </div>
      </form>
    </Dialog>
  );
}
