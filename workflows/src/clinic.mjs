// Polyclinic AI sections (from the MediCare AI system, rebuilt on the platform's AI gate, output guard, verifier and
// Action Validator). The engine side is workflows/src/engine/40_clinic.js; each section starts from an outbox event.
//
//   WF-040 Triage        ClinicBookingRequested      suggests specialty, urgency and the chief complaint for reception
//   WF-041 Visit prep    ClinicAppointmentConfirmed  the patient's "before your visit" note (fasting only when a booked
//                                                    service needs it), released only when the verifier approves it
//   WF-042 Brief         ClinicBriefRequested        one-page SOAP brief for the specialist, from the triage and record
//   WF-043 Prescription  ClinicVisitSigned           the signed prescription in plain Arabic for the patient: every
//                                                    number must match the doctor's text, or the doctor's exact words
//                                                    are sent; released only when the verifier approves it
//   WF-044 Hints         ClinicHintsRequested        doctor-only ideas to consider, marked as drafts, never sent
//
// Every section has fixed text that is used when the model is not allowed (consent, local only), does not answer, or
// its draft fails a check. AI never decides: reception accepts the triage, the doctor writes the diagnosis and
// prescription (fn_apply_ai_action refuses diagnosis and prescription actions from AI).
import { WF } from './lib.mjs';
import { SCHEMAS } from './schemas.mjs';
import { explainer } from './ai.mjs';

// The Cairo date and time of an ISO timestamp, in English and Arabic (Code-node JavaScript).
const WHEN_JS = `
const cairo = (iso) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  const d = p.year + '-' + p.month + '-' + p.day, h = p.hour + ':' + p.minute; return { en: d + ' at ' + h, ar: d + ' الساعة ' + h }; };`;
// Western digits, then every number of a text (for the prescription number check).
const NUMS_JS = `
const numsOf = (s) => (String(s || '').replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0))
  .match(/\\d+(?:[.,]\\d+)?/g) || []).map(x => String(Number(x.replace(',', '.'))));
// The Arabic text (a) must add or change no number of the doctor's text (b); a number from 1 to 10 of the doctor's
// text may be written as the Arabic word ("قرص واحد", "مرتين", "ثلاث مرات").
const WORD_NUM = { '1': /واحد|واحده|واحدة|مره واحده|مرة واحدة/, '2': /اثنين|اثنان|اثنتين|اثنتان|مرتين|قرصين|حبتين/, '3': /ثلاث|ثلاثة|ثلاثه|تلات/,
  '4': /أربع|اربع|أربعة|اربعه/, '5': /خمس|خمسة|خمسه/, '6': /ست |ستة|سته/, '7': /سبع|سبعة|سبعه/, '8': /ثماني|ثمانية|ثمانيه|تمان/, '9': /تسع|تسعة|تسعه/, '10': /عشر |عشرة|عشره/ };
const sameNumbers = (a, b) => {
  const left = numsOf(a), need = numsOf(b);
  for (const n of left) { const i = need.indexOf(n); if (i < 0) return false; need.splice(i, 1); }
  return need.every(n => WORD_NUM[n] && WORD_NUM[n].test(String(a || '')));
};`;

