// 013 · Read models (database/migrations/013_fn_read_models.sql): the JSON shapes returned by the API (see
// packages/api-client/src/types.ts), the patient state cache and care-plan publishing. Every key of the SQL objects is
// kept, also when its value is null.
//
// Text ORDER BY uses the database collation (en_US.utf8), not code-unit order: 'aspirin' sorts before 'Concor'.

const _M13_COLLATOR = new Intl.Collator('en-US');

/* ---------------------------------------------------------------------------------------------- private helpers */

/** Text comparison with the database collation; NULLs last (ascending). */
function _m13_cmp(a, b) {
  const an = a === null || a === undefined, bn = b === null || b === undefined;
  if (an || bn) return an && bn ? 0 : an ? 1 : -1;
  return _M13_COLLATOR.compare(String(a), String(b));
}

/** jsonb ? key: an object key, a string element of an array, or a string scalar equal to the key. */
function _m13_has(v, k) {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.some((x) => typeof x === 'string' && x === k);
  if (typeof v === 'object') return Object.prototype.hasOwnProperty.call(v, k);
  return typeof v === 'string' && v === k;
}

/** a >= b for numeric values (null gives false); decimal values that are equal in numeric arithmetic stay equal. */
function _m13_gte(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return a >= b - 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** a || b || ... : NULL when any part is NULL, numbers as text. */
function _m13_cat(...parts) {
  if (parts.some((p) => p === null || p === undefined)) return null;
  return parts.map((p) => String(p)).join('');
}

/** The ILIKE pattern as a regular expression (% any text, _ one character, \ escapes the next character). */
function _m13_likeRe(pattern) {
  const chars = Array.from(String(pattern));
  let src = '';
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '\\') {
      i++;
      if (i >= chars.length) throw new Error('LIKE pattern must not end with escape character');
      src += chars[i].replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
    } else if (c === '%') src += '[\\s\\S]*';
    else if (c === '_') src += '[\\s\\S]';
    else src += c.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
  }
  return new RegExp(`^${src}$`, 'iu');
}

/** Rows sorted newest first by a time column (ORDER BY col DESC: NULLs first). */
function _m13_newest(list, col) { return orderBy(list, [(r) => t(r[col]), 'desc']); }

/* --------------------------------------------------------------------------------------------------- read models */

function fn_patient_json(p_patient_id) {
  const p = dbGet('patients', p_patient_id);
  if (!p) return null;
  const team = [];
  for (const ct of dbWhere('care_team', (c) => c.patient_id === p.id && c.active === true)) {
    const u = dbGet('users', ct.user_id);
    if (!u) continue;
    const o = dbGet('organizations', ct.organization_id);
    team.push({ user_id: u.id, full_name: u.full_name, role: ct.role, organization: o ? o.name : null });
  }
  return {
    id: p.id, mrn: p.mrn, full_name: p.full_name, full_name_ar: p.full_name_ar,
    date_of_birth: p.date_of_birth, age: fn_age(p.date_of_birth), sex: p.sex, phone: p.phone,
    governorate: p.governorate, city: p.city, preferred_language: p.preferred_language,
    diabetes_type: p.diabetes_type, diagnosis_year: p.diagnosis_year, height_cm: p.height_cm,
    pregnant: p.pregnant, uses_insulin_pump: p.closed_loop_pump,
    tier: fn_tier(p.id), exclusions: fn_exclusions(p.id),
    care_team: team,
  };
}

/** app.fn_medication_json(m app.medications): takes a medications row. */
function fn_medication_json(m) {
  return {
    id: m.id, name: m.name, generic: m.generic, drug_class: m.drug_class,
    dose_text: m.dose_text, frequency: m.frequency, times: m.times === null ? null : [...m.times], status: m.status,
    start_date: m.start_date, verification_status: m.verification_status, source: m.source,
    adherence_7d: fn_adherence(m.patient_id, 7, m.id),
    supply: fn_med_supply(m),
  };
}

