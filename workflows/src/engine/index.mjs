// Assembles the engine (schema.js, 00_runtime.js, one file per former SQL migration, 99_entry.js) into the single
// script that n8n runs, and loads it in Node for tests. Both use exactly the same text.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const dir = new URL('./', import.meta.url);

/** Engine files in load order: schema first, the runtime, then the numbered modules. */
export function engineFiles() {
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  return ['schema.js', ...files.filter((f) => f !== 'schema.js').sort()];
}

/** Top-level function names of a script (the engine's exports). */
export function topLevelFunctions(src) {
  return [...src.matchAll(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
}

/** The engine as one script that returns its functions: new Function('require', source)(require). */
export function engineSource() {
  const parts = engineFiles().map((f) => `// ---- ${f}\n${readFileSync(new URL(f, dir), 'utf8')}`);
  const names = [...new Set(engineFiles().flatMap((f) => topLevelFunctions(readFileSync(new URL(f, dir), 'utf8'))))];
  return `${parts.join('\n')}\nreturn { SCHEMA, ${names.join(', ')} };\n`;
}

/** A fresh engine instance (its own state) in Node. */
export function loadEngine() {
  const require = createRequire(import.meta.url);
  return new Function('require', engineSource())(require);
}

/** The demo data (database/sheets/seed.json) as tables of row objects. */
export function seedTables() {
  const tables = JSON.parse(readFileSync(new URL('../../../database/sheets/seed.json', import.meta.url), 'utf8')).tables;
  // Every table of the schema exists, as in a set-up spreadsheet (a table without seed rows is an empty tab).
  const SCHEMA = new Function(`${readFileSync(new URL('./schema.js', import.meta.url), 'utf8')}; return SCHEMA;`)();
  for (const t of Object.keys(SCHEMA)) if (!(t in tables)) tables[t] = [];
  return tables;
}