export function clinicTriage() {
  return explainer({
    id: WF.clinicTriage,
    name: 'WF-040 · Clinic triage (gated Gemini, reception decides)',
    description: 'Suggests the specialty, urgency, chief complaint and red flags of a polyclinic booking request; reception accepts or changes it.',
    loadSql: `select app.fn_ctx_clinic_triage($1::uuid, $2::uuid) as c`,
    loadParams: `[ $json.resource_id, $json.event_id ]`,
    promptName: 'clinic_triage',
    schema: SCHEMAS.clinic_triage,
    temperature: 0.1,
    task: 'Route the PATIENT_MESSAGE to one of the SPECIALTIES, following your rules.',
    sections: `[['PATIENT_MESSAGE', c.message], ['PATIENT', { age: c.age, sex: c.sex, has_diabetes: c.has_diabetes }], ['SPECIALTIES', c.specialties]]`,
    buildActions: `
const codes = (c.specialties || []).map(s => s.code);
// A specialty outside the list, a dose or medicine advice in the text: not used (reception routes it by hand).
// A number in the wording that is not in the message ("ten days" written as "10 days") drops only the wording: the routing
// is kept, and reception reads the patient's own words instead.
const m0 = o || (gated && !langBad.length ? gated : null);
const wordingOk = !!o;
const violations = m0 ? doseViolations([m0.cc, m0.why, m0.soap_s, m0.cc_ar, m0.why_ar].join(' '), c.dose_guard, []) : [];
const ok = m0 && codes.includes(m0.specialty) && !violations.length;
const own = String(c.message || '').slice(0, 160);
const base = { type: 'clinic_triage', patient_id: c.patient_id, request_id: c.request_id, ai_run_id: c.ai_run_id, trigger: 'clinic_triage' };
const fixed = { ...base, specialty: null, urgency: 'routine', confidence: 0, red_flags: [], out_of_scope: false, source: 'rules',
  cc: String(c.message || '').slice(0, 120), why: 'Not routed automatically: please choose the specialty.', why_ar: 'لم يتم التوجيه تلقائيًا: من فضلك اختر التخصص.' };
const action = ok ? { ...base, specialty: m0.specialty, urgency: m0.urgency, confidence: Number(m0.confidence), red_flags: (m0.red_flags || []).slice(0, 8), out_of_scope: m0.out_of_scope === true,
  cc: wordingOk ? m0.cc : own, cc_ar: wordingOk ? m0.cc_ar : null, why: wordingOk ? m0.why : 'Suggested from the message (wording not shown: it did not match the message).',
  why_ar: wordingOk ? m0.why_ar : 'اقتراح من نص الرسالة.', soap: wordingOk && m0.soap_s ? { s: m0.soap_s } : { s: own }, source: 'model' } : fixed;
const meta = { ai_run_id: c.ai_run_id, status: ok ? 'COMPLETED' : 'FALLBACK', output: o || null, guard: { dose_violations: violations, used_ai: !!ok, wording_used: wordingOk, specialty_known: !!(m0 && codes.includes(m0.specialty)) } };
return [{ json: { action, fallback_action: fixed, meta } }];`,
  });
}

