// 015 Deterministic event handlers and scheduled jobs called by n8n, plus AI context loaders
// (port of database/migrations/015_fn_events_jobs.sql).
//
// Notes on the port:
// - `now() - interval 'N days'` keeps the Cairo wall-clock time across a daylight-saving change, as Postgres does
//   (_m15_daysAgo); hour and minute intervals are absolute. 20_operations.js uses the same helper.
// - Where the SQL had no ORDER BY (jsonb_agg without order, the CGM simulator loop, fan-out inserts) rows are visited in
//   sheet order.
// - The reminder window ("dose time between now and now + 15 minutes") compares Cairo wall-clock times, as the SQL did
//   with timestamp-without-time-zone values; it does not wrap past midnight either.
// - fn_simulate_cgm uses Math.random() for random().
// - Timestamps inside JSON results are ISO strings in UTC (Postgres printed them with the +03 offset).
// - api_intake_free_text treats a NULL from fn_can_access_patient as "no access" (the SQL's `not NULL` let it through;
//   the engine's fn_can_access_patient returns true or false).

/* ------------------------------------------------------------------------------------------- private helpers */

function _m15_isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
/** v -> 'key' (null for a missing field, a NULL key or a value that is not an object). */
function _m15_get(v, key) {
  if (key === null || key === undefined || !_m15_isObj(v)) return null;
  return Object.prototype.hasOwnProperty.call(v, key) && v[key] !== undefined ? v[key] : null;
}
/** v ->> 'key' */
function _m15_text(v, key) { return jtext(_m15_get(v, key)); }
/** SQL text concatenation (||): NULL when any part is NULL; numbers as their text. */
function _m15_cat(...parts) {
  let s = '';
  for (const p of parts) { if (p === null || p === undefined) return null; s += String(p); }
  return s;
}
/** replace(text, from, to) of Postgres (every occurrence; NULL in, NULL out). */
function _m15_replace(s, from, to) {
  if (s === null || s === undefined || from === null || from === undefined || to === null || to === undefined) return null;
  return from === '' ? String(s) : String(s).split(String(from)).join(String(to));
}
/** to_char(app.fn_local(ts), 'YYYY-MM-DD HH24:MI') */
function _m15_local16(ts) { return ts === null || ts === undefined ? null : localTimestamp(ts).slice(0, 16).replace('T', ' '); }
/** to_char(ts, 'YYYYMMDDHH24MISS') in Cairo time; 'YYYYMMDDHH24MI' with n = 12, 'YYYYMM' with n = 6. */
function _m15_digits(ts, n = 14) { return ts === null || ts === undefined ? null : localTimestamp(ts).replace(/[-T:]/g, '').slice(0, n); }
/** now() - interval 'n days' in Africa/Cairo: the wall-clock time stays the same across a daylight-saving change. */
function _m15_daysAgo(n) {
  const p = cairoParts(now());
  const two = (x) => String(x).padStart(2, '0');
  const d = addDays(localDate(now()), -n);
  return castTs(`${d} ${two(p.h)}:${two(p.mi)}:${two(p.s)}.${String(p.ms).padStart(3, '0')}`);
}
/** jsonb || jsonb: objects merge, anything else concatenates as arrays; NULL in, NULL out. */
function _m15_jsonConcat(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (_m15_isObj(a) && _m15_isObj(b)) return { ...a, ...b };
  return [...(Array.isArray(a) ? a : [a]), ...(Array.isArray(b) ? b : [b])];
}
/** jsonb - 'key' - ... */
function _m15_minus(v, ...keys) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.filter((x) => !(typeof x === 'string' && keys.includes(x)));
  if (_m15_isObj(v)) return omit(v, keys);
  throw new Error('cannot delete from scalar');
}
/** jsonb_array_elements(v): NULL gives no rows; a scalar or an object fails as in Postgres. */
function _m15_elements(v) {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  throw new Error(_m15_isObj(v) ? 'cannot extract elements from an object' : 'cannot extract elements from a scalar');
}
/** jsonb_array_elements_text(v): JSON null elements become NULL. */
function _m15_elementsText(v) { return _m15_elements(v).map((x) => jtext(x)); }
/** r -> key <> 'null'::jsonb (a missing key is NULL, which is not true either). */
function _m15_present(r, key) { return _m15_get(r, key) !== null; }

/* ------------------------------------------------------------------------- WF-004 glucose events (no AI) */

