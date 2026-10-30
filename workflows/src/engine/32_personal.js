/* 32 · Personalized care, per patient (deterministic rules; the clinician decides, the patient sees the result).
 *
 *   fn_personal_targets(pid)          a suggested target set (tier tighter, standard, relaxed, older_complex, or
 *                                     pregnancy with no number) and the reasons, from age, diabetes duration, lows,
 *                                     medicines that cause lows, kidney function, heart disease, other conditions and
 *                                     frailty. A suggestion for the doctor: it becomes the person's targets only when the
 *                                     doctor puts it in the care plan and publishes it.
 *   fn_therapy_considerations(pid)    clinician-only points to consider (kidney or heart disease without an SGLT2 inhibitor
 *                                     or GLP-1 RA, BMI 30+, lows on a sulfonylurea or insulin, HbA1c above target with no
 *                                     plan change, statin, ACE inhibitor or ARB). Never a dose, never shown to patients,
 *                                     never sent to the Companion. A doctor's decision hides an item for recheck_days.
 *   fn_food_profile(pid, days)        how this person's sugar rose after meals with each food, from their own readings.
 *   preferences                       how the person likes to be helped (simple words, voice, meal pattern, shift,
 *                                     sleep times, budget, who cooks, fasting days, goals): used by the Companion's
 *                                     wording and examples and by notification quiet hours.
 * Settings: rules personal_targets and therapy_considerations (ADA Standards of Care 2026, sections 6, 9, 10, 11, 13).
 * Demonstration values: the Clinical Safety Officer must check them against the guideline before use.
 */

const _P32_TARGETS = {
  tiers: {
    tighter: { hba1c_target: 6.5, tir_target: 70, tbr_max: 4, fasting_low: 80, fasting_high: 130, post_meal_high: 180 },
    standard: { hba1c_target: 7, tir_target: 70, tbr_max: 4, fasting_low: 80, fasting_high: 130, post_meal_high: 180 },
    relaxed: { hba1c_target: 8, tir_target: 50, tbr_max: 1, fasting_low: 90, fasting_high: 150, post_meal_high: 200 },
    older_complex: { hba1c_target: 8.5, tir_target: 50, tbr_max: 1, fasting_low: 100, fasting_high: 180, post_meal_high: 200 },
  },
  tighter_max_age: 50, tighter_max_years: 10, older_age: 65, very_old_age: 75, complex_conditions: 3, long_duration_years: 20,
  recurrent_lows_90d: 4,
  food: { min_meals: 2, gentle_below: 30, high_from: 50 },
};
const _P32_THERAPY = {
  recheck_days: 180, ckd_egfr_below: 60, ckd_uacr_from: 30, sglt2_min_egfr: 20, bmi_from: 30, lows_14d: 2, older_su_age: 65,
  statin_ages: [40, 75], bp_systolic_from: 130, bp_diastolic_from: 80, inertia_days: 90,
  cost_band: { sglt2_inhibitor: 'medium', glp1_agonist: 'high', statin: 'low', ace_inhibitor: 'low', arb: 'low' },
};
const _P32_DECISIONS = ['started', 'not_appropriate', 'patient_declined', 'cost', 'later'];
const _P32_ASCVD = /^(I2[0-5]|I6[3-6]|I70|I73\.9|Z95\.[15])/i;
const _P32_COMPLICATION = /^(H36|E11\.[2-5]|N18|I2[0-5]|I6[3-6]|I70|G63\.2)/i;

function _p32_cfg(code, defaults) { const r = coalesce(fn_rule(code), {}); return { ...defaults, ...r, tiers: { ...(defaults.tiers || {}), ...(r.tiers || {}) } }; }

