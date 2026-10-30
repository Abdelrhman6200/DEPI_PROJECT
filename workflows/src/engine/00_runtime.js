// Engine runtime: the in-memory tables of one request, loaded from Google Sheets, with the rules the database enforced
// (types, defaults, not-null, check, unique, foreign keys, the append-only audit log), an undo log for rollback, the
// changes to write back, and Postgres-compatible helpers (time in Africa/Cairo, regular expressions, rounding, crypto).
//
// The engine is plain JavaScript in one shared scope (schema.js, this file, one file per former SQL migration,
// 99_entry.js). n8n loads it once per Code node run with new Function('require', code)(require); tests load the same
// text in Node. Nothing is kept between runs: every request opens its own DB.
//
// Data access always names the table with a string literal (dbRows('patients'), dbInsert('outbox', {...})) so the
// build can tell which tabs a request needs.

/* ------------------------------------------------------------------------------------------------------- state */

let DB = null;
const META = new WeakMap();          // row -> { table, rowNum (sheet row, 1-based; null for new rows), state }
let SERIAL = 0;
const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
// The first cell of a deleted row (rows are never removed: other requests may hold row numbers below them).
const TOMBSTONE = '~deleted';
const TZ = 'Africa/Cairo';

/**
 * Opens the data of one request.
 *   sheets: { table: [[header...], [row...], ...] } (Sheets values, UNFORMATTED) or { table: [rowObject, ...] }
 *   now:    the request time (ISO); every now() of the request returns it, like a database transaction.
 *   versions: { tab: stamp } the Sheets cache put on the read (cacheVersions), sent back with the write (see dbWrites).
 */
function dbOpen({ sheets = {}, now, sheetIds = {}, versions = {} } = {}) {
  DB = { t: {}, now: iso(now || new Date()), undo: [], sheetIds, files: [], settings: {}, versions: versions || {} };   // settings: set_config()/current_setting() of the request
  for (const [name, data] of Object.entries(sheets)) dbLoadTable(name, data);
  return DB;
}

function dbLoadTable(name, data) {
  const def = SCHEMA[name];
  if (!def) throw new Error(`engine: unknown table ${name}`);
  const cols = Object.keys(def.columns);
  const tab = { name, rows: [], header: cols, index: null };
  if (Array.isArray(data) && data.length && Array.isArray(data[0])) {
    const header = data[0].map((h) => String(h).trim());
    tab.header = header;
    const pos = Object.fromEntries(header.map((h, i) => [h, i]));
    const pk = def.pk || [];
    const byKey = new Map();
    const rowNumOf = (r) => (data.rowNumbers ? data.rowNumbers[r - 1] : r + 1);
    // A filtered read (some rows only): its unique keys are always checked again by the Sheets cache, and it is never compacted.
    if (data.rowNumbers) tab.partial = true;
    tab.tombstones = [];
    for (let r = 1; r < data.length; r++) {
      const cells = data[r] || [];
      if (cells[0] === TOMBSTONE) { tab.tombstones.push({ rowNum: rowNumOf(r), cells }); continue; }   // a deleted row (see dbWrites)
      if (!cells.some((c) => c !== '' && c != null)) continue;          // a blank row (deleted before tombstones)
      const row = {};
      for (const c of cols) row[c] = fromCell(def.columns[c].type, pos[c] === undefined ? null : cells[pos[c]]);
      // cells: the row as read, so the write can ask the Sheets cache to check that nobody changed it since (dbWrites).
      META.set(row, { table: name, rowNum: rowNumOf(r), state: 'loaded', orig: null, cells });
      // The same primary key twice: a write that was retried after it had landed appended its rows again. The later
      // copy is kept; the earlier one is marked deleted, so the next write of the request tombstones it.
      if (pk.length) {
        const key = pk.map((c) => JSON.stringify(row[c])).join('|');
        const prev = byKey.get(key);
        if (prev) {
          tab.rows.splice(tab.rows.indexOf(prev), 1);
          META.get(prev).state = 'deleted';
          tab.duplicates = (tab.duplicates || []).concat(prev);
        }
        byKey.set(key, row);
      }
      tab.rows.push(row);
    }
  } else if (Array.isArray(data)) {
    for (const o of data) {
      const row = {};
      for (const c of cols) row[c] = o[c] === undefined ? null : cloneValue(o[c]);
      META.set(row, { table: name, rowNum: null, state: 'loaded', orig: null });
      tab.rows.push(row);
    }
  }
  DB.t[name] = tab;
}

/**
 * A table of the request. A table the request did not read raises ENGINE_MISSING_TABLE: the API then reads again with
 * that tab added and runs the request from the start (nothing is written before that).
 */
function tab(name) {
  const t = DB && DB.t[name];
  if (!t) {
    const e = new Error(`engine: table ${name} was not loaded for this request`);
    e.code = 'ENGINE_MISSING_TABLE';
    e.table = name;
    throw e;
  }
  return t;
}
/** The tabs the request has read. */
function dbLoadedTables() { return DB ? Object.keys(DB.t) : []; }

/* ------------------------------------------------------------------------------------------------ cell values */

function fromCell(type, v) {
  if (v === '' || v === null || v === undefined) return null;
  switch (type) {
    case 'int': case 'num': return typeof v === 'number' ? v : (Number.isFinite(Number(v)) ? Number(v) : null);
    case 'bool': return v === true || v === 'TRUE' || v === 'true';
    case 'json': case 'text[]': case 'vector':
      if (typeof v !== 'string') return v;
      try { return JSON.parse(v); } catch (e) { return type === 'json' ? v : null; }
    case 'tsvector': return null;
    default: return typeof v === 'string' ? v : String(v);
  }
}

