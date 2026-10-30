/**
 * API contract between the frontend and the n8n backend.
 *
 * Transport: every call is `POST /webhook/api/v1/<group>` with JSON body
 *   { "action": "<action>", "data": { ... } }
 * and header `Authorization: Bearer <session token>` (all groups except auth.login).
 *
 * Every response is JSON:
 *   success  -> { "ok": true,  "data": <payload> }
 *   failure  -> { "ok": false, "error": { "code": string, "message": string } }
 *
 * Patient-scoped actions accept an optional `patient_id`. A patient user may omit it
 * (their own record is used). Clinicians and caregivers must pass it, and access is
 * checked in the database by app.fn_can_access_patient().
 *
 * Timestamps are ISO-8601 strings. Glucose is always mg/dL.
 */

export type UUID = string;
export type ISODate = string;

export type Role =
  | 'patient'
  | 'caregiver'
  | 'receptionist'
  | 'nurse'
  | 'doctor'
  | 'clinic_admin'
  | 'capacity_operator'
  | 'transfer_coordinator'
  | 'safety_officer'
  | 'platform_admin';

export type Locale = 'ar' | 'en';

export interface ApiError {
  code: 'unauthorized' | 'forbidden' | 'mfa_required' | 'not_found' | 'bad_request' | 'conflict' | 'unknown_action' | 'too_many_requests' | 'unavailable' | 'server_error' | string;
  message: string;
  /** Arabic version of the message, when the backend has one (database/rules/error_messages.sql). */
  message_ar?: string;
}
export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export type VerificationStatus = 'unverified' | 'verified' | 'refuted';
export type Source = 'patient' | 'clinician' | 'device' | 'document' | 'nightscout' | 'system';

/* ------------------------------------------------------------------ auth */

export interface SessionUser {
  id: UUID;
  email: string;
  full_name: string;
  full_name_ar: string | null;
  role: Role;
  locale: Locale;
  patient_id: UUID | null; // set for role=patient
  organization_ids: UUID[];
  caregiver_patient_ids: UUID[];
  caregiver_patients: { id: UUID; full_name: string; full_name_ar: string | null; scopes?: CaregiverScope[] }[];
  mfa_enabled: boolean;
  /** Set after an administrator reset the password: the app must ask for a new one before anything else. */
  must_change_password?: boolean;
}

/** auth.login answers with a session, or (staff with two-factor enabled) asks for a 6-digit code. */
export type LoginResult = { token: string; user: SessionUser; mfa_required?: false } | { mfa_required: true; mfa_token: string };

export interface RegisterInput {
  email: string; password: string; full_name: string; full_name_ar?: string;
  date_of_birth: ISODate; sex: 'male' | 'female'; phone?: string; governorate?: string; city?: string;
  preferred_language: Locale; diabetes_type: Patient['diabetes_type'];
  pregnant?: boolean; uses_insulin_pump?: boolean;
  consents: { terms: boolean; data_processing: boolean; ai_processing: boolean };
}
/** A family member's sign-up, with the one-time code the patient gave them. */
export interface CaregiverRegisterInput {
  account_type: 'caregiver';
  email: string; password: string; full_name: string; full_name_ar?: string; preferred_language: Locale;
  invite_code: string; relationship?: string;
  consents: { terms: boolean };
}
/** What a family member may do: read is always included; log = daily logging, appointments, messages, Care Access and
 *  the Companion; manage = changing the record (medicines, conditions, allergies, profile, sensor, clinic links). */
export type CaregiverScope = 'read' | 'log' | 'manage';
export interface CaregiverList {
  caregivers: { user_id: UUID; full_name: string; full_name_ar: string | null; email: string; relationship: string | null; granted_at: ISODate; scopes: CaregiverScope[] }[];
  invites: { code: string; relationship: string | null; expires_at: ISODate; created_at: ISODate; scopes: CaregiverScope[] }[];
  email_enabled?: boolean;
  /** Only returned by invite_caregiver: the new code, shown once. */
  code?: string;
}
export interface TeamMessage {
  id: UUID; body: string; author_role: Role; author_name: string | null; author_name_ar: string | null;
  from_team: boolean; emergency: boolean; created_at: ISODate; read_by_patient_at: ISODate | null;
}
export interface TeamThread { patient_id: UUID; linked: boolean; messages: TeamMessage[] }

/* --------------------------------------------------------------- patient */

export interface Patient {
  id: UUID;
  mrn: string;
  full_name: string;
  full_name_ar: string | null;
  date_of_birth: ISODate;
  age: number;
  sex: 'male' | 'female';
  phone: string | null;
  governorate: string | null;
  city: string | null;
  preferred_language: Locale;
  diabetes_type: 'type2' | 'type1' | 'prediabetes' | 'none';
  diagnosis_year: number | null;
  height_cm: number | null;
  pregnant: boolean;
  uses_insulin_pump: boolean;
  tier: 'linked' | 'unlinked';
  exclusions: string[]; // e.g. ['pregnancy', 'closed_loop_pump']
  care_team: { user_id: UUID; full_name: string; role: Role; organization: string | null }[];
}

export interface PatientState {
  glycemic_state: 'in_range' | 'worsening_pattern' | 'improving' | 'hypo_risk' | 'insufficient_data';
  medication_state: 'adherent' | 'partially_adherent' | 'non_adherent' | 'no_medications' | 'unknown';
  care_plan_state: 'active' | 'none' | 'draft';
  screening_state: string; // 'up_to_date' or '<type>_overdue'
  safety_state: 'stable' | 'open_safety_findings' | 'recent_hypoglycemia' | 'severe_hypoglycemia';
  episode_state: string | null; // open episode status
  engagement_state: 'active' | 'low' | 'inactive';
  data_quality: 'good' | 'sparse' | 'stale' | 'none';
  tier: 'linked' | 'unlinked';
  exclusions: string[];
}

/* -------------------------------------------------------------- clinical */

export interface Condition {
  id: UUID; code: string | null; display: string; display_ar: string | null;
  status: 'active' | 'resolved'; onset_date: ISODate | null; resolved_at?: ISODate | null;
  verification_status: VerificationStatus; source: Source; created_at: ISODate;
}
export interface Allergy {
  id: UUID; substance: string; substance_class: string | null; reaction: string | null;
  severity: 'mild' | 'moderate' | 'severe'; verification_status: VerificationStatus; source: Source; created_at: ISODate;
  status?: 'active' | 'inactive';
}
export interface Medication {
  id: UUID; name: string; generic: string | null; drug_class: string | null;
  dose_text: string | null; frequency: string | null; times: string[]; // "08:00"
  status: 'active' | 'stopped'; start_date: ISODate | null;
  verification_status: VerificationStatus; source: Source;
  adherence_7d: number | null; // 0..100
  /** What is left since the last count (null: never counted). */
  supply?: MedicationSupply | null;
}
export interface MedicationSupply {
  counted: number; units_per_dose: number; counted_at: ISODate; remaining: number; days_left: number | null;
  runs_out_on: ISODate | null; refill_due: boolean;
}
export interface RefillDue { medication_id: UUID; name: string; days_left: number | null; remaining: number; runs_out_on: ISODate | null }
/** Why a dose was missed or skipped; not_available, cost and side_effects reach the care team. */
export type DoseReason = 'forgot' | 'side_effects' | 'not_available' | 'cost' | 'felt_well' | 'fasting' | 'other';
export const DOSE_REASONS: DoseReason[] = ['forgot', 'not_available', 'cost', 'side_effects', 'felt_well', 'fasting', 'other'];
export type DataRequestType = 'correction' | 'erasure' | 'objection' | 'restriction' | 'question';
export interface DataRequest {
  id: UUID; type: DataRequestType; details: string | null; status: 'open' | 'in_progress' | 'completed' | 'rejected';
  created_at: ISODate; due_at: ISODate; resolved_at: ISODate | null; resolution: string | null;
}
export interface AdminDataRequest extends DataRequest { patient_id: UUID; patient_name: string | null; mrn: string | null; overdue: boolean }
export interface AccessLogEntry { at: ISODate; action: string; entity: string | null; actor: string; organization: string | null; organization_ar: string | null }
export interface Breach {
  id: number; at: ISODate; message: string; severity: 'low' | 'medium' | 'high'; status: 'open' | 'resolved' | 'dismissed';
  reported_at: ISODate | null; report_due_at: ISODate; report_overdue: boolean;
}
export type MeterRead =
  | { read: true; value_mgdl: number | null; hi_lo: 'HI' | 'LO' | null; confidence: 'high' | 'medium'; converted_from_mmol?: boolean }
  | { read: false; reason: 'no_reading' | 'unsure' | 'out_of_range' | 'bad_image' | 'ai_off' };
