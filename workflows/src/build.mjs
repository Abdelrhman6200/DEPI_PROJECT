// Generates the platform workflow (one n8n workflow, one file: workflows/n8n/health-platform.json), the Auth Gate's
// route table (database/sheets/api_routes.json) and the AI output schemas (ai/schemas/).
// Run: node workflows/src/build.mjs
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { buildPlatform, routeTable } from './platform.mjs';
import { GOOGLE_AUTH } from './lib.mjs';
import * as core from './core.mjs';
import * as ai from './ai.mjs';
import { SCHEMAS } from './schemas.mjs';
import { documentExtraction } from './documents.mjs';
import * as rag from './rag.mjs';
import * as guidelines from './guidelines.mjs';
import * as quality from './quality.mjs';
import { pushDelivery } from './push.mjs';
import { meterPhoto } from './meter.mjs';
import { heatAlerts } from './heat.mjs';
import { tracing } from './tracing.mjs';
import * as clinic from './clinic.mjs';

// The workflow file (Google Sheets and Drive through the service account) is workflows/n8n/health-platform.json; the
// local flavour for the Sheets stand-in (SHEETS_AUTH=none, no Google credential) goes to workflows/n8n-local/.
const outDir = new URL(GOOGLE_AUTH ? '../n8n/' : '../n8n-local/', import.meta.url);
const schemaDir = new URL('../../ai/schemas/', import.meta.url);
mkdirSync(outDir, { recursive: true });
mkdirSync(schemaDir, { recursive: true });
for (const f of readdirSync(outDir)) if (f.endsWith('.json')) unlinkSync(new URL(f, outDir));
const oldBundle = new URL('../platform-bundle.json', import.meta.url);
if (existsSync(oldBundle)) unlinkSync(oldBundle);

// Every section of the platform (each was its own workflow before). The API groups are built inside the platform.
const sections = [
  core.errorHandler(),
  core.dispatcher(),
  core.eventRunner(),
  ai.companion(),
  ai.intake(),
  ai.patternAnalysis(),
  ai.medicationSafety(),
  ai.labExplanation(),
  ai.afterVisitPlan(),
  ai.weeklyOne(),
  ai.preVisitBrief(),
  documentExtraction(),
  core.weeklyScheduler(),
  core.briefScheduler(),
  rag.ragSearch(),
  rag.ragIngest(),
  rag.ragMaintenance(),
  rag.ragDriveSync(),
  guidelines.guidelineSync(),
  guidelines.guidelineCheck(),
  core.emailDelivery(),
  rag.medgemmaConsult(),
  quality.aiJudge(),
  quality.qualityReport(),
  pushDelivery(),
  meterPhoto(),
  heatAlerts(),
  tracing(),
  ...clinic.clinicSections(),
  core.nightscout(),
  ...core.deterministicWorkflows(),
];
const ids = new Set();
for (const wf of sections) {
  if (ids.has(wf.id)) throw new Error(`Duplicate section id ${wf.id}`);
  ids.add(wf.id);
}

const { workflow: whole, stats } = buildPlatform(sections);