// Fixed, safety-officer-approved guidance; no AI.
function fn_handle_glucose_event(p_event) {
  const th = fn_rule('glucose_thresholds');
  const e = dbGet('glucose_events', castUuid(_m15_text(p_event, 'resource_id')));
  if (!e) return { handled: false, reason: 'event_not_found' };
  const hypo = /hypo$/.test(e.type);
  const v = String(e.value_mgdl);
  const msg = (type, lang) => _m15_replace(_m15_text(_m15_get(_m15_get(th, 'messages'), type), lang), '{value}', v);
  fn_notify_patient(e.patient_id, `glucose_${e.type}`,
    `${hypo ? 'Low glucose ' : 'High glucose '}${v} mg/dL`,
    msg(e.type, 'en'), `glucose_event:${e.id}`,
    `${hypo ? 'انخفاض السكر ' : 'ارتفاع السكر '}${v} مجم/دل`,
    msg(e.type, 'ar'));
  let inbox = null;
  if (['severe_hypo', 'hypo', 'severe_hyper'].includes(e.type)) {
    inbox = fn_create_inbox_item(e.patient_id, 'glucose',
      e.type === 'severe_hypo' ? 'critical' : 'high',
      e.type === 'severe_hypo' ? 1 : 2,
      `${hypo ? 'Hypoglycemia ' : 'Severe hyperglycemia '}${v} mg/dL`,
      `Detected at ${_m15_local16(e.occurred_at)} (Cairo). Patient received fixed guidance.`,
      { glucose_event_id: e.id, value: e.value_mgdl }, `glucose_event:${e.id}`);
  }
  if (e.type === 'severe_hypo') {
    dbInsert('patient_insights', {
      patient_id: e.patient_id, kind: 'hypo',
      title: `Very low glucose recorded (${v} mg/dL)`, title_ar: `تسجيل سكر منخفض جدًا (${v} مجم/دل)`,
      body: msg('severe_hypo', 'en'), body_ar: msg('severe_hypo', 'ar'), source_ref: `glucose_event:${e.id}`,
    });
  }
  return { handled: true, inbox_item: inbox ?? null };
}

/* ------------------------------------------------------------------- WF-014 / WF-016 referral and capacity events */

function fn_handle_referral_event(p_event) {
  const r = dbGet('referrals', castUuid(_m15_text(p_event, 'resource_id')));
  if (!r) return { handled: false };
  const specialty = _m15_replace(r.to_specialty, '_', ' ');
  let title, titleAr;
  switch (r.status) {
    case 'MATCHING': title = `New referral: ${specialty}`; titleAr = 'تحويل جديد إلى تخصص آخر'; break;
    case 'SELECTED': title = 'Referral facility selected'; titleAr = 'تم اختيار جهة التحويل'; break;
    case 'BOOKED': title = 'Referral appointment booked'; titleAr = 'تم حجز موعد التحويل'; break;
    case 'REPORT_RETURNED': title = 'Specialist report received'; titleAr = 'وصل تقرير الطبيب المختص'; break;
    default: title = 'Referral update'; titleAr = 'تحديث على التحويل';
  }
  fn_notify_patient(r.patient_id, 'referral', title,
    `Your ${specialty} referral is now ${_m15_replace(r.status, '_', ' ').toLowerCase()}. Open Care to see details.`,
    `referral:${r.id}:${r.status}`, titleAr,
    'تم تحديث حالة التحويل. افتح صفحة الرعاية لمعرفة التفاصيل.');
  if (r.status === 'REPORT_RETURNED') {
    fn_create_inbox_item(r.patient_id, 'referral', 'medium', 3, `Specialist report returned: ${r.to_specialty}`,
      left(r.report, 300), { referral_id: r.id }, `referral-report:${r.id}`);
  }
  return { handled: true };
}

function fn_handle_capacity_event(p_event) {
  const f = dbGet('facilities', castUuid(_m15_text(p_event, 'resource_id')));
  const resource = _m15_text(_m15_get(p_event, 'payload'), 'resource');
  const c = f && resource !== null ? dbOne('facility_capacity', (x) => x.facility_id === f.id && x.resource === resource) : null;
  if (c && c.status === 'full' && ['er_accepting', 'icu'].includes(c.resource)) {
    const hhmm = localHHMM(c.updated_at);
    for (const u of dbWhere('users', (x) => x.role === 'transfer_coordinator' || x.role === 'clinic_admin')) {
      dbInsert('notifications', {
        user_id: u.id, kind: 'capacity', title: `${f.name}: ${c.resource.toUpperCase()} full`, body: `Updated ${hhmm}`,
        dedupe_key: `capacity:${f.id}:${c.resource}:${_m15_digits(c.updated_at, 12)}:${u.id}`,
        title_ar: `${f.name_ar}: لا توجد أماكن متاحة (${c.resource})`, body_ar: `آخر تحديث ${hhmm}`,
      }, { onConflict: 'nothing' });
    }
  }
  return { handled: true };
}

