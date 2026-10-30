// 010 Authentication, authorization, audit, and outbox helpers (port of database/migrations/010_fn_auth_access.sql).
// These are the deterministic "Auth Gate" used by every API request.
//
// Notes on the port:
// - Passwords use the runtime's scrypt hashes (hashPassword/checkPassword) instead of pgcrypto bcrypt.
// - Session tokens keep the SQL scheme: the bearer token is 32 random bytes in hex, only its SHA-256 is stored.
// - `now() + interval 'N days'` keeps the Cairo wall-clock time across a daylight-saving change, as Postgres does
//   (_m10_plusDays); hour and minute intervals are absolute.
// - Authorization checks fail closed where the SQL's three-valued logic let a NULL through (a patient context without
//   patient_id, a context without role, a route without roles); none of these can come from fn_auth/fn_user_ctx.
// - fn_request_patient looks up reading_id as the bigint id of glucose_readings (the SQL compared it with a uuid, which
//   made Postgres fail every call that reached that lookup).

const _M10_CLINICAL = ['doctor', 'nurse', 'receptionist', 'clinic_admin'];
const _M10_FAST_EVENTS = ['HypoglycemiaDetected', 'HyperglycemiaDetected', 'PasswordResetRequested', 'CaregiverInviteEmailRequested',
  'AccountSecurityNotice', 'ReferralCreated', 'ReferralStatusChanged', 'TransferStatusChanged', 'FacilityCapacityUpdated'];
const _M10_FAMILY_ACCESS_DENIED = 'forbidden: Your family access does not allow this. The patient can change it under Care, Family.';

/* ------------------------------------------------------------------------------------------- private helpers */

function _m10_isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
/** v -> 'key' (object field; null for a missing field or a value that is not an object). */
function _m10_get(v, key) { return _m10_isObj(v) && Object.prototype.hasOwnProperty.call(v, key) && v[key] !== undefined ? v[key] : null; }
/** v ->> 'key' */
function _m10_text(v, key) { return jtext(_m10_get(v, key)); }
/** jsonb ? key: an object key, a string element of an array, or the string itself. NULL key -> null. */
function _m10_hasKey(v, key) {
  if (key === null || key === undefined || v === undefined) return null;
  if (_m10_isObj(v)) return Object.prototype.hasOwnProperty.call(v, key);
  if (Array.isArray(v)) return v.some((x) => typeof x === 'string' && x === key);
  return typeof v === 'string' && v === key;
}
/** jsonb_array_length */
function _m10_arrayLength(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.length;
  throw new Error(_m10_isObj(v) ? 'cannot get array length of a non-array' : 'cannot get array length of a scalar');
}
/** jsonb - text[] */
function _m10_minus(v, keys) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.filter((x) => !(typeof x === 'string' && keys.includes(x)));
  if (_m10_isObj(v)) return omit(v, keys);
  throw new Error('cannot delete from scalar');
}
/** trim() of Postgres: spaces only. */
function _m10_trim(s) { return s === null || s === undefined ? null : trimChars(String(s), ' '); }
function _m10_lower(s) { return s === null || s === undefined ? null : String(s).toLowerCase(); }
/** ts + n days in Africa/Cairo: the wall-clock time stays the same across a daylight-saving change. */
function _m10_plusDays(ts, n) {
  const p = cairoParts(ts);
  const two = (x) => String(x).padStart(2, '0');
  const d = addDays(`${p.y}-${two(p.mo)}-${two(p.d)}`, n);
  return castTs(`${d} ${two(p.h)}:${two(p.mi)}:${two(p.s)}.${String(p.ms).padStart(3, '0')}`);
}
/** (scope = any(scopes) or 'manage' = any(scopes)) with SQL NULL semantics: true, false or null. */
function _m10_scopeOk(scopes, scope) {
  if (!Array.isArray(scopes)) return null;
  if (scopes.includes('manage')) return true;
  if (scope === null || scope === undefined) return null;
  if (scopes.includes(scope)) return true;
  return scopes.includes(null) ? null : false;
}
/** An exception raised by fn_raise (SQLSTATE P0001): "<code>: <message>". Casts and engine errors are not. */
function _m10_isRaise(e) {
  if (!e || typeof e.message !== 'string') return false;
  if (e.sqlstate === 'P0001' || e.code === 'P0001') return true;
  return /^[a-z_]+: /.test(e.message) && !/^engine: /.test(e.message);
}

