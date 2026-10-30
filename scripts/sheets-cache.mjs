// A caching proxy between n8n and the Google Sheets API. n8n's SHEETS_API_URL points here; requests go on to UPSTREAM
// (Google, or the local stand-in) with the caller's own authorization header.
//
//   values:batchGet   whole-tab ranges of the cached tabs (reference data and the knowledge index, which change
//                     rarely) are answered from memory; the other ranges of the same request are fetched from
//                     upstream in one call, and the answer is put back together in the requested order.
//   :batchUpdate      passed on; on success every cached tab it writes to (by sheet id, learnt from the _meta tab)
//                     is dropped from the cache, so the next read sees the change. values:batchUpdate / batchClear
//                     (the setup script) drop the whole spreadsheet.
//   POST /invalidate  drops everything (the setup and deploy scripts call it after writing to Google directly).
//   GET /stats        upstream reads and writes in the last minute, cache hits, bytes not fetched; GET /health.
// A tab edited by hand in Google Sheets is seen after CACHE_TTL_MS at the latest. Nothing is written to disk and no
// cell value is logged.
//
// Concurrent requests (optimistic concurrency). Every request of the platform reads whole tabs, decides in memory and
// writes back by row number, so two requests running at the same time could overwrite each other or both take the same
// unique key (two sign-ups with one e-mail address, two dispatcher runs claiming one event). Therefore:
//   - writes to one spreadsheet pass one at a time (a lock per spreadsheet), and every tab has a version that each
//     write through here moves on (before and after the upstream write);
//   - a batchGet answer carries cacheVersions: { tab: version } as the tab was when the read started;
//   - a batchUpdate may carry guards (the engine's dbWrites): rows it rewrites or removes, with the hash of what was
//     read, and unique keys it adds. Inside the lock, a guarded tab whose version moved since the read (or every guarded
//     tab with GUARD_RECHECK=always) is read again from upstream and checked: a changed or moved row, or a key already
//     taken, refuses the whole write with 200 { conflict: true } (nothing written; the workflow reads again and runs the
//     request again). The guards are removed before the write goes upstream.
// Writes made around this proxy (the setup scripts, edits by hand in Google Sheets) do not move the versions: removing
// or sorting rows by hand while the platform runs is not supported (GUARD_RECHECK=always checks every guarded write
// against upstream, at the cost of one more read per write).
//
//   CACHE_TABS    comma-separated tab names (default: DEFAULT_TABS below)
//   CACHE_TTL_MS  default 600000 (10 minutes)
//   UPSTREAM      default https://sheets.googleapis.com
//   GUARD_RECHECK changed (default: read again only tabs written since the request's read) | always
// Usage: node scripts/sheets-cache.mjs   (PORT, default 8094)
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const TOMBSTONE = '~deleted';
/** Hash of a row as read (UNFORMATTED_VALUE, trailing empty cells dropped); the same as dbRowHash in the engine. */
export function rowHash(cells) {
  const a = (cells || []).map((c) => (c === null || c === undefined ? '' : c));
  let n = a.length;
  while (n > 0 && a[n - 1] === '') n--;
  return createHash('sha256').update(JSON.stringify(a.slice(0, n)), 'utf8').digest('hex');
}
const cellText = (c) => (c === null || c === undefined || c === '' ? null : String(c));

/**
 * Checks write guards against the current rows: whole[tab] is a whole tab as read (values, header first), rows['tab|n']
 * one row. Guards of tabs not given are not checked. Returns null when every guard holds, or the first failure as
 * { tab, reason }.
 */
export function guardFailure(guards, { whole = {}, rows = {} }) {
  for (const g of guards.rows || []) {
    const cur = whole[g.tab] ? (whole[g.tab][g.row - 1] || []) : rows[`${g.tab}|${g.row}`];
    if (cur === undefined) continue;                                  // not re-read (version unchanged)
    if (rowHash(cur) !== g.hash) return { tab: g.tab, reason: 'row changed' };
  }
  for (const g of guards.unique || []) {
    const values = whole[g.tab];
    if (!values) continue;
    const keys = new Set((g.keys || []).map((k) => JSON.stringify(k.map(String))));
    const skip = new Set(g.exclude || []);
    for (let i = 1; i < values.length; i++) {
      const cells = values[i] || [];
      if (skip.has(i + 1) || cells[0] === TOMBSTONE || !cells.some((c) => c !== '' && c != null)) continue;
      if (g.where && (g.where.notnull ? cellText(cells[g.where.col]) === null : cellText(cells[g.where.col]) !== g.where.eq)) continue;
      const key = g.cols.map((c) => cellText(cells[c]));
      if (key.some((k) => k === null)) continue;
      if (keys.has(JSON.stringify(key))) return { tab: g.tab, reason: 'key taken' };
    }
  }
  return null;
}