// Critical limits and changes from safety_rules.critical_labs: a value at a limit, or a large fall (eGFR) or rise
// (creatinine) from the previous result within compare_days. Returns {critical, reasons, previous}.
// app.fn_lab_critical(l app.lab_results): takes a lab_results row.
function fn_lab_critical(l) {
  const cfg = fn_rule('critical_labs');
  const limits = cfg !== null && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg.limits : undefined;
  const lim = limits !== null && typeof limits === 'object' && !Array.isArray(limits) && l.test_code !== null
    && Object.prototype.hasOwnProperty.call(limits, l.test_code) ? limits[l.test_code] : undefined;
  if (lim === undefined || l.id === null || l.id === undefined) return { critical: false };
  const num = (k) => castNum(jtext(lim[k]));
  const reasons = [];
  if (_m13_has(lim, 'high') && _m13_gte(l.value, num('high'))) reasons.push('at_or_above_critical_limit');
  if (_m13_has(lim, 'low') && l.value !== null && num('low') !== null && l.value < num('low')) reasons.push('below_critical_limit');
  let prev = null;
  if (_m13_has(lim, 'drop_fraction') || _m13_has(lim, 'rise_factor')) {
    const at = t(l.observed_at);
    const from = _m11_addDaysTs(at, -coalesce(castInt(jtext(cfg.compare_days)), 365));
    const best = _m13_newest(dbWhere('lab_results', (p) => p.patient_id === l.patient_id && p.test_code === l.test_code && p.id !== l.id
      && p.verification_status !== null && p.verification_status !== 'refuted'
      && at !== null && t(p.observed_at) < at && t(p.observed_at) > from), 'observed_at')[0];
    prev = best ? best.value : null;
    if (prev !== null && prev > 0 && _m13_has(lim, 'drop_fraction') && l.value !== null
        && _m13_gte((prev - l.value) / prev, num('drop_fraction'))) {
      reasons.push('large_fall_from_previous');
    }
    if (prev !== null && prev > 0 && _m13_has(lim, 'rise_factor') && num('rise_factor') !== null
        && _m13_gte(l.value, prev * num('rise_factor'))) {
      reasons.push('large_rise_from_previous');
    }
  }
  return { critical: reasons.length > 0, reasons, previous: prev };
}

/** app.fn_lab_json(l app.lab_results): takes a lab_results row; null when the test is not in the lab catalog. */
function fn_lab_json(l) {
  const lc = dbGet('lab_catalog', l.test_code);
  if (!lc) return null;
  const v = l.value;
  return {
    id: l.id, test_code: l.test_code, display: lc.display, value: v, unit: l.unit,
    ref_low: lc.ref_low, ref_high: lc.ref_high,
    flag: lc.ref_low !== null && v !== null && v < lc.ref_low ? 'low'
      : lc.ref_high !== null && v !== null && v > lc.ref_high ? 'high' : 'normal',
    observed_at: l.observed_at, verification_status: l.verification_status, source: l.source,
    age_days: l.observed_at === null ? null : daysBetween(today(), localDate(l.observed_at)), display_ar: lc.display_ar,
    critical: coalesce(fn_lab_critical(l).critical, false),
  };
}

function fn_health_summary(p_patient_id) {
  const P = p_patient_id;
  return {
    conditions: _m13_newest(dbWhere('conditions', (c) => c.patient_id === P), 'created_at')
      .map((c) => omit({ ...c }, 'patient_id', 'verified_by', 'verified_at')),
    allergies: _m13_newest(dbWhere('allergies', (a) => a.patient_id === P), 'created_at')
      .map((a) => omit({ ...a }, 'patient_id', 'verified_by', 'verified_at')),
    medications: dbWhere('medications', (m) => m.patient_id === P)
      .sort((a, b) => _m13_cmp(a.status, b.status) || _m13_cmp(a.name, b.name))
      .map(fn_medication_json),
    labs: _m13_newest(dbWhere('lab_results', (l) => l.patient_id === P), 'observed_at').map(fn_lab_json),
    vitals: _m13_newest(dbWhere('vitals', (v) => v.patient_id === P), 'measured_at').slice(0, 60)
      .map((v) => omit({ ...v }, 'patient_id', 'created_at')),
    safety_findings: _m13_newest(dbWhere('safety_findings', (f) => f.patient_id === P && f.status !== null && f.status !== 'resolved'), 'created_at')
      .map((f) => omit({ ...f }, 'patient_id', 'acknowledged_by', 'rule_ref')),
    egfr: fn_egfr(P),
  };
}

