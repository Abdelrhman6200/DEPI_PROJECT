// Workflow generator library. Node shapes match n8n 2.42 (verified with `n8n export:nodes`).
// Workflows are generated from source so that every API route, prompt and contract lives in Git
// and is reviewable, and so that production logic never exists only inside the n8n UI.
import { randomUUID, createHash } from 'node:crypto';
import { sqlStep } from './sheets-steps.mjs';
import { tablesFor } from './engine/deps.mjs';

export const CRED = {
  google: { id: 'credGoogleSA0001', name: 'Google Sheets & Drive (service account)' },
  gemini: { id: 'credGeminiApi001', name: 'Gemini (Google AI Studio)' },
  ollama: { id: 'credOllamaLocal1', name: 'Ollama (local)' },
  smtp: { id: 'credSmtpMail0001', name: 'Email (SMTP)' },
};

// The platform is one n8n workflow (WF.platform). The other ids name its sections: an Execute Workflow node calls a
// section by calling the platform itself with __call = the section id (see platform.mjs). The ids are also the event
// routes stored with each claimed outbox event.
export const WF = {
  platform: 'wfHealthPlatform',
  errorHandler: 'wf099ErrorHandlr',
  dispatcher: 'wfCoreEventDisp1',
  eventRunner: 'wfCoreEventRunr1',
  companion: 'wf001CompanionAI',
  intake: 'wf002IntakeAgent',
  followup: 'wf003EpisodeFlwp',
  glucoseEvent: 'wf004GlucoseEvnt',
  pattern: 'wf005PatternAnly',
  patternScan: 'wf005bPatternScn',
  weekly: 'wf006WeeklyRevw1',
  weeklyOne: 'wf006bWeeklyOne1',
  medSafety: 'wf007MedSafetyEx',
  lab: 'wf008LabExplain1',
  brief: 'wf009PreVisitBrf',
  briefScheduler: 'wf009bBriefSched',
  afterVisit: 'wf010AfterVisitP',
  reminders: 'wf011RemindersAl',
  referral: 'wf014ReferralNtf',
  referralAging: 'wf015ReferralAge',
  capacity: 'wf016CapacityUpd',
  nightscout: 'wf017Nightscout1',
  transfer: 'wf017TransferNtf',
  cgmSim: 'wf017bCgmSimultr',
  docExtract: 'wf018DocExtract1',
  ragIngest: 'wf019RagIngest01',
  ragSearch: 'wf022RagSearch01',
  ragMaintenance: 'wf019bRagMaint01',
  ragDrive: 'wf019cRagDrive01',
  guidelineSync: 'wf024GuidelnSync',
  guidelineCheck: 'wf024bGuidelnChk',
  medgemma: 'wf021MedGemmaCns',
  email: 'wf023EmailSend01',
  dailyMaintenance: 'wf020DailyMaint1',
  judge: 'wf025AiJudge0001',
  qualityReport: 'wf026QualityRpt1',
  push: 'wf027WebPush0001',
  meterPhoto: 'wf028MeterPhoto1',
  heat: 'wf029HeatAlerts1',
  tracing: 'wf030Tracing0001',
  // Polyclinic (clinic.mjs).
  clinicTriage: 'wf040ClinicTriag',
  clinicPrep: 'wf041ClinicPrep1',
  clinicBrief: 'wf042ClinicBrief',
  clinicRx: 'wf043ClinicRxArb',
  clinicHints: 'wf044ClinicHints',
};

