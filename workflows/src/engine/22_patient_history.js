/* ------------------------------------------------------------------------------------------------------------
   Patient-history retrieval (RAG over the person's own record) and the dashboard summary, for the Companion's tools
   search_patient_history and get_dashboard_summary.
   A tool result reaches the model without the input gate, so it is de-identified here: no names or ids of people, no
   absolute dates (days_ago instead), and the only free text is the person's own short notes, with their identifiers
   replaced. Clinicians' free text (encounter notes, team messages) is not included. Each item has a ref the answer can
   cite (meal:<id>, lab:<id>, medication:<id>, ...), so a statement about the person's history is checkable.
------------------------------------------------------------------------------------------------------------ */

function _m22_ago(ts) { return ts === null || ts === undefined ? null : round((nowMs() - t(ts)) / DAY, 1); }
function _m22_hour(ts) { try { return cairoParts(ts).h; } catch (e) { return null; } }
// The person's own note with their and their family's identifiers replaced, emails, phones and ids removed, and cut short.
function _m22_redactor(pid) {
  const ids = (fn_ai_gate(pid, 'history').identifiers || []).filter((x) => String(x.value || '').length >= 3)
    .sort((a, b) => String(b.value).length - String(a.value).length);
  return (s) => {
    if (s === null || s === undefined || String(s).trim() === '') return null;
    let out = String(s);
    for (const x of ids) out = out.split(String(x.value)).join('[' + x.type + ']');
    out = regexpReplace(fn_redact_error(out), '\\+?[0-9][0-9 ]{7,}[0-9]', '[phone]', 'g');
    return left(out, 160);
  };
}

/**
 * Searches the person's record for what the question is about: meals (with the glucose rise after them), low and high
 * glucose days, lab results over time, medicines including stopped ones, activity, sleep, check-ins, vitals, visits,
 * care-plan versions and care-access episodes, over the last 180 days. Arabic and English questions are matched through
 * the same query preparation (stemming, glossary expansion) as the knowledge base. Best matches first, then the newest.
 */
