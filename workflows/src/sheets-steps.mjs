// Maps the SQL of every former Postgres node of the workflow sections to the JavaScript step the Sheets backend runs
// instead (engine_step in workflows/src/engine/99_entry.js). A step is an expression over the engine functions and
// `a`, the node's parameters ($1 = a[0], ...). mode 'one': one row; 'rows': a list of rows.
//
// Queries that only call functions (select app.f($1::uuid, nullif($2, '')) as c, ...) are translated automatically;
// the others are written out below, keyed by their SQL. A query with neither fails the build.

const CAST = { uuid: 'castUuid', jsonb: 'castJson', json: 'castJson', int: 'castInt', integer: 'castInt', bigint: 'castInt', numeric: 'castNum', boolean: 'castBool', text: '', vector: 'castJson', date: 'castDate', timestamptz: 'castTs' };

const norm = (q) => String(q).replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

/** Recursive-descent translation of: select call [as alias] (, call [as alias])* */
function translate(sql) {
  const s = norm(sql);
  let i = 0;
  const peek = (re) => { re.lastIndex = i; const m = re.exec(s); return m && m.index === i ? m : null; };
  const eat = (re) => { const m = peek(re); if (!m) throw new Error(`expected ${re} at ${i}: ${s.slice(i, i + 40)}`); i += m[0].length; return m; };
  const ws = () => { const m = peek(/\s*/y); if (m) i += m[0].length; };
  function withCast(expr) {
    const m = peek(/::(\w+)/y);
    if (!m) return expr;
    i += m[0].length;
    if (!(m[1] in CAST)) throw new Error(`cast ${m[1]}`);
    return CAST[m[1]] ? `${CAST[m[1]]}(${expr})` : expr;
  }
  function arg() {
    ws();
    let m;
    if ((m = peek(/\$(\d+)/y))) { i += m[0].length; return withCast(`a[${Number(m[1]) - 1}]`); }
    if ((m = peek(/nullif\(/y))) {
      i += m[0].length;
      const x = arg(); ws(); eat(/,/y); const y = arg(); ws(); eat(/\)/y);
      return withCast(`nullif(${x}, ${y})`);
    }
    if ((m = peek(/'((?:[^']|'')*)'/y))) { i += m[0].length; return withCast(JSON.stringify(m[1].replace(/''/g, "'"))); }
    if ((m = peek(/(null|true|false)\b/y))) { i += m[0].length; return withCast(m[1]); }
    if ((m = peek(/-?\d+(\.\d+)?/y))) { i += m[0].length; return withCast(m[0]); }
    if ((m = peek(/app\.(\w+)\(/y))) return withCast(call().code);
    throw new Error(`argument at ${i}: ${s.slice(i, i + 40)}`);
  }
  function call() {
    const m = eat(/app\.(\w+)\(/y);
    const args = [];
    ws();
    if (!peek(/\)/y)) { args.push(arg()); ws(); while (peek(/,/y)) { eat(/,/y); args.push(arg()); ws(); } }
    eat(/\)/y);
    return { name: m[1], code: `${m[1]}(${args.join(', ')})` };
  }
  eat(/select /y);
  const cols = [];
  for (;;) {
    ws();
    const c = call();
    ws();
    let alias = c.name;
    const am = peek(/as (\w+)/y);
    if (am) { i += am[0].length; alias = am[1]; }
    cols.push(`${JSON.stringify(alias)}: ${c.code}`);
    ws();
    if (peek(/,/y)) { eat(/,/y); continue; }
    break;
  }
  if (i !== s.length) throw new Error(`trailing text: ${s.slice(i, i + 40)}`);
  return { expr: `({ ${cols.join(', ')} })`, mode: 'one' };
}
const MANUAL = {
  'insert into app.incidents(workflow, node, message, execution_id) values ($1, $2, app.fn_redact_error($3), $4) returning id':
    { expr: 'sec_record_incident(a[0], a[1], a[2], a[3])' },
  "select app.fn_glucose_metrics($1::uuid, greatest(1, least(90, $2::int))) #- '{latest,measured_at}' as metrics":
    { expr: "({ metrics: deletePath(fn_glucose_metrics(castUuid(a[0]), greatest(1, least(90, castInt(a[1])))), ['latest', 'measured_at']) })" },
  'select app.fn_detect_patterns($1::uuid, greatest(7, least(30, $2::int))) as patterns':
    { expr: '({ patterns: fn_detect_patterns(castUuid(a[0]), greatest(7, least(30, castInt(a[1])))) })' },
  'select app.fn_patient_history_search($1::uuid, left($2, 300), 8) as result':
    { expr: '({ result: fn_patient_history_search(castUuid(a[0]), left(a[1], 300), 8) })' },
  'select app.fn_dashboard_summary($1::uuid, greatest(1, least(30, $2::int))) as result':
    { expr: '({ result: fn_dashboard_summary(castUuid(a[0]), greatest(1, least(30, castInt(a[1])))) })' },
  'select app.fn_food_profile($1::uuid, greatest(7, least(365, $2::int))) as result':
    { expr: '({ result: fn_food_profile(castUuid(a[0]), greatest(7, least(365, castInt(a[1])))) })' },
  'select app.fn_check_drug_for_patient($1::uuid, left($2, 80)) as result':
    { expr: '({ result: fn_check_drug_for_patient(castUuid(a[0]), left(a[1], 80)) })' },
  "select coalesce(jsonb_agg(jsonb_build_object('days_ago', round((extract(epoch from now() - r.eaten_at) / 86400)::numeric, 1), 'local_hour', extract(hour from app.fn_local(r.eaten_at)), 'carbs_g', r.est_carbs_g, 'pre', r.pre, 'peak', r.peak, 'rise', r.rise, 'foods', (select string_agg(f.name, ', ') from jsonb_array_elements(m.items) i join app.foods f on f.id = (i->>'food_id')::uuid)) order by r.rise desc nulls last), '[]'::jsonb) as meals from app.fn_meal_responses($1::uuid, greatest(1, least(30, $2::int))) r join app.meal_logs m on m.id = r.meal_id":
    { expr: '({ meals: sec_meal_responses(castUuid(a[0]), greatest(1, least(30, castInt(a[1])))) })' },
  "select jsonb_build_object( 'plan', (select jsonb_build_object('version', p->'version', 'title', p->'title', 'targets', p->'targets', 'items', (select coalesce(jsonb_agg(i - 'id' - 'detail'), '[]'::jsonb) from jsonb_array_elements(p->'items') i)) from (select app.fn_plan_json(id) as p from app.care_plans where patient_id = $1::uuid and status = 'ACTIVE') x), 'appointments', (select coalesce(jsonb_agg(jsonb_build_object('in_days', round((extract(epoch from starts_at - now()) / 86400)::numeric, 1), 'local_time', to_char(app.fn_local(starts_at), 'HH24:MI'), 'type', type, 'channel', channel, 'status', status)), '[]'::jsonb) from app.appointments where patient_id = $1::uuid and starts_at > now() and status in ('booked','requested'))) as result":
    { expr: '({ result: sec_plan_and_appointments(castUuid(a[0])) })' },
  "select app.fn_match_facilities(jsonb_build_object('specialty', nullif(left($2, 40), ''), 'type', nullif(left($3, 40), ''), 'lat', p.lat, 'lng', p.lng, 'limit', 5, 'specialty_soft', true)) as facilities from app.patients p where p.id = $1::uuid":
    { expr: 'sec_find_care(castUuid(a[0]), a[1], a[2])', mode: 'rows' },
  "select coalesce((select jsonb_build_object('id', e.id, 'answers', e.answers, 'patient_id', e.patient_id, 'gate', app.fn_ai_gate(e.patient_id, 'care_access')) from app.episodes e where e.id = nullif($2::jsonb->>'episode_id', '')::uuid and app.fn_can_access_patient($1::jsonb, e.patient_id)), app.fn_raise('not_found: episode not found')) as episode":
    { expr: 'sec_load_episode(castJson(a[0]), castJson(a[1]))' },
  "select case when $1 = 'null' then null else app.fn_apply_ai_action($1::jsonb) end as result":
    { expr: "({ result: a[0] === 'null' ? null : fn_apply_ai_action(castJson(a[0])) })" },
  "select p.id as patient_id from app.patients p where p.user_id is not null and not app.fn_account_closed(p.id) and cardinality(app.fn_exclusions(p.id)) = 0 and exists (select 1 from app.glucose_readings g where g.patient_id = p.id and g.measured_at > now() - interval '7 days') and not exists (select 1 from app.patient_insights i where i.patient_id = p.id and i.kind = 'weekly' and i.created_at > now() - interval '6 days') order by (select max(i.created_at) from app.patient_insights i where i.patient_id = p.id and i.kind = 'weekly') nulls first, p.id limit 15":
    { expr: 'sec_weekly_candidates()', mode: 'rows' },
  "select a.id as appointment_id, a.patient_id from app.appointments a where a.status = 'booked' and a.starts_at between now() and now() + interval '48 hours' and app.fn_tier(a.patient_id) = 'linked' and not exists (select 1 from app.previsit_briefs b where b.appointment_id = a.id) order by a.starts_at limit 3":
    { expr: 'sec_brief_candidates()', mode: 'rows' },
  "select app.fn_rag_search($1, $2, coalesce(nullif($3, '')::int, 4), nullif($4, ''), $5, nullif($6, '')) as results, app.fn_rule('prompt_injection') as injection":
    { expr: "({ results: fn_rag_search(a[0], a[1], coalesce(castInt(nullif(a[2], '')), 4), nullif(a[3], ''), a[4], nullif(a[5], '')), injection: fn_rule('prompt_injection') })" },
  "select coalesce((select jsonb_build_object('id', id, 'title', title, 'content', content) from app.rag_documents where id = $1::uuid and status = 'approved'), '{}'::jsonb) as doc, app.fn_rule('prompt_injection') as injection":
    { expr: "(() => { const d = dbOne('rag_documents', (r) => r.id === castUuid(a[0]) && r.status === 'approved'); return { doc: d ? { id: d.id, title: d.title, content: d.content } : {}, injection: fn_rule('prompt_injection') }; })()" },
  "insert into app.rag_chunks(document_id, chunk_index, content, embedding, search_text, embed_model, content_sha, quarantined, quarantine_reason, indexed_at) values ($1::uuid, $2::int, $3, $4::vector, app.fn_rag_search_text($3), $5, encode(digest($3, 'sha256'), 'hex'), $6::boolean, nullif($7, ''), now()) on conflict (document_id, chunk_index) do update set content = excluded.content, embedding = excluded.embedding, search_text = excluded.search_text, embed_model = excluded.embed_model, content_sha = excluded.content_sha, quarantined = excluded.quarantined, quarantine_reason = excluded.quarantine_reason, indexed_at = excluded.indexed_at returning document_id":
    { expr: 'sec_store_chunk(castUuid(a[0]), castInt(a[1]), a[2], castJson(a[3]), a[4], a[5], a[6])' },
  'delete from app.rag_chunks where document_id = $1::uuid and chunk_index >= $2::int':
    { expr: "({ deleted: dbDeleteWhere('rag_chunks', (r) => r.document_id === castUuid(a[0]) && r.chunk_index >= castInt(a[1])) })" },
  'select jsonb_array_elements(app.fn_guideline_sources_due(10)) as src':
    { expr: '(fn_guideline_sources_due(10) || []).map((src) => ({ src }))', mode: 'rows' },
  "select case when nullif($1, '') is null then '{}'::jsonb else app.fn_ai_context($1::uuid) - 'lifestyle_7d' - 'screenings' - 'recent_vitals' end as context, app.fn_ai_gate(nullif($1, '')::uuid, 'medgemma_consult') as gate, app.fn_dose_guard() as dose_guard":
    { expr: "({ context: nullif(a[0], '') === null ? {} : omit(fn_ai_context(castUuid(a[0])), 'lifestyle_7d', 'screenings', 'recent_vitals'), gate: fn_ai_gate(castUuid(nullif(a[0], '')), 'medgemma_consult'), dose_guard: fn_dose_guard() })" },
  'select jsonb_array_elements(app.fn_nightscout_targets()) as c':
    { expr: '(fn_nightscout_targets() || []).map((c) => ({ c }))', mode: 'rows' },
  "select app.fn_job_run('reminders', app.fn_run_reminders() || jsonb_build_object('escalations', app.fn_run_escalations())) as result":
    { expr: "({ result: fn_job_run('reminders', { ...fn_run_reminders(), escalations: fn_run_escalations() }) })" },
  "select app.fn_job_run('daily_maintenance', jsonb_build_object('retention', app.fn_run_retention(), 'tasks', app.fn_generate_tasks(), 'episodes', app.fn_close_stale_episodes())) as result":
    { expr: "({ result: fn_job_run('daily_maintenance', { retention: fn_run_retention(), tasks: fn_generate_tasks(), episodes: fn_close_stale_episodes() }) })" },
  "select app.fn_brief_json(($1::jsonb->>'id')::uuid) as data":
    { expr: '({ data: fn_brief_json(castUuid(jtext((castJson(a[0]) || {}).id))) })' },
};

/** The step for a Postgres node's SQL: { expr, mode }. */
export function sqlStep(query) {
  const key = norm(query);
  if (MANUAL[key]) return { mode: 'one', ...MANUAL[key] };
  // The event dispatcher's claim query carries its route table inline.
  const claim = key.match(/^select \* from app\.fn_claim_events\((\d+), \$routes\$(.*)\$routes\$::jsonb, (\d+)\)$/);
  if (claim) return { expr: `fn_claim_events(${claim[1]}, ${JSON.stringify(JSON.parse(claim[2]))}, ${claim[3]})`, mode: 'rows' };
  try {
    return translate(key);
  } catch (e) {
    throw new Error(`No Sheets step for this SQL (add it to workflows/src/sheets-steps.mjs): ${key.slice(0, 300)}\n  (${e.message})`);
  }
}
