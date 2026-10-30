// 011 · Deterministic clinical engine (database/migrations/011_fn_clinical_engine.sql): glucose metrics, AGP, daily
// summaries, meal responses, the pattern engine with minimum-data gates, adherence, renal function, screenings, the
// Patient State Engine and the Policy Engine. AI never computes any of these values.
//
// Glucose readings are grouped per patient once per request (_m11_readings): an index over the readings tab, sorted by
// measured_at and rebuilt only when rows are added or removed, so read models that loop over many patients (provider
// panel, pattern scan, state cache refresh) do not scan every reading once per patient per metric. Deleted rows are
// skipped when a patient's list is read, so a rollback of a delete brings the reading back.
//
// Time windows: "now() - interval 'N days'" moves the Cairo calendar date and keeps the wall-clock time, as Postgres
// does in the database time zone (Africa/Cairo), so a window across a daylight-saving change is 1 hour shorter or
// longer than N x 24 h; intervals in hours and minutes are exact durations.

const _M11_IDX = new WeakMap();             // readings row array -> { len, last, gone, by: Map(patient_id -> [{ r, ms, lp }]) }
const _M11_OFF = new Map();                 // UTC hour number -> Cairo offset (ms) during that hour
const _M11_CGM = ['device', 'nightscout'];
const _M11_HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/* ---------------------------------------------------------------------------------------------- private helpers */

/** Cairo UTC offset at a time (ms). Offsets only change at whole UTC hours, so one lookup per hour is cached. */
function _m11_offset(ms) {
  const h = Math.floor(ms / HOUR);
  let o = _M11_OFF.get(h);
  if (o === undefined) {
    const base = h * HOUR;
    const p = cairoParts(base);
    o = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - base;
    _M11_OFF.set(h, o);
  }
  return o;
}

/** A Cairo wall-clock time (given as if it were UTC ms) as a real time; a skipped or repeated hour resolves as Postgres does. */
function _m11_fromLocal(wall) {
  const off = _m11_offset(wall);
  let res = wall - off;
  const off2 = _m11_offset(res);
  if (off2 !== off) res = wall - off2;
  return res;
}

/** ts + n days in the Cairo calendar (timestamptz + make_interval(days => n)), in ms; null stays null. */
function _m11_addDaysTs(x, n) {
  const ms = t(x);
  if (ms === null || Number.isNaN(ms) || n === null || n === undefined) return null;
  return _m11_fromLocal(ms + _m11_offset(ms) + n * DAY);
}

/** now() - make_interval(days => n), in ms (NaN for a NULL n: no time compares as later, as with SQL NULL). */
function _m11_since(n) { return n === null || n === undefined ? NaN : _m11_addDaysTs(nowMs(), -n); }

/** (date + 'HH:MM'::time) at time zone 'Africa/Cairo', in ms. */
function _m11_slot(date, hhmm) {
  const [y, mo, d] = String(date).slice(0, 10).split('-').map(Number);
  return _m11_fromLocal(Date.UTC(y, mo - 1, d, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5))));
}

/** Cairo calendar date, hour and weekday (0 = Sunday) of a time in ms. */
function _m11_lp(ms) {
  const d = new Date(ms + _m11_offset(ms));
  return { date: d.toISOString().slice(0, 10), h: d.getUTCHours(), dow: d.getUTCDay() };
}

/** The local parts of an indexed reading, computed once per request. */
function _m11_elp(e) { return e.lp || (e.lp = _m11_lp(e.ms)); }

/**
 * The glucose readings of one patient, oldest first, as entries { r: row, ms: measured_at in ms }. The index is built
 * from the request's live readings on first use. It is checked in constant time against the runtime's row array
 * (tab(...).rows, which only grows by appends and shrinks when an insert is rolled back) and rebuilt when a row was
 * added or removed, or when a row that was deleted before the build came back through a rollback. Rows deleted after
 * the build are skipped when a patient's list is read.
 */
function _m11_readings(patientId) {
  const raw = tab('glucose_readings').rows;
  let ix = _M11_IDX.get(raw);
  if (!ix || ix.len !== raw.length || ix.last !== raw[raw.length - 1] || ix.gone.some((r) => META.get(r).state !== 'deleted')) {
    const live = dbRows('glucose_readings');
    const liveSet = live.length === raw.length ? null : new Set(live);
    const by = new Map();
    for (const r of live) {
      const k = String(r.patient_id);
      let list = by.get(k);
      if (!list) by.set(k, (list = []));
      list.push({ r, ms: t(r.measured_at), lp: null });
    }
    for (const list of by.values()) list.sort((a, b) => a.ms - b.ms);
    ix = { len: raw.length, last: raw[raw.length - 1], gone: liveSet ? raw.filter((r) => !liveSet.has(r)) : [], by };
    _M11_IDX.set(raw, ix);
  }
  if (patientId === null || patientId === undefined) return [];
  const list = ix.by.get(String(patientId));
  if (!list) return [];
  return list.filter((e) => META.get(e.r).state !== 'deleted');
}

