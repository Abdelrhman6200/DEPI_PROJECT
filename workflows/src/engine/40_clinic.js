// Polyclinic (the specialist clinics beyond the diabetes team; from the MediCare AI system, rebuilt here on the
// platform's records, roles and safety rules). One patient record serves diabetes care and every specialty.
//
//   Booking:   a patient (or family member) describes the problem -> the emergency pre-screen runs first (fixed text,
//              critical inbox item) -> otherwise a booking request waits for AI triage (WF-040, background) -> reception
//              accepts, proposes other times, reassigns or declines -> the patient is told in the app (no third-party
//              messaging). Accepting books an appointment, links the patient to the polyclinic and starts the visit-prep
//              note (WF-041, for the patient) and the pre-visit brief (WF-042, for the doctor).
//   Waitlist:  a cancelled slot is offered to the first person waiting for that specialty; they accept or decline in the
//              app within clinic_policy.waitlist_offer_minutes.
//   Visit:     the doctor writes the diagnosis and prescription (AI hints on request are doctor-only drafts, WF-044), adds
//              services (invoice), a follow-up date and an internal referral (booked into the first free slot of that
//              specialty), and signs. Only then is the patient told: the prescription rewritten in plain Arabic with every
//              number checked (WF-043), or the doctor's exact words.
//   AI never decides: triage is a suggestion reception accepts or changes; diagnosis and prescription are the doctor's.
//   Escalation: a request reception has not decided in time (clinic_policy.escalate_*: urgent 60 minutes, priority 4 hours,
//              routine 24 hours) is raised once to the polyclinic's clinic admins, and the patient is told it is still
//              waiting (fn_run_clinic_escalations, from the 15-minute reminders job).
// Roles: reception = receptionist, clinic_admin (and nurse); doctor = doctor; catalog = clinic_admin, platform_admin.

const _M40_RECEPTION = ['receptionist', 'clinic_admin', 'nurse', 'doctor'];
const _M40_ADMIN = ['clinic_admin', 'platform_admin'];
const _M40_URG = { urgent: 0, priority: 1, routine: 2 };

function _m40_txt(o, k) { return o === null || o === undefined || o[k] === null || o[k] === undefined ? null : String(o[k]); }
function _m40_uid(c) { return castUuid(_m40_txt(c, 'user_id')); }
function _m40_role(c) { return _m40_txt(c, 'role'); }

/** clinic_policy rule with defaults. */
function fn_clinic_policy() {
  return {
    triage_min_confidence: 0.6, waitlist_offer_minutes: 15, booking_days_ahead: 14, max_offer_slots: 3,
    rx_numbers_must_match: true, escalate_urgent_minutes: 60, escalate_priority_hours: 4, escalate_routine_hours: 24,
    ...(coalesce(fn_rule('clinic_policy'), {}) || {}),
  };
}

/** The polyclinic organization: the first organization of type polyclinic. */
function fn_clinic_org() {
  const o = orderBy(dbWhere('organizations', (x) => x.type === 'polyclinic'), [(x) => t(x.created_at), 'asc'])[0];
  return o ? o.id : null;
}

/** Staff of the polyclinic: a member of its organization (or a platform admin for the catalog). */
function fn_clinic_staff(c, roles) {
  fn_require_role(c, roles);
  if (_m40_role(c) === 'platform_admin') return;
  const org = fn_clinic_org();
  const uid = _m40_uid(c);
  if (org === null || !dbExists('memberships', (m) => m.user_id === uid && m.organization_id === org)) fn_raise('forbidden: this action is for the polyclinic staff');
}

/** A booking links the patient to the polyclinic through that doctor (care_team needs a user), which gives the
 *  polyclinic staff (members of its organization) access to the record. */
function fn_clinic_link_patient(pid, userId) {
  const org = fn_clinic_org();
  const uid = castUuid(userId);
  if (org === null || uid === null || dbExists('care_team', (x) => x.patient_id === pid && x.organization_id === org && x.active === true)) return;
  const ex = dbOne('care_team', (x) => x.patient_id === pid && x.user_id === uid);
  if (ex) dbUpdate('care_team', ex, { organization_id: ex.organization_id || org, active: true });
  else dbInsert('care_team', { patient_id: pid, user_id: uid, organization_id: org, role: 'specialist_clinic', active: true });
}

function _m40_age(p) {
  if (!p || !p.date_of_birth) return null;
  const a = fn_age(p.date_of_birth);
  return a === null || a < 0 ? null : a;
}
/** What reception sees of a patient: administrative fields only. */
function _m40_patient_admin(pid) {
  const p = dbGet('patients', pid);
  return p ? { id: p.id, full_name: p.full_name, full_name_ar: p.full_name_ar, mrn: p.mrn, phone: p.phone, age: _m40_age(p), sex: p.sex } : null;
}
function _m40_spec(code) {
  const s = code === null || code === undefined ? null : dbGet('clinic_specialties', String(code));
  return s ? { code: s.code, name: s.name, name_ar: s.name_ar } : null;
}
function _m40_doctor(uid) {
  const u = uid === null || uid === undefined ? null : dbGet('users', uid);
  const p = uid === null || uid === undefined ? null : dbGet('doctor_profiles', uid);
  return u ? { user_id: u.id, full_name: u.full_name, full_name_ar: u.full_name_ar, specialty: p ? p.specialty : null, fee_egp: p ? Number(p.fee_egp) : null } : null;
}

/* ------------------------------------------------------------------------------------------------ availability */

/** Start times (ms) of a doctor's daily slots on a Cairo date. */
function _m40_slots_on(prof, date) {
  const [y, mo, d] = String(date).split('-').map(Number);
  return (prof.daily_slots || []).map((hhmm) => String(hhmm).trim()).filter((x) => /^\d{1,2}:\d{2}$/.test(x))
    .map((x) => cairoLocalToMs(y, mo, d, Number(x.split(':')[0]), Number(x.split(':')[1]))).sort((a, b) => a - b);
}
/** Is the doctor free at this time? Every appointment that is not cancelled holds its slot, also one completed early
 *  (a visit signed before its booked time still used that time). */
function fn_clinic_doctor_free(uid, startMs, minutes = 20, exceptAppointmentId = null) {
  const end = startMs + minutes * MIN;
  return !dbExists('appointments', (x) => x.provider_user_id === uid && x.id !== exceptAppointmentId && x.status !== 'cancelled'
    && t(x.starts_at) < end && (x.ends_at !== null ? t(x.ends_at) : t(x.starts_at) + 20 * MIN) > startMs);
}
/** The next free slots of a doctor (ISO), from now, within booking_days_ahead days. */
function fn_clinic_free_slots(uid, limit = 6) {
  const prof = dbGet('doctor_profiles', uid);
  if (!prof || prof.active !== true) return [];
  const pol = fn_clinic_policy();
  const out = [];
  for (let i = 0; i < Number(pol.booking_days_ahead) && out.length < limit; i++) {
    const date = localDate(iso(nowMs() + i * DAY));
    for (const s of _m40_slots_on(prof, date)) {
      if (s >= nowMs() + 30 * MIN && fn_clinic_doctor_free(uid, s, prof.slot_minutes)) out.push(iso(s));
      if (out.length >= limit) break;
    }
  }
  return out;
}
/** The doctor of a specialty with the earliest free slot: { doctor, slot } or nulls. */
function fn_clinic_pick_doctor(specialty) {
  let best = { doctor_user_id: null, slot: null };
  for (const p of dbWhere('doctor_profiles', (x) => x.specialty === specialty && x.active === true)) {
    const s = fn_clinic_free_slots(p.user_id, 1)[0];
    if (s && (best.slot === null || t(s) < t(best.slot))) best = { doctor_user_id: p.user_id, slot: s };
  }
  if (best.doctor_user_id === null) {
    const any = dbWhere('doctor_profiles', (x) => x.specialty === specialty && x.active === true)[0];
    if (any) best.doctor_user_id = any.user_id;
  }
  return best;
}

/* ----------------------------------------------------------------------------------------------- booking (patient) */

