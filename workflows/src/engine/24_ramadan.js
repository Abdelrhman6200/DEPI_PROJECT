/* 24 · Ramadan: the IDF-DAR 2021 fasting risk score, the person's fasting choice, and a check of every reading taken
 * during fasting hours (deterministic, no AI).
 *
 *   fn_ramadan_score(patient, answers)  the score from the record (diabetes type and duration, lows, HbA1c, medicines,
 *                                       kidney function, pregnancy) plus the answers only the person or clinician can
 *                                       give (awareness of lows, glucose checking, complications, frailty, physical
 *                                       work, earlier Ramadan). Missing answers count 0 and are listed in `missing`.
 *   api_ramadan_assess(c, d)            stores the assessment; a high-risk result goes to the care team's inbox.
 *   api_ramadan_status(c, d)            the latest assessment, the Ramadan dates and today's fasting window.
 *   api_ramadan_set_fasting(c, d)       the person says they are (not) fasting this Ramadan.
 *   fn_ramadan_check_reading(p, r)      during fasting hours of a fasting day: a reading below break_below or above
 *                                       break_above gets the fixed "break your fast now" message (fn_add_glucose).
 * Points and categories follow the IDF-DAR Diabetes and Ramadan Practical Guidelines 2021 (low 0-3, moderate 3.5-6,
 * high > 6). Demonstration content: the Clinical Safety Officer must check it against the guideline before use.
 * Settings: safety rule `ramadan` (dates, fasting hours, break thresholds).
 */

const _R24_DEFAULTS = { start: '2027-02-08', end: '2027-03-09', fasting_from: '04:15', fasting_to: '17:45', break_below: 70, break_above: 300 };
const _R24_ANSWERS = {
  hypo_unawareness: [true, false],
  smbg: ['as_indicated', 'suboptimal', 'not_done'],
  acute_complication: ['none', 'last_12m', 'last_6m', 'last_3m'],
  macrovascular: ['none', 'stable', 'unstable'],
  frailty: ['none', 'over70_no_support', 'frail_or_cognitive'],
  labour: ['none', 'moderate', 'intense'],
  previous_ramadan: ['no_problem', 'negative', 'first_time'],
};

function _r24_cfg() { return { ..._R24_DEFAULTS, ...(coalesce(fn_rule('ramadan'), {})) }; }

