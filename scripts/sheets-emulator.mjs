// A local stand-in for the parts of the Google Sheets and Drive APIs the platform uses, so the whole system runs and is
// tested without a Google account and without spending the Sheets quota. Data is kept in DATA_DIR as JSON.
//
//   Sheets  GET  /v4/spreadsheets/:id                       tabs and their sheet ids
//           GET  /v4/spreadsheets/:id/values:batchGet       ranges (whole tabs or A1 ranges), UNFORMATTED values
//           POST /v4/spreadsheets/:id:batchUpdate           addSheet, deleteSheet, appendCells, updateCells (atomic)
//           POST /v4/spreadsheets/:id/values:batchUpdate    values by A1 range (setup)
//           POST /v4/spreadsheets/:id/values:batchClear
//   Drive   GET  /drive/v3/files?q='<folder>' in parents   files of a folder (DATA_DIR/drive/<folder>/)
//           GET  /drive/v3/files/:id[?alt=media]           metadata or content;  GET /drive/v3/files/:id/export
//
// DATA_ENCRYPTION_KEY (64 hex characters) encrypts the spreadsheets on disk (AES-256-GCM, <id>.json.enc); plain files
// from before are encrypted at start and then removed. A wrong key stops the start (nothing is overwritten).
// QUOTA_PER_MINUTE=60 makes it answer 429 like Google once a minute's read or write requests exceed the number.
// Usage: node scripts/sheets-emulator.mjs   (PORT=8090, DATA_DIR=./.sheets-emulator)
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PORT = Number(process.env.PORT || 8090);
const DATA_DIR = process.env.DATA_DIR || './.sheets-emulator';
const QUOTA = Number(process.env.QUOTA_PER_MINUTE || 0);
mkdirSync(join(DATA_DIR, 'spreadsheets'), { recursive: true });
mkdirSync(join(DATA_DIR, 'drive'), { recursive: true });

/* ------------------------------------------------------------------------------------------------ spreadsheets */

const KEY_HEX = String(process.env.DATA_ENCRYPTION_KEY || '');
if (KEY_HEX && !/^[0-9a-fA-F]{64}$/.test(KEY_HEX)) { console.error('DATA_ENCRYPTION_KEY must be 64 hex characters'); process.exit(1); }
const KEY = KEY_HEX ? Buffer.from(KEY_HEX, 'hex') : null;
const MAGIC = Buffer.from('HPENC1');
const seal = (obj) => {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
};
const unseal = (buf) => {
  if (!buf.subarray(0, 6).equals(MAGIC)) throw new Error('not an encrypted spreadsheet file');
  const d = createDecipheriv('aes-256-gcm', KEY, buf.subarray(6, 18));
  d.setAuthTag(buf.subarray(18, 34));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(34)), d.final()]).toString('utf8'));
};

const books = new Map();
const fileOf = (id) => join(DATA_DIR, 'spreadsheets', `${id.replace(/[^\w-]/g, '_')}.json`);
const dirty = new Set();
function book(id) {
  if (!books.has(id)) {
    const f = fileOf(id), enc = `${f}.enc`;
    if (existsSync(enc)) {
      if (!KEY) throw new Error(`spreadsheet ${id} is encrypted: set DATA_ENCRYPTION_KEY`);
      books.set(id, unseal(readFileSync(enc)));
    } else if (existsSync(f)) {
      books.set(id, JSON.parse(readFileSync(f, 'utf8')));
      if (KEY) dirty.add(id);   // a plain file from before: written encrypted at the next save, then removed
    } else books.set(id, { id, title: id, nextSheetId: 1, sheets: [] });
  }
  return books.get(id);
}
function save(id) { dirty.add(id); }
function writeBook(id) {
  const f = fileOf(id);
  if (KEY) {
    writeFileSync(`${f}.enc.tmp`, seal(books.get(id)));
    renameSync(`${f}.enc.tmp`, `${f}.enc`);
    for (const p of [f, `${f}.tmp`]) if (existsSync(p)) unlinkSync(p);
  } else {
    writeFileSync(`${f}.tmp`, JSON.stringify(books.get(id)));
    renameSync(`${f}.tmp`, f);
  }
}
function flush() { for (const id of dirty) writeBook(id); dirty.clear(); }
setInterval(flush, 300).unref();
process.on('SIGTERM', () => { flush(); process.exit(0); });
// At start: every encrypted file must open with this key (a wrong key stops here, before anything is written), and
// plain files from before are encrypted now.
if (KEY) {
  for (const name of readdirSync(join(DATA_DIR, 'spreadsheets'))) {
    const m = name.match(/^(.+)\.json(\.enc)?$/);
    if (!m) continue;
    try { book(m[1]); } catch (e) { console.error(`cannot open ${name} with DATA_ENCRYPTION_KEY (${e.message}); stopping without changes`); process.exit(1); }
  }
  flush();
}