/** Facts used by both the targets and the considerations (one pass over the record). */
function _p32_facts(pid) {
  const p = dbGet('patients', pid);
  if (!p) fn_raise('not_found: patient not found');
  const nowT = nowMs();
  const meds = dbWhere('medications', (m) => m.patient_id === pid && m.status === 'active' && m.verification_status !== 'refuted');
  const classes = new Set(meds.map((m) => m.drug_class).filter(Boolean));
  const conds = dbWhere('conditions', (c) => c.patient_id === pid && c.status === 'active' && c.verification_status !== 'refuted');
  const code = (re) => conds.some((c) => c.code && re.test(c.code));
  const lab = (test) => orderBy(dbWhere('lab_results', (l) => l.patient_id === pid && l.test_code === test && l.verification_status !== 'refuted' && l.value !== null),
    [(l) => t(l.observed_at), 'desc']);
  const vital = (type) => orderBy(dbWhere('vitals', (v) => v.patient_id === pid && v.type === type), [(v) => t(v.measured_at), 'desc'])[0] || null;
  const ev = dbWhere('glucose_events', (e) => e.patient_id === pid);
  const eg = fn_egfr(pid);
  const weight = vital('weight');
  const h = castNum(p.height_cm);
  const bmi = weight && h ? round(castNum(weight.value) / Math.pow(h / 100, 2), 1) : null;
  const ram = dbWhere('ramadan_assessments', (r) => r.patient_id === pid);
  const lastRam = orderBy(ram, [(r) => t(r.created_at), 'desc'])[0] || null;
  return {
    p, age: fn_age(p.date_of_birth), years: p.diagnosis_year ? Number(today().slice(0, 4)) - Number(p.diagnosis_year) : null,
    type: p.diabetes_type, pregnant: p.pregnant === true, classes, meds, conds,
    others: conds.filter((c) => !/^E1[01](\.9)?$/i.test(c.code || '') && !/^Z33/i.test(c.code || '')).length,
    ascvd: code(_P32_ASCVD), hf: code(/^I50/i), ckd_code: code(/^N18/i), complications: code(_P32_COMPLICATION),
    recurrent_code: code(/^E16\.[12]/i),
    egfr: eg ? eg.value_exact ?? castNum(eg.value) : null, uacr: lab('uacr')[0] ? castNum(lab('uacr')[0].value) : null,
    hba1c: lab('hba1c'), bmi, bp: vital('blood_pressure'),
    severe365: ev.some((e) => e.type === 'severe_hypo' && t(e.occurred_at) > nowT - 365 * DAY),
    lows90: ev.filter((e) => ['hypo', 'severe_hypo'].includes(e.type) && t(e.occurred_at) > nowT - 90 * DAY).length,
    lows14: ev.filter((e) => ['hypo', 'severe_hypo'].includes(e.type) && t(e.occurred_at) > nowT - 14 * DAY).length,
    hypoAgents: ['sulfonylurea', 'basal_insulin', 'rapid_insulin'].filter((c) => classes.has(c)),
    frailty: lastRam && lastRam.answers ? lastRam.answers.frailty || null : null,
    unaware: lastRam && lastRam.answers ? lastRam.answers.hypo_unawareness === true : false,
  };
}

const _P32_REASON = {
  pregnancy: ['Pregnancy: targets are set by the diabetes-in-pregnancy team (much tighter, different limits).', 'الحمل: الأهداف يحددها فريق السكري والحمل (أشد بكثير وبحدود مختلفة).'],
  very_old: ['Age {age} with several health conditions or frailty: avoid lows first; HbA1c is less reliable as a goal.', 'العمر {age} مع عدة أمراض أو ضعف عام: تجنب الهبوط أولًا؛ السكر التراكمي أقل أهمية كهدف.'],
  severe_low: ['A severe low in the last year.', 'هبوط شديد خلال السنة الأخيرة.'],
  recurrent_lows: ['Recurrent lows ({n} in 90 days).', 'هبوط متكرر ({n} مرات خلال 90 يومًا).'],
  unaware: ['Does not feel lows coming (reported).', 'لا يشعر بالهبوط قبل حدوثه (حسب إجابته).'],
  egfr_low: ['Kidney function eGFR {egfr}: higher risk of lows.', 'وظائف الكلى {egfr}: خطر هبوط أعلى.'],
  older_complex: ['Age {age} with {n} other conditions.', 'العمر {age} مع {n} أمراض أخرى.'],
  long_complicated: ['{years} years of diabetes with complications.', '{years} سنة من السكري مع مضاعفات.'],
  tighter: ['Younger ({age}), diabetes for {years} years, no heart disease, no medicines that cause lows and no lows: a tighter goal can be considered if reached safely.', 'سن أصغر ({age})، سكري منذ {years} سنوات، بلا أمراض قلب، بلا أدوية تسبب الهبوط وبلا هبوط: يمكن التفكير في هدف أشد إن تحقق بأمان.'],
  standard: ['No reason found for a looser or tighter goal: the usual targets.', 'لا يوجد سبب لهدف أخف أو أشد: الأهداف المعتادة.'],
};
function _p32_reason(key, vars = {}, ref = 'ADA 2026 §6') {
  const [en, ar] = _P32_REASON[key];
  const f = (s) => s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? '?' : String(vars[k])));
  return { key, en: f(en), ar: f(ar), ref };
}

