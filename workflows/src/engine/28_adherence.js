/* 28 · Medicine supply, refills and missed doses (deterministic, no AI).
 *
 *   fn_med_supply(m)                 units left from the last count: the count minus every scheduled dose since then
 *                                    (assumes doses are taken as prescribed, so it never overstates the supply).
 *   api_set_supply(c, d)             the person (or family member, or clinician) counts what is left of a medicine.
 *   fn_refills_due(pid)              medicines that run out within refill_days_ahead days (Today, the clinician).
 *   fn_dose_reason_followup(...)     a dose missed because the medicine was not available, too expensive or had side
 *                                    effects goes to the care team's inbox (once a week per medicine and reason).
 *   fn_run_adherence()               part of the 15-minute reminders job: "did you take it?" two hours after a dose
 *                                    with no answer (to the person only), and refill notices (to the person and family).
 * Settings: rule `adherence` (refill_days_ahead, missed_followup_minutes, team_reasons).
 * Why: medication reminders are the feature people with type 2 diabetes ask for most, and medicine shortages and price
 * rises in Egypt (2024-2026) make "could not get it" a frequent reason for missed doses that the clinic needs to know.
 */

const _A28_DEFAULTS = { refill_days_ahead: 5, missed_followup_minutes: 120, team_reasons: ['not_available', 'cost', 'side_effects'] };
const _A28_REASONS = ['forgot', 'side_effects', 'not_available', 'cost', 'felt_well', 'fasting', 'other'];
const _A28_REASON_TEXT = {
  not_available: ['could not find it in pharmacies', 'لم يجده في الصيدليات'],
  cost: ['could not afford it', 'لم يستطع شراءه بسبب السعر'],
  side_effects: ['side effects', 'أعراض جانبية'],
};

function _a28_cfg() { return { ..._A28_DEFAULTS, ...(coalesce(fn_rule('adherence'), {})) }; }

function _a28_times(m) { return (Array.isArray(m.times) ? m.times : []).filter((x) => typeof x === 'string' && _M11_HHMM.test(x)); }

/** Supply of one medicine: null when it was never counted. */
function fn_med_supply(m) {
  if (!m || m.supply_count === null || m.supply_count === undefined || m.supply_set_at === null || m.supply_set_at === undefined) return null;
  const count = castNum(m.supply_count);
  const per = coalesce(castNum(m.units_per_dose), 1);
  const times = _a28_times(m);
  const perDay = times.length * per;
  const from = t(m.supply_set_at), nowT = nowMs();
  let used = 0;
  for (let day = localDate(m.supply_set_at); day !== null && day <= today(); day = addDays(day, 1)) {
    for (const tm of times) {
      const slot = _m11_slot(day, tm);
      if (slot > from && slot <= nowT) used += per;
    }
  }
  const remaining = Math.max(0, count - used);
  const daysLeft = perDay > 0 ? Math.floor(remaining / perDay) : null;
  const cfg = _a28_cfg();
  return {
    counted: count, units_per_dose: per, counted_at: m.supply_set_at, remaining: round(remaining, 1), days_left: daysLeft,
    runs_out_on: daysLeft === null ? null : addDays(today(), daysLeft),
    refill_due: daysLeft !== null && daysLeft <= coalesce(castInt(cfg.refill_days_ahead), 5),
  };
}

function fn_refills_due(p_patient_id) {
  const out = [];
  for (const m of dbWhere('medications', (x) => x.patient_id === p_patient_id && x.status === 'active' && x.verification_status !== 'refuted')) {
    const s = fn_med_supply(m);
    if (s && s.refill_due) out.push({ medication_id: m.id, name: m.name, days_left: s.days_left, remaining: s.remaining, runs_out_on: s.runs_out_on });
  }
  return orderBy(out, (x) => x.days_left, (x) => x.name);
}

function api_set_supply(c, d) {
  const pid = fn_resolve_patient(c, d);
  const id = castUuid(jtext(d && d.medication_id));
  const m = id === null ? null : dbOne('medications', (x) => x.id === id && x.patient_id === pid && x.status === 'active');
  if (!m) fn_raise('not_found: medication not found');
  const count = castNum(jtext(d.supply_count));
  if (count === null || !(count >= 0 && count <= 10000)) fn_raise('bad_request: supply_count must be a number from 0 to 10000');
  const perIn = d.units_per_dose === undefined || d.units_per_dose === null || d.units_per_dose === '' ? coalesce(castNum(m.units_per_dose), 1) : castNum(jtext(d.units_per_dose));
  if (perIn === null || !(perIn > 0 && perIn <= 20)) fn_raise('bad_request: units_per_dose must be more than 0 and at most 20');
  const row = dbUpdate('medications', m, { supply_count: count, units_per_dose: perIn, supply_set_at: now(), updated_at: now() });
  fn_audit(c, 'medication.supply', 'medication', m.id, pid, { supply_count: count });
  return { id: m.id, supply: fn_med_supply(row) };
}

