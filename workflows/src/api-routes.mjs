// API route table. Each group is one webhook of the platform workflow (platform.mjs): POST /webhook/api/v1/<group>
// body {action, data}. In SQL, $1 = caller context (jsonb) and $2 = request data (jsonb).
// :pid expands to the authorized patient id (raises forbidden/bad_request otherwise).
// Every query returns exactly one row with a `data` column.
import { WF } from './lib.mjs';

const PID = 'app.fn_resolve_patient($1::jsonb, $2::jsonb)';
// Days and list sizes from the request are kept within limits (a request cannot ask for years of data at once).
const DAYS = (def, max = 90) => `app.fn_clamp($2::jsonb->>'days', ${def}, 1, ${max})`;
const LIMIT = (def, max) => `app.fn_clamp($2::jsonb->>'limit', ${def}, 1, ${max})`;

export const ROLES = {
  any: '*',
  patientScoped: ['patient', 'caregiver', 'doctor', 'nurse', 'clinic_admin'],
  withReception: ['patient', 'caregiver', 'doctor', 'nurse', 'receptionist', 'clinic_admin'],
  clinician: ['doctor', 'nurse'],
  doctor: ['doctor'],
  staff: ['doctor', 'nurse', 'receptionist', 'clinic_admin'],
  clinical: ['doctor', 'nurse', 'clinic_admin'],          // may read clinical details of linked patients
  platform: ['safety_officer', 'platform_admin'],          // cross-organization operations data
  admin: ['clinic_admin', 'safety_officer', 'platform_admin'],
  capacity: ['capacity_operator', 'clinic_admin', 'platform_admin'],
  network: ['patient', 'caregiver', 'doctor', 'nurse', 'receptionist', 'clinic_admin', 'capacity_operator', 'transfer_coordinator', 'platform_admin', 'safety_officer'],
};

const sql = (query, roles = ROLES.patientScoped) => ({ kind: 'sql', query: query.replaceAll(':pid', PID), roles });
const sub = (workflowId, roles = ROLES.patientScoped) => ({ kind: 'workflow', workflowId, roles });
// Caregiver scopes, checked by the Auth Gate (app.fn_gate -> app.fn_scope_ctx): reading needs no scope; 'log' covers daily
// logging, appointments, messages, Care Access and the Companion; 'manage' covers changes to the record and its sharing.
// Staff and patients are not affected.
const log = (route) => ({ ...route, scope: 'log' });
const manage = (route) => ({ ...route, scope: 'manage' });
// Role projection of read models: receptionists see administrative fields only; patients and family see no staff ids.
const forRole = (kind, expr) => `app.fn_for_role($1::jsonb, '${kind}', ${expr})`;

// Reception desk of the polyclinic (doctors and nurses may also work the desk).
const CLINIC_DESK = ['receptionist', 'clinic_admin', 'nurse', 'doctor'];

