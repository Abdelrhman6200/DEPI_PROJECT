/* 29 · Web push and personal-data rights (Egypt Personal Data Protection Law 151/2020, Decree 816/2025).
 *
 * Web push (the push section, workflows/src/push.mjs, encrypts and sends what fn_push_batch returns):
 *   api_push_subscribe / api_push_unsubscribe   a browser's push subscription for the signed-in user. Only the
 *                                               browser push services are accepted as endpoints.
 *   fn_push_batch()                             unread, unpushed notifications of the last max_age_minutes: one push per
 *                                               person per run, within the daily cap and outside quiet hours (urgent
 *                                               kinds always). The push says only what kind of update it is ("medicine
 *                                               reminder", "sugar alert") and opens the app: names, values and medicine
 *                                               names stay in the app, never with Google, Apple or Mozilla.
 *   fn_push_results(results)                    removes subscriptions the push service no longer knows (404/410).
 * Personal-data rights:
 *   api_data_request / api_my_data_requests     the patient asks to correct, erase, object to or restrict processing,
 *                                               or asks a privacy question; the platform admins are notified and the
 *                                               answer is due in privacy.response_days.
 *   api_admin_data_requests / _resolve          the platform admin answers.
 *   api_access_log                              who opened or changed the patient's record (from the audit log).
 *   api_admin_report_breach / _breach_notified  a personal-data breach is an incident of kind privacy_breach; the
 *                                               regulator must be told within 72 hours (reported_at records it).
 * Settings: rules push_policy and privacy.
 */

const _P29_PUSH = { daily_max: 6, quiet_from: 23, quiet_to: 7, urgent_kinds: ['low_predicted', 'ramadan_break_fast', 'glucose_severe_hypo', 'glucose_hypo', 'escalation'], max_age_minutes: 60, batch: 50 };
const _P29_PRIVACY = { response_days: 30, breach_report_hours: 72 };
// Browser push services (an endpoint anywhere else is refused, so the server never posts to an address a user chose).
const _P29_PUSH_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)(:443)?\//i;
const _P29_B64URL = /^[A-Za-z0-9_-]+$/;
// What a push says, by kind: [en title, ar title]. The body is always "open the app".
const _P29_TEXT = [
  [/^medication_reminder$/, 'Medicine reminder', 'تذكير بالدواء'],
  [/^medication_missed$/, 'Did you take your medicine?', 'هل أخذت دواءك؟'],
  [/^refill_due$/, 'Time to refill a medicine', 'حان وقت شراء الدواء'],
  [/^appointment_reminder$/, 'Appointment reminder', 'تذكير بموعد'],
  [/^screening_reminder$/, 'A check-up is due', 'حان موعد فحص دوري'],
  [/^(glucose_|low_predicted|night_low_risk)/, 'Sugar alert: open the app', 'تنبيه السكر: افتح التطبيق'],
  [/^ramadan_/, 'Ramadan: open the app now', 'رمضان: افتح التطبيق الآن'],
  [/^(message|team_message)/, 'New message from your care team', 'رسالة جديدة من فريق الرعاية'],
  [/^weekly_digest$/, 'Your weekly summary is ready', 'ملخصك الأسبوعي جاهز'],
];

function _p29_push_cfg() { return { ..._P29_PUSH, ...(coalesce(fn_rule('push_policy'), {})) }; }
function _p29_privacy_cfg() { return { ..._P29_PRIVACY, ...(coalesce(fn_rule('privacy'), {})) }; }
function _p29_s(v, max) { return v === null || v === undefined ? '' : String(v).trim().slice(0, max); }

/* ------------------------------------------------------------------------------------------------------- Web push */

function api_push_subscribe(c, d) {
  const uid = castUuid(jtext(c && c.user_id));
  if (uid === null) fn_raise('unauthorized: sign in first');
  const endpoint = _p29_s(d && d.endpoint, 1000);
  const keys = d && d.keys && typeof d.keys === 'object' ? d.keys : {};
  const p256dh = _p29_s(keys.p256dh, 200), auth = _p29_s(keys.auth, 100);
  if (!_P29_PUSH_HOSTS.test(endpoint)) fn_raise('bad_request: endpoint must be a browser push service');
  if (!_P29_B64URL.test(p256dh) || p256dh.length !== 87 || !_P29_B64URL.test(auth) || auth.length !== 22) fn_raise('bad_request: keys are not valid');
  const u = dbGet('users', uid);
  const locale = ['ar', 'en'].includes(d && d.locale) ? d.locale : coalesce(u ? u.locale : null, 'ar');
  const row = { user_id: uid, endpoint, p256dh, auth, locale, user_agent: _p29_s(d && d.user_agent, 200) || null, failures: 0 };
  const ex = dbOne('push_subscriptions', (s) => s.endpoint === endpoint);
  if (ex) dbUpdate('push_subscriptions', ex, row); else dbInsert('push_subscriptions', row);
  // At most 5 devices a person: the oldest are dropped.
  const mine = orderBy(dbWhere('push_subscriptions', (s) => s.user_id === uid).map((s, i) => ({ s, i })),
    [(x) => t(x.s.created_at), 'desc'], [(x) => x.i, 'desc']).map((x) => x.s);
  for (const s of mine.slice(5)) dbDeleteWhere('push_subscriptions', (x) => x.id === s.id);
  fn_audit(c, 'push.subscribe', 'push_subscription', null, castUuid(jtext(c.patient_id)));
  return { ok: true, devices: Math.min(mine.length, 5) };
}

