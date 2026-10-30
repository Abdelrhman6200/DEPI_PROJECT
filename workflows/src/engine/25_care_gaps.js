/* 25 · Care gaps and panel risk: what a clinic should act on first, across all its patients (deterministic, no AI).
 *
 *   fn_care_gaps(ctx)        overdue screenings (eye, foot, HbA1c, urine albumin, lipids… from fn_screenings) per
 *                            patient the caller may see, with days overdue, plus per-screening coverage of the panel.
 *   fn_panel_risk(ctx, n)    the n patients with the highest risk score, each with the reasons (English and Arabic):
 *                            recent lows, time in range, HbA1c, kidney function, open safety findings, urgent inbox
 *                            items, overdue screenings, missing data. Points: safety rule panel_risk (defaults below).
 * Clinical roles only (doctor, nurse, clinic administrator); reception and patients are refused.
 */

const _G25_POINTS = {
  severe_hypo_7d: 5, hypo_2plus_7d: 3, tir_below_50: 3, tir_50_70: 1, hba1c_above_9: 3, hba1c_above_8: 2,
  egfr_below_30: 3, egfr_below_45: 2, safety_finding: 2, urgent_inbox: 2, overdue_screening: 1, overdue_max: 3, no_data_14d: 1,
  adherence_below_50: 2, adherence_50_80: 1, medicine_runs_out: 1, therapy_review: 1, wellbeing_flag: 2, self_harm_30d: 5, sick_day: 2,
};

function _g25_clinical(c) {
  const role = c !== null && typeof c === 'object' ? jtext(c.role) : null;
  if (!['doctor', 'nurse', 'clinic_admin'].includes(role)) fn_raise('forbidden: Only the care team can see this.');
}

function _g25_patients(c) { return dbRows('patients').filter((p) => fn_can_access_patient(c, p.id) && !fn_account_closed(p.id)); }

function _g25_daysBetween(a, b) { return Math.round((t(`${b}T00:00:00Z`) - t(`${a}T00:00:00Z`)) / DAY); }

function fn_care_gaps(c) {
  _g25_clinical(c);
  const td = today();
  const patients = [];
  const cover = {};
  for (const p of _g25_patients(c)) {
    const sc = fn_screenings(p.id);
    for (const s of sc) {
      cover[s.type] = cover[s.type] || { type: s.type, title: s.title, title_ar: s.title_ar, up_to_date: 0, total: 0 };
      cover[s.type].total++;
      if (!s.overdue) cover[s.type].up_to_date++;
    }
    const gaps = sc.filter((s) => s.overdue).map((s) => ({ type: s.type, title: s.title, title_ar: s.title_ar, last_done: s.last_done,
      next_due: s.next_due, days_overdue: s.last_done === null ? null : Math.max(0, _g25_daysBetween(s.next_due, td)) }));
    if (gaps.length) patients.push({ id: p.id, full_name: p.full_name, full_name_ar: p.full_name_ar, mrn: p.mrn, gaps });
  }
  patients.sort((a, b) => b.gaps.length - a.gaps.length || (a.full_name || '').localeCompare(b.full_name || ''));
  const coverage = Object.values(cover).map((x) => ({ ...x, percent: x.total ? Math.round((100 * x.up_to_date) / x.total) : null }));
  return { date: td, patients, coverage, patients_with_gaps: patients.length };
}