/** First index of a sorted entry list whose time is >= ms. */
function _m11_lowerBound(list, ms) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].ms < ms) lo = mid + 1; else hi = mid; }
  return lo;
}

/** The jsonb || operator: objects merge (right wins), anything else concatenates as arrays. */
function _m11_jcat(a, b) {
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (isObj(a) && isObj(b)) return { ...a, ...b };
  return [...(Array.isArray(a) ? a : [a]), ...(Array.isArray(b) ? b : [b])];
}

/** numeric division that fails like Postgres on a zero divisor. */
function _m11_div(a, b) {
  if (a === null || b === null) return null;
  if (b === 0) throw new Error('division by zero');
  return a / b;
}

/* ------------------------------------------------------------------------------------------------------ basics */

/** app.fn_local(ts): Cairo wall-clock time without zone ('YYYY-MM-DDTHH:MM:SS', fractional seconds as Postgres prints them). */
function fn_local(ts) {
  const s = localTimestamp(ts);
  if (s === null) return null;
  const ms = ((t(ts) % 1000) + 1000) % 1000;
  return ms ? `${s}.${String(ms).padStart(3, '0').replace(/0+$/, '')}` : s;
}

function fn_rule(p_code) {
  const r = dbGet('safety_rules', p_code);
  return r && r.active === true ? (r.config ?? null) : null;
}

/** date_part('year', age(current_date, dob)): a date of birth in the future gives a negative age, as age() does. */
function fn_age(p_dob) {
  if (p_dob === null || p_dob === undefined) return null;
  const dob = String(p_dob).slice(0, 10);
  const td = today();
  return dob > td ? -ageYears(td, dob) : ageYears(dob, td);
}

// Active care-plan targets, else population defaults (marked as defaults).
function fn_targets(p_patient_id) {
  const plan = dbOne('care_plans', (c) => c.patient_id === p_patient_id && c.status === 'ACTIVE');
  return _m11_jcat(_m11_jcat(coalesce(fn_rule('default_targets'), {}), coalesce(plan ? plan.targets : null, {})),
    { personalized: !!plan });
}

/* ------------------------------------------------------------------- Glucose metrics (CGM consensus definitions) */

// GMI = 3.31 + 0.02392 * mean.
function fn_glucose_metrics(p_patient_id, p_days = 14) {
  const nowT = nowMs();
  const from = _m11_since(p_days);
  const upto = nowT + 5 * MIN;
  const vals = [], fasting = [], post = [];
  const buckets = new Set();
  let inRange = 0, tar1 = 0, tar2 = 0, tbr1 = 0, tbr2 = 0, cgmN = 0;
  let latest = null;
  // Readings dated in the future (clock errors, typos) are ignored everywhere.
  for (const e of _m11_readings(p_patient_id)) {
    if (!(e.ms <= upto)) continue;
    latest = e;                                   // the list is sorted: the last one kept is the latest
    if (!(e.ms > from)) continue;
    const v = e.r.value_mgdl;
    const cgm = _M11_CGM.includes(e.r.source);
    vals.push(v);
    if (v !== null) {
      if (v >= 70 && v <= 180) inRange++;
      if (v > 180 && v <= 250) tar1++;
      if (v > 250) tar2++;
      if (v >= 54 && v < 70) tbr1++;
      if (v < 54) tbr2++;
    }
    // 15-minute buckets (date_trunc('hour') + minute / 15): Cairo offsets are whole hours, so UTC buckets are the same
    // except in the hour that repeats when the clocks go back, which SQL folds into one hour.
    if (cgm) { cgmN++; buckets.add(Math.floor(e.ms / (15 * MIN))); }
    if (e.r.context === 'fasting' || (cgm && _m11_elp(e).h >= 6 && _m11_elp(e).h <= 7)) fasting.push(v);
    if (e.r.context === 'post_meal') post.push(v);
  }
  const n = vals.length;
  const mean = avg(vals), sd = stddev(vals);
  const cgm = n > 0 && cgmN / n > 0.5;
  const cov = cgm ? Math.min(1, buckets.size / (p_days * 96)) : null;
  const ageMin = latest === null ? null : Math.max(0, Math.floor((nowT - latest.ms) / MIN));
  let quality;
  if (n === 0) quality = 'none';
  else if (cgm && ageMin > 180) quality = 'stale';
  else if (!cgm && ageMin > 7 * 1440) quality = 'stale';
  else if (cgm && cov < 0.7) quality = 'sparse';
  else if (!cgm && n < Math.max(3, Math.trunc(p_days / 2))) quality = 'sparse';
  else quality = 'good';
  const pct = (k) => (n > 0 ? round((k * 100) / n, 1) : null);
  return {
    days: p_days,
    readings: n,
    cgm,
    coverage_pct: cgm ? round(cov * 100, 1) : null,
    mean: round(mean, 0),
    sd: round(sd, 0),
    cv: mean !== null && mean > 0 && sd !== null ? round((sd / mean) * 100, 1) : null,
    // GMI is defined for CGM data with at least 70% coverage; it is not reported for fingerstick-only data.
    gmi: cgm && cov >= 0.7 ? round(3.31 + 0.02392 * mean, 1) : null,
    tir: pct(inRange),
    tar_level1: pct(tar1),
    tar_level2: pct(tar2),
    tbr_level1: pct(tbr1),
    tbr_level2: pct(tbr2),
    fasting_mean: round(avg(fasting), 0),
    post_meal_mean: round(avg(post), 0),
    latest: latest === null ? null : {
      value_mgdl: latest.r.value_mgdl, measured_at: latest.r.measured_at, age_minutes: ageMin, source: latest.r.source },
    data_quality: quality,
  };
}