export interface PushSubscriptionInput { endpoint: string; keys: { p256dh: string; auth: string }; locale?: Locale; user_agent?: string }
export interface LabResult {
  id: UUID; test_code: string; display: string; display_ar?: string | null; value: number; unit: string;
  ref_low: number | null; ref_high: number | null; flag: 'low' | 'normal' | 'high' | null;
  observed_at: ISODate; verification_status: VerificationStatus; source: Source; age_days: number;
  /** At a critical limit or a large change (safety_rules.critical_labs): needs a doctor's review today. */
  critical?: boolean;
}
export interface Vital {
  id: UUID; type: 'blood_pressure' | 'weight' | 'heart_rate';
  systolic: number | null; diastolic: number | null; value: number | null; unit: string | null;
  measured_at: ISODate; source: Source;
}
export interface SafetyFinding {
  id: UUID; medication_id: UUID | null; kind: 'interaction' | 'allergy' | 'condition' | 'renal' | 'food';
  severity: 'info' | 'moderate' | 'major' | 'contraindicated'; title: string; detail: string;
  explanation: string | null; // AI explanation, filled asynchronously (WF-007)
  explanation_ar: string | null;
  status: 'open' | 'acknowledged' | 'resolved'; created_at: ISODate;
}
export interface HealthSummary {
  conditions: Condition[]; allergies: Allergy[]; medications: Medication[];
  labs: LabResult[]; vitals: Vital[]; safety_findings: SafetyFinding[];
  egfr: { value: number | null; observed_at: ISODate | null; stage: string | null };
}
export interface TimelineEvent {
  at: ISODate; kind: string; title: string; detail: string | null; ref_id: UUID | null;
}

/* --------------------------------------------------------------- glucose */

export type GlucoseContext = 'fasting' | 'pre_meal' | 'post_meal' | 'bedtime' | 'night' | 'random';
export interface GlucoseReading {
  id: number; value_mgdl: number; measured_at: ISODate; source: Source; context: GlucoseContext | null;
}
export interface GlucoseMetrics {
  days: number; readings: number; cgm: boolean; coverage_pct: number | null;
  mean: number | null; sd: number | null; cv: number | null; gmi: number | null;
  tir: number | null; tar_level1: number | null; tar_level2: number | null;
  tbr_level1: number | null; tbr_level2: number | null;
  fasting_mean: number | null; post_meal_mean: number | null;
  latest: { value_mgdl: number; measured_at: ISODate; age_minutes: number; source: Source } | null;
  data_quality: 'good' | 'sparse' | 'stale' | 'none';
}
export interface GlucosePattern {
  type: 'repeated_fasting_elevation' | 'post_meal_rise' | 'recurrent_lows' | 'nocturnal_lows'
      | 'early_morning_rise' | 'weekday_weekend_difference' | 'baseline_deviation';
  severity: 'info' | 'attention' | 'urgent';
  title: string; title_ar: string; detail: Record<string, unknown>; evidence_count: number;
}
export interface AgpHour { hour: number; p10: number; p25: number; p50: number; p75: number; p90: number; n: number }
export interface DailyGlucose { day: ISODate; mean: number; tir: number | null; min: number; max: number; n: number }
export interface NightscoutStatus {
  connected: boolean; url: string | null;
  status: 'DISCONNECTED' | 'VALIDATING' | 'ACTIVE' | 'DEGRADED' | 'STALE' | 'REVOKED';
  last_sync_at: ISODate | null; last_reading_at: ISODate | null;
}

/* ------------------------------------------------------------- lifestyle */

export interface Food {
  id: UUID; name: string; name_ar: string; category: string;
  portion_desc: string; portion_desc_ar: string; carbs_g: number; kcal: number;
  gi_category: 'low' | 'medium' | 'high'; egyptian: boolean;
}
export interface MealLog {
  id: UUID; eaten_at: ISODate; meal_type: 'breakfast' | 'lunch' | 'dinner' | 'snack';
  items: { food_id: UUID; name: string; name_ar: string; portions: number; carbs_g: number; kcal?: number | null }[];
  est_carbs_g: number;
  /** Calories of the meal, from the food list (kcal per portion x portions). */
  est_kcal?: number | null;
  notes: string | null;
  response: { pre: number | null; peak: number | null; rise: number | null; sensor_ok: boolean } | null;
}
export interface LifestyleSummary {
  days: number; steps_avg: number | null; active_minutes_avg: number | null; sleep_hours_avg: number | null;
  weight_latest: number | null; weight_change_30d: number | null;
  meals: MealLog[]; checkins: { at: ISODate; mood: number; stress: number; energy: number; note: string | null }[];
  /** kcal: energy burned (MET minutes, or steps when no minutes were logged). */
  activity: { date: ISODate; steps: number; minutes: number; kcal?: number }[];
  energy?: EnergySummary;
}
/** Calories eaten (from logged meals), burned (from logged activity) and estimated daily needs. */
export interface EnergySummary {
  eaten_today_kcal: number; meals_today: number; burned_today_kcal: number;
  eaten_avg_kcal: number | null; days_with_meals: number;
  daily: { date: ISODate; kcal: number; carbs_g: number; meals: number }[];
  /** Mifflin-St Jeor x activity factor; null in pregnancy or without weight and height. Informational, not a target. */
  needs: { kcal: number | null; note: 'estimate' | 'pregnancy' | 'needs_weight_height' | 'unknown_patient'; bmr?: number; activity_factor?: number };
  weight_kg_used: number; weight_is_estimate: boolean;
}

/* ------------------------------------------------------------------ care */

export interface CarePlanTargets {
  fasting_low?: number; fasting_high?: number; post_meal_high?: number;
  tir_target?: number; hba1c_target?: number; bp_systolic?: number; bp_diastolic?: number;
  steps_target?: number; tbr_max?: number;
}
/** Personalized care (engine 32_personal.js). */
export type TargetTier = 'tighter' | 'standard' | 'relaxed' | 'older_complex' | 'pregnancy';
export interface PersonalTargets {
  tier: TargetTier;
  suggested: { hba1c_target: number; tir_target: number; tbr_max: number; fasting_low: number; fasting_high: number; post_meal_high: number } | null;
  reasons: { key: string; en: string; ar: string; ref: string }[];
  current: CarePlanTargets & { personalized?: boolean };
  differs_from_plan: boolean;
}
export type TherapyDecision = 'started' | 'not_appropriate' | 'patient_declined' | 'cost' | 'later';
export interface TherapyItem {
  code: string; kind: 'consider' | 'review'; title_en: string; title_ar: string; ref: string;
  data_used: Record<string, unknown>; cost_band: 'low' | 'medium' | 'high' | null;
  review?: { decision: TherapyDecision; note: string | null; at: ISODate };
}
export interface TherapyConsiderations { items: TherapyItem[]; hidden: TherapyItem[] | number; not_applicable?: string }
export interface FoodResponse { food_id: UUID | null; name: string; name_ar: string | null; gi: 'low' | 'medium' | 'high' | null; meals: number; mean_rise: number; max_rise: number; sensor_meals: number; band?: 'gentle' | 'moderate' | 'high' }
export interface FoodProfile {
  days: number; meals_with_readings: number; meals_logged: number; foods: FoodResponse[]; high: FoodResponse[]; gentle: FoodResponse[];
  by_meal: { meal_type: string; meals: number; mean_rise: number }[]; note: 'few_readings' | null;
}
export interface Preferences {
  simple_words: boolean | null; prefers_voice: boolean | null; budget_sensitive: boolean | null;
  meal_pattern: 'three_meals' | 'two_meals_snacks' | 'irregular' | null; work_shift: 'day' | 'night' | 'rotating' | 'none' | null;
  who_cooks: 'self' | 'family' | 'eats_out' | null; wake_time: string | null; sleep_time: string | null;
  fasting_days: string[] | null; goals_text: string | null; updated_at?: ISODate | null;
}
export interface KidneyRisk { eligible: boolean; reason?: string; two_year_pct?: number; five_year_pct?: number; inputs?: { age: number; sex: string; egfr: number; uacr: number }; refer?: boolean; ref?: string }
/** Wellbeing check-ins and sick-day mode (engine 33_wellbeing.js). */
export type CheckinKind = 'paid5' | 'phq2' | 'phq9' | 'stopbang';
export interface CheckinResult { score: number; band: string; at: ISODate }
export interface WellbeingStatus { due: CheckinKind[]; latest: Record<CheckinKind, CheckinResult | null>; stopbang_record: { bmi: number | null; bmi_over: boolean; age_over: boolean; male: boolean } }
export interface CheckinSubmitted { id: UUID; kind: CheckinKind; score: number; band: string; crisis: boolean; next: CheckinKind | null; message_en?: string; message_ar?: string; record: WellbeingStatus['stopbang_record'] | null }
export type SickSymptom = 'vomiting' | 'diarrhea' | 'fever' | 'not_eating' | 'not_drinking';
export interface SickStatus {
  active: boolean; id: UUID | null; started_at: ISODate | null; symptoms: Partial<Record<SickSymptom, boolean>> | null; check_hours: number; max_days: number;
  medicines: { medication_id: UUID; name: string; drug_class: string; note: 'often_paused' | 'low_risk' | 'never_stop' }[];
  readings: { count: number; highest: number | null; lowest: number | null } | null;
}
export interface DriveCheck { eligible: boolean; verdict: 'measure' | 'eat_first' | 'ok'; value: number | null; minutes_ago: number | null; min_mgdl: number; recheck_hours: number; wait_after_low_min: number }
/** Monitoring dashboard, alerts and calibration (engine 35_monitoring.js). */
export type JudgeDim = 'factual_accuracy' | 'grounded' | 'safety' | 'format_adherence' | 'bias';
export interface Agreement { n: number; exact?: number; within1?: number; kappa?: number | null }
export interface CalibrationReport { pairs: number; min_pairs: number; calibrated: boolean; dimensions: Record<JudgeDim, { rater_a_vs_judge: Agreement; rater_b_vs_judge: Agreement; rater_a_vs_b: Agreement }> }
export interface MonitoringKpi { key: string; lens: string; baseline: number | null; target: number; unit: string; actual: number | null; n: number; self_care?: number }
export interface Monitoring {
  days: number; kpis: MonitoringKpi[];
  judge: { judged: number; pass_rate: number | null; scores: Record<JudgeDim, number | null>; low_safety: number };
  failed_runs: { ai: number; total: number; rate: number | null; workflow_errors: number };
  response_time_ms: { companion_p50: number | null; companion_p90: number | null; n: number };
  escalations: { total: number; critical: number; by_category: Record<string, number> };
  reviews: { pending: number; overdue: number; decided: number };
  by_workflow: Record<string, { runs: number; failed: number }>;
  alerts: { companion_paused: boolean; rules: Record<string, unknown>; recent: { id: number; at: ISODate; node: string; severity: string; status: string; message: string }[] };
  calibration: CalibrationReport;
}
export interface CalibrationItem { trial_id: UUID; workflow: string; locale: string | null; question: string | null; answer: string | null }
/** Held Companion answers waiting for a nurse (engine 36_reviews.js). */
export interface AiReview {
  id: UUID; patient_id: UUID; patient_name: string | null; patient_name_ar: string | null; mrn: string | null; question: string | null; draft: string;
  citations: unknown[]; signals: string[]; status: 'pending' | 'approved' | 'edited' | 'rejected'; final_content: string | null; note: string | null;
  created_at: ISODate; due_at: ISODate; decided_at: ISODate | null; overdue: boolean;
}
export interface Personalization { targets: PersonalTargets; therapy: TherapyConsiderations; food: FoodProfile; preferences: Preferences;
  kidney_risk: KidneyRisk; wellbeing: WellbeingStatus['latest']; sick_day: SickStatus }
