// Accredited guideline sources for the RAG knowledge base (WF-024 / WF-024b).
//
//   WF-024   daily: every source due for a check (app.fn_guideline_sources_due) runs through WF-024b, one at a time.
//   WF-024b  one source, by method:
//              pubmed_watch  PubMed search -> summaries -> editions (journal allowlist + title pattern) -> review item
//              pmc           PubMed Central search -> newest edition -> article versions in the PMC Cloud Service ->
//                            license and retraction check -> JATS full text -> sections -> prompt-injection screen
//              web           conditional download (ETag) -> PDF or HTML text -> sections -> prompt-injection screen
//            Every outcome, including failures, ends in app.fn_guideline_record, which decides what is new and turns a
//            new edition into drafts (or a review item) for the Safety Officer. Nothing fetched is ever searchable
//            before the edition is approved with its license confirmed (app.api_guideline_approve).
// Free services only: NCBI E-utilities (3 requests/s without a key; optional NCBI_API_KEY / NCBI_EMAIL), the PMC Cloud
// Service (public S3, no account), and the publisher's own download address.
import { workflow, pg, code, ifTrue, switchOn, execWorkflow, schedule, subTrigger, httpGet, loop, wait, WF } from './lib.mjs';
import { AI_LIB } from './ai-lib.mjs';
import { GUIDELINE_LIB } from './guideline-lib.mjs';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const NCBI_PARAMS = "tool=diabetes-care-platform{{ $env.NCBI_EMAIL ? '&email=' + encodeURIComponent($env.NCBI_EMAIL) : '' }}{{ $env.NCBI_API_KEY ? '&api_key=' + encodeURIComponent($env.NCBI_API_KEY) : '' }}";
const PMC_S3 = 'https://pmc-oa-opendata.s3.amazonaws.com';
const SRC = "$('Load source').first().json.s";

// Small, fast content fingerprint for change detection of downloaded text (not a security hash).
const HASH_LIB = String.raw`
function textHash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}
`;

export function guidelineSync() {
  const wf = workflow({ id: WF.guidelineSync, name: 'WF-024 · Guideline sources sync (daily)', description: 'Every day at 03:00 Cairo time, checks each accredited guideline source that is due (feature flag guideline_sync) for a new edition, one at a time with a pause between sources.' });
  const t = wf.add(schedule('Daily 03:00', { field: 'days', daysInterval: 1, triggerAtHour: 3, triggerAtMinute: 0 }));
  const due = wf.add(pg('Sources due', `select jsonb_array_elements(app.fn_guideline_sources_due(10)) as src`));
  const lp = wf.add(loop('Each source'));
  const shape = wf.add(code('Build request', `return [{ json: { key: $input.first().json.src.key } }];`));
  const run = wf.add(execWorkflow('Check source', WF.guidelineCheck, { onError: 'continueRegularOutput' }));
  const pause = wf.add(wait('Be polite to the services', 3));
  wf.chain(t, due, lp);
  wf.link(lp, shape, { output: 1 });
  wf.chain(shape, run, pause);
  wf.link(pause, lp);
  return wf.build();
}

