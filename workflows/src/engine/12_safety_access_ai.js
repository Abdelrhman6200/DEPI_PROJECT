// 12 Safety, Care Access, network matching, AI context, RAG search, Action Validator
// (port of database/migrations/012_fn_safety_access_ai.sql; that file stays the specification).
//
// Regular expressions. The text rules (app.safety_rules) are Postgres AREs. _m12_rx converts the escapes whose meaning
// differs in JavaScript and hands the result to the runtime's pgRe with the dotAll flag (in an ARE "." also matches a
// newline): \y \m \M use the word characters of the database locale (en_US.UTF-8, glibc: Alphabetic letters, which
// include the Arabic marks, decimal digits and "_"), \w \W likewise (JavaScript's \w is ASCII only), \s \S are glibc's
// [[:space:]] (no-break spaces and U+FEFF are not space), and ARE-only escapes (\A \Z \b \B, \<punct>) become their
// JavaScript equivalents. regexp_split_to_array ignores empty separator matches (no rule pattern can match empty).
// lower() maps one character to one character, as glibc towlower does.
//
// Text order. ORDER BY on text, DISTINCT inside aggregates and least/greatest follow the en_US collation of the database
// (_m12_collate): spaces, punctuation and symbols are ignored first, then case (lower first), then code points.
//
// Full-text and vector search (fn_rag_search, implemented in JavaScript): to_tsvector/to_tsquery('simple') @@ becomes a
// whole-token match of the query terms on the stemmed search text (the search text only holds a-z, 0-9, Arabic letters
// and single spaces, so the tokens are the space-separated words), and pgvector's <=> is the cosine distance computed
// in single precision as pgvector does (vectors are stored as float4).

/* ------------------------------------------------------------------------------------------- private helpers */

const _M12_WORD = '\\p{Alphabetic}\\p{Nd}_';
const _M12_SPACE = '\\t\\n\\v\\f\\r \\u1680\\u2000-\\u2006\\u2008-\\u200a\\u2028\\u2029\\u205f\\u3000';
const _M12_CONV = new Map();
const _M12_TR = new Map();
const _M12_LIKE = new Map();
const _M12_COLL = new Intl.Collator('en-US', { sensitivity: 'variant' });

/** An ARE pattern as the JavaScript pattern text pgRe compiles (see the file header). */
function _m12_conv(src) {
  src = String(src);
  if (_M12_CONV.has(src)) return _M12_CONV.get(src);
  const W = _M12_WORD, SP = _M12_SPACE;
  const SYNTAX = '^$\\.*+?()[]{}|/';
  let out = '', br = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) {
      const n = src[++i];
      if (!br) {
        const map = {
          y: `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`, m: `(?<![${W}])(?=[${W}])`, M: `(?<=[${W}])(?![${W}])`,
          w: `[${W}]`, W: `[^${W}]`, s: `[${SP}]`, S: `[^${SP}]`, d: '[0-9]', D: '[^0-9]', A: '^', Z: '$', b: '\\x08', B: '\\\\',
        };
        if (map[n] !== undefined) { out += map[n]; continue; }
      } else {
        const map = { w: W, s: SP, d: '0-9', b: '\\x08', B: '\\\\' };
        if (map[n] !== undefined) { out += map[n]; continue; }
        if (n === 'W' || n === 'S' || n === 'D') throw new Error(`invalid regular expression: \\${n} inside brackets is not supported`);
      }
      if (/[\p{L}\p{N}]/u.test(n) || SYNTAX.includes(n) || (br && n === '-')) out += '\\' + n;
      else out += n;                                  // ARE: a backslash before any other character is that character
      continue;
    }
    if (!br && c === '[') {
      br = true; out += c;
      if (src[i + 1] === '^') { out += '^'; i++; }
      if (src[i + 1] === ']') { out += '\\]'; i++; }
      continue;
    }
    if (br && c === '[' && (src[i + 1] === ':' || src[i + 1] === '.' || src[i + 1] === '=')) {
      const end = src.indexOf(src[i + 1] + ']', i + 2);
      if (end < 0) throw new Error('invalid regular expression: brackets [] not balanced');
      out += src.slice(i, end + 2); i = end + 1;
      continue;
    }
    if (br && c === ']') br = false;
    out += c;
  }
  _M12_CONV.set(src, out);
  return out;
}
/** The compiled RegExp of an ARE pattern (flags: 'g' for scans). */
function _m12_rx(src, flags = '') { return pgRe(_m12_conv(src), 's' + flags); }
/** text ~ pattern: null when either is null. */
function _m12_re(text, src) {
  if (text === null || text === undefined || src === null || src === undefined) return null;
  return _m12_rx(src).test(String(text));
}
/** text !~ pattern */
function _m12_nre(text, src) { const r = _m12_re(text, src); return r === null ? null : !r; }
/** regexp_replace(text, pattern, literal replacement[, 'g']) */
function _m12_replace(text, src, repl, global = true) {
  if (text === null || text === undefined) return null;
  return String(text).replace(_m12_rx(src, global ? 'g' : ''), () => repl);
}
/** regexp_split_to_array(text, pattern) */
function _m12_split(text, src) {
  if (text === null || text === undefined || src === null || src === undefined) return null;
  const s = String(text), out = [];
  let last = 0;
  for (const m of s.matchAll(_m12_rx(src, 'g'))) {
    if (m[0] === '') continue;
    out.push(s.slice(last, m.index));
    last = m.index + m[0].length;
  }
  out.push(s.slice(last));
  return out;
}
/** Every match of a pattern: { pos (0-based character position), text, groups }. */
function _m12_matches(text, src) {
  const s = String(text), out = [];
  let u = 0, cp = 0;
  for (const m of s.matchAll(_m12_rx(src, 'g'))) {
    if (m[0] === '') continue;
    cp += Array.from(s.slice(u, m.index)).length; u = m.index;
    out.push({ pos: cp, text: m[0], groups: m.slice(1) });
  }
  return out;
}
/** SQL three-valued logic. */
function _m12_not(a) { return a === null || a === undefined ? null : !a; }
function _m12_or(...xs) { let n = false; for (const x of xs) { if (x === true) return true; if (x === null || x === undefined) n = true; } return n ? null : false; }
function _m12_and(...xs) { let n = false; for (const x of xs) { if (x === false) return false; if (x === null || x === undefined) n = true; } return n ? null : true; }
function _m12_eq(a, b) { return a === null || a === undefined || b === null || b === undefined ? null : a === b; }
/** x IN (list): null when x is null (list not empty) or when nothing matched and the list holds a null. */
function _m12_in(x, list) {
  if (!list.length) return false;
  if (x === null || x === undefined) return null;
  if (list.includes(x)) return true;
  return list.some((v) => v === null || v === undefined) ? null : false;
}
/** jsonb ? key */
function _m12_has(j, k) {
  if (j === null || j === undefined || k === null || k === undefined) return null;
  if (Array.isArray(j)) return j.some((e) => e === k);
  if (typeof j === 'object') return Object.prototype.hasOwnProperty.call(j, k);
  return typeof j === 'string' && j === k;
}
/** jsonb -> key (null for a missing key or a non-object) */
function _m12_get(j, k) {
  return j !== null && typeof j === 'object' && !Array.isArray(j) && k !== null && k !== undefined
    && Object.prototype.hasOwnProperty.call(j, k) ? j[k] : null;
}
/** jsonb ->> key */
function _m12_txt(j, k) { return jtext(_m12_get(j, k)); }
/** jsonb_array_elements (SQL NULL gives no rows) */
function _m12_elems(j) {
  if (j === null || j === undefined) return [];
  if (!Array.isArray(j)) throw new Error(typeof j === 'object' ? 'cannot extract elements from an object' : 'cannot extract elements from a scalar');
  return j;
}
/** jsonb_array_elements_text */
function _m12_elemsText(j) { return _m12_elems(j).map((v) => jtext(v)); }
/** jsonb || jsonb */
function _m12_concat(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  const obj = (x) => typeof x === 'object' && !Array.isArray(x);
  if (obj(a) && obj(b)) return { ...a, ...b };
  return [...(Array.isArray(a) ? a : [a]), ...(Array.isArray(b) ? b : [b])];
}
/** text || text: null when any part is null */
function _m12_cat(...parts) { return parts.some((p) => p === null || p === undefined) ? null : parts.join(''); }
/** lower(): one character to one character (glibc towlower) */
function _m12_lower(s) {
  if (s === null || s === undefined) return null;
  let out = '';
  for (const c of String(s)) {
    if (c === 'İ') { out += 'i'; continue; }
    const l = c.toLowerCase();
    out += Array.from(l).length === 1 ? l : c;
  }
  return out;
}
/** translate(s, from, to) */
function _m12_translate(s, from, to) {
  const key = from + '\u0000' + to;
  let map = _M12_TR.get(key);
  if (!map) {
    map = new Map();
    const f = Array.from(from), tt = Array.from(to);
    f.forEach((c, i) => { if (!map.has(c)) map.set(c, i < tt.length ? tt[i] : ''); });
    _M12_TR.set(key, map);
  }
  let out = '';
  for (const c of s) out += map.has(c) ? map.get(c) : c;
  return out;
}
/** s LIKE pattern (ci: ILIKE), backslash escapes */
function _m12_like(s, pat, ci = false) {
  if (s === null || s === undefined || pat === null || pat === undefined) return null;
  if (ci) { s = _m12_lower(s); pat = _m12_lower(pat); }
  pat = String(pat);
  let re = _M12_LIKE.get(pat);
  if (!re) {
    let src = '^';
    const p = Array.from(pat);
    for (let i = 0; i < p.length; i++) {
      let c = p[i];
      if (c === '\\') {
        if (++i >= p.length) throw new Error('LIKE pattern must not end with escape character');
        c = p[i];
      } else if (c === '%') { src += '.*'; continue; } else if (c === '_') { src += '.'; continue; }
      src += c.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
    }
    re = new RegExp(src + '$', 'su');
    _M12_LIKE.set(pat, re);
  }
  return re.test(String(s));
}
/** Text comparison of the en_US.UTF-8 collation (see the file header). */
function _m12_collate(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  const k = (s) => String(s).replace(/[^\p{L}\p{N}\p{M}]/gu, '');
  return _M12_COLL.compare(k(a), k(b)) || (a < b ? -1 : 1);
}
/** array(select distinct x ... order by x) / array_agg(distinct x) for text */
function _m12_distinctSorted(list) { return Array.from(new Set(list)).sort(_m12_collate); }
/** Number of characters */
function _m12_len(s) { return s === null || s === undefined ? null : Array.from(String(s)).length; }
/** substr(s, from) (1-based) */
function _m12_substr(s, from) { return Array.from(String(s)).slice(from - 1).join(''); }
/** float8::numeric keeps 15 significant digits */
function _m12_float(x) { return x === null || x === undefined || !Number.isFinite(x) ? x : Number(x.toPrecision(15)); }
/** A uuid argument as Postgres casts it */
function _m12_uuid(v) { return v === null || v === undefined ? null : castUuid(v); }
/** to_char(ts, 'YYYYMMDDHH24MISS') in Cairo time */
function _m12_stamp(ts) { const p = cairoParts(ts); return `${p.y}${pad(p.mo)}${pad(p.d)}${pad(p.h)}${pad(p.mi)}${pad(p.s)}`; }
/** current_setting(name, true): set by the API functions (set_config(..., true)); null when unset. */
function _m12_setting(name) {
  if (typeof current_setting === 'function') return current_setting(name, true);
  return DB && DB.settings && DB.settings[name] !== undefined ? DB.settings[name] : null;
}

/* ------------------------------------------------------------------------------------- Emergency pre-screen */

// Normalization shared by every text rule: Unicode compatibility forms (NFKC: full-width letters, Arabic presentation
// forms), Cyrillic and Greek look-alikes as Latin letters, lower case, no tashkeel/tatweel, unified
// hamza/alef/ya/ta-marbuta and Persian letter forms, Arabic-Indic and Persian digits as 0-9, the Arabic decimal and
// thousands separators as "." and ",", straight quotes, hyphens and underscores as spaces, single spaces.
const _M12_HOMOGLYPHS_FROM = 'АВЕКМНОРСТХІЈЅ'
  + 'аеорсухіјѕһԁ'
  + 'ΑΒΕΗΙΚΜΝΟΡΤΧΥοαερικτνυ';
