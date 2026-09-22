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
const keyFor = (column) => (column === 'S/C' ? 'sc' : 'com');

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
  const isSimDay = (day) => ctx.execCodes(day).some((c) => simReport.includes(c));
  const simPlanned = (day) => (day.plan?.codes ?? []).some((c) => simPlan.includes(c));
  const key = keyFor(params.report_column);

  const askRest = (id, date, title) => ctx.ask({
    id, date, title,
    body: `לסימולטור אין שעות בקבצים. פעילות שנייה מזכה רק אם הייתה מנוחה חוקית (${params.legal_rest_hours} שעות לפחות) בין שתי הפעילויות, כלומר הן לא באותו FDP.`,
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
    const a = ctx.answer(id);
    if (!a) askRest(id, day, `${describePairing(u)} לא הייתה בתכנון, ובאותה יממה היה סימולטור. האם הייתה מנוחה ביניהם?`);
    else if (a.value === 'separate') ctx.expectPairing(u, key, H(params.hours), rule, `${describePairing(u)} לא הייתה בתכנון, ובאותה יממה היה סימולטור (לפי תשובתך, עם מנוחה חוקית ביניהם)`);
  }

  // סימולטור לא מתוכנן ביום טיסה
  for (const day of ctx.timeline) {
    if (!isSimDay(day) || simPlanned(day)) continue;
    const flights = ctx.execPairings.filter((p) => p.dates.includes(day.date));
    if (!flights.length) continue;
    const id = `second_activity:sim:${day.date}`;
    const a = ctx.answer(id);
    if (!a) askRest(id, day.date, `סימולטור ב-${ddmm(day.date)} לא היה בתכנון, ובאותה יממה בוצעה ${flights.map(describePairing).join(', ')}. האם הייתה מנוחה ביניהם?`);
    else if (a.value === 'separate') ctx.expect(day.date, key, H(params.hours), rule, 'סימולטור לא מתוכנן ביממה עם טיסה (לפי תשובתך, עם מנוחה חוקית ביניהם)');
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

    const id = `base_rest:${p2.id}`;
    const a = ctx.answer(id);
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
    const target = ctx.hasExec ? performedAsPlanned(ctx, p2) : p2;
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

  // מה נחשב ביצוע: הטיסה בדוח, או ביטול ושינוי הצבה ביוזמת החברה (done / company / no / unknown).
  if (ctx.hasExec) {
    for (const n of night) {
      n.target = ctx.execPairings.find((e) => e.legs.some((l) => l.flight === n.leg.flight && l.type !== 'DHO' &&
        Math.abs(Date.parse(l.date) - Date.parse(n.leg.date)) <= dayMs)) ?? null;
      if (n.target) { n.status = 'done'; continue; }
      const cause = companyCause(ctx, n.pairing);
      const a = cause == null ? ctx.answer(`night_landing:${n.pairing.id}`)?.value : null;
      n.status = cause === true || a === 'company' ? 'company' : cause === false || a === 'mine' ? 'no' : 'unknown';
    }
  } else {
    for (const n of night) { n.target = n.pairing; n.status = 'done'; }
  }
  const threshold = params.paid_from_count;

  // נספרות רק טיסות בהרכב צוות מ-`counted_crews` (2024 ס' 39–40: בודד או מוגבר). ההרכב אינו בקבצים, ולכן
  // שואלים על כל טיסה, רק כל עוד התשובות עוד יכולות להביא למינימום.
  let pool = night;
  if (params.counted_crews) {
    const counted = params.counted_crews;
    const crewOf = (n) => ctx.answer(`night_crew:${n.leg.date}:${n.leg.flight}`)?.value;
    const kept = night.filter((n) => counted.includes(crewOf(n)));
    const open = night.filter((n) => crewOf(n) == null);
    if (kept.length + open.length < params.min_planned_count) return;
    // עם דוח ביצוע: אם גם כשכל הטיסות הפתוחות ייספרו לא מגיעים לטיסה ה-`paid_from_count` שבוצעה, לא שואלים.
    if (open.length && [...kept, ...open].filter((n) => n.status !== 'no').length >= threshold) {
      for (const n of open) {
        ctx.ask({
          id: `night_crew:${n.leg.date}:${n.leg.flight}`,
          date: n.leg.date,
          title: `נחיתת לילה: באיזה צוות מתוכננת ${n.leg.flight} ב-${ddmm(n.leg.date)} (נחיתה ${minToHhmm(n.clock)} שעון ישראל)?`,
          body: `בתכנון ${night.length} טיסות עם נחיתה בין ${params.window_from} ל-${params.window_to}. לפיצוי נספרות רק טיסות בצוות ` +
            `${counted.map((c) => CREW_LABEL[c] ?? c).join(' או ')}, מ-${params.min_planned_count} טיסות כאלה בחודש.`,
          options: Object.entries(CREW_LABEL).map(([value, label]) => ({
            value, label: `${label} (${CREW_PILOTS[value]} טייסים)`, hint: counted.includes(value) ? 'נספרת' : 'לא נספרת',
          })),
          ruleId: rule.id,
        });
      }
      return;
    }
    pool = [...kept, ...open];
  }

  const counted = pool.filter((n) => n.status === 'done' || n.status === 'company');
  const unknown = pool.filter((n) => n.status === 'unknown');
  if (counted.length + unknown.length < threshold) {
    const list = (items) => items.map((n) => `${ddmm(n.leg.date)} ${n.leg.flight}${n.status === 'company' ? ' – שינוי ביוזמת החברה' : ''}`).join(', ');
    const missed = pool.filter((n) => !counted.includes(n));
    ctx.note(null, `${rule.title}: תוכננו ${pool.length} טיסות עם נחיתה בין ${params.window_from} ל-${params.window_to}, ` +
      `נספרות כבוצעות: ${counted.length}${counted.length ? ` (${list(counted)})` : ''}${missed.length ? `; לא בוצעו: ${list(missed)}` : ''}. ` +
      `הפיצוי הוא מהטיסה ה-${threshold} שבוצעה, ולכן אין פיצוי.`, rule);
    return;
  }
  if (unknown.length && counted.length < threshold) {
    for (const n of unknown) {
      ctx.ask({
        id: `night_landing:${n.pairing.id}`,
        date: n.pairing.from,
        title: `${describePairing(n.pairing)}: טיסה עם נחיתת לילה (${minToHhmm(n.clock)}) שלא בוצעה`,
        body: `תוכננו ${night.length} טיסות עם נחיתה בין ${params.window_from} ל-${params.window_to}. ביטול או שינוי הצבה ביוזמת החברה ` +
          'נחשב ביצוע לצורך הפיצוי, ושינוי לבקשתך לא. מה קרה?',
        options: [
          { value: 'company', label: 'ביוזמת החברה', hint: 'נספרת כבוצעה' },
          { value: 'mine', label: 'לבקשתי, או שלא הייתי זמין', hint: 'לא נספרת' },
        ],
        ruleId: rule.id,
      });
    }
  }

  counted.sort((a, b) => a.leg.date.localeCompare(b.leg.date) || a.clock - b.clock);
  counted.forEach((n, i) => {
    const why = `${ddmm(n.leg.date)} ${n.leg.flight}, נחיתה ${minToHhmm(n.clock)} שעון ישראל: הטיסה ה-${i + 1} מתוך ` +
      `${night.length} מתוכננות עם נחיתת לילה`;
    if (i + 1 < threshold) return;
    if (n.target) ctx.expectPairing(n.target, keyFor(params.report_column), H(params.hours), rule, why);
    else ctx.expect(n.pairing.from, keyFor(params.report_column), H(params.hours), rule, `${why} (בוטלה ביוזמת החברה)`);
  });
}

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
 * האם סבב מתוכנן שלא בוצע בוטל או שונה ביוזמת החברה: true, false, או null כשלא ידוע.
 * היעדרות והחלפה מרצון אינן ביוזמת החברה.
 */
function companyCause(ctx, planPairing) {
  const m = ctx.matches.find((x) => x.plan === planPairing);
  if (!m) return null;
  if (m.byLeave) return false;
  if (m.how === 'replaced_by_ground') return true; // החברה הציבה אותו לפעילות קרקע
  const a = ctx.answerFor(m);
  if (a?.value === 'voluntary_swap') return false;
  if (['replaced', 'wet_lease', 'cancelled'].includes(a?.value)) return true;
  return null;
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
    const a = ctx.answer(id);
    if (!a) {
      ctx.ask({
        id,
        date: coded.date,
        title: `${occ.title}: האם היית בפעילות מטעם החברה בין ${hhmm(wFrom)} ל-${hhmm(wTo)}?`,
        body: `ב-${ddmm(coded.date)} רשום ${ctx.activityCodes(coded).join(', ')}, ואין בקבצים שעות לפעילות הזאת.`,
        options: [
          { value: 'yes', label: 'כן', hint: `${minToHhmm(H(params.hours))}` },
          { value: 'no', label: 'לא', hint: 'אין פיצוי' },
        ],
        ruleId: rule.id,
      });
    } else if (a.value === 'yes') {
      ctx.expect(coded.date, key, H(params.hours), rule, `${occ.title}: ${ctx.activityCodes(coded).join(', ')} בחלון ${window} (לפי תשובתך)`);
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

  // X ב-1 לחודש בלי טיסה ביום: ייתכן שזו נחיתה של סבב מהחודש הקודם, שאינו בתכנון. שואלים. עד התשובה היום לא נספר.
  const first = ctx.timeline.find((d) => d.date === ctx.monthFirst);
  if (free.includes(ctx.monthFirst) && (first?.plan?.codes ?? []).includes('X')) {
    const fid = `free_days_first:${ctx.monthFirst.slice(0, 7)}`;
    const fa = ctx.answer(fid);
    if (fa?.value !== 'free') free.splice(free.indexOf(ctx.monthFirst), 1);
    if (!fa) {
      ctx.ask({
        id: fid,
        date: ctx.monthFirst,
        title: `ימים ללא פעילות: ב-${ddmm(ctx.monthFirst)} מסומן X. האם נחתת בו מסבב של החודש הקודם?`,
        body: `X ב-1 לחודש מופיע גם כשסבב מהחודש הקודם נוחת בו, והנחיתה אינה בתכנון. יום עם נחיתה בבסיס עד ${params.on_block_until} נחשב פנוי.`,
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
  const what = `בתכנון ${free.length} ימים ללא פעילות, והמינימום לקרדיט מתוכנן ${minToHhmm(credit)} הוא ${due}`;
  if (paidDays <= 0) {
    ctx.note(null, `${what}. חסר יום אחד, והפיצוי מתחיל מהיום השני.`, rule);
    return;
  }
  const id = `free_days:${ctx.monthFirst.slice(0, 7)}`;
  const a = ctx.answer(id);
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
    ctx.expect(ctx.monthFirst, keyFor(params.report_column), paidDays * H(params.hours), rule,
      `${what}: ${missing} ימים חסרים, פיצוי על ${paidDays} (מהיום השני)`);
  }
}

/**
 * שתי שבתות ברצף (2024 ס' 34): פעילות בשתי שבתות עוקבות. שבת עם פעילות = סבב שחופף לשבת
 * (כולל יציאה לפני שבת וחזרה בשבת או אחריה) או קוד פעילות בשבת. לפי הביצוע כשיש; סבב
 * מתוכנן שבוטל ביוזמת החברה נחשב ביצוע (ס' 40). בלי שאלת הסכמה (החלטת בעל המוצר, 21/09/2026).
 * שלוש שבתות ברצף הן שני זוגות.
 */
function consecutive_saturdays(ctx, params, rule) {
  const key = keyFor(params.report_column);
  const planSpans = ctx.hasPlan ? spansOf(ctx, ctx.planPairings, (p) => planSpan(p, ctx.domicile, ctx.monthFirst)) : [];
  const execSpans = ctx.hasExec ? spansOf(ctx, ctx.execPairings, (p) => execSpan(p, ctx.domicile, false)) : [];
  const dayOf = (date) => ctx.timeline.find((d) => d.date === date);
  const active = (date) => {
    const day = dayOf(date);
    if (!ctx.hasExec) {
      const sp = planSpans.find((s) => overlapsDay(s, date));
      return sp ? { pairing: sp.p } : ctx.planActivityCodes(day).length ? { date } : null;
    }
    const sp = execSpans.find((s) => overlapsDay(s, date));
    if (sp) return { pairing: sp.p };
    if (ctx.activityCodes(day).length) return { date };
    const cancelled = planSpans.find((s) => overlapsDay(s, date) && companyCause(ctx, s.p) === true);
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
  // בתכנון אין משך לרגל: STA − STD, כששעת נחיתה עם ! מומרת לשעון הבסיס לפי airports.js.
  const planBlock = (l) => {
    if (!l.arr) return null;
    const off = l.arr.foreign ? stationOffset(l.dst, l.date) : 0;
    return off == null ? null : mod(l.arr.min - off - l.dep.min, 1440);
  };
  const pairings = ctx.hasExec ? ctx.execPairings : ctx.planPairings;

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
      const a = ctx.answer(id);
      if (!a) {
        ctx.ask({
          id,
          date: l.date,
          title: `טיסה לבנה: האם ב-${l.flight} ב-${ddmm(l.date)} היו 3 טייסים או יותר?`,
          body: `${what}. זו טיסה לבנה אם הצוות מוגבר. גם 4 טייסים, כשאחד מהם עוד לא מוגדר קברניט או קצין ראשון, נחשבים.`,
          options: [
            { value: 'yes', label: 'כן, 3 טייסים או יותר', hint: minToHhmm(H(params.hours)) },
            { value: 'no', label: 'לא', hint: 'אין פיצוי' },
          ],
          ruleId: rule.id,
        });
      } else if (a.value === 'yes') {
        ctx.expectPairing(p, key, H(params.hours), rule, `${rule.title}: ${what} (צוות מוגבר לפי תשובתך)`);
      }
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
  for (const m of ctx.matches) {
    if (!m.plan || !m.exec) continue;
    const planned = planSpan(m.plan, ctx.domicile, ctx.monthFirst).end;
    const actual = execSpan(m.exec, ctx.domicile, false).end;
    if (planned == null || actual == null || actual - planned <= H(params.over_hours)) continue;

    ctx.markPairing(m.exec, 'stay_extension');
    const what = `${describePairing(m.exec)}: החזרה לבסיס ב-${ddmm(dateOf(actual))} ${hhmm(actual)}, ` +
      `${minToHhmm(actual - planned)} שעות אחרי המתוכנן (${ddmm(dateOf(planned))} ${hhmm(planned)})`;
    const id = `stay_extension:${m.exec.id}`;
    const a = ctx.answer(id);
    if (!a) {
      ctx.ask({
        id,
        date: m.exec.from,
        title: `חזרה מאוחרת לבסיס: ${describePairing(m.exec)}`,
        body: `${what}. הפיצוי תלוי בסיבה, והיא אינה בקבצים. מה קרה?`,
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
      const days = [];
      for (let d = addDays(dateOf(planned), 1); d <= dateOf(actual); d = addDays(d, 1)) days.push(d);
      ctx.expectPairing(m.exec, key, days.length * H(params.hours), rule,
        `${what}. ${days.length === 1 ? 'יממה לא מתוכננת' : `${days.length} יממות לא מתוכננות`} ` +
        `(${days.map(ddmm).join(', ')}), לפי תשובתך.`);
    }
  }
}

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
  free_days_waived,
  consecutive_saturdays,
  stay_extension,
};

export const DUTY_PARAMS = {
  same_fdp_rounds: ['legal_rest_hours', 'report_minutes_before_std', 'hours', 'report_column'],
  second_unplanned_activity: ['legal_rest_hours', 'report_minutes_before_std', 'hours', 'report_column', 'sim_report_codes', 'sim_plan_codes'],
  base_rest_shortfall: ['answer_value', 'hours', 'report_column', 'report_minutes_before_std', 'rest_buffer_minutes', 'legal_rest_hours',
    'short_stay_max_hours', 'short_stay_factor', 'long_stay_share', 'long_stay_min_hours', 'long_stay_max_hours'],
  night_landings: ['fleet', 'window_from', 'window_to', 'min_planned_count', 'paid_from_count', 'hours', 'report_column', 'base_landings_only', 'counted_crews'],
  special_date_activity: ['occasions', 'flight_activity_only', 'hours', 'report_column', 'report_minutes_before_std'],
  free_days_waived: ['hours', 'report_column', 'paid_from_day', 'off_block_from', 'on_block_until', 'min_free_days'],
  consecutive_saturdays: ['hours', 'report_column'],
  white_flight: ['hours', 'report_column', 'report_minutes_before_std', 'report_after', 'report_until', 'min_block_hours'],
  stay_extension: ['over_hours', 'capped_days', 'hours', 'report_column'],
};
