// 014 Transactional write units called by the API (port of database/migrations/014_fn_api_writes.sql).
// Each function takes (ctx, data), authorizes, writes, audits, emits events, and returns the read model.
//
// Notes on the port:
// - Exceptions raised with fn_raise carry sqlstate 'P0001' (the SQL's errcode) and the Arabic text after " ¦ ".
// - set_config('app.actor_role', …, true) (api_stop_medication) is kept for the rest of the request in
//   DB.settings['app.actor_role']; fn_medication_safety (012) reads it there instead of current_setting().
// - `now() ± interval 'N days'` / '1 year' keep the Cairo wall-clock time across a daylight-saving change, as Postgres
//   does (_m14_plusDays, _m14_plusMonths); minute and hour intervals are absolute.
// - Date/time text is checked like Postgres ('2026-13-45' is out of range) before the runtime's castTs (_m14_castTs).
// - Numbers have no scale in JavaScript: a numeric value prints without trailing zeros (7.40 -> 7.4) except where the
//   SQL printed a value rounded to 2 decimals or the text the person typed (lab messages and inbox titles keep that).
// - jsonb_agg(DISTINCT …) and jsonb_each order like Postgres: jsonb key order (shorter keys first) and an approximation
//   of the database collation (en_US: punctuation and case ignored first) for text (_m14_collate).
// - fn_meal_json reads fn_meal_responses(patient, 400) once per summary instead of once per meal (same result).
// - Rows written in one request share now(); "latest row" lookups (ORDER BY created_at DESC) break such ties by
//   insertion order, newest first (_m14_newest), which is what the SQL meant (in Postgres the order among equal
//   timestamps depended on the plan).

const _M14_TIME = '^([01][0-9]|2[0-3]):[0-5][0-9]$';
const _M14_NUM = '^[0-9]+(\\.[0-9]+)?$';
const _M14_SNUM = '^-?[0-9]+(\\.[0-9]+)?$';
const _M14_TARGET_SPEC = {
  fasting_low: [60, 130], fasting_high: [80, 200], post_meal_high: [120, 300], tir_target: [30, 100],
  hba1c_target: [5, 12], bp_systolic: [90, 180], bp_diastolic: [50, 110], steps_target: [500, 30000],
  tbr_max: [0.5, 10],
};

/* ------------------------------------------------------------------------------------------- private helpers */

function _m14_isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function _m14_own(v, k) { return _m14_isObj(v) && Object.prototype.hasOwnProperty.call(v, k) && v[k] !== undefined; }
/** v -> 'k' */
function _m14_get(v, k) { return _m14_own(v, k) ? v[k] : null; }
/** v ->> 'k' */
function _m14_txt(v, k) { return jtext(_m14_get(v, k)); }
/** Postgres trim()/btrim(): spaces only. */
function _m14_trim(s) { return s === null || s === undefined ? null : trimChars(String(s), ' '); }
/** rtrim(s, chars) */
function _m14_rtrim(s, chars) {
  if (s === null || s === undefined) return null;
  const set = new Set(Array.from(chars));
  const a = Array.from(String(s));
  let j = a.length;
  while (j > 0 && set.has(a[j - 1])) j--;
  return a.slice(0, j).join('');
}
/** text || text || …: NULL when any part is NULL. */
function _m14_cc(...parts) {
  if (parts.some((p) => p === null || p === undefined)) return null;
  return parts.map((p) => (typeof p === 'number' ? _m14_num(p) : String(p))).join('');
}
/** replace(s, from, to) */
function _m14_replace(s, from, to) {
  if (s === null || s === undefined || from === null || to === null || to === undefined) return null;
  return String(s).split(from).join(String(to));
}
/** x IN (list) with SQL NULL: null when x is NULL. */
function _m14_in(x, list) { return x === null || x === undefined ? null : list.includes(x); }
/** jsonb ? key */
function _m14_has(v, k) {
  if (v === null || v === undefined || k === null || k === undefined) return false;
  if (_m14_isObj(v)) return Object.prototype.hasOwnProperty.call(v, k);
  if (Array.isArray(v)) return v.some((x) => typeof x === 'string' && x === k);
  return typeof v === 'string' && v === k;
}
/** jsonb_array_elements(v): a NULL gives no rows; objects and scalars fail as in Postgres. */
function _m14_elems(v) {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  throw new Error(_m14_isObj(v) ? 'cannot extract elements from an object' : 'cannot extract elements from a scalar');
}
/** jsonb_array_elements_text(v) */
function _m14_elemsText(v) { return _m14_elems(v).map((x) => jtext(x)); }
/** jsonb_array_elements(coalesce(d->'k', '[]')): a JSON null in the request is a jsonb null, which is not an array. */
function _m14_itemsOf(d, k) {
  if (!_m14_own(d, k)) return [];
  if (d[k] === null) throw new Error('cannot extract elements from a scalar');
  return _m14_elems(d[k]);
}
/** jsonb || jsonb */
function _m14_jcat(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (_m14_isObj(a) && _m14_isObj(b)) return { ...a, ...b };
  return [...(Array.isArray(a) ? a : [a]), ...(Array.isArray(b) ? b : [b])];
}
/** jsonb - 'key' */
function _m14_minus(v, k) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.filter((x) => !(typeof x === 'string' && x === k));
  if (_m14_isObj(v)) return omit(v, k);
  throw new Error('cannot delete from scalar');
}
/** jsonb a @> b */
function _m14_contains(a, b) {
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return !_m14_isObj(b) && a.some((x) => _m14_contains(x, b));
    return b.every((y) => a.some((x) => (Array.isArray(y) ? Array.isArray(x) && _m14_contains(x, y) : _m14_contains(x, y))));
  }
  if (_m14_isObj(a)) return _m14_isObj(b) && Object.keys(b).every((k) => Object.prototype.hasOwnProperty.call(a, k) && _m14_contains(a[k], b[k]));
  if (Array.isArray(b) || _m14_isObj(b)) return false;
  return a === b || (typeof a === 'number' && typeof b === 'number' && Number(a) === Number(b));
}
/** s LIKE pattern (% and _ wildcards, backslash escape). */
function _m14_like(s, pat) {
  if (s === null || s === undefined || pat === null || pat === undefined) return null;
  let re = '^';
  const a = Array.from(String(pat));
  for (let i = 0; i < a.length; i++) {
    const ch = a[i];
    if (ch === '\\' && i + 1 < a.length) { re += a[++i].replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&'); continue; }
    if (ch === '%') re += '[\\s\\S]*';
    else if (ch === '_') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
  }
  return new RegExp(re + '$', 'u').test(String(s));
}
/** UTF-8 length in bytes (jsonb orders object keys by it). */
function _m14_bytes(s) {
  let n = 0;
  for (const ch of String(s)) { const cp = ch.codePointAt(0); n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4; }
  return n;
}
/** The keys of a jsonb object in jsonb order (shorter first, then bytewise), as jsonb_each returns them. */
function _m14_keys(o) {
  return Object.keys(o).filter((k) => o[k] !== undefined).sort((a, b) => _m14_bytes(a) - _m14_bytes(b) || (a < b ? -1 : a > b ? 1 : 0));
}
/**
 * Text comparison close to the database collation (en_US.utf8): letters and digits first, ignoring case and
 * punctuation; then lower case before upper case; then the characters themselves.
 */
function _m14_collate(a, b) {
  const k = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const ka = k(a), kb = k(b);
  if (ka !== kb) return ka < kb ? -1 : 1;
  const sw = (s) => Array.from(s, (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase())).join('');
  const sa = sw(a), sb = sw(b);
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
/** jsonb ordering: object > array > boolean > number > string > null; objects by size, then key/value pairs. */
function _m14_jsonbCmp(a, b) {
  const rank = (v) => (v === null || v === undefined ? 0 : typeof v === 'string' ? 1 : typeof v === 'number' ? 2 : typeof v === 'boolean' ? 3 : Array.isArray(v) ? 4 : 5);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  switch (ra) {
    case 0: return 0;
    case 1: return _m14_collate(a, b);
    case 2: return a === b ? 0 : a < b ? -1 : 1;
    case 3: return a === b ? 0 : a ? 1 : -1;
    case 4: {
      if (a.length !== b.length) return a.length - b.length;
      for (let i = 0; i < a.length; i++) { const c = _m14_jsonbCmp(a[i], b[i]); if (c) return c; }
      return 0;
    }
    default: {
      const ka = _m14_keys(a), kb = _m14_keys(b);
      if (ka.length !== kb.length) return ka.length - kb.length;
      for (let i = 0; i < ka.length; i++) {
        if (ka[i] !== kb[i]) return _m14_bytes(ka[i]) - _m14_bytes(kb[i]) || (ka[i] < kb[i] ? -1 : 1);
        const c = _m14_jsonbCmp(a[ka[i]], b[kb[i]]);
        if (c) return c;
      }
      return 0;
    }
  }
}
/** jsonb_agg(DISTINCT x): sorted, duplicates removed; NULL for no values. */
function _m14_aggDistinct(list) {
  const out = [];
  for (const v of [...list].sort(_m14_jsonbCmp)) if (!out.length || _m14_jsonbCmp(out[out.length - 1], v) !== 0) out.push(v);
  return jsonAgg(out);
}
/** A number as Postgres prints a numeric (no exponent). */
function _m14_num(n) {
  if (n === null || n === undefined) return null;
  if (Number.isInteger(n) || !/e/i.test(String(n))) return String(n);
  return n.toFixed(20).replace(/\.?0+$/, '');
}
/** The text of a number the way the numeric input prints it back ('007.40' -> '7.40'); numbers as _m14_num. */
function _m14_numText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return _m14_num(Number(v));
  const m = v.trim().match(/^([+-]?)(\d*)(?:\.(\d*))?$/);
  if (!m || (!m[2] && !m[3])) return _m14_num(castNum(v));
  const int = m[2].replace(/^0+(?=\d)/, '') || '0';
  const s = m[3] ? `${int}.${m[3]}` : int;
  return m[1] === '-' && /[1-9]/.test(s) ? `-${s}` : s;
}
/** ::timestamptz with the Postgres range checks the runtime's castTs leaves out ('2026-13-45', '25:00'). */
function _m14_castTs(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?/);
    if (m) {
      const y = +m[1], mo = +m[2], d = +m[3];
      const dim = mo >= 1 && mo <= 12 ? new Date(Date.UTC(y, mo, 0)).getUTCDate() : 0;
      const h = m[4] === undefined ? 0 : +m[4], mi = m[5] === undefined ? 0 : +m[5], sec = m[6] === undefined ? 0 : +m[6];
      if (d < 1 || d > dim || h > 24 || mi > 59 || sec > 60 || (h === 24 && (mi > 0 || sec > 0))) {
        throw new Error(`date/time field value out of range: "${v}"`);
      }
    }
  }
  return castTs(v);
}
/** ts + n days in Africa/Cairo: the wall-clock time stays the same across a daylight-saving change. */
function _m14_plusDays(ts, n) {
  const p = cairoParts(ts);
  const two = (x) => String(x).padStart(2, '0');
  const d = addDays(`${p.y}-${two(p.mo)}-${two(p.d)}`, n);
  return castTs(`${d} ${two(p.h)}:${two(p.mi)}:${two(p.s)}.${String(p.ms).padStart(3, '0')}`);
}
/** ts + n months in Africa/Cairo (the day is clamped to the end of the month, as Postgres does). */
function _m14_plusMonths(ts, n) {
  const p = cairoParts(ts);
  const two = (x) => String(x).padStart(2, '0');
  const total = p.y * 12 + (p.mo - 1) + n;
  const y = Math.floor(total / 12), mo = (total % 12) + 1;
  const d = Math.min(p.d, new Date(Date.UTC(y, mo, 0)).getUTCDate());
  return castTs(`${y}-${two(mo)}-${two(d)} ${two(p.h)}:${two(p.mi)}:${two(p.s)}.${String(p.ms).padStart(3, '0')}`);
}
/** to_char(ts, fmt) in Cairo time for the formats used here. */
function _m14_toChar(ts, fmt) {
  if (ts === null || ts === undefined) return null;
  const p = cairoParts(ts);
  const two = (x) => String(x).padStart(2, '0');
  const date = `${p.y}-${two(p.mo)}-${two(p.d)}`;
  switch (fmt) {
    case 'YYYY-MM-DD HH24:MI': return `${date} ${two(p.h)}:${two(p.mi)}`;
    case 'YYYYMMDDHH24MI': return `${p.y}${two(p.mo)}${two(p.d)}${two(p.h)}${two(p.mi)}`;
    case 'YYYYMMDDHH24': return `${p.y}${two(p.mo)}${two(p.d)}${two(p.h)}`;
    default: throw new Error(`engine: to_char format ${fmt}`);
  }
}
/** set_config(name, value, true): kept for the rest of the request; a rollback restores the earlier value. */
function _m14_setConfig(name, value) {
  if (!DB) return;
  const before = DB.settings ? DB.settings[name] : undefined;
  DB.settings = { ...(DB.settings || {}), [name]: value };
  DB.undo.push(() => { DB.settings = { ...(DB.settings || {}), [name]: before }; });
}
/**
 * ORDER BY key DESC for rows of one table (in table order): rows written in the same request share now(), so equal
 * keys are broken by insertion order, newest first, as Postgres returned them.
 */