function fn_personal_targets(p_patient_id) {
  const pid = castUuid(p_patient_id);
  const cfg = _p32_cfg('personal_targets', _P32_TARGETS);
  const F = _p32_facts(pid);
  const reasons = [];
  let tier;
  if (F.pregnant) {
    reasons.push(_p32_reason('pregnancy', {}, 'ADA 2026 §15'));
    return { tier: 'pregnancy', suggested: null, reasons, current: fn_targets(pid), differs_from_plan: false };
  }
  const older = F.age !== null && F.age >= cfg.older_age, veryOld = F.age !== null && F.age >= cfg.very_old_age;
  if ((veryOld && F.others >= cfg.complex_conditions) || (older && F.frailty === 'frail_or_cognitive')) {
    tier = 'older_complex';
    reasons.push(_p32_reason('very_old', { age: F.age }, 'ADA 2026 §13'));
  } else {
    if (F.severe365) reasons.push(_p32_reason('severe_low'));
    if (F.lows90 >= cfg.recurrent_lows_90d || F.recurrent_code) reasons.push(_p32_reason('recurrent_lows', { n: F.lows90 }));
    if (F.unaware) reasons.push(_p32_reason('unaware'));
    if (F.egfr !== null && F.egfr < 30) reasons.push(_p32_reason('egfr_low', { egfr: Math.round(F.egfr) }));
    if (older && F.others >= cfg.complex_conditions) reasons.push(_p32_reason('older_complex', { age: F.age, n: F.others }, 'ADA 2026 §13'));
    if (F.years !== null && F.years >= cfg.long_duration_years && F.complications) reasons.push(_p32_reason('long_complicated', { years: F.years }));
    if (reasons.length) tier = 'relaxed';
    else if (F.age !== null && F.age < cfg.tighter_max_age && F.years !== null && F.years < cfg.tighter_max_years && !F.ascvd && !F.hypoAgents.length
      && F.lows90 === 0 && F.type === 'type2' && (F.egfr === null || F.egfr >= 60)) {
      tier = 'tighter';
      reasons.push(_p32_reason('tighter', { age: F.age, years: F.years }));
    } else {
      tier = 'standard';
      reasons.push(_p32_reason('standard'));
    }
  }
  const suggested = { ...cfg.tiers[tier] };
  const current = fn_targets(pid);
  const differs = Object.keys(suggested).some((k) => current[k] !== undefined && castNum(current[k]) !== castNum(suggested[k]));
  return { tier, suggested, reasons, current, differs_from_plan: differs };
}

/* ------------------------------------------------------------------------------------- Treatment considerations */

