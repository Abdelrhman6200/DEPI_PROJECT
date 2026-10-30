// WF-029 · Heat alerts. Once a day at 07:00 (Cairo), one request to the free Open-Meteo forecast for the governorates
// where patients live: only city coordinates (2 decimals) are sent, never a patient id or any health data. A forecast
// maximum of the rule's threshold or more sends a hot-day notice (engine 34_heat.js). A failed forecast request is
// recorded as a skipped run; nothing else depends on it.
import { workflow, jsStep, code, schedule, subTrigger, WF } from './lib.mjs';

export function heatAlerts() {
  const wf = workflow({ id: WF.heat, name: 'WF-029 · Heat alerts (Open-Meteo)', description: 'Daily at 07:00: today\'s maximum temperature for each governorate where patients live (city coordinates only); hot days send fluids, lows and insulin-storage advice.' });
  const t = wf.add(schedule('Daily 07:00', { field: 'days', daysInterval: 1, triggerAtHour: 7, triggerAtMinute: 0 }));
  const now = wf.add(subTrigger('Run now'));
  const targets = wf.add(jsStep('Governorates to check', 'fn_heat_targets()', '[]', { mode: 'rows' }));
  const build = wf.add(code('Forecast request', `
const places = $input.all().map((i) => i.json).filter((x) => x && typeof x.lat === 'number' && typeof x.lng === 'number');
const q = 'latitude=' + places.map((p) => p.lat.toFixed(2)).join(',') + '&longitude=' + places.map((p) => p.lng.toFixed(2)).join(',')
  + '&daily=temperature_2m_max&timezone=Africa%2FCairo&forecast_days=1';
return [{ json: { places, url: places.length ? 'https://api.open-meteo.com/v1/forecast?' + q : null } }];`));
  const fetch = wf.add({
    name: 'Open-Meteo forecast',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    onError: 'continueRegularOutput',
    parameters: {
      url: "={{ $json.url || 'https://api.open-meteo.com/v1/forecast?latitude=30.04&longitude=31.24&daily=temperature_2m_max&forecast_days=1' }}",
      options: { timeout: 20000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } },
    },
  });
  const pair = wf.add(code('Pair with governorates', `
const places = $('Forecast request').first().json.places || [];
const r = $input.first().json || {};
const body = r.body;
// One place: an object; several: an array in the same order as the coordinates.
const arr = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : [];
const ok = Number(r.statusCode) === 200 && arr.length === places.length;
const results = ok ? places.map((p, i) => ({ governorate: p.governorate, tmax: ((arr[i] || {}).daily || {}).temperature_2m_max?.[0] ?? null })) : [];
return [{ json: { results, status: Number(r.statusCode || 0) } }];`));
  const apply = wf.add(jsStep('Send hot-day notices', "fn_job_run('heat', { ...fn_heat_apply(castJson(a[0])), forecast_status: castInt(a[1]) })",
    '[ JSON.stringify($json.results), String($json.status) ]'));
  wf.link(t, targets);
  wf.link(now, targets);
  wf.chain(targets, build, fetch, pair, apply);
  return wf.build();
}