/* --------------------------------------------------- WF-011/012/013 reminders, WF-003 follow-ups, WF-015 referral aging */

function fn_run_reminders() {
  const p = cairoParts(now());
  const nowLocal = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s, p.ms);     // fn_local(now()) as wall-clock milliseconds
  const day = today();
  const [y, mo, d] = day.split('-').map(Number);
  // Medication doses due in the next 15 minutes
  const due = [];
  for (const m of dbWhere('medications', (x) => x.status === 'active' && x.verification_status !== 'refuted')) {
    for (const tm of Array.isArray(m.times) ? m.times : []) {
      if (typeof tm !== 'string' || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(tm)) continue;
      const slot = Date.UTC(y, mo - 1, d, Number(tm.slice(0, 2)), Number(tm.slice(3, 5)));
      if (slot >= nowLocal && slot <= nowLocal + 15 * MIN && !fn_account_closed(m.patient_id)) due.push({ m, tm });
    }
  }
  for (const { m, tm } of due) {
    fn_notify_patient(m.patient_id, 'medication_reminder', `Time for ${m.name}`, `${coalesce(m.dose_text, '')} at ${tm}`,
      `med:${m.id}:${day}:${tm}`,
      `موعد دواء ${m.name}`, `${coalesce(m.dose_text, '')} الساعة ${tm}`);
  }
  // Appointments tomorrow (one reminder)
  const tomorrow = addDays(day, 1);
  const appts = dbWhere('appointments', (a) => a.status === 'booked' && localDate(a.starts_at) === tomorrow && !fn_account_closed(a.patient_id));
  for (const a of appts) {
    const hhmm = localHHMM(a.starts_at);
    fn_notify_patient(a.patient_id, 'appointment_reminder', 'Appointment tomorrow',
      `${hhmm} - ${coalesce(a.reason, a.type)}`, `appt:${a.id}`,
      'موعدك غدًا', `الساعة ${hhmm}${a.reason === null ? '' : ` - ${a.reason}`}`);
  }
  // Overdue screenings: at most one reminder per screening per 30 days
  let screenings = 0;
  if (p.h === 10) {
    const month = _m15_digits(now(), 6);
    for (const pt of dbWhere('patients', (x) => x.user_id !== null && !fn_account_closed(x.id))) {
      for (const s of _m15_elements(fn_screenings(pt.id))) {
        if (castBool(_m15_text(s, 'overdue')) !== true) continue;
        fn_notify_patient(pt.id, 'screening_reminder', _m15_cat('Screening due: ', _m15_text(s, 'title')), 'Book it from the Care tab.',
          _m15_cat('screen:', pt.id, ':', _m15_text(s, 'type'), ':', month),
          _m15_cat('حان موعد الفحص: ', _m15_text(s, 'title_ar')), 'يمكنك الحجز من صفحة الرعاية.');
        screenings++;
      }
    }
  }
  // Evening "risky night" notices (23_prediction.js), once a night per person.
  const night = p.h === coalesce(castNum(coalesce(fn_rule('low_prediction'), {}).night_check_hour), 21) ? fn_run_night_risk().night_risk : 0;
  // Weekly digest (27_digest.js): on the configured weekday and hour, once (each digest is de-duplicated per day).
  const dg = _d27_cfg();
  const digests = new Date(Date.UTC(y, mo - 1, d)).getUTCDay() === dg.digest_weekday && p.h === dg.digest_hour ? fn_run_weekly_digest().digests : 0;
  // AI runs that never finished (an n8n restart, a lost execution) are closed, so dashboards and limits stay true.
  const runCutoff = nowMs() - 30 * MIN;
  dbUpdateWhere('ai_runs', (r) => ['QUEUED', 'PROCESSING', 'VERIFYING'].includes(r.status) && t(r.created_at) < runCutoff,
    { status: 'FAILED', error: 'timed out (no result after 30 minutes)', completed_at: now() });
  const dayAgo = t(_m15_daysAgo(1));
  dbDeleteWhere('auth_events', (x) => t(x.at) < dayAgo);
  dbDeleteWhere('password_reset_tokens', (x) => t(x.expires_at) < dayAgo);
  const hourAgo = nowMs() - HOUR;
  dbDeleteWhere('mfa_challenges', (x) => t(x.expires_at) < hourAgo);
  const weekAgo = t(_m15_daysAgo(7));
  dbDeleteWhere('sessions', (x) => t(x.expires_at) < weekAgo);
  // "Did you take it?" follow-ups and refill notices (28_adherence.js).
  const adherence = fn_run_adherence();
  // Sick-day glucose-check reminders and ends (33_wellbeing.js); a failure here never stops the other reminders.
  let sick = {};
  try { sick = fn_run_sick_days(); } catch (e) { sick = { sick_error: String(e && e.message || e).slice(0, 200) }; }
  // Nurse reviews of AI answers not decided in time become high inbox items (36_reviews.js).
  try { Object.assign(sick, fn_run_review_escalations()); } catch (e) { sick.review_error = String(e && e.message || e).slice(0, 200); }
  // Polyclinic booking requests reception has not decided in time go to the clinic admins (40_clinic.js).
  try { Object.assign(sick, fn_run_clinic_escalations()); } catch (e) { sick.clinic_escalation_error = String(e && e.message || e).slice(0, 200); }
  return { medication: due.length, appointments: appts.length, screenings, night_risk: night, digests, ...adherence, ...sick };
}

