/* 34 · Heat alerts (the section is workflows/src/heat.mjs, WF-029: one daily request to the free Open-Meteo forecast).
 *
 *   fn_heat_targets()        the governorates where patients live, as city-level coordinates rounded to 2 decimals
 *                            (no patient data leaves the server: only the list of city coordinates is sent).
 *   fn_heat_apply(results)   for each governorate whose forecast maximum is at least threshold_c, a "hot day" notice to
 *                            every patient living there (and their family members): fluids, lows with heat and
 *                            exercise, and keeping insulin cool (never in a car or in the sun; a clay pot or cool bag
 *                            when there is no fridge or the power is cut). Once a day per governorate.
 * Settings: rule heat (threshold_c, governorates with their coordinates).
 */

const _H34 = {
  threshold_c: 38,
  governorates: {
    Cairo: [30.04, 31.24], Giza: [30.01, 31.21], Alexandria: [31.2, 29.92], Qalyubia: [30.46, 31.18], Dakahlia: [31.04, 31.38],
    Sharqia: [30.59, 31.5], Gharbia: [30.79, 31.0], Monufia: [30.55, 31.01], Beheira: [31.03, 30.47], 'Kafr El Sheikh': [31.11, 30.94],
    Damietta: [31.42, 31.81], 'Port Said': [31.26, 32.3], Ismailia: [30.6, 32.27], Suez: [29.97, 32.53], Faiyum: [29.31, 30.84],
    'Beni Suef': [29.07, 31.1], Minya: [28.11, 30.75], Asyut: [27.18, 31.18], Sohag: [26.56, 31.69], Qena: [26.16, 32.72],
    Luxor: [25.69, 32.64], Aswan: [24.09, 32.9], 'Red Sea': [27.26, 33.81], 'New Valley': [25.44, 30.55], Matrouh: [31.35, 27.24],
    'North Sinai': [31.13, 33.8], 'South Sinai': [28.24, 33.62],
  },
};

function _h34_cfg() { const r = coalesce(fn_rule('heat'), {}); return { ..._H34, ...r, governorates: { ..._H34.governorates, ...(r.governorates || {}) } }; }

function fn_heat_targets() {
  const cfg = _h34_cfg();
  const govs = new Set(dbWhere('patients', (p) => p.governorate && !fn_account_closed(p.id)).map((p) => p.governorate));
  return [...govs].filter((g) => cfg.governorates[g]).sort().map((g) => ({
    governorate: g, lat: round(cfg.governorates[g][0], 2), lng: round(cfg.governorates[g][1], 2),
  }));
}

/** results: [{ governorate, tmax }] (the section pairs Open-Meteo's answer with fn_heat_targets()). */
function fn_heat_apply(p_results) {
  const cfg = _h34_cfg();
  const day = today();
  let alerts = 0, places = 0;
  for (const r of Array.isArray(p_results) ? p_results : []) {
    const n = Number(r && r.tmax);
    const tmax = r && r.tmax !== null && r.tmax !== '' && Number.isFinite(n) ? n : null;
    const gov = r && typeof r.governorate === 'string' ? r.governorate : null;
    if (tmax === null || !gov || !cfg.governorates[gov] || tmax < cfg.threshold_c) continue;
    places++;
    const t0 = Math.round(tmax);
    for (const p of dbWhere('patients', (x) => x.governorate === gov && !fn_account_closed(x.id))) {
      fn_notify_patient(p.id, 'heat_alert', `Hot day: up to ${t0}°C`,
        'Drink water through the day. Heat and exercise can lower your sugar: check it more often. Keep insulin out of the sun and never in a car; without a fridge, use a clay pot or a cool bag.',
        `heat:${gov}:${day}`, `يوم حار: حتى ${t0}°م`,
        'اشرب ماء طول اليوم. الحر والمجهود ممكن يوطّوا السكر: قِسه أكتر. خلي الإنسولين بعيد عن الشمس وعمره ما يتساب في العربية؛ لو مفيش تلاجة حطه في إناء فخار مبلول (زير) أو شنطة تبريد.');
      alerts++;
    }
  }
  return { hot_places: places, heat_alerts: alerts };
}
