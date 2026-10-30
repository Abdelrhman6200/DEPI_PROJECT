// 30 API routes: the actions of workflows/src/api-routes.mjs (GROUPS) in JavaScript.
//
// Each 'sql' action was one query run with $1 = caller context (c, from the Auth Gate) and $2 = request data (d) that
// returned one row with a column `data`. api_route_<group>_<action>(c, d) returns what that column held; it calls the
// ported SQL functions by their SQL names, composed as the query composed them. ':pid' had been expanded to
// app.fn_resolve_patient($1::jsonb, $2::jsonb) and DAYS/LIMIT to app.fn_clamp(...); the comment above each function
// is the query (shortened where noted). Actions of kind 'workflow' run in an AI section of the platform workflow and
// are started by engine_api (99_entry.js), not here.
//
// Translation notes:
//  - $n::jsonb->'k' / ->>'k' read the key of an object only (null for a missing key, an array or a scalar).
//  - Text ORDER BY follows the database collation (en_US.utf8) with the strcmp() tie-break Postgres adds (_r30_collate).
//  - timestamptz +/- interval 'n days' is calendar arithmetic in Africa/Cairo (the same local time n days away, also
//    across a DST change), as in the database (_r30_tsPlusDays).
//  - Casts of request values used in a WHERE clause (($2::jsonb->>'x')::uuid) are done once before the scan: Postgres
//    folds them when it plans the query, so bad input fails even when no row would match.
//  - LIMIT without ORDER BY (lifestyle.foods) takes the rows in sheet order (the database took them in heap order).

/* ----------------------------------------------------------------------------------------------- the dispatcher */

/** Runs one API action (the gate has already authorized it) and returns its `data`. */
function api_action(group, action, c, d) {
  const routes = _r30_routes();
  const g = Object.prototype.hasOwnProperty.call(routes, group) ? routes[group] : null;
  const fn = g && Object.prototype.hasOwnProperty.call(g, action) ? g[action] : null;
  if (!fn) throw new Error('not_found: Unknown action');
  if (fn === 'workflow') throw new Error('engine: action ' + group + '.' + action + ' runs in a workflow');
  const data = fn(c, d);
  return data === undefined ? null : data;
}

/** The route table: group -> action -> function, or 'workflow' for the actions an AI section answers. */
function _r30_routes() {
  return {
    auth: {
      login: api_route_auth_login, me: api_route_auth_me, logout: api_route_auth_logout, verify_mfa: api_route_auth_verify_mfa,
      register: api_route_auth_register, forgot_password: api_route_auth_forgot_password, reset_with_token: api_route_auth_reset_with_token,
      change_password: api_route_auth_change_password, mfa_setup: api_route_auth_mfa_setup, mfa_enable: api_route_auth_mfa_enable,
      mfa_disable: api_route_auth_mfa_disable, redeem_invite: api_route_auth_redeem_invite, delete_account: api_route_auth_delete_account,
    },
    today: { get: api_route_today_get, page: api_route_today_page },
    profile: {
      get: api_route_profile_get, state: api_route_profile_state, update: api_route_profile_update, export: api_route_profile_export,
      consents: api_route_profile_consents, set_consent: api_route_profile_set_consent,
      preferences: api_route_profile_preferences, set_preferences: api_route_profile_set_preferences,
      push_subscribe: api_route_profile_push_subscribe, push_unsubscribe: api_route_profile_push_unsubscribe,
      data_request: api_route_profile_data_request, data_requests: api_route_profile_data_requests, access_log: api_route_profile_access_log,
    },
    clinical: {
      summary: api_route_clinical_summary, timeline: api_route_clinical_timeline, add_condition: api_route_clinical_add_condition,
      add_allergy: api_route_clinical_add_allergy, add_medication: api_route_clinical_add_medication,
      stop_medication: api_route_clinical_stop_medication, update_medication: api_route_clinical_update_medication,
      resolve_condition: api_route_clinical_resolve_condition, remove_allergy: api_route_clinical_remove_allergy,
      log_dose: api_route_clinical_log_dose, set_supply: api_route_clinical_set_supply, add_lab: api_route_clinical_add_lab, add_vital: api_route_clinical_add_vital,
      verify: api_route_clinical_verify, acknowledge_finding: api_route_clinical_acknowledge_finding,
      documents: api_route_clinical_documents, upload_document: api_route_clinical_upload_document,
      review_document: api_route_clinical_review_document,
    },
    glucose: {
      list: api_route_glucose_list, add: api_route_glucose_add, read_meter: 'workflow', drive_check: api_route_glucose_drive_check, delete: api_route_glucose_delete, metrics: api_route_glucose_metrics,
      patterns: api_route_glucose_patterns, agp: api_route_glucose_agp, daily: api_route_glucose_daily,
      nightscout_status: api_route_glucose_nightscout_status, nightscout_connect: api_route_glucose_nightscout_connect,
      nightscout_disconnect: api_route_glucose_nightscout_disconnect, page: api_route_glucose_page,
    },
    lifestyle: {
      foods: api_route_lifestyle_foods, food_profile: api_route_lifestyle_food_profile, log_meal: api_route_lifestyle_log_meal, log_activity: api_route_lifestyle_log_activity,
      log_sleep: api_route_lifestyle_log_sleep, checkin: api_route_lifestyle_checkin, summary: api_route_lifestyle_summary,
      page: api_route_lifestyle_page,
    },
    care: {
      plan: api_route_care_plan, plan_history: api_route_care_plan_history, complete_task: api_route_care_complete_task,
      screenings: api_route_care_screenings, record_screening: api_route_care_record_screening, appointments: api_route_care_appointments,
      ramadan: api_route_care_ramadan, ramadan_assess: api_route_care_ramadan_assess, ramadan_fasting: api_route_care_ramadan_fasting,
      wellbeing: api_route_care_wellbeing, wellbeing_submit: api_route_care_wellbeing_submit, sick_status: api_route_care_sick_status,
      sick_start: api_route_care_sick_start, sick_end: api_route_care_sick_end,
      book_appointment: api_route_care_book_appointment, update_appointment: api_route_care_update_appointment,
      cancel_appointment: api_route_care_cancel_appointment, save_plan_draft: api_route_care_save_plan_draft,
      publish_plan: api_route_care_publish_plan, message_team: api_route_care_message_team, messages: api_route_care_messages,
      reply_message: api_route_care_reply_message, caregivers: api_route_care_caregivers, invite_caregiver: api_route_care_invite_caregiver,
      revoke_caregiver: api_route_care_revoke_caregiver, set_caregiver_scopes: api_route_care_set_caregiver_scopes,
      email_invite: api_route_care_email_invite, organizations: api_route_care_organizations, request_link: api_route_care_request_link,
      link_requests: api_route_care_link_requests, page: api_route_care_page, my_doctor: api_route_care_my_doctor,
    },
    intake: { start: 'workflow', answer: 'workflow', free_text: 'workflow' },
    episodes: {
      list: api_route_episodes_list, get: api_route_episodes_get, select_action: api_route_episodes_select_action,
      followup: api_route_episodes_followup,
    },
    network: {
      search: api_route_network_search, facility: api_route_network_facility, update_capacity: api_route_network_update_capacity,
      referrals: api_route_network_referrals, create_referral: api_route_network_create_referral,
      update_referral: api_route_network_update_referral, transfers: api_route_network_transfers,
      create_transfer: api_route_network_create_transfer, update_transfer: api_route_network_update_transfer,
    },
    companion: { send: 'workflow', history: api_route_companion_history },
    insights: {
      list: api_route_insights_list, mark_read: api_route_insights_mark_read, notifications: api_route_insights_notifications,
      mark_notification_read: api_route_insights_mark_notification_read, mark_all_read: api_route_insights_mark_all_read,
    },
    provider: {
      inbox: api_route_provider_inbox, update_inbox: api_route_provider_update_inbox, assign_inbox: api_route_provider_assign_inbox,
      care_gaps: api_route_provider_care_gaps, panel_risk: api_route_provider_panel_risk,
      personalization: api_route_provider_personalization, therapy_review: api_route_provider_therapy_review,
      ai_reviews: api_route_provider_ai_reviews, ai_review_decide: api_route_provider_ai_review_decide,
      panel: api_route_provider_panel, workspace: api_route_provider_workspace, schedule: api_route_provider_schedule,
      generate_brief: 'workflow', stats: api_route_provider_stats, link_requests: api_route_provider_link_requests,
      decide_link: api_route_provider_decide_link, break_glass: api_route_provider_break_glass, find_patient: api_route_provider_find_patient,
      home: api_route_provider_home,
    },
    admin: {
      rag_list: api_route_admin_rag_list, rag_create: api_route_admin_rag_create, rag_get: api_route_admin_rag_get,
      rag_approve: api_route_admin_rag_approve, rag_retire: api_route_admin_rag_retire, guideline_sources: api_route_admin_guideline_sources,
      guideline_check: 'workflow', guideline_approve: api_route_admin_guideline_approve, guideline_dismiss: api_route_admin_guideline_dismiss,
      rag_sync: api_route_admin_rag_sync,
      ai_runs: api_route_admin_ai_runs, rules: api_route_admin_rules, outbox: api_route_admin_outbox, users: api_route_admin_users,
      create_user: api_route_admin_create_user, set_user_active: api_route_admin_set_user_active, reset_password: api_route_admin_reset_password,
      audit: api_route_admin_audit, health: api_route_admin_health, incidents: api_route_admin_incidents,
      incident_resolve: api_route_admin_incident_resolve, quality: api_route_admin_quality, quality_report: api_route_admin_quality_report,
      eval_record: api_route_admin_eval_record, data_requests: api_route_admin_data_requests,
      data_request_resolve: api_route_admin_data_request_resolve, breaches: api_route_admin_breaches,
      report_breach: api_route_admin_report_breach, breach_notified: api_route_admin_breach_notified,
      monitoring: api_route_admin_monitoring, companion_resume: api_route_admin_companion_resume, calibration_queue: api_route_admin_calibration_queue,
      calibration_score: api_route_admin_calibration_score, calibration_report: api_route_admin_calibration_report,
    },
    clinic: {
      request: api_route_clinic_request, patient_page: api_route_clinic_patient_page, choose_slot: api_route_clinic_choose_slot,
      waitlist_answer: api_route_clinic_waitlist_answer, dispatch_page: api_route_clinic_dispatch_page, accept: api_route_clinic_accept,
      offer: api_route_clinic_offer, reassign: api_route_clinic_reassign, decline: api_route_clinic_decline, walk_in: api_route_clinic_walk_in,
      set_status: api_route_clinic_set_status, waitlist_add: api_route_clinic_waitlist_add, waitlist_remove: api_route_clinic_waitlist_remove,
      queue_page: api_route_clinic_queue_page, visit_save: api_route_clinic_visit_save, visit_hints: api_route_clinic_visit_hints,
      visit_sign: api_route_clinic_visit_sign, catalog_page: api_route_clinic_catalog_page, analytics_page: api_route_clinic_analytics_page,
      specialty_save: api_route_clinic_specialty_save, doctor_save: api_route_clinic_doctor_save, service_save: api_route_clinic_service_save,
    },
  };
}