function _m14_newest(list, key) {
  return orderBy(list.map((r, i) => ({ r, i })), [(x) => key(x.r), 'desc'], [(x) => x.i, 'desc']).map((x) => x.r);
}
/** ORDER BY key ASC for rows of one table: equal keys keep insertion order (oldest first). */
function _m14_oldest(list, key) { return orderBy(list, key); }
/** The uuid of the caller ((c->>'user_id')::uuid). */
function _m14_uid(c) { return castUuid(_m14_txt(c, 'user_id')); }
function _m14_role(c) { return _m14_txt(c, 'role'); }

/* ---------------------------------------------------------------------------------------------- functions */

// Raises a message for people ("bad_request: ...", "forbidden: ..."), with its Arabic version after " ¦ " when one is
// known (error_messages). The platform hub splits the two into message and message_ar.
function fn_raise(p_message) {
  const ar = fn_message_ar(p_message);
  const e = new Error(p_message === null || p_message === undefined ? '<NULL>' : p_message + (ar === null || ar === undefined ? '' : ' ¦ ' + ar));
  e.sqlstate = 'P0001';
  throw e;
}

// Parses a date or timestamp written by a person or a model; returns null instead of failing.
function fn_try_ts(p) {
  if (p === null || p === undefined || reTest(String(p), '^[0-9]{4}-[0-9]{2}-[0-9]{2}') !== true) return null;
  try { return _m14_castTs(String(p)); } catch (e) { return null; }
}

function fn_source_for(p_ctx) { return _m14_in(_m14_role(p_ctx), ['doctor', 'nurse']) ? 'clinician' : 'patient'; }

function fn_verif_for(p_ctx) { return _m14_in(_m14_role(p_ctx), ['doctor', 'nurse']) ? 'verified' : 'unverified'; }

// Patient-entered facts go to the clinician verification queue.
function fn_queue_verification(p_patient, p_entity, p_id, p_title) {
  const id = castUuid(p_id);
  fn_create_inbox_item(castUuid(p_patient), 'verification', 'low', 4, _m14_cc('Verify patient-reported ', p_entity, ': ', p_title),
    null, { entity: p_entity ?? null, id }, _m14_cc('verify:', p_entity, ':', id));
}

function api_add_condition(c, d) {
  const pid = fn_resolve_patient(c, d);
  if (coalesce(_m14_trim(_m14_txt(d, 'display')), '') === '') fn_raise('bad_request: display is required');
  const verified = fn_verif_for(c) === 'verified';
  const r = dbInsert('conditions', {
    patient_id: pid, code: nullif(_m14_txt(d, 'code'), ''), display: _m14_trim(_m14_txt(d, 'display')),
    onset_date: castDate(nullif(_m14_txt(d, 'onset_date'), '')), verification_status: fn_verif_for(c), source: fn_source_for(c),
    verified_by: verified ? _m14_uid(c) : null, verified_at: verified ? now() : null,
  });
  if (r.verification_status === 'unverified') fn_queue_verification(pid, 'condition', r.id, r.display);
  fn_recheck_patient_safety(pid);
  fn_audit(c, 'condition.add', 'condition', String(r.id), pid);
  return omit({ ...r }, 'patient_id', 'verified_by', 'verified_at');
}

function api_add_allergy(c, d) {
  const pid = fn_resolve_patient(c, d);
  if (coalesce(_m14_trim(_m14_txt(d, 'substance')), '') === '') fn_raise('bad_request: substance is required');
  const cls = fn_allergy_class(_m14_txt(d, 'substance'), nullif(_m14_txt(d, 'substance_class'), ''));
  const r = dbInsert('allergies', {
    patient_id: pid, substance: _m14_trim(_m14_txt(d, 'substance')), substance_class: cls, reaction: _m14_txt(d, 'reaction'),
    severity: coalesce(nullif(_m14_txt(d, 'severity'), ''), 'moderate'), verification_status: fn_verif_for(c), source: fn_source_for(c),
  });
  if (r.verification_status === 'unverified') fn_queue_verification(pid, 'allergy', r.id, r.substance);
  // Re-check every medicine against the new allergy
  fn_recheck_patient_safety(pid);
  fn_audit(c, 'allergy.add', 'allergy', String(r.id), pid);
  return omit({ ...r }, 'patient_id', 'verified_by', 'verified_at');
}

function api_add_medication(c, d) {
  const pid = fn_resolve_patient(c, d);
  const comp = fn_resolve_components(_m14_txt(d, 'name')) || [];
  if (coalesce(_m14_trim(_m14_txt(d, 'name')), '') === '') fn_raise('bad_request: name is required');
  const times = [];
  for (const t of _m14_elemsText(jtype(_m14_get(d, 'times')) === 'array' ? d.times : [])) {
    if (t !== null && reTest(t, _M14_TIME) !== true) fn_raise('bad_request: Times must be written like 08:30 (24-hour clock).');
    if (t !== null && !times.includes(t)) times.push(t);
  }
  const generic = comp.length ? comp[0] : null;
  const drug = generic === null ? null : dbGet('drugs', generic);
  const m = dbInsert('medications', {
    patient_id: pid, name: left(_m14_trim(_m14_txt(d, 'name')), 120), generic, components: comp, drug_class: drug ? drug.drug_class : null,
    dose_text: left(_m14_txt(d, 'dose_text'), 80), frequency: left(_m14_txt(d, 'frequency'), 80), times,
    verification_status: fn_verif_for(c), source: fn_source_for(c), prescribed_by: _m14_role(c) === 'doctor' ? _m14_uid(c) : null,
  });
  if (m.verification_status === 'unverified') fn_queue_verification(pid, 'medication', m.id, m.name);
  fn_emit('MedicationAdded', pid, String(m.id), { generic: m.generic });
  fn_audit(c, 'medication.add', 'medication', String(m.id), pid, { generic: m.generic, components: m.components });
  const json = fn_medication_json({ ...m });
  return { medication: json, safety_findings: fn_medication_safety(m.id), recognized: m.generic !== null };
}

function api_stop_medication(c, d) {
  const pid = fn_resolve_patient(c, d);
  const id = castUuid(_m14_txt(d, 'medication_id'));
  const row = id === null ? null : dbOne('medications', (x) => x.id === id && x.patient_id === pid && x.status === 'active');
  if (!row) fn_raise('not_found: medication not found or already stopped');
  const m = dbUpdate('medications', row, { status: 'stopped', end_date: today() });
  // Resolves this medicine's findings and the interaction findings other medicines had with it. When the patient or
  // family stopped it, the clinician's safety items stay open and the care team is told (fn_note_family_change).
  _m14_setConfig('app.actor_role', coalesce(_m14_role(c), ''));
  fn_recheck_patient_safety(pid);
  fn_note_family_change(c, pid, 'medication', m.id, m.name, m.verification_status === 'verified');
  fn_audit(c, 'medication.stop', 'medication', String(m.id), pid);
  return fn_medication_json({ ...m });
}

function api_log_dose(c, d) {
  const pid = fn_resolve_patient(c, d);
  const status = coalesce(nullif(_m14_txt(d, 'status'), ''), 'taken');
  const id = castUuid(_m14_txt(d, 'medication_id'));
  const med = id === null ? null : dbOne('medications', (x) => x.id === id && x.patient_id === pid && x.status === 'active');
  if (!med) fn_raise('not_found: medication not found');
  if (!['taken', 'missed', 'skipped'].includes(status)) fn_raise('bad_request: status must be taken, missed or skipped');
  // Why a dose was missed or skipped (28_adherence.js); a taken dose has no reason.
  const reason = status === 'taken' ? null : nullif(_m14_txt(d, 'reason'), '');
  if (reason !== null && !_A28_REASONS.includes(reason)) fn_raise(`bad_request: reason must be one of ${_A28_REASONS.join(', ')}`);
  // Without an explicit time the dose is matched to the nearest scheduled time, so Today and adherence can see it.
  let tm = nullif(_m14_txt(d, 'scheduled_time'), '');
  if (tm === null) {
    const p = cairoParts(now());
    const nowSec = p.h * 3600 + p.mi * 60 + p.s + p.ms / 1000;
    let best = null, bestDiff = Infinity;
    for (const x of med.times || []) {
      if (x === null || reTest(x, _M14_TIME) !== true) continue;
      const diff = Math.abs(Number(x.slice(0, 2)) * 3600 + Number(x.slice(3, 5)) * 60 - nowSec);
      if (diff < bestDiff) { best = x; bestDiff = diff; }
    }
    tm = coalesce(best, localHHMM(now()));
  }
  if (reTest(tm, _M14_TIME) !== true) fn_raise('bad_request: scheduled_time must be written like 08:30');
  const at = castTs(`${localDate(now())} ${tm}`);
  dbInsert('medication_logs', { medication_id: med.id, patient_id: pid, scheduled_at: at, status, reason },
    { onConflict: { cols: ['medication_id', 'scheduled_at'], set: (ex, nw) => ({ status: nw.status, reason: nw.reason, logged_at: now() }) } });
  fn_dose_reason_followup(pid, med, reason);
  return { ok: true };
}

/** fn_normalize_lab with the printed text of the value (the SQL printed the numeric with its scale). */
function _m14_normalizeLab(p_code, p_value, p_unit) {
  const cat = p_code === null || p_code === undefined ? null : dbGet('lab_catalog', p_code);
  if (!cat) fn_raise('bad_request: unknown test_code');
  const val = typeof p_value === 'string' ? castNum(p_value) : p_value ?? null;
  if (val === null) fn_raise('bad_request: value is required');
  const u = regexpReplace(coalesce(p_unit, ''), '\\s+', '', 'g').toLowerCase();
  let value, text;
  if (u === '' || u === regexpReplace(cat.unit, '\\s+', '', 'g').toLowerCase()) {
    value = val;
    text = _m14_numText(p_value);
  } else {
    const conv = dbOne('lab_units', (lu) => lu.test_code === p_code && regexpReplace(lu.unit, '\\s+', '', 'g') === u);
    if (!conv) {
      fn_raise(`bad_request: The unit ${p_unit ?? ''} is not supported for ${cat.display}. Please enter the value in ${cat.unit}.`);
    }
    value = round(val * conv.factor + conv.shift, 2);
    text = value.toFixed(2);
  }
  if ((cat.min_value !== null && value < cat.min_value) || (cat.max_value !== null && value > cat.max_value)) {
    fn_raise(`bad_request: A ${cat.display} of ${text} ${cat.unit} is outside the possible range. Please check the value and the unit.`);
  }
  return { value, unit: cat.unit, text };
}

// Converts a lab value to the catalog's canonical unit and rejects impossible values. Returns { value, unit } (the OUT
// parameters); p_value may be a number or numeric text.
function fn_normalize_lab(p_code, p_value, p_unit) {
  const r = _m14_normalizeLab(p_code, p_value, p_unit);
  return { value: r.value, unit: r.unit };
}

// A critical value or change (safety_rules.critical_labs) raises a critical inbox item and a fixed bilingual notice
// to the patient (and family members) at once, whether or not the result is verified yet. Returns true when critical.
function fn_handle_critical_lab(p_lab_id) {
  const cfg = fn_rule('critical_labs');
  const id = castUuid(p_lab_id);
  const l = id === null ? null : dbGet('lab_results', id);
  if (!l) return false;
  const crit = fn_lab_critical({ ...l });
  if (!coalesce(castBool(_m14_txt(crit, 'critical')), false)) return false;
  const cat = dbGet('lab_catalog', l.test_code) || {};
  const val = _m14_num(l.value);
  const reasons = _m14_elemsText(_m14_get(crit, 'reasons')).filter((x) => x !== null).map((x) => x.split('_').join(' '));
  const prev = castNum(_m14_txt(crit, 'previous'));
  const item = fn_create_inbox_item(l.patient_id, 'result', 'critical', 1,
    _m14_cc('Critical result: ', cat.display ?? null, ' ', val, ' ', l.unit, l.verification_status !== 'verified' ? ' (entered by the patient, not yet verified)' : ''),
    _m14_cc('Why: ', reasons.length ? reasons.join(', ') : 'critical limit',
      coalesce(_m14_cc('. Previous value: ', prev === null ? null : _m14_num(prev), ' ', l.unit), ''), '. Please review today.'),
    { entity: 'lab', id: l.id, critical: crit }, _m14_cc('critical-lab:', l.id));
  const linked = item !== null && item !== undefined;
  const en = _m14_replace(_m14_replace(_m14_replace(_m14_replace(_m14_txt(cfg, 'message_en'), '{test}', cat.display ?? null), '{value}', val), '{unit}', l.unit),
    '{team}', linked ? _m14_txt(cfg, 'team_linked_en') : _m14_txt(cfg, 'team_unlinked_en'));
  const ar = _m14_replace(_m14_replace(_m14_replace(_m14_replace(_m14_txt(cfg, 'message_ar'), '{test}', coalesce(cat.display_ar, cat.display)), '{value}', val), '{unit}', l.unit),
    '{team}', linked ? _m14_txt(cfg, 'team_linked_ar') : _m14_txt(cfg, 'team_unlinked_ar'));
  fn_notify_patient(l.patient_id, 'critical_lab', 'A result needs a doctor\'s review today', en, _m14_cc('critical-lab:', l.id),
    'نتيجة تحتاج إلى مراجعة طبيب اليوم', ar);
  dbInsert('audit_logs', { action: 'lab.critical', entity: 'lab_result', entity_id: String(l.id), patient_id: l.patient_id,
    detail: _m14_jcat(crit, { routed: linked }) });
  return true;
}

