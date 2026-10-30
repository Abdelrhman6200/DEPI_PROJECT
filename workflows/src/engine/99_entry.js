// Entry points of the engine for the n8n Code nodes of the platform workflow.
//
//   engine_api(req)    one API request: Auth Gate (fn_gate with the group's route table), then the action
//                      (api_action). Returns the HTTP answer, the Sheets write and what to start next.
//   engine_step(req)   one database step of a workflow section (what a Postgres node did): runs a JavaScript
//                      expression over the engine functions with the step's arguments, returns its rows and the write.
//
// Both open the request's data from the Sheets values:batchGet answer of exactly the tabs the build listed for them.

/** The tab name of a range as Sheets returns it ("users!A1:P23", "'my tab'!A1:B2"). */
function _e_tabOf(range) { const r = String(range || ''); const i = r.lastIndexOf('!'); const t = i < 0 ? r : r.slice(0, i); return t.startsWith("'") ? t.slice(1, -1).replace(/''/g, "'") : t; }

/** Opens the data of a request from a Sheets values:batchGet answer (tab names from the answer, or from ranges). */
function dbOpenBatch(batch, ranges, opts = {}) {
  const sheets = {};
  const sheetIds = {};
  ((batch && batch.valueRanges) || []).forEach((vr, i) => {
    const name = vr.range ? _e_tabOf(vr.range) : ranges[i];
    if (name === '_meta') {
      for (const row of (vr.values || []).slice(1)) if (String(row[0]).startsWith('sheet:')) sheetIds[String(row[0]).slice(6)] = Number(row[1]);
    } else {
      if (!vr.values || !vr.values.length || !vr.values[0].length) throw new Error(`engine: the Sheets tab "${name}" has no header row (run scripts/sheets-setup.mjs)`);
      sheets[name] = vr.values;
      // A tab the local store filtered to the caller's patients: rowNumbers gives each data row's place in the sheet.
      if (Array.isArray(vr.rowNumbers)) sheets[name].rowNumbers = vr.rowNumbers;
    }
  });
  // cacheVersions: the Sheets cache's stamp of each tab read; the write's guards send them back (dbWrites).
  return dbOpen({ sheets, sheetIds, now: opts.now, versions: (batch && batch.cacheVersions) || {} });
}

/* ------------------------------------------------------------------------------------------------ API answers */

const _E_STATUS = { unauthorized: 401, forbidden: 403, mfa_required: 403, password_change_required: 403, not_found: 404, unknown_action: 404,
  conflict: 409, too_many_requests: 429, bad_request: 400, unavailable: 503, server_error: 500 };

/**
 * An exception as an API error: only messages raised on purpose by the engine ("bad_request: ...", with the Arabic
 * text after " ¦ ") reach the client; constraint and type errors become fixed sentences, anything else a server error.
 */
function engine_error(raw) {
  raw = String(raw || '');
  const m = raw.match(/(unauthorized|forbidden|not_found|bad_request|conflict):\s*([^\n]*)/);
  if (m) { const p = m[2].split(' ¦ '); return p[1] ? { code: m[1], message: p[0], message_ar: p[1] } : { code: m[1], message: p[0] }; }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|timeout|Quota exceeded|RESOURCE_EXHAUSTED|503|429/i.test(raw)) {
    return { code: 'unavailable', message: 'The service is temporarily unavailable. Please try again in a minute.', message_ar: 'الخدمة غير متاحة مؤقتًا. من فضلك حاول بعد دقيقة.' };
  }
  if (/duplicate key value|violates unique constraint/i.test(raw)) return { code: 'conflict', message: 'This was already saved.', message_ar: 'تم حفظ هذا من قبل.' };
  if (/invalid input syntax|violates check constraint|violates not-null|violates foreign key|out of range|invalid input value|value too long|malformed array|too long to be stored/i.test(raw)) {
    return { code: 'bad_request', message: 'Some of the information sent is not valid. Please check it and try again.', message_ar: 'بعض البيانات المرسلة غير صحيحة. من فضلك راجعها وحاول مرة أخرى.' };
  }
  return { code: 'server_error', message: 'Something went wrong on our side. Please try again.', message_ar: 'حدث خطأ من جهتنا. من فضلك حاول مرة أخرى.' };
}
function _e_answer(body) { return { status: body.ok ? 200 : (_E_STATUS[body.error && body.error.code] || 400), body }; }
/** An action's result as the uniform API answer: {data} or, for a recorded refusal, {__error}. */
function engine_result(data) {
  if (data && typeof data === 'object' && data.__error) return _e_answer({ ok: false, error: data.__error });
  return _e_answer({ ok: true, data: data === undefined ? null : data });
}