/** Hourly percentiles (Cairo hour of day) of the readings of the last p_days days, by hour. */
function fn_glucose_agp(p_patient_id, p_days = 14) {
  const from = _m11_since(p_days);
  const byHour = new Map();
  for (const e of _m11_readings(p_patient_id)) {
    if (!(e.ms > from)) continue;
    const h = _m11_elp(e).h;
    if (!byHour.has(h)) byHour.set(h, []);
    byHour.get(h).push(e.r.value_mgdl);
  }
  return [...byHour.keys()].sort((a, b) => a - b).map((hour) => {
    const v = byHour.get(hour);
    return {
      hour,
      p10: round(percentileCont(v, 0.10)), p25: round(percentileCont(v, 0.25)), p50: round(percentileCont(v, 0.50)),
      p75: round(percentileCont(v, 0.75)), p90: round(percentileCont(v, 0.90)),
      n: v.length,
    };
  });
}

/** Daily summaries (Cairo calendar days) of the last p_days days, by day. */
function fn_glucose_daily(p_patient_id, p_days = 14) {
  const from = _m11_since(p_days);
  const byDay = new Map();
  for (const e of _m11_readings(p_patient_id)) {
    if (!(e.ms > from)) continue;
    const d = _m11_elp(e).date;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(e.r.value_mgdl);
  }
  return [...byDay.keys()].sort().map((day) => {
    const v = byDay.get(day);
    const inRange = v.filter((x) => x !== null && x >= 70 && x <= 180).length;
    return { day, mean: round(avg(v)), tir: round((inRange * 100) / v.length, 1), min: minOf(v), max: maxOf(v), n: v.length };
  });
}

// Meal response: pre-meal reading (<=30 min before) and peak 30-150 min after.
function fn_meal_responses(p_patient_id, p_days = 14) {
  const from = _m11_since(p_days);
  const meals = dbWhere('meal_logs', (m) => m.patient_id === p_patient_id && t(m.eaten_at) > from);
  if (!meals.length) return [];
  const rs = _m11_readings(p_patient_id);
  return meals.map((m) => {
    const at = t(m.eaten_at);
    let pre = null;
    for (let i = _m11_lowerBound(rs, at - 30 * MIN); i < rs.length && rs[i].ms <= at + 5 * MIN; i++) pre = rs[i].r.value_mgdl;
    const peakVals = [];
    for (let i = _m11_lowerBound(rs, at + 30 * MIN); i < rs.length && rs[i].ms <= at + 150 * MIN; i++) peakVals.push(rs[i].r.value_mgdl);
    const peak = maxOf(peakVals);
    return {
      meal_id: m.id, eaten_at: m.eaten_at, est_carbs_g: m.est_carbs_g, pre, peak,
      rise: pre === null || peak === null ? null : peak - pre,
      sensor_ok: peakVals.length >= 4,
    };
  });
}

/* ------------------------------------------------- Pattern engine with minimum-data gates (observations only) */