// Newest first by time (the SQL orders the final list by the text of 'at', which is the same order).
function fn_timeline(p_patient_id, p_limit = 50) {
  const P = p_patient_id;
  const x = (at, kind, title, detail, ref_id) => ({ at, kind, title, detail, ref_id });
  const items = [
    ...dbWhere('conditions', (r) => r.patient_id === P).map((r) => x(r.created_at, 'condition', r.display, r.verification_status, r.id)),
    ...dbWhere('medications', (r) => r.patient_id === P).map((r) => x(r.created_at, 'medication',
      r.name === null ? null : r.name + (r.dose_text === null ? '' : ` ${r.dose_text}`), r.status, r.id)),
    ...dbWhere('lab_results', (r) => r.patient_id === P).map((r) => x(r.observed_at, 'lab', _m13_cat(r.test_code, ': ', r.value, ' ', r.unit), r.verification_status, r.id)),
    ...dbWhere('glucose_events', (r) => r.patient_id === P).map((r) => x(r.occurred_at, 'glucose_event', _m13_cat(r.type, ' (', r.value_mgdl, ' mg/dL)'), null, r.id)),
    ...dbWhere('care_plans', (r) => r.patient_id === P && r.status !== null && r.status !== 'DRAFT')
      .map((r) => x(coalesce(r.published_at, r.created_at), 'care_plan', _m13_cat(r.title, ' v', r.version), r.status, r.id)),
    ...dbWhere('appointments', (r) => r.patient_id === P).map((r) => x(r.starts_at, 'appointment', r.type, r.status, r.id)),
    ...dbWhere('episodes', (r) => r.patient_id === P).map((r) => x(r.started_at, 'episode', r.chief_complaint, r.status, r.id)),
    ...dbWhere('safety_findings', (r) => r.patient_id === P).map((r) => x(r.created_at, 'safety_finding', r.title, r.severity, r.id)),
    ...dbWhere('referrals', (r) => r.patient_id === P).map((r) => x(r.created_at, 'referral', _m13_cat('Referral: ', r.to_specialty), r.status, r.id)),
  ];
  if (p_limit !== null && p_limit !== undefined && p_limit < 0) throw new Error('LIMIT must not be negative');
  const sorted = _m13_newest(items, 'at');
  return p_limit === null || p_limit === undefined ? sorted : sorted.slice(0, p_limit);
}

function fn_plan_json(p_plan_id) {
  const cp = dbGet('care_plans', p_plan_id);
  if (!cp) return null;
  const author = dbGet('users', cp.authored_by);
  return {
    id: cp.id, patient_id: cp.patient_id, version: cp.version, status: cp.status,
    title: cp.title, summary: cp.summary, summary_ar: cp.summary_ar, targets: cp.targets,
    items: orderBy(dbWhere('care_plan_items', (i) => i.plan_id === cp.id), (i) => i.position)
      .map((i) => ({ id: i.id, kind: i.kind, title: i.title, title_ar: i.title_ar, detail: i.detail, schedule: i.schedule })),
    authored_by: author ? author.full_name : null, published_at: cp.published_at,
    what_changed: cp.what_changed,
  };
}

// A care plan as a model may see it: no record ids, no patient id, no author name, no publication time.
function fn_plan_for_ai(p_plan_id) {
  const p = fn_plan_json(p_plan_id);
  if (p === null) return null;
  return { ...omit(p, 'id', 'patient_id', 'authored_by', 'published_at', 'what_changed'),
    items: (Array.isArray(p.items) ? p.items : []).map((i) => (i !== null && typeof i === 'object' && !Array.isArray(i) ? omit(i, 'id') : i)) };
}

