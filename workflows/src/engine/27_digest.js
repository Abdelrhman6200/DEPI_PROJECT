/* 27 · Weekly digest: a short summary of the past 7 days for the person and their family (deterministic, no AI).
 *
 *   fn_weekly_digest(patient)   the numbers (time in range and its change from the week before, mean, lows, days with
 *                               a reading, medicines taken, average steps) and one goal, chosen by fixed rules:
 *                               lows first, then too few readings, then time in range, then steps.
 *   fn_run_weekly_digest()      once a week (from fn_run_reminders: digest_weekday at digest_hour, Cairo time): an in-app
 *                               notice to the person and their family, and, when email is on, an email that only says
 *                               the summary is ready (no health values travel by email).
 * Settings: safety rule weekly_digest (weekday 0 = Sunday … 6 = Saturday; default Saturday 10:00).
 */

const _D27_DEFAULTS = { digest_weekday: 6, digest_hour: 10, min_readings: 7, steps_goal: 6000 };
function _d27_cfg() {
  const c = { ..._D27_DEFAULTS, ...(coalesce(fn_rule('weekly_digest'), {})) };
  for (const k of Object.keys(_D27_DEFAULTS)) c[k] = coalesce(castNum(c[k]), _D27_DEFAULTS[k]);
  return c;
}

function fn_weekly_digest(p_patient_id) {
  const cfg = _d27_cfg();
  const pid = castUuid(p_patient_id);
  const nowT = nowMs(), from7 = nowT - 7 * DAY, from14 = nowT - 14 * DAY;
  const rs = dbWhere('glucose_readings', (r) => r.patient_id === pid && t(r.measured_at) > from14 && t(r.measured_at) <= nowT)
    .map((r) => ({ v: castNum(r.value_mgdl), at: t(r.measured_at) })).filter((r) => r.v !== null);
  const week = rs.filter((r) => r.at > from7), prev = rs.filter((r) => r.at <= from7);
  const tir = (xs) => (xs.length ? Math.round((100 * xs.filter((r) => r.v >= 70 && r.v <= 180).length) / xs.length) : null);
  // Calendar days in Cairo: today and the 6 days before (a 7 x 24 h window touches 8 dates).
  const firstDay = addDays(today(), -6);
  const days = new Set(week.map((r) => localDate(new Date(r.at).toISOString())).filter((x) => x >= firstDay)).size;
  const lows = week.filter((r) => r.v < 70).length;
  const mean = week.length ? Math.round(week.reduce((s, r) => s + r.v, 0) / week.length) : null;
  const acts = dbWhere('activity_logs', (a) => a.patient_id === pid && t(`${String(a.date).slice(0, 10)}T12:00:00Z`) > from7);
  const steps = acts.length ? Math.round(acts.reduce((s, a) => s + coalesce(castNum(a.steps), 0), 0) / 7) : null;
  const meds = fn_adherence(pid, 7);
  const d = { readings: week.length, days_with_readings: days, tir: tir(week), tir_prev: tir(prev), mean, lows, steps_avg: steps, medicines_taken_pct: meds };
  // One goal, the most useful first.
  let goal;
  if (lows >= 2) goal = ['You had ' + lows + ' lows this week. Keep fast sugar with you and check before driving and at bedtime. Tell your care team if lows keep happening.',
    'حصل عندك ' + lows + ' مرات هبوط الأسبوع ده. خلّي معاك سكر سريع، وقيس قبل السواقة وقبل النوم. بلّغ فريق الرعاية لو الهبوط بيتكرر.'];
  else if (week.length < cfg.min_readings) goal = ['Try to log at least one glucose reading a day this week.', 'حاول تسجل قراية سكر واحدة على الأقل كل يوم الأسبوع ده.'];
  else if (d.tir !== null && d.tir < 70) goal = ['A 10 to 15 minute walk after your largest meal can lower the rise in glucose.', 'المشي 10 لـ 15 دقيقة بعد أكبر وجبة بيقلل ارتفاع السكر بعد الأكل.'];
  else if (steps !== null && steps < cfg.steps_goal) goal = [`Aim for ${cfg.steps_goal} steps a day this week.`, `حاول توصل لـ ${cfg.steps_goal} خطوة في اليوم الأسبوع ده.`];
  else goal = ['Great week. Keep going with what works for you.', 'أسبوع ممتاز. كمّل على اللي ماشي معاك.'];
  const change = d.tir !== null && d.tir_prev !== null ? d.tir - d.tir_prev : null;
  const parts = [];
  const partsAr = [];
  if (d.tir !== null) {
    parts.push(`Time in range ${d.tir}%${change === null ? '' : change === 0 ? ' (same as last week)' : ` (${change > 0 ? 'up' : 'down'} ${Math.abs(change)} from last week)`}`);
    partsAr.push(`الوقت في المدى ${d.tir}%${change === null ? '' : change === 0 ? ' (زي الأسبوع اللي فات)' : ` (${change > 0 ? 'زاد' : 'قل'} ${Math.abs(change)} عن الأسبوع اللي فات)`}`);
  }
  parts.push(`${days} of 7 days with a reading`); partsAr.push(`${days} من 7 أيام فيها قراية`);
  if (lows) { parts.push(`${lows} low${lows > 1 ? 's' : ''}`); partsAr.push(`${lows} هبوط`); }
  if (meds !== null) { parts.push(`medicines taken ${meds}%`); partsAr.push(`الأدوية اتاخدت ${meds}%`); }
  if (steps !== null) { parts.push(`about ${steps} steps a day`); partsAr.push(`حوالي ${steps} خطوة في اليوم`); }
  return { ...d, change, text_en: `${parts.join(', ')}. ${goal[0]}`, text_ar: `${partsAr.join('، ')}. ${goal[1]}` };
}

function fn_run_weekly_digest() {
  const day = today();
  let sent = 0, emails = 0;
  for (const p of dbWhere('patients', (x) => x.user_id !== null)) {
    if (fn_account_closed(p.id)) continue;
    const d = fn_weekly_digest(p.id);
    if (d.readings === 0 && d.steps_avg === null && d.medicines_taken_pct === null) continue;   // nothing to report
    fn_notify_patient(p.id, 'weekly_digest', 'Your week', d.text_en, `digest:${p.id}:${day}`, 'أسبوعك', d.text_ar);
    sent++;
    if (fn_email_enabled()) { fn_emit('WeeklyDigestEmail', p.id, p.user_id, {}); emails++; }
  }
  return { digests: sent, emails };
}