/* ---------------------------------------------------------------------------------------------- functions */

// bcrypt with cost 11 in SQL; here the runtime's scrypt hash (crypt(NULL, ...) is NULL).
function fn_hash_password(p) {
  if (p === null || p === undefined) return null;
  return hashPassword(p);
}

// Sessions are stored as the SHA-256 of the bearer token; the token itself only exists on the person's device.
function fn_session_key(p_header) {
  const tok = _m10_trim(regexpReplace(coalesce(p_header, ''), '^Bearer\\s+', '', 'i'));
  return tok === '' ? '' : sha256(tok);
}

// Session context returned to n8n. Null means unauthenticated.
function fn_user_ctx(p_user_id) {
  const u = dbGet('users', castUuid(p_user_id));
  if (!u || u.active !== true) return null;
  const patient = dbOne('patients', (p) => p.user_id === u.id);
  const grants = dbWhere('caregiver_grants', (g) => g.caregiver_user_id === u.id && g.active === true);
  const cgPatients = [];
  for (const g of grants) {
    const p = dbGet('patients', g.patient_id);
    if (p) cgPatients.push({ id: p.id, full_name: p.full_name, full_name_ar: p.full_name_ar, scopes: Array.isArray(g.scopes) ? [...g.scopes] : g.scopes });
  }
  return {
    user_id: u.id,
    email: u.email,
    full_name: u.full_name,
    full_name_ar: u.full_name_ar,
    role: u.role,
    locale: u.locale,
    mfa_enabled: u.mfa_enabled,
    must_change_password: u.must_change_password,
    patient_id: patient ? patient.id : null,
    organization_ids: dbWhere('memberships', (m) => m.user_id === u.id).map((m) => m.organization_id),
    caregiver_patient_ids: grants.map((g) => g.patient_id),
    caregiver_patients: cgPatients,
  };
}

function fn_session_json(p_user_id) {
  const id = castUuid(p_user_id);
  const ctx = fn_user_ctx(id);
  if (ctx === null) return null;
  return { ...omit(ctx, 'user_id'), id };
}

// Lifetimes come from the session_policy rule: patients and family members stay signed in on their own phone;
// staff sessions are short and end after a period without activity.
function fn_new_session(p_user_id, p_action) {
  const token = randomHex(32);
  const uid = castUuid(p_user_id);
  const u = dbGet('users', uid);
  const family = u ? u.role === 'patient' || u.role === 'caregiver' : null;
  const p = coalesce(fn_rule('session_policy'), {});
  const num = (k, d) => coalesce(castInt(_m10_text(p, k)), d);
  dbInsert('sessions', {
    token: fn_session_key(token),
    user_id: uid,
    expires_at: family ? _m10_plusDays(now(), num('patient_days', 30)) : later(num('staff_hours', 12) * HOUR),
    idle_minutes: family ? num('patient_idle_days', 14) * 1440 : num('staff_idle_minutes', 60),
  });
  if (u) dbInsert('audit_logs', { actor_id: u.id, actor_role: u.role, action: p_action ?? null, entity: 'user', entity_id: u.id });
  return { token, user: fn_session_json(uid) };
}

// Throttling helpers. Functions that must record a failure and still report it return {"__error": {code, message}}
// instead of raising, because raising would roll the record back; the API maps __error to an error response.
// p_window: milliseconds.
function fn_throttled(p_key, p_max, p_window) {
  const since = t(now()) - p_window;
  const n = dbCount('auth_events', (e) => p_key !== null && e.key === p_key && e.at !== null && t(e.at) > since);
  if (p_max === null || p_max === undefined) return null;
  return n >= p_max;
}

// Arabic version of a message sent to people (error_messages; the longest matching pattern wins).
function fn_message_ar(p_text) {
  const text = coalesce(p_text, '');
  let best = null, bestLen = -1;
  for (const m of dbRows('error_messages')) {
    const len = Array.from(m.pattern).length;
    if (len > bestLen && reTest(text, m.pattern)) { best = m; bestLen = len; }
  }
  return best ? best.message_ar : null;
}

// A refusal recorded by the function itself (wrong password, throttling): {__error: {code, message, message_ar}}.
function fn_err(p_code, p_message) {
  const text = p_code === null || p_code === undefined || p_message === null || p_message === undefined ? null : `${p_code}: ${p_message}`;
  return { __error: { code: p_code ?? null, message: p_message ?? null, message_ar: fn_message_ar(text) } };
}