/** app.fn_task_json(t app.care_tasks): takes a care_tasks row. */
function fn_task_json(t) {
  return { id: t.id, title: t.title, title_ar: t.title_ar, kind: t.kind, due_at: t.due_at, status: t.status };
}

/** app.fn_appointment_json(a app.appointments): takes an appointments row. */
function fn_appointment_json(a) {
  const p = dbGet('patients', a.patient_id), u = dbGet('users', a.provider_user_id), f = dbGet('facilities', a.facility_id);
  return {
    id: a.id, patient_id: a.patient_id,
    patient_name: p ? p.full_name : null,
    provider_name: u ? u.full_name : null,
    facility_name: f ? f.name : null,
    starts_at: a.starts_at, ends_at: a.ends_at, type: a.type, channel: a.channel, status: a.status, reason: a.reason,
    has_brief: dbExists('previsit_briefs', (b) => b.appointment_id === a.id),
  };
}

/** app.fn_referral_json(r app.referrals): takes a referrals row. */
function fn_referral_json(r) {
  const p = dbGet('patients', r.patient_id), f = dbGet('facilities', r.to_facility_id);
  return {
    id: r.id, patient_id: r.patient_id,
    patient_name: p ? p.full_name : null,
    to_specialty: r.to_specialty, to_facility_name: f ? f.name : null,
    urgency: r.urgency, reason: r.reason, status: r.status, report: r.report, created_at: r.created_at,
  };
}

// ai_written: true only when a model wrote the text and its run completed; rule-based fallback text is not labelled as AI.
// app.fn_insight_json(i app.patient_insights): takes a patient_insights row.
function fn_insight_json(i) {
  const run = dbGet('ai_runs', i.ai_run_id);
  return {
    id: i.id, kind: i.kind, title: i.title, title_ar: i.title_ar, body: i.body, body_ar: i.body_ar,
    citations: i.citations, created_at: i.created_at, read_at: i.read_at,
    ai_written: run && run.status !== null ? run.status === 'COMPLETED' : false,
  };
}

function fn_episode_json(p_episode_id) {
  const e = dbGet('episodes', p_episode_id);
  if (!e) return null;
  const a = _m13_newest(dbWhere('triage_assessments', (x) => x.episode_id === e.id), 'created_at')[0] || null;
  let assessment = null;
  if (a) {
    const fired = Array.isArray(a.rules_fired) ? a.rules_fired : [];
    const desc = jsonAgg(dbWhere('care_level_rules', (r) => fired.includes(r.code)).map((r) => r.description));
    assessment = {
      care_level: a.care_level, specialty: a.specialty, channel: a.channel,
      rules_fired: a.rules_fired === null ? null : [...a.rules_fired], red_flags: a.red_flags === null ? null : [...a.red_flags],
      explanation: a.explanation,
      rule_descriptions: desc ?? (fired.includes('PRESCREEN_EMERGENCY') ? ['Emergency keywords detected in the description'] : []),
    };
  }
  return {
    id: e.id, patient_id: e.patient_id, status: e.status, chief_complaint: e.chief_complaint,
    started_at: e.started_at, answers: e.answers,
    assessment,
    recommended_facilities: ['ASSESSED', 'ROUTED', 'ESCALATED', 'ACTION_SELECTED'].includes(e.status) ? fn_recommend_facilities(e.id) : [],
    followups: orderBy(dbWhere('episode_followups', (f) => f.episode_id === e.id), (f) => t(f.due_at))
      .map((f) => ({ id: f.id, due_at: f.due_at, status: f.status, response: f.response })),
  };
}

/** app.fn_inbox_json(i app.inbox_items): takes an inbox_items row. */
function fn_inbox_json(i) {
  const p = dbGet('patients', i.patient_id);
  return {
    id: i.id, patient_id: i.patient_id,
    patient_name: p ? p.full_name : null,
    category: i.category, urgency: i.urgency, priority: i.priority, title: i.title, body: i.body,
    payload: i.payload, status: i.status, created_at: i.created_at,
  };
}