const _P32_ITEMS = {
  sglt2_ckd: ['consider', 'sglt2_inhibitor', 'Kidney disease: consider an SGLT2 inhibitor with kidney benefit', 'مرض الكلى: فكّر في مثبط SGLT2 له فائدة للكلى', 'ADA 2026 §9, §11'],
  sglt2_hf: ['consider', 'sglt2_inhibitor', 'Heart failure: consider an SGLT2 inhibitor', 'قصور القلب: فكّر في مثبط SGLT2', 'ADA 2026 §9, §10'],
  cv_benefit: ['consider', 'glp1_agonist', 'Atherosclerotic heart or vessel disease: consider a GLP-1 RA or SGLT2 inhibitor with proven heart benefit', 'أمراض القلب أو الشرايين: فكّر في GLP-1 RA أو مثبط SGLT2 بفائدة قلبية مثبتة', 'ADA 2026 §9, §10'],
  weight: ['consider', 'glp1_agonist', 'BMI {bmi}: consider a GLP-1 RA (or dual GIP/GLP-1) for weight and glucose', 'مؤشر كتلة الجسم {bmi}: فكّر في GLP-1 RA (أو مزدوج GIP/GLP-1) للوزن والسكر', 'ADA 2026 §8, §9'],
  hypo_review: ['review', null, 'Lows on {agents}: review the medicines that cause lows (de-intensify or switch)', 'هبوط مع {agents_ar}: راجع الأدوية المسببة للهبوط (تقليل أو تغيير)', 'ADA 2026 §6, §9'],
  older_su: ['review', null, 'Age {age} on a sulfonylurea: review (lows are more dangerous in older adults)', 'العمر {age} مع سلفونيل يوريا: راجع العلاج (الهبوط أخطر في كبار السن)', 'ADA 2026 §13'],
  inertia: ['review', null, 'HbA1c {a1c}% above the target {target}% for over {days} days with no plan change: consider intensifying', 'السكر التراكمي {a1c}% أعلى من الهدف {target}% لأكثر من {days} يومًا دون تغيير الخطة: فكّر في تكثيف العلاج', 'ADA 2026 §6, §9'],
  statin: ['consider', 'statin', 'Age {age} with diabetes and no statin: consider a statin', 'العمر {age} مع السكري وبدون ستاتين: فكّر في ستاتين', 'ADA 2026 §10'],
  acei_arb: ['consider', 'ace_inhibitor', '{why}: consider an ACE inhibitor or ARB', '{why_ar}: فكّر في مثبط ACE أو ARB', 'ADA 2026 §10, §11'],
};

function _p32_item(code, vars, data_used, cfg) {
  const [kind, cls, en, ar, ref] = _P32_ITEMS[code];
  const f = (s) => s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? '?' : String(vars[k])));
  return { code, kind, title_en: f(en), title_ar: f(ar), ref, data_used, cost_band: cls ? (cfg.cost_band || {})[cls] || null : null };
}