function fn_panel_risk(c, p_limit = 20) {
  _g25_clinical(c);
  const P = { ..._G25_POINTS, ...(coalesce(fn_rule('panel_risk'), {})) };
  const limit = Math.max(1, Math.min(coalesce(castInt(p_limit), 20), 100));
  const nowT = nowMs(), from7 = nowT - 7 * DAY;
  const out = [];
  for (const p of _g25_patients(c)) {
    const reasons = [];
    let score = 0;
    const add = (pts, en, ar) => { if (pts > 0) { score += pts; reasons.push({ points: pts, en, ar }); } };
    const ev = dbWhere('glucose_events', (e) => e.patient_id === p.id && t(e.occurred_at) > from7);
    const lows7 = dbCount('glucose_readings', (r) => r.patient_id === p.id && t(r.measured_at) > from7 && castNum(r.value_mgdl) < 70);
    const severe7 = ev.some((e) => e.type === 'severe_hypo') || dbExists('glucose_readings', (r) => r.patient_id === p.id && t(r.measured_at) > from7 && castNum(r.value_mgdl) < 54);
    if (severe7) add(P.severe_hypo_7d, 'Severe low in the last 7 days', 'هبوط شديد خلال آخر 7 أيام');
    else if (lows7 >= 2) add(P.hypo_2plus_7d, `${lows7} lows in the last 7 days`, `${lows7} مرات هبوط خلال آخر 7 أيام`);
    const m = fn_glucose_metrics(p.id, 14);
    if (!m || m.readings === 0) add(P.no_data_14d, 'No glucose readings in 14 days', 'مفيش قراءات سكر خلال 14 يوم');
    else if (m.tir !== null && m.tir < 50) add(P.tir_below_50, `Time in range ${m.tir}%`, `الوقت في المدى ${m.tir}%`);
    else if (m.tir !== null && m.tir < 70) add(P.tir_50_70, `Time in range ${m.tir}%`, `الوقت في المدى ${m.tir}%`);
    const a1c = orderBy(dbWhere('lab_results', (l) => l.patient_id === p.id && l.test_code === 'hba1c' && l.verification_status !== 'refuted' && l.value !== null),
      [(l) => t(l.observed_at), 'desc'])[0];
    const a1cV = a1c ? castNum(a1c.value) : null;
    if (a1cV !== null && a1cV > 9) add(P.hba1c_above_9, `HbA1c ${a1cV}%`, `السكر التراكمي ${a1cV}%`);
    else if (a1cV !== null && a1cV > 8) add(P.hba1c_above_8, `HbA1c ${a1cV}%`, `السكر التراكمي ${a1cV}%`);
    const eg = fn_egfr(p.id);
    if (eg && eg.value_exact !== null && eg.value_exact < 30) add(P.egfr_below_30, `eGFR ${eg.value}`, `وظائف الكلى ${eg.value}`);
    else if (eg && eg.value_exact !== null && eg.value_exact < 45) add(P.egfr_below_45, `eGFR ${eg.value}`, `وظائف الكلى ${eg.value}`);
    const findings = dbCount('safety_findings', (f) => f.patient_id === p.id && f.status === 'open' && ['major', 'contraindicated'].includes(f.severity));
    if (findings) add(P.safety_finding, `${findings} open medicine safety finding(s)`, `${findings} ملاحظة أمان دوائي مفتوحة`);
    const urgent = dbCount('inbox_items', (i) => i.patient_id === p.id && i.status !== 'RESOLVED' && ['high', 'critical'].includes(i.urgency));
    if (urgent) add(P.urgent_inbox, `${urgent} urgent inbox item(s)`, `${urgent} عناصر عاجلة في البريد`);
    // Medicines: doses taken in the last 14 days, and a medicine about to run out (28_adherence.js).
    const adh = fn_adherence(p.id, 14);
    if (adh !== null && adh < 50) add(P.adherence_below_50, `Medicines taken ${adh}% (14 days)`, `الالتزام بالأدوية ${adh}% (14 يوم)`);
    else if (adh !== null && adh < 80) add(P.adherence_50_80, `Medicines taken ${adh}% (14 days)`, `الالتزام بالأدوية ${adh}% (14 يوم)`);
    const runsOut = fn_refills_due(p.id).filter((r) => r.days_left !== null && r.days_left <= 1);
    if (runsOut.length) add(P.medicine_runs_out, `${runsOut.map((r) => r.name).join(', ')} runs out`, `${runsOut.map((r) => r.name).join('، ')} على وشك النفاد`);
    // A "review" treatment consideration nobody has decided on yet (32_personal.js): lows on medicines that cause them,
    // or HbA1c above target with no plan change.
    const review = p.diabetes_type === 'type2' && !p.pregnant ? fn_therapy_considerations(p.id).items.filter((x) => x.kind === 'review') : [];
    if (review.length) add(P.therapy_review, review.map((x) => x.title_en).join('; '), review.map((x) => x.title_ar).join('؛ '));
    // Check-ins and sick days (33_wellbeing.js): self-harm thoughts in 30 days, a high PHQ-9 or PAID-5, an active sick day.
    const qs = dbWhere('questionnaires', (q) => q.patient_id === p.id && t(q.created_at) > nowT - 90 * DAY);
    if (qs.some((q) => q.crisis === true && t(q.created_at) > nowT - 30 * DAY)) add(P.self_harm_30d, 'Self-harm thoughts reported (PHQ-9) in 30 days', 'أفكار إيذاء النفس (PHQ-9) خلال 30 يومًا');
    else if (qs.some((q) => (q.kind === 'phq9' && castNum(q.score) >= 10) || (q.kind === 'paid5' && castNum(q.score) >= 8))) add(P.wellbeing_flag, 'Check-in: distress or depression score high', 'الاستبيان: درجة ضيق أو اكتئاب مرتفعة');
    if (dbExists('sick_days', (s) => s.patient_id === p.id && s.ended_at === null)) add(P.sick_day, 'Unwell now (sick-day mode)', 'مريض الآن (وضع أيام المرض)');
    const overdue = fn_screenings(p.id).filter((s) => s.overdue).length;
    if (overdue) add(Math.min(overdue * P.overdue_screening, P.overdue_max), `${overdue} overdue screening(s)`, `${overdue} فحوصات متأخرة`);
    if (score > 0) out.push({ id: p.id, full_name: p.full_name, full_name_ar: p.full_name_ar, mrn: p.mrn, score, reasons: reasons.sort((a, b) => b.points - a.points) });
  }
  out.sort((a, b) => b.score - a.score || (a.full_name || '').localeCompare(b.full_name || ''));
  return { patients: out.slice(0, limit), ranked: out.length };
}