function fn_today(p_patient_id) {
  const P = p_patient_id;
  const state = fn_patient_state(P);
  const glucose = fn_glucose_metrics(P, 14);
  const targets = fn_targets(P);
  const nowT = nowMs();
  const td = today();

  // Medication doses due today: one row per scheduled time, with logged status
  // A dose scheduled before the medicine was added (or before its start date) was never due, so it is not shown as missed.
  const meds = dbWhere('medications', (m) => m.patient_id === P && m.status === 'active'
    && m.verification_status !== null && m.verification_status !== 'refuted');
  const ids = new Set(meds.map((m) => m.id));
  const logs = new Map();
  for (const l of dbWhere('medication_logs', (x) => ids.has(x.medication_id))) {
    const k = `${l.medication_id}|${t(l.scheduled_at)}`;
    if (!logs.has(k)) logs.set(k, []);
    logs.get(k).push(l);
  }
  const due = [];
  for (const m of meds) {
    const starts = t(fn_med_effective_start(m));
    for (const tm of m.times || []) {
      if (tm === null || !_M11_HHMM.test(tm)) continue;
      const at = _m11_slot(td, tm);
      for (const l of logs.get(`${m.id}|${at}`) || [null]) {
        const st = l ? l.status : null;
        if (!(st !== null || (starts !== null && at >= starts))) continue;
        due.push({ tm, name: m.name, out: { medication_id: m.id, name: m.name, dose_text: m.dose_text, time: tm,
          status: coalesce(st, at < nowT - 2 * HOUR ? 'missed' : 'due') } });
      }
    }
  }
  due.sort((a, b) => _m13_cmp(a.tm, b.tm) || _m13_cmp(a.name, b.name));

  // One focus action, safety first
  let focus;
  if (state.safety_state === 'severe_hypoglycemia' || state.safety_state === 'recent_hypoglycemia') {
    focus = { kind: 'safety', title: 'Recent low glucose: review the hypoglycemia plan', title_ar: 'انخفاض سكر حديث: راجع خطة التعامل مع الهبوط', action: 'emergency_plan' };
  } else if (state.safety_state === 'open_safety_findings') {
    focus = { kind: 'safety', title: 'A medication safety item needs review', title_ar: 'يوجد تنبيه أمان دوائي يحتاج مراجعة', action: 'health' };
  } else if (glucose.data_quality === 'stale' || glucose.data_quality === 'none') {
    focus = { kind: 'data', title: 'Log a glucose reading today', title_ar: 'سجل قراءة سكر اليوم', action: 'log_glucose' };
  } else if (state.medication_state === 'non_adherent' || state.medication_state === 'partially_adherent') {
    focus = { kind: 'medication', title: "Take today's medicines on time", title_ar: 'خذ أدوية اليوم في مواعيدها', action: 'medications' };
  } else if (state.screening_state !== null && state.screening_state !== 'up_to_date') {
    focus = { kind: 'screening', title: 'Book your overdue screening', title_ar: 'احجز الفحص الدوري المتأخر', action: 'screenings' };
  } else {
    focus = { kind: 'lifestyle', title: 'A 20-minute walk after dinner', title_ar: 'مشي 20 دقيقة بعد العشاء', action: 'activity' };
  }

  // Safety alerts: glucose alerts of the past 24 hours, open major medication findings, critical labs of the week
  const thresholds = fn_rule('glucose_thresholds');
  const message = (type, lang, value) => {
    const msgs = thresholds !== null && typeof thresholds === 'object' && !Array.isArray(thresholds) ? thresholds.messages : null;
    const m = msgs !== null && typeof msgs === 'object' && !Array.isArray(msgs) && type !== null
      && Object.prototype.hasOwnProperty.call(msgs, type) ? msgs[type] : null;
    const text = m !== null && typeof m === 'object' && !Array.isArray(m) ? jtext(m[lang]) : null;
    return text === null || value === null ? null : text.split('{value}').join(String(value));
  };
  const alerts = [];
  const from24h = nowT - 24 * HOUR;
  for (const e of dbWhere('glucose_events', (x) => x.patient_id === P && t(x.occurred_at) > from24h)) {
    const low = e.type !== null && e.type.endsWith('hypo');
    alerts.push({ id: e.id, kind: low ? 'low_glucose' : 'high_glucose',
      title: _m13_cat(low ? 'Low glucose ' : 'High glucose ', e.value_mgdl, ' mg/dL'),
      title_ar: _m13_cat(low ? 'انخفاض السكر ' : 'ارتفاع السكر ', e.value_mgdl, ' مجم/دل'),
      body: message(e.type, 'en', e.value_mgdl),
      body_ar: message(e.type, 'ar', e.value_mgdl),
      severity: e.type !== null && e.type.startsWith('severe') ? 'critical' : 'high',
      created_at: e.occurred_at });
  }
  for (const f of dbWhere('safety_findings', (x) => x.patient_id === P && x.status === 'open' && (x.severity === 'major' || x.severity === 'contraindicated'))) {
    alerts.push({ id: f.id, kind: 'medication_safety', title: f.title, title_ar: _m13_cat('تنبيه أمان دوائي: ', f.title), body: f.detail,
      body_ar: coalesce(f.explanation_ar, 'راجع هذا التنبيه مع طبيبك أو الصيدلي قبل أي تغيير في أدويتك.'), severity: f.severity, created_at: f.created_at });
  }
  // Critical lab results of the past week (safety_rules.critical_labs) stay on Today until the week is over.
  const from7 = _m11_since(7);
  for (const l of dbWhere('lab_results', (x) => x.patient_id === P && t(x.created_at) > from7 && x.verification_status !== null && x.verification_status !== 'refuted')) {
    const lc = dbGet('lab_catalog', l.test_code);
    if (!lc || fn_lab_critical(l).critical !== true) continue;
    alerts.push({ id: l.id, kind: 'critical_lab',
      title: _m13_cat('Result needs a doctor today: ', lc.display, ' ', l.value, ' ', l.unit),
      title_ar: _m13_cat('نتيجة تحتاج إلى طبيب اليوم: ', coalesce(lc.display_ar, lc.display), ' ', l.value, ' ', l.unit),
      body: 'If you feel unwell, for example weakness, a racing heartbeat, breathlessness, vomiting or confusion, call 123 now.',
      body_ar: 'إذا شعرت بتعب مثل ضعف شديد أو خفقان أو ضيق في التنفس أو قيء أو تشوش فاتصل بـ 123 الآن.',
      severity: 'critical', created_at: l.created_at });
  }

  const from1d = _m11_since(1);
  const lastMeal = _m13_newest(dbWhere('meal_logs', (m) => m.patient_id === P && t(m.eaten_at) > from1d), 'eaten_at')[0];
  const until1d = _m11_addDaysTs(nowT, 1);
  const steps = sum(dbWhere('activity_logs', (a) => a.patient_id === P && a.date !== null && String(a.date).slice(0, 10) === td).map((a) => a.steps));

  return {
    patient: fn_patient_json(P),
    unread_messages: dbCount('team_messages', (m) => m.patient_id === P && m.read_by_patient_at === null
      && m.author_role !== null && m.author_role !== 'patient' && m.author_role !== 'caregiver'),
    state,
    focus,
    safety_alerts: _m13_newest(alerts, 'created_at'),
    last_meal_at: lastMeal ? lastMeal.eaten_at : null,
    glucose,
    medications_due: due.map((d) => d.out),
    refills_due: fn_refills_due(P),
    drive_check: fn_drive_eligible(P),
    sick_day: !!dbOne('sick_days', (s) => s.patient_id === P && s.ended_at === null),
    wellbeing_due: fn_wellbeing_status(P).due,
    tasks: orderBy(dbWhere('care_tasks', (x) => x.patient_id === P && x.status === 'pending' && (x.due_at === null || t(x.due_at) < until1d)),
      (x) => t(x.due_at)).map(fn_task_json),
    appointments: orderBy(dbWhere('appointments', (a) => a.patient_id === P && t(a.starts_at) > nowT - 2 * HOUR
      && ['requested', 'booked', 'checked_in'].includes(a.status)), (a) => t(a.starts_at)).map(fn_appointment_json),
    insights: _m13_newest(dbWhere('patient_insights', (i) => i.patient_id === P), 'created_at').slice(0, 3).map(fn_insight_json),
    screenings_overdue: fn_screenings(P).filter((x) => x.overdue === true),
    activity_today: {
      steps: coalesce(steps, 0),
      target: castInt(jtext(targets.steps_target)),
    },
  };
}