function fn_run_followups() {
  const nowT = nowMs();
  const due = [];
  for (const f of dbWhere('episode_followups', (x) => x.status === 'pending' && t(x.due_at) <= nowT)) {
    const e = dbGet('episodes', f.episode_id);
    if (!e) continue;
    dbUpdate('episode_followups', f, { status: 'sent' });
    due.push({ id: f.id, patient_id: e.patient_id, chief_complaint: e.chief_complaint });
  }
  for (const x of due) {
    fn_notify_patient(x.patient_id, 'episode_followup', 'How are you feeling now?',
      `Tell us whether "${left(x.chief_complaint, 60)}" is better, the same, or worse.`, `followup:${x.id}`,
      'كيف تشعر الآن؟', `أخبرنا هل أصبحت "${left(x.chief_complaint, 60)}" أفضل أم كما هي أم أسوأ.`);
  }
  const cutoff = t(_m15_daysAgo(5));
  const expired = dbUpdateWhere('episode_followups', (x) => x.status === 'sent' && t(x.due_at) < cutoff, { status: 'expired' });
  const sent = new Set(dbWhere('episode_followups', (x) => x.status === 'sent').map((x) => x.episode_id));
  dbUpdateWhere('episodes', (e) => ['ACTION_SELECTED', 'CARE_RECEIVED'].includes(e.status) && sent.has(e.id),
    { status: 'FOLLOW_UP', updated_at: now() });
  return { sent: due.length, expired };
}

function fn_referral_aging() {
  const day1 = t(_m15_daysAgo(1)), day7 = t(_m15_daysAgo(7)), day21 = t(_m15_daysAgo(21));
  const rows = dbWhere('referrals', (r) =>
    (['CREATED', 'MATCHING', 'SELECTED'].includes(r.status) && t(r.updated_at) < (r.urgency === 'urgent' ? day1 : day7))
    || (r.status === 'BOOKED' && t(r.updated_at) < day21));
  for (const r of rows) {
    const urgent = r.urgency === 'urgent';
    fn_create_inbox_item(r.patient_id, 'referral', urgent ? 'high' : 'medium', urgent ? 2 : 3,
      `Referral not progressing: ${r.to_specialty} (${r.status.toLowerCase()})`,
      `Created ${localDate(r.created_at)}`, { referral_id: r.id },
      `referral-aging:${r.id}:${r.status}`);
  }
  return { flagged: rows.length };
}

/* -------------------------------------------------------------------------- Nightscout connector + demo CGM simulator */

function fn_nightscout_targets() {
  const list = dbWhere('cgm_connections', (c) => ['VALIDATING', 'ACTIVE', 'DEGRADED', 'STALE'].includes(c.status)
      && c.url !== null && !c.url.endsWith('.nightscout.example') && coalesce(fn_nightscout_url_error(c.url)) === null)
    // since: the newest reading already stored (ms), so a sync after an outage fetches everything it missed (at most
    // 24 h back on the first sync).
    .map((c) => ({ patient_id: c.patient_id, url: c.url, token: c.token,
      since: Math.max(coalesce(t(c.last_reading_at), 0), nowMs() - DAY) }));
  return jsonAgg(list) ?? [];
}

