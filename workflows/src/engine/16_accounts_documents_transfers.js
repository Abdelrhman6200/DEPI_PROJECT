// Port of database/migrations/016_fn_accounts_documents_transfers.sql: two-factor sign-in (TOTP), registration and
// passwords, emergency (break-glass) access and record search, care-team messages and clinic linking, documents
// (WF-018), transfers (WF-031) and staff administration.
//
// Differences from the SQL, on purpose:
// - Passwords use the runtime's hashPassword/checkPassword (scrypt) instead of pgcrypto crypt()/bcrypt
//   (app.fn_hash_password is not called).
// - TOTP: HMAC-SHA1 from the runtime's hmac(); a bytea value is a Buffer.
// - Documents keep the uploaded file as base64 text in documents.file_base64, as the SQL did. A Google Sheets cell holds
//   at most 50,000 characters, so the runtime refuses a file above about 37 KB when the request is written, although
//   the function itself still allows 4 MB.
// - Text ordering (order by f.name, u.role, u.full_name) is code-point order (runtime orderBy), not the en_US collation;
//   rows the SQL read without ORDER BY come in sheet order.
// - A numeric value written into a text (lab value in an inbox title) uses the JavaScript number text: 7.0 gives "7".

/* ------------------------------------------------------------------------------------------- private helpers */

/** d->>'key': the text of a field of a JSON object (null when missing, or when d is not an object). */
function _m16_s(obj, key) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  return jtext(obj[key]);
}
/** d->'key' */
function _m16_v(obj, key) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  return obj[key] === undefined ? null : obj[key];
}
/** trim(text): Postgres removes spaces only. */
function _m16_trim(s) { return s === null || s === undefined ? null : trimChars(String(s), ' '); }
/** length(text), in characters. */
function _m16_len(s) { return s === null || s === undefined ? null : Array.from(String(s)).length; }
/** a || b || ...: NULL when any part is NULL. */
function _m16_cat(...parts) { return parts.some((p) => p === null || p === undefined) ? null : parts.map(String).join(''); }
/** (c->>'user_id')::uuid */
function _m16_uid(c) { return castUuid(_m16_s(c, 'user_id')); }
/** a AND b AND ... with the SQL rules for NULL (false wins, then NULL). */
function _m16_and(...v) {
  if (v.some((x) => x === false)) return false;
  if (v.some((x) => x === null || x === undefined)) return null;
  return true;
}
/** to_char(ts, 'YYYYMMDDHH24') or to_char(ts, 'YYMMDD') in the database time zone (Africa/Cairo). */
function _m16_char(ts, fmt) {
  const p = cairoParts(ts);
  const z = (n) => String(n).padStart(2, '0');
  if (fmt === 'YYMMDD') return `${z(p.y % 100)}${z(p.mo)}${z(p.d)}`;
  return `${p.y}${z(p.mo)}${z(p.d)}${z(p.h)}`;
}
/** A bytea value as a Buffer: a Buffer, a byte array, '\x..' hex text or other text (its UTF-8 bytes). */
function _m16_bytes(p) {
  if (p === null || p === undefined) return null;
  if (typeof p === 'string') return p.startsWith('\\x') ? Buffer.from(p.slice(2), 'hex') : Buffer.from(p, 'utf8');
  return Buffer.from(p);
}
/** (select enabled from app.feature_flags where key = k) */
function _m16_flag(key) {
  const f = dbGet('feature_flags', key);
  return f ? f.enabled : null;
}

/* --------------------------------------------------------------------- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) */

/** app.fn_base32_encode(bytea): RFC 4648 base32 without padding; p is a Buffer (or byte array). */
function fn_base32_encode(p) {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = _m16_bytes(p);
  if (bytes === null) return null;
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  while (bits.length % 5 !== 0) bits += '0';
  let out = '';
  for (let i = 0; i < bits.length / 5; i++) out += a[parseInt(bits.substr(i * 5, 5), 2)];
  return out;
}

/** app.fn_base32_decode(text) -> bytea (a Buffer). '=' and white space are ignored; other characters are refused. */
function fn_base32_decode(p) {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  if (p === null || p === undefined) throw new Error('FOREACH expression must not be null');
  let bits = '';
  for (const ch of Array.from(regexpReplace(String(p), '[=\\s]', '', 'g'))) {
    const up = ch.toUpperCase();
    const pos = up.length === 1 ? a.indexOf(up) : -1;
    if (pos < 0) throw new Error('bad_request: invalid base32');
    bits += pos.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i < Math.floor(bits.length / 8); i++) out.push(parseInt(bits.substr(i * 8, 8), 2));
  return Buffer.from(out);
}

/** app.fn_totp(secret, counter): the 6-digit code of a time step. */
function fn_totp(p_secret, p_counter) {
  const key = fn_base32_decode(p_secret);
  if (p_counter === null || p_counter === undefined) return null;
  const msg = Buffer.alloc(8);
  msg.writeBigInt64BE(BigInt(castInt(p_counter)));
  const h = hmac('sha1', key, msg);
  const o = h[19] & 15;
  const bin = (h[o] & 127) * 16777216 + h[o + 1] * 65536 + h[o + 2] * 256 + h[o + 3];
  return String(bin % 1000000).padStart(6, '0');
}

// The time step a code belongs to (null when it matches none of the current, previous or next step).
function fn_totp_step(p_secret, p_code) {
  const code = p_code === null || p_code === undefined ? null : String(p_code);
  if (p_secret === null || p_secret === undefined || reTest(code, '^\\d{6}$') !== true) return null;
  const base = Math.floor(nowMs() / 30000);
  let step = null;
  for (let d = -1; d <= 1; d++) if (fn_totp(p_secret, base + d) === code) step = base + d;
  return step;
}

function fn_totp_ok(p_secret, p_code) {
  const code = p_code === null || p_code === undefined ? null : String(p_code);
  if (p_secret === null || p_secret === undefined || reTest(code, '^\\d{6}$') !== true) return false;
  const base = Math.floor(nowMs() / 30000);
  for (let d = -1; d <= 1; d++) if (fn_totp(p_secret, base + d) === code) return true;
  return false;
}

/* ---------------------------------------------- login with a second factor; registration; password; MFA setup */

function api_verify_mfa(d) {
  const token = _m16_s(d, 'mfa_token');
  const ch = dbOne('mfa_challenges', (r) => r.token === token && t(r.expires_at) > nowMs());
  if (!ch) return fn_err('unauthorized', 'The sign-in step expired. Please sign in again.');
  const key = 'mfa:' + ch.user_id;
  if (ch.attempts >= 5 || fn_throttled(key, 10, 15 * MIN)) {
    dbDelete('mfa_challenges', ch);
    return fn_err('too_many_requests', 'Too many wrong codes. Please wait 15 minutes and sign in again.');
  }
  const found = dbGet('users', ch.user_id);
  const u = found && found.active === true ? found : null;
  const step = fn_totp_step(u ? u.mfa_secret : null, _m16_trim(coalesce(_m16_s(d, 'code'), '')));
  // A code is accepted once: replaying an observed code within its 90-second window fails.
  if (!u || step === null || step <= coalesce(u.mfa_last_step, 0)) {
    // Returned as a value (not raised) so the attempt count and the audit entry are committed.
    dbUpdate('mfa_challenges', ch, { attempts: ch.attempts + 1 });
    dbInsert('auth_events', { key });
    dbInsert('audit_logs', { actor_id: ch.user_id, actor_role: u ? u.role : null, action: 'auth.mfa_failed', entity: 'user', entity_id: String(ch.user_id) });
    return fn_err('unauthorized', 'The code is not correct.');
  }
  dbDelete('mfa_challenges', ch);
  dbUpdate('users', u, { mfa_last_step: step });
  return fn_new_session(u.id, 'auth.login_mfa');
}