function fn_patient_history_search(p_patient_id, p_query, p_k) {
  const pid = castUuid(p_patient_id);
  const k = Math.max(1, Math.min(castInt(p_k) ?? 8, 15));
  const prep = fn_rag_prepare_query(String(p_query ?? '').slice(0, 300), null);
  const terms = new Set(prep.fts_terms);
  const red = _m22_redactor(pid);
  const since = nowMs() - 180 * DAY;
  const items = [];
  const add = (ref, kind, at, summary, words, extra) => items.push({ ref, kind, days_ago: _m22_ago(at), summary, ...(extra || {}), _text: [kind, ...words].filter(Boolean).join(' ') });

  const rise = new Map((fn_meal_responses(pid, 30) || []).map((r) => [r.meal_id, r]));
  for (const m of dbWhere('meal_logs', (x) => x.patient_id === pid && t(x.eaten_at) > since)) {
    const foods = (Array.isArray(m.items) ? m.items : []).map((i) => dbGet('foods', castUuid(i && i.food_id))).filter(Boolean);
    const r = rise.get(m.id);
    add('meal:' + m.id, 'meal', m.eaten_at, `${m.meal_type || 'meal'}: ${foods.map((f) => f.name).join(', ') || 'no foods listed'}`
      + (m.est_carbs_g !== null ? `; about ${m.est_carbs_g} g carbohydrate` : '') + (r && r.rise !== null ? `; glucose rose ${r.rise} mg/dL after it` : ''),
      ['food', 'eat', 'eating', m.meal_type, ...foods.map((f) => f.name), ...foods.map((f) => f.name_ar), m.meal_type === 'breakfast' ? 'فطار' : null, r && r.rise >= 60 ? 'high rise after meal' : null, m.notes],
      { local_hour: _m22_hour(m.eaten_at), note: red(m.notes), _rise: r && r.rise !== null ? r.rise : null });
  }
  // Glucose: one item per day with a low (< 70) or very high (> 250) reading, not every reading.
  const days = new Map();
  for (const g of dbWhere('glucose_readings', (x) => x.patient_id === pid && t(x.measured_at) > since)) {
    const d = localDate(g.measured_at);
    const v = castNum(g.value_mgdl);
    const e = days.get(d) || { min: null, max: null, at: g.measured_at, contexts: new Set() };
    if (e.min === null || v < e.min) { e.min = v; e.at = g.measured_at; }
    if (e.max === null || v > e.max) e.max = v;
    if (g.context) e.contexts.add(g.context);
    days.set(d, e);
  }
  for (const [d, e] of days) {
    if (e.min !== null && e.min < 70) add('glucose_day:' + d, 'low_glucose', e.at, `lowest reading ${e.min} mg/dL that day`, ['low', 'hypoglycemia', 'هبوط', 'reading', ...e.contexts]);
    if (e.max !== null && e.max > 250) add('glucose_day:' + d, 'high_glucose', e.at, `highest reading ${e.max} mg/dL that day`, ['high', 'hyperglycemia', 'ارتفاع', 'reading', ...e.contexts]);
  }
  for (const l of dbWhere('lab_results', (x) => x.patient_id === pid && x.verification_status !== 'refuted')) {
    const lc = dbGet('lab_catalog', l.test_code);
    add('lab:' + l.id, 'lab', l.observed_at, `${lc ? lc.display : l.test_code} ${l.value} ${l.unit || ''}`.trim(), ['lab', 'test', 'تحليل', l.test_code, lc ? lc.display : null], { verification: l.verification_status });
  }
  for (const m of dbWhere('medications', (x) => x.patient_id === pid && x.verification_status !== 'refuted')) {
    const d = m.generic ? dbGet('drugs', m.generic) : null;
    add('medication:' + m.id, 'medicine', coalesce(m.end_date, m.start_date, m.created_at), `${m.name} (${m.generic || 'unknown generic'}), ${m.status}`
      + (m.start_date ? `, started ${_m22_ago(m.start_date)} days ago` : '') + (m.end_date ? `, stopped ${_m22_ago(m.end_date)} days ago` : ''),
      ['medicine', 'medication', 'دوا', m.name, m.generic, m.drug_class, m.status === 'stopped' ? 'stopped' : null, ...(d ? [d.display_ar, ...(d.brand_names_ar || [])] : [])]);
  }
  for (const a of dbWhere('activity_logs', (x) => x.patient_id === pid && x.date > addDays(today(), -30))) {
    add('activity:' + a.id, 'activity', a.date, `${a.steps ?? 0} steps` + (a.minutes ? `, ${a.minutes} min ${a.type || ''}` : ''), ['activity', 'walk', 'walking', 'steps', 'exercise', 'مشي', a.type]);
  }
  for (const s of dbWhere('sleep_logs', (x) => x.patient_id === pid && x.date > addDays(today(), -30))) {
    add('sleep:' + s.id, 'sleep', s.date, `${s.hours} h sleep` + (s.quality ? `, quality ${s.quality}` : ''), ['sleep', 'نوم', s.quality]);
  }
  for (const c of dbWhere('checkins', (x) => x.patient_id === pid && t(x.at) > since)) {
    add('checkin:' + c.id, 'checkin', c.at, `mood ${c.mood ?? '-'}/5, stress ${c.stress ?? '-'}/5, energy ${c.energy ?? '-'}/5`, ['mood', 'stress', 'energy', 'feel', 'مزاج', 'توتر', c.note], { note: red(c.note) });
  }
  for (const v of dbWhere('vitals', (x) => x.patient_id === pid && t(x.measured_at) > since)) {
    add('vital:' + v.id, v.type, v.measured_at, v.type === 'blood_pressure' ? `blood pressure ${v.systolic}/${v.diastolic} mmHg` : `${v.type} ${v.value} ${v.unit || ''}`.trim(),
      [v.type === 'blood_pressure' ? 'blood pressure ضغط' : v.type === 'weight' ? 'weight وزن' : v.type]);
  }
  for (const ap of dbWhere('appointments', (x) => x.patient_id === pid && t(x.starts_at) > since)) {
    const future = t(ap.starts_at) > nowMs();
    add('appointment:' + ap.id, 'appointment', ap.starts_at, `${ap.type || 'appointment'} (${ap.channel || 'visit'}), ${ap.status}` + (future ? `, in ${round((t(ap.starts_at) - nowMs()) / DAY, 1)} days` : ''),
      ['appointment', 'visit', 'doctor', 'clinic', 'موعد', 'دكتور', ap.type, ap.channel]);
  }
  for (const e of dbWhere('encounters', (x) => x.patient_id === pid && t(x.occurred_at) > since)) {
    add('encounter:' + e.id, 'visit', e.occurred_at, 'a visit with the care team (notes are with the clinician)', ['visit', 'doctor', 'clinic', 'زياره', 'دكتور']);
  }
  for (const p of dbWhere('care_plans', (x) => x.patient_id === pid && x.published_at !== null)) {
    add('careplan:' + p.id, 'care_plan', p.published_at, `care plan version ${p.version} (${p.status})`, ['plan', 'care plan', 'خطه', 'changed', 'target']);
  }
  for (const e of dbWhere('episodes', (x) => x.patient_id === pid && t(x.started_at) > since)) {
    add('episode:' + e.id, 'care_request', e.started_at, `Need Care request, ${e.status}` + (e.selected_action ? `, ${e.selected_action}` : ''),
      ['symptom', 'problem', 'need care', 'تعبان', e.chief_complaint], { complaint: red(e.chief_complaint) });
  }

  const hitsIn = (txt) => { let n = 0; for (const w of new Set(fn_rag_search_text(txt).split(' '))) if (terms.has(w)) n++; return n; };
  const scored = items.map((x) => ({ ...x, _hits: terms.size ? hitsIn(x._text) : 0 })).filter((x) => x._hits > 0);
  // "Which meals raise my sugar (the most)?": meals by the size of the rise after them instead of the newest first.
  const byRise = ['rais', 'rise', 'rose', 'spike', 'most', 'worst', 'بيرفع', 'يرفع', 'رفع', 'اكتر', 'اكثر'].some((w) => [...terms].some((x) => x.startsWith(w)));
  const top = orderBy(scored, [(x) => x._hits, 'desc'], [(x) => (byRise ? -(x._rise ?? -1e9) : 0), 'asc'], [(x) => x.days_ago ?? 1e9, 'asc']).slice(0, k);
  return {
    query_terms: [...terms].slice(0, 20), searched_days: 180, matches: scored.length,
    results: top.map(({ _text, _hits, _rise, ...x }) => x),
    note: scored.length ? null : 'Nothing in the record matched; use the other tools or PATIENT_CONTEXT, or say the record has no data on it.',
  };
}

