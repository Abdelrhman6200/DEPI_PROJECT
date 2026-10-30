// 018 Optional email delivery: self-service password reset and invitation codes by email
// (port of database/migrations/018_fn_email.sql).
// The API only queues an event; workflow WF-023 builds the message here (creating the one-time token at send time,
// so no token is ever stored in the event queue) and sends it through SMTP.

/** d ->> 'key' (null for a missing field or a value that is not an object). */
function _m18_text(v, key) {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || !Object.prototype.hasOwnProperty.call(v, key)) return null;
  return jtext(v[key] === undefined ? null : v[key]);
}
/** lower(trim(coalesce(x, ''))) with the trim() of Postgres (spaces only). */
function _m18_clean(s) { return trimChars(String(coalesce(s, '')), ' ').toLowerCase(); }
/** rtrim(s, chars) */
function _m18_rtrim(s, chars) {
  if (s === null || s === undefined) return null;
  const a = Array.from(String(s));
  let j = a.length;
  while (j > 0 && chars.includes(a[j - 1])) j--;
  return a.slice(0, j).join('');
}

function fn_email_enabled() {
  const f = dbGet('feature_flags', 'email_delivery');
  return coalesce(f ? f.enabled : null, false);
}

// Public. Always answers the same way, so it cannot be used to find out who has an account.
function api_forgot_password(d) {
  const email = _m18_clean(_m18_text(d, 'email'));
  if (!fn_email_enabled()) {
    return { ok: true, email_enabled: false };
  }
  const key = 'reset:' + md5(email);
  if (fn_throttled(key, 3, HOUR)) {
    return { ok: true, email_enabled: true };
  }
  dbInsert('auth_events', { key });
  const u = dbOne('users', (r) => r.email !== null && r.email.toLowerCase() === email && r.active === true && r.deleted_at === null);
  if (u) {
    fn_emit('PasswordResetRequested', null, u.id, {});
    dbInsert('audit_logs', { actor_id: u.id, actor_role: u.role, action: 'auth.reset_requested', entity: 'user', entity_id: u.id });
  }
  return { ok: true, email_enabled: true };
}

// Public. Sets a new password with the token from the email.
function api_reset_with_token(d) {
  const tok = dbGet('password_reset_tokens', sha256(coalesce(_m18_text(d, 'token'), '')));
  if (!tok || tok.used_at !== null || (tok.expires_at !== null && t(tok.expires_at) < t(now()))) {
    return fn_err('bad_request', 'This reset link is not valid or has expired. Ask for a new one.');
  }
  if (!fn_password_ok(_m18_text(d, 'new_password'))) {
    fn_raise('bad_request: The new password needs at least 8 characters, including letters and numbers.');
  }
  const u = dbGet('users', tok.user_id);
  if (u) dbUpdate('users', u, { password_hash: fn_hash_password(_m18_text(d, 'new_password')), must_change_password: false });
  dbUpdateWhere('password_reset_tokens', (r) => r.user_id === tok.user_id && r.used_at === null, { used_at: now() });
  dbUpdateWhere('sessions', (s) => s.user_id === tok.user_id, { revoked: true });
  dbInsert('audit_logs', { actor_id: tok.user_id, action: 'auth.reset_with_email', entity: 'user', entity_id: tok.user_id });
  return { ok: true };
}

// The patient sends a new invitation code to a family member's email address.
function api_email_invite(c, d) {
  const pid = castUuid(_m18_text(c, 'patient_id'));
  const to = _m18_clean(_m18_text(d, 'email'));
  fn_require_role(c, ['patient']);
  if (!fn_email_enabled()) fn_raise('bad_request: Email is not set up on this service.');
  if (!reTest(to, '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')) fn_raise('bad_request: Please enter a valid email address.');
  const code = trimChars(String(coalesce(_m18_text(d, 'code'), '')), ' ').toUpperCase();
  const nowT = t(now());
  const i = dbOne('caregiver_invites', (r) => pid !== null && r.patient_id === pid && r.code === code && r.revoked === false
    && r.used_at === null && r.expires_at !== null && t(r.expires_at) > nowT);
  if (!i) fn_raise('not_found: invitation not found');
  if (fn_throttled('invite-mail:' + pid, 5, DAY)) {
    return fn_err('too_many_requests', 'You have sent 5 invitations today. Please try again tomorrow.');
  }
  dbInsert('auth_events', { key: 'invite-mail:' + pid });
  fn_emit('CaregiverInviteEmailRequested', pid, i.code, { to });
  fn_audit(c, 'caregiver.invite_email', 'caregiver_invite', left(i.code, 2) + '******', pid);
  return { ok: true };
}

