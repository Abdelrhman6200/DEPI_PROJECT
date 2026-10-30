// Core orchestration: error handler, event dispatcher, scheduled jobs, deterministic handlers,
// Nightscout connector and the demo CGM simulator. (RAG and the MedGemma consult: rag.mjs.)
import {
  workflow, pg, code, ifTrue, execWorkflow, schedule, errorTrigger, httpGet, subTrigger, CRED, WF, loop, wait,
} from './lib.mjs';

/** Event type -> consumer workflow (blueprint Appendix A.2). Unlisted events are marked skipped. */
export const EVENT_ROUTES = {
  GlucosePatternDetected: WF.pattern,
  MedicationSafetyFindingCreated: WF.medSafety,
  LabResultVerified: WF.lab,
  CarePlanPublished: WF.afterVisit,
  HypoglycemiaDetected: WF.glucoseEvent,
  HyperglycemiaDetected: WF.glucoseEvent,
  ReferralCreated: WF.referral,
  ReferralStatusChanged: WF.referral,
  FacilityCapacityUpdated: WF.capacity,
  RagDocumentApproved: WF.ragIngest,
  DocumentUploaded: WF.docExtract,
  TransferStatusChanged: WF.transfer,
  PasswordResetRequested: WF.email,
  CaregiverInviteEmailRequested: WF.email,
  WeeklyDigestEmail: WF.email,
  AccountSecurityNotice: WF.email,
  KnowledgeSyncRequested: WF.ragDrive,
  // Polyclinic (clinic.mjs, engine 40_clinic.js).
  ClinicBookingRequested: WF.clinicTriage,
  ClinicAppointmentConfirmed: WF.clinicPrep,
  ClinicBriefRequested: WF.clinicBrief,
  ClinicVisitSigned: WF.clinicRx,
  ClinicHintsRequested: WF.clinicHints,
};

export function errorHandler() {
  const wf = workflow({ id: WF.errorHandler, name: 'WF-099 · Global error handler', description: 'Records every failed execution of the platform in the incidents tab, without identifiers.' });
  const t = wf.add(errorTrigger());
  // Throttle: recording an incident needs Google Sheets, so when Sheets answers 429 (quota) the record itself fails and
  // would trigger this handler again, a loop that keeps the quota exhausted. Transient errors (quota, timeouts, lost
  // connections) are recorded at most once per 10 minutes with the number skipped; other errors at most 20 a minute.
  const gate = wf.add(code('Worth recording?', `
const e = $input.first().json;
const msg = String((e.execution && e.execution.error && e.execution.error.message) || '');
const s = $getWorkflowStaticData('global');
const now = Date.now();
const transient = /\\b429\\b|quota|too many requests|RESOURCE_EXHAUSTED|connection (was aborted|cannot be established)|timeout of \\d+ms|ECONNRE(SET|FUSED)|socket hang up/i.test(msg);
const k = transient ? 'transient' : 'other';
const w = s['err_' + k] || { from: 0, n: 0, skipped: 0 };
const span = transient ? 600000 : 60000, max = transient ? 1 : 20;
if (now - w.from > span) { w.from = now; w.n = 0; }
let skippedBefore = 0;
if (w.n >= max) { w.skipped++; s['err_' + k] = w; return []; }
w.n++; skippedBefore = w.skipped; w.skipped = 0; s['err_' + k] = w;
if (skippedBefore && e.execution && e.execution.error) e.execution.error.message = msg + ' (' + skippedBefore + ' similar errors not recorded)';
return [{ json: e }];`));
  const ins = wf.add(pg('Record incident', `
insert into app.incidents(workflow, node, message, execution_id)
values ($1, $2, app.fn_redact_error($3), $4)
returning id`, `[ $json.workflow?.name ?? 'unknown', $json.execution?.lastNodeExecuted ?? '', $json.execution?.error?.message ?? 'unknown error', String($json.execution?.id ?? '') ]`));
  wf.chain(t, gate, ins);
  return wf.build();
}