/* -------------------------------------------------------------------------------------------- private helpers */

/** jsonb -> 'key': the value of an object's key; null for a missing key, an array, a scalar or null. */
function _r30_get(j, k) {
  if (j === null || j === undefined || typeof j !== 'object' || Array.isArray(j)) return null;
  if (!Object.prototype.hasOwnProperty.call(j, k) || j[k] === undefined) return null;
  return j[k];
}
/** jsonb ->> 'key' */
function _r30_text(j, k) { return jtext(_r30_get(j, k)); }

/** jsonb - 'key' */
function _r30_minus(j, k) {
  if (j === null || j === undefined) return null;
  if (Array.isArray(j)) return j.filter((x) => x !== k);
  if (typeof j !== 'object') throw new Error('cannot delete from scalar');
  return omit(j, k);
}

/** jsonb || jsonb: objects merge (right wins), anything else concatenates as arrays. */
function _r30_concat(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (isObj(a) && isObj(b)) return { ...a, ...b };
  return [...(Array.isArray(a) ? a : [a]), ...(Array.isArray(b) ? b : [b])];
}

/** text || text (NULL if either side is NULL). */
function _r30_cat(...parts) {
  if (parts.some((p) => p === null || p === undefined)) return null;
  return parts.map(String).join('');
}

/** a = b in SQL: never true when either side is NULL. */
function _r30_eq(a, b) { return a !== null && a !== undefined && b !== null && b !== undefined && a === b; }
/** timestamptz a > b / a >= b / a < b (false when either side is NULL). */
function _r30_tsGt(a, b) { return a !== null && a !== undefined && b !== null && b !== undefined && t(a) > t(b); }
function _r30_tsGe(a, b) { return a !== null && a !== undefined && b !== null && b !== undefined && t(a) >= t(b); }
function _r30_tsLt(a, b) { return a !== null && a !== undefined && b !== null && b !== undefined && t(a) < t(b); }

/** (select expr from ...) used as a value: null without a row, an error for more than one row. */
function _r30_scalar(rows, fn) {
  if (rows.length > 1) throw new Error('more than one row returned by a subquery used as an expression');
  return rows.length ? fn(rows[0]) : null;
}

/**
 * timestamptz + n days (n < 0: minus) in the database time zone: the same Cairo wall-clock time n calendar days away,
 * as now() - make_interval(days => n) gives it.
 */
function _r30_tsPlusDays(ts, n) {
  if (ts === null || ts === undefined || n === null || n === undefined) return null;
  const ms = t(ts);
  const local = localTimestamp(ms);                                    // YYYY-MM-DDTHH:MM:SS (Cairo)
  const frac = String(((ms % 1000) + 1000) % 1000).padStart(3, '0');
  return castTs(addDays(local.slice(0, 10), n) + 'T' + local.slice(11) + '.' + frac);
}

/**
 * ORDER BY key for a text column under the database collation (en_US.utf8): case, accents, spaces and punctuation
 * only break ties, then strcmp() decides between strings the collation finds equal (as Postgres does). Returns a key
 * function for orderBy() that maps each row to the rank of its text among the rows (NULL stays NULL).
 */
function _r30_collate(rows, keyFn) {
  const coll = new Intl.Collator('en-US', { ignorePunctuation: true });
  const vals = Array.from(new Set(rows.map(keyFn).filter((v) => v !== null && v !== undefined).map(String)))
    .sort((a, b) => coll.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0));
  const rank = new Map(vals.map((v, i) => [v, i]));
  return (r) => { const v = keyFn(r); return v === null || v === undefined ? null : rank.get(String(v)); };
}

/** text ILIKE pattern ('%' any text, '_' one character, backslash escapes the next character). */
function _r30_ilike(text, pattern) {
  if (text === null || text === undefined || pattern === null || pattern === undefined) return null;
  const chars = Array.from(String(pattern));
  const esc = (ch) => ch.replace(/[\^$.*+?()[\]{}|\\/]/g, '\\$&');
  let src = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '\\') {
      if (i + 1 >= chars.length) throw new Error('LIKE pattern must not end with escape character');
      src += esc(chars[++i]);
    } else if (ch === '%') src += '[\\s\\S]*';
    else if (ch === '_') src += '[\\s\\S]';
    else src += esc(ch);
  }
  return new RegExp('^' + src + '$', 'iu').test(String(text));
}

/* --------------------------------------------------------------------------------------------------------- auth */

// select app.fn_login($2::jsonb->>'email', $2::jsonb->>'password') as data
function api_route_auth_login(c, d) { return fn_login(_r30_text(d, 'email'), _r30_text(d, 'password')); }

// select ($1::jsonb - 'user_id') || jsonb_build_object('id', $1::jsonb->>'user_id') as data
function api_route_auth_me(c, d) { return _r30_concat(_r30_minus(c, 'user_id'), { id: _r30_text(c, 'user_id') }); }

// select jsonb_build_object('ok', true) as data from (select app.fn_logout($2::jsonb->>'__token')) x
function api_route_auth_logout(c, d) {
  fn_logout(_r30_text(d, '__token'));
  return { ok: true };
}

// select app.api_verify_mfa($2::jsonb) as data
function api_route_auth_verify_mfa(c, d) { return api_verify_mfa(d); }

// select app.api_register($2::jsonb) as data
function api_route_auth_register(c, d) { return api_register(d); }

// select app.api_forgot_password($2::jsonb) as data
function api_route_auth_forgot_password(c, d) { return api_forgot_password(d); }

// select app.api_reset_with_token($2::jsonb) as data
function api_route_auth_reset_with_token(c, d) { return api_reset_with_token(d); }

// select app.api_change_password($1::jsonb, $2::jsonb) as data
function api_route_auth_change_password(c, d) { return api_change_password(c, d); }

// select app.api_mfa_setup($1::jsonb) as data
function api_route_auth_mfa_setup(c, d) { return api_mfa_setup(c); }

// select app.api_mfa_enable($1::jsonb, $2::jsonb) as data
function api_route_auth_mfa_enable(c, d) { return api_mfa_enable(c, d); }

