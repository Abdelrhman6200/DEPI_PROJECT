// 020 Operations: job records, retention, escalation of unacknowledged urgent items, daily care tasks, stale episodes,
// the operations health page, read auditing, input range checks and family changes to verified records
// (port of database/migrations/020_fn_operations.sql).
//
// Notes on the port:
// - Day intervals (`now() - interval 'N days'`, make_interval(days => N)) keep the Cairo wall-clock time across a
//   daylight-saving change, as Postgres does (_m15_daysAgo in 15_events_jobs.js); hour and minute intervals are absolute.
// - Retention never touches audit_logs, which stays append-only (the runtime refuses updates and deletes there).
// - fn_log_date accepts the ISO forms of a date (YYYY-MM-DD, optionally followed by a time, and YYYYMMDD) and the words
//   today / yesterday / tomorrow; other spellings Postgres would read as a date ('10/10/2026', 'Oct 10 2026') are
//   refused with the same "date must be YYYY-MM-DD" message.
// - api_cancel_appointment treats a NULL from fn_can_access_patient as "no access" (fail closed).

/* ------------------------------------------------------------------------------------------- private helpers */

/** jsonb ? key: an object key, a string element of an array, or the string itself; NULL when the value is NULL. */
function _m20_hasKey(v, key) {
  if (v === null || v === undefined || key === null || key === undefined) return null;
  if (Array.isArray(v)) return v.some((x) => typeof x === 'string' && x === key);
  if (typeof v === 'object') return Object.prototype.hasOwnProperty.call(v, key);
  return typeof v === 'string' && v === key;
}
/** Counts per key, as jsonb_object_agg(key, count(*)) ... group by key; {} when there are no rows. */
function _m20_countBy(rows, keyOf) {
  const out = {};
  for (const r of rows) { const k = keyOf(r); out[k] = (out[k] || 0) + 1; }
  return out;
}
/** format('%s', v): NULL prints as the empty string. */
function _m20_s(v) { return v === null || v === undefined ? '' : String(v); }

/* ------------------------------------------------------------------- job records (a job that stops running is visible) */

function fn_job_run(p_job, p_result) {
  dbInsert('job_runs', { job: p_job ?? null, result: p_result ?? null });
  const cutoff = t(_m15_daysAgo(14));
  dbDeleteWhere('job_runs', (r) => r.job === p_job && t(r.at) < cutoff);
  return p_result ?? null;
}

/* ------------------------------------------------------------------------------------------------------ retention */