/* --------------------------------------------------------------------------------------------- patient state cache */

// Patient state cache (provider panel). Fresh for 30 minutes; cleared by a low or high reading; refreshed by the
// pattern scan.
function fn_cached_state(p_patient_id) {
  const c = dbGet('patient_state_cache', p_patient_id);
  let v = c && t(c.computed_at) > nowMs() - 30 * MIN ? c.state : null;
  if (v === null || v === undefined) {
    v = fn_patient_state(p_patient_id);
    dbInsert('patient_state_cache', { patient_id: p_patient_id, state: v, computed_at: now() },
      { onConflict: { cols: ['patient_id'], set: (existing, row) => ({ state: row.state, computed_at: row.computed_at }) } });
    return v;
  }
  return cloneValue(v);
}

// The patient state comes from the 30-minute cache (app.fn_cached_state), so the panel does not recompute patterns for
// every patient on every open.
function fn_panel(p_ctx, p_q) {
  // Reception staff book and confirm appointments: they get names and appointment times, never clinical values.
  const role = p_ctx !== null && typeof p_ctx === 'object' ? jtext(p_ctx.role) : null;
  const clinical = role === null ? null : ['doctor', 'nurse', 'clinic_admin'].includes(role);
  const re = p_q === null || p_q === undefined || p_q === '' ? null : _m13_likeRe(`%${p_q}%`);
  const nowT = nowMs();
  const out = [];
  for (const p of dbRows('patients')) {
    if (!fn_can_access_patient(p_ctx, p.id)) continue;
    if (re !== null) {
      const hay = _m13_cat(p.full_name, ' ', coalesce(p.full_name_ar, ''), ' ', p.mrn);
      if (hay === null || !re.test(hay)) continue;
    }
    const m = clinical ? fn_glucose_metrics(p.id, 14) : null;
    const next = minOf(dbWhere('appointments', (a) => a.patient_id === p.id && t(a.starts_at) > nowT
      && (a.status === 'booked' || a.status === 'requested')).map((a) => t(a.starts_at)));
    out.push({
      id: p.id, full_name: p.full_name, full_name_ar: p.full_name_ar,
      age: fn_age(p.date_of_birth), sex: p.sex,
      glycemic_state: clinical ? jtext(fn_cached_state(p.id).glycemic_state) : null,
      tir_14d: m ? m.tir : null, mean_14d: m ? m.mean : null,
      last_reading_at: m && m.latest ? jtext(m.latest.measured_at) : null,
      open_items: clinical ? dbCount('inbox_items', (i) => i.patient_id === p.id && i.status !== null && i.status !== 'RESOLVED') : 0,
      next_appointment: next === null ? null : iso(next),
      exclusions: clinical ? fn_exclusions(p.id) : [],
      restricted: clinical === null ? null : !clinical,
    });
  }
  return out.sort((a, b) => (b.open_items - a.open_items) || _m13_cmp(a.full_name, b.full_name));
}