// select app.api_mfa_disable($1::jsonb, $2::jsonb) as data
function api_route_auth_mfa_disable(c, d) { return api_mfa_disable(c, d); }

// select app.api_redeem_invite($1::jsonb, $2::jsonb) as data
function api_route_auth_redeem_invite(c, d) { return api_redeem_invite(c, d); }

// select app.api_delete_account($1::jsonb, $2::jsonb) as data
function api_route_auth_delete_account(c, d) { return api_delete_account(c, d); }

/* -------------------------------------------------------------------------------------------------------- today */

// select app.fn_today(app.fn_resolve_patient($1::jsonb, $2::jsonb)) as data
function api_route_today_get(c, d) { return fn_today(fn_resolve_patient(c, d)); }

/* ------------------------------------------------------------------------------------------------------ profile */

// select app.fn_for_role($1::jsonb, 'patient', app.fn_patient_json(app.fn_resolve_patient($1::jsonb, $2::jsonb))) as data
function api_route_profile_get(c, d) { return fn_for_role(c, 'patient', fn_patient_json(fn_resolve_patient(c, d))); }

// select app.fn_patient_state(app.fn_resolve_patient($1::jsonb, $2::jsonb)) as data
function api_route_profile_state(c, d) { return fn_patient_state(fn_resolve_patient(c, d)); }

// select app.api_profile_update($1::jsonb, $2::jsonb) as data
function api_route_profile_update(c, d) { return api_profile_update(c, d); }

// select app.api_export_data($1::jsonb, $2::jsonb) as data
function api_route_profile_export(c, d) { return api_export_data(c, d); }

// select app.api_consents($1::jsonb, $2::jsonb) as data
function api_route_profile_consents(c, d) { return api_consents(c, d); }

// select app.api_set_consent($1::jsonb, $2::jsonb) as data
function api_route_profile_set_consent(c, d) { return api_set_consent(c, d); }

/* ----------------------------------------------------------------------------------------------------- clinical */

// select app.fn_health_summary(app.fn_resolve_patient($1::jsonb, $2::jsonb)) as data
function api_route_clinical_summary(c, d) { return fn_health_summary(fn_resolve_patient(c, d)); }

// select app.fn_timeline(app.fn_resolve_patient($1::jsonb, $2::jsonb), app.fn_clamp($2::jsonb->>'limit', 50, 1, 200)) as data
function api_route_clinical_timeline(c, d) {
  return fn_timeline(fn_resolve_patient(c, d), fn_clamp(_r30_text(d, 'limit'), 50, 1, 200));
}

// select app.api_add_condition($1::jsonb, $2::jsonb) as data
function api_route_clinical_add_condition(c, d) { return api_add_condition(c, d); }

// select app.api_add_allergy($1::jsonb, $2::jsonb) as data
function api_route_clinical_add_allergy(c, d) { return api_add_allergy(c, d); }

// select app.api_add_medication($1::jsonb, $2::jsonb) as data
function api_route_clinical_add_medication(c, d) { return api_add_medication(c, d); }

// select app.api_stop_medication($1::jsonb, $2::jsonb) as data
function api_route_clinical_stop_medication(c, d) { return api_stop_medication(c, d); }

// select app.api_update_medication($1::jsonb, $2::jsonb) as data
function api_route_clinical_update_medication(c, d) { return api_update_medication(c, d); }

// select app.api_resolve_condition($1::jsonb, $2::jsonb) as data
function api_route_clinical_resolve_condition(c, d) { return api_resolve_condition(c, d); }

// select app.api_remove_allergy($1::jsonb, $2::jsonb) as data
function api_route_clinical_remove_allergy(c, d) { return api_remove_allergy(c, d); }

// select app.api_log_dose($1::jsonb, $2::jsonb) as data
function api_route_clinical_log_dose(c, d) { return api_log_dose(c, d); }
// select app.api_set_supply($1::jsonb, $2::jsonb) as data
function api_route_clinical_set_supply(c, d) { return api_set_supply(c, d); }

// select app.api_add_lab($1::jsonb, $2::jsonb) as data
function api_route_clinical_add_lab(c, d) { return api_add_lab(c, d); }

// select app.api_add_vital($1::jsonb, $2::jsonb) as data
function api_route_clinical_add_vital(c, d) { return api_add_vital(c, d); }

// select app.api_verify($1::jsonb, $2::jsonb) as data
function api_route_clinical_verify(c, d) { return api_verify(c, d); }

// select app.api_ack_finding($1::jsonb, $2::jsonb) as data
function api_route_clinical_acknowledge_finding(c, d) { return api_ack_finding(c, d); }

/*
select coalesce(jsonb_agg(app.fn_document_json(dd) order by dd.created_at desc), '[]'::jsonb) as data
  from app.documents dd where dd.patient_id = app.fn_resolve_patient($1::jsonb, $2::jsonb)
*/
function api_route_clinical_documents(c, d) {
  const pid = fn_resolve_patient(c, d);
  const rows = dbWhere('documents', (dd) => _r30_eq(dd.patient_id, pid));
  return jsonAgg(orderBy(rows, [(dd) => t(dd.created_at), 'desc']).map((dd) => fn_document_json(dd))) ?? [];
}

// select app.api_upload_document($1::jsonb, $2::jsonb) as data
function api_route_clinical_upload_document(c, d) { return api_upload_document(c, d); }

// select app.api_review_document($1::jsonb, $2::jsonb) as data
function api_route_clinical_review_document(c, d) { return api_review_document(c, d); }

/* ------------------------------------------------------------------------------------------------------ glucose */

/*
select coalesce(jsonb_agg(jsonb_build_object('id', id, 'value_mgdl', value_mgdl, 'measured_at', measured_at, 'source', source, 'context', context)
       order by measured_at), '[]'::jsonb) as data
  from app.glucose_readings where patient_id = app.fn_resolve_patient($1::jsonb, $2::jsonb)
   and measured_at > now() - make_interval(days => app.fn_clamp($2::jsonb->>'days', 14, 1, 90))
*/
function api_route_glucose_list(c, d) {
  const pid = fn_resolve_patient(c, d);
  const since = _r30_tsPlusDays(now(), -fn_clamp(_r30_text(d, 'days'), 14, 1, 90));
  const rows = dbWhere('glucose_readings', (r) => _r30_eq(r.patient_id, pid) && _r30_tsGt(r.measured_at, since));
  return jsonAgg(orderBy(rows, (r) => t(r.measured_at)).map((r) => ({
    id: r.id, value_mgdl: r.value_mgdl, measured_at: r.measured_at, source: r.source, context: r.context,
  }))) ?? [];
}

// select app.api_glucose_add($1::jsonb, $2::jsonb) as data
function api_route_glucose_add(c, d) { return api_glucose_add(c, d); }

// select app.api_delete_glucose($1::jsonb, $2::jsonb) as data
function api_route_glucose_delete(c, d) { return api_delete_glucose(c, d); }

// select app.fn_glucose_metrics(app.fn_resolve_patient($1::jsonb, $2::jsonb), app.fn_clamp($2::jsonb->>'days', 14, 1, 90)) as data
function api_route_glucose_metrics(c, d) { return fn_glucose_metrics(fn_resolve_patient(c, d), fn_clamp(_r30_text(d, 'days'), 14, 1, 90)); }

// select app.fn_detect_patterns(app.fn_resolve_patient($1::jsonb, $2::jsonb), app.fn_clamp($2::jsonb->>'days', 14, 1, 90)) as data
function api_route_glucose_patterns(c, d) { return fn_detect_patterns(fn_resolve_patient(c, d), fn_clamp(_r30_text(d, 'days'), 14, 1, 90)); }

// select app.fn_glucose_agp(app.fn_resolve_patient($1::jsonb, $2::jsonb), app.fn_clamp($2::jsonb->>'days', 14, 1, 90)) as data
function api_route_glucose_agp(c, d) { return fn_glucose_agp(fn_resolve_patient(c, d), fn_clamp(_r30_text(d, 'days'), 14, 1, 90)); }

// select app.fn_glucose_daily(app.fn_resolve_patient($1::jsonb, $2::jsonb), app.fn_clamp($2::jsonb->>'days', 14, 1, 90)) as data
function api_route_glucose_daily(c, d) { return fn_glucose_daily(fn_resolve_patient(c, d), fn_clamp(_r30_text(d, 'days'), 14, 1, 90)); }

// select app.fn_nightscout_json(app.fn_resolve_patient($1::jsonb, $2::jsonb)) as data
function api_route_glucose_nightscout_status(c, d) { return fn_nightscout_json(fn_resolve_patient(c, d)); }