// An Auth Gate refusal. A message raised by a database function may carry its Arabic text after " ¦ ".
function fn_gate_error(p_code, p_message) {
  const msg = splitPart(p_message, ' ¦ ', 1);
  const ar = nullif(splitPart(p_message, ' ¦ ', 2), '');
  return {
    action: '__error',
    error: {
      code: p_code ?? null,
      message: msg,
      message_ar: coalesce(ar, fn_message_ar(p_code === null || p_code === undefined || msg === null ? null : `${p_code}: ${msg}`)),
    },
  };
}

// Failed sign-ins are limited per (e-mail, client address): 8 in 15 minutes, so someone who knows an address cannot lock
// its owner out from elsewhere; and per e-mail from all addresses together: 50 in 15 minutes, against guessing spread
// over many addresses. p_client defaults to the address the Auth Gate saw (DB.settings['app.client']).
const _M10_LOGIN_PER_CLIENT = 8, _M10_LOGIN_PER_EMAIL = 50;
function fn_login(p_email, p_password, p_client = null) {
  const emailHash = md5(_m10_lower(_m10_trim(coalesce(p_email, ''))));
  const client = coalesce(nullif(_m10_trim(coalesce(p_client, DB && DB.settings ? DB.settings['app.client'] : null, '')), ''), 'unknown');
  const key = 'login:' + emailHash + ':' + md5(client);
  const since = t(now()) - 15 * MIN;
  const prefix = 'login:' + emailHash;
  const forEmail = dbCount('auth_events', (e) => e.key !== null && (e.key === prefix || String(e.key).startsWith(prefix + ':')) && e.at !== null && t(e.at) > since);
  if (fn_throttled(key, _M10_LOGIN_PER_CLIENT, 15 * MIN) || forEmail >= _M10_LOGIN_PER_EMAIL) {
    return fn_err('too_many_requests', 'Too many sign-in attempts. Please wait 15 minutes and try again.');
  }
  const email = _m10_lower(_m10_trim(p_email));
  const user = email === null || p_password === null || p_password === undefined ? null
    : dbOne('users', (u) => u.email !== null && _m10_lower(u.email) === email && u.active === true && checkPassword(p_password, u.password_hash));
  if (!user) {
    dbInsert('auth_events', { key });
    dbInsert('audit_logs', { action: 'auth.login_failed', entity: 'user', detail: { email_hash: emailHash } });
    return fn_err('unauthorized', 'Invalid email or password');
  }
  if (user.mfa_enabled === true) {
    const token = randomHex(24);
    const nowT = t(now());
    dbDeleteWhere('mfa_challenges', (c) => c.user_id === user.id || (c.expires_at !== null && t(c.expires_at) < nowT));
    dbInsert('mfa_challenges', { token, user_id: user.id });
    return { mfa_required: true, mfa_token: token };
  }
  return fn_new_session(user.id, 'auth.login');
}

// Accepts "Bearer <token>" or the raw token. A session ends at its expiry or after idle_minutes without use; the
// last-use time is written at most once a minute.
function fn_auth(p_header) {
  const key = fn_session_key(p_header);
  if (key === '') return null;
  const nowT = t(now());
  const s = dbGet('sessions', key);
  if (!s || s.revoked !== false || s.expires_at === null || !(t(s.expires_at) > nowT)) return null;
  if (s.idle_minutes !== null && !(s.last_seen_at !== null && t(s.last_seen_at) > nowT - s.idle_minutes * MIN)) return null;
  if (s.user_id === null) return null;
  if (s.last_seen_at !== null && t(s.last_seen_at) < nowT - MIN) dbUpdate('sessions', s, { last_seen_at: now() });
  return fn_user_ctx(s.user_id);
}

// p_session_key is the hashed token the Auth Gate passes as __token.
function fn_logout(p_session_key) {
  if (coalesce(p_session_key, '') === '') return;
  const s = dbGet('sessions', p_session_key);
  if (s) dbUpdate('sessions', s, { revoked: true });
}

function fn_is_clinical(p_role) {
  if (p_role === null || p_role === undefined) return null;
  return _M10_CLINICAL.includes(p_role);
}

