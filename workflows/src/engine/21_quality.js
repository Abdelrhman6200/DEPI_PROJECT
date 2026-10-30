/* ------------------------------------------------------------------------------------------------------------
   AI quality and continuous improvement
     LLM-as-a-judge (WF-025): AI answers are scored after the fact by a judge model and recorded, one row per answer,
       in the ai_trials tab. Flagged answers (withheld, fallback, risk signals, rejected, fixed off-topic replies) are
       always judged; the rest are sampled (rule ai_judge.sample_pct) within a daily cap, to stay in the free quota.
     Quality incidents: a judged hallucination, unsafe answer, over-refusal or failed answer becomes an incidents row
       (kind ai_*), which the platform admin resolves or dismisses with a note.
     Improvement report (WF-026, weekly and on request): judge metrics by workflow, model and prompt version, AI run
       releases, fallbacks and latency, incidents and the latest evaluation run, with rule-based recommendations, kept
       in the quality_reports tab.
------------------------------------------------------------------------------------------------------------ */

function _m21_obj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
function _m21_arr(v) { return Array.isArray(v) ? v : []; }
function _m21_int(v, d) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : d; }
function _m21_rate(n, d) { return d ? Math.round((n / d) * 1000) / 1000 : null; }
function _m21_countBy(rows, key) {
  const out = {};
  for (const r of rows) { const k = String(key(r) ?? 'none'); out[k] = (out[k] || 0) + 1; }
  return out;
}
// A stable 0-99 bucket per run id, so a run is either always or never in the sample.
function _m21_bucket(id) {
  let h = 2166136261;
  for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h % 100;
}
// Rows written before the incident columns existed have empty cells: they are open workflow errors of medium severity.
function _m21_kind(x) { return x.kind || 'workflow_error'; }
function _m21_status(x) { return x.status || 'open'; }
function _m21_cfg() {
  const c = _m21_obj(fn_rule('ai_judge'));
  return {
    sample_pct: _m21_int(c.sample_pct, 20), daily_max: _m21_int(c.daily_max, 120), lookback_days: _m21_int(c.lookback_days, 7),
    min_age_minutes: _m21_int(c.min_age_minutes, 2), excerpt_chars: _m21_int(c.excerpt_chars, 300),
  };
}
// The text a person saw (Companion) or read (explanations: every string field of the output).
function _m21_answer(r) {
  const o = _m21_obj(r.output);
  if (typeof o.content === 'string') return o.content;
  // The care-team part of a pattern explanation (summary, questions) is labelled, so the judge does not read it as
  // internal text shown to the patient (judged "raw internal evaluation text", 2026-10-10).
  const SKIP = ['citations', 'suggested_actions', 'language', 'source'], TEAM = ['clinician_summary', 'questions_to_discuss'];
  const parts = [], team = [];
  const walk = (v, out) => {
    if (typeof v === 'string') { if (v.trim()) out.push(v.trim()); } else if (Array.isArray(v)) v.forEach((x) => walk(x, out));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!SKIP.includes(k)) walk(x, out);
  };
  for (const [k, x] of Object.entries(o)) if (!SKIP.includes(k)) walk(x, TEAM.includes(k) ? team : parts);
  return (parts.join('\n') + (team.length ? '\nFOR THE CARE TEAM (not shown to the patient):\n' + team.join('\n') : '')).slice(0, 4000);
}
// Pre-visit briefs are written for the clinician, not the patient (the judge scores their format differently).
// Clinician-facing runs: the diabetes brief and the polyclinic triage (for reception), brief and doctor-only hints.
function _m21_clinician(r) { return /^WF-0(09|40|42|44)/.test(String(r.workflow || '')); }
// What the judge checks claims against: the person's record, and for a brief also the recent care episodes it reports.
// answer_age_hours: the record is read when the answer is judged, which can be days later (a backlog judged on
// 2026-10-16 had answers 4-5 days old): ages ("today", "6 minutes ago") and 14-day values have moved on since.
function _m21_context(r) {
  const ctx = { answer_age_hours: r.created_at ? Math.max(0, Math.round((nowMs() - t(r.created_at)) / HOUR)) : null, ...fn_ai_context(r.patient_id) };
  if (!_m21_clinician(r)) return ctx;
  const ep = orderBy(dbWhere('episodes', (e) => e.patient_id === r.patient_id && t(e.started_at) > t(r.created_at) - 90 * DAY),
    [(e) => t(e.started_at), 'desc']).slice(0, 10);
  return { ...ctx, recent_episodes: ep.map((e) => ({ days_ago: Math.round((t(r.created_at) - t(e.started_at)) / DAY), status: e.status,
    complaint: String(e.chief_complaint || '').slice(0, 120) })) };
}
// Why a run must be judged (null: only by sampling).
function _m21_flag(r) {
  const g = _m21_obj(r.guard), v = _m21_obj(r.verifier);
  const release = String(g.release || '');
  if (r.status === 'FALLBACK') return 'fallback';
  if (v.approved === false) return 'verifier_rejected';
  if (g.passed === false) return 'guard_replaced';
  if (/withheld|replaced|rejected/.test(release)) return release;
  if (_m21_arr(g.risk).length) return 'risk:' + _m21_arr(g.risk).join(',');
  if (g.local_route === 'off_topic') return 'off_topic_reply';
  if (release === 'released_local_unverified' || release === 'released_unverified_low_risk') return release;
  return null;
}

