/* 33 · Wellbeing check-ins, sick-day mode and the before-driving check (deterministic; no model anywhere).
 *
 *   Check-ins (tab questionnaires):
 *     paid5     Problem Areas in Diabetes, 5 items 0-4 (validated in Arabic in Egyptian primary care); 8+ = possible
 *               diabetes distress -> care team inbox.
 *     phq2      2 items 0-3; 3+ -> the PHQ-9 follows.
 *     phq9      9 items 0-3; 10+ -> care team inbox. Item 9 (thoughts of self-harm) above 0 -> the same fixed crisis
 *               path as the Companion's self-harm pre-screen (emergency_patterns.self_harm_*): crisis text with 123 and
 *               the mental health hotline, a critical inbox item, family members told to stay close. No model.
 *     stopbang  sleep apnea screen; age, sex and BMI from the record, 5 questions; 3+ -> care team inbox.
 *   fn_wellbeing_status(pid)   which check-ins are due (every interval_days) and the latest results.
 *   Sick-day mode (tab sick_days): the person says they are ill (vomiting, diarrhoea, fever, not eating or drinking).
 *     The app lists their medicines that usually need a sick-day plan (it never decides a pause: the care team is told
 *     at once and advises), asks for a glucose check every check_hours, lists when to seek care, and ends after
 *     max_days.
 *   fn_drive_check(pid)  for people on insulin or a sulfonylurea: measure before driving; below min_mgdl do not drive,
 *     treat and wait; recheck every recheck_hours on long drives ("five to drive").
 * Settings: rules wellbeing, sick_day, drive_check. Demonstration values: Clinical Safety Officer sign-off required.
 */

const _W33_WELL = { interval_days: 90, paid5_flag: 8, phq2_flag: 3, phq9_flag: 10, stopbang_flag: 3, stopbang_bmi: 35, stopbang_age: 50, stopbang_every_days: 365 };
const _W33_SICK = {
  check_hours: 4, max_days: 7,
  class_notes: {
    sglt2_inhibitor: 'often_paused', biguanide: 'often_paused', loop_diuretic: 'often_paused', thiazide: 'often_paused',
    potassium_sparing_diuretic: 'often_paused', ace_inhibitor: 'often_paused', arb: 'often_paused', nsaid: 'often_paused',
    sulfonylurea: 'low_risk', basal_insulin: 'never_stop', rapid_insulin: 'never_stop',
  },
};
const _W33_DRIVE = { min_mgdl: 90, max_age_min: 30, recheck_hours: 2, wait_after_low_min: 45, classes: ['sulfonylurea', 'basal_insulin', 'rapid_insulin'] };
const _W33_KINDS = { paid5: { items: 5, max: 4 }, phq2: { items: 2, max: 3 }, phq9: { items: 9, max: 3 }, stopbang: { items: 5, max: 1 } };
const _W33_SYMPTOMS = ['vomiting', 'diarrhea', 'fever', 'not_eating', 'not_drinking'];

function _w33(code, defaults) { return { ...defaults, ...(coalesce(fn_rule(code), {})) }; }

function _w33_latest(pid, kind) {
  return orderBy(dbWhere('questionnaires', (q) => q.patient_id === pid && q.kind === kind), [(q) => t(q.created_at), 'desc'])[0] || null;
}

/* ------------------------------------------------------------------------------------------------- Check-ins */

function _w33_band(kind, score, cfg) {
  if (kind === 'paid5') return score >= cfg.paid5_flag ? 'high' : 'low';
  if (kind === 'phq2') return score >= cfg.phq2_flag ? 'positive' : 'negative';
  if (kind === 'phq9') return score >= 20 ? 'severe' : score >= 15 ? 'moderately_severe' : score >= 10 ? 'moderate' : score >= 5 ? 'mild' : 'minimal';
  if (kind === 'stopbang') return score >= 5 ? 'high' : score >= cfg.stopbang_flag ? 'intermediate' : 'low';
  return null;
}

