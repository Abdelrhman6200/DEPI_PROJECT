/* 35 · Monitoring dashboard, alerts, judge calibration and trace export (course rubric, Phase 4).
 *
 * The platform is presented as five connected workflows (docs/graduation): W1 patient data and logging, W2 AI
 * Companion, W3 clinician decision support, W4 follow-up and care access, W5 safety monitor and evaluation.
 *
 *   api_admin_monitoring(c, d)   one page: KPIs (baseline, target, actual), the judge's five rubric scores, failed runs,
 *                                response time, escalations, the nurse review queue, alerts and calibration. Each KPI
 *                                has an owner (W1-W5; the polyclinic KPIs, from fn_clinic_kpis in 40_clinic.js, sit under W3 and W4),
 *                                lower_is_better where the target is a ceiling, and met.
 *   fn_check_alerts()            after every judged answer (fn_judge_record):
 *                                  soft  average safety below soft_safety_avg over window_hours (at least min_judged
 *                                        answers), or a failed-run rate above failed_rate -> incident + notice to the
 *                                        Evaluation Owner (owner_roles);
 *                                  hard  any answer with safety at or below hard_safety_score -> the Companion's model
 *                                        answers are paused (feature flag companion off; the emergency pre-screen and
 *                                        fixed safety replies still run) + high incident + notices, until an admin resumes.
 *   api_admin_companion_resume   resumes the Companion with a written reason.
 *   Calibration: two people who did not build a workflow score the same judged answers 1-5 on the five dimensions
 *                (raters A and B); agreement with the judge per dimension (exact, within 1, quadratic-weighted kappa).
 *                Shown as "not calibrated" until min_pairs answers have both human scores.
 *   Tracing:     fn_trace_batch() returns finished AI runs and job runs not yet traced, as metadata only (no text, no
 *                patient or user id); the section WF-030 sends them to Langfuse (self-hosted in Docker, so traces stay on
 *                this server), and fn_trace_mark() records it.
 * Settings: rule monitoring_alerts.
 */

const _M35 = {
  soft_safety_avg: 4, window_hours: 24, min_judged: 3, hard_safety_score: 1, failed_rate: 0.2, min_runs: 5,
  owner_roles: ['platform_admin', 'safety_officer'], min_pairs: 10,
};
const _M35_DIMS = ['factual_accuracy', 'grounded', 'safety', 'format_adherence', 'bias'];

function _m35_cfg() { return { ..._M35, ...(coalesce(fn_rule('monitoring_alerts'), {})) }; }

/** The logical workflow (W1-W5) of an AI run or job, for the dashboard and trace tags. */
function fn_logical_workflow(p_name) {
  const n = String(p_name || '');
  if (/^WF-001|^WF-019|^WF-022|^WF-024|rag|guideline/i.test(n)) return 'W2 AI Companion';
  if (/^WF-00[5-9]|^WF-010|brief|weekly|pattern/i.test(n)) return 'W3 Clinician decision support';
  if (/^WF-018|document|meter|nightscout|cgm/i.test(n)) return 'W1 Patient data and logging';
  if (/^WF-00[23]|^WF-01[1-7]|reminder|followup|referral|heat|push|sick/i.test(n)) return 'W4 Follow-up and care access';
  return 'W5 Safety monitor and evaluation';
}

function _m35_notify(roles, kind, title, body, dedupe) {
  for (const u of dbWhere('users', (x) => roles.includes(x.role) && x.active === true)) {
    dbInsert('notifications', { user_id: u.id, kind, title, body, dedupe_key: `${dedupe}:${u.id}` }, { onConflict: 'nothing' });
  }
}

function fn_companion_paused() {
  const f = dbGet('feature_flags', 'companion');
  return !!f && f.enabled === false;
}

/** Model-written Companion answers reach the patient only with an explicit verifier approval. A missing flag counts as
 *  on, so an installation without the row is safe by default; only an explicit enabled = false turns it off. */
function fn_companion_require_verified() {
  const f = dbGet('feature_flags', 'companion_require_verified');
  return !(f && f.enabled === false);
}

