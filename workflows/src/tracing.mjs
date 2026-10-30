// WF-030 · Tracing. Every 2 minutes, finished AI runs and job runs not yet traced go to Langfuse (self-hosted in
// Docker, scripts/set-langfuse.mjs). Each is a trace tagged with its logical workflow (W1-W5), with the judge's five
// rubric scores as Langfuse scores. Metadata only: workflow, status, model, latency, release, risk signals, verifier
// result, judge scores. No message text, no patient or user id; the AI run's own id is the trace id. Rows Langfuse did
// not accept are sent again next time. Without Langfuse configured the section does nothing.
import { workflow, jsStep, code, ifTrue, schedule, subTrigger, WF } from './lib.mjs';

const LANGFUSE_ON = '!!$env.LANGFUSE_PUBLIC_KEY && !!$env.LANGFUSE_SECRET_KEY && !!$env.LANGFUSE_HOST';

const BUILD = String.raw`
const items = $input.all().map((i) => i.json).filter((x) => x && x.id !== undefined);
const ts = (x) => new Date(x || Date.now()).toISOString();
const batch = [];
const events = [];
for (const x of items) {
  // Judge scores for a run traced earlier: only scores, on that run's trace.
  if (x.kind === 'trial') {
    const j = (x.outputs || {}).judge || {};
    let first = null;
    for (const k of ['factual_accuracy', 'grounded', 'safety', 'format_adherence', 'bias']) {
      if (typeof j[k] !== 'number') continue;
      const ev = 'score-' + x.trace_id + '-' + k;
      first = first || ev;
      batch.push({ id: ev, type: 'score-create', timestamp: ts(x.end), body: {
        id: x.trace_id + '-' + k, traceId: String(x.trace_id), name: k === 'grounded' ? 'groundedness' : k === 'safety' ? 'safety_compliance' : k, value: j[k], dataType: 'NUMERIC' } });
    }
    events.push({ kind: 'trial', id: x.id, event: first });
    continue;
  }
  const traceId = x.kind === 'job' ? 'job-' + x.id : String(x.id);
  events.push({ kind: x.kind, id: x.id, event: 'trace-' + traceId });
  const status = (x.outputs || {}).status || null;
  const duration_ms = x.start && x.end ? (Date.parse(x.end) - Date.parse(x.start)) : null;
  const tags = (x.tags || []).concat(x.error ? ['error'] : []);
  batch.push({ id: 'trace-' + traceId, type: 'trace-create', timestamp: ts(x.end || x.start), body: {
    id: traceId, name: x.name, timestamp: ts(x.start), input: x.inputs, output: x.outputs,
    metadata: { ...x.metadata, kind: x.kind, status, error: x.error || null, duration_ms },
    tags } });
  const j = x.outputs && x.outputs.judge;
  if (j) for (const k of ['factual_accuracy', 'grounded', 'safety', 'format_adherence', 'bias']) {
    if (typeof j[k] === 'number') batch.push({ id: 'score-' + traceId + '-' + k, type: 'score-create', timestamp: ts(x.end), body: {
      id: traceId + '-' + k, traceId, name: k === 'grounded' ? 'groundedness' : k === 'safety' ? 'safety_compliance' : k, value: j[k], dataType: 'NUMERIC' } });
  }
}
const auth = 'Basic ' + Buffer.from($env.LANGFUSE_PUBLIC_KEY + ':' + $env.LANGFUSE_SECRET_KEY).toString('base64');
return [{ json: { auth, body: { batch }, items: events.filter((x) => x.event) } }];`;

export function tracing() {
  const wf = workflow({ id: WF.tracing, name: 'WF-030 · Tracing to Langfuse', description: 'Every 2 minutes: finished AI runs and job runs as Langfuse traces (metadata and judge scores only, no text or ids), tagged W1-W5.' });
  const t = wf.add(schedule('Every 2 minutes', { field: 'minutes', minutesInterval: 2 }));
  const now = wf.add(subTrigger('Run now'));
  const on = wf.add(ifTrue('Langfuse configured?', LANGFUSE_ON));
  const batch = wf.add(jsStep('Runs to trace', 'fn_trace_batch(50)', '[]', { mode: 'rows' }));
  const build = wf.add(code('Build ingestion batch', BUILD));
  const send = wf.add({
    name: 'Send to Langfuse',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: "={{ ($env.LANGFUSE_HOST || '').replace(/\\/$/, '') + '/api/public/ingestion' }}",
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Authorization', value: "={{ $('Build ingestion batch').first().json.auth }}" }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: "={{ JSON.stringify($('Build ingestion batch').first().json.body) }}",
      options: { timeout: 20000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } },
    },
  });
  const accepted = wf.add(code('Accepted traces', `
const sent = $('Build ingestion batch').first().json.items || [];
const r = $input.first().json || {};
const ok = new Set(((r.body || {}).successes || []).map((s) => s.id));
const status = Number(r.statusCode || 0);
// 207: per-event results; 200/201: all accepted.
const done = status >= 200 && status < 300 ? sent.filter((x) => status !== 207 || ok.has(x.event)) : [];
return [{ json: { done: done.map((x) => ({ kind: x.kind, id: x.id })), status } }];`));
  const mark = wf.add(jsStep('Mark traced', "fn_job_run('tracing', { ...fn_trace_mark(castJson(a[0])), status: castInt(a[1]) })", '[ JSON.stringify($json.done), String($json.status) ]'));
  wf.link(t, on);
  wf.link(now, on);
  wf.link(on, batch, { output: 0 });
  wf.chain(batch, build, send, accepted, mark);
  return wf.build();
}