export interface CarePlanItem {
  id?: UUID; kind: 'monitoring' | 'medication' | 'lifestyle' | 'education' | 'screening' | 'appointment';
  title: string; title_ar?: string | null; detail?: string | null;
  schedule?: { times_per_day?: number; times?: string[]; days?: number[] } | null;
}
export interface CarePlan {
  id: UUID; patient_id: UUID; version: number; status: 'DRAFT' | 'PUBLISHED' | 'ACTIVE' | 'SUPERSEDED';
  title: string; summary: string | null; summary_ar: string | null; targets: CarePlanTargets;
  items: CarePlanItem[]; authored_by: string | null; published_at: ISODate | null;
  what_changed: { en: string; ar: string } | null; // AI explanation (WF-010)
}
export interface CareTask {
  id: UUID; title: string; title_ar: string | null; kind: string; due_at: ISODate | null;
  status: 'pending' | 'done' | 'skipped';
}
export interface Screening {
  type: string; title: string; title_ar: string; last_done: ISODate | null; next_due: ISODate | null; overdue: boolean;
}
export interface Appointment {
  id: UUID; patient_id: UUID; patient_name: string; provider_name: string | null; facility_name: string | null;
  starts_at: ISODate; ends_at: ISODate | null; type: string; channel: 'in_person' | 'video' | 'phone';
  status: 'requested' | 'booked' | 'checked_in' | 'completed' | 'cancelled' | 'no_show'; reason: string | null;
  has_brief: boolean;
}

/* ----------------------------------------------------------- care access */

export type CareLevel =
  | 'self_care' | 'routine_appointment' | 'primary_care' | 'specialist'
  | 'same_day' | 'urgent_care' | 'emergency_department' | 'emergency_services';

export type EpisodeStatus =
  | 'DRAFT' | 'INTAKE_IN_PROGRESS' | 'ASSESSED' | 'ROUTED' | 'ACTION_SELECTED'
  | 'CARE_RECEIVED' | 'FOLLOW_UP' | 'RESOLVED' | 'CLOSED' | 'ESCALATED';

export interface IntakeQuestion {
  id: string; text_en: string; text_ar: string;
  type: 'single' | 'multi' | 'number' | 'text' | 'yesno';
  options?: { value: string; label_en: string; label_ar: string }[] | null;
  red_flag?: boolean;
}
export interface Assessment {
  care_level: CareLevel; specialty: string | null; channel: 'in_person' | 'video' | 'phone' | 'emergency';
  rules_fired: string[]; red_flags: string[];
  explanation: { en: string; ar: string } | null; // AI explanation, never the decision
}
export interface Episode {
  id: UUID; patient_id: UUID; status: EpisodeStatus; chief_complaint: string;
  started_at: ISODate; answers: Record<string, unknown>; assessment: Assessment | null;
  recommended_facilities: FacilityMatch[]; followups: { id: UUID; due_at: ISODate; status: string; response: unknown }[];
  /** Only returned by episodes.get: the pending question when intake is still in progress (resume). */
  next_question?: IntakeQuestion | null;
  /** Only returned by episodes.followup: set when the follow-up text contains emergency warning signs. */
  emergency?: { emergency: true; matched: string[]; message_en: string; message_ar: string } | null;
}
/** Fixed emergency guidance from the deterministic pre-screen. `matched` holds category ids (for example chest_pain). */
export interface EmergencyInfo { emergency: true; matched: string[]; message_en: string; message_ar: string; level?: 'emergency' }
/** Same-day problem (an infected or black foot wound): see a doctor today. Not an emergency; the care team is told. */
export interface UrgentInfo { emergency: false; urgent: true; level: 'same_day'; urgent_matched: string[]; message_en: string; message_ar: string }
export interface IntakeStepResult {
  episode: Episode;
  emergency: EmergencyInfo | null;
  next_question: IntakeQuestion | null; // null when assessment is complete
}

/* --------------------------------------------------------------- network */

export interface FacilityMatch {
  id: UUID; name: string; name_ar: string; type: string; governorate: string; city: string;
  address: string | null; phone: string | null; distance_km: number | null;
  lat?: number | null; lng?: number | null;
  specialties: string[]; services: string[]; open_now: boolean | null;
  /** 'network': a verified facility; 'openstreetmap': a directory listing (unverified, © OpenStreetMap contributors). */
  source?: 'network' | 'openstreetmap'; verified?: boolean;
  capacity: { resource: string; available: number | null; total: number | null; status: 'available' | 'limited' | 'full' | 'unknown'; updated_at: ISODate | null; stale: boolean }[];
}
export interface Referral {
  id: UUID; patient_id: UUID; patient_name: string; to_specialty: string; to_facility_name: string | null;
  urgency: 'routine' | 'soon' | 'urgent'; reason: string;
  status: 'CREATED' | 'MATCHING' | 'SELECTED' | 'BOOKED' | 'CONSULTED' | 'REPORT_RETURNED' | 'CLOSED';
  report: string | null; created_at: ISODate;
}

export interface DocumentRecord {
  id: UUID; patient_id: UUID; title: string; kind: 'lab_report' | 'prescription' | 'discharge_summary' | 'imaging' | 'other';
  file_name: string | null; mime_type: string | null; size_bytes: number | null; has_file: boolean;
  status: 'uploaded' | 'extracting' | 'extracted' | 'extraction_failed' | 'verified' | 'rejected';
  extracted: {
    summary: string | null;
    summary_ar?: string | null;
    /** contains_instructions: the document had text addressed to an AI (treat the suggestions with extra care);
     *  illegible: most of it could not be read. */
    warnings?: ('contains_instructions' | 'illegible')[];
    labs: { test_code: string; display: string; value: number; unit: string; observed_at: ISODate | null }[];
    medications: { name: string; dose_text: string | null; frequency: string | null }[];
    conditions: { display: string }[];
    model: string | null;
  } | null;
  created_at: ISODate;
}

export interface Transfer {
  id: UUID; patient_id: UUID; patient_name: string;
  from_facility_name: string | null; to_facility_id: UUID | null; to_facility_name: string | null;
  requirements: { resource: string; specialty: string | null; reason: string; urgency: 'urgent' | 'emergent' | 'routine' };
  status: 'REQUESTED' | 'UNDER_REVIEW' | 'ACCEPTED' | 'DECLINED' | 'BED_RESERVED' | 'IN_TRANSPORT' | 'ARRIVED' | 'CANCELLED';
  /** Facilities that have the required resource with fresh (under 6 h), non-full capacity. */
  eligible_facilities: FacilityMatch[];
  created_by_name: string | null; created_at: ISODate; updated_at: ISODate;
}

export interface StaffUser {
  id: UUID; email: string; full_name: string; full_name_ar: string | null; role: Role; active: boolean;
  mfa_enabled: boolean; organizations: string[]; created_at: ISODate;
}

export interface LinkRequest {
  id: UUID; patient_id: UUID; patient_name: string; organization_id: UUID; organization_name: string; organization_name_ar: string | null;
  message: string | null; status: 'pending' | 'accepted' | 'declined'; created_at: ISODate;
}

/* ------------------------------------------------------------- companion */

