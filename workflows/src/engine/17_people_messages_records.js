// 017 Caregiver invitations, care-team conversation, record corrections and account self-service
// (port of database/migrations/017_fn_people_messages_records.sql).
//
// Notes on the port:
// - fn_invite_code takes its 8 random bytes from the runtime's randomHex (gen_random_bytes in SQL); the two digits of
//   the temporary password in api_reset_password come from the same source (random() in SQL).
// - set_config('app.actor_role', role, true), which 012 fn_medication_safety reads with current_setting(), becomes
//   DB.settings['app.actor_role'] for the rest of the request (undone on rollback): _m17_setActorRole.
// - `now() - interval '7 days'` keeps the Cairo wall-clock time across a daylight-saving change, as Postgres does.
// - d->'scopes': a missing key is SQL NULL (fn_clean_scopes gives {read}); a JSON null gives {read,log} (_m17_scopesOf).
// - The team-message dedupe key hashes now() written as Postgres writes it (Cairo time, '+03').
// - api_team_messages refuses a context without role (SQL: `NULL not in (...)` let it through; fn_resolve_patient has
//   already refused such a context).

const _M17_INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const _M17_FAMILY = ['patient', 'caregiver'];

/* ------------------------------------------------------------------------------------------- private helpers */

function _m17_isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
/** jsonb ? 'key' on an object (the key exists, even with a JSON null value). */
function _m17_has(v, key) { return _m17_isObj(v) && Object.prototype.hasOwnProperty.call(v, key) && v[key] !== undefined; }
/** v -> 'key' (null for a missing key or a value that is not an object) */
function _m17_get(v, key) { return _m17_has(v, key) ? v[key] : null; }
/** v ->> 'key' */
function _m17_text(v, key) { return jtext(_m17_get(v, key)); }
/** trim() of Postgres: spaces only. */
function _m17_trim(s) { return s === null || s === undefined ? null : trimChars(String(s), ' '); }
/** a || b || ...: NULL when any part is NULL. */
function _m17_cat(...parts) { return parts.some((p) => p === null || p === undefined) ? null : parts.map(String).join(''); }
/** x NOT IN (list) with SQL NULL semantics. */
function _m17_notIn(x, list) { return x === null || x === undefined ? null : !list.includes(x); }
/** length(text) in characters. */
function _m17_len(s) { return s === null || s === undefined ? null : Array.from(String(s)).length; }
/** (text)::bigint */
function _m17_castBigint(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (!/^\s*[+-]?\d+\s*$/.test(s)) throw new Error(`invalid input syntax for type bigint: "${s.slice(0, 60)}"`);
  return Number(s.trim());
}
/** A random integer 0 <= x < n. */
function _m17_randomInt(n) { return parseInt(randomHex(4), 16) % n; }
/** now() - interval 'n days': the same Cairo wall-clock time n calendar days earlier. */
function _m17_daysAgo(n) {
  const p = cairoParts(now());
  const d = addDays(`${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`, -n);
  return iso(cairoLocalToMs(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8, 10), p.h, p.mi, p.s, p.ms));
}
/** timestamptz::text in the Cairo session time zone, e.g. '2026-10-10 13:00:00.12+03'. */
function _m17_pgTsText(ts) {
  const ms = t(ts);
  const p = cairoParts(ms);
  const two = (x) => String(x).padStart(2, '0');
  const off = Math.round(offsetMs(ms) / MIN);
  const frac = p.ms ? '.' + String(p.ms).padStart(3, '0').replace(/0+$/, '') : '';
  const sign = off < 0 ? '-' : '+';
  const oh = Math.floor(Math.abs(off) / 60), om = Math.abs(off) % 60;
  return `${p.y}-${two(p.mo)}-${two(p.d)} ${two(p.h)}:${two(p.mi)}:${two(p.s)}${frac}${sign}${two(oh)}${om ? ':' + two(om) : ''}`;
}
/** set_config('app.actor_role', role, true): kept until the end of the request; a rollback restores the earlier value. */
function _m17_setActorRole(role) {
  const before = DB.settings ? DB.settings['app.actor_role'] : undefined;
  DB.settings = { ...(DB.settings || {}), 'app.actor_role': role };
  DB.undo.push(() => { DB.settings = { ...(DB.settings || {}), 'app.actor_role': before }; });
}
/**
 * fn_clean_scopes(d->'scopes'). A key that is present with a JSON null is not SQL NULL: fn_clean_scopes('null'::jsonb)
 * gives {read,log} (not an array), while a missing key gives {read}.
 */