/** IDF-DAR 2021 risk score: { score, category, items[], missing[], advice_en, advice_ar }. */
function fn_ramadan_score(p_patient_id, p_answers = {}) {
  const pid = castUuid(p_patient_id);
  const p = dbGet('patients', pid);
  if (!p) fn_raise('not_found: patient not found');
  const a = p_answers && typeof p_answers === 'object' ? p_answers : {};
  for (const [k, v] of Object.entries(a)) {
    if (!(k in _R24_ANSWERS)) fn_raise(`bad_request: unknown answer ${k}`);
    if (v !== null && !_R24_ANSWERS[k].includes(v)) fn_raise(`bad_request: ${k} must be one of ${_R24_ANSWERS[k].join(', ')}`);
  }
  const items = [];
  const add = (key, points, basis, detail) => items.push({ key, points, basis, detail });
  const missing = [];
  const answer = (key) => { if (a[key] === undefined || a[key] === null) { missing.push(key); return null; } return a[key]; };

  add('diabetes_type', p.diabetes_type === 'type1' ? 1 : 0, 'record', p.diabetes_type);
  const yearsSince = p.diagnosis_year ? Number(today().slice(0, 4)) - Number(p.diagnosis_year) : null;
  add('duration', yearsSince !== null && yearsSince >= 10 ? 1 : 0, yearsSince === null ? 'missing' : 'record', yearsSince === null ? null : `${yearsSince} years`);

  // Lows: unawareness (answer) > a severe low in 3 months > several lows a week > fewer lows > none.
  const day = nowMs();
  const lows = dbWhere('glucose_events', (e) => e.patient_id === pid && ['hypo', 'severe_hypo'].includes(e.type));
  const severe90 = lows.some((e) => e.type === 'severe_hypo' && t(e.occurred_at) > day - 90 * DAY);
  const lows28 = lows.filter((e) => t(e.occurred_at) > day - 28 * DAY).length;
  const unaware = answer('hypo_unawareness');
  if (unaware === true) add('hypoglycaemia', 6.5, 'answer', 'unaware of lows');
  else if (severe90) add('hypoglycaemia', 5.5, 'record', 'severe low in the last 3 months');
  else if (lows28 >= 4) add('hypoglycaemia', 3.5, 'record', `${lows28} lows in 4 weeks`);
  else if (lows28 >= 1) add('hypoglycaemia', 1, 'record', `${lows28} low(s) in 4 weeks`);
  else add('hypoglycaemia', 0, 'record', 'no lows in 4 weeks');

  const a1c = orderBy(dbWhere('lab_results', (l) => l.patient_id === pid && l.test_code === 'hba1c' && l.verification_status !== 'refuted' && l.value !== null),
    [(l) => t(l.observed_at), 'desc'])[0] || null;
  const a1cV = a1c ? castNum(a1c.value) : null;
  add('hba1c', a1cV === null ? 0 : a1cV > 9 ? 2 : a1cV >= 7.5 ? 1 : 0, a1cV === null ? 'missing' : 'record', a1cV === null ? null : `${a1cV}%`);

  const meds = dbWhere('medications', (m) => m.patient_id === pid && m.status === 'active' && m.verification_status !== 'refuted');
  const cls = new Set(meds.map((m) => m.drug_class));
  const gens = meds.map((m) => String(m.generic || m.name || '').toLowerCase());
  const insulinOrSu = cls.has('basal_insulin') || cls.has('rapid_insulin') || cls.has('sulfonylurea');
  const treat = cls.has('basal_insulin') && cls.has('rapid_insulin') ? [2.5, 'basal-bolus insulin']
    : cls.has('rapid_insulin') ? [2.5, 'mealtime insulin'] : cls.has('basal_insulin') ? [1.5, 'basal insulin']
    : gens.some((g) => /glibenclamide|glyburide/.test(g)) ? [1, 'glibenclamide']
    : cls.has('sulfonylurea') ? [0.5, 'sulfonylurea'] : [0, 'other treatment'];
  add('treatment', treat[0], 'record', treat[1]);

  // Glucose checking: the answer, or from the record for people on insulin or a sulfonylurea (14 checks in 14 days).
  let smbg = answer('smbg');
  if (smbg === null && insulinOrSu) {
    const n14 = dbCount('glucose_readings', (r) => r.patient_id === pid && t(r.measured_at) > day - 14 * DAY);
    smbg = n14 >= 14 ? 'as_indicated' : n14 >= 1 ? 'suboptimal' : 'not_done';
    missing.splice(missing.indexOf('smbg'), 1);
  }
  add('glucose_checking', smbg === 'not_done' ? 2 : smbg === 'suboptimal' ? 1 : 0, a.smbg ? 'answer' : smbg ? 'record' : 'missing', smbg);

  const acute = answer('acute_complication');
  add('acute_complications', { last_3m: 3, last_6m: 2, last_12m: 1 }[acute] || 0, acute ? 'answer' : 'missing', acute);
  const macro = answer('macrovascular');
  add('macrovascular', { unstable: 6.5, stable: 2 }[macro] || 0, macro ? 'answer' : 'missing', macro);

  const eg = fn_egfr(pid);
  const e = eg && eg.value_exact !== null && eg.value_exact !== undefined ? eg.value_exact : null;
  add('kidney', e === null ? 0 : e < 30 ? 6.5 : e < 45 ? 4 : e < 60 ? 2 : 0, e === null ? 'missing' : 'record', e === null ? null : `eGFR ${eg.value}`);
  add('pregnancy', p.pregnant === true ? 6.5 : 0, 'record', p.pregnant === true ? 'pregnant' : null);
  const frail = answer('frailty');
  add('frailty', { frail_or_cognitive: 6.5, over70_no_support: 3.5 }[frail] || 0, frail ? 'answer' : 'missing', frail);
  const labour = answer('labour');
  add('physical_labour', { intense: 4, moderate: 2 }[labour] || 0, labour ? 'answer' : 'missing', labour);
  const prev = answer('previous_ramadan');
  add('previous_ramadan', prev === 'negative' ? 1 : 0, prev ? 'answer' : 'missing', prev);

  const score = round(items.reduce((s, i) => s + i.points, 0), 1);
  const category = score <= 3 ? 'low' : score <= 6 ? 'moderate' : 'high';
  const cfg = _r24_cfg();
  const ADVICE = {
    low: [`Low risk. Fasting is likely to be safe with a plan from your care team. Check your glucose during the day; checking does not break the fast. Break your fast at once if your glucose is below ${cfg.break_below} or above ${cfg.break_above} mg/dL, or if you feel unwell.`,
      `خطورة منخفضة. الصيام غالبًا آمن مع خطة من فريق الرعاية. قيس السكر أثناء النهار، والقياس لا يفطر. افطر فورًا لو السكر أقل من ${cfg.break_below} أو أعلى من ${cfg.break_above} مجم/دل، أو لو حسيت بتعب.`],
    moderate: [`Moderate risk. Talk to your care team before Ramadan: fasting may be possible with a personal plan and frequent glucose checks. Break your fast at once if your glucose is below ${cfg.break_below} or above ${cfg.break_above} mg/dL, or if you feel unwell.`,
      `خطورة متوسطة. اتكلم مع فريق الرعاية قبل رمضان: الصيام ممكن مع خطة شخصية وقياس متكرر للسكر. افطر فورًا لو السكر أقل من ${cfg.break_below} أو أعلى من ${cfg.break_above} مجم/دل، أو لو حسيت بتعب.`],
    high: ['High risk. Fasting is not advised for you. Please see your doctor before Ramadan to plan what is safe for you.',
      'خطورة عالية. الصيام غير منصوح به لك. من فضلك قابل طبيبك قبل رمضان علشان تتفقوا على الآمن ليك.'],
  };
  return { version: 'IDF-DAR 2021', score, category, items, missing, advice_en: ADVICE[category][0], advice_ar: ADVICE[category][1] };
}