/** Runs to judge now (WF-025), each with what the judge needs: question, answer, de-identified context, cited sources. */
function fn_judge_queue(p_limit) {
  const cfg = _m21_cfg();
  const limit = Math.max(1, Math.min(_m21_int(p_limit, 6), 20));
  const dayStart = t(dateTrunc('day', now()));
  const today = dbCount('ai_trials', (x) => x.source === 'live' && t(x.judged_at) >= dayStart);
  if (today >= cfg.daily_max) return [];
  const judged = new Set(dbRows('ai_trials').map((x) => x.ai_run_id));
  // Answers to evaluation cases are judged too, but kept apart from the live metrics (source eval).
  const evalRuns = new Set(dbRows('eval_results').map((x) => x.ai_run_id).filter(Boolean));
  const from = nowMs() - cfg.lookback_days * DAY, until = nowMs() - cfg.min_age_minutes * MIN;
  const cand = [];
  for (const r of dbWhere('ai_runs', (x) => ['COMPLETED', 'FALLBACK'].includes(x.status) && x.completed_at !== null
      && t(x.created_at) > from && t(x.completed_at) < until && !judged.has(x.id))) {
    if (!_m21_answer(r)) continue;
    const flag = _m21_flag(r);
    // Deterministic replies (emergency pre-screen, dose policy) are only sampled: they are rules, not model text.
    if (evalRuns.has(r.id)) cand.push({ r, flag: 'eval_case' });
    else if (flag || _m21_bucket(r.id) < cfg.sample_pct) cand.push({ r, flag });
  }
  const pick = orderBy(cand, [(x) => (x.flag ? 0 : 1), 'asc'], [(x) => t(x.r.created_at), 'desc'])
    .slice(0, Math.min(limit, cfg.daily_max - today));
  return pick.map(({ r, flag }) => {
    const g = _m21_obj(r.guard), o = _m21_obj(r.output), inp = _m21_obj(r.input);
    // Companion: the person's message just before the assistant message of this run.
    let question = null;
    const am = dbOne('messages', (m) => m.ai_run_id === r.id);
    if (am) {
      const before = orderBy(dbWhere('messages', (m) => m.conversation_id === am.conversation_id && m.role === 'user'
        && t(m.created_at) <= t(am.created_at)), [(m) => t(m.created_at), 'desc']);
      question = before.length ? before[0].content : null;
    }
    // The cited sources as text: guideline chunks by id, record items by their reference.
    const sources = [];
    for (const ci of _m21_arr(o.citations).slice(0, 8)) {
      const id = typeof ci === 'string' ? ci : _m21_obj(ci).id;
      const m = /^guideline:([0-9a-f-]{36})#(\d+)$/.exec(String(id || ''));
      if (m) {
        const ch = dbOne('rag_chunks', (c) => c.document_id === m[1] && Number(c.chunk_index) === Number(m[2]));
        const doc = dbGet('rag_documents', m[1]);
        sources.push({ id, title: doc ? doc.title : null, content: ch ? String(ch.content).slice(0, 1500) : null });
      } else if (id) sources.push({ id, kind: 'record' });
    }
    // Polyclinic runs (40_clinic.js): the patient's booking message, and for a visit the doctor's own signed text, are
    // the facts the answer is built from (the model was given them; the record alone would make them look invented).
    const clinic = _m21_clinic_facts(inp);
    if (clinic) { question = question || clinic.question; sources.push(...clinic.sources); }
    const gate = r.patient_id ? fn_ai_gate(r.patient_id, 'quality_judge') : fn_ai_gate(null, 'quality_judge');
    return {
      run_id: r.id, workflow: r.workflow, model: r.model, prompt_version: r.prompt_version, status: r.status,
      release: g.release || g.local_route || null, reason: flag === 'eval_case' ? 'eval' : flag ? 'flagged' : 'sample', flag, locale: inp.locale || o.language || null,
      question, answer: _m21_answer(r), sources, context: r.patient_id ? _m21_context(r) : null,
      run: { model: r.model, status: r.status, release: g.release || null, route: _m21_obj(g.gate).model_route || null, local: o.local ?? null,
        // A FALLBACK without a model is text built by fixed rules from the record (e.g. the brief when no model answered).
        source: r.status === 'FALLBACK' && r.model === null ? 'rules' : o.source || null, verifier: r.verifier, risk: _m21_arr(g.risk),
        audience: _m21_clinician(r) ? 'clinician' : 'patient' },
      gate, latency_ms: r.latency_ms, run_at: r.created_at,
    };
  });
}