// A patient or family member asks for a specialist visit in their own words. Emergencies get the fixed emergency text
// at once (and a critical inbox item for the patient's care team); everything else waits for triage and reception.
function api_clinic_request(c, d) {
  const pid = fn_resolve_patient(c, d);
  fn_require_scope(c, pid, 'log');
  const msg = left(String(coalesce(_m40_txt(d, 'message'), '')).trim(), 2000);
  if (msg.length < 3) fn_raise('bad_request: Please describe the problem in a few words. ¦ من فضلك اكتب المشكلة في كلمات قليلة.');
  const open = dbCount('booking_requests', (x) => x.patient_id === pid && ['triaging', 'pending', 'offered', 'escalated'].includes(x.status));
  if (open >= 3) fn_raise('conflict: You already have requests waiting for the clinic. ¦ لديك طلبات بالفعل في انتظار العيادة.');
  const em = fn_prescreen_for(c, pid, msg);
  const emergency = !!(em && em.emergency === true);
  const sameDay = !!(em && em.urgent === true);
  const r = dbInsert('booking_requests', {
    organization_id: fn_clinic_org(), patient_id: pid, source: coalesce(_m40_txt(d, 'source'), 'app') === 'referral' ? 'referral' : 'app', message: msg,
    urgency: emergency || sameDay ? 'urgent' : 'routine', status: emergency ? 'escalated' : 'triaging',
    triage: emergency ? { cc: msg.slice(0, 160), why: 'Emergency signs in the message (rules, not AI): fixed emergency text shown.', red_flags: em.matched || [], ai: 'rules' } : null,
  });
  if (emergency) {
    fn_create_inbox_item(pid, 'safety', 'critical', 1, 'Emergency signs in a clinic booking request', left(msg, 300), { booking_request_id: r.id, matched: em.matched || [] });
  } else {
    fn_emit('ClinicBookingRequested', pid, String(r.id), {});
  }
  fn_audit(c, 'clinic.request', 'booking_request', String(r.id), pid, { emergency });
  return {
    request_id: r.id, status: r.status, emergency, same_day: sameDay,
    message_en: emergency || sameDay ? em.message_en : 'Your request was sent to the clinic. Reception will offer you an appointment soon. If you get severe chest pain, breathlessness or you faint, call 123 now.',
    message_ar: emergency || sameDay ? em.message_ar : 'تم إرسال طلبك إلى العيادة، وسيعرض عليك الاستقبال موعدًا قريبًا. إذا شعرت بألم شديد في الصدر أو ضيق في التنفس أو إغماء فاتصل بـ 123 فورًا.',
  };
}

function _m40_request_json(r, view) {
  const tri = r.triage || {};
  const base = {
    id: r.id, status: r.status, source: r.source, urgency: r.urgency, created_at: r.created_at, decided_at: r.decided_at,
    specialty: _m40_spec(r.specialty), doctor: _m40_doctor(r.doctor_user_id), proposed_at: r.proposed_at,
    offered_slots: r.offered_slots || [], appointment_id: r.appointment_id,
  };
  if (view === 'patient') return { ...base, message: r.message };
  // Reception: what is needed to route the request (chief complaint, why this specialty, red flags, review reasons);
  // the structured clinical summary is for the doctor's brief.
  return { ...base, patient: _m40_patient_admin(r.patient_id), chief_complaint: tri.cc || null, chief_complaint_ar: tri.cc_ar || null,
    routing_reason: tri.why || null, routing_reason_ar: tri.why_ar || null, red_flags: tri.red_flags || [], review_reasons: tri.review_reasons || [],
    triaged_by: tri.ai || null, confidence: tri.confidence ?? null };
}

// The patient's clinic page: requests (with offered times), waitlist offers, upcoming specialist appointments, visits.
function api_clinic_patient_page(c, d) {
  const pid = fn_resolve_patient(c, d);
  const reqs = orderBy(dbWhere('booking_requests', (x) => x.patient_id === pid), [(x) => t(x.created_at), 'desc']).slice(0, 10);
  const offers = dbWhere('waitlist_entries', (x) => x.patient_id === pid && ['waiting', 'offered'].includes(x.status));
  const appts = orderBy(dbWhere('appointments', (x) => x.patient_id === pid && x.specialty !== null && ['requested', 'booked', 'checked_in'].includes(x.status)
    && t(x.starts_at) > nowMs() - 6 * 60 * MIN), [(x) => t(x.starts_at), 'asc']);
  const visits = orderBy(dbWhere('clinic_visits', (x) => x.patient_id === pid && x.status === 'sent'), [(x) => t(x.signed_at), 'desc']).slice(0, 10);
  return {
    requests: jsonAgg(reqs.map((r) => _m40_request_json(r, 'patient'))) ?? [],
    waitlist: jsonAgg(offers.map((w) => ({ id: w.id, status: w.status, specialty: _m40_spec(w.specialty), offered_at_slot: w.offered_at_slot,
      offer_expires_at: w.offer_expires_at, doctor: _m40_doctor(w.offered_doctor_user_id) }))) ?? [],
    appointments: jsonAgg(appts.map((a) => ({ id: a.id, starts_at: a.starts_at, status: a.status, specialty: _m40_spec(a.specialty), doctor: _m40_doctor(a.provider_user_id) }))) ?? [],
    visits: jsonAgg(visits.map((v) => ({ id: v.id, signed_at: v.signed_at, doctor: _m40_doctor(v.doctor_user_id), specialty: _m40_spec((dbGet('doctor_profiles', v.doctor_user_id) || {}).specialty),
      diagnosis: v.diagnosis, prescription_ar: v.prescription_patient_ar || v.prescription, follow_up_date: v.follow_up_date, invoice_total_egp: v.invoice_total_egp }))) ?? [],
    specialties: jsonAgg(orderBy(dbWhere('clinic_specialties', (s) => s.active === true), [(s) => s.sort, 'asc']).map((s) => _m40_spec(s.code))) ?? [],
  };
}

/** Books a polyclinic appointment (used by accept, choose_slot, walk-in, waitlist and referrals). */
function _m40_book(pid, doctorUid, startIso, extra = {}) {
  const prof = dbGet('doctor_profiles', doctorUid);
  if (!prof) fn_raise('bad_request: This doctor has no clinic profile.');
  if (fn_try_ts(startIso) === null) fn_raise('bad_request: Please choose the date and time of the appointment.');
  if (t(startIso) < nowMs() - 5 * MIN) fn_raise('bad_request: The appointment time has already passed.');
  const s0 = t(startIso), e0 = s0 + prof.slot_minutes * MIN;
  if (dbExists('appointments', (x) => x.patient_id === pid && ['requested', 'booked', 'checked_in'].includes(x.status) && t(x.starts_at) < e0
      && (x.ends_at !== null ? t(x.ends_at) : t(x.starts_at) + 20 * MIN) > s0)) fn_raise('conflict: The patient already has an appointment at this time. ¦ لدى المريض موعد آخر في هذا الوقت.');
  if (!fn_clinic_doctor_free(doctorUid, t(startIso), prof.slot_minutes)) fn_raise('conflict: The doctor already has an appointment at this time. ¦ الطبيب لديه موعد في هذا الوقت.');
  const a = dbInsert('appointments', {
    patient_id: pid, provider_user_id: doctorUid, facility_id: null, starts_at: iso(t(startIso)), ends_at: iso(t(startIso) + prof.slot_minutes * MIN),
    type: 'consultation', channel: 'in_person', status: 'booked', reason: extra.reason ? left(extra.reason, 500) : null,
    specialty: prof.specialty, urgency: extra.urgency || 'routine', source: extra.source || 'app', booking_request_id: extra.booking_request_id || null,
    referral_id: extra.referral_id || null,
  });
  fn_clinic_link_patient(pid, doctorUid);
  fn_emit('AppointmentCreated', pid, String(a.id), { starts_at: a.starts_at });
  return a;
}
function _m40_when(startIso) {
  const p = cairoParts(startIso);
  const hh = String(p.h).padStart(2, '0'), mi = String(p.mi).padStart(2, '0');
  return { en: `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')} at ${hh}:${mi}`, ar: `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')} الساعة ${hh}:${mi}` };
}
function _m40_confirm(pid, a) {
  const doc = _m40_doctor(a.provider_user_id) || {}, sp = _m40_spec(a.specialty) || {}, w = _m40_when(a.starts_at);
  fn_notify_patient(pid, 'clinic_booking', `Appointment confirmed: ${sp.name || 'clinic'}`, `${doc.full_name || 'Your doctor'}, ${w.en}. Please arrive 10 minutes early with your ID and your medicines list.`,
    `clinic-confirm:${a.id}`, `تم تأكيد موعدك: ${sp.name_ar || sp.name || 'العيادة'}`, `${doc.full_name_ar || doc.full_name || 'طبيبك'}، ${w.ar}. من فضلك احضر قبل الموعد بعشر دقائق ومعك بطاقة الهوية وقائمة أدويتك.`);
  // The visit-prep note (patient) and the pre-visit brief (doctor) are written in the background.
  fn_emit('ClinicAppointmentConfirmed', pid, String(a.id), {});
  fn_emit('ClinicBriefRequested', pid, String(a.id), {});
}