function fn_password_ok(p) {
  return _m16_len(coalesce(p, '')) >= 8 && reTest(p, '[A-Za-z؀-ۿ]') === true && reTest(p, '[0-9]') === true;
}

function api_register(d) {
  const email = _m16_trim(coalesce(_m16_s(d, 'email'), '')).toLowerCase();
  const dob = castDate(nullif(_m16_s(d, 'date_of_birth'), ''));
  const type = coalesce(nullif(_m16_s(d, 'diabetes_type'), ''), 'type2');
  const consent = (k) => coalesce(castBool(_m16_s(_m16_v(d, 'consents'), k)), false);
  const emailTaken = () => dbExists('users', (u) => String(u.email).toLowerCase() === email);
  const lang = () => coalesce(nullif(_m16_s(d, 'preferred_language'), ''), 'ar');
  if (reTest(email, '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$') !== true) fn_raise('bad_request: Please enter a valid email address.');
  if (!fn_password_ok(_m16_s(d, 'password'))) fn_raise('bad_request: The password needs at least 8 characters, including letters and numbers.');
  if (coalesce(_m16_trim(_m16_s(d, 'full_name')), '') === '') fn_raise('bad_request: Please enter your name.');
  // A family member signs up with the code the patient gave them; they get no record of their own.
  if (_m16_s(d, 'account_type') === 'caregiver') {
    if (!consent('terms')) fn_raise('bad_request: Please accept the terms to continue.');
    if (emailTaken()) fn_raise('bad_request: An account with this email already exists. Try signing in.');
    const code = regexpReplace(coalesce(_m16_s(d, 'invite_code'), ''), '[\\s-]', '', 'g').toUpperCase();
    if (!dbExists('caregiver_invites', (i) => i.code === code && !i.revoked && i.used_at === null && t(i.expires_at) > nowMs())) {
      fn_raise('bad_request: This invitation code is not valid or has expired. Ask for a new one.');
    }
    const cu = dbInsert('users', { email, password_hash: hashPassword(_m16_s(d, 'password')), full_name: _m16_trim(_m16_s(d, 'full_name')),
      full_name_ar: nullif(_m16_trim(_m16_s(d, 'full_name_ar')), ''), role: 'caregiver', locale: lang() });
    fn_use_invite(_m16_s(d, 'invite_code'), cu.id, nullif(_m16_s(d, 'relationship'), ''));
    dbInsert('audit_logs', { actor_id: cu.id, actor_role: 'caregiver', action: 'auth.register', entity: 'user', entity_id: cu.id });
    return fn_new_session(cu.id, 'auth.login');
  }
  if (dob === null || dob > today()) fn_raise('bad_request: Please enter a valid date of birth.');
  if (ageYears(dob) < 18) fn_raise('bad_request: This service is for adults aged 18 and over.');   // app.fn_age
  if (!['male', 'female'].includes(coalesce(_m16_s(d, 'sex'), ''))) fn_raise('bad_request: Please choose male or female.');
  if (!['type2', 'type1', 'prediabetes', 'none'].includes(type)) fn_raise('bad_request: Unknown diabetes type.');
  if (!(consent('terms') && consent('data_processing') && consent('ai_processing'))) {
    fn_raise('bad_request: All three consents are required to use the service.');
  }
  if (emailTaken()) fn_raise('bad_request: An account with this email already exists. Try signing in.');
  const u = dbInsert('users', { email, password_hash: hashPassword(_m16_s(d, 'password')), full_name: _m16_trim(_m16_s(d, 'full_name')),
    full_name_ar: nullif(_m16_trim(_m16_s(d, 'full_name_ar')), ''), role: 'patient', locale: lang() });
  const p = dbInsert('patients', {
    user_id: u.id, mrn: 'MRN-' + _m16_char(now(), 'YYMMDD') + '-' + md5(u.id).slice(0, 5).toUpperCase(),
    full_name: _m16_trim(_m16_s(d, 'full_name')), full_name_ar: nullif(_m16_trim(_m16_s(d, 'full_name_ar')), ''), date_of_birth: dob,
    sex: _m16_s(d, 'sex'), phone: nullif(_m16_s(d, 'phone'), ''), governorate: nullif(_m16_s(d, 'governorate'), ''),
    city: nullif(_m16_s(d, 'city'), ''), preferred_language: lang(), diabetes_type: type,
    pregnant: coalesce(castBool(_m16_s(d, 'pregnant')), false), closed_loop_pump: coalesce(castBool(_m16_s(d, 'uses_insulin_pump')), false),
    persona: 'self_registered',
  });
  for (const k of ['terms', 'data_processing', 'ai_processing']) dbInsert('consents', { patient_id: p.id, type: k, granted: true });
  for (const s of dbRows('screening_types')) dbInsert('screening_items', { patient_id: p.id, type: s.type });
  if (type === 'type2' || type === 'type1') {
    dbInsert('conditions', { patient_id: p.id, code: type === 'type1' ? 'E10' : 'E11',
      display: type === 'type1' ? 'Type 1 diabetes mellitus' : 'Type 2 diabetes mellitus',
      display_ar: type === 'type1' ? 'السكري من النوع الأول' : 'السكري من النوع الثاني', verification_status: 'unverified', source: 'patient' });
  }
  dbInsert('audit_logs', { actor_id: u.id, actor_role: 'patient', action: 'auth.register', entity: 'patient', entity_id: p.id, patient_id: p.id });
  return fn_new_session(u.id, 'auth.login');
}

function api_change_password(c, d) {
  const uid = _m16_uid(c);
  const key = _m16_cat('pwd:', _m16_s(c, 'user_id'));
  if (fn_throttled(key, 8, 15 * MIN)) {
    return fn_err('too_many_requests', 'Too many attempts. Please wait 15 minutes and try again.');
  }
  const u = dbGet('users', uid);
  if (!u || !checkPassword(coalesce(_m16_s(d, 'current_password'), ''), u.password_hash)) {
    dbInsert('auth_events', { key });
    return fn_err('bad_request', 'The current password is not correct.');
  }
  if (!fn_password_ok(_m16_s(d, 'new_password'))) fn_raise('bad_request: The new password needs at least 8 characters, including letters and numbers.');
  dbUpdate('users', u, { password_hash: hashPassword(_m16_s(d, 'new_password')), must_change_password: false });
  // Sign out every other device; the session that changed the password stays signed in.
  const keep = coalesce(_m16_s(d, '__token'), '');
  dbUpdateWhere('sessions', (s) => s.user_id === uid && s.token !== keep && !s.revoked, { revoked: true });
  fn_audit(c, 'auth.change_password', 'user', uid, null);
  return { ok: true };
}