function api_add_lab(c, d) {
  const pid = fn_resolve_patient(c, d);
  const code = _m14_txt(d, 'test_code');
  const cat = code === null ? null : dbGet('lab_catalog', code);
  if (!cat) fn_raise('bad_request: unknown test_code');
  const raw = _m14_txt(d, 'value');
  if (reTest(coalesce(raw, ''), _M14_SNUM) !== true) fn_raise('bad_request: value must be a number');
  const n = _m14_normalizeLab(cat.test_code, raw, _m14_txt(d, 'unit'));
  const at = coalesce(_m14_castTs(nullif(_m14_txt(d, 'observed_at'), '')), now());
  if (t(at) > t(_m14_plusDays(now(), 1))) fn_raise('bad_request: The result date is in the future.');
  const verified = fn_verif_for(c) === 'verified';
  const l = dbInsert('lab_results', {
    patient_id: pid, test_code: cat.test_code, value: n.value, unit: n.unit, observed_at: at, verification_status: fn_verif_for(c),
    source: fn_source_for(c), verified_by: verified ? _m14_uid(c) : null, verified_at: verified ? now() : null,
  });
  if (l.verification_status === 'verified') {
    fn_emit('LabResultVerified', pid, String(l.id), { test_code: l.test_code });
  } else {
    fn_create_inbox_item(pid, 'result', 'medium', 3, _m14_cc('New patient-entered result: ', cat.display, ' ', n.text, ' ', l.unit),
      'Entered by the patient; needs verification.', { entity: 'lab', id: l.id }, _m14_cc('verify:lab:', l.id));
  }
  fn_handle_critical_lab(l.id);
  if (['creatinine', 'egfr'].includes(l.test_code)) fn_recheck_patient_safety(pid);
  fn_audit(c, 'lab.add', 'lab_result', String(l.id), pid);
  return fn_lab_json({ ...l });
}

function api_add_vital(c, d) {
  const pid = fn_resolve_patient(c, d);
  const at = coalesce(fn_try_ts(_m14_txt(d, 'measured_at')), now());
  const type = _m14_txt(d, 'type');
  // Plausible ranges; a value outside them is refused with a clear message instead of being stored.
  if (!['blood_pressure', 'weight', 'heart_rate'].includes(coalesce(type, ''))) {
    fn_raise('bad_request: type must be blood_pressure, weight or heart_rate');
  }
  if (t(at) > nowMs() + 10 * MIN) fn_raise('bad_request: The measurement time is in the future.');
  if (type === 'blood_pressure') {
    if (fn_num_in(d, 'systolic', 50, 260) === null || fn_num_in(d, 'diastolic', 30, 160) === null) {
      fn_raise('bad_request: Enter both blood pressure numbers.');
    }
    if (castNum(_m14_txt(d, 'diastolic')) >= castNum(_m14_txt(d, 'systolic'))) fn_raise('bad_request: The first blood pressure number must be the higher one.');
  } else if (type === 'weight') {
    if (fn_num_in(d, 'value', 20, 350) === null) fn_raise('bad_request: Enter the weight in kg.');
  } else {
    if (fn_num_in(d, 'value', 25, 250) === null) fn_raise('bad_request: Enter the heart rate in beats per minute.');
  }
  const v = dbInsert('vitals', {
    patient_id: pid, type, systolic: castNum(_m14_txt(d, 'systolic')), diastolic: castNum(_m14_txt(d, 'diastolic')),
    value: castNum(_m14_txt(d, 'value')), unit: type === 'blood_pressure' ? 'mmHg' : type === 'weight' ? 'kg' : 'bpm',
    measured_at: at, source: fn_source_for(c),
  });
  fn_audit(c, 'vital.add', 'vital', String(v.id), pid);
  return omit({ ...v }, 'patient_id', 'created_at');
}

function api_verify(c, d) {
  const id = castUuid(_m14_txt(d, 'id'));
  const status = _m14_txt(d, 'status');
  const uid = _m14_uid(c);
  fn_require_role(c, ['doctor', 'nurse']);
  if (status !== null && !['verified', 'refuted'].includes(status)) fn_raise('bad_request: status must be verified or refuted');
  const entity = _m14_txt(d, 'entity');
  let row = null;
  switch (entity) {
    case 'condition': row = dbGet('conditions', id); break;
    case 'allergy': row = dbGet('allergies', id); break;
    case 'medication': row = dbGet('medications', id); break;
    case 'lab': row = dbGet('lab_results', id); break;
    default: fn_raise('bad_request: unknown entity');
  }
  const pid = row ? row.patient_id : null;
  if (pid === null || !fn_can_access_patient(c, pid)) fn_raise('not_found: record not found');
  const patch = { verification_status: status, verified_by: uid, verified_at: now() };
  switch (entity) {
    case 'condition': dbUpdate('conditions', row, patch); break;
    case 'allergy': dbUpdate('allergies', row, patch); break;
    case 'medication':
      // A medicine the clinician refutes is not being taken: it leaves the active list.
      dbUpdate('medications', row, {
        ...patch, status: status === 'refuted' ? 'stopped' : row.status, end_date: status === 'refuted' ? today() : row.end_date,
      });
      break;
    case 'lab': dbUpdate('lab_results', row, patch); break;
  }
  if (entity === 'lab' && status === 'verified') fn_emit('LabResultVerified', pid, String(id), {});
  fn_recheck_patient_safety(pid);
  const key = _m14_cc('verify:', entity, ':', id);
  dbUpdateWhere('inbox_items', (i) => key !== null && i.dedupe_key === key, { status: 'RESOLVED', updated_at: now() });
  fn_audit(c, _m14_cc('verify.', entity), entity, String(id), pid, { status });
  return { ok: true };
}

function api_ack_finding(c, d) {
  // Only clinicians acknowledge safety findings; a patient reading the alert must not clear the clinician's item.
  fn_require_role(c, ['doctor', 'nurse']);
  const id = castUuid(_m14_txt(d, 'finding_id'));
  const f = id === null ? null : dbGet('safety_findings', id);
  const pid = f ? f.patient_id : null;
  if (pid === null || !fn_can_access_patient(c, pid)) fn_raise('not_found: finding not found');
  if (f.status === 'open') dbUpdate('safety_findings', f, { status: 'acknowledged', acknowledged_by: _m14_uid(c) });
  const fid = _m14_txt(d, 'finding_id');
  dbUpdateWhere('inbox_items', (i) => i.category === 'safety' && _m14_txt(i.payload, 'finding_id') === fid && ['OPEN', 'ROUTED'].includes(i.status),
    { status: 'ACKNOWLEDGED', updated_at: now() });
  fn_audit(c, 'finding.acknowledge', 'safety_finding', fid, pid);
  return { ok: true };
}

/* ---------------------------------------------------------------------------------------------------- glucose */

function api_glucose_add(c, d) {
  const pid = fn_resolve_patient(c, d);
  const val = castNum(_m14_txt(d, 'value_mgdl'));
  if (val === null || val < 20 || val > 600) fn_raise('bad_request: value_mgdl must be between 20 and 600');
  const r = fn_add_glucose(pid, val, coalesce(_m14_castTs(nullif(_m14_txt(d, 'measured_at'), '')), now()),
    _m14_in(_m14_role(c), ['doctor', 'nurse']) ? 'clinician' : 'patient', nullif(_m14_txt(d, 'context'), ''), `manual:${uuid()}`);
  fn_audit(c, 'glucose.add', 'glucose_reading', _m14_txt(_m14_get(r, 'reading'), 'id'), pid);
  return r;
}

function fn_nightscout_json(p_pid) {
  const pid = castUuid(p_pid);
  const x = pid === null ? null : dbGet('cgm_connections', pid);
  if (!x) return { connected: false, url: null, status: 'DISCONNECTED', last_sync_at: null, last_reading_at: null };
  return {
    connected: x.status === null ? null : !['DISCONNECTED', 'REVOKED'].includes(x.status), url: x.url,
    status: x.status === 'ACTIVE' && x.last_reading_at !== null && t(x.last_reading_at) < nowMs() - 30 * MIN ? 'STALE' : x.status,
    last_sync_at: x.last_sync_at, last_reading_at: x.last_reading_at,
  };
}

// The Nightscout address is fetched by the server, so it must be a public https site: no IP addresses, no
// single-label or internal names, no user names, queries or other ports. (Feature flag nightscout_allow_private
// lifts this for local development only.) Returns the reason the address is refused, or null when it is fine.
function fn_nightscout_url_error(p_url) {
  const flag = dbGet('feature_flags', 'nightscout_allow_private');
  const priv = coalesce(flag ? flag.enabled : null, false);
  if (p_url === null || p_url === undefined || reTest(p_url, '^https?://[^/\\s]+') !== true) return 'The address must start with https://';
  if (reTest(p_url, '[\\s@#?\\\\]') || reTest(p_url, '\\[')) {
    return 'Enter only the site address, for example https://my-site.example.com (no user name, "?" or "#").';
  }
  if (priv) return null;
  if (reTest(p_url, '^https://') !== true) return 'The address must start with https://';
  if (reTest(p_url, '^https://[^/]+:[0-9]*') && reTest(p_url, '^https://[^/:]+:443(/|$)') !== true) return 'Only the standard https port can be used.';
  const m = reMatch(p_url, '^https://([^/:]+)');
  const host = m === null ? null : m.toLowerCase();
  if (host === null
      || reTest(host, '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$') !== true
      || reTest(host, '(^|\\.)(0x[0-9a-f]*|[0-9]+)$')
      || reTest(host, '(^|\\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|invalid)$')) {
    return 'This address cannot be used. Enter the public https address of your Nightscout site.';
  }
  return null;
}

function api_nightscout_connect(c, d) {
  const pid = fn_resolve_patient(c, d);
  const url = _m14_rtrim(_m14_trim(coalesce(_m14_txt(d, 'url'), '')), '/');
  const why = fn_nightscout_url_error(url);
  if (why !== null) fn_raise(`bad_request: ${why}`);
  dbInsert('cgm_connections', { patient_id: pid, provider: 'nightscout', url, token: nullif(left(_m14_txt(d, 'token'), 200), ''), status: 'VALIDATING' },
    { onConflict: { cols: ['patient_id'], set: (ex, nw) => ({ url: nw.url, token: nw.token, status: 'VALIDATING', last_error: null }) } });
  fn_audit(c, 'nightscout.connect', 'cgm_connection', pid, pid);
  return fn_nightscout_json(pid);
}

function api_nightscout_disconnect(c, d) {
  const pid = fn_resolve_patient(c, d);
  dbUpdateWhere('cgm_connections', (x) => x.patient_id === pid, { status: 'REVOKED', token: null });
  fn_audit(c, 'nightscout.disconnect', 'cgm_connection', pid, pid);
  return fn_nightscout_json(pid);
}

/* -------------------------------------------------------------------------------------------------- lifestyle */

/**
 * Calories come from the food list (kcal per portion), like carbohydrates. They are computed when a meal is shown, not
 * stored, so meals logged before this existed get the same numbers. A food without a portion count counts as one
 * portion, as for est_carbs_g.
 */
function _m14_mealKcal(m) {
  const kcal = [];
  for (const i of _m14_elems(m.items)) {
    const fid = castUuid(_m14_txt(i, 'food_id'));
    const f = fid === null ? null : dbGet('foods', fid);
    if (f && castNum(f.kcal) !== null) kcal.push(castNum(f.kcal) * coalesce(castNum(_m14_txt(i, 'portions')), 1));
  }
  return round(coalesce(sum(kcal), 0));
}