// The patient picks one of the times reception offered.
function api_clinic_choose_slot(c, d) {
  const pid = fn_resolve_patient(c, d);
  fn_require_scope(c, pid, 'log');
  const r = dbGet('booking_requests', castUuid(_m40_txt(d, 'request_id')));
  if (!r || r.patient_id !== pid) fn_raise('not_found: request not found');
  if (r.status !== 'offered') fn_raise('conflict: This request has no times waiting for your choice.');
  const slot = _m40_txt(d, 'slot');
  const offered = (r.offered_slots || []).find((s) => t(s.starts_at) === t(slot));
  if (!offered) fn_raise('bad_request: Please choose one of the offered times.');
  const a = _m40_book(pid, offered.doctor_user_id || r.doctor_user_id, offered.starts_at, { urgency: r.urgency, source: r.source, booking_request_id: r.id, reason: (r.triage || {}).cc || r.message });
  dbUpdate('booking_requests', r, { status: 'accepted', appointment_id: a.id, decided_at: now(), proposed_at: a.starts_at, doctor_user_id: a.provider_user_id });
  _m40_confirm(pid, a);
  fn_audit(c, 'clinic.choose_slot', 'appointment', String(a.id), pid);
  return { appointment_id: a.id, starts_at: a.starts_at };
}

// A waitlist offer: accept books the offered slot (if still free), decline offers it to the next person.
function api_clinic_waitlist_answer(c, d) {
  const pid = fn_resolve_patient(c, d);
  fn_require_scope(c, pid, 'log');
  const w = dbGet('waitlist_entries', castUuid(_m40_txt(d, 'entry_id')));
  if (!w || w.patient_id !== pid || w.status !== 'offered') fn_raise('not_found: offer not found');
  if (w.offer_expires_at !== null && t(w.offer_expires_at) < nowMs()) { dbUpdate('waitlist_entries', w, { status: 'waiting', offered_at_slot: null, offered_at: null, offer_expires_at: null }); fn_clinic_offer_slot(w.specialty, w.offered_doctor_user_id, w.offered_at_slot, w.id); fn_raise('conflict: This offer has expired. ¦ انتهت مدة هذا العرض.'); }
  if (castBool(_m40_txt(d, 'accept')) === true) {
    const a = _m40_book(pid, w.offered_doctor_user_id, w.offered_at_slot, { source: 'waitlist' });
    dbUpdate('waitlist_entries', w, { status: 'booked', appointment_id: a.id });
    _m40_confirm(pid, a);
    fn_audit(c, 'clinic.waitlist_accept', 'appointment', String(a.id), pid);
    return { appointment_id: a.id, starts_at: a.starts_at };
  }
  dbUpdate('waitlist_entries', w, { status: 'waiting', offered_at_slot: null, offered_at: null, offer_expires_at: null, offered_doctor_user_id: null });
  fn_clinic_offer_slot(w.specialty, w.offered_doctor_user_id, w.offered_at_slot, w.id);
  return { declined: true };
}

/* ------------------------------------------------------------------------------------------------------ reception */

function _m40_request_for_staff(c, id) {
  fn_clinic_staff(c, _M40_RECEPTION);
  const r = dbGet('booking_requests', castUuid(id));
  if (!r || (r.organization_id !== null && r.organization_id !== fn_clinic_org())) fn_raise('not_found: request not found');
  return r;
}

// Reception's dispatch board: requests waiting for a decision (urgent first), offers waiting for the patient, today's
// clinic appointments, the waitlist and four counts. Administrative fields only.
function api_clinic_dispatch_page(c, d) {
  fn_clinic_staff(c, _M40_RECEPTION);
  const org = fn_clinic_org();
  const mine = (x) => x.organization_id === null || x.organization_id === org;
  const open = orderBy(dbWhere('booking_requests', (x) => mine(x) && ['triaging', 'pending', 'escalated'].includes(x.status)),
    [(x) => _M40_URG[x.urgency] ?? 3, 'asc'], [(x) => t(x.created_at), 'asc']);
  const offered = orderBy(dbWhere('booking_requests', (x) => mine(x) && x.status === 'offered'), [(x) => t(x.created_at), 'desc']);
  const day = coalesce(_m40_txt(d, 'date'), today());
  const appts = orderBy(dbWhere('appointments', (x) => x.specialty !== null && localDate(x.starts_at) === day), [(x) => t(x.starts_at), 'asc']);
  const wl = orderBy(dbWhere('waitlist_entries', (x) => mine(x) && ['waiting', 'offered'].includes(x.status)), [(x) => t(x.created_at), 'asc']);
  return {
    counts: { waiting_decision: open.length, offered: offered.length, today_booked: appts.filter((a) => ['booked', 'checked_in'].includes(a.status)).length, waitlist: wl.length },
    requests: jsonAgg(open.map((r) => _m40_request_json(r, 'staff'))) ?? [],
    offered: jsonAgg(offered.map((r) => _m40_request_json(r, 'staff'))) ?? [],
    appointments: jsonAgg(appts.map((a) => ({ id: a.id, starts_at: a.starts_at, status: a.status, urgency: a.urgency, source: a.source,
      specialty: _m40_spec(a.specialty), doctor: _m40_doctor(a.provider_user_id), patient: _m40_patient_admin(a.patient_id) }))) ?? [],
    waitlist: jsonAgg(wl.map((w) => ({ id: w.id, status: w.status, specialty: _m40_spec(w.specialty), patient: _m40_patient_admin(w.patient_id),
      created_at: w.created_at, offer_expires_at: w.offer_expires_at }))) ?? [],
    doctors: jsonAgg(dbWhere('doctor_profiles', (x) => x.active === true).map((p) => ({ ..._m40_doctor(p.user_id), next_slots: fn_clinic_free_slots(p.user_id, 3) }))) ?? [],
    date: day,
  };
}

// Accept: book the proposed (or a chosen) time with the proposed (or a chosen) doctor.
function api_clinic_accept(c, d) {
  const r = _m40_request_for_staff(c, _m40_txt(d, 'request_id'));
  if (!['pending', 'escalated', 'triaging'].includes(r.status)) fn_raise('conflict: This request was already decided.');
  const doctor = castUuid(coalesce(_m40_txt(d, 'doctor_user_id'), r.doctor_user_id));
  const slot = coalesce(_m40_txt(d, 'slot'), r.proposed_at);
  if (doctor === null || slot === null) fn_raise('bad_request: Choose a doctor and a time first.');
  const a = _m40_book(r.patient_id, doctor, slot, { urgency: r.urgency, source: r.source, booking_request_id: r.id, reason: (r.triage || {}).cc || r.message });
  dbUpdate('booking_requests', r, { status: 'accepted', appointment_id: a.id, doctor_user_id: doctor, proposed_at: a.starts_at, decided_at: now(), decided_by: _m40_uid(c) });
  _m40_confirm(r.patient_id, a);
  fn_audit(c, 'clinic.accept', 'appointment', String(a.id), r.patient_id, { request_id: r.id });
  return { appointment_id: a.id, starts_at: a.starts_at };
}

// Propose other times (one to max_offer_slots): the patient chooses in the app.
function api_clinic_offer(c, d) {
  const r = _m40_request_for_staff(c, _m40_txt(d, 'request_id'));
  if (!['pending', 'escalated', 'triaging', 'offered'].includes(r.status)) fn_raise('conflict: This request was already decided.');
  const doctor = castUuid(coalesce(_m40_txt(d, 'doctor_user_id'), r.doctor_user_id));
  const slots = (Array.isArray(d && d.slots) ? d.slots : []).map(String).slice(0, Number(fn_clinic_policy().max_offer_slots));
  if (doctor === null || !slots.length) fn_raise('bad_request: Choose a doctor and at least one time.');
  const prof = dbGet('doctor_profiles', doctor);
  for (const s of slots) if (fn_try_ts(s) === null || !fn_clinic_doctor_free(doctor, t(s), prof ? prof.slot_minutes : 20)) fn_raise('conflict: One of the times is not free any more. Please refresh.');
  const offered = slots.map((s) => ({ starts_at: iso(t(s)), doctor_user_id: doctor }));
  dbUpdate('booking_requests', r, { status: 'offered', offered_slots: offered, doctor_user_id: doctor, specialty: prof ? prof.specialty : r.specialty, decided_by: _m40_uid(c) });
  const sp = _m40_spec(prof ? prof.specialty : r.specialty) || {};
  fn_notify_patient(r.patient_id, 'clinic_offer', `Choose your appointment time: ${sp.name || 'clinic'}`, `The clinic offers ${offered.length} time${offered.length > 1 ? 's' : ''}. Open the app to choose one.`,
    `clinic-offer:${r.id}:${offered.length}`, `اختر موعدك: ${sp.name_ar || sp.name || 'العيادة'}`, `تعرض عليك العيادة ${offered.length} مواعيد. افتح التطبيق لتختار واحدًا.`);
  fn_audit(c, 'clinic.offer', 'booking_request', String(r.id), r.patient_id, { slots: offered.length });
  return _m40_request_json({ ...r, status: 'offered', offered_slots: offered, doctor_user_id: doctor }, 'staff');
}