// select app.api_nightscout_connect($1::jsonb, $2::jsonb) as data
function api_route_glucose_nightscout_connect(c, d) { return api_nightscout_connect(c, d); }

// select app.api_nightscout_disconnect($1::jsonb, $2::jsonb) as data
function api_route_glucose_nightscout_disconnect(c, d) { return api_nightscout_disconnect(c, d); }

/* ---------------------------------------------------------------------------------------------------- lifestyle */

/*
select coalesce(jsonb_agg(to_jsonb(f) order by f.category, f.name), '[]'::jsonb) as data
  from (select * from app.foods
         where (nullif($2::jsonb->>'category', '') is null or category = $2::jsonb->>'category')
           and (nullif($2::jsonb->>'q', '') is null or (name || ' ' || name_ar) ilike '%' || ($2::jsonb->>'q') || '%')
         limit 60) f
*/
function api_route_lifestyle_foods(c, d) {
  const category = _r30_text(d, 'category');
  const q = _r30_text(d, 'q');
  const f = dbWhere('foods', (r) =>
    (nullif(category, '') === null || _r30_eq(r.category, category))
    && (nullif(q, '') === null || _r30_ilike(_r30_cat(r.name, ' ', r.name_ar), _r30_cat('%', q, '%')) === true)).slice(0, 60);
  return jsonAgg(orderBy(f, _r30_collate(f, (r) => r.category), _r30_collate(f, (r) => r.name)).map((r) => ({ ...r }))) ?? [];
}

// select app.api_log_meal($1::jsonb, $2::jsonb) as data
function api_route_lifestyle_log_meal(c, d) { return api_log_meal(c, d); }

/*
insert into app.activity_logs(patient_id, date, steps, minutes, type)
values (app.fn_resolve_patient($1::jsonb, $2::jsonb), app.fn_log_date($2::jsonb->>'date'), app.fn_num_in($2::jsonb, 'steps', 0, 100000, 0)::int,
        app.fn_num_in($2::jsonb, 'minutes', 0, 1440, 0)::int, left(coalesce(nullif($2::jsonb->>'type', ''), 'walking'), 30))
on conflict (patient_id, date, type) do update set steps = app.activity_logs.steps + excluded.steps, minutes = app.activity_logs.minutes + excluded.minutes
returning jsonb_build_object('ok', true) as data
*/
function api_route_lifestyle_log_activity(c, d) {
  const values = {
    patient_id: fn_resolve_patient(c, d),
    date: fn_log_date(_r30_text(d, 'date')),
    steps: castInt(fn_num_in(d, 'steps', 0, 100000, 0)),
    minutes: castInt(fn_num_in(d, 'minutes', 0, 1440, 0)),
    type: left(coalesce(nullif(_r30_text(d, 'type'), ''), 'walking'), 30),
  };
  dbInsert('activity_logs', values, {
    onConflict: { cols: ['patient_id', 'date', 'type'], set: (old, excluded) => ({ steps: old.steps + excluded.steps, minutes: old.minutes + excluded.minutes }) },
  });
  return { ok: true };
}

/*
insert into app.sleep_logs(patient_id, date, hours, quality)
values (app.fn_resolve_patient($1::jsonb, $2::jsonb), app.fn_log_date($2::jsonb->>'date'), app.fn_num_in($2::jsonb, 'hours', 0, 24),
        app.fn_num_in($2::jsonb, 'quality', 1, 5)::int)
on conflict (patient_id, date) do update set hours = excluded.hours, quality = excluded.quality
returning jsonb_build_object('ok', true) as data
*/
function api_route_lifestyle_log_sleep(c, d) {
  const values = {
    patient_id: fn_resolve_patient(c, d),
    date: fn_log_date(_r30_text(d, 'date')),
    hours: fn_num_in(d, 'hours', 0, 24),
    quality: castInt(fn_num_in(d, 'quality', 1, 5)),
  };
  dbInsert('sleep_logs', values, {
    onConflict: { cols: ['patient_id', 'date'], set: (old, excluded) => ({ hours: excluded.hours, quality: excluded.quality }) },
  });
  return { ok: true };
}

/*
insert into app.checkins(patient_id, mood, stress, energy, note)
values (app.fn_resolve_patient($1::jsonb, $2::jsonb), app.fn_num_in($2::jsonb, 'mood', 1, 5)::int, app.fn_num_in($2::jsonb, 'stress', 1, 5)::int,
        app.fn_num_in($2::jsonb, 'energy', 1, 5)::int, left(nullif(trim(coalesce($2::jsonb->>'note', '')), ''), 500))
returning jsonb_build_object('ok', true) as data
*/
function api_route_lifestyle_checkin(c, d) {
  dbInsert('checkins', {
    patient_id: fn_resolve_patient(c, d),
    mood: castInt(fn_num_in(d, 'mood', 1, 5)),
    stress: castInt(fn_num_in(d, 'stress', 1, 5)),
    energy: castInt(fn_num_in(d, 'energy', 1, 5)),
    note: left(nullif(trimChars(coalesce(_r30_text(d, 'note'), ''), ' '), ''), 500),
  });
  return { ok: true };
}

// select app.fn_lifestyle_summary(app.fn_resolve_patient($1::jsonb, $2::jsonb), app.fn_clamp($2::jsonb->>'days', 7, 1, 90)) as data
function api_route_lifestyle_summary(c, d) { return fn_lifestyle_summary(fn_resolve_patient(c, d), fn_clamp(_r30_text(d, 'days'), 7, 1, 90)); }

/* --------------------------------------------------------------------------------------------------------- care */

/*
with p as (select app.fn_resolve_patient($1::jsonb, $2::jsonb) as pid)
select jsonb_build_object(
  'active', (select app.fn_plan_json(id) from app.care_plans, p where patient_id = p.pid and status = 'ACTIVE'),
  'draft', (select app.fn_plan_json(id) from app.care_plans, p where patient_id = p.pid and status = 'DRAFT'),
  'tasks', coalesce((select jsonb_agg(app.fn_task_json(t) order by t.due_at nulls last) from app.care_tasks t, p
                      where t.patient_id = p.pid and t.status = 'pending'), '[]'::jsonb)) as data from p
*/
function api_route_care_plan(c, d) {
  const pid = fn_resolve_patient(c, d);
  const active = _r30_scalar(dbWhere('care_plans', (r) => _r30_eq(r.patient_id, pid) && r.status === 'ACTIVE'), (r) => fn_plan_json(r.id));
  const draft = _r30_scalar(dbWhere('care_plans', (r) => _r30_eq(r.patient_id, pid) && r.status === 'DRAFT'), (r) => fn_plan_json(r.id));
  const tasks = dbWhere('care_tasks', (x) => _r30_eq(x.patient_id, pid) && x.status === 'pending');
  return {
    active: active === undefined ? null : active,
    draft: draft === undefined ? null : draft,
    tasks: jsonAgg(orderBy(tasks, [(x) => t(x.due_at), 'asc', 'nulls last']).map((x) => fn_task_json(x))) ?? [],
  };
}

/*
select coalesce(jsonb_agg(app.fn_plan_json(id) order by version desc), '[]'::jsonb) as data
  from app.care_plans where patient_id = app.fn_resolve_patient($1::jsonb, $2::jsonb) and status <> 'DRAFT'
*/
function api_route_care_plan_history(c, d) {
  const pid = fn_resolve_patient(c, d);
  const rows = dbWhere('care_plans', (r) => _r30_eq(r.patient_id, pid) && r.status !== null && r.status !== 'DRAFT');
  return jsonAgg(orderBy(rows, [(r) => r.version, 'desc']).map((r) => fn_plan_json(r.id))) ?? [];
}

/*
with u as (update app.care_tasks set status = coalesce(nullif($2::jsonb->>'status', ''), 'done'), completed_at = now()
            where id = ($2::jsonb->>'task_id')::uuid and app.fn_can_access_patient($1::jsonb, patient_id) returning 1)
select case when exists (select 1 from u) then jsonb_build_object('ok', true) else app.fn_raise('not_found: task not found') end as data
*/
function api_route_care_complete_task(c, d) {
  const id = castUuid(_r30_text(d, 'task_id'));
  const u = dbWhere('care_tasks', (r) => _r30_eq(r.id, id) && fn_can_access_patient(c, r.patient_id) === true);
  for (const r of u) dbUpdate('care_tasks', r, { status: coalesce(nullif(_r30_text(d, 'status'), ''), 'done'), completed_at: now() });
  return u.length ? { ok: true } : fn_raise('not_found: task not found');
}