export const DEFAULT_TABS = ['_meta', 'api_routes', 'safety_rules', 'feature_flags', 'error_messages', 'drugs', 'drug_combinations',
  'drug_interactions', 'drug_condition_rules', 'allergy_synonyms', 'lab_catalog', 'lab_units', 'foods', 'facilities',
  'intake_questions', 'care_level_rules', 'screening_types', 'guideline_sources', 'organizations', 'rag_documents', 'rag_chunks',
  'rag_document_parts'];

export function createSheetsCache(opts = {}) {
  // UPSTREAM, or SHEETS_API_URL (the server's sheets.env names the real address so).
  const upstream = String(opts.upstream || process.env.UPSTREAM || process.env.SHEETS_API_URL || 'https://sheets.googleapis.com').replace(/\/$/, '');
  const tabs = new Set(opts.tabs || String(process.env.CACHE_TABS || DEFAULT_TABS.join(',')).split(',').map((x) => x.trim()).filter(Boolean));
  const ttl = Number(opts.ttlMs || process.env.CACHE_TTL_MS || 600000);
  const log = opts.log || ((line) => console.log(line));
  const cache = new Map();        // `${sheet}|${render}|${tab}` -> { at, vr, bytes }
  const sheetIds = new Map();     // `${sheet}|${sheetId}` -> tab   (from _meta answers)
  const events = [];              // [time, kind] for the per-minute counts
  const counters = { hits: 0, misses: 0, bytes_saved: 0, invalidations: 0, guarded_writes: 0, guard_rechecks: 0, conflicts: 0 };
  const startedAt = new Date().toISOString();
  const recheck = String(opts.guardRecheck || process.env.GUARD_RECHECK || 'changed');
  // Versions: `${epoch}.${generation of the spreadsheet}.${version of the tab}`. A restart (new epoch) or a write whose
  // tabs are unknown (a new generation) makes every earlier stamp stale, so those writes are checked against upstream.
  const EPOCH = randomUUID().slice(0, 8);
  const gens = new Map();          // sheet -> generation
  const tabVers = new Map();       // `${sheet}|${tab}` -> version
  const stamp = (sheet, tab) => `${EPOCH}.${gens.get(sheet) || 0}.${tabVers.get(`${sheet}|${tab}`) || 0}`;
  const bump = (sheet, tabNames) => {
    if (!tabNames) { gens.set(sheet, (gens.get(sheet) || 0) + 1); return; }
    for (const t of tabNames) tabVers.set(`${sheet}|${t}`, (tabVers.get(`${sheet}|${t}`) || 0) + 1);
  };
  // One write at a time per spreadsheet (guards are checked and the write is made inside).
  const tails = new Map();
  const withLock = async (key, fn) => {
    const prev = tails.get(key) || Promise.resolve();
    let release;
    const mine = new Promise((ok) => { release = ok; });
    const next = prev.then(() => mine);
    tails.set(key, next);
    await prev;
    try { return await fn(); } finally { release(); if (tails.get(key) === next) tails.delete(key); }
  };
  const UPSTREAM_TIMEOUT = 60000;
  const note = (kind) => { const now = Date.now(); events.push([now, kind]); while (events.length && events[0][0] < now - 60000) events.shift(); };

  const tabOf = (range) => { const r = String(range); const i = r.lastIndexOf('!'); const t = i < 0 ? r : r.slice(0, i); return { tab: t.startsWith("'") ? t.slice(1, -1).replace(/''/g, "'") : t, whole: i < 0 }; };
  const dropSheet = (sheet) => { for (const k of [...cache.keys()]) if (k.startsWith(`${sheet}|`)) cache.delete(k); counters.invalidations++; };
  const dropTab = (sheet, tab) => { for (const k of [...cache.keys()]) if (k.startsWith(`${sheet}|`) && k.endsWith(`|${tab}`)) cache.delete(k); counters.invalidations++; };
  const learnMeta = (sheet, vr) => {
    for (const row of (vr.values || []).slice(1)) if (String(row[0]).startsWith('sheet:')) sheetIds.set(`${sheet}|${Number(row[1])}`, String(row[0]).slice(6));
  };
  const headersFor = (req) => {
    const h = {};
    // x-scope-*: the local store's per-patient reads (scripts/sheets-emulator.mjs); a filtered answer is never cached.
    for (const k of ['authorization', 'x-goog-api-key', 'content-type', 'x-goog-user-project', 'x-scope-token', 'x-scope-patient']) if (req.headers[k]) h[k] = req.headers[k];
    return h;
  };
  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const passThrough = async (req, res, url, body) => {
    const r = await fetch(`${upstream}${url.pathname}${url.search}`, { method: req.method, headers: headersFor(req), body: body && body.length ? body : undefined });
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
    if (r.body) Readable.fromWeb(r.body).pipe(res); else res.end();
    return r;
  };

  // Inside the lock: the guarded tabs that changed since the request read them are read again from upstream (one
  // request; rows one by one, or the whole tab when it has unique keys or many rows) and checked.
  // Returns null (go on), { tab, reason } (conflict) or { upstream: { status, text } } (the re-read failed: quota, outage).
  async function checkGuards(sheet, guards, req) {
    const all = [...(guards.rows || []), ...(guards.unique || [])];
    const versions = guards.versions && typeof guards.versions === 'object' ? guards.versions : {};
    const stale = new Set(all.map((g) => g.tab).filter((tab) => recheck === 'always' || versions[tab] !== stamp(sheet, tab)));
    if (!stale.size) return null;
    counters.guard_rechecks++;
    const q = (tab) => `'${String(tab).replace(/'/g, "''")}'`;
    const ranges = [], plan = [];
    for (const tab of stale) {
      const rowGuards = (guards.rows || []).filter((g) => g.tab === tab);
      if ((guards.unique || []).some((g) => g.tab === tab) || rowGuards.length > 40) { ranges.push(q(tab)); plan.push({ tab }); }
      else for (const g of rowGuards) { ranges.push(`${q(tab)}!${g.row}:${g.row}`); plan.push({ tab, row: g.row }); }
    }
    const headers = {};
    for (const k of ['authorization', 'x-goog-api-key', 'x-goog-user-project']) if (req.headers[k]) headers[k] = req.headers[k];   // never the x-scope-* headers: whole tabs
    note('read');
    const r = await fetch(`${upstream}/v4/spreadsheets/${sheet}/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&majorDimension=ROWS&${ranges.map((x) => `ranges=${encodeURIComponent(x)}`).join('&')}`,
      { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT) });
    if (!r.ok) return { upstream: { status: r.status, text: await r.text() } };
    const j = await r.json();
    const whole = {}, rows = {};
    plan.forEach((p, i) => {
      const values = (j.valueRanges[i] && j.valueRanges[i].values) || [];
      if (p.row === undefined) whole[p.tab] = values; else rows[`${p.tab}|${p.row}`] = values[0] || [];
    });
    return guardFailure({ rows: (guards.rows || []).filter((g) => stale.has(g.tab)), unique: (guards.unique || []).filter((g) => stale.has(g.tab)) }, { whole, rows });
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://cache');
      if (url.pathname === '/health') return send(res, 200, { ok: true, upstream, tabs: tabs.size });
      if (url.pathname === '/stats') {
        const per = (k) => events.filter((e) => e[1] === k).length;
        return send(res, 200, { since: startedAt, ttl_ms: ttl, cached_entries: cache.size, upstream_reads_last_min: per('read'), upstream_writes_last_min: per('write'),
          served_from_cache_last_min: per('hit'), ...counters });
      }
      if (url.pathname === '/invalidate' && req.method === 'POST') {
        cache.clear(); counters.invalidations++;
        for (const s of new Set([...gens.keys(), ...[...tabVers.keys()].map((k) => k.split('|')[0])])) bump(s, null);
        log(`${new Date().toISOString()} invalidate all`);
        return send(res, 200, { ok: true });
      }
      const parts = []; for await (const c of req) parts.push(c);
      const body = Buffer.concat(parts);

      let m = url.pathname.match(/^\/v4\/spreadsheets\/([^/:]+)\/values:batchGet$/);
      if (m && req.method === 'GET') {
        const sheet = m[1];
        const ranges = url.searchParams.getAll('ranges');
        const render = `${url.searchParams.get('valueRenderOption') || ''}/${url.searchParams.get('majorDimension') || ''}`;
        const now = Date.now();
        const answer = new Array(ranges.length);
        const missing = [];
        // The versions as the read starts: a write that lands while the read runs makes them stale (it moves them first).
        const cacheVersions = {};
        for (const range of ranges) { const { tab, whole } = tabOf(range); if (whole) cacheVersions[tab] = stamp(sheet, tab); }
        ranges.forEach((range, i) => {
          const { tab, whole } = tabOf(range);
          const hit = whole && tabs.has(tab) ? cache.get(`${sheet}|${render}|${tab}`) : null;
          if (hit && now - hit.at < ttl) { answer[i] = hit.vr; counters.hits++; counters.bytes_saved += hit.bytes; note('hit'); }
          else missing.push(i);
        });
        if (missing.length) {
          const q = new URLSearchParams(url.searchParams);
          q.delete('ranges');
          for (const i of missing) q.append('ranges', ranges[i]);
          note('read');
          const r = await fetch(`${upstream}${url.pathname}?${q}`, { headers: headersFor(req) });
          if (!r.ok) { res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' }); return res.end(await r.text()); }
          const j = await r.json();
          missing.forEach((i, k) => {
            const vr = j.valueRanges[k];
            answer[i] = vr;
            const { tab, whole } = tabOf(ranges[i]);
            if (tab === '_meta') learnMeta(sheet, vr);
            if (whole && tabs.has(tab) && !Array.isArray(vr.rowNumbers)) { cache.set(`${sheet}|${render}|${tab}`, { at: Date.now(), vr, bytes: JSON.stringify(vr).length }); counters.misses++; }
          });
          return send(res, 200, { spreadsheetId: j.spreadsheetId || sheet, valueRanges: answer, cacheVersions });
        }
        return send(res, 200, { spreadsheetId: sheet, valueRanges: answer, cacheVersions });
      }

      m = url.pathname.match(/^\/v4\/spreadsheets\/([^/:]+):batchUpdate$/);
      if (m && req.method === 'POST') {
        const sheet = m[1];
        note('write');
        // Dropped before and after the write: a read racing the write must not keep the old copy.
        let ids = [];
        let parsed = null;
        // Cell writes and row removals name their tab; anything else (a new tab, a resize) drops the whole spreadsheet.
        try {
          parsed = JSON.parse(body.toString('utf8'));
          const reqs = parsed.requests || [];
          ids = reqs.every((x) => x.appendCells || x.updateCells || x.deleteDimension)
            ? reqs.map((x) => (x.appendCells ? x.appendCells.sheetId : x.deleteDimension ? x.deleteDimension.range?.sheetId
              : x.updateCells.start?.sheetId ?? x.updateCells.range?.sheetId)) : null;
          if (ids && ids.some((x) => x === undefined)) ids = null;
        } catch (e) { ids = null; parsed = null; }
        const guards = parsed && parsed.guards && typeof parsed.guards === 'object' ? parsed.guards : null;
        // The guards name each tab with its sheet id: learnt here too, so a write's tab is known before any _meta read.
        if (guards) for (const g of [...(guards.rows || []), ...(guards.unique || [])]) if (g && g.tab && g.sheetId !== undefined && !sheetIds.has(`${sheet}|${Number(g.sheetId)}`)) sheetIds.set(`${sheet}|${Number(g.sheetId)}`, String(g.tab));
        const written = () => (ids === null || ids.some((id) => !sheetIds.has(`${sheet}|${Number(id)}`)) ? null
          : [...new Set(ids.map((id) => sheetIds.get(`${sheet}|${Number(id)}`)))]);
        const drop = () => {
          const names = written();
          bump(sheet, names);
          if (names === null) return dropSheet(sheet);
          for (const tab of names) if (tabs.has(tab)) dropTab(sheet, tab);
        };
        return withLock(sheet, async () => {
          if (guards) {
            counters.guarded_writes++;
            const failed = await checkGuards(sheet, guards, req);
            if (failed && failed.upstream) { res.writeHead(failed.upstream.status, { 'content-type': 'application/json' }); return res.end(failed.upstream.text); }
            if (failed) {
              counters.conflicts++;
              dropTab(sheet, failed.tab);       // the request runs again on a fresh read, also of a cached tab edited by hand
              log(`${new Date().toISOString()} write refused: ${failed.reason} in ${failed.tab}`);
              res.writeHead(200, { 'content-type': 'application/json', 'x-write-conflict': '1' });
              return res.end(JSON.stringify({ spreadsheetId: sheet, conflict: true, replies: [], error: { status: 'ABORTED', tab: failed.tab, reason: failed.reason } }));
            }
          }
          const out = parsed && guards ? Buffer.from(JSON.stringify({ ...parsed, guards: undefined }), 'utf8') : body;
          drop();
          try {
            const r = await fetch(`${upstream}${url.pathname}${url.search}`, { method: 'POST', headers: headersFor(req), body: out, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT) });
            const text = await r.text();
            res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
            res.end(text);
          } finally { drop(); }
        });
      }
      m = url.pathname.match(/^\/v4\/spreadsheets\/([^/:]+)\/values:(batchUpdate|batchClear|append|update)$/);
      if (m) {
        const sheet = m[1];
        note('write');
        return withLock(sheet, async () => {
          bump(sheet, null); dropSheet(sheet);
          try { await passThrough(req, res, url, body); } finally { bump(sheet, null); dropSheet(sheet); }
        });
      }
      m = url.pathname.match(/^\/v4\/spreadsheets\/([^/:]+)/);
      if (m) note(req.method === 'GET' ? 'read' : 'write');
      return passThrough(req, res, url, body);
    } catch (e) {
      log(`${new Date().toISOString()} sheets cache error ${e.name}`);
      if (!res.headersSent) send(res, 502, { error: { code: 502, status: 'UNAVAILABLE', message: 'Sheets cache error' } });
      else res.end();
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const port = Number(process.env.PORT || 8094);
  createSheetsCache().listen(port, () => console.log(`sheets cache on :${port}`));
}