// Reassign to another doctor (and specialty): the proposed time becomes that doctor's next free slot.
function api_clinic_reassign(c, d) {
  const r = _m40_request_for_staff(c, _m40_txt(d, 'request_id'));
  if (!['pending', 'escalated', 'triaging', 'offered'].includes(r.status)) fn_raise('conflict: This request was already decided.');
  const doctor = castUuid(_m40_txt(d, 'doctor_user_id'));
  const prof = doctor === null ? null : dbGet('doctor_profiles', doctor);
  if (!prof || prof.active !== true) fn_raise('bad_request: Choose an active clinic doctor.');
  const slot = fn_clinic_free_slots(doctor, 1)[0] || null;
  const tri = { ...(r.triage || {}), reassigned_from: r.specialty };
  const row = dbUpdate('booking_requests', r, { doctor_user_id: doctor, specialty: prof.specialty, proposed_at: slot, status: r.status === 'triaging' ? 'pending' : r.status, triage: tri });
  fn_audit(c, 'clinic.reassign', 'booking_request', String(r.id), r.patient_id, { from: r.specialty, to: prof.specialty });
  return _m40_request_json(row, 'staff');
}

function api_clinic_decline(c, d) {
  const r = _m40_request_for_staff(c, _m40_txt(d, 'request_id'));
  if (['accepted', 'declined', 'cancelled'].includes(r.status)) fn_raise('conflict: This request was already decided.');
  dbUpdate('booking_requests', r, { status: 'declined', decided_at: now(), decided_by: _m40_uid(c), note: left(_m40_txt(d, 'reason'), 300) });
  fn_notify_patient(r.patient_id, 'clinic_declined', 'Your clinic request', 'The clinic could not book this request. Please contact reception or try another specialty. If you feel very unwell, call 123.',
    `clinic-decline:${r.id}`, 'طلبك للعيادة', 'لم تتمكن العيادة من حجز هذا الطلب. من فضلك تواصل مع الاستقبال أو جرّب تخصصًا آخر. إذا شعرت بتعب شديد فاتصل بـ 123.');
  fn_audit(c, 'clinic.decline', 'booking_request', String(r.id), r.patient_id);
  return { declined: true };
}

// Walk-in: an existing patient (patient_id) or a new one (full_name, phone, date_of_birth, sex), booked now or at a time.
function api_clinic_walk_in(c, d) {
  fn_clinic_staff(c, _M40_RECEPTION);
  let pid = castUuid(_m40_txt(d, 'patient_id'));
  if (pid !== null && !dbGet('patients', pid)) fn_raise('not_found: patient not found');
  if (pid === null) {
    const name = left(String(coalesce(_m40_txt(d, 'full_name'), '')).trim(), 120);
    if (name.length < 3) fn_raise('bad_request: The patient\'s full name is required.');
    const phone = nullif(String(coalesce(_m40_txt(d, 'phone'), '')).replace(/[^\d+]/g, ''), '');
    const same = phone === null ? null : dbOne('patients', (p) => p.phone === phone && String(p.full_name).toLowerCase() === name.toLowerCase());
    const dob = nullif(_m40_txt(d, 'date_of_birth'), ''), sex = _m40_txt(d, 'sex');
    if (!same && (dob === null || !/^\d{4}-\d{2}-\d{2}$/.test(dob) || dob > today())) fn_raise('bad_request: Please enter a valid date of birth.');
    if (!same && !['male', 'female'].includes(coalesce(sex, ''))) fn_raise('bad_request: Please choose male or female.');
    pid = same ? same.id : dbInsert('patients', { mrn: 'MRN-' + today().replace(/-/g, '').slice(2) + '-' + md5(name + phone + now()).slice(0, 5).toUpperCase(),
      full_name: name, full_name_ar: nullif(_m40_txt(d, 'full_name_ar'), ''), phone, date_of_birth: dob, sex, preferred_language: 'ar', diabetes_type: 'none', persona: 'clinic_walk_in' }).id;
  }
  const doctor = castUuid(_m40_txt(d, 'doctor_user_id'));
  const prof = doctor === null ? null : dbGet('doctor_profiles', doctor);
  if (!prof) fn_raise('bad_request: Choose a clinic doctor.');
  const slot = coalesce(_m40_txt(d, 'starts_at'), fn_clinic_free_slots(doctor, 1)[0]);
  if (slot === null) fn_raise('conflict: This doctor has no free time in the next days.');
  const a = _m40_book(pid, doctor, slot, { source: 'walk_in', reason: _m40_txt(d, 'reason') });
  fn_audit(c, 'clinic.walk_in', 'appointment', String(a.id), pid);
  return { appointment_id: a.id, patient_id: pid, starts_at: a.starts_at };
}

// Appointment status for the polyclinic (the general rules of api_update_appointment apply). A cancellation offers the
// freed slot to the waitlist.
function api_clinic_set_status(c, d) {
  fn_clinic_staff(c, _M40_RECEPTION);
  const a0 = dbGet('appointments', castUuid(_m40_txt(d, 'appointment_id')));
  if (!a0 || a0.specialty === null) fn_raise('not_found: appointment not found');
  fn_clinic_link_patient(a0.patient_id, a0.provider_user_id);
  const res = api_update_appointment(c, d);
  const status = _m40_txt(d, 'status');
  let offered = null;
  if (status === 'cancelled' && t(a0.starts_at) > nowMs()) offered = fn_clinic_offer_slot(a0.specialty, a0.provider_user_id, a0.starts_at, null);
  return { ...res, waitlist_offer: offered };
}

/** Offers a freed slot to the first person waiting for the specialty (or that doctor). Returns the entry id or null. */
function fn_clinic_offer_slot(specialty, doctorUid, slotIso, skipEntryId) {
  if (slotIso === null || t(slotIso) < nowMs() + 30 * MIN || !fn_clinic_doctor_free(doctorUid, t(slotIso))) return null;
  const pol = fn_clinic_policy();
  const w = orderBy(dbWhere('waitlist_entries', (x) => x.status === 'waiting' && x.specialty === specialty && x.id !== skipEntryId
    && (x.doctor_user_id === null || x.doctor_user_id === doctorUid)), [(x) => t(x.created_at), 'asc'])[0];
  if (!w) return null;
  dbUpdate('waitlist_entries', w, { status: 'offered', offered_at_slot: slotIso, offered_doctor_user_id: doctorUid, offered_at: now(), offer_expires_at: iso(nowMs() + Number(pol.waitlist_offer_minutes) * MIN) });
  const sp = _m40_spec(specialty) || {}, when = _m40_when(slotIso);
  fn_notify_patient(w.patient_id, 'clinic_waitlist', `An earlier appointment is free: ${sp.name || 'clinic'}`, `${when.en}. Open the app within ${pol.waitlist_offer_minutes} minutes to take it.`,
    `clinic-wl:${w.id}:${slotIso}`, `توفر موعد أقرب: ${sp.name_ar || sp.name || 'العيادة'}`, `${when.ar}. افتح التطبيق خلال ${pol.waitlist_offer_minutes} دقيقة لتحجزه.`);
  return w.id;
}

function api_clinic_waitlist_add(c, d) {
  fn_clinic_staff(c, _M40_RECEPTION);
  const pid = castUuid(_m40_txt(d, 'patient_id'));
  if (pid === null || !dbGet('patients', pid)) fn_raise('not_found: patient not found');
  const sp = _m40_txt(d, 'specialty');
  if (!dbGet('clinic_specialties', String(sp))) fn_raise('bad_request: Choose a specialty.');
  if (dbExists('waitlist_entries', (x) => x.patient_id === pid && x.specialty === sp && ['waiting', 'offered'].includes(x.status))) fn_raise('conflict: The patient is already waiting for this specialty.');
  fn_clinic_link_patient(pid, coalesce(castUuid(_m40_txt(d, 'doctor_user_id')), _m40_uid(c)));
  const w = dbInsert('waitlist_entries', { organization_id: fn_clinic_org(), patient_id: pid, specialty: sp, doctor_user_id: castUuid(_m40_txt(d, 'doctor_user_id')) });
  fn_audit(c, 'clinic.waitlist_add', 'waitlist_entry', String(w.id), pid);
  return { id: w.id };
}
function api_clinic_waitlist_remove(c, d) {
  fn_clinic_staff(c, _M40_RECEPTION);
  const w = dbGet('waitlist_entries', castUuid(_m40_txt(d, 'entry_id')));
  if (!w || !['waiting', 'offered'].includes(w.status)) fn_raise('not_found: waitlist entry not found');
  dbUpdate('waitlist_entries', w, { status: 'removed' });
  return { removed: true };
}