function toCell(type, v) {
  if (v === null || v === undefined) return {};
  let value;
  switch (type) {
    case 'int': case 'num': return { userEnteredValue: { numberValue: Number(v) } };
    case 'bool': return { userEnteredValue: { boolValue: !!v } };
    case 'json': case 'text[]': case 'vector': value = JSON.stringify(v); break;
    case 'tsvector': return {};
    default: value = String(v);
  }
  if (value.length > 50000) throw new Error('bad_request: a value is too long to be stored (more than 50,000 characters)');
  return { userEnteredValue: { stringValue: value } };
}

function cloneValue(v) { return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v; }

/* ----------------------------------------------------------------------------------------------------- reads */

function dbRows(name) { return tab(name).rows.filter((r) => META.get(r).state !== 'deleted'); }
function dbWhere(name, pred) { return dbRows(name).filter(pred); }
function dbOne(name, pred) { return tab(name).rows.find((r) => META.get(r).state !== 'deleted' && pred(r)) || null; }
function dbExists(name, pred) { return dbOne(name, pred) !== null; }
function dbCount(name, pred) { return pred ? dbWhere(name, pred).length : dbRows(name).length; }
/** Row by primary key (single-column keys). */
function dbGet(name, key) {
  if (key === null || key === undefined) return null;
  const t = tab(name);
  const pk = (SCHEMA[name].pk || ['id'])[0];
  if (!t.index) { t.index = new Map(); for (const r of t.rows) t.index.set(String(r[pk]), r); }
  const r = t.index.get(String(key));
  return r && META.get(r).state !== 'deleted' ? r : null;
}

/* ---------------------------------------------------------------------------------------------------- writes */

/**
 * Inserts a row: defaults, type checks and constraints as in the database. Returns the stored row.
 *   opts.onConflict: 'nothing' -> returns null instead of failing on a unique conflict;
 *                    { cols?: [...], set: patch | (existing, values) => patch } -> updates the conflicting row.
 */
function dbInsert(name, values, opts = {}) {
  const t = tab(name);
  const def = SCHEMA[name];
  const row = {};
  for (const [c, cd] of Object.entries(def.columns)) {
    let v = values[c];
    if (v === undefined) v = defaultValue(cd.default);
    row[c] = normalize(name, c, cd.type, v);
  }
  for (const c of Object.keys(values)) if (!(c in def.columns)) throw new Error(`column "${c}" of relation "${name}" does not exist`);
  validateRow(name, row);
  const clash = uniqueClash(name, row, null, opts.onConflict && opts.onConflict.cols);
  if (clash) {
    if (opts.onConflict === 'nothing') return null;
    if (opts.onConflict && opts.onConflict.set) {
      const patch = typeof opts.onConflict.set === 'function' ? opts.onConflict.set(clash, row) : opts.onConflict.set;
      return dbUpdate(name, clash, patch);
    }
    throw new Error(`duplicate key value violates unique constraint "${name}_key"`);
  }
  checkForeignKeys(name, row, Object.keys(def.columns));
  t.rows.push(row);
  if (t.index) t.index.set(String(row[(def.pk || ['id'])[0]]), row);
  // genPk: the key was generated here (a random uuid or a time-based serial), so no other request can hold it.
  const pkDef = def.pk && def.pk.length === 1 ? def.columns[def.pk[0]] : null;
  const genPk = !!(pkDef && values[def.pk[0]] === undefined && pkDef.default && ['uuid', 'serial'].includes(pkDef.default.kind));
  META.set(row, { table: name, rowNum: null, state: 'new', orig: null, genPk });
  DB.undo.push(() => { t.rows.splice(t.rows.indexOf(row), 1); if (t.index) t.index.delete(String(row[(def.pk || ['id'])[0]])); });
  return row;
}

/** Updates a row in place (patch: object of new values). Returns the row. */
function dbUpdate(name, row, patch) {
  if (name === 'audit_logs') throw new Error('audit_logs is append-only');
  const def = SCHEMA[name];
  const meta = META.get(row);
  if (!meta || meta.table !== name || meta.state === 'deleted') throw new Error(`engine: update of a row that is not in ${name}`);
  const before = { ...row };
  const next = { ...row };
  for (const [c, v] of Object.entries(patch)) {
    if (!(c in def.columns)) throw new Error(`column "${c}" of relation "${name}" does not exist`);
    next[c] = normalize(name, c, def.columns[c].type, v);
  }
  validateRow(name, next);
  if (uniqueClash(name, next, row)) throw new Error(`duplicate key value violates unique constraint "${name}_key"`);
  checkForeignKeys(name, next, Object.keys(patch));
  if (meta.state === 'loaded' && !meta.orig) meta.orig = before;
  Object.assign(row, next);
  DB.undo.push(() => Object.assign(row, before));
  return row;
}

/** Updates every row that matches; returns the number of rows. */
function dbUpdateWhere(name, pred, patch) {
  const list = dbWhere(name, pred);
  for (const r of list) dbUpdate(name, r, typeof patch === 'function' ? patch(r) : patch);
  return list.length;
}