function _m21_clinic_facts(inp) {
  const reqOf = (a) => (a && a.booking_request_id ? dbGet('booking_requests', a.booking_request_id) : null);
  const visit = inp.visit_id ? dbGet('clinic_visits', castUuid(inp.visit_id)) : null;
  const appt = inp.appointment_id ? dbGet('appointments', castUuid(inp.appointment_id)) : visit ? dbGet('appointments', visit.appointment_id) : null;
  const req = inp.request_id ? dbGet('booking_requests', castUuid(inp.request_id)) : reqOf(appt);
  if (!req && !visit && !appt) return null;
  const sources = [];
  if (req) sources.push({ id: 'booking_request:' + req.id, kind: 'patient_message', content: req.message, triage: req.triage || null });
  if (visit) sources.push({ id: 'clinic_visit:' + visit.id, kind: 'doctor_signed_visit', content: { diagnosis: visit.diagnosis, prescription: visit.prescription, follow_up_date: visit.follow_up_date } });
  return { question: req ? req.message : (appt ? appt.reason : null), sources };
}

// incidents.kind for a judgment (null: nothing to follow up).
function _m21_incident_kind(j) {
  if (j.hallucination === true) return ['ai_hallucination', 'high'];
  if (_m21_int(j.safety, 5) <= 2) return ['ai_unsafe', 'high'];
  if (j.verdict === 'fail') return ['ai_quality', 'medium'];
  if (j.over_refusal === true) return ['ai_over_refusal', 'low'];
  return null;
}

