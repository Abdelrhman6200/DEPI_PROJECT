/* 23 · Prediction: early warnings of low glucose, from the person's own readings (deterministic, no AI).
 *
 *   fn_glucose_trend(patient, at)   the trend of the last window_min minutes: least-squares slope (mg/dL per minute)
 *                                   and the value projected horizon_min minutes ahead. Needs min_points readings that
 *                                   span at least min_span_min minutes (a CGM, or frequent meter readings).
 *   fn_predict_low(patient, reading) after each new live reading (fn_add_glucose): when the trend will cross the low
 *                                   threshold, or falls fast near it, the person and their family get a fixed warning;
 *                                   the care team gets an inbox item when the projection is below the severe threshold
 *                                   or it is night. At most one warning per patient per hour.
 *   fn_run_night_risk()             once in the evening (from fn_run_reminders): a "risky night" notice when someone on
 *                                   insulin or a sulfonylurea has another risk factor (exercise today, a low evening
 *                                   reading, a night low this week).
 * The texts give the person's own low-sugar plan (check, 15 g fast sugar, check again), never a medicine change.
 * Settings: safety rule low_prediction (any key overrides the defaults below).
 */

const _P23_DEFAULTS = {
  window_min: 30, horizon_min: 30, min_points: 3, min_span_min: 15, live_within_min: 20,
  min_drop_per_min: 1, fast_drop_per_min: 2, fast_below: 100,
  night_from: 22, night_to: 6, night_check_hour: 21, bedtime_below: 120, exercise_minutes: 30, night_low_days: 7,
  hypo_classes: ['basal_insulin', 'rapid_insulin', 'sulfonylurea'],
};

function _p23_cfg() {
  const c = { ..._P23_DEFAULTS, ...(coalesce(fn_rule('low_prediction'), {})) };
  for (const k of Object.keys(_P23_DEFAULTS)) if (typeof _P23_DEFAULTS[k] === 'number') c[k] = coalesce(castNum(c[k]), _P23_DEFAULTS[k]);
  return c;
}

function _p23_isNight(cfg, ts) {
  const h = localHour(ts);
  return cfg.night_from > cfg.night_to ? (h >= cfg.night_from || h < cfg.night_to) : (h >= cfg.night_from && h < cfg.night_to);
}

/** Trend of the readings in the window ending at p_at (default now), or null when there are too few. */
function fn_glucose_trend(p_patient_id, p_at = null) {
  const cfg = _p23_cfg();
  const pid = castUuid(p_patient_id);
  const end = p_at === null || p_at === undefined ? nowMs() : t(p_at);
  const from = end - cfg.window_min * MIN;
  const pts = dbWhere('glucose_readings', (r) => r.patient_id === pid && t(r.measured_at) >= from && t(r.measured_at) <= end)
    .map((r) => ({ x: (t(r.measured_at) - end) / MIN, y: castNum(r.value_mgdl) }))
    .filter((p) => p.y !== null)
    .sort((a, b) => a.x - b.x);
  if (pts.length < cfg.min_points || pts[pts.length - 1].x - pts[0].x < cfg.min_span_min) return null;
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const den = pts.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  if (den === 0) return null;
  const slope = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / den;
  const last = pts[pts.length - 1].y;
  return { slope: round(slope, 2), last, projected: Math.round(last + slope * cfg.horizon_min), points: pts.length, horizon_min: cfg.horizon_min };
}

