// זמני רגל וזמני סבב: המקום היחיד שקובע מתי רגל או סבב מתחילים ונגמרים.
//
// כל הזמנים הם דקות מוחלטות בשעון הבסיס: `at(date, clock)`. כך אפשר להשוות בין רגליים
// וסבבים בימים שונים בלי לחשב הפרשי ימים בכל מקום.
//
// בשני הקבצים רגל רשומה ביום ההמראה המתוכננת בשעון הבסיס:
// - תכנון: שעה בלי ! היא שעון הבסיס, ושעה עם ! – שעון התחנה. "-1" ליד המוצא אומר רק שבשעון
//   התחנה ההמראה עוד ביום הקודם (BUD!2315-1 ב-15/06/2026 = 00:15 שעון הבסיס, ‏LIS!2225-1 ב-21/05/2025),
//   ו-"+1" ליד הנחיתה – שהנחיתה ביום שאחרי. גם ב-1 לחודש: LY388 מ-MXP ב-01/06/2026, ‏22:55 שעון
//   מילאנו = 23:55 שעון הבסיס, נחתה ב-02/06 (כך גם ברומה).
// - רומה: STD, ‏STA, ‏ATD ו-ATA מקומיים לכל שדה (LY398 מ-MAD ב-24/01/2025: ‏STD 23:05 מקומי = 00:05).
//   החריג היחיד: ב-1 לחודש הרומה חוזרת על הרגל שיצאה ביום האחרון של החודש הקודם (`prevMonth`,
//   `markCarryIn` ב-js/model.js; ‏LY387 ב-01/06/2026), והיא יום אחד קודם.

import { stationOffset } from './airports.js';

const dayMs = 86400000;
export const at = (date, clock) => Date.parse(date) / 60000 + clock;
export const dateOf = (abs) => new Date(Math.floor(abs / 1440) * dayMs).toISOString().slice(0, 10);
const mod = (n, m) => ((n % m) + m) % m;
/** ההפרש הקרוב ביותר בין שתי שעות באותו שעון: עיכוב או הקדמה של עד 12 שעות, גם מעבר לחצות. */
const nearest = (n) => mod(n + 720, 1440) - 720;
const byDistance = (list, date) =>
  [...list].sort((a, b) => Math.abs(Date.parse(a.date) - Date.parse(date)) - Math.abs(Date.parse(b.date) - Date.parse(date)))[0];

/**
 * אזורי הזמן של החודש: `offsetAt(station, date)` – שעון התחנה פחות שעון הבסיס, בדקות, או null.
 * 0 בבסיס; אחרת מה שנלמד מקובץ התכנון (`stationOffsets`: ימים עם תחנה זרה אחת וה-FT שלהם), ואחריו
 * מה שנלמד מהרומה (רגל מהבסיס לתחנה או ממנה: STD, ‏STA ו-SkdDur נותנים את ההפרש המדויק), ואחריו
 * אזור הזמן של השדה (js/airports.js). מכל מקור – מהתאריך הקרוב ביותר, בגלל שעון קיץ.
 */
export function timeZones(domicile, planOffsets = null, timeline = []) {
  const learned = {};
  for (const day of timeline) {
    for (const l of day.exec?.legs ?? []) {
      if (l.std == null || l.sta == null || l.skdDur == null || l.prevMonth) continue;
      if (l.org === domicile && l.dst !== domicile) (learned[l.dst] ||= []).push({ date: day.date, off: nearest(l.sta - l.std - l.skdDur) });
      if (l.dst === domicile && l.org !== domicile) (learned[l.org] ||= []).push({ date: day.date, off: nearest(l.std + l.skdDur - l.sta) });
    }
  }
  return {
    domicile,
    offsetAt(station, date) {
      if (!station || station === domicile) return 0;
      const list = planOffsets?.[station]?.length ? planOffsets[station] : learned[station];
      if (list?.length) return byDistance(list, date).off;
      return stationOffset(station, date, domicile);
    },
  };
}

/**
 * זמני רגל: `std` ו-`sta` המתוכננים, `atd` ו-`ata` בפועל (null בתכנון, או בלי ATD ברומה).
 * - המראה מתוכננת: היום הרשום ושעת ה-STD בשעון הבסיס. רגל שנוחתת בבסיס – STA פחות SkdDur, כך
 *   שאין צורך בהפרש של שדה המוצא; אחרת לפי `tz.offsetAt`.
 * - נחיתה מתוכננת: ההמראה ועוד SkdDur ברומה, ועוד STA − STD (כל צד בשעון הבסיס) בתכנון. ה-`skdDur`
 *   של רגל בתכנון אינו משמש: הוא ה-FT של כל היום, שנרשם על הרגל האחרונה בו.
 * - המראה בפועל: ה-ATD הקרוב ביותר ל-STD, עד 12 שעות לפני או אחרי – גם עיכוב שעובר את חצות
 *   (STD 22:55, ‏ATD 00:08: LY388 ב-01/06/2026). נחיתה בפועל: ההמראה בפועל ועוד ActDur, ובלעדיו SkdDur.
 * null כשאין שעת המראה, או שאין הפרש שעון לשדה שצריך אותו.
 */
