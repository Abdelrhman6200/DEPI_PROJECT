// Prepares the Google Sheets backend: one tab per table (headers from workflows/src/engine/schema.js), a _meta tab with
// the tab ids, and the initial data (database/sheets/seed.json). Record times are moved forward by whole days so the
// demo data is current on the day it is loaded.
//
// Target: the spreadsheet SHEETS_ID at SHEETS_API_URL (default https://sheets.googleapis.com).
//   Google  set GOOGLE_SA_EMAIL and GOOGLE_SA_KEY (the service account's private key; share the spreadsheet with that
//           e-mail address as Editor). The token is made here with Node's crypto, no packages needed.
//   Local   SHEETS_API_URL=http://localhost:8090 (scripts/sheets-emulator.mjs) needs no key.
//
// Options: --reset      clear every tab and load the data again (an existing spreadsheet otherwise only gets
//                       missing tabs and headers)
//          --flag key=true|false   switch a feature flag after the setup (repeatable)
//          SEED_DEMO=false   reference data only (no demo people or readings), plus PLATFORM_ADMIN_EMAIL/_PASSWORD
//          DEMO_PASSWORD     password of the demo accounts (default Demo@2026)
// Maintenance (instead of the setup):
//          --release-claims        events claimed by stopped runs go back to the queue
//          --queue-knowledge-sync  queue a read of the Drive knowledge folder
//          --export                every tab as JSON on standard output (backup)
//          --import <file|->       replace the data of every tab with an export (restore)
// Usage: node scripts/sheets-setup.mjs [--reset] [--flag key=value ...]
import { readFileSync } from 'node:fs';
import { createSign, randomBytes, scryptSync, randomUUID } from 'node:crypto';

const API = (process.env.SHEETS_API_URL || 'https://sheets.googleapis.com').replace(/\/$/, '');
const ID = process.env.SHEETS_ID;
const RESET = process.argv.includes('--reset');
const SEED_DEMO = process.env.SEED_DEMO !== 'false';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Demo@2026';
if (!ID) { console.error('Set SHEETS_ID (the spreadsheet id from its URL).'); process.exit(1); }
const SCHEMA = new Function(`${readFileSync(new URL('../workflows/src/engine/schema.js', import.meta.url), 'utf8')}; return SCHEMA;`)();
const TABLES = Object.keys(SCHEMA);
const DAY = 86400e3;
const TOMBSTONE = '~deleted';

// Reference data is loaded on every installation; the rest is demo data (SEED_DEMO).
const REFERENCE = new Set(['organizations', 'drugs', 'drug_combinations', 'drug_interactions', 'drug_condition_rules', 'allergy_synonyms',
  'lab_catalog', 'lab_units', 'foods', 'facilities', 'facility_capacity', 'intake_questions', 'care_level_rules', 'screening_types',
  'safety_rules', 'error_messages', 'api_routes', 'feature_flags', 'guideline_sources', 'rag_documents', 'diabetes_doctors']);
// Calendar dates that describe a person, not an event, are never moved.
const FIXED_DATES = new Set(['date_of_birth', 'dob', 'diagnosed_on', 'diagnosis_year']);

/* ---------------------------------------------------------------------------------------------------- auth */