// Patient-level authorization. Platform admins have no default clinical access.
// Role 'system' (no user_id) is used only by scheduled workflows; clients can never obtain it because every API
// context comes from fn_auth().
// Differs from SQL: a patient context without patient_id gives false (SQL: NULL, which `if not ...` let through).
function fn_can_access_patient(p_ctx, p_patient_id) {
  const pid = castUuid(p_patient_id);
  const role = _m10_text(p_ctx, 'role');
  const uid = castUuid(nullif(_m10_text(p_ctx, 'user_id'), ''));
  if (p_ctx === null || p_ctx === undefined || pid === null) return false;
  if (role === 'system' && _m10_text(p_ctx, 'user_id') === null) return true;
  if (role === 'patient') {
    const own = castUuid(_m10_text(p_ctx, 'patient_id'));
    return own !== null && own === pid;
  }
  if (role === 'caregiver') {
    return dbExists('caregiver_grants', (g) => uid !== null && g.caregiver_user_id === uid && g.patient_id === pid && g.active === true);
  }
  if (fn_is_clinical(role)) {
    const orgs = uid === null ? [] : dbWhere('memberships', (m) => m.user_id === uid).map((m) => m.organization_id);
    const nowT = t(now());
    return dbExists('care_team', (ct) => ct.patient_id === pid && ct.active === true
        && ((uid !== null && ct.user_id === uid) || (ct.organization_id !== null && orgs.includes(ct.organization_id))))
      || dbExists('access_grants', (g) => uid !== null && g.user_id === uid && g.patient_id === pid && g.expires_at !== null && t(g.expires_at) > nowT);
  }
  return false;
}

// Resolves which patient a request targets and enforces access. Raises 'forbidden' so the API returns a clean error.
function fn_resolve_patient(p_ctx, p_data) {
  let pid = castUuid(nullif(_m10_text(p_data, 'patient_id'), ''));
  const role = _m10_text(p_ctx, 'role');
  if (pid === null && role === 'patient') {
    pid = castUuid(_m10_text(p_ctx, 'patient_id'));
  }
  if (pid === null && role === 'caregiver' && _m10_arrayLength(_m10_get(p_ctx, 'caregiver_patient_ids')) === 1) {
    pid = castUuid(jtext(p_ctx.caregiver_patient_ids[0]));
  }
  if (pid === null) {
    fn_raise('bad_request: patient_id is required');
  }
  if (!fn_can_access_patient(p_ctx, pid)) {
    fn_raise('forbidden: no access to this patient');
  }
  return pid;
}

// Differs from SQL: a context without role is refused (SQL: `NULL = any(...)` let it pass).
function fn_require_role(p_ctx, p_roles) {
  const role = _m10_text(p_ctx, 'role');
  if (!(role !== null && Array.isArray(p_roles) && p_roles.includes(role))) {
    fn_raise(`forbidden: role ${role ?? ''} cannot perform this action`);
  }
}

// Caregiver scopes: read (see the record) < log (daily logging, appointments, messages, Care Access, Companion)
// < manage (change the record). Patient-only actions use the pseudo-scope 'self'.
function fn_require_scope(p_ctx, p_patient_id, p_scope) {
  const pid = castUuid(p_patient_id);
  const role = _m10_text(p_ctx, 'role');
  if ((role !== null && role !== 'caregiver') || p_scope === 'read') return;
  const uid = castUuid(_m10_text(p_ctx, 'user_id'));
  if (!dbExists('caregiver_grants', (g) => uid !== null && g.caregiver_user_id === uid && g.patient_id === pid && g.active === true
      && _m10_scopeOk(g.scopes, p_scope) === true)) {
    fn_raise(_M10_FAMILY_ACCESS_DENIED);
  }
}