/* ------------------------------------------------------------------------------------------------------- Alerts */

function fn_check_alerts() {
  const cfg = _m35_cfg();
  const from = nowMs() - cfg.window_hours * HOUR;
  const day = today();
  const trials = dbWhere('ai_trials', (x) => x.source === 'live' && t(x.judged_at) > from && x.safety !== null);
  const out = { soft: [], hard: null };
  // Hard: one model-written answer scored at or below hard_safety_score on safety pauses the Companion's model answers.
  // Fixed safety texts (model 'deterministic-*') do not: pausing the model does not change them, and the judge's own
  // incident sends them to the Safety Officer. An answer that already caused a hard alert does not pause again after an
  // admin resumes (it stays in the 24 h window).
  const worst = trials.find((x) => castNum(x.safety) <= cfg.hard_safety_score && String(x.workflow || '').startsWith('WF-001')
    && !String(x.model || '').startsWith('deterministic')
    && !dbExists('incidents', (i) => i.node === 'hard alert' && i.ai_run_id === x.ai_run_id));
  if (worst && !fn_companion_paused()) {
    const f = dbGet('feature_flags', 'companion');
    if (f) dbUpdate('feature_flags', f, { enabled: false });
    else dbInsert('feature_flags', { key: 'companion', enabled: false, description: 'Patient AI Companion (model answers)' });
    const inc = dbInsert('incidents', { workflow: 'WF-001 Companion', node: 'hard alert', kind: 'ai_unsafe', severity: 'high', status: 'open', ai_run_id: worst.ai_run_id,
      message: `Hard alert: an answer scored safety ${worst.safety}. Companion model answers paused until an admin resumes them.` });
    _m35_notify(cfg.owner_roles, 'escalation', 'Companion paused: unsafe answer', 'An answer scored 1 on safety. Model answers are paused; emergency and fixed safety replies still work. Review it in Administration, Monitoring.', `hard-alert:${inc.id}`);
    out.hard = { incident_id: inc.id, ai_run_id: worst.ai_run_id };
  }
  // Soft: average safety below the threshold, or too many failed runs.
  if (trials.length >= cfg.min_judged) {
    const avgSafety = trials.reduce((s, x) => s + castNum(x.safety), 0) / trials.length;
    if (avgSafety < cfg.soft_safety_avg) {
      out.soft.push('safety_average');
      if (!dbExists('incidents', (x) => x.node === 'soft alert: safety average' && localDate(x.at) === day)) {
        dbInsert('incidents', { workflow: 'AI quality', node: 'soft alert: safety average', kind: 'ai_quality', severity: 'medium', status: 'open',
          message: `Soft alert: average safety ${round(avgSafety, 2)} over ${trials.length} answers in ${cfg.window_hours} h (threshold ${cfg.soft_safety_avg}).` });
      }
      _m35_notify(cfg.owner_roles, 'quality_alert', 'AI safety average below threshold', `Average safety ${round(avgSafety, 2)} over the last ${cfg.window_hours} hours. Check Administration, Monitoring.`, `soft-safety:${day}`);
    }
  }
  const runs = dbWhere('ai_runs', (r) => t(r.created_at) > from && ['COMPLETED', 'FALLBACK', 'FAILED'].includes(r.status));
  if (runs.length >= cfg.min_runs) {
    const rate = runs.filter((r) => r.status === 'FAILED').length / runs.length;
    if (rate > cfg.failed_rate) {
      out.soft.push('failed_runs');
      if (!dbExists('incidents', (x) => x.node === 'soft alert: failed runs' && localDate(x.at) === day)) {
        dbInsert('incidents', { workflow: 'AI runs', node: 'soft alert: failed runs', kind: 'workflow_error', severity: 'medium', status: 'open',
          message: `Soft alert: ${round(rate * 100, 0)}% of ${runs.length} AI runs failed in ${cfg.window_hours} h (threshold ${cfg.failed_rate * 100}%).` });
      }
      _m35_notify(cfg.owner_roles, 'quality_alert', 'Many AI runs failing', `${round(rate * 100, 0)}% of AI runs failed in the last ${cfg.window_hours} hours.`, `soft-failed:${day}`);
    }
  }
  return out;
}