/**
 * One API request.
 *   req: { group, action, data, authorization, client, batch, ranges, workflowActions: { 'group.action': sectionId } }
 * Returns { status, body, write, files, call?, kick }:
 *   write  Sheets batchUpdate requests (also when the action failed: the gate's own records, such as sign-in
 *          throttling, are kept, as they were committed before the action in the database)
 *   call   { section, payload } when the action runs in an AI section; the section answers the request
 *   files  files to write on the n8n server first ([{ path, base64 }]: uploaded documents, removed files)
 *   kick   true when the request queued events, so the event dispatcher runs now instead of at its next minute
 *   read   the tabs this run read: when the Sheets cache refuses the write (write.guards failed: another request changed
 *          the same rows or took the same unique key in between), the workflow reads them again and runs the request again
 */
function engine_api(req) {
  try {
    return { ..._e_api(req), read: [...new Set(['_meta', ...dbLoadedTables()])] };
  } catch (e) {
    // The request needs a tab it did not read (a rare path, such as a family member's lookup of a record): read again
    // with that tab and run the request from the start. Nothing was written.
    if (e && e.code === 'ENGINE_MISSING_TABLE') return { retry: true, ranges: [...new Set(['_meta', ...dbLoadedTables(), e.table])] };
    throw e;
  }
}

function _e_api(req) {
  dbOpenBatch(req.batch, req.ranges);
  const routesRow = dbOne('api_routes', (r) => r.grp === req.group);
  const g = fn_gate(req.authorization || '', String(req.action ?? ''), req.data && typeof req.data === 'object' ? req.data : {}, (routesRow && routesRow.routes) || {}, req.client || '');
  if (g.action === '__error') return { ..._e_answer({ ok: false, error: g.error }), write: dbWrites(), files: dbFiles(), kick: false };
  const section = (req.workflowActions || {})[`${req.group}.${g.action}`];
  if (section) return { status: 200, body: null, write: dbWrites(), files: dbFiles(), call: { section, payload: { action: g.action, ctx: g.ctx, data: g.data } }, kick: false };
  const sp = dbSavepoint();
  let answer;
  try {
    answer = engine_result(api_action(req.group, g.action, g.ctx, g.data));
  } catch (e) {
    if (e && e.code === 'ENGINE_MISSING_TABLE') throw e;
    dbRollbackTo(sp);
    answer = _e_answer({ ok: false, error: engine_error(e && e.message) });
  }
  const write = dbWrites();
  return { ...answer, write, files: dbFiles(), kick: _e_queuedEvents() };
}

function _e_queuedEvents() {
  const t = DB.t.outbox;
  return !!(t && t.rows.some((r) => META.get(r).state === 'new'));
}

/**
 * The database step of a workflow section (what one Postgres node did), for every item it received, on one read of
 * the tabs and with one write.
 *   steps: [{ expr, args, mode }]   expr: a JavaScript expression over the engine functions and `a` (the item's
 *          parameters as a JSON array text, in order: the Postgres node's $1, $2 …); mode 'one' (default): one row (an
 *          object); 'rows': an array of rows.
 *   scope: the engine's exports (the expression is compiled outside the engine and sees its functions through it).
 * Returns { rows, write, kick }. An exception fails the whole step, as the Postgres node did.
 */
function engine_steps(steps, batch, ranges, scope) {
  dbOpenBatch(batch, ranges);
  const compiled = new Map();
  const rows = [];
  for (const s of steps) {
    if (!compiled.has(s.expr)) compiled.set(s.expr, new Function('a', 'E', `with (E) { return (${s.expr}); }`));
    const a = typeof s.args === 'string' ? JSON.parse(s.args || '[]') : (Array.isArray(s.args) ? s.args : []);
    const value = compiled.get(s.expr)(a, scope);
    if (s.mode === 'rows') { if (Array.isArray(value)) rows.push(...value); } else if (value !== undefined && value !== null) rows.push(value);
  }
  return { rows, write: dbWrites(), files: dbFiles(), kick: _e_queuedEvents() };
}