// Retention (safety_rules.retention_policy). The audit log, clinical records and briefs are kept; operational data that
// can hold health information is removed or emptied when it is no longer needed.
function fn_run_retention() {
  const p = coalesce(fn_rule('retention_policy'), {});
  const days = (key, dflt) => coalesce(castInt(jtext(_m15_get(p, key))), dflt);
  const before = (key, dflt) => t(_m15_daysAgo(days(key, dflt)));
  const r = {};

  let cut = before('outbox_days', 30);
  r.outbox = dbDeleteWhere('outbox', (x) => ['done', 'skipped', 'failed'].includes(x.status) && t(coalesce(x.processed_at, x.occurred_at)) < cut);

  cut = before('incidents_days', 90);
  r.incidents = dbDeleteWhere('incidents', (x) => t(x.at) < cut);

  cut = before('notifications_days', 180);
  r.notifications = dbDeleteWhere('notifications', (x) => t(x.created_at) < cut && x.read_at !== null);

  // AI runs keep their metadata (status, model, release, latency, gate summary) for safety review; the stored inputs
  // and outputs, which can hold health information, are emptied.
  cut = before('ai_run_payload_days', 90);
  r.ai_run_payloads = dbUpdateWhere('ai_runs', (x) => t(x.created_at) < cut && (x.input !== null || x.output !== null), { input: null, output: null });

  // Uploaded files are kept until the document has been reviewed, then for document_file_days.
  cut = before('document_file_days', 30);
  // The file on the n8n server is overwritten (the workflow writes the engine's file list), and the row loses its reference.
  r.document_files = dbUpdateWhere('documents', (x) => (x.file_base64 !== null || x.file_ref !== null) && ['verified', 'rejected'].includes(x.status) && t(x.created_at) < cut,
    (x) => { if (x.file_ref) dbFileRemove(x.file_ref); return { file_base64: null, file_ref: null }; });

  // Every request reads glucose_readings whole, so it must stay small: readings older than readings_archive_days move to
  // glucose_readings_archive (at most readings_archive_batch a night). The data export reads both tabs.
  cut = before('readings_archive_days', 180);
  const old = dbWhere('glucose_readings', (x) => t(x.measured_at) < cut).slice(0, days('readings_archive_batch', 2000));
  for (const x of old) {
    dbInsert('glucose_readings_archive', { ...x, archived_at: now() }, { onConflict: 'nothing' });
    dbDelete('glucose_readings', x);
  }
  r.readings_archived = old.length;

  cut = before('expired_grants_days', 30);
  r.access_grants = dbDeleteWhere('access_grants', (x) => t(x.expires_at) < cut);

  cut = before('invites_days', 30);
  const nowT = nowMs();
  r.invites = dbDeleteWhere('caregiver_invites', (x) => (x.used_at !== null || x.revoked === true || t(x.expires_at) < nowT) && t(x.created_at) < cut);

  cut = before('link_requests_days', 180);
  r.link_requests = dbDeleteWhere('link_requests', (x) => x.status !== 'pending' && t(x.created_at) < cut);

  dbDeleteWhere('mfa_challenges', (x) => t(x.expires_at) < nowT - HOUR);
  const dayAgo = t(_m15_daysAgo(1));
  dbDeleteWhere('password_reset_tokens', (x) => t(x.expires_at) < dayAgo);
  const weekAgo = t(_m15_daysAgo(7)), monthAgo = t(_m15_daysAgo(30));
  dbDeleteWhere('sessions', (x) => t(x.expires_at) < weekAgo || (x.revoked === true && t(x.created_at) < monthAgo));
  dbDeleteWhere('auth_events', (x) => t(x.at) < dayAgo);
  // Deleted rows stay in their tab as tombstones (so row numbers held by running requests stay right); the busiest tabs
  // would grow for ever, so the tombstones this run read are removed here, once there are at least 20 in a tab. The
  // removal is guarded like every write (dbCompact): a request that read the tab before it runs again on a fresh read.
  // Only rows deleted earlier are removed, never a live row; their references were removed or cleared when they were
  // deleted (the foreign-key actions of dbDelete), so nothing points at them.
  let compacted = 0;
  for (const name of ['outbox', 'auth_events', 'sessions', 'notifications', 'incidents', 'mfa_challenges', 'password_reset_tokens',
    'access_grants', 'caregiver_invites', 'link_requests', 'glucose_readings']) compacted += dbCompact(name, { min: 20 });
  if (compacted) r.compacted = compacted;
  return r;
}

/* ------------------------------------------------------------------------------------------------------ escalation */

// An urgent item that nobody acknowledged in time is raised to the Safety Officers and the clinic's administrators
// (once per item). Critical: 30 minutes; high: 4 hours.
function fn_run_escalations() {
  const nowT = nowMs();
  const week = t(_m15_daysAgo(7));   // an older backlog is shown on the health page, not paged
  const late = dbWhere('inbox_items', (i) => ['OPEN', 'ROUTED'].includes(i.status) && i.escalated_at === null
    && t(i.created_at) > week
    && ((i.urgency === 'critical' && t(i.created_at) < nowT - 30 * MIN) || (i.urgency === 'high' && t(i.created_at) < nowT - 4 * HOUR)));
  for (const l of late) dbUpdate('inbox_items', l, { escalated_at: now() });
  const staff = dbWhere('users', (u) => u.active === true && (u.role === 'safety_officer' || u.role === 'clinic_admin'));
  for (const l of late) {
    const o = l.organization_id === null ? null : dbGet('organizations', l.organization_id);
    const minutes = round((nowT - t(l.created_at)) / MIN);
    for (const u of staff) {
      if (u.role === 'clinic_admin'
          && !(l.organization_id !== null && dbExists('memberships', (m) => m.user_id === u.id && m.organization_id === l.organization_id))) continue;
      dbInsert('notifications', {
        user_id: u.id, patient_id: l.patient_id, kind: 'escalation',
        title: `Not yet acknowledged: ${l.title}`,
        body: `A ${l.urgency} item in ${coalesce(o && o.name, 'a clinic')} has waited ${minutes} minutes without acknowledgement.`,
        title_ar: `لم يتم الاطلاع بعد: ${l.title}`,
        body_ar: `عنصر ${l.urgency === 'critical' ? 'حرج' : 'عاجل'} في ${coalesce(o && o.name_ar, o && o.name, 'العيادة')} ينتظر منذ ${minutes} دقيقة دون اطلاع.`,
        dedupe_key: `escalation:${l.id}:${u.id}`,
      }, { onConflict: 'nothing' });
    }
  }
  return { escalated: late.length };
}