export const stableId = (seed) => {
  const h = createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** Create a workflow builder (one section of the platform). Nodes are added with add(); connections with link(). */
// Sections that may legitimately run longer than 10 minutes (document reading, embeddings, guideline downloads). The
// platform workflow takes the longest of these as its time limit.
const LONG_RUNNING = {};
export function workflow({ id, name, tags = [], description = '', active = true, settings = {} }) {
  if (!Object.keys(LONG_RUNNING).length) Object.assign(LONG_RUNNING, { [WF.docExtract]: 1800, [WF.ragIngest]: 2400, [WF.guidelineSync]: 3600, [WF.guidelineCheck]: 3600, [WF.ragMaintenance]: 1800 });
  const nodes = [];
  const connections = {};
  const wf = {
    id,
    name,
    nodes,
    connections,
    add(node) {
      if (nodes.find((n) => n.name === node.name)) throw new Error(`Duplicate node name "${node.name}" in ${name}`);
      node.id = node.id || stableId(`${id}:${node.name}`);
      nodes.push(node);
      return node.name;
    },
    /** Connect from -> to. type: 'main' | 'ai_languageModel' | 'ai_tool' | 'ai_outputParser' | 'ai_memory' */
    link(from, to, { output = 0, input = 0, type = 'main' } = {}) {
      connections[from] = connections[from] || {};
      connections[from][type] = connections[from][type] || [];
      while (connections[from][type].length <= output) connections[from][type].push([]);
      connections[from][type][output].push({ node: to, type, index: input });
      return wf;
    },
    chain(...names) {
      for (let i = 0; i < names.length - 1; i++) wf.link(names[i], names[i + 1]);
      return wf;
    },
    build() {
      layout(nodes, connections);
      return {
        id,
        name,
        nodes,
        connections,
        active,
        settings: {
          executionOrder: 'v1',
          errorWorkflow: id === WF.errorHandler ? undefined : WF.errorHandler,
          // Execution data holds health information: nothing is kept unless a developer switches on DEBUG_EXECUTIONS for a
          // debugging session. Failures are still recorded, without identifiers, in app.incidents (WF-099).
          saveDataSuccessExecution: process.env.DEBUG_EXECUTIONS ? 'all' : 'none',
          saveDataErrorExecution: process.env.DEBUG_EXECUTIONS ? 'all' : 'none',
          saveManualExecutions: !!process.env.DEBUG_EXECUTIONS,
          // Every run has a time limit (seconds); model-heavy batch work on a CPU server gets longer.
          executionTimeout: LONG_RUNNING[id] ?? 600,
          callerPolicy: 'workflowsFromSameOwner',
          ...settings,
        },
        meta: { templateCredsSetupCompleted: true, description },
        pinData: {},
        tags: [],
        versionId: stableId(`${id}:version:${JSON.stringify(nodes.map((n) => n.parameters))}`),
      };
    },
  };
  return wf;
}

/** Simple layered layout: x by longest path from a trigger, y by order within a layer. AI sub-nodes sit below their parent. */
export function layout(nodes, connections) {
  const byName = Object.fromEntries(nodes.map((n) => [n.name, n]));
  const mainEdges = [];
  const subParent = {};
  for (const [from, types] of Object.entries(connections)) {
    for (const [type, outs] of Object.entries(types)) {
      for (const out of outs) for (const c of out) {
        if (type === 'main') mainEdges.push([from, c.node]);
        else subParent[from] = c.node;
      }
    }
  }
  const depth = {};
  const incoming = new Set(mainEdges.map((e) => e[1]));
  const roots = nodes.filter((n) => !incoming.has(n.name) && !subParent[n.name]).map((n) => n.name);
  for (const r of roots) depth[r] = 0;
  for (let i = 0; i < nodes.length + 2; i++) {
    for (const [a, b] of mainEdges) {
      if (depth[a] !== undefined && (depth[b] === undefined || depth[b] < depth[a] + 1) && depth[a] + 1 < 60) depth[b] = depth[a] + 1;
    }
  }
  const rows = {};
  for (const n of nodes) {
    if (subParent[n.name]) continue;
    const d = depth[n.name] ?? 0;
    rows[d] = rows[d] || 0;
    n.position = [d * 280, rows[d] * 200];
    rows[d]++;
  }
  // AI sub-nodes (model, parser, tools) sit under their parent, in a band below the main flow so a wide row of tools
  // never covers other nodes. Fans of different parents that would overlap go into further bands.
  const groups = {};
  for (const n of nodes) if (subParent[n.name]) (groups[subParent[n.name]] = groups[subParent[n.name]] || []).push(n);
  const mainYs = nodes.filter((n) => !subParent[n.name]).map((n) => n.position[1]);
  const top = (mainYs.length ? Math.max(...mainYs) : 0) + 240;
  const bands = [];
  for (const [p, subs] of Object.entries(groups).sort((a, b) => byName[a[0]].position[0] - byName[b[0]].position[0])) {
    const x0 = byName[p].position[0] - 160, x1 = x0 + subs.length * 140;
    let band = bands.findIndex((used) => used.every(([a, b]) => x1 + 40 <= a || x0 >= b + 40));
    if (band < 0) { bands.push([]); band = bands.length - 1; }
    bands[band].push([x0, x1]);
    subs.forEach((n, i) => { n.position = [x0 + i * 140, top + band * 180]; });
  }
}

/* ------------------------------------------------------------------ nodes */

export const webhook = (name, path, extra = {}) => ({
  name,
  type: 'n8n-nodes-base.webhook',
  typeVersion: 2.1,
  webhookId: stableId(`webhook:${path}`),
  // Browsers reach the API through the web app's same-origin proxy; no other site may call it from a browser.
  parameters: { httpMethod: 'POST', path, responseMode: 'responseNode', options: { allowedOrigins: process.env.APP_URL || 'http://localhost:3000' }, ...extra },
});

export const respond = (name) => ({
  name,
  type: 'n8n-nodes-base.respondToWebhook',
  typeVersion: 1.4,
  parameters: {
    respondWith: 'firstIncomingItem',
    options: {
      responseCode: "={{ $json.ok ? 200 : ({ unauthorized: 401, forbidden: 403, not_found: 404, bad_request: 400, unknown_action: 404 })[$json.error?.code] || 500 }}",
    },
  },
});

/**
 * A database step. The SQL (kept here as the specification) becomes the engine step of workflows/src/sheets-steps.mjs;
 * the node calls the platform's "Data" section, which reads the tabs the step needs from Google Sheets, runs it for
 * every item and writes the changes back. params: an n8n expression that evaluates to the array of $1, $2, …
 */
export const DATA_SECTION = 'data';
const STEP_FIELDS = ['sql', 'expr', 'args', 'ranges', 'mode'];
function dataStepInputs(query, params, step = sqlStep(query)) {
  const ranges = ['_meta', ...tablesFor({ expr: step.expr })];
  return {
    mappingMode: 'defineBelow',
    value: { expr: step.expr, args: `={{ JSON.stringify(${params || '[]'}) }}`, ranges: ranges.join(','), mode: step.mode, sql: query ? query.trim().replace(/\s+/g, ' ').slice(0, 1500) : '(engine step)' },
    matchingColumns: [],
    schema: STEP_FIELDS.map((k) => ({ id: k, displayName: k, required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string', removed: false })),
    attemptToConvertTypes: false,
    convertFieldsToString: false,
  };
}
export const pg = (name, query, params, { onError, alwaysOutput, executeOnce } = {}) => ({
  name,
  type: 'n8n-nodes-base.executeWorkflow',
  typeVersion: 1.2,
  ...(onError ? { onError } : {}),
  ...(alwaysOutput ? { alwaysOutputData: true } : {}),
  ...(executeOnce ? { executeOnce: true } : {}),
  parameters: {
    workflowId: { __rl: true, mode: 'list', value: DATA_SECTION, cachedResultName: DATA_SECTION },
    workflowInputs: dataStepInputs(query, params),
    mode: 'once',
    options: { waitForSubWorkflow: true },
  },
});

export const code = (name, jsCode, { mode = 'runOnceForAllItems', onError } = {}) => ({
  name,
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  ...(onError ? { onError } : {}),
  parameters: { mode, jsCode: jsCode.trim() },
});

let condCounter = 0;
const condition = (leftValue, rightValue, operation = 'equals', type = 'string') => ({
  id: stableId(`cond:${leftValue}:${rightValue}:${operation}:${condCounter++}`),
  leftValue,
  rightValue,
  operator: { type, operation, ...(operation === 'true' || operation === 'false' || operation === 'exists' || operation === 'notExists' ? { singleValue: true } : {}) },
});

/** Switch on an expression value. cases: array of string keys. Last output is the fallback. */
export const switchOn = (name, valueExpr, cases) => ({
  name,
  type: 'n8n-nodes-base.switch',
  typeVersion: 3.2,
  parameters: {
    rules: {
      values: cases.map((c) => ({
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
          conditions: [condition(`={{ ${valueExpr} }}`, c)],
          combinator: 'and',
        },
        renameOutput: true,
        outputKey: c,
      })),
    },
    looseTypeValidation: true,
    options: { fallbackOutput: 'extra', renameFallbackOutput: 'unknown' },
  },
});

/** IF node on a boolean expression. Output 0 = true, 1 = false. */
export const ifTrue = (name, boolExpr) => ({
  name,
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [condition(`={{ ${boolExpr} }}`, '', 'true', 'boolean')],
      combinator: 'and',
    },
    looseTypeValidation: true,
    options: {},
  },
});

export const subTrigger = (name = 'When called by another workflow') => ({
  name,
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  typeVersion: 1.1,
  parameters: { inputSource: 'passthrough' },
});

export const execWorkflow = (name, workflowIdOrExpr, { onError, waitForSubWorkflow = true, inputs } = {}) => ({
  name,
  type: 'n8n-nodes-base.executeWorkflow',
  typeVersion: 1.2,
  ...(onError ? { onError } : {}),
  parameters: {
    workflowId: workflowIdOrExpr.startsWith('=')
      ? { __rl: true, mode: 'id', value: workflowIdOrExpr }
      : { __rl: true, mode: 'list', value: workflowIdOrExpr, cachedResultName: workflowIdOrExpr },
    workflowInputs: inputs
      ? {
          mappingMode: 'defineBelow',
          value: inputs,
          matchingColumns: [],
          schema: Object.keys(inputs).map((k) => ({ id: k, displayName: k, required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string', removed: false })),
          attemptToConvertTypes: false,
          convertFieldsToString: true,
        }
      : { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true },
    mode: 'once',
    options: { waitForSubWorkflow },
  },
});

export const schedule = (name, rule) => ({
  name,
  type: 'n8n-nodes-base.scheduleTrigger',
  typeVersion: 1.2,
  parameters: { rule: { interval: [rule] } },
});

export const errorTrigger = (name = 'On workflow error') => ({
  name,
  type: 'n8n-nodes-base.errorTrigger',
  typeVersion: 1,
  parameters: {},
});

export const loop = (name, batchSize = 1) => ({
  name,
  type: 'n8n-nodes-base.splitInBatches',
  typeVersion: 3,
  parameters: { batchSize, options: {} },
});

export const wait = (name, seconds) => ({
  name,
  type: 'n8n-nodes-base.wait',
  typeVersion: 1.1,
  webhookId: stableId(`wait:${name}:${seconds}`),
  parameters: { resume: 'timeInterval', amount: seconds, unit: 'seconds' },
});

/** HTTP POST with a JSON body built by an expression (bodyExpr must evaluate to an object). */
export const httpJson = (name, urlExpr, bodyExpr, { onError, timeout = 60000 } = {}) => ({
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  ...(onError ? { onError } : {}),
  parameters: {
    method: 'POST',
    url: `=${urlExpr}`,
    sendBody: true,
    specifyBody: 'json',
    jsonBody: `={{ JSON.stringify(${bodyExpr}) }}`,
    options: { timeout },
  },
});

/** HTTP GET. responseFormat 'json' (default) | 'text' (body in $json.data, or $json.body with fullResponse) | 'file'
 *  (binary property "data"). neverError: non-2xx answers (e.g. 304 Not Modified) arrive as normal output. */
export const httpGet = (name, urlExpr, { onError, timeout = 20000, headersExpr, fullResponse = false, noRedirects = false, responseFormat, neverError = false } = {}) => ({
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  ...(onError ? { onError } : {}),
  parameters: {
    url: `=${urlExpr}`,
    ...(headersExpr ? { sendHeaders: true, specifyHeaders: 'json', jsonHeaders: `={{ JSON.stringify(${headersExpr}) }}` } : {}),
    options: {
      timeout,
      // One output item per request ({ body, headers, statusCode }) instead of one item per array element.
      ...(fullResponse || responseFormat || neverError
        ? { response: { response: { ...(fullResponse ? { fullResponse: true } : {}), ...(neverError ? { neverError: true } : {}),
                                    responseFormat: responseFormat || 'json', ...(responseFormat === 'file' ? { outputPropertyName: 'data' } : {}) } } }
        : {}),
      ...(noRedirects ? { redirect: { redirect: { followRedirects: false } } } : {}),
    },
  },
});

/* --------------------------------------------------------------- AI nodes */

export const OLLAMA_URL_EXPR = "{{ $env.OLLAMA_URL || 'http://host.docker.internal:11434' }}";

// LLM_PROVIDER=ollama at build time swaps Gemini for a local tool-calling model (offline testing only).
export const gemini = (name = 'Gemini', opts = {}) => (process.env.LLM_PROVIDER === 'ollama' ? localAgentModel(name, opts) : geminiNode(name, opts));

const localAgentModel = (name, { temperature = 0.3 } = {}) => ({
  name,
  type: '@n8n/n8n-nodes-langchain.lmChatOllama',
  typeVersion: 1,
  credentials: { ollamaApi: CRED.ollama },
  parameters: { model: "={{ $env.AGENT_OLLAMA_MODEL || 'qwen3.5:9b' }}", options: { temperature, think: false, keepAlive: '30m', numCtx: 16384 } },
});

// Explicit safety settings, so behaviour does not drift with the API defaults. Dangerous content blocks only at HIGH:
// hypoglycemia, overdose and self-harm warnings are legitimate topics here and are handled by the deterministic
// emergency pre-screen and guards, not by the provider filter.
const GEMINI_SAFETY = [
  ['HARM_CATEGORY_HARASSMENT', 'BLOCK_MEDIUM_AND_ABOVE'],
  ['HARM_CATEGORY_HATE_SPEECH', 'BLOCK_MEDIUM_AND_ABOVE'],
  ['HARM_CATEGORY_SEXUALLY_EXPLICIT', 'BLOCK_MEDIUM_AND_ABOVE'],
  ['HARM_CATEGORY_DANGEROUS_CONTENT', 'BLOCK_ONLY_HIGH'],
].map(([category, threshold]) => ({ category, threshold }));

// Two model tiers: 'main' (GEMINI_MODEL) for the Companion agent, the verifiers and the pre-visit brief; 'lite'
// (GEMINI_MODEL_LITE) for the frequent, simpler jobs (intake extraction, event explanations). The credential points at
// the Gemini gateway (scripts/gemini-gateway.mjs), which moves to the next model of the chain when one is busy.
export const GEMINI_DEFAULTS = { main: 'gemini-3.8-flash', lite: 'gemini-3.5-flash-lite' };
export const geminiModelExpr = (tier = 'main') => (tier === 'lite'
  ? `($env.GEMINI_MODEL_LITE || '${GEMINI_DEFAULTS.lite}')`
  : `($env.GEMINI_MODEL || '${GEMINI_DEFAULTS.main}')`);

const geminiNode = (name, { temperature = 0.3, maxOutputTokens = 2048, tier = 'main' } = {}) => ({
  name,
  type: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini',
  typeVersion: 1,
  credentials: { googlePalmApi: CRED.gemini },
  parameters: {
    modelName: `={{ 'models/' + ${geminiModelExpr(tier)} }}`,
    options: { temperature, maxOutputTokens, safetySettings: { values: GEMINI_SAFETY } },
  },
});

// numPredict caps the answer: both prompts ask for at most 120-180 words, and medgemma:4b can loop on one bullet until
// the context is full (seen: 49 s of the same line).
export const medgemma = (name = 'MedGemma (Ollama)', { temperature = 0.2, numPredict = 600 } = {}) => ({
  name,
  type: '@n8n/n8n-nodes-langchain.lmChatOllama',
  typeVersion: 1,
  credentials: { ollamaApi: CRED.ollama },
  parameters: {
    model: "={{ $env.MEDGEMMA_MODEL || 'medgemma:4b' }}",
    options: { temperature, think: false, keepAlive: '30m', numCtx: 8192, numPredict },
  },
});

export const agent = (name, { text, systemMessage, outputParser = false, maxIterations = 6, onError }) => ({
  name,
  type: '@n8n/n8n-nodes-langchain.agent',
  typeVersion: 2.2,
  ...(onError ? { onError } : {}),
  parameters: {
    promptType: 'define',
    text,
    hasOutputParser: outputParser,
    options: { systemMessage, maxIterations, returnIntermediateSteps: false, enableStreaming: false },
  },
});

/** Basic LLM chain with a system message and a user prompt. */
export const chain = (name, { system, prompt, outputParser = false, onError }) => ({
  name,
  type: '@n8n/n8n-nodes-langchain.chainLlm',
  typeVersion: 1.7,
  ...(onError ? { onError } : {}),
  parameters: {
    promptType: 'define',
    text: prompt,
    hasOutputParser: outputParser,
    messages: { messageValues: [{ type: 'SystemMessagePromptTemplate', message: system }] },
  },
});

export const outputParser = (name, jsonSchema, { autoFix = false } = {}) => ({
  name,
  type: '@n8n/n8n-nodes-langchain.outputParserStructured',
  typeVersion: 1.3,
  parameters: { schemaType: 'manual', inputSchema: JSON.stringify(jsonSchema, null, 2), autoFix },
});

/** A database step written in JavaScript over the engine functions (expr, with `a` = the parameters) — see pg. */
export const jsStep = (name, expr, params, { mode = 'one', onError, alwaysOutput, executeOnce } = {}) => ({
  name,
  type: 'n8n-nodes-base.executeWorkflow',
  typeVersion: 1.2,
  ...(onError ? { onError } : {}),
  ...(alwaysOutput ? { alwaysOutputData: true } : {}),
  ...(executeOnce ? { executeOnce: true } : {}),
  parameters: {
    workflowId: { __rl: true, mode: 'list', value: DATA_SECTION, cachedResultName: DATA_SECTION },
    workflowInputs: dataStepInputs(null, params, { expr, mode }),
    mode: 'once',
    options: { waitForSubWorkflow: true },
  },
});

/** A database step exposed to an agent as a tool (see pg). Use $fromAI() in params for model-supplied args. */
export const pgTool = (name, description, query, params) => ({
  name,
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  typeVersion: 2.2,
  parameters: {
    description,
    workflowId: { __rl: true, mode: 'list', value: DATA_SECTION, cachedResultName: DATA_SECTION },
    workflowInputs: dataStepInputs(query, params),
  },
});

/* ------------------------------------------------------------------------------------------- Google Sheets I/O */

// Every Sheets and Drive request signs in with the Google service account credential. SHEETS_AUTH=none builds the
// local flavour for the stand-in (scripts/sheets-emulator.mjs) into workflows/n8n-local/ (n8n does not accept an
// expression for the authentication of an HTTP Request node, so the choice is made at build time).
export const GOOGLE_AUTH = process.env.SHEETS_AUTH !== 'none';
const googleAuth = () => (GOOGLE_AUTH ? { authentication: 'predefinedCredentialType', nodeCredentialType: 'googleApi' } : { authentication: 'none' });
const googleCred = () => (GOOGLE_AUTH ? { credentials: { googleApi: CRED.google } } : {});
// Uploaded documents are kept on the n8n server, in this folder (n8n allows its file nodes only under ~/.n8n-files).
export const FILES_DIR = '/home/node/.n8n-files/';
// Uploaded documents are encrypted on disk (AES-256-GCM, key DATA_ENCRYPTION_KEY: 64 hex characters in .env). A file
// is "HPENC1" + 12-byte IV + 16-byte tag + ciphertext, kept as base64 like before. Without a key nothing is written
// (no silent plaintext); a file from before encryption (no marker) is read as it is.
export const FILE_CRYPTO = String.raw`
const _fcCrypto = require('crypto');
const _FC_MAGIC = Buffer.from('HPENC1');
function _fcKey() {
  const k = String($env.DATA_ENCRYPTION_KEY || '');
  if (!/^[0-9a-fA-F]{64}$/.test(k)) throw new Error('DATA_ENCRYPTION_KEY is missing or not 64 hex characters: documents are not stored unencrypted. Run scripts/setup.sh or add the key to .env.');
  return Buffer.from(k, 'hex');
}
function encryptFile(b64) {
  if (!b64) return b64;
  const iv = _fcCrypto.randomBytes(12);
  const c = _fcCrypto.createCipheriv('aes-256-gcm', _fcKey(), iv);
  const ct = Buffer.concat([c.update(Buffer.from(b64, 'base64')), c.final()]);
  return Buffer.concat([_FC_MAGIC, iv, c.getAuthTag(), ct]).toString('base64');
}
function decryptFile(b64) {
  if (!b64) return b64;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 34 || !buf.subarray(0, 6).equals(_FC_MAGIC)) return b64;
  const d = _fcCrypto.createDecipheriv('aes-256-gcm', _fcKey(), buf.subarray(6, 18));
  d.setAuthTag(buf.subarray(18, 34));
  return Buffer.concat([d.update(buf.subarray(34)), d.final()]).toString('base64');
}
`;
export const SHEETS_BASE = "($env.SHEETS_API_URL || 'https://sheets.googleapis.com') + '/v4/spreadsheets/' + $env.SHEETS_ID";
export const DRIVE_BASE = "($env.DRIVE_API_URL || 'https://www.googleapis.com') + '/drive/v3'";
// Quota answers (429) and short outages are retried; Sheets allows 60 reads and 60 writes a minute per account.
const RETRY = { retryOnFail: true, maxTries: 4, waitBetweenTries: 5000 };

/**
 * Reads whole tabs: rangesExpr is an n8n expression giving the tab names (an array). One request for all of them.
 * scope (local store only): { token, patient } expressions. The store then returns only the caller's patients' rows of
 * its large per-patient tabs (with their row numbers); the engine still checks access. Google ignores nothing here: the
 * headers are not sent in the Google build.
 */
export const sheetsRead = (name, rangesExpr, { onError, scope } = {}) => ({
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  executeOnce: true,
  ...RETRY,
  ...(onError ? { onError } : {}),
  ...googleCred(),
  parameters: {
    method: 'GET',
    url: `={{ ${SHEETS_BASE} + '/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&majorDimension=ROWS&' + (${rangesExpr}).map((r) => 'ranges=' + encodeURIComponent(r)).join('&') }}`,
    ...googleAuth(),
    ...(scope && !GOOGLE_AUTH ? { sendHeaders: true, headerParameters: { parameters: [
      { name: 'x-scope-token', value: `={{ ${scope.token} }}` },
      { name: 'x-scope-patient', value: `={{ ${scope.patient} }}` }] } } : {}),
    options: { timeout: 30000 },
  },
});

/**
 * Writes the changes of a request: writeExpr is an n8n expression giving the engine's write ({ requests, guards }, see
 * dbWrites) or just the batchUpdate requests (an array). The guards go to the Sheets cache (scripts/sheets-cache.mjs),
 * which checks them inside its write lock and removes them; a refused write answers { conflict: true } (status 200, so
 * the node's retries are kept for quota and outages) and the workflow runs the request again. Google itself does not
 * accept the guards: with n8n talking to Google directly, set SHEETS_WRITE_GUARDS=off (no guards, and no row
 * compaction, which is only safe behind the cache).
 */
const WRITE_BODY = (writeExpr) => `((w) => { const g = $env.SHEETS_WRITE_GUARDS !== 'off'; const reqs = Array.isArray(w) ? w : (w.requests || []); `
  + `return g && !Array.isArray(w) && w.guards ? { requests: reqs, guards: w.guards } : { requests: reqs.filter((r) => !r.deleteDimension) }; })(${writeExpr})`;
export const sheetsWrite = (name, writeExpr, { onError } = {}) => ({
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  executeOnce: true,
  ...RETRY,
  ...(onError ? { onError } : {}),
  ...googleCred(),
  parameters: {
    method: 'POST',
    url: `={{ ${SHEETS_BASE} + ':batchUpdate' }}`,
    ...googleAuth(),
    sendBody: true,
    specifyBody: 'json',
    jsonBody: `={{ JSON.stringify(${WRITE_BODY(writeExpr)}) }}`,
    options: { timeout: 30000 },
  },
});

/** A Google Drive GET (list, metadata, download or export); urlExpr is an expression for the path after /drive/v3. */
// paginate: follow Drive's nextPageToken (one output item per page, at most 50 pages). A failed page fails the node, so
// a caller never sees a partial listing as complete.
export const driveGet = (name, pathExpr, { onError, responseFormat, paginate = false } = {}) => ({
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  ...RETRY,
  ...(onError ? { onError } : {}),
  ...googleCred(),
  parameters: {
    method: 'GET',
    url: `={{ ${DRIVE_BASE} + ${pathExpr} }}`,
    ...googleAuth(),
    options: {
      timeout: 60000,
      ...(responseFormat ? { response: { response: { responseFormat, ...(responseFormat === 'file' ? { outputPropertyName: 'data' } : {}) } } } : {}),
      ...(paginate ? { pagination: { pagination: {
        paginationMode: 'updateAParameterInEachRequest',
        parameters: { parameters: [{ type: 'qs', name: 'pageToken', value: '={{ $response.body.nextPageToken }}' }] },
        paginationCompleteWhen: 'other', completeExpression: '={{ !$response.body.nextPageToken }}',
        limitPagesFetched: true, maxRequests: 50, requestInterval: 200,
      } } } : {}),
    },
  },
});

/** Call another workflow as an agent tool. inputs: {fieldName: expression} */
export const workflowTool = (name, description, workflowId, inputs) => ({
  name,
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  typeVersion: 2.2,
  parameters: {
    description,
    workflowId: { __rl: true, mode: 'list', value: workflowId, cachedResultName: workflowId },
    workflowInputs: {
      mappingMode: 'defineBelow',
      value: inputs,
      matchingColumns: [],
      schema: Object.keys(inputs).map((k) => ({
        id: k, displayName: k, required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string', removed: false,
      })),
      attemptToConvertTypes: false,
      convertFieldsToString: false,
    },
  },
});

export const subTriggerWithInputs = (name, fields) => ({
  name,
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  typeVersion: 1.1,
  parameters: { workflowInputs: { values: fields.map((f) => ({ name: f, type: 'string' })) } },
});

/** Wire a chat model / parser / tools into a root AI node. */
export function wireAI(wf, root, { model, parser, tools = [], fallbackModel }) {
  if (model) wf.link(model, root, { type: 'ai_languageModel' });
  if (fallbackModel) wf.link(fallbackModel, root, { type: 'ai_languageModel', input: 1 });
  if (parser) wf.link(parser, root, { type: 'ai_outputParser' });
  for (const t of tools) wf.link(t, root, { type: 'ai_tool' });
}