function fn_detect_patterns(p_patient_id, p_days = 14) {
  const g = coalesce(fn_rule('pattern_gates'), {});
  const tg = fn_targets(p_patient_id);
  const gate = (k) => (g !== null && typeof g === 'object' && !Array.isArray(g) ? g[k] : undefined);
  const gInt = (k, d) => coalesce(castInt(jtext(gate(k))), d);
  const gNum = (k, d) => coalesce(castNum(jtext(gate(k))), d);
  const out = [];
  const fh = coalesce(castNum(jtext(tg.fasting_high)), 130);
  const ph = coalesce(castNum(jtext(tg.post_meal_high)), 180);
  const rs = _m11_readings(p_patient_id);
  const nowT = nowMs();
  const from = _m11_since(p_days);
  const win = rs.filter((e) => e.ms > from);

  // 1. Repeated fasting elevation (fasting-tagged or CGM 06:00-07:59): the first such reading of each local day
  const firstOfDay = new Map();
  for (const e of win) {
    const lp = _m11_elp(e);
    if (e.r.context === 'fasting' || (_M11_CGM.includes(e.r.source) && lp.h >= 6 && lp.h <= 7)) {
      if (!firstOfDay.has(lp.date)) firstOfDay.set(lp.date, e.r.value_mgdl);
    }
  }
  const fastN = firstOfDay.size;
  const fastHigh = [...firstOfDay.values()].filter((v) => v !== null && v > fh).length;
  if (fastN >= gInt('fasting_min_days', 5) && _m11_div(fastHigh, fastN) >= gNum('fasting_high_fraction', 0.6)) {
    out.push({ type: 'repeated_fasting_elevation', severity: 'attention',
      title: `Fasting glucose above ${fh} mg/dL on ${fastHigh} of ${fastN} days`,
      title_ar: `سكر الصيام أعلى من ${fh} مجم/دل في ${fastHigh} من ${fastN} يوم`,
      detail: { days_with_data: fastN, days_above: fastHigh, threshold: fh, personalized_target: castBool(jtext(tg.personalized)) },
      evidence_count: fastN });
  }

  // 2. Recurrent lows: an episode is a run of readings < 70 with no gap longer than 60 minutes
  let lowN = 0, lowSevere = 0, prevMs = null;
  for (const e of win) {
    if (!(e.ms <= nowT + 5 * MIN) || !(e.r.value_mgdl < 70)) continue;
    if (prevMs === null || e.ms - prevMs > 60 * MIN) lowN++;
    if (e.r.value_mgdl < 54) lowSevere++;
    prevMs = e.ms;
  }
  if (lowN >= gInt('lows_min_episodes', 3)) {
    out.push({ type: 'recurrent_lows', severity: lowSevere > 0 ? 'urgent' : 'attention',
      title: `${lowN} low-glucose episodes (<70 mg/dL) in ${p_days} days`,
      title_ar: `${lowN} نوبات انخفاض سكر (أقل من 70) خلال ${p_days} يوم`,
      detail: { episodes: lowN, readings_below_54: lowSevere },
      evidence_count: lowN });
  }

  // 3. Nocturnal lows (00:00-05:59 local) on distinct nights
  const nights = new Set();
  for (const e of win) if (e.r.value_mgdl !== null && e.r.value_mgdl < 70 && _m11_elp(e).h < 6) nights.add(_m11_elp(e).date);
  const lowNights = nights.size;
  if (lowNights >= gInt('nocturnal_min_nights', 2)) {
    out.push({ type: 'nocturnal_lows', severity: 'urgent',
      title: `Night-time lows on ${lowNights} nights`,
      title_ar: `انخفاض السكر أثناء الليل في ${lowNights} ليالٍ`,
      detail: { nights: lowNights }, evidence_count: lowNights });
  }

  // 4. Post-meal rise (CGM meal responses, or post-meal tagged manual readings)
  const responses = fn_meal_responses(p_patient_id, p_days);
  const analysed = responses.filter((r) => r.pre !== null && r.peak !== null);
  const riseMin = gNum('meal_rise_mgdl', 60);
  let mealN = analysed.length;
  let mealRise = analysed.filter((r) => r.rise !== null && r.rise >= riseMin).length;
  const mealAvg = round(avg(analysed.map((r) => r.rise)));
  if (mealN >= 3 && mealRise >= gInt('meal_min_events', 3)) {
    const top = orderBy(responses.filter((r) => r.rise !== null), [(r) => r.rise, 'desc']).slice(0, 3).map((r) => {
      const m = dbGet('meal_logs', r.meal_id);
      const items = m ? m.items : null;
      if (items !== null && items !== undefined && !Array.isArray(items)) {
        throw new Error(`cannot extract elements from ${typeof items === 'object' ? 'an object' : 'a scalar'}`);
      }
      const names = [];
      for (const i of items || []) {
        const f = dbGet('foods', castUuid(jtext(i === null || i === undefined ? null : i.food_id)));
        if (f && f.name !== null) names.push(f.name);
      }
      return { eaten_at: r.eaten_at, rise: r.rise, foods: names.length ? names.join(', ') : null };
    });
    out.push({ type: 'post_meal_rise', severity: 'attention',
      title: `Glucose rose 60+ mg/dL after ${mealRise} of ${mealN} logged meals`,
      title_ar: `ارتفع السكر 60+ بعد ${mealRise} من ${mealN} وجبة مسجلة`,
      detail: { meals_analyzed: mealN, meals_with_rise: mealRise, average_rise: mealAvg, top_meals: top },
      evidence_count: mealN });
  } else {
    const pm = win.filter((e) => e.r.context === 'post_meal');
    mealN = pm.length;
    mealRise = pm.filter((e) => e.r.value_mgdl !== null && e.r.value_mgdl > ph).length;
    if (mealN >= 5 && mealRise / mealN >= 0.5) {
      out.push({ type: 'post_meal_rise', severity: 'attention',
        title: `Post-meal glucose above ${ph} mg/dL in ${mealRise} of ${mealN} readings`,
        title_ar: `سكر بعد الأكل أعلى من ${ph} في ${mealRise} من ${mealN} قراءة`,
        detail: { readings: mealN, above: mealRise, threshold: ph },
        evidence_count: mealN });
    }
  }

  // 5. Early-morning rise (CGM): mean 06-08h minus mean 02-04h, per night
  const nightsByDay = new Map();
  for (const e of win) {
    if (!_M11_CGM.includes(e.r.source)) continue;
    const lp = _m11_elp(e);
    let d = nightsByDay.get(lp.date);
    if (!d) nightsByDay.set(lp.date, (d = { early: [], late: [] }));
    if (lp.h >= 2 && lp.h <= 3) d.early.push(e.r.value_mgdl);
    if (lp.h >= 6 && lp.h <= 7) d.late.push(e.r.value_mgdl);
  }
  const rises = [];
  for (const d of nightsByDay.values()) {
    if (d.early.length < 2 || d.late.length < 2) continue;
    const rise = avg(d.late) - avg(d.early);
    if (rise >= 30) rises.push(rise);
  }
  const dawnN = rises.length, dawnAvg = round(avg(rises));
  if (dawnN >= gInt('dawn_min_nights', 5)) {
    out.push({ type: 'early_morning_rise', severity: 'info',
      title: `Early-morning rise of about ${dawnAvg} mg/dL on ${dawnN} mornings`,
      title_ar: `ارتفاع في الصباح الباكر بحوالي ${dawnAvg} في ${dawnN} صباحًا`,
      detail: { mornings: dawnN, average_rise: dawnAvg }, evidence_count: dawnN });
  }

  // 6. Weekday vs weekend (Egypt weekend = Friday/Saturday)
  const fromWe = _m11_since(Math.max(p_days, 14));
  const we = [], wd = [], weDays = new Set();
  for (const e of rs) {
    if (!(e.ms > fromWe)) continue;
    const lp = _m11_elp(e);
    if (lp.dow === 5 || lp.dow === 6) { we.push(e.r.value_mgdl); weDays.add(lp.date); } else wd.push(e.r.value_mgdl);
  }
  const weMean = avg(we), wdMean = avg(wd);
  if (weDays.size >= 3 && weMean !== null && wdMean !== null && Math.abs(weMean - wdMean) >= gNum('weekend_diff_mgdl', 25)) {
    out.push({ type: 'weekday_weekend_difference', severity: 'info',
      title: `Weekend average ${round(weMean)} mg/dL vs weekdays ${round(wdMean)} mg/dL`,
      title_ar: `متوسط عطلة نهاية الأسبوع ${round(weMean)} مقابل ${round(wdMean)} في أيام العمل`,
      detail: { weekend_mean: round(weMean), weekday_mean: round(wdMean), weekend_days: weDays.size },
      evidence_count: weDays.size });
  }

  // 7. Deviation from personal baseline: last 7 days vs days 8-37
  const from7 = _m11_since(7), from37 = _m11_since(37);
  const recent = [], base = [];
  for (const e of rs) {
    if (e.ms > from7) recent.push(e.r.value_mgdl);
    if (e.ms >= from37 && e.ms <= from7) base.push(e.r.value_mgdl);
  }
  const recentMean = avg(recent), baseMean = avg(base);
  if (recent.length >= 7 && base.length >= 14
      && _m11_div(Math.abs(recentMean - baseMean), baseMean) >= gNum('baseline_change_fraction', 0.15)) {
    out.push({ type: 'baseline_deviation', severity: recentMean > baseMean ? 'attention' : 'info',
      title: `7-day average ${round(recentMean)} mg/dL vs your usual ${round(baseMean)} mg/dL`,
      title_ar: `متوسط آخر 7 أيام ${round(recentMean)} مقابل المعتاد ${round(baseMean)}`,
      detail: { recent_mean: round(recentMean), baseline_mean: round(baseMean), direction: recentMean > baseMean ? 'higher' : 'lower' },
      evidence_count: recent.length });
  }

  return out;
}

