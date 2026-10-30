# Engine porting guide (SQL functions → JavaScript)

The backend moves from PostgreSQL to Google Sheets. Every `app.*` SQL function in `database/migrations/0[1-9]*.sql`
becomes a JavaScript function in this folder with the **same name** (without `app.`), the **same arguments** and the
**same result**. The SQL files stay as the specification; read them, do not edit them. The frontend and the API contract
(`packages/api-client/src/types.ts`) do not change.

## How the engine runs

- All files in this folder (`schema.js`, `00_runtime.js`, your module, …) are concatenated into **one script**
  (`index.mjs` → `engineSource()`). n8n runs it inside a Code node with `new Function('require', source)(require)`;
  tests load the same text in Node (`loadEngine()`).
- Your file is a **plain script**: top-level `function` declarations only. No `import`, `export`, `class` hierarchies or
  top-level code that runs at load time (top-level `const` tables of constants are fine if they are only *used* inside
  functions). Every top-level function is exported automatically.
- Private helpers: prefix with your module tag, e.g. `_m14_parseSchedule`. Ported SQL functions keep their SQL name
  (`fn_today`, `api_glucose_add`, `fn_raise`).
- One request = one `dbOpen()`; nothing persists between runs. Functions read and change the in-memory tables; the
  runtime turns the changes into one Sheets write at the end. An exception rolls back everything (like a transaction).

## Types (arguments, row fields and results)

| SQL | JavaScript |
|---|---|
| uuid, text | string (uuids lower-case) or `null` |
| integer, bigint, numeric, double | number or `null` |
| boolean | boolean or `null` |
| timestamptz | ISO string in UTC (`2026-10-10T09:00:00.000Z`) or `null` — compare with `t(x)` (ms) |
| date | `'YYYY-MM-DD'` (Cairo calendar date) |
| interval argument | milliseconds (number) |
| jsonb | the JS value (object, array, string, number, boolean) or `null` |
| text[] | array of strings |
| `app.<table>` row type | the row object |
| `returns setof …` / `returns table(…)` | array of row objects with those column names |
| `returns void` | nothing (`undefined`) |
| vector | array of numbers |

Default arguments keep their position: `function fn_x(a, b = null, c = 7)`.

## Runtime API (00_runtime.js) — use only this for data

Table names are always **string literals** (the build reads them to know which Sheets tabs a request needs).

| | |
|---|---|
| `dbRows('t')` | all rows (array of live row objects) |
| `dbWhere('t', r => …)`, `dbOne('t', r => …)`, `dbExists`, `dbCount` | filters |
| `dbGet('t', id)` | row by single-column primary key, or `null` |
| `dbInsert('t', {...}, { onConflict })` | insert with defaults (uuid, now(), serial ids, column defaults), type casts and every constraint (not-null, check, unique incl. partial unique indexes, foreign keys). `onConflict: 'nothing'` returns `null` on a unique clash; `onConflict: { cols: [...], set: patch \| (existing, newRow) => patch }` = `ON CONFLICT (cols) DO UPDATE`. Returns the stored row (= `RETURNING *`). |
| `dbUpdate('t', row, patch)` | update one row (constraints checked); returns it. Mutate rows **only** through this. |
| `dbUpdateWhere('t', pred, patch \| row => patch)` → count | `UPDATE … WHERE` |
| `dbDelete('t', row)`, `dbDeleteWhere('t', pred)` → count | delete with the FK actions (cascade / set null / restrict) |
| `dbTry(fn, onError)` | plpgsql `BEGIN … EXCEPTION WHEN … THEN …`: changes made in `fn` are undone if it throws |
| `now()` | the request time (constant, like `now()` in a transaction); `clockNow()` = `clock_timestamp()` |
| `t(x)`, `iso(ms)`, `ago(ms)`, `later(ms)`, `MIN`, `HOUR`, `DAY` | time arithmetic (`now() - interval '7 days'` → `ago(7 * DAY)`) |
| `localDate(ts)`, `today()`, `localTimestamp(ts)` (= `app.fn_local`), `localHour`, `localMinuteOfDay`, `localHHMM`, `dayStart(date)`, `addDays(date, n)`, `daysBetween(a, b)`, `dateTrunc('hour'\|'day'\|'week'\|'month', ts)`, `ageYears(dob)`, `minutesBetween`, `hoursBetween`, `daysBetweenTs`, `cairoParts(ts)` (`dow`: 0 = Sunday) | Africa/Cairo calendar, as the database (`timezone = Africa/Cairo`) |
| `castUuid`, `castNum`, `castInt`, `castBool`, `castTs`, `castDate` | `::uuid`, `::numeric`, `::int`, … — bad input throws the Postgres message (`invalid input syntax for type uuid: "x"`), which the API answers with 400 |
| `round(x, d)`, `sum`, `avg`, `minOf`, `maxOf`, `percentileCont(arr, p)`, `stddev` | aggregates ignore `null`; empty input gives `null` |
| `orderBy(list, r => a, [r => b, 'desc'], [r => c, 'asc', 'nulls first'])` | ORDER BY with Postgres NULL placement (ASC: nulls last; DESC: nulls first) |
| `jsonAgg(list)` | `jsonb_agg`: `null` for an empty list — write `jsonAgg(x) ?? []` where SQL had `coalesce(…, '[]')` |
| `coalesce`, `nullif`, `omit(obj, 'k', …)` (`jsonb - 'k'`), `stripNulls` (`jsonb_strip_nulls`), `jtext(v)` (`->>`), `jtype(v)` (`jsonb_typeof`) | |
| `splitPart`, `left`, `right`, `initcap`, `trimChars` | string functions (lengths count characters: `Array.from(s).length`) |
| `pgRe(src, flags)`, `reTest(text, src, ci)` (`~` / `~*`), `regexpReplace(text, src, repl, flags)`, `reMatch(text, src)` (`substring(… from …)`), `reMatchAll` (`regexp_matches(…, 'g')`) | Postgres regular expressions (`\m \M \y`, `[[:space:]]` …) — pass the SQL pattern text unchanged |
| `similarity(a, b)` | pg_trgm (`a % b` is `similarity(a, b) >= 0.3`) |
| `uuid()`, `randomHex(n)` (`encode(gen_random_bytes(n), 'hex')`), `md5`, `sha256`, `hmac(alg, key, msg)` (Buffer), `hashPassword(pw)` (`crypt(pw, gen_salt('bf'))`), `checkPassword(pw, hash)` (`hash = crypt(pw, hash)`), `nextSerial()` | |