function _r24_latest(pid) {
  return orderBy(dbWhere('ramadan_assessments', (r) => r.patient_id === pid), [(r) => t(r.created_at), 'desc'])[0] || null;
}

/** Stores an assessment (patient, family member with 'log' scope, or care team). */
function api_ramadan_assess(c, d) {
  const pid = fn_resolve_patient(c, d);
  const res = fn_ramadan_score(pid, d && d.answers ? d.answers : {});
  const prev = _r24_latest(pid);
  const row = dbInsert('ramadan_assessments', { patient_id: pid, year: Number(_r24_cfg().start.slice(0, 4)), score: res.score,
    category: res.category, items: res.items, answers: (d && d.answers) || {}, fasting: prev ? prev.fasting === true && res.category !== 'high' : false,
    assessed_by: castUuid(c.user_id) });
  if (res.category === 'high') {
    fn_create_inbox_item(pid, 'care_plan', 'medium', 3, `Ramadan risk: high (IDF-DAR ${res.score})`,
      'Pre-Ramadan visit needed: fasting is not advised. Review the treatment plan and give fasting advice.',
      { type: 'ramadan_high_risk', assessment_id: row.id, score: res.score }, `ramadan-high:${pid}:${row.year}`);
  }
  fn_audit(c, 'ramadan.assess', 'ramadan_assessment', row.id, pid, { score: res.score, category: res.category });
  return { id: row.id, ...res, fasting: row.fasting };
}