export function clinicPrep() {
  return explainer({
    id: WF.clinicPrep,
    name: 'WF-041 · Clinic visit preparation (gated, verified-only release)',
    description: 'Writes the patient\'s "before your visit" note for a booked polyclinic appointment; fasting only when a booked service needs it.',
    loadSql: `select app.fn_ctx_clinic_appointment($1::uuid, $2::uuid, 'prep') as c`,
    loadParams: `[ $json.resource_id, $json.event_id ]`,
    promptName: 'clinic_prep',
    draftPurpose: 'body_en and body_ar are the note a patient reads before a booked polyclinic appointment (APPOINTMENT in FACTS): what to bring, arriving early, and fasting only when PREPARATION.fasting_required is true. The app shows the date and time above the note, so the note need not mention them.',
    schema: SCHEMAS.bilingual,
    verify: true,
    requireVerified: true,
    task: 'Write the note the patient reads before the APPOINTMENT, following your rules.',
    sections: `[['APPOINTMENT', { specialty: c.specialty, doctor: c.doctor && { full_name: c.doctor.full_name, full_name_ar: c.doctor.full_name_ar } }],
  ['REQUEST', { message: c.triage && c.triage.message, chief_complaint: c.triage && c.triage.cc }], ['PREPARATION', { fasting_required: c.fasting_required }], ['POLICY', c.policy]]`,
    buildActions: `${WHEN_JS}
const w = cairo(c.starts_at);
const sp = c.specialty || {}, doc = c.doctor || {};
const fastEn = c.fasting_required ? ' Please do not eat for 8-10 hours before the visit (water is fine); if you take diabetes medicines or insulin, ask the clinic how to take them that morning.' : '';
const fastAr = c.fasting_required ? ' من فضلك لا تأكل لمدة 8-10 ساعات قبل الزيارة (الماء مسموح)، وإذا كنت تتناول أدوية السكر أو الإنسولين فاسأل العيادة عن طريقة تناولها في ذلك الصباح.' : '';
const fbEn = 'Your ' + (sp.name || 'clinic') + ' visit with ' + (doc.full_name || 'your doctor') + ': please arrive 10 minutes early with your ID, your current medicines (or their boxes) and any earlier reports or scans.' + fastEn + ' If your symptoms get much worse before the visit, call 123.';
const fbAr = 'زيارتك لعيادة ' + (sp.name_ar || sp.name || 'العيادة') + ' مع ' + (doc.full_name_ar || doc.full_name || 'طبيبك') + ': من فضلك احضر قبل الموعد بعشر دقائق ومعك بطاقة الهوية وأدويتك الحالية (أو علبها) وأي تقارير أو أشعة سابقة.' + fastAr + ' إذا ساءت الأعراض كثيرًا قبل الزيارة فاتصل بـ 123.';
// The fasting rule is checked, not trusted: a note must say "fast" exactly when a booked service needs it.
const saysFast = (t) => /\\bfast(ing)?\\b|do not eat|don't eat/i.test(t);
const saysFastAr = (t) => /صائم|صيام|تصوم|لا تأكل|الامتناع عن الأكل/.test(t);
const fastingWrong = o ? (c.fasting_required ? !(saysFast(o.body_en) && saysFastAr(o.body_ar)) : (saysFast(o.body_en) || saysFastAr(o.body_ar))) : false;
const violations = o ? doseViolations(o.body_en + ' ' + o.body_ar, c.dose_guard, []) : [];
const ok = o && !fastingWrong && !violations.length;
const en = ok ? o.body_en : fbEn, arText = ok ? o.body_ar : fbAr;
const base = { type: 'clinic_prep', patient_id: c.patient_id, appointment_id: c.appointment_id, ai_run_id: c.ai_run_id, trigger: 'clinic_prep' };
const action = { ...base, body_en: w.en + '. ' + en, body_ar: w.ar + '. ' + arText };
const fallback = { ...base, body_en: w.en + '. ' + fbEn, body_ar: w.ar + '. ' + fbAr };
const meta = { ai_run_id: c.ai_run_id, status: ok ? 'COMPLETED' : 'FALLBACK', output: o || null, guard: { dose_violations: violations, fasting_wrong: fastingWrong, used_ai: !!ok },
  draft: { body_en: en, body_ar: arText, fasting_required: c.fasting_required } };
return [{ json: { action, fallback_action: fallback, meta } }];`,
  });
}