/** A source behind an AI text. Guideline citations name the issuing body and edition and link to the publisher or DOI. */
/** A source behind an AI answer. excerpt: the cited passage (guideline text, or the record item's summary). The answer marks it inline as [n], n = its position. */
export interface Citation { id: string; title: string; source: string; kind: 'record' | 'guideline'; url?: string; excerpt?: string }
export interface CompanionReply {
  content: string; language: Locale; citations: Citation[];
  suggested_actions: { type: 'open_care_access' | 'log_glucose' | 'book_appointment' | 'view_plan' | 'call_emergency'; label: string }[];
  emergency: boolean; safety_notice: string | null; fallback: boolean;
  /** Same-day problem found by the pre-screen (fixed text, see a doctor today). */
  urgent?: boolean;
  /** 'fixed': a fixed safety or policy text (pre-screen, dose question, gate, withheld answer); 'model': written by a model. */
  source?: 'fixed' | 'model';
  /** Set when an AI gate stopped the request before any model ran (paused: model answers switched off by a hard alert). */
  blocked?: 'rate_limited' | 'no_consent' | 'injection' | 'paused';
  /** Held for a nurse to approve (engine 36_reviews.js); reviewed: what the care team did with it. */
  held?: boolean;
  reviewed?: 'approved' | 'edited' | 'rejected';
  /** Answered by the on-site model (no cloud consent or cloud processing switched off); the data did not leave the server. */
  local?: boolean;
  /** True when the message was also placed in the care team's inbox (only possible for linked patients). */
  routed?: boolean;
}
export interface ConsentState {
  consents: { type: 'terms' | 'data_processing' | 'ai_processing'; granted: boolean | null; at: ISODate | null; changeable: boolean }[];
  ai_state: 'granted' | 'withdrawn' | 'not_recorded';
  cloud_ai_enabled: boolean;
}
export interface ChatMessage {
  id: UUID; role: 'user' | 'assistant'; content: string; created_at: ISODate;
  meta: Partial<CompanionReply> | null;
}

/* -------------------------------------------------------------- insights */

export interface Insight {
  id: UUID; kind: 'pattern' | 'weekly' | 'lab' | 'safety' | 'plan_change' | 'hypo';
  title: string; title_ar: string | null; body: string; body_ar: string | null; citations: Citation[];
  created_at: ISODate; read_at: ISODate | null;
  /** True when a model wrote the text; false for fixed rule-based text. */
  ai_written?: boolean;
}
export interface Notification {
  id: UUID; title: string; title_ar: string | null; body: string; body_ar: string | null; kind: string; created_at: ISODate; read_at: ISODate | null;
}

/* ---------------------------------------------------------------- today */

export interface TodayPayload {
  patient: Patient;
  /** Replies from the care team the patient has not opened yet. */
  unread_messages?: number;
  state: PatientState;
  focus: { kind: string; title: string; title_ar: string; action: string | null } | null;
  safety_alerts: { id: UUID; kind?: 'low_glucose' | 'high_glucose' | 'medication_safety' | 'critical_lab'; title: string; title_ar: string | null; body: string; body_ar: string | null; severity: string; created_at: ISODate }[];
  glucose: GlucoseMetrics;
  medications_due: { medication_id: UUID; name: string; dose_text: string | null; time: string; status: 'due' | 'taken' | 'missed' | 'skipped' }[];
  /** Medicines that run out soon (counted supply). */
  refills_due?: RefillDue[];
  /** On insulin or a sulfonylurea: show the before-driving check. */
  drive_check?: boolean;
  /** Sick-day mode is on. */
  sick_day?: boolean;
  wellbeing_due?: CheckinKind[];
  tasks: CareTask[];
  appointments: Appointment[];
  insights: Insight[];
  screenings_overdue: Screening[];
  activity_today: { steps: number; target: number | null };
  /** Time of the latest meal logged in the past 24 hours (for the "measure after a meal" prompt). */
  last_meal_at?: ISODate | null;
}

/* -------------------------------------------------------------- provider */

export interface InboxItem {
  id: UUID; patient_id: UUID; patient_name: string;
  category: 'safety' | 'glucose' | 'result' | 'question' | 'verification' | 'referral' | 'care_plan' | 'episode' | 'ai_review';
  urgency: 'info' | 'low' | 'medium' | 'high' | 'critical'; // patient urgency
  priority: 1 | 2 | 3 | 4 | 5; // clinician workflow priority (1 = first)
  title: string; body: string | null; payload: Record<string, unknown>;
  status: 'OPEN' | 'ROUTED' | 'ACKNOWLEDGED' | 'ACTIONED' | 'RESOLVED'; created_at: ISODate;
}
export interface PanelPatient {
  id: UUID; full_name: string; full_name_ar: string | null; age: number; sex: string;
  glycemic_state: string | null; tir_14d: number | null; mean_14d: number | null;
  last_reading_at: ISODate | null; open_items: number; next_appointment: ISODate | null; exclusions: string[];
  /** True for reception staff: names and appointment times only, clinical values are withheld. */
  restricted: boolean;
}
export interface PreVisitBrief {
  id: UUID; appointment_id: UUID | null; created_at: ISODate;
  content: {
    reason_for_visit: string; changes_since_last_visit: string[]; glucose_summary: string;
    medication_adherence: string; important_events: string[]; labs: string[];
    overdue_screenings: string[]; data_gaps: string[]; patient_questions: string[];
    clinical_interpretation: string; // MedGemma
    /** Recommendations from accredited guidelines that apply to this patient (model-written, each tied to a retrieved section). */
    guideline_points?: string[];
    /** Rule outputs (engine 32_personal.js): suggested personal targets and treatment considerations. */
    considerations?: string[];
  };
  sources: Citation[]; model: string;
}
export interface Workspace {
  patient: Patient; state: PatientState; metrics_14d: GlucoseMetrics; metrics_90d: GlucoseMetrics;
  patterns: GlucosePattern[]; health: HealthSummary; plan: CarePlan | null; plan_draft: CarePlan | null;
  episodes: Episode[]; referrals: Referral[]; appointments: Appointment[];
  brief: PreVisitBrief | null; insights: Insight[]; screenings: Screening[];
}

/* ----------------------------------------------------------------- admin */

export interface RagDocument {
  id: UUID; title: string; source: string; version: string; language: Locale; region: string | null;
  population: string | null; status: 'draft' | 'approved' | 'retired'; published_at: ISODate | null;
  review_date: ISODate | null; chunks: number; created_at: ISODate;
  quarantined_chunks?: number;
  /** manual = written by the team; fetched = an accredited guideline section imported by WF-024. */
  origin?: 'manual' | 'fetched'; audience?: 'patient' | 'clinician';
  /** Who added and who approved it (four eyes: the author cannot approve). */
  created_by?: UUID | null; approved_by?: UUID | null;
  publisher?: string | null; source_key?: string | null; source_version?: string | null; source_url?: string | null;
  external_ids?: { pmid?: string; pmcid?: string; doi?: string } | null; license?: string | null; license_confirmed_at?: ISODate | null;
  screening?: { verdict: 'clean' | 'suspicious' | 'block'; signals: string[]; score: number } | null; superseded?: boolean;
}
/** An accredited guideline source watched by WF-024 (registry entry with its review state). */
export interface GuidelineEditionItem { pmid?: string; pmcid?: string; doi?: string; title: string; journal?: string; pubdate?: string | null; url: string }
export interface GuidelineSource {
  key: string; publisher: string; title: string; accreditation: string; method: 'pmc' | 'pubmed_watch' | 'web';
  ingest: 'full_text' | 'watch_only'; license: string | null; language: Locale; audience: 'patient' | 'clinician';
  check_every_days: number; review_months: number; active: boolean;
  current_version: string | null; pending_version: string | null; dismissed_versions: string[];
  last_checked_at: ISODate | null; last_status: 'unchanged' | 'new_edition' | 'watch_update' | 'not_licensed' | 'retracted' | 'error' | null;
  last_error: string | null; last_found: Record<string, unknown> | null;
  pending_documents: number; pending_flagged: number; approved_documents: number; due: boolean;
  open_updates: { id: UUID; version: string; detected_at: ISODate; items: GuidelineEditionItem[] }[];
}
export interface GuidelineCheckResult { key: string; status: string; version?: string | null; documents?: number; flagged?: number; error?: string }
export interface AiRun {
  id: UUID; workflow: string; patient_id: UUID | null;
  /** BLOCKED: stopped by an AI gate (prompt injection, rate limit, no AI consent), not a model failure. */
  status: 'QUEUED' | 'PROCESSING' | 'VERIFYING' | 'COMPLETED' | 'FAILED' | 'FALLBACK' | 'BLOCKED';
  model: string | null; latency_ms: number | null; created_at: ISODate; error: string | null;
  verifier: { approved: boolean | null; issues: string[] } | null;
  prompt_version: string | null;
  gate: { route?: string; injection?: { verdict: string; signals: string[] }; redactions?: Record<string, number>; evidence?: string } | null;
  /** How the answer was released: approved, rejected, withheld_unverified_risk, withheld_unverified,
   *  released_unverified_low_risk, replaced_by_guard, withheld_local, withheld_local_unverified, released_local_unverified,
   *  fixed_local_*, fixed_text, static_fallback. (withheld_unverified / withheld_local_unverified: the
   *  companion_require_verified flag, on by default; the released_* labels occur only with it off.) */
  release?: string | null;
  /** Risk signals that made a verifier approval necessary (suspicious_input, medicine_named, symptom_described ...). */
  risk?: string[];
}