let token = null;
async function auth() {
  // The local encrypted store needs no Google sign-in (and must not depend on reaching Google).
  if (!process.env.GOOGLE_SA_EMAIL || !/googleapis\.com/.test(API)) return {};
  if (token && token.exp > Date.now() + 60e3) return { authorization: `Bearer ${token.value}` };
  const key = String(process.env.GOOGLE_SA_KEY || '').replace(/\\n/g, '\n');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: process.env.GOOGLE_SA_EMAIL, scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`Google sign-in failed: ${JSON.stringify(j).slice(0, 300)}`);
  token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return { authorization: `Bearer ${token.value}` };
}
async function api(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', ...(await auth()) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (r.status === 429 && attempt < 6) { await new Promise((ok) => setTimeout(ok, 10e3 * (attempt + 1))); continue; }   // per-minute quota
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${path.split('?')[0]} -> ${r.status} ${JSON.stringify(j).slice(0, 400)}`);
    return j;
  }
}
const sid = encodeURIComponent(ID);

/* ------------------------------------------------------------------------------------------------- helpers */

const header = (t) => Object.keys(SCHEMA[t].columns);

/** A tab as row objects with their sheet row numbers (row 1 is the header). */
async function readTab(tab) {
  const r = await api('GET', `/v4/spreadsheets/${sid}/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&ranges=${encodeURIComponent(tab)}`);
  const values = r.valueRanges[0].values || [];
  const head = values[0] || [];
  return { head, rows: values.slice(1).map((cells, i) => ({ rowNum: i + 2, obj: Object.fromEntries(head.map((h, j) => [h, cells[j] ?? ''])) })).filter((x) => Object.values(x.obj).some((v) => v !== '') && Object.values(x.obj)[0] !== TOMBSTONE) };
}
const colLetter = (n) => { let s = ''; for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
async function setCells(tab, head, updates) {
  if (!updates.length) return;
  await api('POST', `/v4/spreadsheets/${sid}/values:batchUpdate`, { valueInputOption: 'RAW',
    data: updates.map(({ rowNum, col, value }) => ({ range: `${tab}!${colLetter(head.indexOf(col))}${rowNum}`, values: [[value]] })) });
}

/** Creates the tabs that are missing (with room for their columns); returns every tab id by title. */
async function ensureTabs() {
  const meta = await api('GET', `/v4/spreadsheets/${sid}?fields=sheets.properties`);
  const ids = new Map((meta.sheets || []).map((s) => [s.properties.title, s.properties.sheetId]));
  const missing = ['_meta', ...TABLES].filter((t) => !ids.has(t));
  if (missing.length) {
    // A new tab starts small (100 rows): Google counts the empty cells of every tab towards the 10 million cell limit.
    const added = await api('POST', `/v4/spreadsheets/${sid}:batchUpdate`, { requests: missing.map((title) => ({ addSheet: { properties: { title,
      gridProperties: { frozenRowCount: 1, rowCount: 100, columnCount: Math.max(title === '_meta' ? 2 : header(title).length, 1) } } } })) });
    for (const rep of added.replies) ids.set(rep.addSheet.properties.title, rep.addSheet.properties.sheetId);
    console.log(`added ${missing.length} tabs`);
  }
  return ids;
}

/** Makes each tab large enough for what is written to it next. need: { tab: [rows, columns] } */
async function sizeGrids(need) {
  const meta = await api('GET', `/v4/spreadsheets/${sid}?fields=sheets.properties`);
  const requests = [];
  for (const s of meta.sheets || []) {
    const n = need[s.properties.title];
    if (!n) continue;
    const g = s.properties.gridProperties || {};
    const rowCount = Math.max(g.rowCount || 0, n[0]);
    const columnCount = Math.max(g.columnCount || 0, n[1]);
    if (rowCount !== g.rowCount || columnCount !== g.columnCount) {
      requests.push({ updateSheetProperties: { properties: { sheetId: s.properties.sheetId, gridProperties: { rowCount, columnCount } },
        fields: 'gridProperties.rowCount,gridProperties.columnCount' } });
    }
  }
  if (requests.length) await api('POST', `/v4/spreadsheets/${sid}:batchUpdate`, { requests });
}

/** Writes value ranges in calls of about 2 MB (Google accepts larger requests, but smaller ones fail more gracefully). */
async function writeRanges(data) {
  for (let i = 0; i < data.length;) {
    const part = [];
    let size = 0;
    while (i < data.length && (part.length === 0 || size + JSON.stringify(data[i]).length < 2e6)) { size += JSON.stringify(data[i]).length; part.push(data[i++]); }
    await api('POST', `/v4/spreadsheets/${sid}/values:batchUpdate`, { valueInputOption: 'RAW', data: part });
  }
}

/** The _meta tab: the tab ids (the engine addresses its writes by them) and where the data came from. */
async function writeMeta(ids, info) {
  const rows = [['key', 'value'], ...TABLES.map((t) => [`sheet:${t}`, ids.get(t)]), ['schema_tables', TABLES.length],
    ['loaded_at', new Date().toISOString()], ...Object.entries(info)];
  // Written in place (never cleared first: a request reading _meta meanwhile would find no tab ids); rows past the new
  // end are blanked afterwards.
  const cur = await api('GET', `/v4/spreadsheets/${sid}/values:batchGet?ranges=${encodeURIComponent('_meta!A:A')}`);
  const oldLen = (cur.valueRanges[0].values || []).length;
  if (oldLen > rows.length) rows.push(...Array.from({ length: oldLen - rows.length }, () => ['', '']));
  await sizeGrids({ _meta: [rows.length, 2] });
  await writeRanges([{ range: '_meta!A1', values: rows }]);
}

// A deleted row keeps '~deleted' in its first cell (engine 00_runtime.js): it counts as empty here.
const blankRow = (r) => !r || r[0] === TOMBSTONE || r.every((c) => c === '' || c === null || c === undefined);

// The maintenance options below run on their own (without the full setup). Nothing calls process.exit after a request:
// on Windows, Node can abort while a connection is still closing.
let special = false;

// --release-claims: after n8n restarted, events claimed by runs that were stopped go back to the queue (attempt not
// counted), so the dispatcher retries them now instead of after their lease.
if (process.argv.includes('--release-claims')) {
  const { head, rows } = await readTab('outbox');
  const stuck = rows.filter((r) => r.obj.status === 'processing');
  await setCells('outbox', head, stuck.flatMap((r) => [{ rowNum: r.rowNum, col: 'status', value: 'pending' },
    { rowNum: r.rowNum, col: 'attempts', value: Math.max(Number(r.obj.attempts || 0) - 1, 0) }]));
  console.log(`released ${stuck.length} claimed events`);
  special = true;
}

// --queue-knowledge-sync: queues a KnowledgeSyncRequested event, so WF-019c reads the Drive knowledge folder at the next
// dispatcher run (a new installation then has its knowledge base within minutes instead of at the next half hour).
if (process.argv.includes('--queue-knowledge-sync')) {
  const { head, rows } = await readTab('outbox');
  const last = rows.reduce((m, r) => Math.max(m, r.rowNum), 1);
  const nowIso = new Date().toISOString();
  const ev = { event_id: randomUUID(), event_type: 'KnowledgeSyncRequested', payload: '{}', status: 'pending', attempts: 0, occurred_at: nowIso, next_attempt_at: nowIso };
  await sizeGrids({ outbox: [last + 1, head.length] });
  const meta = await api('GET', `/v4/spreadsheets/${sid}?fields=sheets.properties`);
  const outboxId = meta.sheets.find((x) => x.properties.title === 'outbox').properties.sheetId;
  const cell = (v) => (typeof v === 'number' ? { numberValue: v } : { stringValue: String(v) });
  await api('POST', `/v4/spreadsheets/${sid}:batchUpdate`, { requests: [{ appendCells: { sheetId: outboxId, fields: 'userEnteredValue',
    rows: [{ values: head.map((h) => (ev[h] === undefined || ev[h] === '' ? {} : { userEnteredValue: cell(ev[h]) })) }] } }] });
  console.log('knowledge sync queued');
  special = true;
}

// --add-reference <tab>: appends the seed's rows of a reference tab (guideline_sources, facilities, foods, ...) whose
// primary key is not in the spreadsheet yet. The setup itself only fills empty tabs, so reference rows added to
// database/sheets/seed.json later reach an existing installation this way; rows already there are never changed.
const addRef = process.argv.indexOf('--add-reference');
if (addRef >= 0) {
  const t = process.argv[addRef + 1];
  // Demo accounts added to the seed later (the polyclinic staff, 2026-10-20) reach a running demo the same way.
  const DEMO_APPEND = new Set(['users', 'memberships']);
  if (!REFERENCE.has(t) && !DEMO_APPEND.has(t)) throw new Error(`--add-reference: ${t} is not a reference tab (${[...REFERENCE].join(', ')}, or users/memberships)`);
  const seed = JSON.parse(readFileSync(new URL('../database/sheets/seed.json', import.meta.url), 'utf8'));
  const pk = SCHEMA[t].pk || ['id'];
  const key = (o) => pk.map((k) => String(o[k] ?? '')).join('|');
  const { head, rows } = await readTab(t);
  const have = new Set(rows.map((r) => key(r.obj)));
  const hashed = (pw) => { const salt = randomBytes(16).toString('hex'); return `scrypt$16384$8$1$${salt}$${scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex')}`; };
  const add = (seed.tables[t] || []).filter((r) => !have.has(key(r))).map((r) => (t === 'users' ? { ...r, password_hash: hashed(DEMO_PASSWORD) } : r));
  const cols = head.length ? head : header(t);
  const enc = (type, v) => (v === null || v === undefined ? '' : ['json', 'text[]', 'vector'].includes(type) ? JSON.stringify(v)
    : type === 'int' || type === 'num' ? Number(v) : type === 'bool' ? !!v : String(v));
  const last = rows.reduce((m, r) => Math.max(m, r.rowNum), 1);
  if (add.length) {
    await sizeGrids({ [t]: [last + add.length + 1, cols.length] });
    await writeRanges([{ range: `${t}!A${last + 1}`, values: add.map((r) => cols.map((c) => (SCHEMA[t].columns[c] ? enc(SCHEMA[t].columns[c].type, r[c]) : ''))) }]);
  }
  console.log(`${t}: ${add.length} rows added (${have.size} were already there)`);
  special = true;
}

// --export: every tab as JSON on standard output, ten tabs per read request (infra/hostinger/backup.sh). Nothing else
// is written to standard output.
if (process.argv.includes('--export')) {
  const out = { format: 'health-platform-sheets', version: 1, exported_at: new Date().toISOString(), spreadsheet: ID, tabs: {} };
  for (let i = 0; i < TABLES.length; i += 10) {
    const part = TABLES.slice(i, i + 10);
    const r = await api('GET', `/v4/spreadsheets/${sid}/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&${part.map((t) => `ranges=${encodeURIComponent(t)}`).join('&')}`);
    r.valueRanges.forEach((vr, j) => { out.tabs[part[j]] = (vr.values || []).filter((row, k) => k === 0 || !blankRow(row)); });
  }
  process.stdout.write(JSON.stringify(out));
  special = true;
}

// --import <file|->: replaces the data of every tab with an export (infra/hostinger/restore.sh); "-" reads standard
// input. Missing tabs are created, so an export can be loaded into a new, empty spreadsheet. Columns are matched by
// their header, so an export taken before a column was added still loads (the new column stays empty).
const importAt = process.argv.indexOf('--import');
if (importAt > 0) {
  const src = process.argv[importAt + 1];
  if (!src) throw new Error('--import needs a file, or - for standard input');
  const data = JSON.parse(readFileSync(src === '-' ? 0 : src, 'utf8'));
  if (data.format !== 'health-platform-sheets' || !data.tabs) throw new Error('not an export written by sheets-setup.mjs --export');
  const ids = await ensureTabs();
  const values = {};
  let rowCount = 0;
  for (const t of TABLES) {
    const head = header(t);
    const [oldHead = [], ...body] = data.tabs[t] || [];
    const at = head.map((c) => oldHead.indexOf(c));
    const rows = body.filter((r) => !blankRow(r)).map((r) => at.map((j) => (j < 0 ? '' : r[j] ?? '')));
    values[t] = [head, ...rows];
    rowCount += rows.length;
  }
  const skipped = Object.keys(data.tabs).filter((t) => !SCHEMA[t] && t !== '_meta');
  await api('POST', `/v4/spreadsheets/${sid}/values:batchClear`, { ranges: TABLES });
  await sizeGrids(Object.fromEntries(TABLES.map((t) => [t, [values[t].length + 1, header(t).length]])));
  await writeRanges(TABLES.map((t) => ({ range: `${t}!A1`, values: values[t] })));
  await writeMeta(ids, { restored_from: data.exported_at, restored_spreadsheet: data.spreadsheet || '' });
  console.log(`restored ${rowCount} rows into ${TABLES.length} tabs from the export of ${data.exported_at}${skipped.length ? ` (tabs no longer used, not loaded: ${skipped.join(', ')})` : ''}`);
  special = true;
}

/* --------------------------------------------------------------------------------------------------- setup */
if (!special) {

const ids = await ensureTabs();
if (RESET) {
  await api('POST', `/v4/spreadsheets/${sid}/values:batchClear`, { ranges: ['_meta', ...TABLES] });
  console.log('cleared every tab');
}

// Headers (row 1) and the tab ids. _meta also records when and from what the data was loaded.
const seed = JSON.parse(readFileSync(new URL('../database/sheets/seed.json', import.meta.url), 'utf8'));
const shiftDays = Math.round((Date.now() - Date.parse(seed.exported_at)) / DAY);
await sizeGrids(Object.fromEntries(TABLES.map((t) => [t, [2, header(t).length]])));
await writeMeta(ids, { seed_exported_at: seed.exported_at, shift_days: shiftDays, demo_data: SEED_DEMO });
await writeRanges(TABLES.map((t) => ({ range: `${t}!A1`, values: [header(t)] })));

// Data: only into empty tabs (or after --reset), so running setup again never duplicates rows.
const filled = new Set();
if (!RESET) {
  const probe = await api('GET', `/v4/spreadsheets/${sid}/values:batchGet?${TABLES.map((t) => `ranges=${encodeURIComponent(`${t}!A2:A3`)}`).join('&')}`);
  probe.valueRanges.forEach((vr, i) => { if (vr.values && vr.values.length) filled.add(TABLES[i]); });
}
const scrypt = (pw) => { const salt = randomBytes(16).toString('hex'); return `scrypt$16384$8$1$${salt}$${scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex')}`; };
const cell = (type, v, col) => {
  if (v === null || v === undefined) return '';
  if (type === 'ts') return new Date(Date.parse(v) + shiftDays * DAY).toISOString();
  if (type === 'date' && !FIXED_DATES.has(col)) { const d = new Date(Date.parse(`${String(v).slice(0, 10)}T00:00:00Z`) + shiftDays * DAY); return d.toISOString().slice(0, 10); }
  if (type === 'json' || type === 'text[]' || type === 'vector') return JSON.stringify(v);
  if (type === 'int' || type === 'num') return Number(v);
  if (type === 'bool') return !!v;
  return String(v);
};
let rowsWritten = 0;
const batch = [];
for (const t of TABLES) {
  if (filled.has(t)) continue;
  if (!SEED_DEMO && !REFERENCE.has(t)) continue;
  let rows = seed.tables[t] || [];
  if (t === 'users') rows = rows.map((u) => ({ ...u, password_hash: scrypt(DEMO_PASSWORD) }));
  if (!rows.length) continue;
  const cols = header(t);
  batch.push({ range: `${t}!A2`, values: rows.map((r) => cols.map((c) => cell(SCHEMA[t].columns[c].type, r[c], c))) });
  rowsWritten += rows.length;
}
// The first platform administrator of a real deployment: only while the users tab is still empty, so a later run never
// replaces the account (or a person created since).
if (!SEED_DEMO && !filled.has('users') && process.env.PLATFORM_ADMIN_EMAIL && process.env.PLATFORM_ADMIN_PASSWORD) {
  const u = { id: randomUUID(), email: process.env.PLATFORM_ADMIN_EMAIL.toLowerCase(), password_hash: scrypt(process.env.PLATFORM_ADMIN_PASSWORD),
    full_name: 'Platform administrator', role: 'platform_admin', locale: 'en', active: true, mfa_enabled: false, must_change_password: true, created_at: new Date().toISOString() };
  batch.push({ range: 'users!A2', values: [header('users').map((c) => cell(SCHEMA.users.columns[c].type, u[c], c))] });
  rowsWritten++;
  console.log(`platform administrator ${u.email} created (must change the password at first sign-in)`);
}
await sizeGrids(Object.fromEntries(batch.map((b) => [b.range.split('!')[0], [b.values.length + 2, header(b.range.split('!')[0]).length]])));
await writeRanges(batch);

// Rules come from the source tree on every run (database/migrate.sh upserted database/rules the same way): the safety
// rules and error messages (database/sheets/rules.json) and the API route table (database/sheets/api_routes.json, made
// by the build). Rows with the same key are replaced; a safety rule whose settings changed gets the next version.
const rulesFile = JSON.parse(readFileSync(new URL('../database/sheets/rules.json', import.meta.url), 'utf8'));
let routesFile = [];
try { routesFile = JSON.parse(readFileSync(new URL('../database/sheets/api_routes.json', import.meta.url), 'utf8')); } catch (e) { console.log('no database/sheets/api_routes.json yet (run node workflows/src/build.mjs)'); }
const parseCell = (type, v) => {
  if (v === '' || v === undefined || v === null) return null;
  if ((type === 'json' || type === 'text[]') && typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return v; } }
  return v;
};
const current = await api('GET', `/v4/spreadsheets/${sid}/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&ranges=safety_rules&ranges=error_messages&ranges=api_routes`);
const nowIso = new Date().toISOString();
const refresh = [];
[['safety_rules', 'code', rulesFile.safety_rules], ['error_messages', 'pattern', rulesFile.error_messages], ['api_routes', 'grp', routesFile]].forEach(([tab, key, rows], i) => {
  if (!rows || !rows.length) return;
  const values = current.valueRanges[i].values || [];
  const head = values[0] || header(tab);
  const existing = values.slice(1).filter((r) => r.some((c) => c !== '' && c !== null)).map((r) => Object.fromEntries(head.map((h, j) => [h, parseCell(SCHEMA[tab].columns[h]?.type, r[j])])));
  const byKey = new Map(existing.map((r) => [String(r[key]), r]));
  for (const r of rows) {
    const old = byKey.get(String(r[key]));
    const merged = { ...(old || {}), ...r };
    if (tab === 'safety_rules') {
      const changed = !old || JSON.stringify(old.config) !== JSON.stringify(r.config) || old.kind !== r.kind;
      merged.version = changed ? Number(old?.version || 0) + 1 : Number(old.version || 1);
      merged.updated_at = changed ? nowIso : (old.updated_at || nowIso);
      if (merged.active === undefined || merged.active === null) merged.active = true;
    }
    byKey.set(String(r[key]), merged);
  }
  const cols = header(tab);
  refresh.push({ tab, oldLen: values.length, rows: [cols, ...[...byKey.values()].map((r) => cols.map((c) => { const v = r[c]; return v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : v); }))] });
});
if (refresh.length) {
  // Written in place, never cleared first: a request reading the tab meanwhile must not find it empty ("no header row").
  // Rows past the new end are blanked in the same write.
  for (const r of refresh) { const w = Math.max(...r.rows.map((x) => x.length)); while (r.rows.length < r.oldLen) r.rows.push(Array(w).fill('')); }
  await sizeGrids(Object.fromEntries(refresh.map((r) => [r.tab, [r.rows.length + 1, r.rows[0].length]])));
  await writeRanges(refresh.map((r) => ({ range: `${r.tab}!A1`, values: r.rows })));
}
console.log(`rules: ${refresh.map((r) => `${r.tab} ${r.rows.length - 1}`).join(', ')}`);

// --flag key=true|false: switches a feature flag (for example email_delivery when an SMTP server is configured).
const flags = process.argv.flatMap((a, i) => (a === '--flag' ? [process.argv[i + 1]] : [])).filter(Boolean);
if (flags.length) {
  const { head, rows } = await readTab('feature_flags');
  const updates = [];
  for (const f of flags) {
    const [key, value] = f.split('=');
    const row = rows.find((r) => r.obj.key === key);
    if (row) updates.push({ rowNum: row.rowNum, col: 'enabled', value: value === 'true' });
    else console.log(`unknown feature flag ${key}`);
  }
  await setCells('feature_flags', head, updates);
  console.log(`flags: ${flags.join(', ')}`);
}
console.log(`spreadsheet ${ID}: ${TABLES.length + 1} tabs, ${rowsWritten} rows loaded${filled.size ? ` (${filled.size} tabs already had data and were left as they are)` : ''}, times moved forward ${shiftDays} day(s)`);
}