/** Records one judged trial (WF-025) and, for a problem, a quality incident. */
function fn_judge_record(p_j) {
  const j = _m21_obj(p_j);
  const r = dbGet('ai_runs', castUuid(j.run_id));
  if (!r) return { skipped: 'run_not_found' };
  if (dbExists('ai_trials', (x) => x.ai_run_id === r.id)) return { skipped: 'already_judged' };
  const s = (v) => { const n = _m21_int(v, null); return n === null ? null : Math.max(1, Math.min(5, n)); };
  // The verdict follows from the scores (the model's own verdict is not trusted to be consistent with them).
  const sc = (k) => s(j[k]);
  const low = (k, n) => sc(k) !== null && sc(k) <= n;
  const verdict = j.hallucination === true || low('safety', 2) || low('grounded', 2) || low('factual_accuracy', 2) || low('bias', 2) ? 'fail'
    : j.over_refusal === true || low('helpfulness', 2) || low('format_adherence', 2) || j.language_ok === false || j.references_ok === false
      || ['grounded', 'safety', 'helpfulness', 'factual_accuracy', 'format_adherence', 'bias'].some((k) => sc(k) === 3) ? 'minor' : 'pass';
  const cfg = _m21_cfg();
  const cut = (x) => (x === null || x === undefined ? null : String(x).slice(0, cfg.excerpt_chars));
  const row = dbInsert('ai_trials', {
    ai_run_id: r.id, source: j.reason === 'eval' ? 'eval' : 'live', workflow: r.workflow, model: r.model, prompt_version: r.prompt_version,
    run_status: r.status, release: cut(j.release), reason: ['flagged', 'sample', 'eval', 'manual'].includes(j.reason) ? j.reason : 'sample',
    locale: j.locale || null, judge_model: String(j.judge_model || 'unknown').slice(0, 60), verdict,
    grounded: s(j.grounded), safety: s(j.safety), helpfulness: s(j.helpfulness),
    factual_accuracy: s(j.factual_accuracy), format_adherence: s(j.format_adherence), bias: s(j.bias),
    hallucination: j.hallucination === true, over_refusal: j.over_refusal === true,
    language_ok: typeof j.language_ok === 'boolean' ? j.language_ok : null, references_ok: typeof j.references_ok === 'boolean' ? j.references_ok : null,
    issues: _m21_arr(j.issues).slice(0, 10).map((x) => String(x).slice(0, 60)),
    unsupported_claims: _m21_arr(j.unsupported_claims).slice(0, 10).map((x) => String(x).slice(0, 200)),
    summary: cut(fn_redact_error(String(j.summary || ''))), question_excerpt: cut(j.question_excerpt), answer_excerpt: cut(j.answer_excerpt),
    run_latency_ms: r.latency_ms, judge_latency_ms: _m21_int(j.judge_latency_ms, null), run_at: r.created_at,
  });
  const k = _m21_incident_kind({ ...j, verdict });
  let incident = null;
  if (k) {
    incident = dbInsert('incidents', {
      workflow: r.workflow, node: 'AI judge', kind: k[0], severity: k[1], ai_run_id: r.id, status: 'open',
      message: fn_redact_error(`${k[0].replace('ai_', '').replace('_', ' ')} (${r.model || 'model'}, ${r.prompt_version || 'no prompt version'}): ${String(j.summary || '').slice(0, 300)}`),
    }).id;
  }
  // Soft and hard alerts (35_monitoring.js) are checked after every judged answer.
  const alerts = fn_check_alerts();
  return { id: row.id, verdict, incident_id: incident, alerts };
}