function api_push_unsubscribe(c, d) {
  const uid = castUuid(jtext(c && c.user_id));
  const endpoint = _p29_s(d && d.endpoint, 1000);
  const n = dbDeleteWhere('push_subscriptions', (s) => s.user_id === uid && (endpoint === '' || s.endpoint === endpoint));
  return { ok: true, removed: n };
}

function _p29_quiet(cfg, hour) {
  const from = coalesce(castInt(cfg.quiet_from), 23), to = coalesce(castInt(cfg.quiet_to), 7);
  return from > to ? hour >= from || hour < to : hour >= from && hour < to;
}

function _p29_text(kind, locale) {
  const hit = _P29_TEXT.find(([re]) => re.test(kind || ''));
  const [en, ar] = hit ? [hit[1], hit[2]] : ['New update', 'تحديث جديد'];
  return locale === 'en' ? { title: en, body: 'Open the app to see the details.' } : { title: ar, body: 'افتح التطبيق لمعرفة التفاصيل.' };
}

function fn_push_batch() {
  const cfg = _p29_push_cfg();
  const nowT = nowMs();
  const since = nowT - coalesce(castInt(cfg.max_age_minutes), 60) * MIN;
  const urgent = new Set(Array.isArray(cfg.urgent_kinds) ? cfg.urgent_kinds : []);
  const quiet = _p29_quiet(cfg, cairoParts(now()).h);
  const dayStartT = t(dayStart(today()));
  const max = coalesce(castInt(cfg.daily_max), 6);
  const subs = new Map();
  for (const s of dbRows('push_subscriptions')) { if (!subs.has(s.user_id)) subs.set(s.user_id, []); subs.get(s.user_id).push(s); }
  if (!subs.size) return [];
  const byUser = new Map();
  for (const x of dbWhere('notifications', (x) => x.pushed_at === null && x.read_at === null && t(x.created_at) > since && subs.has(x.user_id))) {
    if (!byUser.has(x.user_id)) byUser.set(x.user_id, []);
    byUser.get(x.user_id).push(x);
  }
  const out = [];
  for (const [uid, list] of byUser) {
    if (out.length >= coalesce(castInt(cfg.batch), 50)) break;
    // The person's own sleep and wake times (32_personal.js preferences) replace the platform's quiet hours.
    const own = fn_personal_quiet(uid);
    const isQuiet = own ? _p29_quiet({ quiet_from: own.from, quiet_to: own.to }, cairoParts(now()).h) : quiet;
    const eligible = isQuiet ? list.filter((x) => urgent.has(x.kind)) : list;
    if (!eligible.length) continue;
    const isUrgent = eligible.some((x) => urgent.has(x.kind));
    const sentToday = dbCount('notifications', (x) => x.user_id === uid && x.pushed_at !== null && t(x.pushed_at) >= dayStartT);
    if (sentToday >= max && !isUrgent) continue;
    const top = orderBy(eligible, [(x) => (urgent.has(x.kind) ? 1 : 0), 'desc'], [(x) => t(x.created_at), 'desc'])[0];
    const u = dbGet('users', uid);
    const staff = u && !['patient', 'caregiver'].includes(u.role);
    for (const x of eligible) dbUpdate('notifications', x, { pushed_at: now() });
    for (const s of subs.get(uid)) {
      const txt = _p29_text(top.kind, s.locale);
      if (eligible.length > 1) txt.body = s.locale === 'en' ? `${eligible.length} new updates. Open the app to see them.` : `${eligible.length} تحديثات جديدة. افتح التطبيق لمعرفتها.`;
      out.push({ subscription_id: s.id, endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth, urgency: isUrgent ? 'high' : 'normal',
        ttl: isUrgent ? 900 : 3600,
        payload: JSON.stringify({ ...txt, url: staff ? '/provider' : '/app/today', tag: isUrgent ? 'urgent' : 'update', kind: top.kind }) });
    }
  }
  return out;
}

