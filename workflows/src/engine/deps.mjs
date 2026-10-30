// Which Google Sheets tabs a request needs: every engine function's own table accesses (dbRows('t'), dbInsert('t', …))
// and the functions it calls, followed transitively, plus the tables a delete cascades into. The build uses this to read
// only those tabs for each API action and each database step (Sheets has a per-minute request quota, and a smaller read
// is faster).
import { loadEngine, engineFiles, topLevelFunctions } from './index.mjs';
import { readFileSync } from 'node:fs';

const ACCESS = /\bdb(Rows|Where|One|Exists|Count|Get|Insert|Update|UpdateWhere|Delete|DeleteWhere)\(\s*(['"])([a-z_0-9]+)\2/g;
const DYNAMIC = /\bdb(Rows|Where|One|Exists|Count|Get|Insert|Update|UpdateWhere|Delete|DeleteWhere)\(\s*(?!['"])[^)\s]/;

let cache = null;
function analyse() {
  if (cache) return cache;
  const E = loadEngine();
  const runtime = new Set(topLevelFunctions(readFileSync(new URL('./00_runtime.js', import.meta.url), 'utf8')));
  const names = Object.keys(E).filter((k) => typeof E[k] === 'function');
  const known = new Set(names);
  const info = {};
  const problems = [];
  for (const n of names) {
    if (runtime.has(n)) { info[n] = { tables: new Set(), deletes: new Set(), refs: new Set() }; continue; }
    const src = E[n].toString();
    const tables = new Set(), deletes = new Set();
    for (const m of src.matchAll(ACCESS)) { tables.add(m[3]); if (m[1].startsWith('Delete')) deletes.add(m[3]); }
    if (DYNAMIC.test(src)) problems.push(n);
    const refs = new Set((src.match(/[A-Za-z_$][\w$]*/g) || []).filter((x) => known.has(x) && x !== n && !runtime.has(x)));
    info[n] = { tables, deletes, refs };
  }
  for (const t of Object.values(info)) for (const x of t.tables) if (!E.SCHEMA[x]) problems.push(`unknown table ${x}`);
  cache = { E, info, problems };
  return cache;
}

/** Problems that make the analysis unreliable: table names that are not literals, unknown tables. */
export function depsProblems() { return analyse().problems; }

/** The tabs needed by some engine functions and/or a JavaScript expression over them (sorted; without _meta). */
export function tablesFor({ functions = [], expr = '', skip = [] } = {}) {
  const { E, info } = analyse();
  const tables = new Set(), deletes = new Set();
  // skip: functions not followed (their tabs are read only when a request needs them; see engine_api's retry).
  const seen = new Set(skip);
  const visit = (n) => {
    if (seen.has(n) || !info[n]) return;
    seen.add(n);
    for (const t of info[n].tables) tables.add(t);
    for (const t of info[n].deletes) deletes.add(t);
    for (const r of info[n].refs) visit(r);
  };
  for (const f of functions) {
    if (!info[f]) throw new Error(`engine function ${f} does not exist`);
    visit(f);
  }
  if (expr) {
    for (const m of expr.matchAll(ACCESS)) { tables.add(m[3]); if (m[1].startsWith('Delete')) deletes.add(m[3]); }
    for (const id of expr.match(/[A-Za-z_$][\w$]*/g) || []) visit(id);
  }
  // A delete reaches the tables whose foreign keys cascade from it (or are set to null), and further down.
  const queue = [...deletes];
  while (queue.length) {
    const parent = queue.shift();
    for (const [child, def] of Object.entries(E.SCHEMA)) {
      for (const fk of def.fks || []) {
        if (fk.ref === parent && (fk.onDelete === 'cascade' || fk.onDelete === 'set null') && !tables.has(child)) { tables.add(child); queue.push(child); }
        if (fk.ref === parent && fk.onDelete === 'cascade' && !deletes.has(child)) { deletes.add(child); queue.push(child); }
      }
    }
  }
  return [...tables].sort();
}

/** Every engine function name (for checks). */
export function engineFunctionNames() { return Object.keys(analyse().info); }
export { engineFiles };