/** fn_meal_json with the rows of fn_meal_responses(patient, 400) already read. */
function _m14_mealJson(m, responses) {
  const items = [];
  for (const i of _m14_elems(m.items)) {
    const fid = castUuid(_m14_txt(i, 'food_id'));
    const f = fid === null ? null : dbGet('foods', fid);
    if (!f) continue;
    const portions = castNum(_m14_txt(i, 'portions'));
    const kcal = castNum(f.kcal);
    items.push({ food_id: f.id, name: f.name, name_ar: f.name_ar, portions, carbs_g: portions === null ? null : round(f.carbs_g * portions),
      kcal: kcal === null ? null : round(kcal * coalesce(portions, 1)) });
  }
  const r = (responses || []).find((x) => x.meal_id === m.id);
  return {
    id: m.id, eaten_at: m.eaten_at, meal_type: m.meal_type, est_carbs_g: m.est_carbs_g, est_kcal: m.id === null ? null : _m14_mealKcal(m),
    notes: m.notes, items: jsonAgg(items) ?? [],
    response: r ? { pre: r.pre ?? null, peak: r.peak ?? null, rise: r.rise ?? null, sensor_ok: r.sensor_ok ?? null } : null,
  };
}

/*
 * Energy from activity: MET minutes (Compendium of Physical Activities) when minutes are logged, otherwise about
 * 0.0005 kcal per step per kg of body weight. kcal = MET x 3.5 x kg / 200 x minutes.
 */
const _M14_MET = { walking: 3.5, housework: 3.0, prayer_walk: 3.0, exercise: 5.0, other: 3.5 };
function _m14_activityKcal(a, kg) {
  const minutes = coalesce(castNum(a.minutes), 0), steps = coalesce(castNum(a.steps), 0);
  if (minutes > 0) return round(coalesce(_M14_MET[a.type], 3.5) * 3.5 * kg / 200 * minutes);
  if (steps > 0) return round(steps * kg * 0.0005);
  return 0;
}

/**
 * Estimated daily energy needs to keep the current weight (Mifflin-St Jeor, times an activity factor from the average
 * daily steps). Informational only: the care team or a dietitian sets any calorie target. No estimate in pregnancy
 * (needs differ) or without weight, height and age.
 */
function fn_energy_needs(p_pid, p_weight_kg, p_steps_avg) {
  const p = dbGet('patients', castUuid(p_pid));
  if (!p) return { kcal: null, note: 'unknown_patient' };
  if (castBool(p.pregnant) === true) return { kcal: null, note: 'pregnancy' };
  const w = castNum(p_weight_kg), h = castNum(p.height_cm), age = fn_age(p.date_of_birth);
  if (w === null || h === null || age === null || age < 18) return { kcal: null, note: 'needs_weight_height' };
  const bmr = 10 * w + 6.25 * h - 5 * age + (p.sex === 'male' ? 5 : -161);
  const steps = castNum(p_steps_avg);
  const factor = steps === null ? 1.2 : steps >= 10000 ? 1.725 : steps >= 7500 ? 1.55 : steps >= 5000 ? 1.375 : 1.2;
  return { kcal: round(bmr * factor / 10) * 10, note: 'estimate', bmr: round(bmr), activity_factor: factor };
}

function fn_meal_json(m) {
  const row = m || { id: null, patient_id: null, eaten_at: null, meal_type: null, est_carbs_g: null, notes: null, items: null };   // a NULL row
  return _m14_mealJson(row, fn_meal_responses(row.patient_id ?? null, 400));
}

function api_log_meal(c, d) {
  const pid = fn_resolve_patient(c, d);
  const carbs = [];
  for (const i of _m14_itemsOf(d, 'items')) {
    const fid = castUuid(_m14_txt(i, 'food_id'));
    const f = fid === null ? null : dbGet('foods', fid);
    if (f) carbs.push(f.carbs_g * coalesce(castNum(_m14_txt(i, 'portions')), 1));
  }
  const m = dbInsert('meal_logs', {
    patient_id: pid, eaten_at: coalesce(_m14_castTs(nullif(_m14_txt(d, 'eaten_at'), '')), now()), meal_type: coalesce(_m14_txt(d, 'meal_type'), 'snack'),
    items: _m14_own(d, 'items') ? d.items : [], est_carbs_g: round(coalesce(sum(carbs), 0)), notes: _m14_txt(d, 'notes'),
  });
  return fn_meal_json({ ...m });
}

function fn_lifestyle_summary(p_pid, p_days) {
  const pid = castUuid(p_pid);
  const days = castInt(p_days);
  const since = days === null ? null : addDays(today(), -days);
  const cut = days === null ? null : t(_m14_plusDays(now(), -days));
  const byDate = new Map();
  const weights = _m14_newest(dbWhere('vitals', (v) => v.patient_id === pid && v.type === 'weight'), (v) => t(v.measured_at));
  const latest = weights.length ? weights[0].value : null;
  const kgUsed = coalesce(castNum(latest), 70);            // 70 kg when no weight is recorded (shown as an estimate)
  for (const a of dbWhere('activity_logs', (x) => x.patient_id === pid && since !== null && x.date > since)) {
    const g = byDate.get(a.date) || { date: a.date, steps: [], minutes: [], kcal: [] };
    g.steps.push(a.steps); g.minutes.push(a.minutes); g.kcal.push(_m14_activityKcal(a, kgUsed));
    byDate.set(a.date, g);
  }
  const act = [...byDate.values()].map((g) => ({ date: g.date, steps: sum(g.steps), minutes: sum(g.minutes), kcal: round(coalesce(sum(g.kcal), 0)) }));
  const old = weights.find((v) => t(v.measured_at) < t(_m14_plusDays(now(), -30)));
  const before = old ? old.value : null;
  const meals = _m14_newest(dbWhere('meal_logs', (m) => m.patient_id === pid && cut !== null && t(m.eaten_at) > cut), (m) => t(m.eaten_at)).slice(0, 40);
  const responses = meals.length ? fn_meal_responses(pid, 400) : [];
  const checkins = _m14_newest(dbWhere('checkins', (x) => x.patient_id === pid && cut !== null && t(x.at) > cut), (x) => t(x.at));
  // Energy eaten per local day, from every meal in the window (not only the 40 listed).
  const intake = new Map();
  for (const m of dbWhere('meal_logs', (x) => x.patient_id === pid && since !== null && localDate(x.eaten_at) > since)) {
    const d = localDate(m.eaten_at);
    const g = intake.get(d) || { date: d, kcal: 0, carbs_g: 0, meals: 0 };
    g.kcal += _m14_mealKcal(m); g.carbs_g += coalesce(castNum(m.est_carbs_g), 0); g.meals += 1;
    intake.set(d, g);
  }
  const todayIntake = intake.get(today());
  const todayAct = act.find((a) => a.date === today());
  const stepsAvg = round(avg(act.map((a) => a.steps)));
  return {
    days,
    steps_avg: round(avg(act.map((a) => a.steps))),
    active_minutes_avg: round(avg(act.map((a) => a.minutes))),
    sleep_hours_avg: round(avg(dbWhere('sleep_logs', (s) => s.patient_id === pid && since !== null && s.date > since).map((s) => s.hours)), 1),
    weight_latest: latest,
    weight_change_30d: latest === null || before === null ? null : round(latest - before, 1),
    meals: jsonAgg(meals.map((m) => _m14_mealJson(m, responses))) ?? [],
    checkins: jsonAgg(checkins.map((x) => ({ at: x.at, mood: x.mood, stress: x.stress, energy: x.energy, note: x.note }))) ?? [],
    activity: jsonAgg(orderBy(act, (a) => a.date)) ?? [],
    energy: {
      eaten_today_kcal: todayIntake ? round(todayIntake.kcal) : 0,
      meals_today: todayIntake ? todayIntake.meals : 0,
      burned_today_kcal: todayAct ? todayAct.kcal : 0,
      eaten_avg_kcal: round(avg([...intake.values()].map((g) => g.kcal))),
      days_with_meals: intake.size,
      daily: jsonAgg(orderBy([...intake.values()].map((g) => ({ date: g.date, kcal: round(g.kcal), carbs_g: round(g.carbs_g), meals: g.meals })), (g) => g.date)) ?? [],
      needs: fn_energy_needs(pid, latest, stepsAvg),
      weight_kg_used: kgUsed,
      weight_is_estimate: latest === null,
    },
  };
}

/* ------------------------------------------------------------------------------------------------------- care */

// Booking checks: a time in the future (within a year), a known channel, no second open appointment of the patient at
// the same time, and (for a confirmed booking) a free slot for the doctor. A clash is a 409 conflict.
function api_book_appointment(c, d) {
  const pid = fn_resolve_patient(c, d);
  const start = fn_try_ts(_m14_txt(d, 'starts_at'));
  if (start === null) fn_raise('bad_request: Please choose the date and time of the appointment.');
  if (t(start) < nowMs() - 5 * MIN) fn_raise('bad_request: The appointment time has already passed.');
  if (t(start) > t(_m14_plusMonths(now(), 12))) fn_raise('bad_request: Appointments can be booked up to one year ahead.');
  const channel = coalesce(nullif(_m14_txt(d, 'channel'), ''), 'in_person');
  if (!['in_person', 'video', 'phone'].includes(channel)) fn_raise('bad_request: channel must be in_person, video or phone');
  let provider = castUuid(nullif(_m14_txt(d, 'provider_user_id'), ''));
  if (provider === null) {
    const ct = dbOne('care_team', (x) => x.patient_id === pid && x.role === 'doctor' && x.active === true);
    provider = ct ? ct.user_id : null;
  }
  const s = t(start);
  const overlaps = (x) => t(x.starts_at) < s + 20 * MIN && (x.ends_at !== null ? t(x.ends_at) : t(x.starts_at) + 20 * MIN) > s;
  if (dbExists('appointments', (x) => x.patient_id === pid && ['requested', 'booked', 'checked_in'].includes(x.status) && overlaps(x))) {
    fn_raise('conflict: There is already an appointment at this time.');
  }
  const role = _m14_role(c);
  if (role !== null && !['patient', 'caregiver'].includes(role) && provider !== null
      && dbExists('appointments', (x) => x.provider_user_id === provider && ['booked', 'checked_in'].includes(x.status) && overlaps(x))) {
    fn_raise('conflict: The doctor already has an appointment at this time. Please choose another time.');
  }
  const startsAt = _m14_castTs(_m14_txt(d, 'starts_at'));
  const a = dbInsert('appointments', {
    patient_id: pid, provider_user_id: provider, facility_id: castUuid(nullif(_m14_txt(d, 'facility_id'), '')), starts_at: startsAt,
    ends_at: iso(t(startsAt) + 20 * MIN), type: left(coalesce(nullif(_m14_txt(d, 'type'), ''), 'consultation'), 40), channel,
    status: _m14_in(role, ['patient', 'caregiver']) ? 'requested' : 'booked', reason: left(nullif(_m14_trim(coalesce(_m14_txt(d, 'reason'), '')), ''), 500),
    episode_id: castUuid(nullif(_m14_txt(d, 'episode_id'), '')), referral_id: castUuid(nullif(_m14_txt(d, 'referral_id'), '')),
  });
  if (a.episode_id !== null) {
    dbUpdateWhere('episodes', (e) => e.id === a.episode_id && e.patient_id === pid, { status: 'ACTION_SELECTED', selected_action: 'book', updated_at: now() });
  }
  if (a.referral_id !== null) {
    dbUpdateWhere('referrals', (r) => r.id === a.referral_id && r.patient_id === pid, { status: 'BOOKED', appointment_id: a.id, updated_at: now() });
  }
  fn_emit('AppointmentCreated', pid, String(a.id), { starts_at: a.starts_at });
  fn_audit(c, 'appointment.book', 'appointment', String(a.id), pid);
  return fn_appointment_json({ ...a });
}

