/* 26 · Reading a glucose meter's screen from a photo (the AI section is workflows/src/meter.mjs, WF-028).
 *
 *   fn_meter_photo_ctx(c, d)   who asks, for which patient, and where the photo may be read: by the local model always
 *                              (with AI-processing consent), in the cloud only with the meter_photo_cloud flag and the
 *                              usual cloud gate. Nothing is stored: the number fills the log form and the person
 *                              checks it and taps Save (glucose.add), like a typed reading.
 *   fn_meter_photo_result(o)   the model's answer, checked: a number a meter can show (mg/dL, or mmol/L converted),
 *                              HI/LO, or nothing; a low-confidence or implausible read is returned as "not read".
 */

function fn_meter_photo_ctx(c, d) {
  const pid = fn_resolve_patient(c, d);
  const gate = fn_ai_gate(pid, 'meter_photo');
  const flag = dbGet('feature_flags', 'meter_photo_cloud');
  return {
    patient_id: pid,
    ai_allowed: gate.ai_allowed === true,
    cloud_allowed: gate.cloud_allowed === true && coalesce(flag ? flag.enabled : null, false) === true,
  };
}

function fn_meter_photo_result(o) {
  const r = o && typeof o === 'object' ? o : {};
  const hilo = String(r.hi_lo || '').toUpperCase();
  const conf = ['high', 'medium', 'low'].includes(r.confidence) ? r.confidence : 'low';
  if (r.reading_visible !== true || conf === 'low') return { read: false, reason: r.reading_visible === true ? 'unsure' : 'no_reading' };
  if (hilo === 'HI' || hilo === 'LO') return { read: true, hi_lo: hilo, value_mgdl: null, confidence: conf };
  let v = castNum(r.value);
  const unit = String(r.unit || '').toLowerCase().replace(/\s+/g, '');
  if (v === null) return { read: false, reason: 'no_reading' };
  // A meter in mmol/L shows one decimal (5.6); in mg/dL a whole number (101).
  const mmol = unit.includes('mmol') || (unit === '' && v < 35 && !Number.isInteger(v));
  if (mmol) v = Math.round(v * 18.016);
  v = Math.round(v);
  if (v < 20 || v > 600) return { read: false, reason: 'out_of_range' };
  return { read: true, value_mgdl: v, converted_from_mmol: mmol, hi_lo: null, confidence: conf };
}
