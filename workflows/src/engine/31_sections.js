// Database steps of the workflow sections whose SQL was a query of its own rather than a call of one function: the
// Companion's agent tools, the scheduler queries, RAG chunk storage, the incident record and the intake episode load.
// The workflow calls them through engine_step (see workflows/src/sheets-steps.mjs, which maps every former Postgres
// node to its JavaScript).

/** 099 · Record incident: insert into incidents (message without identifiers) returning id. */
function sec_record_incident(workflow, node, message, executionId) {
  const r = dbInsert('incidents', { workflow, node, message: fn_redact_error(message), execution_id: executionId });
  return { id: r.id };
}

/** Companion tool get_meal_responses: glucose before and after logged meals, with the foods, biggest rise first. */
function sec_meal_responses(patientId, days) {
  const rows = (fn_meal_responses(patientId, days) || []).map((r) => {
    const m = dbGet('meal_logs', r.meal_id);
    if (!m) return null;
    const foods = (Array.isArray(m.items) ? m.items : [])
      .map((i) => dbGet('foods', castUuid(jtext(i && i.food_id))))
      .filter(Boolean).map((f) => f.name);
    return { r, out: {
      days_ago: round((nowMs() - t(r.eaten_at)) / DAY, 1),
      local_hour: localHour(r.eaten_at),
      carbs_g: r.est_carbs_g ?? null, pre: r.pre ?? null, peak: r.peak ?? null, rise: r.rise ?? null,
      foods: foods.length ? foods.join(', ') : null,
    } };
  }).filter(Boolean);
  return orderBy(rows, [(x) => x.r.rise, 'desc', 'nulls last']).map((x) => x.out);
}

/** Companion tool get_plan_and_appointments: structured plan fields only, and upcoming appointments. */
function sec_plan_and_appointments(patientId) {
  const plan = dbOne('care_plans', (c) => c.patient_id === patientId && c.status === 'ACTIVE');
  let planOut = null;
  if (plan) {
    const p = fn_plan_json(plan.id) || {};
    planOut = { version: p.version ?? null, title: p.title ?? null, targets: p.targets ?? null,
      items: (Array.isArray(p.items) ? p.items : []).map((i) => omit(i, 'id', 'detail')) };
  }
  const appointments = dbWhere('appointments', (a) => a.patient_id === patientId && t(a.starts_at) > nowMs() && ['booked', 'requested'].includes(a.status))
    .map((a) => ({ in_days: round((t(a.starts_at) - nowMs()) / DAY, 1), local_time: localHHMM(a.starts_at), type: a.type, channel: a.channel, status: a.status }));
  return { plan: planOut, appointments };
}

/** Companion tool find_care: facilities near the patient (no row when the patient is unknown). */
function sec_find_care(patientId, specialty, facilityType) {
  const p = dbGet('patients', patientId);
  if (!p) return [];
  return [{ facilities: fn_match_facilities({ specialty: nullif(left(specialty, 40), ''), type: nullif(left(facilityType, 40), ''),
    lat: p.lat ?? null, lng: p.lng ?? null, limit: 5, specialty_soft: true, include_directory: true }) }];
}

/** 002 · Load episode: the episode with its AI gate, if the caller may see the patient; otherwise not_found. */
function sec_load_episode(ctx, data) {
  const id = castUuid(nullif(jtext((data || {}).episode_id), ''));
  const e = id ? dbGet('episodes', id) : null;
  if (e && fn_can_access_patient(ctx, e.patient_id)) {
    return { episode: { id: e.id, answers: e.answers, patient_id: e.patient_id, gate: fn_ai_gate(e.patient_id, 'care_access') } };
  }
  return { episode: fn_raise('not_found: episode not found') };
}

/**
 * 006 · Active patients: up to 15 app users with readings this week and no weekly review in 6 days, longest-waiting
 * first. Closed accounts and populations outside the AI policy are left out.
 */