export function dispatcher() {
  const wf = workflow({ id: WF.dispatcher, name: 'CORE · Event dispatcher (outbox → sections)', description: 'Claims up to 5 outbox events (at most 6 in flight), skips events without a consumer, and runs each through the event runner. Runs every minute, and at once when an API request queued events (Google Sheets allows about 60 reads a minute, so it does not poll every few seconds).' });
  const t = wf.add(schedule('Every minute', { field: 'minutes', minutesInterval: 1 }));
  const now = wf.add(subTrigger('Run now'));
  const claim = wf.add(pg('Claim events', `select * from app.fn_claim_events(5, $routes$${JSON.stringify(EVENT_ROUTES, null, 1)}$routes$::jsonb, 6)`));
  const lp = wf.add(loop('Each event'));
  const run = wf.add(execWorkflow('Run event', WF.eventRunner, { onError: 'continueRegularOutput' }));
  wf.chain(t, claim, lp);
  wf.link(now, claim);
  wf.link(lp, run, { output: 1 });
  wf.link(run, lp);
  return wf.build();
}

export function eventRunner() {
  const wf = workflow({ id: WF.eventRunner, name: 'CORE · Event runner (one event)', description: 'Takes a heartbeat, runs the consumer section for one claimed event and records done/failed (retries with back-off, up to 5 attempts).' });
  const t = wf.add(subTrigger('Event'));
  // Heartbeat: events wait their turn in a sequential batch, so the claim time is refreshed when work really starts.
  // false = another run already finished or re-claimed this event, so it is left alone.
  // The claim token makes the heartbeat and the outcome count only for the run that still holds the claim.
  const start = wf.add(pg('Start event (heartbeat)', `select app.fn_event_start($1::uuid, nullif($2, '')::uuid) as started`, `[ $json.event_id, String($json.claim_token ?? '') ]`));
  const mine = wf.add(ifTrue('Still ours?', '$json.started === true'));
  const pass = wf.add(code('Event payload', `return [{ json: $('Event').first().json }];`));
  // A failing consumer continues on the normal output with { error }, and a consumer that returns nothing still yields
  // one empty item, so exactly one of "done" / "failed" always runs.
  const run = wf.add({ ...execWorkflow('Run consumer workflow', '={{ $json.workflow_id }}', { onError: 'continueRegularOutput' }), alwaysOutputData: true });
  const bad = wf.add(ifTrue('Consumer failed?', '!!$json.error'));
  const failed = wf.add(pg('Mark failed (will retry)', `select app.fn_complete_event($1::uuid, false, $2, nullif($3, '')::uuid)`,
    `[ $('Event').first().json.event_id, String($json.error?.message ?? $json.error ?? 'error').slice(0, 300), String($('Event').first().json.claim_token ?? '') ]`, { executeOnce: true }));
  const done = wf.add(pg('Mark done', `select app.fn_complete_event($1::uuid, true, null, nullif($2, '')::uuid)`,
    `[ $('Event').first().json.event_id, String($('Event').first().json.claim_token ?? '') ]`, { executeOnce: true }));
  wf.chain(t, start, mine);
  wf.link(mine, pass, { output: 0 });
  wf.chain(pass, run, bad);
  wf.link(bad, failed, { output: 0 });
  wf.link(bad, done, { output: 1 });
  return wf.build();
}

/** A schedule that calls one deterministic SQL job. */
function sqlJob(id, name, description, rule, query) {
  const wf = workflow({ id, name, description });
  const t = wf.add(schedule('Schedule', rule));
  const q = wf.add(pg('Run job', query));
  wf.chain(t, q);
  return wf.build();
}

/** An event consumer that calls one deterministic SQL handler. */
function sqlHandler(id, name, description, query) {
  const wf = workflow({ id, name, description });
  const t = wf.add(subTrigger());
  const q = wf.add(pg('Handle event', query, `[ JSON.stringify($json) ]`));
  wf.chain(t, q);
  return wf.build();
}