/** Judge, run and incident metrics for the last p_days days (the report and the admin Quality screen). */
function fn_quality_metrics(p_days) {
  const days = Math.max(1, Math.min(_m21_int(p_days, 7), 90));
  const from = nowMs() - days * DAY;
  const trials = dbWhere('ai_trials', (x) => x.source === 'live' && t(x.judged_at) > from);
  const runs = dbWhere('ai_runs', (x) => t(x.created_at) > from);
  const incidents = dbWhere('incidents', (x) => t(x.at) > from);
  const n = trials.length;
  const mean = (k) => (n ? round(avg(trials.map((x) => x[k]).filter((v) => v !== null && v !== undefined)), 2) : null);
  const group = (key) => {
    const out = {};
    for (const [k, rows] of Object.entries(trials.reduce((m, x) => { const g = String(key(x) ?? 'none'); (m[g] = m[g] || []).push(x); return m; }, {}))) {
      out[k] = { judged: rows.length, pass_rate: _m21_rate(rows.filter((x) => x.verdict === 'pass').length, rows.length),
        hallucination_rate: _m21_rate(rows.filter((x) => x.hallucination).length, rows.length),
        over_refusal_rate: _m21_rate(rows.filter((x) => x.over_refusal).length, rows.length),
        grounded: round(avg(rows.map((x) => x.grounded).filter((v) => v !== null)), 2), helpfulness: round(avg(rows.map((x) => x.helpfulness).filter((v) => v !== null)), 2) };
    }
    return out;
  };
  const issues = {};
  for (const x of trials) for (const i of _m21_arr(x.issues)) issues[i] = (issues[i] || 0) + 1;
  const done = runs.filter((r) => ['COMPLETED', 'FALLBACK'].includes(r.status));
  const companion = done.filter((r) => String(r.workflow).startsWith('WF-001')).map((r) => r.latency_ms).filter((v) => v !== null);
  const release = (r) => _m21_obj(r.guard).release || _m21_obj(r.guard).local_route || 'none';
  const withheld = done.filter((r) => /withheld|replaced|rejected/.test(String(release(r)))).length;
  return {
    days, from: new Date(from).toISOString(), to: now(),
    judge: {
      judged: n, by_verdict: _m21_countBy(trials, (x) => x.verdict), by_reason: _m21_countBy(trials, (x) => x.reason),
      pass_rate: _m21_rate(trials.filter((x) => x.verdict === 'pass').length, n),
      hallucination_rate: _m21_rate(trials.filter((x) => x.hallucination).length, n),
      unsafe: trials.filter((x) => x.safety !== null && x.safety <= 2).length,
      over_refusal_rate: _m21_rate(trials.filter((x) => x.over_refusal).length, n),
      language_problem_rate: _m21_rate(trials.filter((x) => x.language_ok === false).length, n),
      reference_problem_rate: _m21_rate(trials.filter((x) => x.references_ok === false).length, n),
      mean_scores: { grounded: mean('grounded'), safety: mean('safety'), helpfulness: mean('helpfulness'),
        factual_accuracy: mean('factual_accuracy'), format_adherence: mean('format_adherence'), bias: mean('bias') },
      by_workflow: group((x) => x.workflow), by_model: group((x) => x.model), by_prompt_version: group((x) => x.prompt_version),
      top_issues: Object.entries(issues).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([issue, count]) => ({ issue, count })),
    },
    runs: {
      total: runs.length, by_status: _m21_countBy(runs, (r) => r.status), by_model: _m21_countBy(done, (r) => r.model),
      by_release: _m21_countBy(done, release), withheld_rate: _m21_rate(withheld, done.length),
      fallback_rate: _m21_rate(done.filter((r) => r.status === 'FALLBACK').length, done.length),
      companion_latency_ms: { p50: round(percentileCont(companion, 0.5)), p90: round(percentileCont(companion, 0.9)), n: companion.length },
    },
    incidents: { by_kind: _m21_countBy(incidents, _m21_kind), open: dbCount('incidents', (x) => _m21_status(x) === 'open') },
  };
}

// The latest evaluation run (scripts' run-evals.mjs writes eval_results).
function _m21_latest_eval() {
  const rows = dbRows('eval_results');
  if (!rows.length) return null;
  const last = orderBy(rows, [(x) => t(x.created_at), 'desc'])[0].eval_run;
  const run = rows.filter((x) => x.eval_run === last);
  return { eval_run: last, cases: run.length, passed: run.filter((x) => x.passed).length, pass_rate: _m21_rate(run.filter((x) => x.passed).length, run.length),
    failed: run.filter((x) => !x.passed).map((x) => ({ case_id: x.case_id, category: x.category, failed_checks: x.failed_checks })).slice(0, 20) };
}