/** results: [{ subscription_id, status }] from the push services. */
function fn_push_results(p_results) {
  let ok = 0, removed = 0, failed = 0;
  for (const r of Array.isArray(p_results) ? p_results : []) {
    const s = dbOne('push_subscriptions', (x) => x.id === castUuid(jtext(r && r.subscription_id)));
    if (!s) continue;
    const st = castInt(jtext(r.status));
    const error = r.error === null || r.error === undefined || r.error === '' ? null : String(r.error).slice(0, 300);
    if (st !== null && st >= 200 && st < 300) { dbUpdate('push_subscriptions', s, { last_ok_at: now(), failures: 0, last_status: st, last_error: null }); ok++; }
    else if (st === 404 || st === 410 || coalesce(castInt(s.failures), 0) >= 4) { dbDeleteWhere('push_subscriptions', (x) => x.id === s.id); removed++; }
    else { dbUpdate('push_subscriptions', s, { failures: coalesce(castInt(s.failures), 0) + 1, last_status: st, last_error: error }); failed++; }
  }
  return { ok, removed, failed };
}

/* -------------------------------------------------------------------------------------------- Personal-data rights */

const _P29_REQUEST_TYPES = ['correction', 'erasure', 'objection', 'restriction', 'question'];

function _p29_request_json(r) {
  return { id: r.id, type: r.type, details: r.details, status: r.status, created_at: r.created_at, due_at: r.due_at,
    resolved_at: r.resolved_at, resolution: r.resolution };
}

function api_data_request(c, d) {
  fn_require_role(c, ['patient']);
  const pid = fn_resolve_patient(c, d);
  const type = _p29_s(d && d.type, 20);
  if (!_P29_REQUEST_TYPES.includes(type)) fn_raise(`bad_request: type must be one of ${_P29_REQUEST_TYPES.join(', ')}`);
  const details = _p29_s(d && d.details, 2000);
  if (type !== 'erasure' && details.length < 5) fn_raise('bad_request: please describe your request');
  if (dbCount('data_requests', (r) => r.patient_id === pid && ['open', 'in_progress'].includes(r.status)) >= 5) {
    fn_raise('bad_request: you already have 5 open requests; please wait for an answer');
  }
  const cfg = _p29_privacy_cfg();
  const row = dbInsert('data_requests', { patient_id: pid, user_id: castUuid(jtext(c.user_id)), type, details: details || null,
    due_at: iso(nowMs() + coalesce(castInt(cfg.response_days), 30) * DAY) });
  for (const u of dbWhere('users', (x) => x.role === 'platform_admin' && x.active === true)) {
    dbInsert('notifications', { user_id: u.id, kind: 'data_request', title: `Personal-data request: ${type}`,
      body: 'A patient made a personal-data request. Answer it from Administration, Privacy.',
      title_ar: `طلب بيانات شخصية: ${type}`, body_ar: 'قدّم مريض طلبًا بخصوص بياناته الشخصية. رد عليه من الإدارة، الخصوصية.',
      dedupe_key: `data-request:${row.id}:${u.id}` }, { onConflict: 'nothing' });
  }
  fn_audit(c, 'privacy.request', 'data_request', row.id, pid, { type });
  return _p29_request_json(row);
}

function api_my_data_requests(c, d) {
  fn_require_role(c, ['patient']);
  const pid = fn_resolve_patient(c, d);
  return orderBy(dbWhere('data_requests', (r) => r.patient_id === pid), [(r) => t(r.created_at), 'desc']).map(_p29_request_json);
}

function api_admin_data_requests(c, d) {
  fn_require_role(c, ['platform_admin']);
  const status = _p29_s(d && d.status, 20);
  const nowT = nowMs();
  return orderBy(dbWhere('data_requests', (r) => !status || r.status === status), [(r) => t(r.created_at), 'desc']).slice(0, 200).map((r) => {
    const p = dbGet('patients', r.patient_id);
    return { ..._p29_request_json(r), patient_id: r.patient_id, patient_name: p ? p.full_name : null, mrn: p ? p.mrn : null,
      overdue: ['open', 'in_progress'].includes(r.status) && t(r.due_at) < nowT };
  });
}