/** Deletes a row, with the foreign-key actions of the database (cascade, set null, restrict). */
function dbDelete(name, row) {
  if (name === 'audit_logs') throw new Error('audit_logs is append-only');
  const meta = META.get(row);
  if (!meta || meta.state === 'deleted') return;
  for (const [child, def] of Object.entries(SCHEMA)) {
    for (const fk of def.fks || []) {
      if (fk.ref !== name || !DB.t[child]) continue;
      const refs = dbWhere(child, (c) => fk.cols.every((col, i) => c[col] !== null && String(c[col]) === String(row[fk.refcols[i]])));
      if (!refs.length) continue;
      if (fk.onDelete === 'cascade') for (const c of refs) dbDelete(child, c);
      else if (fk.onDelete === 'set null') for (const c of refs) dbUpdate(child, c, Object.fromEntries(fk.cols.map((col) => [col, null])));
      else throw new Error(`update or delete on table "${name}" violates foreign key constraint "${child}_${fk.cols.join('_')}_fkey" on table "${child}"`);
    }
  }
  const prev = meta.state;
  if (prev === 'new') meta.wasNew = true;
  meta.state = 'deleted';
  DB.undo.push(() => { meta.state = prev; meta.wasNew = false; });
  // A deleted document takes its stored file with it (on whatever path: account deletion, cascades, retention).
  if (name === 'documents' && row.file_ref) dbFileRemove(row.file_ref);
}

/* ------------------------------------------------------------------------------------------------------ files */

// Uploaded files are kept on the n8n server (a private volume under ~/.n8n-files), not in a Sheets cell. The engine
// lists the files a request writes; the workflow writes them before it saves the Sheets changes. A removed file is
// overwritten with a short marker (n8n has no node that deletes files).
const FILE_REMOVED = Buffer.from('removed').toString('base64');
function dbFileWrite(path, base64) {
  // documents/<document id>: n8n's write node does not create folders, so files are not grouped in subfolders.
  if (!/^documents\/[0-9a-f-]{36}$/.test(String(path))) throw new Error(`engine: bad file path ${path}`);
  const entry = { path, base64 };
  DB.files.push(entry);
  DB.undo.push(() => { DB.files.splice(DB.files.indexOf(entry), 1); });
}
function dbFileRemove(path) { dbFileWrite(path, FILE_REMOVED); }
/** The files this request writes: [{ path, base64 }] (the last write of a path wins). */
function dbFiles() {
  const last = new Map();
  for (const f of DB.files) last.set(f.path, f);
  return [...last.values()];
}

function dbDeleteWhere(name, pred) {
  const list = dbWhere(name, pred);
  for (const r of list) dbDelete(name, r);
  return list.length;
}

/* -------------------------------------------------------------------------------------------- transactions */

/** Savepoint of the undo log; dbRollbackTo(sp) undoes every change made after it. */
function dbSavepoint() { return DB.undo.length; }
function dbRollbackTo(sp) { while (DB.undo.length > sp) DB.undo.pop()(); }
/** Runs fn as a subtransaction (a plpgsql BEGIN ... EXCEPTION block): its changes are undone if it throws. */
function dbTry(fn, onError) {
  const sp = dbSavepoint();
  try { return fn(); } catch (e) {
    dbRollbackTo(sp);
    if (onError && !(e && e.code === 'ENGINE_MISSING_TABLE')) return onError(e);   // a missing tab always reaches the API
    throw e;
  }
}

/* ------------------------------------------------------------------------------------------------- validation */

function defaultValue(d) {
  if (!d) return null;
  switch (d.kind) {
    case 'uuid': return uuid();
    case 'now': return now();
    case 'now+': return iso(nowMs() + d.ms);
    case 'today': return today();
    case 'serial': return nextSerial();
    case 'value': return cloneValue(d.value);
    default: return null;
  }
}

function normalize(table, col, type, v) {
  if (v === undefined || v === null) return null;
  switch (type) {
    case 'uuid': return castUuid(v);
    case 'int': { const n = castNum(v, 'integer'); if (!Number.isInteger(n)) throw new Error(`invalid input syntax for type integer: "${v}"`); return n; }
    case 'num': return castNum(v, 'numeric');
    case 'bool': return castBool(v);
    case 'ts': return castTs(v);
    case 'date': return castDate(v);
    case 'text': return typeof v === 'string' ? v : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    case 'text[]': if (!Array.isArray(v)) throw new Error(`malformed array literal: "${v}"`); return v.map((x) => (x === null ? null : String(x)));
    case 'json': return typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch (e) { throw new Error(`invalid input syntax for type json`); } })() : cloneValue(v);
    case 'vector': return Array.isArray(v) ? v.map(Number) : JSON.parse(v);
    default: return null;
  }
}

function validateRow(name, row) {
  const def = SCHEMA[name];
  for (const [c, cd] of Object.entries(def.columns)) {
    if (cd.notnull && (row[c] === null || row[c] === undefined)) throw new Error(`null value in column "${c}" of relation "${name}" violates not-null constraint`);
  }
  for (const ck of def.checks || []) {
    const v = row[ck.col];
    if (v === null || v === undefined) continue;                     // a check passes on NULL, as in SQL
    const ok = ck.in ? ck.in.includes(v)
      : ck.op ? ({ '>=': v >= ck.value, '>': v > ck.value, '<=': v <= ck.value, '<': v < ck.value })[ck.op]
      : (v >= ck.min && v <= ck.max);
    if (!ok) throw new Error(`new row for relation "${name}" violates check constraint "${name}_${ck.col}_check"`);
  }
}

function keyOf(row, cols) {
  const vals = cols.map((c) => row[c]);
  if (vals.some((v) => v === null || v === undefined)) return null;  // NULLs never conflict
  return JSON.stringify(vals.map((v) => String(v)));
}

/** The existing row a new or changed row would duplicate on any unique key, or null. */
function uniqueClash(name, row, self, onlyCols) {
  const def = SCHEMA[name];
  const sets = [];
  if (def.pk) sets.push({ cols: def.pk });
  for (const u of def.unique || []) sets.push({ cols: u });
  for (const u of def.uniqueWhere || []) sets.push(u);
  for (const s of sets) {
    if (onlyCols && JSON.stringify(s.cols) !== JSON.stringify(onlyCols) && s.cols !== def.pk) continue;
    const applies = (r) => !s.where || (s.where.notnull ? r[s.where.col] !== null && r[s.where.col] !== undefined : r[s.where.col] === s.where.eq);
    if (!applies(row)) continue;
    const k = keyOf(row, s.cols);
    if (k === null) continue;
    const hit = tab(name).rows.find((r) => r !== self && META.get(r).state !== 'deleted' && applies(r) && keyOf(r, s.cols) === k);
    if (hit) return hit;
  }
  return null;
}