// select app.fn_screenings(app.fn_resolve_patient($1::jsonb, $2::jsonb)) as data
function api_route_care_screenings(c, d) { return fn_screenings(fn_resolve_patient(c, d)); }

// select app.api_record_screening($1::jsonb, $2::jsonb) as data
function api_route_care_record_screening(c, d) { return api_record_screening(c, d); }

/*
select app.fn_for_role($1::jsonb, 'appointment', coalesce(jsonb_agg(app.fn_appointment_json(a) order by a.starts_at desc), '[]'::jsonb)) as data
  from app.appointments a where a.patient_id = app.fn_resolve_patient($1::jsonb, $2::jsonb)
*/
function api_route_care_appointments(c, d) {
  const pid = fn_resolve_patient(c, d);
  const rows = dbWhere('appointments', (a) => _r30_eq(a.patient_id, pid));
  return fn_for_role(c, 'appointment', jsonAgg(orderBy(rows, [(a) => t(a.starts_at), 'desc']).map((a) => fn_appointment_json(a))) ?? []);
}

// select app.fn_for_role($1::jsonb, 'appointment', app.api_book_appointment($1::jsonb, $2::jsonb)) as data
function api_route_care_book_appointment(c, d) { return fn_for_role(c, 'appointment', api_book_appointment(c, d)); }

// select app.fn_for_role($1::jsonb, 'appointment', app.api_update_appointment($1::jsonb, $2::jsonb)) as data
function api_route_care_update_appointment(c, d) { return fn_for_role(c, 'appointment', api_update_appointment(c, d)); }

// select app.api_cancel_appointment($1::jsonb, $2::jsonb) as data
function api_route_care_cancel_appointment(c, d) { return api_cancel_appointment(c, d); }

// select app.api_save_plan_draft($1::jsonb, $2::jsonb) as data
function api_route_care_save_plan_draft(c, d) { return api_save_plan_draft(c, d); }

// select app.fn_publish_plan($1::jsonb, ($2::jsonb->>'plan_id')::uuid) as data
function api_route_care_publish_plan(c, d) { return fn_publish_plan(c, castUuid(_r30_text(d, 'plan_id'))); }

// select app.api_message_team($1::jsonb, $2::jsonb) as data
function api_route_care_message_team(c, d) { return api_message_team(c, d); }

// select app.api_team_messages($1::jsonb, $2::jsonb) as data
function api_route_care_messages(c, d) { return api_team_messages(c, d); }

// select app.api_reply_message($1::jsonb, $2::jsonb) as data
function api_route_care_reply_message(c, d) { return api_reply_message(c, d); }

// select app.api_caregivers($1::jsonb, $2::jsonb) as data
function api_route_care_caregivers(c, d) { return api_caregivers(c, d); }

// select app.api_invite_caregiver($1::jsonb, $2::jsonb) as data
function api_route_care_invite_caregiver(c, d) { return api_invite_caregiver(c, d); }

// select app.api_revoke_caregiver($1::jsonb, $2::jsonb) as data
function api_route_care_revoke_caregiver(c, d) { return api_revoke_caregiver(c, d); }

// select app.api_set_caregiver_scopes($1::jsonb, $2::jsonb) as data
function api_route_care_set_caregiver_scopes(c, d) { return api_set_caregiver_scopes(c, d); }

// select app.api_email_invite($1::jsonb, $2::jsonb) as data
function api_route_care_email_invite(c, d) { return api_email_invite(c, d); }

/*
select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'name_ar', o.name_ar, 'type', o.type,
       'city', (select f.city from app.facilities f where f.organization_id = o.id limit 1)) order by o.name), '[]'::jsonb) as data
  from app.organizations o where o.type <> 'network'
*/
function api_route_care_organizations(c, d) {
  const rows = dbWhere('organizations', (o) => o.type !== null && o.type !== 'network');
  return jsonAgg(orderBy(rows, _r30_collate(rows, (o) => o.name)).map((o) => {
    const f = dbOne('facilities', (x) => _r30_eq(x.organization_id, o.id));
    return { id: o.id, name: o.name, name_ar: o.name_ar, type: o.type, city: f ? f.city : null };
  })) ?? [];
}

// select app.api_request_link($1::jsonb, $2::jsonb) as data
function api_route_care_request_link(c, d) { return api_request_link(c, d); }

/*
select coalesce(jsonb_agg(app.fn_link_request_json(r) order by r.created_at desc), '[]'::jsonb) as data
  from app.link_requests r where r.patient_id = app.fn_resolve_patient($1::jsonb, $2::jsonb)
*/
function api_route_care_link_requests(c, d) {
  const pid = fn_resolve_patient(c, d);
  const rows = dbWhere('link_requests', (r) => _r30_eq(r.patient_id, pid));
  return jsonAgg(orderBy(rows, [(r) => t(r.created_at), 'desc']).map((r) => fn_link_request_json(r))) ?? [];
}

/* ----------------------------------------------------------------------------------------------------- episodes */

/*
select coalesce(jsonb_agg(app.fn_episode_json(e.id) order by e.started_at desc), '[]'::jsonb) as data
  from app.episodes e where e.patient_id = app.fn_resolve_patient($1::jsonb, $2::jsonb)
*/
function api_route_episodes_list(c, d) {
  const pid = fn_resolve_patient(c, d);
  const rows = dbWhere('episodes', (e) => _r30_eq(e.patient_id, pid));
  return jsonAgg(orderBy(rows, [(e) => t(e.started_at), 'desc']).map((e) => fn_episode_json(e.id))) ?? [];
}

/*
select coalesce((select app.fn_episode_json(e.id) || jsonb_build_object('next_question',
                   case when e.status in ('DRAFT','INTAKE_IN_PROGRESS') then app.fn_next_question(e.answers) end)
                   from app.episodes e
                  where e.id = ($2::jsonb->>'episode_id')::uuid and app.fn_can_access_patient($1::jsonb, e.patient_id)),
                app.fn_raise('not_found: episode not found')) as data
*/
function api_route_episodes_get(c, d) {
  const id = castUuid(_r30_text(d, 'episode_id'));
  const rows = dbWhere('episodes', (e) => _r30_eq(e.id, id) && fn_can_access_patient(c, e.patient_id) === true);
  const v = _r30_scalar(rows, (e) => _r30_concat(fn_episode_json(e.id), {
    next_question: e.status === 'DRAFT' || e.status === 'INTAKE_IN_PROGRESS' ? coalesce(fn_next_question(e.answers), null) : null,
  }));
  return v !== null && v !== undefined ? v : fn_raise('not_found: episode not found');
}

// select app.api_episode_action($1::jsonb, $2::jsonb) as data
function api_route_episodes_select_action(c, d) { return api_episode_action(c, d); }

// select app.api_episode_followup($1::jsonb, $2::jsonb) as data
function api_route_episodes_followup(c, d) { return api_episode_followup(c, d); }

/* ------------------------------------------------------------------------------------------------------ network */

// select app.fn_match_facilities($2::jsonb) as data
function api_route_network_search(c, d) { return fn_match_facilities(d); }

/*
select coalesce((select app.fn_facility_json(f, null, null) from app.facilities f where f.id = ($2::jsonb->>'facility_id')::uuid),
                app.fn_raise('not_found: facility not found')) as data
*/
function api_route_network_facility(c, d) {
  const id = castUuid(_r30_text(d, 'facility_id'));
  const v = _r30_scalar(dbWhere('facilities', (f) => _r30_eq(f.id, id)), (f) => fn_facility_json(f, null, null));
  return v !== null && v !== undefined ? v : fn_raise('not_found: facility not found');
}

// select app.api_update_capacity($1::jsonb, $2::jsonb) as data
function api_route_network_update_capacity(c, d) { return api_update_capacity(c, d); }

/*
select app.fn_for_role($1::jsonb, 'referral', coalesce(jsonb_agg(app.fn_referral_json(r) order by r.created_at desc), '[]'::jsonb)) as data
  from app.referrals r
 where app.fn_can_access_patient($1::jsonb, r.patient_id)
   and (nullif($2::jsonb->>'patient_id', '') is null or r.patient_id = ($2::jsonb->>'patient_id')::uuid)
*/
function api_route_network_referrals(c, d) {
  const only = nullif(_r30_text(d, 'patient_id'), '');
  const onlyId = only === null ? null : castUuid(only);
  const rows = dbWhere('referrals', (r) => fn_can_access_patient(c, r.patient_id) === true && (only === null || _r30_eq(r.patient_id, onlyId)));
  return fn_for_role(c, 'referral', jsonAgg(orderBy(rows, [(r) => t(r.created_at), 'desc']).map((r) => fn_referral_json(r))) ?? []);
}