/* --------------------------------------------------------------------------------------------------------- doctor */

function _m40_appt_for_doctor(c, id) {
  fn_require_role(c, ['doctor']);
  const a = dbGet('appointments', castUuid(id));
  if (!a || a.specialty === null || a.provider_user_id !== _m40_uid(c)) fn_raise('not_found: appointment not found');
  return a;
}
function _m40_invoice(doctorUid, serviceIds) {
  const prof = dbGet('doctor_profiles', doctorUid);
  const services = (serviceIds || []).map((id) => dbGet('clinic_services', castUuid(id))).filter((s) => s && s.active === true);
  const items = services.map((s) => ({ id: s.id, name: s.name, name_ar: s.name_ar, price_egp: Number(s.price_egp) }));
  return { items, total: round(Number(prof ? prof.fee_egp : 0) + items.reduce((a, s) => a + s.price_egp, 0), 2) };
}

// The doctor's clinic queue (today, urgent first) and, for the chosen appointment, the one-page brief, the record
// facts, the visit draft and the doctor-only AI hints.
function api_clinic_queue_page(c, d) {
  fn_require_role(c, ['doctor']);
  const me = _m40_uid(c);
  const day = coalesce(_m40_txt(d, 'date'), today());
  const q = orderBy(dbWhere('appointments', (a) => a.provider_user_id === me && a.specialty !== null && localDate(a.starts_at) === day && a.status !== 'cancelled'),
    [(a) => (['completed', 'no_show'].includes(a.status) ? 1 : 0), 'asc'], [(a) => _M40_URG[a.urgency] ?? 3, 'asc'], [(a) => t(a.starts_at), 'asc']);
  const sel = castUuid(_m40_txt(d, 'appointment_id')) || (q.find((a) => ['booked', 'checked_in'].includes(a.status)) || {}).id || null;
  const a = sel === null ? null : q.find((x) => x.id === sel) || null;
  let detail = null;
  if (a) {
    const p = dbGet('patients', a.patient_id) || {};
    const v = dbOne('clinic_visits', (x) => x.appointment_id === a.id);
    detail = {
      appointment: { id: a.id, starts_at: a.starts_at, status: a.status, urgency: a.urgency, source: a.source, reason: a.reason, specialty: _m40_spec(a.specialty),
        patient: { id: p.id, full_name: p.full_name, full_name_ar: p.full_name_ar } },
      patient: { id: p.id, full_name: p.full_name, full_name_ar: p.full_name_ar, age: _m40_age(p), sex: p.sex, has_diabetes: ['type1', 'type2', 'prediabetes'].includes(p.diabetes_type),
        allergies: jsonAgg(dbWhere('allergies', (x) => x.patient_id === p.id && x.status !== 'inactive' && x.verification_status !== 'refuted').map((x) => x.substance).filter(Boolean)) ?? [],
        conditions: jsonAgg(dbWhere('conditions', (x) => x.patient_id === p.id && x.status === 'active' && x.verification_status !== 'refuted').map((x) => x.display || x.code)) ?? [],
        medicines: jsonAgg(dbWhere('medications', (x) => x.patient_id === p.id && x.status === 'active' && x.verification_status !== 'refuted').map((x) => [x.name, x.dose_text, x.frequency].filter(Boolean).join(' '))) ?? [],
        recent_labs: jsonAgg(orderBy(dbWhere('lab_results', (x) => x.patient_id === p.id), [(x) => t(x.observed_at || x.created_at), 'desc']).slice(0, 6)
          .map((x) => ({ test: x.test_code, value: x.value, unit: x.unit, verified: x.verification_status === 'verified', at: x.observed_at || x.created_at }))) ?? [] },
      // The brief is an AI draft (WF-042), verified, from the triage and the record; null until it is written.
      brief: a.brief ? { ...a.brief, ai_draft: true, source: 'clinic_brief' } : null,
      visit: v ? { id: v.id, status: v.status, diagnosis: v.diagnosis, prescription: v.prescription, services: v.services || [], invoice_total_egp: v.invoice_total_egp,
        follow_up_date: v.follow_up_date, referral_id: v.referral_id, signed_at: v.signed_at, sent_at: v.sent_at, rx_check: v.rx_check, prescription_patient_ar: v.prescription_patient_ar,
        // Doctor-only drafts: never sent to the patient; the doctor copies what they agree with into their own text.
        ai_hints: v.ai_hints ? { ...v.ai_hints, ai_draft: true, doctor_only: true, source: 'clinic_hints' } : null } : null,
    };
  }
  return {
    date: day,
    queue: jsonAgg(q.map((x) => ({ id: x.id, starts_at: x.starts_at, status: x.status, urgency: x.urgency, source: x.source, has_brief: !!x.brief,
      patient: { id: x.patient_id, full_name: (dbGet('patients', x.patient_id) || {}).full_name, full_name_ar: (dbGet('patients', x.patient_id) || {}).full_name_ar } }))) ?? [],
    selected: detail,
    services: jsonAgg(dbWhere('clinic_services', (s) => s.active === true).map((s) => ({ id: s.id, specialty: s.specialty, name: s.name, name_ar: s.name_ar, price_egp: Number(s.price_egp) }))) ?? [],
    specialties: jsonAgg(orderBy(dbWhere('clinic_specialties', (s) => s.active === true), [(s) => s.sort, 'asc']).map((s) => _m40_spec(s.code))) ?? [],
    fee_egp: Number((dbGet('doctor_profiles', me) || {}).fee_egp || 0),
  };
}

// Save the visit draft (diagnosis, prescription, services, follow-up, referral). Nothing reaches the patient yet.
function api_clinic_visit_save(c, d) {
  const a = _m40_appt_for_doctor(c, _m40_txt(d, 'appointment_id'));
  let v = dbOne('clinic_visits', (x) => x.appointment_id === a.id);
  if (v && v.status !== 'draft') fn_raise('conflict: This visit is already signed.');
  const inv = _m40_invoice(a.provider_user_id, Array.isArray(d && d.service_ids) ? d.service_ids : (v ? (v.services || []).map((s) => s.id) : []));
  const ref = d && d.referral && typeof d.referral === 'object' ? { specialty: _m40_txt(d.referral, 'specialty'), reason: left(_m40_txt(d.referral, 'reason'), 300) } : null;
  if (ref && ref.specialty && !dbGet('clinic_specialties', ref.specialty)) fn_raise('bad_request: Unknown specialty for the referral.');
  const fields = {
    diagnosis: left(_m40_txt(d, 'diagnosis'), 500), prescription: left(_m40_txt(d, 'prescription'), 2000), services: inv.items, invoice_total_egp: inv.total,
    follow_up_date: nullif(_m40_txt(d, 'follow_up_date'), ''), updated_at: now(),
  };
  v = v ? dbUpdate('clinic_visits', v, fields) : dbInsert('clinic_visits', { appointment_id: a.id, patient_id: a.patient_id, doctor_user_id: a.provider_user_id, ...fields });
  if (a.status === 'booked') dbUpdate('appointments', a, { status: 'checked_in' });
  return { visit_id: v.id, invoice: inv, referral: ref };
}

// Ask the AI for doctor-only hints (possible diagnoses and treatment options to consider). Written in the background
// (WF-044) into the visit draft; the queue page shows them, marked as drafts.
function api_clinic_visit_hints(c, d) {
  const a = _m40_appt_for_doctor(c, _m40_txt(d, 'appointment_id'));
  let v = dbOne('clinic_visits', (x) => x.appointment_id === a.id);
  if (!v) v = dbInsert('clinic_visits', { appointment_id: a.id, patient_id: a.patient_id, doctor_user_id: a.provider_user_id, updated_at: now() });
  if (v.status !== 'draft') fn_raise('conflict: This visit is already signed.');
  dbUpdate('clinic_visits', v, { ai_hints: { status: 'writing', requested_at: now() } });
  fn_emit('ClinicHintsRequested', a.patient_id, String(v.id), {});
  return { visit_id: v.id, status: 'writing' };
}