/* ------------------------------------------------------------------------- Adherence, renal function, screening */

// A medicine's schedule counts from its start date, or from the moment it was added when it starts the same day.
function fn_med_effective_start(m) {
  if (m.start_date === null || m.start_date === undefined) return iso(m.created_at);
  const created = localDate(m.created_at);
  if (created !== null && String(m.start_date).slice(0, 10) >= created) return iso(m.created_at);
  return dayStart(m.start_date);
}

// Adherence = scheduled doses logged as taken / scheduled doses that were due, for active medicines only.
function fn_adherence(p_patient_id, p_days = 7, p_medication_id = null) {
  const meds = dbWhere('medications', (m) => m.patient_id === p_patient_id && m.status === 'active'
    && m.verification_status !== null && m.verification_status !== 'refuted'
    && (p_medication_id === null || p_medication_id === undefined || m.id === p_medication_id));
  if (!meds.length) return null;
  const nowT = nowMs();
  const td = today();
  const due = [];
  for (const m of meds) {
    const starts = t(fn_med_effective_start(m));
    for (const tm of m.times || []) {
      if (tm === null || !_M11_HHMM.test(tm)) continue;
      for (let k = p_days - 1; k >= 0; k--) {
        const slot = _m11_slot(addDays(td, -k), tm);
        if (slot <= nowT && starts !== null && slot >= starts) due.push(`${m.id}|${slot}`);
      }
    }
  }
  if (!due.length) return null;
  const ids = new Set(meds.map((m) => m.id));
  const taken = new Set(dbWhere('medication_logs', (l) => l.status === 'taken' && ids.has(l.medication_id))
    .map((l) => `${l.medication_id}|${t(l.scheduled_at)}`));
  const k = due.filter((s) => taken.has(s)).length;
  return round((k * 100) / due.length, 0);
}