// select app.api_create_referral($1::jsonb, $2::jsonb) as data
function api_route_network_create_referral(c, d) { return api_create_referral(c, d); }

// select app.fn_for_role($1::jsonb, 'referral', app.api_update_referral($1::jsonb, $2::jsonb)) as data
function api_route_network_update_referral(c, d) { return fn_for_role(c, 'referral', api_update_referral(c, d)); }

// select app.fn_transfers_list($1::jsonb, $2::jsonb) as data
function api_route_network_transfers(c, d) { return fn_transfers_list(c, d); }

// select app.api_create_transfer($1::jsonb, $2::jsonb) as data
function api_route_network_create_transfer(c, d) { return api_create_transfer(c, d); }

// select app.api_update_transfer($1::jsonb, $2::jsonb) as data
function api_route_network_update_transfer(c, d) { return api_update_transfer(c, d); }

/* ---------------------------------------------------------------------------------------------------- companion */

// select app.fn_companion_history($1::jsonb, $2::jsonb) as data
function api_route_companion_history(c, d) { return fn_companion_history(c, d); }

/* ----------------------------------------------------------------------------------------------------- insights */

/*
select coalesce(jsonb_agg(app.fn_insight_json(i) order by i.created_at desc), '[]'::jsonb) as data
  from (select * from app.patient_insights where patient_id = app.fn_resolve_patient($1::jsonb, $2::jsonb) order by created_at desc
        limit app.fn_clamp($2::jsonb->>'limit', 30, 1, 100)) i
*/
function api_route_insights_list(c, d) {
  const pid = fn_resolve_patient(c, d);
  const limit = fn_clamp(_r30_text(d, 'limit'), 30, 1, 100);
  const i = orderBy(dbWhere('patient_insights', (r) => _r30_eq(r.patient_id, pid)), [(r) => t(r.created_at), 'desc']).slice(0, limit);
  return jsonAgg(orderBy(i, [(r) => t(r.created_at), 'desc']).map((r) => fn_insight_json(r))) ?? [];
}

/*
with u as (update app.patient_insights set read_at = now()
            where id = ($2::jsonb->>'insight_id')::uuid and app.fn_can_access_patient($1::jsonb, patient_id) returning 1)
select case when exists (select 1 from u) then jsonb_build_object('ok', true) else app.fn_raise('not_found: insight not found') end as data
*/
function api_route_insights_mark_read(c, d) {
  const id = castUuid(_r30_text(d, 'insight_id'));
  const u = dbWhere('patient_insights', (r) => _r30_eq(r.id, id) && fn_can_access_patient(c, r.patient_id) === true);
  for (const r of u) dbUpdate('patient_insights', r, { read_at: now() });
  return u.length ? { ok: true } : fn_raise('not_found: insight not found');
}

/*
select coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'title_ar', title_ar, 'body', body, 'body_ar', body_ar, 'kind', kind,
       'created_at', created_at, 'read_at', read_at) order by created_at desc), '[]'::jsonb) as data
  from (select * from app.notifications where user_id = ($1::jsonb->>'user_id')::uuid order by created_at desc limit 50) n
*/
function api_route_insights_notifications(c, d) {
  const uid = castUuid(_r30_text(c, 'user_id'));
  const n = orderBy(dbWhere('notifications', (r) => _r30_eq(r.user_id, uid)), [(r) => t(r.created_at), 'desc']).slice(0, 50);
  return jsonAgg(orderBy(n, [(r) => t(r.created_at), 'desc']).map((r) => ({
    id: r.id, title: r.title, title_ar: r.title_ar, body: r.body, body_ar: r.body_ar, kind: r.kind, created_at: r.created_at, read_at: r.read_at,
  }))) ?? [];
}

/*
with u as (update app.notifications set read_at = now()
            where id = ($2::jsonb->>'notification_id')::uuid and user_id = ($1::jsonb->>'user_id')::uuid returning 1)
select case when exists (select 1 from u) then jsonb_build_object('ok', true) else app.fn_raise('not_found: notification not found') end as data
*/
function api_route_insights_mark_notification_read(c, d) {
  const id = castUuid(_r30_text(d, 'notification_id'));
  const uid = castUuid(_r30_text(c, 'user_id'));
  const u = dbWhere('notifications', (r) => _r30_eq(r.id, id) && _r30_eq(r.user_id, uid));
  for (const r of u) dbUpdate('notifications', r, { read_at: now() });
  return u.length ? { ok: true } : fn_raise('not_found: notification not found');
}

/*
with u as (update app.notifications set read_at = now() where user_id = ($1::jsonb->>'user_id')::uuid and read_at is null returning 1)
select jsonb_build_object('ok', true, 'count', (select count(*) from u)) as data
*/
function api_route_insights_mark_all_read(c, d) {
  const uid = castUuid(_r30_text(c, 'user_id'));
  const count = dbUpdateWhere('notifications', (r) => _r30_eq(r.user_id, uid) && r.read_at === null, { read_at: now() });
  return { ok: true, count };
}

/* ----------------------------------------------------------------------------------------------------- provider */

// select app.fn_inbox_list($1::jsonb, $2::jsonb) as data
function api_route_provider_inbox(c, d) { return fn_inbox_list(c, d); }

// select app.api_update_inbox($1::jsonb, $2::jsonb) as data
function api_route_provider_update_inbox(c, d) { return api_update_inbox(c, d); }

// select app.api_assign_inbox($1::jsonb, $2::jsonb) as data
function api_route_provider_assign_inbox(c, d) { return api_assign_inbox(c, d); }

// select app.fn_panel($1::jsonb, $2::jsonb->>'q') as data
function api_route_provider_panel(c, d) { return fn_panel(c, _r30_text(d, 'q')); }

// select app.fn_audit_read($1::jsonb, app.fn_resolve_patient($1::jsonb, $2::jsonb), 'workspace',
//                          app.fn_workspace(app.fn_resolve_patient($1::jsonb, $2::jsonb))) as data
function api_route_provider_workspace(c, d) {
  return fn_audit_read(c, fn_resolve_patient(c, d), 'workspace', fn_workspace(fn_resolve_patient(c, d)));
}

/*
select app.fn_for_role($1::jsonb, 'appointment', coalesce(jsonb_agg(app.fn_appointment_json(a) order by a.starts_at), '[]'::jsonb)) as data
  from app.appointments a
 where app.fn_can_access_patient($1::jsonb, a.patient_id)
   and a.starts_at >= coalesce(nullif($2::jsonb->>'from', '')::timestamptz, date_trunc('day', now()))
   and a.starts_at < coalesce(nullif($2::jsonb->>'to', '')::timestamptz, date_trunc('day', now()) + interval '7 days')
   and a.status <> 'cancelled'
*/
function api_route_provider_schedule(c, d) {
  const from = coalesce(castTs(nullif(_r30_text(d, 'from'), '')), dateTrunc('day', now()));
  const to = coalesce(castTs(nullif(_r30_text(d, 'to'), '')), _r30_tsPlusDays(dateTrunc('day', now()), 7));
  const rows = dbWhere('appointments', (a) => a.status !== null && a.status !== 'cancelled'
    && _r30_tsGe(a.starts_at, from) && _r30_tsLt(a.starts_at, to) && fn_can_access_patient(c, a.patient_id) === true);
  return fn_for_role(c, 'appointment', jsonAgg(orderBy(rows, (a) => t(a.starts_at)).map((a) => fn_appointment_json(a))) ?? []);
}

// select app.fn_provider_stats($1::jsonb) as data
function api_route_provider_stats(c, d) { return fn_provider_stats(c); }

/*
select coalesce(jsonb_agg(app.fn_link_request_json(r) order by r.status = 'pending' desc, r.created_at desc), '[]'::jsonb) as data
  from app.link_requests r
 where r.organization_id in (select organization_id from app.memberships where user_id = ($1::jsonb->>'user_id')::uuid)
*/
function api_route_provider_link_requests(c, d) {
  const uid = castUuid(_r30_text(c, 'user_id'));
  const orgs = dbWhere('memberships', (m) => _r30_eq(m.user_id, uid)).map((m) => m.organization_id).filter((o) => o !== null);
  const rows = dbWhere('link_requests', (r) => r.organization_id !== null && orgs.includes(r.organization_id));
  return jsonAgg(orderBy(rows,
    [(r) => (r.status === null ? null : r.status === 'pending' ? 1 : 0), 'desc'],
    [(r) => t(r.created_at), 'desc']).map((r) => fn_link_request_json(r))) ?? [];
}