function api_mfa_setup(c) {
  const secret = fn_base32_encode(Buffer.from(randomHex(20), 'hex'));
  const u = dbGet('users', _m16_uid(c));
  if (u && u.mfa_enabled) {
    fn_raise('bad_request: Two-factor sign-in is already on. Turn it off with a current code before setting it up again.');
  }
  if (u) dbUpdate('users', u, { mfa_pending_secret: secret });
  return { secret, otpauth_url: u ? 'otpauth://totp/DiabetesCare:' + u.email.split('@').join('%40') + '?secret=' + secret + '&issuer=DiabetesCare&digits=6&period=30' : null };
}

function api_mfa_enable(c, d) {
  const u = dbGet('users', _m16_uid(c));
  if (!u || u.mfa_pending_secret === null) fn_raise('bad_request: Start the setup first.');
  if (!fn_totp_ok(u.mfa_pending_secret, _m16_trim(_m16_s(d, 'code')))) fn_raise('bad_request: The code is not correct. Check the time on your phone and try again.');
  dbUpdate('users', u, { mfa_secret: u.mfa_pending_secret, mfa_pending_secret: null, mfa_enabled: true });
  fn_audit(c, 'auth.mfa_enable', 'user', u.id, null);
  return { ok: true };
}

function api_mfa_disable(c, d) {
  const u = dbGet('users', _m16_uid(c));
  if (!u || !u.mfa_enabled || !fn_totp_ok(u.mfa_secret, _m16_trim(_m16_s(d, 'code')))) fn_raise('bad_request: The code is not correct.');
  dbUpdate('users', u, { mfa_secret: null, mfa_enabled: false });
  fn_audit(c, 'auth.mfa_disable', 'user', u.id, null);
  return { ok: true };
}

/* --------------------------------------------------------------------------- emergency (break-glass) access */

// Exact MRN or name search for emergency access. Limited per clinician (break_glass_policy.searches_per_hour); the
// ids found are audited, not only the query length.
function api_find_patient(c, d) {
  const q = _m16_trim(coalesce(_m16_s(d, 'q'), ''));
  const key = _m16_cat('find:', _m16_s(c, 'user_id'));
  const p = coalesce(fn_rule('break_glass_policy'), {});
  fn_require_role(c, ['doctor', 'nurse']);
  if (_m16_len(q) < 3) return [];
  if (fn_throttled(key, coalesce(castInt(_m16_s(p, 'searches_per_hour')), 20), HOUR)) {
    return fn_err('too_many_requests', 'Too many record searches. Please wait before searching again.');
  }
  dbInsert('auth_events', { key });
  const out = dbWhere('patients', (x) => x.mrn.toUpperCase() === q.toUpperCase() || x.full_name.toLowerCase() === q.toLowerCase() || x.full_name_ar === q)
    .slice(0, 5)
    .map((x) => ({ id: x.id, full_name: x.full_name, mrn: x.mrn, age: ageYears(x.date_of_birth) }));   // app.fn_age
  fn_audit(c, 'patient.find', 'patient', null, null, { query_length: _m16_len(q), found: out.map((x) => x.id) });
  return out;
}

// Emergency access outside the care team (H11): a written reason, a daily limit per clinician, a 4-hour grant, an audit
// entry, and a notice to every Safety Officer and to the patient's own clinic.
function api_break_glass(c, d) {
  const pid = castUuid(_m16_s(d, 'patient_id'));
  const p = coalesce(fn_rule('break_glass_policy'), {});
  fn_require_role(c, ['doctor', 'nurse']);
  const minChars = coalesce(castInt(_m16_s(p, 'min_reason_chars')), 20);
  if (_m16_len(_m16_trim(coalesce(_m16_s(d, 'reason'), ''))) < minChars) {
    fn_raise('bad_request: Please describe the emergency reason (at least ' + minChars + ' characters).');
  }
  if (!dbGet('patients', pid)) fn_raise('not_found: patient not found');
  const uid = _m16_uid(c);
  // The limit counts different records opened in the past day; renewing access to the same record does not count.
  const since = nowMs() - DAY;
  const opened = new Set(dbWhere('access_grants', (g) => g.user_id === uid && t(g.created_at) > since && g.patient_id !== pid).map((g) => g.patient_id));
  if (opened.size >= coalesce(castInt(_m16_s(p, 'grants_per_day')), 3)) {
    fn_raise('forbidden: The daily limit of emergency access grants is reached. Ask the Safety Officer.');
  }
  const g = dbInsert('access_grants', { user_id: uid, patient_id: pid, reason: _m16_trim(_m16_s(d, 'reason')),
    expires_at: later(coalesce(castInt(_m16_s(p, 'grant_hours')), 4) * HOUR) });
  const exp = g.expires_at;
  fn_audit(c, 'access.break_glass', 'patient', pid, pid, { reason: _m16_s(d, 'reason'), expires_at: exp });
  const name = _m16_s(c, 'full_name');
  const body = _m16_cat(name, ': ', left(_m16_s(d, 'reason'), 200));
  for (const u of dbWhere('users', (x) => x.role === 'safety_officer' && x.active)) {
    dbInsert('notifications', { user_id: u.id, patient_id: pid, kind: 'break_glass', title: 'Break-glass access used', body,
      title_ar: 'تم استخدام صلاحية الطوارئ', body_ar: body });
  }
  fn_create_inbox_item(pid, 'safety', 'medium', 3, _m16_cat('Emergency access to this record by ', name), left(_m16_s(d, 'reason'), 500),
    { grant_user_id: _m16_s(c, 'user_id'), expires_at: exp },
    _m16_cat('break-glass:', pid, ':', _m16_s(c, 'user_id'), ':', _m16_char(now(), 'YYYYMMDDHH24')));
  return { ok: true, expires_at: exp };
}

/* ------------------------------------------------------------------------- care-team messaging, clinic linking */