// The API (webhooks -> Request -> ... -> Respond) is its own small workflow, "Health Platform · API": n8n prepares the
// whole workflow for every execution, and the API answers far more often than anything else (measured: about 100 ms
// less per call than inside the 461-node workflow). Its calls into sections (Run section, the dispatcher kick) target the
// platform workflow by id, and its failures go to the platform's Error Trigger (settings.errorWorkflow).
export const API_ID = 'wfHealthPlatApi1';
function splitApi(wf) {
  const byName = new Map(wf.nodes.map((n) => [n.name, n]));
  const hooks = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook').map((n) => n.name);
  const api = new Set([...hooks, 'Request']);
  for (let grew = true; grew;) {
    grew = false;
    for (const n of [...api]) for (const outs of Object.values(wf.connections[n] || {})) for (const list of outs) for (const c of list || []) {
      if (!api.has(c.node)) { api.add(c.node); grew = true; }
    }
  }
  const frame = wf.nodes.find((n) => n.type === 'n8n-nodes-base.stickyNote' && /· API \(/.test(n.parameters.content || ''));
  const libs = new Set();
  for (const n of api) for (const m of JSON.stringify(byName.get(n).parameters).matchAll(/\$\('(Library · [^']+)'\)/g)) libs.add(m[1]);
  // Nothing outside the API may lead into it, and the API leads only to its own nodes.
  for (const [from, types] of Object.entries(wf.connections)) for (const outs of Object.values(types)) for (const list of outs) for (const c of list || []) {
    if (api.has(c.node) && !api.has(from)) throw new Error(`API node "${c.node}" is reached from "${from}" outside the API`);
  }
  const toPlatform = (n) => {
    const c = structuredClone(n);
    if ((c.type === 'n8n-nodes-base.executeWorkflow') && c.parameters.workflowId?.value === '={{ $workflow.id }}') c.parameters.workflowId = { __rl: true, mode: 'id', value: wf.id };
    return c;
  };
  const apiNodes = [...(frame ? [structuredClone(frame)] : []), ...[...api].map((x) => toPlatform(byName.get(x))), ...[...libs].map((x) => structuredClone(byName.get(x)))];
  const pick = (keep) => Object.fromEntries(Object.entries(wf.connections).filter(([from]) => keep(from)));
  const apiWf = { id: API_ID, name: 'Health Platform · API', nodes: apiNodes, connections: pick((n) => api.has(n)),
    settings: { ...wf.settings, errorWorkflow: wf.id }, pinData: {}, active: false, meta: wf.meta,
    description: 'The HTTP API of the platform (/webhook/api/v1/<group>): Auth Gate and action in the engine, one read and one write. Sections run in "Health Platform".' };
  const mainWf = { ...wf, nodes: wf.nodes.filter((n) => !api.has(n.name) && n !== frame), connections: pick((n) => !api.has(n)) };
  return { mainWf, apiWf };
}
const { mainWf: workflow, apiWf } = splitApi(whole);
const file = new URL('health-platform.json', outDir);
writeFileSync(file, JSON.stringify(workflow, null, 1) + '\n');
writeFileSync(new URL('health-platform-api.json', outDir), JSON.stringify(apiWf, null, 1) + '\n');

// The Auth Gate's route table (roles, public, caregiver scope per action) for the api_routes tab: scripts/sheets-setup.mjs
// writes it on every run, so the gate and the workflow always match.
writeFileSync(new URL('../../database/sheets/api_routes.json', import.meta.url),
  JSON.stringify(Object.entries(routeTable()).map(([grp, routes]) => ({ grp, routes })), null, 1) + '\n');
for (const [name, schema] of Object.entries(SCHEMAS)) {
  writeFileSync(new URL(`${name}.schema.json`, schemaDir), JSON.stringify(schema, null, 2) + '\n');
}
const size = Buffer.byteLength(JSON.stringify(workflow, null, 1));
const count = (t) => workflow.nodes.filter((n) => n.type === t).length;
console.log(`Wrote workflows/${GOOGLE_AUTH ? 'n8n' : 'n8n-local'}/health-platform.json: "${workflow.name}" (${workflow.id}), ${workflow.nodes.length} nodes, ${Math.round(size / 1024)} KB; health-platform-api.json: "${apiWf.name}" (${apiWf.id}), ${apiWf.nodes.length} nodes`);
console.log(`  ${stats.sections} sections (${stats.called} reached by call-ins), ${stats.apiActions} API actions, ${count('n8n-nodes-base.webhook')} webhooks, ${count('n8n-nodes-base.scheduleTrigger')} schedules, ${stats.shared} Code nodes on the shared libraries`);
console.log(`  and database/sheets/api_routes.json, ${Object.keys(SCHEMAS).length} schemas in ai/schemas/`);