function api_admin_companion_resume(c, d) {
  fn_require_role(c, ['platform_admin', 'safety_officer']);
  const note = String((d && d.note) || '').trim();
  if (note.length < 5) fn_raise('bad_request: write what was checked or changed before resuming');
  const f = dbGet('feature_flags', 'companion');
  if (f) dbUpdate('feature_flags', f, { enabled: true });
  dbUpdateWhere('incidents', (x) => x.node === 'hard alert' && x.status === 'open', { status: 'resolved', resolution: note.slice(0, 500), resolved_at: now(), resolved_by: castUuid(jtext(c.user_id)) });
  fn_audit(c, 'companion.resume', 'feature_flag', 'companion', null, { note: note.slice(0, 200) });
  return { paused: false };
}

/* -------------------------------------------------------------------------------------------------- Calibration */

function _m35_kappa(pairs) {
  // Quadratic-weighted kappa for scores 1-5.
  if (pairs.length < 2) return null;
  const k = 5, O = Array.from({ length: k }, () => Array(k).fill(0));
  for (const [a, b] of pairs) O[a - 1][b - 1]++;
  const n = pairs.length, ra = O.map((r) => r.reduce((s, x) => s + x, 0)), cb = O[0].map((_, j) => O.reduce((s, r) => s + r[j], 0));
  let num = 0, den = 0;
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
    const w = ((i - j) * (i - j)) / ((k - 1) * (k - 1));
    num += w * O[i][j]; den += w * (ra[i] * cb[j]) / n;
  }
  return den === 0 ? 1 : round(1 - num / den, 2);
}

/** Judged answers for the two human raters (excerpts and no judge scores, so the raters score blind). */
function api_admin_calibration_queue(c, d) {
  fn_require_role(c, ['platform_admin', 'safety_officer']);
  const rater = String((d && d.rater) || 'A') === 'B' ? 'B' : 'A';
  const done = new Set(dbWhere('judge_calibration', (x) => x.rater === rater).map((x) => x.trial_id));
  return orderBy(dbWhere('ai_trials', (x) => x.answer_excerpt && !done.has(x.id)), [(x) => t(x.judged_at), 'desc']).slice(0, 20)
    .map((x) => ({ trial_id: x.id, workflow: x.workflow, locale: x.locale, question: x.question_excerpt, answer: x.answer_excerpt }));
}

function api_admin_calibration_score(c, d) {
  fn_require_role(c, ['platform_admin', 'safety_officer']);
  const rater = String((d && d.rater) || '');
  if (!['A', 'B'].includes(rater)) fn_raise('bad_request: rater must be A or B');
  const trial = dbGet('ai_trials', castUuid(jtext(d && d.trial_id)));
  if (!trial) fn_raise('not_found: judged answer not found');
  const scores = {};
  for (const k of _M35_DIMS) {
    const v = castInt(jtext(d.scores && d.scores[k]));
    if (v === null || v < 1 || v > 5) fn_raise(`bad_request: ${k} must be 1 to 5`);
    scores[k] = v;
  }
  const ex = dbOne('judge_calibration', (x) => x.trial_id === trial.id && x.rater === rater);
  if (ex) dbUpdate('judge_calibration', ex, { scores, rater_user: castUuid(jtext(c.user_id)) });
  else dbInsert('judge_calibration', { trial_id: trial.id, rater, rater_user: castUuid(jtext(c.user_id)), scores });
  return fn_calibration_report();
}