function fn_therapy_considerations(p_patient_id, p_with_hidden = false) {
  const pid = castUuid(p_patient_id);
  const cfg = { ..._P32_THERAPY, ...(coalesce(fn_rule('therapy_considerations'), {})) };
  const F = _p32_facts(pid);
  if (F.type !== 'type2' || F.pregnant) return { items: [], hidden: [], not_applicable: F.pregnant ? 'pregnancy' : F.type };
  const has = (c) => F.classes.has(c);
  const items = [];
  const ckd = (F.egfr !== null && F.egfr < cfg.ckd_egfr_below) || (F.uacr !== null && F.uacr >= cfg.ckd_uacr_from) || F.ckd_code;
  if (ckd && !has('sglt2_inhibitor') && (F.egfr === null || F.egfr >= cfg.sglt2_min_egfr)) {
    items.push(_p32_item('sglt2_ckd', {}, { egfr: F.egfr === null ? null : Math.round(F.egfr), uacr: F.uacr }, cfg));
  }
  if (F.hf && !has('sglt2_inhibitor')) items.push(_p32_item('sglt2_hf', {}, { condition: 'heart failure' }, cfg));
  if (F.ascvd && !has('glp1_agonist') && !has('sglt2_inhibitor')) items.push(_p32_item('cv_benefit', {}, { condition: 'ASCVD' }, cfg));
  if (F.bmi !== null && F.bmi >= cfg.bmi_from && !has('glp1_agonist')) items.push(_p32_item('weight', { bmi: F.bmi }, { bmi: F.bmi }, cfg));
  if (F.hypoAgents.length && (F.lows14 >= cfg.lows_14d || F.severe365)) {
    const NAMES = { sulfonylurea: ['a sulfonylurea', 'سلفونيل يوريا'], basal_insulin: ['basal insulin', 'إنسولين قاعدي'], rapid_insulin: ['mealtime insulin', 'إنسولين سريع'] };
    items.push(_p32_item('hypo_review', { agents: F.hypoAgents.map((c) => NAMES[c][0]).join(' and '), agents_ar: F.hypoAgents.map((c) => NAMES[c][1]).join(' و') }, { lows_14d: F.lows14, severe_365d: F.severe365, agents: F.hypoAgents }, cfg));
  } else if (has('sulfonylurea') && F.age !== null && F.age >= cfg.older_su_age) {
    items.push(_p32_item('older_su', { age: F.age }, { age: F.age }, cfg));
  }
  // Treatment inertia: every HbA1c in the window above the personal target, the first one at least inertia_days old, and
  // the care plan not changed since then.
  const target = castNum(coalesce(fn_targets(pid).hba1c_target, 7));
  const a1c = F.hba1c;
  if (a1c.length && castNum(a1c[0].value) > target) {
    const old = a1c.find((l) => t(l.observed_at) <= nowMs() - cfg.inertia_days * DAY);
    const allAbove = old && a1c.filter((l) => t(l.observed_at) >= t(old.observed_at)).every((l) => castNum(l.value) > target);
    const plan = dbOne('care_plans', (c) => c.patient_id === pid && c.status === 'ACTIVE');
    if (allAbove && (!plan || t(plan.published_at || plan.created_at) <= t(old.observed_at))) {
      items.push(_p32_item('inertia', { a1c: castNum(a1c[0].value), target, days: cfg.inertia_days }, { hba1c: castNum(a1c[0].value), since: old.observed_at, target }, cfg));
    }
  }
  const [lo, hi] = Array.isArray(cfg.statin_ages) ? cfg.statin_ages : [40, 75];
  if (F.age !== null && F.age >= lo && F.age <= hi && !has('statin')) items.push(_p32_item('statin', { age: F.age }, { age: F.age }, cfg));
  const bpHigh = F.bp && (castNum(F.bp.systolic) >= cfg.bp_systolic_from || castNum(F.bp.diastolic) >= cfg.bp_diastolic_from);
  const albumin = F.uacr !== null && F.uacr >= cfg.ckd_uacr_from;
  if ((bpHigh || albumin) && !has('ace_inhibitor') && !has('arb')) {
    const why = albumin ? `Urine albumin (ACR ${F.uacr})` : `Blood pressure ${F.bp.systolic}/${F.bp.diastolic}`;
    const why_ar = albumin ? `زلال في البول (ACR ${F.uacr})` : `ضغط الدم ${F.bp.systolic}/${F.bp.diastolic}`;
    items.push(_p32_item('acei_arb', { why, why_ar }, { uacr: F.uacr, bp: F.bp ? `${F.bp.systolic}/${F.bp.diastolic}` : null }, cfg));
  }
  // A clinician's decision hides the item until recheck_days have passed.
  const since = nowMs() - cfg.recheck_days * DAY;
  const reviews = dbWhere('therapy_reviews', (r) => r.patient_id === pid && t(r.at) > since);
  const hiddenCodes = new Set(reviews.map((r) => r.code));
  const shown = items.filter((x) => !hiddenCodes.has(x.code));
  const hidden = items.filter((x) => hiddenCodes.has(x.code)).map((x) => {
    const r = orderBy(reviews.filter((y) => y.code === x.code), [(y) => t(y.at), 'desc'])[0];
    return { ...x, review: { decision: r.decision, note: r.note, at: r.at } };
  });
  return { items: shown, hidden: p_with_hidden ? hidden : hidden.length };
}

/* ------------------------------------------------------------------------------------ Kidney failure risk (KFRE) */

/**
 * Kidney Failure Risk Equation, 4 variables (Tangri 2011; non-North-American calibration), when eGFR is below 60 and a
 * urine albumin-creatinine ratio (mg/g) is recorded: risk of kidney failure in 2 and 5 years (KDIGO 2024 recommends it
 * for CKD G3-G5). A 5-year risk at or above referral_5y_pct adds a nephrology consideration for the clinician.
 */
function fn_kidney_risk(p_patient_id) {
  const pid = castUuid(p_patient_id);
  const F = _p32_facts(pid);
  const cfg = { referral_5y_pct: 5, base_2y: 0.9832, base_5y: 0.9365, ...(coalesce(fn_rule('therapy_considerations'), {}).kfre || {}) };
  if (F.egfr === null || F.egfr >= 60 || F.uacr === null || F.uacr <= 0 || F.age === null) {
    return { eligible: false, reason: F.egfr === null || F.egfr >= 60 ? 'egfr_60_or_more_or_missing' : 'acr_missing' };
  }
  const lp = -0.2201 * (F.age / 10 - 7.036) + 0.2467 * ((F.p.sex === 'male' ? 1 : 0) - 0.5642)
    - 0.5567 * (F.egfr / 5 - 7.222) + 0.451 * (Math.log(F.uacr) - 5.137);
  const two = 1 - Math.pow(cfg.base_2y, Math.exp(lp)), five = 1 - Math.pow(cfg.base_5y, Math.exp(lp));
  return { eligible: true, two_year_pct: round(two * 100, 1), five_year_pct: round(five * 100, 1),
    inputs: { age: F.age, sex: F.p.sex, egfr: Math.round(F.egfr), uacr: F.uacr }, refer: five * 100 >= cfg.referral_5y_pct, ref: 'KFRE (Tangri 2011), KDIGO 2024' };
}