// Sign the visit: the appointment is completed, a referral (if any) is created and booked into the first free slot of
// that specialty, and the patient is told (WF-043 rewrites the prescription in plain Arabic, numbers checked).
function api_clinic_visit_sign(c, d) {
  const a = _m40_appt_for_doctor(c, _m40_txt(d, 'appointment_id'));
  const v = dbOne('clinic_visits', (x) => x.appointment_id === a.id);
  if (!v || v.status !== 'draft') fn_raise('conflict: Save the visit before signing it.');
  if (!v.diagnosis) fn_raise('bad_request: Write the diagnosis before signing.');
  let referral = null, refAppt = null;
  const refSpec = _m40_txt(d && d.referral, 'specialty');
  if (refSpec) {
    if (!dbGet('clinic_specialties', refSpec)) fn_raise('bad_request: Unknown specialty for the referral.');
    referral = dbInsert('referrals', { patient_id: a.patient_id, from_user_id: _m40_uid(c), to_specialty: refSpec, to_facility_id: null, urgency: 'routine',
      reason: left(coalesce(_m40_txt(d.referral, 'reason'), v.diagnosis), 500), status: 'CREATED' });
    const pick = fn_clinic_pick_doctor(refSpec);
    if (pick.doctor_user_id && pick.slot) {
      refAppt = _m40_book(a.patient_id, pick.doctor_user_id, pick.slot, { source: 'referral', referral_id: referral.id, reason: referral.reason });
      dbUpdate('referrals', referral, { status: 'BOOKED', appointment_id: refAppt.id, updated_at: now() });
    }
  }
  dbUpdate('clinic_visits', v, { status: 'signed', signed_at: now(), referral_id: referral ? referral.id : null, updated_at: now() });
  if (['booked', 'checked_in'].includes(a.status)) dbUpdate('appointments', a, { status: 'completed' });
  fn_emit('ClinicVisitSigned', a.patient_id, String(v.id), {});
  fn_audit(c, 'clinic.visit_sign', 'clinic_visit', String(v.id), a.patient_id, { referral: refSpec || null });
  return { visit_id: v.id, status: 'signed', referral_id: referral ? referral.id : null, referral_appointment: refAppt ? { id: refAppt.id, starts_at: refAppt.starts_at } : null };
}

/* ---------------------------------------------------------------------------------------------- catalog and analytics */

function api_clinic_catalog_page(c, d) {
  fn_clinic_staff(c, _M40_RECEPTION.concat(_M40_ADMIN));
  return {
    specialties: jsonAgg(orderBy(dbRows('clinic_specialties'), [(s) => s.sort, 'asc']).map((s) => ({ ...s }))) ?? [],
    doctors: jsonAgg(dbWhere('users', (u) => u.role === 'doctor' && u.active !== false).map((u) => { const p = dbGet('doctor_profiles', u.id);
      return { user_id: u.id, full_name: u.full_name, full_name_ar: u.full_name_ar, profile: p ? { specialty: p.specialty, fee_egp: Number(p.fee_egp), daily_slots: p.daily_slots || [], slot_minutes: p.slot_minutes, active: p.active } : null }; })) ?? [],
    services: jsonAgg(dbRows('clinic_services').map((s) => ({ ...s, price_egp: Number(s.price_egp) }))) ?? [],
  };
}
function api_clinic_specialty_save(c, d) {
  fn_clinic_staff(c, _M40_ADMIN);
  const code = String(coalesce(_m40_txt(d, 'code'), '')).trim().toLowerCase().replace(/[^a-z_]/g, '');
  if (code.length < 2) fn_raise('bad_request: code is required (letters and _).');
  const row = { code, name: left(coalesce(_m40_txt(d, 'name'), code), 80), name_ar: left(_m40_txt(d, 'name_ar'), 80),
    sort: castInt(coalesce(_m40_txt(d, 'sort'), '100')), active: castBool(coalesce(_m40_txt(d, 'active'), 'true')) !== false };
  const ex = dbGet('clinic_specialties', code);
  fn_audit(c, 'clinic.specialty_save', 'clinic_specialty', code, null);
  return ex ? dbUpdate('clinic_specialties', ex, row) : dbInsert('clinic_specialties', row);
}
function api_clinic_doctor_save(c, d) {
  fn_clinic_staff(c, _M40_ADMIN);
  const uid = castUuid(_m40_txt(d, 'user_id'));
  const u = uid === null ? null : dbGet('users', uid);
  if (!u || u.role !== 'doctor') fn_raise('bad_request: Choose a doctor account.');
  const spec = _m40_txt(d, 'specialty');
  if (!dbGet('clinic_specialties', String(spec))) fn_raise('bad_request: Choose a specialty.');
  const slots = (Array.isArray(d.daily_slots) ? d.daily_slots : String(coalesce(_m40_txt(d, 'daily_slots'), '')).split(','))
    .map((s) => String(s).trim()).filter((s) => /^\d{1,2}:\d{2}$/.test(s)).map((s) => s.padStart(5, '0'));
  const row = { user_id: uid, organization_id: fn_clinic_org(), specialty: spec, fee_egp: Number(coalesce(_m40_txt(d, 'fee_egp'), '0')), daily_slots: [...new Set(slots)].sort(),
    slot_minutes: castInt(coalesce(_m40_txt(d, 'slot_minutes'), '20')), active: castBool(coalesce(_m40_txt(d, 'active'), 'true')) !== false };
  const org = fn_clinic_org();
  if (org !== null && !dbExists('memberships', (m) => m.user_id === uid && m.organization_id === org)) dbInsert('memberships', { user_id: uid, organization_id: org, role: 'doctor' });
  const ex = dbGet('doctor_profiles', uid);
  fn_audit(c, 'clinic.doctor_save', 'doctor_profile', String(uid), null);
  return ex ? dbUpdate('doctor_profiles', ex, row) : dbInsert('doctor_profiles', row);
}
function api_clinic_service_save(c, d) {
  fn_clinic_staff(c, _M40_ADMIN);
  const id = castUuid(_m40_txt(d, 'id'));
  const spec = _m40_txt(d, 'specialty');
  if (!dbGet('clinic_specialties', String(spec))) fn_raise('bad_request: Choose a specialty.');
  const price = Number(_m40_txt(d, 'price_egp'));
  if (!Number.isFinite(price) || price < 0) fn_raise('bad_request: The price must be a number of pounds.');
  const row = { organization_id: fn_clinic_org(), specialty: spec, name: left(coalesce(_m40_txt(d, 'name'), ''), 120), name_ar: left(_m40_txt(d, 'name_ar'), 120),
    price_egp: price, duration_min: castInt(_m40_txt(d, 'duration_min')), fasting_required: castBool(_m40_txt(d, 'fasting_required')) === true,
    active: castBool(coalesce(_m40_txt(d, 'active'), 'true')) !== false };
  if (!row.name) fn_raise('bad_request: The service needs a name.');
  const ex = id === null ? null : dbGet('clinic_services', id);
  fn_audit(c, 'clinic.service_save', 'clinic_service', String(id || ''), null);
  return ex ? dbUpdate('clinic_services', ex, row) : dbInsert('clinic_services', row);
}

// Clinic results from the records (no fixed numbers): requests, routing kept by reception (triage accuracy), time to a
// decision, waitlist recoveries, internal referrals kept in the clinic, visits, revenue and no-shows.
function api_clinic_analytics_page(c, d) {
  fn_clinic_staff(c, _M40_RECEPTION.concat(_M40_ADMIN));
  return fn_clinic_kpis(castInt(coalesce(_m40_txt(d, 'days'), '30')));
}

/** The clinic numbers over the last p_days days (1-365): { days, kpis[{key, actual, unit, n?, owner}], by_specialty[] }.
 *  owner is the workflow the number belongs to: W4 booking and access (triage, decisions, waitlist, no-shows), W3 the
 *  visit (referrals kept in the clinic, visits, revenue). Also read by the monitoring dashboard (35_monitoring.js). */
