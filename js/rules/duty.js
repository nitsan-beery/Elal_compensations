// חוקים שתלויים בזמני התפקיד: FDP, מנוחה בבסיס, נחיתות לילה ותאריכים מיוחדים.
//
// כל הזמנים כאן הם דקות מוחלטות בשעון הבסיס (שעון ישראל): `at(date, clock)`. כך אפשר
// להשוות בין סבבים בימים שונים בלי לחשב הפרשי ימים בכל מקום.
//
// שני מקורות לזמנים:
// - סבב תכנון: רגל עם dep/arr ({min, foreign}). שעה בלי ! היא שעון הבסיס. רגל רשומה
//   ביום ההמראה, ונחיתה שנראית מוקדמת מההמראה היא ביום שאחרי (LY336 ב-16/07/2026).
// - סבב ביצוע: רגל עם std/sta/atd/ata ומשכים. השעות מקומיות לכל תחנה, והרגל רשומה
//   ביום ההמראה בשעון הבסיס (ראו awayFromBase ב-logic.js).

import { hoursToMin, minToHhmm } from '../time.js';
import { describePairing } from '../model.js';
import { stationOffset } from '../airports.js';

const H = (hours) => hoursToMin(hours) ?? 0;
/**
 * המילה שמתארת סכום לפי העמודה שבה הוא נרשם: COM ו-S/C הם פיצוי, ו-Credit ו-Rig הם
 * קרדיט (בעל המוצר, 23/09/2026). שם העמודה עצמו אינו מוצג בהערות ובשאלות.
 */