export function legTimes(leg, tz) {
  if (leg.dep || leg.arr) return planLegTimes(leg, tz);
  const raw = leg.std ?? leg.atd;
  if (raw == null) return null;
  let depBase;
  if (leg.org === tz.domicile) depBase = raw;
  else if (leg.dst === tz.domicile && leg.std != null && leg.sta != null && leg.skdDur != null) depBase = mod(leg.sta - leg.skdDur, 1440);
  else {
    const off = tz.offsetAt(leg.org, leg.date);
    if (off == null) return null;
    depBase = mod(raw - off, 1440);
  }
  const std = at(leg.date, depBase) - (leg.prevMonth ? 1440 : 0);
  let block = leg.skdDur;
  if (block == null && leg.sta != null) {
    const off = tz.offsetAt(leg.dst, leg.date);
    if (off != null) block = mod(leg.sta - off - depBase, 1440);
  }
  const atd = leg.atd != null ? std + nearest(leg.atd - raw) : null;
  const actual = leg.actDur ?? block;
  return {
    std,
    sta: block == null ? null : std + block,
    atd,
    ata: atd == null || actual == null ? null : atd + actual,
  };
}

function planLegTimes(leg, tz) {
  if (!leg.dep || !leg.arr) return null;
  const o1 = leg.dep.foreign ? tz.offsetAt(leg.org, leg.date) : 0;
  const o2 = leg.arr.foreign ? tz.offsetAt(leg.dst, leg.date) : 0;
  if (o1 == null || o2 == null) return null;
  const depBase = mod(leg.dep.min - o1, 1440);
  const std = at(leg.date, depBase);
  return { std, sta: std + mod(leg.arr.min - o2 - depBase, 1440), atd: null, ata: null };
}

/**
 * זמני סבב, מהרגל הראשונה שיוצאת מהבסיס ועד האחרונה שחוזרת אליו (`legTimes`), ו-`flight` – סכום
 * ה-SkdDur. צד שאינו בחודש (סבב חתוך, `cutAtStart` / `cutAtEnd`) הוא null.
 * - בלי `away`: המתוכנן – Off block ב-STD ו-On block ב-STA.
 * - `away`: השהייה מחוץ לבסיס (ישן כ"ה ס' 1.יא) – מההמראה המתוכננת או בפועל, המוקדמת מביניהן, ועד
 *   הנחיתה בפועל בבסיס. כשהרומה רושמת את הסבב עד יום מסוים, הנחיתה לפי ה-TAB של היום הזה
 *   (`pairing.reportEnd`, ‏`reportEnd` ב-js/rules/evaluate.js), כי היא כבר חישבה אותה לפי הזמנים
 *   בפועל; אחרת ATA, ובלעדיו STA.
 */
export function pairingTimes(pairing, tz, { away = false } = {}) {
  const out = pairing.cutAtStart ? null : pairing.legs.find((l) => l.org === tz.domicile);
  const home = pairing.cutAtEnd ? null : pairing.legs.findLast((l) => l.dst === tz.domicile);
  const a = out ? legTimes(out, tz) : null;
  const b = home ? legTimes(home, tz) : null;
  let start = a?.std ?? null;
  let end = b?.sta ?? null;
  if (away) {
    if (a?.atd != null) start = Math.min(start, a.atd);
    if (b) end = pairing.reportEnd ? at(pairing.reportEnd.date, pairing.reportEnd.min) : b.ata ?? b.sta;
  }
  const flight = pairing.legs.reduce((s, l) => (s == null || l.skdDur == null ? null : s + l.skdDur), 0);
  return { start, end, flight };
}

/** רגל שהמריאה לפני חצות בשעון הבסיס ונחתה בחצות או אחריו, לפי הזמנים המתוכננים או בפועל. */
export function crossesMidnight(leg, tz) {
  const t = legTimes(leg, tz);
  if (!t) return false;
  return (t.sta != null && dateOf(t.sta) > dateOf(t.std)) || (t.ata != null && dateOf(t.ata) > dateOf(t.atd));
}