const _M12_HOMOGLYPHS_TO = 'abekmhopctxijsaeopcyxijshdabehikmnoptxyoaepiktvu';
const _M12_LETTERS_FROM = 'أإآٱىةؤئیک'
  + '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹'
  + '٫٬’‘`´“”–—_';
const _M12_LETTERS_TO = 'اااايهوييك'
  + '01234567890123456789' + '.,' + "''''" + '""' + '   ';

function fn_normalize_text(p) {
  let s = String(coalesce(p, '')).normalize('NFKC');
  s = _m12_translate(s, _M12_HOMOGLYPHS_FROM, _M12_HOMOGLYPHS_TO);
  s = _m12_replace(s, '[\\u064B-\\u0652\\u0640\\u0670]', '');
  s = _m12_translate(_m12_lower(s), _M12_LETTERS_FROM, _M12_LETTERS_TO);
  return trimChars(_m12_replace(s, '[\\s\\-]+', ' '), ' ');
}

// Deterministic emergency pre-screen. Runs before any model in Companion, Care Access, follow-ups and care-team
// messages. Category patterns come from safety_rules.emergency_patterns and are applied to normalized text.
//   level emergency  a life-threatening sign: fixed emergency guidance (call 123) and a critical inbox item
//   level same_day   an urgent diabetes problem (an infected or black foot wound): see a doctor today, high-priority item
// p_opts: linked (the patient has a care team, so the text may say the team was told) and writer (patient or
// caregiver; a family member reporting someone else's suicidal thoughts gets guidance for the helper).
function fn_emergency_prescreen(p_text, p_opts = {}) {
  const cfg = fn_rule('emergency_patterns');
  const th = fn_rule('glucose_thresholds');
  const v_text = fn_normalize_text(p_text).replace(/'/g, '');
  const C = (k) => _m12_txt(cfg, k);
  const v_matched = [];
  const v_urgent = [];
  const v_linked = coalesce(castBool(_m12_txt(p_opts, 'linked')), false);
  if (v_text === '' || cfg === null || cfg === undefined) {
    return { emergency: false, urgent: false, level: 'none', matched: [] };
  }
  const v_glucose = _m12_cat('(', C('glucose_words_en'), ')|(', C('glucose_words_ar'), ')');
  // Contextual categories (stroke, seizure, coma) are skipped in a clause that is clearly educational or historical,
  // unless that clause also says it is happening now. Each clause is judged on its own, so a question elsewhere in
  // the message ("but what is a stroke anyway?") never hides a symptom.
  const v_clauses = _m12_split(v_text, coalesce(C('clause_split'), '[.!?]')) || [];
  for (const c of _m12_elems(_m12_get(cfg, 'categories'))) {
    let v_hit;
    if (coalesce(castBool(_m12_txt(c, 'contextual')), false)) {
      v_hit = v_clauses.some((cl) => _m12_or(_m12_re(cl, _m12_txt(c, 'en')), _m12_re(cl, _m12_txt(c, 'ar'))) === true
        && _m12_or(_m12_not(_m12_or(_m12_re(cl, C('unless_en')), _m12_re(cl, C('unless_ar')))), _m12_re(cl, C('happening_now'))) === true);
    } else {
      v_hit = _m12_or(_m12_re(v_text, _m12_txt(c, 'en')), _m12_re(v_text, _m12_txt(c, 'ar'))) === true;
    }
    if (v_hit) v_matched.push(_m12_txt(c, 'id'));
  }
  for (const c of _m12_elems(coalesce(_m12_get(cfg, 'urgent_categories'), []))) {
    if (_m12_or(_m12_re(v_text, _m12_txt(c, 'en')), _m12_re(v_text, _m12_txt(c, 'ar'))) === true) v_urgent.push(_m12_txt(c, 'id'));
  }

  const severeHypo = castNum(_m12_txt(th, 'severe_hypo'));
  const severeHyper = castNum(_m12_txt(th, 'severe_hyper'));
  const criticalHigh = coalesce(castNum(C('critical_high')), 600);
  const judge = (v_val) => {
    if (v_val === null) return;
    if (severeHypo !== null && v_val < severeHypo) v_matched.push('glucose_very_low');
    else if (v_val >= criticalHigh) v_matched.push('glucose_critical_high');
    else if (severeHyper !== null && v_val >= severeHyper && _m12_re(v_text, C('hyper_symptoms')) === true) v_matched.push('glucose_very_high_with_symptoms');
  };
  const cps = Array.from(v_text);
  const beforeOf = (p) => cps.slice(Math.max(0, p - 30), p).join('');
  // Every 2-3 digit number near a glucose word (before or after it) is read as a glucose value in mg/dL unless it is
  // followed by a duration, percent, distance, dose or mmol unit, or preceded by an HbA1c/average word.
  const isDigit = (ch) => ch !== undefined && ch >= '0' && ch <= '9';
  let n = 1;
  for (let i = 0; i < cps.length;) {
    if (!(isDigit(cps[i]) && isDigit(cps[i + 1]))) { i++; continue; }
    const len = isDigit(cps[i + 2]) ? 3 : 2;
    const p = i;
    i += len;
    if (n > 15) break;
    n++;
    const v_num = cps.slice(p, p + len).join('');
    const v_before = beforeOf(p);
    const v_after = cps.slice(p + len, p + len + 30).join('');
    if (/^[0-9]/.test(v_after) || /^[.,][0-9]/.test(v_after) || /[0-9][.,]?$/.test(v_before)) continue;
    if (_m12_or(_m12_re(v_after, C('not_glucose_after')), _m12_re(v_before, C('not_glucose_before'))) === true) continue;
    if (_m12_nre(v_before + ' ' + v_after, v_glucose) === true) continue;
    judge(Number(v_num));
  }
  // mmol/L values next to a glucose word (not a cholesterol, potassium or ketone value) are converted (x18).
  if (C('mmol_value') !== null) {
    let k = 1;
    for (const m of _m12_matches(v_text, C('mmol_value'))) {
      if (k > 10) break;
      k++;
      const v_before = beforeOf(m.pos);
      if (_m12_or(_m12_re(v_before, C('not_glucose_lab')), _m12_nre(v_before, v_glucose)) === true) continue;
      const v_num = m.groups.length ? coalesce(m.groups[0], null) : m.text;
      judge(v_num === null ? null : castNum(v_num) * 18);
    }
  }
  // Meters and sensors display "LO" below and "HI" above their range.
  if (_m12_re(v_text, C('display_lo')) === true && _m12_re(v_text, v_glucose) === true) v_matched.push('glucose_very_low');
  if (_m12_re(v_text, C('display_hi')) === true && _m12_re(v_text, v_glucose) === true) v_matched.push('glucose_critical_high');

  const v_level = v_matched.length > 0 ? 'emergency' : v_urgent.length > 0 ? 'same_day' : 'none';
  if (v_level === 'none') return { emergency: false, urgent: false, level: 'none', matched: [] };
  let v_en, v_ar;
  if (v_level === 'emergency' && v_matched.includes('self_harm')) {
    if (coalesce(_m12_txt(p_opts, 'writer'), '') === 'caregiver' && _m12_re(v_text, C('third_person')) === true) {
      v_en = C('self_harm_caregiver_en'); v_ar = C('self_harm_caregiver_ar');
    } else {
      v_en = C('self_harm_message_en'); v_ar = C('self_harm_message_ar');
    }
    if (v_linked) { v_en = _m12_cat(v_en, ' ', C('team_note_en')); v_ar = _m12_cat(v_ar, ' ', C('team_note_ar')); }
  } else if (v_level === 'emergency') {
    v_en = C('message_en'); v_ar = C('message_ar');
  } else {
    v_en = C('urgent_message_en'); v_ar = C('urgent_message_ar');
    if (v_linked) { v_en = _m12_cat(v_en, ' ', C('urgent_team_note_en')); v_ar = _m12_cat(v_ar, ' ', C('urgent_team_note_ar')); }
  }
  return {
    emergency: v_level === 'emergency', urgent: v_level === 'same_day', level: v_level,
    matched: _m12_distinctSorted(v_matched), urgent_matched: _m12_distinctSorted(v_urgent),
    message_en: v_en, message_ar: v_ar,
  };
}

// The pre-screen for a request: knows whether the patient has a care team (so the fixed text may say the team was
// told) and who is writing.
function fn_prescreen_for(p_ctx, p_patient_id, p_text) {
  const pid = _m12_uuid(p_patient_id);
  return fn_emergency_prescreen(p_text, {
    linked: dbExists('care_team', (r) => r.patient_id === pid && r.active === true && r.organization_id !== null),
    writer: _m12_txt(p_ctx, 'role') === 'caregiver' ? 'caregiver' : 'patient',
  });
}

// Every known medicine name (generic, brand, Arabic, combination), normalized, as a regex alternation.
function fn_medicine_regex() {
  const words = new Set();
  for (const d of dbRows('drugs')) {
    words.add(fn_normalize_text(d.generic.replace(/_/g, ' ')));
    for (const b of d.brand_names || []) words.add(fn_normalize_text(b));
    for (const b of d.brand_names_ar || []) words.add(fn_normalize_text(b));
    if (d.display_ar !== null) words.add(fn_normalize_text(d.display_ar));
  }
  for (const c of dbRows('drug_combinations')) {
    words.add(fn_normalize_text(c.name));
    if (c.name_ar !== null) words.add(fn_normalize_text(c.name_ar));
  }
  const list = _m12_distinctSorted([...words].filter((w) => _m12_len(w) > 2).map((w) => w.replace(/([.+*?(){}|^$[\]\\])/g, '\\$1')));
  return list.length ? list.join('|') : null;
}

// Output-guard configuration for the AI workflows: the dose_guard rule plus the current medicine names.
function fn_dose_guard() {
  return _m12_concat(fn_rule('dose_guard'), { medicine_regex: fn_medicine_regex() });
}

// True when the message asks to change, stop, skip or dose a medicine. Such requests get a fixed answer and are
// routed to the care team instead of being answered by a model.
function fn_is_dose_change_request(p_text) {
  const cfg = fn_rule('dose_change_request');
  const v = fn_normalize_text(p_text).replace(/'/g, '');
  const meds = fn_medicine_regex();
  const C = (k) => _m12_txt(cfg, k);
  if (v === '' || cfg === null || cfg === undefined || _m12_re(v, C('exclude')) === true) return false;
  const obj_en = _m12_cat('(', C('objects_en'), '|', meds, ')');
  const obj_ar = _m12_cat('(', C('objects_ar'), '|', meds, ')');
  const R = (src) => _m12_re(v, src);
  const lazyOr = (...fns) => { let n = false; for (const f of fns) { const x = f(); if (x === true) return true; if (x === null) n = true; } return n ? null : false; };
  return lazyOr(
    () => R(C('quantity_en')),
    () => R(C('quantity_ar')),
    // verb followed by a medicine object: "stop my metformin", "ازود جرعة الانسولين"
    () => R(_m12_cat('\\y(', C('verbs_en'), ')\\y.{0,40}\\y', obj_en, '\\y')),
    () => R(_m12_cat('(^| )[هبانيت]?(', C('verbs_ar'), ')\\S*( \\S+){0,3} \\S*', obj_ar)),
    // stated intent + verb with a medicine mentioned anywhere: "my insulin is 20 units, should I increase it?",
    // "should I start insulin?", "can I replace Glucophage with Cidophage?"
    () => _m12_and(R(_m12_cat('\\y', obj_en, '\\y')),
      R(_m12_cat('\\y(', C('intent_en'), ')\\y( \\S+){0,3} (', C('verbs_en'), '|', coalesce(C('intent_verbs_en'), 'start'), ')\\y'))),
    () => _m12_and(R(obj_ar),
      R(_m12_cat('(^| )(', C('intent_ar'), ')( \\S+){0,2} [هبانيت]?(', C('verbs_ar'), '|', coalesce(C('intent_verbs_ar'), 'ابدا'), ')'))),
    // stated intent + a medicine + a swap or a new time: "can I take metformin at night instead?",
    // "ينفع اخد الجلوكوفاج بالليل بدل الصبح؟", "اخد الانسولين امتى في رمضان؟", "اشرب حلبة بدل الدوا؟"
    () => _m12_and(R(_m12_cat('\\y', obj_en, '\\y')), R(_m12_cat('\\y(', C('intent_en'), ')\\y')),
      R(coalesce(C('swap_timing_en'), '\\yinstead\\y'))),
    () => _m12_and(R(obj_ar), R(_m12_cat('(^| )(', C('intent_ar'), ')( |$|[؟?!.,،])')), R(coalesce(C('swap_timing_ar'), 'بدل'))),
  );
}

/* --------------------------------------------------------------- Glucose ingest with deterministic event detection */

// p_value::text keeps the number as JavaScript prints it (a numeric scale such as 120.0 is not kept).
function fn_add_glucose(p_patient_id, p_value, p_measured_at, p_source, p_context, p_dedupe = null) {
  const th = fn_rule('glucose_thresholds');
  const pid = _m12_uuid(p_patient_id);
  const value = castNum(p_value);
  const measured = coalesce(castTs(p_measured_at), now());
  if (t(measured) > t(now()) + 10 * MIN) {
    fn_raise('bad_request: The reading time is in the future. Please check the date and time.');
  }
  const v_reading = dbInsert('glucose_readings', {
    patient_id: pid, value_mgdl: value, measured_at: measured, source: coalesce(p_source, 'patient'),
    context: p_context, dedupe_key: p_dedupe,
  }, { onConflict: 'nothing' });
  if (v_reading === null) return { reading: null, event: null, duplicate: true };

  const num = (k) => castNum(_m12_txt(th, k));
  const lt = (k) => { const x = num(k); return x !== null && value !== null && value < x; };
  const ge = (k) => { const x = num(k); return x !== null && value !== null && value >= x; };
  const v_type = lt('severe_hypo') ? 'severe_hypo' : lt('hypo') ? 'hypo' : ge('severe_hyper') ? 'severe_hyper' : ge('hyper') ? 'hyper' : null;
  const msg = (lang) => {
    const tpl = jtext(_m12_get(_m12_get(_m12_get(th, 'messages'), v_type), lang));
    return tpl === null || value === null ? null : tpl.split('{value}').join(String(value));
  };

  let v_event = null;
  // Guidance is returned for every out-of-range reading taken in the last 2 hours (also repeats within an hour);
  // live alerts (events, clinician inbox) are raised for readings from the last 6 hours, at most one per type per hour.
  if (v_type !== null && t(v_reading.measured_at) > t(now()) - 2 * HOUR) {
    v_event = { type: v_type, new_alert: false, message_en: msg('en'), message_ar: msg('ar') };
  }
  // Any low or high reading: the provider panel recomputes this patient's state.
  if (v_type !== null) dbDeleteWhere('patient_state_cache', (r) => r.patient_id === pid);
  const at = t(v_reading.measured_at);
  if (v_type !== null && at > t(now()) - 6 * HOUR
      && !dbExists('glucose_events', (e) => e.patient_id === pid && e.type === v_type
        && t(e.occurred_at) > at - 60 * MIN && t(e.occurred_at) <= at + 60 * MIN)) {
    const ev = dbInsert('glucose_events', { patient_id: pid, type: v_type, value_mgdl: value, reading_id: v_reading.id, occurred_at: v_reading.measured_at });
    fn_emit(v_type.endsWith('hypo') ? 'HypoglycemiaDetected' : 'HyperglycemiaDetected', pid, ev.id, { type: v_type, value });
    v_event = { ...coalesce(v_event, { type: v_type, message_en: msg('en'), message_ar: msg('ar') }), new_alert: true };
  }

  if (p_source === 'nightscout' || p_source === 'device') {
    dbUpdateWhere('cgm_connections', (r) => r.patient_id === pid,
      (r) => ({ last_reading_at: iso(maxOf([t(r.last_reading_at), t(v_reading.measured_at)])) }));
  }
  if (v_reading.source === 'patient') fn_emit('GlucoseReadingReceived', pid, String(v_reading.id), { source: v_reading.source });
  // A falling trend that will cross the low threshold soon (23_prediction.js); not when this reading is already low.
  const v_prediction = v_type !== null && v_type.endsWith('hypo') ? null : fn_predict_low(pid, v_reading);
  // During a Ramadan fast: "break your fast" for a reading out of the safe range (24_ramadan.js).
  const v_ramadan = fn_ramadan_check_reading(pid, v_reading);

  return {
    reading: { id: v_reading.id, value_mgdl: v_reading.value_mgdl, measured_at: v_reading.measured_at, source: v_reading.source, context: v_reading.context },
    event: v_event,
    ...(v_prediction ? { prediction: v_prediction } : {}),
    ...(v_ramadan ? { ramadan: v_ramadan } : {}),
  };
}

/* ------------------------------------------------ Medication safety: interactions, allergy, condition, renal */

function fn_drug_matches(p_rule, p_generic, p_class) {
  return _m12_or(_m12_eq(p_rule, p_generic),
    _m12_and(_m12_like(p_rule, 'class:%'), p_rule === null || p_rule === undefined ? null : _m12_eq(_m12_substr(p_rule, 7), p_class)));
}

// Strips strengths, units and dosage-form words so "Glucophage XR 1000 mg tablets" or "أماريل 2 مجم" can be matched.
function fn_clean_drug_name(p_name) {
  let s = fn_normalize_text(p_name);
  s = _m12_replace(s, '[0-9]+([.,][0-9]+)?', ' ');
  s = _m12_replace(s, '[/+&()%]', ' ');
  s = _m12_replace(s, '\\y(mg|mcg|g|gm|ml|iu|units?|tablets?|tabs?|caps?|capsules?|injection|injections|pen|pens|flexpen|solostar|kwikpen|vial|vials|مجم|ملجم|جم|مل|وحده|وحدات|اقراص|قرص|حبوب|حقن|حقنه|قلم|كبسول|كبسولات)\\y', ' ');
  return trimChars(_m12_replace(s, '\\s+', ' '), ' ');
}

// Returns a copy of the app.drugs row, or null.
function fn_resolve_drug(p_name) {
  const v = fn_clean_drug_name(p_name);
  if (v === '') return null;
  const N = (s) => fn_normalize_text(s);
  const vNoAl = _m12_replace(v, '^ال', '', false);
  const hits = [];
  for (const d of dbRows('drugs')) {
    const gn = N(d.generic.replace(/_/g, ' '));
    const ok = gn === v || _m12_like(v, gn + ' %') === true
      || (d.brand_names || []).some((b) => N(b) === v || _m12_like(v, N(b) + ' %') === true)
      || (d.brand_names_ar || []).some((b) => { const nb = N(b); return nb === v || nb === vNoAl || _m12_like(vNoAl, nb + ' %') === true; })
      || (d.display_ar !== null && (N(d.display_ar) === v || _m12_like(v, N(d.display_ar) + ' %') === true));
    if (ok) hits.push({ d, exact: gn === v, brand: (d.brand_names || []).some((b) => N(b) === v), len: _m12_len(d.generic) });
  }
  const best = orderBy(hits, [(h) => (h.exact ? 1 : 0), 'desc'], [(h) => (h.brand ? 1 : 0), 'desc'], [(h) => h.len, 'desc'])[0];
  return best ? { ...best.d } : null;
}

// All active ingredients of a medicine name: a known combination product, an "a + b" style name, or a single drug.
function fn_resolve_components(p_name) {
  const v = fn_clean_drug_name(p_name);
  const N = (s) => fn_normalize_text(s);
  const combo = orderBy(dbWhere('drug_combinations', (dc) => v === N(dc.name) || _m12_like(v, N(dc.name) + ' %') === true
      || (dc.name_ar !== null && (v === N(dc.name_ar) || _m12_like(v, N(dc.name_ar) + ' %') === true))),
    [(dc) => _m12_len(dc.name), 'desc'])[0];
  if (combo) {
    // The known ingredients, in the order the database returns them (its plan scans app.drugs and probes the list).
    const comps = combo.components || [];
    const out = dbRows('drugs').flatMap((d) => comps.filter((c) => c === d.generic));
    if (out.length > 0) return out;
  }
  const v_out = [];
  if (_m12_re(p_name, '[+/&]| and | و ') === true) {
    for (const part of _m12_split(p_name, '[+/&]| and | و ')) {
      const d = fn_resolve_drug(part);
      const g = d ? d.generic : null;
      if (g !== null && !v_out.includes(g)) v_out.push(g);
    }
    if (v_out.length > 0) return v_out;
  }
  const d = fn_resolve_drug(p_name);
  return d ? [d.generic] : [];
}

// Maps what a person calls an allergy ("penicillin", "sulfa drugs", a brand name) to an allergy group.
function fn_allergy_class(p_substance, p_class) {
  const nc = fn_normalize_text(p_class);
  const syn = dbOne('allergy_synonyms', (s) => s.term === nc);
  if (syn && syn.allergy_class !== null) return syn.allergy_class;
  if (p_class !== null && p_class !== undefined) {
    const lc = _m12_lower(trimChars(String(p_class), ' '));
    const d = dbOne('drugs', (x) => x.allergy_class === lc);
    if (d) return d.allergy_class;
  }
  const ns = fn_normalize_text(p_substance);
  const best = orderBy(dbWhere('allergy_synonyms', (s) => ns === s.term || _m12_like(ns, s.term + ' %') === true
      || _m12_like(ns, '% ' + s.term) === true || _m12_like(ns, '% ' + s.term + ' %') === true),
    [(s) => _m12_len(s.term), 'desc'])[0];
  if (best && best.allergy_class !== null) return best.allergy_class;
  const r = fn_resolve_drug(p_substance);
  return r ? r.allergy_class : null;
}

function fn_allergy_matches(p_substance, p_class, p_generic, p_drug_allergy_class) {
  const r = fn_resolve_drug(p_substance);
  if (r !== null && p_generic !== null && p_generic !== undefined && r.generic === p_generic) return true;
  return p_drug_allergy_class !== null && p_drug_allergy_class !== undefined && fn_allergy_class(p_substance, p_class) === p_drug_allergy_class;
}

const _M12_NO_COMBINE = ['sulfonylurea', 'dpp4_inhibitor', 'sglt2_inhibitor', 'glp1_agonist', 'thiazolidinedione',
  'biguanide', 'statin', 'ace_inhibitor', 'arb', 'nsaid', 'basal_insulin', 'rapid_insulin', 'beta_blocker', 'ppi', 'anticoagulant'];

// Pure computation of the findings that currently apply to one medicine (all its active ingredients).
// returns table(kind, severity, rule_ref, title, detail) -> array of rows.
function fn_compute_findings(p_medication_id) {
  const out = [];
  const m = dbGet('medications', _m12_uuid(p_medication_id));
  if (!m || m.status !== 'active' || m.verification_status === 'refuted') return out;
  const v_egfr = castNum(_m12_txt(fn_egfr(m.patient_id), 'value_exact'));
  const ingredients = (x) => (x.components && x.components.length ? x.components : [x.generic]);
  const name = (g) => initcap(g.replace(/_/g, ' '));
  const least = (a, b) => (_m12_collate(a, b) <= 0 ? a : b);
  const greatest = (a, b) => (_m12_collate(a, b) >= 0 ? a : b);
  const others = [];
  for (const om of dbWhere('medications', (r) => r.patient_id === m.patient_id && r.status === 'active' && r.verification_status !== 'refuted' && r.id !== m.id)) {
    for (const og of ingredients(om)) {
      const od = og === null ? null : dbGet('drugs', og);
      if (od) others.push({ id: om.id, generic: og, cls: od.drug_class });
    }
  }
  for (const g of ingredients(m)) {
    if (g === null) continue;
    const d = dbGet('drugs', g);
    if (!d) continue;

    // Drug-drug interactions against the ingredients of the other active, non-refuted medicines
    for (const o of others) {
      // Therapeutic duplication: the same medicine under two names, two medicines of a class that is not combined
      // (two sulfonylureas, two DPP-4 inhibitors, two basal insulins, two statins, two NSAIDs ...), or a class pair that
      // should not be combined (ACE inhibitor with ARB, DPP-4 inhibitor with GLP-1 agonist).
      const pair = (a, b) => [a, b].includes(o.cls) && [a, b].includes(d.drug_class) && o.cls !== d.drug_class;
      if (o.generic === d.generic || (o.cls === d.drug_class && _M12_NO_COMBINE.includes(d.drug_class))
          || pair('ace_inhibitor', 'arb') || pair('dpp4_inhibitor', 'glp1_agonist')) {
        const same = o.generic === d.generic;
        out.push({
          kind: 'interaction',
          severity: same || ['sulfonylurea', 'basal_insulin', 'rapid_insulin', 'anticoagulant', 'nsaid'].includes(d.drug_class)
            || ([o.cls, d.drug_class].every((x) => ['ace_inhibitor', 'arb'].includes(x))) ? 'major' : 'moderate',
          rule_ref: `DUP-${least(m.id, o.id)}-${greatest(m.id, o.id)}-${least(d.generic, o.generic)}`,
          title: same ? `Same medicine twice: ${name(d.generic)}` : `Duplicate therapy: ${name(d.generic)} + ${name(o.generic)}`,
          detail: same
            ? 'Two medicines on the list contain the same active ingredient (different brand names). Taking both doubles the dose. The prescriber should confirm which one to keep.'
            : 'Two medicines of the same kind (or a combination that is usually avoided) are on the list. The prescriber should confirm that both are intended.',
        });
      }
      for (const r of dbRows('drug_interactions')) {
        if (!((fn_drug_matches(r.a, d.generic, d.drug_class) === true && fn_drug_matches(r.b, o.generic, o.cls) === true)
            || (fn_drug_matches(r.b, d.generic, d.drug_class) === true && fn_drug_matches(r.a, o.generic, o.cls) === true))) continue;
        out.push({
          kind: 'interaction', severity: r.severity,
          rule_ref: `DDI-${r.id}-${least(m.id, o.id)}-${greatest(m.id, o.id)}`,
          title: `${name(d.generic)} + ${name(o.generic)}`,
          detail: _m12_cat(r.effect, ' ', r.recommendation),
        });
      }
    }

    // Allergy: same drug, or the same allergy group ("penicillin", "sulfa drugs", brand names, Arabic names)
    for (const a of dbWhere('allergies', (al) => al.patient_id === m.patient_id && al.verification_status !== 'refuted' && al.status === 'active'
        && fn_allergy_matches(al.substance, al.substance_class, d.generic, d.allergy_class))) {
      out.push({
        kind: 'allergy', severity: a.severity === 'severe' ? 'contraindicated' : 'major',
        rule_ref: `ALG-${a.id}-${m.id}-${d.generic}`,
        title: `Recorded allergy: ${a.substance}`,
        detail: `${name(d.generic)} is the same medicine or belongs to the same allergy group as the recorded allergy (${a.substance}, reaction: ${coalesce(a.reaction, 'not recorded')}). Confirm with the prescriber before taking it.`,
      });
    }

    // Condition and kidney-function rules (unrounded eGFR)
    for (const r of dbRows('drug_condition_rules')) {
      if (fn_drug_matches(r.drug, d.generic, d.drug_class) !== true) continue;
      const byCondition = r.condition_code_prefix !== null && dbExists('conditions', (c) => c.patient_id === m.patient_id && c.status === 'active'
        && c.verification_status !== 'refuted' && _m12_like(c.code, r.condition_code_prefix + '%') === true);
      const byKidney = r.egfr_below !== null && v_egfr !== null && v_egfr < r.egfr_below && (r.egfr_at_least === null || v_egfr >= r.egfr_at_least);
      if (!byCondition && !byKidney) continue;
      out.push({
        kind: r.egfr_below !== null ? 'renal' : 'condition', severity: r.severity,
        rule_ref: `DCR-${r.id}-${m.id}`,
        title: r.title,
        detail: r.detail + (r.egfr_below !== null ? ` Latest eGFR: ${v_egfr === null ? '' : String(round(v_egfr))}.` : ''),
      });
    }
  }
  return out;
}

// Synchronizes stored findings with the current computation for one medicine: adds new ones (with events and a
// clinician inbox item), re-opens ones that apply again, and resolves ones whose basis has gone.
function fn_medication_safety(p_medication_id) {
  const m = dbGet('medications', _m12_uuid(p_medication_id));
  if (!m) return [];
  const v_refs = [];
  const found = [...fn_compute_findings(m.id)].sort((a, b) => _m12_collate(a.rule_ref, b.rule_ref));
  const seen = new Set();
  for (const f of found) {
    if (seen.has(f.rule_ref)) continue;                        // distinct on (rule_ref)
    seen.add(f.rule_ref);
    v_refs.push(f.rule_ref);
    let r = null;
    const existing = dbOne('safety_findings', (x) => x.patient_id === m.patient_id && x.rule_ref === f.rule_ref);
    if (!existing) {
      r = dbInsert('safety_findings', { patient_id: m.patient_id, medication_id: m.id, kind: f.kind, severity: f.severity, rule_ref: f.rule_ref, title: f.title, detail: f.detail });
    } else if (existing.status === 'resolved') {
      r = dbUpdate('safety_findings', existing, { status: 'open', severity: f.severity, detail: f.detail, created_at: now(), explanation: null, explanation_ar: null });
    }
    if (r) {
      fn_emit('MedicationSafetyFindingCreated', r.patient_id, r.id, { severity: r.severity, kind: r.kind });
      fn_create_inbox_item(r.patient_id, 'safety',
        ({ contraindicated: 'critical', major: 'high', moderate: 'medium' })[r.severity] || 'low',
        ({ contraindicated: 1, major: 2 })[r.severity] || 3,
        'Medication safety: ' + r.title, r.detail, { finding_id: r.id, medication_id: r.medication_id },
        `safety:${r.id}:${_m12_stamp(now())}`);
    }
  }
  // Findings stored for this medicine that no longer apply (medicine stopped or refuted, the other medicine stopped,
  // allergy or condition refuted, kidney function improved) are resolved together with their inbox items.
  // When the change was made by the patient or a family member (app.actor_role, set by the API function), the
  // clinician's safety items stay open: the clinician confirms the change instead of it disappearing silently.
  const gone = dbWhere('safety_findings', (x) => x.medication_id === m.id && x.status !== 'resolved' && !v_refs.includes(x.rule_ref));
  for (const x of gone) dbUpdate('safety_findings', x, { status: 'resolved' });
  if (gone.length && !['patient', 'caregiver'].includes(coalesce(_m12_setting('app.actor_role'), ''))) {
    const ids = gone.map((x) => x.id);
    dbUpdateWhere('inbox_items', (i) => i.status !== 'RESOLVED' && i.category === 'safety' && ids.includes(_m12_txt(i.payload, 'finding_id')),
      { status: 'RESOLVED', updated_at: now() });
  }
  return jsonAgg(orderBy(dbWhere('safety_findings', (sf) => sf.medication_id === m.id && sf.status !== 'resolved'), (sf) => t(sf.created_at))
    .map((sf) => omit(sf, 'patient_id', 'acknowledged_by', 'rule_ref'))) ?? [];
}

// Re-evaluates every medicine of a patient. Call after anything a rule depends on changes: medicines, allergies,
// conditions, kidney labs, verification decisions.
function fn_recheck_patient_safety(p_patient_id) {
  const pid = _m12_uuid(p_patient_id);
  for (const m of dbWhere('medications', (r) => r.patient_id === pid)) fn_medication_safety(m.id);
}

/* ------------------------------------------------------------- Care Access: next question + care-level engine */

// p_q: an intake_questions row. Returns true, false or null (SQL).
function fn_question_visible(p_q, p_answers) {
  const showIf = p_q ? p_q.show_if : null;
  if (showIf === null || showIf === undefined) return true;
  const qid = _m12_txt(showIf, 'question_id');
  const a = _m12_has(p_answers, qid);
  if (a === false) return false;
  return _m12_and(a, _m12_in(_m12_txt(p_answers, qid), _m12_elemsText(_m12_get(showIf, 'in'))));
}

function fn_next_question(p_answers) {
  const q = orderBy(dbWhere('intake_questions', (x) => _m12_not(_m12_has(p_answers, x.id)) === true && fn_question_visible(x, p_answers) === true),
    (x) => x.position)[0];
  return q ? omit(q, 'position', 'required', 'show_if') : null;
}

// Returns true, false or null (SQL): a null inside "all" does not fail it, a null inside "any" does not satisfy it.
function fn_rule_matches(p_cond, p_answers) {
  if (_m12_has(p_cond, 'default') === true) return true;
  if (_m12_has(p_cond, 'all') === true) {
    for (const c of _m12_elems(_m12_get(p_cond, 'all'))) if (_m12_not(fn_rule_matches(c, p_answers)) === true) return false;
    return true;
  }
  if (_m12_has(p_cond, 'any') === true) {
    for (const c of _m12_elems(_m12_get(p_cond, 'any'))) if (fn_rule_matches(c, p_answers) === true) return true;
    return false;
  }
  if (_m12_has(p_cond, 'red_flag_any') === true) {
    const flags = _m12_elemsText(coalesce(_m12_get(p_answers, 'q_red_flags'), []));
    if (!flags.length) return false;
    const want = _m12_elemsText(_m12_get(p_cond, 'red_flag_any'));
    return flags.some((f) => _m12_in(f, want) === true);
  }
  if (_m12_has(p_cond, 'answer') === true) {
    const ans = _m12_get(p_cond, 'answer');
    const v_q = _m12_txt(ans, 'q');
    if (_m12_not(_m12_has(p_answers, v_q)) === true) return false;
    const v_val = _m12_txt(p_answers, v_q);
    const cmp = (key, op) => {
      const m = v_val === null ? null : /^-?[0-9.]+$/.test(v_val);
      if (m === false) return false;
      const a = v_val === null ? null : castNum(v_val);
      const b = castNum(_m12_txt(ans, key));
      const r = a === null || b === null ? null : op(a, b);
      return m === null ? (r === false ? false : null) : r;
    };
    if (_m12_has(ans, 'in') === true) return _m12_in(v_val, _m12_elemsText(_m12_get(ans, 'in')));
    if (_m12_has(ans, 'gte') === true) return cmp('gte', (a, b) => a >= b);
    if (_m12_has(ans, 'lt') === true) return cmp('lt', (a, b) => a < b);
    if (_m12_has(ans, 'lte') === true) return cmp('lte', (a, b) => a <= b);
    if (_m12_has(ans, 'neq') === true) { const x = _m12_txt(ans, 'neq'); return v_val === null || x === null ? null : v_val !== x; }
  }
  return false;
}

function fn_specialty_for_area(p_area) {
  return ({
    chest: 'cardiology', breathing: 'pulmonology', digestive: 'gastroenterology', urinary: 'urology', skin_foot: 'diabetic_foot',
    eyes: 'ophthalmology', head_neuro: 'neurology', joints: 'orthopedics', mental: 'psychiatry', diabetes: 'endocrinology',
  })[p_area] || 'family_medicine';
}

function fn_assess_episode(p_episode_id) {
  const id = _m12_uuid(p_episode_id);
  const e = dbGet('episodes', id) || { id: null, patient_id: null, answers: null, chief_complaint: null };
  const v_red = _m12_elemsText(coalesce(_m12_get(e.answers, 'q_red_flags'), [])).filter((x) => x !== null && x !== 'none');
  const v_fired = [];
  let v_level = null, v_spec = null, v_channel = null;
  for (const r of orderBy(dbRows('care_level_rules'), (x) => x.priority)) {
    if (fn_rule_matches(r.condition, e.answers) === true) {
      v_fired.push(r.code);
      v_level = r.care_level;
      v_spec = coalesce(r.specialty, fn_specialty_for_area(_m12_txt(e.answers, 'q_area')));
      v_channel = r.channel;
      break;
    }
  }
  const a = dbInsert('triage_assessments', { episode_id: e.id, care_level: v_level, specialty: v_spec, channel: v_channel, rules_fired: v_fired, red_flags: v_red });
  dbUpdateWhere('episodes', (x) => x.id === e.id, {
    status: ['emergency_services', 'emergency_department'].includes(v_level) ? 'ESCALATED' : 'ASSESSED', updated_at: now(),
  });
  fn_emit('EpisodeAssessed', e.patient_id, e.id, { care_level: v_level, assessment_id: a.id });
  if (['emergency_services', 'emergency_department', 'urgent_care', 'same_day'].includes(v_level)) {
    const emergency = v_level.startsWith('emergency');
    fn_create_inbox_item(e.patient_id, 'episode', emergency ? 'critical' : 'high', emergency ? 1 : 2,
      'Care Access: ' + v_level.replace(/_/g, ' ') + ' - ' + left(e.chief_complaint, 80),
      'Red flags: ' + coalesce(nullif(v_red.join(', '), ''), 'none'),
      { episode_id: e.id }, 'episode:' + e.id);
  }
  return { care_level: v_level, specialty: v_spec, channel: v_channel, rules_fired: v_fired, red_flags: v_red };
}

/* ----------------------------------------------- Facility matching (capacity is operational data; stale = unknown) */

function fn_haversine_km(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((x) => x === null || x === undefined)) return null;
  const rad = (x) => Number(x) * (Math.PI / 180);
  return 6371 * 2 * Math.asin(Math.sqrt(Math.pow(Math.sin(rad(lat2 - lat1) / 2), 2)
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.pow(Math.sin(rad(lng2 - lng1) / 2), 2)));
}

// f: a facilities row.
function fn_facility_json(f, p_lat, p_lng) {
  const h = localHour(now());
  const stale = (c) => t(c.updated_at) < t(now()) - 6 * HOUR;
  return {
    id: f.id, name: f.name, name_ar: f.name_ar, type: f.type, governorate: f.governorate, city: f.city,
    address: f.address, phone: f.phone, lat: f.lat, lng: f.lng,
    distance_km: p_lat === null || p_lat === undefined || f.lat === null ? null : round(_m12_float(fn_haversine_km(p_lat, p_lng, f.lat, f.lng)), 1),
    specialties: f.specialties, services: f.services,
    // where the listing comes from: the verified network, or the OpenStreetMap directory (© OpenStreetMap contributors)
    source: f.source || 'network', verified: f.source !== 'openstreetmap',
    // unknown hours: a network facility is taken as open (its hours are recorded when they are limited); a directory
    // listing without hours is unknown
    open_now: f.open_hour === null ? (f.source === 'openstreetmap' ? null : true) : _m12_and(h >= f.open_hour, f.close_hour === null ? null : h < f.close_hour),
    capacity: jsonAgg(dbWhere('facility_capacity', (c) => c.facility_id === f.id).sort((a, b) => _m12_collate(a.resource, b.resource)).map((c) => ({
      resource: c.resource,
      available: stale(c) ? null : c.available,
      total: c.total,
      status: stale(c) ? 'unknown' : c.status,
      updated_at: c.updated_at,
      stale: stale(c),
    }))) ?? [],
  };
}

function fn_match_facilities(p) {
  const P = (k) => _m12_txt(p, k);
  const lat = () => castNum(P('lat'), 'double precision');
  const lng = () => castNum(P('lng'), 'double precision');
  const spec = nullif(P('specialty'), '');
  // Directory listings (imported from OpenStreetMap: unverified, no capacity, no referral agreement) are found only when
  // the caller asks for the directory (include_directory: the patient's "find a doctor or pharmacy" and the Companion's
  // find_care); care-access recommendations and referrals use the verified network only.
  const withDirectory = coalesce(castBool(P('include_directory')), false);
  const rows = [];
  for (const f of dbRows('facilities')) {
    if (f.source === 'openstreetmap' && !withDirectory) continue;
    let typeOk;
    if (_m12_has(p, 'types') === true) typeOk = _m12_in(f.type, _m12_elemsText(_m12_get(p, 'types'))) === true;
    else if (nullif(P('type'), '') !== null) typeOk = f.type === P('type');
    else typeOk = true;
    if (!typeOk) continue;
    if (!(nullif(P('governorate'), '') === null || f.governorate === P('governorate'))) continue;
    if (!(spec === null || (f.specialties || []).includes(spec) || coalesce(castBool(P('specialty_soft')), false))) continue;
    if (!(nullif(P('service'), '') === null || (f.services || []).includes(P('service')))) continue;
    if (!(nullif(P('q'), '') === null || _m12_like([f.name, f.name_ar, f.city, (f.specialties || []).filter((x) => x !== null).join(' ')].join(' '), '%' + P('q') + '%', true) === true)) continue;
    const rank = (spec !== null && (f.specialties || []).includes(spec) ? 0 : 1)
      // a fresh "full" report for the needed resource pushes the facility to the end
      + (nullif(P('avoid_full'), '') !== null && dbExists('facility_capacity', (fc) => fc.facility_id === f.id && fc.resource === P('avoid_full')
          && fc.status === 'full' && t(fc.updated_at) > t(now()) - 6 * HOUR) ? 4 : 0)
      // without coordinates, prefer the patient's governorate
      + (P('lat') === null && nullif(P('prefer_governorate'), '') !== null && f.governorate !== P('prefer_governorate') ? 2 : 0);
    const dist = P('lat') === null || f.lat === null ? null : fn_haversine_km(lat(), lng(), f.lat, f.lng);
    rows.push({ f, rank, dist });
  }
  const limit = minOf([coalesce(castInt(nullif(P('limit'), '')), 20), 50]);
  if (limit < 0) throw new Error('LIMIT must not be negative');
  rows.sort((a, b) => a.rank - b.rank
    || (a.dist === null ? (b.dist === null ? 0 : 1) : b.dist === null ? -1 : a.dist - b.dist)
    || _m12_collate(a.f.name, b.f.name));
  return jsonAgg(rows.slice(0, limit).map((x) => fn_facility_json(x.f, P('lat') === null ? null : lat(), P('lng') === null ? null : lng()))) ?? [];
}

function fn_recommend_facilities(p_episode_id) {
  const id = _m12_uuid(p_episode_id);
  const a = orderBy(dbWhere('triage_assessments', (x) => x.episode_id === id), [(x) => t(x.created_at), 'desc'])[0] || null;
  const ep = dbGet('episodes', id);
  const pt = ep ? dbGet('patients', ep.patient_id) : null;
  if (!a || a.care_level === 'self_care') return [];
  const v_emergency = ['emergency_services', 'emergency_department'].includes(a.care_level);
  const v_types = ({
    emergency_services: ['emergency_department', 'hospital'], emergency_department: ['emergency_department', 'hospital'],
    urgent_care: ['urgent_care', 'hospital', 'emergency_department'], specialist: ['hospital', 'polyclinic'],
    same_day: ['urgent_care', 'polyclinic', 'clinic'],
  })[a.care_level] || ['clinic', 'polyclinic'];
  return fn_match_facilities(stripNulls({
    types: v_types, specialty: v_emergency ? null : a.specialty, specialty_soft: true,
    avoid_full: v_emergency || a.care_level === 'urgent_care' ? 'er_accepting' : null,
    prefer_governorate: pt ? pt.governorate : null, lat: pt ? pt.lat : null, lng: pt ? pt.lng : null, limit: 5,
  }));
}

/**
 * concat_ws('-', ref_low, ref_high). The database prints a numeric with its stored scale ("4.0-5.6", "3.5-5.0"); Sheets
 * keeps only the number, so both bounds are printed with the larger number of decimals of the two (true for every
 * range of the lab catalog).
 */
function _m12_range_text(low, high) {
  const vals = [low, high].filter((x) => x !== null && x !== undefined).map(Number);
  const dec = Math.max(0, ...vals.map((x) => (String(x).split('.')[1] || '').length));
  return vals.map((x) => (/e/i.test(String(x)) ? String(x) : x.toFixed(dec))).join('-');
}

/* ------------------------------------------------------------------------------------------------------------
   AI context package: de-identified, scoped, with provenance and data age.
   No names, phone numbers, MRNs, or addresses are ever sent to a model.
------------------------------------------------------------------------------------------------------------ */
// Whether each measure meets the person's care-plan target, decided here and never by a model (medgemma:4b called an
// HbA1c of 6.9% "above the 7% target"). Boundaries follow the app's target labels (CarePlanView): HbA1c, after-meal
// sugar and blood pressure "below", time in range and daily steps "at least", fasting sugar a range. A measure without
// a value or a target is left out. status: meets_target | above_target | below_target.
function fn_target_checks(p_patient_id, p_targets, p_g14, p_steps_avg) {
  const pid = _m12_uuid(p_patient_id);
  const num = (v) => { try { return castNum(v); } catch (e) { return null; } };
  const tg = p_targets || {}, g = p_g14 || {};
  const T = (k) => num(tg[k]);
  // basis: the person's care plan, or the standard targets (no active plan; such targets are not personal ones).
  const basis = tg.personalized ? 'care_plan' : 'standard';
  const out = [];
  const add = (measure, value, unit, target, status, extra) => {
    if (value !== null && value !== undefined && status) out.push({ measure, value, unit, target, status, basis, ...(extra || {}) });
  };
  const hb = orderBy(dbWhere('lab_results', (x) => x.patient_id === pid && x.test_code === 'hba1c' && x.verification_status !== 'refuted'),
    [(x) => t(x.observed_at), 'desc'])[0];
  const a1c = hb ? num(hb.value) : null;
  if (a1c !== null && T('hba1c_target') !== null) {
    add('HbA1c (latest)', a1c, '%', 'below ' + T('hba1c_target'), a1c < T('hba1c_target') ? 'meets_target' : 'above_target',
      // estimated average glucose (ADAG: 28.7 x HbA1c - 46.7 mg/dL), so a model quotes it instead of converting itself
      { age_days: daysBetween(today(), localDate(hb.observed_at)), eag_mgdl: round(28.7 * a1c - 46.7) });
  }
  const tir = num(g.tir);
  if (tir !== null && T('tir_target') !== null) {
    add('Time in range (14 days)', tir, '%', 'at least ' + T('tir_target'), tir >= T('tir_target') ? 'meets_target' : 'below_target');
  }
  const fm = num(g.fasting_mean), fl = T('fasting_low'), fh = T('fasting_high');
  if (fm !== null && fl !== null && fh !== null) {
    add('Fasting glucose average (14 days)', fm, 'mg/dL', fl + '-' + fh, fm < fl ? 'below_target' : fm > fh ? 'above_target' : 'meets_target');
  }
  const pm = num(g.post_meal_mean);
  if (pm !== null && T('post_meal_high') !== null) {
    add('After-meal glucose average (14 days)', pm, 'mg/dL', 'below ' + T('post_meal_high'), pm < T('post_meal_high') ? 'meets_target' : 'above_target');
  }
  // Blood pressure: the average of the readings of the last 14 days (one reading does not show control).
  const bp = dbWhere('vitals', (v) => v.patient_id === pid && v.type === 'blood_pressure' && t(v.measured_at) > t(now()) - 14 * DAY
    && num(v.systolic) !== null && num(v.diastolic) !== null);
  if (bp.length && T('bp_systolic') !== null && T('bp_diastolic') !== null) {
    const sys = round(avg(bp.map((v) => num(v.systolic)))), dia = round(avg(bp.map((v) => num(v.diastolic))));
    add('Blood pressure average (14 days)', sys + '/' + dia, 'mmHg', 'below ' + T('bp_systolic') + '/' + T('bp_diastolic'),
      sys < T('bp_systolic') && dia < T('bp_diastolic') ? 'meets_target' : 'above_target', { readings: bp.length });
  }
  const steps = num(p_steps_avg);
  if (steps !== null && T('steps_target') !== null) {
    add('Daily steps average (7 days)', steps, 'steps', 'at least ' + T('steps_target'), steps >= T('steps_target') ? 'meets_target' : 'below_target');
  }
  return out;
}

function fn_ai_context(p_patient_id) {
  const pid = _m12_uuid(p_patient_id);
  const pt = dbGet('patients', pid);
  const age = fn_age(pt ? pt.date_of_birth : null);
  const plan = dbOne('care_plans', (cp) => cp.patient_id === pid && cp.status === 'ACTIVE');
  const latestLabs = [];
  const byTest = new Map();
  for (const l of orderBy(dbWhere('lab_results', (x) => x.patient_id === pid && x.verification_status !== 'refuted'), [(x) => t(x.observed_at), 'desc'])) {
    if (!byTest.has(l.test_code)) byTest.set(l.test_code, l);
  }
  for (const code of [...byTest.keys()].sort(_m12_collate)) {
    const l = byTest.get(code);
    const lc = dbGet('lab_catalog', code);
    if (!lc) continue;                                           // join lab_catalog using (test_code)
    latestLabs.push({
      ref: 'lab:' + l.id, test: lc.display, value: l.value, unit: l.unit,
      ref_range: _m12_range_text(lc.ref_low, lc.ref_high),
      observed_at: l.observed_at, age_days: daysBetween(today(), localDate(l.observed_at)), verification: l.verification_status,
    });
  }
  const weekAgo = addDays(today(), -7);
  const stepsByDay = new Map();
  for (const a of dbWhere('activity_logs', (x) => x.patient_id === pid && x.date > weekAgo)) stepsByDay.set(a.date, (stepsByDay.get(a.date) || 0) + a.steps);
  const targets = fn_targets(pid);
  const g14 = fn_glucose_metrics(pid, 14);
  const stepsAvg = round(avg([...stepsByDay.values()]));
  return {
    // Ages of 90 and over are reported as "90+" (HIPAA Safe Harbor).
    patient: {
      age: age !== null && age >= 90 ? '90+' : age,
      sex: pt ? pt.sex : null, diabetes_type: pt ? pt.diabetes_type : null,
      years_since_diagnosis: pt && pt.diagnosis_year !== null ? cairoParts(now()).y - pt.diagnosis_year : null,
      preferred_language: pt ? pt.preferred_language : null,
    },
    state: fn_patient_state(pid),
    policy_targets: targets,
    target_checks: fn_target_checks(pid, targets, g14, stepsAvg),
    conditions: jsonAgg(dbWhere('conditions', (c) => c.patient_id === pid && c.status === 'active' && c.verification_status !== 'refuted')
      .map((c) => ({ ref: 'condition:' + c.id, display: c.display, code: c.code, verification: c.verification_status, source: c.source }))) ?? [],
    medications: jsonAgg(dbWhere('medications', (m) => m.patient_id === pid && m.status === 'active' && m.verification_status !== 'refuted')
      .map((m) => {
        // The Arabic spellings from the drug reference, so a model copies a name instead of transliterating it
        // (Gemini wrote «جلوكاجه» for Glucophage). The brand lists are not index-aligned, so all names are given.
        const d = m.generic ? dbGet('drugs', m.generic) : null;
        const ar = d ? [d.display_ar, ...(d.brand_names_ar || [])].filter((x) => x) : [];
        return {
          ref: 'medication:' + m.id, name: m.name, generic: m.generic, ...(ar.length ? { names_ar: [...new Set(ar)] } : {}),
          class: m.drug_class, dose_text: m.dose_text, frequency: m.frequency,
          verification: m.verification_status, adherence_7d: fn_adherence(pid, 7, m.id),
        };
      })) ?? [],
    allergies: jsonAgg(dbWhere('allergies', (a) => a.patient_id === pid && a.verification_status !== 'refuted' && a.status === 'active')
      .map((a) => ({ ref: 'allergy:' + a.id, substance: a.substance, reaction: a.reaction, severity: a.severity, verification: a.verification_status }))) ?? [],
    labs: jsonAgg(latestLabs) ?? [],
    egfr: fn_egfr(pid),
    glucose_14d: g14,
    glucose_90d: omit(fn_glucose_metrics(pid, 90), 'latest'),
    patterns: fn_detect_patterns(pid, 14),
    open_safety_findings: jsonAgg(dbWhere('safety_findings', (f) => f.patient_id === pid && f.status === 'open')
      .map((f) => ({ ref: 'finding:' + f.id, severity: f.severity, title: f.title, detail: f.detail }))) ?? [],
    care_plan: plan ? {
      ref: 'careplan:' + plan.id, version: plan.version, title: plan.title, summary: plan.summary, targets: plan.targets,
      items: jsonAgg(dbWhere('care_plan_items', (i) => i.plan_id === plan.id).map((i) => ({ kind: i.kind, title: i.title, detail: i.detail }))) ?? [],
    } : null,
    screenings: fn_screenings(pid),
    recent_vitals: jsonAgg(orderBy(dbWhere('vitals', (v) => v.patient_id === pid), [(v) => t(v.measured_at), 'desc']).slice(0, 6)
      .map((v) => ({ type: v.type, systolic: v.systolic, diastolic: v.diastolic, value: v.value, unit: v.unit, measured_at: v.measured_at }))) ?? [],
    lifestyle_7d: {
      steps_avg: stepsAvg,
      sleep_avg: round(avg(dbWhere('sleep_logs', (s) => s.patient_id === pid && s.date > weekAgo).map((s) => s.hours)), 1),
      meals_logged: dbCount('meal_logs', (ml) => ml.patient_id === pid && t(ml.eaten_at) > t(now()) - 7 * DAY),
    },
    // How the person likes to be helped (32_personal.js): wording, voice, meals, shift and sleep times, budget. No identifiers.
    preferences: omit(fn_preferences(pid), 'updated_at', 'goals_text'),
    generated_at: now(),
  };
}

/* ------------------------------------------------------------------------------------------------------------
   Action Validator: the only path by which AI output reaches clinical tables.
   Validates action type, authority level, policy, and payload shape.
   A JSON null "citations" is stored as [] (a Sheets cell cannot hold JSON null in a not-null column).
------------------------------------------------------------------------------------------------------------ */
function fn_apply_ai_action(p_action) {
  const A = (k) => _m12_txt(p_action, k);
  const v_type = A('type');
  const v_pid = castUuid(A('patient_id'));
  const v_run = castUuid(nullif(A('ai_run_id'), ''));
  const v_trigger = coalesce(A('trigger'), 'companion');
  const v_human_only = ['treatment_change', 'prescription', 'dose_adjustment', 'diagnosis', 'care_plan_authorship', 'medication_change'];
  let v_id = null;
  if (v_type !== null && v_human_only.includes(v_type)) {
    dbInsert('audit_logs', { action: 'ai.action_rejected', entity: v_type, patient_id: v_pid, detail: p_action });
    return { applied: false, reason: 'human_only_action' };
  }
  // Polyclinic results (40_clinic.js) have their own checks; the diabetes AI policy does not apply to them.
  if (v_type !== null && v_type.startsWith('clinic_')) return fn_clinic_apply_action(p_action);
  const v_policy = fn_policy(v_pid, v_trigger);
  const actions = _m12_get(v_policy, 'actions');

  if (v_type === 'patient_insight') {
    // Data-driven insights need a policy that allows them (excluded populations: pregnancy, type 1, pump, under 18
    // get none). Explanations of a deterministic safety finding or of the clinician's own plan are always allowed.
    if (!['safety', 'plan_change'].includes(coalesce(A('kind'), 'pattern'))
        && _m12_not(_m12_or(_m12_has(actions, 'patient_explanation'), _m12_has(actions, 'observation_summary'))) === true) {
      dbInsert('audit_logs', { action: 'ai.action_denied', entity: v_type, patient_id: v_pid,
        detail: { ai_run_id: v_run, reasons: _m12_get(v_policy, 'reasons'), exclusions: _m12_get(v_policy, 'exclusions') } });
      return { applied: false, reason: 'policy_denied' };
    }
    if (coalesce(A('title'), '') === '' || coalesce(A('body'), '') === '') return { applied: false, reason: 'invalid_payload' };
    // One insight per source (a pattern, a lab result, a finding, a plan version, a week): a retried event updates it
    // instead of adding a second copy, and the person is notified only the first time.
    let v_new = true;
    const row = dbInsert('patient_insights', {
      patient_id: v_pid, kind: coalesce(A('kind'), 'pattern'), title: left(A('title'), 200), title_ar: left(nullif(A('title_ar'), ''), 200),
      body: A('body'), body_ar: A('body_ar'), citations: coalesce(_m12_get(p_action, 'citations'), []), ai_run_id: v_run,
      source_ref: nullif(A('source_ref'), ''),
    }, { onConflict: { cols: ['patient_id', 'kind', 'source_ref'], set: (ex, nr) => {
      v_new = false;
      return { title: nr.title, title_ar: nr.title_ar, body: nr.body, body_ar: nr.body_ar, citations: nr.citations, ai_run_id: nr.ai_run_id };
    } } });
    v_id = row.id;
    if (v_new) {
      fn_notify_patient(v_pid, 'insight', left(A('title'), 200), left(A('body'), 280), 'insight:' + v_id,
        left(nullif(A('title_ar'), ''), 200), left(nullif(A('body_ar'), ''), 280));
    }

  } else if (v_type === 'clinician_review_task') {
    if (_m12_not(_m12_has(actions, 'clinician_review_task')) === true) return { applied: false, reason: 'policy_denied' };
    v_id = fn_create_inbox_item(v_pid, coalesce(A('category'), 'ai_review'),
      coalesce(A('urgency'), 'medium'), coalesce(castInt(A('priority')), 3),
      left(A('title'), 200), A('body'), _m12_concat(coalesce(_m12_get(p_action, 'payload'), {}), { ai_run_id: v_run }),
      A('dedupe_key'));

  } else if (v_type === 'finding_explanation') {
    const fid = castUuid(A('finding_id'));
    const f = dbOne('safety_findings', (x) => x.id === fid && x.patient_id === v_pid);
    if (f) { dbUpdate('safety_findings', f, { explanation: A('body'), explanation_ar: A('body_ar') }); v_id = f.id; }

  } else if (v_type === 'plan_what_changed') {
    const pl = castUuid(A('plan_id'));
    const cp = dbOne('care_plans', (x) => x.id === pl && x.patient_id === v_pid);
    if (cp) { dbUpdate('care_plans', cp, { what_changed: { en: A('body'), ar: A('body_ar') } }); v_id = cp.id; }

  } else if (v_type === 'assessment_explanation') {
    const ep = castUuid(A('episode_id'));
    const ta = orderBy(dbWhere('triage_assessments', (x) => x.episode_id === ep), [(x) => t(x.created_at), 'desc'])[0];
    if (ta) { dbUpdate('triage_assessments', ta, { explanation: { en: A('body'), ar: A('body_ar') } }); v_id = ta.id; }

  } else if (v_type === 'previsit_brief') {
    const ap = castUuid(nullif(A('appointment_id'), ''));
    const appt = dbOne('appointments', (x) => x.id === ap && x.patient_id === v_pid);
    v_id = dbInsert('previsit_briefs', {
      patient_id: v_pid, appointment_id: appt ? appt.id : null, content: _m12_get(p_action, 'content'),
      sources: coalesce(_m12_get(p_action, 'sources'), []), model: A('model'), ai_run_id: v_run,
    }).id;

  } else {
    return { applied: false, reason: 'unknown_action_type' };
  }

  dbInsert('audit_logs', { action: v_id === null ? 'ai.action_not_applied' : 'ai.action_applied', entity: v_type, entity_id: v_id, patient_id: v_pid, detail: { ai_run_id: v_run } });
  return { applied: v_id !== null, id: v_id };
}

// AI run bookkeeping used by every agent workflow
// A retried event closes the earlier unfinished run of the same workflow, so each event has one open run at most.
function fn_ai_run_start(p_workflow, p_patient_id, p_event_id, p_input, p_model, p_prompt_version) {
  const ev = _m12_uuid(p_event_id);
  if (ev !== null) {
    dbUpdateWhere('ai_runs', (r) => r.event_id === ev && r.workflow === p_workflow && ['QUEUED', 'PROCESSING', 'VERIFYING'].includes(r.status),
      { status: 'FAILED', error: 'superseded by a retry of the same event', completed_at: now() });
  }
  return dbInsert('ai_runs', { workflow: p_workflow, patient_id: _m12_uuid(p_patient_id), event_id: ev, status: 'PROCESSING', input: p_input, model: p_model, prompt_version: p_prompt_version }).id;
}

// guard.prompt_version (set by the AI gate node: prompt name + hash of the exact system prompt text) replaces the
// version label given at start, so every trace points at the prompt text that produced it.
function fn_ai_run_finish(p_id, p_status, p_output, p_guard, p_verifier, p_error) {
  const id = _m12_uuid(p_id);
  dbUpdateWhere('ai_runs', (r) => r.id === id, (r) => ({
    status: p_status, output: p_output, guard: p_guard, verifier: p_verifier, error: p_error,
    prompt_version: coalesce(nullif(_m12_txt(p_guard, 'prompt_version'), ''), r.prompt_version),
    completed_at: now(), latency_ms: castInt(t(now()) - t(r.created_at)),
  }));
}

/* ------------------------------------------------------------------------------------------------------------
   AI gates (consent, cloud egress, identifiers, prompt-injection and PHI rules)
   The rules are applied in the n8n "AI gate" Code nodes (workflows/src/ai-lib.mjs); the engine decides who may be
   processed by which kind of model and supplies the identifiers that must never reach a cloud model.
------------------------------------------------------------------------------------------------------------ */

// Latest recorded AI-processing consent: 'granted', 'withdrawn' or 'not_recorded'.
function fn_ai_consent(p_patient_id) {
  const pid = _m12_uuid(p_patient_id);
  const c = orderBy(dbWhere('consents', (x) => x.patient_id === pid && x.type === 'ai_processing'),
    [(x) => t(x.granted_at), 'desc'], [(x) => x.id, 'desc'])[0];
  return c ? (c.granted ? 'granted' : 'withdrawn') : 'not_recorded';
}

// Gate decision and rules for one AI step about one patient (p_patient_id may be null for steps without a patient).
//   ai_allowed     false when the patient withdrew AI-processing consent: no model of any kind runs, fixed text only.
//   cloud_allowed  true only with explicit consent and the ai_cloud_egress flag on; otherwise local models or fixed text.
//   identifiers    the patient's and their family members' identifiers, removed from any text sent to a cloud model.
function fn_ai_gate(p_patient_id, p_purpose) {
  const pid = _m12_uuid(p_patient_id);
  const v_consent = pid === null ? 'not_applicable' : fn_ai_consent(pid);
  const flag = dbGet('feature_flags', 'ai_cloud_egress');
  let v_egress = coalesce(flag ? flag.enabled : null, false);
  const v_budget = coalesce(fn_rule('ai_budget'), {});
  const B = (k, d) => coalesce(castInt(_m12_txt(v_budget, k)), d);
  let v_ids = [];
  const v_reasons = [];
  if (pid !== null) {
    const pt = dbGet('patients', pid);
    const ids = [['name', pt && pt.full_name], ['name', pt && pt.full_name_ar], ['phone', pt && pt.phone], ['mrn', pt && pt.mrn], ['dob', pt && pt.date_of_birth]];
    const u = pt && pt.user_id !== null ? dbGet('users', pt.user_id) : null;
    if (u) ids.push(['email', u.email]);
    // family members who follow the record write in the same chat and are named in it
    const family = dbWhere('caregiver_grants', (g) => g.patient_id === pid && g.active === true).map((g) => dbGet('users', g.caregiver_user_id)).filter(Boolean);
    for (const f of family) ids.push(['name', f.full_name]);
    for (const f of family) ids.push(['name', f.full_name_ar]);
    for (const f of family) ids.push(['email', f.email]);
    const seen = new Set();
    v_ids = ids.filter(([, v]) => v !== null && v !== undefined && v !== false && _m12_len(trimChars(String(v), ' ')) >= 2)
      .map(([type, v]) => ({ type, value: String(v) }))
      .filter((x) => { const k = JSON.stringify([x.type, x.value]); if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => _m12_collate(a.type, b.type) || _m12_collate(a.value, b.value));
  }
  if (v_consent === 'withdrawn') v_reasons.push('ai_consent_withdrawn');
  if (v_consent === 'not_recorded') v_reasons.push('ai_consent_not_recorded');
  if (!v_egress) v_reasons.push('cloud_egress_disabled');
  // Free-tier protection (rule ai_budget): a daily budget of cloud calls (in total and per patient), and a circuit
  // breaker that keeps work on the local model for a while after repeated cloud failures, instead of every request
  // waiting for a model that is down or out of quota.
  if (v_egress) {
    const dayStartMs = t(dateTrunc('day', now()));
    const cloud = (r) => coalesce(_m12_txt(_m12_get(r.guard, 'gate'), 'model_route'), _m12_txt(_m12_get(r.guard, 'gate'), 'route')) === 'cloud';
    const windowMs = B('breaker_window_minutes', 10) * MIN;
    if (dbCount('ai_runs', (r) => t(r.created_at) > dayStartMs && cloud(r)) >= B('cloud_calls_per_day', 400)) {
      v_egress = false; v_reasons.push('cloud_daily_budget_used');
    } else if (pid !== null && dbCount('ai_runs', (r) => r.patient_id === pid && t(r.created_at) > dayStartMs && cloud(r)) >= B('cloud_calls_per_patient_per_day', 60)) {
      v_egress = false; v_reasons.push('cloud_patient_budget_used');
    } else if (dbCount('ai_runs', (r) => t(r.created_at) > t(now()) - windowMs
        && _m12_or(_m12_has(coalesce(_m12_get(r.verifier, 'issues'), []), 'fallback_path'),
          // the cloud model gave no answer (a draft the guard refused is not a cloud failure)
          _m12_and(r.status === 'FALLBACK', _m12_eq(_m12_txt(_m12_get(r.guard, 'gate'), 'route'), 'cloud'),
            _m12_eq(coalesce(_m12_txt(r.guard, 'model_answered'), _m12_txt(r.guard, 'used_ai')), 'false'))) === true) >= B('breaker_failures', 3)) {
      v_egress = false; v_reasons.push('cloud_breaker_open');
    }
  }
  return {
    purpose: p_purpose, consent: v_consent,
    ai_allowed: v_consent !== 'withdrawn',
    cloud_allowed: ['granted', 'not_applicable'].includes(v_consent) && v_egress,
    reasons: v_reasons,
    identifiers: v_ids,
    phi: coalesce(fn_rule('phi_patterns'), {}),
    injection: coalesce(fn_rule('prompt_injection'), {}),
  };
}

// Model-bound Companion requests for this patient (written by them or their family) in the last hour and the last
// 24 hours (rolling), against the companion_gate limits. Requests answered with fixed text (emergency pre-screen,
// dose policy, a gate) never count: they cost no model call. The request being prepared is already counted.
function fn_companion_rate(p_patient_id) {
  const pid = _m12_uuid(p_patient_id);
  const cfg = coalesce(fn_rule('companion_gate'), {});
  const runs = dbWhere('ai_runs', (r) => r.patient_id === pid && r.workflow === 'WF-001 Companion' && t(r.created_at) > t(now()) - DAY
    && !['deterministic-prescreen', 'deterministic-policy', 'deterministic-gate'].includes(coalesce(r.model, '')));
  const h = runs.filter((r) => t(r.created_at) > t(now()) - HOUR).length;
  const d = runs.length;
  return {
    last_hour: h, last_day: d,
    limited: h > coalesce(castInt(_m12_txt(cfg, 'per_hour')), 60) || d > coalesce(castInt(_m12_txt(cfg, 'per_day')), 300),
    message_en: _m12_txt(cfg, 'rate_en'), message_ar: _m12_txt(cfg, 'rate_ar'),
    no_consent_en: _m12_txt(cfg, 'no_consent_en'), no_consent_ar: _m12_txt(cfg, 'no_consent_ar'),
  };
}

/* ------------------------------------------------------------------------------------------------- RAG retrieval */

// Light stemming shared by documents and queries: the Arabic article with attached prepositions (ال، وال، بال، فال،
// كال، لل) and a few English suffixes. Symmetric, so it only has to be consistent, not linguistically complete.
function fn_rag_stem(w) {
  if (w === null || w === undefined) return null;
  const len = _m12_len(w);
  if (_m12_re(w, '^[\\u0600-\\u06ff]+$')) {
    if (_m12_re(w, '^(وال|فال|بال|كال)') && len > 5) return _m12_substr(w, 4);
    if (_m12_re(w, '^لل') && len > 4) return _m12_substr(w, 3);
    if (_m12_re(w, '^ال') && len > 4) return _m12_substr(w, 3);
    return w;
  }
  if (_m12_re(w, '^[a-z]+$')) {
    if (_m12_re(w, 'ies$') && len > 5) return _m12_replace(w, 'ies$', 'y', false);
    if (_m12_re(w, 'ing$') && len > 5) return _m12_replace(w, 'ing$', '', false);
    if (_m12_re(w, '[^s]s$') && len > 4) return _m12_replace(w, 's$', '', false);
    return w;
  }
  return w;
}

// Full-text search form of a text: normalized like the safety rules, punctuation removed (including the Arabic comma,
// semicolon, question mark and percent signs, which sit inside the Arabic Unicode block), each word stemmed.
function fn_rag_search_text(p) {
  const s = _m12_replace(_m12_replace(fn_normalize_text(p), '[\\u060c\\u061b\\u061f\\u066a-\\u066d\\u06d4]', ' '), '[^a-z0-9\\u0600-\\u06ff ]+', ' ');
  return _m12_split(s, '\\s+').filter((w) => w !== '').map(fn_rag_stem).join(' ');
}

// Query preparation: informative terms (stop words removed), and an English expansion of Arabic medical words from the
// rag_config glossary. nomic-embed-text places any Arabic text close to any Arabic document, so Arabic questions are
// embedded together with their English expansion (cross-lingual retrieval) and matched on the expanded terms as well.
function fn_rag_prepare_query(p_query, p_language = null) {
  const cfg = coalesce(fn_rule('rag_config'), {});
  const v_q = left(trimChars(String(coalesce(p_query, '')), ' '), 1000);
  const v_lang = coalesce(nullif(p_language, ''), _m12_re(v_q, '[\\u0600-\\u06ff]') ? 'ar' : 'en');
  const v_tokens = fn_rag_search_text(v_q).split(' ').filter((w) => w !== '');
  const stop = (w) => coalesce(_m12_has(_m12_get(cfg, 'stopwords'), w), false) || coalesce(_m12_has(_m12_get(cfg, 'domain_stopwords'), w), false);
  // Search terms: three characters or more and not a stop word (one- and two-letter words match almost every chunk).
  const v_terms = _m12_distinctSorted(v_tokens.filter((w) => _m12_len(w) > 2 && !stop(w)));
  // The glossary sees every word, so short Arabic words such as "رز" (rice) still expand. An Arabic word also matches
  // with one attached prefix (و ف ب ل ك: "بقدمي") or a possessive or plural ending ("رجليه", "تحاليلي").
  const exp = [];
  const glossHit = (t) => v_tokens.some((w) => w === t || (_m12_re(t, '^[\\u0600-\\u06ff]{2,}$') && (
    (w.length === t.length + 1 && 'وفبلك'.includes(w[0]) && w.slice(1) === t)
    || (t.length >= 3 && w.startsWith(t) && ['ي', 'ه', 'ها', 'هم', 'ك', 'نا', 'ات', 'ين', 'ون'].includes(w.slice(t.length))))));
  for (const g of _m12_elems(coalesce(_m12_get(cfg, 'glossary'), []))) {
    if (_m12_elemsText(_m12_get(g, 'terms')).some((x) => glossHit(fn_rag_stem(fn_normalize_text(x))))) {
      const en = _m12_txt(g, 'en');
      if (en !== null) exp.push(en);
    }
  }
  const v_exp = exp.length ? _m12_distinctSorted(exp).join(' ') : null;
  const v_all = _m12_distinctSorted([...v_terms,
    ...(v_exp === null ? [] : fn_rag_search_text(v_exp).split(' ').filter((w) => _m12_len(w) > 2 && !stop(w)))]);
  return {
    query: v_q, language: v_lang, terms: v_terms, expansion: v_exp, fts_terms: v_all,
    embed_text: 'search_query: ' + v_q + (v_exp === null ? '' : ' ' + v_exp),
  };
}

/** text::vector (an array of numbers is taken as it is) */
function _m12_vector(s) {
  let v;
  if (Array.isArray(s)) v = s;
  else try { v = JSON.parse(String(s)); } catch (e) { v = null; }
  if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
    throw new Error(`invalid input syntax for type vector: "${String(s).slice(0, 60)}"`);
  }
  return v;
}
/** pgvector a <=> b (cosine distance; float4 vectors, float accumulators) */
function _m12_cosine_distance(a, b) {
  if (a.length !== b.length) throw new Error(`different vector dimensions ${a.length} and ${b.length}`);
  const f = Math.fround;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = f(a[i]), y = f(b[i]);
    dot = f(dot + f(x * y)); na = f(na + f(x * x)); nb = f(nb + f(y * y));
  }
  let sim = dot / Math.sqrt(na * nb);
  if (sim > 1) sim = 1; else if (sim < -1) sim = -1;
  return 1 - sim;
}