function fn_calibration_report() {
  const cfg = _m35_cfg();
  const rows = dbRows('judge_calibration');
  const by = new Map();
  for (const r of rows) { if (!by.has(r.trial_id)) by.set(r.trial_id, {}); by.get(r.trial_id)[r.rater] = r.scores; }
  const dims = {};
  let complete = 0;
  for (const [tid, x] of by) if (x.A && x.B) complete++;
  for (const k of _M35_DIMS) {
    const aj = [], bj = [], ab = [];
    for (const [tid, x] of by) {
      const tr = dbGet('ai_trials', tid);
      const jv = tr ? castInt(tr[k]) : null;
      if (x.A && jv) aj.push([x.A[k], jv]);
      if (x.B && jv) bj.push([x.B[k], jv]);
      if (x.A && x.B) ab.push([x.A[k], x.B[k]]);
    }
    const agree = (p) => (p.length ? { n: p.length, exact: round(p.filter(([a, b]) => a === b).length / p.length, 2), within1: round(p.filter(([a, b]) => Math.abs(a - b) <= 1).length / p.length, 2), kappa: _m35_kappa(p) } : { n: 0 });
    dims[k] = { rater_a_vs_judge: agree(aj), rater_b_vs_judge: agree(bj), rater_a_vs_b: agree(ab) };
  }
  return { pairs: complete, min_pairs: cfg.min_pairs, calibrated: complete >= cfg.min_pairs, dimensions: dims };
}

function api_admin_calibration_report(c, d) {
  fn_require_role(c, ['platform_admin', 'safety_officer']);
  return fn_calibration_report();
}

/* ---------------------------------------------------------------------------------------------------- Dashboard */

/** Share of signed polyclinic visits whose prescription reached the patient as the verified plain-Arabic rewrite of
 *  WF-043. The release label is clinic_visits.rx_check, written by fn_clinic_apply_action: 'numbers_match' = the model's
 *  rewrite, released only after the verifier approved it and every number matched the doctor's text; 'doctor_text' = the
 *  fallback with the doctor's own words. Visits signed but not yet sent (rx_check empty) are left out. */
function _m35_clinic_rx(p_from) {
  const sent = dbWhere('clinic_visits', (v) => v.signed_at !== null && v.signed_at !== undefined && t(v.signed_at) >= p_from && ['numbers_match', 'doctor_text'].includes(v.rx_check));
  return { actual: sent.length ? round((100 * sent.filter((v) => v.rx_check === 'numbers_match').length) / sent.length, 1) : null, n: sent.length };
}

/** Owner of each KPI: the five workflows (docs/graduation); the polyclinic KPIs sit under W3 and W4. */
const _M35_OWNERS = { W1: 'Patient data', W2: 'AI Companion', W3: 'Clinician support', W4: 'Follow-up and access', W5: 'Safety and evaluation' };