export function clinicBrief() {
  return explainer({
    id: WF.clinicBrief,
    name: 'WF-042 · Clinic pre-visit brief (gated, verified)',
    description: 'Writes the one-page SOAP brief the specialist reads before the visit, from the request, the triage and the patient record.',
    loadSql: `select app.fn_ctx_clinic_appointment($1::uuid, $2::uuid, 'brief') as c`,
    loadParams: `[ $json.resource_id, $json.event_id ]`,
    promptName: 'clinic_brief',
    schema: SCHEMAS.clinic_brief,
    verify: true,
    temperature: 0.2,
    task: 'Prepare the specialist\'s brief from REQUEST and RECORD, following your rules.',
    sections: `[['REQUEST', c.triage], ['APPOINTMENT', { specialty: c.specialty }], ['RECORD', c.record], ['POLICY', c.policy]]`,
    buildActions: `
const r = c.record || {}, tr = c.triage || {};
const list = (x) => (x && x.length ? x.join(', ') : 'not recorded');
const fixed = { cc: tr.cc || String(tr.message || '').slice(0, 160), s: tr.soap && tr.soap.s ? tr.soap.s : String(tr.message || '').slice(0, 400),
  o: 'Age ' + (r.age ?? 'not recorded') + ', ' + (r.sex || 'sex not recorded') + (r.diabetes_type && r.diabetes_type !== 'none' ? ', diabetes (' + r.diabetes_type + ')' : '')
    + '. Conditions: ' + list(r.conditions) + '. Medicines: ' + list(r.medicines) + '. Allergies: ' + list(r.allergies) + '.',
  a: (tr.red_flags || []).length ? 'Red flags reported: ' + tr.red_flags.join(', ') + '.' : 'Assess the presenting complaint.', p: 'Examination as indicated.' };
const violations = o ? doseViolations([o.s, o.o, o.a, o.p].join(' '), c.dose_guard, (r.medicines || [])) : [];
const ok = o && !violations.length;
const brief = ok ? { cc: o.cc, s: o.s, o: o.o, a: o.a, p: o.p } : fixed;
const flags = ok ? (o.lab_flags || []).slice(0, 12) : [];
const base = { type: 'clinic_brief', patient_id: c.patient_id, appointment_id: c.appointment_id, ai_run_id: c.ai_run_id, trigger: 'clinic_brief' };
const meta = { ai_run_id: c.ai_run_id, status: ok ? 'COMPLETED' : 'FALLBACK', output: o || null, guard: { dose_violations: violations, used_ai: !!ok }, draft: { ...brief, lab_flags: flags } };
return [{ json: { action: { ...base, brief, lab_flags: flags, release: ok ? 'model' : 'fixed_text' }, fallback_action: { ...base, brief: fixed, lab_flags: [], release: 'fixed_text' }, meta } }];`,
  });
}

