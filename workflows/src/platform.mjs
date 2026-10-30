// The whole platform as ONE n8n workflow, "Health Platform" (workflows/n8n/health-platform.json).
//
// Each former workflow is a section of this workflow, shown on the canvas in its own labelled frame. Node names carry
// the section's number ("001 · Prepare", "Dispatcher · Claim events") so they stay unique.
//
//   API         POST /webhook/api/v1/<group>  ->  Request  ->  Read for request (the tabs the action needs, one Sheets
//               request)  ->  Run API (the engine: Auth Gate fn_gate with the route table api_routes, then the action)
//               ->  Write for request (one Sheets request)  ->  Respond. An API request is one execution; AI actions
//               call their section (below).
//   Data        every database step of the sections calls the Data section: read, engine step, write, rows back.
//   Schedules   each job keeps its own Schedule Trigger and runs inline (event dispatcher every minute, reminders, ...);
//               an API request that queued events also starts the dispatcher at once.
//   Call-ins    a section that is called (event consumers, AI flows, RAG search, MedGemma consult, weekly review, brief,
//               guideline check) starts at the single "Internal call" trigger: an Execute Workflow node calls this same
//               workflow with __call = the section id, and "Route internal call" sends the item to that section.
//   Errors      the Error Trigger records failures without identifiers (n8n runs a workflow's own Error Trigger).
//   Libraries   the engine, the deterministic AI gates/guards and the guideline parser live once, in disabled
//               "Library · ..." Code nodes; a Code node that needs one loads it with new Function($('Library · ...').params.jsCode).
import { stableId, webhook, ifTrue, layout, code, sheetsRead, sheetsWrite, DATA_SECTION, FILES_DIR, FILE_CRYPTO, WF } from './lib.mjs';
import { tablesFor } from './engine/deps.mjs';
import { engineSource } from './engine/index.mjs';
import { GROUPS } from './api-routes.mjs';
import { AI_LIB, GUARD_LIB } from './ai-lib.mjs';
import { GUIDELINE_LIB } from './guideline-lib.mjs';
import { EVENT_ROUTES } from './core.mjs';

const SELF = WF.platform;
// A function name the Gemini API accepts (tools of an AI agent are named after their node).
export const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;
const NAME = 'Health Platform';
const T = {
  exec: 'n8n-nodes-base.executeWorkflow',
  tool: '@n8n/n8n-nodes-langchain.toolWorkflow',
  subTrigger: 'n8n-nodes-base.executeWorkflowTrigger',
  schedule: 'n8n-nodes-base.scheduleTrigger',
  errorTrigger: 'n8n-nodes-base.errorTrigger',
  code: 'n8n-nodes-base.code',
};

/* ----------------------------------------------------------------------------------------------- API responses */

// Maps database exceptions ("forbidden: ...", "bad_request: ...") to API error codes, inside n8n expressions.
const DB_DOWN = '/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|timeout expired|terminating connection|database system is|too many clients|Connection terminated/i';
const BAD_INPUT = '/invalid input syntax|violates check constraint|violates not-null|violates foreign key|out of range|invalid input value|value too long/i';
const CONFLICT = '/duplicate key value|violates unique constraint/i';
// Only messages raised on purpose by the database functions ("bad_request: ...") reach the client, with their Arabic
// version after " ¦ ". Anything else (constraint names, column names, type diagnostics) is replaced by a fixed sentence.
const MAP_ERROR = `(raw) => { const m = raw.match(/(unauthorized|forbidden|not_found|bad_request|conflict):\\s*([^\\n]*)/); if (m) { const p = m[2].split(' ¦ '); return p[1] ? { code: m[1], message: p[0], message_ar: p[1] } : { code: m[1], message: p[0] }; } if (${DB_DOWN}.test(raw)) return { code: 'unavailable', message: 'The service is temporarily unavailable. Please try again in a minute.', message_ar: 'الخدمة غير متاحة مؤقتًا. من فضلك حاول بعد دقيقة.' }; if (${CONFLICT}.test(raw)) return { code: 'conflict', message: 'This was already saved.', message_ar: 'تم حفظ هذا من قبل.' }; if (${BAD_INPUT}.test(raw)) return { code: 'bad_request', message: 'Some of the information sent is not valid. Please check it and try again.', message_ar: 'بعض البيانات المرسلة غير صحيحة. من فضلك راجعها وحاول مرة أخرى.' }; return { code: 'server_error', message: 'Something went wrong on our side. Please try again.', message_ar: 'حدث خطأ من جهتنا. من فضلك حاول مرة أخرى.' }; }`;
const STATUS = '{ unauthorized: 401, forbidden: 403, mfa_required: 403, password_change_required: 403, not_found: 404, unknown_action: 404, conflict: 409, too_many_requests: 429, bad_request: 400, unavailable: 503, server_error: 500 }';
// An action returns {data}; functions that record a refusal return {data: {__error}}.
const RESULT = `(j) => { if (j.data && j.data.__error) return { ok: false, error: j.data.__error }; return { ok: true, data: j.data ?? null }; }`;
const RESULT_BODY = `={{ (${RESULT})($json) }}`;
const RESULT_CODE = `={{ (() => { const r = (${RESULT})($json); return r.ok ? 200 : ((${STATUS})[r.error.code] || 400); })() }}`;
const ERR_RAW = "String($json.message || ($json.error && $json.error.message) || $json.error || 'Unexpected error')";
const ERR_BODY = `={{ { ok: false, error: (${MAP_ERROR})(${ERR_RAW}) } }}`;
const ERR_CODE = `={{ (${STATUS})[(${MAP_ERROR})(${ERR_RAW}).code] || 500 }}`;

// The client address of an API request, as an n8n expression over the webhook item ($json.headers) and $env (see the
// Request node below for the order and why).
export const CLIENT_IP_EXPR = "(($h, pick) => { const first = (v) => String(v ?? '').split(',')[0].trim(); "
  + "return pick ? first($h[pick]) : (first($h['cf-connecting-ip']) || first($h['x-real-ip']) || first($h['x-forwarded-for'])); })"
  + "($json.headers || {}, String($env.CLIENT_IP_HEADER || '').trim().toLowerCase())";

const respondJson = (name, body, code) => ({
  name,
  type: 'n8n-nodes-base.respondToWebhook',
  typeVersion: 1.4,
  // Health data is never cached by a browser or a proxy.
  parameters: { respondWith: 'json', responseBody: body, options: { responseCode: code, responseHeaders: { entries: [
    { name: 'Cache-Control', value: 'no-store' }, { name: 'Pragma', value: 'no-cache' }, { name: 'X-Content-Type-Options', value: 'nosniff' }] } } },
});