// Staff confirm, reschedule, check in, complete or cancel appointments (patients can only request and cancel).
// Allowed steps: requested -> booked | cancelled; booked -> booked (new time) | checked_in | no_show | cancelled;
// checked_in -> completed | cancelled. Completed, cancelled and no-show appointments are final.
function api_update_appointment(c, d) {
  const status = _m14_txt(d, 'status');
  const start = fn_try_ts(_m14_txt(d, 'starts_at'));
  fn_require_role(c, ['doctor', 'nurse', 'receptionist', 'clinic_admin']);
  const id = castUuid(_m14_txt(d, 'appointment_id'));
  const row = id === null ? null : dbGet('appointments', id);
  if (!row || !fn_can_access_patient(c, row.patient_id)) fn_raise('not_found: appointment not found');
  if (status !== null && !['booked', 'checked_in', 'completed', 'no_show', 'cancelled'].includes(status)) {
    fn_raise('bad_request: status must be booked, checked_in, completed, no_show or cancelled');
  }
  const prev = row.status;
  if (status !== null && !((prev === 'requested' && ['booked', 'cancelled'].includes(status))
      || (prev === 'booked' && ['booked', 'checked_in', 'no_show', 'cancelled'].includes(status))
      || (prev === 'checked_in' && ['completed', 'cancelled'].includes(status)))) {
    fn_raise(`bad_request: A ${_m14_replace(prev, '_', ' ')} appointment cannot be changed to ${_m14_replace(status, '_', ' ')}.`);
  }
  const role = _m14_role(c);
  const me = role === 'doctor' ? _m14_uid(c) : null;
  if (start !== null && status === 'booked') {
    if (t(start) < nowMs() - 5 * MIN) fn_raise('bad_request: The new time has already passed.');
    const doc = coalesce(row.provider_user_id, me);
    const s = t(start);
    if (dbExists('appointments', (x) => x.id !== row.id && ['booked', 'checked_in'].includes(x.status) && doc !== null && x.provider_user_id === doc
        && t(x.starts_at) < s + 20 * MIN && (x.ends_at !== null ? t(x.ends_at) : t(x.starts_at) + 20 * MIN) > s)) {
      fn_raise('conflict: The doctor already has an appointment at this time. Please choose another time.');
    }
  }
  const len = row.ends_at !== null ? t(row.ends_at) - t(row.starts_at) : 20 * MIN;
  const a = dbUpdate('appointments', row, {
    status,
    starts_at: status === 'booked' ? coalesce(start, row.starts_at) : row.starts_at,
    ends_at: status === 'booked' && start !== null ? iso(t(start) + len) : row.ends_at,
    provider_user_id: coalesce(row.provider_user_id, me),
  });
  if (status === 'booked') {
    const when = _m14_toChar(a.starts_at, 'YYYY-MM-DD HH24:MI');
    fn_notify_patient(a.patient_id, 'appointment', prev === 'booked' ? 'Your appointment time changed' : 'Your appointment is confirmed',
      when, _m14_cc('appt-confirmed:', a.id, ':', _m14_toChar(a.starts_at, 'YYYYMMDDHH24MI')),
      prev === 'booked' ? 'تغير موعدك' : 'تم تأكيد موعدك', when);
  } else if (status === 'cancelled') {
    const when = _m14_toChar(a.starts_at, 'YYYY-MM-DD HH24:MI');
    fn_notify_patient(a.patient_id, 'appointment', 'Your appointment was cancelled',
      _m14_cc(when, '. Please book a new time if you still need one.'), _m14_cc('appt-cancelled:', a.id),
      'تم إلغاء موعدك', _m14_cc(when, '. من فضلك احجز موعدًا جديدًا إذا كنت ما زلت تحتاج إليه.'));
  } else if (status === 'completed' && a.episode_id !== null) {
    dbUpdateWhere('episodes', (e) => e.id === a.episode_id && ['ASSESSED', 'ROUTED', 'ACTION_SELECTED', 'ESCALATED'].includes(e.status),
      { status: 'CARE_RECEIVED', updated_at: now() });
    if (!dbExists('episode_followups', (f) => f.episode_id === a.episode_id && f.status === 'pending')) {
      dbInsert('episode_followups', { episode_id: a.episode_id, due_at: later(48 * HOUR) });
    }
  }
  fn_audit(c, _m14_cc('appointment.', status), 'appointment', String(a.id), a.patient_id);
  return fn_appointment_json({ ...a });
}

// Screenings that are not lab tests (eye, foot, dental) are marked done here; lab-based ones follow the results.
function api_record_screening(c, d) {
  const pid = fn_resolve_patient(c, d);
  const on = coalesce(castDate(nullif(_m14_txt(d, 'done_on'), '')), today());
  const type = _m14_txt(d, 'type');
  if (type === null || !dbGet('screening_types', type)) fn_raise('bad_request: unknown screening type');
  if (on > today()) fn_raise('bad_request: The date is in the future.');
  dbInsert('screening_items', { patient_id: pid, type, last_done: on }, {
    onConflict: { cols: ['patient_id', 'type'], set: (ex, nw) => ({ last_done: maxOf([coalesce(ex.last_done, nw.last_done), nw.last_done]) }) },
  });
  fn_audit(c, 'screening.record', 'screening', type, pid, { done_on: on });
  return fn_screenings(pid);
}

function api_profile_update(c, d) {
  const pid = fn_resolve_patient(c, d);
  const lang = nullif(_m14_txt(d, 'preferred_language'), '');
  if (lang !== null && !['ar', 'en'].includes(lang)) fn_raise('bad_request: preferred_language must be ar or en');
  const h = _m14_txt(d, 'height_cm');
  if (nullif(h, '') !== null && (reTest(h, _M14_NUM) !== true || castNum(h) < 80 || castNum(h) > 250)) {
    fn_raise('bad_request: Height must be between 80 and 250 cm.');
  }
  const role = _m14_role(c);
  const p = dbGet('patients', pid);
  if (p) {
    const may = _m14_in(role, ['patient', 'doctor', 'nurse']) === true;
    dbUpdate('patients', p, {
      phone: coalesce(left(_m14_txt(d, 'phone'), 30), p.phone),
      governorate: coalesce(left(_m14_txt(d, 'governorate'), 60), p.governorate),
      city: coalesce(left(_m14_txt(d, 'city'), 60), p.city),
      preferred_language: coalesce(lang, p.preferred_language),
      height_cm: coalesce(castNum(nullif(h, '')), p.height_cm),
      pregnant: _m14_has(d, 'pregnant') && may ? coalesce(castBool(_m14_txt(d, 'pregnant')), p.pregnant) : p.pregnant,
      closed_loop_pump: _m14_has(d, 'uses_insulin_pump') && may ? coalesce(castBool(_m14_txt(d, 'uses_insulin_pump')), p.closed_loop_pump) : p.closed_loop_pump,
    });
  }
  // The app language of the patient's own account follows the profile language.
  if (lang !== null && role === 'patient') {
    const uid = _m14_uid(c);
    dbUpdateWhere('users', (u) => uid !== null && u.id === uid, { locale: lang });
  }
  fn_audit(c, 'profile.update', 'patient', pid, pid);
  return fn_patient_json(pid);
}

// Keeps only known targets and rejects values that are not plausible numbers, so one bad value cannot break
// the patient's Today screen or the clinician's panel.
function fn_clean_targets(p) {
  const out = {};
  if (!_m14_isObj(p)) return out;
  for (const k of _m14_keys(p)) {
    const v = p[k];
    const s = jtext(v);
    if (!Object.prototype.hasOwnProperty.call(_M14_TARGET_SPEC, k) || v === null || s === '') continue;
    const name = k.split('_').join(' ');
    if (reTest(s, _M14_NUM) !== true) fn_raise(`bad_request: The target ${name} must be a number.`);
    const n = castNum(s);
    const [lo, hi] = _M14_TARGET_SPEC[k];
    if (n < lo || n > hi) fn_raise(`bad_request: The target ${name} must be between ${lo} and ${hi}.`);
    out[k] = n;
  }
  if ('fasting_low' in out && 'fasting_high' in out && out.fasting_low >= out.fasting_high) {
    fn_raise('bad_request: The fasting range is not valid: the low value must be below the high value.');
  }
  return out;
}

function api_save_plan_draft(c, d) {
  const pid = fn_resolve_patient(c, d);
  fn_require_role(c, ['doctor', 'nurse']);
  const draft = dbOne('care_plans', (p) => p.patient_id === pid && p.status === 'DRAFT');
  let planId;
  if (!draft) {
    const title = coalesce(nullif(_m14_txt(d, 'title'), ''), 'Care plan');
    const targets = fn_clean_targets(_m14_get(d, 'targets'));
    const version = coalesce(maxOf(dbWhere('care_plans', (p) => p.patient_id === pid).map((p) => p.version)), 0) + 1;
    planId = dbInsert('care_plans', {
      patient_id: pid, status: 'DRAFT', title, summary: _m14_txt(d, 'summary'), summary_ar: _m14_txt(d, 'summary_ar'), targets,
      authored_by: _m14_uid(c), version,
    }).id;
  } else {
    planId = draft.id;
    dbUpdate('care_plans', draft, {
      title: coalesce(nullif(_m14_txt(d, 'title'), ''), draft.title), summary: _m14_txt(d, 'summary'), summary_ar: _m14_txt(d, 'summary_ar'),
      targets: _m14_has(d, 'targets') ? fn_clean_targets(_m14_get(d, 'targets')) : draft.targets, authored_by: _m14_uid(c),
    });
    dbDeleteWhere('care_plan_items', (i) => i.plan_id === planId);
  }
  let pos = 0;
  for (const it of _m14_itemsOf(d, 'items')) {
    pos += 1;
    if (coalesce(_m14_trim(_m14_txt(it, 'title')), '') === '') continue;
    const kind = _m14_txt(it, 'kind');
    dbInsert('care_plan_items', {
      plan_id: planId, kind: ['monitoring', 'medication', 'lifestyle', 'education', 'screening', 'appointment'].includes(kind) ? kind : 'education',
      title: left(_m14_txt(it, 'title'), 200), title_ar: left(_m14_txt(it, 'title_ar'), 200), detail: left(_m14_txt(it, 'detail'), 500),
      schedule: jtype(_m14_get(it, 'schedule')) === 'object' ? it.schedule : null, position: pos,
    });
  }
  fn_audit(c, 'careplan.save_draft', 'care_plan', String(planId), pid);
  return fn_plan_json(planId);
}

/* ----------------------------------------------------------------------------------------------- Care Access */

function fn_intake_result(p_episode, p_emergency) {
  const id = castUuid(p_episode);
  const e = id === null ? null : dbGet('episodes', id);
  if (!e) return null;
  const open = ['DRAFT', 'INTAKE_IN_PROGRESS'].includes(e.status);
  return {
    episode: fn_episode_json(e.id),
    emergency: coalesce(castBool(_m14_txt(p_emergency, 'emergency')), false) ? p_emergency : null,
    next_question: open ? fn_next_question(e.answers) : null,
    assessed: !open,
  };
}

function api_intake_start(c, d) {
  const pid = fn_resolve_patient(c, d);
  const text = _m14_txt(d, 'complaint_text');
  if (coalesce(_m14_trim(text), '') === '') fn_raise('bad_request: complaint_text is required');
  const em = fn_prescreen_for(c, pid, text);
  const emergency = castBool(_m14_txt(em, 'emergency')) === true;
  const e = dbInsert('episodes', {
    patient_id: pid, status: emergency ? 'ESCALATED' : 'INTAKE_IN_PROGRESS', chief_complaint: left(_m14_trim(text), 500), answers: fn_urgent_answers(em),
  });
  if (coalesce(castBool(_m14_txt(em, 'urgent')), false)) {
    fn_create_inbox_item(pid, 'episode', 'high', 2, 'Urgent foot problem described in Care Access', left(_m14_trim(text), 500),
      { episode_id: e.id, matched: _m14_get(em, 'urgent_matched') }, _m14_cc('episode-urgent:', e.id));
  }
  if (emergency) {
    const matched = _m14_elemsText(_m14_get(em, 'matched'));
    dbInsert('triage_assessments', {
      episode_id: e.id, care_level: 'emergency_services', specialty: 'emergency_medicine', channel: 'emergency',
      rules_fired: ['PRESCREEN_EMERGENCY'], red_flags: matched,
    });
    const signs = matched.filter((x) => x !== null).map((x) => x.split('_').join(' '));
    fn_create_inbox_item(pid, 'episode', 'critical', 1, 'Emergency pre-screen triggered in Care Access',
      `Warning signs: ${signs.length ? signs.join(', ') : 'emergency words'}`, { episode_id: e.id }, _m14_cc('episode-emergency:', e.id));
  }
  fn_emit('EpisodeCreated', pid, String(e.id), {});
  fn_audit(c, 'episode.start', 'episode', String(e.id), pid);
  return fn_intake_result(e.id, em);
}

// Answers implied by an urgent pre-screen match: a black or smelly foot wound, or an infected one, is a foot problem
// that the rules send to urgent care (R04), whatever else is answered.
function fn_urgent_answers(p_em) {
  const m = coalesce(_m14_get(p_em, 'urgent_matched'), []);
  if (_m14_has(m, 'foot_gangrene')) return { q_area: 'skin_foot', q_foot: 'black_or_smelly' };
  if (_m14_has(m, 'foot_infection')) return { q_area: 'skin_foot', q_foot: 'red_swollen' };
  return {};
}

// An AI-extracted answer is used only when it makes the assessment more urgent (or is neutral, such as the body area);
// a reassuring value ("not severe", "getting better", "eating normally") waits for the person's own answer, so a
// misread sentence can never lower the level of care. The extraction itself stays in episodes.extracted.
// Returns true, false or null (SQL NULL for a JSON null value).
function fn_ai_answer_raises(p_q, p_v) {
  const s = jtext(p_v);
  const num = () => (reTest(s, _M14_NUM) === true ? castNum(s) : null);
  switch (p_q) {
    case 'q_severity': if (s === null) return null; return num() !== null && num() >= 7;
    case 'q_trend': return s === null ? null : s === 'worse';
    case 'q_eat_drink': return s === null ? null : s === 'no';
    case 'q_fever': return s === null ? null : s === 'yes';
    case 'q_foot': return s === null ? null : ['red_swollen', 'black_or_smelly'].includes(s);
    case 'q_glucose_now': {
      if (s === null) return null;
      const n = num();
      return n !== null && n >= 1 && (n < 70 || n >= 250);
    }
    default: return true;
  }
}