function sec_weekly_candidates() {
  const lastWeekly = (pid) => maxOf(dbWhere('patient_insights', (i) => i.patient_id === pid && i.kind === 'weekly').map((i) => i.created_at));
  const recent = new Set(dbWhere('glucose_readings', (g) => t(g.measured_at) > nowMs() - 7 * DAY).map((g) => g.patient_id));
  const list = dbWhere('patients', (p) => p.user_id !== null && !fn_account_closed(p.id) && (fn_exclusions(p.id) || []).length === 0 && recent.has(p.id)
    && !dbExists('patient_insights', (i) => i.patient_id === p.id && i.kind === 'weekly' && t(i.created_at) > nowMs() - 6 * DAY));
  return orderBy(list, [(p) => lastWeekly(p.id), 'asc', 'nulls first'], (p) => p.id).slice(0, 15).map((p) => ({ patient_id: p.id }));
}

/** 009b · Appointments needing a brief: booked, within 48 hours, linked patient, no brief yet (3 at a time). */
function sec_brief_candidates() {
  const list = dbWhere('appointments', (a) => a.status === 'booked' && t(a.starts_at) >= nowMs() && t(a.starts_at) <= nowMs() + 48 * HOUR
    && fn_tier(a.patient_id) === 'linked' && !dbExists('previsit_briefs', (b) => b.appointment_id === a.id));
  return orderBy(list, (a) => a.starts_at).slice(0, 3).map((a) => ({ appointment_id: a.id, patient_id: a.patient_id }));
}

/** admin.rag_sync: asks WF-019c to read the Drive knowledge folder now (the event dispatcher starts it at once). */
function api_rag_sync(c) {
  fn_emit('KnowledgeSyncRequested', null, null, { requested_by: jtext((c || {}).user_id) });
  fn_audit(c, 'knowledge.sync_requested', 'rag_document', null, null);
  return { queued: true };
}

/**
 * 019c · Knowledge base from Google Drive: which files of the folder need (re)ingestion — new, changed (Drive version)
 * or never indexed. Documents whose file has left the folder are retired here, with their chunks.
 *   files: the Drive listing [{ id, name, mimeType, modifiedTime, md5Checksum }]
 */
function sec_drive_plan(files, complete = false) {
  const list = (Array.isArray(files) ? files : []).filter((f) => f && f.id && f.mimeType !== 'application/vnd.google-apps.folder');
  const seen = new Set();
  const out = [];
  for (const f of list) {
    const key = `drive:${f.id}`;
    seen.add(key);
    const version = String(f.md5Checksum || f.modifiedTime || '');
    const doc = dbOne('rag_documents', (d) => d.source_key === key);
    const indexed = doc && dbExists('rag_chunks', (c) => c.document_id === doc.id);
    if (doc && doc.status === 'approved' && doc.source_version === version && indexed) continue;
    out.push({ file_id: f.id, name: f.name, mime_type: f.mimeType || 'text/plain', version, modified: f.modifiedTime || null, url: `https://drive.google.com/file/d/${f.id}` });
  }
  // Retiring documents whose file left the folder needs a complete, non-empty listing (all pages fetched), and at most
  // a quarter of the folder's documents (at least 3) in one run. A permissions problem or a partial listing would
  // otherwise empty the knowledge base; then nothing is retired and an incident asks a person to check.
  const gone = dbWhere('rag_documents', (d) => String(d.source_key || '').startsWith('drive:') && d.status === 'approved' && !seen.has(d.source_key));
  const approved = dbCount('rag_documents', (d) => String(d.source_key || '').startsWith('drive:') && d.status === 'approved');
  const limit = Math.max(3, Math.floor(approved / 4));
  if (gone.length && (complete !== true || list.length === 0 || gone.length > limit)) {
    dbInsert('incidents', { workflow: 'Health Platform', node: '019c · Plan sync', kind: 'workflow_error', severity: 'medium',
      message: `Drive sync did not retire ${gone.length} document(s): ${complete !== true ? 'the folder listing was incomplete' : list.length === 0 ? 'the folder listing was empty' : `more than ${limit} at once`}. Check the folder and its sharing.` });
    return out;
  }
  for (const d of gone) {
    dbUpdate('rag_documents', d, { status: 'retired' });
    dbDeleteWhere('rag_chunks', (c) => c.document_id === d.id);
  }
  return out;
}

/**
 * 019c · One Drive file as an approved knowledge document (the folder is the approval). A Markdown file may start with
 * front matter (title, source, version, language, audience, publisher). Returns the document in the shape the ingestion
 * steps take: { doc: { id, title, content }, injection }. The tab keeps at most 45,000 characters of the text (a Sheets
 * cell holds 50,000); the chunks are made from the whole text.
 */