const sheetByTitle = (b, title) => b.sheets.find((s) => s.title === title);

/* Per-patient reads (an extension of this local store; Google has no such thing). A read that carries the caller's
 * session token (x-scope-token) gets only that caller's patients' rows of the large per-patient tabs, with the row
 * number of each row (rowNumbers), so the engine's updates still land on the right row. It only ever removes rows:
 * a patient gets their own record, a family member the patients granted to them (narrowed to x-scope-patient when
 * given); staff, an unknown or expired session, or anything unexpected get the whole tab. The engine checks access as
 * before. SCOPED_TABS: tabs whose rows all belong to one patient and that no patient or family action reads across
 * patients. */
const SCOPED_TABS = new Set(String(process.env.SCOPED_TABS ?? 'glucose_readings,meal_logs,activity_logs,medication_logs,vitals,sleep_logs,lab_results')
  .split(',').map((t) => t.trim()).filter(Boolean));
const tabRows = (b, title) => {
  const s = sheetByTitle(b, title);
  const v = s ? (s.rows || []) : [];
  const head = (v[0] || []).map(String);
  return v.slice(1).filter((row) => row && row[0] !== '~deleted').map((row) => Object.fromEntries(head.map((h, i) => [h, row[i]])));
};
const truthy = (x) => x === true || String(x).toUpperCase() === 'TRUE';
function scopeOf(b, token, patient) {
  try {
    if (!token || !SCOPED_TABS.size) return null;
    const hash = createHash('sha256').update(String(token), 'utf8').digest('hex');
    const now = Date.now();
    const session = tabRows(b, 'sessions').find((s) => s.token === hash && !truthy(s.revoked) && !(s.expires_at && Date.parse(s.expires_at) <= now));
    if (!session) return null;
    const user = tabRows(b, 'users').find((u) => u.id === session.user_id);
    if (!user) return null;
    let ids = [];
    if (user.role === 'patient') ids = tabRows(b, 'patients').filter((p) => p.user_id === user.id).map((p) => p.id);
    else if (user.role === 'caregiver') ids = tabRows(b, 'caregiver_grants').filter((g) => g.caregiver_user_id === user.id && truthy(g.active)).map((g) => g.patient_id);
    else return null;
    if (patient && user.role === 'caregiver') ids = ids.filter((id) => id === patient);
    // A patient asking about another patient id: whole tabs, so the engine answers (and refuses) as it always did.
    if (patient && !ids.includes(patient)) return null;
    return ids.length ? new Set(ids) : null;
  } catch (e) { return null; }
}
function scoped(vr, allowed) {
  const [head = [], ...rows] = vr.values || [];
  const col = head.indexOf('patient_id');
  if (col < 0) return vr;
  const values = [head], rowNumbers = [];
  rows.forEach((row, i) => { if (allowed.has(row[col])) { values.push(row); rowNumbers.push(i + 2); } });
  return { ...vr, values, rowNumbers };
}
const sheetById = (b, id) => b.sheets.find((s) => s.sheetId === Number(id));
const colNum = (letters) => letters.toUpperCase().split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colName = (n) => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };

/** 'tab', 'tab!A:F', "'my tab'!A2:C10" -> { title, c1, r1, c2, r2 } (1-based, inclusive; null = open). */
function parseRange(range) {
  const m = String(range).match(/^(?:'((?:[^']|'')+)'|([^!]+))(?:!([A-Za-z]*)(\d*)(?::([A-Za-z]*)(\d*))?)?$/);
  if (!m) throw httpError(400, `Unable to parse range: ${range}`);
  const title = (m[1] || m[2]).replace(/''/g, "'");
  return { title, c1: m[3] ? colNum(m[3]) : 1, r1: m[4] ? Number(m[4]) : 1, c2: m[5] ? colNum(m[5]) : (m[3] && !m[5] && m[6] === undefined ? colNum(m[3]) : null), r2: m[6] ? Number(m[6]) : (m[4] && !m[5] && !m[6] ? Number(m[4]) : null) };
}
function cellValue(c) {
  const v = c && c.userEnteredValue;
  if (!v) return '';
  if ('stringValue' in v) return v.stringValue;
  if ('numberValue' in v) return v.numberValue;
  if ('boolValue' in v) return v.boolValue;
  if ('formulaValue' in v) return v.formulaValue;
  return '';
}
const trimRow = (row) => { let n = row.length; while (n > 0 && (row[n - 1] === '' || row[n - 1] === null || row[n - 1] === undefined)) n--; return row.slice(0, n); };
function getValues(sheet, r) {
  const rows = [];
  const last = r.r2 ? Math.min(r.r2, sheet.rows.length) : sheet.rows.length;
  for (let i = r.r1 - 1; i < last; i++) {
    const row = sheet.rows[i] || [];
    rows.push(trimRow(row.slice(r.c1 - 1, r.c2 ? r.c2 : undefined)));
  }
  while (rows.length && !rows[rows.length - 1].length) rows.pop();
  return rows;
}
function lastDataRow(sheet) { let n = sheet.rows.length; while (n > 0 && !trimRow(sheet.rows[n - 1] || []).length) n--; return n; }

function batchUpdate(b, requests) {
  // Applied to a copy, so a failing request leaves the spreadsheet unchanged (as the real API does).
  const work = JSON.parse(JSON.stringify(b));
  const replies = [];
  for (const req of requests || []) {
    const [kind] = Object.keys(req);
    const body = req[kind];
    if (kind === 'addSheet') {
      const title = body.properties && body.properties.title;
      if (!title) throw httpError(400, 'addSheet needs a title');
      if (sheetByTitle(work, title)) throw httpError(400, `Invalid requests[0].addSheet: A sheet with the name "${title}" already exists. Please enter another name.`);
      const props = { sheetId: body.properties.sheetId ?? work.nextSheetId++, title, index: work.sheets.length, gridProperties: { rowCount: 1000, columnCount: 26 } };
      work.sheets.push({ ...props, rows: [] });
      replies.push({ addSheet: { properties: props } });
    } else if (kind === 'deleteSheet') {
      const i = work.sheets.findIndex((s) => s.sheetId === Number(body.sheetId));
      if (i < 0) throw httpError(400, `No grid with id: ${body.sheetId}`);
      work.sheets.splice(i, 1);
      replies.push({});
    } else if (kind === 'appendCells') {
      const s = sheetById(work, body.sheetId);
      if (!s) throw httpError(400, `No grid with id: ${body.sheetId}`);
      let at = lastDataRow(s);
      for (const row of body.rows || []) s.rows[at++] = (row.values || []).map(cellValue);
      replies.push({});
    } else if (kind === 'updateCells') {
      const st = body.start || {};
      const s = sheetById(work, st.sheetId);
      if (!s) throw httpError(400, `No grid with id: ${st.sheetId}`);
      (body.rows || []).forEach((row, i) => {
        const ri = (st.rowIndex || 0) + i;
        const cur = s.rows[ri] || [];
        (row.values || []).forEach((c, j) => { cur[(st.columnIndex || 0) + j] = cellValue(c); });
        for (let k = 0; k < ri; k++) if (!s.rows[k]) s.rows[k] = [];
        s.rows[ri] = cur;
      });
      replies.push({});
    } else if (kind === 'deleteDimension') {
      // Rows removed (the compaction of deleted rows); the rows below move up, as in Google Sheets.
      const rg = body.range || {};
      const s = sheetById(work, rg.sheetId);
      if (!s) throw httpError(400, `No grid with id: ${rg.sheetId}`);
      if (rg.dimension !== 'ROWS') throw httpError(400, 'deleteDimension: only ROWS is supported here');
      const a = Number(rg.startIndex), z = Number(rg.endIndex);
      if (!Number.isInteger(a) || !Number.isInteger(z) || a < 0 || z <= a) throw httpError(400, 'deleteDimension: bad range');
      if (a < s.rows.length) s.rows.splice(a, z - a);
      replies.push({});
    } else if (kind === 'updateSheetProperties' || kind === 'repeatCell' || kind === 'setBasicFilter' || kind === 'addProtectedRange' || kind === 'autoResizeDimensions') {
      replies.push({});
    } else {
      throw httpError(400, `Unsupported request: ${kind}`);
    }
  }
  Object.assign(b, work);
  return replies;
}