/** Route table of every group for the Auth Gate: { group: { action: { roles, public, scope } } } (app.api_routes). */
export function routeTable() {
  return Object.fromEntries(Object.entries(GROUPS).map(([g, def]) => [g, Object.fromEntries(Object.entries(def.actions).map(([a, r]) =>
    [a, { roles: r.roles, public: !!r.public, ...(r.scope ? { scope: r.scope } : {}) }]))]));
}

/* ------------------------------------------------------------------------------------------------- node shapes */

const condition = (seed, leftValue, rightValue) => ({
  id: stableId(`${SELF}:cond:${seed}`), leftValue, rightValue, operator: { type: 'string', operation: 'equals' },
});

/** Switch with one output per case: cases = [{ value, label }]; the last output is the fallback. */
const switchNode = (name, valueExpr, cases) => ({
  name,
  type: 'n8n-nodes-base.switch',
  typeVersion: 3.2,
  parameters: {
    rules: {
      values: cases.map((c) => ({
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
          conditions: [condition(`${name}:${c.value}`, `={{ ${valueExpr} }}`, c.value)],
          combinator: 'and',
        },
        renameOutput: true,
        outputKey: c.label,
      })),
    },
    looseTypeValidation: true,
    options: { fallbackOutput: 'extra', renameFallbackOutput: 'unknown' },
  },
});

/** Adds __call (the section to run) to the item, before an Execute Workflow node that passes its items through. */
const setTarget = (name, target) => ({
  name,
  type: 'n8n-nodes-base.set',
  typeVersion: 3.4,
  parameters: {
    mode: 'manual',
    assignments: { assignments: [{ id: stableId(`${SELF}:${name}:__call`), name: '__call', value: target, type: 'string' }] },
    includeOtherFields: true,
    options: {},
  },
});

/**
 * Files the engine asks to write (uploaded documents, files emptied by retention or deletion), on the n8n server under
 * ~/.n8n-files: a list node, base64 to file, write to disk. They are written before the Sheets changes are saved, so a
 * saved reference always has its file.
 */
function fileNodes(prefix, runNode) {
  const list = code(`${prefix}Files`, `// One item per file the engine wrote: { path, base64 }, encrypted (AES-256-GCM) before it reaches the disk.
${FILE_CRYPTO}
return ($('${runNode}').first().json.files || []).map((f) => ({ json: { path: f.path, base64: encryptFile(f.base64) } }));`);
  const toFile = { name: `${prefix}To file`, type: 'n8n-nodes-base.convertToFile', typeVersion: 1.1, parameters: {
    operation: 'toBinary', sourceProperty: 'base64', binaryPropertyName: 'data', options: { fileName: '={{ $json.path.split(\'/\').pop() }}' } } };
  const save = { name: `${prefix}Save file`, type: 'n8n-nodes-base.readWriteFile', typeVersion: 1.1, parameters: {
    operation: 'write', fileName: `={{ '${FILES_DIR}' + $('${prefix}Files').item.json.path }}`, dataPropertyName: 'data', options: {} } };
  return { list, toFile, save };
}

const noOp = (name, notes) => ({ name, type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {}, ...(notes ? { notes, notesInFlow: false } : {}) });

const sticky = (name, content, { width, height, color }) => ({
  name, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, parameters: { content, height, width, color },
});

// A call-in names "this workflow" by expression, not by id: the file keeps working when the n8n editor imports it under
// a new id.
const SELF_REF = { __rl: true, mode: 'id', value: '={{ $workflow.id }}' };
const CALL_FIELD = { id: '__call', displayName: '__call', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string', removed: false };

/* -------------------------------------------------------------------------------------------- shared libraries */

// Libraries in the order they are recognized at the start of a Code node (GUARD_LIB is the first half of AI_LIB, so
// a node that inlined only the guard loads the whole AI library).
const LIBRARIES = [
  { name: 'Library · AI guard', srcs: [AI_LIB, GUARD_LIB], code: AI_LIB,
    about: 'AI gates and guards: PHI redaction, prompt-injection screen, nonce data blocks, output gate, dose and treatment wording, citation whitelist. Tested offline by scripts/test-ai-gate.mjs and scripts/test-guard.mjs.' },
  { name: 'Library · guideline sources', srcs: [GUIDELINE_LIB], code: GUIDELINE_LIB,
    about: 'Guideline parsing: PubMed/PMC/JATS, PDF and HTML text, edition and license checks. Tested offline by scripts/test-guidelines.mjs.' },
];

/** Top-level declarations of a library source (its exports). */
function topLevelNames(src) {
  if (/^(?:const|let|var)\s*[{[]/m.test(src)) throw new Error('library: top-level destructuring is not supported');
  const names = [];
  for (const m of src.matchAll(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.push(m[1] || m[2]);
  return [...new Set(names)];
}
for (const lib of LIBRARIES) {
  lib.exports = topLevelNames(lib.code);
  lib.nodeCode = `${lib.code.trim()}\n\n// Exports. Code nodes load this library with new Function($('${lib.name}').params.jsCode)(); this node itself never runs.\nreturn { ${lib.exports.join(', ')} };`;
  // The library must load outside n8n too (no n8n globals at the top level).
  const loaded = new Function(lib.nodeCode)();
  for (const n of lib.exports) if (!(n in loaded)) throw new Error(`${lib.name}: export ${n} missing`);
}
{
  const [a, b] = LIBRARIES;
  const clash = b.exports.filter((n) => a.exports.includes(n));
  if (clash.length) throw new Error(`libraries declare the same names: ${clash.join(', ')}`);
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replaces the libraries a Code node inlined with a loader; returns the new code (unchanged when none are inlined). */
function shareLibraries(js) {
  let rest = js;
  const used = [];
  for (;;) {
    const t = rest.trimStart();
    let hit = null;
    for (const lib of LIBRARIES) {
      if (used.includes(lib)) continue;
      const src = lib.srcs.map((s) => s.trim()).find((s) => t.startsWith(s));
      if (src) { hit = lib; rest = t.slice(src.length); break; }
    }
    if (!hit) break;
    used.push(hit);
  }
  if (!used.length) return js;
  rest = rest.replace(/^\n+/, '');
  const exportsAll = used.flatMap((l) => l.exports);
  // Names declared by the node itself (top level) stay its own; every other library name it mentions is loaded.
  const own = new Set([...rest.matchAll(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1] || m[2]));
  const names = exportsAll.filter((n) => !own.has(n) && new RegExp(`(?<![\\w$.])${escRe(n)}(?![\\w$])`).test(rest));
  if (!names.length) return rest;
  const lines = [`// Shared code, held once for the whole platform by the disabled ${used.map((l) => `"${l.name}"`).join(' and ')} node${used.length > 1 ? 's' : ''}.`];
  if (used.length === 1) {
    lines.push(`const { ${names.join(', ')} } = new Function($('${used[0].name}').params.jsCode)();`);
  } else {
    lines.push(`const __lib = new Function($('${used[0].name}').params.jsCode)();`);
    for (const l of used.slice(1)) lines.push(`Object.assign(__lib, new Function(...Object.keys(__lib), $('${l.name}').params.jsCode)(...Object.values(__lib)));`);
    lines.push(`const { ${names.join(', ')} } = __lib;`);
  }
  return `${lines.join('\n')}\n${rest}`;
}

/* ---------------------------------------------------------------------------------------------------- sections */

// Node-name prefix of each section: its WF number, or a word for the core sections.
const PREFIX = { [WF.dispatcher]: 'Dispatcher', [WF.eventRunner]: 'Runner', [WF.transfer]: '017t' };
const prefixOf = (wf) => {
  if (PREFIX[wf.id]) return PREFIX[wf.id];
  const m = wf.name.match(/^WF-(\w+)/);
  if (!m) throw new Error(`No section number in "${wf.name}"`);
  return m[1];
};

/** Rewrites $('Node') references inside every string of a value; names not in `map` are an error. */
function renameRefs(value, map, where) {
  if (typeof value === 'string') {
    return value.replace(/\$\('((?:[^'\\]|\\.)*)'\)/g, (m, name) => {
      if (!(name in map)) throw new Error(`${where}: $('${name}') is not a node of this section`);
      return `$('${map[name]}')`;
    });
  }
  if (Array.isArray(value)) return value.map((v) => renameRefs(v, map, where));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameRefs(v, map, where)]));
  return value;
}