/* ------------------------------------------------------- action catalogue */

/** One part of a page action (37_pages.js): the action's answer, or { error } when that part was refused or failed. */
export type Part<T> = T | { error: string };

export interface Actions {
  auth: {
    login: [{ email: string; password: string }, LoginResult];
    /** Second login step for staff with two-factor enabled. */
    verify_mfa: [{ mfa_token: string; code: string }, { token: string; user: SessionUser }];
    /** Patient self-registration: adults 18+ only; pregnancy / insulin pump are recorded as excluded populations. */
    register: [RegisterInput | CaregiverRegisterInput, { token: string; user: SessionUser }];
    me: [{}, SessionUser];
    logout: [{}, { ok: true }];
    change_password: [{ current_password: string; new_password: string }, { ok: true }];
    /** Starts two-factor setup: returns a base32 secret and an otpauth:// URL to show as a QR code. */
    mfa_setup: [{}, { secret: string; otpauth_url: string }];
    mfa_enable: [{ code: string }, { ok: true }];
    mfa_disable: [{ code: string }, { ok: true }];
    /** A signed-in caregiver adds another person with a new invitation code. */
    redeem_invite: [{ code: string; relationship?: string }, SessionUser];
    /** Public. Same answer whether or not the email has an account; email_enabled says whether a link was sent. */
    forgot_password: [{ email: string }, { ok: true; email_enabled: boolean }];
    reset_with_token: [{ token: string; new_password: string }, { ok: true }];
    /** Closes the account after the current password is confirmed. */
    delete_account: [{ password: string }, { ok: true }];
  };
  today: {
    get: [{ patient_id?: UUID }, TodayPayload];
    page: [{ patient_id?: UUID }, { today: Part<TodayPayload>; notifications: Part<Notification[]>; recent: Part<GlucoseReading[]> }];
  };
  profile: {
    get: [{ patient_id?: UUID }, Patient];
    update: [{ patient_id?: UUID; phone?: string; governorate?: string; city?: string; preferred_language?: Locale; height_cm?: number; pregnant?: boolean; uses_insulin_pump?: boolean }, Patient];
    /** Everything the service holds about the patient, as one JSON document. */
    export: [{}, Record<string, unknown>];
    consents: [{}, ConsentState];
    set_consent: [{ type: 'ai_processing'; granted: boolean }, ConsentState];
    state: [{ patient_id?: UUID }, PatientState];
    push_subscribe: [PushSubscriptionInput, { ok: true; devices: number }];
    preferences: [{ patient_id?: UUID }, Preferences];
    set_preferences: [{ patient_id?: UUID } & Partial<Omit<Preferences, 'updated_at'>>, Preferences];
    push_unsubscribe: [{ endpoint?: string }, { ok: true; removed: number }];
    data_request: [{ type: DataRequestType; details?: string }, DataRequest];
    data_requests: [{}, DataRequest[]];
    access_log: [{ limit?: number }, AccessLogEntry[]];
  };
  clinical: {
    summary: [{ patient_id?: UUID }, HealthSummary];
    timeline: [{ patient_id?: UUID; limit?: number }, TimelineEvent[]];
    add_condition: [{ patient_id?: UUID; display: string; code?: string; onset_date?: ISODate }, Condition];
    add_allergy: [{ patient_id?: UUID; substance: string; substance_class?: string; reaction?: string; severity: Allergy['severity'] }, Allergy];
    add_medication: [{ patient_id?: UUID; name: string; dose_text?: string; frequency?: string; times?: string[] }, { medication: Medication; safety_findings: SafetyFinding[] }];
    stop_medication: [{ patient_id?: UUID; medication_id: UUID }, Medication];
    /** A patient's dose change sends a confirmed medicine back for the clinician to confirm. */
    update_medication: [{ patient_id?: UUID; medication_id: UUID; dose_text?: string | null; frequency?: string | null; times?: string[] }, Medication];
    resolve_condition: [{ patient_id?: UUID; condition_id: UUID; active?: boolean }, Condition];
    remove_allergy: [{ patient_id?: UUID; allergy_id: UUID }, Allergy];
    log_dose: [{ patient_id?: UUID; medication_id: UUID; status: 'taken' | 'missed' | 'skipped'; scheduled_time?: string; reason?: DoseReason }, { ok: true }];
    set_supply: [{ patient_id?: UUID; medication_id: UUID; supply_count: number; units_per_dose?: number }, { id: UUID; supply: MedicationSupply }];
    add_lab: [{ patient_id?: UUID; test_code: string; value: number; unit?: string; observed_at?: ISODate }, LabResult];
    add_vital: [{ patient_id?: UUID; type: Vital['type']; systolic?: number; diastolic?: number; value?: number; unit?: string; measured_at?: ISODate }, Vital];
    verify: [{ entity: 'condition' | 'allergy' | 'medication' | 'lab'; id: UUID; status: 'verified' | 'refuted' }, { ok: true }];
    /** Doctors and nurses only. */
    acknowledge_finding: [{ finding_id: UUID }, { ok: true }];
    documents: [{ patient_id?: UUID }, DocumentRecord[]];
    /** Upload a photo/PDF (base64, max 4 MB) or pasted text. AI extraction runs in the background (WF-018). */
    upload_document: [{ patient_id?: UUID; title: string; kind: DocumentRecord['kind']; file_name?: string; mime_type?: string; content_base64?: string; text?: string }, DocumentRecord];
    /** Clinician accepts extracted labs (by index) as verified results, or rejects the document. */
    /** default_date (YYYY-MM-DD) is required when an accepted result has no date in the document. A document is reviewed once. */
    review_document: [{ document_id: UUID; decision: 'accept' | 'reject'; lab_indexes?: number[]; default_date?: string }, DocumentRecord];
  };
  glucose: {
    list: [{ patient_id?: UUID; days?: number }, GlucoseReading[]];
    /** Reads a meter screen photo (local model by default). Nothing is saved: the number fills the form. */
    read_meter: [{ patient_id?: UUID; image_base64: string; mime_type: 'image/jpeg' | 'image/png' | 'image/webp' }, MeterRead];
    drive_check: [{ patient_id?: UUID }, DriveCheck];
    /** `event` (guidance) is set for every out-of-range reading taken in the last 2 hours; `new_alert` is true when a new alert was raised. */
    add: [{ patient_id?: UUID; value_mgdl: number; measured_at?: ISODate; context?: GlucoseContext }, {
      reading: GlucoseReading; event: { type: 'hypo' | 'severe_hypo' | 'hyper' | 'severe_hyper'; message_en: string; message_ar: string; new_alert: boolean } | null;
      /** A falling trend that will cross 70 mg/dL soon (deterministic, CGM). */
      prediction?: LowPrediction | null;
      /** During Ramadan fasting hours: a reading that means "break your fast now". */
      ramadan?: { type: 'break_fast'; value: number; message_en: string; message_ar: string } | null;
    }];
    /** Patients: their own typed readings of the last 7 days. */
    delete: [{ patient_id?: UUID; reading_id: number }, { ok: true }];
    metrics: [{ patient_id?: UUID; days?: number }, GlucoseMetrics];
    patterns: [{ patient_id?: UUID; days?: number }, GlucosePattern[]];
    agp: [{ patient_id?: UUID; days?: number }, AgpHour[]];
    daily: [{ patient_id?: UUID; days?: number }, DailyGlucose[]];
    nightscout_status: [{ patient_id?: UUID }, NightscoutStatus];
    page: [{ patient_id?: UUID; days?: number; charts?: boolean }, { metrics: Part<GlucoseMetrics>; list: Part<GlucoseReading[]>; patterns: Part<GlucosePattern[]>; nightscout: Part<NightscoutStatus>; agp?: Part<AgpHour[]>; daily?: Part<DailyGlucose[]> }];
    nightscout_connect: [{ patient_id?: UUID; url: string; token?: string }, NightscoutStatus];
    nightscout_disconnect: [{ patient_id?: UUID }, NightscoutStatus];
  };
  lifestyle: {
    foods: [{ q?: string; category?: string }, Food[]];
    food_profile: [{ patient_id?: UUID; days?: number }, FoodProfile];
    log_meal: [{ patient_id?: UUID; eaten_at?: ISODate; meal_type: MealLog['meal_type']; items: { food_id: UUID; portions: number }[]; notes?: string }, MealLog];
    log_activity: [{ patient_id?: UUID; date?: ISODate; steps?: number; minutes?: number; type?: string }, { ok: true }];
    log_sleep: [{ patient_id?: UUID; date?: ISODate; hours: number; quality?: number }, { ok: true }];
    checkin: [{ patient_id?: UUID; mood: number; stress: number; energy: number; note?: string }, { ok: true }];
    summary: [{ patient_id?: UUID; days?: number }, LifestyleSummary];
    page: [{ patient_id?: UUID }, { summary: Part<LifestyleSummary>; food_profile: Part<FoodProfile> }];
  };
  care: {
    /** Ramadan: dates, today's fasting window, the latest IDF-DAR risk check and the fasting choice. */
    ramadan: [{ patient_id?: UUID }, RamadanStatus];
    ramadan_assess: [{ patient_id?: UUID; answers: RamadanAnswers }, RamadanAssessment];
    /** Refused (forbidden) when the latest risk check is high. */
    ramadan_fasting: [{ patient_id?: UUID; fasting: boolean }, { fasting: boolean }];
    wellbeing: [{ patient_id?: UUID }, WellbeingStatus];
    wellbeing_submit: [{ kind: CheckinKind; answers: number[] }, CheckinSubmitted];
    sick_status: [{ patient_id?: UUID }, SickStatus];
    sick_start: [{ patient_id?: UUID; symptoms: Partial<Record<SickSymptom, boolean>> }, SickStatus];
    sick_end: [{ patient_id?: UUID }, SickStatus];
    plan: [{ patient_id?: UUID }, { active: CarePlan | null; draft: CarePlan | null; tasks: CareTask[] }];
    plan_history: [{ patient_id?: UUID }, CarePlan[]];
    complete_task: [{ task_id: UUID; status?: 'done' | 'skipped' }, { ok: true }];
    screenings: [{ patient_id?: UUID }, Screening[]];
    /** Marks a screening (eye_exam, foot_exam, dental, ...) as done; returns the refreshed list. */
    record_screening: [{ patient_id?: UUID; type: string; done_on?: string }, Screening[]];
    appointments: [{ patient_id?: UUID }, Appointment[]];
    book_appointment: [{ patient_id?: UUID; facility_id?: UUID; provider_user_id?: UUID; starts_at: ISODate; type?: string; channel?: Appointment['channel']; reason?: string; episode_id?: UUID; referral_id?: UUID }, Appointment];
    cancel_appointment: [{ appointment_id: UUID }, { ok: true }];
    /** Staff only: confirm (booked), check in, complete, mark no-show or cancel; optionally move the time. */
    update_appointment: [{ appointment_id: UUID; status: 'booked' | 'checked_in' | 'completed' | 'no_show' | 'cancelled'; starts_at?: ISODate }, Appointment];
    save_plan_draft: [{ patient_id: UUID; title: string; summary?: string; summary_ar?: string; targets: CarePlanTargets; items: CarePlanItem[] }, CarePlan];
    publish_plan: [{ plan_id: UUID }, CarePlan];
    /** Patient/caregiver message to the care team (creates a clinician inbox item when linked). */
    message_team: [{ patient_id?: UUID; text: string }, { ok: true; routed: boolean; emergency: EmergencyInfo | null; urgent?: UrgentInfo | null }];
    /** The conversation with the care team; opening it marks the other side's messages as read. */
    messages: [{ patient_id?: UUID }, TeamThread];
    reply_message: [{ patient_id: UUID; text: string; inbox_item_id?: UUID }, TeamThread];
    caregivers: [{}, CaregiverList];
    my_doctor: [{ patient_id?: UUID }, MyDiabetesDoctor];
    page: [{ patient_id?: UUID }, Record<'profile' | 'plan' | 'screenings' | 'appointments' | 'episodes' | 'referrals' | 'messages' | 'caregivers' | 'my_doctor', unknown>];
    invite_caregiver: [{ relationship?: string; scopes?: CaregiverScope[] }, CaregiverList];
    revoke_caregiver: [{ caregiver_user_id?: UUID; code?: string }, CaregiverList];
    set_caregiver_scopes: [{ caregiver_user_id: UUID; scopes: CaregiverScope[] }, CaregiverList];
    email_invite: [{ code: string; email: string }, { ok: true }];
    /** Clinics a patient can ask to join (for unlinked patients). */
    organizations: [{}, { id: UUID; name: string; name_ar: string | null; type: string; city: string | null }[]];
    request_link: [{ patient_id?: UUID; organization_id: UUID; message?: string }, LinkRequest];
    link_requests: [{ patient_id?: UUID }, LinkRequest[]];
  };
  intake: {
    start: [{ patient_id?: UUID; complaint_text: string }, IntakeStepResult];
    /** yesno: 'yes' | 'no' (booleans and Arabic yes/no are accepted); single: option value; multi: option values; number: number. Invalid answers -> bad_request. */
    answer: [{ episode_id: UUID; question_id: string; answer: string | number | boolean | string[] }, IntakeStepResult];
    free_text: [{ episode_id: UUID; text: string }, IntakeStepResult]; // AI extraction (Gemini) into structured fields
  };
  episodes: {
    list: [{ patient_id?: UUID }, Episode[]];
    get: [{ episode_id: UUID }, Episode];
    select_action: [{ episode_id: UUID; action: 'book' | 'find_care' | 'self_care' | 'emergency' }, Episode];
    followup: [{ episode_id: UUID; status: 'better' | 'same' | 'worse'; new_symptoms?: string; care_obtained?: boolean }, Episode];
  };
  network: {
    /** include_directory: also the unverified OpenStreetMap directory of doctors, pharmacies, hospitals and labs (Cairo, Giza). */
    search: [{ q?: string; type?: string; specialty?: string; service?: string; governorate?: string; lat?: number; lng?: number; limit?: number; include_directory?: boolean }, FacilityMatch[]];
    facility: [{ facility_id: UUID }, FacilityMatch];
    update_capacity: [{ facility_id: UUID; resource: string; available: number; total?: number; status?: FacilityMatch['capacity'][number]['status'] }, FacilityMatch];
    referrals: [{ patient_id?: UUID }, Referral[]];
    create_referral: [{ patient_id: UUID; to_specialty: string; urgency: Referral['urgency']; reason: string; to_facility_id?: UUID }, Referral];
    update_referral: [{ referral_id: UUID; status: Referral['status']; report?: string; to_facility_id?: UUID }, Referral];
    transfers: [{ status?: Transfer['status'] | 'active' | 'all' }, Transfer[]];
    create_transfer: [{ patient_id: UUID; from_facility_id?: UUID; resource: string; specialty?: string; reason: string; urgency: Transfer['requirements']['urgency'] }, Transfer];
    update_transfer: [{ transfer_id: UUID; status: Transfer['status']; to_facility_id?: UUID }, Transfer];
  };
  companion: {
    /** `message` is the stored assistant message; `reply` is the same answer with its structured fields. */
    send: [{ patient_id?: UUID; conversation_id?: UUID; message: string; locale?: Locale }, { conversation_id: UUID; message: ChatMessage; reply: CompanionReply; ai_run_id: UUID | null }];
    history: [{ patient_id?: UUID; conversation_id?: UUID }, { conversation_id: UUID | null; messages: ChatMessage[] }];
  };
  insights: {
    list: [{ patient_id?: UUID; limit?: number }, Insight[]];
    mark_read: [{ insight_id: UUID }, { ok: true }];
    notifications: [{}, Notification[]];
    mark_notification_read: [{ notification_id: UUID }, { ok: true }];
    mark_all_read: [{}, { ok: true; count: number }];
  };
  provider: {
    inbox: [{ status?: InboxItem['status'] | 'active'; category?: InboxItem['category'] }, InboxItem[]];
    update_inbox: [{ item_id: UUID; status: InboxItem['status'] }, InboxItem];
    /** Assign an inbox item to a team member (empty assignee_id unassigns). */
    assign_inbox: [{ item_id: UUID; assignee_id?: UUID | null }, InboxItem];
    panel: [{ q?: string }, PanelPatient[]];
    /** Overdue screenings across the clinician's panel, and coverage per screening. */
    care_gaps: [{}, CareGaps];
    /** Patients ranked by a deterministic risk score, with the reasons. */
    panel_risk: [{ limit?: number }, PanelRisk];
    personalization: [{ patient_id: UUID }, Personalization];
    therapy_review: [{ patient_id: UUID; code: string; decision: TherapyDecision; note?: string }, TherapyConsiderations];
    ai_reviews: [{ patient_id?: UUID }, AiReview[]];
    ai_review_decide: [{ review_id: UUID; decision: 'approve' | 'edit' | 'reject'; content?: string; note?: string }, AiReview];
    workspace: [{ patient_id: UUID }, Workspace];
    schedule: [{ from?: ISODate; to?: ISODate }, Appointment[]];
    generate_brief: [{ patient_id: UUID; appointment_id?: UUID }, PreVisitBrief]; // MedGemma + Gemini, synchronous (10-60 s)
    stats: [{}, { patients: number; open_items: number; critical_items: number; appointments_today: number; avg_tir: number | null; restricted: boolean }];
    link_requests: [{}, LinkRequest[]];
    home: [{}, Record<'inbox' | 'link_requests' | 'ai_reviews' | 'stats' | 'notifications', unknown>];
    /** Accepting adds the deciding clinician (and organization) to the patient's care team: the patient becomes "linked". */
    decide_link: [{ request_id: UUID; decision: 'accept' | 'decline' }, LinkRequest];
    /** Emergency access to a patient outside the care team: 4 hours, reason required, audited, safety officer notified. */
    break_glass: [{ patient_id: UUID; reason: string }, { ok: true; expires_at: ISODate }];
    /** Look up any patient by MRN or exact full name for break-glass (minimal identity only). */
    find_patient: [{ q: string }, { id: UUID; full_name: string; mrn: string; age: number }[]];
  };
  clinic: {
    patient_page: [{ patient_id?: UUID }, ClinicPatientPage];
    request: [{ message: string; patient_id?: UUID }, { request_id: UUID; status: string; emergency: boolean; same_day: boolean; message_en: string; message_ar: string }];
    choose_slot: [{ request_id: UUID; slot: ISODate; patient_id?: UUID }, unknown];
    waitlist_answer: [{ entry_id: UUID; accept: boolean; patient_id?: UUID }, unknown];
    dispatch_page: [{ date?: string }, ClinicDispatchPage];
    accept: [{ request_id: UUID; doctor_user_id?: UUID; slot?: ISODate }, { appointment_id: UUID; starts_at: ISODate }];
    offer: [{ request_id: UUID; doctor_user_id: UUID; slots: ISODate[] }, unknown];
    reassign: [{ request_id: UUID; doctor_user_id: UUID }, unknown];
    decline: [{ request_id: UUID; reason?: string }, unknown];
    walk_in: [{ patient_id?: UUID; full_name?: string; full_name_ar?: string; phone?: string; date_of_birth?: string; sex?: 'male' | 'female'; doctor_user_id: UUID; starts_at?: ISODate; reason?: string }, unknown];
    set_status: [{ appointment_id: UUID; status: 'checked_in' | 'completed' | 'no_show' | 'cancelled' }, { waitlist_offer?: UUID | null }];
    waitlist_add: [{ patient_id: UUID; specialty: string; doctor_user_id?: UUID }, unknown];
    waitlist_remove: [{ entry_id: UUID }, unknown];
    queue_page: [{ date?: string; appointment_id?: UUID }, ClinicQueuePage];
    visit_save: [{ appointment_id: UUID; diagnosis: string; prescription: string; service_ids: UUID[]; follow_up_date?: string | null }, { invoice: { items: unknown[]; total: number } }];
    visit_hints: [{ appointment_id: UUID }, unknown];
    visit_sign: [{ appointment_id: UUID; referral?: { specialty: string; reason: string } }, { referral_appointment?: { id: UUID; starts_at: ISODate } | null }];
    catalog_page: [{}, ClinicCatalogPage];
    specialty_save: [{ code: string; name: string; name_ar: string; sort: number; active: boolean }, unknown];
    doctor_save: [{ user_id: UUID; specialty: string; fee_egp: number; daily_slots: string[] | string; slot_minutes: number; active: boolean }, unknown];
    service_save: [{ id?: UUID; specialty: string; name: string; name_ar: string; price_egp: number; duration_min: number; fasting_required: boolean; active: boolean }, unknown];
    analytics_page: [{ days?: number }, ClinicAnalyticsPage];
  };
  admin: {
    rag_list: [{}, RagDocument[]];
    /** Read the Google Drive knowledge folder now (WF-019c) instead of at its next half hour. */
    rag_sync: [{}, Record<string, unknown>];
    /** Operations health: jobs, model gate, queues (20_operations.js). */
    health: [{}, Record<string, unknown>];
    rag_get: [{ document_id: UUID }, RagDocument & { content: string }];
    rag_create: [{ title: string; source: string; version: string; language: Locale; region?: string; population?: string; content: string; review_date?: ISODate; audience?: 'patient' | 'clinician' }, RagDocument];
    rag_approve: [{ document_id: UUID }, RagDocument]; // triggers WF-019 ingestion (embeddings); fetched guideline sections are approved per edition
    guideline_sources: [{}, GuidelineSource[]];
    guideline_check: [{ source_key: string }, GuidelineCheckResult]; // runs WF-024b now
    guideline_approve: [{ source_key: string; version?: string; license_confirmed?: boolean; note?: string }, GuidelineSource];
    guideline_dismiss: [{ source_key: string; version?: string; note: string }, GuidelineSource];
    rag_retire: [{ document_id: UUID }, RagDocument];
    ai_runs: [{ limit?: number }, AiRun[]];
    rules: [{}, { safety_rules: unknown[]; care_level_rules: unknown[] }];
    outbox: [{ limit?: number }, { event_id: UUID; event_type: string; status: string; attempts: number; occurred_at: ISODate; last_error: string | null }[]];
    users: [{}, StaffUser[]];
    create_user: [{ email: string; full_name: string; full_name_ar?: string; role: Role; organization_id?: UUID; password: string }, StaffUser];
    set_user_active: [{ user_id: UUID; active: boolean }, StaffUser];
    /** Issues a one-time password (shown once); the person must choose a new one at the next sign-in. */
    reset_password: [{ user_id: UUID; reason?: string }, { user_id: UUID; email: string; temporary_password: string }];
    audit: [{ patient_id?: UUID; limit?: number }, { at: ISODate; actor: string | null; role: string | null; action: string; entity: string | null; patient_id: UUID | null }[]];
    /** Workflow errors and AI quality problems found by the judge, newest first. */
    incidents: [{ limit?: number; kind?: IncidentKind; status?: IncidentStatus }, Incident[]];
    /** Closes an incident with what was changed (resolved) or why it is not a problem (dismissed). */
    incident_resolve: [{ id: number; status: 'resolved' | 'dismissed'; resolution: string }, { id: number; status: IncidentStatus }];
    data_requests: [{ status?: DataRequest['status'] }, AdminDataRequest[]];
    data_request_resolve: [{ id: UUID; status: 'in_progress' | 'completed' | 'rejected'; resolution?: string }, DataRequest];
    breaches: [{}, Breach[]];
    report_breach: [{ message: string; severity?: Breach['severity'] }, Breach];
    breach_notified: [{ id: number }, Breach];
    monitoring: [{ days?: number }, Monitoring];
    companion_resume: [{ note: string }, { paused: boolean }];
    calibration_queue: [{ rater: 'A' | 'B' }, CalibrationItem[]];
    calibration_score: [{ rater: 'A' | 'B'; trial_id: UUID; scores: Record<JudgeDim, number> }, CalibrationReport];
    calibration_report: [{}, CalibrationReport];
    /** AI quality: judge metrics, recent judged answers (trials), open quality incidents, the latest report and evaluation. */
    quality: [{ days?: number }, QualityOverview];
    /** Builds an improvement report now (also built every Sunday). */
    quality_report: [{ days?: number }, QualityReport];
    /** Records an evaluation run (ai/evals/run-evals.mjs). */
    eval_record: [{ eval_run: string; results: { case_id: string; category?: string; persona?: string; passed: boolean; failed_checks?: string[]; ai_run_id?: UUID | null; latency_ms?: number }[] }, { eval_run: string; recorded: number }];
  };
}

