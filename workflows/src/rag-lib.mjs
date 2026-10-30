// Shared RAG code, used by the ingestion Code node (rag.mjs) and by the offline retrieval evaluation
// (scripts/eval-retrieval.mjs), so the evaluation measures exactly what production does.
//   chunkDocument(title, content, opts) → [{ index, key, section, content }]
//     opts.version 'v1': paragraphs and sentences up to 800 characters (the original chunker)
//     opts.version 'v2': splits at Markdown headings, carries the section path, ~800 characters with a one-sentence
//                        overlap; the key is a stable hash of document title, section and text (citations survive edits)
export const RAG_LIB = String.raw`
function _rlHash(s) {   // FNV-1a, 32 bit, as 8 hex characters (stable keys without a crypto import)
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
function _rlSentences(text) { return String(text).split(/(?<=[.!?؟])\s+/).map((x) => x.trim()).filter(Boolean); }
// Pieces of at most max characters: sentences, and a sentence longer than max split at word boundaries.
function _rlPieces(text, max) {
  const out = [];
  for (const s of _rlSentences(text)) {
    if (s.length <= max) { out.push(s); continue; }
    let cur = '';
    for (const w of s.split(/\s+/)) {
      if (cur && cur.length + 1 + w.length > max) { out.push(cur); cur = ''; }
      cur = cur ? cur + ' ' + w : w.slice(0, max);
    }
    if (cur) out.push(cur);
  }
  return out;
}
function _rlPack(paras, max, overlap) {
  const chunks = []; let cur = [];
  const size = () => cur.join(' ').length;
  for (const para of paras) {
    if (cur.length && size() + para.length > max) { chunks.push(cur.join(' ')); cur = []; }
    if (para.length <= max) { cur.push(para); continue; }
    for (const s of _rlPieces(para, max)) {
      if (cur.length && size() + s.length > max) { chunks.push(cur.join(' ')); cur = overlap ? [cur[cur.length - 1]] : []; if (size() + s.length > max) cur = []; }
      cur.push(s);
    }
  }
  if (cur.length) chunks.push(cur.join(' '));
  return chunks;
}
function chunkDocument(title, content, opts) {
  opts = opts || {};
  const max = Number(opts.max) || 800;
  const text = String(content || '').replace(/\r/g, '');
  if (opts.version !== 'v2') {
    const paras = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    return _rlPack(paras, max, true).map((c, i) => ({ index: i, key: null, section: null, content: title + '. ' + c }));
  }
  // v2: sections by Markdown heading (#…######); text before the first heading belongs to the title.
  const sections = []; let cur = { path: [], lines: [] };
  for (const line of text.split('\n')) {
    const h = line.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (h) {
      if (cur.lines.some((l) => l.trim())) sections.push(cur);
      const level = h[1].length;
      const path = cur.path.slice(0, level - 1);
      path[level - 1] = h[2].replace(/[*_\x60]/g, '').trim();
      cur = { path: path.filter(Boolean), lines: [] };
    } else cur.lines.push(line);
  }
  if (cur.lines.some((l) => l.trim())) sections.push(cur);
  const out = [];
  for (const s of sections) {
    const section = [title, ...s.path].join(' › ');
    const paras = s.lines.join('\n').split(/\n\s*\n|\n(?=\s*[-*•]\s)/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
    for (const c of _rlPack(paras, max, true)) {
      const body = section + '. ' + c;
      out.push({ index: out.length, key: _rlHash(title + '|' + section + '|' + c), section, content: body });
    }
  }
  return out;
}
`;