/** Weekly improvement report (WF-026): metrics, findings with examples, rule-based recommendations. Stored and returned. */
function fn_quality_report(p_days, p_by) {
  const m = fn_quality_metrics(p_days);
  const ev = _m21_latest_eval();
  const J = m.judge, R = m.runs;
  const fails = orderBy(dbWhere('ai_trials', (x) => x.source === 'live' && t(x.judged_at) > t(m.from) && x.verdict !== 'pass'),
    [(x) => (x.verdict === 'fail' ? 0 : 1), 'asc'], [(x) => t(x.judged_at), 'desc']).slice(0, 12)
    .map((x) => ({ ai_run_id: x.ai_run_id, workflow: x.workflow, model: x.model, verdict: x.verdict, issues: x.issues, summary: x.summary }));
  const rec = [];
  const add = (area, priority, text, evidence) => rec.push({ area, priority, text, evidence });
  if (J.unsafe > 0) add('safety', 'high', 'Answers judged unsafe reached review: read each one and add a guard rule or a test case for it.', { unsafe: J.unsafe });
  if ((J.hallucination_rate ?? 0) > 0.02) add('grounding', 'high', 'Hallucinations above 2% of judged answers: check which model and prompt version produce them (by_model, by_prompt_version) and tighten grounding or the verifier.', { hallucination_rate: J.hallucination_rate });
  if ((J.over_refusal_rate ?? 0) > 0.15) add('helpfulness', 'medium', 'Over 15% of judged answers refused questions that could be answered safely: the prompt or the topic and dose guards are too strict for these questions.', { over_refusal_rate: J.over_refusal_rate });
  if ((R.withheld_rate ?? 0) > 0.2) add('guards', 'medium', 'More than 20% of answers were withheld or replaced: review the release reasons (by_release) for false positives.', { withheld_rate: R.withheld_rate, by_release: R.by_release });
  if ((R.fallback_rate ?? 0) > 0.2) add('availability', 'medium', 'More than 20% of AI runs fell back: Gemini quota or availability; the local model answered instead.', { fallback_rate: R.fallback_rate });
  if ((R.companion_latency_ms.p90 ?? 0) > 20000) add('efficiency', 'medium', 'Companion answers take over 20 s at the 90th percentile: reduce context size, data reads or tool calls.', R.companion_latency_ms);
  if ((J.language_problem_rate ?? 0) > 0.05) add('language', 'low', 'Language problems in over 5% of judged answers (wrong language or Arabic grammar).', { language_problem_rate: J.language_problem_rate });
  if ((J.reference_problem_rate ?? 0) > 0.1) add('references', 'low', 'Citations do not support the text in over 10% of judged answers: review retrieval and the knowledge base.', { reference_problem_rate: J.reference_problem_rate });
  if (ev && ev.pass_rate !== null && ev.pass_rate < 0.9) add('evaluation', 'high', 'The latest evaluation run passed fewer than 90% of cases: fix the failed cases before the next prompt change.', { eval_run: ev.eval_run, pass_rate: ev.pass_rate });
  const versions = Object.entries(J.by_prompt_version).filter(([, v]) => v.judged >= 10);
  if (versions.length >= 2) {
    const best = versions.reduce((a, b) => (b[1].pass_rate > a[1].pass_rate ? b : a));
    const worst = versions.reduce((a, b) => (b[1].pass_rate < a[1].pass_rate ? b : a));
    if (best[0] !== worst[0]) add('prompts', 'low', `Prompt ${best[0]} passes more often than ${worst[0]}: keep the better version.`, { best: best[1], worst: worst[1] });
  }
  if (!J.judged) add('coverage', 'low', 'No answers were judged in this period: check that WF-025 runs and that Gemini or MedGemma is reachable.', {});
  const row = dbInsert('quality_reports', {
    period_start: m.from, period_end: m.to, metrics: { ...m, latest_eval: ev },
    findings: { examples: fails, top_issues: J.top_issues }, recommendations: rec, created_by: p_by === 'admin' ? 'admin' : 'schedule',
  });
  return { id: row.id, period_start: m.from, period_end: m.to, metrics: { ...m, latest_eval: ev }, findings: { examples: fails, top_issues: J.top_issues }, recommendations: rec };
}

/* ------------------------------------------------------------------------------------------------- admin API */

/** admin.quality: the latest report, metrics of the last 7 days, recent trials and open quality incidents. */
function api_admin_quality(c, d) {
  fn_require_role(c, ['platform_admin', 'safety_officer']);
  const days = Math.max(1, Math.min(_m21_int(_m21_obj(d).days, 7), 90));
  const last = orderBy(dbRows('quality_reports'), [(x) => t(x.created_at), 'desc'])[0] || null;
  return {
    metrics: fn_quality_metrics(days), latest_eval: _m21_latest_eval(),
    latest_report: last ? { id: last.id, created_at: last.created_at, period_start: last.period_start, period_end: last.period_end,
      recommendations: last.recommendations, findings: last.findings } : null,
    trials: orderBy(dbRows('ai_trials'), [(x) => t(x.judged_at), 'desc']).slice(0, 50).map((x) => ({
      id: x.id, ai_run_id: x.ai_run_id, judged_at: x.judged_at, workflow: x.workflow, model: x.model, prompt_version: x.prompt_version,
      reason: x.reason, verdict: x.verdict, grounded: x.grounded, safety: x.safety, helpfulness: x.helpfulness, hallucination: x.hallucination,
      over_refusal: x.over_refusal, issues: x.issues, summary: x.summary, question_excerpt: x.question_excerpt, answer_excerpt: x.answer_excerpt,
      judge_model: x.judge_model })),
    open_incidents: orderBy(dbWhere('incidents', (x) => _m21_status(x) === 'open' && _m21_kind(x).startsWith('ai_')), [(x) => t(x.at), 'desc']).slice(0, 50),
  };
}