// Validates answers against the question bank before storing them. Returns true, false or null (SQL NULL: a JSON
// null answer to a yes/no or number question, which the caller does not treat as invalid).
function fn_valid_answer(p_q, p_answer) {
  const type = p_q ? p_q.type : null;
  const optionValues = () => _m14_elems(p_q.options).map((o) => _m14_txt(o, 'value'));
  switch (type) {
    case 'single': return jtype(p_answer) === 'string' && optionValues().includes(p_answer);
    case 'multi': {
      if (jtype(p_answer) !== 'array' || p_answer.length === 0) return false;
      const opts = optionValues();
      return _m14_elemsText(p_answer).every((a) => a !== null && opts.includes(a));
    }
    case 'yesno': { const s = jtext(p_answer); return s === null ? null : ['yes', 'no'].includes(s); }
    case 'number': { const s = jtext(p_answer); return s === null ? null : reTest(s, _M14_SNUM) === true; }
    default: return jtype(p_answer) === 'string';
  }
}

// Normalizes common answer forms before validation: booleans and yes/no words (Arabic or English) for yes/no questions,
// a single string for multi-choice, and numeric strings for numbers.
function fn_normalize_answer(p_q, p_answer) {
  const type = p_q ? p_q.type : null;
  const v = _m14_trim(coalesce(jtext(p_answer), '')).toLowerCase();
  if (type === 'yesno') {
    if (jtype(p_answer) === 'boolean') return p_answer === true ? 'yes' : 'no';
    if (['yes', 'y', 'true', '1', 'نعم', 'ايوه', 'أيوه', 'اه', 'آه', 'ايوة'].includes(v)) return 'yes';
    if (['no', 'n', 'false', '0', 'لا', 'لأ', 'لاء'].includes(v)) return 'no';
    return p_answer;
  } else if (type === 'multi' && jtype(p_answer) === 'string') {
    return [p_answer];
  } else if (type === 'number' && jtype(p_answer) === 'string' && reTest(v, _M14_SNUM) === true) {
    return castNum(v);
  } else if ((type === 'single' || type === 'text') && jtype(p_answer) === 'string') {
    return _m14_trim(p_answer);
  }
  return p_answer;
}

function fn_intake_store(c, p_episode, p_answers, p_source) {
  const id = castUuid(p_episode);
  const e = id === null ? null : dbGet('episodes', id);
  if (!e || !fn_can_access_patient(c, e.patient_id)) fn_raise('not_found: episode not found');
  if (!['DRAFT', 'INTAKE_IN_PROGRESS'].includes(e.status)) return fn_intake_result(e.id, null);
  let answers = e.answers;
  if (p_answers !== null && p_answers !== undefined && !_m14_isObj(p_answers)) throw new Error('cannot call jsonb_each on a non-object');
  for (const k of p_answers ? _m14_keys(p_answers) : []) {
    let v = p_answers[k];
    const q = dbGet('intake_questions', k);
    if (!q) {
      if (p_source === 'patient') fn_raise('bad_request: Unknown question.');
      continue;
    }
    v = fn_normalize_answer(q, v);
    if (fn_valid_answer(q, v) === false) {
      // Patients get a clear error instead of the same question again; AI-extracted values are silently dropped.
      if (p_source === 'patient') fn_raise('bad_request: That answer is not valid for this question.');
      continue;
    }
    // AI-extracted answers may add red flags but can never record "no red flags"; the patient must answer that explicitly.
    // Extracted red flags are added to whatever the patient already selected, even after "none".
    if (p_source === 'ai' && k === 'q_red_flags') {
      const flags = _m14_elemsText(v).filter((x) => x !== null && x !== 'none');
      if (flags.length === 0) continue;
      const had = jtype(_m14_get(answers, 'q_red_flags')) === 'array' ? answers.q_red_flags : [];
      const all = [...flags, ..._m14_elemsText(had)].filter((x) => x !== null && x !== 'none');
      answers = _m14_jcat(answers, { [k]: _m14_aggDistinct(all) });
      continue;
    }
    if (p_source === 'ai' && _m14_has(answers, k)) continue;
    if (p_source === 'ai' && fn_ai_answer_raises(k, v) === false) continue;
    answers = _m14_jcat(answers, { [k]: v });
  }
  dbUpdate('episodes', e, { answers, status: 'INTAKE_IN_PROGRESS', updated_at: now() });

  const next = fn_next_question(answers);
  // Short-circuit: assess immediately when a red flag is present or an emergency rule already matches
  // (for example a glucose reading of 400 or more, or below 54).
  const redFlags = () => {   // jsonb_array_elements_text(coalesce(answers->'q_red_flags', '[]')): a JSON null is not an array
    if (!_m14_own(answers, 'q_red_flags')) return [];
    if (answers.q_red_flags === null) throw new Error('cannot extract elements from a scalar');
    return _m14_elemsText(answers.q_red_flags);
  };
  if (next === null || next === undefined
      || redFlags().some((f) => f !== null && f !== 'none')
      || dbExists('care_level_rules', (r) => ['emergency_services', 'emergency_department'].includes(r.care_level) && fn_rule_matches(r.condition, answers) === true)) {
    fn_assess_episode(e.id);
  }
  return fn_intake_result(e.id, null);
}

function api_intake_answer(c, d) {
  const id = castUuid(_m14_txt(d, 'episode_id'));
  const q = _m14_txt(d, 'question_id');
  if (q === null) throw new Error('argument 1: key must not be null');
  return fn_intake_store(c, id, { [q]: _m14_get(d, 'answer') }, 'patient');
}

function api_episode_action(c, d) {
  const id = castUuid(_m14_txt(d, 'episode_id'));
  const e = id === null ? null : dbGet('episodes', id);
  if (!e || !fn_can_access_patient(c, e.patient_id)) fn_raise('not_found: episode not found');
  if (['DRAFT', 'INTAKE_IN_PROGRESS'].includes(e.status)) fn_raise('bad_request: Please finish the questions first.');
  if (['RESOLVED', 'CLOSED'].includes(e.status)) fn_raise('bad_request: This request is closed. Start a new one under Need Care.');
  const action = _m14_txt(d, 'action');
  if (!['book', 'find_care', 'self_care', 'emergency'].includes(coalesce(action, ''))) {
    fn_raise('bad_request: action must be book, find_care, self_care or emergency');
  }
  dbUpdate('episodes', e, { status: action === 'self_care' ? 'FOLLOW_UP' : 'ACTION_SELECTED', selected_action: action, updated_at: now() });
  if (!dbExists('episode_followups', (f) => f.episode_id === e.id && f.status === 'pending')) {
    dbInsert('episode_followups', { episode_id: e.id, due_at: later(action === 'self_care' ? 24 * HOUR : 72 * HOUR) });
  }
  fn_audit(c, 'episode.select_action', 'episode', String(e.id), e.patient_id, { action });
  return fn_episode_json(e.id);
}

function api_episode_followup(c, d) {
  let status = _m14_txt(d, 'status');
  const id = castUuid(_m14_txt(d, 'episode_id'));
  const e = id === null ? null : dbGet('episodes', id);
  if (!e || !fn_can_access_patient(c, e.patient_id)) fn_raise('not_found: episode not found');
  if (status !== null && !['better', 'same', 'worse'].includes(status)) fn_raise('bad_request: status must be better, same or worse');
  dbUpdateWhere('episode_followups', (f) => f.episode_id === e.id && ['pending', 'sent'].includes(f.status),
    { status: 'answered', response: _m14_minus(d, 'episode_id'), answered_at: now() });
  const symptoms = coalesce(_m14_txt(d, 'new_symptoms'), '');
  const em = fn_prescreen_for(c, e.patient_id, symptoms);
  const emergency = coalesce(castBool(_m14_txt(em, 'emergency')), false);
  if (!emergency && coalesce(castBool(_m14_txt(em, 'urgent')), false)) status = 'worse';
  if (emergency) {
    // Same handling as an emergency at the start of Care Access: emergency care level, fixed guidance, critical inbox item.
    dbUpdate('episodes', e, { status: 'ESCALATED', updated_at: now() });
    dbInsert('triage_assessments', {
      episode_id: e.id, care_level: 'emergency_services', specialty: 'emergency_medicine', channel: 'emergency',
      rules_fired: ['PRESCREEN_EMERGENCY'], red_flags: _m14_elemsText(_m14_get(em, 'matched')),
    });
    fn_create_inbox_item(e.patient_id, 'episode', 'critical', 1, 'Emergency warning signs reported in a follow-up', left(symptoms, 500),
      { episode_id: e.id, matched: _m14_get(em, 'matched') }, _m14_cc('episode-emergency:', e.id, ':', _m14_toChar(now(), 'YYYYMMDDHH24')));
  } else if (status === 'worse') {
    dbUpdate('episodes', e, { status: 'ESCALATED', updated_at: now() });
    fn_create_inbox_item(e.patient_id, 'episode', 'high', 2, 'Episode follow-up: patient reports getting worse', left(symptoms, 500),
      { episode_id: e.id }, _m14_cc('episode-worse:', e.id, ':', _m14_toChar(now(), 'YYYYMMDDHH24')));
  } else if (status === 'better') {
    dbUpdate('episodes', e, { status: 'RESOLVED', resolved_at: now(), updated_at: now() });
  } else {
    dbUpdate('episodes', e, { status: 'FOLLOW_UP', updated_at: now() });
    dbInsert('episode_followups', { episode_id: e.id, due_at: later(48 * HOUR) });
  }
  fn_audit(c, 'episode.followup', 'episode', String(e.id), e.patient_id, { status, emergency });
  return _m14_jcat(fn_episode_json(e.id), { emergency: emergency ? em : null });
}

/* ---------------------------------------------------------------------------------------------------- network */

function api_update_capacity(c, d) {
  const res = nullif(_m14_txt(d, 'resource'), '');
  fn_require_role(c, ['capacity_operator', 'clinic_admin', 'platform_admin']);
  const fid = castUuid(_m14_txt(d, 'facility_id'));
  const f = fid === null ? null : dbGet('facilities', fid);
  if (!f) fn_raise('not_found: facility not found');
  if (res === null) fn_raise('bad_request: resource is required');
  if (reTest(coalesce(_m14_txt(d, 'available'), ''), '^[0-9]{1,5}$') !== true || reTest(coalesce(_m14_txt(d, 'total'), '0'), '^[0-9]{1,5}$') !== true) {
    fn_raise('bad_request: Available and total must be whole numbers.');
  }
  const avail = castInt(_m14_txt(d, 'available'));
  // When the total is not sent, the stored total is used to work out the status.
  let total = castInt(_m14_txt(d, 'total'));
  if (total === null) {
    const cur = dbOne('facility_capacity', (x) => x.facility_id === f.id && x.resource === res);
    total = cur ? cur.total : null;
  }
  if (total !== null && total > 0 && avail > total) fn_raise('bad_request: Available cannot be more than the total.');
  const status = coalesce(nullif(_m14_txt(d, 'status'), ''),
    avail === 0 ? 'full' : total !== null && total > 0 && avail / total < 0.2 ? 'limited' : 'available');
  dbInsert('facility_capacity', {
    facility_id: f.id, resource: res, available: avail, total, status, source: 'operator', updated_by: _m14_uid(c), updated_at: now(),
  }, {
    onConflict: {
      cols: ['facility_id', 'resource'],
      set: (ex, nw) => ({ available: nw.available, total: coalesce(nw.total, ex.total), status: nw.status, source: 'operator', updated_by: nw.updated_by, updated_at: now() }),
    },
  });
  fn_emit('FacilityCapacityUpdated', null, String(f.id), { resource: res, available: avail });
  fn_audit(c, 'capacity.update', 'facility', String(f.id), null, d);
  return fn_facility_json({ ...f }, null, null);
}

function api_create_referral(c, d) {
  const pid = fn_resolve_patient(c, d);
  fn_require_role(c, ['doctor', 'nurse']);
  const fac = nullif(_m14_txt(d, 'to_facility_id'), '');
  const r = dbInsert('referrals', {
    patient_id: pid, from_user_id: _m14_uid(c), to_specialty: _m14_txt(d, 'to_specialty'), to_facility_id: castUuid(fac),
    urgency: coalesce(nullif(_m14_txt(d, 'urgency'), ''), 'routine'), reason: coalesce(_m14_txt(d, 'reason'), ''),
    status: fac === null ? 'MATCHING' : 'SELECTED',
  });
  fn_emit('ReferralCreated', pid, String(r.id), { specialty: r.to_specialty, urgency: r.urgency });
  fn_audit(c, 'referral.create', 'referral', String(r.id), pid);
  return fn_referral_json({ ...r });
}