function fn_clinic_kpis(p_days) {
  const days = Math.max(1, Math.min(castInt(p_days) || 30, 365));
  const since = nowMs() - days * DAY;
  const reqs = dbWhere('booking_requests', (r) => t(r.created_at) >= since);
  const triaged = reqs.filter((r) => r.triage && r.triage.ai === 'model');
  const decided = reqs.filter((r) => r.decided_at !== null);
  const kept = triaged.filter((r) => ['accepted', 'offered'].includes(r.status) && !(r.triage && r.triage.reassigned_from));
  const minutes = decided.map((r) => (t(r.decided_at) - t(r.created_at)) / MIN).sort((a, b) => a - b);
  const appts = dbWhere('appointments', (a) => a.specialty !== null && t(a.starts_at) >= since && t(a.starts_at) <= nowMs());
  const visits = dbWhere('clinic_visits', (v) => v.signed_at !== null && t(v.signed_at) >= since);
  const refs = visits.filter((v) => v.referral_id !== null);
  const refsBooked = refs.filter((v) => { const r = dbGet('referrals', v.referral_id); return r && r.appointment_id !== null; });
  const wl = dbWhere('waitlist_entries', (w) => w.status === 'booked' && t(w.offered_at || w.created_at) >= since);
  const bySpec = {};
  for (const r of reqs) { const k = r.specialty || 'untriaged'; bySpec[k] = bySpec[k] || { requests: 0, accepted: 0 }; bySpec[k].requests++; if (r.status === 'accepted') bySpec[k].accepted++; }
  const pct = (a, b) => (b ? round(100 * a / b, 1) : null);
  return {
    days,
    kpis: [
      { key: 'requests', actual: reqs.length, unit: 'requests', owner: 'W4' },
      { key: 'ai_triaged', actual: triaged.length, unit: 'requests', owner: 'W4' },
      { key: 'routing_kept', actual: pct(kept.length, triaged.filter((r) => ['accepted', 'offered'].includes(r.status)).length), unit: '%', n: triaged.length, owner: 'W4' },
      { key: 'minutes_to_decision', actual: minutes.length ? round(minutes[Math.floor(minutes.length / 2)], 0) : null, unit: 'min (median)', n: minutes.length, owner: 'W4' },
      { key: 'waitlist_recoveries', actual: wl.length, unit: 'slots', owner: 'W4' },
      { key: 'referrals_kept_in_clinic', actual: pct(refsBooked.length, refs.length), unit: '%', n: refs.length, owner: 'W3' },
      { key: 'visits', actual: visits.length, unit: 'visits', owner: 'W3' },
      { key: 'revenue_egp', actual: round(visits.reduce((a, v) => a + Number(v.invoice_total_egp || 0), 0), 0), unit: 'EGP', owner: 'W3' },
      { key: 'no_shows', actual: pct(appts.filter((a) => a.status === 'no_show').length, appts.length), unit: '%', n: appts.length, owner: 'W4' },
    ],
    by_specialty: jsonAgg(Object.entries(bySpec).map(([k, v]) => ({ specialty: _m40_spec(k) || { code: k, name: k }, ...v }))) ?? [],
  };
}

/* --------------------------------------------------------------------------------- AI sections: context and results */

/** Nothing left to do for this event (the request was decided, the visit signed, ...): a run an earlier attempt left
 *  open is closed, and the section ends without a model call. */
function _m40_nothing(p_event_id) {
  const ev = castUuid(p_event_id);
  if (ev !== null) dbUpdateWhere('ai_runs', (r) => r.event_id === ev && ['QUEUED', 'PROCESSING', 'VERIFYING'].includes(r.status), { status: 'FAILED', error: 'nothing to do: the record changed since the event', completed_at: now() });
  return null;
}

// Context of the triage (WF-040): the message, the patient's age and sex, the specialties the clinic offers, the gate.
function fn_ctx_clinic_triage(p_request_id, p_event_id) {
  const r = dbGet('booking_requests', castUuid(p_request_id));
  if (!r || r.status !== 'triaging') return _m40_nothing(p_event_id);
  const p = dbGet('patients', r.patient_id) || {};
  const run = fn_ai_run_start('WF-040 Clinic triage', r.patient_id, castUuid(p_event_id), { request_id: r.id }, null, 'clinic_triage/v1');
  return {
    request_id: r.id, patient_id: r.patient_id, ai_run_id: run, message: r.message, age: _m40_age(p), sex: p.sex || null,
    has_diabetes: ['type1', 'type2', 'prediabetes'].includes(p.diabetes_type),
    specialties: orderBy(dbWhere('clinic_specialties', (s) => s.active === true), [(s) => s.sort, 'asc']).map((s) => ({ code: s.code, name: s.name })),
    policy: fn_clinic_policy(), gate: fn_ai_gate(r.patient_id, 'clinic_triage'), dose_guard: fn_dose_guard(),
  };
}
// Context of the visit-prep note (WF-041) and the pre-visit brief (WF-042).
function fn_ctx_clinic_appointment(p_appointment_id, p_event_id, p_kind) {
  const a = dbGet('appointments', castUuid(p_appointment_id));
  if (!a || a.specialty === null || !['booked', 'checked_in'].includes(a.status)) return _m40_nothing(p_event_id);
  const p = dbGet('patients', a.patient_id) || {};
  const r = a.booking_request_id ? dbGet('booking_requests', a.booking_request_id) : null;
  const services = dbWhere('clinic_services', (s) => s.specialty === a.specialty && s.active === true);
  const run = fn_ai_run_start(p_kind === 'brief' ? 'WF-042 Clinic brief' : 'WF-041 Clinic visit prep', a.patient_id, castUuid(p_event_id), { appointment_id: a.id }, null, p_kind === 'brief' ? 'clinic_brief/v1' : 'clinic_prep/v1');
  return {
    appointment_id: a.id, patient_id: a.patient_id, ai_run_id: run, starts_at: a.starts_at, specialty: _m40_spec(a.specialty), doctor: _m40_doctor(a.provider_user_id),
    triage: r ? { message: r.message, ...(r.triage || {}) } : { message: a.reason },
    fasting_required: services.some((s) => s.fasting_required === true),
    record: p_kind === 'brief' ? {
      age: _m40_age(p), sex: p.sex || null, diabetes_type: p.diabetes_type || null,
      conditions: dbWhere('conditions', (x) => x.patient_id === p.id && x.status === 'active' && x.verification_status !== 'refuted').map((x) => x.display || x.code),
      medicines: dbWhere('medications', (x) => x.patient_id === p.id && x.status === 'active' && x.verification_status !== 'refuted').map((x) => [x.name, x.dose_text, x.frequency].filter(Boolean).join(' ')),
      allergies: dbWhere('allergies', (x) => x.patient_id === p.id && x.status !== 'inactive' && x.verification_status !== 'refuted').map((x) => x.substance).filter(Boolean),
      recent_labs: orderBy(dbWhere('lab_results', (x) => x.patient_id === p.id), [(x) => t(x.observed_at || x.created_at), 'desc']).slice(0, 8)
        .map((x) => ({ test: x.test_code, value: x.value, unit: x.unit, verified: x.verification_status === 'verified', at: x.observed_at || x.created_at })),
      recent_vitals: orderBy(dbWhere('vitals', (v) => v.patient_id === p.id), [(v) => t(v.measured_at), 'desc']).slice(0, 4)
        .map((v) => ({ type: v.type, systolic: v.systolic, diastolic: v.diastolic, value: v.value, unit: v.unit, at: v.measured_at })),
    } : null,
    policy: fn_clinic_policy(), gate: fn_ai_gate(a.patient_id, p_kind === 'brief' ? 'clinic_brief' : 'clinic_prep'), dose_guard: fn_dose_guard(),
  };
}
// Context of the prescription rewrite (WF-043) and of the doctor hints (WF-044).
function fn_ctx_clinic_visit(p_visit_id, p_event_id, p_kind) {
  const v = dbGet('clinic_visits', castUuid(p_visit_id));
  if (!v || (p_kind === 'rx' && v.status !== 'signed') || (p_kind === 'hints' && v.status !== 'draft')) return _m40_nothing(p_event_id);
  const a = dbGet('appointments', v.appointment_id) || {};
  const ctxA = fn_ctx_clinic_appointment_facts(a);
  const run = fn_ai_run_start(p_kind === 'rx' ? 'WF-043 Clinic prescription for the patient' : 'WF-044 Clinic doctor hints', v.patient_id, castUuid(p_event_id), { visit_id: v.id }, null, p_kind === 'rx' ? 'clinic_rx/v1' : 'clinic_hints/v1');
  const ref = v.referral_id ? dbGet('referrals', v.referral_id) : null;
  const refA = ref && ref.appointment_id ? dbGet('appointments', ref.appointment_id) : null;
  return {
    visit_id: v.id, patient_id: v.patient_id, ai_run_id: run, appointment_id: a.id, specialty: _m40_spec(a.specialty), doctor: _m40_doctor(v.doctor_user_id),
    diagnosis: v.diagnosis, prescription: v.prescription, follow_up_date: v.follow_up_date, invoice_total_egp: v.invoice_total_egp, services: v.services || [],
    referral: ref ? { specialty: _m40_spec(ref.to_specialty), starts_at: refA ? refA.starts_at : null, doctor: refA ? _m40_doctor(refA.provider_user_id) : null } : null,
    facts: ctxA, policy: fn_clinic_policy(), gate: fn_ai_gate(v.patient_id, p_kind === 'rx' ? 'clinic_rx' : 'clinic_hints'), dose_guard: fn_dose_guard(),
  };
}
function fn_ctx_clinic_appointment_facts(a) {
  const p = dbGet('patients', a.patient_id) || {};
  const r = a.booking_request_id ? dbGet('booking_requests', a.booking_request_id) : null;
  return { age: _m40_age(p), sex: p.sex || null, specialty: a.specialty, complaint: r ? r.message : a.reason, brief: a.brief || null,
    conditions: dbWhere('conditions', (x) => x.patient_id === p.id && x.status === 'active' && x.verification_status !== 'refuted').map((x) => x.display || x.code),
    medicines: dbWhere('medications', (x) => x.patient_id === p.id && x.status === 'active' && x.verification_status !== 'refuted').map((x) => [x.name, x.dose_text, x.frequency].filter(Boolean).join(' ')),
    allergies: dbWhere('allergies', (x) => x.patient_id === p.id && x.status !== 'inactive' && x.verification_status !== 'refuted').map((x) => x.substance).filter(Boolean) };
}