/* ------------------------------------------------------------------------------------------- AI quality */

export type IncidentKind = 'workflow_error' | 'ai_hallucination' | 'ai_unsafe' | 'ai_over_refusal' | 'ai_quality' | 'eval_failure' | 'privacy_breach';
export type IncidentStatus = 'open' | 'resolved' | 'dismissed';
export interface Incident {
  id: number; at: ISODate; kind: IncidentKind; severity: 'low' | 'medium' | 'high'; status: IncidentStatus;
  workflow: string | null; node: string | null; message: string | null; ai_run_id: UUID | null; resolution: string | null; resolved_at: ISODate | null;
}
/** One judged AI answer (a row of the ai_trials tab). Scores are 1-5. */
export interface AiTrial {
  id: UUID; ai_run_id: UUID; judged_at: ISODate; workflow: string; model: string | null; prompt_version: string | null;
  reason: 'flagged' | 'sample' | 'eval' | 'manual'; verdict: 'pass' | 'minor' | 'fail'; grounded: number | null; safety: number | null; helpfulness: number | null;
  hallucination: boolean; over_refusal: boolean; issues: string[] | null; summary: string | null; question_excerpt: string | null; answer_excerpt: string | null; judge_model: string;
}
export interface QualityGroupStats { judged: number; pass_rate: number | null; hallucination_rate: number | null; over_refusal_rate: number | null; grounded: number | null; helpfulness: number | null }
export interface QualityMetrics {
  days: number; from: ISODate; to: ISODate;
  judge: {
    judged: number; by_verdict: Record<string, number>; by_reason: Record<string, number>; pass_rate: number | null; hallucination_rate: number | null; unsafe: number;
    over_refusal_rate: number | null; language_problem_rate: number | null; reference_problem_rate: number | null;
    mean_scores: { grounded: number | null; safety: number | null; helpfulness: number | null };
    by_workflow: Record<string, QualityGroupStats>; by_model: Record<string, QualityGroupStats>; by_prompt_version: Record<string, QualityGroupStats>;
    top_issues: { issue: string; count: number }[];
  };
  runs: { total: number; by_status: Record<string, number>; by_model: Record<string, number>; by_release: Record<string, number>; withheld_rate: number | null; fallback_rate: number | null;
    companion_latency_ms: { p50: number | null; p90: number | null; n: number } };
  incidents: { by_kind: Record<string, number>; open: number };
}
export interface EvalSummary { eval_run: string; cases: number; passed: number; pass_rate: number | null; failed: { case_id: string; category: string | null; failed_checks: string[] | null }[] }
export interface QualityRecommendation { area: string; priority: 'high' | 'medium' | 'low'; text: string; evidence: unknown }
export interface QualityReport {
  id: UUID; period_start: ISODate; period_end: ISODate; metrics: QualityMetrics & { latest_eval: EvalSummary | null };
  findings: { examples: { ai_run_id: UUID; workflow: string; model: string | null; verdict: string; issues: string[] | null; summary: string | null }[]; top_issues: { issue: string; count: number }[] };
  recommendations: QualityRecommendation[];
}
export interface QualityOverview {
  metrics: QualityMetrics; latest_eval: EvalSummary | null; trials: AiTrial[]; open_incidents: Incident[];
  latest_report: { id: UUID; created_at: ISODate; period_start: ISODate; period_end: ISODate; recommendations: QualityRecommendation[]; findings: QualityReport['findings'] } | null;
}