function renameConnections(connections, map) {
  const out = {};
  for (const [from, types] of Object.entries(connections)) {
    out[map[from] ?? from] = Object.fromEntries(Object.entries(types).map(([type, outs]) =>
      [type, outs.map((list) => (list || []).map((c) => ({ ...c, node: map[c.node] ?? c.node })))]));
  }
  return out;
}

/** Connections helper on a {nodes, connections} pair. */
function linker(connections) {
  return (from, to, { output = 0, input = 0, type = 'main' } = {}) => {
    connections[from] = connections[from] || {};
    connections[from][type] = connections[from][type] || [];
    while (connections[from][type].length <= output) connections[from][type].push([]);
    connections[from][type][output].push({ node: to, type, index: input });
  };
}

/**
 * Turns Execute Workflow / workflow-tool nodes into calls of this workflow. Calls with mapped inputs get __call as one
 * more input; pass-through calls get a "· target" Set node in front. Returns the Set nodes to add.
 */
function selfCalls(nodes, connections, called, callers, section) {
  const added = [];
  for (const node of [...nodes]) {
    if (node.type !== T.exec && node.type !== T.tool) continue;
    const p = node.parameters;
    const target = p.workflowId?.value;
    const dynamic = String(target).startsWith('=');
    if (!dynamic && !called.has(target)) throw new Error(`${node.name}: calls ${target}, which is not a called section`);
    if (!dynamic) callers.set(target, [...(callers.get(target) || []), `${node.name}${section ? ` (${section})` : ''}`]);
    p.workflowId = { ...SELF_REF };
    const inputs = p.workflowInputs;
    if (inputs?.schema?.length) {
      inputs.value = { __call: target, ...inputs.value };
      inputs.schema = [{ ...CALL_FIELD }, ...inputs.schema];
      continue;
    }
    if (node.type === T.tool) throw new Error(`${node.name}: a workflow tool needs mapped inputs`);
    const set = setTarget(`${node.name} · target`, target);
    set.id = stableId(`${SELF}:${set.name}`);
    for (const types of Object.values(connections)) {
      for (const list of types.main || []) for (const c of list || []) if (c.node === node.name) c.node = set.name;
    }
    linker(connections)(set.name, node.name);
    nodes.splice(nodes.indexOf(node), 0, set);
    added.push(set);
  }
  return added;
}

function describeRule(rule) {
  const at = `${String(rule.triggerAtHour ?? 0).padStart(2, '0')}:${String(rule.triggerAtMinute ?? 0).padStart(2, '0')}`;
  if (rule.field === 'seconds') return `every ${rule.secondsInterval} s`;
  if (rule.field === 'minutes') return `every ${rule.minutesInterval} min`;
  if (rule.field === 'hours') return `every ${rule.hoursInterval} h`;
  if (rule.field === 'days') return `daily at ${at} (Cairo time)`;
  return 'on a schedule';
}

/** Category of each section, for the canvas order and frame colour. */
const CATEGORY = {
  core: [WF.errorHandler, WF.dispatcher, WF.eventRunner],
  ai: [WF.companion, WF.intake, WF.pattern, WF.weeklyOne, WF.medSafety, WF.lab, WF.brief, WF.afterVisit, WF.docExtract, WF.medgemma, WF.judge, WF.meterPhoto,
    WF.clinicTriage, WF.clinicPrep, WF.clinicBrief, WF.clinicRx, WF.clinicHints],
  knowledge: [WF.ragSearch, WF.ragIngest, WF.ragMaintenance, WF.ragDrive, WF.guidelineSync, WF.guidelineCheck],
  consumers: [WF.glucoseEvent, WF.referral, WF.transfer, WF.capacity, WF.email],
  jobs: [WF.patternScan, WF.reminders, WF.followup, WF.referralAging, WF.dailyMaintenance, WF.cgmSim, WF.nightscout, WF.weekly, WF.briefScheduler, WF.qualityReport, WF.push, WF.heat, WF.tracing],
};
function category(wf) {
  const c = Object.keys(CATEGORY).find((k) => CATEGORY[k].includes(wf.id));
  if (!c) throw new Error(`${wf.name}: no category in platform.mjs`);
  return c;
}

/**
 * Owner workflow (W1–W5, docs/graduation/02-solution-design.md §2) of each section: its frame header starts with the
 * W label, the frame takes the W colour and the canvas groups the frames by W (one band of rows per W).
 */