function fn_workspace(p_patient_id) {
  const P = p_patient_id;
  const plan = dbOne('care_plans', (c) => c.patient_id === P && c.status === 'ACTIVE');
  const draft = dbOne('care_plans', (c) => c.patient_id === P && c.status === 'DRAFT');
  const brief = _m13_newest(dbWhere('previsit_briefs', (b) => b.patient_id === P), 'created_at')[0];
  return {
    patient: fn_patient_json(P),
    state: fn_patient_state(P),
    metrics_14d: fn_glucose_metrics(P, 14),
    metrics_90d: fn_glucose_metrics(P, 90),
    patterns: fn_detect_patterns(P, 14),
    health: fn_health_summary(P),
    plan: plan ? fn_plan_json(plan.id) : null,
    plan_draft: draft ? fn_plan_json(draft.id) : null,
    episodes: _m13_newest(dbWhere('episodes', (e) => e.patient_id === P), 'started_at').map((e) => fn_episode_json(e.id)),
    referrals: _m13_newest(dbWhere('referrals', (r) => r.patient_id === P), 'created_at').map(fn_referral_json),
    appointments: _m13_newest(dbWhere('appointments', (a) => a.patient_id === P), 'starts_at').map(fn_appointment_json),
    brief: brief ? { id: brief.id, appointment_id: brief.appointment_id, created_at: brief.created_at, content: brief.content,
      sources: brief.sources, model: brief.model } : null,
    insights: _m13_newest(dbWhere('patient_insights', (i) => i.patient_id === P), 'created_at').slice(0, 10).map(fn_insight_json),
    screenings: fn_screenings(P),
  };
}