// Builds one email for an event. Returns {to, subject, text} or {skip: reason}.
function fn_build_email(p_event, p_app_url) {
  const type = _m18_text(p_event, 'event_type');
  const url = _m18_rtrim(coalesce(nullif(p_app_url, ''), 'http://localhost:3000'), '/');
  if (!fn_email_enabled()) return { skip: 'email_disabled' };
  if (type === 'PasswordResetRequested') {
    const u = dbGet('users', castUuid(_m18_text(p_event, 'resource_id')));
    if (!u || u.active !== true) return { skip: 'no_user' };
    const token = randomHex(32);
    dbInsert('password_reset_tokens', { token_hash: sha256(token), user_id: u.id });
    return {
      to: u.email,
      subject: u.locale === 'ar' ? 'إعادة تعيين كلمة المرور' : 'Reset your password',
      text: u.locale === 'ar'
        ? 'مرحبًا ' + u.full_name + ',\n\nلإعادة تعيين كلمة المرور افتح هذا الرابط خلال ساعة:\n' + url + '/reset-password?token=' + token
          + '\n\nإذا لم تطلب ذلك فتجاهل هذه الرسالة؛ كلمة مرورك لم تتغير.'
        : 'Hello ' + u.full_name + ',\n\nTo reset your password, open this link within one hour:\n' + url + '/reset-password?token=' + token
          + '\n\nIf you did not ask for this, ignore this email; your password has not changed.',
    };
  } else if (type === 'CaregiverInviteEmailRequested') {
    const code = _m18_text(p_event, 'resource_id');
    const i = code === null ? null : dbGet('caregiver_invites', code);
    if (!i || i.revoked !== false || i.used_at !== null || i.expires_at === null || !(t(i.expires_at) > t(now()))) return { skip: 'invite_gone' };
    const p = dbGet('patients', i.patient_id);
    const patient = p ? coalesce(p.full_name, '') : null;          // no patient row: the text is NULL, as in SQL
    const payload = p_event.payload;
    return {
      to: payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? _m18_text(payload, 'to') : null,
      subject: 'Your invitation code / رمز الدعوة الخاص بك',
      text: patient === null ? null
        : patient + ' would like you to help follow their diabetes care.\n\nYour invitation code: ' + i.code
          + '\nSign up here: ' + url + '/register?invite=' + i.code + '\nThe code works once and expires on ' + localDate(i.expires_at) + '.\n\n'
          + patient + ' يدعوك للمساعدة في متابعة رعاية السكر.\nرمز الدعوة: ' + i.code + '\nسجّل من هنا: ' + url + '/register?invite=' + i.code,
    };
  } else if (type === 'WeeklyDigestEmail') {
    // Only a pointer to the app: health values do not travel by email.
    const u = dbGet('users', castUuid(_m18_text(p_event, 'resource_id')));
    if (!u || u.active !== true || !u.email) return { skip: 'no_user' };
    return {
      to: u.email,
      subject: u.locale === 'ar' ? 'ملخص أسبوعك جاهز' : 'Your weekly summary is ready',
      text: u.locale === 'ar'
        ? 'مرحبًا ' + u.full_name + ',\n\nملخص الأسبوع ده وهدف الأسبوع الجاي جاهزين في التطبيق:\n' + url + '/app'
        : 'Hello ' + u.full_name + ',\n\nYour summary of this week and a goal for next week are ready in the app:\n' + url + '/app',
    };
  } else if (type === 'AccountSecurityNotice') {
    const u = dbGet('users', castUuid(_m18_text(p_event, 'resource_id')));
    if (!u || u.active !== true) return { skip: 'no_user' };
    return {
      to: u.email,
      subject: u.locale === 'ar' ? 'تنبيه أمان لحسابك' : 'Security notice for your account',
      text: u.locale === 'ar'
        ? 'مرحبًا ' + u.full_name + ',\n\nقام أحد المسؤولين بتعيين كلمة مرور مؤقتة لحسابك.\n'
          + 'ستحتاج إلى اختيار كلمة مرور جديدة عند تسجيل الدخول. إذا لم تطلب ذلك فأبلغ عيادتك فورًا.'
        : 'Hello ' + u.full_name + ',\n\nAn administrator set a temporary password for your account.\n'
          + 'You will choose a new password when you next sign in. If you did not ask for this, tell your clinic straight away.',
    };
  }
  return { skip: 'unknown_event' };
}