// CKD-EPI 2021 (race-free) from the latest serum creatinine (mg/dL)
function fn_egfr(p_patient_id) {
  const latest = (code) => orderBy(dbWhere('lab_results', (l) => l.patient_id === p_patient_id && l.test_code === code
    && l.verification_status !== null && l.verification_status !== 'refuted' && l.value !== null && l.value > 0),
    [(l) => t(l.observed_at), 'desc'])[0] || null;
  const scr = latest('creatinine'), dir = latest('egfr');
  let egfr = null, at = null, src = null;
  if (scr && (!dir || (scr.observed_at !== null && dir.observed_at !== null && t(scr.observed_at) >= t(dir.observed_at)))) {
    const p = dbGet('patients', p_patient_id);
    const sex = p ? p.sex : null;
    const age = p ? fn_age(p.date_of_birth) : null;
    const k = sex === 'female' ? 0.7 : 0.9;
    const a = sex === 'female' ? -0.241 : -0.302;
    egfr = age === null ? null
      : 142 * Math.pow(Math.min(scr.value / k, 1), a) * Math.pow(Math.max(scr.value / k, 1), -1.200)
        * Math.pow(0.9938, age) * (sex === 'female' ? 1.012 : 1);
    at = scr.observed_at; src = 'creatinine';
  } else if (dir) {
    egfr = dir.value; at = dir.observed_at; src = 'reported';
  }
  return {
    value: round(egfr),
    value_exact: round(egfr, 2),   // rules compare the unrounded value
    observed_at: at,
    source: src,
    stage: egfr === null ? null : egfr >= 90 ? 'G1' : egfr >= 60 ? 'G2' : egfr >= 45 ? 'G3a' : egfr >= 30 ? 'G3b' : egfr >= 15 ? 'G4' : 'G5',
  };
}