function api_message_team(c, d) {
  const pid = fn_resolve_patient(c, d);
  const text = left(_m16_trim(coalesce(_m16_s(d, 'text'), '')), 1000);
  const who = _m16_s(c, 'role') === 'caregiver' ? 'caregiver' : 'patient';
  if (_m16_len(text) < 2) fn_raise('bad_request: Please write your message.');
  // Messages are read later, not at once: emergency warning signs get the fixed emergency guidance immediately
  // and reach the care team as a critical item.
  const em = fn_prescreen_for(c, pid, text);
  const emergency = coalesce(castBool(_m16_s(em, 'emergency')), false);
  const urgent = coalesce(castBool(_m16_s(em, 'urgent')), false);
  const from = { from_user: _m16_s(c, 'user_id'), from_role: _m16_s(c, 'role') };
  let item;
  if (emergency) {
    item = fn_create_inbox_item(pid, 'episode', 'critical', 1, 'Emergency warning signs in a message from the ' + who, text,
      { ...from, matched: _m16_v(em, 'matched') }, null);
  } else if (urgent) {
    item = fn_create_inbox_item(pid, 'episode', 'high', 2, 'Urgent foot problem in a message from the ' + who, text,
      { ...from, matched: _m16_v(em, 'urgent_matched') }, null);
  } else {
    item = fn_create_inbox_item(pid, 'question', 'low', 4, 'Message from ' + who, text, from, null);
  }
  item = item ?? null;
  if (item !== null) {
    dbInsert('team_messages', { patient_id: pid, author_id: _m16_uid(c), author_role: _m16_s(c, 'role'), body: text, inbox_item_id: item, emergency });
  }
  fn_audit(c, 'message.care_team', 'inbox_item', item, pid, { emergency });
  return { ok: true, routed: item !== null, emergency: emergency ? em : null, urgent: urgent ? em : null };
}

function fn_link_request_json(r) {
  const x = r || {};
  const p = dbGet('patients', x.patient_id ?? null);
  const o = dbGet('organizations', x.organization_id ?? null);
  return { id: x.id ?? null, patient_id: x.patient_id ?? null, patient_name: p ? p.full_name : null,
    organization_id: x.organization_id ?? null, organization_name: o ? o.name : null, organization_name_ar: o ? o.name_ar : null,
    message: x.message ?? null, status: x.status ?? null, created_at: x.created_at ?? null };
}

function api_request_link(c, d) {
  const pid = fn_resolve_patient(c, d);
  const org = castUuid(_m16_s(d, 'organization_id'));
  if (!dbGet('organizations', org)) fn_raise('not_found: clinic not found');
  if (dbExists('care_team', (ct) => ct.patient_id === pid && ct.organization_id === org && ct.active)) {
    fn_raise('bad_request: You are already connected with this clinic.');
  }
  const r = dbInsert('link_requests', { patient_id: pid, organization_id: org, message: left(_m16_s(d, 'message'), 500) },
    { onConflict: { cols: ['patient_id', 'organization_id'], set: (existing, row) => ({ message: row.message }) } });
  const p = dbGet('patients', pid);
  for (const m of dbWhere('memberships', (x) => x.organization_id === r.organization_id && ['doctor', 'clinic_admin'].includes(x.role))) {
    dbInsert('notifications', { user_id: m.user_id, patient_id: pid, kind: 'link_request', title: 'New patient join request',
      body: p ? p.full_name : null, title_ar: 'طلب انضمام مريض جديد', body_ar: p ? coalesce(p.full_name_ar, p.full_name) : null });
  }
  fn_audit(c, 'link.request', 'link_request', r.id, pid);
  return fn_link_request_json(r);
}

function api_decide_link(c, d) {
  fn_require_role(c, ['doctor', 'clinic_admin']);
  const uid = _m16_uid(c);
  const id = castUuid(_m16_s(d, 'request_id'));
  const mine = dbWhere('memberships', (m) => m.user_id === uid).map((m) => m.organization_id);
  let r = dbOne('link_requests', (x) => x.id === id && mine.includes(x.organization_id));
  if (!r) fn_raise('not_found: request not found');
  if (r.status !== 'pending') return fn_link_request_json(r);
  r = dbUpdate('link_requests', r, { status: _m16_s(d, 'decision') === 'accept' ? 'accepted' : 'declined', decided_by: uid, decided_at: now() });
  const pid = r.patient_id;
  if (r.status === 'accepted') {
    const doctor = _m16_s(c, 'role') === 'doctor' ? uid
      : ((dbOne('memberships', (m) => m.organization_id === r.organization_id && m.role === 'doctor') || {}).user_id ?? null);
    dbInsert('care_team', { patient_id: pid, user_id: doctor, organization_id: r.organization_id, role: 'doctor' },
      { onConflict: { cols: ['patient_id', 'user_id'], set: (existing, row) => ({ active: true, organization_id: row.organization_id }) } });
    // What the patient recorded before joining now reaches the clinic: unverified facts and open safety findings.
    for (const x of dbWhere('conditions', (y) => y.patient_id === pid && y.verification_status === 'unverified')) {
      fn_queue_verification(pid, 'condition', x.id, x.display);
    }
    for (const x of dbWhere('allergies', (y) => y.patient_id === pid && y.verification_status === 'unverified' && y.status === 'active')) {
      fn_queue_verification(pid, 'allergy', x.id, x.substance);
    }
    for (const x of dbWhere('medications', (y) => y.patient_id === pid && y.verification_status === 'unverified' && y.status === 'active')) {
      fn_queue_verification(pid, 'medication', x.id, x.name);
    }
    for (const x of dbWhere('lab_results', (y) => y.patient_id === pid && y.verification_status === 'unverified')) {
      const lc = dbGet('lab_catalog', x.test_code);
      if (!lc) continue;
      fn_create_inbox_item(pid, 'result', 'medium', 3, _m16_cat('New patient-entered result: ', lc.display, ' ', x.value, ' ', x.unit),
        'Entered by the patient; needs verification.', { entity: 'lab', id: x.id }, 'verify:lab:' + x.id);
    }
    for (const x of dbWhere('safety_findings', (y) => y.patient_id === pid && y.status === 'open')) {
      const sev = x.severity;
      fn_create_inbox_item(pid, 'safety',
        sev === 'contraindicated' ? 'critical' : sev === 'major' ? 'high' : sev === 'moderate' ? 'medium' : 'low',
        sev === 'contraindicated' ? 1 : sev === 'major' ? 2 : 3,
        _m16_cat('Medication safety: ', x.title), x.detail, { finding_id: x.id, medication_id: x.medication_id }, _m16_cat('safety:', x.id, ':linked'));
    }
    const o = dbGet('organizations', r.organization_id);
    fn_notify_patient(pid, 'link_accepted', 'You are now connected with your clinic',
      _m16_cat(o ? o.name : null, ' accepted your request. Your care team can now see your record and send you a care plan.'),
      'link:' + r.id, 'تم ربطك بعيادتك',
      _m16_cat(o ? coalesce(o.name_ar, o.name) : null, ' وافقت على طلبك. يمكن لفريق الرعاية الآن رؤية ملفك وإرسال خطة رعاية لك.'));
  } else {
    fn_notify_patient(pid, 'link_declined', 'Clinic request not accepted',
      'The clinic could not accept your request. You can try another clinic from the Care tab.', 'link:' + r.id,
      'لم يتم قبول طلب الانضمام', 'لم تتمكن العيادة من قبول طلبك. يمكنك تجربة عيادة أخرى من صفحة الرعاية.');
  }
  fn_audit(c, 'link.' + r.status, 'link_request', r.id, pid);
  return fn_link_request_json(r);
}

/* ------------------------------------------------------------------------------------------- documents (WF-018) */