/* ---------------------------------------------------------------------------------------- daily care tasks, episodes */

// Daily care tasks: every day the next 7 days of tasks exist for the daily items of each active plan, and daily tasks
// left pending for more than 2 days are marked skipped (the list never grows without end).
function fn_generate_tasks() {
  const day = today();
  const dueTimes = [0, 1, 2, 3, 4, 5, 6].map((n) => castTs(`${addDays(day, n)} 20:00`));
  let created = 0;
  for (const cp of dbWhere('care_plans', (x) => x.status === 'ACTIVE')) {
    const p = dbGet('patients', cp.patient_id);
    if (!p || fn_account_closed(p.id)) continue;
    const items = dbWhere('care_plan_items', (it) => it.plan_id === cp.id && ['monitoring', 'lifestyle'].includes(it.kind)
      && _m20_hasKey(it.schedule, 'times_per_day') === true);
    for (const it of items) {
      for (const due of dueTimes) {
        const row = dbInsert('care_tasks', { patient_id: cp.patient_id, plan_id: cp.id, plan_item_id: it.id, title: it.title,
          title_ar: it.title_ar, kind: it.kind, due_at: due }, { onConflict: 'nothing' });
        if (row) created++;
      }
    }
  }
  const cutoff = t(_m15_daysAgo(2));
  const expired = dbUpdateWhere('care_tasks', (x) => x.status === 'pending' && ['monitoring', 'lifestyle'].includes(x.kind)
    && x.due_at !== null && t(x.due_at) < cutoff, { status: 'skipped' });
  return { created, expired };
}

// Episodes nobody touched for a long time are closed: an intake never finished (3 days) or an assessed problem with
// no activity for 30 days. The follow-up job handles the normal path.
function fn_close_stale_episodes() {
  const d3 = t(_m15_daysAgo(3)), d30 = t(_m15_daysAgo(30));
  const n1 = dbUpdateWhere('episodes', (e) => ['DRAFT', 'INTAKE_IN_PROGRESS'].includes(e.status) && t(e.updated_at) < d3,
    { status: 'CLOSED', updated_at: now() });
  const n2 = dbUpdateWhere('episodes', (e) => ['ASSESSED', 'ROUTED', 'ACTION_SELECTED', 'FOLLOW_UP', 'CARE_RECEIVED'].includes(e.status)
    && t(e.updated_at) < d30, { status: 'CLOSED', updated_at: now() });
  return { abandoned_intakes: n1, inactive: n2 };
}

// A patient whose app account was closed: no reminders, reviews or other patient-facing messages.
function fn_account_closed(p_patient_id) {
  const p = dbGet('patients', castUuid(p_patient_id));
  if (!p || p.user_id === null) return false;
  const u = dbGet('users', p.user_id);
  return !!u && u.active === false;
}

/* ----------------------------------------------- operations health page (platform administrator, Safety Officer) */