// select app.api_decide_link($1::jsonb, $2::jsonb) as data
function api_route_provider_decide_link(c, d) { return api_decide_link(c, d); }

// select app.api_break_glass($1::jsonb, $2::jsonb) as data
function api_route_provider_break_glass(c, d) { return api_break_glass(c, d); }

// select app.api_find_patient($1::jsonb, $2::jsonb) as data
function api_route_provider_find_patient(c, d) { return api_find_patient(c, d); }

/* -------------------------------------------------------------------------------------------------------- admin */

/*
select coalesce(jsonb_agg(app.fn_rag_document_json(d) order by d.status = 'draft' desc, d.created_at desc), '[]'::jsonb) as data
  from app.rag_documents d where d.status <> 'retired' or d.created_at > now() - interval '180 days'
*/
function api_route_admin_rag_list(c, d) {
  const since = _r30_tsPlusDays(now(), -180);
  const rows = dbWhere('rag_documents', (x) => (x.status !== null && x.status !== 'retired') || _r30_tsGt(x.created_at, since));
  return jsonAgg(orderBy(rows,
    [(x) => (x.status === null ? null : x.status === 'draft' ? 1 : 0), 'desc'],
    [(x) => t(x.created_at), 'desc']).map((x) => fn_rag_document_json(x))) ?? [];
}

/*
insert into app.rag_documents(title, source, version, language, region, population, content, review_date, created_by, audience)
values ($2::jsonb->>'title', $2::jsonb->>'source', coalesce(nullif($2::jsonb->>'version', ''), '1'), coalesce(nullif($2::jsonb->>'language', ''), 'en'),
        $2::jsonb->>'region', $2::jsonb->>'population', $2::jsonb->>'content', nullif($2::jsonb->>'review_date', '')::date, ($1::jsonb->>'user_id')::uuid,
        coalesce(nullif($2::jsonb->>'audience', ''), 'patient'))
returning app.fn_rag_document_json(rag_documents.*) as data
*/
function api_route_admin_rag_create(c, d) {
  const row = dbInsert('rag_documents', {
    title: _r30_text(d, 'title'),
    source: _r30_text(d, 'source'),
    version: coalesce(nullif(_r30_text(d, 'version'), ''), '1'),
    language: coalesce(nullif(_r30_text(d, 'language'), ''), 'en'),
    region: _r30_text(d, 'region'),
    population: _r30_text(d, 'population'),
    content: _r30_text(d, 'content'),
    review_date: castDate(nullif(_r30_text(d, 'review_date'), '')),
    created_by: castUuid(_r30_text(c, 'user_id')),
    audience: coalesce(nullif(_r30_text(d, 'audience'), ''), 'patient'),
  });
  return fn_rag_document_json(row);
}

/*
select coalesce((select app.fn_rag_document_json(d) || jsonb_build_object('content', d.content) from app.rag_documents d
                  where d.id = nullif($2::jsonb->>'document_id', '')::uuid),
                app.fn_raise('not_found: document not found')) as data
*/
function api_route_admin_rag_get(c, d) {
  const id = castUuid(nullif(_r30_text(d, 'document_id'), ''));
  const rows = dbWhere('rag_documents', (x) => _r30_eq(x.id, id));
  const v = _r30_scalar(rows, (x) => _r30_concat(fn_rag_document_json(x), { content: x.content }));
  return v !== null && v !== undefined ? v : fn_raise('not_found: document not found');
}

// select app.api_rag_approve($1::jsonb, $2::jsonb) as data
function api_route_admin_rag_approve(c, d) { return api_rag_approve(c, d); }

/*
with u as (update app.rag_documents set status = 'retired' where id = ($2::jsonb->>'document_id')::uuid returning *),
 d as (delete from app.rag_chunks where document_id in (select id from u))
select app.fn_rag_document_json(u.*) as data from u
union all select app.fn_raise('not_found: document not found') where not exists (select 1 from u)
*/
// select app.api_rag_sync($1::jsonb) as data
function api_route_admin_rag_sync(c, d) {
  return api_rag_sync(c);
}

function api_route_admin_rag_retire(c, d) {
  const id = castUuid(_r30_text(d, 'document_id'));
  const u = dbWhere('rag_documents', (x) => _r30_eq(x.id, id));
  for (const x of u) dbUpdate('rag_documents', x, { status: 'retired' });
  const ids = u.map((x) => x.id);
  dbDeleteWhere('rag_chunks', (ch) => ch.document_id !== null && ids.includes(ch.document_id));
  if (!u.length) return fn_raise('not_found: document not found');
  return fn_rag_document_json(u[0]);
}

// select app.api_guideline_sources($1::jsonb, $2::jsonb) as data
function api_route_admin_guideline_sources(c, d) { return api_guideline_sources(c, d); }

// select app.api_guideline_approve($1::jsonb, $2::jsonb) as data
function api_route_admin_guideline_approve(c, d) { return api_guideline_approve(c, d); }

// select app.api_guideline_dismiss($1::jsonb, $2::jsonb) as data
function api_route_admin_guideline_dismiss(c, d) { return api_guideline_dismiss(c, d); }

// select app.fn_admin_ai_runs($1::jsonb, $2::jsonb) as data
function api_route_admin_ai_runs(c, d) { return fn_admin_ai_runs(c, d); }

/*
select jsonb_build_object(
  'safety_rules', (select coalesce(jsonb_agg(to_jsonb(s) order by s.code), '[]'::jsonb) from app.safety_rules s),
  'care_level_rules', (select coalesce(jsonb_agg(to_jsonb(r) order by r.priority), '[]'::jsonb) from app.care_level_rules r)) as data
*/
function api_route_admin_rules(c, d) {
  const s = dbRows('safety_rules');
  const r = dbRows('care_level_rules');
  return {
    safety_rules: jsonAgg(orderBy(s, _r30_collate(s, (x) => x.code)).map((x) => ({ ...x }))) ?? [],
    care_level_rules: jsonAgg(orderBy(r, (x) => x.priority).map((x) => ({ ...x }))) ?? [],
  };
}

/*
select coalesce(jsonb_agg(jsonb_build_object('event_id', event_id, 'event_type', event_type, 'status', status, 'attempts', attempts,
       'occurred_at', occurred_at, 'last_error', last_error) order by occurred_at desc), '[]'::jsonb) as data
  from (select * from app.outbox order by occurred_at desc limit app.fn_clamp($2::jsonb->>'limit', 100, 1, 500)) o
*/
function api_route_admin_outbox(c, d) {
  const limit = fn_clamp(_r30_text(d, 'limit'), 100, 1, 500);
  const o = orderBy(dbRows('outbox'), [(x) => t(x.occurred_at), 'desc']).slice(0, limit);
  return jsonAgg(orderBy(o, [(x) => t(x.occurred_at), 'desc']).map((x) => ({
    event_id: x.event_id, event_type: x.event_type, status: x.status, attempts: x.attempts, occurred_at: x.occurred_at, last_error: x.last_error,
  }))) ?? [];
}

// select app.fn_users_list($1::jsonb) as data
function api_route_admin_users(c, d) { return fn_users_list(c); }

// select app.api_create_user($1::jsonb, $2::jsonb) as data
function api_route_admin_create_user(c, d) { return api_create_user(c, d); }

// select app.api_set_user_active($1::jsonb, $2::jsonb) as data
function api_route_admin_set_user_active(c, d) { return api_set_user_active(c, d); }

// select app.api_reset_password($1::jsonb, $2::jsonb) as data
function api_route_admin_reset_password(c, d) { return api_reset_password(c, d); }

// select app.fn_admin_audit($1::jsonb, $2::jsonb) as data
function api_route_admin_audit(c, d) { return fn_admin_audit(c, d); }

// select app.api_admin_health($1::jsonb, $2::jsonb) as data
function api_route_admin_health(c, d) { return api_admin_health(c, d); }

/*
select coalesce(jsonb_agg(jsonb_build_object('at', at, 'workflow', workflow, 'node', node, 'message', message) order by at desc), '[]'::jsonb) as data
  from (select * from app.incidents order by at desc limit app.fn_clamp($2::jsonb->>'limit', 100, 1, 500)) i
*/
function api_route_admin_incidents(c, d) { return api_admin_incidents(c, d); }