function fn_nightscout_ingest(p_patient_id, p_entries) {
  const pid = castUuid(p_patient_id);
  // A Nightscout site answers with a JSON array of entries. Anything else (a web page, an error object) is a failed sync.
  if (p_entries === null || p_entries === undefined || jtype(p_entries) !== 'array') {
    fn_nightscout_error(pid, 'The address did not answer like a Nightscout site.');
    return { inserted: 0, events: 0, error: 'not_nightscout' };
  }
  let n = 0, events = 0, seen = 0;
  const nowT = nowMs();
  const oldest = t(_m15_daysAgo(90));
  for (const e of p_entries) {
    if (jtype(e) !== 'object') continue;
    const sgv = coalesce(_m15_text(e, 'sgv'), '');
    const date = coalesce(_m15_text(e, 'date'), '');
    if (!/^[0-9]{1,4}(\.[0-9]+)?$/.test(sgv) || !/^[0-9]{10,14}(\.[0-9]+)?$/.test(date)) continue;
    const value = Number(sgv);
    if (value < 20 || value > 600) continue;
    const at = Number(date);                                              // to_timestamp(date / 1000.0)
    // Readings stamped in the future (wrong device clock) or older than the history window are ignored.
    if (at > nowT + 10 * MIN || at < oldest) continue;
    seen++;
    const r = fn_add_glucose(pid, value, iso(at), 'nightscout', null, `ns:${date}`);
    if (_m15_present(r, 'reading')) n++;
    if (_m15_present(r, 'event')) events++;
  }
  const c = dbGet('cgm_connections', pid);
  if (c) {
    if (seen === 0) {
      // Nothing usable came back: a new connection stays unconfirmed, an existing one is shown as not up to date.
      dbUpdate('cgm_connections', c, {
        last_sync_at: now(), last_error: 'No glucose readings were found at this address.',
        status: c.status === 'VALIDATING' ? 'VALIDATING' : c.last_reading_at === null ? 'DEGRADED' : 'STALE',
      });
    } else {
      dbUpdate('cgm_connections', c, {
        status: c.last_reading_at === null || t(c.last_reading_at) < nowT - 30 * MIN ? 'STALE' : 'ACTIVE',
        last_sync_at: now(), last_error: null,
      });
    }
  }
  return { inserted: n, events, usable: seen };
}

function fn_nightscout_error(p_patient_id, p_message) {
  const c = dbGet('cgm_connections', castUuid(p_patient_id));
  if (!c) return;
  dbUpdate('cgm_connections', c, {
    status: c.status === 'VALIDATING' ? 'VALIDATING' : 'DEGRADED',
    // An error text can quote the request address: the access token is removed before it is stored.
    last_error: left(p_message === null || p_message === undefined ? null : String(p_message).replace(/([?&](token|secret|api-secret)=)[^&\s]+/gi, '$1[removed]'), 300), last_sync_at: now(),
  });
}

// The migration also seeds feature_flags.demo_cgm_simulator (enabled); that row is part of the Sheets seed data.
function fn_simulate_cgm() {
  const flag = dbGet('feature_flags', 'demo_cgm_simulator');
  if (!coalesce(flag ? flag.enabled : null, false)) return { enabled: false };
  const m = localMinuteOfDay(now());
  const conns = dbWhere('cgm_connections', (c) => c.url !== null && c.url.endsWith('.nightscout.example') && c.status !== 'REVOKED')
    .map((c) => ({ c, p: dbGet('patients', c.patient_id) }))
    .filter((x) => x.p && x.p.user_id !== null);
  // The latest reading of each simulated patient (one pass over the readings).
  const latest = new Map();
  const ids = new Set(conns.map((x) => x.c.patient_id));
  for (const g of dbWhere('glucose_readings', (g) => ids.has(g.patient_id))) {
    const cur = latest.get(g.patient_id);
    if (!cur || t(g.measured_at) > t(cur.measured_at)) latest.set(g.patient_id, g);
  }
  let n = 0, events = 0;
  const slot = Math.floor(nowMs() / 300000);
  for (const { c, p } of conns) {
    const last = latest.has(c.patient_id) ? latest.get(c.patient_id).value_mgdl : null;
    const target = (p.persona === 'recurrent_hypo' ? 104 : p.persona === 'acute_episode' ? 170 : 120)
      + 60 * (Math.exp(-Math.pow((m - 600) / 45.0, 2) / 2) + 1.2 * Math.exp(-Math.pow((m - 990) / 50.0, 2) / 2) + Math.exp(-Math.pow((m - 1320) / 45.0, 2) / 2))
      + (p.persona === 'recurrent_hypo' && m >= 120 && m <= 270 ? -50 : 0);
    const prev = coalesce(last, target);
    const value = round(Math.min(380, Math.max(45, prev + (target - prev) * 0.35 + (Math.random() - 0.5) * 10)));
    const res = fn_add_glucose(c.patient_id, value, now(), 'device', null, `sim:${c.patient_id}:${slot}`);
    if (_m15_present(res, 'reading')) n++;
    if (_m15_present(res, 'event')) events++;
    dbUpdate('cgm_connections', c, { last_sync_at: now(), status: 'ACTIVE' });
  }
  return { enabled: true, inserted: n, events };
}

/* ------------------------------------------- Care Access free-text step (AI answers are checked in fn_intake_store) */