/** STOP-BANG items from the record: B (BMI > 35), A (age > 50), G (male). */
function _w33_stopbang_record(pid, cfg) {
  const p = dbGet('patients', pid);
  const w = orderBy(dbWhere('vitals', (v) => v.patient_id === pid && v.type === 'weight'), [(v) => t(v.measured_at), 'desc'])[0];
  const h = p ? castNum(p.height_cm) : null;
  const bmi = w && h ? castNum(w.value) / Math.pow(h / 100, 2) : null;
  const age = p ? fn_age(p.date_of_birth) : null;
  return { bmi: bmi === null ? null : round(bmi, 1), bmi_over: bmi !== null && bmi > cfg.stopbang_bmi, age_over: age !== null && age > cfg.stopbang_age, male: !!p && p.sex === 'male' };
}

function fn_wellbeing_status(p_patient_id) {
  const pid = castUuid(p_patient_id);
  const cfg = _w33('wellbeing', _W33_WELL);
  const nowT = nowMs();
  const latest = {};
  for (const k of Object.keys(_W33_KINDS)) {
    const q = _w33_latest(pid, k);
    latest[k] = q ? { score: q.score, band: q.band, at: q.created_at } : null;
  }
  const due = [];
  const old = (x, days) => !x || t(x.at) < nowT - days * DAY;
  if (old(latest.paid5, cfg.interval_days)) due.push('paid5');
  if (old(latest.phq2, cfg.interval_days) && old(latest.phq9, cfg.interval_days)) due.push('phq2');
  if (old(latest.stopbang, cfg.stopbang_every_days)) due.push('stopbang');
  return { due, latest, stopbang_record: _w33_stopbang_record(pid, cfg) };
}

function api_wellbeing_status(c, d) {
  const pid = fn_resolve_patient(c, d);
  return fn_wellbeing_status(pid);
}

/** wellbeing.submit {kind, answers[]}: the person's own answers (a family member cannot answer for them). */
function api_wellbeing_submit(c, d) {
  fn_require_role(c, ['patient']);
  const pid = fn_resolve_patient(c, d);
  const cfg = _w33('wellbeing', _W33_WELL);
  const kind = String((d && d.kind) || '');
  const spec = _W33_KINDS[kind];
  if (!spec) fn_raise(`bad_request: kind must be one of ${Object.keys(_W33_KINDS).join(', ')}`);
  const answers = Array.isArray(d.answers) ? d.answers.map((x) => castInt(jtext(x))) : [];
  if (answers.length !== spec.items || answers.some((x) => x === null || x < 0 || x > spec.max)) {
    fn_raise(`bad_request: ${kind} needs ${spec.items} answers from 0 to ${spec.max}`);
  }
  let score = answers.reduce((s, x) => s + x, 0);
  let record = null;
  if (kind === 'stopbang') {
    record = _w33_stopbang_record(pid, cfg);
    score += (record.bmi_over ? 1 : 0) + (record.age_over ? 1 : 0) + (record.male ? 1 : 0);
  }
  const band = _w33_band(kind, score, cfg);
  const crisis = kind === 'phq9' && answers[8] > 0;
  const row = dbInsert('questionnaires', { patient_id: pid, kind, answers, score, band, crisis });
  fn_audit(c, 'wellbeing.submit', 'questionnaire', row.id, pid, { kind, score, band });
  const out = { id: row.id, kind, score, band, crisis, next: kind === 'phq2' && band === 'positive' ? 'phq9' : null, record };
  if (crisis) {
    // The same fixed crisis path as the Companion's self-harm pre-screen.
    const em = coalesce(fn_rule('emergency_patterns'), {});
    out.message_en = em.self_harm_message_en || 'If you are in danger now, call 123. Contact a doctor or the mental health hotline 16328 today.';
    out.message_ar = em.self_harm_message_ar || 'إذا كنت في خطر الآن اتصل بـ 123. تواصل مع طبيب أو مع الخط الساخن للصحة النفسية 16328 اليوم.';
    fn_create_inbox_item(pid, 'safety', 'critical', 1, 'Thoughts of self-harm reported (PHQ-9 item 9)',
      `The patient answered PHQ-9 item 9 above 0 (score ${score}). Contact the patient today; assess risk and safety.`,
      { type: 'phq9_item9', questionnaire_id: row.id, score }, `phq9-crisis:${row.id}`);
    for (const g of dbWhere('caregiver_grants', (x) => x.patient_id === pid && x.active === true)) {
      dbInsert('notifications', { user_id: g.caregiver_user_id, patient_id: pid, kind: 'escalation', title: 'Please check on them today',
        body: em.self_harm_caregiver_en || 'Stay with them if they may be in danger, and call 123.', title_ar: 'من فضلك اطمئن عليه اليوم',
        body_ar: em.self_harm_caregiver_ar || 'ابق معه إن كان في خطر واتصل بـ 123.', dedupe_key: `phq9-crisis:${row.id}:${g.caregiver_user_id}` }, { onConflict: 'nothing' });
    }
  } else if ((kind === 'phq9' && score >= cfg.phq9_flag) || (kind === 'paid5' && score >= cfg.paid5_flag)) {
    const what = kind === 'phq9' ? `PHQ-9 ${score} (${band})` : `PAID-5 ${score} (possible diabetes distress)`;
    fn_create_inbox_item(pid, 'question', 'medium', 3, `Check-in: ${what}`,
      `The patient's check-in scored ${what}. Consider discussing it at the next contact or offering support or referral.`,
      { type: 'wellbeing', kind, score, band }, `wellbeing:${pid}:${kind}:${isoWeekKey(today())}`);
  } else if (kind === 'stopbang' && score >= cfg.stopbang_flag) {
    fn_create_inbox_item(pid, 'question', 'low', 4, `Sleep apnea screen: STOP-BANG ${score} (${band})`,
      'Consider assessment for obstructive sleep apnea.', { type: 'stopbang', score, band }, `stopbang:${pid}:${today().slice(0, 7)}`);
  }
  return out;
}