// Hybrid search over approved, current, unquarantined chunks: vector similarity (only against vectors made by the same
// embedding model) and stemmed full-text term hits, merged with reciprocal-rank fusion. A chunk is returned only when it
// is relevant enough: similarity above the floor for its language, or enough query terms, or one term plus a near-miss
// similarity. At most max_chunks_per_doc chunks per document. An empty list means "no approved evidence".
// p_audience ('patient' or 'clinician') gives a small boost to documents written for that reader; both kinds are
// returned. Each result carries its provenance (publisher, edition, link, DOI/PMID, license) for citations.
// p_embedding: the query vector as text ('[0.1, ...]'), or null/'' for full-text only.
function fn_rag_search(p_query, p_embedding, p_k = 5, p_language = null, p_embed_model = null, p_audience = null) {
  const cfg = coalesce(fn_rule('rag_config'), {});
  const prep = fn_rag_prepare_query(p_query, p_language);
  const N = (k, d) => coalesce(castNum(_m12_txt(cfg, k)), d);
  const v_terms = _m12_elemsText(prep.fts_terms);
  const v_emb = nullif(p_embedding, '') !== null && p_embedding !== undefined ? _m12_vector(p_embedding) : null;
  const v_floor = N('min_similarity', 0.60);
  const v_floor_ar = N('min_similarity_ar_doc', 0.80);
  const v_margin = N('near_miss_margin', 0.10);
  const v_strong = coalesce(castInt(_m12_txt(cfg, 'strong_fts_terms')), 2);
  const v_strong_margin = N('strong_terms_margin', 0.15);
  // Without a query vector (embedding service down) a chunk must contain most of the question's informative terms:
  // one incidental shared word is not evidence in a large knowledge base.
  const v_need = Math.max(1, Math.min(3, Math.ceil(N('fts_only_coverage', 0.6) * Math.max(1, prep.terms.length))));
  const v_per_doc = coalesce(castInt(_m12_txt(cfg, 'max_chunks_per_doc')), 2);
  const v_per_source = coalesce(castInt(_m12_txt(cfg, 'max_chunks_per_source')), 3);
  const v_chars = coalesce(castInt(_m12_txt(cfg, 'max_content_chars')), 1200);
  const v_lang = prep.language;
  const day = today();

  const approved = [];
  for (const c of dbRows('rag_chunks')) {
    const d = dbGet('rag_documents', c.document_id);
    if (!d || d.status !== 'approved' || d.superseded_by !== null || !(d.review_date === null || d.review_date >= day) || c.quarantined) continue;
    approved.push({ c, d, search_text: coalesce(c.search_text, fn_rag_search_text(c.content)) });
  }
  const sameModel = (a) => v_emb !== null && a.c.embedding !== null && (p_embed_model === null || p_embed_model === undefined || a.c.embed_model === null || a.c.embed_model === p_embed_model);
  for (const a of approved) a.dist = sameModel(a) ? _m12_cosine_distance(a.c.embedding, v_emb) : null;
  const vec = new Set([...approved].filter(sameModel).sort((x, y) => x.dist - y.dist).slice(0, 30));
  const termSet = new Set(v_terms);
  const hitsIn = (text) => { const toks = new Set(String(text).split(' ')); let n = 0; for (const x of v_terms) if (toks.has(x)) n++; return n; };
  const cand = approved.filter((a) => vec.has(a) || (v_terms.length > 0 && a.search_text.split(/\s+/).some((w) => termSet.has(w)))).map((a) => ({
    ...a,
    sim: a.dist === null ? null : 1 - a.dist,
    hits: hitsIn(a.search_text),
    title_hits: hitsIn(fn_rag_search_text(a.d.title)),
    floor: a.d.language === 'ar' ? v_floor_ar : v_floor,
  }));
  const kept = cand.filter((x) => (x.sim !== null && (x.sim >= x.floor || (x.hits >= v_strong && x.sim >= x.floor - v_strong_margin)
      || (x.hits >= 1 && x.sim >= x.floor - v_margin))) || (x.sim === null && x.hits >= v_need));
  // Score: a weighted sum of the similarity (scaled between the weakest and the best kept chunk) and the share of the
  // query's terms the chunk contains, plus small boosts for query terms in the title, the query's language and the
  // reader. Weights in rag_config, tuned on ai/evals/retrieval.json (scripts/eval-retrieval.mjs). fusion 'rrf' keeps
  // the earlier reciprocal-rank fusion, whose fixed boosts outweighed real differences in similarity.
  const sims = kept.filter((x) => x.sim !== null).map((x) => x.sim);
  const sLo = sims.length ? Math.min(...sims) : 0, sHi = sims.length ? Math.max(...sims) : 0;
  const maxHits = Math.max(1, ...kept.map((x) => x.hits));
  const w = { vector: N('weight_vector', 0.7), terms: N('weight_terms', 0.3), title: N('boost_title', 0.05),
    language: N('boost_language', 0.03), audience: N('boost_audience', 0.02) };
  const rrf = _m12_txt(cfg, 'fusion') === 'rrf', minmax = _m12_txt(cfg, 'similarity_scale') === 'minmax';
  for (const x of kept) {
    x.vrank = 1 + kept.filter((y) => x.sim === null ? y.sim !== null : y.sim !== null && y.sim > x.sim).length;
    x.frank = 1 + kept.filter((y) => y.hits > x.hits).length;
    const sameLang = x.d.language === v_lang, sameReader = p_audience !== null && p_audience !== undefined && x.d.audience === p_audience;
    x.score = rrf
      ? (x.sim !== null ? 1 / (60 + x.vrank) : 0) + (x.hits > 0 ? 1 / (60 + x.frank) : 0)
        + 0.004 * x.title_hits + (sameLang ? 0.003 : 0) + (sameReader ? 0.003 : 0)
      : w.vector * (x.sim === null ? 0 : minmax ? (sHi > sLo ? (x.sim - sLo) / (sHi - sLo) : 1)
        : Math.max(0, Math.min(1, (x.sim - (x.floor - v_margin)) / (1 - (x.floor - v_margin))))) + w.terms * (x.hits / maxHits)
        + w.title * Math.min(2, x.title_hits) + (sameLang ? w.language : 0) + (sameReader ? w.audience : 0);
  }
  // Relative cut: a chunk far below the best match (by more than relative_margin) rode in on a shared generic word and
  // dilutes the citations ("what to eat for breakfast" also got the sick-day guide). A chunk whose title contains a query
  // term stays: "does walking after meals help" ranks the eating guide first but needs "Physical activity and diabetes".
  const v_rel = N('relative_margin', 0.08);
  const topSim = maxOf(kept.map((x) => x.sim));
  const relevant = kept.filter((x) => topSim === null || x.sim === null || x.title_hits > 0 || topSim - x.sim <= v_rel);
  // Diversity: at most max_chunks_per_doc chunks of one document and max_chunks_per_source of one guideline source
  // (a fetched guideline edition is split into many documents).
  const byScore = [...relevant].sort((a, b) => b.score - a.score);
  const docN = new Map(), srcN = new Map();
  for (const x of byScore) {
    const sk = coalesce(x.d.source_key, x.d.id);
    docN.set(x.d.id, (docN.get(x.d.id) || 0) + 1); x.doc_rank = docN.get(x.d.id);
    srcN.set(sk, (srcN.get(sk) || 0) + 1); x.source_rank = srcN.get(sk);
  }
  const k = Math.max(1, Math.min(coalesce(p_k, 5), 10));
  const res = byScore.filter((x) => x.doc_rank <= v_per_doc && x.source_rank <= v_per_source).slice(0, k);
  return jsonAgg(res.map((r) => ({
    id: 'guideline:' + r.d.id + '#' + r.c.chunk_index,
    title: r.d.title, source: r.d.source, version: r.d.version, language: r.d.language,
    publisher: r.d.publisher, url: r.d.source_url, doi: _m12_txt(r.d.external_ids, 'doi'), pmid: _m12_txt(r.d.external_ids, 'pmid'),
    license: r.d.license, audience: r.d.audience, origin: r.d.origin,
    content: left(r.c.content, v_chars), score: round(r.score, 4),
    similarity: r.sim === null ? null : round(_m12_float(r.sim), 3), term_hits: r.hits,
    match: r.sim !== null && r.sim >= r.floor && r.hits > 0 ? 'both' : r.sim !== null && r.sim >= r.floor ? 'vector' : 'terms',
  }))) ?? [];
}