export function deterministicWorkflows() {
  return [
    sqlHandler(WF.glucoseEvent, 'WF-004 · Glucose event (hypo/hyper alert)', 'Fixed safety guidance to patient and caregiver; clinician inbox item. No AI.',
      `select app.fn_handle_glucose_event($1::jsonb) as result`),
    sqlHandler(WF.referral, 'WF-014 · Referral workflow notifications', 'Notifies patients on referral status changes; report-returned tasks.',
      `select app.fn_handle_referral_event($1::jsonb) as result`),
    sqlHandler(WF.transfer, 'WF-031 · Transfer notifications', 'Notifies coordinators, the requesting clinician and (from bed reservation on) the patient.',
      `select app.fn_handle_transfer_event($1::jsonb) as result`),
    sqlHandler(WF.capacity, 'WF-016 · Capacity update', 'Capacity is operational data; alerts coordinators when ER/ICU become full.',
      `select app.fn_handle_capacity_event($1::jsonb) as result`),
    sqlJob(WF.patternScan, 'WF-005b · Pattern scan (every 30 min)', 'Runs the deterministic pattern engine and emits GlucosePatternDetected events.',
      { field: 'minutes', minutesInterval: 30 }, `select app.fn_job_run('pattern_scan', app.fn_scan_patterns()) as result`),
    sqlJob(WF.reminders, 'WF-011/012/013 · Reminders and escalation of unacknowledged urgent items', 'Deterministic in-app reminders; critical inbox items not acknowledged within 30 minutes (high: 4 hours) are raised to the Safety Officers and clinic administrators.',
      { field: 'minutes', minutesInterval: 15 }, `select app.fn_job_run('reminders', app.fn_run_reminders() || jsonb_build_object('escalations', app.fn_run_escalations())) as result`),
    sqlJob(WF.followup, 'WF-003 · Episode follow-up', 'Sends due episode follow-ups and expires stale ones.',
      { field: 'minutes', minutesInterval: 30 }, `select app.fn_job_run('followups', app.fn_run_followups()) as result`),
    sqlJob(WF.referralAging, 'WF-015 · Referral follow-up (aging)', 'Flags referrals that are not progressing.',
      { field: 'hours', hoursInterval: 6 }, `select app.fn_job_run('referral_aging', app.fn_referral_aging()) as result`),
    sqlJob(WF.dailyMaintenance, 'WF-020 · Daily maintenance (retention, care tasks, stale requests)', 'Applies the retention policy, creates the next 7 days of daily care tasks, and closes abandoned or inactive Care Access requests.',
      { field: 'days', daysInterval: 1, triggerAtHour: 2, triggerAtMinute: 40 },
      `select app.fn_job_run('daily_maintenance', jsonb_build_object('retention', app.fn_run_retention(), 'tasks', app.fn_generate_tasks(), 'episodes', app.fn_close_stale_episodes())) as result`),
    sqlJob(WF.cgmSim, 'WF-017b · Demo CGM simulator (feature flag)', 'Inserts synthetic CGM readings for demo personas so the live pipeline can be seen. Disable with feature flag demo_cgm_simulator.',
      { field: 'minutes', minutesInterval: 30 }, `select app.fn_simulate_cgm() as result`),
  ];
}

export function nightscout() {
  const wf = workflow({ id: WF.nightscout, name: 'WF-017 · Nightscout CGM sync', description: 'Pulls recent SGV entries from each connected Nightscout site. Failures mark the connection DEGRADED; the app shows data age.' });
  const t = wf.add(schedule('Every 15 minutes', { field: 'minutes', minutesInterval: 15 }));
  const targets = wf.add(pg('Load connections', `select jsonb_array_elements(app.fn_nightscout_targets()) as c`));
  // The whole answer stays in one item per connection, so an empty list or a non-Nightscout answer is still
  // recorded against the right connection. Redirects are not followed (the address was validated when saved).
  const fetch = wf.add(httpGet('Fetch entries',
    // Incremental: entries newer than the last stored reading (up to a day, 288 five-minute readings), so an outage
    // longer than the old 3-hour window leaves no gap.
    "{{ $json.c.url }}/api/v1/entries/sgv.json?count=288&find[date][$gt]={{ $json.c.since }}{{ $json.c.token ? '&token=' + encodeURIComponent($json.c.token) : '' }}",
    { onError: 'continueErrorOutput', timeout: 15000, fullResponse: true, noRedirects: true }));
  const ingest = wf.add(pg('Ingest readings', `select app.fn_nightscout_ingest($1::uuid, $2::jsonb) as result`,
    `[ $('Load connections').item.json.c.patient_id, JSON.stringify($json.body ?? null) ]`));
  const fail = wf.add(pg('Mark degraded', `select app.fn_nightscout_error($1::uuid, $2)`,
    `[ $('Load connections').item.json.c.patient_id, String($json.error?.message ?? $json.error ?? 'fetch failed') ]`));
  wf.chain(t, targets);
  wf.link(targets, fetch);
  wf.link(fetch, ingest, { output: 0 });
  wf.link(fetch, fail, { output: 1 });
  return wf.build();
}

// RAG search, RAG ingestion and the MedGemma consult live in rag.mjs.