/* --------------------------------------------------------------------------------------------- Food response */

function fn_food_profile(p_patient_id, p_days = 90) {
  const pid = castUuid(p_patient_id);
  const cfg = _p32_cfg('personal_targets', _P32_TARGETS).food || _P32_TARGETS.food;
  const days = Math.max(7, Math.min(coalesce(castInt(p_days), 90), 365));
  const responses = fn_meal_responses(pid, days).filter((r) => r.rise !== null);
  const meals = new Map(dbWhere('meal_logs', (m) => m.patient_id === pid).map((m) => [m.id, m]));
  const byFood = new Map(), bySlot = new Map();
  for (const r of responses) {
    const m = meals.get(r.meal_id);
    if (!m) continue;
    const slot = m.meal_type || 'other';
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot).push(r.rise);
    for (const it of Array.isArray(m.items) ? m.items : []) {
      const f = it && it.food_id ? dbGet('foods', it.food_id) : null;
      const key = f ? f.id : it && it.name ? `name:${String(it.name).toLowerCase()}` : null;
      if (!key) continue;
      if (!byFood.has(key)) byFood.set(key, { food_id: f ? f.id : null, name: f ? f.name : it.name, name_ar: f ? f.name_ar : null, gi: f ? f.gi_category : null, rises: [], sensor: 0 });
      const x = byFood.get(key);
      x.rises.push(r.rise);
      if (r.sensor_ok) x.sensor++;
    }
  }
  const mean = (a) => round(a.reduce((s, v) => s + v, 0) / a.length, 0);
  const foods = [...byFood.values()].filter((x) => x.rises.length >= cfg.min_meals)
    .map((x) => ({ food_id: x.food_id, name: x.name, name_ar: x.name_ar, gi: x.gi, meals: x.rises.length, mean_rise: mean(x.rises), max_rise: Math.max(...x.rises), sensor_meals: x.sensor }));
  const band = (r) => (r >= cfg.high_from ? 'high' : r < cfg.gentle_below ? 'gentle' : 'moderate');
  return {
    days, meals_with_readings: responses.length,
    // Every food eaten at least min_meals times, highest average rise first (rises are of whole meals with this food).
    foods: orderBy(foods, [(x) => x.mean_rise, 'desc']).slice(0, 12).map((x) => ({ ...x, band: band(x.mean_rise) })), meals_logged: dbCount('meal_logs', (m) => m.patient_id === pid && t(m.eaten_at) > nowMs() - days * DAY),
    high: orderBy(foods.filter((x) => x.mean_rise >= cfg.high_from), [(x) => x.mean_rise, 'desc']).slice(0, 5),
    gentle: orderBy(foods.filter((x) => x.mean_rise < cfg.gentle_below), (x) => x.mean_rise).slice(0, 5),
    by_meal: [...bySlot.entries()].map(([slot, r]) => ({ meal_type: slot, meals: r.length, mean_rise: mean(r) })),
    note: responses.length < 4 ? 'few_readings' : null,
  };
}

/* ---------------------------------------------------------------------------------------------- Preferences */

const _P32_PREF = {
  simple_words: 'bool', prefers_voice: 'bool', budget_sensitive: 'bool',
  meal_pattern: ['three_meals', 'two_meals_snacks', 'irregular'], work_shift: ['day', 'night', 'rotating', 'none'],
  who_cooks: ['self', 'family', 'eats_out'], wake_time: 'time', sleep_time: 'time', fasting_days: 'days', goals_text: 'text',
};
const _P32_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function fn_preferences(p_patient_id) {
  const r = dbOne('patient_preferences', (x) => x.patient_id === p_patient_id);
  const out = {};
  for (const k of Object.keys(_P32_PREF)) out[k] = r ? coalesce(r[k], null) : null;
  out.updated_at = r ? r.updated_at : null;
  return out;
}

