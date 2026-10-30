// Deterministic AI safety library, inlined into n8n Code nodes (String.raw keeps regular-expression backslashes as written).
//
//   GUARD_LIB  output guard: dose and treatment-change wording, instruction leaks, citation whitelist.
//   GATE_LIB   AI gates around every model call:
//                input   PHI redaction (known identifiers + patterns), prompt-injection screen, date relativization,
//                        instruction-like record fields removed, untrusted text wrapped in per-run nonce markers
//                output  canary / marker leaks, markup and ungrounded contact details removed, numbers checked
//                        against the facts the model was given.
//   AI_LIB     both, in the order they depend on each other.
//
// The rules (patterns, weights, replacement tokens) come from app.safety_rules (database/rules/ai_gates.sql) through
// app.fn_ai_gate, so the Clinical Safety Officer can tune them without a code change. scripts/test-ai-gate.mjs and
// scripts/test-guard.mjs test this file offline.

export const GUARD_LIB = String.raw`
// Same normalization as app.fn_normalize_text in the database (apostrophes are dropped here): compatibility forms
// (full-width letters, Arabic presentation forms), Cyrillic and Greek look-alikes as Latin letters, Arabic letter
// variants and Persian forms unified, Arabic-Indic digits and separators as ASCII.
const HOMOGLYPHS = { 'А': 'a', 'В': 'b', 'Е': 'e', 'К': 'k', 'М': 'm', 'Н': 'h', 'О': 'o', 'Р': 'p', 'С': 'c', 'Т': 't', 'Х': 'x', 'І': 'i', 'Ј': 'j', 'Ѕ': 's',
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'һ': 'h', 'ԁ': 'd',
  'Α': 'a', 'Β': 'b', 'Ε': 'e', 'Η': 'h', 'Ι': 'i', 'Κ': 'k', 'Μ': 'm', 'Ν': 'n', 'Ο': 'o', 'Ρ': 'p', 'Τ': 't', 'Χ': 'x', 'Υ': 'y',
  'ο': 'o', 'α': 'a', 'ε': 'e', 'ρ': 'p', 'ι': 'i', 'κ': 'k', 'τ': 't', 'ν': 'v', 'υ': 'u' };
function normText(s) {
  return String(s || '').normalize('NFKC').replace(/[\u0370-\u03FF\u0400-\u052F]/g, c => HOMOGLYPHS[c] || c).toLowerCase()
    .replace(/[ً-ْـٰ]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/[ىی]/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/ک/g, 'ك')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0))
    .replace(/٫/g, '.').replace(/٬/g, ',')
    .replace(/[’‘\u0060´']/g, '').replace(/[“”"]/g, ' ').replace(/[–—_]/g, ' ')
    .replace(/[\s\-]+/g, ' ').trim();
}
function escRe(s) { return String(s).replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'); }
function safeRe(src, flags) { try { return new RegExp(src, flags); } catch (e) { return null; } }

// Phrases in an AI-written text that state a dose or tell the person to change a medicine.
//   allowedDoseTexts: doses already on the person's own medicine list (these may be repeated back to them).
//   opts.skipNumeric: numbers are not flagged (clinician-facing text).
//   opts.strict: "ask your doctor ..." sentences are not exempt (used when no verifier model reviews the answer).
// A change verb is exempt only when a negation directly precedes it ("do not stop", "never skip") or, outside strict
// mode, when the clause before it names the clinician ("ask your doctor before changing").
function doseViolations(text, cfg, allowedDoseTexts, opts) {
  cfg = cfg || {}; opts = opts || {};
  const out = [];
  const numRes = (cfg.number_patterns || []).map(p => safeRe(p, 'gi')).filter(Boolean);
  const allowed = new Set();
  for (const d of (allowedDoseTexts || [])) {
    const n = normText(d);
    if (n.length > 1) allowed.add(n);
    for (const re of numRes) for (const m of n.matchAll(re)) allowed.add(m[0].trim());
  }
  // Allowed doses are removed on token boundaries only, so "500" never turns "1500 mg" into something harmless.
  const allowedRes = Array.from(allowed).sort((a, b) => b.length - a.length)
    .map(a => safeRe('(?<![\\d.\\p{L}])' + escRe(a) + '(?!\\.?\\d)(?!\\p{L})', 'gu')).filter(Boolean);

  const B = '(?<![\\p{L}\\d])', E = '(?![\\p{L}\\d])';
  const meds = cfg.medicine_regex ? '|' + cfg.medicine_regex : '';
  const objsEn = '(?:' + (cfg.objects_en || 'dose') + meds + ')';
  const objsAr = '(?:' + (cfg.objects_ar || 'جرعه') + meds + ')';
  const enA = cfg.change_verbs_en && safeRe(B + '(' + cfg.change_verbs_en + ')(?:d|ed|s|es)?' + E + '((?: \\S+){0,4}?) ' + B + objsEn + E, 'giu');
  const enB = cfg.change_verbs_en && safeRe(B + objsEn + E + '(?: \\S+){0,3}? (?:should|must|can|could|may|needs? to|has to|have to) (?:be )?(' + cfg.change_verbs_en + ')(?:d|ed)?' + E, 'giu');
  const arA = cfg.change_verbs_ar && safeRe('(?:^| )(\\S{0,3}?)(' + cfg.change_verbs_ar + ')\\S{0,3}((?: \\S+){0,3}?) \\S{0,3}' + objsAr, 'gu');
  const neg = '(?:' + (cfg.negation || 'do not|dont|never|not|without|avoid') + '|cannot|cant|wont)';
  const negEn = safeRe('(?:^| )' + neg + '(?: (?:ever|just|simply|suddenly|abruptly|to|try to|you|yourself|be))* ?$', 'iu');
  const negAr = safeRe('(?:^| )(?:لا|بدون|بلاش|ممنوع|ما|عدم|دون|ولا|مش|لن|لم|من)(?: (?:تحاول|تحاولي|ان|انك))* ?$', 'u');
  const clin = !opts.strict && cfg.clinician ? safeRe(cfg.clinician, 'iu') : null;
  const clauseOf = (prefix) => prefix.split(/[,،;؛:]| and | then | but | so | or | ثم | لكن | بس | او /).pop();
  const negated = (clause) => (negEn && negEn.test(clause)) || (negAr && negAr.test(clause)) || (clin && clin.test(clause));
  // The clinician still decides when the clause before the change is only a modal whose subject is a clinician named
  // earlier in the sentence: a pronoun ("check with your doctor or pharmacist, as they may need to change your
  // medications", "…your pharmacist, who can adjust your medications") or the same subject after "and" ("your doctor
  // will check your kidney function and may need to adjust your dose"). Any other subject does not count: "so they say
  // you can stop metformin" and "…and you can stop metformin" are still refused.
  const pronounModal = /^ *(?:(?:as|because|since|if|when|so) )?(?:(?:they|who|he|she) )?(?:may|might|can|could|will|would|needs? to)(?: (?:need|want|decide|be able|have))?(?: to)? ?$/i;
  const referredBack = (before, clause) => !!clin && clin.test(before) && pronounModal.test(clause);
  // "Ask your doctor whether your medications need to be adjusted": the change is a question for the clinician.
  const askWhether = /(?:^| )(?:ask|check with|talk to|talk with|speak to|speak with|consult|decide|tell you|let you know)(?: \S+)*? (?:whether|if)(?: \S+){0,3} ?$/i;
  // Re-timing ("take your metformin at night instead", "خدها وقت السحور") and supplements offered as treatment
  // ("try cinnamon to lower your sugar") are treatment changes too.
  const takeAll = cfg.take_verbs && safeRe(B + '(?:' + cfg.take_verbs + ')\\S*', 'giu');
  const retime = cfg.retiming && safeRe(cfg.retiming, 'iu');
  const objEn = safeRe(B + objsEn + E, 'iu'), objAr = safeRe(objsAr, 'u');
  const supp = cfg.supplement_advice && safeRe(cfg.supplement_advice, 'giu');

  for (const raw of String(text || '').split(/(?<=[.!?؟])\s+|\n+/)) {
    let s = normText(raw);
    if (!s) continue;
    for (const re of allowedRes) s = s.replace(re, ' ');
    s = s.replace(/ {2,}/g, ' ');
    if (!opts.skipNumeric) for (const re of numRes) for (const m of s.matchAll(re)) out.push(m[0].trim());
    if (enA) for (const m of s.matchAll(enA)) {
      const clause = clauseOf(s.slice(0, m.index));
      if (negEn && negEn.test(clause)) continue;
      if (clin && clin.test(clause)) continue;
      if (referredBack(s.slice(0, m.index), clause)) continue;
      out.push(m[0].trim());
    }
    if (enB) for (const m of s.matchAll(enB)) {
      const clause = clauseOf(s.slice(0, m.index));
      if (clin && clin.test(clause) && askWhether.test(clause)) continue;
      out.push(m[0].trim());
    }
    if (arA) for (const m of s.matchAll(arA)) {
      const prefix = m[1] || '';
      if (/^[وف]?(مت|مات|ما|لات)$/.test(prefix)) continue;                 // متزودش، ماتوقفش
      const clause = clauseOf(s.slice(0, m.index));
      if (negAr && negAr.test(clause)) continue;                           // لا توقف، بدون تغيير، من غير
      if (clin && clin.test(clause)) continue;
      out.push(m[0].trim());
    }
    // The medicine must be what is taken or moved: named within 4 words before or 5 words after the verb ("take your
    // metformin after dinner instead", «الدوا ده خده مع الفطار»). A medicine word elsewhere in the sentence does not
    // count: «يرتفع بعد الفطار بسبب تناول الكربوهيدرات أو مقاومة الأنسولين» is about food (and «الفطار» is also breakfast).
    if (takeAll && retime && retime.test(s)) for (const tm of s.matchAll(takeAll)) {
      const near = s.slice(0, tm.index).split(' ').slice(-5).join(' ') + ' ' + tm[0] + ' '
        + s.slice(tm.index + tm[0].length).trim().split(' ').slice(0, 5).join(' ');
      if (!((objEn && objEn.test(near)) || (objAr && objAr.test(near)))) continue;
      if (!negated(clauseOf(s.slice(0, tm.index)))) { out.push('re-timing: ' + tm[0].trim()); break; }
    }
    if (supp) for (const m of s.matchAll(supp)) {
      if (!negated(clauseOf(s.slice(0, m.index)))) out.push(m[0].trim());
    }
  }
  return Array.from(new Set(out)).slice(0, 10);
}
// Reassurance that must never follow a symptom ("not unusual", "nothing to worry about", «طبيعي», «بسيط»).
function reassures(text) {
  return /\b(?:not unusual|nothing to worry|no need to worry|dont worry|do not worry|is normal|are normal|perfectly normal|completely normal|nothing serious|not serious|minor|harmless|safe to wait|can wait|no cause for concern)\b|طبيعي|مفيش داعي|لا داعي للقلق|متقلقش|لا تقلق|بسيط|مش خطير|ليس خطير|لا يدعو للقلق/.test(normText(text));
}
// The message describes a symptom (anything a model must not assess in chat).
function mentionsSymptom(text) {
  return /\b(?:pain|painful|hurts?|hurting|ache|aching|swollen|swelling|bleed\w*|fever|vomit\w*|diarrh\w*|dizz\w*|faint\w*|numb\w*|tingl\w*|blurr\w*|wound|ulcer|sore|rash|itch\w*|cough\w*|breathless\w*|palpitation\w*|shak\w*|sweat\w*|confus\w*|headache|infect\w*|pus|burn(?:s|ing)?(?!\s+(?:calories|fat|sugar|energy))|cramp\w*)\b|وجع|الم |بيوجع|واجع|ورم|وارم|نزيف|سخونيه|حراره|ترجيع|استفراغ|بستفرغ|اسهال|دوخه|دايخ|اغما|تنميل|بينمل|زغلله|جرح|قرحه|حكه|كحه|نهجان|رعشه|عرقان|صداع|التهاب|صديد|حرقان|شد عضلي/.test(normText(text));
}
// The message is about this person's health or diabetes care (otherwise the assistant declines in one sentence).
// English words also match their plurals ("readings", "meals"); Arabic plurals and possessives that do not contain the
// singular are listed (قرايات، تحاليل، أدوية، وجبات، مواعيد، نتايج، صحتي). Words are in normText form (ة→ه، ى→ي، ئ→ي).
function onTopic(text) {
  return /\b(?:sugar|glucose|insulin|diabet\w*|a1c|hba1c|meal|food|eat\w*|carb\w*|diet|walk\w*|exercis\w*|activit\w*|sleep\w*|weight|medic\w*|pill|tablet|dose|foot|feet|toe|eye|vision|kidney|pressure|cholesterol|reading|sensor|cgm|plan|appointment|doctor|clinic|ramadan|fast\w*|hypo\w*|hyper\w*|low|high|range|health\w*|pain|sick|ill|symptom\w*|test|lab|result|pregnan\w*|stress|mood|breakfast|lunch|dinner|supper|snack|drink\w*|calorie|kcal|step|level|number|trend\w*|prescription|refill|nurse|care team)(?:s|es)?\b|سكر|انسولين|اكل|وجبه|وجبات|رجيم|نشويات|كربوهيدرات|سعرات|مشي|خطوات|رياضه|تمرين|تمارين|نوم|وزن|دوا|ادوي|علاج|حبوب|حبايه|جرع|قدم|رجل|صباع|عين|نظر|كلي|ضغط|كوليسترول|دهون|قراءه|قرايه|قراءات|قرايات|قياس|مستوي|حساس|خطه|موعد|مواعيد|ميعاد|دكتور|طبيب|عياده|رمضان|صيام|صايم|فطار|سحور|الغدا|العشا|عيش|رز|كشري|فول|فاكهه|حلويات|تحليل|تحاليل|نتيجه|نتايج|التراكمي|هبوط|ارتفاع|صحه|صحت|تعبان|عيان|حامل|توتر|مزاج/.test(normText(text));
}
// Share of Arabic letters among all letters: a reply in the wrong language is not released.
function arabicShare(text) {
  const letters = String(text || '').match(/\p{L}/gu) || [];
  if (!letters.length) return null;
  return letters.filter(c => /[؀-ۿ]/.test(c)).length / letters.length;
}
// A verifier verdict that rejects only for the reply language (category 'language', nothing else).
function languageOnly(v) {
  const c = v && Array.isArray(v.categories) ? v.categories : [];
  return !!v && v.approved === false && c.length > 0 && c.every((x) => x === 'language');
}
function wrongLanguage(text, locale) {
  const r = arabicShare(text);
  if (r === null) return false;
  return locale === 'ar' ? r < 0.5 : r > 0.3;
}
// Fixed answer to a dose question. People without a care team are not told that the question was forwarded.
function refusalText(p) {
  const g = p.dose_guard || {}, linked = !!(p.policy && p.policy.tier === 'linked');
  return p.locale === 'ar' ? (linked ? g.refusal_ar : (g.refusal_unlinked_ar || g.refusal_ar))
                           : (linked ? g.refusal_en : (g.refusal_unlinked_en || g.refusal_en));
}
// Fixed answer when a draft is withheld for any reason other than a dose question (leak, risk signal, verifier).
function withheldText(p) {
  const linked = !!(p.policy && p.policy.tier === 'linked');
  return p.locale === 'ar'
    ? 'لم أتمكن من تقديم إجابة آمنة على هذا السؤال الآن. ' + (linked ? 'أضفت سؤالك لفريق الرعاية.' : 'من فضلك اسأل طبيبًا أو صيدليًا.') + ' إذا شعرت بأعراض مقلقة استخدم زر الطوارئ أو اتصل بـ 123.'
    : 'I could not give a safe answer to this right now' + (linked ? ', so I have added your question for your care team.' : '. Please ask a doctor or pharmacist.') + ' If you feel unwell, use the Emergency button or call 123.';
}
function leaksInstructions(text, systemText) {
  const s = String(text || '');
  if (/AUTHORITY RULES|system prompt|SYSTEM MESSAGE|PATIENT CONTEXT \(|you are the patient companion|internal reference code|SECURITY RULES|CNRY-|⟦|⟧/i.test(s)) return true;
  if (/\b(?:my instructions|my system rules|my guidelines say|i (?:was|am|have been) (?:instructed|programmed) to)\b|تعليماتي|التعليمات (?:اللي|الي) (?:عندي|اتقالتلي)|اتبرمجت|تم توجيهي/i.test(normText(s))) return true;
  // A paraphrased or translated disclosure usually still copies long runs of the system text: any 10-word run of the
  // system prompt in the reply counts as a leak.
  if (systemText) {
    const words = (x) => normText(x).replace(/[^\p{L}\p{N} ]/gu, ' ').split(/ +/).filter(Boolean);
    const w = words(systemText), shingles = new Set();
    for (let i = 0; i + 10 <= w.length; i++) shingles.add(w.slice(i, i + 10).join(' '));
    const o = words(s);
    for (let i = 0; i + 10 <= o.length; i++) if (shingles.has(o.slice(i, i + 10).join(' '))) return true;
  }
  return false;
}
function refIds(obj) {
  const s = JSON.stringify(obj || {});
  return Array.from(new Set(s.match(/(condition|medication|allergy|lab|finding|careplan):[0-9a-f-]{36}/g) || []));
}
function refTitle(ctx, id) {
  const [kind] = id.split(':');
  const find = (arr, key) => (arr || []).find(x => x.ref === id)?.[key];
  if (kind === 'medication') return find(ctx.medications, 'name');
  if (kind === 'condition') return find(ctx.conditions, 'display');
  if (kind === 'lab') return find(ctx.labs, 'test');
  if (kind === 'allergy') return find(ctx.allergies, 'substance');
  if (kind === 'finding') return find(ctx.open_safety_findings, 'title');
  if (kind === 'careplan') return ctx.care_plan && ctx.care_plan.title;
  return null;
}
// Inline source markers, NotebookLM style: the model writes [n] after a sentence, n = the position of the source in its
// citations list. Safety checks read the text without them (a marker is not a number about the person), and after the
// citations are filtered the markers are renumbered to the kept list; a marker of a dropped or invented source is removed.
function stripMarkers(text) { return String(text || '').replace(/\s?\[\d{1,2}(?:\s*,\s*\d{1,2})*\]/g, ''); }
// [2] or [2, 3]: each number is mapped to the kept list; numbers of dropped sources are removed, and so is an empty marker.
function renumberMarkers(text, rawIds, citations) {
  const pos = new Map((citations || []).map((c, i) => [c.id, i + 1]));
  return String(text || '').replace(/\s?\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g, (m, list) => {
    const ks = Array.from(new Set(list.split(',').map((n) => { const id = (rawIds || [])[Number(n.trim()) - 1]; return id === undefined ? undefined : pos.get(id); }).filter(Boolean)));
    return ks.length ? ' [' + ks.join(', ') + ']' : '';
  })
    // any other bracket is a source the model named in words or by a field name ("[, target checks]"): removed
    .replace(/\s?\[([^\]\n]{0,60})\]/g, (m, inner) => (/^\d{1,2}(?:,\s*\d{1,2})*$/.test(inner.trim()) ? m : ''))
    .replace(/ +([.,!?؟،؛])/g, '$1');
}
// Record items returned by the search_patient_history tool ({ ref, kind, days_ago, summary }), found anywhere in the
// tool answers, so an answer can cite the meal, lab or reading it talks about.
function historyRecords(steps) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') { if (typeof v.ref === 'string' && typeof v.summary === 'string') out.push(v); else Object.values(v).forEach(walk); }
  };
  for (const s of (steps || [])) { if (s.tool !== 'search_patient_history') continue; try { let j = JSON.parse(s.full); if (typeof j === 'string') j = JSON.parse(j); walk(j); } catch (e) { /* not JSON */ } }
  return out;
}
function citationsFrom(ids, ctx, guidance, records) {
  const allowed = new Set(refIds(ctx));
  const g = Object.fromEntries((guidance || []).map(r => [r.id, r]));
  const rec = Object.fromEntries((records || []).map(r => [r.ref, r]));
  const out = [];
  for (const id of (ids || [])) {
    if (g[id]) {
      // Accredited guideline chunks name their publisher and edition and link to the source (publisher page or DOI).
      const r = g[id], url = r.url || (r.doi ? 'https://doi.org/' + r.doi : null);
      out.push({ id, title: r.title, source: r.publisher ? r.publisher + (r.version ? ' · ' + r.version : '') : r.source, kind: 'guideline', ...(url ? { url } : {}),
        // the cited passage itself, shown when the reader opens the source
        ...(r.content ? { excerpt: String(r.content).replace(/\s+/g, ' ').trim().slice(0, 400) } : {}) });
    }
    else if (allowed.has(id)) out.push({ id, title: refTitle(ctx, id) || id.split(':')[0], source: 'Patient record', kind: 'record' });
    else if (rec[id]) out.push({ id, title: rec[id].summary.slice(0, 80), source: 'Patient record' + (rec[id].days_ago !== null && rec[id].days_ago !== undefined ? ' · ' + rec[id].days_ago + ' d' : ''), kind: 'record', excerpt: rec[id].summary });
  }
  return out.filter((c, i) => out.findIndex(x => x.id === c.id) === i).slice(0, 6);
}
function cleanCodes(text) {
  // Patient-facing text must not contain internal ids or snake_case codes (e.g. view_plan, open_safety_findings).
  // Any "<word>:<record id>" code, however the model spells the word ("guidelin:…#1"), and bare record ids are removed.
  return String(text || '')
    .replace(/[\p{L}_]{2,}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:#\d+)?/giu, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:#\d+)?\b/gi, '')
    // brackets left empty, or holding only separators, once the codes inside were removed ("[, ]")
    .replace(/[([][\s,،;؛]*[)\]]/g, '')
    .replace(/[ \t]+([.,!?؟،؛])/g, '$1')
    .replace(/\b([a-z]+(?:_[a-z0-9]+)+)\b/g, (m) => m.replace(/_/g, ' '))
    .replace(/[ \t]{2,}/g, ' ').trim();
}
// The local model does not keep to a length: a reply is cut after the last whole sentence within max words (a single
// sentence longer than that is cut at max words).
function limitWords(text, max) {
  const t = String(text || '').trim();
  if (t.split(/\s+/).filter(Boolean).length <= max) return t;
  const sentences = t.match(/[^.!?؟\n]+(?:[.!?؟]+|\n+|$)/g) || [t];
  let out = '', n = 0;
  for (const s of sentences) {
    const k = s.trim().split(/\s+/).filter(Boolean).length;
    if (n + k > max) break;
    out += s; n += k;
  }
  return out.trim() || t.split(/\s+/).slice(0, max).join(' ') + ' …';
}
// A greeting at the start of a model answer («أهلاً بكِ،», «مرحباً يا أحمد،», "Hello there!"): the prompts say not to
// greet; the local model does anyway. Only a greeting followed by punctuation is removed, so a sentence is never cut.
function stripGreeting(text) {
  return String(text || '').replace(/^\s*(?:(?:أهلا|أهلاً|اهلا|اهلاً|مرحبا|مرحبًا|مرحباً|السلام عليكم)(?:\s+و?سهلا|\s+و?سهلاً)?(?:\s+(?:بك|بكِ|بكَ|بيك|بكم|يا\s+\S+))?|(?:[Hh]i|[Hh]ello|[Hh]ey|[Dd]ear)(?:\s+there|\s+[A-Z][a-z]+)?)\s*[،,.!:]+\s*/u, '');
}
// A local model stuck in a loop (the same bullet over and over until the token limit): any run of 8 words that occurs
// 3 or more times. A list that differs only in its numbers ("over the last 14 days", "over the last 90 days") does not
// repeat a whole 8-word run. Checked on the full model text, before limitWords cuts it.
function repetitive(text) {
  const w = normText(text).replace(/[^\p{L}\p{N} ]/gu, ' ').split(/ +/).filter(Boolean);
  const seen = new Map();
  for (let i = 0; i + 8 <= w.length; i++) {
    const k = w.slice(i, i + 8).join(' ');
    const n = (seen.get(k) || 0) + 1;
    if (n >= 3) return true;
    seen.set(k, n);
  }
  return false;
}
function doseTextsFrom(ctx) {
  return ((ctx && ctx.medications) || []).flatMap(m => [m.dose_text, m.name + ' ' + (m.dose_text || '')]).filter(Boolean);
}
`;