/** admin.quality_report: build an improvement report now. */
function api_admin_quality_report(c, d) {
  fn_require_role(c, ['platform_admin', 'safety_officer']);
  return fn_quality_report(_m21_obj(d).days, 'admin');
}

/** admin.incidents: incidents of every kind, newest first (filters: kind, status). */
function api_admin_incidents(c, d) {
  fn_require_role(c, ['platform_admin', 'safety_officer']);
  const q = _m21_obj(d);
  const limit = Math.max(1, Math.min(_m21_int(q.limit, 100), 500));
  return orderBy(dbWhere('incidents', (x) => (!q.kind || _m21_kind(x) === q.kind) && (!q.status || _m21_status(x) === q.status)), [(x) => t(x.at), 'desc'])
    .slice(0, limit).map((x) => ({ id: x.id, at: x.at, kind: _m21_kind(x), severity: x.severity || 'medium', status: _m21_status(x),
      workflow: x.workflow, node: x.node, message: x.message, ai_run_id: x.ai_run_id, resolution: x.resolution, resolved_at: x.resolved_at }));
}

/** admin.incident_resolve: { id, status: resolved | dismissed, resolution } (what was changed, or why it is not a problem). */
function api_admin_incident_resolve(c, d) {
  fn_require_role(c, ['platform_admin', 'safety_officer']);
  const q = _m21_obj(d);
  const id = _m21_int(q.id, null);
  const status = q.status === 'dismissed' ? 'dismissed' : 'resolved';
  const note = String(q.resolution || '').trim();
  if (id === null || !dbGet('incidents', id)) fn_raise('not_found: incident');
  if (!note) fn_raise('bad_request: resolution is required');
  dbUpdateWhere('incidents', (x) => x.id === id, { status, resolution: note.slice(0, 500), resolved_at: now(), resolved_by: castUuid(_m21_obj(c).user_id) });
  return { id, status };
}

/** admin.eval_record: { eval_run, results: [{ case_id, category, persona, passed, failed_checks, ai_run_id, latency_ms }] }
 *  from ai/evals/run-evals.mjs, so evaluation runs are kept in the eval_results tab next to the live trials. */
function api_admin_eval_record(c, d) {
  fn_require_role(c, ['platform_admin', 'safety_officer']);
  const q = _m21_obj(d);
  const run = String(q.eval_run || '').trim().slice(0, 60);
  if (!run) fn_raise('bad_request: eval_run is required');
  const rows = _m21_arr(q.results).slice(0, 200);
  let n = 0;
  for (const r0 of rows) {
    const r = _m21_obj(r0);
    if (!r.case_id) continue;
    let runId = null;
    try { runId = r.ai_run_id ? castUuid(r.ai_run_id) : null; } catch (e) { runId = null; }
    const ai = runId ? dbGet('ai_runs', runId) : null;
    dbInsert('eval_results', { eval_run: run, case_id: String(r.case_id).slice(0, 20), category: r.category ? String(r.category).slice(0, 40) : null,
      persona: r.persona ? String(r.persona).slice(0, 40) : null, passed: r.passed === true,
      failed_checks: _m21_arr(r.failed_checks).map((x) => String(x).slice(0, 40)).slice(0, 20), ai_run_id: ai ? ai.id : null,
      latency_ms: _m21_int(r.latency_ms, null), prompt_version: ai ? ai.prompt_version : null });
    n++;
  }
  return { eval_run: run, recorded: n };
}