const OWNERS = [
  { id: 'P', label: 'Platform (shared)', color: 7, sections: [WF.dispatcher, WF.eventRunner] },
  { id: 'W1', label: 'W1 · Patient data and logging · owner Mohamed', color: 4,
    sections: [WF.meterPhoto, WF.docExtract, WF.nightscout, WF.cgmSim, WF.glucoseEvent] },
  { id: 'W2', label: 'W2 · AI Companion · owner Abdelrhman', color: 6,
    sections: [WF.companion, WF.ragSearch, WF.ragIngest, WF.ragMaintenance, WF.ragDrive, WF.guidelineSync, WF.guidelineCheck, WF.medgemma] },
  { id: 'W3', label: 'W3 · Clinician decision support · owner Maysaa', color: 5,
    sections: [WF.brief, WF.briefScheduler, WF.pattern, WF.patternScan, WF.weekly, WF.weeklyOne, WF.medSafety, WF.lab, WF.afterVisit,
      WF.clinicBrief, WF.clinicHints, WF.clinicRx] },   // polyclinic: specialist brief, doctor-only hints, the prescription in plain Arabic
  { id: 'W4', label: 'W4 · Follow-up and care access · owner Amr', color: 2,
    sections: [WF.reminders, WF.push, WF.heat, WF.intake, WF.followup, WF.referral, WF.referralAging, WF.capacity, WF.transfer, WF.email, WF.dailyMaintenance,
      WF.clinicTriage, WF.clinicPrep] },   // polyclinic: booking triage and the visit-prep note
  { id: 'W5', label: 'W5 · Safety monitor and evaluation · owner Kerolos', color: 3,
    sections: [WF.judge, WF.qualityReport, WF.tracing, WF.errorHandler] },
];
const PLATFORM_OWNER = OWNERS[0];
function ownerOf(wf) {
  const o = OWNERS.find((x) => x.sections.includes(wf.id));
  if (!o) throw new Error(`${wf.name}: no owner workflow (W1–W5) in platform.mjs`);
  return o;
}

/* ------------------------------------------------------------------------------------------------------- build */

/**
 * @param sections built workflows (lib.mjs workflow().build()); each becomes one section of the platform.
 * @returns the platform workflow (n8n JSON).
 */