/** The person's dashboard (Today and Food & activity screens) as the model sees it: no dates, no free text. */
function fn_dashboard_summary(p_patient_id, p_days) {
  const pid = castUuid(p_patient_id);
  const days = Math.max(1, Math.min(castInt(p_days) ?? 7, 30));
  const life = fn_lifestyle_summary(pid, days) || {};
  const en = life.energy || {};
  const targets = fn_targets(pid);
  const g = fn_glucose_metrics(pid, days);
  const steps = life.steps_avg ?? null;
  return {
    days,
    glucose: g ? { mean: g.mean, tir: g.tir, tbr: (g.tbr_level1 ?? 0) + (g.tbr_level2 ?? 0), tar: (g.tar_level1 ?? 0) + (g.tar_level2 ?? 0), readings: g.readings, data_quality: g.data_quality,
      latest: g.latest ? { value_mgdl: g.latest.value_mgdl, age_minutes: g.latest.age_minutes } : null } : null,
    target_checks: fn_target_checks(pid, targets, fn_glucose_metrics(pid, 14), steps),
    energy: { eaten_today_kcal: en.eaten_today_kcal ?? null, meals_today: en.meals_today ?? null, burned_today_kcal: en.burned_today_kcal ?? null,
      eaten_avg_kcal: en.eaten_avg_kcal ?? null, days_with_meals: en.days_with_meals ?? null, estimated_needs_kcal: en.needs ? en.needs.kcal ?? null : null,
      needs_note: en.needs ? en.needs.note ?? null : null },
    activity: { steps_avg: steps, active_minutes_avg: life.active_minutes_avg ?? null, days_logged: (life.activity || []).length },
    sleep: { hours_avg: life.sleep_hours_avg ?? null },
    weight: { latest_kg: life.weight_latest ?? null, change_30d_kg: life.weight_change_30d ?? null },
    meals_logged: (life.meals || []).length,
  };
}
