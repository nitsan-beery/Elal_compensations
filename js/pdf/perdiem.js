// חילוץ תלוש האש"ל ("דמי אש"ל (PERDIEM) לחודש", מלם שכר), לעדכון התעריף השנתי (בעל המוצר, 18/10/2026).
//
// רק התלוש המקורי מהפורטל (iText) נקרא: תלוש שנשמר ב-Print to PDF הוא תמונה, בלי שכבת טקסט. בכל שורת
// תשלום, משמאל לימין: הסכום, התעריף לשעה, השעות, תאריך התוקף והתיאור. שורה בתאריך אחר היא תשלום בדיעבד.

import { extractPages, toRows } from './extract.js';

const fail = (message) => Object.assign(new Error(message), { exact: true });
const plain = (s) => s.replace(/[״”]/g, '"');
const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/**
 * @returns {Promise<{period: {year:number, month:number}, staff: string|null, person: string|null,
 *   stay_usd: number, flight_usd: number}>}
 */
export async function parsePerDiem(data) {
  const pages = await extractPages(data);
  const items = pages.flatMap((p) => p.items);
  if (items.length < 5) throw fail('בקובץ אין שכבת טקסט (כנראה נשמר ב-Print to PDF). הורד את התלוש מהפורטל כמו שהוא.');
  if (!items.some((i) => i.s.includes('PERDIEM'))) throw fail('הקובץ אינו נראה כמו תלוש אש"ל. ודא שהעלית את תלוש האש"ל של אפריל.');
  const rows = toRows(pages[0].items).map((r) => r.items ?? r);
  // החודש: התאריך בשורת הכותרת, "01/04/2026 דמי אש"ל (PERDIEM) לחודש".
  const head = rows.find((r) => r.some((i) => i.s.includes('PERDIEM')));
  const date = head?.find((i) => DATE_RE.test(i.s))?.s;
  if (!date) throw fail('לא נמצא בתלוש החודש שהוא משולם עליו.');
  const [, , mm, yyyy] = date.match(DATE_RE);
  // מספר העובד והשם מגוף התלוש, משמאל לתווית: בכותרת הם בשורות שזזות כשאין "Box number".
  const left = (label) => {
    for (const r of rows) {
      const k = r.findIndex((i) => i.s === label);
      if (k > 0) return r[k - 1].s;
    }
    return null;
  };
  const staff = left('מספר אישי')?.replace(/^0+/, '') ?? null;
  const rate = (label) => {
    const r = rows.find((row) => row.some((i) => plain(i.s) === label) && row.some((i) => i.s === date));
    const k = r?.findIndex((i) => i.s === date) ?? -1;
    const v = k >= 2 ? Number(r[k - 2].s.replace(/,/g, '')) : NaN;
    if (!(v > 0)) throw fail(`לא נמצא בתלוש התעריף של "${label}".`);
    return v;
  };
  return {
    period: { year: Number(yyyy), month: Number(mm) },
    staff,
    person: left('שם'),
    stay_usd: rate('אש"ל שהייה'),
    flight_usd: rate('אש"ל טיסה'),
  };
}

/**
 * התעריף החדש מהתלוש, מול התקופה הקודמת (`rates` ב-`per_diem`). התלוש הוא של `position`, ושאר התפקידים
 * נגזרים באותו אחוז: כל עדכון מעלה את כל התעריפים באותו אחוז, כל אחד מהקודם שלו, ומעגל לסנט (בעל המוצר,
 * 18/10/2026). טווח האחוזים הוא מה ששני התעריפים בתלוש מתיישבים איתו; כשהוא נותן שני סנטים – הגבוה
 * (`ambiguous`). 04/2025: ‏5.55 → 5.75 או 5.76 (בתלוש 5.76); 04/2026: ‏5.76 → 6.04.
 * @returns {null | {from: string, stay_usd: object, flight_usd: number, prev: object, pct: number,
 *   unchanged: boolean, derived: Record<string, {low: number, high: number}>}}
 */
export function rateFromSlip(slip, rates, position) {
  const from = `${slip.period.year}-${String(slip.period.month).padStart(2, '0')}-01`;
  const prev = [...(rates ?? [])].sort((a, b) => b.from.localeCompare(a.from)).find((r) => r.from < from);
  if (!prev || prev.stay_usd[position] == null) return null;
  const c = (usd) => Math.round(usd * 100);
  const span = (was, now) => [(c(now) - 0.5) / c(was), (c(now) + 0.5) / c(was)];
  const a = span(prev.stay_usd[position], slip.stay_usd);
  const b = span(prev.flight_usd, slip.flight_usd);
  let [lo, hi] = [Math.max(a[0], b[0]), Math.min(a[1], b[1])];
  if (lo > hi) [lo, hi] = [Math.min(a[0], b[0]), Math.max(a[1], b[1])]; // שני התעריפים לא עלו באותו אחוז
  const stay = { [position]: slip.stay_usd };
  const derived = {};
  for (const [pos, was] of Object.entries(prev.stay_usd)) {
    if (pos === position) continue;
    const [low, high] = [Math.round(c(was) * lo) / 100, Math.round(c(was) * hi) / 100];
    stay[pos] = high;
    derived[pos] = { low, high };
  }
  const unchanged = slip.stay_usd === prev.stay_usd[position] && slip.flight_usd === prev.flight_usd;
  const pct = Math.round((slip.flight_usd / prev.flight_usd - 1) * 1000) / 10;
  return { from, stay_usd: stay, flight_usd: slip.flight_usd, prev, pct, unchanged, derived };
}