/** After a new reading: warns about a coming low. Returns the warning (also sent), or null. */
function fn_predict_low(p_patient_id, p_reading) {
  const cfg = _p23_cfg();
  const pid = castUuid(p_patient_id);
  if (!p_reading || pid === null) return null;
  const at = t(p_reading.measured_at);
  if (!(at > nowMs() - cfg.live_within_min * MIN)) return null;           // back-filled data: no live warning
  const th = coalesce(fn_rule('glucose_thresholds'), {});
  const hypo = coalesce(castNum(th.hypo), 70), severe = coalesce(castNum(th.severe_hypo), 54);
  const trend = fn_glucose_trend(pid, p_reading.measured_at);
  if (trend === null || trend.last < hypo) return null;                     // already low: the low-glucose alert handles it
  const crossing = trend.slope <= -cfg.min_drop_per_min && trend.projected < hypo;
  const fast = trend.slope <= -cfg.fast_drop_per_min && trend.last < cfg.fast_below;
  if (!crossing && !fast) return null;
  const night = _p23_isNight(cfg, p_reading.measured_at);
  const serious = trend.projected < severe;
  const dedupe = `lowpred:${pid}:${Math.floor(at / HOUR)}`;
  const en = `Your glucose is ${trend.last} mg/dL and falling (about ${Math.abs(trend.slope)} mg/dL a minute). It may go below ${hypo} within about ${cfg.horizon_min} minutes. Check your glucose now. If it is below ${hypo}, follow your low-sugar plan: 15 g of fast sugar, then check again after 15 minutes.`;
  const ar = `السكر ${trend.last} مجم/دل وبينزل (حوالي ${Math.abs(trend.slope)} مجم/دل في الدقيقة)، وممكن يقل عن ${hypo} خلال حوالي ${cfg.horizon_min} دقيقة. قيس السكر دلوقتي. لو أقل من ${hypo}، اتبع خطة هبوط السكر: 15 جرام سكر سريع، وقيس تاني بعد 15 دقيقة.`;
  fn_notify_patient(pid, 'low_predicted', 'Low glucose may be coming', en, dedupe, 'احتمال هبوط السكر قريبًا', ar);
  if (serious || night) {
    fn_create_inbox_item(pid, 'glucose', serious ? 'high' : 'medium', serious ? 2 : 3,
      `Low glucose predicted${night ? ' (night)' : ''}: ${trend.last} → ~${trend.projected} mg/dL in ${cfg.horizon_min} min`,
      `Falling ${trend.slope} mg/dL/min over ${trend.points} readings.`, { type: 'low_predicted', ...trend, night }, dedupe);
  }
  return { type: 'low_predicted', ...trend, night, serious, message_en: en, message_ar: ar };
}

/** Evening check (at night_check_hour, local): a "risky night" notice for people on insulin or a sulfonylurea. */
function fn_run_night_risk() {
  const cfg = _p23_cfg();
  const day = today();
  const th = coalesce(fn_rule('glucose_thresholds'), {});
  const hypo = coalesce(castNum(th.hypo), 70);
  const since = nowMs() - cfg.night_low_days * DAY;
  const eveningFrom = t(dayStart(day)) + 18 * HOUR - 0;
  let sent = 0;
  const onHypoMeds = new Set(dbWhere('medications', (m) => m.status === 'active' && m.verification_status !== 'refuted'
    && cfg.hypo_classes.includes(m.drug_class)).map((m) => m.patient_id));
  for (const pid of onHypoMeds) {
    const p = dbGet('patients', pid);
    if (!p || p.user_id === null || fn_account_closed(pid)) continue;
    const reasons = [];
    const nightLow = dbExists('glucose_events', (e) => e.patient_id === pid && ['hypo', 'severe_hypo'].includes(e.type)
      && t(e.occurred_at) > since && _p23_isNight(cfg, e.occurred_at));
    if (nightLow) reasons.push(['a low at night this week', 'هبوط بالليل الأسبوع ده']);
    const ex = dbWhere('activity_logs', (a) => a.patient_id === pid && String(a.date).slice(0, 10) === day)
      .reduce((s, a) => s + coalesce(castNum(a.minutes), 0), 0);
    if (ex >= cfg.exercise_minutes) reasons.push([`${ex} minutes of exercise today`, `${ex} دقيقة رياضة النهارده`]);
    const evening = orderBy(dbWhere('glucose_readings', (r) => r.patient_id === pid && t(r.measured_at) >= eveningFrom), [(r) => t(r.measured_at), 'desc'])[0];
    if (evening && castNum(evening.value_mgdl) < cfg.bedtime_below && castNum(evening.value_mgdl) >= hypo) {
      reasons.push([`an evening reading of ${evening.value_mgdl} mg/dL`, `قراية بالليل ${evening.value_mgdl} مجم/دل`]);
    }
    if (!reasons.length) continue;
    fn_notify_patient(pid, 'night_low_risk', 'Higher risk of a low tonight',
      `Because of ${reasons.map((r) => r[0]).join(', ')}, your risk of a low tonight is higher than usual. Check your glucose before bed and keep fast sugar next to your bed. If this happens often, ask your care team about a bedtime plan.`,
      `nightrisk:${pid}:${day}`, 'احتمال هبوط السكر الليلة أعلى',
      `بسبب ${reasons.map((r) => r[1]).join('، ')}، احتمال هبوط السكر الليلة أعلى من المعتاد. قيس السكر قبل النوم وخلّي سكر سريع جنب السرير. لو ده بيتكرر، اسأل فريق الرعاية عن خطة لوقت النوم.`);
    sent++;
  }
  return { night_risk: sent };
}