export const GATE_LIB = String.raw`
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;
const AR_VARIANTS = { 'ا': '[اأإآٱ]', 'أ': '[اأإآٱ]', 'إ': '[اأإآٱ]', 'آ': '[اأإآٱ]', 'ه': '[هة]', 'ة': '[هة]', 'ي': '[يى]', 'ى': '[يى]', 'و': '[وؤ]', 'ؤ': '[وؤ]', 'ئ': '[ئيى]' };

function asciiDigits(s) {
  return String(s ?? '').replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0));
}
function randomCode(n) {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789'; let s = '';
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

/* ---------- PHI redaction ---------- */

// A known name in raw text: Arabic letter variants and diacritics tolerated, Latin letters case-insensitive.
function nameTokenSrc(tok) {
  return Array.from(tok).map(ch => (AR_VARIANTS[ch] || escRe(ch)) + '[\\u064B-\\u0652\\u0640]*').join('');
}
// Regular expressions for the identifiers the database knows (patient, family members). Whole names first, then each
// distinctive name part (common words that are also names, such as "Amal" or "Said", are kept: name_stoplist).
function identifierRes(gate) {
  const phi = (gate && gate.phi) || {};
  const stop = new Set((phi.name_stoplist || []).map(normText));
  const B = '(?<![\\p{L}\\p{M}\\d])', E = '(?![\\p{L}\\p{M}\\d])';
  const out = [];
  const ids = ((gate && gate.identifiers) || []).slice().sort((a, b) => String(b.value).length - String(a.value).length);
  const parts = [];
  for (const id of ids) {
    const v = String(id.value || '').trim();
    if (v.length < 2) continue;
    if (id.type === 'name') {
      const toks = v.split(/\s+/).filter(Boolean);
      if (toks.length > 1) out.push({ type: 'name', re: safeRe(B + toks.map(nameTokenSrc).join('[\\s\\u00A0]+') + E, 'giu') });
      // Two adjacent parts of the name ("Karim Adel" of "Karim Adel Mansour") identify the person even when each part
      // alone is a common word.
      for (let i = 0; i + 1 < toks.length && toks.length > 2; i++) out.push({ type: 'name', re: safeRe(B + nameTokenSrc(toks[i]) + '[\\s\\u00A0]+' + nameTokenSrc(toks[i + 1]) + E, 'giu') });
      for (const t of toks) if (normText(t).length >= 3 && !stop.has(normText(t))) parts.push(t);
    } else if (id.type === 'phone') {
      const d = v.replace(/\D/g, '');
      const variants = new Set([d]);
      if (d.startsWith('0020')) variants.add('0' + d.slice(4));
      if (d.startsWith('20') && d.length >= 11) variants.add('0' + d.slice(2));
      for (const x of variants) if (x.length >= 7) out.push({ type: 'phone', re: safeRe('(?<!\\d)(?:\\+|00)?' + x.split('').join('[\\s.\\-]?') + '(?!\\d)', 'g') });
    } else if (id.type === 'email' || id.type === 'mrn') {
      out.push({ type: id.type, re: safeRe('(?<![A-Za-z0-9])' + escRe(v).replace(/-/g, '[\\s:#\\-]*') + '(?![A-Za-z0-9])', 'gi') });
    } else if (id.type === 'dob') {
      const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) {
        const z = s => s.replace(/^0/, '0?');
        out.push({ type: 'dob', re: safeRe('(?<!\\d)(?:' + m[1] + '[\\-/.]' + z(m[2]) + '[\\-/.]' + z(m[3]) + '|' + z(m[3]) + '[\\-/.]' + z(m[2]) + '[\\-/.]' + m[1] + ')(?!\\d)', 'g') });
      }
    }
  }
  for (const t of Array.from(new Set(parts)).sort((a, b) => b.length - a.length)) out.push({ type: 'name', re: safeRe(B + nameTokenSrc(t) + E, 'giu') });
  return out.filter(x => x.re);
}
function patternRes(gate) {
  const phi = (gate && gate.phi) || {};
  return (phi.patterns || []).map(p => ({ ...p, rx: safeRe(p.re, 'gu' + String(p.flags || '').replace(/[gu]/g, '')) })).filter(p => p.rx);
}
// Compiled expressions per gate object, for the run. (n8n passes node data as read-only proxies, so nothing is stored
// on the gate object itself.)
const GATE_RES = new WeakMap();
function gateRes(gate) {
  let r = GATE_RES.get(gate);
  if (!r) { r = { ids: identifierRes(gate), pats: patternRes(gate) }; GATE_RES.set(gate, r); }
  return r;
}
// Replaces identifiers with tokens such as [name] or [phone]. Internal ids (uuids) are protected so they still cite.
// stats counts replacements by type.
function redactPHI(text, gate, stats) {
  if (text === null || text === undefined) return text;
  stats = stats || {};
  gate = gate || {};
  const R = (gate.phi && gate.phi.replacements) || {};
  const tok = t => R[t] || '[' + t + ']';
  const bump = t => { stats[t] = (stats[t] || 0) + 1; };
  const res = gateRes(gate);
  const saved = [];
  let s = asciiDigits(String(text)).replace(UUID_RE, m => { saved.push(m); return '\u0001' + (saved.length - 1) + '\u0001'; });
  for (const id of res.ids) s = s.replace(id.re, () => { bump(id.type); return tok(id.type); });
  const found = [];   // values recognised by their context ("my neighbour Hassan Ali"): removed everywhere afterwards
  for (const p of res.pats) {
    s = s.replace(p.rx, (...a) => {
      const m = a[0];
      if (p.group) {
        const g = a[p.group];
        if (!g || /^\[[a-z_]+\]$/.test(g)) return m;
        bump(p.type);
        if (String(g).trim().length >= 3) found.push({ value: String(g).trim(), type: p.type });
        return m.replace(g, tok(p.type));
      }
      if (/^\[[a-z_]+\]$/.test(m)) return m;
      bump(p.type); return tok(p.type);
    });
  }
  // A name found once after a relation word is the same person when it comes again without one ("…what should
  // Hassan Ali eat?").
  for (const f of found) {
    const re = safeRe('(?<![\\p{L}\\d])' + escRe(f.value) + '(?![\\p{L}\\d])', 'gu');
    if (re) s = s.replace(re, () => { bump(f.type); return tok(f.type); });
  }
  return s.replace(/\u0001(\d+)\u0001/g, (_, i) => saved[Number(i)]);
}

/* ---------- prompt-injection screen ---------- */

// Weighted signals from the prompt_injection rule on normalized text, raw-text signals (spoofed headers), invisible
// Unicode (tag characters used for "ASCII smuggling", bidi controls, zero-width), long encoded blobs, and text hidden in
// tag characters, decoded and screened again. verdict: clean | suspicious | block.
function screenInjection(text, cfg) {
  cfg = cfg || {};
  const raw = String(text ?? '');
  const n = normText(raw);
  const signals = []; let score = 0;
  const add = (id, w) => { if (!signals.includes(id)) { signals.push(id); score += Number(w) || 0; } };
  // The rules run on the normalized text and on two screening copies: digits read as letters ("1gn0r3" -> "ignore")
  // and spaced-out letters joined ("i g n o r e" -> "ignore"). Arabic written in Latin letters keeps its digits in the
  // first copy, so both kinds of writing are covered.
  const leet = n.replace(/[013457@$!]/g, c => ({ '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' })[c]);
  const joined = n.replace(/\b(?:\w[ .]){3,}\w\b/g, m => m.replace(/[ .]/g, ''));
  const variants = Array.from(new Set([n, leet, joined]));
  for (const s of (cfg.signals || [])) { const re = safeRe(s.re, 'iu'); if (re && variants.some(v => re.test(v))) add(s.id, s.weight); }
  for (const s of (cfg.raw_signals || [])) { const re = safeRe(s.re, String(s.flags || 'i').replace(/[gu]/g, '') + 'u'); if (re && re.test(raw)) add(s.id, s.weight); }
  const inv = cfg.invisible || {};
  if (/[\u{E0000}-\u{E007F}]/u.test(raw)) add('unicode_tags', inv.tag_weight ?? 3);
  if (/[\u202A-\u202E\u2066-\u2069]/.test(raw)) add('bidi_control', inv.bidi_weight ?? 2);
  if (/[\u200B\u2060\uFEFF]/.test(raw)) add('zero_width', inv.zero_width_weight ?? 1);
  const b = cfg.base64 || {};
  if (b.weight && safeRe('[A-Za-z0-9+/]{' + (Number(b.min_length) || 60) + ',}={0,2}', '').test(raw)) add('encoded_blob', b.weight);
  // Encoded instructions (base64 or hex) are decoded and screened again with full weight.
  if (b.weight !== undefined) {
    for (const m of raw.match(/[A-Za-z0-9+/]{24,}={0,2}|\b(?:[0-9a-fA-F]{2}){16,}\b/g) || []) {
      const dec = /^[0-9a-fA-F]+$/.test(m) && m.length % 2 === 0 ? decodeHex(m) : decodeBase64(m);
      if (!dec || dec.length < 12) continue;
      const printable = (dec.match(/[\x20-\x7E\n\u0600-\u06FF]/g) || []).length / dec.length;
      if (printable < 0.85) continue;
      const h = screenInjection(dec, { ...cfg, invisible: {}, base64: {} });
      for (const id of h.signals) add('encoded_' + id, 0);
      score += h.score;
    }
  }
  const hidden = Array.from(raw).map(ch => ch.codePointAt(0)).filter(c => c >= 0xE0020 && c <= 0xE007E).map(c => String.fromCodePoint(c - 0xE0000)).join('');
  if (hidden.length > 3) {
    const h = screenInjection(hidden, { ...cfg, invisible: {}, base64: {} });
    for (const id of h.signals) add('hidden_' + id, 0);
    score += h.score;
  }
  const verdict = score >= (cfg.block_at ?? 3) ? 'block' : score >= (cfg.suspicious_at ?? 2) ? 'suspicious' : 'clean';
  return { score, verdict, signals };
}
function decodeBase64(x) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let bits = 0, val = 0, out = '';
  for (const ch of String(x).replace(/=+$/, '')) {
    const i = A.indexOf(ch); if (i < 0) return '';
    val = ((val << 6) | i) & 0xFFFFFF; bits += 6;
    if (bits >= 8) { bits -= 8; out += String.fromCharCode((val >> bits) & 255); }
  }
  try { return decodeURIComponent(escape(out)); } catch (e) { return out; }
}
function decodeHex(x) {
  let out = '';
  for (let i = 0; i + 1 < x.length; i += 2) out += String.fromCharCode(parseInt(x.slice(i, i + 2), 16));
  try { return decodeURIComponent(escape(out)); } catch (e) { return out; }
}

/* ---------- spotlighting ---------- */

// Untrusted text is cleaned (invisible and control characters, our marker characters, the run nonce) and wrapped in
// markers that carry a per-run nonce, so data can never close its block or pose as an instruction.
function sanitizeUntrusted(text, nonce, maxLen) {
  let s = String(text ?? '')
    .replace(/[\u{E0000}-\u{E007F}]/gu, '')
    .replace(/[‪-‮⁦-⁩​⁠﻿]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/⟦/g, '[').replace(/⟧/g, ']');
  if (nonce) s = s.split(nonce).join('[…]');
  s = s.replace(/\n{3,}/g, '\n\n');
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen) + ' …';
  return s;
}
function dataBlock(label, content, nonce, maxLen) {
  const body = typeof content === 'string' ? content : JSON.stringify(content ?? null);
  return '⟦' + label + ' ' + nonce + '⟧\n' + sanitizeUntrusted(body, nonce, maxLen || 24000) + '\n⟦/' + label + ' ' + nonce + '⟧';
}

/* ---------- data preparation ---------- */

// Dates tied to a person become relative ("12 days ago"), as in HIPAA Safe Harbor de-identification.
function relativeWhen(s, now) {
  const t = Date.parse(s);
  if (!isFinite(t)) return s;
  const diff = now - t, abs = Math.abs(diff), day = 86400000;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!dateOnly && abs < 2 * day) {
    const h = Math.round(abs / 3600000);
    if (h === 0) return diff >= 0 ? 'within the last hour' : 'within the next hour';
    return diff >= 0 ? h + ' hours ago' : 'in ' + h + ' hours';
  }
  // A date without a time is a calendar day: count whole days from today.
  const d = dateOnly ? Math.round((Math.floor(now / day) * day - t) / day) : Math.round(diff / day);
  return d === 0 ? 'today' : d > 0 ? d + ' days ago' : 'in ' + (-d) + ' days';
}
// Walks a value that will be shown to a model. Strings that read like instructions to the model (indirect prompt
// injection through record fields, documents or tool text) are replaced; identifiers are redacted when opts.redact;
// absolute dates become relative. Returns { value, stats, removed, signals }.
function prepareData(value, gate, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const cfg = (gate && gate.injection) || {};
  const stats = {}; const signals = new Set(); let removed = 0;
  const walk = (v, depth) => {
    if (depth > 12) return null;
    if (typeof v === 'string') {
      if (ISO_RE.test(v)) return opts.keepDates ? v : relativeWhen(v, now);
      if (v.length > 12) {
        const sc = screenInjection(v, cfg);
        if (sc.verdict === 'block') { removed++; sc.signals.forEach(x => signals.add(x)); return '[instruction-like text removed]'; }
        if (sc.verdict === 'suspicious') sc.signals.forEach(x => signals.add(x));
      }
      return opts.redact ? redactPHI(v, gate, stats) : v;
    }
    if (Array.isArray(v)) return v.map(x => walk(x, depth + 1));
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = walk(x, depth + 1); return o; }
    return v;
  };
  return { value: walk(value, 0), stats, removed, signals: Array.from(signals) };
}
function addStats(total, s) { for (const [k, v] of Object.entries(s || {})) total[k] = (total[k] || 0) + v; return total; }

/* ---------- output gate ---------- */

// Numbers with a clinical unit, or right after a metric name, that appear nowhere in the facts the model was given
// (tolerating rounding) and are not standard education values (output_allowed_numbers).
// Standard education values (output_allowed_numbers: 70, 180, 54 ...) are exempt only in threshold wording ("below
// 70", "between 70 and 180", «أقل من 70»), never when presented as the person's own result ("your eGFR is 30").
// A number right after an allowed one ("70-180", normalized to "70 180") is part of the same range. The emergency
// numbers 123 and 16328 are always allowed.
function ungroundedNumbers(text, facts, allowed) {
  const t = normText(text);
  const UNIT = '(?:%|٪|percent|per cent|بالمئه|بالمائه|في المئه|في الميه|بالميه|mg ?\\/ ?dl|mmol(?: ?\\/ ?l)?|ml ?\\/ ?min|mg ?\\/ ?g|mmhg|kg|bpm|units?|iu|points?|readings?|مجم ?\\/ ?دل|مجم|ملجم|وحده|وحدات|كجم|قراءات|قراءه)';
  const METRIC = '(?:tir|tar|tbr|gmi|hba1c|a1c|egfr|ldl|hdl|uacr|time in range|average|mean|التراكمي|المتوسط|متوسط|النطاق)';
  const found = new Map();
  for (const m of t.matchAll(safeRe('(\\d+(?:[.,]\\d+)?) ?' + UNIT, 'giu'))) if (!found.has(m[1])) found.set(m[1], m.index);
  for (const m of t.matchAll(safeRe(METRIC + '[^\\d\\n]{0,15}?(\\d+(?:[.,]\\d+)?)', 'giu'))) if (!found.has(m[1])) found.set(m[1], m.index + m[0].length - m[1].length);
  const factNums = (asciiDigits(facts).replace(UUID_RE, ' ').match(/\d+(?:\.\d+)?/g) || []).map(Number);
  const allow = new Set((allowed || []).map(String));
  const THRESHOLD = /(?:below|under|over|above|less than|more than|greater than|at least|at most|target|targets|between|from|to|and|or|aim for|aim|keep it|range of|range|up to|اقل من|اكثر من|اكتر من|اعلي من|فوق|تحت|بين|من|الي|الى|او|و|هدف|المستهدف|حوالي|يزيد عن|يقل عن|حتي)\s*$|\d[\s-]*$/;
  const out = [];
  for (const [raw, idx] of found) {
    const v = Number(String(raw).replace(',', '.'));
    if (!isFinite(v) || ['123', '16328'].includes(String(v))) continue;
    if (allow.has(String(v)) && THRESHOLD.test(t.slice(Math.max(0, idx - 25), idx))) continue;
    const tol = /[.,]/.test(raw) ? 0.051 : 0.51;
    if (factNums.some(f => Math.abs(f - v) <= tol)) continue;
    out.push(String(raw));
  }
  return out.slice(0, 10);
}
// Cleans model text before anyone sees it. flags: canary_leak, marker_leak, instruction_leak, phi_<type> (removed),
// markup (removed). leak = true means the whole text must be replaced.
function outputGate(text, opts) {
  opts = opts || {};
  let s = String(text ?? '');
  const flags = new Set();
  if (opts.canary && s.includes(opts.canary)) flags.add('canary_leak');
  if ((opts.nonce && s.includes(opts.nonce)) || /[⟦⟧]/.test(s)) flags.add('marker_leak');
  // For diagnosis, the leaked markers themselves (the request code replaced, at most 3, no surrounding text).
  const markers = (s.match(/⟦[^⟧\r\n]{0,48}⟧?|⟧/g) || []).concat(opts.nonce && s.includes(opts.nonce) && !/[⟦⟧]/.test(s) ? ['code'] : [])
    .map((m) => (opts.nonce ? m.split(opts.nonce).join('code') : m)).slice(0, 3);
  if (leaksInstructions(s, opts.systemText)) flags.add('instruction_leak');
  const before = s;
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
       .replace(/\[([^\]]+)\]\((?:https?:|www\.)[^)]*\)/gi, '$1')
       .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?>/gi, '');
  if (s !== before) flags.add('markup');
  // Contact details and links are kept only when they were in the facts (for example a facility phone from find_care).
  const facts = asciiDigits(opts.facts || '');
  const squash = x => asciiDigits(x).replace(/[\s.\-()]/g, '').toLowerCase();
  const factsSquashed = squash(facts);
  for (const p of patternRes(opts.gate || {})) {
    if (!['phone', 'email', 'url', 'national_id', 'id_number', 'mrn'].includes(p.type)) continue;
    s = asciiDigits(s).replace(p.rx, (m) => {
      if (/^\[[a-z_]+\]$/.test(m)) return m;
      if (['phone', 'email', 'url'].includes(p.type) && squash(m).length >= 6 && factsSquashed.includes(squash(m))) return m;
      flags.add('phi_' + p.type); return '';
    });
  }
  // Placeholders left by redaction are not shown to the person ("Hi [name]," -> "").
  s = s.replace(/(?:\b(?:dear|hi|hello)\s+|(?:^|\s)(?:يا|عزيزي|عزيزتي)\s+)?\[name\]\s*[,،]?\s*/gi, ' ');
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.،؟?!])/g, '$1').trim();
  const leak = flags.has('canary_leak') || flags.has('marker_leak') || flags.has('instruction_leak');
  return { text: s, flags: Array.from(flags), leak, markers };
}
// Applies outputGate to every string in a structured model output. Returns { value, flags, leak }.
function outputGateObject(obj, opts) {
  const flags = new Set(); let leak = false;
  const walk = (v) => {
    if (typeof v === 'string') { const r = outputGate(v, opts); r.flags.forEach(f => flags.add(f)); leak = leak || r.leak; return r.text; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = walk(x); return o; }
    return v;
  };
  const value = walk(obj);
  return { value, flags: Array.from(flags), leak };
}
`;

export const AI_LIB = GUARD_LIB + GATE_LIB;