export function clinicRx() {
  return explainer({
    id: WF.clinicRx,
    name: 'WF-043 · Clinic prescription in plain Arabic (number check, verified-only release)',
    description: 'Rewrites the signed prescription in plain Arabic for the patient; any number that differs from the doctor\'s text sends the doctor\'s exact words instead.',
    loadSql: `select app.fn_ctx_clinic_visit($1::uuid, $2::uuid, 'rx') as c`,
    loadParams: `[ $json.resource_id, $json.event_id ]`,
    promptName: 'clinic_rx',
    langSkip: ['rx_ar'],
    draftPurpose: 'doctor_prescription is the signed prescription the doctor wrote (in FACTS as VISIT.prescription). rx_ar is that same list rewritten in plain Arabic for the patient: it should contain the medicines, doses, frequencies and durations, with no number added or changed. Medicine names and units (mg, g, ml) stay in Latin letters exactly as the doctor wrote them (Egyptian prescriptions and medicine boxes use them): that is correct Arabic output, not a language error; only the instructions must be Arabic. summary_en and summary_ar summarize the visit (diagnosis, how to take the medicines, follow-up, referral, services) and must say the same thing. VISIT.services are billed clinic services (for example "Joint injection" is a procedure, not a prompt injection); VISIT.referral is the booked internal referral; dates are given relative to today.',
    schema: SCHEMAS.clinic_rx,
    verify: true,
    requireVerified: true,
    temperature: 0.1,
    task: 'Rewrite the signed prescription in VISIT for the patient, following your rules.',
    sections: `[['VISIT', { specialty: c.specialty, doctor: c.doctor && c.doctor.full_name, diagnosis: c.diagnosis, prescription: c.prescription, follow_up_date: c.follow_up_date,
  referral: c.referral && { specialty: c.referral.specialty, starts_at: c.referral.starts_at }, services: (c.services || []).map(s => s.name) }], ['POLICY', c.policy]]`,
    buildActions: `${NUMS_JS}${WHEN_JS}
const rx = String(c.prescription || '');
const sp = c.specialty || {}, doc = c.doctor || {};
const ref = c.referral && c.referral.specialty ? c.referral : null;
const refEn = ref ? ' Referral: ' + ref.specialty.name + (ref.starts_at ? ', ' + cairo(ref.starts_at).en : '') + '.' : '';
const refAr = ref ? ' تحويل: ' + (ref.specialty.name_ar || ref.specialty.name) + (ref.starts_at ? '، ' + cairo(ref.starts_at).ar : '') + '.' : '';
const fuEn = c.follow_up_date ? ' Follow-up: ' + c.follow_up_date + '.' : '', fuAr = c.follow_up_date ? ' موعد المتابعة: ' + c.follow_up_date + '.' : '';
// The doctor's exact words, with fixed framing (used when the rewrite is not allowed, unavailable or fails a check).
const fbEn = 'Your visit with ' + (doc.full_name || 'the doctor') + ' (' + (sp.name || 'clinic') + '). Diagnosis: ' + (c.diagnosis || '-') + '. Prescription, as written by your doctor: ' + (rx || '-') + '.' + fuEn + refEn + ' Contact the clinic if a medicine causes side effects or you feel worse; for severe symptoms call 123.';
const fbAr = 'زيارتك مع ' + (doc.full_name_ar || doc.full_name || 'الطبيب') + ' (' + (sp.name_ar || sp.name || 'العيادة') + '). التشخيص: ' + (c.diagnosis || '-') + '. الروشتة كما كتبها طبيبك: ' + (rx || '-') + '.' + fuAr + refAr + ' تواصل مع العيادة إذا سبب لك أي دواء أعراضًا جانبية أو شعرت بسوء؛ وفي الأعراض الشديدة اتصل بـ 123.';
// Every number of the prescription, and no other, must be in the Arabic list; the summaries may add only the dates.
// The medicine list must be Arabic output whatever language the doctor wrote in (Egyptian prescriptions are mostly
// English): the doctor's own Latin words (drug names) and units are kept as written and left out of the count; the
// rest must be Arabic, and an unchanged copy of the doctor's text is not a rewrite.
// Instruction words always count as untranslated, so "twice daily after food" left in English is caught.
const RX_WORDS = new Set(('a an and as at after before bedtime breakfast by capsule capsules cap caps daily day days dinner drop drops during each '
  + 'every food for gargle hour hours if in lunch meal meals month months morning needed night noon of on once one or pain per puff puffs '
  + 'tablet tablets tab tabs take the then three thrice times to twice two until use week weeks when while with apply spray rinse '
  + 'bid tid qid od prn stat hs ac pc').split(' '));
const latinOfRx = new Set((rx.match(/[A-Za-z][A-Za-z.-]*/g) || []).map(w => w.toLowerCase()).filter(w => !RX_WORDS.has(w)));
const rxRest = o ? String(o.rx_ar || '').replace(/[A-Za-z][A-Za-z.-]*/g, w => (latinOfRx.has(w.toLowerCase()) || /^(mg|g|ml|mcg|iu|tab|tabs|cap|caps)$/i.test(w) ? ' ' : w)) : '';
const rxShare = (() => { const l = rxRest.match(/\\p{L}/gu) || []; return l.length ? l.filter(ch => /[\\u0600-\\u06FF]/.test(ch)).length / l.length : 0; })();
const rxArabic = !!o && rxShare >= 0.8 && String(o.rx_ar).trim() !== rx.trim();
const rxNumbers = !!o && sameNumbers(o.rx_ar, rx);
const rxOk = rxArabic && rxNumbers;
// The summaries may use the dates as the model was shown them (relative: "in 14 days"), so their numbers are checked
// against those facts; the medicine list above must match the doctor's text exactly.
const allowedNums = numsOf(rx + ' ' + G.facts + ' ' + (c.follow_up_date || '') + (ref && ref.starts_at ? ' ' + cairo(ref.starts_at).en : '')).concat(['123']);
const extraEn = o ? numsOf(o.summary_en).filter(n => !allowedNums.includes(n)) : [];
const extraAr = o ? numsOf(o.summary_ar).filter(n => !allowedNums.includes(n)) : [];
const violations = o ? doseViolations(o.summary_en + ' ' + o.summary_ar + ' ' + o.rx_ar, c.dose_guard, [rx]) : [];
const ok = rxOk && !extraEn.length && !extraAr.length && !violations.length;
const base = { type: 'clinic_rx', patient_id: c.patient_id, visit_id: c.visit_id, ai_run_id: c.ai_run_id, trigger: 'clinic_rx', title_en: 'Your visit summary: ' + (sp.name || 'clinic'), title_ar: 'ملخص زيارتك: ' + (sp.name_ar || sp.name || 'العيادة') };
const fallback = { ...base, rx_ar: rx, rx_check: 'doctor_text', body_en: fbEn, body_ar: fbAr };
const action = ok ? { ...base, rx_ar: o.rx_ar, rx_check: 'numbers_match', body_en: o.summary_en + fuEn + refEn, body_ar: o.summary_ar + '\\n' + o.rx_ar + fuAr + refAr } : fallback;
const meta = { ai_run_id: c.ai_run_id, status: ok ? 'COMPLETED' : 'FALLBACK', output: o || null,
  guard: { used_ai: !!ok, numbers_match: rxNumbers, rx_arabic: rxArabic, rx_arabic_share: Math.round(rxShare * 100) / 100, extra_numbers: extraEn.concat(extraAr), dose_violations: violations },
  draft: ok ? { rx_ar: o.rx_ar, summary_en: o.summary_en, summary_ar: o.summary_ar, doctor_prescription: rx } : null };
return [{ json: { action, fallback_action: fallback, meta } }];`,
  });
}