function checkForeignKeys(name, row, changedCols) {
  for (const fk of SCHEMA[name].fks || []) {
    if (!fk.cols.some((c) => changedCols.includes(c))) continue;
    if (fk.cols.some((c) => row[c] === null || row[c] === undefined)) continue;
    if (!DB.t[fk.ref]) continue;                                       // the referenced tab is not part of this request
    const ok = fk.refcols.length === 1 && (SCHEMA[fk.ref].pk || [])[0] === fk.refcols[0]
      ? !!dbGet(fk.ref, row[fk.cols[0]])
      : dbExists(fk.ref, (r) => fk.cols.every((c, i) => String(r[fk.refcols[i]]) === String(row[c])));
    if (!ok) throw new Error(`insert or update on table "${name}" violates foreign key constraint "${name}_${fk.cols.join('_')}_fkey"`);
  }
}

/* ------------------------------------------------------------------------------------------------------ casts */

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Casts like Postgres: a bad value throws "invalid input syntax for type ...", which the API answers with 400. */
function castUuid(v) {
  if (v === null || v === undefined || v === '') { if (v === '') throw new Error('invalid input syntax for type uuid: ""'); return null; }
  const s = String(v).trim();
  if (!UUID_FORMAT.test(s)) throw new Error(`invalid input syntax for type uuid: "${String(v).slice(0, 60)}"`);
  return s.toLowerCase();
}
function castNum(v, typeName = 'numeric') {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error(`invalid input syntax for type ${typeName}: "${v}"`); return v; }
  const s = String(v).trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(s)) throw new Error(`invalid input syntax for type ${typeName}: "${String(v).slice(0, 60)}"`);
  return Number(s);
}
/** ::jsonb — JSON text is parsed (bad text throws like Postgres); a value that is already parsed is kept. */
function castJson(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { throw new Error('invalid input syntax for type json'); }
}
/** ::int — text must be a whole number ('1.5'::int fails); a number is rounded half away from zero (1.5::int = 2). */
function castInt(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') { const s = v.trim(); if (!/^[+-]?\d+$/.test(s)) throw new Error(`invalid input syntax for type integer: "${v.slice(0, 60)}"`); return Number(s); }
  const n = castNum(v, 'integer');
  return Number.isInteger(n) ? n : round(n);
}
function castBool(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['t', 'true', 'y', 'yes', 'on', '1'].includes(s)) return true;
  if (['f', 'false', 'n', 'no', 'off', '0'].includes(s)) return false;
  throw new Error(`invalid input syntax for type boolean: "${String(v).slice(0, 60)}"`);
}
function castTs(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) { if (isNaN(v)) throw new Error('invalid input syntax for type timestamp with time zone'); return v.toISOString(); }
  if (typeof v === 'number') return new Date(v).toISOString();
  const s = String(v).trim();
  // A date or a time without zone is Cairo local time, as in the database.
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?$/);
  if (m) return iso(cairoLocalToMs(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), m[7] ? Math.round(Number(m[7]) * 1000) : 0));
  const ms = Date.parse(s);
  if (!/^\d{4}-\d{2}-\d{2}/.test(s) || isNaN(ms)) throw new Error(`invalid input syntax for type timestamp with time zone: "${s.slice(0, 60)}"`);
  return new Date(ms).toISOString();
}
function castDate(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error(`invalid input syntax for type date: "${s.slice(0, 60)}"`);
  if (s.length > 10) return localDate(castTs(s));
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1) throw new Error(`date/time field value out of range: "${s}"`);
  return s.slice(0, 10);
}

/* -------------------------------------------------------------------------------------------------------- time */

function now() { return DB ? DB.now : new Date().toISOString(); }
function nowMs() { return Date.parse(now()); }
function clockNow() { return new Date().toISOString(); }
/** Milliseconds of a time (ISO text, Date or ms); null stays null. */
function t(x) { if (x === null || x === undefined) return null; if (typeof x === 'number') return x; if (x instanceof Date) return x.getTime(); return Date.parse(x); }
function iso(x) { if (x === null || x === undefined) return null; return new Date(typeof x === 'string' ? Date.parse(x) : x).toISOString(); }
function ago(ms) { return iso(nowMs() - ms); }
function later(ms) { return iso(nowMs() + ms); }

