/* 36 · Nurse approval of Companion answers ("AI drafts, a clinician decides").
 *
 * A model answer that carries a higher-risk signal (a medicine named, a symptom described, MedGemma consulted, a
 * reassuring answer to a symptom) is held for a person to approve when the patient has a care team. The patient gets an
 * immediate holding reply ("your question was sent to your care team"), never silence; the draft goes to the review
 * queue. Emergencies, dose refusals and blocked messages are fixed replies and are never held.
 *
 *   fn_review_hold(...)          called by api_companion_store: holds the draft or returns null.
 *   api_ai_reviews(c, d)         the clinician's queue (pending first, overdue marked).
 *   api_ai_review_decide(c, d)   approve (the draft is shown), edit (the clinician's text is shown) or reject (a short
 *                                note or "your care team will contact you" is shown). The patient is notified.
 *   fn_run_review_escalations()  part of the reminders job: a review not decided within review_hours becomes a high
 *                                inbox item.
 * Settings: rule companion_review (enabled, hold_signals, review_hours).
 */

const _R36 = { enabled: true, hold_signals: ['medicine_named', 'symptom_described', 'medgemma_consulted', 'reassurance'], review_hours: 4 };
const _R36_HOLD = {
  en: 'Your question has been sent to your care team. A nurse will check the answer before you see it, usually within {h} hours. If you feel unwell now, use Need Care or call 123.',
  ar: 'سؤالك اتبعت لفريق الرعاية. ممرض/ة هيراجع الإجابة قبل ما توصلك، غالبًا خلال {h} ساعات. لو حاسس إنك تعبان دلوقتي استخدم "أحتاج رعاية" أو اتصل بـ 123.',
};

function _r36_cfg() { return { ..._R36, ...(coalesce(fn_rule('companion_review'), {})) }; }

/** Holds a Companion model answer for review, or returns null. p_reply is what the agent produced. */
function fn_review_hold(p_patient_id, p_message_id, p_conversation_id, p_run_id, p_question, p_reply, p_guard, p_status) {
  const cfg = _r36_cfg();
  if (!cfg.enabled || p_status !== 'COMPLETED' || !p_reply || p_reply.source !== 'model' || p_reply.emergency || p_reply.urgent || p_reply.blocked) return null;
  if (p_guard && (p_guard.dose_change_request || (Array.isArray(p_guard.dose_violations) && p_guard.dose_violations.length))) return null;
  const risk = p_guard && Array.isArray(p_guard.risk) ? p_guard.risk : [];
  const signals = risk.filter((x) => (cfg.hold_signals || []).includes(x));
  if (!signals.length) return null;
  if (!dbExists('care_team', (ct) => ct.patient_id === p_patient_id && ct.active === true)) return null;
  const h = coalesce(castInt(cfg.review_hours), 4);
  const row = dbInsert('ai_reviews', {
    ai_run_id: castUuid(p_run_id), message_id: p_message_id, conversation_id: castUuid(p_conversation_id), patient_id: p_patient_id,
    question: left(p_question, 1000), draft: String(p_reply.content || ''), draft_meta: omit(p_reply, 'content'), signals,
    due_at: iso(nowMs() + h * HOUR),
  });
  fn_create_inbox_item(p_patient_id, 'ai_review', 'medium', 3, 'AI answer waiting for approval',
    `Signals: ${signals.join(', ')}. Approve, edit or reject the Companion's draft within ${h} hours.`,
    { type: 'ai_review', review_id: row.id, ai_run_id: p_run_id }, `ai-review:${row.id}`);
  const ar = p_reply.language === 'ar';
  return { review_id: row.id, content: (ar ? _R36_HOLD.ar : _R36_HOLD.en).split('{h}').join(String(h)), signals, due_at: row.due_at };
}

function _r36_json(r) {
  const p = dbGet('patients', r.patient_id);
  return { id: r.id, patient_id: r.patient_id, patient_name: p ? p.full_name : null, patient_name_ar: p ? p.full_name_ar : null, mrn: p ? p.mrn : null,
    question: r.question, draft: r.draft, citations: (r.draft_meta && r.draft_meta.citations) || [], signals: r.signals, status: r.status,
    final_content: r.final_content, note: r.note, created_at: r.created_at, due_at: r.due_at, decided_at: r.decided_at,
    overdue: r.status === 'pending' && t(r.due_at) < nowMs() };
}