/** A missed or skipped dose with a reason the clinic should know about goes to the care team (once a week each). */
function fn_dose_reason_followup(p_patient_id, m, p_reason) {
  const cfg = _a28_cfg();
  if (p_reason === null || !(Array.isArray(cfg.team_reasons) ? cfg.team_reasons : []).includes(p_reason)) return null;
  const [en, ar] = _A28_REASON_TEXT[p_reason] || [p_reason, p_reason];
  const week = isoWeekKey(today());
  return fn_create_inbox_item(p_patient_id, p_reason === 'side_effects' ? 'safety' : 'question', 'medium', 3,
    `Missed ${m.name}: ${en}`,
    `The patient reported missing ${m.name} (${coalesce(m.dose_text, 'dose not recorded')}) because of ${en}. `
      + (p_reason === 'side_effects' ? 'Review the medicine and possible side effects.' : 'Consider an available or affordable alternative.'),
    { type: 'dose_reason', medication_id: m.id, reason: p_reason, reason_ar: ar }, `dose-reason:${m.id}:${p_reason}:${week}`);
}

/** ISO week key such as 2026-W41 for a YYYY-MM-DD date. */
function isoWeekKey(p_day) {
  const [y, mo, d] = String(p_day).slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  const dow = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dow);
  const y0 = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const w = Math.ceil(((dt - y0) / DAY + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(w).padStart(2, '0')}`;
}

/** Notifies only the person (no family members): used for "did you take it?" so family is not told about every dose. */
function _a28_notify_self(p_patient_id, p_kind, p_title, p_body, p_dedupe, p_title_ar, p_body_ar) {
  const p = dbGet('patients', p_patient_id);
  if (!p || p.user_id === null) return;
  dbInsert('notifications', { user_id: p.user_id, patient_id: p.id, kind: p_kind, title: p_title, body: p_body,
    title_ar: p_title_ar, body_ar: p_body_ar, dedupe_key: `${p_dedupe}:${p.user_id}` }, { onConflict: 'nothing' });
}

function fn_run_adherence() {
  const cfg = _a28_cfg();
  const delay = coalesce(castInt(cfg.missed_followup_minutes), 120) * MIN;
  const nowT = nowMs(), day = today();
  let followups = 0, refills = 0;
  const meds = dbWhere('medications', (x) => x.status === 'active' && x.verification_status !== 'refuted' && !fn_account_closed(x.patient_id));
  for (const m of meds) {
    const start = t(fn_med_effective_start(m));
    // "Did you take it?": a dose whose time passed `delay` ago (within this 15-minute run) and has no answer.
    for (const tm of _a28_times(m)) {
      for (const dday of [day, addDays(day, -1)]) {
        const slot = _m11_slot(dday, tm);
        if (!(slot + delay <= nowT && slot + delay > nowT - 15 * MIN) || (start !== null && slot < start)) continue;
        if (dbExists('medication_logs', (l) => l.medication_id === m.id && t(l.scheduled_at) === slot)) continue;
        _a28_notify_self(m.patient_id, 'medication_missed', `Did you take ${m.name}?`, `Your ${tm} dose is not marked yet.`,
          `missed:${m.id}:${dday}:${tm}`, `هل أخذت ${m.name}؟`, `جرعة الساعة ${tm} لم تُسجَّل بعد.`);
        followups++;
      }
    }
    // Refill: once when it reaches refill_days_ahead, and again on the last day.
    const s = fn_med_supply(m);
    if (s && s.refill_due) {
      const stage = s.days_left <= 1 ? 'last' : 'soon';
      fn_notify_patient(m.patient_id, 'refill_due',
        s.days_left <= 1 ? `${m.name} runs out ${s.days_left <= 0 ? 'today' : 'tomorrow'}` : `${m.name}: about ${s.days_left} days left`,
        'Buy a refill now so you do not miss doses. You can find a nearby pharmacy in the app.',
        `refill:${m.id}:${String(m.supply_set_at).slice(0, 19)}:${stage}`,
        s.days_left <= 1 ? `${m.name} ${s.days_left <= 0 ? 'ينفد اليوم' : 'ينفد غدًا'}` : `${m.name}: باقي حوالي ${s.days_left} أيام`,
        'اشترِ العبوة الجديدة الآن حتى لا تفوتك جرعات. يمكنك إيجاد صيدلية قريبة من التطبيق.');
      refills++;
    }
  }
  return { missed_followups: followups, refills };
}