function api_admin_data_request_resolve(c, d) {
  fn_require_role(c, ['platform_admin']);
  const id = castUuid(jtext(d && d.id));
  const r = id === null ? null : dbGet('data_requests', id);
  if (!r) fn_raise('not_found: request not found');
  const status = _p29_s(d.status, 20);
  if (!['in_progress', 'completed', 'rejected'].includes(status)) fn_raise('bad_request: status must be in_progress, completed or rejected');
  const note = _p29_s(d.resolution, 2000);
  if (status !== 'in_progress' && note.length < 5) fn_raise('bad_request: write the answer the patient will see');
  const done = status !== 'in_progress';
  dbUpdate('data_requests', r, { status, resolution: note || r.resolution, resolved_at: done ? now() : null, resolved_by: done ? castUuid(jtext(c.user_id)) : null });
  if (done) {
    fn_notify_patient(r.patient_id, 'data_request', 'Your personal-data request was answered', 'Open Settings, Privacy to read the answer.',
      `data-request-done:${r.id}`, 'تم الرد على طلبك بخصوص بياناتك', 'افتح الإعدادات، الخصوصية لقراءة الرد.');
  }
  fn_audit(c, 'privacy.request_' + status, 'data_request', r.id, r.patient_id);
  return _p29_request_json(r);
}

/** Who opened or changed the record: the audit log of this patient, newest first (staff are shown by role and clinic). */
function api_access_log(c, d) {
  fn_require_role(c, ['patient']);
  const pid = fn_resolve_patient(c, d);
  const me = castUuid(jtext(c.user_id));
  const limit = Math.max(1, Math.min(coalesce(castInt(jtext(d && d.limit)), 100), 300));
  return orderBy(dbWhere('audit_logs', (l) => l.patient_id === pid), [(l) => t(l.at), 'desc']).slice(0, limit).map((l) => {
    const m = l.actor_id && l.actor_id !== me ? dbOne('memberships', (x) => x.user_id === l.actor_id) : null;
    const org = m ? dbGet('organizations', m.organization_id) : null;
    const actor = l.actor_id === me ? 'you' : l.actor_id === null ? 'system' : coalesce(l.actor_role, 'staff');
    return { at: l.at, action: l.action, entity: l.entity, actor, organization: org ? org.name : null, organization_ar: org ? org.name_ar : null };
  });
}

/* ---------------------------------------------------------------------------------------- Personal-data breaches */

function api_admin_report_breach(c, d) {
  fn_require_role(c, ['platform_admin', 'safety_officer']);
  const msg = _p29_s(d && d.message, 2000);
  if (msg.length < 10) fn_raise('bad_request: describe what happened, what data and how many people');
  const severity = ['low', 'medium', 'high'].includes(d && d.severity) ? d.severity : 'high';
  const row = dbInsert('incidents', { workflow: 'privacy', node: 'breach report', message: msg, kind: 'privacy_breach', severity, status: 'open' });
  for (const u of dbWhere('users', (x) => ['platform_admin', 'safety_officer'].includes(x.role) && x.active === true)) {
    dbInsert('notifications', { user_id: u.id, kind: 'privacy_breach', title: 'Personal-data breach reported',
      body: `Tell the Personal Data Protection Centre within ${_p29_privacy_cfg().breach_report_hours} hours.`,
      title_ar: 'تم الإبلاغ عن اختراق بيانات شخصية', body_ar: 'يجب إخطار مركز حماية البيانات الشخصية خلال 72 ساعة.',
      dedupe_key: `breach:${row.id}:${u.id}` }, { onConflict: 'nothing' });
  }
  fn_audit(c, 'privacy.breach_report', 'incident', String(row.id), null, { severity });
  return _p29_breach_json(row);
}

function _p29_breach_json(x) {
  const due = t(x.at) + coalesce(castInt(_p29_privacy_cfg().breach_report_hours), 72) * HOUR;
  return { id: x.id, at: x.at, message: x.message, severity: x.severity, status: x.status, reported_at: x.reported_at,
    report_due_at: iso(due), report_overdue: x.reported_at === null && due < nowMs() };
}

function api_admin_breaches(c, d) {
  fn_require_role(c, ['platform_admin', 'safety_officer']);
  return orderBy(dbWhere('incidents', (x) => x.kind === 'privacy_breach'), [(x) => t(x.at), 'desc']).map(_p29_breach_json);
}

/** The regulator (and, when needed, the people affected) were told: records the time. */
function api_admin_breach_notified(c, d) {
  fn_require_role(c, ['platform_admin', 'safety_officer']);
  const id = castInt(jtext(d && d.id));
  const x = id === null ? null : dbOne('incidents', (r) => r.id === id && r.kind === 'privacy_breach');
  if (!x) fn_raise('not_found: breach not found');
  dbUpdate('incidents', x, { reported_at: coalesce(x.reported_at, now()) });
  fn_audit(c, 'privacy.breach_notified', 'incident', String(x.id), null);
  return _p29_breach_json(x);
}