// Results of the clinic AI sections (called by fn_apply_ai_action for types clinic_*). Each is checked here again.
function fn_clinic_apply_action(p) {
  const type = _m40_txt(p, 'type');
  if (type === 'clinic_triage') {
    const r = dbGet('booking_requests', castUuid(_m40_txt(p, 'request_id')));
    if (!r || r.status !== 'triaging') return { applied: false, reason: 'request_not_triaging' };
    const pol = fn_clinic_policy();
    const spec = dbGet('clinic_specialties', String(_m40_txt(p, 'specialty')));
    const conf = Number(_m40_txt(p, 'confidence'));
    const reasons = [];
    let urgency = ['urgent', 'priority', 'routine'].includes(_m40_txt(p, 'urgency')) ? _m40_txt(p, 'urgency') : 'priority';
    const redFlags = Array.isArray(p.red_flags) ? p.red_flags.map(String).slice(0, 8) : [];
    if (redFlags.length) { urgency = 'urgent'; reasons.push('red_flag'); }
    if (r.urgency === 'urgent') urgency = 'urgent';
    if (!spec) reasons.push('no_specialty');
    if (!(conf >= Number(pol.triage_min_confidence))) reasons.push('low_confidence');
    if (castBool(_m40_txt(p, 'out_of_scope')) === true) reasons.push('out_of_scope');
    const code = spec ? spec.code : (dbGet('clinic_specialties', 'internal_medicine') ? 'internal_medicine' : null);
    const pick = code ? fn_clinic_pick_doctor(code) : { doctor_user_id: null, slot: null };
    const tri = { cc: left(_m40_txt(p, 'cc'), 200), cc_ar: left(_m40_txt(p, 'cc_ar'), 200), why: left(_m40_txt(p, 'why'), 300), why_ar: left(_m40_txt(p, 'why_ar'), 300),
      soap: p.soap && typeof p.soap === 'object' ? p.soap : null, red_flags: redFlags, confidence: Number.isFinite(conf) ? conf : null, review_reasons: reasons,
      ai: _m40_txt(p, 'source') === 'model' ? 'model' : 'rules' };
    dbUpdate('booking_requests', r, { status: reasons.includes('out_of_scope') ? 'escalated' : 'pending', specialty: code, urgency, triage: tri,
      doctor_user_id: pick.doctor_user_id, proposed_at: pick.slot, ai_run_id: castUuid(_m40_txt(p, 'ai_run_id')) });
    return { applied: true, request_id: r.id };
  }
  if (type === 'clinic_brief') {
    const a = dbGet('appointments', castUuid(_m40_txt(p, 'appointment_id')));
    if (!a) return { applied: false, reason: 'appointment_not_found' };
    const keys = ['cc', 'why', 's', 'o', 'a', 'p', 'prep', 'cc_ar', 'why_ar', 's_ar', 'o_ar', 'a_ar', 'p_ar', 'prep_ar'];
    const brief = Object.fromEntries(keys.map((k) => [k, left(_m40_txt(p.brief || {}, k), 800)]));
    dbUpdate('appointments', a, { brief: { ...brief, lab_flags: Array.isArray(p.lab_flags) ? p.lab_flags.slice(0, 12) : [], written_at: now(), ai_run_id: _m40_txt(p, 'ai_run_id'), release: _m40_txt(p, 'release') } });
    return { applied: true };
  }
  if (type === 'clinic_prep') {
    const a = dbGet('appointments', castUuid(_m40_txt(p, 'appointment_id')));
    if (!a) return { applied: false, reason: 'appointment_not_found' };
    fn_notify_patient(a.patient_id, 'clinic_prep', 'Before your visit', left(_m40_txt(p, 'body_en'), 500), `clinic-prep:${a.id}`, 'قبل زيارتك', left(_m40_txt(p, 'body_ar'), 500));
    return { applied: true };
  }
  if (type === 'clinic_rx') {
    const v = dbGet('clinic_visits', castUuid(_m40_txt(p, 'visit_id')));
    if (!v || v.status !== 'signed') return { applied: false, reason: 'visit_not_signed' };
    dbUpdate('clinic_visits', v, { prescription_patient_ar: left(_m40_txt(p, 'rx_ar'), 3000), rx_check: _m40_txt(p, 'rx_check'), status: 'sent', sent_at: now(), updated_at: now() });
    fn_notify_patient(v.patient_id, 'clinic_visit', left(_m40_txt(p, 'title_en'), 120) || 'Your visit summary', left(_m40_txt(p, 'body_en'), 1500), `clinic-visit:${v.id}`,
      left(_m40_txt(p, 'title_ar'), 120) || 'ملخص زيارتك', left(_m40_txt(p, 'body_ar'), 3000));
    return { applied: true };
  }
  if (type === 'clinic_hints') {
    const v = dbGet('clinic_visits', castUuid(_m40_txt(p, 'visit_id')));
    if (!v || v.status !== 'draft') return { applied: false, reason: 'visit_not_draft' };
    dbUpdate('clinic_visits', v, { ai_hints: { status: _m40_txt(p, 'status') || 'ready', items: Array.isArray(p.items) ? p.items.slice(0, 6) : [],
      note: left(_m40_txt(p, 'note'), 400), written_at: now(), ai_run_id: _m40_txt(p, 'ai_run_id') } });
    return { applied: true };
  }
  return { applied: false, reason: 'unknown_clinic_action' };
}

/* ------------------------------------------------------------------------------------------------ escalation */

// Requests nobody at reception decided in time: once per request, the clinic admins of its organization get an
// escalation notice and the patient is told the clinic has been reminded (with the emergency number).
function fn_run_clinic_escalations() {
  const pol = fn_clinic_policy();
  const limit = { urgent: Number(pol.escalate_urgent_minutes) * MIN, priority: Number(pol.escalate_priority_hours) * HOUR,
    routine: Number(pol.escalate_routine_hours) * HOUR };
  const nowT = nowMs();
  const late = dbWhere('booking_requests', (r) => ['triaging', 'pending', 'escalated'].includes(r.status) && !r.escalated_at
    && t(r.created_at) < nowT - coalesce(limit[r.urgency], limit.routine));
  const admins = dbWhere('users', (u) => u.active === true && u.role === 'clinic_admin');
  for (const r of late) {
    dbUpdate('booking_requests', r, { escalated_at: now() });
    const hours = round((nowT - t(r.created_at)) / HOUR * 10) / 10;
    const sp = r.specialty ? _m40_spec(r.specialty) || {} : {};
    for (const u of admins) {
      if (!dbExists('memberships', (m) => m.user_id === u.id && m.organization_id === r.organization_id)) continue;
      dbInsert('notifications', {
        user_id: u.id, patient_id: r.patient_id, kind: 'escalation',
        title: `Booking request not answered: ${coalesce(sp.name, 'clinic')}`,
        body: `A ${r.urgency} booking request has waited ${hours} hours without a reception decision. Open Clinic reception to accept, offer times or decline.`,
        title_ar: `طلب حجز بدون رد: ${coalesce(sp.name_ar, sp.name, 'العيادة')}`,
        body_ar: `طلب حجز ${r.urgency === 'urgent' ? 'عاجل' : ''} ينتظر منذ ${hours} ساعة دون قرار من الاستقبال. افتح استقبال العيادة لقبوله أو عرض مواعيد أو رفضه.`,
        dedupe_key: `clinic-escalation:${r.id}:${u.id}`,
      }, { onConflict: 'nothing' });
    }
    fn_notify_patient(r.patient_id, 'clinic_request', 'Your clinic request is still waiting',
      'We reminded the clinic manager about your request. If you feel much worse, severe chest pain, breathlessness or fainting, call 123 now.',
      `clinic-escalation-patient:${r.id}`, 'طلبك للعيادة ما زال في الانتظار',
      'ذكّرنا مدير العيادة بطلبك. إذا ساءت حالتك أو شعرت بألم شديد في الصدر أو ضيق في التنفس أو إغماء فاتصل بـ 123 فورًا.');
  }
  return { clinic_escalations: late.length };
}