function api_intake_free_text(c, d, p_extracted) {
  const e = dbGet('episodes', castUuid(_m15_text(d, 'episode_id')));
  if (!e || !fn_can_access_patient(c, e.patient_id)) fn_raise('not_found: episode not found');
  const text = _m15_text(d, 'text');
  dbUpdate('episodes', e, {
    extracted: _m15_jsonConcat(coalesce(e.extracted, {}), { [_m15_digits(now())]: { text: left(text, 1000), answers: p_extracted ?? null } }),
  });
  const em = fn_prescreen_for(c, e.patient_id, text);
  if (castBool(_m15_text(em, 'emergency')) === true) {
    dbUpdate('episodes', e, { status: 'ESCALATED', updated_at: now() });
    const matched = _m15_elementsText(_m15_get(em, 'matched'));
    dbInsert('triage_assessments', {
      episode_id: e.id, care_level: 'emergency_services', specialty: 'emergency_medicine', channel: 'emergency',
      rules_fired: ['PRESCREEN_EMERGENCY'], red_flags: matched,
    });
    const signs = matched.filter((x) => x !== null).map((x) => _m15_replace(x, '_', ' '));
    fn_create_inbox_item(e.patient_id, 'episode', 'critical', 1, 'Emergency pre-screen triggered in Care Access',
      `Warning signs: ${signs.length ? signs.join(', ') : 'emergency words'}`, { episode_id: e.id }, `episode-emergency:${e.id}`);
    return fn_intake_result(e.id, em);
  }
  if (coalesce(castBool(_m15_text(em, 'urgent')), false)) {
    fn_create_inbox_item(e.patient_id, 'episode', 'high', 2, 'Urgent foot problem described in Care Access',
      left(text, 500), { episode_id: e.id, matched: _m15_get(em, 'urgent_matched') }, `episode-urgent:${e.id}`);
  }
  return fn_intake_store(c, e.id, _m15_jsonConcat(coalesce(p_extracted, {}), fn_urgent_answers(em)), 'ai');
}

/* ----------------------------------------------------------- AI context loaders for event workflows (de-identified) */

function fn_ctx_pattern(p_pattern_id, p_event_id) {
  const gp = dbGet('glucose_patterns', castUuid(p_pattern_id));
  if (!gp) return null;
  return {
    patient_id: gp.patient_id, pattern_id: gp.id, pattern: gp.detail,
    context: fn_ai_context(gp.patient_id), policy: fn_policy(gp.patient_id, 'glucose_pattern'),
    dose_guard: fn_dose_guard(),
    gate: fn_ai_gate(gp.patient_id, 'glucose_pattern'),
    ai_run_id: fn_ai_run_start('WF-005 Pattern Analysis', gp.patient_id, castUuid(p_event_id), gp.detail, null, 'pattern/v1'),
  };
}

function fn_ctx_finding(p_finding_id, p_event_id) {
  const f = dbGet('safety_findings', castUuid(p_finding_id));
  if (!f) return null;
  const m = f.medication_id === null ? null : dbGet('medications', f.medication_id);
  return {
    patient_id: f.patient_id, finding_id: f.id,
    finding: { kind: f.kind, severity: f.severity, title: f.title, detail: f.detail,
      medication: m ? { name: m.name, generic: m.generic, class: m.drug_class } : null },
    context: _m15_minus(fn_ai_context(f.patient_id), 'glucose_90d', 'patterns', 'lifestyle_7d'),
    policy: fn_policy(f.patient_id, 'medication_safety'), dose_guard: fn_dose_guard(),
    gate: fn_ai_gate(f.patient_id, 'medication_safety'),
    ai_run_id: fn_ai_run_start('WF-007 Medication Safety', f.patient_id, castUuid(p_event_id), { finding_id: f.id }, null, 'safety_explain/v1'),
  };
}

function fn_ctx_lab(p_lab_id, p_event_id) {
  const l = dbGet('lab_results', castUuid(p_lab_id));
  if (!l) return null;
  const previous = orderBy(dbWhere('lab_results', (p) => p.patient_id === l.patient_id && p.test_code === l.test_code && p.id !== l.id
      && p.verification_status === 'verified'), [(p) => t(p.observed_at), 'desc'])
    .map((p) => ({ value: p.value, unit: p.unit, observed_at: p.observed_at }));
  return {
    patient_id: l.patient_id, lab_id: l.id, lab: fn_lab_json(l), critical: fn_lab_critical(l),
    previous: jsonAgg(previous) ?? [],
    care_plan_targets: fn_targets(l.patient_id),
    policy: fn_policy(l.patient_id, 'lab_result'), dose_guard: fn_dose_guard(),
    gate: fn_ai_gate(l.patient_id, 'lab_result'),
    ai_run_id: fn_ai_run_start('WF-008 Lab Explanation', l.patient_id, castUuid(p_event_id), { lab_id: l.id }, null, 'lab_explain/v1'),
  };
}