function sec_drive_document(file, text) {
  let body = String(text || '').replace(/\r/g, '');
  const meta = {};
  const fm = body.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    for (const line of fm[1].split('\n')) { const m = line.match(/^(\w+):\s*(.*)$/); if (m) meta[m[1].toLowerCase()] = m[2].trim().replace(/^"(.*)"$/, '$1'); }
    body = body.slice(fm[0].length);
  }
  body = body.trim();
  if (!body) throw new Error(`bad_request: the Drive file "${file && file.name}" has no text`);
  const arabic = (body.match(/[؀-ۿ]/g) || []).length > (body.match(/[A-Za-z]/g) || []).length;
  const values = {
    title: left(meta.title || String(file.name || 'Document').replace(/\.[a-z0-9]+$/i, ''), 300),
    source: meta.source || `Google Drive: ${file.name}`,
    version: meta.version || (file.modified ? String(file.modified).slice(0, 10) : '1'),
    language: meta.language === 'ar' || meta.language === 'en' ? meta.language : (arabic ? 'ar' : 'en'),
    audience: meta.audience === 'clinician' ? 'clinician' : 'patient',
    publisher: meta.publisher || null,
    content: body.slice(0, RAG_PART_CHARS),
    status: 'approved', origin: 'manual',
    source_key: `drive:${file.file_id}`, source_version: file.version || null, source_url: file.url || null,
    content_sha: sha256(body), published_at: file.modified ? localDate(file.modified) : today(),
  };
  const existing = dbOne('rag_documents', (d) => d.source_key === values.source_key);
  const doc = existing ? dbUpdate('rag_documents', existing, values) : dbInsert('rag_documents', values);
  fn_rag_store_parts(doc.id, body);
  return { doc: { id: doc.id, title: doc.title, content: body }, injection: fn_rule('prompt_injection') };
}

/* A Sheets cell holds 50,000 characters: a document's text is kept in rag_documents.content (the first part) and, when
 * longer, in rag_document_parts (the rest, in order). Re-indexing reads the whole text back (fn_rag_ingest_doc). */
const RAG_PART_CHARS = 45000;

/** Stores the text beyond the first part; parts the new text no longer needs are removed. */
function fn_rag_store_parts(documentId, text) {
  const body = String(text || '');
  const parts = [];
  for (let i = RAG_PART_CHARS; i < body.length; i += RAG_PART_CHARS) parts.push(body.slice(i, i + RAG_PART_CHARS));
  const old = dbWhere('rag_document_parts', (p) => p.document_id === documentId);
  parts.forEach((content, k) => {
    const row = old.find((p) => p.part === k + 1);
    if (row) { if (row.content !== content) dbUpdate('rag_document_parts', row, { content }); }
    else dbInsert('rag_document_parts', { document_id: documentId, part: k + 1, content });
  });
  for (const p of old) if (p.part > parts.length) dbDelete('rag_document_parts', p);
  return parts.length;
}

/** The whole text of an approved document, for (re)ingestion: { id, title, content }, or {} when not approved. */
function fn_rag_ingest_doc(p_document_id) {
  const d = dbGet('rag_documents', castUuid(p_document_id));
  if (!d || d.status !== 'approved') return {};
  const rest = orderBy(dbWhere('rag_document_parts', (p) => p.document_id === d.id), (p) => p.part).map((p) => p.content).join('');
  return { id: d.id, title: d.title, content: String(d.content || '') + rest };
}

/** 019 · Store chunk: insert or replace one chunk of a document, returning its document id. */
function sec_store_chunk(documentId, index, content, embedding, embedModel, quarantined, reason) {
  // Four decimals keep a 768-number embedding near 6 KB in its Sheets cell; cosine ranking does not change.
  const vec = Array.isArray(embedding) ? embedding.map((x) => Math.round(Number(x) * 1e4) / 1e4) : embedding;
  const values = { content, embedding: vec, search_text: fn_rag_search_text(content), embed_model: embedModel, content_sha: sha256(content),
    quarantined: castBool(quarantined), quarantine_reason: nullif(reason, ''), indexed_at: now() };
  const r = dbInsert('rag_chunks', { document_id: documentId, chunk_index: index, ...values }, { onConflict: { cols: ['document_id', 'chunk_index'], set: values } });
  return { document_id: r.document_id };
}