function api_admin_health(c, d) {
  const expected = { reminders: 15, followups: 30, pattern_scan: 30, referral_aging: 360, daily_maintenance: 1440 };
  const g = fn_ai_gate(null, 'health_check');
  fn_require_role(c, ['platform_admin', 'safety_officer']);
  const nowT = nowMs();
  const dayAgo = nowT - 24 * HOUR;
  const pending = dbWhere('outbox', (o) => o.status === 'pending');
  const oldest = minOf(pending.map((o) => t(o.occurred_at)));
  const failed = orderBy(dbWhere('outbox', (o) => o.status === 'failed' && o.processed_at !== null && t(o.processed_at) > dayAgo),
    [(o) => t(o.processed_at), 'desc']).slice(0, 20);
  const jobs = Object.keys(expected).sort().map((key) => {
    const every = expected[key];
    const r = orderBy(dbWhere('job_runs', (j) => j.job === key), [(j) => t(j.at), 'desc'])[0] || null;
    return { job: key, every_minutes: every, last_run: r ? r.at : null,
      late: r === null || t(r.at) < nowT - (every * 2 + 5) * MIN, result: r ? r.result : null };
  });
  const runs24 = dbWhere('ai_runs', (r) => t(r.created_at) > dayAgo);
  const incidents = orderBy(dbWhere('incidents', (i) => t(i.at) > dayAgo), [(i) => t(i.at), 'desc']).slice(0, 20);
  const flags = {};
  for (const f of dbRows('feature_flags')) flags[f.key] = f.enabled;
  return {
    at: now(),
    events: {
      by_status: _m20_countBy(dbWhere('outbox', (o) => ['pending', 'processing'].includes(o.status)
        || t(coalesce(o.processed_at, o.occurred_at)) > dayAgo), (o) => o.status),
      oldest_pending_minutes: oldest === null ? null : round((nowT - oldest) / MIN),
      failed_24h: jsonAgg(failed.map((o) => ({ type: o.event_type, error: o.last_error, at: o.processed_at }))) ?? [],
    },
    jobs,
    ai: {
      runs_24h: _m20_countBy(runs24, (r) => r.status),
      releases_24h: _m20_countBy(runs24, (r) => coalesce(jtext(_m15_get(r.guard, 'release')), 'none')),
      open_runs: dbCount('ai_runs', (r) => ['QUEUED', 'PROCESSING', 'VERIFYING'].includes(r.status)),
      cloud_allowed_now: castBool(jtext(_m15_get(g, 'cloud_allowed'))), cloud_reasons: _m15_get(g, 'reasons'),
    },
    incidents_24h: jsonAgg(incidents.map((i) => ({ workflow: i.workflow, node: i.node, message: i.message, at: i.at }))) ?? [],
    inbox: {
      unacknowledged_critical: dbCount('inbox_items', (i) => ['OPEN', 'ROUTED'].includes(i.status) && i.urgency === 'critical'),
      escalated_open: dbCount('inbox_items', (i) => i.status !== 'RESOLVED' && i.escalated_at !== null),
    },
    flags,
  };
}

/* ------------------------------------- read auditing: staff opening a patient's record (once an hour per person, view) */

function fn_audit_read(c, p_patient_id, p_view, p_payload) {
  const role = jtext(_m15_get(c, 'role'));
  const pid = castUuid(p_patient_id);
  if (role !== null && role !== 'patient' && role !== 'caregiver' && pid !== null) {
    const uid = castUuid(jtext(_m15_get(c, 'user_id')));
    const view = p_view ?? null;
    const since = nowMs() - HOUR;
    const seen = uid !== null && view !== null && dbExists('audit_logs', (a) => a.action === 'record.view' && a.actor_id === uid
      && a.patient_id === pid && a.entity === view && t(a.at) > since);
    if (!seen) dbInsert('audit_logs', { actor_id: uid, actor_role: role, action: 'record.view', entity: view, patient_id: pid });
  }
  return p_payload ?? null;
}

/* ------------------- input ranges: a value outside the plausible range is refused with a clear message, not stored */

function fn_num_in(p_data, p_key, p_lo, p_hi, p_default = null) {
  const v = nullif(trimChars(coalesce(jtext(_m15_get(p_data, p_key)), ''), ' '), '');
  if (v === null) return p_default ?? null;
  const ok = /^-?[0-9]+(\.[0-9]+)?$/.test(v);
  const n = ok ? Number(v) : null;
  const lo = p_lo ?? null, hi = p_hi ?? null;
  if (!ok || (lo !== null && n < Number(lo)) || (hi !== null && n > Number(hi))) {
    fn_raise(`bad_request: ${_m20_s(_m15_replace(p_key, '_', ' '))} must be a number from ${_m20_s(lo)} to ${_m20_s(hi)}.`);
  }
  return n + 0;    // -0 is 0, as numeric
}