/* --------------------------------------------------------------------------------------------- Sick-day mode */

function _w33_active_sick(pid) {
  return dbOne('sick_days', (s) => s.patient_id === pid && s.ended_at === null) || null;
}

function fn_sick_status(p_patient_id) {
  const pid = castUuid(p_patient_id);
  const cfg = _w33('sick_day', _W33_SICK);
  const s = _w33_active_sick(pid);
  const notes = cfg.class_notes || {};
  const meds = dbWhere('medications', (m) => m.patient_id === pid && m.status === 'active' && m.verification_status !== 'refuted')
    .filter((m) => notes[m.drug_class]).map((m) => ({ medication_id: m.id, name: m.name, drug_class: m.drug_class, note: notes[m.drug_class] }));
  let readings = null;
  if (s) {
    const rs = dbWhere('glucose_readings', (r) => r.patient_id === pid && t(r.measured_at) >= t(s.started_at)).map((r) => castNum(r.value_mgdl));
    readings = { count: rs.length, highest: rs.length ? Math.max(...rs) : null, lowest: rs.length ? Math.min(...rs) : null };
  }
  return { active: !!s, id: s ? s.id : null, started_at: s ? s.started_at : null, symptoms: s ? s.symptoms : null,
    check_hours: cfg.check_hours, max_days: cfg.max_days, medicines: meds, readings };
}

function api_sick_status(c, d) { return fn_sick_status(fn_resolve_patient(c, d)); }