function api_admin_monitoring(c, d) {
  fn_require_role(c, ['platform_admin', 'safety_officer', 'clinic_admin']);
  const days = Math.max(1, Math.min(castInt(jtext(d && d.days)) ?? 7, 90));
  const from = nowMs() - days * DAY;
  const pct = (a, b) => (b ? round((100 * a) / b, 1) : null);
  const med = (xs) => (xs.length ? round(percentileCont(xs, 0.5), 0) : null);
  // KPIs (docs/graduation/01-business-brief.md): baseline, target, actual.
  const flags = dbWhere('audit_logs', (l) => t(l.at) > from && ['companion.routed', 'companion.not_routed'].includes(l.action)
    && ['emergency', 'urgent', 'ai_emergency'].includes(jtext(l.detail && l.detail.kind)));
  // Only patients with a care team can be routed; self-care patients (no clinic) get the fixed emergency text and are counted apart.
  // A patient with a care team, own or the on-call diabetes clinic (rule diabetes_oncall), can be routed.
  const routed = flags.filter((l) => l.patient_id && dbExists('care_team', (ct) => ct.patient_id === l.patient_id && ct.active === true));
  const selfCare = flags.length - routed.length;
  const urgent = dbWhere('inbox_items', (i) => t(i.created_at) > from && ['high', 'critical'].includes(i.urgency));
  const ackMin = urgent.filter((i) => i.acknowledged_at).map((i) => (t(i.acknowledged_at) - t(i.created_at)) / MIN);
  const appts = dbWhere('appointments', (a) => t(a.starts_at) > from && t(a.starts_at) < nowMs() + 2 * DAY && ['booked', 'completed', 'checked_in'].includes(a.status));
  const briefed = appts.filter((a) => dbExists('previsit_briefs', (b) => b.appointment_id === a.id)).length;
  const patients = dbWhere('patients', (p) => p.user_id !== null && !fn_account_closed(p.id));
  const logging = patients.filter((p) => dbCount('glucose_readings', (r) => r.patient_id === p.id && t(r.measured_at) > nowMs() - 7 * DAY) >= 3).length;
  const adh = patients.map((p) => fn_adherence(p.id, 7)).filter((x) => x !== null);
  const companion = dbWhere('ai_runs', (r) => t(r.created_at) > from && String(r.workflow).startsWith('WF-001') && ['COMPLETED', 'FALLBACK'].includes(r.status));
  // Sources are expected only on model-written answers, not on fixed safety texts (emergency, dose refusal) or fallbacks.
  const written = companion.filter((r) => r.status === 'COMPLETED' && r.output && r.output.source !== 'fixed' && !r.output.emergency && !r.output.fallback);
  const cited = written.filter((r) => Array.isArray(r.output.citations) && r.output.citations.length > 0).length;
  const trials = dbWhere('ai_trials', (x) => x.source === 'live' && t(x.judged_at) > from);
  const mean = (k) => { const v = trials.map((x) => x[k]).filter((v) => v !== null && v !== undefined); return v.length ? round(v.reduce((s, x) => s + castNum(x), 0) / v.length, 2) : null; };
  const judgedSafety = trials.filter((x) => x.safety !== null && x.safety !== undefined).length;
  // The polyclinic numbers come from the clinic analytics (fn_clinic_kpis in 40_clinic.js), over the same window.
  const clk = fn_clinic_kpis(days).kpis;
  const clinic = (key) => { const x = clk.find((y) => y.key === key); return x ? { actual: x.actual ?? null, n: x.n ?? x.actual ?? 0 } : { actual: null, n: 0 }; };
  const cl = { minutes_to_decision: clinic('minutes_to_decision'), waitlist_recoveries: clinic('waitlist_recoveries'),
    referrals_kept: clinic('referrals_kept_in_clinic'), no_show_rate: clinic('no_shows'), rx_plain_arabic: _m35_clinic_rx(from) };
  // Each workflow owner's KPIs (W1-W5), in that order. lower_is_better: the actual must be at or below the target.
  const kpis = [
    { key: 'patients_logging_weekly', owner: 'W1', lens: 'outcomes', baseline: 35, target: 70, unit: '%', actual: pct(logging, patients.length), n: patients.length },
    { key: 'medicines_taken', owner: 'W1', lens: 'outcomes', baseline: null, target: 80, unit: '% (7 days)', actual: adh.length ? round(adh.reduce((s, x) => s + x, 0) / adh.length, 0) : null, n: adh.length },
    { key: 'answers_with_sources', owner: 'W2', lens: 'outcomes', baseline: null, target: 80, unit: '%', actual: pct(cited, written.length), n: written.length },
    { key: 'judge_safety_avg', owner: 'W2', lens: 'outcomes', baseline: null, target: 4.5, unit: 'average (1-5)', actual: mean('safety'), n: judgedSafety },
    { key: 'brief_ready_before_visit', owner: 'W3', lens: 'cost', baseline: 0, target: 90, unit: '%', actual: pct(briefed, appts.length), n: appts.length },
    { key: 'clinic_rx_plain_arabic', owner: 'W3', lens: 'outcomes', baseline: null, target: 80, unit: '%', ...cl.rx_plain_arabic },
    { key: 'clinic_referrals_kept', owner: 'W3', lens: 'cost', baseline: null, target: 70, unit: '%', ...cl.referrals_kept,
      baseline_note: 'about 50% completed (US study); 68.4% of Egyptian specialist-clinic patients followed up elsewhere (Egypt Heart J 2022)', target_note: 'team target' },
    { key: 'clinic_no_show_rate', owner: 'W4', lens: 'cost', baseline: 22, target: 17, unit: '%', ...cl.no_show_rate, lower_is_better: true,
      baseline_note: 'estimate: regional and global studies, about 21-23%; measure the real rate in the pilot' },
    { key: 'clinic_minutes_to_decision', owner: 'W4', lens: 'workforce', baseline: null, target: 30, unit: 'min (median)', ...cl.minutes_to_decision, lower_is_better: true, target_note: 'team target' },
    { key: 'clinic_waitlist_recoveries', owner: 'W4', lens: 'cost', baseline: 0, target: 1, unit: 'slots (count)', ...cl.waitlist_recoveries, target_note: 'more than 0' },
    { key: 'red_flags_routed', owner: 'W5', lens: 'outcomes', baseline: 0, target: 100, unit: '%', actual: pct(routed.filter((l) => l.action === 'companion.routed').length, routed.length), n: routed.length, self_care: selfCare },
    { key: 'urgent_ack_minutes', owner: 'W5', lens: 'workforce', baseline: null, target: 60, unit: 'min (median)', actual: med(ackMin), n: ackMin.length, lower_is_better: true },
  ].map((k) => ({ baseline_note: null, ...k, lower_is_better: k.lower_is_better === true, owner_name: _M35_OWNERS[k.owner],
    met: k.actual === null || k.actual === undefined ? null : k.lower_is_better ? k.actual <= k.target : k.actual >= k.target }));
  const runs = dbWhere('ai_runs', (r) => t(r.created_at) > from);
  const lat = companion.map((r) => r.latency_ms).filter((v) => v !== null);
  const byWorkflow = {};
  for (const r of runs) {
    const w = fn_logical_workflow(r.workflow);
    byWorkflow[w] = byWorkflow[w] || { runs: 0, failed: 0 };
    byWorkflow[w].runs++;
    if (r.status === 'FAILED') byWorkflow[w].failed++;
  }
  for (const j of dbWhere('job_runs', (x) => t(x.at) > from)) {
    const w = fn_logical_workflow(j.job);
    byWorkflow[w] = byWorkflow[w] || { runs: 0, failed: 0 };
    byWorkflow[w].runs++;
  }
  return {
    days, kpis,
    judge: { judged: trials.length, pass_rate: pct(trials.filter((x) => x.verdict === 'pass').length, trials.length),
      scores: Object.fromEntries(_M35_DIMS.map((k) => [k, mean(k)])), low_safety: trials.filter((x) => castNum(x.safety) <= 2).length },
    failed_runs: { ai: runs.filter((r) => r.status === 'FAILED').length, total: runs.length, rate: pct(runs.filter((r) => r.status === 'FAILED').length, runs.length),
      workflow_errors: dbCount('incidents', (x) => t(x.at) > from && (x.kind === null || x.kind === 'workflow_error')) },
    response_time_ms: { companion_p50: lat.length ? round(percentileCont(lat, 0.5), 0) : null, companion_p90: lat.length ? round(percentileCont(lat, 0.9), 0) : null, n: lat.length },
    escalations: { total: urgent.length, critical: urgent.filter((i) => i.urgency === 'critical').length,
      by_category: urgent.reduce((m, i) => { m[i.category] = (m[i.category] || 0) + 1; return m; }, {}) },
    reviews: { pending: dbCount('ai_reviews', (r) => r.status === 'pending'), overdue: dbCount('ai_reviews', (r) => r.status === 'pending' && t(r.due_at) < nowMs()),
      decided: dbCount('ai_reviews', (r) => r.status !== 'pending' && t(r.created_at) > from) },
    by_workflow: byWorkflow,
    alerts: { companion_paused: fn_companion_paused(), rules: _m35_cfg(),
      recent: orderBy(dbWhere('incidents', (x) => /alert/.test(String(x.node || ''))), [(x) => t(x.at), 'desc']).slice(0, 10)
        .map((x) => ({ id: x.id, at: x.at, node: x.node, severity: x.severity, status: x.status, message: x.message })) },
    calibration: fn_calibration_report(),
  };
}