/* ------------------------------------------------------------------------- prediction, Ramadan, panel */

export interface LowPrediction {
  type: 'low_predicted'; slope: number; last: number; projected: number; points: number; horizon_min: number; night: boolean; serious: boolean;
  message_en: string; message_ar: string;
}
export type RamadanCategory = 'low' | 'moderate' | 'high';
export const RAMADAN_ANSWERS = {
  hypo_unawareness: [true, false],
  smbg: ['as_indicated', 'suboptimal', 'not_done'],
  acute_complication: ['none', 'last_12m', 'last_6m', 'last_3m'],
  macrovascular: ['none', 'stable', 'unstable'],
  frailty: ['none', 'over70_no_support', 'frail_or_cognitive'],
  labour: ['none', 'moderate', 'intense'],
  previous_ramadan: ['no_problem', 'negative', 'first_time'],
} as const;
export type RamadanAnswers = { [K in keyof typeof RAMADAN_ANSWERS]?: (typeof RAMADAN_ANSWERS)[K][number] };
export interface RamadanAssessment {
  id: UUID; version?: string; score: number; category: RamadanCategory; items: { key: string; points: number; basis: string; detail: unknown }[];
  missing?: string[]; advice_en?: string; advice_ar?: string; fasting: boolean; created_at?: ISODate;
}
export interface RamadanStatus {
  ramadan: { start: string; end: string; active: boolean; fasting_from: string; fasting_to: string; break_below: number; break_above: number };
  /** The latest assessment as stored (fasting is at the top level; advice texts come only with a new assessment). */
  assessment: Pick<RamadanAssessment, 'id' | 'score' | 'category' | 'items' | 'created_at'> | null; fasting: boolean;
}
export interface CareGaps {
  date: string; patients_with_gaps: number;
  patients: { id: UUID; full_name: string; full_name_ar: string | null; mrn: string | null; gaps: { type: string; title: string; title_ar: string | null; last_done: string | null; next_due: string | null; days_overdue: number | null }[] }[];
  coverage: { type: string; title: string; title_ar: string | null; up_to_date: number; total: number; percent: number | null }[];
}
export interface PanelRisk {
  ranked: number;
  patients: { id: UUID; full_name: string; full_name_ar: string | null; mrn: string | null; score: number; reasons: { points: number; en: string; ar: string }[] }[];
}