// Re-ingests approved documents whose index is incomplete or stale: no chunks, missing vectors or search text, or vectors
// made by another embedding model (after EMBED_MODEL changes). Called by WF-019b; skips documents already queued.
function fn_rag_reindex_queue(p_embed_model, p_limit = 3) {
  const model = coalesce(p_embed_model, null);
  // Search text made by an older version of fn_rag_search_text is refreshed in place (no new embedding needed).
  let v_refreshed = 0;
  for (const c of dbWhere('rag_chunks', (x) => x.search_text !== null)) {
    const s = fn_rag_search_text(c.content);
    if (c.search_text !== s) { dbUpdate('rag_chunks', c, { search_text: s }); v_refreshed++; }
  }
  const lim = Math.max(1, Math.min(coalesce(p_limit, 3), 20));
  const v_ids = orderBy(dbWhere('rag_documents', (d) => d.status === 'approved'
      && (!dbExists('rag_chunks', (c) => c.document_id === d.id)
        || dbExists('rag_chunks', (c) => c.document_id === d.id && (c.search_text === null || c.embedding === null || c.embed_model !== model)))
      && !dbExists('outbox', (o) => o.event_type === 'RagDocumentApproved' && o.resource_id === d.id
        && (['pending', 'processing'].includes(o.status) || (o.status === 'failed' && o.processed_at !== null && t(o.processed_at) > t(now()) - DAY)))),
    (d) => t(d.created_at)).slice(0, lim).map((d) => d.id);
  if (!v_ids.length) return { queued: 0, search_text_refreshed: v_refreshed };
  for (const id of v_ids) fn_emit('RagDocumentApproved', null, id, { reason: 'reindex', embed_model: model });
  return { queued: v_ids.length, search_text_refreshed: v_refreshed };
}

// After ingestion: chunks quarantined for instruction-like text become a safety incident and an audit entry, so an
// administrator reviews the document. Quarantined chunks are never retrieved.
function fn_rag_ingest_report(p_document_id) {
  const id = _m12_uuid(p_document_id);
  const q = dbWhere('rag_chunks', (c) => c.document_id === id && c.quarantined === true);
  const v_n = q.length;
  const reasons = _m12_distinctSorted(q.map((c) => c.quarantine_reason).filter((r) => r !== null));
  const v_reasons = reasons.length ? reasons.join(', ') : null;
  if (v_n > 0) {
    const doc = dbGet('rag_documents', id);
    const v_title = doc ? doc.title : null;
    dbInsert('incidents', {
      workflow: 'WF-019 RAG ingestion', node: 'Prompt-injection screen',
      message: left(`Document "${coalesce(v_title, '')}": ${v_n} chunk(s) quarantined for instruction-like text (${coalesce(v_reasons, '')}). They are not used for answers until the document is corrected and approved again.`, 500),
    });
    dbInsert('audit_logs', { action: 'rag.chunks_quarantined', entity: 'rag_document', entity_id: id, detail: { chunks: v_n, signals: v_reasons } });
  }
  return { document_id: id, quarantined: v_n };
}
