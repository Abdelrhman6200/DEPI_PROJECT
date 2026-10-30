// Page actions: everything one screen shows, in one API request. n8n runs one execution at a time on its main thread,
// so a screen that fired 5-10 requests waited for them in a queue; one page request answers in the time of one.
// Each part is the existing route function (30_api_routes.js), called only if the caller could call that action on its
// own: the same roles and family-member scopes as the Auth Gate (fn_gate), read from the api_routes table. A part that
// is refused or fails is { error: code } and the others are still answered; the web app then asks for that part alone.

/** null when ctx may call group.action with data; otherwise the error code the Auth Gate would give. */
function _p37_refused(c, group, action, data) {
  const row = dbOne('api_routes', (r) => r.grp === group);
  const routes = row && row.routes && typeof row.routes === 'object' ? row.routes : {};
  if (!Object.prototype.hasOwnProperty.call(routes, action)) return 'unknown_action';
  const route = routes[action] || {};
  const roles = Object.prototype.hasOwnProperty.call(route, 'roles') ? route.roles : undefined;
  const role = jtext(c && c.role);
  if (roles === undefined || roles === null || (roles !== '*' && _m10_hasKey(roles, role) !== true)) return 'forbidden';
  if (route.scope) {
    try { fn_scope_ctx(c, data, route.scope); } catch (e) { if (!_m10_isRaise(e)) throw e; return 'forbidden'; }
  }
  return null;
}

/** One part of a page: the route's answer, or { error } when refused or when it raises (other errors propagate). */
function _p37_part(c, group, action, fn, data) {
  const refused = _p37_refused(c, group, action, data);
  if (refused) return { error: refused };
  try {
    return fn(c, data);
  } catch (e) {
    if (!_m10_isRaise(e)) throw e;
    return { error: String(e.message).split(':')[0] };
  }
}

/** The patient's id-carrying input for the parts (a family member names the patient; a patient may omit it). */
function _p37_scope(d) { return d && d.patient_id ? { patient_id: d.patient_id } : {}; }

// Today: the day's payload, the notifications shown in its notices and in the bell, and the last day's readings.
function api_page_today(c, d) {
  fn_resolve_patient(c, d);
  const s = _p37_scope(d);
  return {
    today: _p37_part(c, 'today', 'get', api_route_today_get, s),
    notifications: _p37_part(c, 'insights', 'notifications', api_route_insights_notifications, {}),
    // The last day's readings: the trend arrow next to the latest sensor value.
    recent: _p37_part(c, 'glucose', 'list', api_route_glucose_list, { ...s, days: 1 }),
  };
}

// Blood sugar: summary, readings and patterns for the chosen days; the charts' data when asked for (charts: true).
function api_page_glucose(c, d) {
  fn_resolve_patient(c, d);
  const s = { ..._p37_scope(d), days: fn_clamp(jtext(d && d.days), 14, 1, 90) };
  const out = {
    metrics: _p37_part(c, 'glucose', 'metrics', api_route_glucose_metrics, s),
    list: _p37_part(c, 'glucose', 'list', api_route_glucose_list, s),
    patterns: _p37_part(c, 'glucose', 'patterns', api_route_glucose_patterns, s),
    nightscout: _p37_part(c, 'glucose', 'nightscout_status', api_route_glucose_nightscout_status, _p37_scope(d)),
  };
  if (d && d.charts === true) {
    out.agp = _p37_part(c, 'glucose', 'agp', api_route_glucose_agp, s);
    out.daily = _p37_part(c, 'glucose', 'daily', api_route_glucose_daily, s);
  }
  return out;
}

// My care: care team, plan, check-ups, appointments, care requests, referrals, messages and family members.
function api_page_care(c, d) {
  fn_resolve_patient(c, d);
  const s = _p37_scope(d);
  return {
    profile: _p37_part(c, 'profile', 'get', api_route_profile_get, s),
    plan: _p37_part(c, 'care', 'plan', api_route_care_plan, s),
    screenings: _p37_part(c, 'care', 'screenings', api_route_care_screenings, s),
    appointments: _p37_part(c, 'care', 'appointments', api_route_care_appointments, s),
    episodes: _p37_part(c, 'episodes', 'list', api_route_episodes_list, s),
    referrals: _p37_part(c, 'network', 'referrals', api_route_network_referrals, s),
    messages: _p37_part(c, 'care', 'messages', api_route_care_messages, s),
    caregivers: _p37_part(c, 'care', 'caregivers', api_route_care_caregivers, {}),
    my_doctor: _p37_part(c, 'care', 'my_doctor', api_route_care_my_doctor, s),
  };
}

// Food and activity: the week's summary and the person's food responses.
function api_page_lifestyle(c, d) {
  fn_resolve_patient(c, d);
  const s = _p37_scope(d);
  return {
    summary: _p37_part(c, 'lifestyle', 'summary', api_route_lifestyle_summary, { ...s, days: 7 }),
    food_profile: _p37_part(c, 'lifestyle', 'food_profile', api_route_lifestyle_food_profile, { ...s, days: 90 }),
  };
}

// Clinician home: the inbox (active items), join requests, held AI answers, the header counts and notifications.
function api_page_provider_home(c, d) {
  return {
    inbox: _p37_part(c, 'provider', 'inbox', api_route_provider_inbox, { status: 'active' }),
    link_requests: _p37_part(c, 'provider', 'link_requests', api_route_provider_link_requests, {}),
    ai_reviews: _p37_part(c, 'provider', 'ai_reviews', api_route_provider_ai_reviews, {}),
    stats: _p37_part(c, 'provider', 'stats', api_route_provider_stats, {}),
    notifications: _p37_part(c, 'insights', 'notifications', api_route_insights_notifications, {}),
  };
}