export function guidelineCheck() {
  const wf = workflow({ id: WF.guidelineCheck, name: 'WF-024b · Check one guideline source', description: 'Looks for a new edition of one accredited guideline source and records the result: unchanged, a fetched edition as drafts for review, a review item for watch-only sources, a retraction, or an error. Called by WF-024 and by admin.guideline_check.' });
  const t = wf.add(subTrigger('Check request'));
  const load = wf.add(pg('Load source', `select app.fn_guideline_source_ctx($1) as s`, `[ String($json.key ?? $json.data?.source_key ?? '') ]`));
  const sw = wf.add(switchOn('Method', '$json.s.method', ['pmc', 'pubmed_watch', 'web']));
  const failed = wf.add(code('Request failed', `
const e = $input.first().json.error;
return [{ json: { result: { status: 'error', error: String((e && (e.message || e.description)) || e || 'request failed').slice(0, 400) } } }];`));
  const record = wf.add(pg('Record result', `select app.fn_guideline_record($1, $2::jsonb) as data`,
    `[ ${SRC}.key, JSON.stringify($json.result ?? { status: 'error', error: 'no result' }) ]`));

  /* ---- PubMed / PubMed Central ---- */
  const search = wf.add(httpGet('Search PubMed',
    `${EUTILS}/esearch.fcgi?db={{ $json.s.method === 'pmc' ? 'pmc' : 'pubmed' }}&retmode=json&sort=pub_date&retmax={{ Math.min(Number($json.s.locator.retmax) || 20, 60) }}&term={{ encodeURIComponent($json.s.locator.term) }}&${NCBI_PARAMS}`,
    { onError: 'continueErrorOutput', timeout: 30000 }));
  const found = wf.add(ifTrue('Anything found?', '($json.esearchresult?.idlist || []).length > 0'));
  const nothing = wf.add(code('Nothing found', `return [{ json: { result: { status: 'error', error: 'The search found no publication for this source.' } } }];`));
  const summaries = wf.add(httpGet('Summaries',
    `${EUTILS}/esummary.fcgi?db={{ ${SRC}.method === 'pmc' ? 'pmc' : 'pubmed' }}&retmode=json&id={{ $json.esearchresult.idlist.join(',') }}&${NCBI_PARAMS}`,
    { onError: 'continueErrorOutput', timeout: 30000 }));
  const pick = wf.add(code('Pick edition', `${GUIDELINE_LIB}
const s = ${SRC};
const eds = pickEditions($input.first().json, s.locator || {});
if (!eds.length) return [{ json: { next: 'record', result: { status: 'error', error: 'No publication matched the journals and title pattern of this source.' } } }];
const edition = String(eds[0].edition);
const items = eds.filter(e => String(e.edition) === edition).slice(0, 40);
const first = items[0];
const meta = { edition, title: first.title, journal: first.journal, pubdate: first.pubdate, doi: first.doi, pmid: first.pmid, pmcid: first.pmcid, url: first.url, publications: items.length };
// Watched sources never copy text: the newest edition becomes a review item with links.
if (s.method === 'pubmed_watch' || s.ingest === 'watch_only') return [{ json: { next: 'record', result: { status: 'watch', version: edition, items, meta } } }];
const c = items.find(e => e.pmcid);
if (!c) return [{ json: { next: 'record', result: { status: 'not_licensed', version: 'not_licensed:' + edition, items, meta } } }];
return [{ json: { next: 'pmc', pmcid: c.pmcid, edition, items,
  meta: { ...meta, title: c.title, doi: c.doi, pmid: c.pmid, pmcid: c.pmcid, url: c.url, citation: [c.journal, c.pubdate].filter(Boolean).join(' ') + (c.doi ? '. doi:' + c.doi : '') } } }];`));
  const toPmc = wf.add(ifTrue('Full text to look up?', "$json.next === 'pmc'"));
  const versions = wf.add(httpGet('List article versions', `${PMC_S3}/?list-type=2&delimiter=/&prefix={{ $json.pmcid }}.`,
    { onError: 'continueErrorOutput', timeout: 30000, responseFormat: 'text' }));
  const pickV = wf.add(code('Pick article version', `
const P = $('Pick edition').first().json;
const s = ${SRC};
const xml = String($input.first().json.data || '');
const vs = Array.from(xml.matchAll(/<Prefix>(PMC\\d+\\.(\\d+))\\/<\\/Prefix>/g)).map(m => ({ v: m[1], n: Number(m[2]) })).sort((a, b) => b.n - a.n);
// Not in the PMC Cloud Service: the article is not licensed for text mining and reuse.
if (!vs.length) return [{ json: { next: 'record', result: { status: 'not_licensed', version: 'not_licensed:' + P.pmcid, items: P.items, meta: P.meta } } }];
const version = vs[0].v;
if ((s.known_versions || []).includes(version)) return [{ json: { next: 'record', result: { status: 'unchanged', version } } }];
return [{ json: { next: 'meta', version } }];`));
  const toMeta = wf.add(ifTrue('New article version?', "$json.next === 'meta'"));
  // The PMC Cloud Service serves every object as binary/octet-stream: read as text, parse here.
  const metaN = wf.add(httpGet('Article metadata', `${PMC_S3}/metadata/{{ $json.version }}.json`, { onError: 'continueErrorOutput', timeout: 30000, responseFormat: 'text' }));
  const lic = wf.add(code('Check license', `
const P = $('Pick edition').first().json;
const V = $('Pick article version').first().json.version;
let m;
try { m = JSON.parse(String($input.first().json.data || '')); } catch (e) {
  return [{ json: { next: 'record', result: { status: 'error', error: 'The PMC metadata for ' + V + ' could not be read.' } } }];
}
if (m.is_retracted) return [{ json: { next: 'record', result: { status: 'retracted', version: V, meta: P.meta } } }];
if (!m.is_pmc_openaccess) return [{ json: { next: 'record', result: { status: 'not_licensed', version: 'not_licensed:' + V, items: P.items, meta: P.meta } } }];
return [{ json: { next: 'xml', version: V, license_code: m.license_code || null, xml_url: '${PMC_S3}/' + V + '/' + V + '.xml' } }];`));
  const toXml = wf.add(ifTrue('Licensed for reuse?', "$json.next === 'xml'"));
  const dl = wf.add(httpGet('Download article XML', '{{ $json.xml_url }}', { onError: 'continueErrorOutput', timeout: 120000, responseFormat: 'text' }));
  const parse = wf.add(code('Parse article and screen', `${AI_LIB}${GUIDELINE_LIB}
const s = ${SRC};
const P = $('Pick edition').first().json;
const L = $('Check license').first().json;
const xml = String($input.first().json.data || '');
const jm = jatsMeta(xml);
if (jm.retracted) return [{ json: { result: { status: 'retracted', version: L.version, meta: P.meta } } }];
// Each section is screened for instruction-like text; flagged sections are shown to the reviewer, and WF-019
// quarantines such chunks again at indexing.
const sections = sizeSections(jatsToSections(xml), 1500, 20000).map(x => ({ ...x, screening: screenInjection(x.content, s.injection) }));
const license = L.license_code ? 'CC ' + String(L.license_code).toUpperCase() + ' (PMC)' : 'PMC Open Access Subset, publisher license: ' + (jm.license || 'not stated');
return [{ json: { result: { status: 'fetched', version: L.version,
  meta: { ...P.meta, title: jm.title || P.meta.title, short_title: s.publisher + ' (' + P.edition + ')', license }, sections } } }];`));

  /* ---- web document ---- */
  const isPdf = wf.add(ifTrue('PDF document?', "$json.s.locator.format === 'pdf'"));
  const pdf = wf.add(httpGet('Download PDF', '{{ $json.s.locator.url }}', {
    onError: 'continueErrorOutput', timeout: 180000, responseFormat: 'file', fullResponse: true, neverError: true,
    headersExpr: "($json.s.known_etag ? { 'If-None-Match': $json.s.known_etag } : {})" }));
  const pdfOk = wf.add(ifTrue('PDF changed?', '$json.statusCode >= 200 && $json.statusCode < 300'));
  const notModified = wf.add(code('Not modified', `
const r = $input.first().json;
if (r.statusCode === 304) return [{ json: { result: { status: 'unchanged' } } }];
return [{ json: { result: { status: 'error', error: 'The publisher answered HTTP ' + r.statusCode + '.' } } }];`));
  const extract = wf.add({
    name: 'Extract PDF text', type: 'n8n-nodes-base.extractFromFile', typeVersion: 1, onError: 'continueErrorOutput',
    parameters: { operation: 'pdf', binaryPropertyName: 'data', options: {} },
  });
  const parsePdf = wf.add(code('Parse PDF and screen', `${AI_LIB}${GUIDELINE_LIB}${HASH_LIB}
const s = ${SRC};
const resp = $('Download PDF').first().json;
const etag = (resp.headers && (resp.headers.etag || resp.headers.ETag)) || null;
const text = String($input.first().json.text || '');
if (text.replace(/\\s+/g, '').length < 500) return [{ json: { result: { status: 'error', error: 'The PDF has no extractable text (scanned images?).' } } }];
const sha = textHash(text);
const version = etag ? 'etag:' + String(etag).replace(/^W\\//, '').replace(/"/g, '') : 'hash:' + sha;
if ((s.known_versions || []).includes(version) || s.known_sha === sha) return [{ json: { result: { status: 'unchanged', version, etag, sha } } }];
// The edition label comes from the registry (locator.edition); a PDF's Last-Modified date is not its publication date.
// A patient page is titled by what it is about ("Creatinine test — MedlinePlus Medical Test"), not by its publisher: each
// web source is one test or topic, and its sections ("What do the results mean?") are otherwise indistinguishable.
const meta = { title: s.title, url: s.locator.page_url || s.locator.url, short_title: s.audience === 'patient' ? s.title : s.publisher + (s.locator.edition ? ' (' + s.locator.edition + ')' : ''),
  edition: s.locator.edition || ((resp.headers && resp.headers['last-modified']) ? 'downloaded ' + new Date(resp.headers['last-modified']).toISOString().slice(0, 10) : version) };
if (s.ingest === 'watch_only') return [{ json: { result: { status: 'watch', version, etag, sha, meta, items: [{ title: s.title, url: meta.url }] } } }];
const sections = sizeSections(pdfTextToSections(text), 1500, 20000).map(x => ({ ...x, screening: screenInjection(x.content, s.injection) }));
return [{ json: { result: { status: 'fetched', version, etag, sha, meta: { ...meta, citation: s.title, license: s.license }, sections } } }];`));
  const page = wf.add(httpGet('Download page', '{{ $json.s.locator.url }}', {
    onError: 'continueErrorOutput', timeout: 60000, responseFormat: 'text', fullResponse: true, neverError: true }));
  const parseHtml = wf.add(code('Parse page and screen', `${AI_LIB}${GUIDELINE_LIB}${HASH_LIB}
const s = ${SRC};
const r = $input.first().json;
if (!(r.statusCode >= 200 && r.statusCode < 300)) return [{ json: { result: { status: 'error', error: 'The publisher answered HTTP ' + r.statusCode + '.' } } }];
const html = String(r.body || r.data || '');
// A watched page is versioned by its own "last updated" text (version_regex), so cookie banners and adverts do not
// look like new editions; otherwise by the hash of its readable text.
const textOnly = htmlToSections(html).map(x => x.title + '\\n' + x.content).join('\\n');
const vm = s.locator.version_regex ? textOnly.match(new RegExp(s.locator.version_regex, 'i')) : null;
if (s.locator.version_regex && !vm) return [{ json: { result: { status: 'error', error: 'The version text was not found on the page; the page layout may have changed.' } } }];
const sha = textHash(textOnly);
const version = vm ? String(vm[1] || vm[0]).trim() : 'hash:' + sha;
if ((s.known_versions || []).includes(version)) return [{ json: { result: { status: 'unchanged', version, sha } } }];
const meta = { title: s.title, url: s.locator.page_url || s.locator.url, short_title: s.audience === 'patient' ? s.title : s.publisher + (s.locator.edition ? ' (' + s.locator.edition + ')' : ''), edition: s.locator.edition || version };
if (s.ingest === 'watch_only') return [{ json: { result: { status: 'watch', version, sha, meta, items: [{ title: s.title, url: meta.url }] } } }];
const sections = sizeSections(htmlToSections(html), 1500, 20000).map(x => ({ ...x, screening: screenInjection(x.content, s.injection) }));
return [{ json: { result: { status: 'fetched', version, sha, meta: { ...meta, citation: s.title, license: s.license }, sections } } }];`));

  wf.chain(t, load, sw);
  wf.link(sw, search, { output: 0 });
  wf.link(sw, search, { output: 1 });
  wf.link(sw, isPdf, { output: 2 });
  wf.link(search, found, { output: 0 });
  wf.link(search, failed, { output: 1 });
  wf.link(found, summaries, { output: 0 });
  wf.link(found, nothing, { output: 1 });
  wf.link(summaries, pick, { output: 0 });
  wf.link(summaries, failed, { output: 1 });
  wf.link(pick, toPmc);
  wf.link(toPmc, versions, { output: 0 });
  wf.link(toPmc, record, { output: 1 });
  wf.link(versions, pickV, { output: 0 });
  wf.link(versions, failed, { output: 1 });
  wf.link(pickV, toMeta);
  wf.link(toMeta, metaN, { output: 0 });
  wf.link(toMeta, record, { output: 1 });
  wf.link(metaN, lic, { output: 0 });
  wf.link(metaN, failed, { output: 1 });
  wf.link(lic, toXml);
  wf.link(toXml, dl, { output: 0 });
  wf.link(toXml, record, { output: 1 });
  wf.link(dl, parse, { output: 0 });
  wf.link(dl, failed, { output: 1 });
  wf.link(isPdf, pdf, { output: 0 });
  wf.link(isPdf, page, { output: 1 });
  wf.link(pdf, pdfOk, { output: 0 });
  wf.link(pdf, failed, { output: 1 });
  wf.link(pdfOk, extract, { output: 0 });
  wf.link(pdfOk, notModified, { output: 1 });
  wf.link(extract, parsePdf, { output: 0 });
  wf.link(extract, failed, { output: 1 });
  wf.link(page, parseHtml, { output: 0 });
  wf.link(page, failed, { output: 1 });
  for (const n of [failed, nothing, parse, notModified, parsePdf, parseHtml]) wf.link(n, record);
  return wf.build();
}
