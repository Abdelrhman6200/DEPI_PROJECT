// Diabetes cover for every patient (rule diabetes_oncall).
//  - A patient linked to a diabetes doctor (diabetology, endocrinology, internal medicine; or a diabetes clinic doctor
//    without a specialty profile): alerts go to that doctor's clinic, as before.
//  - A patient with no doctor, or linked only to doctors of other specialties (e.g. an orthopedic surgeon in the
//    polyclinic): the on-call diabetes clinic covers them (care_team role 'oncall', so its clinicians get the alerts and
//    may open the record; the patient's tier stays 'unlinked'), and the patient is shown a matched diabetes doctor from
//    the directory (diabetes_doctors, imported from the DEPI list). A patient linked to another specialty keeps that
//    doctor too: both get the alerts.
//  - Emergencies always point to 123 (the fixed emergency texts); the cover never replaces it.

function _d41_cfg() { return fn_rule('diabetes_oncall'); }

/** The patient's linked doctors, each marked whether they cover diabetes. */
function fn_linked_doctors(p_patient_id) {
  const pid = castUuid(p_patient_id);
  const cfg = _d41_cfg() || {};
  const ok = Array.isArray(cfg.diabetes_specialties) ? cfg.diabetes_specialties : ['diabetology', 'endocrinology', 'internal_medicine'];
  return dbWhere('care_team', (ct) => pid !== null && ct.patient_id === pid && ct.active === true && ct.role === 'doctor').map((ct) => {
    const u = dbGet('users', ct.user_id);
    const prof = dbGet('doctor_profiles', ct.user_id);
    const org = ct.organization_id ? dbGet('organizations', ct.organization_id) : null;
    // A diabetes clinic's doctor has no specialty profile; the polyclinic's specialists do.
    const diabetes = prof ? ok.includes(prof.specialty) : !(org && org.type === 'polyclinic');
    return { user_id: ct.user_id, full_name: u ? u.full_name : null, full_name_ar: u ? u.full_name_ar : null,
      specialty: prof ? prof.specialty : null, organization_id: ct.organization_id, organization: org ? org.name : null, diabetes };
  });
}

/** null when the patient has a diabetes doctor (or the rule is off); otherwise the on-call clinic's id. */
function fn_needs_diabetes_cover(p_patient_id) {
  const cfg = _d41_cfg();
  if (!cfg || !cfg.organization_id) return null;
  return fn_linked_doctors(p_patient_id).some((d) => d.diabetes) ? null : castUuid(cfg.organization_id);
}

/**
 * Makes sure the on-call diabetes clinic covers this patient when they need it (one care_team row with role oncall,
 * held by a doctor of that clinic, so the clinic's staff get the inbox items and may open the record). Returns the
 * clinic's id, or null when no cover is needed.
 */
function fn_ensure_diabetes_cover(p_patient_id) {
  const pid = castUuid(p_patient_id);
  const org = pid === null ? null : fn_needs_diabetes_cover(pid);
  if (org === null) return null;
  if (dbExists('care_team', (ct) => ct.patient_id === pid && ct.organization_id === org && ct.active === true)) return org;
  const doc = dbOne('memberships', (m) => m.organization_id === org && m.role === 'doctor')
    || dbOne('memberships', (m) => m.organization_id === org && m.role === 'nurse');
  if (!doc) return null;
  const old = dbOne('care_team', (ct) => ct.patient_id === pid && ct.user_id === doc.user_id);
  if (old) dbUpdate('care_team', old, { active: true, organization_id: org, role: old.role === 'doctor' ? 'doctor' : 'oncall' });
  else dbInsert('care_team', { patient_id: pid, user_id: doc.user_id, organization_id: org, role: 'oncall', active: true });
  return org;
}

