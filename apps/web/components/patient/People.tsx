'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { AlertTriangle, Copy, Download, FileText, HeartPulse, PencilLine, Send, Share2, Stethoscope, Trash2, UserPlus, UserX, UsersRound } from 'lucide-react';
import type { CaregiverScope, TeamThread, UUID } from '@health/api-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useApi, useMutation } from '@/lib/useApi';
import { cn } from '@/lib/cn';
import { Card, CardHeader } from '../Card';
import { Button } from '../Button';
import { Badge } from '../Badge';
import { Dialog } from '../Dialog';
import { CheckRow, Field, Input, OptionButtons, Textarea } from '../Field';
import { EmptyState, InlineError } from '../EmptyState';
import { SkeletonList } from '../Skeleton';
import { useErrorToast, useToast } from '../Toast';
import { usePatientShell } from './PatientShellContext';
import { SameDayCard } from './SameDayCard';

/* ------------------------------------------------------------------ conversation */

function Bubbles({ thread, mineIsTeam }: { thread: TeamThread; mineIsTeam: boolean }) {
  const { t, fmt, pick } = useLocale();
  const listRef = useRef<HTMLOListElement>(null);
  // Scroll the conversation box to its newest message; scrollIntoView would also scroll the whole page.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.messages.length]);
  if (!thread.messages.length) return <EmptyState compact title={t('team.empty')} />;
  return (
    <ol ref={listRef} className="max-h-[28rem] space-y-3 overflow-y-auto pe-1" aria-live="polite">
      {thread.messages.map((m) => {
        const mine = m.from_team === mineIsTeam;
        return (
          <li key={m.id} className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}>
            <div
              dir="auto"
              className={cn(
                'max-w-[85%] rounded-2xl px-4 py-2.5 text-base leading-7 whitespace-pre-line',
                mine ? 'rounded-se-md bg-primary text-primary-fg' : 'rounded-ss-md border border-line bg-surface text-fg',
                m.emergency && 'ring-2 ring-danger/60',
              )}
            >
              {m.body}
            </div>
            <span className="mt-0.5 text-xs text-fg-muted">
              {m.from_team ? pick(m.author_name, m.author_name_ar) || t('team.careTeam') : pick(m.author_name, m.author_name_ar)}
              {' · '}
              {fmt.relative(m.created_at)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The patient's (or caregiver's) conversation with the care team, on the Care page. */
export function CareTeamThread() {
  const { scope } = useAuth();
  const { t, pick } = useLocale();
  const { openEmergency } = usePatientShell();
  const q = useApi('care', 'messages', scope);
  const { mutate, pending, error, clearError } = useMutation();
  const [text, setText] = useState('');
  const [emergency, setEmergency] = useState<string | null>(null);
  // same-day problem (e.g. an infected foot wound): see a doctor today, not an emergency
  const [urgent, setUrgent] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (body.length < 2) return;
    clearError();
    try {
      const res = await mutate('care', 'message_team', { ...scope, text: body });
      setText('');
      setEmergency(res.emergency ? pick(res.emergency.message_en, res.emergency.message_ar) : null);
      setUrgent(!res.emergency && res.urgent ? pick(res.urgent.message_en, res.urgent.message_ar) : null);
      void q.reload(true);
    } catch {
      /* inline */
    }
  }

  return (
    <Card id="messages" className="scroll-mt-24">
      <CardHeader title={t('team.title')} subtitle={t('team.subtitle')} icon={<UsersRound className="size-5" />} />
      {q.loading && !q.data ? (
        <SkeletonList rows={2} />
      ) : q.data && !q.data.linked ? (
        <p className="rounded-xl bg-surface-2 px-4 py-3 text-base leading-7 text-fg">{t('team.notLinked')}</p>
      ) : q.data ? (
        <>
          <Bubbles thread={q.data} mineIsTeam={false} />
          {emergency && (
            <div role="alert" className="mt-3 space-y-2 rounded-2xl border-2 border-danger/60 bg-danger-soft p-4">
              <p className="flex items-start gap-2 text-base leading-7 font-medium text-fg">
                <AlertTriangle className="mt-1 size-5 shrink-0 text-danger" aria-hidden />
                {emergency}
              </p>
              <Button variant="danger" size="lg" icon={<HeartPulse className="size-5" />} onClick={openEmergency}>
                {t('ca.showSafety')}
              </Button>
            </div>
          )}
          {urgent && <SameDayCard message={urgent} className="mt-3" />}
          <form onSubmit={send} className="mt-4 space-y-2">
            <label className="block">
              <span className="sr-only">{t('msg.title')}</span>
              <Textarea className="min-h-24" placeholder={t('msg.placeholder')} value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />
            </label>
            <p className="text-sm text-fg-muted">{t('team.notUrgent')}</p>
            <InlineError error={error} />
            <Button type="submit" size="lg" loading={pending} disabled={text.trim().length < 2} icon={<Send className="size-5 rtl:-scale-x-100" />}>
              {t('msg.send')}
            </Button>
          </form>
        </>
      ) : null}
    </Card>
  );
}

/** The same conversation from the clinic side, with a reply box (doctors and nurses). */
export function ProviderThread({ patientId, canReply }: { patientId: UUID; canReply: boolean }) {
  const { t } = useLocale();
  const toast = useToast();
  const q = useApi('care', 'messages', { patient_id: patientId });
  const { mutate, pending, error, clearError } = useMutation();
  const [text, setText] = useState('');

  async function reply(e: FormEvent) {
    e.preventDefault();
    clearError();
    try {
      const thread = await mutate('care', 'reply_message', { patient_id: patientId, text: text.trim() });
      q.setData(thread);
      setText('');
      toast(t('common.sent'));
    } catch {
      /* inline */
    }
  }

  return (
    <Card>
      <CardHeader title={t('team.title')} icon={<UsersRound className="size-5" />} />
      {q.loading && !q.data ? <SkeletonList rows={2} /> : q.data ? <Bubbles thread={q.data} mineIsTeam /> : null}
      {canReply && (
        <form onSubmit={reply} className="mt-4 space-y-2">
          <Textarea className="min-h-24" aria-label={t('team.reply')} placeholder={t('team.replyPlaceholder')} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} />
          <InlineError error={error} />
          <Button type="submit" loading={pending} disabled={text.trim().length < 2} icon={<Send className="size-4 rtl:-scale-x-100" />}>
            {t('team.reply')}
          </Button>
        </form>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ family members */

/** The two access levels a patient gives a family member (reading is always included). */
const LOG_ONLY: CaregiverScope[] = ['log'];
const LOG_AND_MANAGE: CaregiverScope[] = ['log', 'manage'];
type AccessLevel = 'log' | 'manage';
const levelOf = (scopes: CaregiverScope[] | undefined): AccessLevel => (scopes?.includes('manage') ? 'manage' : 'log');

/** The patient decides who in the family may follow their record. */
export function CaregiverManager() {
  const { t, fmt, pick } = useLocale();
  const toast = useToast();
  const errorToast = useErrorToast();
  const q = useApi('care', 'caregivers', {});
  const { mutate, pending } = useMutation();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [relationship, setRelationship] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const [allowManage, setAllowManage] = useState(false);
  const [savingScope, setSavingScope] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ user_id: string; name: string } | null>(null);

  async function invite(e: FormEvent) {
    e.preventDefault();
    try {
      const res = await mutate('care', 'invite_caregiver', {
        relationship: relationship.trim() || undefined,
        scopes: allowManage ? LOG_AND_MANAGE : LOG_ONLY,
      });
      q.setData(res);
      setCode(res.code ?? null);
    } catch (err) {
      errorToast(err);
    }
  }
  async function sendByEmail(e: FormEvent) {
    e.preventDefault();
    if (!code) return;
    try {
      await mutate('care', 'email_invite', { code, email: inviteEmail.trim() });
      setEmailSent(true);
    } catch (err) {
      errorToast(err);
    }
  }
  async function setLevel(userId: string, level: AccessLevel) {
    setSavingScope(userId);
    try {
      q.setData(await mutate('care', 'set_caregiver_scopes', { caregiver_user_id: userId, scopes: level === 'manage' ? LOG_AND_MANAGE : LOG_ONLY }));
      toast(t('common.saved'));
    } catch (err) {
      errorToast(err);
    } finally {
      setSavingScope(null);
    }
  }
  async function cancelInvite(c: string) {
    try {
      q.setData(await mutate('care', 'revoke_caregiver', { code: c }));
    } catch (err) {
      errorToast(err);
    }
  }
  async function remove() {
    if (!removing) return;
    try {
      q.setData(await mutate('care', 'revoke_caregiver', { caregiver_user_id: removing.user_id }));
      toast(t('fam.removed', { name: removing.name }));
      setRemoving(null);
    } catch (err) {
      errorToast(err);
    }
  }
  const shareText = code ? t('fam.shareText', { code, url: typeof window !== 'undefined' ? `${window.location.origin}/register?invite=${code}` : '' }) : '';

  return (
    <Card id="family" className="scroll-mt-24">
      <CardHeader
        title={t('fam.title')}
        subtitle={t('fam.subtitle')}
        icon={<UsersRound className="size-5" />}
        action={
          <Button size="md" icon={<UserPlus className="size-4" />} onClick={() => { setCode(null); setRelationship(''); setInviteEmail(''); setEmailSent(false); setAllowManage(false); setInviteOpen(true); }}>
            {t('fam.invite')}
          </Button>
        }
      />
      {q.loading && !q.data ? (
        <SkeletonList rows={1} />
      ) : q.data ? (
        <div className="space-y-3">
          {q.data.caregivers.length === 0 && q.data.invites.length === 0 && <p className="text-base text-fg-muted">{t('fam.none')}</p>}
          {q.data.caregivers.map((c) => {
            const name = pick(c.full_name, c.full_name_ar);
            return (
              <div key={c.user_id} className="space-y-3 rounded-2xl border border-line bg-surface p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-base font-semibold">{name}</div>
                    <div className="text-sm text-fg-muted">
                      {c.relationship ? (
                        <>
                          <bdi>{c.relationship}</bdi> ·{' '}
                        </>
                      ) : null}
                      {t('fam.since', { d: fmt.date(c.granted_at) })}
                    </div>
                  </div>
                  <Button size="md" variant="ghost" icon={<UserX className="size-4" />} onClick={() => setRemoving({ user_id: c.user_id, name })}>
                    {t('fam.remove')}
                  </Button>
                </div>
                <fieldset>
                  <legend className="mb-1.5 text-sm font-medium text-fg-muted">{t('fam.accessFor', { name })}</legend>
                  <OptionButtons<AccessLevel>
                    name={t('fam.accessFor', { name })}
                    value={levelOf(c.scopes)}
                    disabled={savingScope === c.user_id}
                    onChange={(v) => {
                      if (v !== levelOf(c.scopes)) void setLevel(c.user_id, v);
                    }}
                    options={[
                      { value: 'log', label: t('fam.levelLog'), hint: t('fam.levelLogHint'), icon: <PencilLine className="size-5" /> },
                      { value: 'manage', label: t('fam.levelManage'), hint: t('fam.levelManageHint'), icon: <Stethoscope className="size-5" /> },
                    ]}
                  />
                </fieldset>
              </div>
            );
          })}
          {q.data.invites.map((i) => (
            <div key={i.code} className="flex flex-wrap items-center gap-3 rounded-2xl border border-dashed border-line-strong p-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="num font-mono text-base font-semibold tracking-widest" dir="ltr">{i.code}</span>
                  <Badge tone="warn">{t('fam.waiting')}</Badge>
                  <Badge tone={levelOf(i.scopes) === 'manage' ? 'primary' : 'neutral'}>{t(levelOf(i.scopes) === 'manage' ? 'fam.levelManage' : 'fam.levelLog')}</Badge>
                </div>
                <div className="text-sm text-fg-muted">{t('fam.expires', { d: fmt.date(i.expires_at) })}</div>
              </div>
              <Button size="md" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => void cancelInvite(i.code)}>
                {t('common.cancel')}
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      <Dialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title={t('fam.invite')}
        footer={
          code ? (
            <Button size="lg" onClick={() => setInviteOpen(false)}>
              {t('common.done')}
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="lg" onClick={() => setInviteOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" form="fam-invite" size="lg" loading={pending}>
                {t('fam.createCode')}
              </Button>
            </>
          )
        }
      >
        {code ? (
          <div className="space-y-4 text-center">
            <p className="text-base leading-7 text-fg">{t('fam.codeIntro')}</p>
            <p className="num rounded-2xl bg-primary-soft py-4 font-mono text-4xl font-bold tracking-[0.3em] text-primary-strong" dir="ltr">
              {code}
            </p>
            <p className="text-sm text-fg-muted">{t('fam.codeRules')}</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="outline" icon={<Copy className="size-4" />} onClick={() => void navigator.clipboard?.writeText(shareText).then(() => toast(t('fam.copied')))}>
                {t('fam.copy')}
              </Button>
              {typeof navigator !== 'undefined' && 'share' in navigator && (
                <Button variant="outline" icon={<Share2 className="size-4" />} onClick={() => void navigator.share({ text: shareText }).catch(() => {})}>
                  {t('fam.share')}
                </Button>
              )}
            </div>
            {q.data?.email_enabled &&
              (emailSent ? (
                <p className="rounded-xl bg-ok-soft px-4 py-3 text-base text-ok-fg" role="status">
                  {t('fam.emailSent')}
                </p>
              ) : (
                <form onSubmit={sendByEmail} className="flex flex-wrap items-end gap-2 border-t border-line pt-4 text-start">
                  <Field label={t('fam.emailLabel')} className="min-w-48 flex-1">
                    <Input type="email" dir="ltr" required value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
                  </Field>
                  <Button type="submit" variant="outline" loading={pending}>
                    {t('fam.emailSend')}
                  </Button>
                </form>
              ))}
          </div>
        ) : (
          <form id="fam-invite" onSubmit={invite} className="space-y-4">
            <p className="text-base leading-7 text-fg">{t('fam.inviteIntro')}</p>
            <Field label={`${t('fam.relationship')} (${t('common.optional')})`} hint={t('fam.relationshipHint')}>
              <Input value={relationship} onChange={(e) => setRelationship(e.target.value)} maxLength={60} />
            </Field>
            <CheckRow checked={allowManage} onChange={setAllowManage} title={t('fam.allowManage')} body={t('fam.allowManageBody')} />
          </form>
        )}
      </Dialog>

      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        size="sm"
        title={t('fam.removeTitle', { name: removing?.name ?? '' })}
        footer={
          <>
            <Button variant="ghost" size="lg" onClick={() => setRemoving(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" size="lg" loading={pending} onClick={() => void remove()}>
              {t('fam.remove')}
            </Button>
          </>
        }
      >
        <p className="text-base leading-7">{t('fam.removeBody')}</p>
      </Dialog>
    </Card>
  );
}

/** A signed-in caregiver adds another person with a new code. */
export function RedeemInviteCard() {
  const { t } = useLocale();
  const toast = useToast();
  const { refreshUser } = useAuth();
  const { mutate, pending, error, clearError } = useMutation();
  const [code, setCode] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    clearError();
    try {
      await mutate('auth', 'redeem_invite', { code: code.trim() });
      await refreshUser();
      setCode('');
      toast(t('fam.added'));
    } catch {
      /* inline */
    }
  }
  return (
    <Card>
      <CardHeader title={t('fam.addPerson')} subtitle={t('fam.addPersonHint')} icon={<UserPlus className="size-5" />} />
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <Field label={t('fam.code')} className="min-w-48 flex-1">
          <Input dir="ltr" autoCapitalize="characters" className="font-mono tracking-widest uppercase" value={code} onChange={(e) => setCode(e.target.value)} maxLength={12} />
        </Field>
        <Button type="submit" size="lg" loading={pending} disabled={code.trim().length < 8}>
          {t('fam.addButton')}
        </Button>
      </form>
      <div className="mt-2">
        <InlineError error={error} />
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ my data */

/** Download everything, or close the account (patients and caregivers). */
export function MyDataSettings() {
  const { t } = useLocale();
  const { user, logout } = useAuth();
  const errorToast = useErrorToast();
  const { mutate, pending, error, clearError } = useMutation();
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [password, setPassword] = useState('');

  async function download() {
    setBusy(true);
    try {
      const data = await mutate('profile', 'export', {});
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `my-health-record-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  }
  async function close(e: FormEvent) {
    e.preventDefault();
    clearError();
    try {
      await mutate('auth', 'delete_account', { password });
      await logout();
      window.location.replace('/login?closed=1');
    } catch {
      /* inline */
    }
  }

  return (
    <Card>
      <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold">
        <Download className="size-5 text-primary" aria-hidden />
        {t('data.title')}
      </h2>
      <div className="mb-4">
        <p className="mb-2 text-base leading-7 text-fg-muted">{t('summary.hint')}</p>
        <Link
          href="/app/summary"
          className="inline-flex min-h-12 items-center gap-2 rounded-xl border border-line-strong bg-surface px-4 text-base font-semibold text-fg hover:bg-surface-2"
        >
          <FileText className="size-5" aria-hidden />
          {t('summary.title')}
        </Link>
      </div>
      {user?.role === 'patient' && (
        <div className="mb-4">
          <p className="mb-2 text-base leading-7 text-fg-muted">{t('data.exportHint')}</p>
          <Button variant="outline" size="lg" loading={busy} icon={<Download className="size-5" />} onClick={() => void download()}>
            {t('data.export')}
          </Button>
        </div>
      )}
      <div className="border-t border-line pt-4">
        <p className="mb-2 text-base leading-7 text-fg-muted">{t(user?.role === 'patient' ? 'data.closeHint' : 'data.closeHintCaregiver')}</p>
        <Button variant="ghost" size="lg" className="text-danger" onClick={() => { setPassword(''); clearError(); setClosing(true); }}>
          {t('data.close')}
        </Button>
      </div>
      <Dialog
        open={closing}
        onClose={() => setClosing(false)}
        size="sm"
        title={t('data.closeTitle')}
        footer={
          <>
            <Button variant="ghost" size="lg" onClick={() => setClosing(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form="close-account" variant="danger" size="lg" loading={pending} disabled={!password}>
              {t('data.closeConfirm')}
            </Button>
          </>
        }
      >
        <form id="close-account" onSubmit={close} className="space-y-3">
          <p className="text-base leading-7">{t(user?.role === 'patient' ? 'data.closeBody' : 'data.closeBodyCaregiver')}</p>
          <Field label={t('acc.currentPassword')}>
            <Input type="password" autoComplete="current-password" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <InlineError error={error} />
        </form>
      </Dialog>
    </Card>
  );
}
