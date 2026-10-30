/**
 * Client-side backup to the Companion's server pre-screen (rules in database/sheets/rules.json, run in
 * api_companion_prepare before any model). It only decides whether to show the "call 123" banner at once, also when
 * the request never reaches the server; it never blocks, changes or replaces what is sent. Kept small and literal:
 * the server pre-screen stays the source of truth.
 */

/** Lower case, Arabic diacritics and tatweel removed, alef / yaa / taa marbuta forms unified, Arabic-Indic digits to 0-9. */
function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, ' ');
}

const PATTERNS: RegExp[] = [
  // chest pain
  /\bchest (?:pain|pressure|tightness)|\bpain in (?:my|the) chest|الم (?:ف|في) (?:ال)?صدر|وجع (?:ف|في) (?:ال)?صدر|صدري (?:بيوجعني|واجعني|بيتقل)|ضغط (?:ف|في|علي) صدري/,
  /\b(?:w[a2]?g[a3]+|wag3|alam) (?:f|fi|fe) (?:el)?sadr|sadr[iy] (?:b[iey]?y?)?w[a2]?g[a3]+/,
  // cannot breathe
  /\b(?:can'?t|cannot|can not|unable to|hard to|trouble|difficulty|struggling to) breath|\bshort(?:ness)? of breath|\bnot breathing\b/,
  /مش (?:قادر|قادره) (?:ا|أ)?تنفس|مش عارف (?:ا)?تنفس|ضيق (?:ف|في )?(?:ال)?تنفس|صعوب[هة] (?:ف|في )?(?:ال)?تنفس|بتنفس بصعوب|نفسي (?:مقطوع|بيتقطع)/,
  /\b(?:msh|mesh|mish) (?:2ader|2adra|qader|3arf|3arfa) (?:a|at)?n?afe?s|\bnafas[iy]? (?:ma2tou3|by2ta3)/,
  // unconscious, fainting, seizure, stroke
  /\bunconscious|\bpassed out|\bfainted|\bwon'?t wake|\bnot waking|\bunresponsive|\bseizure|\bstroke\b|\bface (?:is )?drooping/,
  /فاقد (?:ال)?وعي|مغمي علي|اغمي علي|اغم[يا] عليه|مش بيفوق|مش بتفوق|مش (?:بيرد|بترد) علي|تشنج|جلطه/,
  /\b(?:oghma|ughma|aghma|oghmy) 3al|\bmsh (?:bey|bi)fo2|\bmesh (?:bey|bi)fo2|\btashannog|\bgalta\b/,
  // very low sugar: a reading below 54 mg/dL next to a sugar word, or "very low"
  /\b(?:sugar|glucose|reading|bg)\b[^.\n0-9]{0,20}\b(?:[1-4]\d|5[0-3])\b(?!\s*(?:%|mmol|min|minute|hour|day|year|kg|units?))/,
  /(?:سكر|قراءه|قرايه)[^.\n0-9]{0,20}(?:[1-4][0-9]|5[0-3])(?![0-9])(?!\s*(?:%|دقيق|ساع|يوم|سن|كيلو|وحد|مليمول))/,
  /\b(?:sugar|glucose)\b[^.\n]{0,15}\b(?:very|really|dangerously|extremely) low|\bsevere hypo/,
  /(?:السكر|سكر|سكري)[^.\n]{0,15}(?:واطي|نازل|منخفض|وقع) (?:جدا|اوي|خالص|قوي)|هبوط (?:حاد|شديد) (?:ف|في )?(?:ال)?سكر/,
  /\b(?:sokk?ar|sukk?ar)\b[^.\n]{0,15}\b(?:wate|wa6i|nazel|wa2e3) (?:awy|gedan|khales)/,
  // self-harm
  /\b(?:kill|hurt|harm) (?:my ?self|myself)|\bsuicid|\bend (?:my|it) (?:life|all)|\bwant(?:s)? to die\b|\bself[- ]harm|\bdon'?t want to (?:live|be alive)/,
  /(?:عايز|عايزه|عاوز|عاوزه|اريد|بفكر) (?:ا|أ)?موت|هنتحر|انتحار|انتحر|اقتل نفسي|(?:ا|أ)?ذي نفسي|اموت نفسي|مش عايز (?:ا)?عيش|انهي حياتي/,
  /\b(?:3ayez|3ayza|3awez|3awza) (?:a)?moo?t\b|\bhanteh?ar|\bente?har\b|\ba2tel nafs/,
];

/** True when the message reads like an emergency (chest pain, trouble breathing, fainting, a very low sugar, self-harm). */
export function looksLikeEmergency(text: string): boolean {
  const s = norm(text || '');
  return !!s && PATTERNS.some((re) => re.test(s));
}