function fn_ctx_plan_change(p_plan_id, p_event_id) {
  const cp = dbGet('care_plans', castUuid(p_plan_id));
  if (!cp) return null;
  return {
    patient_id: cp.patient_id, plan_id: cp.id,
    // The plans go into a model prompt: without record ids, the patient id or the author's name (fn_plan_for_ai).
    new_plan: fn_plan_for_ai(cp.id), previous_plan: cp.previous_id === null ? null : fn_plan_for_ai(cp.previous_id),
    policy: fn_policy(cp.patient_id, 'plan_change'), dose_guard: fn_dose_guard(),
    gate: fn_ai_gate(cp.patient_id, 'plan_change'),
    ai_run_id: fn_ai_run_start('WF-010 After-Visit Plan', cp.patient_id, castUuid(p_event_id), { plan_id: cp.id }, null, 'plan_change/v1'),
  };
}

function fn_ctx_weekly(p_patient_id) {
  const pid = castUuid(p_patient_id);
  const lo = t(_m15_daysAgo(14)), hi = t(_m15_daysAgo(7));
  const week = dbWhere('glucose_readings', (g) => g.patient_id === pid && t(g.measured_at) >= lo && t(g.measured_at) <= hi);
  const inRange = week.filter((g) => g.value_mgdl >= 70 && g.value_mgdl <= 180).length;
  return {
    patient_id: pid,
    this_week: _m15_minus(fn_glucose_metrics(pid, 7), 'latest'),
    last_week: { mean: round(avg(week.map((g) => g.value_mgdl))), readings: week.length,
      tir: week.length ? round(inRange / week.length * 100, 1) : null },
    adherence_7d: fn_adherence(pid, 7),
    lifestyle: _m15_minus(fn_lifestyle_summary(pid, 7), 'meals', 'checkins'),
    patterns: fn_detect_patterns(pid, 7),
    targets: fn_targets(pid),
    policy: fn_policy(pid, 'weekly_review'), dose_guard: fn_dose_guard(),
    gate: fn_ai_gate(pid, 'weekly_review'),
    ai_run_id: fn_ai_run_start('WF-006 Weekly Review', pid, null, {}, null, 'weekly/v1'),
  };
}

function fn_ctx_brief(c, d) {
  const pid = fn_resolve_patient(c, d);
  const apptId = castUuid(nullif(_m15_text(d, 'appointment_id'), ''));
  if (apptId !== null && !dbExists('appointments', (a) => a.id === apptId && a.patient_id === pid)) {
    fn_raise('not_found: appointment not found');
  }
  const nowT = nowMs();
  const appointment = orderBy(dbWhere('appointments', (a) => (apptId !== null && a.id === apptId && a.patient_id === pid)
    || (apptId === null && a.patient_id === pid && t(a.starts_at) > nowT && ['booked', 'requested'].includes(a.status))), (a) => t(a.starts_at))[0];
  const lastVisit = orderBy(dbWhere('appointments', (a) => a.patient_id === pid && a.status === 'completed'), [(a) => t(a.starts_at), 'desc'])[0];
  const days90 = t(_m15_daysAgo(90)), days30 = t(_m15_daysAgo(30));
  // Only what the patient (or family) chose to share with the care team, in their own words: questions routed from the
  // Companion (they carry the conversation) and messages to the team (they carry the sender). Other "question" items are
  // notices the system wrote (a cancelled appointment's time, a missed dose, a check-in score), not questions.
  // Private Companion chat never reaches the brief.
  const ownWords = (i) => !!(i.payload && typeof i.payload === 'object' && (i.payload.conversation_id || i.payload.from_role));
  const questions = orderBy(dbWhere('inbox_items', (i) => i.patient_id === pid && i.category === 'question' && t(i.created_at) > days90
    && coalesce(i.body, '') !== '' && ownWords(i)), [(i) => t(i.created_at), 'desc']).slice(0, 5).map((i) => i.body);
  const events = orderBy(dbWhere('glucose_events', (g) => g.patient_id === pid && t(g.occurred_at) > days30), [(g) => t(g.occurred_at), 'desc'])
    .slice(0, 15).map((g) => ({ type: g.type, value: g.value_mgdl, at: g.occurred_at }));
  const episodes = dbWhere('episodes', (e) => e.patient_id === pid && t(e.started_at) > days90)
    .map((e) => ({ complaint: e.chief_complaint, status: e.status, started_at: e.started_at }));
  return {
    patient_id: pid,
    context: fn_ai_context(pid),
    appointment: appointment ? { id: appointment.id, starts_at: appointment.starts_at, reason: appointment.reason, type: appointment.type, channel: appointment.channel } : null,
    last_visit: lastVisit ? lastVisit.starts_at : null,
    recent_questions: jsonAgg(questions) ?? [],
    glucose_events_30d: jsonAgg(events) ?? [],
    episodes: jsonAgg(episodes) ?? [],
    dose_guard: fn_dose_guard(),
    // Deterministic rule outputs for the clinician (32_personal.js): the brief lists them as points to consider.
    personal_targets: (() => { const x = fn_personal_targets(pid); return { tier: x.tier, suggested: x.suggested, reasons: x.reasons.map((r) => r.en), differs_from_plan: x.differs_from_plan }; })(),
    therapy_considerations: fn_therapy_considerations(pid).items.map((x) => ({ code: x.code, kind: x.kind, title: x.title_en, ref: x.ref })),
    kidney_risk: fn_kidney_risk(pid),
    wellbeing: fn_wellbeing_status(pid).latest,
    sick_day_active: fn_sick_status(pid).active,
    gate: fn_ai_gate(pid, 'previsit_brief'),
    ai_run_id: fn_ai_run_start('WF-009 Pre-Visit Brief', pid, null, { appointment_id: _m15_text(d, 'appointment_id') }, null, 'brief/v1'),
  };
}