function api_ai_reviews(c, d) {
  const role = jtext(c && c.role);
  if (!['doctor', 'nurse', 'clinic_admin'].includes(role)) fn_raise('forbidden: Only the care team can see this.');
  const pid = d && d.patient_id ? castUuid(jtext(d.patient_id)) : null;
  const rows = dbWhere('ai_reviews', (r) => (pid === null || r.patient_id === pid) && fn_can_access_patient(c, r.patient_id)
    && (r.status === 'pending' || t(r.created_at) > nowMs() - 14 * DAY));
  return orderBy(rows, [(r) => (r.status === 'pending' ? 0 : 1)], [(r) => t(r.due_at)]).slice(0, 100).map(_r36_json);
}

function api_ai_review_decide(c, d) {
  const role = jtext(c && c.role);
  if (!['doctor', 'nurse'].includes(role)) fn_raise('forbidden: Only a doctor or nurse can approve an answer.');
  const r = dbGet('ai_reviews', castUuid(jtext(d && d.review_id)));
  if (!r || !fn_can_access_patient(c, r.patient_id)) fn_raise('not_found: review not found');
  if (r.status !== 'pending') fn_raise('conflict: this answer was already reviewed');
  const decision = String((d && d.decision) || '');
  if (!['approve', 'edit', 'reject'].includes(decision)) fn_raise('bad_request: decision must be approve, edit or reject');
  const note = String((d && d.note) || '').trim().slice(0, 1000) || null;
  const ar = r.draft_meta && r.draft_meta.language === 'ar';
  let final;
  if (decision === 'approve') final = r.draft;
  else if (decision === 'edit') {
    final = String((d && d.content) || '').trim().slice(0, 2000);
    if (final.length < 5) fn_raise('bad_request: write the answer the patient will see');
  } else {
    final = note ? (ar ? `رد فريق الرعاية: ${note}` : `Your care team replied: ${note}`)
      : (ar ? 'فريق الرعاية هيتواصل معاك بخصوص سؤالك.' : 'Your care team will contact you about this question.');
  }
  const status = decision === 'approve' ? 'approved' : decision === 'edit' ? 'edited' : 'rejected';
  dbUpdate('ai_reviews', r, { status, final_content: final, note, decided_at: now(), decided_by: castUuid(jtext(c.user_id)) });
  const msg = dbGet('messages', r.message_id);
  if (msg) {
    const meta = { ...(msg.meta && typeof msg.meta === 'object' ? msg.meta : {}), held: false, reviewed: status, reviewed_by_role: role };
    if (decision !== 'approve') meta.citations = decision === 'edit' ? (meta.citations || []) : [];
    dbUpdate('messages', msg, { content: final, meta });
  }
  dbUpdateWhere('inbox_items', (i) => i.dedupe_key === `ai-review:${r.id}` || i.dedupe_key === `ai-review-overdue:${r.id}`, { status: 'RESOLVED', resolved_by: castUuid(jtext(c.user_id)), updated_at: now() });
  fn_notify_patient(r.patient_id, 'companion_reviewed', 'Your care team answered your question', 'Open the AI helper to read it.',
    `companion-reviewed:${r.id}`, 'فريق الرعاية رد على سؤالك', 'افتح المساعد الذكي لقراءة الرد.');
  fn_audit(c, `ai_review.${status}`, 'ai_review', r.id, r.patient_id);
  return _r36_json(r);
}

function fn_run_review_escalations() {
  let n = 0;
  for (const r of dbWhere('ai_reviews', (x) => x.status === 'pending' && x.escalated_at === null && t(x.due_at) < nowMs())) {
    fn_create_inbox_item(r.patient_id, 'ai_review', 'high', 2, 'Overdue: AI answer still waiting for approval',
      'A patient is waiting for an answer that needs a nurse to approve it. Please review it now.', { type: 'ai_review', review_id: r.id }, `ai-review-overdue:${r.id}`);
    dbUpdate('ai_reviews', r, { escalated_at: now() });
    n++;
  }
  return { review_escalations: n };
}