// Who may change what on a referral:
//   patient / caregiver: choose the facility (status SELECTED) while the referral is still open, nothing else;
//   reception / clinic admin: record the chosen facility or that the visit is booked;
//   doctor / nurse: everything, including the specialist report and closing the referral.
function api_update_referral(c, d) {
  const role = _m14_role(c);
  let status = nullif(_m14_txt(d, 'status'), '');
  const fac = castUuid(nullif(_m14_txt(d, 'to_facility_id'), ''));
  const report = nullif(_m14_trim(coalesce(_m14_txt(d, 'report'), '')), '');
  const id = castUuid(_m14_txt(d, 'referral_id'));
  const r = id === null ? null : dbGet('referrals', id);
  if (!r || !fn_can_access_patient(c, r.patient_id)) fn_raise('not_found: referral not found');
  const prev = r.status;
  if (status !== null && !['CREATED', 'MATCHING', 'SELECTED', 'BOOKED', 'CONSULTED', 'REPORT_RETURNED', 'CLOSED'].includes(status)) {
    fn_raise('bad_request: unknown referral status');
  }
  if (fac !== null && !dbGet('facilities', fac)) fn_raise('not_found: facility not found');
  if (_m14_in(role, ['patient', 'caregiver'])) {
    if (report !== null || coalesce(status, 'SELECTED') !== 'SELECTED' || fac === null) {
      fn_raise('forbidden: You can only choose where to go for this referral.');
    }
    if (!['CREATED', 'MATCHING', 'SELECTED'].includes(r.status)) {
      fn_raise('bad_request: This referral can no longer be changed. Please contact your care team.');
    }
    status = 'SELECTED';
  } else if (_m14_in(role, ['receptionist', 'clinic_admin'])) {
    if (report !== null || !['SELECTED', 'BOOKED'].includes(coalesce(status, ''))) {
      fn_raise('forbidden: Only a doctor or nurse can record the specialist report or close a referral.');
    }
  } else if (role !== null && !['doctor', 'nurse'].includes(role)) {
    fn_raise('forbidden: cannot update referrals');
  }
  if (status === 'REPORT_RETURNED' && coalesce(report, r.report) === null) fn_raise('bad_request: Add the specialist report first.');
  // Allowed steps: forward along the pathway (a booking can go back to choosing a place), or close from any open step.
  if (status !== null && status !== prev && !(
    (prev === 'CREATED' && ['MATCHING', 'SELECTED', 'BOOKED', 'CLOSED'].includes(status))
    || (prev === 'MATCHING' && ['SELECTED', 'BOOKED', 'CLOSED'].includes(status))
    || (prev === 'SELECTED' && ['MATCHING', 'BOOKED', 'CLOSED'].includes(status))
    || (prev === 'BOOKED' && ['SELECTED', 'CONSULTED', 'REPORT_RETURNED', 'CLOSED'].includes(status))
    || (prev === 'CONSULTED' && ['REPORT_RETURNED', 'CLOSED'].includes(status))
    || (prev === 'REPORT_RETURNED' && status === 'CLOSED'))) {
    fn_raise(`bad_request: A referral that is ${prev.split('_').join(' ').toLowerCase()} cannot move to ${status.split('_').join(' ').toLowerCase()}.`);
  }
  dbUpdate('referrals', r, {
    status: coalesce(status, r.status), report: coalesce(left(report, 4000), r.report), to_facility_id: coalesce(fac, r.to_facility_id), updated_at: now(),
  });
  if (r.status !== prev) fn_emit('ReferralStatusChanged', r.patient_id, String(r.id), { status: r.status });
  fn_audit(c, 'referral.update', 'referral', String(r.id), r.patient_id, { status: r.status, report_written: report !== null });
  return fn_referral_json({ ...r });
}

/* --------------------------------------------------------------------------------------------------- provider */

function fn_inbox_list(c, d) {
  const role = _m14_role(c);
  if (_m14_in(role, ['doctor', 'nurse', 'clinic_admin']) !== true) return [];   // the inbox holds clinical details
  const want = coalesce(_m14_txt(d, 'status'), 'active');
  const status = _m14_txt(d, 'status');
  const category = nullif(_m14_txt(d, 'category'), '');
  const access = new Map();
  const can = (pid) => { if (!access.has(pid)) access.set(pid, fn_can_access_patient(c, pid) === true); return access.get(pid); };
  const rows = dbWhere('inbox_items', (i) => (want === 'all' || (want === 'active' && i.status !== 'RESOLVED') || (status !== null && i.status === status))
    && (category === null || i.category === category) && can(i.patient_id));
  // ORDER BY priority, created_at DESC; items of the same request: newest first.
  return orderBy(rows.map((r, n) => ({ r, n })), (x) => x.r.priority, [(x) => t(x.r.created_at), 'desc'], [(x) => x.n, 'desc'])
    .slice(0, 200).map((x) => fn_inbox_json({ ...x.r }));
}

// Inbox triage. Safety and critical items are acknowledged and resolved by clinicians (not by an administrator); the
// first person to acknowledge an unassigned item takes it; an optional note is kept with the item.
function api_update_inbox(c, d) {
  const status = coalesce(_m14_txt(d, 'status'), '');
  const note = nullif(left(_m14_trim(coalesce(_m14_txt(d, 'note'), '')), 1000), '');
  fn_require_role(c, ['doctor', 'nurse', 'clinic_admin']);
  const id = castUuid(_m14_txt(d, 'item_id'));
  const i = id === null ? null : dbGet('inbox_items', id);
  if (!i || !fn_can_access_patient(c, i.patient_id)) fn_raise('not_found: item not found');
  if (!['OPEN', 'ROUTED', 'ACKNOWLEDGED', 'ACTIONED', 'RESOLVED'].includes(status)) fn_raise('bad_request: unknown inbox status');
  const handled = ['ACKNOWLEDGED', 'ACTIONED', 'RESOLVED'].includes(status);
  if (_m14_role(c) === 'clinic_admin' && (i.category === 'safety' || ['critical', 'high'].includes(i.urgency)) && handled) {
    fn_raise('forbidden: A doctor or nurse must handle safety and urgent items.');
  }
  dbUpdate('inbox_items', i, {
    status, updated_at: now(),
    assignee_id: coalesce(i.assignee_id, handled ? _m14_uid(c) : null),
    acknowledged_at: coalesce(i.acknowledged_at, handled ? now() : null),
    resolved_by: status === 'RESOLVED' ? _m14_uid(c) : i.resolved_by,
    notes: note === null ? i.notes
      : _m14_jcat(i.notes, [{ by: _m14_txt(c, 'full_name'), role: _m14_role(c), at: now(), text: note, status }]),
  });
  fn_audit(c, 'inbox.update', 'inbox_item', String(i.id), i.patient_id, { status: i.status, note: note !== null });
  return fn_inbox_json({ ...i });
}

// Assigns an item to a clinician of the patient's clinic (or to nobody).
function api_assign_inbox(c, d) {
  const to = castUuid(nullif(_m14_txt(d, 'assignee_id'), ''));
  fn_require_role(c, ['doctor', 'nurse', 'clinic_admin']);
  const id = castUuid(_m14_txt(d, 'item_id'));
  const i = id === null ? null : dbGet('inbox_items', id);
  if (!i || !fn_can_access_patient(c, i.patient_id)) fn_raise('not_found: item not found');
  if (to !== null) {
    const u = dbGet('users', to);
    if (!(u && u.active === true && ['doctor', 'nurse'].includes(u.role)
        && dbExists('memberships', (m) => m.user_id === u.id && i.organization_id !== null && m.organization_id === i.organization_id))) {
      fn_raise('bad_request: Choose a doctor or nurse of this clinic.');
    }
  }
  dbUpdate('inbox_items', i, { assignee_id: to, updated_at: now() });
  const me = _m14_uid(c);
  if (to !== null && me !== null && to !== me) {
    dbInsert('notifications', {
      user_id: to, patient_id: i.patient_id, kind: 'inbox_assigned', title: 'An inbox item was assigned to you', body: i.title,
      title_ar: 'تم إسناد عنصر إليك', body_ar: i.title, dedupe_key: _m14_cc('assigned:', i.id, ':', to, ':', _m14_toChar(now(), 'YYYYMMDDHH24MI')),
    }, { onConflict: 'nothing' });
  }
  fn_audit(c, 'inbox.assign', 'inbox_item', String(i.id), i.patient_id, { assignee_id: to });
  return fn_inbox_json({ ...i });
}

function fn_provider_stats(c) {
  const pts = dbWhere('patients', (p) => fn_can_access_patient(c, p.id) === true).map((p) => p.id);
  const ids = new Set(pts);
  const role = _m14_role(c);
  const clinical = _m14_in(role, ['doctor', 'nurse', 'clinic_admin']);
  const open = () => dbWhere('inbox_items', (i) => ids.has(i.patient_id) && i.status !== 'RESOLVED');
  return {
    patients: pts.length,
    open_items: clinical ? open().length : 0,
    critical_items: clinical ? open().filter((i) => ['critical', 'high'].includes(i.urgency)).length : 0,
    appointments_today: dbCount('appointments', (a) => ids.has(a.patient_id) && localDate(a.starts_at) === today()
      && ['requested', 'booked', 'checked_in'].includes(a.status)),
    avg_tir: clinical ? round(avg(pts.map((id) => castNum(_m14_txt(fn_glucose_metrics(id, 14), 'tir')))), 1) : null,
    restricted: clinical === null ? null : !clinical,
  };
}

/* ------------------------------------------------------------------------------------- companion bookkeeping */

