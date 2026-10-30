// 019 Accredited guideline sources: registry, edition watch, fetched editions, review and approval
// (port of database/migrations/019_fn_guidelines.sql).
// The workflows WF-024 / WF-024b fetch and parse; every decision (is this a new edition, what becomes a draft,
// who is told, what an approval changes) is made here.
//
// Notes on the port:
// - Nothing here searches: the module only counts chunks (`embedding is not null`, `quarantined`) and deletes them.
//   Vector and full-text search stay in 012 (fn_rag_search).
// - A fetched section is stored up to 45,000 characters (the SQL kept 60,000): a Google Sheets cell holds 50,000.
// - `now() - make_interval(days => n)` keeps the Cairo wall-clock time (calendar days, as Postgres in Africa/Cairo);
//   `current_date + make_interval(months => n)` clamps to the end of a shorter month, as Postgres does.
// - ORDER BY s.key compares code units (the database used en_US.utf8; the source keys are lower-case ASCII words).

/* ------------------------------------------------------------------------------------------- private helpers */

function _m19_isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
/** jsonb ? 'key' on an object (the key exists, even with a JSON null value). */
function _m19_has(v, key) { return _m19_isObj(v) && Object.prototype.hasOwnProperty.call(v, key) && v[key] !== undefined; }
/** v -> 'key' (null for a missing key or a value that is not an object) */
function _m19_get(v, key) { return _m19_has(v, key) ? v[key] : null; }
/** v ->> 'key' */
function _m19_text(v, key) { return jtext(_m19_get(v, key)); }
/** a || b || ...: NULL when any part is NULL. */
function _m19_cat(...parts) { return parts.some((p) => p === null || p === undefined) ? null : parts.map(String).join(''); }
/** v = any(arr) with SQL NULL semantics: true, false or null. */
function _m19_anyEq(v, arr) {
  if (v === null || v === undefined || !Array.isArray(arr)) return null;
  if (arr.includes(v)) return true;
  return arr.includes(null) ? null : false;
}
/** jsonb_array_length of a value that is not SQL NULL (a JSON null is a scalar). */
function _m19_arrayLength(v) {
  if (Array.isArray(v)) return v.length;
  throw new Error(_m19_isObj(v) ? 'cannot get array length of a non-array' : 'cannot get array length of a scalar');
}
/** jsonb_array_elements of a value that is not SQL NULL. */
function _m19_arrayElements(v) {
  if (Array.isArray(v)) return v;
  throw new Error(_m19_isObj(v) ? 'cannot extract elements from an object' : 'cannot extract elements from a scalar');
}
/** now() - make_interval(days => n): the same Cairo wall-clock time n calendar days earlier. */
function _m19_daysAgo(n) {
  const p = cairoParts(now());
  const d = addDays(`${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`, -n);
  return iso(cairoLocalToMs(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8, 10), p.h, p.mi, p.s, p.ms));
}
/** (date + make_interval(months => n))::date: the day is clamped to the length of the target month. */
function _m19_addMonths(date, n) {
  if (date === null || date === undefined || n === null || n === undefined) return null;
  const [y, m, d] = String(date).slice(0, 10).split('-').map(Number);
  const total = y * 12 + (m - 1) + Number(n);
  const ny = Math.floor(total / 12), nm = total - ny * 12 + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
/** s.last_checked_at is null or s.last_checked_at < now() - make_interval(days => s.check_every_days) */
// Due when never checked, when the check period has passed, or, after a failed check, sooner: 1 hour after the first
// failure, then 2, 4, 8 … hours (a network blip does not delay a new edition by a whole period).
function _m19_unchecked(s) {
  if (s.last_checked_at === null) return true;
  if (s.check_every_days !== null && t(s.last_checked_at) < t(_m19_daysAgo(s.check_every_days))) return true;
  const failures = s.last_status === 'error' ? coalesce(castInt(_m19_text(s.last_detail, 'failures')), 1) : 0;
  return failures > 0 && t(s.last_checked_at) + Math.min(2 ** (failures - 1), 24 * 30) * 3600e3 <= t(now());
}
function _m19_source(key) { return key === null || key === undefined ? null : dbGet('guideline_sources', String(key)); }

/* --------------------------------------------------------------------------------------------------- functions */

// Is edition a newer than edition b? Years compare as numbers; anything else (PMC article versions, ETags,
// content hashes) is newer when it differs.
function fn_edition_newer(a, b) {
  if (a === null || a === undefined) return false;
  if (b === null || b === undefined) return true;
  if (/^\d{4}$/.test(String(a)) && /^\d{4}$/.test(String(b))) return Number(a) > Number(b);
  return String(a) !== String(b);
}

function fn_guideline_source_json(s) {
  const pending = dbWhere('rag_documents', (x) => x.source_key === s.key && x.status === 'draft' && s.pending_version !== null
    && x.source_version === s.pending_version);
  return {
    ...cloneValue(omit(s, 'last_detail')),
    last_error: _m19_text(s.last_detail, 'error'),
    last_found: cloneValue(_m19_get(s.last_detail, 'meta')),
    pending_documents: pending.length,
    pending_flagged: pending.filter((x) => ['block', 'suspicious'].includes(_m19_text(x.screening, 'verdict'))).length,
    approved_documents: dbCount('rag_documents', (x) => x.source_key === s.key && x.status === 'approved'),
    open_updates: jsonAgg(orderBy(dbWhere('guideline_updates', (u) => u.source_key === s.key && u.status === 'open'), [(u) => t(u.detected_at), 'desc'])
      .map((u) => ({ id: u.id, version: u.version, detected_at: u.detected_at, items: cloneValue(u.items) }))) ?? [],
    due: s.active === true && _m19_unchecked(s),
  };
}

// Sources due for a check, longest-unchecked first. Empty while the guideline_sync flag is off.
function fn_guideline_sources_due(p_limit = 5) {
  const flag = dbGet('feature_flags', 'guideline_sync');
  if (coalesce(flag ? flag.enabled : null, false) !== true) return [];
  const limit = greatest(1, least(castInt(coalesce(p_limit, 5)), 20));
  const due = dbWhere('guideline_sources', (s) => s.active === true && _m19_unchecked(s));
  return jsonAgg(orderBy(due, [(s) => t(s.last_checked_at), 'asc', 'nulls first']).slice(0, limit).map((s) => ({ key: s.key }))) ?? [];
}

// What the check workflow needs for one source: the registry entry, the editions it must not report again, the
// validators of the last download (ETag, content hash) and the prompt-injection rule for screening fetched text.
function fn_guideline_source_ctx(p_key) {
  const s = _m19_source(p_key);
  if (!s) return fn_raise('not_found: guideline source not found');
  return {
    ...cloneValue(s),
    known_versions: [s.current_version, s.pending_version].filter((v) => v !== null).concat(s.dismissed_versions || []),
    known_etag: _m19_text(s.last_detail, 'etag'),
    known_sha: _m19_text(s.last_detail, 'sha'),
    injection: fn_rule('prompt_injection'),
  };
}

// In-app notification to every active Safety Officer (deduplicated per officer).
function fn_notify_safety_officers(p_kind, p_title, p_body, p_dedupe) {
  let n = 0;
  for (const u of dbWhere('users', (x) => x.role === 'safety_officer' && x.active === true)) {
    const row = dbInsert('notifications', {
      user_id: u.id, kind: p_kind ?? null, title: left(p_title ?? null, 200), body: left(p_body ?? null, 1000),
      dedupe_key: _m19_cat(p_dedupe, ':', u.id),
    }, { onConflict: 'nothing' });
    if (row) n++;
  }
  return n;
}

// Records the result of one source check (WF-024b). p_result:
//   {status: unchanged | fetched | watch | not_licensed | retracted | error, version, etag, sha, error,
//    meta: {title, short_title, edition, citation, journal, pmid, pmcid, doi, url, license, published},
//    sections: [{title, content, screening}]   (fetched)
//    items: [{pmid, pmcid, doi, title, journal, pubdate, url}]   (watch / not_licensed)}
// A fetched edition becomes draft documents (never searchable before approval); a watched edition becomes an open
// review item. Either way every active Safety Officer is notified once. A retracted edition is withdrawn at once.
function fn_guideline_record(p_key, p_result) {
  const s = _m19_source(p_key);
  if (!s) fn_raise('not_found: guideline source not found');
  const key = String(p_key);
  const r = p_result;
  const status = coalesce(nullif(_m19_text(r, 'status'), ''), 'error');
  const version = nullif(_m19_text(r, 'version'), '');
  const meta = _m19_has(r, 'meta') ? r.meta : {};   // coalesce(p_result->'meta', '{}'): a JSON null stays null
  const metaText = (k) => _m19_text(meta, k);
  // Validators of the last successful download survive checks that do not carry them (e.g. "304 Not Modified").
  const detail = {
    ...(_m19_isObj(s.last_detail) ? omit(cloneValue(s.last_detail), 'error', 'failures') : {}),
    ...stripNulls({
      version, etag: _m19_text(r, 'etag'), sha: _m19_text(r, 'sha'),
      meta: _m19_isObj(meta) && Object.keys(meta).length === 0 ? null : cloneValue(meta), checked_at: now(),
    }),
  };
  const isNew = fn_edition_newer(version, s.current_version) && version !== s.pending_version && _m19_anyEq(version, s.dismissed_versions) === false;

  if (status === 'error') {
    dbUpdate('guideline_sources', s, {
      last_checked_at: now(), last_status: 'error',
      last_detail: { ...detail, error: left(coalesce(_m19_text(r, 'error'), 'unknown error'), 500),
        failures: (s.last_status === 'error' ? coalesce(castInt(_m19_text(s.last_detail, 'failures')), 1) : 0) + 1 },
    });
    return { key, status: 'error', error: left(_m19_text(r, 'error'), 500) };
  }

  if (status === 'retracted') {
    const docs = dbWhere('rag_documents', (x) => x.source_key === key && version !== null && x.source_version === version
      && (x.status === 'draft' || x.status === 'approved'));
    for (const x of docs) dbUpdate('rag_documents', x, { status: 'retired' });
    const ids = new Set(docs.map((x) => x.id));
    dbDeleteWhere('rag_chunks', (ch) => ids.has(ch.document_id));
    dbUpdate('guideline_sources', s, {
      last_checked_at: now(), last_status: 'retracted', last_detail: detail,
      pending_version: version !== null && s.pending_version === version ? null : s.pending_version,
      current_version: version !== null && s.current_version === version ? null : s.current_version,
    });
    dbInsert('incidents', {
      workflow: 'WF-024 Guideline sources', node: 'Retraction check',
      message: left(`${s.title ?? ''} edition ${version ?? ''} was marked retracted at the source; ${docs.length} document(s) withdrawn from answers.`, 500),
    });
    fn_notify_safety_officers('guideline', _m19_cat('Guideline edition retracted: ', s.title),
      _m19_cat('The source marks edition ', version, ' as retracted. It was withdrawn from AI answers at once. Review the knowledge base.'),
      _m19_cat('guideline-retracted:', key, ':', version));
    dbInsert('audit_logs', { action: 'guideline.retracted', entity: 'guideline_source', entity_id: key, detail: { version, documents: docs.length } });
    return { key, status: 'retracted', version, withdrawn: docs.length };
  }

  if (status === 'fetched' && isNew) {
    // An earlier pending edition that was never approved is replaced by this one.
    dbUpdateWhere('rag_documents', (x) => x.source_key === key && x.status === 'draft', { status: 'retired' });
    let n = 0, flagged = 0;
    for (const sec of _m19_arrayElements(_m19_has(r, 'sections') ? r.sections : [])) {
      const content = _m19_text(sec, 'content');
      if (Array.from(coalesce(content, '')).length < 200) continue;
      if (n >= 80) break;
      const screening = _m19_get(sec, 'screening');
      dbInsert('rag_documents', {
        title: left(coalesce(nullif(metaText('short_title'), ''), s.title) + ' — ' + left(coalesce(nullif(_m19_text(sec, 'title'), ''), 'Text'), 160), 300),
        source: left(s.publisher + coalesce(_m19_cat('. ', nullif(metaText('citation'), '')), ''), 500),
        version: left(coalesce(nullif(metaText('edition'), ''), version), 60),
        language: s.language, region: s.region, population: s.population,
        // A Google Sheets cell holds 50,000 characters (the SQL kept 60,000).
        content: left(content, 45000), status: 'draft', review_date: _m19_addMonths(today(), s.review_months),
        source_key: key, source_version: version,
        source_url: coalesce(nullif(metaText('url'), ''), _m19_text(s.locator, 'page_url'), _m19_text(s.locator, 'url')),
        publisher: s.publisher,
        external_ids: stripNulls({ pmid: metaText('pmid'), pmcid: metaText('pmcid'), doi: metaText('doi') }),
        license: coalesce(nullif(metaText('license'), ''), s.license),
        audience: s.audience, origin: 'fetched', content_sha: sha256(content), screening: cloneValue(screening),
      });
      n++;
      if (['block', 'suspicious'].includes(_m19_text(screening, 'verdict'))) flagged++;
    }
    if (n === 0) {
      dbUpdate('guideline_sources', s, {
        last_checked_at: now(), last_status: 'error', last_detail: { ...detail, error: 'The fetched edition contained no usable text.' },
      });
      return { key, status: 'error', error: 'no usable text' };
    }
    dbUpdate('guideline_sources', s, { last_checked_at: now(), last_status: 'new_edition', pending_version: version, last_detail: detail });
    fn_notify_safety_officers('guideline', _m19_cat('New guideline edition to review: ', s.title),
      _m19_cat(n, ' section(s) of ', coalesce(metaText('citation'), s.publisher), ' were fetched as drafts',
        flagged > 0 ? ` (${flagged} flagged by the prompt-injection screen)` : '',
        '. Check the text and the license, then approve the edition in Administration, Knowledge base.'),
      _m19_cat('guideline-edition:', key, ':', version));
    dbInsert('audit_logs', {
      action: 'guideline.edition_fetched', entity: 'guideline_source', entity_id: key,
      detail: { version, documents: n, flagged, meta: cloneValue(meta) },
    });
    return { key, status: 'new_edition', version, documents: n, flagged };
  }

  if ((status === 'watch' || status === 'not_licensed') && isNew) {
    const items = _m19_has(r, 'items') ? r.items : [];
    // jsonb_array_length of the items (in SQL it fails after the insert, which rolls the call back all the same)
    const count = _m19_arrayLength(items);
    const u = dbInsert('guideline_updates', { source_key: key, version, items: cloneValue(items) }, {
      onConflict: { cols: ['source_key', 'version'], set: (old, row) => ({ items: row.items, status: 'open', detected_at: now() }) },
    });
    dbUpdate('guideline_sources', s, { last_checked_at: now(), last_status: 'watch_update', pending_version: version, last_detail: detail });
    fn_notify_safety_officers('guideline', _m19_cat('New guideline edition published: ', s.title),
      _m19_cat('Edition ', version, ' (', count, ' publication(s))',
        status === 'not_licensed' ? ' is not licensed for automatic import' : ' is watched only',
        '. Update the knowledge-base summaries from it, then mark the edition reviewed.'),
      _m19_cat('guideline-update:', key, ':', version));
    dbInsert('audit_logs', { action: 'guideline.edition_detected', entity: 'guideline_source', entity_id: key, detail: { version, kind: status } });
    return { key, status: 'watch_update', version, update_id: u.id };
  }

  dbUpdate('guideline_sources', s, { last_checked_at: now(), last_status: 'unchanged', last_detail: detail });
  return { key, status: 'unchanged', version: coalesce(version, s.current_version) };
}

// Approves the pending edition of a source as one unit. A fetched edition needs the reviewer to confirm that its
// license allows this use; its drafts become approved and are indexed (WF-019), and the previous edition stays in use
// until every new document is indexed (fn_guideline_switch_over). For a watched edition, approval records that the
// knowledge base was reviewed against it.
function api_guideline_approve(c, d) {
  const uid = castUuid(_m19_text(c, 'user_id'));
  fn_require_role(c, ['safety_officer']);
  const s = _m19_source(_m19_text(d, 'source_key'));
  if (!s) fn_raise('not_found: guideline source not found');
  const version = coalesce(nullif(_m19_text(d, 'version'), ''), s.pending_version);
  if (version === null || version !== s.pending_version) fn_raise('bad_request: There is no pending edition with this version.');
  const drafts = () => dbWhere('rag_documents', (x) => x.source_key === s.key && x.source_version === version && x.status === 'draft');
  let ids = null;
  if (drafts().length) {
    if (!coalesce(castBool(_m19_text(d, 'license_confirmed')), false)) {
      fn_raise('bad_request: Confirm that the license of this guideline allows its use in the knowledge base before approving it.');
    }
    const rows = drafts();
    for (const x of rows) {
      dbUpdate('rag_documents', x, { status: 'approved', approved_by: uid, license_confirmed_by: uid, license_confirmed_at: now(), published_at: today() });
    }
    ids = rows.map((x) => x.id);
    for (const id of ids) fn_emit('RagDocumentApproved', null, id, { source_key: s.key, version });
  }
  dbUpdateWhere('guideline_updates', (u) => u.source_key === s.key && u.version === version && u.status === 'open',
    { status: 'done', resolved_by: uid, resolved_at: now(), note: nullif(_m19_text(d, 'note'), '') });
  dbUpdate('guideline_sources', s, { current_version: version, pending_version: null });
  fn_audit(c, 'guideline.edition_approved', 'guideline_source', s.key, null,
    { version, documents: ids ? ids.length : 0, license_confirmed: ids !== null, note: _m19_text(d, 'note') });
  return fn_guideline_source_json(s);
}

// Rejects the pending edition: its drafts are retired and the edition is never fetched or announced again.
function api_guideline_dismiss(c, d) {
  fn_require_role(c, ['safety_officer']);
  const s = _m19_source(_m19_text(d, 'source_key'));
  if (!s) fn_raise('not_found: guideline source not found');
  const version = coalesce(nullif(_m19_text(d, 'version'), ''), s.pending_version);
  if (version === null || version !== s.pending_version) fn_raise('bad_request: There is no pending edition with this version.');
  const note = _m19_text(d, 'note');
  if (coalesce(note === null ? null : Array.from(trimChars(note, ' ')).length, 0) < 5) {
    fn_raise('bad_request: Give a short reason for rejecting this edition.');
  }
  dbUpdateWhere('rag_documents', (x) => x.source_key === s.key && x.source_version === version && x.status === 'draft', { status: 'retired' });
  dbUpdateWhere('guideline_updates', (u) => u.source_key === s.key && u.version === version && u.status === 'open',
    { status: 'dismissed', resolved_by: castUuid(_m19_text(c, 'user_id')), resolved_at: now(), note });
  dbUpdate('guideline_sources', s, { pending_version: null, dismissed_versions: [...(s.dismissed_versions || []), version] });
  fn_audit(c, 'guideline.edition_dismissed', 'guideline_source', s.key, null, { version, note });
  return fn_guideline_source_json(s);
}

// After a document of an approved edition is indexed: once every approved document of that edition has chunks, the
// earlier approved editions of the same source are retired (zero-downtime switch-over, called by WF-019).
function fn_guideline_switch_over(p_document_id) {
  const id = castUuid(p_document_id);
  const dd = id === null ? null : dbGet('rag_documents', id);
  if (!dd || dd.source_key === null || dd.status !== 'approved') return { switched: false };
  const indexed = (docId) => dbExists('rag_chunks', (ch) => ch.document_id === docId && ch.embedding !== null);
  if (dbExists('rag_documents', (x) => x.source_key === dd.source_key && dd.source_version !== null && x.source_version === dd.source_version
      && x.status === 'approved' && !indexed(x.id))) {
    return { switched: false, waiting: true };
  }
  const old = dbWhere('rag_documents', (x) => x.source_key === dd.source_key && x.status === 'approved' && x.source_version !== dd.source_version);
  for (const x of old) dbUpdate('rag_documents', x, { status: 'retired', superseded_by: id });
  const oldIds = new Set(old.map((x) => x.id));
  dbDeleteWhere('rag_chunks', (ch) => oldIds.has(ch.document_id));
  if (old.length) {
    dbInsert('audit_logs', {
      action: 'guideline.edition_switched', entity: 'guideline_source', entity_id: dd.source_key,
      detail: { version: dd.source_version, retired_documents: old.length },
    });
  }
  return { switched: old.length > 0, retired: old.length };
}

/* ------------------------------------------------------------------------------------------------- Admin views */

function api_guideline_sources(c, d) {
  fn_require_role(c, ['safety_officer', 'clinic_admin', 'platform_admin']);
  return jsonAgg(orderBy(dbRows('guideline_sources'), (s) => s.pending_version === null, (s) => s.key).map((s) => fn_guideline_source_json(s))) ?? [];
}

// A NULL row (no document) gives an object of nulls, as the SQL function does.
function fn_rag_document_json(d) {
  const x = d || {};
  const v = (k) => (x[k] === undefined ? null : x[k]);
  const id = v('id');
  return {
    id, title: v('title'), source: v('source'), version: v('version'), language: v('language'),
    region: v('region'), population: v('population'), status: v('status'), published_at: v('published_at'), review_date: v('review_date'),
    chunks: dbCount('rag_chunks', (ch) => id !== null && ch.document_id === id && ch.embedding !== null),
    quarantined_chunks: dbCount('rag_chunks', (ch) => id !== null && ch.document_id === id && ch.quarantined === true),
    created_at: v('created_at'), origin: v('origin'), audience: v('audience'), publisher: v('publisher'), source_key: v('source_key'),
    source_version: v('source_version'), source_url: v('source_url'), external_ids: cloneValue(v('external_ids')), license: v('license'),
    license_confirmed_at: v('license_confirmed_at'), screening: cloneValue(v('screening')), superseded: v('superseded_by') !== null,
    // who added it: the same person may not approve it (four eyes)
    created_by: v('created_by'), approved_by: v('approved_by'),
  };
}

// Single-document approval is for documents written by the team. A fetched guideline edition is approved as a whole
// (api_guideline_approve), so its sections can never be half-approved and its license is always confirmed.
function api_rag_approve(c, d) {
  fn_require_role(c, ['safety_officer', 'clinic_admin']);
  const id = castUuid(nullif(_m19_text(d, 'document_id'), ''));
  const dd = id === null ? null : dbGet('rag_documents', id);
  if (!dd || dd.status === 'retired') fn_raise('not_found: document not found or retired');
  if (dd.origin === 'fetched') {
    fn_raise('bad_request: This section belongs to a fetched guideline edition. Approve the whole edition under Guideline sources.');
  }
  // Four eyes: patient education is approved by someone other than the person who added it.
  const uid = castUuid(_m19_text(c, 'user_id'));
  if (dd.created_by !== null && dd.created_by === uid) fn_raise('forbidden: A second person must approve a document you added.');
  dbUpdate('rag_documents', dd, { status: 'approved', approved_by: uid, published_at: coalesce(dd.published_at, today()) });
  fn_emit('RagDocumentApproved', null, dd.id, { title: dd.title });
  fn_audit(c, 'rag.document_approved', 'rag_document', dd.id, null, {});
  return fn_rag_document_json(dd);
}