const CAIRO_FMT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
/** Cairo wall-clock parts of a time: { y, mo, d, h, mi, s, dow (0 = Sunday) }. */
function cairoParts(x) {
  const ms = t(x);
  const p = Object.fromEntries(CAIRO_FMT.formatToParts(new Date(ms)).map((q) => [q.type, q.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, dow: DOW[p.weekday], ms: ms % 1000 };
}
/** The UTC time of a Cairo wall-clock time. */
function cairoLocalToMs(y, mo, d, h = 0, mi = 0, s = 0, ms = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  let off = offsetMs(guess);
  let res = guess - off;
  const off2 = offsetMs(res);
  if (off2 !== off) res = guess - off2;
  return res;
}
function offsetMs(ms) { const p = cairoParts(ms); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - (ms - (ms % 1000)); }
const pad = (n, w = 2) => String(n).padStart(w, '0');
/** (ts at time zone 'Africa/Cairo')::date */
function localDate(x) { if (x === null || x === undefined) return null; const p = cairoParts(x); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; }
/** app.fn_local(ts): Cairo wall-clock time without zone, 'YYYY-MM-DDTHH:MM:SS'. */
function localTimestamp(x) { if (x === null || x === undefined) return null; const p = cairoParts(x); return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`; }
function localHour(x) { return cairoParts(x).h; }
function localMinuteOfDay(x) { const p = cairoParts(x); return p.h * 60 + p.mi; }
/** to_char(fn_local(ts), 'HH24:MI') */
function localHHMM(x) { if (x === null || x === undefined) return null; const p = cairoParts(x); return `${pad(p.h)}:${pad(p.mi)}`; }
/** current_date in the database time zone. */
function today() { return localDate(now()); }
/** The start (Cairo midnight) of a date, as an ISO time: date::timestamptz. */
function dayStart(date) { const [y, m, d] = String(date).slice(0, 10).split('-').map(Number); return iso(cairoLocalToMs(y, m, d)); }
function addDays(date, n) { const [y, m, d] = String(date).slice(0, 10).split('-').map(Number); const x = new Date(Date.UTC(y, m - 1, d + n)); return x.toISOString().slice(0, 10); }
/** date_a - date_b in days. */
function daysBetween(a, b) { return Math.round((Date.parse(String(a).slice(0, 10)) - Date.parse(String(b).slice(0, 10))) / DAY); }
/** date_trunc(unit, ts) in Cairo time: 'hour', 'day', 'week' (Monday), 'month'. Returns an ISO time. */
function dateTrunc(unit, x) {
  const p = cairoParts(x);
  if (unit === 'hour') return iso(cairoLocalToMs(p.y, p.mo, p.d, p.h));
  if (unit === 'day') return iso(cairoLocalToMs(p.y, p.mo, p.d));
  if (unit === 'week') { const back = (p.dow + 6) % 7; const d = addDays(`${p.y}-${pad(p.mo)}-${pad(p.d)}`, -back); return dayStart(d); }
  if (unit === 'month') return iso(cairoLocalToMs(p.y, p.mo, 1));
  throw new Error(`engine: dateTrunc ${unit}`);
}
/** Whole years between a date of birth and today (extract(year from age(dob))). */
function ageYears(dob, ref) {
  if (!dob) return null;
  const [y, m, d] = String(dob).slice(0, 10).split('-').map(Number);
  const r = (ref ? String(ref) : today()).slice(0, 10).split('-').map(Number);
  let a = r[0] - y;
  if (r[1] < m || (r[1] === m && r[2] < d)) a--;
  return a;
}
/** extract(epoch from (a - b)) / 60 etc.: minutes, hours and days between two times. */
function minutesBetween(a, b) { return (t(a) - t(b)) / MIN; }
function hoursBetween(a, b) { return (t(a) - t(b)) / HOUR; }
function daysBetweenTs(a, b) { return (t(a) - t(b)) / DAY; }

/* -------------------------------------------------------------------------------------------- numbers and lists */

/** round(x, d) for numeric: half away from zero, as Postgres. */
function round(x, d = 0) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return null;
  const f = Math.pow(10, d);
  const v = Number(x) * f;
  const r = Math.sign(v) * Math.round(Math.abs(v) + 1e-9);
  return r / f;
}
const nums = (arr) => arr.filter((v) => v !== null && v !== undefined && !Number.isNaN(Number(v))).map(Number);
function sum(arr) { const a = nums(arr); return a.length ? a.reduce((x, y) => x + y, 0) : null; }
function avg(arr) { const a = nums(arr); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function minOf(arr) { const a = arr.filter((v) => v !== null && v !== undefined); return a.length ? a.reduce((x, y) => (y < x ? y : x)) : null; }
function maxOf(arr) { const a = arr.filter((v) => v !== null && v !== undefined); return a.length ? a.reduce((x, y) => (y > x ? y : x)) : null; }
/** percentile_cont(p) within group (order by v) */
function percentileCont(arr, p) {
  const a = nums(arr).sort((x, y) => x - y);
  if (!a.length) return null;
  const pos = (a.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}
/** stddev_samp */
function stddev(arr) { const a = nums(arr); if (a.length < 2) return null; const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1)); }
/** Sort helper: sortBy(list, r => [key1, -key2]) with SQL-like NULLS LAST for ascending keys. */
function sortBy(list, keyFn) {
  return [...list].sort((a, b) => {
    const ka = keyFn(a), kb = keyFn(b);
    for (let i = 0; i < ka.length; i++) {
      const x = ka[i], y = kb[i];
      if (x === y) continue;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return x < y ? -1 : 1;
    }
    return 0;
  });
}
/**
 * ORDER BY with Postgres rules: orderBy(list, r => r.a, [r => r.b, 'desc'], [r => r.c, 'asc', 'nulls first']).
 * Ascending puts NULLs last and descending puts them first, unless 'nulls first' / 'nulls last' is given. The sort is
 * stable, so rows with equal keys keep their order.
 */
function orderBy(list, ...keys) {
  const spec = keys.map((k) => (typeof k === 'function' ? [k, 'asc'] : k)).map(([fn, dir = 'asc', nulls]) => ({ fn, desc: dir === 'desc', nullsFirst: nulls ? nulls === 'nulls first' : dir === 'desc' }));
  return [...list].map((r, i) => ({ r, i, k: spec.map((s) => s.fn(r)) })).sort((a, b) => {
    for (let j = 0; j < spec.length; j++) {
      const x = a.k[j], y = b.k[j], s = spec[j];
      const xn = x === null || x === undefined, yn = y === null || y === undefined;
      if (xn && yn) continue;
      if (xn) return s.nullsFirst ? -1 : 1;
      if (yn) return s.nullsFirst ? 1 : -1;
      if (x === y) continue;
      const c = x < y ? -1 : 1;
      return s.desc ? -c : c;
    }
    return a.i - b.i;
  }).map((x) => x.r);
}
/** greatest(...) / least(...): NULLs are ignored; all NULL gives NULL. */
function greatest(...v) { return maxOf(v); }
function least(...v) { return minOf(v); }
/** jsonb #- '{a,b}': a copy without the value at that path. */
function deletePath(obj, path) {
  if (!obj || typeof obj !== 'object') return obj;
  const copy = cloneValue(obj);
  let cur = copy;
  for (let i = 0; i < path.length - 1; i++) { cur = cur && cur[path[i]]; if (!cur || typeof cur !== 'object') return copy; }
  if (cur && typeof cur === 'object') delete cur[path[path.length - 1]];
  return copy;
}
/** jsonb_agg: an empty set gives null, as in SQL (wrap with ?? [] where the SQL used coalesce). */
function jsonAgg(list) { return list && list.length ? list : null; }
function coalesce(...v) { for (const x of v) if (x !== null && x !== undefined) return x; return null; }
function nullif(a, b) { return a === b ? null : a; }
/** jsonb - 'key' - 'key2' */
function omit(obj, ...keys) { if (!obj || typeof obj !== 'object') return obj; const o = { ...obj }; for (const k of keys.flat()) delete o[k]; return o; }
/** jsonb_strip_nulls: object fields that are null are removed, recursively (array elements are kept). */
function stripNulls(v) {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== undefined).map(([k, x]) => [k, stripNulls(x)]));
  return v;
}
/** The text of a JSON value as ->> gives it (objects and arrays as JSON text). */
function jtext(v) { if (v === null || v === undefined) return null; if (typeof v === 'object') return JSON.stringify(v); return String(v); }
/** jsonb_typeof */
function jtype(v) { if (v === null || v === undefined) return null; if (Array.isArray(v)) return 'array'; if (typeof v === 'object') return 'object'; if (typeof v === 'number') return 'number'; if (typeof v === 'boolean') return 'boolean'; return 'string'; }

/* --------------------------------------------------------------------------------------------------------- text */

function splitPart(s, sep, n) { if (s === null || s === undefined) return null; const p = String(s).split(sep); return p[n - 1] ?? ''; }
function left(s, n) { if (s === null || s === undefined) return null; const a = Array.from(String(s)); return (n >= 0 ? a.slice(0, n) : a.slice(0, Math.max(0, a.length + n))).join(''); }
function right(s, n) { if (s === null || s === undefined) return null; const a = Array.from(String(s)); return a.slice(Math.max(0, a.length - n)).join(''); }
function initcap(s) { return s === null || s === undefined ? null : String(s).toLowerCase().replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()); }
/** btrim / ltrim / rtrim with a character set */
function trimChars(s, chars = ' ') { if (s === null || s === undefined) return null; const set = new Set(Array.from(chars)); const a = Array.from(String(s)); let i = 0, j = a.length; while (i < j && set.has(a[i])) i++; while (j > i && set.has(a[j - 1])) j--; return a.slice(i, j).join(''); }

const RE_CACHE = new Map();
/**
 * A Postgres (POSIX ARE) regular expression as a JavaScript one (Unicode mode): \m \M \y word boundaries, character
 * classes such as [[:space:]] and [[:alpha:]], and the flags of ~ (case-sensitive) and ~* ('i').
 */
function pgRe(src, flags = '') {
  const key = src + '\u0000' + flags;
  if (RE_CACHE.has(key)) return RE_CACHE.get(key);
  const W = '[\\p{L}\\p{N}_]';
  const CLASS = { alpha: '\\p{L}', digit: '\\d', alnum: '\\p{L}\\p{N}', space: '\\s', upper: '\\p{Lu}', lower: '\\p{Ll}', punct: '\\p{P}\\p{S}', word: '\\p{L}\\p{N}_', xdigit: '0-9A-Fa-f' };
  let out = String(src)
    .replace(/\[\[:<:\]\]/g, `(?<!${W})(?=${W})`).replace(/\[\[:>:\]\]/g, `(?<=${W})(?!${W})`)
    .replace(/\\m/g, `(?<!${W})(?=${W})`).replace(/\\M/g, `(?<=${W})(?!${W})`).replace(/\\y/g, `(?:(?<!${W})(?=${W})|(?<=${W})(?!${W}))`)
    .replace(/\[:(\w+):\]/g, (m, c) => { if (!(c in CLASS)) throw new Error(`engine: regex class ${c}`); return CLASS[c]; });
  const f = Array.from(new Set(('u' + flags).split(''))).join('');
  let re;
  try { re = new RegExp(out, f); } catch (e) { throw new Error(`invalid regular expression: ${e.message}`); }
  RE_CACHE.set(key, re);
  return re;
}
/** text ~ pattern (ci: ~*) */
function reTest(text, src, ci = false) { if (text === null || text === undefined || src === null || src === undefined) return null; return pgRe(src, ci ? 'i' : '').test(String(text)); }
/** regexp_replace(text, pattern, replacement, flags): \1 refers to a group and \& to the whole match. */
function regexpReplace(text, src, repl, flags = '') {
  if (text === null || text === undefined) return null;
  const re = pgRe(src, flags.replace(/[^gi]/g, ''));
  const r = String(repl).replace(/\$/g, '$$$$').replace(/\\(\d)/g, '$$$1').replace(/\\&/g, '$$&');
  return String(text).replace(re, r);
}
/** substring(text from pattern): the first group, or the whole match. */
function reMatch(text, src, ci = false) { if (text === null || text === undefined) return null; const m = String(text).match(pgRe(src, ci ? 'i' : '')); return m ? (m.length > 1 ? m[1] ?? null : m[0]) : null; }
/** regexp_matches(text, pattern, 'g'): every match as the array of its groups. */
function reMatchAll(text, src, flags = 'g') { if (text === null || text === undefined) return []; const re = pgRe(src, (flags.includes('g') ? 'g' : '') + (flags.includes('i') ? 'i' : '')); if (!re.global) { const m = String(text).match(re); return m ? [m.length > 1 ? m.slice(1) : [m[0]]] : []; } return Array.from(String(text).matchAll(re), (m) => (m.length > 1 ? m.slice(1) : [m[0]])); }

/** pg_trgm similarity(a, b) */
function similarity(a, b) {
  const grams = (s) => {
    const set = new Set();
    for (const w of String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
      const p = `  ${w} `;
      for (let i = 0; i < p.length - 2; i++) set.add(p.slice(i, i + 3));
    }
    return set;
  };
  const x = grams(a), y = grams(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return inter / (x.size + y.size - inter);
}

/* ------------------------------------------------------------------------------------------------------- crypto */

let CRYPTO = null;
function nodeCrypto() {
  if (!CRYPTO) {
    if (typeof require !== 'function') throw new Error('engine: the crypto module is not available (set NODE_FUNCTION_ALLOW_BUILTIN=crypto)');
    CRYPTO = require('crypto');
  }
  return CRYPTO;
}
function uuid() { return nodeCrypto().randomUUID(); }
function randomHex(bytes) { return nodeCrypto().randomBytes(bytes).toString('hex'); }
function md5(s) { return nodeCrypto().createHash('md5').update(String(s ?? ''), 'utf8').digest('hex'); }
function sha256(s) { return nodeCrypto().createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex'); }
/** HMAC; key and message as Buffers or text; returns a Buffer. */
function hmac(alg, key, msg) { return nodeCrypto().createHmac(alg, key).update(msg).digest(); }
/** Unique integer ids for the tables that used a sequence (time-based, so concurrent requests do not collide). */
function nextSerial() { SERIAL = (SERIAL + 1) % 1000; return Date.now() * 1000 + SERIAL; }
/** Password hashes: scrypt$N$r$p$salt$hash (crypt()/bcrypt in the database). */
function hashPassword(pw) {
  const salt = randomHex(16);
  return `scrypt$16384$8$1$${salt}$${nodeCrypto().scryptSync(String(pw), salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const m = String(stored || '').match(/^scrypt\$(\d+)\$(\d+)\$(\d+)\$([0-9a-f]+)\$([0-9a-f]+)$/);
  if (!m || pw === null || pw === undefined) return false;
  const c = nodeCrypto();
  const got = c.scryptSync(String(pw), m[4], m[5].length / 2, { N: +m[1], r: +m[2], p: +m[3] });
  return c.timingSafeEqual(got, Buffer.from(m[5], 'hex'));
}

/* ----------------------------------------------------------------------------------------------- Sheets writes */

/**
 * The changes of the request as Google Sheets batchUpdate requests: new rows are appended (appendCells), changed rows
 * are rewritten in place (updateCells), deleted rows are tombstoned. Rows are only removed by compaction (dbCompact),
 * which goes last in the write, bottom row first.
 *
 * guards: what the write assumes, for the Sheets cache (scripts/sheets-cache.mjs) to check atomically before it passes
 * the write on, because two requests can read the same rows at the same time:
 *   rows    every row rewritten, tombstoned or removed still holds what this request read (its hash). This also catches
 *           a row that moved (a row removed above it), so a row number never lands on another row.
 *   unique  no live row of the tab already has the unique key of a new row (or of a changed key): an e-mail address,
 *           a de-duplication key. Keys generated here (uuid, serial) are not checked.
 *   versions  the tabs' versions as the cache stamped them on the read; an unchanged tab needs no second read.
 * When a guard fails the cache answers { conflict: true } and writes nothing; the workflow reads again and runs the
 * request again (a few times), so the second request sees the first one's changes.
 */
function dbWrites() {
  const requests = [];
  const removals = [];
  const summary = {};
  const guards = { rows: [], unique: [], versions: {} };
  for (const [name, t] of Object.entries(DB.t)) {
    const def = SCHEMA[name];
    const header = t.header;
    const cellsOf = (row) => header.map((h) => (def.columns[h] ? toCell(def.columns[h].type, row[h]) : {}));
    const appends = [];
    const rewritten = [];                 // row numbers this request rewrites (they are checked by their own guard)
    const keyed = [];                     // [row, cells, changed columns or null for a new row]
    const guardRow = (rowNum, cells) => { if (cells) { guards.rows.push({ tab: name, sheetId: sheetId(name), row: rowNum, hash: dbRowHash(cells) }); rewritten.push(rowNum); } };
    // A deleted row keeps a marker in its first cell: a blank row would be reused by the next appendCells, and a request
    // still holding that row number would then overwrite the new row.
    const tombstone = { start: null, rows: [{ values: header.map((h, i) => (i === 0 ? { userEnteredValue: { stringValue: TOMBSTONE } } : {})) }], fields: 'userEnteredValue' };
    for (const row of [...t.rows, ...(t.duplicates || [])]) {
      const meta = META.get(row);
      if (meta.state === 'new') { const cells = cellsOf(row); appends.push({ values: cells }); keyed.push([row, cells, null, meta]); }
      else if (meta.state === 'deleted' && meta.rowNum) {
        requests.push({ updateCells: { ...tombstone, start: { sheetId: sheetId(name), rowIndex: meta.rowNum - 1, columnIndex: 0 } } });
        guardRow(meta.rowNum, meta.cells);
        summary[name] = (summary[name] || 0) + 1;
      } else if (meta.state === 'loaded' && meta.orig && meta.rowNum) {
        const changed = header.filter((h) => def.columns[h] && JSON.stringify(meta.orig[h]) !== JSON.stringify(row[h]));
        if (changed.length) {
          const cells = cellsOf(row);
          requests.push({ updateCells: { start: { sheetId: sheetId(name), rowIndex: meta.rowNum - 1, columnIndex: 0 }, rows: [{ values: cells }], fields: 'userEnteredValue' } });
          guardRow(meta.rowNum, meta.cells);
          keyed.push([row, cells, changed, meta]);
          summary[name] = (summary[name] || 0) + 1;
        }
      }
    }
    if (appends.length) {
      requests.push({ appendCells: { sheetId: sheetId(name), rows: appends, fields: 'userEnteredValue' } });
      summary[name] = (summary[name] || 0) + appends.length;
    }
    // Unique keys of the new and changed rows, one guard per key (columns as positions in the tab's header).
    if (keyed.length) {
      const sets = [];
      if (def.pk) sets.push({ cols: def.pk, pk: true });
      for (const u of def.unique || []) sets.push({ cols: u });
      for (const u of def.uniqueWhere || []) sets.push(u);
      for (const s of sets) {
        const at = s.cols.map((c) => header.indexOf(c));
        const whereAt = s.where ? header.indexOf(s.where.col) : -1;
        if (at.some((i) => i < 0) || (s.where && whereAt < 0)) continue;
        const keys = [];
        for (const [row, cells, changed, meta] of keyed) {
          if (s.pk && meta.genPk) continue;
          if (changed && !s.cols.concat(s.where ? [s.where.col] : []).some((c) => changed.includes(c))) continue;
          if (s.where && !(s.where.notnull ? row[s.where.col] !== null && row[s.where.col] !== undefined : row[s.where.col] === s.where.eq)) continue;
          const key = at.map((i) => _cellText(cells[i]));
          if (key.some((k) => k === null)) continue;                                     // NULLs never conflict
          keys.push(key);
        }
        if (keys.length) {
          guards.unique.push({ tab: name, sheetId: sheetId(name), cols: at, keys, exclude: rewritten.slice(),
            ...(s.where ? { where: s.where.notnull ? { col: whereAt, notnull: true } : { col: whereAt, eq: String(s.where.eq) } } : {}) });
        }
      }
    }
    // Compaction: the tombstones read by this request are removed (bottom first, after every other change).
    if (t.compact && !t.partial) {
      for (const ts of (t.tombstones || []).slice().sort((a, b) => b.rowNum - a.rowNum).slice(0, t.compact)) {
        guardRow(ts.rowNum, ts.cells);
        removals.push({ deleteDimension: { range: { sheetId: sheetId(name), dimension: 'ROWS', startIndex: ts.rowNum - 1, endIndex: ts.rowNum } } });
      }
      if (removals.length) summary.compacted = removals.length;
    }
    if ((rewritten.length || guards.unique.some((g) => g.tab === name)) && !t.partial && DB.versions && DB.versions[name] !== undefined) {
      guards.versions[name] = DB.versions[name];
    }
  }
  removals.sort((a, b) => b.deleteDimension.range.startIndex - a.deleteDimension.range.startIndex);
  return { requests: requests.concat(removals), summary, guards };
}

/** The text of a cell as written (userEnteredValue), as the Sheets API then returns it; null for an empty cell. */
function _cellText(cell) {
  const v = cell && cell.userEnteredValue;
  if (!v) return null;
  const x = 'stringValue' in v ? v.stringValue : 'numberValue' in v ? v.numberValue : 'boolValue' in v ? v.boolValue : null;
  return x === null || x === '' ? null : String(x);
}

/**
 * Hash of a row as Sheets returns it (UNFORMATTED_VALUE, without its trailing empty cells). The Sheets cache computes the
 * same hash of the row it reads before a write (rowHash in scripts/sheets-cache.mjs): keep the two identical.
 */
function dbRowHash(cells) {
  const a = (cells || []).map((c) => (c === null || c === undefined ? '' : c));
  let n = a.length;
  while (n > 0 && a[n - 1] === '') n--;
  return sha256(JSON.stringify(a.slice(0, n)));
}

/**
 * Removes the deleted rows (tombstones) this request read from a tab, at most `max` (default 2000), when there are at
 * least `min` (default 1). Safe while other requests run: the removal is one guarded write, and a request holding row
 * numbers from before it fails its guards and runs again on a fresh read. Returns the number of rows to remove.
 */
function dbCompact(name, { min = 1, max = 2000 } = {}) {
  const t = DB && DB.t[name];
  if (!t || t.partial || !t.tombstones || t.tombstones.length < min) return 0;
  const prev = t.compact;
  t.compact = Math.min(t.tombstones.length, max);
  DB.undo.push(() => { t.compact = prev; });
  return t.compact;
}
function sheetId(name) {
  const id = DB.sheetIds[name];
  if (id === undefined || id === null) throw new Error(`engine: no sheet id for tab ${name} (run the Sheets setup)`);
  return Number(id);
}

/** The changed rows of the request as plain objects (tests and the local Sheets emulator). */
function dbChanges() {
  const out = {};
  for (const [name, t] of Object.entries(DB.t)) {
    for (const row of t.rows) {
      const meta = META.get(row);
      let kind = null;
      if (meta.state === 'new') kind = 'insert';
      else if (meta.state === 'deleted') kind = meta.wasNew ? null : 'delete';
      else if (meta.orig && JSON.stringify(meta.orig) !== JSON.stringify(row)) kind = 'update';
      if (kind) (out[name] = out[name] || []).push({ kind, row: { ...row } });
    }
  }
  return out;
}