// The reply language is the language of the message (the verifier checks the same): Arabic script, or Arabic written in
// Latin letters (Franco: "ynfa3 asoom", "el sokar 3andy wate"), is answered in Arabic; other Latin text in English. A
// message without letters ("250") keeps the app's language.
function fn_message_locale(p_msg, p_fallback = null) {
  const msg = String(coalesce(p_msg, ''));
  if (/[؀-ۿ]/.test(msg)) return 'ar';
  const words = (msg.toLowerCase().match(/[a-z0-9']+/g) || []).filter((w) => /[a-z]/.test(w));
  if (!words.length) return p_fallback === 'ar' || p_fallback === 'en' ? p_fallback : 'en';
  // Digits standing for Arabic letters inside a word (3 ع, 7 ح, 2 ء, 5 خ, 8 ق, 9 ص), or common Franco words.
  const FRANCO = new Set(['ana', 'enta', 'enty', 'inta', 'howa', 'heya', 'ehna', 'eh', 'ezay', 'izay', 'leh', 'msh', 'mesh', 'mish', 'keda', 'kda',
    'el', 'fe', 'fy', 'w', 'lw', 'law', 'bas', 'awy', 'kteer', 'ktir', 'shwaya', 'delwa2ty', 'dlwa2ty', 'ynfa3', 'yenfa3', 'ma3lesh', 'aywa', 'la2',
    'ya', 'bta3y', 'bta3ty', '3andy', '3ndy', 'sokar', 'sokkar', 'sukar', 'elsokar', 'wate', 'a3mel', 'a3ml', 'asoom', 'ramadan', 'doctor', 'dktor']);
  const digitWord = (w) => /[a-z][235789]|[235789][a-z]/.test(w);
  const ENGLISH = new Set(['the', 'is', 'are', 'my', 'i', 'what', 'how', 'can', 'should', 'do', 'does', 'and', 'to', 'of', 'it', 'have', 'with', 'for']);
  const franco = words.filter((w) => digitWord(w) || FRANCO.has(w)).length;
  const english = words.filter((w) => ENGLISH.has(w)).length;
  return franco >= 2 && franco > english ? 'ar' : 'en';
}

function api_companion_prepare(c, d) {
  const pid = fn_resolve_patient(c, d);
  const uid = _m14_uid(c);
  let conv = castUuid(nullif(_m14_txt(d, 'conversation_id'), ''));
  const msg = left(_m14_trim(coalesce(_m14_txt(d, 'message'), '')), 2000);
  if (msg === '') fn_raise('bad_request: message is required');
  // Each person has their own conversations: a family member never reads or continues the patient's chat, and the
  // other way round.
  if (conv === null || !dbExists('conversations', (x) => x.id === conv && x.patient_id === pid && uid !== null && x.user_id === uid)) {
    conv = dbInsert('conversations', { patient_id: pid, user_id: uid }).id;
  }
  const all = dbWhere('messages', (m) => m.conversation_id === conv);
  const last8 = new Set(_m14_newest(all, (m) => t(m.created_at)).slice(0, 8));
  const hist = jsonAgg(_m14_oldest(all.filter((m) => last8.has(m)), (m) => t(m.created_at)).map((m) => ({ role: m.role, content: left(m.content, 600) }))) ?? [];
  // The person's last three messages in the past two hours: an emergency described there still counts ("it is a bit
  // better now, can I sleep?" after chest pain), and a dose question split over two messages is still a dose question.
  const mine = all.filter((m) => m.role === 'user' && t(m.created_at) > nowMs() - 2 * HOUR);
  const recent = _m14_newest(mine, (m) => t(m.created_at)).slice(0, 3);
  const prev = recent.length ? _m14_oldest(mine.filter((m) => recent.includes(m)), (m) => t(m.created_at)).map((m) => m.content).join(' . ') : null;
  const last = recent.length ? recent[0].content : null;
  dbInsert('messages', { conversation_id: conv, role: 'user', content: msg });
  const em = fn_prescreen_for(c, pid, msg);
  let recentEm = null;
  if (prev !== null && !coalesce(castBool(_m14_txt(em, 'emergency')), false)) recentEm = fn_prescreen_for(c, pid, prev);
  const len = Array.from(msg).length;
  const dose = fn_is_dose_change_request(msg)
    || (last !== null && len < 160 && !fn_is_dose_change_request(last) && fn_is_dose_change_request(`${last} ${msg}`));
  const locale = fn_message_locale(msg, nullif(_m14_txt(d, 'locale'), ''));
  const run = fn_ai_run_start('WF-001 Companion', pid, null, { message_chars: len, locale }, null, 'companion/v1');
  const grant = dbOne('caregiver_grants', (g) => uid !== null && g.caregiver_user_id === uid && g.patient_id === pid && g.active === true);
  const out = {
    patient_id: pid, conversation_id: conv, message: msg, locale, emergency: em, ai_run_id: run, history: hist,
    recent_emergency: coalesce(castBool(_m14_txt(recentEm, 'emergency')), false) ? _m14_get(recentEm, 'matched') : null,
    // Who is writing: the patient, or a family member asking about the patient (relationship as the patient wrote it).
    writer: { role: _m14_role(c) === 'caregiver' ? 'caregiver' : 'patient', relationship: grant ? grant.relationship : null },
  };
  out.context = fn_ai_context(pid);
  out.policy = fn_policy(pid, 'companion');
  out.dose_guard = fn_dose_guard();
  out.dose_change_request = dose;
  // AI gates: consent and cloud egress, identifiers to redact, injection rules, and the message rate (this message
  // is already counted). The emergency pre-screen above runs whatever these say.
  out.gate = fn_ai_gate(pid, 'companion');
  // Hard alert (35_monitoring.js): model answers paused. The emergency pre-screen and fixed replies above still run.
  out.paused = fn_companion_paused();
  // Release policy (35_monitoring.js): when on (the default), an answer the verifier did not approve is withheld.
  out.require_verified = fn_companion_require_verified();
  out.rate = fn_companion_rate(pid);
  // Deterministic checks for any medicine named in the message (generic, brand, or Arabic name).
  const nm = fn_normalize_text(msg);
  const named = dbWhere('drugs', (dr) => _m14_like(nm, `%${dr.generic.split('_').join(' ')}%`)
    || (dr.display_ar !== null && _m14_like(nm, `%${fn_normalize_text(dr.display_ar)}%`))
    || (dr.brand_names || []).some((b) => b !== null && Array.from(b).length > 3 && _m14_like(nm, `%${b.toLowerCase()}%`))
    || (dr.brand_names_ar || []).some((b) => b !== null && Array.from(b).length > 3 && _m14_like(nm, `%${fn_normalize_text(b)}%`)));
  out.medicine_checks = jsonAgg(named.map((dr) => fn_check_drug_for_patient(pid, dr.generic))) ?? [];
  return out;
}

function api_companion_store(p_run, p_conv, p_reply, p_status, p_guard, p_verifier, p_model) {
  const run = castUuid(p_run), conv = castUuid(p_conv);
  const msg = dbInsert('messages', { conversation_id: conv, role: 'assistant', content: _m14_txt(p_reply, 'content'), meta: _m14_minus(p_reply, 'content'), ai_run_id: run });
  dbUpdateWhere('ai_runs', (r) => run !== null && r.id === run, { model: p_model ?? null });
  fn_ai_run_finish(run, p_status, p_reply, p_guard, p_verifier, null);
  const cv = conv === null ? null : dbGet('conversations', conv);
  const pid = cv ? cv.patient_id : null;
  const lastUser = _m14_newest(dbWhere('messages', (m) => conv !== null && m.conversation_id === conv && m.role === 'user'), (m) => t(m.created_at))[0];
  const user = left(lastUser ? lastUser.content : null, 500);
  // Higher-risk model answers wait for a nurse (36_reviews.js); the patient gets a holding reply at once.
  const hold = pid === null ? null : fn_review_hold(pid, msg.id, conv, run, user, p_reply, p_guard, p_status);
  if (hold) {
    dbUpdate('messages', msg, { content: hold.content, meta: { ..._m14_minus(p_reply, 'content'), citations: [], suggested_actions: [], held: true, review_id: hold.review_id } });
  }
  // What the patient wrote goes to the care team with an urgency that matches what happened. These are the
  // patient's own words, not an AI proposal, so they are routed whenever the patient has a care team.
  let kind = null, item = null;
  const flag = (o, k) => coalesce(castBool(_m14_txt(o, k)), false);
  const actions = _m14_own(p_reply, 'suggested_actions') ? p_reply.suggested_actions : [];
  const violations = _m14_get(p_guard, 'dose_violations');
  if (flag(p_reply, 'emergency')) {
    kind = 'emergency';
    item = fn_create_inbox_item(pid, 'episode', 'critical', 1, 'Emergency warning signs reported in Companion chat', user,
      { ai_run_id: run, conversation_id: conv, matched: _m14_get(p_guard, 'emergency_prescreen') }, _m14_cc('companion-emergency:', run));
  } else if (flag(p_reply, 'urgent')) {
    kind = 'urgent';
    item = fn_create_inbox_item(pid, 'episode', 'high', 2, 'Urgent foot problem reported in Companion chat', user,
      { ai_run_id: run, conversation_id: conv, matched: _m14_get(p_guard, 'urgent_prescreen') }, _m14_cc('companion-urgent:', run));
  } else if (actions !== null && _m14_contains(actions, [{ type: 'call_emergency' }])) {
    // The model itself advised emergency care although the pre-screen did not match: a person reviews it, and the
    // message is a candidate for a new pre-screen pattern (audit kind 'ai_emergency').
    kind = 'ai_emergency';
    item = fn_create_inbox_item(pid, 'episode', 'high', 2, 'Companion advised emergency care', user,
      { ai_run_id: run, conversation_id: conv }, _m14_cc('companion-ai-emergency:', run));
  } else if (flag(p_guard, 'dose_change_request') || (Array.isArray(violations) && violations.length > 0)) {
    kind = 'dose';
    item = fn_create_inbox_item(pid, 'question', 'high', 2, 'Patient asked about changing or dosing a medicine', user,
      { ai_run_id: run, conversation_id: conv }, _m14_cc('companion-dose:', run));
  } else if (hold) {
    kind = 'ai_review';
    item = 'held';
  } else if (flag(p_reply, 'needs_clinician_review')) {
    kind = 'question';
    const refused = _m14_txt(p_verifier, 'approved') === 'false';
    item = fn_create_inbox_item(pid, 'question', refused ? 'medium' : 'low', refused ? 3 : 4, 'Patient question for review', user,
      { ai_run_id: run, conversation_id: conv }, _m14_cc('question:', run));
  }
  const routed = item !== null && item !== undefined;
  if (kind !== null) {
    dbInsert('audit_logs', { action: routed ? 'companion.routed' : 'companion.not_routed', entity: 'inbox_item', entity_id: routed ? String(item) : null,
      patient_id: pid, detail: { ai_run_id: run, kind } });
  }
  // A chat stopped by an AI gate (prompt injection, rate limit, no AI consent) is audited with the reason, never the text.
  if (p_status === 'BLOCKED') {
    const gate = _m14_get(p_guard, 'gate');
    dbInsert('audit_logs', { action: 'ai.gate_blocked', entity: 'ai_run', entity_id: run, patient_id: pid,
      detail: { route: _m14_txt(gate, 'route'), signals: coalesce(_m14_get(_m14_get(gate, 'injection'), 'signals'), []) } });
  }
  return {
    conversation_id: conv, ai_run_id: run,
    message: { id: msg.id, role: 'assistant', content: msg.content, created_at: msg.created_at, meta: msg.meta },
    reply: hold ? { ..._m14_minus(p_reply, 'needs_clinician_review'), content: hold.content, citations: [], suggested_actions: [], held: true, review_due_at: hold.due_at, routed: true }
      : _m14_jcat(_m14_minus(p_reply, 'needs_clinician_review'), { routed }),
  };
}

function fn_companion_history(c, d) {
  const pid = fn_resolve_patient(c, d);
  const uid = _m14_uid(c);
  let conv = castUuid(nullif(_m14_txt(d, 'conversation_id'), ''));
  if (conv === null) {
    const last = _m14_newest(dbWhere('conversations', (x) => x.patient_id === pid && uid !== null && x.user_id === uid), (x) => t(x.created_at))[0];
    conv = last ? last.id : null;
  }
  if (conv !== null && !dbExists('conversations', (x) => x.id === conv && x.patient_id === pid && uid !== null && x.user_id === uid)) {
    fn_raise('not_found: conversation not found');
  }
  const msgs = _m14_oldest(dbWhere('messages', (m) => conv !== null && m.conversation_id === conv), (m) => t(m.created_at));
  return {
    conversation_id: conv,
    messages: jsonAgg(msgs.map((m) => ({ id: m.id, role: m.role, content: m.content, created_at: m.created_at, meta: m.meta }))) ?? [],
  };
}

// Hypothetical drug check for the Companion tool: deterministic, no writes.
function fn_check_drug_for_patient(p_pid, p_name) {
  const pid = castUuid(p_pid);
  const comp = fn_resolve_components(p_name) || [];
  const egfr = castNum(_m14_txt(fn_egfr(pid), 'value_exact'));
  if (comp.length === 0) {
    return { recognized: false, name: p_name ?? null, findings: [], note: 'Medicine not in the reference list; ask a pharmacist or the care team.' };
  }
  // Same rules as the stored safety findings: every ingredient, other medicines' ingredients, allergy groups,
  // non-refuted conditions and the unrounded eGFR.
  let out = [];
  for (const g of comp) {
    const d = g === null ? null : dbGet('drugs', g);
    if (!d) continue;
    const inter = [];
    for (const om of dbWhere('medications', (m) => m.patient_id === pid && m.status === 'active' && m.verification_status !== 'refuted')) {
      for (const og of om.components && om.components.length ? om.components : [om.generic]) {
        const od = og === null ? null : dbGet('drugs', og);
        if (!od) continue;
        for (const di of dbRows('drug_interactions')) {
          if ((fn_drug_matches(di.a, d.generic, d.drug_class) === true && fn_drug_matches(di.b, od.generic, od.drug_class) === true)
              || (fn_drug_matches(di.b, d.generic, d.drug_class) === true && fn_drug_matches(di.a, od.generic, od.drug_class) === true)) {
            inter.push({ kind: 'interaction', with: om.name, severity: di.severity, effect: di.effect, recommendation: di.recommendation });
          }
        }
      }
    }
    out = out.concat(_m14_aggDistinct(inter) ?? []);
    const allergies = dbWhere('allergies', (a) => a.patient_id === pid && a.verification_status !== 'refuted' && a.status === 'active'
      && fn_allergy_matches(a.substance, a.substance_class, d.generic, d.allergy_class) === true)
      .map((a) => ({ kind: 'allergy', severity: a.severity === 'severe' ? 'contraindicated' : 'major', allergy: a.substance, reaction: a.reaction }));
    out = out.concat(allergies);
    const rules = dbWhere('drug_condition_rules', (r) => fn_drug_matches(r.drug, d.generic, d.drug_class) === true
      && ((r.condition_code_prefix !== null && dbExists('conditions', (cn) => cn.patient_id === pid && cn.status === 'active'
            && cn.verification_status !== 'refuted' && _m14_like(cn.code, `${r.condition_code_prefix}%`) === true))
        || (r.egfr_below !== null && egfr !== null && egfr < r.egfr_below && (r.egfr_at_least === null || egfr >= r.egfr_at_least))))
      .map((r) => ({ kind: r.egfr_below !== null ? 'renal' : 'condition', severity: r.severity, title: r.title, detail: r.detail }));
    out = out.concat(rules);
  }
  const first = dbGet('drugs', comp[0]);
  return { recognized: true, generic: comp[0], components: comp, class: first ? first.drug_class : null, egfr: round(egfr), findings: out };
}