// Cairo districts as they appear in the directory's locations (Arabic and English), for matching by area.
const _D41_DISTRICTS = {
  'nasr city': ['nasr city', 'مدينة نصر', 'مدينه نصر', 'رابعة', 'الحى السابع', 'الحي السابع', 'الحى العاشر', 'الحي العاشر'],
  'heliopolis': ['heliopolis', 'مصر الجديدة', 'مصر الجديده', 'روكسى', 'روكسي', 'الكوربة', 'الكوربه', 'ميدان الحجاز', 'شيراتون'],
  'zeitoun': ['zeitoun', 'zeitoun', 'الزيتون'],
  'ain shams': ['ain shams', 'عين شمس'],
  'matareya': ['matareya', 'matariya', 'المطرية', 'المطريه'],
  'nozha': ['nozha', 'النزهة', 'النزهه'],
  'shubra': ['shubra', 'شبرا'],
};
function _d41_text(d) {
  return [...(d.areas || []), ...(d.locations || []).flatMap((l) => [l && l.name, l && l.address])].filter(Boolean).join(' ').toLowerCase();
}
function _d41_hash(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }

/**
 * The patient's matched diabetes doctor from the directory, or null when they have a linked diabetes doctor. The
 * match is stored, so it stays the same; it prefers the specialties in the rule's order and a doctor in the
 * patient's district, and spreads patients evenly between equal choices.
 */
function fn_matched_doctor(p_patient_id) {
  const pid = castUuid(p_patient_id);
  if (pid === null || fn_needs_diabetes_cover(pid) === null) return null;
  const kept = dbGet('patient_doctor_matches', pid);
  if (kept) {
    const d = dbGet('diabetes_doctors', kept.doctor_id);
    if (d && d.active !== false) return { ...d, reason: kept.reason };
  }
  const cfg = _d41_cfg() || {};
  const order = Array.isArray(cfg.specialty_order) ? cfg.specialty_order : ['diabetology', 'endocrinology', 'internal_medicine'];
  const p = dbGet('patients', pid) || {};
  const city = String(p.city || '').toLowerCase().trim();
  const words = _D41_DISTRICTS[city] || (city ? [city] : []);
  const ranked = dbWhere('diabetes_doctors', (d) => d.active !== false && order.includes(d.specialty)).map((d) => {
    const inArea = words.length > 0 && words.some((w) => _d41_text(d).includes(w.toLowerCase()));
    return { d, inArea, rank: order.indexOf(d.specialty), h: _d41_hash(`${pid}|${d.id}`) };
  });
  if (!ranked.length) return null;
  // In the patient's district first; within that, the best specialty; equal choices spread by a hash of the patient.
  ranked.sort((a, b) => Number(b.inArea) - Number(a.inArea) || a.rank - b.rank || a.h - b.h);
  const best = ranked[0];
  const reason = best.inArea ? 'specialty and district' : 'specialty (no listed doctor in the patient\'s district)';
  const prev = dbGet('patient_doctor_matches', pid);
  if (prev) dbUpdate('patient_doctor_matches', prev, { doctor_id: best.d.id, reason, matched_at: now() });
  else dbInsert('patient_doctor_matches', { patient_id: pid, doctor_id: best.d.id, reason });
  return { ...best.d, reason };
}

/** What the patient (or family member) sees under "Your diabetes doctor". */
function api_my_diabetes_doctor(c, d) {
  const pid = fn_resolve_patient(c, d);
  const cfg = _d41_cfg() || {};
  const linked = fn_linked_doctors(pid);
  const coverOrg = fn_ensure_diabetes_cover(pid);
  const m = fn_matched_doctor(pid);
  const org = coverOrg ? dbGet('organizations', coverOrg) : null;
  return {
    linked: linked.map((x) => ({ full_name: x.full_name, full_name_ar: x.full_name_ar, specialty: x.specialty, organization: x.organization, diabetes: x.diabetes })),
    matched: m ? { id: m.id, name_ar: m.name_ar, name_en: m.name_en, specialty: m.specialty, locations: m.locations || [], areas: m.areas || [], phone: m.phone, reason: m.reason } : null,
    covered_by: org ? { name: org.name, name_ar: org.name_ar } : null,
    emergency_number: String(cfg.emergency_number || '123'),
  };
}