// Publishing a care plan: supersede the previous version, generate tasks, emit CarePlanPublished.
function fn_publish_plan(p_ctx, p_plan_id) {
  const cp = dbGet('care_plans', p_plan_id);
  if (!cp || (cp.status !== null && cp.status !== 'DRAFT')) {
    fn_raise('bad_request: only a DRAFT plan can be published');
  }
  const access = fn_can_access_patient(p_ctx, cp.patient_id);
  const role = p_ctx !== null && typeof p_ctx === 'object' ? jtext(p_ctx.role) : null;
  if ((!access && access !== null) || (role !== null && role !== 'doctor')) {
    fn_raise('forbidden: only the treating doctor can publish a care plan');
  }
  const prev = dbOne('care_plans', (c) => c.patient_id === cp.patient_id && c.status === 'ACTIVE');
  const prevId = prev ? prev.id : null;
  if (prev) dbUpdate('care_plans', prev, { status: 'SUPERSEDED' });
  if (prevId !== null) dbUpdateWhere('care_tasks', (x) => x.plan_id === prevId && x.status === 'pending', { status: 'skipped' });
  const maxVersion = maxOf(dbWhere('care_plans', (c) => c.patient_id === cp.patient_id && c.status !== null && c.status !== 'DRAFT').map((c) => c.version));
  dbUpdate('care_plans', cp, { status: 'ACTIVE', published_at: now(), previous_id: prevId,
    version: coalesce(maxVersion, 0) + 1, authored_by: castUuid(jtext(p_ctx.user_id)) });
  // Tasks for the next 7 days from item schedules (times_per_day) or a single pending task
  const td = today();
  for (const it of dbWhere('care_plan_items', (i) => i.plan_id === cp.id)) {
    const task = (due_at) => dbInsert('care_tasks', { patient_id: cp.patient_id, plan_id: cp.id, plan_item_id: it.id,
      title: it.title, title_ar: it.title_ar, kind: it.kind, due_at });
    if ((it.kind === 'monitoring' || it.kind === 'lifestyle') && _m13_has(it.schedule, 'times_per_day')) {
      for (let d = 0; d <= 6; d++) task(iso(_m11_slot(addDays(td, d), '20:00')));
    } else if (it.kind === 'screening' || it.kind === 'education' || it.kind === 'appointment') {
      task(iso(_m11_addDaysTs(nowMs(), 7)));
    }
  }
  fn_emit('CarePlanPublished', cp.patient_id, String(cp.id), { previous_id: prevId });
  fn_audit(p_ctx, 'careplan.publish', 'care_plan', String(cp.id), cp.patient_id);
  fn_notify_patient(cp.patient_id, 'care_plan', 'Your care plan was updated', 'Open Care to see what changed.', `plan:${cp.id}`,
    'تم تحديث خطة الرعاية', 'افتح صفحة الرعاية لمعرفة ما الذي تغير.');
  return fn_plan_json(cp.id);
}