// AI quality (engine 21_quality.js): resolve an incident, the Quality screen, an improvement report on request.
function api_route_admin_incident_resolve(c, d) { return api_admin_incident_resolve(c, d); }
function api_route_admin_quality(c, d) { return api_admin_quality(c, d); }
function api_route_admin_quality_report(c, d) { return api_admin_quality_report(c, d); }
function api_route_admin_eval_record(c, d) { return api_admin_eval_record(c, d); }
// select app.api_push_subscribe($1::jsonb, $2::jsonb) as data
function api_route_profile_push_subscribe(c, d) { return api_push_subscribe(c, d); }
// select app.api_push_unsubscribe($1::jsonb, $2::jsonb) as data
function api_route_profile_push_unsubscribe(c, d) { return api_push_unsubscribe(c, d); }
// select app.api_data_request($1::jsonb, $2::jsonb) as data
function api_route_profile_data_request(c, d) { return api_data_request(c, d); }
// select app.api_my_data_requests($1::jsonb, $2::jsonb) as data
function api_route_profile_data_requests(c, d) { return api_my_data_requests(c, d); }
// select app.api_access_log($1::jsonb, $2::jsonb) as data
function api_route_profile_access_log(c, d) { return api_access_log(c, d); }
// select app.api_admin_data_requests($1::jsonb, $2::jsonb) as data
function api_route_admin_data_requests(c, d) { return api_admin_data_requests(c, d); }
// select app.api_admin_data_request_resolve($1::jsonb, $2::jsonb) as data
function api_route_admin_data_request_resolve(c, d) { return api_admin_data_request_resolve(c, d); }
// select app.api_admin_breaches($1::jsonb, $2::jsonb) as data
function api_route_admin_breaches(c, d) { return api_admin_breaches(c, d); }
// select app.api_admin_report_breach($1::jsonb, $2::jsonb) as data
function api_route_admin_report_breach(c, d) { return api_admin_report_breach(c, d); }
// select app.api_admin_breach_notified($1::jsonb, $2::jsonb) as data
function api_route_admin_breach_notified(c, d) { return api_admin_breach_notified(c, d); }

/* ---- v2: Ramadan (24_ramadan.js), care gaps and panel risk (25_care_gaps.js) ---- */
function api_route_care_ramadan(c, d) { return api_ramadan_status(c, d); }

/* ---- Wellbeing, sick-day mode, driving (33_wellbeing.js) ---- */
// select app.api_wellbeing_status($1::jsonb, $2::jsonb) as data
function api_route_care_wellbeing(c, d) { return api_wellbeing_status(c, d); }
// select app.api_wellbeing_submit($1::jsonb, $2::jsonb) as data
function api_route_care_wellbeing_submit(c, d) { return api_wellbeing_submit(c, d); }
// select app.api_sick_status($1::jsonb, $2::jsonb) as data
function api_route_care_sick_status(c, d) { return api_sick_status(c, d); }
// select app.api_sick_start($1::jsonb, $2::jsonb) as data
function api_route_care_sick_start(c, d) { return api_sick_start(c, d); }
// select app.api_sick_end($1::jsonb, $2::jsonb) as data
function api_route_care_sick_end(c, d) { return api_sick_end(c, d); }
// select app.api_drive_check($1::jsonb, $2::jsonb) as data
function api_route_glucose_drive_check(c, d) { return api_drive_check(c, d); }
function api_route_care_ramadan_assess(c, d) { return api_ramadan_assess(c, d); }
function api_route_care_ramadan_fasting(c, d) { return api_ramadan_set_fasting(c, d); }
function api_route_provider_care_gaps(c, d) { return fn_care_gaps(c); }
function api_route_provider_panel_risk(c, d) { return fn_panel_risk(c, d && d.limit); }

/* ---- Personalization (32_personal.js) ---- */
// select app.api_personalization($1::jsonb, $2::jsonb) as data
function api_route_provider_personalization(c, d) { return api_personalization(c, d); }
// select app.api_therapy_review($1::jsonb, $2::jsonb) as data
function api_route_provider_therapy_review(c, d) { return api_therapy_review(c, d); }
// select app.api_preferences($1::jsonb, $2::jsonb) as data
function api_route_profile_preferences(c, d) { return api_preferences(c, d); }
// select app.api_set_preferences($1::jsonb, $2::jsonb) as data
function api_route_profile_set_preferences(c, d) { return api_set_preferences(c, d); }
// select app.fn_food_profile(:pid, app.fn_clamp($2::jsonb->>'days', 90, 7, 365)) as data
function api_route_lifestyle_food_profile(c, d) { return fn_food_profile(fn_resolve_patient(c, d), d && d.days); }

/* ---- Monitoring, alerts, calibration (35_monitoring.js) and nurse review (36_reviews.js) ---- */
// select app.api_admin_monitoring($1::jsonb, $2::jsonb) as data
function api_route_admin_monitoring(c, d) { return api_admin_monitoring(c, d); }
// select app.api_admin_companion_resume($1::jsonb, $2::jsonb) as data
function api_route_admin_companion_resume(c, d) { return api_admin_companion_resume(c, d); }
// select app.api_admin_calibration_queue($1::jsonb, $2::jsonb) as data
function api_route_admin_calibration_queue(c, d) { return api_admin_calibration_queue(c, d); }
// select app.api_admin_calibration_score($1::jsonb, $2::jsonb) as data
function api_route_admin_calibration_score(c, d) { return api_admin_calibration_score(c, d); }
// select app.api_admin_calibration_report($1::jsonb, $2::jsonb) as data
function api_route_admin_calibration_report(c, d) { return api_admin_calibration_report(c, d); }
// select app.api_ai_reviews($1::jsonb, $2::jsonb) as data
function api_route_provider_ai_reviews(c, d) { return api_ai_reviews(c, d); }
// select app.api_ai_review_decide($1::jsonb, $2::jsonb) as data
function api_route_provider_ai_review_decide(c, d) { return api_ai_review_decide(c, d); }

/* ---- Page actions: one request per screen (37_pages.js) ---- */
// select app.api_page_today($1::jsonb, $2::jsonb) as data
function api_route_today_page(c, d) { return api_page_today(c, d); }
// select app.api_page_glucose($1::jsonb, $2::jsonb) as data
function api_route_glucose_page(c, d) { return api_page_glucose(c, d); }
// select app.api_page_care($1::jsonb, $2::jsonb) as data
function api_route_care_page(c, d) { return api_page_care(c, d); }
// select app.api_page_lifestyle($1::jsonb, $2::jsonb) as data
function api_route_lifestyle_page(c, d) { return api_page_lifestyle(c, d); }
// select app.api_page_provider_home($1::jsonb, $2::jsonb) as data
function api_route_provider_home(c, d) { return api_page_provider_home(c, d); }

// Polyclinic (40_clinic.js).
function api_route_clinic_request(c, d) { return api_clinic_request(c, d); }
function api_route_clinic_patient_page(c, d) { return api_clinic_patient_page(c, d); }
function api_route_clinic_choose_slot(c, d) { return api_clinic_choose_slot(c, d); }
function api_route_clinic_waitlist_answer(c, d) { return api_clinic_waitlist_answer(c, d); }
function api_route_clinic_dispatch_page(c, d) { return api_clinic_dispatch_page(c, d); }
function api_route_clinic_accept(c, d) { return api_clinic_accept(c, d); }
function api_route_clinic_offer(c, d) { return api_clinic_offer(c, d); }
function api_route_clinic_reassign(c, d) { return api_clinic_reassign(c, d); }
function api_route_clinic_decline(c, d) { return api_clinic_decline(c, d); }
function api_route_clinic_walk_in(c, d) { return api_clinic_walk_in(c, d); }
function api_route_clinic_set_status(c, d) { return api_clinic_set_status(c, d); }
function api_route_clinic_waitlist_add(c, d) { return api_clinic_waitlist_add(c, d); }
function api_route_clinic_waitlist_remove(c, d) { return api_clinic_waitlist_remove(c, d); }
function api_route_clinic_queue_page(c, d) { return api_clinic_queue_page(c, d); }
function api_route_clinic_visit_save(c, d) { return api_clinic_visit_save(c, d); }
function api_route_clinic_visit_hints(c, d) { return api_clinic_visit_hints(c, d); }
function api_route_clinic_visit_sign(c, d) { return api_clinic_visit_sign(c, d); }
function api_route_clinic_catalog_page(c, d) { return api_clinic_catalog_page(c, d); }
function api_route_clinic_analytics_page(c, d) { return api_clinic_analytics_page(c, d); }
function api_route_clinic_specialty_save(c, d) { return api_clinic_specialty_save(c, d); }
function api_route_clinic_doctor_save(c, d) { return api_clinic_doctor_save(c, d); }
function api_route_clinic_service_save(c, d) { return api_clinic_service_save(c, d); }

// select app.api_my_diabetes_doctor($1::jsonb, $2::jsonb) as data
function api_route_care_my_doctor(c, d) { return api_my_diabetes_doctor(c, d); }
