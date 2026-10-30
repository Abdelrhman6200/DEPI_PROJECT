import type { GlucoseContext } from '@health/api-client';

/**
 * Reads a spoken glucose reading: "سكري 180 بعد الفطار", "مية وتمانين صايم", "my sugar is 95 before lunch".
 * Returns the number (mg/dL) and, when said, when it was measured. The person always sees and confirms the result
 * before it is saved; nothing here is sent anywhere (the browser's speech recognition gives the text).
 */
export interface VoiceReading { value: number | null; context: GlucoseContext | null }

const UNITS: Record<string, number> = {
  واحد: 1, اتنين: 2, اثنين: 2, اثنان: 2, تلاتة: 3, تلاته: 3, ثلاثة: 3, اربعة: 4, أربعة: 4, اربعه: 4, خمسة: 5, خمسه: 5,
  ستة: 6, سته: 6, سبعة: 7, سبعه: 7, تمانية: 8, تمانيه: 8, ثمانية: 8, تسعة: 9, تسعه: 9,
};
const TEENS: Record<string, number> = {
  عشرة: 10, عشره: 10, حداشر: 11, اتناشر: 12, تلتاشر: 13, اربعتاشر: 14, خمستاشر: 15, ستاشر: 16, سبعتاشر: 17, تمنتاشر: 18, تسعتاشر: 19,
};
const TENS: Record<string, number> = {
  عشرين: 20, تلاتين: 30, ثلاثين: 30, اربعين: 40, أربعين: 40, خمسين: 50, ستين: 60, سبعين: 70, تمانين: 80, ثمانين: 80, تسعين: 90,
};
const HUNDREDS: Record<string, number> = {
  مية: 100, ميه: 100, مائة: 100, مئة: 100, ميتين: 200, مائتين: 200, مئتين: 200, تلتمية: 300, تلاتمية: 300, ثلاثمائة: 300,
  ربعمية: 400, اربعمية: 400, أربعمائة: 400, خمسمية: 500, خمسمائة: 500, ستمية: 600, ستمائة: 600,
};
const EN: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

function wordsToNumber(text: string): number | null {
  let total = 0, found = false;
  for (const raw of text.split(/\s+/)) {
    const w = raw.replace(/^و/, '').replace(/[.,،؟?!]/g, '').toLowerCase();
    if (!w) continue;
    if (w in HUNDREDS) { total += HUNDREDS[w]; found = true; continue; }
    if (w === 'hundred') { total = (total || 1) * 100; found = true; continue; }
    const n = TENS[w] ?? TEENS[w] ?? UNITS[w] ?? EN[w];
    if (n !== undefined) { total += n; found = true; continue; }
    if (found && !/^(and|و)$/.test(w)) break;
  }
  return found ? total : null;
}

export function parseVoiceReading(text: string): VoiceReading {
  const t = text.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).trim();
  const digits = t.match(/\d{2,3}/g)?.map(Number).find((n) => n >= 20 && n <= 600) ?? null;
  const value = digits ?? (() => { const n = wordsToNumber(t); return n !== null && n >= 20 && n <= 600 ? n : null; })();
  const s = t.toLowerCase();
  let context: GlucoseContext | null = null;
  if (/صايم|صائم|صيام|على الريق|ع الريق|fasting|empty stomach/.test(s)) context = 'fasting';
  else if (/بعد (ال)?(أكل|اكل|فطار|غدا|غداء|عشا|عشاء|وجبة|الفطور)|after (a |the )?(meal|breakfast|lunch|dinner|eating)/.test(s)) context = 'post_meal';
  else if (/قبل (ال)?(أكل|اكل|فطار|غدا|غداء|عشا|عشاء|وجبة|الفطور)|before (a |the )?(meal|breakfast|lunch|dinner|eating)/.test(s)) context = 'pre_meal';
  else if (/قبل (ال)?نوم|bed ?time|before (bed|sleep)/.test(s)) context = 'bedtime';
  else if (/بالليل|نص الليل|في الليل|at night|middle of the night/.test(s)) context = 'night';
  return { value, context };
}