/** The latest assessment and today's fasting window. */
function api_ramadan_status(c, d) {
  const pid = fn_resolve_patient(c, d);
  const cfg = _r24_cfg();
  const last = _r24_latest(pid);
  const day = today();
  return {
    ramadan: { start: cfg.start, end: cfg.end, active: day >= cfg.start && day <= cfg.end, fasting_from: cfg.fasting_from, fasting_to: cfg.fasting_to,
      break_below: cfg.break_below, break_above: cfg.break_above },
    assessment: last ? { id: last.id, score: last.score, category: last.category, items: last.items, created_at: last.created_at } : null,
    fasting: last ? last.fasting === true : false,
  };
}

/** The person says they are fasting (or not). Needs an assessment first; not allowed after a high-risk result. */
function api_ramadan_set_fasting(c, d) {
  const pid = fn_resolve_patient(c, d);
  const last = _r24_latest(pid);
  const want = castBool(d && d.fasting) === true;
  if (!last) fn_raise('bad_request: Please complete the Ramadan risk check first.');
  if (want && last.category === 'high') fn_raise('forbidden: Fasting is not advised at high risk. Please talk to your doctor first.');
  dbUpdate('ramadan_assessments', last, { fasting: want, updated_at: now() });
  fn_audit(c, 'ramadan.set_fasting', 'ramadan_assessment', last.id, pid, { fasting: want });
  return { fasting: want };
}

/** During fasting hours on a fasting day of Ramadan: "break your fast" for a reading out of the safe range. */
function fn_ramadan_check_reading(p_patient_id, p_reading) {
  const cfg = _r24_cfg();
  const pid = castUuid(p_patient_id);
  if (!p_reading || pid === null) return null;
  const day = localDate(p_reading.measured_at);
  if (!(day >= cfg.start && day <= cfg.end)) return null;
  if (!(t(p_reading.measured_at) > nowMs() - 2 * HOUR)) return null;
  const last = _r24_latest(pid);
  if (!last || last.fasting !== true) return null;
  const hm = localHHMM(p_reading.measured_at);
  if (!(hm >= cfg.fasting_from && hm < cfg.fasting_to)) return null;
  const v = castNum(p_reading.value_mgdl);
  if (v === null || (v >= cfg.break_below && v <= cfg.break_above)) return null;
  const low = v < cfg.break_below;
  const en = low
    ? `Your glucose is ${v} mg/dL. Break your fast now: take 15 g of fast sugar, check again after 15 minutes, then eat. Tell your care team.`
    : `Your glucose is ${v} mg/dL. Break your fast now: drink water and check again within an hour. If it stays high, or you feel unwell, vomit or breathe fast, seek care today.`;
  const ar = low
    ? `السكر ${v} مجم/دل. افطر دلوقتي: خد 15 جرام سكر سريع، وقيس تاني بعد 15 دقيقة، وبعدين كُل. بلّغ فريق الرعاية.`
    : `السكر ${v} مجم/دل. افطر دلوقتي: اشرب مية وقيس تاني خلال ساعة. لو فضل عالي، أو حسيت بتعب أو ترجيع أو نفس سريع، اطلب رعاية النهارده.`;
  fn_notify_patient(pid, 'ramadan_break_fast', 'Break your fast now', en, `ramadan-break:${p_reading.id}`, 'افطر دلوقتي', ar);
  fn_create_inbox_item(pid, 'glucose', low ? 'high' : 'medium', low ? 2 : 3, `Fasting patient: ${v} mg/dL during the fast`,
    'The person was told to break the fast. Review the Ramadan plan.', { type: 'ramadan_break_fast', value: v }, `ramadan-break:${p_reading.id}`);
  return { type: 'break_fast', value: v, message_en: en, message_ar: ar };
}