## SQL semantics you must keep

- **NULL**: a comparison with NULL is not true. `WHERE status <> 'done'` does **not** return rows whose status is NULL;
  `x = ANY(…)` with NULL is not true; `'a' || NULL` is NULL (`concat()` ignores NULLs); `count(col)` skips NULLs,
  `count(*)` does not; `greatest/least` ignore NULLs; `NOT (NULL)` is NULL (falsy).
- **Empty aggregates**: `jsonb_agg`, `array_agg`, `string_agg`, `max`, `sum`, `avg` over no rows are NULL.
  `count` is 0. Keep the SQL's `coalesce(…)` defaults exactly.
- **Integer division**: `int / int` truncates toward zero in SQL (`7 / 2 = 3`); numeric division does not.
- **ORDER BY**: use `orderBy` (NULLs last ascending, first descending). `LIMIT n` → `.slice(0, n)`.
  `DISTINCT ON (a) … ORDER BY a, b` → keep the first row per `a` after sorting.
- **Casts**: `(d->>'x')::numeric` on bad text must throw like Postgres (use the cast helpers); `nullif(d->>'x', '')::uuid`
  → `castUuid(nullif(jtext(d.x), ''))`.
- **Errors**: `raise exception 'forbidden: …'` → `throw new Error('forbidden: …')` with **identical text**. The API maps
  the `code:` prefix to the HTTP status and message. `perform app.fn_raise('…')` → call your port of `fn_raise`.
  Functions that *return* `{__error: …}` (refusals that are recorded) must keep doing so — their writes are committed.
- **Time**: SQL `now()` is the request time → `now()`. `current_date`, `::date`, `date_trunc` and
  `extract(hour/dow …)` use Cairo time (helpers above). JSON output of timestamps: ISO strings are fine.
- **jsonb**: `->` value, `->>` text (`jtext`), `?` key exists (`k in obj`), `@>` containment, `||` shallow merge
  (`{...a, ...b}`; arrays concatenate), `jsonb_build_object` keeps keys whose value is null (use `null`, never
  `undefined`, in results), `jsonb_array_elements` → iterate, `to_jsonb(row)` → `{...row}`.
- **Uniqueness and constraints** are enforced by `dbInsert`/`dbUpdate` from the schema. Where SQL used
  `ON CONFLICT`, pass `onConflict`. Where SQL caught `unique_violation`, use `dbTry`.
- **Row locks** (`FOR UPDATE`, `SKIP LOCKED`), `pg_notify`, `raise notice`, `set local` → drop them.
- **Full-text and vector search** (`to_tsvector`, `websearch_to_tsquery`, `<=>`): implement in JS (token match /
  cosine distance) and say so in your file header.
- Keep the SQL comments that explain *why*; drop SQL-specific ones.

## Your deliverable

1. `workflows/src/engine/NN_<name>.js`: every function of your SQL file(s), in the same order, each with a one-line
   comment naming the SQL function when the name differs or the behaviour needs a note.
2. `scripts/engine-tests/NN_<name>.test.mjs`: tests of your functions against the demo data
   (`dbOpen({ sheets: seedTables(), now: '…' })`, see `scripts/test-engine-runtime.mjs`). Functions of other modules
   may not exist yet while you work — guard such tests with `if (typeof E.fn_x !== 'function') skip`.
3. Your final report: the functions ported, every place where the JavaScript knowingly differs from the SQL, and the
   functions of other modules you call (name + argument types you assumed).

Check your file loads: `node -e "import('./workflows/src/engine/index.mjs').then(m => m.loadEngine())"` and run your tests.
Do not edit other modules, `00_runtime.js` or `schema.js`; if the runtime lacks something, write a private helper in your
file and mention it in your report.