export function buildPlatform(sections) {
  const nodes = [];
  const connections = {};
  const link = linker(connections);
  const blocks = [];     // canvas frames: { title, body, color, nodes: [...] } laid out at the end
  const callers = new Map();

  // Sections started through the internal router: the ones whose workflow had an Execute Workflow Trigger.
  const called = new Set(sections.filter((wf) => wf.nodes.some((n) => n.type === T.subTrigger)).map((wf) => wf.id));
  called.add(DATA_SECTION);
  const prefixes = new Set();
  const converted = [];
  // An agent's tool keeps its own name, without the section prefix: n8n turns the node name into the function name the
  // model sees, and Gemini accepts only letters, digits, _ . : - there, starting with a letter or _.
  const toolNames = new Set();
  const isTool = (n) => n.type.startsWith('@n8n/n8n-nodes-langchain.tool');
  const toolName = (name, where) => {
    if (!TOOL_NAME.test(name)) throw new Error(`${where}: tool "${name}" needs a name of letters, digits and _ (it is the function name the model sees)`);
    if (toolNames.has(name)) throw new Error(`${where}: tool name "${name}" is used twice`);
    toolNames.add(name);
    return name;
  };

  /* ---- sections ---- */
  for (const src of sections) {
    const wf = JSON.parse(JSON.stringify(src));
    const prefix = prefixOf(wf);
    if (prefixes.has(prefix)) throw new Error(`Duplicate section prefix ${prefix}`);
    prefixes.add(prefix);
    const map = Object.fromEntries(wf.nodes.map((n) => [n.name, isTool(n) ? toolName(n.name, wf.name) : `${prefix} · ${n.name}`]));
    let secNodes = wf.nodes.map((n) => ({ ...renameRefs(n, map, `${wf.name} / ${n.name}`), name: map[n.name] }));
    const secConns = renameConnections(wf.connections, map);

    const subTriggers = secNodes.filter((n) => n.type === T.subTrigger);
    const timers = secNodes.filter((n) => n.type === T.schedule);
    const kind = secNodes.some((n) => n.type === T.errorTrigger) ? 'error' : subTriggers.length ? 'called' : timers.length ? 'scheduled' : null;
    if (!kind) throw new Error(`${wf.name}: no trigger`);
    if (subTriggers.length > 1) throw new Error(`${wf.name}: more than one call trigger`);
    let entry = null;
    if (kind === 'called') {
      // The section's own call trigger becomes its entry point (a pass-through), reached from "Route internal call".
      const t = subTriggers[0];
      const e = noOp(t.name, `Section entry: ${wf.name}. Reached from "Route internal call" when __call = ${wf.id}.`);
      e.id = t.id;
      secNodes[secNodes.indexOf(t)] = e;
      entry = e.name;
    }
    for (const n of secNodes) if (n.type === 'n8n-nodes-base.wait') n.webhookId = stableId(`${SELF}:wait:${n.name}`);
    selfCalls(secNodes, secConns, called, callers, null);
    layout(secNodes, secConns);
    converted.push({ wf, prefix, kind, entry, nodes: secNodes, connections: secConns, timers });
  }

  /* ---- API: webhooks, one Sheets read, the engine (Auth Gate + action), one Sheets write, the answer ---- */
  const apiBlocks = [];
  {
    const nodesApi = [];
    const groups = Object.keys(GROUPS);
    // The tabs each action needs (Auth Gate included), worked out from the engine code at build time.
    // fn_request_patient looks up a record (a reading, a medicine, …) only when a family member names one; those tabs
    // are read on the rare request that needs them (engine_api asks for them and the request is read again).
    const SKIP = ['fn_request_patient'];
    const gateTables = tablesFor({ functions: ['fn_gate'], skip: SKIP });
    const RANGES = { __gate: ['_meta', 'api_routes', ...gateTables].filter((v, i, a) => a.indexOf(v) === i) };
    const WORKFLOW_ACTIONS = {};
    for (const g of groups) for (const [a, r] of Object.entries(GROUPS[g].actions)) {
      if (r.kind === 'workflow') { WORKFLOW_ACTIONS[`${g}.${a}`] = r.workflowId; continue; }
      RANGES[`${g}.${a}`] = [...new Set(['_meta', 'api_routes', ...gateTables, ...tablesFor({ functions: [`api_route_${g}_${a}`], skip: SKIP })])];
    }
    const mid = ((groups.length - 1) * 140) / 2;
    groups.forEach((g, i) => {
      const hook = webhook(`POST /api/v1/${g}`, `api/v1/${g}`);
      hook.position = [0, i * 140];
      nodesApi.push(hook);
      link(hook.name, 'Request');
    });
    // The group is the last part of the webhook path. The client address (for the per-address limits of public actions
    // and sign-in): CLIENT_IP_HEADER names the one header to trust when it is set (for example x-real-ip behind Caddy,
    // cf-connecting-ip behind Cloudflare). Otherwise CF-Connecting-IP (Cloudflare's edge sets it: the public tunnel),
    // then X-Real-IP (Caddy overwrites it with the peer address), and only as a last resort the first X-Forwarded-For
    // entry, which a client can write itself. Behind Caddy without Cloudflare, Caddy must drop a client's
    // CF-Connecting-IP (or CLIENT_IP_HEADER=x-real-ip must be set), since a client could otherwise choose its address.
    const field = (name, value, type = 'string') => ({ id: stableId(`${SELF}:request:${name}`), name, value, type });
    const request = { name: 'Request', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [300, mid], parameters: {
      mode: 'manual', includeOtherFields: false, options: {},
      assignments: { assignments: [
        field('group', "={{ String($prevNode.name).split('/').pop() }}"),
        field('action', "={{ String($json.body?.action ?? '') }}"),
        field('data', '={{ $json.body?.data && typeof $json.body.data === "object" ? $json.body.data : {} }}', 'object'),
        field('authorization', "={{ $json.headers.authorization ?? '' }}"),
        field('client', `={{ ${CLIENT_IP_EXPR} }}`),
        field('ranges', `={{ ((m, k) => (m[k] || m.__gate).join(','))(${JSON.stringify(RANGES)}, String($prevNode.name).split('/').pop() + '.' + String($json.body?.action ?? '')) }}`),
      ] } } };
    const read = sheetsRead('Read for request', "$json.ranges.split(',')", { onError: 'continueErrorOutput',
      scope: { token: "String($('Request').first().json.authorization || '').replace(/^Bearer\s+/i, '')", patient: "String($('Request').first().json.data?.patient_id ?? '')" } });
    read.position = [560, mid];
    const run = code('Run API', `// The Auth Gate and the action, in the engine (Library · engine): one request, one read, one write.
const E = new Function('require', $('Library · engine').params.jsCode)(require);
const req = $('Request').first().json;
const out = E.engine_api({ ...req, batch: $input.first().json, workflowActions: ${JSON.stringify(WORKFLOW_ACTIONS)} });
return [{ json: out }];`, { onError: 'continueErrorOutput' });
    run.position = [820, mid];
    const needMore = ifTrue('Needs more tabs?', '$json.retry === true');
    needMore.position = [1080, mid - 220];
    const more = { name: 'More tabs', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [1080, mid - 440], parameters: {
      mode: 'manual', includeOtherFields: false, options: {},
      assignments: { assignments: [field('ranges', "={{ $json.ranges.join(',') }}")] } } };
    const needFiles = ifTrue('Files to save?', "($('Run API').first().json.files || []).length > 0");
    needFiles.position = [1340, mid - 220];
    const apiFiles = fileNodes('', 'Run API');
    apiFiles.list.position = [1600, mid - 440];
    apiFiles.toFile.position = [1860, mid - 440];
    apiFiles.save.position = [2120, mid - 440];
    // executeOnce: after several files there are several items, and the answer is given once.
    const needWrite = { ...ifTrue('Changes to save?', "($('Run API').first().json.write?.requests || []).length > 0"), executeOnce: true };
    needWrite.position = [1340, mid];
    const write = sheetsWrite('Write for request', "$('Run API').first().json.write", { onError: 'continueErrorOutput' });
    write.position = [1340, mid - 100];
    // The Sheets cache refused the write (another request changed the same rows, or took the same unique key, since this
    // one read them): nothing was written. Read again and run the request again, at most 3 more times.
    const conflictIf = ifTrue('Write refused (conflict)?', '$json.conflict === true');
    conflictIf.position = [1600, mid - 300];
    const retryIf = ifTrue('Run again after conflict?', '$runIndex < 3');
    retryIf.position = [1860, mid - 300];
    const again = { name: 'Read again', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [1860, mid - 520], parameters: {
      mode: 'manual', includeOtherFields: false, options: {},
      assignments: { assignments: [field('ranges', "={{ $('Run API').first().json.read.join(',') }}")] } } };
    const inSection = ifTrue('Runs in a section?', "!!$('Run API').first().json.call");
    inSection.position = [1600, mid];
    const respond = respondJson('Respond', "={{ $('Run API').first().json.body }}", "={{ $('Run API').first().json.status }}");
    respond.position = [1860, mid + 120];
    const kickIf = ifTrue('Events queued?', "$('Run API').first().json.kick === true");
    kickIf.position = [2120, mid + 120];
    const kickTarget = setTarget('Run event dispatcher now · target', WF.dispatcher);
    kickTarget.position = [2380, mid + 120];
    const kick = { name: 'Run event dispatcher now', type: T.exec, typeVersion: 1.2, position: [2640, mid + 120], parameters: {
      workflowId: { ...SELF_REF },
      workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true },
      mode: 'once', options: { waitForSubWorkflow: false } } };
    // Actions that run in an AI section (companion.send, intake.*, provider.generate_brief, admin.guideline_check).
    const target = { name: 'Section request', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [1860, mid - 140], parameters: {
      mode: 'manual', includeOtherFields: false, options: {},
      assignments: { assignments: [
        field('action', "={{ $('Run API').first().json.call.payload.action }}"),
        field('ctx', "={{ $('Run API').first().json.call.payload.ctx }}", 'object'),
        field('data', "={{ $('Run API').first().json.call.payload.data }}", 'object'),
        field('__call', "={{ $('Run API').first().json.call.section }}"),
      ] } } };
    const callSection = { name: 'Run section', type: T.exec, typeVersion: 1.2, onError: 'continueErrorOutput', position: [2120, mid - 140], parameters: {
      workflowId: { ...SELF_REF },
      workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true },
      mode: 'once', options: { waitForSubWorkflow: true } } };
    const sectionOk = respondJson('Respond (section)', RESULT_BODY, RESULT_CODE);
    sectionOk.position = [2380, mid - 220];
    const sectionErr = respondJson('Respond (section error)', ERR_BODY, ERR_CODE);
    sectionErr.position = [2380, mid - 60];
    const down = respondJson('Respond unavailable', `={{ { ok: false, error: { code: 'unavailable', message: 'The service is temporarily unavailable. Please try again in a minute.', message_ar: 'الخدمة غير متاحة مؤقتًا. من فضلك حاول بعد دقيقة.' } } }}`, '={{ 503 }}');
    down.position = [1340, mid + 260];
    const crash = respondJson('Respond server error', `={{ { ok: false, error: { code: 'server_error', message: 'Something went wrong on our side. Please try again.', message_ar: 'حدث خطأ من جهتنا. من فضلك حاول مرة أخرى.' } } }}`, '={{ 500 }}');
    crash.position = [1080, mid + 260];
    const busy = respondJson('Respond busy', `={{ { ok: false, error: { code: 'conflict', message: 'This was changed at the same time by another request. Please try again.', message_ar: 'تم تغيير هذه البيانات في نفس الوقت من طلب آخر. من فضلك حاول مرة أخرى.' } } }}`, '={{ 409 }}');
    busy.position = [2120, mid - 300];
    nodesApi.push(request, read, run, needMore, more, needFiles, apiFiles.list, apiFiles.toFile, apiFiles.save, needWrite, write, conflictIf, retryIf, again, busy, inSection, respond, kickIf, kickTarget, kick, target, callSection, sectionOk, sectionErr, down, crash);
    link(request.name, read.name);
    link(read.name, run.name);
    link(read.name, down.name, { output: 1 });          // Sheets unreachable or over quota -> 503
    link(run.name, needMore.name);
    link(needMore.name, more.name, { output: 0 });
    link(more.name, read.name);
    link(needMore.name, needFiles.name, { output: 1 });
    link(needFiles.name, apiFiles.list.name, { output: 0 });
    link(needFiles.name, needWrite.name, { output: 1 });
    link(apiFiles.list.name, apiFiles.toFile.name);
    link(apiFiles.toFile.name, apiFiles.save.name);
    link(apiFiles.save.name, needWrite.name);
    link(run.name, crash.name, { output: 1 });          // an engine fault -> 500, without details
    link(needWrite.name, write.name, { output: 0 });
    link(needWrite.name, inSection.name, { output: 1 });
    link(write.name, conflictIf.name);
    link(write.name, down.name, { output: 1 });
    link(conflictIf.name, retryIf.name, { output: 0 });
    link(conflictIf.name, inSection.name, { output: 1 });
    link(retryIf.name, again.name, { output: 0 });
    link(retryIf.name, busy.name, { output: 1 });
    link(again.name, read.name);
    link(inSection.name, target.name, { output: 0 });
    link(inSection.name, respond.name, { output: 1 });
    link(respond.name, kickIf.name);
    link(kickIf.name, kickTarget.name, { output: 0 });
    link(kickTarget.name, kick.name);
    link(target.name, callSection.name);
    link(callSection.name, sectionOk.name, { output: 0 });
    link(callSection.name, sectionErr.name, { output: 1 });
    for (const [k, id] of Object.entries(WORKFLOW_ACTIONS)) callers.set(id, [...(callers.get(id) || []), `${k} (API, through "Run section")`]);
    callers.set(WF.dispatcher, [...(callers.get(WF.dispatcher) || []), 'Run event dispatcher now (API, when a request queued events)']);
    apiBlocks.push({ title: 'API (Google Sheets)', color: 5, nodes: nodesApi,
      body: 'Every request: `POST /webhook/api/v1/<group>` with `{action, data}`. "Read for request" reads only the tabs the action needs (one Sheets request); "Run API" runs the Auth Gate (`fn_gate`: session, role, caregiver scope, password-change and staff 2FA rules) and the action in the engine; "Write for request" saves the changes (one request). AI actions continue in their section. When the request queued events, the event dispatcher starts at once.' });
  }

  /* ---- Data: the database step of every former Postgres node (and the agent tools) ---- */
  const dataNodes = [];
  {
    const entry = noOp('Data', 'Section entry: a database step. Reached from "Route internal call" when __call = data. Each item carries the step (expr, over the engine functions), its parameters (args), the tabs to read (ranges), the result shape (mode) and the SQL it replaces (sql).');
    entry.position = [0, 0];
    const dRead = sheetsRead('Data · Read', "String($('Data').first().json.ranges).split(',')");
    dRead.position = [260, 0];
    const dRun = code('Data · Run', `// Runs the step for every item on one read of the tabs (Library · engine); returns the rows and the write.
const E = new Function('require', $('Library · engine').params.jsCode)(require);
const steps = $('Data').all().map((i) => i.json);
return [{ json: E.engine_steps(steps, $input.first().json, String(steps[0].ranges).split(','), E) }];`);
    dRun.position = [520, 0];
    const dNeedFiles = ifTrue('Data · Files to save?', "($('Data · Run').first().json.files || []).length > 0");
    dNeedFiles.position = [780, -260];
    const dFiles = fileNodes('Data · ', 'Data · Run');
    dFiles.list.position = [1040, -360];
    dFiles.toFile.position = [1300, -360];
    dFiles.save.position = [1560, -360];
    const dNeed = { ...ifTrue('Data · Changes to save?', "($('Data · Run').first().json.write?.requests || []).length > 0"), executeOnce: true };
    dNeed.position = [1820, 0];
    const dWrite = sheetsWrite('Data · Write', "$('Data · Run').first().json.write");
    dWrite.position = [2080, -100];
    // A write the Sheets cache refused (a concurrent change of the same rows, such as two dispatcher runs claiming one
    // event): read again and run the step again, at most 3 more times; then the step fails as a database error did.
    const dConflict = ifTrue('Data · Write refused (conflict)?', '$json.conflict === true');
    dConflict.position = [2340, -260];
    const dRetry = ifTrue('Data · Run again after conflict?', '$runIndex < 3');
    dRetry.position = [2600, -260];
    const dBusy = { name: 'Data · Still conflicting', type: 'n8n-nodes-base.stopAndError', typeVersion: 1, position: [2860, -160],
      parameters: { errorMessage: 'conflict: This was changed at the same time by another request. Please try again.' } };
    const dRows = code('Data · Rows', `// The rows of the step are what the calling node receives, as the Postgres node returned them.
return $('Data · Run').first().json.rows.map((json) => ({ json }));`);
    dRows.position = [2340, 0];
    dataNodes.push(entry, dRead, dRun, dNeedFiles, dFiles.list, dFiles.toFile, dFiles.save, dNeed, dWrite, dConflict, dRetry, dBusy, dRows);
    link(entry.name, dRead.name);
    link(dRead.name, dRun.name);
    link(dRun.name, dNeedFiles.name);
    link(dNeedFiles.name, dFiles.list.name, { output: 0 });
    link(dNeedFiles.name, dNeed.name, { output: 1 });
    link(dFiles.list.name, dFiles.toFile.name);
    link(dFiles.toFile.name, dFiles.save.name);
    link(dFiles.save.name, dNeed.name);
    link(dNeed.name, dWrite.name, { output: 0 });
    link(dNeed.name, dRows.name, { output: 1 });
    link(dWrite.name, dConflict.name);
    link(dConflict.name, dRetry.name, { output: 0 });
    link(dConflict.name, dRows.name, { output: 1 });
    link(dRetry.name, dRead.name, { output: 0 });
    link(dRetry.name, dBusy.name, { output: 1 });
  }


  /* ---- internal call router ---- */
  const routerNodes = [];
  {
    const trigger = { name: 'Internal call', type: T.subTrigger, typeVersion: 1.1, parameters: { inputSource: 'passthrough' }, position: [0, 0],
      notes: 'Every call-in of the platform starts here: an Execute Workflow node (or an agent tool) calls this workflow with __call = the section id.' };
    const targets = [{ value: DATA_SECTION, label: 'Data · database step (Google Sheets)', entry: 'Data' },
      ...converted.filter((s) => s.kind === 'called').map((s) => ({ value: s.wf.id, label: s.wf.name.slice(0, 60), entry: s.entry }))];
    const route = switchNode('Route internal call', '$json.__call', targets.map(({ value, label }) => ({ value, label })));
    route.position = [300, 0];
    const unknown = { name: 'Unknown internal call', type: 'n8n-nodes-base.stopAndError', typeVersion: 1,
      parameters: { errorMessage: '=Unknown internal call: {{ $json.__call }}' }, position: [600, 160] };
    routerNodes.push(trigger, route, unknown);
    link(trigger.name, route.name);
    targets.forEach((s, i) => link(route.name, s.entry, { output: i }));
    link(route.name, unknown.name, { output: targets.length });
  }

  /* ---- libraries ---- */
  const libNodes = LIBRARIES.map((lib, i) => ({
    name: lib.name, type: T.code, typeVersion: 2, disabled: true, position: [0, i * 180],
    notes: lib.about, notesInFlow: true,
    parameters: { mode: 'runOnceForAllItems', jsCode: lib.nodeCode },
  }));
  // The engine: the platform's data rules and functions (formerly SQL), run over the Google Sheets tabs.
  libNodes.push({
    name: 'Library · engine', type: T.code, typeVersion: 2, disabled: true, position: [0, LIBRARIES.length * 180],
    notes: 'The engine (workflows/src/engine): every former database function, the table rules (types, not-null, check, unique, foreign keys) and the Sheets reads and writes. Loaded by "Run API" and "Data · Run". Tested offline by scripts/engine-tests.',
    notesInFlow: true,
    parameters: { mode: 'runOnceForAllItems', jsCode: engineSource() },
  });
  let shared = 0;
  for (const s of converted) {
    for (const n of s.nodes) {
      if (n.type !== T.code) continue;
      const js = shareLibraries(n.parameters.jsCode);
      if (js !== n.parameters.jsCode) { n.parameters.jsCode = js; shared++; }
    }
  }

  /* ---- frames ---- */
  const startedBy = (s) => {
    if (s.kind === 'error') return 'any failed execution of this workflow (Error Trigger).';
    if (s.kind === 'scheduled') return `its schedule, ${s.timers.map((t) => describeRule(t.parameters.rule.interval[0])).join(' and ')}.`;
    const by = callers.get(s.wf.id) || [];
    const events = Object.entries(EVENT_ROUTES).filter(([, id]) => id === s.wf.id).map(([e]) => e);
    return [by.length ? `call-in from ${by.map((c) => `"${c}"`).join(', ')}` : '', events.length ? `the event runner for ${events.join(', ')}` : '']
      .filter(Boolean).join('; ') + '.';
  };
  const COLORS = { core: 4, ai: 6, knowledge: 2, consumers: 7, jobs: 3 };
  const sectionBlocks = converted.map((s) => ({
    title: s.wf.name, owner: ownerOf(s.wf), color: COLORS[category(s.wf)], cat: category(s.wf), nodes: s.nodes,
    body: `${s.wf.meta?.description || ''}\n\n**Started by:** ${startedBy(s)}${s.kind === 'called' ? ` Section id: \`${s.wf.id}\`.` : ''}`,
  }));
  for (const s of converted) {
    for (const [from, types] of Object.entries(s.connections)) {
      for (const [type, outs] of Object.entries(types)) outs.forEach((list, output) => (list || []).forEach((c) => link(from, c.node, { output, input: c.index, type })));
    }
  }

  const order = { core: 0, ai: 1, knowledge: 2, consumers: 3, jobs: 4 };
  sectionBlocks.sort((a, b) => OWNERS.indexOf(a.owner) - OWNERS.indexOf(b.owner) || order[a.cat] - order[b.cat] || a.title.localeCompare(b.title));
  blocks.push(
    { title: 'Shared code', color: 1, nodes: libNodes,
      body: 'Disabled Code nodes that hold the deterministic libraries once. Other Code nodes load them at run time (`new Function(…params.jsCode)`), so each library exists once. These nodes never run.' },
    { title: 'Internal calls', color: 4, nodes: routerNodes,
      body: 'Call-ins: an Execute Workflow node (or an agent tool) calls this same workflow with `__call` = the id of the section to run; the Switch sends the item to that section\'s entry node. The called section returns its last node\'s output to the caller.' },
    ...apiBlocks,
    { title: 'Data (Google Sheets)', color: 4, nodes: dataNodes,
      body: 'Every database step of the sections (formerly a Postgres node) calls this section: it reads the tabs the step needs (one Sheets request), runs the step in the engine for every item, saves the changes (one request) and returns the rows to the caller.' },
    ...sectionBlocks,
  );

  /* ---- layout: frames packed in rows; a sticky note behind each ---- */
  const MAXW = 9000, GAP = 160, PAD = 60, NODE_W = 220, NODE_H = 130;
  let x = 0, y = 0, rowH = 0;
  const overview = sticky('Note · How this workflow is organized', OVERVIEW, { width: 1500, height: 1060, color: 1 });
  overview.position = [0, 0];
  y = 900 + GAP;
  const stickies = [overview];
  let group = null;
  for (const b of blocks) {
    // Every frame carries its owner workflow (W1–W5, or Platform for the shared plumbing) and that owner's colour;
    // each owner starts a new band of rows.
    const owner = b.owner || PLATFORM_OWNER;
    const tag = owner === PLATFORM_OWNER ? owner.label : owner.id;
    const xs = b.nodes.map((n) => n.position[0]), ys = b.nodes.map((n) => n.position[1]);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const w = Math.max(Math.max(...xs) - minX + NODE_W + 2 * PAD, 520);
    const textLines = Math.ceil((b.body.length + b.title.length + 24) / Math.max(40, (w - 40) / 8.5)) + (owner === PLATFORM_OWNER ? 3 : 4);
    const header = 40 + textLines * 24;
    const h = Math.max(...ys) - minY + NODE_H + header + PAD;
    if (x > 0 && (x + w > MAXW || owner !== group)) { x = 0; y += rowH + GAP; rowH = 0; }
    group = owner;
    for (const n of b.nodes) n.position = [Math.round(x + PAD + n.position[0] - minX), Math.round(y + header + n.position[1] - minY)];
    const ownerLine = owner === PLATFORM_OWNER ? '' : `*Owner workflow: ${owner.label}.*\n`;
    const note = sticky(`Note · ${b.title}`, `## ${tag} · ${b.title}\n${ownerLine}${b.body}`, { width: Math.round(w), height: Math.round(h), color: owner.color });
    note.position = [x, y];
    stickies.push(note);
    x += w + GAP;
    rowH = Math.max(rowH, h);
  }

  // Node order: the one Execute Workflow Trigger first (n8n starts every call-in at the first such node).
  const all = [...routerNodes, ...libNodes, ...apiBlocks.flatMap((b) => b.nodes), ...dataNodes, ...converted.flatMap((s) => s.nodes), ...stickies];
  const seen = new Set();
  for (const n of all) {
    if (seen.has(n.name)) throw new Error(`Duplicate node name "${n.name}"`);
    seen.add(n.name);
    n.id = n.id || stableId(`${SELF}:${n.name}`);
    nodes.push(n);
  }
  if (nodes.filter((n) => n.type === T.subTrigger).length !== 1) throw new Error('The platform needs exactly one Execute Workflow Trigger');
  for (const [from, types] of Object.entries(connections)) {
    if (!seen.has(from)) throw new Error(`Connection from unknown node "${from}"`);
    for (const outs of Object.values(types)) for (const list of outs) for (const c of list || []) if (!seen.has(c.node)) throw new Error(`Connection to unknown node "${c.node}"`);
  }

  const timeout = Math.max(600, ...sections.map((wf) => wf.settings?.executionTimeout || 0));
  const description = 'The whole Health Platform in one workflow, with its data in Google Sheets: the public API (one Sheets read, the engine with the Auth Gate and the action, one Sheets write), every schedule, the event dispatcher and runner, the AI sections (Companion, intake, explanations, briefs, MedGemma consult, RAG), the Drive knowledge sync, the guideline sync and the error handler.';
  const wfJson = {
    id: SELF,
    name: NAME,
    nodes,
    connections,
    active: true,
    settings: {
      executionOrder: 'v1',
      // Execution data holds health information: nothing is kept unless a developer switches on DEBUG_EXECUTIONS for a
      // debugging session. Failures are still recorded, without identifiers, in the incidents tab (section 099).
      saveDataSuccessExecution: process.env.DEBUG_EXECUTIONS ? 'all' : 'none',
      saveDataErrorExecution: process.env.DEBUG_EXECUTIONS ? 'all' : 'none',
      saveManualExecutions: !!process.env.DEBUG_EXECUTIONS,
      // One limit for the whole workflow: the longest section (guideline downloads) needs an hour. Model and HTTP nodes
      // have their own shorter time limits.
      executionTimeout: timeout,
      callerPolicy: 'workflowsFromSameOwner',
    },
    meta: { templateCredsSetupCompleted: true, description },
    pinData: {},
    tags: [],
  };
  wfJson.versionId = stableId(`${SELF}:version:${JSON.stringify(nodes.map((n) => [n.name, n.parameters]))}:${JSON.stringify(connections)}`);
  return { workflow: wfJson, stats: { sections: converted.length, called: called.size, shared, apiActions: Object.values(GROUPS).reduce((a, g) => a + Object.keys(g.actions).length, 0) } };
}