function fn_brief_json(p_id) {
  const b = dbGet('previsit_briefs', castUuid(p_id));
  if (!b) return null;
  return { id: b.id, appointment_id: b.appointment_id, created_at: b.created_at, content: b.content, sources: b.sources, model: b.model };
}

// Pattern scan: AI explanation events only for app users, capped per run to respect free-tier model quotas; patients
// without app accounts get a deterministic clinician inbox item instead.
function fn_scan_patterns(p_patient_id = null, p_max_ai_events = 5) {
  const only = castUuid(p_patient_id);
  const SEVERITY = ['info', 'attention', 'urgent'];
  const rank = (s) => { const i = SEVERITY.indexOf(s); return i < 0 ? null : i + 1; };   // array_position
  let ai = 0, det = 0;
  const patients = orderBy(dbWhere('patients', (p) => only === null || p.id === only), (p) => (p.user_id === null ? 1 : 0), (p) => p.id);
  for (const r of patients) {
    for (const p of _m15_elements(fn_detect_patterns(r.id, 14))) {
      const type = _m15_text(p, 'type'), severity = _m15_text(p, 'severity');
      const since = t(_m15_daysAgo(7));
      // Same pattern type again within 7 days is skipped unless its severity went up (for example attention -> urgent).
      if (dbExists('glucose_patterns', (gp) => gp.patient_id === r.id && type !== null && gp.type === type && t(gp.detected_at) > since
          && rank(gp.severity) !== null && rank(severity) !== null && rank(gp.severity) >= rank(severity))) continue;
      const exclusions = r.user_id === null ? null : fn_exclusions(r.id);
      const explain = r.user_id !== null && Array.isArray(exclusions) && exclusions.length === 0;
      if (explain && p_max_ai_events !== null && p_max_ai_events !== undefined && ai >= p_max_ai_events) {
        continue;  // picked up by the next scan
      }
      const gp = dbInsert('glucose_patterns', { patient_id: r.id, type, severity, detail: p, window_days: 14 });
      if (explain) {
        fn_emit('GlucosePatternDetected', r.id, gp.id, p);
        ai++;
      } else if (severity === 'attention' || severity === 'urgent') {
        fn_create_inbox_item(r.id, 'glucose', severity === 'urgent' ? 'high' : 'medium', severity === 'urgent' ? 2 : 3,
          _m15_cat('Glucose pattern: ', _m15_text(p, 'title')), null, { pattern_id: gp.id }, `pattern:${gp.id}`);
        det++;
      }
    }
  }
  // Refresh the panel's state cache for patients whose cached state is older than 25 minutes.
  const fresh = nowMs() - 25 * MIN;
  for (const p of dbWhere('patients', (x) => only === null || x.id === only)) {
    const cached = dbGet('patient_state_cache', p.id);
    if (cached && t(cached.computed_at) > fresh) continue;
    const state = fn_patient_state(p.id);
    dbInsert('patient_state_cache', { patient_id: p.id, state, computed_at: now() },
      { onConflict: { cols: ['patient_id'], set: { state, computed_at: now() } } });
  }
  return { ai_events: ai, deterministic: det };
}