function api_preferences(c, d) { return fn_preferences(fn_resolve_patient(c, d)); }

function api_set_preferences(c, d) {
  const pid = fn_resolve_patient(c, d);
  const patch = {};
  for (const [k, spec] of Object.entries(_P32_PREF)) {
    if (!d || !(k in d)) continue;
    const v = d[k];
    if (v === null || v === '') { patch[k] = null; continue; }
    if (spec === 'bool') { if (typeof v !== 'boolean') fn_raise(`bad_request: ${k} must be true or false`); patch[k] = v; }
    else if (spec === 'time') { if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(String(v))) fn_raise(`bad_request: ${k} must be written like 22:30`); patch[k] = String(v); }
    else if (spec === 'days') {
      const list = Array.isArray(v) ? v.map(String) : [];
      if (list.some((x) => !_P32_DAYS.includes(x))) fn_raise(`bad_request: fasting_days must be days like mon, thu`);
      patch[k] = [...new Set(list)];
    } else if (spec === 'text') patch[k] = String(v).trim().slice(0, 300) || null;
    else if (!spec.includes(v)) fn_raise(`bad_request: ${k} must be one of ${spec.join(', ')}`);
    else patch[k] = v;
  }
  const ex = dbOne('patient_preferences', (x) => x.patient_id === pid);
  if (ex) dbUpdate('patient_preferences', ex, { ...patch, updated_at: now() });
  else dbInsert('patient_preferences', { patient_id: pid, ...patch, updated_at: now() });
  fn_audit(c, 'preferences.update', 'patient_preferences', pid, pid, { fields: Object.keys(patch) });
  return fn_preferences(pid);
}

/** Quiet hours from the person's own sleep and wake times (push notifications), or null. */
function fn_personal_quiet(p_user_id) {
  const p = dbOne('patients', (x) => x.user_id === p_user_id);
  if (!p) return null;
  const r = dbOne('patient_preferences', (x) => x.patient_id === p.id);
  if (!r || !r.sleep_time || !r.wake_time) return null;
  return { from: Number(String(r.sleep_time).slice(0, 2)), to: Number(String(r.wake_time).slice(0, 2)) };
}

/* ---------------------------------------------------------------------------------------------- Clinician API */

function _p32_clinical(c) {
  const role = c !== null && typeof c === 'object' ? jtext(c.role) : null;
  if (!['doctor', 'nurse', 'clinic_admin'].includes(role)) fn_raise('forbidden: Only the care team can see this.');
}

/** provider.personalization: suggested targets, treatment considerations, food response and preferences. */
function api_personalization(c, d) {
  _p32_clinical(c);
  const pid = fn_resolve_patient(c, d);
  return { targets: fn_personal_targets(pid), therapy: fn_therapy_considerations(pid, true), food: fn_food_profile(pid, 90), preferences: fn_preferences(pid),
    kidney_risk: fn_kidney_risk(pid), wellbeing: fn_wellbeing_status(pid).latest, sick_day: fn_sick_status(pid) };
}

/** provider.therapy_review: the doctor's decision on one consideration (hides it for recheck_days). */
function api_therapy_review(c, d) {
  const role = c !== null && typeof c === 'object' ? jtext(c.role) : null;
  if (!['doctor', 'nurse'].includes(role)) fn_raise('forbidden: Only a doctor or nurse can record this.');
  const pid = fn_resolve_patient(c, d);
  const code = String((d && d.code) || '');
  if (!(code in _P32_ITEMS)) fn_raise('bad_request: unknown consideration');
  const decision = String((d && d.decision) || '');
  if (!_P32_DECISIONS.includes(decision)) fn_raise(`bad_request: decision must be one of ${_P32_DECISIONS.join(', ')}`);
  const note = String((d && d.note) || '').trim().slice(0, 500) || null;
  const row = dbInsert('therapy_reviews', { patient_id: pid, code, decision, note, reviewed_by: castUuid(jtext(c.user_id)) });
  fn_audit(c, 'therapy.review', 'therapy_review', row.id, pid, { code, decision });
  return fn_therapy_considerations(pid, true);
}