export function briefScheduler() {
  const wf = workflow({ id: WF.briefScheduler, name: 'WF-009b · Pre-visit brief scheduler (appointment −48 h)', description: 'Generates briefs for upcoming appointments that do not have one yet.' });
  const t = wf.add(schedule('Hourly', { field: 'hours', hoursInterval: 1 }));
  const q = wf.add(pg('Appointments needing a brief', `
select a.id as appointment_id, a.patient_id from app.appointments a
 where a.status = 'booked' and a.starts_at between now() and now() + interval '48 hours'
   and app.fn_tier(a.patient_id) = 'linked'
   and not exists (select 1 from app.previsit_briefs b where b.appointment_id = a.id)
 order by a.starts_at limit 3`));
  const lp = wf.add(loop('Each appointment'));
  const shape = wf.add(code('Build request', `const a = $input.first().json;
return [{ json: { action: 'generate_brief', ctx: { role: 'system' }, data: { patient_id: a.patient_id, appointment_id: a.appointment_id } } }];`));
  const run = wf.add(execWorkflow('Generate brief', WF.brief, { onError: 'continueRegularOutput' }));
  const pause = wf.add(wait('Respect model rate limit', 12));
  wf.chain(t, q, lp);
  wf.link(lp, shape, { output: 1 });
  wf.chain(shape, run, pause);
  wf.link(pause, lp);
  return wf.build();
}

export function weeklyScheduler() {
  const wf = workflow({ id: WF.weekly, name: 'WF-006 · Weekly diabetes review (scheduler)', description: 'Every day at 10:00 Cairo time, runs the weekly review for up to 15 active app users who have not had one in the last 6 days, longest-waiting first, so everyone gets one review a week. Populations outside the AI policy (pregnancy, type 1, closed-loop pump, under 18) get no AI review.' });
  const t = wf.add(schedule('Daily 10:00', { field: 'days', daysInterval: 1, triggerAtHour: 10, triggerAtMinute: 0 }));
  const q = wf.add(pg('Active patients', `
select p.id as patient_id from app.patients p
 where p.user_id is not null and not app.fn_account_closed(p.id)
   -- the policy allows no weekly review for these populations, so they would be picked (and refused) every day
   and cardinality(app.fn_exclusions(p.id)) = 0
   and exists (select 1 from app.glucose_readings g where g.patient_id = p.id and g.measured_at > now() - interval '7 days')
   and not exists (select 1 from app.patient_insights i where i.patient_id = p.id and i.kind = 'weekly' and i.created_at > now() - interval '6 days')
 order by (select max(i.created_at) from app.patient_insights i where i.patient_id = p.id and i.kind = 'weekly') nulls first, p.id
 limit 15`));
  const lp = wf.add(loop('Each patient'));
  const run = wf.add(execWorkflow('Weekly review for patient', WF.weeklyOne, { onError: 'continueRegularOutput' }));
  const pause = wf.add(wait('Respect model rate limit', 8));
  wf.chain(t, q, lp);
  wf.link(lp, run, { output: 1 });
  wf.chain(run, pause);
  wf.link(pause, lp);
  return wf.build();
}

/** WF-023: optional email delivery through any SMTP account (password reset links, family invitation codes). */
export function emailDelivery() {
  const wf = workflow({ id: WF.email, name: 'WF-023 · Email delivery (SMTP, optional)', description: 'Builds the message in the engine (the one-time reset token is created at send time, never stored in the event queue) and sends it through the SMTP account from .env. Does nothing while email is switched off.' });
  const t = wf.add(subTrigger('Event'));
  const build = wf.add(pg('Build email', `select app.fn_build_email($1::jsonb, $2) as m`, `[ JSON.stringify($json), $env.APP_URL || '' ]`));
  const has = wf.add(ifTrue('Anything to send?', '!!($json.m && $json.m.to)'));
  const send = wf.add({
    name: 'Send email (SMTP)',
    type: 'n8n-nodes-base.emailSend',
    typeVersion: 2.1,
    credentials: { smtp: CRED.smtp },
    parameters: {
      resource: 'email',
      operation: 'send',
      fromEmail: "={{ $env.SMTP_FROM || 'no-reply@example.com' }}",
      toEmail: '={{ $json.m.to }}',
      subject: '={{ $json.m.subject }}',
      emailFormat: 'text',
      text: '={{ $json.m.text }}',
      options: { appendAttribution: false },
    },
  });
  wf.chain(t, build, has);
  wf.link(has, send, { output: 0 });
  return wf.build();
}