export const amountWord = (column) => (column === 'COM' || column === 'S/C' ? 'פיצוי' : 'קרדיט');
const dayMs = 86400000;
const at = (date, clock) => Date.parse(date) / 60000 + clock;
const dateOf = (abs) => new Date(Math.floor(abs / 1440) * dayMs).toISOString().slice(0, 10);
const clockOf = (abs) => ((abs % 1440) + 1440) % 1440;
const addDays = (iso, n) => new Date(Date.parse(iso) + n * dayMs).toISOString().slice(0, 10);
const ddmm = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7);
const hhmm = (abs) => minToHhmm(clockOf(abs));
const mod = (n, m) => ((n % m) + m) % m;
const parseClock = (s) => {
  const m = String(s ?? '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const keyFor = (column) => (column === 'S/C' ? 'sc' : column === 'Credit' ? 'credit' : 'com');

/** בתכנון אין משך לרגל: STA − STD, כששעת נחיתה עם ! מומרת לשעון הבסיס לפי airports.js. */
const planBlock = (l) => {
  if (!l.arr || !l.dep) return null;
  const off = l.arr.foreign ? stationOffset(l.dst, l.date) : 0;
  return off == null ? null : mod(l.arr.min - off - l.dep.min, 1440);
};

// ---------- זמני סבב ----------

/**
 * זמני סבב מתוכנן לפי קובץ התכנון: יציאה מהבסיס (Off block), חזרה לבסיס (On block)
 * ושעות הטיסה המתוכננות (FT ורגלי DH). צד שאינו בחודש (סבב חתוך) נשאר null.
 */
function planSpan(pairing, domicile, monthFirst) {
  const out = pairing.legs.find((l) => l.org === domicile && l.dep && !l.dep.foreign);
  const home = pairing.legs.findLast((l) => l.dst === domicile && l.arr && !l.arr.foreign);
  const start = out && !pairing.cutAtStart ? at(out.date, out.dep.min) : null;
  let end = null;
  if (home && !pairing.cutAtEnd) {
    // נחיתה שנראית מוקדמת מההמראה היא ביום שאחרי. ביום הראשון בחודש, רגל שיצאה בחודש
    // הקודם רשומה ביום הנחיתה (LY388 ב-01/06/2026).
    const carriedIn = home.date === monthFirst && home.org !== domicile;
    const nextDay = !carriedIn && home.dep && home.arr.min < home.dep.min;
    end = at(home.date, home.arr.min) + (nextDay ? 1440 : 0);
  }
  const flight = pairing.legs.reduce((s, l) => (s == null || l.skdDur == null ? null : s + l.skdDur), 0);
  return { start, end, flight };
}

/**
 * זמני סבב ביצוע. `planned` – לפי STD/STA; אחרת הטווח הרחב מבין המתוכנן לבפועל,
 * כמו בשהייה מחוץ לבסיס (ישן כ"ה ס' 1.יא).
 */
function execSpan(pairing, domicile, planned) {
  const out = pairing.legs.find((l) => l.org === domicile);
  const home = pairing.legs.findLast((l) => l.dst === domicile);
  let start = null;
  if (out && !pairing.cutAtStart) {
    const clocks = planned ? [out.std] : [out.std, out.atd];
    const c = clocks.filter((t) => t != null);
    if (c.length) start = at(out.date, Math.min(...c));
  }
  let end = null;
  if (home && !pairing.cutAtEnd) {
    const ends = [];
    if (home.sta != null && home.skdDur != null) ends.push(at(home.date, mod(home.sta - home.skdDur, 1440)) + home.skdDur);
    if (!planned && home.ata != null && (home.actDur ?? home.skdDur) != null) {
      const dur = home.actDur ?? home.skdDur;
      ends.push(at(home.date, mod(home.ata - dur, 1440)) + dur);
    }
    if (ends.length) end = Math.max(...ends);
  }
  const flight = pairing.legs.reduce((s, l) => (s == null || l.skdDur == null ? null : s + l.skdDur), 0);
  return { start, end, flight };
}

/** טיסת סבב (turnaround): אין בה מנוחה בחו"ל, כלומר זמן הקרקע בחו"ל קצר מהמנוחה החוקית. */
const isTurnaround = (span, legalRest) =>
  span.start != null && span.end != null && span.flight != null && span.end - span.start - span.flight < legalRest;

/** המנוחה בין סיום FDP (On block בבסיס) לבין ההתייצבות לפעילות הבאה. */
const restBetween = (a, b, reportMin) => b.start - reportMin - a.end;

function planPairingsSorted(ctx) {
  return [...ctx.planPairings].sort((a, b) => a.from.localeCompare(b.from));
}

/** הסבב המבוצע שהותאם לסבב מתוכנן, רק כשהוא בוצע כמתוכנן. */
function performedAsPlanned(ctx, planPairing) {
  const m = ctx.matches.find((x) => x.plan === planPairing);
  return m?.how === 'exact' ? m.exec : null;
}

// ---------- שתי טיסות סבב באותו FDP (2024 ס' 38) ----------

/**
 * שתי טיסות סבב מתוכננות בלי מנוחה חוקית ביניהן הן באותו FDP. כשאצ"א תוכנן והתייצב לשתיהן,
 * מגיע פיצוי אחד. הזיכוי המינימלי לכל סבב כבר נבדק בחוק הסליפ הקצר, כי כל חזרה לבסיס
 * סוגרת סבב.
 */
function same_fdp_rounds(ctx, params, rule) {
  if (!ctx.hasPlan) return;
  const legal = H(params.legal_rest_hours);
  const report = params.report_minutes_before_std ?? 0;
  const list = planPairingsSorted(ctx);
  for (let i = 1; i < list.length; i++) {
    const [p1, p2] = [list[i - 1], list[i]];
    const [s1, s2] = [planSpan(p1, ctx.domicile, ctx.monthFirst), planSpan(p2, ctx.domicile, ctx.monthFirst)];
    if (s1.end == null || s2.start == null) continue;
    const rest = restBetween(s1, s2, report);
    if (rest >= legal) continue;
    if (!isTurnaround(s1, legal) || !isTurnaround(s2, legal)) continue;

    const why = `${describePairing(p1)} ו-${describePairing(p2)}: ${minToHhmm(Math.max(rest, 0))} בין הנחיתה (${hhmm(s1.end)}) ` +
      `להתייצבות (${hhmm(s2.start - report)}), פחות ממנוחה חוקית של ${params.legal_rest_hours} שעות. שתי טיסות סבב באותו FDP`;
    if (!ctx.hasExec) {
      ctx.expectPairing(p2, keyFor(params.report_column), H(params.hours), rule, why);
      continue;
    }
    const [e1, e2] = [performedAsPlanned(ctx, p1), performedAsPlanned(ctx, p2)];
    if (!e1 || !e2) {
      ctx.note(p2.from, `${why}, אבל שתיהן לא בוצעו כמתוכנן. הפיצוי מותנה בהתייצבות לשתיהן.`, rule);
      continue;
    }
    ctx.expectPairing(e2, keyFor(params.report_column), H(params.hours), rule, why);
  }
}

// ---------- פעילות שנייה לא מתוכננת (2024 ס' 42.6–42.7) ----------

/**
 * טיסה או סימולטור שלא היו בתכנון, באותה יממה שבה אצ"א ביצע טיסה או סימולטור אחרים.
 * לא כולל פעילות קרקע, ולא שתי פעילויות באותו FDP (פחות ממנוחה חוקית ביניהן).
 */
function second_unplanned_activity(ctx, params, rule) {
  if (!ctx.hasExec || !ctx.hasPlan) return;
  const legal = H(params.legal_rest_hours);
  const report = params.report_minutes_before_std ?? 0;
  const simReport = params.sim_report_codes ?? [];
  const simPlan = params.sim_plan_codes ?? [];
  const simPlanPrefixes = params.sim_plan_code_prefixes ?? [];
  const isSimDay = (day) => ctx.execCodes(day).some((c) => simReport.includes(c));
  // SIM_PRG ב-28/01/2025: סימולטור בחו"ל שתוכנן באמצע סבב.
  const simPlanned = (day) => (day.plan?.codes ?? []).some((c) => simPlan.includes(c) || simPlanPrefixes.some((x) => c.startsWith(x)));
  const key = keyFor(params.report_column);
  const own = ctx.rulesWithLogic('second_unplanned_activity').map((r) => r.id);

  const askRest = (id, date, title) => ctx.ask({
    id, date, title,
    body: `לסימולטור אין שעות בקבצים, והדוח לא מזכה על הפעילות השנייה. היא מזכה רק אם הייתה מנוחה חוקית (${params.legal_rest_hours} שעות לפחות) בין שתי הפעילויות, כלומר הן לא באותו FDP.`,
    options: [
      { value: 'separate', label: `הייתה מנוחה של ${params.legal_rest_hours} שעות לפחות`, hint: `${minToHhmm(H(params.hours))} על הפעילות השנייה` },
      { value: 'same_fdp', label: 'שתיהן באותו FDP', hint: 'אין פיצוי' },
    ],
    ruleId: rule.id,
  });

  // טיסה לא מתוכננת
  for (const m of ctx.matches) {
    if (m.how !== 'unplanned' || m.exec.cutAtStart) continue;
    if (ctx.answerFor(m)?.value === 'voluntary_swap') continue;
    const u = m.exec;
    const span = execSpan(u, ctx.domicile, false);
    if (span.start == null) continue;
    const day = u.from;
    const others = ctx.execPairings.filter((p) => p !== u && p.dates.includes(day));
    let separate = null;
    for (const o of others) {
      const so = execSpan(o, ctx.domicile, false);
      const [first, second] = (so.start ?? 0) < span.start ? [so, span] : [span, so];
      if (first.end == null || second.start == null) continue;
      if (restBetween(first, second, report) >= legal) { separate = o; break; }
    }
    if (separate) {
      ctx.expectPairing(u, key, H(params.hours), rule,
        `${describePairing(u)} לא הייתה בתכנון, ובאותה יממה בוצעה גם ${describePairing(separate)} עם מנוחה חוקית ביניהן`);
      continue;
    }
    if (others.length) {
      ctx.note(day, `${describePairing(u)} לא הייתה בתכנון, אבל היא באותו FDP עם ${others.map(describePairing).join(', ')}. אין פיצוי על פעילות שנייה (2024 ס' 42.7).`, rule);
      continue;
    }
    const simDay = ctx.timeline.find((d) => d.date === day && isSimDay(d));
    if (!simDay) continue;
    const id = `second_activity:${u.id}`;
    const answered = ctx.answer(id);
    const a = answered ?? (ctx.paidOn(u, params.report_column, key, H(params.hours), own) ? { value: 'separate' } : null);
    if (!a) askRest(id, day, `${describePairing(u)} לא הייתה בתכנון, ובאותה יממה היה סימולטור. האם הייתה מנוחה ביניהם?`);
    else if (a.value === 'separate') ctx.expectPairing(u, key, H(params.hours), rule, `${describePairing(u)} לא הייתה בתכנון, ובאותה יממה היה סימולטור ` +
      `(${answered ? 'לפי תשובתך, עם מנוחה חוקית ביניהם' : `הדוח מזכה את הפיצוי`})`);
  }

  // סימולטור לא מתוכנן ביום טיסה
  for (const day of ctx.timeline) {
    if (!isSimDay(day) || simPlanned(day)) continue;
    const flights = ctx.execPairings.filter((p) => p.dates.includes(day.date));
    if (!flights.length) continue;
    const id = `second_activity:sim:${day.date}`;
    const answered = ctx.answer(id);
    const a = answered ?? (ctx.paidOnDate(day.date, params.report_column, key, H(params.hours)) ? { value: 'separate' } : null);
    if (!a) askRest(id, day.date, `סימולטור ב-${ddmm(day.date)} לא היה בתכנון, ובאותה יממה בוצעה ${flights.map(describePairing).join(', ')}. האם הייתה מנוחה ביניהם?`);
    else if (a.value === 'separate') ctx.expect(day.date, key, H(params.hours), rule,
      `סימולטור לא מתוכנן ביממה עם טיסה (${answered ? 'לפי תשובתך, עם מנוחה חוקית ביניהם' : `הדוח מזכה את הפיצוי`})`);
  }
}

// ---------- מנוחה חוזית בבסיס (2018 ס' 53–54; 2024 ס' 35; ישן כ"ה ס' 12.טו) ----------

/**
 * מנוחה חוזית בבסיס מתחילה `rest_buffer_minutes` אחרי תום ה-FDP ומסתיימת `rest_buffer_minutes`
 * לפני ההתייצבות (2018 ס' 53). משכה (ס' 54): בשהייה של עד `short_stay_max_hours` – פי
 * `short_stay_factor` משעות הטיסה; מעבר לזה – `long_stay_share` מהשהייה, בין
 * `long_stay_min_hours` ל-`long_stay_max_hours`.
 *
 * שני חוקים משתמשים באותה בדיקה ובאותה שאלה, וכל אחד מזכה רק בתשובה שלו (`answer_value`):
 * ויתור לבקשת החברה (2024 ס' 35) או תכנון שגוי שלא תוקן (ישן כ"ה ס' 12.טו).
 * רצף טיסות סבב עוקבות מותר בתכנון עם מנוחה קצרה (2018 ס' 55), ואינו נבדק כאן.
 */
function base_rest_shortfall(ctx, params, rule) {
  if (!ctx.hasPlan) return;
  const buffer = params.rest_buffer_minutes ?? 0;
  const report = params.report_minutes_before_std ?? 0;
  const legal = H(params.legal_rest_hours);
  const list = planPairingsSorted(ctx);

  for (let i = 1; i < list.length; i++) {
    const [p1, p2] = [list[i - 1], list[i]];
    const [s1, s2] = [planSpan(p1, ctx.domicile, ctx.monthFirst), planSpan(p2, ctx.domicile, ctx.monthFirst)];
    if (s1.start == null || s1.end == null || s2.start == null || s1.flight == null) continue;
    if (isTurnaround(s1, legal) && isTurnaround(s2, legal)) continue; // רצף סבבים, 2018 ס' 55

    const rest = restBetween(s1, s2, report) - 2 * buffer;
    const stay = s1.end - s1.start;
    let required;
    let basis;
    let capUnknown = false;
    if (stay <= H(params.short_stay_max_hours)) {
      required = Math.round(s1.flight * params.short_stay_factor);
      basis = `פי ${params.short_stay_factor} משעות הטיסה (${minToHhmm(s1.flight)})`;
    } else {
      const share = Math.round(stay * params.long_stay_share);
      required = Math.max(share, H(params.long_stay_min_hours));
      if (params.long_stay_max_hours != null) required = Math.min(required, H(params.long_stay_max_hours));
      else capUnknown = share > H(params.long_stay_min_hours);
      basis = `${params.long_stay_share * 100}% מהשהייה (${minToHhmm(stay)}), לפחות ${params.long_stay_min_hours} שעות`;
    }
    if (rest >= required) continue;

    const what = `${describePairing(p1)} → ${describePairing(p2)}: מנוחה בבסיס ${minToHhmm(Math.max(rest, 0))}, ` +
      `והמנוחה החוזית היא ${minToHhmm(required)} (${basis})`;
    if (capUnknown && rest >= H(params.long_stay_min_hours)) {
      ctx.review(`${what}. אין ב-rules.json תקרה למנוחה אחרי שהייה ארוכה (long_stay_max_hours), ולכן לא ידוע אם זו חריגה. דורש בדיקה ידנית.`, rule);
      continue;
    }

    const performed = ctx.hasExec ? performedAsPlanned(ctx, p2) && performedAsPlanned(ctx, p1) : null;
    if (ctx.hasExec && !performed) continue; // לא בוצע כמתוכנן: אין פיצוי על ויתור או על תכנון שגוי

    // הדוח כבר מזכה (מעבר למה שחוקים אחרים מסבירים): לא שואלים, והפיצוי נרשם כוויתור לבקשת החברה.
    const target = ctx.hasExec ? performedAsPlanned(ctx, p2) : p2;
    const own = ctx.rulesWithLogic('base_rest_shortfall').map((r) => r.id);
    const paid = ctx.hasExec &&
      ctx.reportedOn(target, params.report_column) - ctx.expectedOn(target, keyFor(params.report_column), own) >= H(params.hours);
    const id = `base_rest:${p2.id}`;
    const a = ctx.answer(id) ?? (paid ? { value: 'company_request' } : null);
    if (!a) {
      ctx.ask({
        id,
        date: p2.from,
        title: `מנוחה בבסיס קצרה מהחוזית לפני ${describePairing(p2)}`,
        body: `${what}. הפיצוי תלוי בסיבה, והיא אינה בקבצים. מה קרה?`,
        options: [
          { value: 'company_request', label: 'לבקשת החברה ובהסכמתי', hint: 'פיצוי לפי 2024 ס\' 35' },
          { value: 'planning_error', label: 'טעות בתכנון שלא תוקנה, והסכמתי לבצע', hint: 'פיצוי לפי ישן כ"ה ס\' 12.טו' },
          { value: 'my_request', label: 'ויתרתי על המנוחה בבקשות שלי', hint: 'אין פיצוי (2018 ס\' 61.1)' },
          { value: 'other', label: 'סיבה אחרת', needsText: true },
        ],
        ruleId: rule.id,
      });
      continue;
    }
    if (a.value === 'other') {
      ctx.review(`${what}. ${a.text || 'סיבה אחרת'}. דורש בדיקה ידנית.`, rule);
      continue;
    }
    if (a.value !== params.answer_value) continue;
    ctx.expectPairing(target, keyFor(params.report_column), H(params.hours), rule, what);
  }
}

// ---------- נחיתות לילה (2024 ס' 39–40) ----------

/**
 * טיסות בצי `fleet` שהנחיתה המתוכננת שלהן, בשעון ישראל, בין `window_from` ל-`window_to`.
 * כשתוכננו לפחות `min_planned_count` כאלה בחודש, מגיע פיצוי על כל טיסה כזאת שבוצעה, החל
 * מה-`paid_from_count`. ביטול או שינוי הצבה ביוזמת החברה נחשב ביצוע (ס' 40).
 * `base_landings_only`: רק נחיתות בבסיס. אחרת גם נחיתה בחו"ל, אחרי המרה לשעון ישראל.
 * `counted_crews`: הרכבי הצוות שנספרים (single = 2 טייסים, augmented = 3, double = 4). נשאל על כל טיסה.
 */
const CREW_LABEL = { single: 'בודד', augmented: 'מוגבר', double: 'כפול' };
const CREW_PILOTS = { single: 2, augmented: 3, double: 4 };

function night_landings(ctx, params, rule) {
  if (!ctx.hasPlan) {
    ctx.note(null, `${rule.title}: החוק נקבע לפי התכנון, ובלי קובץ תכנון הוא לא נבדק.`, rule);
    return;
  }
  const from = parseClock(params.window_from);
  const to = parseClock(params.window_to);
  const inWindow = (clock) => clock >= from && clock <= to;

  const night = [];
  const unsure = []; // נחיתה בחו"ל שאי אפשר להמיר לשעון ישראל, ושבטווח ההפרשים האפשרי עשויה להיות בחלון
  for (const p of ctx.planPairings) {
    for (const leg of p.legs) {
      if (leg.dh || !leg.arr) continue;
      if (params.base_landings_only && leg.dst !== ctx.domicile) continue;
      if (params.fleet && (leg.ac ?? ctx.fleet) !== params.fleet) continue;
      const clock = arrivalAtBaseClock(ctx, leg);
      if (clock == null) {
        const local = leg.arr.min;
        if ([-180, 0, 180].some((d) => inWindow(mod(local + d, 1440)))) unsure.push(leg);
        continue;
      }
      if (inWindow(clock)) night.push({ pairing: p, leg, clock });
    }
  }
  // נחיתה לא ודאית נשלחת לבדיקה רק כשהיא יכולה לשנות את התוצאה.
  if (unsure.length && night.length + unsure.length >= params.min_planned_count) {
    for (const leg of unsure) {
      ctx.review(`${ddmm(leg.date)} ${leg.flight}: הנחיתה ב-${leg.dst} היא ${minToHhmm(leg.arr.min)} שעון מקומי, והשדה לא בטבלת אזורי הזמן, כך שלא ידוע ההפרש לשעון ישראל. ` +
        `לא ניתן לדעת אם היא נחיתת לילה, וזה משנה את ${rule.title}. דורש בדיקה ידנית.`, rule);
    }
  }
  if (night.length < params.min_planned_count) return;

  // מה נחשב ביצוע: הטיסה בדוח, או ביטול ושינוי הצבה ביוזמת החברה (ס' 40). הסיבה נשאלת
  // במקום אחד בלבד, בשאלה על הסבב שלא בוצע, וכאן רק קוראים מה יצא ממנה.
  if (ctx.hasExec) {
    for (const n of night) {
      n.target = ctx.execPairings.find((e) => e.legs.some((l) => l.flight === n.leg.flight && l.type !== 'DHO' &&
        Math.abs(Date.parse(l.date) - Date.parse(n.leg.date)) <= dayMs)) ?? null;
      if (n.target) { n.status = 'done'; continue; }
      n.status = cancelStatus(ctx, n.pairing);
    }
  } else {
    for (const n of night) { n.target = n.pairing; n.status = 'done'; }
  }
  const threshold = params.paid_from_count;
  const key = keyFor(params.report_column);
  const hours = H(params.hours);
  const crews = params.counted_crews;
  const crewNames = crews ? crews.map((c) => CREW_LABEL[c] ?? c).join(' או ') : '';
  const crewOf = (n) => ctx.answer(`night_crew:${n.leg.date}:${n.leg.flight}`)?.value;

  // נספרות רק טיסות בהרכב צוות מ-`counted_crews` (2024 ס' 39–40: בודד או מוגבר). ההרכב אינו
  // בקבצים, ולכן מניחים תחילה שכל טיסה שלא נענתה נספרת: ההרכב יכול רק להוריד את המספר, וזאת
  // התוצאה הגבוהה האפשרית. רק אם תחתיה מגיע פיצוי שהדוח לא זיכה, נשאלת שאלה על הרכב הצוות
  // (החלטת בעל המוצר, 23/09/2026). מרגע שתוכננו `min_planned_count` טיסות כאלה, כל מסלול
  // מסתיים בהערה שמסבירה את המצב ואת הסיבה – גם כשאין פיצוי (בקשת בעל המוצר, 23/09/2026).
  const pool = crews ? night.filter((n) => crewOf(n) == null || crews.includes(crewOf(n))) : night;
  const names = (items) => items.map((n) => `${ddmm(n.leg.date)} ${n.leg.flight}`).join(', ');
  const list = (items) => items.map((n) => `${ddmm(n.leg.date)} ${n.leg.flight}${n.status === 'company' ? ' – שינוי ביוזמת החברה' : ''}`).join(', ');
  const planned = `תוכננו ${night.length} טיסות עם נחיתה בין ${params.window_from} ל-${params.window_to}`;
  if (pool.length < params.min_planned_count) {
    ctx.note(null, `${rule.title}: ${planned}, ואחרי התשובות על הרכב הצוות נספרות ${pool.length}` +
      `${pool.length ? ` (${list(pool)})` : ''}. המינימום הוא ${params.min_planned_count}, ולכן אין פיצוי.`, rule);
    return;
  }

  const counted = pool.filter((n) => n.status === 'done' || n.status === 'company');
  const unsettled = pool.filter((n) => n.status === 'unknown' || n.status === 'review');
  if (counted.length + unsettled.length < threshold) {
    const missed = pool.filter((n) => !counted.includes(n));
    ctx.note(null, `${rule.title}: ${planned}, נספרות כבוצעות: ${counted.length}${counted.length ? ` (${list(counted)})` : ''}` +
      `${missed.length ? `; לא בוצעו: ${list(missed)}` : ''}. הפיצוי הוא מהטיסה ה-${threshold} שבוצעה, ולכן אין פיצוי.`, rule);
    return;
  }
  // הספירה אינה סגורה כל עוד לא ידוע למה סבב לא בוצע. השאלה על כך כבר נשאלה בחוק הסבב
  // שלא בוצע, ולכן כאן לא שואלים שוב (החלטת בעל המוצר, 23/09/2026), אלא מסבירים במה זה תלוי.
  // גם על הרכב הצוות לא שואלים עד שהיא תיסגר: עד אז לא ידוע אם בכלל מגיע פיצוי.
  if (counted.length < threshold) {
    const why = `${rule.title}: נספרות כבוצעות ${counted.length} טיסות מתוך ${pool.length} מתוכננות עם נחיתה בין ` +
      `${params.window_from} ל-${params.window_to}, והפיצוי הוא מהטיסה ה-${threshold} שבוצעה`;
    const reviewed = unsettled.filter((x) => x.status === 'review');
    for (const n of reviewed) {
      ctx.review(`${ddmm(n.leg.date)} ${n.leg.flight} לא בוצעה, והסיבה שנרשמה עליה היא "סיבה אחרת", כך שלא ידוע אם זה היה ביוזמת ` +
        `החברה – ורק אז היא נספרת כבוצעה (ס' 40). ${why}. דורש בדיקה ידנית.`, rule);
    }
    const pending = unsettled.filter((x) => x.status === 'unknown');
    if (pending.length) {
      const many = pending.length > 1;
      ctx.note(null, `${why}. ${list(pending)} לא ${many ? 'בוצעו' : 'בוצעה'}, וביטול או שינוי הצבה ביוזמת החברה ` +
        `נחשב ביצוע (ס' 40). הספירה תיסגר לפי התשובה על ${many ? 'הסבבים שלא בוצעו' : 'הסבב שלא בוצע'}.`, rule);
    } else {
      const many = reviewed.length > 1;
      ctx.note(null, `${why}. ${list(reviewed)} לא ${many ? 'בוצעו' : 'בוצעה'}, והסיבה שנרשמה ` +
        `${many ? 'עליהן' : 'עליה'} היא "סיבה אחרת", ולכן לא ידוע אם ${many ? 'הן נספרות כבוצעות' : 'היא נספרת כבוצעה'} ` +
        `(ס' 40). הספירה תיסגר אחרי הבדיקה הידנית.`, rule);
    }
    return;
  }

  counted.sort((a, b) => a.leg.date.localeCompare(b.leg.date) || a.clock - b.clock);
  const paying = counted.slice(threshold - 1);
  const open = crews ? pool.filter((n) => crewOf(n) == null) : [];
  if (open.length) {
    const unpaid = paying.filter((n) => !(n.target ? ctx.paidOn(n.target, params.report_column, key, hours)
      : ctx.paidOnDate(n.pairing.from, params.report_column, key, hours)));
    if (!unpaid.length) {
      const one = paying.length === 1;
      ctx.note(null, `${rule.title}: ${planned}, והדוח מזכה ${minToHhmm(hours)} על ` +
        `${names(paying)}. לכן ${one ? 'היא בוצעה' : 'הן בוצעו'} בצוות ${crewNames}, ` +
        'ולא נשאלה שאלה על הרכב הצוות.', rule);
    } else {
      // שואלים אחת בכל פעם, מהטיסה הארוכה ביותר (בקשת בעל המוצר, 23/09/2026): תשובה שאינה
      // נספרת מורידה את המספר ומייתרת את השאר, והסיכוי לכך גדול יותר בטיסה ארוכה.
      const next = [...open].sort((a, b) => (plannedBlock(ctx, b.leg) ?? 0) - (plannedBlock(ctx, a.leg) ?? 0) ||
        a.leg.date.localeCompare(b.leg.date))[0];
      ctx.note(null, `${rule.title}: ${planned}. תחת ההנחה שכל טיסה שעדיין לא נענתה היא בצוות ` +
        `${crewNames}, מגיע פיצוי של ${minToHhmm(hours)}.`, rule);
      ctx.ask({
        id: `night_crew:${next.leg.date}:${next.leg.flight}`,
        date: next.leg.date,
        title: `נחיתת לילה: באיזה צוות מתוכננת ${next.leg.flight} ב-${ddmm(next.leg.date)} (נחיתה ${minToHhmm(next.clock)} שעון ישראל)?`,
        body: `${planned}. על מנת לחשב אם מגיע פיצוי נדרשת תשובה על הרכב הצוות בכל אחת מהטיסות.`,
        options: Object.entries(CREW_LABEL).map(([value, label]) => ({
          value, label: `${label} (${CREW_PILOTS[value]} טייסים)`, hint: crews.includes(value) ? 'נספרת' : 'לא נספרת',
        })),
        ruleId: rule.id,
      });
      return;
    }
  }

  // כשכל מה שתוכנן נספר כבוצע, מספר אחד מספיק לשניהם.
  const counts = counted.length === night.length
    ? `תוכננו ונספרות ${night.length} טיסות עם נחיתה בין ${params.window_from} ל-${params.window_to}`
    : `${planned}, ונספרות כבוצעות ${counted.length}`;
  ctx.note(null, `${rule.title}: ${counts} (${list(counted)}). הפיצוי הוא מהטיסה ה-${threshold} שבוצעה, ` +
    `ולכן מגיע פיצוי של ${minToHhmm(hours)} על ${names(paying)}.`, rule);
  paying.forEach((n) => {
    const why = `${ddmm(n.leg.date)} ${n.leg.flight}, נחיתה ${minToHhmm(n.clock)} שעון ישראל: הטיסה ה-${counted.indexOf(n) + 1} מתוך ` +
      `${night.length} מתוכננות עם נחיתת לילה`;
    if (n.target) ctx.expectPairing(n.target, key, hours, rule, why);
    else ctx.expect(n.pairing.from, key, hours, rule, `${why} (בוטלה ביוזמת החברה)`);
  });
}

/**
 * משך הטיסה המתוכנן של רגל: STA − STD, אחרי שכל צד מומר לשעון הבסיס. ה-`skdDur` של רגל
 * בתכנון אינו משמש כאן: הוא ה-FT של כל היום, שנרשם על הרגל האחרונה שבו.
 */
function plannedBlock(ctx, leg) {
  if (!leg.dep || !leg.arr) return null;
  const [o, d] = [offsetOf(ctx, leg.dep, leg.org, leg.date), offsetOf(ctx, leg.arr, leg.dst, leg.date)];
  return o == null || d == null ? null : mod(leg.arr.min - d - (leg.dep.min - o), 1440);
}

/** ההפרש בין שעון התחנה לשעון הבסיס: 0 בבסיס, מה שנלמד מהקבצים, ואחרת לפי אזור הזמן. */
function stationOffsetAt(ctx, station, date) {
  if (!station || station === ctx.domicile) return 0;
  const learned = ctx.stationOffsets?.[station];
  if (learned?.length) {
    return [...learned].sort((a, b) => Math.abs(Date.parse(a.date) - Date.parse(date)) - Math.abs(Date.parse(b.date) - Date.parse(date)))[0].off;
  }
  return stationOffset(station, date, ctx.domicile);
}

/** ההפרש של שעה בתכנון: שעה בלי ! היא כבר בשעון הבסיס. */
const offsetOf = (ctx, time, station, date) => (time.foreign ? stationOffsetAt(ctx, station, date) : 0);

/** שעת הנחיתה של רגל מתוכננת בשעון הבסיס, או null. */
function arrivalAtBaseClock(ctx, leg) {
  if (!leg.arr.foreign) return leg.arr.min;
  const learned = ctx.stationOffsets?.[leg.dst];
  if (learned?.length) {
    const closest = [...learned].sort((a, b) => Math.abs(Date.parse(a.date) - Date.parse(leg.date)) - Math.abs(Date.parse(b.date) - Date.parse(leg.date)))[0];
    return mod(leg.arr.min - closest.off, 1440);
  }
  // בלי הפרש מהתכנון: לומדים אותו מהדוח, מרגל מהבסיס לתחנה או ממנה בחזרה. בדוח STD ו-STA
  // מקומיים ו-SkdDur הוא המשך האמיתי, ולכן ההפרש יוצא מדויק.
  const found = [];
  for (const day of ctx.timeline) {
    for (const l of day.exec?.legs ?? []) {
      if (l.std == null || l.sta == null || l.skdDur == null) continue;
      if (l.org === ctx.domicile && l.dst === leg.dst) found.push({ date: day.date, off: mod(l.sta - l.std - l.skdDur + 720, 1440) - 720 });
      if (l.org === leg.dst && l.dst === ctx.domicile) found.push({ date: day.date, off: mod(l.std + l.skdDur - l.sta + 720, 1440) - 720 });
    }
  }
  if (!found.length) {
    // אין הפרש בקבצים: לפי אזור הזמן של השדה (LTN → לונדון), כולל שעון קיץ.
    const off = stationOffset(leg.dst, leg.date, ctx.domicile);
    return off == null ? null : mod(leg.arr.min - off, 1440);
  }
  const closest = found.sort((a, b) => Math.abs(Date.parse(a.date) - Date.parse(leg.date)) - Math.abs(Date.parse(b.date) - Date.parse(leg.date)))[0];
  return mod(leg.arr.min - closest.off, 1440);
}

/**
 * סבב מתוכנן שלא בוצע, לעניין ס' 40: ביטול או שינוי הצבה ביוזמת החברה נחשב ביצוע.
 * הסיבה נשאלת פעם אחת בלבד, בשאלה על הסבב שלא בוצע, שרצה לפני החוק הזה. הקריאה כאן היא
 * לפי הסימונים שהחוקים הקודמים שמו על הסבב, ולא לפי התשובה בלבד: כשהדוח כבר מזכה את
 * השעות שהפסיד לא נשאלת שאלה, והסבב מסומן `lost_hours_credit` (החלטת בעל המוצר, 23/09/2026).
 * `company` נספר כבוצע, `no` לא נספר, `review` נדרשת בדיקה ידנית, `unknown` השאלה עוד פתוחה.
 */
function cancelStatus(ctx, planPairing) {
  const m = ctx.matches.find((x) => x.plan === planPairing);
  if (!m) return 'unknown';
  if (m.byLeave) return 'no'; // היעדרות ומחלה אינן ביוזמת החברה
  if (m.how === 'replaced_by_ground') return 'company'; // החברה הציבה אותו לפעילות קרקע
  const by = (tag) => ctx.pairingHandledBy(planPairing, tag);
  if (by('lost_hours_credit') || by('cancelled_no_compensation')) return 'company';
  if (by('voluntary_swap')) return 'no';
  // גם בלי סימון, כשהחוק שמסמן אינו בתוקף בחודש: התשובה עצמה.
  const a = ctx.answerFor(m)?.value;
  if (a === 'voluntary_swap') return 'no';
  if (['cancelled', 'wet_lease', 'trainee', 'swap_777', 'replaced'].includes(a)) return 'company';
  if (a === 'other') return 'review';
  return 'unknown';
}

// ---------- פעילות בתאריכים מיוחדים (2024 ס' 42.1–42.5) ----------

/**
 * פעילות בחלון זמן סביב תאריך מסוים: ערב יום הזיכרון ויום הזיכרון, יום העצמאות, היום
 * הראשון ללימודים. התאריכים לכל שנה ב-`occasions[].dates`. חל גם על שהייה מחוץ לבסיס
 * (ס' 42.5), ולכן כל טווח הסבב נבדק, מההתייצבות ועד הנחיתה בבסיס. פיצוי נפרד לכל אירוע.
 *
 * `flight_activity_only`: רק פעילות טיסתית (יום הזיכרון והעצמאות). אחרת כל פעילות מטעם
 * החברה, וקוד פעילות בלי שעות (קרקע, סימולטור, כוננות) – שואלים.
 */
function special_date_activity(ctx, params, rule) {
  const report = params.report_minutes_before_std ?? 0;
  const key = keyFor(params.report_column);
  const monthStart = at(ctx.monthFirst, 0);
  const monthEnd = at(ctx.timeline.at(-1).date, 1440);
  const pairings = ctx.hasExec ? ctx.execPairings : ctx.planPairings;

  for (const occ of params.occasions ?? []) {
    const date = occ.dates?.[String(ctx.period.year)];
    if (!date) {
      if ((occ.months ?? []).includes(ctx.period.month)) {
        ctx.review(`${occ.title}: אין ב-rules.json תאריך לשנת ${ctx.period.year}, ולכן החוק לא נבדק. נדרש עדכון של קובץ החוקים.`, rule);
      }
      continue;
    }
    const wFrom = at(addDays(date, occ.from.day_offset), parseClock(occ.from.time));
    const wTo = at(addDays(date, occ.to.day_offset), parseClock(occ.to.time));
    if (wTo <= monthStart || wFrom >= monthEnd) continue;
    const window = `${ddmm(dateOf(wFrom))} ${hhmm(wFrom)} – ${ddmm(dateOf(wTo))} ${hhmm(wTo)}`;

    let hit = null;
    for (const p of pairings) {
      const s = ctx.hasExec ? execSpan(p, ctx.domicile, false) : planSpan(p, ctx.domicile, ctx.monthFirst);
      const start = s.start != null ? s.start - report : monthStart;
      const end = s.end ?? monthEnd;
      if (start < wTo && end > wFrom) { hit = p; break; }
    }
    if (hit) {
      ctx.expectPairing(hit, key, H(params.hours), rule, `${occ.title}: ${describePairing(hit)} בחלון ${window}`);
      continue;
    }
    if (params.flight_activity_only) continue;

    const days = ctx.timeline.filter((d) => d.date >= dateOf(wFrom) && d.date <= dateOf(wTo - 1));
    const coded = days.find((d) => ctx.activityCodes(d).length);
    if (!coded) continue;
    const id = `occasion:${rule.id}:${date}`;
    const answered = ctx.answer(id);
    const a = answered ?? (ctx.paidOnDate(coded.date, params.report_column, key, H(params.hours)) ? { value: 'yes' } : null);
    if (!a) {
      ctx.ask({
        id,
        date: coded.date,
        title: `${occ.title}: האם היית בפעילות מטעם החברה בין ${hhmm(wFrom)} ל-${hhmm(wTo)}?`,
        body: `ב-${ddmm(coded.date)} רשום ${ctx.activityCodes(coded).join(', ')}, אין בקבצים שעות לפעילות הזאת, והדוח לא מזכה עליה.`,
        options: [
          { value: 'yes', label: 'כן', hint: `${minToHhmm(H(params.hours))} – פער מול הדוח` },
          { value: 'no', label: 'לא', hint: 'אין פיצוי' },
        ],
        ruleId: rule.id,
      });
    } else if (a.value === 'yes') {
      ctx.expect(coded.date, key, H(params.hours), rule, `${occ.title}: ${ctx.activityCodes(coded).join(', ')} בחלון ${window} ` +
        `(${answered ? 'לפי תשובתך' : `הדוח מזכה את הפיצוי`})`);
    }
  }
}

// ---------- ימים ללא פעילות ושבתות (2018 ס' 71, 42.1; 2024 ס' 33–34, 40) ----------

/** טווחי הסבבים בזמן מוחלט. צד חתוך נמתח עד קצה הציר. */
function spansOf(ctx, pairings, spanOf) {
  return pairings.map((p) => {
    const s = spanOf(p);
    return { p, start: s.start ?? -Infinity, end: s.end ?? Infinity };
  });
}
const overlapsDay = (sp, date) => sp.start < at(date, 1440) && sp.end > at(date, 0);

/**
 * ימים ללא פעילות בתכנון (2018 ס' 71.1–71.2): יממה קלנדרית בלי פעילות. חופשה, מחלה מתוכננת,
 * DUM ו-X אינם פעילות. יום שיש בו רק Off block מ-`off_block_from` או רק On block בבסיס עד
 * `on_block_until` (כולל) נחשב פנוי. המינימום לפי הקרדיט המתוכנן (Sum בסיכום התכנון) והצי
 * (ס' 71.3, `min_free_days`). חסרים ימים – 2.5 ש' לכל יום מהיום השני (2024 ס' 33), אם
 * הוויתור היה לבקשת החברה. ויתור בבקשות (2018 ס' 61) אינו מזכה, ולכן שואלים.
 */
function free_days_waived(ctx, params, rule) {
  if (!ctx.hasPlan) return;
  const table = params.min_free_days?.[ctx.fleet];
  const credit = ctx.planSummary?.sum;
  if (!table || credit == null) {
    ctx.review(`${rule.title}: ${!table ? `אין ב-rules.json טבלת מינימום לצי ${ctx.fleet}` : 'לא נקרא הקרדיט המתוכנן (Sum) מסיכום התכנון'}, ולכן לא נבדק.`, rule);
    return;
  }
  const due = [...table].sort((a, b) => b.min_credit_hours - a.min_credit_hours).find((r) => credit >= H(r.min_credit_hours))?.days;
  if (due == null) return;
  const offFrom = parseClock(params.off_block_from);
  const onUntil = parseClock(params.on_block_until);
  const spans = spansOf(ctx, ctx.planPairings, (p) => planSpan(p, ctx.domicile, ctx.monthFirst));
  const free = ctx.timeline.filter((day) => {
    if (ctx.planActivityCodes(day).length) return false;
    const d0 = at(day.date, 0);
    return !spans.some((sp) => overlapsDay(sp, day.date) &&
      !(sp.start >= d0 + offFrom && sp.end >= d0 + 1440) && !(sp.start < d0 && sp.end <= d0 + onUntil));
  }).map((d) => d.date);

  // X ב-1 לחודש בלי טיסה ביום: ייתכן שזו נחיתה של סבב מהחודש הקודם, שאינו בתכנון. עד התשובה
  // היום לא נספר. שואלים רק כשהתשובה יכולה להוריד את מספר הימים מתחת למינימום (החלטת בעל
  // המוצר, 23/09/2026), גם כשחסר יום אחד בלבד ולא מגיע עליו זיכוי: המספר עצמו צריך להיות נכון.
  const first = ctx.timeline.find((d) => d.date === ctx.monthFirst);
  let pendingFirst = false;
  if (free.includes(ctx.monthFirst) && (first?.plan?.codes ?? []).includes('X')) {
    const fid = `free_days_first:${ctx.monthFirst.slice(0, 7)}`;
    const fa = ctx.answer(fid);
    if (fa?.value !== 'free') free.splice(free.indexOf(ctx.monthFirst), 1);
    if (!fa && free.length >= due) {
      // גם בלי היום יש מספיק ימים: התשובה לא תשנה דבר, ואין על מה לשאול.
      ctx.note(ctx.monthFirst, `${rule.title}: ב-${ddmm(ctx.monthFirst)} מסומן X, וייתכן שנחתת בו מסבב של החודש הקודם, שאינו בתכנון, ` +
        `ולכן הוא אינו נספר. גם בלעדיו יש ${free.length} ימים ללא פעילות מול מינימום ${due}, ולכן אין צורך לשאול.`, rule);
    } else if (!fa) {
      pendingFirst = true;
      ctx.ask({
        id: fid,
        date: ctx.monthFirst,
        title: `ימים ללא פעילות: ב-${ddmm(ctx.monthFirst)} מסומן X. האם נחתת בו מסבב של החודש הקודם?`,
        body: `X ב-1 לחודש מופיע גם כשסבב מהחודש הקודם נוחת בו, והנחיתה אינה בתכנון. יום עם נחיתה בבסיס עד ${params.on_block_until} נחשב פנוי. ` +
          `בלעדיו יש ${free.length} ימים ללא פעילות, והמינימום הוא ${due}.`,
        options: [
          { value: 'free', label: `לא נחתתי בו, או שנחתתי עד ${params.on_block_until}`, hint: 'יום פנוי' },
          { value: 'busy', label: `נחתתי אחרי ${params.on_block_until}`, hint: 'לא יום פנוי' },
        ],
        ruleId: rule.id,
      });
    }
  }

  ctx.setFreeDays({ free: free.length, due, dates: free });
  const missing = due - free.length;
  if (missing <= 0) return;
  const paidDays = missing - (params.paid_from_day - 1);
  const what = `בתכנון ${free.length} ימים ללא פעילות` +
    (pendingFirst ? ` (${free.length + 1} אם ב-${ddmm(ctx.monthFirst)} לא נחתת)` : '') +
    `, והמינימום לקרדיט מתוכנן ${minToHhmm(credit)} הוא ${due}`;
  if (paidDays <= 0) {
    ctx.note(null, `${what}. ${pendingFirst ? 'גם אם נחתת, חסר יום אחד בלבד' : 'חסר יום אחד'}, ` +
      `והפיצוי ניתן רק מ-${params.paid_from_day} ימים חסרים ומעלה, ולכן לא מגיע זיכוי.`, rule);
    return;
  }
  const id = `free_days:${ctx.monthFirst.slice(0, 7)}`;
  const key = keyFor(params.report_column);
  // הדוח כבר מזכה ביום הראשון בחודש: לא שואלים.
  const paid = ctx.hasExec &&
    ctx.reportedOnDate(ctx.monthFirst, params.report_column) - ctx.expectedOnDate(ctx.monthFirst, key) >= paidDays * H(params.hours);
  const a = ctx.answer(id) ?? (paid ? { value: 'company' } : null);
  if (!a) {
    ctx.ask({
      id,
      date: ctx.monthFirst,
      title: `ימים ללא פעילות: חסרים ${missing}. האם הוויתור היה לבקשת החברה?`,
      body: `${what}. הימים הפנויים: ${free.map(ddmm).join(', ')}.`,
      options: [
        { value: 'company', label: 'לבקשת החברה ובהסכמתי', hint: minToHhmm(paidDays * H(params.hours)) },
        { value: 'own', label: 'ויתרתי בבקשות שלי', hint: 'אין פיצוי' },
      ],
      ruleId: rule.id,
    });
  } else if (a.value === 'company') {
    ctx.expect(ctx.monthFirst, key, paidDays * H(params.hours), rule,
      `${what}: ${missing} ימים חסרים, פיצוי על ${paidDays} (מהיום השני)`);
  }
}

/**
 * שתי שבתות ברצף (2024 ס' 34): פעילות טיסתית בשתי שבתות עוקבות. חלון השבת קבוע בשעון
 * ישראל, משישי `shabbat_from` עד שבת `shabbat_to` (החלטת בעל המוצר, 23/09/2026). שבת עם
 * פעילות = סבב שחופף לחלון: טיסה בתוך החלון, או יציאה לפניו וחזרה לארץ אחריו (טיסה חוצת
 * שבת). פעילות קרקע בשבת, כמו לימוד עצמי בבית, אינה נספרת. לפי הביצוע כשיש; סבב מתוכנן
 * שבוטל ביוזמת החברה נחשב ביצוע (ס' 40). בלי שאלת הסכמה (החלטת בעל המוצר, 21/09/2026).
 * שלוש שבתות ברצף הן שני זוגות.
 */
function consecutive_saturdays(ctx, params, rule) {
  const key = keyFor(params.report_column);
  const planSpans = ctx.hasPlan ? spansOf(ctx, ctx.planPairings, (p) => planSpan(p, ctx.domicile, ctx.monthFirst)) : [];
  const execSpans = ctx.hasExec ? spansOf(ctx, ctx.execPairings, (p) => execSpan(p, ctx.domicile, false)) : [];
  const inShabbat = (sp, date) =>
    sp.start < at(date, parseClock(params.shabbat_to)) && sp.end > at(addDays(date, -1), parseClock(params.shabbat_from));
  const active = (date) => {
    if (!ctx.hasExec) {
      const sp = planSpans.find((s) => inShabbat(s, date));
      return sp ? { pairing: sp.p } : null;
    }
    const sp = execSpans.find((s) => inShabbat(s, date));
    if (sp) return { pairing: sp.p };
    const cancelled = planSpans.find((s) => inShabbat(s, date) && cancelStatus(ctx, s.p) === 'company');
    return cancelled ? { date, cancelled: cancelled.p } : null;
  };

  const saturdays = ctx.timeline.filter((d) => new Date(d.date).getUTCDay() === 6).map((d) => d.date);
  for (let i = 1; i < saturdays.length; i++) {
    const [s1, s2] = [saturdays[i - 1], saturdays[i]];
    const [a1, a2] = [active(s1), active(s2)];
    if (!a1 || !a2) continue;
    const why = `${rule.title}: פעילות בשבתות ${ddmm(s1)} ו-${ddmm(s2)}${a2.cancelled ? ' (בשבת השנייה סבב שבוטל ביוזמת החברה)' : ''}`;
    if (a2.pairing) ctx.expectPairing(a2.pairing, key, H(params.hours), rule, why);
    else ctx.expect(s2, key, H(params.hours), rule, why);
  }
}

// ---------- יותר משתי טיסות סבב לילה עוקבות (2024 ס' 37, 40) ----------

/**
 * טיסת סבב לילה: טיסת סבב שה-FDP שלה (מההתייצבות ועד On block בבסיס) חופף לחלון
 * `window_from`–`window_to` בשעון ישראל (02:00–05:00, לסעיף הזה בלבד; החלטת בעל המוצר,
 * 22/09/2026). רצף = לילות בתאריכים עוקבים, בלי יום פנוי ביניהם. רצף של יותר מ-
 * `more_than` לילות מזכה `hours` פעם אחת, על הלילה ה-(`more_than`+1).
 *
 * לפי התכנון. עם דוח ביצוע, לילה מתוכנן נספר אם בוצעה בו טיסת סבב לילה (גם אחרת, כמו
 * זכייה במכרז על טיסה דומה) או שהסבב בוטל ביוזמת החברה (ס' 40). ההסכמה מונחת; שואלים
 * אם התכנון היה לבקשת החברה רק כשהדוח לא מזכה. רצף מהחודש הקודם אינו נראה ואינו נשאל.
 */
function consecutive_night_rounds(ctx, params, rule) {
  if (!ctx.hasPlan) return;
  const report = params.report_minutes_before_std ?? 0;
  const legal = H(params.legal_rest_hours);
  const from = parseClock(params.window_from);
  const to = parseClock(params.window_to);
  const key = keyFor(params.report_column);
  const nightsOf = (s) => {
    if (s.start == null || s.end == null || !isTurnaround(s, legal)) return [];
    const d0 = dateOf(s.start - report);
    return [d0, addDays(d0, 1)].filter((d) => s.start - report < at(d, to) && s.end > at(d, from));
  };

  const planned = new Map(); // לילה → סבב מתוכנן
  for (const p of planPairingsSorted(ctx)) {
    for (const d of nightsOf(planSpan(p, ctx.domicile, ctx.monthFirst))) if (!planned.has(d)) planned.set(d, p);
  }
  const performed = new Map(); // לילה → סבב ביצוע
  if (ctx.hasExec) {
    for (const e of ctx.execPairings) {
      for (const d of nightsOf(execSpan(e, ctx.domicile, true))) if (!performed.has(d)) performed.set(d, e);
    }
  }
  // done / company / no / unknown
  const statusOf = (d) => {
    if (!ctx.hasExec || performed.has(d)) return 'done';
    const st = cancelStatus(ctx, planned.get(d));
    return st === 'review' ? 'unknown' : st; // הבדיקה הידנית על הרצף מכסה גם את זה
  };

  const nights = [...planned.keys()].sort();
  const runs = [];
  for (const d of nights) {
    const last = runs.at(-1);
    if (last && addDays(last.at(-1), 1) === d) last.push(d);
    else runs.push([d]);
  }

  for (const run of runs) {
    if (run.length <= params.more_than) continue;
    const list = run.map(ddmm).join(', ');
    const statuses = run.map(statusOf);
    const what = `${rule.title}: ${run.length} טיסות סבב לילה מתוכננות בלילות ${list}`;
    const counted = run.filter((d, i) => statuses[i] === 'done' || statuses[i] === 'company');
    const open = run.filter((d, i) => statuses[i] === 'unknown');
    if (counted.length < run.length) {
      if (counted.length + open.length <= params.more_than) {
        ctx.note(run[0], `${what}, אבל רק ${counted.length} מהן בוצעו או בוטלו ביוזמת החברה, ולכן אין פיצוי.`, rule);
      } else if (open.length) {
        ctx.review(`${what}. לא ידוע אם ${open.map((d) => describePairing(planned.get(d))).join(', ')} בוטלה ביוזמת החברה, ` +
          'וזה קובע אם הרצף נחשב בוצע (2024 ס\' 40). דורש בדיקה ידנית.', rule);
      } else {
        ctx.review(`${what}, אבל לא כל הרצף בוצע (בוצעו או בוטלו ביוזמת החברה: ${counted.map(ddmm).join(', ')}). דורש בדיקה ידנית.`, rule);
      }
      continue;
    }

    const payNight = run[params.more_than];
    // כשהדוח כבר מזכה על אחד הלילות ברצף, הצפוי נרשם שם.
    const paid = ctx.hasExec ? run.map((d) => performed.get(d)).find((p) =>
      p && ctx.reportedOn(p, params.report_column) - ctx.expectedOn(p, key) >= H(params.hours)) : null;
    const target = paid ?? (ctx.hasExec ? performed.get(payNight) : planned.get(payNight));
    const why = `${what}${statuses.includes('company') ? ' (חלקן בוטלו ביוזמת החברה)' : ''}`;
    if (ctx.hasExec) {
      if (!paid) {
        const id = `night_rounds:${run[0]}`;
        const a = ctx.answer(id);
        if (!a) {
          ctx.ask({
            id,
            date: target ? target.from : payNight,
            title: `${run.length} טיסות סבב לילה עוקבות (${list}): האם התכנון היה לבקשת החברה?`,
            body: `${what}. על יותר משתי טיסות כאלה ברצף מגיע פיצוי, והדוח לא מזכה אותו. הפיצוי רק כשהרצף תוכנן לבקשת החברה.`,
            options: [
              { value: 'company', label: 'לבקשת החברה', hint: minToHhmm(H(params.hours)) },
              { value: 'mine', label: 'לבקשתי (בקשות או מכרז)', hint: 'אין פיצוי' },
            ],
            ruleId: rule.id,
          });
          continue;
        }
        if (a.value !== 'company') {
          ctx.note(run[0], `${what}. לבקשתך, לפי תשובתך: אין פיצוי.`, rule);
          continue;
        }
      }
    }
    if (target) ctx.expectPairing(target, key, H(params.hours), rule, why);
    else ctx.expect(payNight, key, H(params.hours), rule, `${why} (הסבב בלילה ${ddmm(payNight)} בוטל ביוזמת החברה)`);
  }
}

// ---------- טיסה לבנה (2018 הגדרות, ס' 27.4) ----------

/**
 * טיסה לבנה: יוצאת מהבסיס, בצוות מוגבר, ההתייצבות המתוכננת (STD פחות `report_minutes_before_std`,
 * 90 דק' בצי רחב גוף, 2018 ס' 52.2) אחרי `report_after` ועד `report_until`, ובלוק מקובע ארוך
 * מ-`min_block_hours`. הרכב הצוות אינו בקבצים, ולכן שואלים: 3 טייסים ומעלה נחשבים צוות מוגבר,
 * גם כשאחד מ-4 עוד לא מוגדר קברניט או קצין ראשון (החלטת בעל המוצר, 21/09/2026).
 */
function white_flight(ctx, params, rule) {
  const report = params.report_minutes_before_std ?? 0;
  const key = keyFor(params.report_column);
  const from = parseClock(params.report_after);
  const to = parseClock(params.report_until);
  const inWindow = (c) => (from < to ? c > from && c <= to : c > from || c <= to);
  const pairings = ctx.hasExec ? ctx.execPairings : ctx.planPairings;
  const own = ctx.rulesWithLogic('white_flight').map((r) => r.id);

  for (const p of pairings) {
    for (const l of p.legs) {
      const dh = ctx.hasExec ? l.dhd || l.type === 'DHO' : l.dh;
      const std = ctx.hasExec ? l.std : l.dep && !l.dep.foreign ? l.dep.min : null;
      if (dh || l.org !== ctx.domicile || std == null) continue;
      const reportAt = at(l.date, std) - report;
      if (!inWindow(clockOf(reportAt))) continue;
      const block = ctx.hasExec ? l.skdDur : planBlock(l);
      if (block == null) {
        ctx.review(`${rule.title}: אין משך מתוכנן ל-${l.flight} ${l.org}→${l.dst} ב-${ddmm(l.date)} (השדה אינו בטבלת אזורי הזמן), ולכן לא נבדק אם היא ארוכה מ-${params.min_block_hours} שעות.`, rule);
        continue;
      }
      if (block <= H(params.min_block_hours)) continue;

      const what = `${l.flight} ${l.org}→${l.dst} ב-${ddmm(l.date)}, התייצבות ${hhmm(reportAt)}, בלוק ${minToHhmm(block)}`;
      const id = `white:${l.date}:${l.flight}`;
      const answered = ctx.answer(id);
      const a = answered ?? (ctx.paidOn(p, params.report_column, key, H(params.hours), own) ? { value: 'yes' } : null);
      if (!a) {
        ctx.ask({
          id,
          date: l.date,
          title: `טיסה לבנה: האם ${l.flight} ב-${ddmm(l.date)} בוצעה בצוות מוגבר?`,
          body: `${what}. הדוח לא מזכה עליה, והיא טיסה לבנה רק אם הצוות היה מוגבר: 3 טייסים ומעלה, ` +
            'גם 4 כשאחד מהם עוד לא מוגדר קברניט או קצין ראשון.',
          options: [
            { value: 'yes', label: 'כן, צוות מוגבר (3 טייסים או יותר)', hint: `${minToHhmm(H(params.hours))} – פער מול הדוח` },
            { value: 'no', label: 'לא', hint: 'אין פיצוי' },
          ],
          ruleId: rule.id,
        });
      } else if (a.value === 'yes') {
        ctx.expectPairing(p, key, H(params.hours), rule,
          `${rule.title}: ${what} (${answered ? 'צוות מוגבר לפי תשובתך' : `הדוח מזכה את הפיצוי, ולכן צוות מוגבר`})`);
      }
    }
  }
}

// ---------- טיסות ULH (2026 ס' 21) ----------

/**
 * טיסת ULH: צוות כפול שתוכנן וביצע טיסה ישירה שזמן הבלוק שלה גדול מ-`min_block_hours`
 * ועד `max_block_hours` זכאי ל-`hours` (2026 ס' 21.2). אין מדרגה מעל 19 שעות: זו תקרת
 * התכנון שבס' 21.1, ולא סף פיצוי נוסף.
 *
 * הרכב הצוות אינו בקבצים ואינו נשאל, בשונה מטיסה לבנה: לפי ס' 21.1 אישור רת"א לטיסות
 * האלה מבוקש לטיסה ישירה בצוות כפול בלי עצירת ביניים, ולכן רגל אחת עם בלוק כזה היא
 * צוות כפול (החלטת בעל המוצר, 23/09/2026). ס' 21.2 אינו מגביל לפי סוג מטוס, ובדוח
 * הביצוע ממילא אין סוג מטוס, ולכן אין סינון 787.
 *
 * הבלוק הוא המתוכנן: SkdDur בדוח, ו-STA − STD בקובץ התכנון (החלטת בעל המוצר,
 * 23/09/2026). "ביצע" = הרגל בדוח ואינה DH. "תוכנן" = אותה טיסה נמצאת גם בסבב המתוכנן
 * שהותאם לה; טיסה כזו שלא תוכננה יוצאת לבדיקה ידנית ולא מדולגת בשקט.
 */
function ulh_flight(ctx, params, rule) {
  const key = keyFor(params.report_column);
  const min = H(params.min_block_hours);
  const max = H(params.max_block_hours);
  const entries = ctx.hasExec
    ? ctx.matches.filter((m) => m.exec).map((m) => ({ pairing: m.exec, plan: m.plan }))
    : ctx.planPairings.map((p) => ({ pairing: p, plan: p }));

  for (const { pairing, plan } of entries) {
    for (const l of pairing.legs) {
      if (ctx.hasExec ? l.dhd || l.type === 'DHO' : l.dh) continue;
      const block = ctx.hasExec ? l.skdDur : planBlock(l);
      if (block == null || block <= min || block > max) continue;

      const what = `${l.flight ?? ''} ${l.org}→${l.dst} ב-${ddmm(l.date)}, בלוק ${minToHhmm(block)}`.trim();
      const planned = !ctx.hasExec ||
        (plan?.legs ?? []).some((p) => !p.dh && (l.flight ? p.flight === l.flight : p.org === l.org && p.dst === l.dst));
      if (!planned) {
        ctx.review(`${rule.title}: ${what} אינה בתכנון. ס' 21.2 מזכה צוות כפול "אשר תוכנן וביצע", ולכן צריך לבדוק ידנית אם מגיע ${amountWord(params.report_column)}.`, rule);
        continue;
      }
      ctx.expectPairingDay(pairing, l.date, key, H(params.hours), rule, `${rule.title}: ${what} (צוות כפול)`);
    }
  }
}

// ---------- הארכת שהייה (ישן כ"ה ס' 10.א(5), 10.ב) ----------

/**
 * סבב שחזר לבסיס יותר מ-`over_hours` אחרי הנחיתה המתוכננת. הסיבה אינה בקבצים, ולכן שואלים:
 * - `voluntary` – מרצון, אין פיצוי.
 * - `force_majeure` – אירוע שאינו בשליטת החברה (ס' 10.ב): קריאה מיוחדת ל-48 השעות הראשונות,
 *   כלומר `capped_days` יממות × `hours`. גם אש"ל לכל התקופה ובלי זיכוי שהייה – הערה בלבד.
 * - `company` – פיצוי על כל יממה לא מתוכננת (פרשנות בעל המוצר, 22/09/2026): מהיום שאחרי
 *   יום החזרה המתוכנן ועד יום החזרה בפועל, בשעון הבסיס, `hours` לכל יממה.
 * הסבב מסומן, כדי שחוק הקריאה המיוחדת לא יספור אותו כולו כקריאה מיוחדת.
 */
function stay_extension(ctx, params, rule) {
  if (!ctx.hasPlan || !ctx.hasExec) return;
  const key = keyFor(params.report_column);
  const own = ctx.rulesWithLogic('stay_extension').map((r) => r.id);
  for (const m of ctx.matches) {
    if (!m.plan || !m.exec) continue;
    const planned = planSpan(m.plan, ctx.domicile, ctx.monthFirst).end;
    const actual = execSpan(m.exec, ctx.domicile, false).end;
    if (planned == null || actual == null || actual - planned <= H(params.over_hours)) continue;

    ctx.markPairing(m.exec, 'stay_extension');
    const what = `${describePairing(m.exec)}: החזרה לבסיס ב-${ddmm(dateOf(actual))} ${hhmm(actual)}, ` +
      `${minToHhmm(actual - planned)} שעות אחרי המתוכנן (${ddmm(dateOf(planned))} ${hhmm(planned)})`;
    const unplanned = [];
    for (let d = addDays(dateOf(planned), 1); d <= dateOf(actual); d = addDays(d, 1)) unplanned.push(d);
    const id = `stay_extension:${m.exec.id}`;
    const answered = ctx.answer(id);
    // הדוח כבר מזכה את הסכום הגבוה שאפשרי כאן: אין פער, ולא שואלים.
    const a = answered ?? (ctx.paidOn(m.exec, params.report_column, key, unplanned.length * H(params.hours), own) ? { value: 'company' } : null);
    if (!a) {
      ctx.ask({
        id,
        date: m.exec.from,
        title: `חזרה מאוחרת לבסיס: ${describePairing(m.exec)}`,
        body: `${what}. הדוח לא מזכה עליה, והפיצוי תלוי בסיבה, שאינה בקבצים. מה קרה?`,
        options: [
          { value: 'voluntary', label: 'החזרה המאוחרת מרצונך', hint: 'ללא פיצוי' },
          { value: 'force_majeure', label: 'העיכוב מאירוע שלא בשליטת החברה', hint: `מגיע פיצוי רק על ${params.over_hours} שעות` },
          { value: 'company', label: 'מגיע פיצוי על כל הימים הלא מתוכננים' },
        ],
        ruleId: rule.id,
      });
      continue;
    }
    if (a.value === 'voluntary') {
      ctx.note(dateOf(actual), `${what}. מרצונך, לפי תשובתך: אין פיצוי.`, rule);
    } else if (a.value === 'force_majeure') {
      ctx.expectPairing(m.exec, key, params.capped_days * H(params.hours), rule,
        `${what}. אירוע שלא בשליטת החברה, לפי תשובתך: קריאה מיוחדת על ${params.over_hours} השעות הראשונות ` +
        `(${params.capped_days} יממות). מגיע גם אש"ל לכל התקופה, ובתקופה הזאת אין זיכוי שהייה בחו"ל.`);
    } else if (a.value === 'company') {
      ctx.expectPairing(m.exec, key, unplanned.length * H(params.hours), rule,
        `${what}. ${unplanned.length === 1 ? 'יממה לא מתוכננת' : `${unplanned.length} יממות לא מתוכננות`} ` +
        `(${unplanned.map(ddmm).join(', ')}), ${answered ? 'לפי תשובתך' : `לפי מה שהדוח מזכה`}.`);
    }
  }
}


// ---------- מיאמי (2026 ס' 24) ----------

/**
 * זמני רגל בזמן מוחלט בשעון הבסיס. הרגל רשומה ביום ההמראה בשעון הבסיס, בתכנון ובדוח
 * כאחד, והשעות עצמן מקומיות לתחנה (בתכנון עם !). `actual` – לפי ATD ומשך בפועל כשיש.
 */
function legTimes(ctx, leg, actual) {
  const off = stationOffsetAt(ctx, leg.org, leg.date);
  if (off == null) return null;
  const abs = (clock) => at(leg.date, mod(clock - off, 1440));
  if (leg.dep || leg.arr) { // רגל תכנון
    const block = plannedBlock(ctx, leg);
    if (block == null) return null;
    const dep = abs(leg.dep.min);
    return { dep, arr: dep + block };
  }
  if (leg.std == null || leg.skdDur == null) return null;
  const dep = abs(leg.std);
  if (!actual || leg.atd == null) return { dep, arr: dep + leg.skdDur };
  // המראה בפועל שנראית מוקדמת מה-STD היא ביום שאחרי.
  const real = dep - abs(leg.atd) > 720 ? abs(leg.atd) + 1440 : abs(leg.atd);
  return { dep: real, arr: real + (leg.actDur ?? leg.skdDur) };
}

/**
 * שהייה בתחנה בתוך סבב: מהנחיתה בה ועד ההתייצבות לרגל שיוצאת ממנה. שעת ההתייצבות אינה
 * בקבצים, ונגזרת מ-STD פחות `report_minutes_before_std`. מוחזרים גם הזמנים בשעון התחנה,
 * כי חלון הלילה של ס' 24.3 הוא מקומי. רגל DH נספרת גם היא: הצוות שוהה בתחנה בכל מקרה.
 */
function stationStay(ctx, pairing, params, actual) {
  const legs = pairing.legs;
  for (let i = 0; i < legs.length - 1; i++) {
    const [inLeg, outLeg] = [legs[i], legs[i + 1]];
    if (inLeg.dst !== params.station || outLeg.org !== params.station) continue;
    const [a, b] = [legTimes(ctx, inLeg, actual), legTimes(ctx, outLeg, false)];
    const off = stationOffsetAt(ctx, params.station, inLeg.date);
    if (!a || !b || off == null) return null;
    const pickup = b.dep - (params.report_minutes_before_std ?? 0);
    if (pickup <= a.arr) return null;
    return { inLeg, outLeg, arr: a.arr, pickup, localArr: a.arr + off, localPickup: pickup + off };
  }
  return null;
}

/**
 * מספר הלילות שהשהייה חופפת להם. לילה = `from`–`to` בשעון התחנה, ונגיעה בקצה אינה נספרת,
 * לפי הדוגמה שבס' 24.3: נחיתה ב-05:00 ופיקאפ למחרת ב-23:00 הם לילה אחד.
 */
function nightsIn(from, to, startLocal, endLocal) {
  const span = from < to ? to - from : 1440 - from + to;
  let count = 0;
  for (let d = Math.floor(startLocal / 1440) - 1; d <= Math.floor(endLocal / 1440); d++) {
    const s = d * 1440 + from;
    if (Math.min(endLocal, s + span) - Math.max(startLocal, s) > 0) count++;
  }
  return count;
}

const stayLine = (p, stay, params) =>
  `${describePairing(p)}: נחיתה ב-${params.station} ${ddmm(dateOf(stay.localArr))} ${hhmm(stay.localArr)} והתייצבות ` +
  `${ddmm(dateOf(stay.localPickup))} ${hhmm(stay.localPickup)} (שעון ${params.station}), שהייה ${minToHhmm(stay.pickup - stay.arr)}`;

/**
 * קיצור מנוחה במיאמי (2026 ס' 24.1–24.3): `hours` שעות בכל מקרה שבו הצוות שהה בתחנה
 * `max_nights` לילה בלבד. "יום אחר יום באמצע השבוע" (ס' 24.1) הוא תנאי לתכנון ולא לפיצוי
 * ("בכל מקרה" בס' 24.3), ולכן אין סינון לפי יום בשבוע. הספירה עצמה בקבצים, ורק שעת
 * ההתייצבות נגזרת, ולכן כשיש דוח שלא זיכה שואלים לאישור (החלטת בעל המוצר, 23/09/2026).
 * סבב שנקבע בו לילה אחד מסומן `miami_one_night`, וחוקי הדחייה של ס' 24.4 נשענים עליו.
 */
function short_rest_miami(ctx, params, rule) {
  const key = keyFor(params.report_column);
  const hours = H(params.hours);
  const from = parseClock(params.night_from);
  const to = parseClock(params.night_to);
  const own = ctx.rulesWithLogic('short_rest_miami').map((r) => r.id);
  const window = `בין ${params.night_from} ל-${params.night_to}`;
  for (const p of ctx.hasExec ? ctx.execPairings : ctx.planPairings) {
    const stay = stationStay(ctx, p, params, ctx.hasExec);
    if (!stay) continue;
    const what = stayLine(p, stay, params);
    const nights = nightsIn(from, to, stay.localArr, stay.localPickup);
    if (nights !== params.max_nights) {
      ctx.note(p.from, `${rule.title}: ${what}, כלומר ${nights} לילות ${window}. הפיצוי ניתן רק על ` +
        `${params.max_nights} לילה בלבד, ולכן אין פיצוי.`, rule);
      continue;
    }
    const derived = `שעת ההתייצבות אינה בקבצים ונגזרת מ-STD פחות ${params.report_minutes_before_std} דק'.`;
    const why = `${what}, ולכן לילה אחד בלבד ${window}`;
    if (!ctx.hasExec) {
      ctx.markPairing(p, 'miami_one_night');
      ctx.expectPairing(p, key, hours, rule, `${why}. ${derived}`);
      continue;
    }
    const id = `miami_short_rest:${p.id}`;
    const answered = ctx.answer(id);
    const a = answered ?? (ctx.paidOn(p, params.report_column, key, hours, own) ? { value: 'yes' } : null);
    if (a?.value === 'no') {
      ctx.note(p.from, `${rule.title}: ${what}. לפי תשובתך שהית שם יותר מלילה אחד, ולכן אין פיצוי.`, rule);
      continue;
    }
    if (!a) {
      ctx.ask({
        id,
        date: p.from,
        title: `קיצור מנוחה ב-${params.station}: האם שהית שם לילה אחד בלבד?`,
        body: `${what}. לפי החישוב זה לילה אחד ${window}, והדוח לא מזכה ${minToHhmm(hours)}. ${derived}`,
        options: [
          { value: 'yes', label: 'כן, לילה אחד בלבד', hint: `${minToHhmm(hours)} – פער מול הדוח` },
          { value: 'no', label: 'לא, יותר מלילה אחד', hint: 'אין פיצוי' },
        ],
        ruleId: rule.id,
      });
      continue;
    }
    ctx.markPairing(p, 'miami_one_night');
    ctx.expectPairing(p, key, hours, rule,
      `${why} (${answered ? 'לפי תשובתך' : `לפי מה שהדוח מזכה`})`);
  }
}

/** הדחייה בהמראה מהבסיס: מה-STD המתוכנן ועד ה-ATD בפועל, וכך גם הזזה של לוח הזמנים נכללת. */
function outboundDelay(ctx, execPairing, leg) {
  if (leg.atd == null) return null;
  const [actual, scheduled] = [legTimes(ctx, leg, true), legTimes(ctx, leg, false)];
  if (!actual || !scheduled) return null;
  const planLeg = ctx.matches.find((m) => m.exec === execPairing)?.plan?.legs
    .find((l) => l.flight === leg.flight && l.dst === leg.dst && Math.abs(Date.parse(l.date) - Date.parse(leg.date)) <= dayMs);
  const planned = planLeg ? legTimes(ctx, planLeg, false) : null;
  return actual.dep - (planned?.dep ?? scheduled.dep);
}

const PHASE_LABEL = {
  before_duty: 'לפני תחילת זמן התפקיד',
  after_duty: 'אחרי שזמן התפקיד כבר החל',
};

/**
 * דחיית הטיסה ביציאה מהארץ (2026 ס' 24.4), בנוסף לקיצור המנוחה של ס' 24.3: דחייה של מעל
 * `min_delay_hours` שחלה לפני תחילת זמן התפקיד (`phase` = before_duty), או דחייה של
 * `min_delay_hours` ומעלה בהמראה אחרי שזמן התפקיד כבר החל (after_duty). שני המצבים אינם
 * יכולים לחול יחד, ולכן שני החוקים חולקים שאלה אחת (`miami_delay:`), והתשובה בוחרת מי מהם
 * חל (בקשת בעל המוצר, 23/09/2026). קיומה של דחייה נלמד מהקבצים, ומניחים שמגיע עליה פיצוי;
 * שואלים רק כשהדוח לא זיכה.
 */
function miami_delay(ctx, params, rule) {
  if (!ctx.hasExec) return;
  const key = keyFor(params.report_column);
  const hours = H(params.hours);
  const own = ctx.rulesWithLogic('miami_delay').map((r) => r.id);
  const enough = (pr, delay) => (pr.min_delay_exclusive ? delay > H(pr.min_delay_hours) : delay >= H(pr.min_delay_hours));
  const siblingFor = (phase) => ctx.rulesWithLogic('miami_delay').find((r) => r.logic.params.phase === phase);
  for (const p of ctx.execPairings) {
    if (!ctx.pairingHandledBy(p, 'miami_one_night')) continue; // ס' 24.4 חל רק בנוסף לקיצור המנוחה
    const leg = p.legs.find((l) => l.org === ctx.domicile && l.dst === params.station);
    if (!leg) continue;
    const delay = outboundDelay(ctx, p, leg);
    if (delay == null || !enough(params, delay)) continue;
    const what = `${describePairing(p)}: ${leg.flight ?? `${leg.org}–${leg.dst}`} המריאה ${minToHhmm(delay)} אחרי ה-STD המתוכנן`;
    const id = `miami_delay:${p.id}`;
    const answered = ctx.answer(id);
    const assumed = !ctx.pairingHandledBy(p, 'miami_delay') && ctx.paidOn(p, params.report_column, key, hours, own);
    const a = answered ?? (assumed ? { value: params.phase } : null);
    if (!a) {
      if (ctx.pairingHandledBy(p, 'miami_delay')) continue; // החוק השני כבר קבע
      const opt = (phase) => {
        const sib = siblingFor(phase);
        return { value: phase, label: PHASE_LABEL[phase],
          hint: sib && enough(sib.logic.params, delay) ? `${minToHhmm(hours)} – פער מול הדוח` : 'אין פיצוי' };
      };
      ctx.ask({
        id,
        date: p.from,
        title: `דחייה ביציאה ל-${params.station}: מתי חלה הדחייה?`,
        body: `${what}, והמנוחה בתחנה קוצרה ללילה אחד. הדוח לא מזכה ${minToHhmm(hours)}, ` +
          'והפיצוי תלוי במועד הדחייה, שאינו בקבצים: לפני תחילת זמן התפקיד מגיע פיצוי רק על דחייה של מעל 5 שעות, ' +
          'ואחרי שזמן התפקיד החל – על דחייה של שעתיים ומעלה.',
        options: [opt('before_duty'), opt('after_duty'),
          { value: 'no_rest_cut', label: `הדחייה לא קיצרה עוד את המנוחה ב-${params.station}`, hint: 'אין פיצוי' }],
        ruleId: rule.id,
      });
      continue;
    }
    if (a.value === params.phase) {
      ctx.markPairing(p, 'miami_delay');
      ctx.expectPairing(p, key, hours, rule, `${what}, ${PHASE_LABEL[params.phase]} ` +
        `(${answered ? 'לפי תשובתך' : `לפי מה שהדוח מזכה`}), בנוסף לקיצור המנוחה של ס' 24.3.`);
      continue;
    }
    // התשובה שייכת לחוק השני. אם גם הוא אינו חל על הדחייה הזאת, ההסבר נרשם כאן, פעם אחת.
    const sib = siblingFor(a.value);
    if (sib && enough(sib.logic.params, delay)) continue;
    if (ctx.pairingHandledBy(p, 'miami_delay')) continue;
    ctx.markPairing(p, 'miami_delay');
    ctx.note(p.from, `${rule.title}: ${what}. ` + (a.value === 'no_rest_cut'
      ? `לפי תשובתך הדחייה לא קיצרה עוד את המנוחה ב-${params.station}, ולכן אין פיצוי.`
      : `לפי תשובתך הדחייה חלה ${PHASE_LABEL[a.value]}, ובמקרה כזה הפיצוי ניתן רק על דחייה של ` +
        `${sib?.logic.params.min_delay_exclusive ? 'מעל ' : ''}${sib?.logic.params.min_delay_hours ?? '?'} שעות` +
        `${sib?.logic.params.min_delay_exclusive ? '' : ' ומעלה'}, ולכן אין פיצוי.`), rule);
  }
}


// ---------- לאס וגאס (2018 ס' 58.2) ----------

/**
 * קיצור המנוחה בלאס וגאס (2018 ס' 58.2): המנוחה החוזית בתחנה מקוצרת ל-`rest_hours` שעות
 * "בתמורה לתשלום פיצוי בגובה 5 שעות לתשלום לכל אצ"א פרטני [לפי 100%]", כל עוד החברה טסה
 * לשם פעם בשבוע. ההסדר קבוע, ולכן מניחים שכל שהייה בתחנה מזכה, בלי תנאי על אורך השהייה
 * (החלטת בעל המוצר, 23/09/2026). שואלים רק כשיש דוח שלא זיכה, כי שתי הסיבות שבגללן הפיצוי
 * אינו מגיע – מנוחה חוזית מלאה, או שהחברה אינה טסה לשם פעם בשבוע – אינן בקבצים.
 */
function short_rest_las_vegas(ctx, params, rule) {
  const key = keyFor(params.report_column);
  const hours = H(params.hours);
  const own = ctx.rulesWithLogic('short_rest_las_vegas').map((r) => r.id);
  const deal = `המנוחה החוזית ב-${params.station} מקוצרת ל-${params.rest_hours} שעות בתמורה לפיצוי של ` +
    `${minToHhmm(hours)}, כל עוד החברה טסה לשם פעם בשבוע.`;
  const derived = `שעת ההתייצבות אינה בקבצים ונגזרת מ-STD פחות ${params.report_minutes_before_std} דק'.`;
  for (const p of ctx.hasExec ? ctx.execPairings : ctx.planPairings) {
    const stay = stationStay(ctx, p, params, ctx.hasExec);
    if (!stay) continue;
    const what = stayLine(p, stay, params);
    if (!ctx.hasExec) {
      ctx.expectPairing(p, key, hours, rule, `${what}. ${deal} ${derived}`);
      continue;
    }
    const id = `las_vegas_rest:${p.id}`;
    const answered = ctx.answer(id);
    const a = answered ?? (ctx.paidOn(p, params.report_column, key, hours, own) ? { value: 'yes' } : null);
    if (!a) {
      ctx.ask({
        id,
        date: p.from,
        title: `קיצור מנוחה ב-${params.station}: האם מגיע פיצוי?`,
        body: `${what}. ${deal} הדוח לא מזכה ${minToHhmm(hours)}, והסיבה אינה בקבצים. ${derived}`,
        options: [
          { value: 'yes', label: 'כן, המנוחה קוצרה', hint: `${minToHhmm(hours)} – פער מול הדוח` },
          { value: 'full_rest', label: 'לא, קיבלתי את המנוחה החוזית המלאה', hint: 'אין פיצוי' },
          { value: 'not_weekly', label: `החברה אינה טסה ל-${params.station} פעם בשבוע`, hint: 'אין פיצוי' },
        ],
        ruleId: rule.id,
      });
      continue;
    }
    if (a.value !== 'yes') {
      ctx.note(p.from, `${rule.title}: ${what}. ` + (a.value === 'full_rest'
        ? 'לפי תשובתך המנוחה לא קוצרה, ולכן אין פיצוי.'
        : `לפי תשובתך החברה אינה טסה ל-${params.station} פעם בשבוע, ולכן הקיצור אינו בתוקף ואין פיצוי.`), rule);
      continue;
    }
    ctx.expectPairing(p, key, hours, rule, `${what}. ${deal} הפיצוי נרשם ` +
      `${answered ? 'לפי תשובתך' : `לפי מה שהדוח מזכה`}. ${derived}`);
  }
}


// ---------- סימולטור בישראל (2024 ס' 15–18; 2026 ס' 18) ----------

/**
 * אימוני סימולטור בישראל מדוח הביצוע: שורות SIM עם STD/STA בשעון מקומי. סימולטור בחו"ל (SIM_BER) אינו בפרק "סימולטור בישראל" ואינו נבדק.
 */
function israelSims(ctx, params) {
  const stations = params.stations ?? [ctx.domicile];
  return ctx.timeline.flatMap((day) => (day.exec?.sims ?? [])
    .filter((s) => stations.includes(s.org) && s.std != null)
    .map((s) => ({ ...s, date: day.date })));
}

const simLabel = (s) => `סימולטור ב-${ddmm(s.date)} ${minToHhmm(s.std)}–${s.sta != null ? minToHhmm(s.sta) : '?'}`;

/** ימי החג של השנה, ובדיקה ידנית אחת לכל שנה שחסרה ב-rules.json. */
function holidaysOf(ctx, year, rule, what) {
  const list = ctx.holidays(year);
  if (!list) ctx.review(`${what}: אין ב-rules.json את תאריכי החגים לשנת ${year}, ולכן נבדק רק לפי ימי השבוע. נדרש עדכון של קובץ החוקים.`, rule);
  return list ?? [];
}

const weekday = (iso) => new Date(Date.parse(iso)).getUTCDay();

/**
 * אימון שתחילתו בין `night_from` ל-`night_to`, או ביום שבת או חג (2024 ס' 18). השעות בשורת ה-SIM אינן
 * מדויקות: האימון מתחיל `start_after_std_minutes` אחרי STD (החלטת בעל המוצר, 22/09/2026). בשבת ובחג
 * אין אימונים, ולכן כל אימון ביום כזה הוא אחרי צאת השבת או החג. חלון הלילה של 2026 (ס' 18.1.7)
 * ומוצ"ש של 2026 (ס' 18.1.8) נכללים כאן: אין כפל פיצוי. ההסכמה מונחת.
 */
function sim_night_session(ctx, params, rule) {
  if (!ctx.hasExec) return;
  const key = keyFor(params.report_column);
  const from = parseClock(params.night_from);
  const to = parseClock(params.night_to);
  const sims = israelSims(ctx, params);
  const years = [...new Set(sims.map((s) => s.date.slice(0, 4)))];
  const holidays = new Set(years.flatMap((y) => holidaysOf(ctx, y, rule, 'סימולטור במוצאי חג')));
  for (const s of sims) {
    const start = mod(s.std + (params.start_after_std_minutes ?? 0), 1440);
    const night = from > to ? (start >= from || start <= to) : (start >= from && start <= to);
    const saturday = weekday(s.date) === 6;
    const holiday = holidays.has(s.date);
    if (!night && !saturday && !holiday) continue;
    const why = [night && `תחילתו ב-${minToHhmm(start)}, בין ${params.night_from} ל-${params.night_to}`, saturday && 'במוצאי שבת', holiday && 'במוצאי חג']
      .filter(Boolean).join(', ');
    ctx.expect(s.date, key, H(params.hours), rule, `${simLabel(s)}: ${why}`);
  }
}

/**
 * אימון ביום שישי או בערב חג (2018 ס' 182.5.5), לפי התאריך. ערב חג = היום שלפני יום חג שאינו
 * המשך של חג (ערב ראש השנה, ולא היום הראשון שלו).
 */
function sim_friday_holiday_eve(ctx, params, rule) {
  if (!ctx.hasExec) return;
  const key = keyFor(params.report_column);
  const sims = israelSims(ctx, params);
  const years = [...new Set(sims.flatMap((s) => [s.date.slice(0, 4), addDays(s.date, 1).slice(0, 4)]))];
  const holidays = new Set(years.flatMap((y) => holidaysOf(ctx, y, rule, 'סימולטור בערב חג')));
  for (const s of sims) {
    const next = addDays(s.date, 1);
    const eve = holidays.has(next) && !holidays.has(s.date);
    const friday = weekday(s.date) === 5;
    if (!eve && !friday) continue;
    ctx.expect(s.date, key, H(params.hours), rule, `${simLabel(s)}: ${[friday && 'ביום שישי', eve && 'בערב חג'].filter(Boolean).join(', ')}`);
  }
}

/**
 * הארכת אימון (2024 ס' 17): אימון ארוך מ-`max_hours` (4 שעות ועוד רבע שעה), לפי STA − STD.
 * הפיצוי רק כשההארכה לבקשת החברה. מניחים שכן, ושואלים רק כשהדוח לא מזכה.
 */
function sim_extension(ctx, params, rule) {
  if (!ctx.hasExec) return;
  const key = keyFor(params.report_column);
  const max = H(params.max_hours);
  for (const s of israelSims(ctx, params)) {
    if (s.sta == null) continue;
    const dur = mod(s.sta - s.std, 1440);
    if (dur <= max) continue;
    const what = `${simLabel(s)} נמשך ${minToHhmm(dur)}, יותר מ-${minToHhmm(max)}`;
    const paid = ctx.reportedOnDate(s.date, params.report_column) - ctx.expectedOnDate(s.date, key) >= H(params.hours);
    if (!paid) {
      const id = `sim_extension:${s.date}:${s.std}`;
      const a = ctx.answer(id);
      if (!a) {
        ctx.ask({
          id,
          date: s.date,
          title: `${what}. האם ההארכה הייתה לבקשת החברה?`,
          body: 'על הארכת אימון בסימולטור לבקשת החברה מגיע פיצוי, והדוח לא מזכה אותו.',
          options: [
            { value: 'company', label: 'לבקשת החברה', hint: minToHhmm(H(params.hours)) },
            { value: 'mine', label: 'לא לבקשת החברה', hint: 'אין פיצוי' },
          ],
          ruleId: rule.id,
        });
        continue;
      }
      if (a.value !== 'company') {
        ctx.note(s.date, `${what}. לפי תשובתך ההארכה לא הייתה לבקשת החברה: אין פיצוי.`, rule);
        continue;
      }
    }
    ctx.expect(s.date, key, H(params.hours), rule, what);
  }
}

/** חוק שהפיצוי שלו נבדק בחוק אחר (`rule`), כדי שלא יהיה כפל פיצוי. */
function covered_by() {}

/**
 * קיבוץ סבבי הביצוע ל-FDP: סבבים עוקבים שאין ביניהם מנוחה חוקית, לפי STD/STA. סבב חתוך,
 * או סבב שחסרים לו זמנים, עומד לבד.
 */
export function execFdpGroups(pairings, domicile, legalRest, reportMin) {
  const sorted = [...pairings].sort((a, b) => a.from.localeCompare(b.from));
  const groups = [];
  let prev = null;
  for (const p of sorted) {
    const span = execSpan(p, domicile, true);
    const joins = prev && prev.span.end != null && span.start != null && restBetween(prev.span, span, reportMin) < legalRest;
    if (joins) groups.at(-1).push(p);
    else groups.push([p]);
    prev = { span };
  }
  return groups;
}

export const DUTY_LOGIC = {
  same_fdp_rounds,
  second_unplanned_activity,
  base_rest_shortfall,
  night_landings,
  special_date_activity,
  white_flight,
  ulh_flight,
  free_days_waived,
  consecutive_saturdays,
  consecutive_night_rounds,
  stay_extension,
  short_rest_miami,
  miami_delay,
  short_rest_las_vegas,
  sim_night_session,
  sim_extension,
  sim_friday_holiday_eve,
  covered_by,
};

export const DUTY_PARAMS = {
  same_fdp_rounds: ['legal_rest_hours', 'report_minutes_before_std', 'hours', 'report_column'],
  second_unplanned_activity: ['legal_rest_hours', 'report_minutes_before_std', 'hours', 'report_column', 'sim_report_codes', 'sim_plan_codes', 'sim_plan_code_prefixes'],
  base_rest_shortfall: ['answer_value', 'hours', 'report_column', 'report_minutes_before_std', 'rest_buffer_minutes', 'legal_rest_hours',
    'short_stay_max_hours', 'short_stay_factor', 'long_stay_share', 'long_stay_min_hours', 'long_stay_max_hours'],
  night_landings: ['fleet', 'window_from', 'window_to', 'min_planned_count', 'paid_from_count', 'hours', 'report_column', 'base_landings_only', 'counted_crews'],
  special_date_activity: ['occasions', 'flight_activity_only', 'hours', 'report_column', 'report_minutes_before_std'],
  free_days_waived: ['hours', 'report_column', 'paid_from_day', 'off_block_from', 'on_block_until', 'min_free_days'],
  consecutive_saturdays: ['hours', 'report_column', 'shabbat_from', 'shabbat_to'],
  consecutive_night_rounds: ['hours', 'report_column', 'more_than', 'window_from', 'window_to', 'legal_rest_hours', 'report_minutes_before_std'],
  white_flight: ['hours', 'report_column', 'report_minutes_before_std', 'report_after', 'report_until', 'min_block_hours'],
  ulh_flight: ['hours', 'report_column', 'min_block_hours', 'max_block_hours'],
  stay_extension: ['over_hours', 'capped_days', 'hours', 'report_column'],
  short_rest_miami: ['station', 'night_from', 'night_to', 'max_nights', 'hours', 'report_column', 'report_minutes_before_std'],
  miami_delay: ['station', 'phase', 'min_delay_hours', 'min_delay_exclusive', 'hours', 'report_column'],
  short_rest_las_vegas: ['station', 'rest_hours', 'hours', 'report_column', 'report_minutes_before_std'],
  sim_night_session: ['hours', 'report_column', 'stations', 'night_from', 'night_to', 'start_after_std_minutes'],
  sim_friday_holiday_eve: ['hours', 'report_column', 'stations'],
  sim_extension: ['hours', 'report_column', 'stations', 'max_hours'],
  covered_by: ['rule'],
};