// The patient a request is about, from patient_id or from the id of the record it changes.
// reading_id is the bigint id of glucose_readings (see the file header).
function fn_request_patient(p_ctx, p_data) {
  if (nullif(_m10_text(p_data, 'patient_id'), '') !== null) return castUuid(_m10_text(p_data, 'patient_id'));
  const byId = (key) => castUuid(nullif(_m10_text(p_data, key), ''));
  const patientOf = (row) => (row ? row.patient_id : null);
  // coalesce(...) stops at the first record found, so later ids are not read.
  const lookups = [
    () => { const id = byId('medication_id'); return id === null ? null : patientOf(dbGet('medications', id)); },
    () => { const id = byId('condition_id'); return id === null ? null : patientOf(dbGet('conditions', id)); },
    () => { const id = byId('allergy_id'); return id === null ? null : patientOf(dbGet('allergies', id)); },
    () => { const id = castInt(nullif(_m10_text(p_data, 'reading_id'), '')); return id === null ? null : patientOf(dbGet('glucose_readings', id)); },
    () => { const id = byId('appointment_id'); return id === null ? null : patientOf(dbGet('appointments', id)); },
    () => { const id = byId('task_id'); return id === null ? null : patientOf(dbGet('care_tasks', id)); },
    () => { const id = byId('episode_id'); return id === null ? null : patientOf(dbGet('episodes', id)); },
    () => { const id = byId('referral_id'); return id === null ? null : patientOf(dbGet('referrals', id)); },
  ];
  let v = null;
  for (const look of lookups) { v = look(); if (v !== null && v !== undefined) break; v = null; }
  if (v === null && _m10_text(p_ctx, 'role') === 'caregiver' && _m10_arrayLength(coalesce(_m10_get(p_ctx, 'caregiver_patient_ids'), [])) === 1) {
    v = castUuid(jtext(p_ctx.caregiver_patient_ids[0]));
  }
  return v;
}

// Route-level scope check (the Auth Gate applies the route's scope). Returns the context unchanged.
// A caregiver whose target patient cannot be determined needs the scope on every record they follow.
// Differs from SQL: 'self' refuses a context without role (SQL: `NULL <> 'patient'` let it pass).
function fn_scope_ctx(p_ctx, p_data, p_scope) {
  const role = _m10_text(p_ctx, 'role');
  if (p_scope === 'self') {
    if (role !== 'patient') fn_raise('forbidden: Only the patient can do this.');
    return p_ctx;
  }
  if (role === 'caregiver' && p_scope !== null && p_scope !== undefined && p_scope !== 'read') {
    const pid = fn_request_patient(p_ctx, p_data);
    if (pid !== null) {
      fn_require_scope(p_ctx, pid, p_scope);
    } else {
      const uid = castUuid(_m10_text(p_ctx, 'user_id'));
      if (dbExists('caregiver_grants', (g) => uid !== null && g.caregiver_user_id === uid && g.active === true && _m10_scopeOk(g.scopes, p_scope) === false)) {
        fn_raise(_M10_FAMILY_ACCESS_DENIED);
      }
    }
  }
  return p_ctx;
}

// Role-based projection of read models: receptionists see administrative fields only (no diagnosis, pregnancy,
// exclusions, appointment reasons or specialist reports); patients and family members do not see staff user ids.
function fn_for_role(p_ctx, p_kind, p_json) {
  const role = _m10_text(p_ctx, 'role');
  if (p_json === null || p_json === undefined) return null;
  if (Array.isArray(p_json)) return p_json.map((x) => fn_for_role(p_ctx, p_kind, x));
  if (p_kind === 'patient') {
    if (role === 'receptionist') {
      return _m10_minus(p_json, ['diabetes_type', 'diagnosis_year', 'height_cm', 'pregnant', 'uses_insulin_pump', 'tier', 'exclusions']);
    } else if ((role === 'patient' || role === 'caregiver') && Array.isArray(_m10_get(p_json, 'care_team'))) {
      return { ...p_json, care_team: p_json.care_team.map((m) => _m10_minus(m, ['user_id'])) };
    }
  } else if ((p_kind === 'appointment' || p_kind === 'referral') && role === 'receptionist') {
    return _m10_minus(p_json, ['reason', 'report']);
  }
  return p_json;
}

function fn_audit(p_ctx, p_action, p_entity, p_entity_id, p_patient_id, p_detail = {}) {
  dbInsert('audit_logs', {
    actor_id: castUuid(_m10_text(p_ctx, 'user_id')),
    actor_role: _m10_text(p_ctx, 'role'),
    action: p_action ?? null,
    entity: p_entity ?? null,
    entity_id: p_entity_id ?? null,
    patient_id: castUuid(p_patient_id),
    detail: coalesce(p_detail, {}),
  });
}

// Returns the event id (pg_notify is dropped: the dispatcher polls).
function fn_emit(p_event_type, p_patient_id, p_resource_id, p_payload = {}) {
  const row = dbInsert('outbox', {
    event_type: p_event_type ?? null,
    patient_id: castUuid(p_patient_id),
    resource_id: p_resource_id ?? null,
    payload: coalesce(p_payload, {}),
  });
  return row.event_id;
}