/* -------------------------------------------------------------------------------------------------------- drive */

const MIME = { '.md': 'text/markdown', '.txt': 'text/plain', '.pdf': 'application/pdf', '.html': 'text/html', '.json': 'application/json' };
const driveId = (folder, name) => Buffer.from(`${folder}/${name}`).toString('base64url');
const fromDriveId = (id) => { const s = Buffer.from(id, 'base64url').toString(); const i = s.indexOf('/'); return { folder: s.slice(0, i), name: s.slice(i + 1) }; };
function driveMeta(folder, name) {
  const p = join(DATA_DIR, 'drive', folder, name);
  const st = statSync(p);
  const content = readFileSync(p);
  return { kind: 'drive#file', id: driveId(folder, name), name, mimeType: MIME[extname(name).toLowerCase()] || 'application/octet-stream', parents: [folder],
    modifiedTime: st.mtime.toISOString(), md5Checksum: createHash('md5').update(content).digest('hex'), size: String(st.size), trashed: false };
}

/* ------------------------------------------------------------------------------------------------------- server */

function httpError(code, message) { const e = new Error(message); e.code = code; return e; }
const minute = { at: 0, read: 0, write: 0 };
function quota(kind) {
  if (!QUOTA) return;
  const m = Math.floor(Date.now() / 60000);
  if (minute.at !== m) Object.assign(minute, { at: m, read: 0, write: 0 });
  if (++minute[kind] > QUOTA) throw httpError(429, `Quota exceeded for quota metric '${kind === 'read' ? 'Read' : 'Write'} requests' and limit '${kind === 'read' ? 'Read' : 'Write'} requests per minute per user'`);
}
const readBody = (req) => new Promise((res, rej) => { const parts = []; req.on('data', (c) => parts.push(c)); req.on('end', () => { try { const s = Buffer.concat(parts).toString('utf8'); res(s ? JSON.parse(s) : {}); } catch (e) { rej(httpError(400, 'Invalid JSON payload')); } }); });
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    if (path === '/health') return send(res, 200, { ok: true });
    let m;
    if ((m = path.match(/^\/v4\/spreadsheets\/([^/:]+)\/values:batchGet$/)) && req.method === 'GET') {
      quota('read');
      const b = book(m[1]);
      const allowed = scopeOf(b, req.headers['x-scope-token'], req.headers['x-scope-patient']);
      const valueRanges = url.searchParams.getAll('ranges').map((range) => {
        const r = parseRange(range);
        const s = sheetByTitle(b, r.title);
        if (!s) throw httpError(400, `Unable to parse range: ${range}`);
        const values = getValues(s, r);
        const vr = { range: `${r.title}!${colName(r.c1)}${r.r1}:${colName(r.c2 || Math.max(1, ...values.map((x) => x.length + r.c1 - 1)))}${r.r1 + Math.max(values.length, 1) - 1}`, majorDimension: 'ROWS', ...(values.length ? { values } : {}) };
        return allowed && SCOPED_TABS.has(r.title) && r.r1 === 1 ? scoped(vr, allowed) : vr;
      });
      return send(res, 200, { spreadsheetId: m[1], valueRanges });
    }
    if ((m = path.match(/^\/v4\/spreadsheets\/([^/:]+):batchUpdate$/)) && req.method === 'POST') {
      quota('write');
      const b = book(m[1]);
      const body = await readBody(req);
      const replies = batchUpdate(b, body.requests);
      save(m[1]);
      return send(res, 200, { spreadsheetId: m[1], replies });
    }
    if ((m = path.match(/^\/v4\/spreadsheets\/([^/:]+)\/values:batchUpdate$/)) && req.method === 'POST') {
      quota('write');
      const b = book(m[1]);
      const body = await readBody(req);
      let cells = 0;
      for (const d of body.data || []) {
        const r = parseRange(d.range);
        const s = sheetByTitle(b, r.title);
        if (!s) throw httpError(400, `Unable to parse range: ${d.range}`);
        (d.values || []).forEach((row, i) => {
          const ri = r.r1 - 1 + i;
          const cur = s.rows[ri] || [];
          row.forEach((v, j) => { cur[r.c1 - 1 + j] = v === null ? '' : v; cells++; });
          for (let k = 0; k < ri; k++) if (!s.rows[k]) s.rows[k] = [];
          s.rows[ri] = cur;
        });
      }
      save(m[1]);
      return send(res, 200, { spreadsheetId: m[1], totalUpdatedCells: cells });
    }
    if ((m = path.match(/^\/v4\/spreadsheets\/([^/:]+)\/values:batchClear$/)) && req.method === 'POST') {
      quota('write');
      const b = book(m[1]);
      const body = await readBody(req);
      for (const range of body.ranges || []) { const s = sheetByTitle(b, parseRange(range).title); if (s) s.rows = []; }
      save(m[1]);
      return send(res, 200, { spreadsheetId: m[1], clearedRanges: body.ranges || [] });
    }
    if ((m = path.match(/^\/v4\/spreadsheets\/([^/:]+)$/)) && req.method === 'GET') {
      quota('read');
      const b = book(m[1]);
      return send(res, 200, { spreadsheetId: b.id, properties: { title: b.title }, sheets: b.sheets.map((s) => ({ properties: { sheetId: s.sheetId, title: s.title, index: s.index, gridProperties: { rowCount: Math.max(1000, s.rows.length), columnCount: 26 } } })) });
    }
    if (path === '/drive/v3/files' && req.method === 'GET') {
      const q = url.searchParams.get('q') || '';
      const fm = q.match(/'([^']+)' in parents/);
      if (!fm) return send(res, 200, { files: [] });
      const dir = join(DATA_DIR, 'drive', fm[1]);
      const all = existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith('.') && statSync(join(dir, n)).isFile()).sort().map((n) => driveMeta(fm[1], n)) : [];
      // Pages like Drive: pageSize (default 100, at most 1000) and an opaque pageToken (here the start offset).
      const size = Math.min(Math.max(Number(url.searchParams.get('pageSize')) || 100, 1), 1000);
      const start = Number(url.searchParams.get('pageToken')) || 0;
      const files = all.slice(start, start + size);
      return send(res, 200, { kind: 'drive#fileList', files, ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}) });
    }
    if ((m = path.match(/^\/drive\/v3\/files\/([^/]+)(\/export)?$/)) && req.method === 'GET') {
      const { folder, name } = fromDriveId(m[1]);
      const p = join(DATA_DIR, 'drive', folder, name);
      if (!folder || !existsSync(p)) return send(res, 404, { error: { code: 404, message: `File not found: ${m[1]}.`, status: 'NOT_FOUND' } });
      if (m[2] || url.searchParams.get('alt') === 'media') return send(res, 200, readFileSync(p), MIME[extname(name).toLowerCase()] || 'application/octet-stream');
      return send(res, 200, driveMeta(folder, name));
    }
    return send(res, 404, { error: { code: 404, message: `Not found: ${req.method} ${path}`, status: 'NOT_FOUND' } });
  } catch (e) {
    const code = e.code && Number.isInteger(e.code) ? e.code : 500;
    return send(res, code, { error: { code, message: e.message, status: code === 429 ? 'RESOURCE_EXHAUSTED' : code === 400 ? 'INVALID_ARGUMENT' : 'INTERNAL' } });
  }
}).listen(PORT, () => console.log(`sheets emulator on :${PORT}, data in ${DATA_DIR}${KEY ? ', encrypted on disk (AES-256-GCM)' : ', NOT encrypted (no DATA_ENCRYPTION_KEY)'}${QUOTA ? `, quota ${QUOTA}/min` : ''}`));