// A list size or a number of days from the request, kept within limits.
function fn_clamp(p_value, p_default, p_lo, p_hi) {
  const s = p_value === null || p_value === undefined ? '' : String(p_value);
  const x = /^[0-9]{1,6}$/.test(s) ? Number(s) : (p_default ?? null);
  return greatest(p_lo ?? null, least(p_hi ?? null, x));
}

/* ------------- a patient or family member changing something a clinician verified: the care team is told (see
   fn_medication_safety: the clinician's own safety items stay open) */

function fn_note_family_change(c, p_patient_id, p_kind, p_id, p_title, p_verified) {
  const role = jtext(_m15_get(c, 'role'));
  // `role not in (...)` is NULL for a context without role, which does not return here (as in the SQL).
  if ((role !== null && role !== 'patient' && role !== 'caregiver') || !coalesce(p_verified, false)) return;
  p_id = castUuid(p_id);
  const prefix = p_kind === 'medication' ? 'Patient stopped a verified medicine: '
    : p_kind === 'allergy' ? 'Patient removed a verified allergy: '
    : 'Patient marked a verified condition resolved: ';
  fn_create_inbox_item(p_patient_id, 'verification', 'medium', 3, prefix + coalesce(p_title, ''),
    `${role === 'caregiver' ? 'Changed by a family member' : 'Changed by the patient'} in the app. Please review it with them.`,
    { entity: p_kind ?? null, id: p_id ?? null, by_role: role }, _m15_cat('family-change:', p_kind, ':', p_id));
}

/* ------- appointments: cancelling (patients and family: their own future requests and bookings; staff: any open one) */

function api_cancel_appointment(c, d) {
  const role = jtext(_m15_get(c, 'role'));
  const family = role === 'patient' || role === 'caregiver';
  const a = dbGet('appointments', castUuid(nullif(jtext(_m15_get(d, 'appointment_id')), '')));
  if (!a || !fn_can_access_patient(c, a.patient_id)) fn_raise('not_found: appointment not found');
  if (!['requested', 'booked'].includes(a.status)) {
    fn_raise('bad_request: Only a requested or booked appointment can be cancelled.');
  }
  if (family && t(a.starts_at) < nowMs()) fn_raise('bad_request: This appointment has already started or passed.');
  dbUpdate('appointments', a, { status: 'cancelled' });
  const when = _m15_local16(a.starts_at);
  if (family) {
    // The clinic learns about it in its inbox.
    const reason = nullif(left(jtext(_m15_get(d, 'reason')), 300), '');
    fn_create_inbox_item(a.patient_id, 'question', 'low', 4, `Appointment cancelled by the ${role === 'caregiver' ? 'family' : 'patient'}`,
      `${when}${reason === null ? '' : ` · ${reason}`}`, { appointment_id: a.id }, `appt-cancel:${a.id}`);
  } else {
    fn_notify_patient(a.patient_id, 'appointment', 'Your appointment was cancelled',
      `${when}. Please book a new time if you still need one.`, `appt-cancelled:${a.id}`,
      'تم إلغاء موعدك', `${when}. من فضلك احجز موعدًا جديدًا إذا كنت ما زلت تحتاج إليه.`);
  }
  fn_audit(c, 'appointment.cancelled', 'appointment', a.id, a.patient_id);
  return { ok: true, appointment: fn_appointment_json(a) };
}

// The day a log entry belongs to: today when not given; never in the future and at most 30 days back.
function fn_log_date(p) {
  const s = p === null || p === undefined ? '' : trimChars(String(p), ' ');
  const day = today();
  if (s === '') return day;
  let v = null;
  const words = { today: 0, yesterday: -1, tomorrow: 1 };
  const w = s.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(words, w)) v = addDays(day, words[w]);
  else {
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/i)
      || s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) {
      const iso10 = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
      v = dbTry(() => castDate(iso10), () => null);
    }
  }
  if (v === null) fn_raise('bad_request: date must be YYYY-MM-DD');
  if (v > day) fn_raise('bad_request: The date is in the future.');
  if (v < addDays(day, -30)) fn_raise('bad_request: Entries can be added for the last 30 days only.');
  return v;
}