// Error text kept for operators (outbox.last_error, incidents): internal ids, email addresses and long digit runs (phone,
// national id, MRN numbers) are replaced, so a consumer's error message never stores identifiers.
function fn_redact_error(p) {
  let s = coalesce(p, '');
  s = regexpReplace(s, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<id>', 'gi');
  s = regexpReplace(s, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', '<email>', 'g');
  s = regexpReplace(s, '\\d[\\d\\s-]{6,}\\d', '<number>', 'g');
  return left(s, 500);
}

// How long one claim of an event may run before another dispatcher run may take it over (milliseconds). Model-heavy
// consumers on a CPU server (document reading, knowledge-base ingestion) get longer leases.
function fn_event_lease(p_event_type) {
  switch (p_event_type) {
    case 'DocumentUploaded': return 25 * MIN;
    case 'RagDocumentApproved': return 40 * MIN;
    case 'GlucosePatternDetected': return 15 * MIN;
    case 'LabResultVerified': return 15 * MIN;
    default: return 10 * MIN;
  }
}

// Deterministic consumers that must never wait behind slow AI work (safety alerts, emails, network updates).
function fn_event_is_fast(p_event_type) {
  if (p_event_type === null || p_event_type === undefined) return null;
  return _M10_FAST_EVENTS.includes(p_event_type);
}

// Event Dispatcher claim: skips event types without a consumer in bulk, gives up events whose last attempt lost its
// lease, then claims up to p_limit events. Fast deterministic events (safety alerts first) are always claimed; model
// work is capped at p_max_inflight across overlapping dispatcher runs. Every claim gets a new token and a lease.
// The rows come back in claim priority (safety alerts first, then oldest first); SQL's RETURNING order is unspecified.
function fn_claim_events(p_limit = 5, p_routes = null, p_max_inflight = 6) {
  const nowT = t(now());
  if (p_routes !== null && p_routes !== undefined) {
    dbUpdateWhere('outbox', (o) => o.status === 'pending' && _m10_hasKey(p_routes, o.event_type) === false,
      { status: 'skipped', processed_at: now() });
  }
  // A last attempt whose lease ran out (the run died) is failed for good instead of staying in processing forever.
  dbUpdateWhere('outbox', (o) => o.status === 'processing' && o.attempts >= 5 && o.lease_until !== null && t(o.lease_until) < nowT,
    (o) => ({ status: 'failed', processed_at: now(), last_error: coalesce(o.last_error, '') + ' [lease expired on the last attempt]' }));
  const inflight = dbCount('outbox', (o) => o.status === 'processing' && o.lease_until !== null && t(o.lease_until) > nowT
    && fn_event_is_fast(o.event_type) === false);
  const slow = p_max_inflight === null || p_max_inflight === undefined ? 0 : Math.max(p_max_inflight - inflight, 0);
  const locked = orderBy(dbWhere('outbox', (o) => (o.status === 'pending' || (o.status === 'processing' && o.lease_until !== null && t(o.lease_until) < nowT))
    && o.attempts < 5 && o.next_attempt_at !== null && t(o.next_attempt_at) <= nowT), (o) => t(o.occurred_at)).slice(0, 200);
  const urgent = (o) => (o.event_type === 'HypoglycemiaDetected' || o.event_type === 'HyperglycemiaDetected' ? 1 : 0);
  const ranked = orderBy(locked, [urgent, 'desc'], (o) => t(o.occurred_at));
  const fastCap = p_limit === null || p_limit === undefined ? -1 : p_limit;
  const slowCap = p_limit === null || p_limit === undefined ? slow : Math.min(p_limit, slow);     // least() ignores NULL
  let nFast = 0, nSlow = 0;
  const chosen = [];
  for (const o of ranked) {
    if (fn_event_is_fast(o.event_type)) { nFast++; if (nFast <= fastCap) chosen.push(o); }
    else { nSlow++; if (nSlow <= slowCap) chosen.push(o); }
  }
  return chosen.map((o) => {
    dbUpdate('outbox', o, {
      status: 'processing', claimed_at: now(), attempts: o.attempts + 1,
      claim_token: uuid(), lease_until: later(fn_event_lease(o.event_type)),
    });
    return {
      event_id: o.event_id, event_type: o.event_type, patient_id: o.patient_id, resource_id: o.resource_id,
      payload: o.payload, attempts: o.attempts, occurred_at: o.occurred_at,
      workflow_id: p_routes === null || p_routes === undefined ? null : _m10_text(p_routes, o.event_type),
      claim_token: o.claim_token,
    };
  });
}

// Heartbeat taken when the event runner actually starts an event: events waiting in a sequential batch are not
// mistaken for stuck ones, and the lease restarts. Returns false when another run already finished or re-claimed the
// event (the claim token no longer matches).
function fn_event_start(p_event_id, p_token = null) {
  const id = castUuid(p_event_id);
  const tok = castUuid(p_token);
  const o = dbGet('outbox', id);
  if (!o || o.status !== 'processing' || (tok !== null && o.claim_token !== tok)) return false;
  dbUpdate('outbox', o, { claimed_at: now(), lease_until: later(fn_event_lease(o.event_type)) });
  return true;
}

// Records the outcome of one claim. Only the run that holds the current claim token may complete the event.
function fn_complete_event(p_event_id, p_ok, p_error = null, p_token = null) {
  const id = castUuid(p_event_id);
  const tok = castUuid(p_token);
  const ok = castBool(p_ok) === true;
  const o = dbGet('outbox', id);
  if (!o || o.status !== 'processing' || (tok !== null && o.claim_token !== tok)) return;
  dbUpdate('outbox', o, {
    status: ok ? 'done' : o.attempts >= 5 ? 'failed' : 'pending',
    last_error: p_error === null || p_error === undefined ? null : fn_redact_error(p_error),
    // back-off: 1, 2, 4, 8 minutes, so a short outage of a model or of Ollama does not burn all attempts
    next_attempt_at: ok ? o.next_attempt_at : later(MIN * Math.pow(2, Math.max(o.attempts - 1, 0))),
    processed_at: ok || o.attempts >= 5 ? now() : o.processed_at,
    lease_until: null,
  });
}

// Inbox routing: fan out to the patient's care team organization.
function fn_create_inbox_item(p_patient_id, p_category, p_urgency, p_priority, p_title, p_body, p_payload, p_dedupe_key = null) {
  const pid = castUuid(p_patient_id);
  // A patient without a diabetes doctor is covered by the on-call diabetes clinic (41_doctor_match.js, rule
  // diabetes_oncall); a patient linked only to another specialty keeps that doctor, and the on-call clinic gets the
  // item too.
  const cover = pid === null ? null : fn_ensure_diabetes_cover(pid);
  const team = orderBy(dbWhere('care_team', (ct) => pid !== null && ct.patient_id === pid && ct.active === true),
    [(ct) => (ct.role === null ? null : ct.role === 'doctor' ? 1 : 0), 'desc']);
  const org = team.length ? team[0].organization_id : null;
  if (org === null) {
    return null;  // no clinician inbox (no care team and no on-call cover)
  }
  const item = (o, key) => dbInsert('inbox_items', {
    patient_id: pid, organization_id: o, category: p_category ?? null, urgency: p_urgency ?? null, priority: p_priority ?? null,
    title: p_title ?? null, body: p_body ?? null, payload: coalesce(p_payload, {}), dedupe_key: key, status: 'ROUTED',
  }, { onConflict: 'nothing' });
  const row = item(org, p_dedupe_key ?? null);
  if (cover !== null && cover !== org) item(cover, p_dedupe_key ? `${p_dedupe_key}:oncall` : null);
  return row ? row.id : null;
}

// Notifies the patient and active caregivers. Titles/bodies are stored in English and Arabic; the app shows the user's language.
function fn_notify_patient(p_patient_id, p_kind, p_title, p_body, p_dedupe_key = null, p_title_ar = null, p_body_ar = null) {
  const pid = castUuid(p_patient_id);
  if (pid === null) return;
  const recipients = [];
  const p = dbGet('patients', pid);
  if (p && p.user_id !== null) recipients.push(p.user_id);
  for (const g of dbWhere('caregiver_grants', (x) => x.patient_id === pid && x.active === true)) {
    if (!recipients.includes(g.caregiver_user_id)) recipients.push(g.caregiver_user_id);
  }
  for (const u of recipients) {
    dbInsert('notifications', {
      user_id: u, patient_id: pid, kind: p_kind ?? null, title: p_title ?? null, body: p_body ?? null,
      dedupe_key: p_dedupe_key === null || p_dedupe_key === undefined ? null : `${p_dedupe_key}:${u}`,
      title_ar: p_title_ar ?? null, body_ar: p_body_ar ?? null,
    }, { onConflict: 'nothing' });
  }
}

// Auth Gate used by every API request: authenticates the session, checks that the action exists and that the caller's
// role may call it, and normalizes the request data. p_routes is the route table of the group ({action: {roles,
// public, scope}}); p_client the client address (X-Real-IP / X-Forwarded-For).
// Differs from SQL: a route without "roles" refuses every signed-in caller (SQL let them through).
function fn_gate(p_header, p_action, p_data, p_routes, p_client = null) {
  const ctx = fn_auth(p_header);
  const actionKey = coalesce(p_action, '');
  // Own keys only: an action named "constructor" or "__proto__" is unknown, not a property of every object.
  const route = _m10_isObj(p_routes) && Object.prototype.hasOwnProperty.call(p_routes, actionKey) && p_routes[actionKey] !== undefined
    ? p_routes[actionKey] : undefined;
  let data = _m10_isObj(p_data) ? p_data : {};
  const token = fn_session_key(p_header);
  const pub = 'pub:' + coalesce(nullif(_m10_trim(splitPart(coalesce(p_client, ''), ',', 1)), ''), 'unknown');
  // The client address for the rest of the request (fn_login limits failed sign-ins per e-mail and address).
  if (DB) DB.settings = { ...(DB.settings || {}), 'app.client': pub.slice(4) };
  if (route === undefined) {
    return fn_gate_error('unknown_action', 'Unknown action "' + left(String(actionKey), 60) + '"');
  }
  if (coalesce(castBool(_m10_text(route, 'public')), false)) {
    // Public actions (sign-in, sign-up, second factor): limit calls per client address.
    if (fn_throttled(pub, 300, 15 * MIN)) {
      return fn_gate_error('too_many_requests', 'Too many requests. Please wait a few minutes and try again.');
    }
    dbInsert('auth_events', { key: pub });
  } else {
    if (ctx === null) {
      return fn_gate_error('unauthorized', 'Sign in required');
    }
    const roles = _m10_isObj(route) && Object.prototype.hasOwnProperty.call(route, 'roles') ? route.roles : undefined;
    const role = _m10_text(ctx, 'role');
    if (roles === undefined || roles === null || (roles !== '*' && _m10_hasKey(roles, role) !== true)) {
      return fn_gate_error('forbidden', 'Your role cannot do this');
    }
    // After a password reset by an administrator, the person must choose a new password before anything else.
    if (coalesce(castBool(_m10_text(ctx, 'must_change_password')), false) && p_action !== null && p_action !== undefined
        && !['me', 'logout', 'change_password'].includes(p_action)) {
      return fn_gate_error('password_change_required', 'Please choose a new password to continue.');
    }
    // Optional policy (feature flag require_staff_mfa): staff must enable two-factor sign-in before using anything else.
    if (role !== null && !['patient', 'caregiver'].includes(role) && !coalesce(castBool(_m10_text(ctx, 'mfa_enabled')), false)
        && p_action !== null && p_action !== undefined && !['me', 'logout', 'mfa_setup', 'mfa_enable', 'change_password'].includes(p_action)) {
      const flag = dbGet('feature_flags', 'require_staff_mfa');
      if (coalesce(flag ? flag.enabled : null, false)) {
        return fn_gate_error('mfa_required', 'Turn on two-factor sign-in in your account settings to continue.');
      }
    }
    // Family members act within the scopes the patient gave them (read, log, manage); 'self' actions are the patient's
    // alone. The route table (workflows/src/api-routes.mjs) names the scope of each action.
    if (_m10_hasKey(route, 'scope') === true) {
      let refused = null;
      dbTry(() => fn_scope_ctx(ctx, data, _m10_text(route, 'scope')), (e) => {
        if (!_m10_isRaise(e)) throw e;
        refused = fn_gate_error('forbidden', regexpReplace(e.message, '^forbidden:\\s*', ''));
      });
      if (refused) return refused;
    }
  }
  if (p_action === 'logout' || p_action === 'change_password') {
    data = { ...data, __token: token };
  }
  return { action: p_action ?? null, ctx: coalesce(ctx, {}), data };
}