function fn_document_json(dd) {
  const x = dd || {};
  return { id: x.id ?? null, patient_id: x.patient_id ?? null, title: x.title ?? null, kind: x.kind ?? null, file_name: x.file_name ?? null,
    mime_type: x.mime_type ?? null, size_bytes: x.size_bytes ?? null,
    has_file: (x.file_ref !== null && x.file_ref !== undefined) || (x.file_base64 !== null && x.file_base64 !== undefined),
    status: x.status ?? null, extracted: x.extracted ?? null, created_at: x.created_at ?? null };
}

// The uploaded file is kept on the n8n server (documents/<document id> under ~/.n8n-files, written by the
// workflow before the Sheets changes are saved); the row keeps its reference and checksum. Pasted text stays in the
// row, so it is limited to what a Sheets cell holds.
function api_upload_document(c, d) {
  const pid = fn_resolve_patient(c, d);
  const b64 = nullif(_m16_s(d, 'content_base64'), '');
  let size = null;
  if (coalesce(_m16_trim(_m16_s(d, 'title')), '') === '') fn_raise('bad_request: Please give the document a title.');
  if (b64 === null && coalesce(_m16_trim(_m16_s(d, 'text')), '') === '') fn_raise('bad_request: Attach a photo or PDF, or paste the text.');
  if (b64 !== null) {
    size = Math.trunc((_m16_len(b64) * 3) / 4);
    if (size > 4 * 1024 * 1024) fn_raise('bad_request: The file is larger than 4 MB. Please take a smaller photo.');
    if (reTest(coalesce(_m16_s(d, 'mime_type'), ''), '^(image/(png|jpeg|jpg|webp|heic)|application/pdf)$') !== true) {
      fn_raise('bad_request: Only photos (PNG, JPEG, WebP, HEIC) and PDF files are supported.');
    }
  }
  if (_m16_len(_m16_s(d, 'text')) > 45000) fn_raise('bad_request: The pasted text is too long (45,000 characters at most). Please attach the document as a PDF instead.');
  const id = uuid();
  const fileRef = b64 === null ? null : `documents/${id}`;
  const dd = dbInsert('documents', {
    id, patient_id: pid, title: left(_m16_trim(_m16_s(d, 'title')), 200), kind: coalesce(nullif(_m16_s(d, 'kind'), ''), 'other'),
    content_text: nullif(_m16_trim(_m16_s(d, 'text')), ''), status: 'uploaded', file_name: nullif(_m16_s(d, 'file_name'), ''),
    mime_type: nullif(_m16_s(d, 'mime_type'), ''), size_bytes: coalesce(size, _m16_len(_m16_s(d, 'text'))), file_base64: null,
    file_ref: fileRef, file_sha256: b64 === null ? null : sha256(b64), uploaded_by: _m16_uid(c),
  });
  if (fileRef) dbFileWrite(fileRef, b64);
  fn_emit('DocumentUploaded', pid, dd.id, { kind: dd.kind, mime_type: dd.mime_type });
  fn_audit(c, 'document.upload', 'document', dd.id, pid);
  return fn_document_json(dd);
}

// Called by WF-018 with the validated extraction (or a failure).
function fn_document_extracted(p_id, p_extracted, p_ok) {
  const id = castUuid(p_id);
  const extracted = castJson(p_extracted);
  const ok = castBool(p_ok) === true;
  let dd = dbOne('documents', (x) => x.id === id && ['uploaded', 'extracting'].includes(x.status));
  if (!dd) return null;
  dd = dbUpdate('documents', dd, { status: ok ? 'extracted' : 'extraction_failed', extracted: ok ? extracted : null });
  if (ok) {
    fn_create_inbox_item(dd.patient_id, 'verification', 'low', 4, _m16_cat('Review uploaded document: ', dd.title),
      coalesce(_m16_s(extracted, 'summary'), ''), { entity: 'document', id: dd.id, document_id: dd.id }, 'verify:document:' + dd.id);
  }
  fn_notify_patient(dd.patient_id, 'document',
    ok ? 'Your document was read' : 'We could not read your document',
    ok ? 'We found information in "' + dd.title + '". Your care team will confirm it.'
      : 'Your care team can still open "' + dd.title + '". You can also type the results yourself in Health.',
    'document:' + dd.id + ':' + dd.status,
    ok ? 'تمت قراءة المستند' : 'لم نتمكن من قراءة المستند',
    ok ? 'وجدنا معلومات في "' + dd.title + '". سيؤكدها فريق الرعاية.'
      : 'ما زال بإمكان فريق الرعاية فتح "' + dd.title + '". ويمكنك أيضًا كتابة النتائج بنفسك في صفحة صحتي.');
  return fn_document_json(dd);
}

function api_review_document(c, d) {
  const vDefault = fn_try_ts(_m16_s(d, 'default_date'));
  fn_require_role(c, ['doctor', 'nurse']);
  let dd = dbGet('documents', castUuid(_m16_s(d, 'document_id')));
  if (!dd || !fn_can_access_patient(c, dd.patient_id)) fn_raise('not_found: document not found');
  const decision = _m16_s(d, 'decision');
  if (!['accept', 'reject'].includes(coalesce(decision, ''))) fn_raise('bad_request: decision must be accept or reject');
  // A document is reviewed once; a second review would file the same results again.
  // (A document that could not be read can only be dismissed.)
  if (!['extracted', 'extraction_failed'].includes(dd.status) || (decision === 'accept' && dd.status !== 'extracted')) {
    fn_raise('bad_request: This document has already been reviewed or is not ready for review.');
  }
  const uid = _m16_uid(c);
  if (decision === 'accept') {
    let kidney = false;
    const li = _m16_v(d, 'lab_indexes');
    const indexes = [...new Set((Array.isArray(li) ? li : []).map(jtext).filter((x) => reTest(x, '^[0-9]{1,3}$') === true).map(Number))]
      .sort((a, b) => a - b);
    const labs = _m16_v(dd.extracted, 'labs');
    for (const idx of indexes) {
      const lab = Array.isArray(labs) && idx < labs.length ? labs[idx] : null;
      if (lab === null || jtype(lab) !== 'object') continue;
      const code = _m16_s(lab, 'test_code');
      if (!dbGet('lab_catalog', code)) continue;
      if (reTest(coalesce(_m16_s(lab, 'value'), ''), '^-?[0-9]+(\\.[0-9]+)?$') !== true) {
        fn_raise(_m16_cat('bad_request: The value read for ', code, ' is not a number. Untick it and enter the result by hand.'));
      }
      // Converts to the standard unit and refuses impossible values, exactly like a hand-entered result.
      const nr = fn_normalize_lab(code, castNum(_m16_s(lab, 'value')), _m16_s(lab, 'unit'));
      const n = Array.isArray(nr) ? nr[0] : nr;
      const at = coalesce(fn_try_ts(_m16_s(lab, 'observed_at')), vDefault);
      if (at === null) fn_raise('bad_request: The document does not show the date of these results. Enter the date of the test.');
      if (t(at) > nowMs() + DAY) fn_raise('bad_request: The result date is in the future.');
      const l = dbInsert('lab_results', { patient_id: dd.patient_id, test_code: code, value: n.value, unit: n.unit, observed_at: at,
        verification_status: 'verified', source: 'document', verified_by: uid, verified_at: now() });
      fn_emit('LabResultVerified', dd.patient_id, l.id, { test_code: code, document_id: dd.id });
      fn_handle_critical_lab(l.id);
      kidney = kidney || code === 'creatinine' || code === 'egfr';
    }
    dd = dbUpdate('documents', dd, { status: 'verified', reviewed_by: uid });
    if (kidney) fn_recheck_patient_safety(dd.patient_id);
  } else {
    dd = dbUpdate('documents', dd, { status: 'rejected', reviewed_by: uid });
  }
  const dedupe = 'verify:document:' + dd.id;
  dbUpdateWhere('inbox_items', (i) => i.dedupe_key === dedupe, { status: 'RESOLVED', updated_at: now() });
  fn_audit(c, 'document.' + dd.status, 'document', dd.id, dd.patient_id);
  return fn_document_json(dd);
}