export function clinicHints() {
  return explainer({
    id: WF.clinicHints,
    name: 'WF-044 · Clinic doctor hints (gated, doctor-only drafts)',
    description: 'Ideas the doctor may consider (diagnoses, tests, treatment classes, interactions); shown only to the doctor, marked as AI drafts, never sent to the patient.',
    loadSql: `select app.fn_ctx_clinic_visit($1::uuid, $2::uuid, 'hints') as c`,
    loadParams: `[ $json.resource_id, $json.event_id ]`,
    promptName: 'clinic_hints',
    retryOnNoAnswer: false,   // the doctor is waiting on screen: "unavailable" at once, and they can ask again
    schema: SCHEMAS.clinic_hints,
    temperature: 0.2,
    task: 'List what the doctor may consider at this VISIT, following your rules.',
    sections: `[['VISIT', { specialty: c.specialty, complaint: c.facts && c.facts.complaint, draft_diagnosis: c.diagnosis, draft_prescription: c.prescription }], ['RECORD', c.facts]]`,
    buildActions: `
const kinds = ['consider_diagnosis', 'consider_test', 'consider_treatment', 'red_flag', 'interaction'];
// No doses even for the doctor: a hint with a dose or an instruction to change one is dropped.
const items = o ? (o.items || []).filter(i => i && kinds.includes(i.kind) && String(i.text || '').length > 2)
  .filter(i => !doseViolations(i.text + ' ' + (i.why || ''), c.dose_guard, [c.prescription || '']).length).slice(0, 5)
  .map(i => ({ kind: i.kind, text: String(i.text).slice(0, 200), why: String(i.why || '').slice(0, 300) })) : [];
const base = { type: 'clinic_hints', patient_id: c.patient_id, visit_id: c.visit_id, ai_run_id: c.ai_run_id, trigger: 'clinic_hints' };
const action = o ? { ...base, status: 'ready', items, note: o.note ? String(o.note).slice(0, 300) : null } : { ...base, status: 'unavailable', items: [], note: 'AI hints are not available right now. Ask again in a minute.' };
const meta = { ai_run_id: c.ai_run_id, status: o ? 'COMPLETED' : 'FALLBACK', output: o || null, guard: { used_ai: !!o, dropped: o ? (o.items || []).length - items.length : 0 } };
return [{ json: { action, fallback_action: { ...base, status: 'unavailable', items: [] }, meta } }];`,
  });
}

export const clinicSections = () => [clinicTriage(), clinicPrep(), clinicBrief(), clinicRx(), clinicHints()];