function api_sick_start(c, d) {
  const pid = fn_resolve_patient(c, d);
  const sym = d && d.symptoms && typeof d.symptoms === 'object' ? d.symptoms : {};
  const symptoms = {};
  for (const k of _W33_SYMPTOMS) symptoms[k] = sym[k] === true;
  const ex = _w33_active_sick(pid);
  if (ex) dbUpdate('sick_days', ex, { symptoms });
  else {
    const row = dbInsert('sick_days', { patient_id: pid, symptoms, started_by: castUuid(jtext(c.user_id)) });
    const st = fn_sick_status(pid);
    const flagged = st.medicines.filter((m) => m.note !== 'low_risk').map((m) => m.name);
    const dehydrating = symptoms.vomiting || symptoms.diarrhea || symptoms.not_drinking;
    fn_create_inbox_item(pid, 'safety', dehydrating && flagged.length ? 'high' : 'medium', 2, 'Sick day: patient is unwell',
      `Symptoms: ${_W33_SYMPTOMS.filter((k) => symptoms[k]).join(', ') || 'not specified'}. `
        + (flagged.length ? `Medicines that usually need sick-day advice: ${flagged.join(', ')}. ` : '')
        + 'Please give the patient sick-day advice today.',
      { type: 'sick_day', sick_day_id: row.id, symptoms }, `sick-day:${row.id}`);
    fn_notify_patient(pid, 'sick_day', 'Sick-day mode is on', 'Check your sugar every few hours, drink fluids, and follow your care team\'s advice.',
      `sick-day:${row.id}`, 'وضع أيام المرض مفعّل', 'قِس السكر كل بضع ساعات، واشرب سوائل، واتبع نصيحة فريق الرعاية.');
  }
  fn_audit(c, 'sick_day.start', 'sick_day', null, pid, { symptoms });
  return fn_sick_status(pid);
}

function api_sick_end(c, d) {
  const pid = fn_resolve_patient(c, d);
  const s = _w33_active_sick(pid);
  if (s) dbUpdate('sick_days', s, { ended_at: now() });
  fn_audit(c, 'sick_day.end', 'sick_day', s ? s.id : null, pid);
  return fn_sick_status(pid);
}

/** Part of the 15-minute reminders job: a glucose-check reminder every check_hours, and the end after max_days. */
function fn_run_sick_days() {
  const cfg = _w33('sick_day', _W33_SICK);
  const nowT = nowMs();
  let reminders = 0, ended = 0;
  for (const s of dbWhere('sick_days', (x) => x.ended_at === null)) {
    const since = nowT - t(s.started_at);
    if (since > cfg.max_days * DAY) { dbUpdate('sick_days', s, { ended_at: now() }); ended++; continue; }
    const slot = Math.floor(since / (cfg.check_hours * HOUR));
    if (slot < 1) continue;
    fn_notify_patient(s.patient_id, 'sick_check', 'Sick day: time to check your sugar', 'Also drink water and note if you can keep fluids down.',
      `sick-check:${s.id}:${slot}`, 'يوم مرض: وقت قياس السكر', 'واشرب ماء ولاحظ إن كنت تقدر تحتفظ بالسوائل.');
    reminders++;
  }
  return { sick_reminders: reminders, sick_ended: ended };
}

/* --------------------------------------------------------------------------------------- Before-driving check */

function fn_drive_eligible(p_patient_id) {
  const cfg = _w33('drive_check', _W33_DRIVE);
  return dbExists('medications', (m) => m.patient_id === p_patient_id && m.status === 'active' && m.verification_status !== 'refuted' && cfg.classes.includes(m.drug_class));
}

/** verdict: measure (no reading in max_age_min), eat_first (below min_mgdl), ok. */
function fn_drive_check(p_patient_id) {
  const pid = castUuid(p_patient_id);
  const cfg = _w33('drive_check', _W33_DRIVE);
  const last = orderBy(dbWhere('glucose_readings', (r) => r.patient_id === pid), [(r) => t(r.measured_at), 'desc'])[0] || null;
  const age = last ? Math.round((nowMs() - t(last.measured_at)) / MIN) : null;
  const value = last ? castNum(last.value_mgdl) : null;
  const verdict = last === null || age > cfg.max_age_min ? 'measure' : value < cfg.min_mgdl ? 'eat_first' : 'ok';
  return { eligible: fn_drive_eligible(pid), verdict, value: verdict === 'measure' ? null : value, minutes_ago: age,
    min_mgdl: cfg.min_mgdl, recheck_hours: cfg.recheck_hours, wait_after_low_min: cfg.wait_after_low_min };
}

function api_drive_check(c, d) { return fn_drive_check(fn_resolve_patient(c, d)); }