/* ------------------------------------------------------------------------------------- Tracing (Langfuse) */


/** Finished AI runs and job runs not yet sent, as metadata only (no text, no patient or user id). */
function fn_trace_batch(p_limit) {
  const limit = Math.max(1, Math.min(castInt(p_limit) ?? 50, 100));
  const since = nowMs() - 7 * DAY;
  const runs = orderBy(dbWhere('ai_runs', (r) => r.traced_at === null && r.completed_at !== null && t(r.created_at) > since), (r) => t(r.created_at)).slice(0, limit);
  const out = runs.map((r) => {
    const g = r.guard && typeof r.guard === 'object' ? r.guard : {};
    const v = r.verifier && typeof r.verifier === 'object' ? r.verifier : {};
    const tr = dbOne('ai_trials', (x) => x.ai_run_id === r.id);
    const judge = tr ? Object.fromEntries(_M35_DIMS.concat(['verdict']).map((k) => [k, tr[k]])) : null;
    return {
      kind: 'ai_run', id: r.id, name: String(r.workflow || 'AI run'), start: r.created_at, end: r.completed_at,
      error: r.status === 'FAILED' ? String(r.error || 'failed').slice(0, 200) : null,
      inputs: { workflow: r.workflow, prompt_version: r.prompt_version },
      outputs: { status: r.status, release: g.release || null, risk: Array.isArray(g.risk) ? g.risk : [], verifier_approved: v.approved ?? null,
        verifier_categories: Array.isArray(v.categories) ? v.categories : [],
        judge },
      metadata: { logical_workflow: fn_logical_workflow(r.workflow), model: r.model, latency_ms: r.latency_ms, prompt_version: r.prompt_version },
      tags: [fn_logical_workflow(r.workflow).slice(0, 2), r.status, r.model].filter(Boolean),
    };
  });
  const jobs = orderBy(dbWhere('job_runs', (j) => j.traced_at === null && j.job !== 'tracing' && t(j.at) > since), (j) => t(j.at)).slice(0, Math.max(0, limit - out.length));
  for (const j of jobs) {
    out.push({ kind: 'job', id: j.id, name: `job: ${j.job}`, start: j.at, end: j.at, error: null,
      inputs: { job: j.job }, outputs: j.result && typeof j.result === 'object' ? j.result : { result: j.result },
      metadata: { logical_workflow: fn_logical_workflow(j.job) }, tags: [fn_logical_workflow(j.job).slice(0, 2), 'job'] });
  }
  // Judge scores that arrived after their run was traced (the judge runs every 10 min, tracing every 2): sent as
  // scores on the run's existing trace.
  const trials = orderBy(dbWhere('ai_trials', (x) => x.traced_at === null && t(x.judged_at) > since && x.ai_run_id !== null && x.safety !== null), (x) => t(x.judged_at))
    .filter((x) => { const r = dbGet('ai_runs', x.ai_run_id); return r && r.traced_at !== null; })
    .slice(0, Math.max(0, limit - out.length));
  for (const x of trials) {
    out.push({ kind: 'trial', id: x.id, trace_id: x.ai_run_id, name: 'judge scores', start: x.judged_at, end: x.judged_at, error: null,
      outputs: { judge: Object.fromEntries(_M35_DIMS.concat(['verdict']).map((k) => [k, x[k]])) }, tags: [] });
  }
  return out;
}

/** p_ids: [{ kind: 'ai_run' | 'job' | 'trial', id }] that Langfuse accepted. */
function fn_trace_mark(p_ids) {
  let n = 0;
  for (const x of Array.isArray(p_ids) ? p_ids : []) {
    if (x && x.kind === 'job') { const j = dbGet('job_runs', castInt(jtext(x.id))); if (j) { dbUpdate('job_runs', j, { traced_at: now() }); n++; } }
    else if (x && x.kind === 'trial') { const tr = dbGet('ai_trials', castUuid(jtext(x.id))); if (tr) { dbUpdate('ai_trials', tr, { traced_at: now() }); n++; } }
    else if (x) {
      const r = dbGet('ai_runs', castUuid(jtext(x.id)));
      if (r) {
        dbUpdate('ai_runs', r, { traced_at: now() }); n++;
        // A run judged before it was traced carried its scores in the trace.
        const tr = dbOne('ai_trials', (y) => y.ai_run_id === r.id && y.traced_at === null);
        if (tr) dbUpdate('ai_trials', tr, { traced_at: now() });
      }
    }
  }
  return { marked: n };
}
