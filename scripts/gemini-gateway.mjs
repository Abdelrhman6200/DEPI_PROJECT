// A small gateway between n8n and the Gemini API (free tier). n8n's Gemini credential points its host here, and the
// document reader calls it too, instead of https://generativelanguage.googleapis.com. For every model request it:
//   - tries the requested model, then the next models of its chain, when Google answers 429 (quota), 404 (model not
//     offered), 5xx (busy), or sends no response headers within GEMINI_TIMEOUT_MS;
//   - rests a model that failed that way (a few minutes; an hour for a daily quota or a missing model), so the next
//     requests go straight to a model that answers;
//   - asks the larger Gemini 3 models to think briefly (GEMINI_THINKING), with room for it in the output budget, unless
//     the request sets its own thinking;
//   - gives a function call in the conversation history a thought signature when it has none (Gemini 3 refuses tool
//     history without one, and LangChain does not keep them).
// It never logs or stores request or answer text: one line per request with the models tried, the status and the time.
//
//   GEMINI_CHAINS      chains, ';' between chains and ',' between models, best first. A request starts at its model in
//                      the first chain that holds it (a model in no chain is tried alone). Default: DEFAULT_CHAINS below.
//   GEMINI_TIMEOUT_MS  time allowed until the response headers before the next model is tried (default 20000)
//   GEMINI_REST_MS     how long a busy model (5xx, quota) is skipped (default 600000); a model that only timed out is
//                      skipped a fifth of that (2 minutes): one slow answer under load is no outage
//   GEMINI_HEDGE_MS    when the model tried has not answered after this time, the next model of the chain starts too;
//                      the first answer wins (default 8000)
//   GEMINI_NO_HEDGE    requested models matching this pattern are not hedged, only tried in turn (default 'lite': the
//                      lite models answer in a few seconds, a second request would only spend quota)
//   GEMINI_OUTRUN_REST_MS  how long a model rests after it was outrun twice within 10 minutes (default 120000)
//   GEMINI_THINKING    thinking level for the larger Gemini 3 models: low | medium | high | off (default low)
//   UPSTREAM           default https://generativelanguage.googleapis.com
// Usage: node scripts/gemini-gateway.mjs   (PORT, default 8092)
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

export const DEFAULT_CHAINS = 'gemini-3.8-flash,gemini-3.7-flash,gemini-3.5-flash,gemini-3.5-flash-lite;'
  + 'gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash';
const SKIP_SIGNATURE = 'skip_thought_signature_validator';   // documented placeholder for history without signatures
const RETRY_STATUS = new Set([404, 408, 429, 500, 502, 503, 504]);