const OVERVIEW = `# Health Platform — one workflow
Every part of the platform lives in this workflow. Each coloured frame is one **section** (formerly its own workflow); node names start with the section number.

**Owner workflows**: every frame header starts with the logical workflow it belongs to (docs/graduation/02-solution-design.md §2), and the canvas groups the frames by it, one band of rows each: **W1** Patient data and logging (green, owner Mohamed) · **W2** AI Companion (purple, owner Abdelrhman, Team Lead) · **W3** Clinician decision support (blue, owner Maysaa, Integration Owner) · **W4** Follow-up and care access (orange, owner Amr) · **W5** Safety monitor and evaluation (red, owner Kerolos, Evaluation Owner) · **Platform (shared)**, the plumbing all five use (grey: shared code, internal calls, API, Data, event dispatcher and runner). The API groups \`glucose\`, \`lifestyle\` and \`clinical\` are W1's entry points.

**Data**: a Google spreadsheet, one tab per table (the \`_meta\` tab holds the tab ids). Knowledge documents come from a Google Drive folder; uploaded documents are files on the n8n server. The **engine** (Library · engine) holds every data rule and function and runs them in memory on the tabs a request reads.

**Entry points**
- **API**: \`POST /webhook/api/v1/<group>\` → Request → **Read for request** (only the tabs the action needs) → **Run API** (Auth Gate \`fn_gate\`, then the action, in the engine) → **Write for request** (all changes in one request) → Respond. One execution per request.
- **Data** section: every database step of the other sections calls it (read, run the step in the engine, write, rows back to the caller).
- **Schedules**: each job section keeps its own Schedule Trigger (event dispatcher every minute, reminders, pattern scan, Nightscout, CGM simulator, weekly reviews, briefs, Drive knowledge sync, guideline sync, maintenance). An API request that queued events starts the dispatcher at once.
- **Internal calls**: a section that is called (event consumers, AI flows, RAG search, MedGemma consult) starts at **Internal call**; an Execute Workflow node calls this same workflow with \`__call\` = the section id.
- **Errors**: the Error Trigger (section 099) records failures in the \`incidents\` tab without identifiers.

**Rules that hold everywhere**
- Clinical decisions are deterministic engine functions; AI only interprets, behind the AI gate, the output guard and the verifier.
- No patient data reaches a cloud model unless the patient consented and cloud egress is on; otherwise MedGemma runs locally.
- Edit \`workflows/src/\` and rebuild (\`node workflows/src/build.mjs\`), not this canvas: the next deploy replaces UI edits.

Colours: one per owner workflow, as listed under **Owner workflows** above (this note is yellow).`;