function fn_ctx_document(p_id) {
  const id = castUuid(p_id);
  // Claims a new upload, or an extraction whose worker died (12-minute lease, longer than the model time-outs).
  let dd = dbOne('documents', (x) => x.id === id && (x.status === 'uploaded'
    || (x.status === 'extracting' && t(coalesce(x.extraction_started_at, x.created_at)) < nowMs() - 12 * MIN)));
  if (!dd) {
    const cur = dbGet('documents', id);
    if (cur && cur.status === 'extracting') {
      // Another attempt may still be running: fail this delivery so the dispatcher tries again later.
      throw new Error('retry_later: document extraction is still in progress');
    }
    return null;
  }
  dd = dbUpdate('documents', dd, { status: 'extracting', extraction_started_at: now() });
  const gate = fn_ai_gate(dd.patient_id, 'document_extraction');
  const cloudFlag = coalesce(_m16_flag('document_cloud_extraction'), false);
  const gateCloud = castBool(_m16_s(gate, 'cloud_allowed'));
  return {
    document_id: dd.id, patient_id: dd.patient_id, title: dd.title, kind: dd.kind,
    // The file itself is read from the n8n server by WF-018 (file_ref); file_base64 is only set for rows from before.
    mime_type: dd.mime_type, file_ref: dd.file_ref ?? null, file_base64: dd.file_base64, text: dd.content_text,
    // A document is identifiable as a whole: cloud reading needs its own flag on top of the AI gate (consent + egress).
    ai_allowed: castBool(_m16_s(gate, 'ai_allowed')),
    cloud_allowed: _m16_and(cloudFlag, gateCloud),
    // Photos and PDFs cannot be redacted: they go to the cloud only under a zero-retention agreement (never on the free
    // tier, which may use the data). Text documents are redacted first and need only the flags above.
    cloud_binary_allowed: _m16_and(cloudFlag, gateCloud, coalesce(_m16_flag('cloud_zero_retention'), false)),
    gate,
    lab_catalog: jsonAgg(dbRows('lab_catalog').map((l) => ({ test_code: l.test_code, display: l.display, unit: l.unit }))),
    ai_run_id: fn_ai_run_start('WF-018 Document Extraction', dd.patient_id, null, { document_id: dd.id, mime_type: dd.mime_type }, null, 'doc_extract/v1'),
  };
}

/* ------------------------------------------------------------------------------------- transfers (8.4, WF-031) */

// Status machine of a transfer: the statuses each one may move to.
const _M16_TRANSFER_NEXT = {
  REQUESTED: ['UNDER_REVIEW', 'CANCELLED'], UNDER_REVIEW: ['ACCEPTED', 'DECLINED', 'CANCELLED'],
  ACCEPTED: ['BED_RESERVED', 'CANCELLED'], DECLINED: ['UNDER_REVIEW', 'CANCELLED'], BED_RESERVED: ['IN_TRANSPORT', 'CANCELLED'],
  IN_TRANSPORT: ['ARRIVED'], ARRIVED: [], CANCELLED: [],
};

function fn_transfer_json(tr) {
  const x = tr || {};
  const resource = _m16_s(x.requirements, 'resource');
  const specialty = nullif(_m16_s(x.requirements, 'specialty'), '');
  const from = x.from_facility_id ?? null;
  const fresh = nowMs() - 6 * HOUR;
  const eligible = dbWhere('facilities', (f) => (from === null || f.id !== from)
    && dbExists('facility_capacity', (fc) => fc.facility_id === f.id && fc.resource === resource && t(fc.updated_at) > fresh
      && ['available', 'limited'].includes(fc.status) && coalesce(fc.available, 1) > 0)
    && (specialty === null || (f.specialties || []).includes(specialty)));
  const p = dbGet('patients', x.patient_id ?? null);
  const ff = dbGet('facilities', from);
  const tf = dbGet('facilities', x.to_facility_id ?? null);
  const u = dbGet('users', x.created_by ?? null);
  return {
    id: x.id ?? null, patient_id: x.patient_id ?? null, patient_name: p ? p.full_name : null,
    from_facility_name: ff ? ff.name : null,
    to_facility_id: x.to_facility_id ?? null, to_facility_name: tf ? tf.name : null,
    requirements: x.requirements ?? null, status: x.status ?? null,
    eligible_facilities: jsonAgg(orderBy(eligible, (f) => f.name).map((f) => fn_facility_json(f, null, null))) ?? [],
    created_by_name: u ? u.full_name : null, created_at: x.created_at ?? null, updated_at: x.updated_at ?? null,
  };
}

function fn_can_see_transfer(c, tr) {
  return _m16_s(c, 'role') === 'transfer_coordinator' || fn_can_access_patient(c, tr ? tr.patient_id : null);
}

function api_create_transfer(c, d) {
  const pid = fn_resolve_patient(c, d);
  fn_require_role(c, ['doctor', 'nurse']);
  if (coalesce(_m16_s(d, 'resource'), '') === '' || coalesce(_m16_trim(_m16_s(d, 'reason')), '') === '') fn_raise('bad_request: resource and reason are required');
  const tr = dbInsert('transfers', {
    patient_id: pid, from_facility_id: castUuid(nullif(_m16_s(d, 'from_facility_id'), '')),
    requirements: { resource: _m16_s(d, 'resource'), specialty: nullif(_m16_s(d, 'specialty'), ''), reason: _m16_s(d, 'reason'),
      urgency: coalesce(nullif(_m16_s(d, 'urgency'), ''), 'urgent') },
    status: 'REQUESTED', created_by: _m16_uid(c),
  });
  fn_emit('TransferStatusChanged', pid, tr.id, { status: tr.status });
  fn_audit(c, 'transfer.create', 'transfer', tr.id, pid);
  return fn_transfer_json(tr);
}