export function createGateway(opts = {}) {
  const upstream = String(opts.upstream || process.env.UPSTREAM || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const chains = String(opts.chains || process.env.GEMINI_CHAINS || DEFAULT_CHAINS).split(';')
    .map((c) => c.split(',').map((m) => m.trim()).filter(Boolean)).filter((c) => c.length);
  const timeoutMs = Number(opts.timeoutMs || process.env.GEMINI_TIMEOUT_MS || 20000);
  const restMs = Number(opts.restMs || process.env.GEMINI_REST_MS || 600000);
  const thinking = String(opts.thinking || process.env.GEMINI_THINKING || 'low');
  const hedgeMs = Number(opts.hedgeMs || process.env.GEMINI_HEDGE_MS || 8000);
  const noHedge = new RegExp(String(opts.noHedge ?? process.env.GEMINI_NO_HEDGE ?? 'lite') || '(?!)');
  const outrunRestMs = Number(opts.outrunRestMs || process.env.GEMINI_OUTRUN_REST_MS || 120000);
  const outruns = new Map();   // model -> times it was outrun (last 10 minutes)
  // An outrun is one slow answer, not an outage: the model rests (briefly) only when it happens twice in 10 minutes.
  const outrun = (model) => {
    const now = Date.now();
    const list = (outruns.get(model) || []).filter((t) => now - t < 600000);
    list.push(now); outruns.set(model, list);
    if (list.length >= 2) resting.set(model, Math.max(resting.get(model) || 0, now + outrunRestMs));
  };
  const log = opts.log || ((line) => console.log(line));
  const resting = new Map();   // model -> time until which it is skipped
  const startedAt = new Date().toISOString();
  // Per-model counts since the start (no request text): ok, busy, timeout, outrun, refused, and answer times.
  const stats = new Map();
  const record = (model, outcome, ms) => {
    const s = stats.get(model) || { ok: 0, busy: 0, timeout: 0, outrun: 0, refused: 0, ms_total: 0, last: null, tokens: { prompt: 0, output: 0, thoughts: 0, cached: 0 } };
    s[outcome] = (s[outcome] || 0) + 1;
    if (outcome === 'ok') s.ms_total += ms;
    s.last = { outcome, at: new Date().toISOString() };
    stats.set(model, s);
  };
  /** Token counts of an answer (usageMetadata), per model; no text is kept. */
  const countTokens = (model, u) => {
    const s = stats.get(model); if (!s || !u) return;
    s.tokens.prompt += u.promptTokenCount || 0; s.tokens.output += u.candidatesTokenCount || 0;
    s.tokens.thoughts += u.thoughtsTokenCount || 0; s.tokens.cached += u.cachedContentTokenCount || 0;
  };

  /** The models to try for a requested model: the chain that starts with it (a lite model's own chain), else the first
   *  chain that holds it, from its place on. */
  const candidates = (model) => {
    const chain = chains.find((c) => c[0] === model) || chains.find((c) => c.includes(model));
    const list = chain ? chain.slice(chain.indexOf(model)) : [model];
    const now = Date.now();
    const awake = list.filter((m) => !(resting.get(m) > now));
    // When every model rests, try them anyway, the one that rests the shortest first.
    return awake.length ? awake : [...list].sort((a, b) => (resting.get(a) || 0) - (resting.get(b) || 0));
  };
  const bigGemini3 = (m) => /^gemini-3(\.\d+)?-(flash|pro)(-preview)?$/.test(m);

  /** The request body for one model: thinking level and thought signatures. Returns { body, thinkingAdded }. */
  const bodyFor = (parsed, raw, model, allowThinking) => {
    if (!parsed) return { body: raw, thinkingAdded: false };
    const b = structuredClone(parsed);
    let thinkingAdded = false;
    if (/^gemini-3/.test(model)) {
      for (const c of b.contents || []) for (const p of c.parts || []) if (p.functionCall && !p.thoughtSignature) p.thoughtSignature = SKIP_SIGNATURE;
    }
    if (allowThinking && thinking !== 'off' && bigGemini3(model) && !b.generationConfig?.thinkingConfig) {
      b.generationConfig = { ...(b.generationConfig || {}), thinkingConfig: { thinkingLevel: thinking } };
      // Thinking counts towards the output budget: give it room so the answer is not cut off.
      if (b.generationConfig.maxOutputTokens) b.generationConfig.maxOutputTokens += 1024;
      thinkingAdded = true;
    }
    return { body: JSON.stringify(b), thinkingAdded };
  };

  const forwardHeaders = (req) => {
    const h = { 'content-type': req.headers['content-type'] || 'application/json' };
    for (const k of ['x-goog-api-key', 'authorization', 'x-goog-api-client', 'x-goog-user-project']) if (req.headers[k]) h[k] = req.headers[k];
    return h;
  };
  const sendJson = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const pipe = async (r, res, model) => {
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json', 'x-gemini-model': model });
    if (r.body) Readable.fromWeb(r.body).pipe(res); else res.end();
  };

  return createServer(async (req, res) => {
    const t0 = Date.now();
    try {
      const url = new URL(req.url, 'http://gateway');
      if (url.pathname === '/health') {
        const now = Date.now();
        return sendJson(res, 200, { ok: true, chains, resting: Object.fromEntries([...resting].filter(([, t]) => t > now).map(([m, t]) => [m, Math.round((t - now) / 1000)])) });
      }
      if (url.pathname === '/stats') {
        const now = Date.now();
        return sendJson(res, 200, { since: startedAt, hedge_ms: hedgeMs, timeout_ms: timeoutMs, outrun_rest_ms: outrunRestMs, models: Object.fromEntries([...stats].map(([m, s]) => [m, {
          ok: s.ok, busy: s.busy, timeout: s.timeout, outrun: s.outrun, refused: s.refused,
          avg_ms: s.ok ? Math.round(s.ms_total / s.ok) : null, tokens: s.tokens, last: s.last,
          resting_s: resting.get(m) > now ? Math.round((resting.get(m) - now) / 1000) : 0 }])) });
      }
      const parts = [];
      for await (const chunk of req) parts.push(chunk);
      const raw = Buffer.concat(parts);
      const m = url.pathname.match(/^\/(v1|v1beta|v1alpha)\/models\/([^/:]+):(generateContent|streamGenerateContent|countTokens)$/);
      if (!m) {
        // Anything else (model lists, file uploads) goes through as it is.
        const r = await fetch(`${upstream}${url.pathname}${url.search}`, { method: req.method, headers: forwardHeaders(req), body: raw.length ? raw : undefined });
        return pipe(r, res, '-');
      }
      const [, ver, requested, method] = m;
      let parsed = null;
      try { parsed = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch (e) { parsed = null; }
      const tried = [];
      const why = (text) => { try { return String(JSON.parse(text).error?.message || '').slice(0, 300); } catch (e) { return ''; } };

      /** One model, until it answers or fails. 'retry': busy, over quota, silent or unreachable (try the next model). */
      const attempt = async (model, ctl) => {
        const started = Date.now();
        for (let allowThinking = true; ; allowThinking = false) {
          const { body, thinkingAdded } = bodyFor(parsed, raw, model, allowThinking);
          const timer = setTimeout(() => ctl.abort('timeout'), timeoutMs);
          let r = null;
          try {
            r = await fetch(`${upstream}/${ver}/models/${model}:${method}${url.search}`, { method: 'POST', headers: forwardHeaders(req), body, signal: ctl.signal });
          } catch (e) {
            r = null;
          } finally {
            clearTimeout(timer);
          }
          if (!r) {
            if (ctl.signal.reason === 'outrun') return { kind: 'outrun', model, started };
            record(model, 'timeout', Date.now() - started);
            return { kind: 'retry', model, tag: 'timeout', status: 504, error: `${model} did not answer within ${timeoutMs} ms` };
          }
          if (r.ok) { record(model, 'ok', Date.now() - started); return { kind: 'ok', model, r }; }
          if (!RETRY_STATUS.has(r.status)) {
            const text = await r.text();
            // A request the model refuses because of the added thinking setting is sent again without it.
            if (r.status === 400 && thinkingAdded && /thinking/i.test(text)) { tried.push(`${model}:400-thinking`); continue; }
            record(model, 'refused', Date.now() - started);
            return { kind: 'final', model, status: r.status, text };
          }
          const text = await r.text().catch(() => '');
          const long = r.status === 404 || /per ?day|PerDay/i.test(text);
          record(model, 'busy', Date.now() - started);
          return { kind: 'retry', model, tag: String(r.status), status: r.status, body: text, long };
        }
      };

      // Hedged requests: the first model starts; when it has not answered within hedgeMs (or fails), the next model of
      // the chain starts too. The first real answer wins and the others are stopped. A model that was outrun by a later
      // one twice within 10 minutes rests briefly, so the next requests start with a model that answers. Lite models are not
      // hedged (GEMINI_NO_HEDGE): the next one starts only when the first fails.
      const queue = candidates(requested);
      const hedging = !noHedge.test(requested);
      const result = await new Promise((resolve) => {
        const running = new Map();   // model -> { ctl, started }
        let next = 0, done = false, hedge = null, last = null;
        const finish = (res) => {
          done = true; clearTimeout(hedge);
          for (const [model, run] of running) {
            if (res.kind === 'ok' && run.started < res.startedAt) { outrun(model); record(model, 'outrun', Date.now() - run.started); tried.push(`${model}:outrun`); }
            run.ctl.abort('outrun');
          }
          resolve(res);
        };
        const launch = () => {
          if (done || next >= queue.length) return false;
          const model = queue[next++];
          const ctl = new AbortController();
          const started = Date.now();
          running.set(model, { ctl, started });
          clearTimeout(hedge);
          if (hedging) hedge = setTimeout(() => { if (!done) launch(); }, hedgeMs);
          attempt(model, ctl).then((res) => {
            running.delete(model);
            if (done) { if (res.r?.body) res.r.body.cancel().catch(() => {}); return; }
            if (res.kind === 'outrun') return;
            if (res.kind === 'retry') {
              resting.set(model, Date.now() + (res.long ? Math.max(restMs, 3600e3) : res.tag === 'timeout' ? Math.round(restMs / 5) : restMs));
              tried.push(`${model}:${res.tag}`);
              last = res;
              if (!launch() && running.size === 0) finish({ kind: 'fail', last });
              return;
            }
            tried.push(`${model}:${res.kind === 'ok' ? 200 : res.status}`);
            finish({ ...res, startedAt: started });
          });
          return true;
        };
        launch();
      });

      const ms = Date.now() - t0;
      if (result.kind === 'ok') {
        log(`${new Date().toISOString()} ${requested} -> ${tried.join(' ')} ${ms}ms`);
        // A whole (not streamed) answer is read once to count its tokens, then sent on unchanged.
        if (method === 'generateContent' && /json/.test(result.r.headers.get('content-type') || '')) {
          const buf = Buffer.from(await result.r.arrayBuffer());
          try { countTokens(result.model, JSON.parse(buf.toString('utf8')).usageMetadata); } catch (e) { /* not JSON: nothing to count */ }
          res.writeHead(result.r.status, { 'content-type': result.r.headers.get('content-type'), 'x-gemini-model': result.model });
          return res.end(buf);
        }
        return pipe(result.r, res, result.model);
      }
      if (result.kind === 'final') {
        // Google's error message names fields and settings, not the request text; it is logged (shortened) so a refused
        // request can be diagnosed.
        log(`${new Date().toISOString()} ${requested} -> ${tried.join(' ')} ${ms}ms ${why(result.text)}`);
        res.writeHead(result.status, { 'content-type': 'application/json', 'x-gemini-model': result.model });
        return res.end(result.text);
      }
      const last = result.last;
      log(`${new Date().toISOString()} ${requested} -> ${tried.join(' ')} ${ms}ms (no model answered)`);
      if (last?.body) { res.writeHead(last.status, { 'content-type': 'application/json' }); return res.end(last.body); }
      return sendJson(res, 503, { error: { code: 503, status: 'UNAVAILABLE', message: `No Gemini model answered (${tried.join(', ')}). ${last?.error || ''}`.trim() } });
    } catch (e) {
      log(`${new Date().toISOString()} gateway error ${e.name}`);
      if (!res.headersSent) sendJson(res, 502, { error: { code: 502, status: 'UNAVAILABLE', message: 'Gemini gateway error' } });
      else res.end();
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const port = Number(process.env.PORT || 8092);
  createGateway().listen(port, () => console.log(`gemini gateway on :${port}`));
}