export const GROUPS = {
  auth: {
    title: 'Auth',
    actions: {
      login: { ...sql(`select app.fn_login($2::jsonb->>'email', $2::jsonb->>'password') as data`), roles: '*', public: true },
      me: sql(`select ($1::jsonb - 'user_id') || jsonb_build_object('id', $1::jsonb->>'user_id') as data`, '*'),
      logout: sql(`select jsonb_build_object('ok', true) as data from (select app.fn_logout($2::jsonb->>'__token')) x`, '*'),
      verify_mfa: { ...sql(`select app.api_verify_mfa($2::jsonb) as data`), roles: '*', public: true },
      register: { ...sql(`select app.api_register($2::jsonb) as data`), roles: '*', public: true },
      forgot_password: { ...sql(`select app.api_forgot_password($2::jsonb) as data`), roles: '*', public: true },
      reset_with_token: { ...sql(`select app.api_reset_with_token($2::jsonb) as data`), roles: '*', public: true },
      change_password: sql(`select app.api_change_password($1::jsonb, $2::jsonb) as data`, '*'),
      mfa_setup: sql(`select app.api_mfa_setup($1::jsonb) as data`, '*'),
      mfa_enable: sql(`select app.api_mfa_enable($1::jsonb, $2::jsonb) as data`, '*'),
      mfa_disable: sql(`select app.api_mfa_disable($1::jsonb, $2::jsonb) as data`, '*'),
      redeem_invite: sql(`select app.api_redeem_invite($1::jsonb, $2::jsonb) as data`, ['caregiver']),
      delete_account: sql(`select app.api_delete_account($1::jsonb, $2::jsonb) as data`, ['patient', 'caregiver']),
    },
  },
  today: {
    title: 'Today',
    actions: {
      get: sql(`select app.fn_today(:pid) as data`),
      // One request for the whole screen (37_pages.js): each part checked as if called alone.
      page: sql(`select app.api_page_today($1::jsonb, $2::jsonb) as data`),
    },
  },
  profile: {
    title: 'Profile',
    actions: {
      get: sql(`select ${forRole('patient', 'app.fn_patient_json(:pid)')} as data`, ROLES.withReception),
      state: sql(`select app.fn_patient_state(:pid) as data`),
      update: manage(sql(`select app.api_profile_update($1::jsonb, $2::jsonb) as data`)),
      export: sql(`select app.api_export_data($1::jsonb, $2::jsonb) as data`, ['patient']),
      consents: sql(`select app.api_consents($1::jsonb, $2::jsonb) as data`, ['patient']),
      set_consent: sql(`select app.api_set_consent($1::jsonb, $2::jsonb) as data`, ['patient']),
      // How the person likes to be helped (32_personal.js): wording, voice, meals, shifts, sleep, budget.
      preferences: sql(`select app.api_preferences($1::jsonb, $2::jsonb) as data`),
      set_preferences: manage(sql(`select app.api_set_preferences($1::jsonb, $2::jsonb) as data`, ['patient', 'caregiver'])),
      // Web push on this device (29_push_privacy.js): any signed-in person.
      push_subscribe: sql(`select app.api_push_subscribe($1::jsonb, $2::jsonb) as data`, '*'),
      push_unsubscribe: sql(`select app.api_push_unsubscribe($1::jsonb, $2::jsonb) as data`, '*'),
      // Personal-data rights (Egypt PDPL): requests to the platform, and who opened the record.
      data_request: sql(`select app.api_data_request($1::jsonb, $2::jsonb) as data`, ['patient']),
      data_requests: sql(`select app.api_my_data_requests($1::jsonb, $2::jsonb) as data`, ['patient']),
      access_log: sql(`select app.api_access_log($1::jsonb, $2::jsonb) as data`, ['patient']),
    },
  },
  clinical: {
    title: 'Clinical record',
    actions: {
      summary: sql(`select app.fn_health_summary(:pid) as data`),
      timeline: sql(`select app.fn_timeline(:pid, ${LIMIT(50, 200)}) as data`),
      add_condition: manage(sql(`select app.api_add_condition($1::jsonb, $2::jsonb) as data`)),
      add_allergy: manage(sql(`select app.api_add_allergy($1::jsonb, $2::jsonb) as data`)),
      add_medication: manage(sql(`select app.api_add_medication($1::jsonb, $2::jsonb) as data`)),
      stop_medication: manage(sql(`select app.api_stop_medication($1::jsonb, $2::jsonb) as data`)),
      update_medication: manage(sql(`select app.api_update_medication($1::jsonb, $2::jsonb) as data`)),
      resolve_condition: manage(sql(`select app.api_resolve_condition($1::jsonb, $2::jsonb) as data`)),
      remove_allergy: manage(sql(`select app.api_remove_allergy($1::jsonb, $2::jsonb) as data`)),
      log_dose: log(sql(`select app.api_log_dose($1::jsonb, $2::jsonb) as data`)),
      set_supply: log(sql(`select app.api_set_supply($1::jsonb, $2::jsonb) as data`)),
      add_lab: log(sql(`select app.api_add_lab($1::jsonb, $2::jsonb) as data`)),
      add_vital: log(sql(`select app.api_add_vital($1::jsonb, $2::jsonb) as data`)),
      verify: sql(`select app.api_verify($1::jsonb, $2::jsonb) as data`, ROLES.clinician),
      acknowledge_finding: sql(`select app.api_ack_finding($1::jsonb, $2::jsonb) as data`, ROLES.clinician),
      documents: sql(`
select coalesce(jsonb_agg(app.fn_document_json(dd) order by dd.created_at desc), '[]'::jsonb) as data
  from app.documents dd where dd.patient_id = :pid`),
      upload_document: log(sql(`select app.api_upload_document($1::jsonb, $2::jsonb) as data`)),
      review_document: sql(`select app.api_review_document($1::jsonb, $2::jsonb) as data`, ROLES.clinician),
    },
  },
  glucose: {
    title: 'Glucose & CGM',
    actions: {
      list: sql(`
select coalesce(jsonb_agg(jsonb_build_object('id', id, 'value_mgdl', value_mgdl, 'measured_at', measured_at, 'source', source, 'context', context)
       order by measured_at), '[]'::jsonb) as data
  from app.glucose_readings where patient_id = :pid and measured_at > now() - make_interval(days => ${DAYS(14)})`),
      add: log(sql(`select app.api_glucose_add($1::jsonb, $2::jsonb) as data`)),
      delete: log(sql(`select app.api_delete_glucose($1::jsonb, $2::jsonb) as data`)),
      // Reads the number on a photo of the meter's screen (WF-028); nothing is saved, the person confirms and saves.
      read_meter: log(sub(WF.meterPhoto, ['patient', 'caregiver'])),
      // Before-driving check for people on insulin or a sulfonylurea (33_wellbeing.js).
      drive_check: sql(`select app.api_drive_check($1::jsonb, $2::jsonb) as data`),
      metrics: sql(`select app.fn_glucose_metrics(:pid, ${DAYS(14)}) as data`),
      patterns: sql(`select app.fn_detect_patterns(:pid, ${DAYS(14)}) as data`),
      agp: sql(`select app.fn_glucose_agp(:pid, ${DAYS(14)}) as data`),
      daily: sql(`select app.fn_glucose_daily(:pid, ${DAYS(14)}) as data`),
      nightscout_status: sql(`select app.fn_nightscout_json(:pid) as data`),
      page: sql(`select app.api_page_glucose($1::jsonb, $2::jsonb) as data`),
      nightscout_connect: manage(sql(`select app.api_nightscout_connect($1::jsonb, $2::jsonb) as data`)),
      nightscout_disconnect: manage(sql(`select app.api_nightscout_disconnect($1::jsonb, $2::jsonb) as data`)),
    },
  },
  lifestyle: {
    title: 'Lifestyle',
    actions: {
      // How this person's sugar rose after meals with each food (32_personal.js), from their own readings.
      food_profile: sql(`select app.fn_food_profile(:pid, app.fn_clamp($2::jsonb->>'days', 90, 7, 365)) as data`),
      foods: sql(`
select coalesce(jsonb_agg(to_jsonb(f) order by f.category, f.name), '[]'::jsonb) as data
  from (select * from app.foods
         where (nullif($2::jsonb->>'category', '') is null or category = $2::jsonb->>'category')
           and (nullif($2::jsonb->>'q', '') is null or (name || ' ' || name_ar) ilike '%' || ($2::jsonb->>'q') || '%')
         limit 60) f`, '*'),
      log_meal: log(sql(`select app.api_log_meal($1::jsonb, $2::jsonb) as data`)),
      log_activity: log(sql(`
insert into app.activity_logs(patient_id, date, steps, minutes, type)
values (:pid, app.fn_log_date($2::jsonb->>'date'), app.fn_num_in($2::jsonb, 'steps', 0, 100000, 0)::int,
        app.fn_num_in($2::jsonb, 'minutes', 0, 1440, 0)::int, left(coalesce(nullif($2::jsonb->>'type', ''), 'walking'), 30))
on conflict (patient_id, date, type) do update set steps = app.activity_logs.steps + excluded.steps, minutes = app.activity_logs.minutes + excluded.minutes
returning jsonb_build_object('ok', true) as data`)),
      log_sleep: log(sql(`
insert into app.sleep_logs(patient_id, date, hours, quality)
values (:pid, app.fn_log_date($2::jsonb->>'date'), app.fn_num_in($2::jsonb, 'hours', 0, 24), app.fn_num_in($2::jsonb, 'quality', 1, 5)::int)
on conflict (patient_id, date) do update set hours = excluded.hours, quality = excluded.quality
returning jsonb_build_object('ok', true) as data`)),
      checkin: log(sql(`
insert into app.checkins(patient_id, mood, stress, energy, note)
values (:pid, app.fn_num_in($2::jsonb, 'mood', 1, 5)::int, app.fn_num_in($2::jsonb, 'stress', 1, 5)::int, app.fn_num_in($2::jsonb, 'energy', 1, 5)::int,
        left(nullif(trim(coalesce($2::jsonb->>'note', '')), ''), 500))
returning jsonb_build_object('ok', true) as data`)),
      summary: sql(`select app.fn_lifestyle_summary(:pid, ${DAYS(7)}) as data`),
      page: sql(`select app.api_page_lifestyle($1::jsonb, $2::jsonb) as data`),
    },
  },
  care: {
    title: 'Care plans & appointments',
    actions: {
      plan: sql(`
with p as (select :pid as pid)
select jsonb_build_object(
  'active', (select app.fn_plan_json(id) from app.care_plans, p where patient_id = p.pid and status = 'ACTIVE'),
  'draft', (select app.fn_plan_json(id) from app.care_plans, p where patient_id = p.pid and status = 'DRAFT'),
  'tasks', coalesce((select jsonb_agg(app.fn_task_json(t) order by t.due_at nulls last) from app.care_tasks t, p
                      where t.patient_id = p.pid and t.status = 'pending'), '[]'::jsonb)) as data from p`),
      plan_history: sql(`
select coalesce(jsonb_agg(app.fn_plan_json(id) order by version desc), '[]'::jsonb) as data
  from app.care_plans where patient_id = :pid and status <> 'DRAFT'`),
      complete_task: log(sql(`
with u as (update app.care_tasks set status = coalesce(nullif($2::jsonb->>'status', ''), 'done'), completed_at = now()
            where id = ($2::jsonb->>'task_id')::uuid and app.fn_can_access_patient($1::jsonb, patient_id) returning 1)
select case when exists (select 1 from u) then jsonb_build_object('ok', true) else app.fn_raise('not_found: task not found') end as data`)),
      screenings: sql(`select app.fn_screenings(:pid) as data`),
      record_screening: log(sql(`select app.api_record_screening($1::jsonb, $2::jsonb) as data`)),
      // Ramadan (engine 24_ramadan.js): IDF-DAR risk check, the fasting choice, today's fasting window.
      ramadan: sql(`select app.api_ramadan_status($1::jsonb, $2::jsonb) as data`),
      ramadan_assess: log(sql(`select app.api_ramadan_assess($1::jsonb, $2::jsonb) as data`)),
      ramadan_fasting: log(sql(`select app.api_ramadan_set_fasting($1::jsonb, $2::jsonb) as data`)),
      // Wellbeing check-ins and sick-day mode (engine 33_wellbeing.js). The check-in answers are the patient's own.
      wellbeing: sql(`select app.api_wellbeing_status($1::jsonb, $2::jsonb) as data`),
      wellbeing_submit: sql(`select app.api_wellbeing_submit($1::jsonb, $2::jsonb) as data`, ['patient']),
      sick_status: sql(`select app.api_sick_status($1::jsonb, $2::jsonb) as data`),
      sick_start: log(sql(`select app.api_sick_start($1::jsonb, $2::jsonb) as data`)),
      sick_end: log(sql(`select app.api_sick_end($1::jsonb, $2::jsonb) as data`)),
      appointments: sql(`
select ${forRole('appointment', `coalesce(jsonb_agg(app.fn_appointment_json(a) order by a.starts_at desc), '[]'::jsonb)`)} as data
  from app.appointments a where a.patient_id = :pid`, ROLES.withReception),
      book_appointment: log(sql(`select ${forRole('appointment', 'app.api_book_appointment($1::jsonb, $2::jsonb)')} as data`, ROLES.withReception)),
      update_appointment: sql(`select ${forRole('appointment', 'app.api_update_appointment($1::jsonb, $2::jsonb)')} as data`, ROLES.staff),
      cancel_appointment: log(sql(`select app.api_cancel_appointment($1::jsonb, $2::jsonb) as data`, ROLES.withReception)),
      save_plan_draft: sql(`select app.api_save_plan_draft($1::jsonb, $2::jsonb) as data`, ROLES.clinician),
      publish_plan: sql(`select app.fn_publish_plan($1::jsonb, ($2::jsonb->>'plan_id')::uuid) as data`, ROLES.doctor),
      message_team: log(sql(`select app.api_message_team($1::jsonb, $2::jsonb) as data`, ['patient', 'caregiver'])),
      messages: sql(`select app.api_team_messages($1::jsonb, $2::jsonb) as data`, ['patient', 'caregiver', 'doctor', 'nurse', 'clinic_admin']),
      reply_message: sql(`select app.api_reply_message($1::jsonb, $2::jsonb) as data`, ROLES.clinician),
      caregivers: sql(`select app.api_caregivers($1::jsonb, $2::jsonb) as data`, ['patient']),
      page: sql(`select app.api_page_care($1::jsonb, $2::jsonb) as data`),
      // The patient's diabetes doctor: own, or a matched one from the directory with on-call cover (41_doctor_match.js).
      my_doctor: sql(`select app.api_my_diabetes_doctor($1::jsonb, $2::jsonb) as data`),
      invite_caregiver: sql(`select app.api_invite_caregiver($1::jsonb, $2::jsonb) as data`, ['patient']),
      revoke_caregiver: sql(`select app.api_revoke_caregiver($1::jsonb, $2::jsonb) as data`, ['patient']),
      set_caregiver_scopes: sql(`select app.api_set_caregiver_scopes($1::jsonb, $2::jsonb) as data`, ['patient']),
      email_invite: sql(`select app.api_email_invite($1::jsonb, $2::jsonb) as data`, ['patient']),
      organizations: sql(`
select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'name_ar', o.name_ar, 'type', o.type,
       'city', (select f.city from app.facilities f where f.organization_id = o.id limit 1)) order by o.name), '[]'::jsonb) as data
  from app.organizations o where o.type <> 'network'`, '*'),
      // Sharing the record with a new clinic is the patient's decision (or a family member allowed to manage it).
      request_link: manage(sql(`select app.api_request_link($1::jsonb, $2::jsonb) as data`, ['patient', 'caregiver'])),
      link_requests: sql(`
select coalesce(jsonb_agg(app.fn_link_request_json(r) order by r.created_at desc), '[]'::jsonb) as data
  from app.link_requests r where r.patient_id = :pid`, ['patient', 'caregiver']),
    },
  },
  intake: {
    title: 'Care Access intake',
    actions: {
      start: log(sub(WF.intake)),
      answer: log(sub(WF.intake)),
      free_text: log(sub(WF.intake)),
    },
  },
  episodes: {
    title: 'Episodes',
    actions: {
      list: sql(`
select coalesce(jsonb_agg(app.fn_episode_json(e.id) order by e.started_at desc), '[]'::jsonb) as data
  from app.episodes e where e.patient_id = :pid`),
      get: sql(`
select coalesce((select app.fn_episode_json(e.id) || jsonb_build_object('next_question',
                   case when e.status in ('DRAFT','INTAKE_IN_PROGRESS') then app.fn_next_question(e.answers) end)
                   from app.episodes e
                  where e.id = ($2::jsonb->>'episode_id')::uuid and app.fn_can_access_patient($1::jsonb, e.patient_id)),
                app.fn_raise('not_found: episode not found')) as data`),
      select_action: log(sql(`select app.api_episode_action($1::jsonb, $2::jsonb) as data`)),
      followup: log(sql(`select app.api_episode_followup($1::jsonb, $2::jsonb) as data`)),
    },
  },
  network: {
    title: 'Care network',
    actions: {
      search: sql(`select app.fn_match_facilities($2::jsonb) as data`, ROLES.network),
      facility: sql(`select coalesce((select app.fn_facility_json(f, null, null) from app.facilities f where f.id = ($2::jsonb->>'facility_id')::uuid),
                app.fn_raise('not_found: facility not found')) as data`, ROLES.network),
      update_capacity: sql(`select app.api_update_capacity($1::jsonb, $2::jsonb) as data`, ROLES.capacity),
      referrals: sql(`
select ${forRole('referral', `coalesce(jsonb_agg(app.fn_referral_json(r) order by r.created_at desc), '[]'::jsonb)`)} as data
  from app.referrals r
 where app.fn_can_access_patient($1::jsonb, r.patient_id)
   and (nullif($2::jsonb->>'patient_id', '') is null or r.patient_id = ($2::jsonb->>'patient_id')::uuid)`, ROLES.withReception),
      create_referral: sql(`select app.api_create_referral($1::jsonb, $2::jsonb) as data`, ROLES.clinician),
      update_referral: sql(`select ${forRole('referral', 'app.api_update_referral($1::jsonb, $2::jsonb)')} as data`, ROLES.withReception),
      transfers: sql(`select app.fn_transfers_list($1::jsonb, $2::jsonb) as data`, ['doctor', 'nurse', 'transfer_coordinator', 'clinic_admin']),
      create_transfer: sql(`select app.api_create_transfer($1::jsonb, $2::jsonb) as data`, ROLES.clinician),
      update_transfer: sql(`select app.api_update_transfer($1::jsonb, $2::jsonb) as data`, ['doctor', 'nurse', 'transfer_coordinator', 'clinic_admin']),
    },
  },
  companion: {
    title: 'Companion',
    actions: {
      send: log(sub(WF.companion, ['patient', 'caregiver'])),
      history: sql(`select app.fn_companion_history($1::jsonb, $2::jsonb) as data`, ['patient', 'caregiver']),
    },
  },
  insights: {
    title: 'Insights & notifications',
    actions: {
      list: sql(`
select coalesce(jsonb_agg(app.fn_insight_json(i) order by i.created_at desc), '[]'::jsonb) as data
  from (select * from app.patient_insights where patient_id = :pid order by created_at desc
        limit ${LIMIT(30, 100)}) i`),
      mark_read: log(sql(`
with u as (update app.patient_insights set read_at = now()
            where id = ($2::jsonb->>'insight_id')::uuid and app.fn_can_access_patient($1::jsonb, patient_id) returning 1)
select case when exists (select 1 from u) then jsonb_build_object('ok', true) else app.fn_raise('not_found: insight not found') end as data`)),
      notifications: sql(`
select coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'title_ar', title_ar, 'body', body, 'body_ar', body_ar, 'kind', kind, 'created_at', created_at, 'read_at', read_at)
       order by created_at desc), '[]'::jsonb) as data
  from (select * from app.notifications where user_id = ($1::jsonb->>'user_id')::uuid order by created_at desc limit 50) n`, '*'),
      mark_notification_read: sql(`
with u as (update app.notifications set read_at = now()
            where id = ($2::jsonb->>'notification_id')::uuid and user_id = ($1::jsonb->>'user_id')::uuid returning 1)
select case when exists (select 1 from u) then jsonb_build_object('ok', true) else app.fn_raise('not_found: notification not found') end as data`, '*'),
      // Marks all of the caller's own notifications read.
      mark_all_read: sql(`
with u as (update app.notifications set read_at = now() where user_id = ($1::jsonb->>'user_id')::uuid and read_at is null returning 1)
select jsonb_build_object('ok', true, 'count', (select count(*) from u)) as data`, '*'),
    },
  },
  provider: {
    title: 'Provider OS',
    actions: {
      inbox: sql(`select app.fn_inbox_list($1::jsonb, $2::jsonb) as data`, ROLES.clinical),
      update_inbox: sql(`select app.api_update_inbox($1::jsonb, $2::jsonb) as data`, ROLES.clinical),
      // Engine 25_care_gaps.js: overdue screenings across the panel, and patients ranked by risk with the reasons.
      care_gaps: sql(`select app.fn_care_gaps($1::jsonb) as data`, ROLES.clinical),
      panel_risk: sql(`select app.fn_panel_risk($1::jsonb, app.fn_clamp($2::jsonb->>'limit', 20, 1, 100)) as data`, ROLES.clinical),
      // Engine 32_personal.js: suggested personal targets, treatment considerations (clinician only), food response, preferences.
      personalization: sql(`select app.api_personalization($1::jsonb, $2::jsonb) as data`, ROLES.clinical),
      therapy_review: sql(`select app.api_therapy_review($1::jsonb, $2::jsonb) as data`, ROLES.clinician),
      // Nurse approval of held Companion answers (36_reviews.js).
      ai_reviews: sql(`select app.api_ai_reviews($1::jsonb, $2::jsonb) as data`, ROLES.clinical),
      ai_review_decide: sql(`select app.api_ai_review_decide($1::jsonb, $2::jsonb) as data`, ROLES.clinician),
      assign_inbox: sql(`select app.api_assign_inbox($1::jsonb, $2::jsonb) as data`, ROLES.clinical),
      panel: sql(`select app.fn_panel($1::jsonb, $2::jsonb->>'q') as data`, ROLES.staff),
      // Opening a patient's record is audited (once an hour per clinician and record).
      workspace: sql(`select app.fn_audit_read($1::jsonb, :pid, 'workspace', app.fn_workspace(:pid)) as data`, ['doctor', 'nurse', 'clinic_admin']),
      schedule: sql(`
select ${forRole('appointment', `coalesce(jsonb_agg(app.fn_appointment_json(a) order by a.starts_at), '[]'::jsonb)`)} as data
  from app.appointments a
 where app.fn_can_access_patient($1::jsonb, a.patient_id)
   and a.starts_at >= coalesce(nullif($2::jsonb->>'from', '')::timestamptz, date_trunc('day', now()))
   and a.starts_at < coalesce(nullif($2::jsonb->>'to', '')::timestamptz, date_trunc('day', now()) + interval '7 days')
   and a.status <> 'cancelled'`, ROLES.staff),
      generate_brief: sub(WF.brief, ['doctor', 'nurse']),
      stats: sql(`select app.fn_provider_stats($1::jsonb) as data`, ROLES.staff),
      home: sql(`select app.api_page_provider_home($1::jsonb, $2::jsonb) as data`, ROLES.staff),
      link_requests: sql(`
select coalesce(jsonb_agg(app.fn_link_request_json(r) order by r.status = 'pending' desc, r.created_at desc), '[]'::jsonb) as data
  from app.link_requests r
 where r.organization_id in (select organization_id from app.memberships where user_id = ($1::jsonb->>'user_id')::uuid)`, ['doctor', 'nurse', 'clinic_admin']),
      decide_link: sql(`select app.api_decide_link($1::jsonb, $2::jsonb) as data`, ['doctor', 'clinic_admin']),
      break_glass: sql(`select app.api_break_glass($1::jsonb, $2::jsonb) as data`, ROLES.clinician),
      find_patient: sql(`select app.api_find_patient($1::jsonb, $2::jsonb) as data`, ROLES.clinician),
    },
  },
  admin: {
    title: 'Administration',
    actions: {
      rag_list: sql(`
select coalesce(jsonb_agg(app.fn_rag_document_json(d) order by d.status = 'draft' desc, d.created_at desc), '[]'::jsonb) as data
  from app.rag_documents d where d.status <> 'retired' or d.created_at > now() - interval '180 days'`, ROLES.admin),
      rag_create: sql(`
insert into app.rag_documents(title, source, version, language, region, population, content, review_date, created_by, audience)
values ($2::jsonb->>'title', $2::jsonb->>'source', coalesce(nullif($2::jsonb->>'version', ''), '1'), coalesce(nullif($2::jsonb->>'language', ''), 'en'),
        $2::jsonb->>'region', $2::jsonb->>'population', $2::jsonb->>'content', nullif($2::jsonb->>'review_date', '')::date, ($1::jsonb->>'user_id')::uuid,
        coalesce(nullif($2::jsonb->>'audience', ''), 'patient'))
returning app.fn_rag_document_json(rag_documents.*) as data`, ROLES.admin),
      // A fetched guideline section cannot be approved alone: its whole edition is approved under guideline_approve.
      rag_get: sql(`
select coalesce((select app.fn_rag_document_json(d) || jsonb_build_object('content', d.content) from app.rag_documents d
                  where d.id = nullif($2::jsonb->>'document_id', '')::uuid),
                app.fn_raise('not_found: document not found')) as data`, ROLES.admin),
      rag_approve: sql(`select app.api_rag_approve($1::jsonb, $2::jsonb) as data`, ['safety_officer', 'clinic_admin']),
      rag_retire: sql(`
with u as (update app.rag_documents set status = 'retired' where id = ($2::jsonb->>'document_id')::uuid returning *),
 d as (delete from app.rag_chunks where document_id in (select id from u))
select app.fn_rag_document_json(u.*) as data from u
union all select app.fn_raise('not_found: document not found') where not exists (select 1 from u)`,
        ['safety_officer', 'clinic_admin']),
      // Accredited guideline sources (WF-024): registry and status, check now, approve or reject a pending edition.
      guideline_sources: sql(`select app.api_guideline_sources($1::jsonb, $2::jsonb) as data`, ROLES.admin),
      guideline_check: sub(WF.guidelineCheck, ['safety_officer', 'clinic_admin', 'platform_admin']),
      // Reads the knowledge folder in Google Drive now (WF-019c) instead of at its next half hour.
      rag_sync: sql(`select app.api_rag_sync($1::jsonb) as data`, ['safety_officer', 'platform_admin']),
      // A new guideline edition changes what every patient is told: the Clinical Safety Officer alone approves it.
      guideline_approve: sql(`select app.api_guideline_approve($1::jsonb, $2::jsonb) as data`, ['safety_officer']),
      guideline_dismiss: sql(`select app.api_guideline_dismiss($1::jsonb, $2::jsonb) as data`, ['safety_officer']),
      ai_runs: sql(`select app.fn_admin_ai_runs($1::jsonb, $2::jsonb) as data`, ROLES.admin),
      rules: sql(`
select jsonb_build_object(
  'safety_rules', (select coalesce(jsonb_agg(to_jsonb(s) order by s.code), '[]'::jsonb) from app.safety_rules s),
  'care_level_rules', (select coalesce(jsonb_agg(to_jsonb(r) order by r.priority), '[]'::jsonb) from app.care_level_rules r)) as data`, ROLES.admin),
      outbox: sql(`
select coalesce(jsonb_agg(jsonb_build_object('event_id', event_id, 'event_type', event_type, 'status', status, 'attempts', attempts,
       'occurred_at', occurred_at, 'last_error', last_error) order by occurred_at desc), '[]'::jsonb) as data
  from (select * from app.outbox order by occurred_at desc limit ${LIMIT(100, 500)}) o`, ROLES.platform),
      users: sql(`select app.fn_users_list($1::jsonb) as data`, ROLES.admin),
      create_user: sql(`select app.api_create_user($1::jsonb, $2::jsonb) as data`, ['clinic_admin', 'platform_admin']),
      set_user_active: sql(`select app.api_set_user_active($1::jsonb, $2::jsonb) as data`, ['clinic_admin', 'platform_admin']),
      reset_password: sql(`select app.api_reset_password($1::jsonb, $2::jsonb) as data`, ['clinic_admin', 'platform_admin']),
      audit: sql(`select app.fn_admin_audit($1::jsonb, $2::jsonb) as data`, ROLES.admin),
      // Operations health: event backlog, job runs, AI releases and cloud gate state, incidents, escalated items.
      health: sql(`select app.api_admin_health($1::jsonb, $2::jsonb) as data`, ROLES.platform),
      // Incidents of every kind: workflow errors (WF-099) and AI quality problems found by the judge (WF-025).
      incidents: sql(`select app.api_admin_incidents($1::jsonb, $2::jsonb) as data`, ROLES.platform),
      incident_resolve: sql(`select app.api_admin_incident_resolve($1::jsonb, $2::jsonb) as data`, ROLES.platform),
      // AI quality: judge metrics, recent trials, the latest improvement report and evaluation run.
      quality: sql(`select app.api_admin_quality($1::jsonb, $2::jsonb) as data`, ROLES.platform),
      quality_report: sql(`select app.api_admin_quality_report($1::jsonb, $2::jsonb) as data`, ROLES.platform),
      // Evaluation runs (ai/evals/run-evals.mjs) recorded in the eval_results tab.
      eval_record: sql(`select app.api_admin_eval_record($1::jsonb, $2::jsonb) as data`, ROLES.platform),
      // Personal-data requests and breaches (29_push_privacy.js).
      data_requests: sql(`select app.api_admin_data_requests($1::jsonb, $2::jsonb) as data`, ['platform_admin']),
      data_request_resolve: sql(`select app.api_admin_data_request_resolve($1::jsonb, $2::jsonb) as data`, ['platform_admin']),
      breaches: sql(`select app.api_admin_breaches($1::jsonb, $2::jsonb) as data`, ROLES.platform),
      report_breach: sql(`select app.api_admin_report_breach($1::jsonb, $2::jsonb) as data`, ROLES.platform),
      breach_notified: sql(`select app.api_admin_breach_notified($1::jsonb, $2::jsonb) as data`, ROLES.platform),
      // Monitoring dashboard, alerts and judge calibration (35_monitoring.js).
      monitoring: sql(`select app.api_admin_monitoring($1::jsonb, $2::jsonb) as data`, ROLES.admin),
      companion_resume: sql(`select app.api_admin_companion_resume($1::jsonb, $2::jsonb) as data`, ROLES.platform),
      calibration_queue: sql(`select app.api_admin_calibration_queue($1::jsonb, $2::jsonb) as data`, ROLES.platform),
      calibration_score: sql(`select app.api_admin_calibration_score($1::jsonb, $2::jsonb) as data`, ROLES.platform),
      calibration_report: sql(`select app.api_admin_calibration_report($1::jsonb, $2::jsonb) as data`, ROLES.platform),
    },
  },
  // Polyclinic (engine 40_clinic.js): the specialist clinics beyond diabetes care, on the same patient record.
  clinic: {
    title: 'Polyclinic',
    actions: {
      // Patient and family: ask for a specialist visit, choose an offered time, answer a waitlist offer, see visits.
      request: log(sql(`select app.api_clinic_request($1::jsonb, $2::jsonb) as data`, ['patient', 'caregiver'])),
      patient_page: sql(`select app.api_clinic_patient_page($1::jsonb, $2::jsonb) as data`, ['patient', 'caregiver']),
      choose_slot: log(sql(`select app.api_clinic_choose_slot($1::jsonb, $2::jsonb) as data`, ['patient', 'caregiver'])),
      waitlist_answer: log(sql(`select app.api_clinic_waitlist_answer($1::jsonb, $2::jsonb) as data`, ['patient', 'caregiver'])),
      // Reception: the dispatch board and its decisions, walk-ins, appointment status, the waitlist.
      dispatch_page: sql(`select app.api_clinic_dispatch_page($1::jsonb, $2::jsonb) as data`, CLINIC_DESK),
      accept: sql(`select app.api_clinic_accept($1::jsonb, $2::jsonb) as data`, CLINIC_DESK),
      offer: sql(`select app.api_clinic_offer($1::jsonb, $2::jsonb) as data`, CLINIC_DESK),
      reassign: sql(`select app.api_clinic_reassign($1::jsonb, $2::jsonb) as data`, CLINIC_DESK),
      decline: sql(`select app.api_clinic_decline($1::jsonb, $2::jsonb) as data`, CLINIC_DESK),
      walk_in: sql(`select app.api_clinic_walk_in($1::jsonb, $2::jsonb) as data`, CLINIC_DESK),
      set_status: sql(`select app.api_clinic_set_status($1::jsonb, $2::jsonb) as data`, CLINIC_DESK),
      waitlist_add: sql(`select app.api_clinic_waitlist_add($1::jsonb, $2::jsonb) as data`, CLINIC_DESK),
      waitlist_remove: sql(`select app.api_clinic_waitlist_remove($1::jsonb, $2::jsonb) as data`, CLINIC_DESK),
      // Doctor: the clinic queue with the brief, the visit (diagnosis, prescription, services), doctor-only AI hints, signing.
      queue_page: sql(`select app.api_clinic_queue_page($1::jsonb, $2::jsonb) as data`, ROLES.doctor),
      visit_save: sql(`select app.api_clinic_visit_save($1::jsonb, $2::jsonb) as data`, ROLES.doctor),
      visit_hints: sql(`select app.api_clinic_visit_hints($1::jsonb, $2::jsonb) as data`, ROLES.doctor),
      visit_sign: sql(`select app.api_clinic_visit_sign($1::jsonb, $2::jsonb) as data`, ROLES.doctor),
      // Catalog (specialties, doctors, services) and clinic results from the records.
      catalog_page: sql(`select app.api_clinic_catalog_page($1::jsonb, $2::jsonb) as data`, [...CLINIC_DESK, 'platform_admin']),
      analytics_page: sql(`select app.api_clinic_analytics_page($1::jsonb, $2::jsonb) as data`, [...CLINIC_DESK, 'platform_admin']),
      // Catalog changes.
      specialty_save: sql(`select app.api_clinic_specialty_save($1::jsonb, $2::jsonb) as data`, ['clinic_admin', 'platform_admin']),
      doctor_save: sql(`select app.api_clinic_doctor_save($1::jsonb, $2::jsonb) as data`, ['clinic_admin', 'platform_admin']),
      service_save: sql(`select app.api_clinic_service_save($1::jsonb, $2::jsonb) as data`, ['clinic_admin', 'platform_admin']),
    },
  },
};