function api_update_transfer(c, d) {
  const next = _m16_s(d, 'status');
  let tr = dbGet('transfers', castUuid(_m16_s(d, 'transfer_id')));
  if (!tr || !fn_can_see_transfer(c, tr)) fn_raise('not_found: transfer not found');
  const role = _m16_s(c, 'role');
  if (role !== null && !['doctor', 'nurse', 'transfer_coordinator', 'clinic_admin', 'platform_admin'].includes(role)) fn_raise('forbidden: cannot update transfers');
  const prev = tr.status;
  if (next === null || !Object.prototype.hasOwnProperty.call(_M16_TRANSFER_NEXT, next)) fn_raise('bad_request: unknown transfer status');
  if (next !== prev && !(_M16_TRANSFER_NEXT[prev] || []).includes(next)) {
    fn_raise('bad_request: A transfer cannot move from ' + prev + ' to ' + next + '.');
  }
  const fac = coalesce(castUuid(nullif(_m16_s(d, 'to_facility_id'), '')), tr.to_facility_id);
  if (fac !== null && !dbGet('facilities', fac)) fn_raise('not_found: facility not found');
  if ((next === 'ACCEPTED' || next === 'BED_RESERVED') && fac === null) fn_raise('bad_request: Choose the receiving facility first.');
  if (['BED_RESERVED', 'IN_TRANSPORT', 'ARRIVED'].includes(prev) && fac !== tr.to_facility_id) {
    fn_raise('bad_request: The receiving facility cannot be changed after a bed is reserved. Cancel this transfer and create a new one.');
  }
  const resource = _m16_s(tr.requirements, 'resource');
  if (next === 'BED_RESERVED' && prev !== 'BED_RESERVED') {
    // Reserve one place, once, and only against capacity the facility confirmed recently.
    const cap = dbOne('facility_capacity', (x) => x.facility_id === fac && x.resource === resource);
    if (!cap || t(cap.updated_at) < nowMs() - 6 * HOUR || cap.status === 'full' || coalesce(cap.available, 0) < 1) {
      fn_raise('bad_request: This facility has no confirmed free place for this request right now. Ask the facility to update its capacity, or choose another facility.');
    }
    // updated_at is left alone: a reservation is not a fresh capacity report from the facility.
    const rest = cap.available - 1;
    dbUpdate('facility_capacity', cap, { available: rest, source: 'transfer',
      status: rest <= 0 ? 'full' : (coalesce(cap.total, 0) > 0 && rest / cap.total < 0.2 ? 'limited' : cap.status) });
  } else if (next === 'CANCELLED' && prev === 'BED_RESERVED') {
    // Give the reserved place back.
    for (const cap of dbWhere('facility_capacity', (x) => x.facility_id === tr.to_facility_id && x.resource === resource)) {
      const avail = coalesce(cap.available, 0);
      dbUpdate('facility_capacity', cap, { available: Math.min(avail + 1, coalesce(nullif(cap.total, 0), avail + 1)),
        status: cap.status === 'full' ? 'limited' : cap.status });
    }
  }
  tr = dbUpdate('transfers', tr, { status: next, to_facility_id: fac, updated_at: now() });
  if (next !== prev) fn_emit('TransferStatusChanged', tr.patient_id, tr.id, { status: tr.status });
  fn_audit(c, 'transfer.' + tr.status.toLowerCase(), 'transfer', tr.id, tr.patient_id);
  return fn_transfer_json(tr);
}

function fn_transfers_list(c, d) {
  const raw = _m16_s(d, 'status');
  const status = coalesce(raw, 'active');
  const list = dbWhere('transfers', (x) => fn_can_see_transfer(c, x)
    && (status === 'all' || (status === 'active' && !['ARRIVED', 'CANCELLED', 'DECLINED'].includes(x.status)) || x.status === raw));
  return jsonAgg(orderBy(list, [(x) => t(x.updated_at), 'desc']).map((x) => fn_transfer_json(x))) ?? [];
}

function fn_handle_transfer_event(p_event) {
  const ev = castJson(p_event);
  const tr = dbGet('transfers', castUuid(_m16_s(ev, 'resource_id')));
  if (!tr) return { handled: false };
  const resource = _m16_s(tr.requirements, 'resource');
  const reason = left(_m16_s(tr.requirements, 'reason'), 120);
  const to = dbGet('facilities', tr.to_facility_id);
  for (const u of dbWhere('users', (x) => x.active && (x.role === 'transfer_coordinator' || x.id === tr.created_by))) {
    dbInsert('notifications', {
      user_id: u.id, patient_id: tr.patient_id, kind: 'transfer',
      title: _m16_cat('Transfer ', tr.status.split('_').join(' ').toLowerCase(), ': ', resource),
      body: _m16_cat(coalesce(to ? to.name : null, 'Destination not chosen yet'), ' - ', reason),
      dedupe_key: _m16_cat('transfer:', tr.id, ':', tr.status, ':', u.id),
      title_ar: _m16_cat('تحديث نقل مريض (', resource, ')'),
      body_ar: _m16_cat(coalesce(to ? to.name_ar : null, 'لم تحدد الجهة المستقبلة بعد'), ' - ', reason),
    }, { onConflict: 'nothing' });
  }
  if (['BED_RESERVED', 'IN_TRANSPORT', 'ARRIVED'].includes(tr.status)) {
    fn_notify_patient(tr.patient_id, 'transfer', 'Transfer update',
      tr.status === 'BED_RESERVED' ? 'A bed has been reserved at ' + coalesce(to ? to.name : null, 'the receiving hospital') + '.'
        : tr.status === 'IN_TRANSPORT' ? 'You are on the way to the receiving hospital.' : 'You have arrived. The receiving team has your summary.',
      'transfer-patient:' + tr.id + ':' + tr.status, 'تحديث على نقلك',
      tr.status === 'BED_RESERVED' ? 'تم حجز سرير لك في ' + coalesce(to ? to.name_ar : null, 'المستشفى المستقبل') + '.'
        : tr.status === 'IN_TRANSPORT' ? 'أنت في الطريق إلى المستشفى المستقبل.' : 'لقد وصلت. لدى الفريق المستقبل ملخص حالتك.');
  }
  return { handled: true };
}

/* ------------------------------------------------------------------------------------------ staff administration */

function fn_staff_json(u) {
  const x = u || {};
  const orgs = dbWhere('memberships', (m) => m.user_id === x.id).map((m) => dbGet('organizations', m.organization_id)).filter(Boolean).map((o) => o.name);
  return { id: x.id ?? null, email: x.email ?? null, full_name: x.full_name ?? null, full_name_ar: x.full_name_ar ?? null, role: x.role ?? null,
    active: x.active ?? null, mfa_enabled: x.mfa_enabled ?? null, organizations: jsonAgg(orgs) ?? [], created_at: x.created_at ?? null };
}