/** date + make_interval(months => n), as a date: the day is clamped to the end of a shorter month. */
function _m11_addMonths(date, n) {
  const [y, m, d] = String(date).slice(0, 10).split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12), nm = total - ny * 12 + 1;
  const dim = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(Math.min(d, dim)).padStart(2, '0')}`;
}

function fn_screenings(p_patient_id) {
  // A screening counts as done when it was recorded directly or when the matching lab result exists.
  const td = today();
  const labs = dbWhere('lab_results', (l) => l.patient_id === p_patient_id && l.verification_status !== null && l.verification_status !== 'refuted');
  const items = dbWhere('screening_items', (s) => s.patient_id === p_patient_id);
  const rows = dbRows('screening_types').map((st) => {
    const si = items.find((s) => s.type === st.type) || null;
    let code = null;
    switch (st.type) { case 'hba1c': code = 'hba1c'; break; case 'uacr': code = 'uacr'; break; case 'lipids': code = 'ldl'; break; default: code = null; }
    const labMax = code === null ? null : maxOf(labs.filter((l) => l.test_code === code).map((l) => t(l.observed_at)));
    const last = maxOf([si ? si.last_done : null, labMax === null ? null : localDate(labMax)]);
    const due = last === null || st.interval_months === null ? null : _m11_addMonths(last, st.interval_months);
    const next = due === null ? td : due;
    return { type: st.type, title: st.title, title_ar: st.title_ar, last_done: last, next_due: next, overdue: next <= td };
  });
  return orderBy(rows, (r) => r.next_due);
}

/* ------------------------------------------------------- Patient State Engine (single canonical interpretation) */

/** Excluded populations; null when the patient does not exist (the SQL query returns no row). */
function fn_exclusions(p_patient_id) {
  const p = dbGet('patients', p_patient_id);
  if (!p) return null;
  const c = dbWhere('conditions', (x) => x.patient_id === p_patient_id && x.status === 'active'
    && x.verification_status !== null && x.verification_status !== 'refuted')
    .map((x) => ({ code: x.code === null ? '' : String(x.code), display: x.display === null ? null : String(x.display).toLowerCase() }));
  const has = (s, sub) => s !== null && s.includes(sub);
  const out = [];
  if (p.pregnant === true || c.some((x) => /^(Z33|Z34|O[0-9])/.test(x.code) || has(x.display, 'pregnan') || has(x.display, 'gestational')
      || has(x.display, 'حامل') || has(x.display, 'حمل'))) out.push('pregnancy');
  if (p.closed_loop_pump === true || c.some((x) => x.code.startsWith('Z96.41') || has(x.display, 'insulin pump')
      || has(x.display, 'closed loop') || has(x.display, 'مضخة'))) out.push('closed_loop_pump');
  if (p.diabetes_type === 'type1' || c.some((x) => x.code.startsWith('E10') || has(x.display, 'type 1 diabetes'))) out.push('type1_diabetes');
  const age = fn_age(p.date_of_birth);
  if (age !== null && age < 18) out.push('under_18');
  return out;
}

function fn_tier(p_patient_id) {
  return dbExists('care_team', (ct) => ct.patient_id === p_patient_id && ct.active === true && ct.role === 'doctor') ? 'linked' : 'unlinked';
}

function fn_patient_state(p_patient_id) {
  const m14 = fn_glucose_metrics(p_patient_id, 14);
  const pats = fn_detect_patterns(p_patient_id, 14);
  const adh = fn_adherence(p_patient_id, 7);
  const from7 = _m11_since(7);
  const events = dbWhere('glucose_events', (e) => e.patient_id === p_patient_id && t(e.occurred_at) > from7);
  let recentHypo = events.filter((e) => e.type === 'hypo' || e.type === 'severe_hypo').length;
  let recentSevere = events.filter((e) => e.type === 'severe_hypo').length;
  // Readings count too, not only alert events (events are de-duplicated, and imported readings may not raise one).
  const rs = _m11_readings(p_patient_id);
  let low = 0, severe = 0;
  for (const e of rs) if (e.ms > from7) { if (e.r.value_mgdl < 70) low++; if (e.r.value_mgdl < 54) severe++; }
  recentHypo = Math.max(recentHypo, low);
  recentSevere = Math.max(recentSevere, severe);
  const openFindings = dbCount('safety_findings', (f) => f.patient_id === p_patient_id && f.status === 'open'
    && (f.severity === 'major' || f.severity === 'contraindicated'));

  const from28 = _m11_since(28), from14 = _m11_since(14);
  const prevMean = avg(rs.filter((e) => e.ms >= from28 && e.ms <= from14).map((e) => e.r.value_mgdl));

  const tbr10 = (v) => (v === null ? null : Math.round(v * 10));          // tbr values carry one decimal: add exactly
  let glycemic;
  if (recentHypo >= 2 || recentSevere >= 1) glycemic = 'hypo_risk';
  else if (m14.data_quality === 'none' || m14.readings < 5) glycemic = 'insufficient_data';
  else if (tbr10(m14.tbr_level1) !== null && tbr10(m14.tbr_level2) !== null && tbr10(m14.tbr_level1) + tbr10(m14.tbr_level2) >= 40) glycemic = 'hypo_risk';
  else if (pats.some((p) => p.severity === 'attention' || p.severity === 'urgent')) glycemic = 'worsening_pattern';
  else if (prevMean !== null && m14.mean !== null && m14.mean < prevMean - 10) glycemic = 'improving';
  else glycemic = 'in_range';

  const safety = recentSevere > 0 ? 'severe_hypoglycemia' : recentHypo > 0 ? 'recent_hypoglycemia'
    : openFindings > 0 ? 'open_safety_findings' : 'stable';

  const hasMeds = dbExists('medications', (m) => m.patient_id === p_patient_id && m.status === 'active');
  const firstOverdue = fn_screenings(p_patient_id).find((x) => x.overdue === true);
  const screen = firstOverdue && firstOverdue.type !== null ? `${firstOverdue.type}_overdue` : 'up_to_date';

  const ep = orderBy(dbWhere('episodes', (e) => e.patient_id === p_patient_id && e.status !== null && e.status !== 'RESOLVED' && e.status !== 'CLOSED'),
    [(e) => t(e.started_at), 'desc'])[0];
  const episode = ep ? ep.status : null;

  const lastActivity = maxOf([
    maxOf(rs.filter((e) => e.r.source === 'patient').map((e) => t(e.r.created_at))),
    maxOf(dbWhere('medication_logs', (l) => l.patient_id === p_patient_id).map((l) => t(l.logged_at))),
    maxOf(dbWhere('meal_logs', (m) => m.patient_id === p_patient_id).map((m) => t(m.created_at))),
    maxOf(rs.filter((e) => _M11_CGM.includes(e.r.source)).map((e) => e.ms)),
  ]);
  const engage = lastActivity !== null && lastActivity > _m11_since(3) ? 'active'
    : lastActivity !== null && lastActivity > from14 ? 'low' : 'inactive';

  const plan = dbExists('care_plans', (c) => c.patient_id === p_patient_id && c.status === 'ACTIVE') ? 'active'
    : dbExists('care_plans', (c) => c.patient_id === p_patient_id && c.status === 'DRAFT') ? 'draft' : 'none';

  return {
    glycemic_state: glycemic,
    medication_state: !hasMeds ? 'no_medications' : adh === null ? 'unknown'
      : adh >= 80 ? 'adherent' : adh >= 50 ? 'partially_adherent' : 'non_adherent',
    care_plan_state: plan,
    screening_state: screen,
    safety_state: safety,
    episode_state: episode,
    engagement_state: engage,
    data_quality: m14.data_quality,
    tier: fn_tier(p_patient_id),
    exclusions: fn_exclusions(p_patient_id),
  };
}

/* ------------------------------------------------- Policy Engine: which actions are permitted from a state */

function fn_policy(p_patient_id, p_trigger) {
  const tier = fn_tier(p_patient_id);
  const excl = fn_exclusions(p_patient_id);
  const actions = ['general_education'];
  const reasons = [];
  if (excl !== null && excl.length > 0) {
    reasons.push(`excluded_population:${excl.join(',')}`);
    if (tier === 'linked') actions.push('clinician_review_task');
    actions.push('recommend_professional_followup');
    return { tier, exclusions: excl, actions, reasons, personalized: false };
  }
  if (tier === 'unlinked') {
    actions.push('recommend_professional_followup', 'observation_summary');
    reasons.push('unlinked_no_personalized_targets');
  } else {
    // A linked patient can always reach the care team; only data-driven explanations need adequate data.
    const quality = fn_glucose_metrics(p_patient_id, 14).data_quality;
    actions.push('observation_summary', 'clinician_review_task', 'questions_to_discuss');
    if (quality === 'good' || quality === 'sparse'
        || ['medication_safety', 'lab_result', 'plan_change', 'companion', 'care_access'].includes(p_trigger)) {
      actions.push('patient_explanation');
    } else {
      reasons.push(`data_quality:${quality}`);
    }
  }
  if (p_trigger === 'companion' || p_trigger === 'care_access') actions.push('care_navigation');
  // Human-only actions are never permitted to any automated path.
  return { tier, exclusions: excl, actions, reasons, personalized: tier === 'linked',
    forbidden: ['treatment_change', 'prescription', 'dose_adjustment', 'diagnosis', 'care_plan_authorship'] };
}