function _m17_scopesOf(d) {
  return _m17_has(d, 'scopes') && d.scopes === null ? ['read', 'log'] : fn_clean_scopes(_m17_get(d, 'scopes'));
}

/* ------------------------------------------------------------------------------------------------ Caregivers */

// Eight characters without look-alikes (no 0/O, 1/I/L), easy to read out over the phone.
function fn_invite_code() {
  const hex = randomHex(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += _M17_INVITE_ALPHABET[parseInt(hex.slice(2 * i, 2 * i + 2), 16) % 31];
  return out;
}

function fn_caregivers_json(p_pid) {
  const pid = castUuid(p_pid);
  const flag = dbGet('feature_flags', 'email_delivery');
  const caregivers = [];
  for (const g of orderBy(dbWhere('caregiver_grants', (x) => pid !== null && x.patient_id === pid && x.active === true), (x) => t(x.granted_at))) {
    const u = dbGet('users', g.caregiver_user_id);
    if (!u || u.active !== true) continue;
    caregivers.push({ user_id: u.id, full_name: u.full_name, full_name_ar: u.full_name_ar, email: u.email, relationship: g.relationship,
      granted_at: g.granted_at, scopes: g.scopes === null ? null : [...g.scopes] });
  }
  const invites = orderBy(dbWhere('caregiver_invites', (i) => pid !== null && i.patient_id === pid && i.revoked === false && i.used_at === null
      && t(i.expires_at) > nowMs()), [(i) => t(i.created_at), 'desc'])
    .map((i) => ({ code: i.code, relationship: i.relationship, expires_at: i.expires_at, created_at: i.created_at,
      scopes: i.scopes === null ? null : [...i.scopes] }));
  return {
    email_enabled: coalesce(flag ? flag.enabled : null, false),
    caregivers: jsonAgg(caregivers) ?? [],
    invites: jsonAgg(invites) ?? [],
  };
}

// What a family member may do: read is always included; log adds daily logging, appointments, messages, Care Access
// and the Companion; manage adds changing the record. Unknown values are ignored; the default is read + log.
// SQL NULL (null/undefined here) gives {read}: jsonb_typeof(NULL) <> 'array' is NULL, so the ELSE branch runs.
function fn_clean_scopes(p) {
  if (p === null || p === undefined) return ['read'];
  if (!Array.isArray(p)) return ['read', 'log'];
  const has = (s) => p.some((x) => typeof x === 'string' && x === s);
  return ['read', ...['log', 'manage'].filter((s) => has(s) || (s === 'log' && has('manage')))];
}

// Only the patient decides who may follow their record.
function api_caregivers(c, d) {
  fn_require_role(c, ['patient']);
  return fn_caregivers_json(castUuid(_m17_text(c, 'patient_id')));
}

function api_invite_caregiver(c, d) {
  const pid = castUuid(_m17_text(c, 'patient_id'));
  fn_require_role(c, ['patient']);
  if (dbCount('caregiver_invites', (i) => pid !== null && i.patient_id === pid && i.revoked === false && i.used_at === null
      && t(i.expires_at) > nowMs()) >= 5) {
    fn_raise('bad_request: You already have 5 open invitations. Cancel one before creating another.');
  }
  if (dbCount('caregiver_grants', (g) => pid !== null && g.patient_id === pid && g.active === true) >= 5) {
    fn_raise('bad_request: Up to 5 family members can follow your record.');
  }
  let code;
  do { code = fn_invite_code(); } while (dbExists('caregiver_invites', (i) => i.code === code));
  dbInsert('caregiver_invites', {
    code, patient_id: pid, created_by: castUuid(_m17_text(c, 'user_id')),
    relationship: nullif(left(_m17_trim(coalesce(_m17_text(d, 'relationship'), '')), 60), ''),
    scopes: _m17_scopesOf(d),
  });
  fn_audit(c, 'caregiver.invite', 'caregiver_invite', left(code, 2) + '******', pid);
  return { ...fn_caregivers_json(pid), code };
}

function api_revoke_caregiver(c, d) {
  const pid = castUuid(_m17_text(c, 'patient_id'));
  const uid = castUuid(nullif(_m17_text(d, 'caregiver_user_id'), ''));
  fn_require_role(c, ['patient']);
  if (uid !== null) {
    const n = dbUpdateWhere('caregiver_grants', (g) => pid !== null && g.patient_id === pid && g.caregiver_user_id === uid && g.active === true,
      { active: false, revoked_at: now() });
    if (n === 0) fn_raise('not_found: caregiver not found');
    // Their copies of notifications about this record go with the access.
    dbDeleteWhere('notifications', (x) => x.user_id === uid && pid !== null && x.patient_id === pid);
    dbInsert('notifications', {
      user_id: uid, patient_id: null, kind: 'caregiver_removed', title: 'Access to a record ended',
      body: 'The person you were helping has ended your access to their record.',
      title_ar: 'انتهى وصولك إلى ملف', body_ar: 'أنهى الشخص الذي كنت تساعده وصولك إلى ملفه.',
    });
    fn_audit(c, 'caregiver.revoke', 'user', uid, pid);
  } else {
    const code = _m17_trim(coalesce(_m17_text(d, 'code'), '')).toUpperCase();
    const n = dbUpdateWhere('caregiver_invites', (i) => pid !== null && i.patient_id === pid && i.code === code && i.used_at === null, { revoked: true });
    if (n === 0) fn_raise('not_found: invitation not found');
    fn_audit(c, 'caregiver.invite_cancel', 'caregiver_invite', null, pid);
  }
  return fn_caregivers_json(pid);
}

// The patient changes what a family member may do.
function api_set_caregiver_scopes(c, d) {
  const pid = castUuid(_m17_text(c, 'patient_id'));
  const uid = castUuid(nullif(_m17_text(d, 'caregiver_user_id'), ''));
  const scopes = _m17_scopesOf(d);
  fn_require_role(c, ['patient']);
  const n = dbUpdateWhere('caregiver_grants', (g) => pid !== null && uid !== null && g.patient_id === pid && g.caregiver_user_id === uid
    && g.active === true, { scopes });
  if (n === 0) fn_raise('not_found: caregiver not found');
  fn_audit(c, 'caregiver.scopes', 'user', uid, pid, { scopes: [...scopes] });
  return fn_caregivers_json(pid);
}

// Turns a valid code into access for a caregiver account. Returns the patient id, or raises.
function fn_use_invite(p_code, p_caregiver, p_relationship = null) {
  const caregiver = castUuid(p_caregiver);
  const code = regexpReplace(coalesce(p_code, ''), '[\\s-]', '', 'g').toUpperCase();
  const i = dbGet('caregiver_invites', code);
  if (!i || i.revoked === true || i.used_at !== null || t(i.expires_at) < nowMs()) {
    fn_raise('bad_request: This invitation code is not valid or has expired. Ask for a new one.');
  }
  if (dbExists('patients', (p) => p.id === i.patient_id && caregiver !== null && p.user_id === caregiver)) {
    fn_raise('bad_request: You cannot use your own invitation code.');
  }
  dbInsert('caregiver_grants', {
    patient_id: i.patient_id, caregiver_user_id: caregiver, relationship: coalesce(i.relationship, p_relationship),
    active: true, granted_at: now(), revoked_at: null, scopes: i.scopes,
  }, {
    onConflict: {
      cols: ['patient_id', 'caregiver_user_id'],
      set: (old, row) => ({ active: true, revoked_at: null, granted_at: now(), scopes: row.scopes, relationship: coalesce(row.relationship, old.relationship) }),
    },
  });
  dbUpdate('caregiver_invites', i, { used_by: caregiver, used_at: now() });
  const u = caregiver === null ? null : dbGet('users', caregiver);
  fn_notify_patient(i.patient_id, 'caregiver_joined', 'A family member can now follow your record',
    _m17_cat(u ? u.full_name : null, ' used your invitation. You can remove them at any time from My care.'),
    'caregiver-joined:' + i.code, 'أصبح بإمكان أحد أفراد عائلتك متابعة ملفك',
    _m17_cat(u ? coalesce(u.full_name_ar, u.full_name) : null, ' استخدم دعوتك. يمكنك إزالته في أي وقت من صفحة رعايتي.'));
  dbInsert('audit_logs', { actor_id: caregiver, actor_role: 'caregiver', action: 'caregiver.join', entity: 'user', entity_id: caregiver, patient_id: i.patient_id });
  return i.patient_id;
}

// A signed-in caregiver adds another person with a new code.
function api_redeem_invite(c, d) {
  const key = _m17_cat('invite:', _m17_text(c, 'user_id'));
  fn_require_role(c, ['caregiver']);
  if (fn_throttled(key, 10, 15 * MIN)) {
    return fn_err('too_many_requests', 'Too many attempts. Please wait 15 minutes and try again.');
  }
  dbInsert('auth_events', { key });
  fn_use_invite(_m17_text(d, 'code'), castUuid(_m17_text(c, 'user_id')), nullif(_m17_text(d, 'relationship'), ''));
  return fn_session_json(castUuid(_m17_text(c, 'user_id')));
}

/* ---------------------------------------------------------------------------------- Care-team conversation */

function fn_team_messages_json(p_pid) {
  const pid = castUuid(p_pid);
  const latest = orderBy(dbWhere('team_messages', (m) => pid !== null && m.patient_id === pid), [(m) => t(m.created_at), 'desc']).slice(0, 100);
  return jsonAgg(orderBy(latest, (m) => t(m.created_at)).map((m) => {
    const u = m.author_id === null ? null : dbGet('users', m.author_id);
    return {
      id: m.id, body: m.body, author_role: m.author_role, author_name: u ? u.full_name : null, author_name_ar: u ? u.full_name_ar : null,
      from_team: _m17_notIn(m.author_role, _M17_FAMILY), emergency: m.emergency, created_at: m.created_at, read_by_patient_at: m.read_by_patient_at,
    };
  })) ?? [];
}

function api_team_messages(c, d) {
  const pid = fn_resolve_patient(c, d);
  const role = _m17_text(c, 'role');
  if (!['patient', 'caregiver', 'doctor', 'nurse', 'clinic_admin'].includes(role)) fn_raise('forbidden: cannot read messages');
  // Opening the conversation marks the other side's messages as read.
  if (_M17_FAMILY.includes(role)) {
    dbUpdateWhere('team_messages', (m) => m.patient_id === pid && m.read_by_patient_at === null && _m17_notIn(m.author_role, _M17_FAMILY) === true,
      { read_by_patient_at: now() });
  } else {
    dbUpdateWhere('team_messages', (m) => m.patient_id === pid && m.read_by_team_at === null && _M17_FAMILY.includes(m.author_role),
      { read_by_team_at: now() });
  }
  return { patient_id: pid, linked: fn_tier(pid) === 'linked', messages: fn_team_messages_json(pid) };
}

function api_reply_message(c, d) {
  const pid = fn_resolve_patient(c, d);
  const body = left(_m17_trim(coalesce(_m17_text(d, 'text'), '')), 2000);
  let item = castUuid(nullif(_m17_text(d, 'inbox_item_id'), ''));
  fn_require_role(c, ['doctor', 'nurse']);
  if (_m17_len(body) < 2) fn_raise('bad_request: Please write your message.');
  if (item !== null && !dbExists('inbox_items', (x) => x.id === item && x.patient_id === pid)) item = null;
  const uid = castUuid(_m17_text(c, 'user_id'));
  dbInsert('team_messages', { patient_id: pid, author_id: uid, author_role: _m17_text(c, 'role'), body, inbox_item_id: item });
  // A reply answers the patient's open questions.
  dbUpdateWhere('inbox_items', (x) => x.patient_id === pid && x.category === 'question' && ['OPEN', 'ROUTED', 'ACKNOWLEDGED'].includes(x.status)
    && (item === null || x.id === item), { status: 'ACTIONED', assignee_id: uid, updated_at: now() });
  fn_notify_patient(pid, 'team_message', 'New message from your care team', left(body, 160),
    'team-message:' + md5(body + _m17_pgTsText(now())), 'رسالة جديدة من فريق الرعاية', left(body, 160));
  fn_audit(c, 'message.reply', 'patient', pid, pid);
  return { patient_id: pid, linked: true, messages: fn_team_messages_json(pid) };
}

/* ---------------------------------------------------------------------------------------- Record corrections */

function api_update_medication(c, d) {
  const pid = fn_resolve_patient(c, d);
  const role = _m17_text(c, 'role');
  const clin = role === 'doctor' || role === 'nurse';
  const mid = castUuid(_m17_text(d, 'medication_id'));
  let m = dbOne('medications', (x) => mid !== null && x.id === mid && x.patient_id === pid && x.status === 'active');
  if (!m) fn_raise('not_found: medication not found');
  const times = [];
  if (_m17_has(d, 'times')) {
    for (const el of Array.isArray(d.times) ? d.times : []) {
      const tx = jtext(el);
      if (tx === null) continue;   // a JSON null element: NULL !~ pattern is NULL, so SQL neither raises nor adds it
      if (!reTest(tx, '^([01][0-9]|2[0-3]):[0-5][0-9]$')) fn_raise('bad_request: Times must be written like 08:30 (24-hour clock).');
      if (!times.includes(tx)) times.push(tx);
    }
  }
  const before = { dose_text: m.dose_text, frequency: m.frequency, times: m.times === null ? null : [...m.times] };
  const doseIn = _m17_text(d, 'dose_text');
  const patch = { updated_at: now() };
  if (_m17_has(d, 'dose_text')) patch.dose_text = nullif(left(_m17_trim(coalesce(doseIn, '')), 80), '');
  if (_m17_has(d, 'frequency')) patch.frequency = nullif(left(_m17_trim(coalesce(_m17_text(d, 'frequency'), '')), 80), '');
  // array_agg over no times is NULL; medications.times is NOT NULL, so clearing every time fails as it does in SQL.
  if (_m17_has(d, 'times')) patch.times = times.length ? [...times].sort() : null;
  // A patient's change to the dose of a confirmed medicine goes back to the clinician for confirmation.
  if (!clin && doseIn !== m.dose_text && _m17_has(d, 'dose_text')) patch.verification_status = 'unverified';
  m = dbUpdate('medications', m, patch);
  if (m.times === null) m = dbUpdate('medications', m, { times: [] });
  m = { ...m };   // the row as the UPDATE returned it (later checks may change the stored row)
  if (m.verification_status === 'unverified' && !clin) fn_queue_verification(pid, 'medication', m.id, m.name);
  fn_recheck_patient_safety(pid);
  fn_audit(c, 'medication.update', 'medication', m.id, pid,
    { before, after: { dose_text: m.dose_text, frequency: m.frequency, times: m.times === null ? null : [...m.times] } });
  return fn_medication_json(m);
}

function api_resolve_condition(c, d) {
  const pid = fn_resolve_patient(c, d);
  const active = coalesce(castBool(_m17_text(d, 'active')), false);
  const cid = castUuid(_m17_text(d, 'condition_id'));
  const row = dbOne('conditions', (x) => cid !== null && x.id === cid && x.patient_id === pid);
  if (!row) fn_raise('not_found: condition not found');
  const r = { ...dbUpdate('conditions', row, { status: active ? 'active' : 'resolved', resolved_at: active ? null : today() }) };
  _m17_setActorRole(coalesce(_m17_text(c, 'role'), ''));
  fn_recheck_patient_safety(pid);
  if (r.status === 'resolved') fn_note_family_change(c, pid, 'condition', r.id, r.display, r.verification_status === 'verified');
  fn_audit(c, 'condition.' + r.status, 'condition', r.id, pid);
  return omit(r, 'patient_id', 'verified_by', 'verified_at');
}

function api_remove_allergy(c, d) {
  const pid = fn_resolve_patient(c, d);
  const aid = castUuid(_m17_text(d, 'allergy_id'));
  const row = dbOne('allergies', (x) => aid !== null && x.id === aid && x.patient_id === pid && x.status === 'active');
  if (!row) fn_raise('not_found: allergy not found');
  const r = { ...dbUpdate('allergies', row, { status: 'inactive' }) };
  _m17_setActorRole(coalesce(_m17_text(c, 'role'), ''));
  fn_recheck_patient_safety(pid);
  fn_note_family_change(c, pid, 'allergy', r.id, r.substance, r.verification_status === 'verified');
  dbUpdateWhere('inbox_items', (x) => x.dedupe_key === 'verify:allergy:' + r.id, { status: 'RESOLVED', updated_at: now() });
  fn_audit(c, 'allergy.remove', 'allergy', r.id, pid, { substance: r.substance });
  return omit(r, 'patient_id', 'verified_by', 'verified_at');
}

// A reading typed by mistake can be removed by the person who entered it (patient side: their own manual readings of
// the last 7 days; clinicians: any manual reading). Alerts raised by that reading are closed as well.
function api_delete_glucose(c, d) {
  const pid = fn_resolve_patient(c, d);
  const rid = _m17_castBigint(_m17_text(d, 'reading_id'));
  const found = rid === null ? null : dbGet('glucose_readings', rid);
  const g = found && found.patient_id === pid ? found : null;
  if (!g) fn_raise('not_found: reading not found');
  const role = _m17_text(c, 'role');
  if (_M17_FAMILY.includes(role) && (g.source !== 'patient' || t(g.created_at) < t(_m17_daysAgo(7)))) {
    fn_raise('bad_request: Only readings you typed in during the last 7 days can be removed.');
  }
  if ((role === 'doctor' || role === 'nurse') && !['patient', 'clinician'].includes(g.source)) {
    fn_raise('bad_request: Sensor readings cannot be removed.');
  }
  for (const e of dbWhere('glucose_events', (x) => x.reading_id === g.id)) {
    dbUpdateWhere('inbox_items', (x) => x.dedupe_key === 'glucose_event:' + e.id && x.status !== 'RESOLVED', { status: 'RESOLVED', updated_at: now() });
    dbDeleteWhere('patient_insights', (x) => x.source_ref === 'glucose_event:' + e.id);
  }
  dbDeleteWhere('glucose_events', (x) => x.reading_id === g.id);
  const gone = { ...g };
  dbDelete('glucose_readings', g);
  fn_audit(c, 'glucose.delete', 'glucose_reading', String(gone.id), pid, { value: gone.value_mgdl, measured_at: gone.measured_at });
  return { ok: true };
}

/* ------------------------------------------------------------------------------------------------------ Accounts */

// Administrators issue a one-time password (shown once); the person must choose their own at the next sign-in.
function api_reset_password(c, d) {
  const target = castUuid(_m17_text(d, 'user_id'));
  fn_require_role(c, ['clinic_admin', 'platform_admin']);
  const u = target === null ? null : dbGet('users', target);
  if (!u) fn_raise('not_found: user not found');
  const me = castUuid(_m17_text(c, 'user_id'));
  if (u.id === me) fn_raise('bad_request: Use Account settings to change your own password.');
  let ok;
  if (_M17_FAMILY.includes(u.role)) {
    const myOrgs = dbWhere('memberships', (m) => me !== null && m.user_id === me).map((m) => m.organization_id);
    const own = dbOne('patients', (p) => p.user_id === u.id);
    const followed = dbWhere('caregiver_grants', (g) => g.caregiver_user_id === u.id && g.active === true).map((g) => g.patient_id);
    ok = _m17_text(c, 'role') === 'clinic_admin' && dbExists('care_team', (ct) => ct.active === true && ct.organization_id !== null
      && myOrgs.includes(ct.organization_id) && ((own !== null && ct.patient_id === own.id) || followed.includes(ct.patient_id)));
  } else if (u.role === 'platform_admin') {
    ok = false;
  } else {
    ok = fn_admin_can_manage(c, u.id);
  }
  if (!ok) fn_raise('forbidden: You cannot reset the password of this account.');
  const pw = fn_invite_code().slice(0, 4) + '-' + fn_invite_code().slice(0, 4).toLowerCase() + String(_m17_randomInt(90) + 10);
  dbUpdate('users', u, { password_hash: fn_hash_password(pw), must_change_password: true });
  dbUpdateWhere('sessions', (s) => s.user_id === u.id, { revoked: true });
  const ownRecord = dbOne('patients', (p) => p.user_id === u.id);
  fn_audit(c, 'auth.reset_password', 'user', u.id, ownRecord ? ownRecord.id : null,
    { reason: nullif(left(_m17_trim(coalesce(_m17_text(d, 'reason'), '')), 200), ''), target_role: u.role });
  // The account holder always learns about it, in the app and by email when email is set up.
  const by = _m17_text(c, 'full_name');
  const at = localTimestamp(now()).slice(0, 16).replace('T', ' ');
  dbInsert('notifications', {
    user_id: u.id, kind: 'security', title: 'Your password was reset',
    body: _m17_cat('An administrator (', by, ') set a temporary password for your account on ', at,
      '. If you did not ask for this, tell your clinic straight away.'),
    title_ar: 'تمت إعادة تعيين كلمة المرور',
    body_ar: _m17_cat('قام أحد المسؤولين (', by, ') بتعيين كلمة مرور مؤقتة لحسابك في ', at, '. إذا لم تطلب ذلك فأبلغ عيادتك فورًا.'),
  });
  fn_emit('AccountSecurityNotice', null, u.id, { kind: 'admin_reset', by });
  return { user_id: u.id, email: u.email, temporary_password: pw };
}

// Everything the service holds about the patient, in one JSON document (uploaded files are listed, not included).
// Each download is audited.
function api_export_data(c, d) {
  const pid = fn_resolve_patient(c, d);
  fn_require_role(c, ['patient']);
  fn_audit(c, 'record.export', 'patient', pid, pid);
  const uid = castUuid(_m17_text(c, 'user_id'));
  const rowsOf = (list, key) => jsonAgg(orderBy(list, key).map((x) => cloneValue(omit(x, 'patient_id')))) ?? [];
  const conversations = new Set(dbWhere('conversations', (cv) => cv.patient_id === pid && uid !== null && cv.user_id === uid).map((cv) => cv.id));
  return {
    exported_at: now(),
    profile: fn_patient_json(pid),
    record: fn_health_summary(pid),
    // Older readings were moved to glucose_readings_archive by the retention job: the export holds both.
    glucose_readings: jsonAgg(orderBy([...dbWhere('glucose_readings_archive', (g) => g.patient_id === pid), ...dbWhere('glucose_readings', (g) => g.patient_id === pid)], (g) => t(g.measured_at))
      .map((g) => ({ value_mgdl: g.value_mgdl, measured_at: g.measured_at, source: g.source, context: g.context }))) ?? [],
    meals: rowsOf(dbWhere('meal_logs', (x) => x.patient_id === pid), (x) => t(x.eaten_at)),
    activity: rowsOf(dbWhere('activity_logs', (x) => x.patient_id === pid), (x) => x.date),
    sleep: rowsOf(dbWhere('sleep_logs', (x) => x.patient_id === pid), (x) => x.date),
    checkins: rowsOf(dbWhere('checkins', (x) => x.patient_id === pid), (x) => t(x.at)),
    appointments: jsonAgg(orderBy(dbWhere('appointments', (a) => a.patient_id === pid), (a) => t(a.starts_at)).map((a) => fn_appointment_json(a))) ?? [],
    care_plans: jsonAgg(orderBy(dbWhere('care_plans', (p) => p.patient_id === pid && p.status !== 'DRAFT'), (p) => t(p.created_at))
      .map((p) => fn_plan_json(p.id))) ?? [],
    care_requests: jsonAgg(orderBy(dbWhere('episodes', (e) => e.patient_id === pid), (e) => t(e.started_at)).map((e) => fn_episode_json(e.id))) ?? [],
    documents: jsonAgg(orderBy(dbWhere('documents', (x) => x.patient_id === pid), (x) => t(x.created_at)).map((x) => fn_document_json(x))) ?? [],
    messages_with_care_team: fn_team_messages_json(pid),
    assistant_conversations: jsonAgg(orderBy(dbWhere('messages', (m) => conversations.has(m.conversation_id)), (m) => t(m.created_at))
      .map((m) => ({ role: m.role, content: m.content, at: m.created_at }))) ?? [],
    consents: jsonAgg(dbWhere('consents', (x) => x.patient_id === pid).map((x) => omit(x, 'patient_id'))) ?? [],
  };
}

// Consents: the latest decision per type. The patient can switch the AI assistant on or off at any time (ai_processing);
// data processing and the terms are needed to use the service and are withdrawn by closing the account.
function api_consents(c, d) {
  const pid = fn_resolve_patient(c, d);
  fn_require_role(c, ['patient']);
  const consents = orderBy(['terms', 'data_processing', 'ai_processing'], (type) => type).map((type) => {
    const x = orderBy(dbWhere('consents', (r) => r.patient_id === pid && r.type === type), [(r) => t(r.granted_at), 'desc'], [(r) => r.id, 'desc'])[0] || null;
    return { type, granted: x ? x.granted : null, at: x ? x.granted_at : null, changeable: type === 'ai_processing' };
  });
  const flag = dbGet('feature_flags', 'ai_cloud_egress');
  return { consents, ai_state: fn_ai_consent(pid), cloud_ai_enabled: coalesce(flag ? flag.enabled : null, false) };
}

function api_set_consent(c, d) {
  const pid = fn_resolve_patient(c, d);
  fn_require_role(c, ['patient']);
  if (coalesce(_m17_text(d, 'type'), '') !== 'ai_processing') {
    fn_raise('bad_request: Only the AI assistant consent can be changed here. To stop all processing, close your account.');
  }
  if (!['true', 'false'].includes(coalesce(_m17_text(d, 'granted'), ''))) fn_raise('bad_request: granted must be true or false');
  const granted = castBool(_m17_text(d, 'granted'));
  dbInsert('consents', { patient_id: pid, type: 'ai_processing', granted });
  fn_audit(c, granted ? 'consent.grant' : 'consent.withdraw', 'consent', 'ai_processing', pid);
  return api_consents(c, d);
}

// Closing an account signs the person out everywhere and stops all access. Health records already shared with a
// clinic stay with that clinic, as medical records must be kept; the clinic is told the account was closed.
function api_delete_account(c, d) {
  const uid = castUuid(_m17_text(c, 'user_id'));
  const pid = castUuid(nullif(_m17_text(c, 'patient_id'), ''));
  const key = _m17_cat('del:', _m17_text(c, 'user_id'));
  fn_require_role(c, ['patient', 'caregiver']);
  if (fn_throttled(key, 5, 15 * MIN)) {
    return fn_err('too_many_requests', 'Too many attempts. Please wait 15 minutes and try again.');
  }
  const u = uid === null ? null : dbGet('users', uid);
  if (!u || !checkPassword(coalesce(_m17_text(d, 'password'), ''), u.password_hash)) {
    dbInsert('auth_events', { key });
    return fn_err('bad_request', 'The current password is not correct.');
  }
  dbUpdate('users', u, {
    active: false, deleted_at: now(), mfa_enabled: false, mfa_secret: null,
    email: 'closed-' + left(u.id, 8) + '-' + round(nowMs() / 1000) + '@closed.invalid',
  });
  dbUpdateWhere('sessions', (s) => s.user_id === uid, { revoked: true });
  // Companion conversations and notifications are not part of the medical record: they are deleted with the account.
  const conversations = new Set(dbWhere('conversations', (cv) => cv.user_id === uid).map((cv) => cv.id));
  dbDeleteWhere('messages', (m) => conversations.has(m.conversation_id));
  dbDeleteWhere('conversations', (cv) => cv.user_id === uid);
  dbDeleteWhere('notifications', (n) => n.user_id === uid);
  if (pid !== null) {
    const followers = new Set(dbWhere('caregiver_grants', (g) => g.patient_id === pid && g.active === true).map((g) => g.caregiver_user_id));
    dbDeleteWhere('notifications', (n) => n.patient_id === pid && followers.has(n.user_id));
    dbUpdateWhere('caregiver_grants', (g) => g.patient_id === pid && g.active === true, { active: false, revoked_at: now() });
    dbUpdateWhere('caregiver_invites', (i) => i.patient_id === pid && i.used_at === null, { revoked: true });
    dbUpdateWhere('cgm_connections', (x) => x.patient_id === pid, { status: 'REVOKED', token: null });
    dbInsert('consents', { patient_id: pid, type: 'data_processing', granted: false });
    dbInsert('consents', { patient_id: pid, type: 'ai_processing', granted: false });
    fn_create_inbox_item(pid, 'question', 'low', 4, 'Patient closed their app account',
      'The patient closed their account. The record stays with the clinic; the patient no longer receives messages in the app.',
      {}, 'account-closed:' + pid);
  } else {
    dbUpdateWhere('caregiver_grants', (g) => g.caregiver_user_id === uid && g.active === true, { active: false, revoked_at: now() });
    dbUpdateWhere('caregiver_invites', (i) => i.used_by === uid && i.used_at === null, { revoked: true });
  }
  dbInsert('audit_logs', { actor_id: uid, actor_role: _m17_text(c, 'role'), action: 'auth.delete_account', entity: 'user', entity_id: uid, patient_id: pid });
  return { ok: true };
}