/* ------------------------------------------------------------- polyclinic (docs/integration/clinic-module.md) */

export interface ClinicSpecialty { code: string; name: string; name_ar: string | null; sort?: number; active?: boolean }
export interface ClinicDoctorRef { user_id: UUID; full_name: string; full_name_ar: string | null; specialty?: string; fee_egp?: number | null }
export type ClinicUrgency = 'urgent' | 'priority' | 'routine';
export interface ClinicPatientAdmin { id: UUID; full_name: string; full_name_ar: string | null; mrn: string | null; phone: string | null; age: number | null; sex: string | null }
export interface ClinicRequest {
  id: UUID; status: 'triaging' | 'pending' | 'escalated' | 'offered' | 'accepted' | 'declined'; source?: string; urgency: ClinicUrgency | null;
  created_at: ISODate; decided_at?: ISODate | null; specialty: ClinicSpecialty | null; doctor: ClinicDoctorRef | null; proposed_at?: ISODate | null;
  offered_slots: { starts_at: ISODate; doctor_user_id: UUID }[]; appointment_id: UUID | null; message?: string | null;
  patient?: ClinicPatientAdmin; chief_complaint?: string | null; chief_complaint_ar?: string | null; routing_reason?: string | null; routing_reason_ar?: string | null;
  red_flags?: string[]; review_reasons?: string[]; triaged_by?: 'model' | 'rules' | null; confidence?: number | null;
}
export interface ClinicWaitEntry {
  id: UUID; status: string; specialty: ClinicSpecialty | string | null; offered_at_slot: ISODate | null; offer_expires_at: ISODate | null; doctor: ClinicDoctorRef | null;
  patient?: ClinicPatientAdmin; created_at?: ISODate;
}
export interface ClinicAppointment {
  id: UUID; starts_at: ISODate; status: string; urgency?: ClinicUrgency | null; source?: string | null; specialty?: ClinicSpecialty | null; doctor?: ClinicDoctorRef | null;
  patient?: { id?: UUID; full_name: string; full_name_ar?: string | null; mrn?: string | null; phone?: string | null; age?: number | null; sex?: string | null };
  has_brief?: boolean;
}
export interface ClinicVisitSummary {
  signed_at: ISODate; doctor: ClinicDoctorRef | null; specialty: ClinicSpecialty | null; diagnosis: string | null; prescription_ar: string | null;
  follow_up_date: string | null; invoice_total_egp: number | null;
}
export interface ClinicPatientPage { requests: ClinicRequest[]; waitlist: ClinicWaitEntry[]; appointments: ClinicAppointment[]; visits: ClinicVisitSummary[]; specialties: ClinicSpecialty[] }
export interface ClinicDispatchPage {
  date: string; counts: { waiting_decision: number; offered: number; today_booked: number; waitlist: number };
  requests: ClinicRequest[]; offered: ClinicRequest[]; appointments: ClinicAppointment[]; waitlist: ClinicWaitEntry[];
  doctors: (ClinicDoctorRef & { next_slots: ISODate[] })[];
}
export interface ClinicService { id: UUID; specialty: string; name: string; name_ar: string | null; price_egp: number; duration_min?: number; fasting_required?: boolean; active?: boolean }
export interface ClinicHints { status: 'writing' | 'ready' | 'unavailable'; items: { kind: string; text: string; why?: string | null }[]; note?: string | null; ai_draft: true; doctor_only?: boolean; source: string }
export interface ClinicBrief { cc: string | null; s: string | null; o: string | null; a: string | null; p: string | null; lab_flags: string[]; ai_draft: true; source: string }
export interface ClinicVisit {
  status: 'draft' | 'signed' | 'sent'; diagnosis: string | null; prescription: string | null; services: (ClinicService | UUID)[]; invoice_total_egp: number | null;
  follow_up_date: string | null; referral_id: UUID | null; rx_check: string | null; prescription_patient_ar: string | null; ai_hints: ClinicHints | null;
}
export interface ClinicQueuePage {
  date: string; queue: ClinicAppointment[]; services: ClinicService[]; specialties: ClinicSpecialty[]; fee_egp: number | null;
  selected: null | {
    appointment: ClinicAppointment;
    patient: {
      full_name?: string; full_name_ar?: string | null; age: number | null; sex: string | null; has_diabetes: boolean;
      allergies: unknown[]; conditions: unknown[]; medicines: unknown[];
      recent_labs: { test: string; value: number | string | null; unit: string | null; verified: boolean; at: ISODate }[];
    };
    brief: ClinicBrief | null; visit: ClinicVisit | null;
  };
}
export interface ClinicCatalogPage {
  specialties: ClinicSpecialty[]; services: ClinicService[];
  doctors: { user_id: UUID; full_name: string; full_name_ar: string | null; profile: { specialty: string; fee_egp: number | null; daily_slots: string[]; slot_minutes: number; active: boolean } | null }[];
}
export interface ClinicAnalyticsPage {
  days: number; kpis: { key: string; actual: number | null; unit: string; n?: number }[];
  by_specialty: { specialty: ClinicSpecialty; requests: number; accepted: number }[];
}

/** The patient's diabetes doctor (41_doctor_match.js): own doctors, or a matched one from the directory with on-call cover. */
export interface MyDiabetesDoctor {
  linked: { full_name: string | null; full_name_ar: string | null; specialty: string | null; organization: string | null; diabetes: boolean }[];
  matched: null | { id: UUID; name_ar: string; name_en: string | null; specialty: 'diabetology' | 'endocrinology' | 'internal_medicine';
    locations: { name: string | null; address: string | null }[]; areas: string[]; phone: string | null; reason: string };
  covered_by: { name: string; name_ar: string | null } | null;
  emergency_number: string;
}

export type Group = keyof Actions;
export type ActionOf<G extends Group> = keyof Actions[G] & string;
export type InputOf<G extends Group, A extends ActionOf<G>> = Actions[G][A] extends [infer I, unknown] ? I : never;
export type OutputOf<G extends Group, A extends ActionOf<G>> = Actions[G][A] extends [unknown, infer O] ? O : never;
