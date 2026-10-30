// Guideline content parsing, inlined into the WF-024b Code nodes (String.raw keeps regular-expression backslashes).
//   pickEditions      PubMed / PMC summaries -> editions of an accredited guideline (journal allowlist + title pattern)
//   jatsToSections    PMC JATS XML -> [{title, content}] by top-level section
//   pdfTextToSections text extracted from a PDF -> [{title, content}] by numbered or capitalised headings
//   htmlToSections    an HTML page -> [{title, content}] by h1-h3
//   sizeSections      merges small sections and splits very long ones (each becomes one knowledge-base document)
// scripts/test-guidelines.mjs tests this file offline.

export const GUIDELINE_LIB = String.raw`
function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', le: '≤', ge: '≥',
                  plusmn: '±', times: '×', middot: '·', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', deg: '°', micro: 'µ', minus: '−' };
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ' '; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch (e) { return ' '; } })
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}
function stripTags(s) { return String(s || '').replace(/<[^>]+>/g, ' '); }
// Whitespace, empty citation brackets left by removed markers ("[, ]", "( )"), hyphenation at line ends.
function tidy(s) {
  return String(s || '')
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\[\s*[,;–\-\s]*\]|\(\s*[,;–\-\s]*\)/g, '')
    .replace(/ +([,.;:)])/g, '$1').replace(/\( +/g, '(')
    .replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}
function normJournal(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

/* ---------- editions ---------- */

// esummary JSON (db=pubmed or db=pmc) -> editions matching the source's journals and title pattern, newest first.
// edition = first capture group of title_pattern (an edition year), else the publication year.
function pickEditions(summary, locator) {
  const res = (summary && summary.result) || {};
  const re = locator.title_pattern ? new RegExp(locator.title_pattern, 'i') : null;
  const journals = (locator.journals || []).map(normJournal);
  const out = [];
  for (const uid of (res.uids || [])) {
    const r = res[uid] || {};
    const title = decodeEntities(String(r.title || '')).replace(/\s+/g, ' ').trim();
    const journal = String(r.source || r.fulljournalname || '');
    if (journals.length && !journals.includes(normJournal(r.source)) && !journals.includes(normJournal(r.fulljournalname))) continue;
    const m = re ? title.match(re) : null;
    if (re && !m) continue;
    const ids = {};
    for (const a of (r.articleids || [])) {
      if (a.idtype === 'doi') ids.doi = a.value;
      else if (a.idtype === 'pubmed' || a.idtype === 'pmid') ids.pmid = String(a.value);
      else if ((a.idtype === 'pmc' || a.idtype === 'pmcid') && /PMC\d+/.test(a.value)) ids.pmcid = a.value.match(/PMC\d+/)[0];
    }
    if (!ids.pmcid && /^\d+$/.test(uid) && summary.header && /pmc/i.test(JSON.stringify(summary.header))) ids.pmcid = 'PMC' + uid;
    if (!ids.pmid && !ids.pmcid) ids.pmid = String(uid);
    const year = (String(r.pubdate || r.epubdate || '').match(/\d{4}/) || [''])[0];
    const edition = (m && m[1]) || year;
    out.push({ ...ids, title, journal, pubdate: r.pubdate || null, edition,
      url: ids.doi ? 'https://doi.org/' + ids.doi : ids.pmcid ? 'https://pmc.ncbi.nlm.nih.gov/articles/' + ids.pmcid + '/' : 'https://pubmed.ncbi.nlm.nih.gov/' + ids.pmid + '/' });
  }
  return out.sort((a, b) => String(b.edition).localeCompare(String(a.edition)) || String(b.pubdate || '').localeCompare(String(a.pubdate || '')));
}

/* ---------- PMC JATS XML ---------- */

function jatsMeta(xml) {
  const x = String(xml || '');
  const pick = (re) => { const m = x.match(re); return m ? tidy(decodeEntities(stripTags(m[1]))) : null; };
  const lic = x.match(/<license\b([^>]*)>([\s\S]*?)<\/license>/);
  const href = lic && (lic[1].match(/xlink:href="([^"]+)"/) || [])[1];
  const ali = pick(/<ali:license_ref[^>]*>([\s\S]*?)<\/ali:license_ref>/);
  return {
    title: pick(/<article-title[^>]*>([\s\S]*?)<\/article-title>/),
    journal: pick(/<journal-title[^>]*>([\s\S]*?)<\/journal-title>/),
    license: ali || href || (lic ? tidy(decodeEntities(stripTags(lic[2]))).slice(0, 300) : null),
    retracted: /article-type="retraction"/.test(x) || /related-article-type="retracted-article"/.test(x),
  };
}
// Linearizes JATS: non-prose elements are dropped, citation markers removed, sub/superscripts kept inline,
// sections and titles become markers, paragraphs and list items become lines.
function jatsLinear(fragment) {
  let s = String(fragment || '')
    .replace(/<(ref-list|table-wrap|table-wrap-foot|fig|fig-group|fn-group|supplementary-material|disp-formula|alternatives|graphic|media|ack|glossary|app-group|sec-meta)\b[\s\S]*?<\/\1>/g, ' ')
    .replace(/<xref\b[^>]*>[\s\S]*?<\/xref>/g, '')
    .replace(/<xref\b[^>]*\/>/g, '')
    .replace(/<(sub|sup|italic|bold|sc|underline|monospace)\b[^>]*>([\s\S]*?)<\/\1>/g, '$2');
  s = s.replace(/<title\b[^>]*>([\s\S]*?)<\/title>/g, (_, t) => '\u0002T' + tidy(decodeEntities(stripTags(t))).replace(/[\u0002\u0003]/g, '') + '\u0003')
       .replace(/<sec\b[^>]*>/g, '\u0002O\u0003').replace(/<\/sec>/g, '\u0002C\u0003')
       .replace(/<list-item\b[^>]*>/g, '\n• ')
       .replace(/<\/?(p|list|boxed-text|statement|disp-quote|def-list|def-item|term|def)\b[^>]*>/g, '\n');
  // A list item's text sits in its own <p>: keep it on the bullet's line.
  return decodeEntities(stripTags(s)).replace(/•[ \t]*\n+[ \t]*/g, '• ');
}
function jatsToSections(xml) {
  const x = String(xml || '');
  const sections = [];
  const abs = (x.match(/<abstract(?![^>]*abstract-type="(?:graphical|teaser|toc)")[^>]*>([\s\S]*?)<\/abstract>/) || [])[1];
  if (abs) {
    const t = tidy(jatsLinear(abs).replace(/\u0002[OC]\u0003/g, '').replace(/\u0002T([^\u0003]*)\u0003/g, '\n$1: '));
    if (t) sections.push({ title: 'Summary', content: t });
  }
  const body = (x.match(/<body\b[^>]*>([\s\S]*)<\/body>/) || [])[1] || '';
  const lin = jatsLinear(body);
  const re = /\u0002([OCT])([^\u0003]*)\u0003/g;
  let depth = 0, last = 0, top = null, m;
  const add = (text) => {
    const t = text.trim();
    if (!t) return;
    if (!top) { top = { title: 'Introduction', parts: [] }; sections.push(top); }
    top.parts.push(t);
  };
  while ((m = re.exec(lin))) {
    add(lin.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] === 'O') { depth++; if (depth === 1) { top = { title: '', parts: [] }; sections.push(top); } }
    else if (m[1] === 'C') { depth = Math.max(0, depth - 1); }
    else if (m[1] === 'T') {
      if (depth <= 1 && top && !top.title) top.title = m[2];
      else if (top) top.parts.push('## ' + m[2]);
    }
  }
  add(lin.slice(last));
  return sections.map(s => ({ title: (s.title || 'Text').slice(0, 160), content: tidy(s.parts ? s.parts.join('\n\n') : s.content) }))
    .filter(s => s.content && !/^(references|acknowledg|funding|conflicts? of interest|duality of interest|author contributions|data availability|abbreviations)/i.test(s.title));
}

/* ---------- PDF text ---------- */

// Text extracted from a PDF (pages joined by blank lines, as n8n's Extract From File node returns it):
//   * running headers and footers are removed (lines repeated on many pages, page numbers ignored),
//   * a contents page is skipped up to the next page break, and so are references and acknowledgements,
//   * headings are numbered ("3 Prevention and management", "2.1 ...", "Annex 1: ...") and may wrap onto lowercase
//     continuation lines; capitalised lines count as headings only in documents without numbered headings
//     (flowchart steps such as "IF SYMPTOMATIC" are not headings),
//   * lines wrapped by the PDF are joined back into paragraphs, bullets start new paragraphs.
function pdfTextToSections(text) {
  const raw = String(text || '').replace(/\r/g, '').replace(/\f/g, '\n\n');
  const lines = raw.split('\n').map(l => l.replace(/\s+/g, ' ').trim());
  const key = l => l.replace(/\d+/g, '').trim().toLowerCase();
  const count = {};
  for (const l of lines) if (l.length > 3 && l.length < 140) count[key(l)] = (count[key(l)] || 0) + 1;
  const MONTHS = /^(\d{1,2}) (january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
  const numbered = l => l.length >= 4 && l.length <= 100 && !MONTHS.test(l) && !/\s\d{1,3}$/.test(l) && !/\d{4}$/.test(l) &&
    /^(?:(?:\d{1,2}(?:\.\d{1,2}){0,2})\.?|Annex \d+:?|Appendix [A-Z\d]+:?|Chapter \d+:?|Part \d+:?)\s+[A-Z(]/.test(l) && !/[.;]$/.test(l);
  const capital = l => l.length >= 6 && l.length <= 80 && /^[A-Z0-9 ,&()\-–:/]+$/.test(l) && /[A-Z]{4,}/.test(l) && !/[.;,]$/.test(l) &&
    !/^(IF|THEN|ELSE|AND|OR|REDUCE|INCREASE|STOP|START|BEGIN|CONTINUE|REFER|ADD|CHECK|GIVE|REPEAT|NO|YES)\b/.test(l);
  const structured = lines.filter(numbered).length >= 3;
  const isHeading = l => numbered(l) || (!structured && capital(l));
  const isSkipTitle = t => /^(?:\d[\d.]*\s+)?(contents|table of contents|references|bibliography|acknowledg|abbreviations|foreword|resources|further reading)\b/i.test(t);
  const sections = []; let cur = null; let para = []; let mode = 'text';
  const flushPara = () => { if (para.length && cur) cur.parts.push(para.join(' ').replace(/(\w)- (\w)/g, '$1$2')); para = []; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l) { flushPara(); if (mode === 'contents') mode = 'text'; continue; }
    if (/^\d{1,3}$/.test(l) || (count[key(l)] || 0) >= 5 || /\.{4,}\s*\d+$/.test(l)) continue;
    if (mode === 'contents') continue;
    if (/^(contents|table of contents)$/i.test(l)) { flushPara(); mode = 'contents'; continue; }
    if (isHeading(l)) {
      flushPara();
      let title = l;
      // Wrapped heading: short lowercase continuation lines without final punctuation.
      while (i + 1 < lines.length && lines[i + 1] && lines[i + 1].length <= 60 && /^[a-z(]/.test(lines[i + 1]) && !/[.;:]$/.test(lines[i + 1]) && title.length < 140) {
        title += ' ' + lines[++i];
      }
      if (isSkipTitle(title)) { mode = 'skip'; continue; }
      mode = 'text';
      cur = { title: title.slice(0, 160), parts: [] }; sections.push(cur);
      continue;
    }
    if (mode === 'skip') continue;
    if (!cur) { cur = { title: 'Introduction', parts: [] }; sections.push(cur); }
    if (/^[•\-–▪●○]\s/.test(l)) flushPara();
    para.push(l);
    if (/[.!?:]$/.test(l) && l.length < 75) flushPara();
  }
  flushPara();
  return sections.map(s => ({ title: s.title, content: tidy(s.parts.join('\n\n')) })).filter(s => s.content.length > 0);
}

/* ---------- HTML ---------- */

function htmlToSections(html) {
  let s = String(html || '')
    .replace(/<(script|style|noscript|nav|header|footer|form|svg|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi, (_, t) => '\u0002T' + tidy(decodeEntities(stripTags(t))) + '\u0003')
    .replace(/<li\b[^>]*>/gi, '\n• ').replace(/<\/?(p|div|section|article|br|tr|ul|ol)\b[^>]*>/gi, '\n');
  s = decodeEntities(stripTags(s));
  const sections = []; let cur = { title: 'Introduction', parts: [] }; sections.push(cur);
  const re = /\u0002T([^\u0003]*)\u0003/g; let last = 0, m;
  while ((m = re.exec(s))) { cur.parts.push(s.slice(last, m.index)); cur = { title: m[1].slice(0, 160) || 'Text', parts: [] }; sections.push(cur); last = re.lastIndex; }
  cur.parts.push(s.slice(last));
  return sections.map(x => ({ title: x.title, content: tidy(x.parts.join('\n')) })).filter(x => x.content.length > 0);
}

/* ---------- sizing ---------- */

// Each section becomes one knowledge-base document: sections shorter than minChars join the previous one, sections
// longer than maxChars are split at paragraph boundaries into numbered parts.
function sizeSections(sections, minChars, maxChars) {
  minChars = minChars || 1500; maxChars = maxChars || 20000;
  const merged = [];
  for (const s of sections) {
    const prev = merged[merged.length - 1];
    if (prev && (s.content.length < minChars || prev.content.length < minChars) && prev.content.length + s.content.length <= maxChars) {
      prev.content += '\n\n## ' + s.title + '\n\n' + s.content;
      if (prev.content.length - s.content.length < minChars && prev.title === 'Introduction') prev.title = s.title;
    } else merged.push({ title: s.title, content: s.content });
  }
  const out = [];
  for (const s of merged) {
    if (s.content.length <= maxChars) { out.push(s); continue; }
    // A paragraph longer than maxChars is split at sentence ends (or, failing that, at maxChars): no text is dropped.
    const pieces = (p) => {
      if (p.length <= maxChars) return [p];
      const outP = []; let cur = '';
      for (const sentence of p.split(/(?<=[.!?؟])\s+/)) {
        for (let i = 0; i < sentence.length; i += maxChars) {
          const bit = sentence.slice(i, i + maxChars);
          if (cur && cur.length + 1 + bit.length > maxChars) { outP.push(cur); cur = ''; }
          cur = cur ? cur + ' ' + bit : bit;
        }
      }
      if (cur) outP.push(cur);
      return outP;
    };
    const paras = s.content.split(/\n\n+/).flatMap(pieces); let part = [], n = 1;
    for (const p of paras) {
      if (part.length && part.join('\n\n').length + p.length > maxChars) { out.push({ title: s.title + ' (part ' + n++ + ')', content: part.join('\n\n') }); part = []; }
      part.push(p);
    }
    if (part.length) out.push({ title: n > 1 ? s.title + ' (part ' + n + ')' : s.title, content: part.join('\n\n') });
  }
  return out;
}
`;