// Who an administrator may manage (reset, deactivate): staff accounts only, never patients or family members (they use
// the emailed reset link). A clinic admin manages only doctors, nurses and receptionists of their own clinic.
// (Like the SQL, the answer is NULL rather than false for a staff account when the caller has no role.)
function fn_admin_can_manage(c, p_user) {
  const id = castUuid(p_user);
  const target = dbGet('users', id);
  if (!target || ['patient', 'caregiver'].includes(target.role)) return false;
  const role = _m16_s(c, 'role');
  if (role === null) return null;
  if (role === 'platform_admin') return true;
  if (role !== 'clinic_admin' || !['doctor', 'nurse', 'receptionist'].includes(target.role)) return false;
  const mine = fn_admin_orgs(c);
  return dbExists('memberships', (m) => m.user_id === id && mine.includes(m.organization_id));
}

function fn_users_list(c) {
  const role = _m16_s(c, 'role');
  const me = _m16_uid(c);
  const list = dbWhere('users', (u) => !['patient', 'caregiver'].includes(u.role)
    && (['platform_admin', 'safety_officer'].includes(role) || fn_admin_can_manage(c, u.id) === true || u.id === me));
  return jsonAgg(orderBy(list, (u) => u.role, (u) => u.full_name).map((u) => fn_staff_json(u))) ?? [];
}

// Audit log and AI run list. Platform roles see everything. A clinic admin sees only entries about patients linked
// to their own organizations, or (when no patient is involved) actions by their own staff.
// app.fn_admin_orgs returns setof uuid: an array of organization ids.
function fn_admin_orgs(c) {
  const uid = _m16_uid(c);
  return dbWhere('memberships', (m) => m.user_id === uid).map((m) => m.organization_id);
}

function _m16_limit(d, dflt, max) {
  const n = Math.min(coalesce(castInt(nullif(_m16_s(d, 'limit'), '')), dflt), max);
  if (n < 0) throw new Error('LIMIT must not be negative');
  return n;
}

function fn_admin_audit(c, d) {
  const pidText = nullif(_m16_s(d, 'patient_id'), '');
  const pid = castUuid(pidText);
  const role = _m16_s(c, 'role');
  const limit = _m16_limit(d, 200, 1000);
  let linked = null;
  let staff = null;
  if (role === 'clinic_admin') {
    const orgs = new Set(fn_admin_orgs(c));
    linked = new Set(dbWhere('care_team', (ct) => ct.active && orgs.has(ct.organization_id)).map((ct) => ct.patient_id));
    staff = new Set(dbWhere('memberships', (m) => orgs.has(m.organization_id)).map((m) => m.user_id));
  }
  const rows = dbWhere('audit_logs', (l) => (pidText === null || l.patient_id === pid)
    && (['safety_officer', 'platform_admin'].includes(role)
      || (role === 'clinic_admin' && (l.patient_id !== null ? linked.has(l.patient_id) : l.actor_id !== null && staff.has(l.actor_id)))));
  return jsonAgg(orderBy(rows, [(l) => t(l.at), 'desc']).slice(0, limit).map((l) => {
    const u = dbGet('users', l.actor_id);
    return { at: l.at, actor: u ? u.full_name : null, role: l.actor_role, action: l.action, entity: l.entity, patient_id: l.patient_id };
  })) ?? [];
}

function fn_admin_ai_runs(c, d) {
  const role = _m16_s(c, 'role');
  const limit = _m16_limit(d, 100, 500);
  let linked = null;
  if (role === 'clinic_admin') {
    const orgs = new Set(fn_admin_orgs(c));
    linked = new Set(dbWhere('care_team', (ct) => ct.active && orgs.has(ct.organization_id)).map((ct) => ct.patient_id));
  }
  const rows = dbWhere('ai_runs', (r) => ['safety_officer', 'platform_admin'].includes(role)
    || (role === 'clinic_admin' && r.patient_id !== null && linked.has(r.patient_id)));
  return jsonAgg(orderBy(rows, [(r) => t(r.created_at), 'desc']).slice(0, limit).map((r) => ({
    id: r.id, workflow: r.workflow, patient_id: r.patient_id, status: r.status, model: r.model,
    latency_ms: r.latency_ms, created_at: r.created_at, error: r.error, verifier: r.verifier,
    prompt_version: r.prompt_version,
    // Gate summary only (route, injection verdict, redaction counts, retrieval evidence); never message text.
    gate: _m16_v(r.guard, 'gate'),
    // How the answer was released (approved, withheld, fixed text ...) and the risk signals that decided it.
    release: _m16_s(r.guard, 'release'), risk: coalesce(_m16_v(r.guard, 'risk'), []),
  }))) ?? [];
}

function api_create_user(c, d) {
  let org = castUuid(nullif(_m16_s(d, 'organization_id'), ''));
  const role = _m16_s(d, 'role');
  fn_require_role(c, ['clinic_admin', 'platform_admin']);
  if (role === null || role === 'patient' || role === 'caregiver') fn_raise('bad_request: Use registration for patients.');
  const uid = _m16_uid(c);
  if (_m16_s(c, 'role') === 'clinic_admin') {
    if (!['doctor', 'nurse', 'receptionist'].includes(role)) fn_raise('forbidden: Clinic admins can create doctors, nurses and receptionists.');
    org = coalesce(org, (dbOne('memberships', (m) => m.user_id === uid) || {}).organization_id ?? null);
    if (!dbExists('memberships', (m) => m.user_id === uid && m.organization_id === org)) fn_raise('forbidden: You can only add staff to your own clinic.');
  }
  if (!fn_password_ok(_m16_s(d, 'password'))) fn_raise('bad_request: The password needs at least 8 characters, including letters and numbers.');
  const trimmed = _m16_trim(_m16_s(d, 'email'));
  const email = trimmed === null ? null : trimmed.toLowerCase();
  if (email !== null && dbExists('users', (u) => String(u.email).toLowerCase() === email)) fn_raise('bad_request: This email is already used.');
  const u = dbInsert('users', { email, password_hash: hashPassword(_m16_s(d, 'password')), full_name: _m16_trim(_m16_s(d, 'full_name')),
    full_name_ar: nullif(_m16_s(d, 'full_name_ar'), ''), role, locale: 'ar' });
  if (org !== null) dbInsert('memberships', { user_id: u.id, organization_id: org, role });
  fn_audit(c, 'user.create', 'user', u.id, null, { role });
  return fn_staff_json(u);
}

function api_set_user_active(c, d) {
  fn_require_role(c, ['clinic_admin', 'platform_admin']);
  const target = castUuid(_m16_s(d, 'user_id'));
  const me = _m16_uid(c);
  if (target !== null && target === me) fn_raise('bad_request: You cannot deactivate your own account.');
  if (fn_admin_can_manage(c, target) !== true) fn_raise('not_found: user not found');
  const found = dbGet('users', target);
  const u = dbUpdate('users', found, { active: coalesce(castBool(_m16_s(d, 'active')), found.active) });
  if (!u.active) dbUpdateWhere('sessions', (s) => s.user_id === u.id && !s.revoked, { revoked: true });
  fn_audit(c, u.active ? 'user.activate' : 'user.deactivate', 'user', u.id, null);
  return fn_staff_json(u);
}
