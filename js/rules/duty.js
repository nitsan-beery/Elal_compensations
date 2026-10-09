// חוקים שתלויים בזמני התפקיד: FDP, מנוחה בבסיס, נחיתות לילה ותאריכים מיוחדים.
//
// כל הזמנים כאן הם דקות מוחלטות בשעון הבסיס (שעון ישראל): `at(date, clock)`. זמני הרגליים
// והסבבים – רק מ-js/flight-times.js (`legTimes`, ‏`pairingTimes`).

import { hoursToMin, isoDate, minToHhmm } from '../time.js';
import { describePairing } from '../model.js';
import { at, dateOf, legTimes, pairingTimes } from '../flight-times.js';

const H = (hours) => hoursToMin(hours) ?? 0;
/**
 * המילה שמתארת סכום לפי העמודה שבה הוא נרשם: COM ו-S/C הם פיצוי, ו-Credit ו-Rig הם
 * קרדיט (בעל המוצר, 23/09/2026). שם העמודה עצמו אינו מוצג בהערות ובשאלות.
 */
export const amountWord = (column) => (column === 'COM' || column === 'S/C' ? 'פיצוי' : 'קרדיט');

/**
 * "סיבה אחרת" בשאלה: המשתמש כותב את הסיבה, ואומר אם מגיע עליה קרדיט וכמה, מחצי שעה עד חמש
 * שעות (`answer.creditMin`, 0 כשלא מגיע; בעל המוצר, 29/09/2026). הקרדיט נבדק מול עמודת Rig,
 * העמודה של קרדיט שאינו קרדיט הטיסה עצמה.
 */
export const otherOption = () => ({ value: 'other', label: 'סיבה אחרת', needsText: true, needsCredit: true });

/**
 * הערה עם הסיבה כלשונה, מסומנת "לפי תשובת המשתמש", והקרדיט שהמשתמש אמר שמגיע – על `pairing`
 * כשיש טיסה שבוצעה, ואחרת על `date`. תשובה שנשמרה לפני שנשאל על הקרדיט מחזירה false, והקורא
 * שולח אותה לבדיקה ידנית כמו קודם.
 */
export function applyOtherReason(ctx, answer, rule, { what, date, pairing = null, extra }) {
  if (typeof answer.creditMin !== 'number') return false;
  const min = answer.creditMin;
  const note = `${what}: "${answer.text}"`;
  ctx.note(date, `${note} – ${min > 0 ? 'קרדיט נוסף' : 'לא מגיע קרדיט'}.`, rule, { byUser: true, ruleTitle: null });
  // בשורת ההשוואה: "סיבה אחרת" ולא שם החוק, שאינו מתאר את מה שקרה ("טיסה שבוטלה ללא פיצוי").
  const shown = { ...extra, ruleTitle: 'סיבה אחרת, לפי תשובת המשתמש' };
  if (min > 0 && pairing) ctx.expectPairing(pairing, 'rig', min, rule, note, shown);
  else if (min > 0) ctx.expect(date, 'rig', min, rule, note, shown);
  return true;
}
const dayMs = 86400000;
const clockOf = (abs) => ((abs % 1440) + 1440) % 1440;
const addDays = (iso, n) => new Date(Date.parse(iso) + n * dayMs).toISOString().slice(0, 10);
const ddmm = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7);
const hhmm = (abs) => minToHhmm(clockOf(abs));
const mod = (n, m) => ((n % m) + m) % m;
const parseClock = (s) => {
  const m = String(s ?? '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
export const keyFor = (column) => (column === 'S/C' ? 'sc' : column === 'Credit' ? 'credit' : 'com');

/** משך הרגל המתוכנן, STA − STD (`legTimes`), או null. */
const legBlock = (ctx, l) => {
  const t = legTimes(l, ctx.tz);
  return t?.sta == null ? null : t.sta - t.std;
};

/**
 * טיסת סבב (turnaround): אין בה מנוחה בחו"ל. המנוחה בחו"ל מתחילה `postMin` אחרי הנחיתה ונגמרת
 * בהתייצבות, `outstationReportMin` לפני ההמראה (OMA 7.2.1), ולכן היא זמן הקרקע פחות שניהם.
 */
const isTurnaround = (span, legalRest, ctx) =>
  span.start != null && span.end != null && span.flight != null &&
  span.end - span.start - span.flight - (ctx.legalRest?.postMin ?? 0) - (ctx.legalRest?.outstationReportMin ?? 0) < legalRest;

/** הזמן בין סיום FDP (On block בבסיס) לבין ההתייצבות לפעילות הבאה. */
const restBetween = (a, b, reportMin) => b.start - reportMin - a.end;

/** המנוחה החוקית ביניהם: מתחילה `postMin` אחרי ה-On block (תפקיד אחרי הטיסה, OMA 7.2.1). */
const legalRestBetween = (a, b, reportMin, postMin = 0) => restBetween(a, b, reportMin) - postMin;

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
    const [s1, s2] = [pairingTimes(p1, ctx.tz), pairingTimes(p2, ctx.tz)];
    if (s1.end == null || s2.start == null) continue;
    const post = ctx.legalRest?.postMin ?? 0;
    const rest = legalRestBetween(s1, s2, report, post);
    if (rest >= legal) continue;
    if (!isTurnaround(s1, legal, ctx) || !isTurnaround(s2, legal, ctx)) continue;

    const why = `${describePairing(p1)} ו-${describePairing(p2)}: ${minToHhmm(Math.max(rest, 0))} מנוחה מהשחרור (${hhmm(s1.end + post)}) ` +
      `עד ההתייצבות (${hhmm(s2.start - report)}), פחות ממנוחה חוקית של ${params.legal_rest_hours} שעות. שתי טיסות סבב באותו FDP`;
    // מתחת לטיסה רק שם החוק, בלי השעות (בעל המוצר, 01/10/2026).
    const explain = '';
    if (!ctx.hasExec) {
      ctx.expectPairing(p2, keyFor(params.report_column), H(params.hours), rule, why, { explain });
      continue;
    }
    const [e1, e2] = [performedAsPlanned(ctx, p1), performedAsPlanned(ctx, p2)];
    if (!e1 || !e2) {
      ctx.note(p2.from, `${why}, אבל שתיהן לא בוצעו כמתוכנן. הפיצוי מותנה בהתייצבות לשתיהן.`, rule);
      continue;
    }
    // `jointWith`: הפיצוי על שתי הטיסות יחד, ובטבלת הפירוט הוא שורה אחת לשני הסבבים (04/08/2025).
    ctx.expectPairing(e2, keyFor(params.report_column), H(params.hours), rule, why, { jointWith: [e1.id], explain });
  }
}

// ---------- פעילות שנייה לא מתוכננת (2024 ס' 42.6–42.7) ----------

/**
 * סבב מתוכנן שבוצע גם ביום שהסבב המתוכנן לא נגע בו (בעל המוצר, 06/10/2026): מההמראה ועד הנחיתה בבסיס
 * בפועל, כולל נחיתה באיחור אחרי חצות – בלי הסף של היממה השנייה בקריאה מיוחדת (`countSpecialCallDays`),
 * שהוא לטיסה שלא תוכננה כלל. `free` – יום שלא תוכנן בו כלום (`ctx.planFreeDay`): קריאה מיוחדת
 * (`special_call`). `second` – יום שתוכננה בו פעילות ובוצעו בו גם טיסה אחרת או סימולטור: פעילות שנייה לא
 * מתוכננת (`second_unplanned_activity`, 2024 ס' 42.6; פעילות קרקע אינה נספרת). null כשאין יום כזה.
 */
export function extensionDays(ctx, match) {
  if (!match.plan || !match.exec || match.exec.cutAtStart || match.exec.cutAtEnd || match.plan.cutAtStart || match.plan.cutAtEnd) return null;
  const e = pairingTimes(match.exec, ctx.tz, { away: true });
  const p = pairingTimes(match.plan, ctx.tz);
  if (e.start == null || e.end == null || p.start == null || p.end == null) return null;
  const days = [];
  for (let d = dateOf(e.start); at(d, 0) < e.end; d = addDays(d, 1)) {
    if (p.start < at(d, 1440) && p.end > at(d, 0)) continue;
    if (ctx.timeline.some((x) => x.date === d)) days.push(d);
  }
  if (!days.length) return null;
  const free = days.filter((d) => ctx.planFreeDay(d));
  const sims = ctx.rulesWithLogic('second_unplanned_activity')[0]?.logic.params?.sim_report_codes;
  const second = !sims ? [] : days.filter((d) => !free.includes(d) &&
    (ctx.execPairings.some((x) => x !== match.exec && x.dates.includes(d)) || ctx.execCodes(ctx.timeline.find((x) => x.date === d)).some((c) => sims.includes(c))));
  return { days, free, second };
}

/**
 * הפעילויות האחרות ביממה `d` של `exec` (בעל המוצר, 09/10/2026): קריאה מיוחדת מגיעה על יממה שלא תוכננה בה
 * פעילות; פעילות שלא תוכננה ביממה שהייתה בה פעילות נוספת, עם מנוחה חוקית ביניהן, היא פעילות שנייה (2024
 * ס' 42.6). ביממה שתוכננה בה פעילות – רק פעילות שנייה, בלי קריאה מיוחדת; ביממה שלא תוכננה בה פעילות ובוצעו בה
 * שתיים – שתיהן: קריאה מיוחדת אחת על היממה, ופעילות שנייה על המאוחרת.
 * נספרים סבב ביצוע שנגע ביממה – יצא בה, או נחת בה, גם כשהמריא ביום שלפני: טיסה שנוחתת אחרי חצות היא פעילות
 * טיסה ביממה שבה נחתה (08/10/2026; רון: LY2524 נחתה ב-23/09 ב-02:36, ו-LY391 יצאה ב-17:45) – וסימולטור. כל
 * אחד מהם רק כשהוא מתוכנן (בכל סדר), או כשלא תוכנן והתחיל לפני `exec` (אז `exec` היא השנייה). סבב מתוכנן
 * שבוטל ללא קרדיט אינו מתוכנן. לסימולטור אין בקבצים שעות שמהן אפשר לדעת אם הייתה מנוחה, והתשובה
 * (`second_activity:`) נשאלת ב-`second_unplanned_activity`.
 * מחזירה `{ planned, pairing, sameFdp, sim }`: `planned` – יש ביממה פעילות מתוכננת; `pairing` – סבב שהייתה
 * מנוחה חוקית בינו לבין `exec` (מתוכנן קודם); `sameFdp` – סבבים באותו FDP; `sim` – סימולטור, או null.
 */
export function dayActivity(ctx, exec, d) {
  const params = ctx.rulesWithLogic('second_unplanned_activity')[0]?.logic.params;
  const span = pairingTimes(exec, ctx.tz, { away: true });
  const none = { planned: false, pairing: null, sameFdp: [], sim: null };
  if (!params || span.start == null) return none;
  const legal = H(params.legal_rest_hours);
  const report = params.report_minutes_before_std ?? 0;
  const plannedPairing = (o) => {
    const m = ctx.matches.find((x) => x.exec === o);
    return !!m?.plan && !ctx.pairingHandledBy(m.plan, 'cancelled_no_compensation');
  };
  const pairings = [];
  for (const o of ctx.execPairings) {
    if (o === exec) continue;
    const so = pairingTimes(o, ctx.tz, { away: true });
    if (so.start == null || so.end == null || !(o.dates.includes(d) || dateOf(so.end) === d)) continue;
    const planned = plannedPairing(o);
    if (!planned && so.start >= span.start) continue;
    const [first, second] = so.start < span.start ? [so, span] : [span, so];
    pairings.push({ o, planned, separate: legalRestBetween(first, second, report, ctx.legalRest?.postMin) >= legal });
  }
  const separate = pairings.filter((x) => x.separate).sort((a, b) => b.planned - a.planned);
  const day = ctx.timeline.find((x) => x.date === d);
  const simDay = day && (params.sim_report_codes ?? []).some((c) => ctx.execCodes(day).includes(c));
  const simPlanned = !!simDay && planSimDay(day, params);
  const sims = day?.exec?.sims ?? [];
  // סימולטור בלי שעות: רק כשתוכנן, כי אי אפשר לדעת אם היה לפני הטיסה.
  const simEarlier = sims.some((s) => s.std != null && at(d, s.std) < span.start);
  const sim = simDay && (simPlanned || simEarlier) ? { planned: simPlanned } : null;
  return {
    planned: pairings.some((x) => x.planned) || simPlanned,
    pairing: separate[0] ? { pairing: separate[0].o, planned: separate[0].planned } : null,
    sameFdp: pairings.filter((x) => !x.separate).map((x) => x.o),
    sim,
  };
}

/** סימולטור שתוכנן ביום (SIM_PRG ב-28/01/2025: סימולטור בחו"ל שתוכנן באמצע סבב). */
function planSimDay(day, params) {
  return (day.plan?.codes ?? []).some((c) => (params.sim_plan_codes ?? []).includes(c) || (params.sim_plan_code_prefixes ?? []).some((x) => c.startsWith(x)));
}

/**
 * טיסה או סימולטור שלא היו בתכנון, באותה יממה שבה אצ"א ביצע טיסה או סימולטור אחרים.
 * לא כולל פעילות קרקע, ולא שתי פעילויות באותו FDP (פחות ממנוחה חוקית ביניהן).
 * הפיצוי שייך ליממה, ולא לסבב כולו (בעל המוצר, 08/10/2026): הציפייה על היממה, ו"הרומה זיכתה" נבדק
 * ביממה עצמה (`paidOnDate`).
 */
function second_unplanned_activity(ctx, params, rule) {
  if (!ctx.hasExec || !ctx.hasPlan) return;
  const legal = H(params.legal_rest_hours);
  const report = params.report_minutes_before_std ?? 0;
  const plannedPairing = (o) => {
    const m = ctx.matches.find((x) => x.exec === o);
    return !!m?.plan && !ctx.pairingHandledBy(m.plan, 'cancelled_no_compensation');
  };
  const simReport = params.sim_report_codes ?? [];
  const scColumn = ctx.rulesWithLogic('special_call')[0]?.logic?.params?.report_column ?? 'S/C';
  const isSimDay = (day) => ctx.execCodes(day).some((c) => simReport.includes(c));
  const simPlanned = (day) => planSimDay(day, params);
  const key = keyFor(params.report_column);

  const askRest = (id, date, title) => ctx.ask({
    id, date, title,
    body: `לסימולטור אין שעות בקבצים, והרומה לא מזכה על הפעילות השנייה. היא מזכה רק אם הייתה מנוחה חוקית (${params.legal_rest_hours} שעות לפחות) בין שתי הפעילויות, כלומר הן לא באותו FDP.`,
    options: [
      { value: 'separate', label: `הייתה מנוחה של ${params.legal_rest_hours} שעות לפחות`, hint: `${minToHhmm(H(params.hours))} על הפעילות השנייה` },
      { value: 'same_fdp', label: 'שתיהן באותו FDP', hint: 'אין פיצוי' },
    ],
    ruleId: rule.id,
  });

  // טיסה לא מתוכננת
  for (const m of ctx.matches) {
    if (m.how !== 'unplanned' || m.exec.cutAtStart) continue;
    // החלפה מרצוני, והוספה בהסכמה ביומן לפני הרומה (`ROOT` ב-js/rules/journal.js): אין פיצוי על
    // ההוספה עצמה (בעל המוצר, 06/10/2026).
    if (['voluntary_swap', 'added'].includes(ctx.answerFor(m)?.value)) continue;
    const u = m.exec;
    const span = pairingTimes(u, ctx.tz, { away: true });
    if (span.start == null) continue;
    const day = u.from;
    // הפעילות האחרת ביממה: מתוכננת (בכל סדר), או לא מתוכננת שהייתה לפניה (`dayActivity`; בעל המוצר,
    // 09/10/2026). כש-`special_call` כבר מצפה לפעילות השנייה (ביממה מתוכננת, `second_activity` על הסבב) – לא שוב.
    const act = dayActivity(ctx, u, day);
    if (act.pairing) {
      // ממתין לתשובה על הטיסה (`unplanned:`): בהוספה בהסכמה אין פיצוי.
      if (!ctx.pairingHandledBy(u, 'second_activity') && !ctx.isAsked(`unplanned:${u.id}`)) {
        // הרומה רשמה ביממה S/C מעבר למה שכבר צפוי: הפעילות השנייה רשומה כקריאה מיוחדת, באותו סכום (כמו ב-`special_call`).
        const asSc = ctx.paidOnDate(day, scColumn, 'sc', H(params.hours));
        ctx.expectPairing(u, asSc ? 'sc' : key, H(params.hours), rule,
          `${describePairing(u)} לא הייתה בתכנון, ובאותה יממה בוצעה גם ${describePairing(act.pairing.pairing)} עם מנוחה חוקית ביניהן`,
          { date: day, dates: [day], ...(asSc && { perDay: true, explain: 'פעילות שנייה ביממה. הרומה רשמה אותה כקריאה מיוחדת, באותו סכום.' }) });
      }
      continue;
    }
    if (act.sameFdp.length) {
      ctx.note(day, `${describePairing(u)} לא הייתה בתכנון, אבל היא באותו FDP עם ${act.sameFdp.map(describePairing).join(', ')}. אין פיצוי על פעילות שנייה (2024 ס' 42.7).`, rule);
      continue;
    }
    if (!act.sim) continue;
    const id = `second_activity:${u.id}`;
    const answered = ctx.answer(id);
    const a = answered ?? (ctx.paidOnDate(day, params.report_column, key, H(params.hours)) ? { value: 'separate' } : null);
    if (!a) askRest(id, day, `${describePairing(u)} לא הייתה בתכנון, ובאותה יממה היה סימולטור. האם הייתה מנוחה ביניהם?`);
    else if (a.value === 'separate') ctx.expectPairing(u, key, H(params.hours), rule, `${describePairing(u)} לא הייתה בתכנון, ובאותה יממה היה סימולטור ` +
      `(${answered ? 'לפי תשובתך, עם מנוחה חוקית ביניהם' : `הרומה מזכה את הפיצוי`})`, { date: day, dates: [day] });
  }

  // סבב מתוכנן שהתארך ליום שתוכננו בו טיסה או סימולטור (`extensionDays`; בעל המוצר, 06/10/2026): ההארכה
  // היא הפעילות השנייה ביום הזה. הסיבה נשאלת ב-`special_call` (`extended:`), והסכמה – אין פיצוי.
  for (const m of ctx.matches) {
    const ans = ctx.answerFor(m);
    if (['voluntary_swap', 'added'].includes(ans?.value) || (m.how === 'dates' && !ans)) continue;
    if (m.plan && ctx.pairingHandledBy(m.plan, 'cancelled_no_compensation')) continue;
    const ext = extensionDays(ctx, m);
    if (!ext?.second.length) continue;
    const reason = `extended:${m.exec.id}`;
    if (ctx.isAsked(reason) || ctx.answer(reason)?.value === 'agreed') continue;
    const span = pairingTimes(m.exec, ctx.tz, { away: true });
    for (const d of ext.second) {
      const what = `${describePairing(m.exec)} התארך ל-${ddmm(d)}`;
      const others = ctx.execPairings.filter((x) => x !== m.exec && x.dates.includes(d));
      const separate = others.find((o) => {
        const so = pairingTimes(o, ctx.tz, { away: true });
        const [first, second] = (so.start ?? 0) < span.start ? [so, span] : [span, so];
        return first.end != null && second.start != null && legalRestBetween(first, second, report, ctx.legalRest?.postMin) >= legal;
      });
      if (separate) {
        ctx.expectPairing(m.exec, key, H(params.hours), rule, `${what}, ובאותה יממה בוצעה גם ${describePairing(separate)} עם מנוחה חוקית ביניהן`,
          { date: d, dates: [d], explain: `הסבב התארך ל-${ddmm(d)}, ובאותה יממה בוצעה גם ${describePairing(separate)}.` });
        continue;
      }
      if (others.length) {
        ctx.note(d, `${what}, באותו FDP עם ${others.map(describePairing).join(', ')}. אין פיצוי על פעילות שנייה (2024 ס' 42.7).`, rule, { pairingId: m.exec.id });
        continue;
      }
      const id = `second_activity:${m.exec.id}:${d}`;
      const answered = ctx.answer(id);
      const a = answered ?? (ctx.paidOnDate(d, params.report_column, key, H(params.hours)) ? { value: 'separate' } : null);
      if (!a) askRest(id, d, `${what}, ובאותה יממה היה סימולטור. האם הייתה מנוחה ביניהם?`);
      else if (a.value === 'separate') ctx.expectPairing(m.exec, key, H(params.hours), rule, `${what}, ובאותה יממה היה סימולטור ` +
        `(${answered ? 'לפי תשובתך, עם מנוחה חוקית ביניהם' : 'הרומה מזכה את הפיצוי'})`, { date: d, dates: [d], explain: `הסבב התארך ל-${ddmm(d)}, ובאותה יממה היה סימולטור.` });
    }
  }

  // סימולטור לא מתוכנן ביום טיסה
  for (const day of ctx.timeline) {
    if (!isSimDay(day) || simPlanned(day)) continue;
    // הסימולטור הוא הפעילות השנייה כשהטיסה מתוכננת, או כשלא תוכננה והייתה לפניו; טיסה שלא תוכננה אחריו היא
    // השנייה, והשאלה עליה (בעל המוצר, 09/10/2026). סימולטור בלי שעות – כל טיסה.
    const simStart = (day.exec?.sims ?? []).filter((s) => s.std != null).map((s) => at(day.date, s.std)).sort((a, b) => a - b)[0];
    const flights = ctx.execPairings.filter((p) => p.dates.includes(day.date) &&
      (simStart == null || plannedPairing(p) || (pairingTimes(p, ctx.tz, { away: true }).start ?? Infinity) < simStart));
    if (!flights.length) continue;
    const id = `second_activity:sim:${day.date}`;
    const answered = ctx.answer(id);
    const a = answered ?? (ctx.paidOnDate(day.date, params.report_column, key, H(params.hours)) ? { value: 'separate' } : null);
    if (!a) askRest(id, day.date, `סימולטור ב-${ddmm(day.date)} לא היה בתכנון, ובאותה יממה בוצעה ${flights.map(describePairing).join(', ')}. האם הייתה מנוחה ביניהם?`);
    else if (a.value === 'separate') ctx.expect(day.date, key, H(params.hours), rule,
      `סימולטור לא מתוכנן ביממה עם טיסה (${answered ? 'לפי תשובתך, עם מנוחה חוקית ביניהם' : `הרומה מזכה את הפיצוי`})`);
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
    const [s1, s2] = [pairingTimes(p1, ctx.tz), pairingTimes(p2, ctx.tz)];
    if (s1.start == null || s1.end == null || s2.start == null || s1.flight == null) continue;
    if (isTurnaround(s1, legal, ctx) && isTurnaround(s2, legal, ctx)) continue; // רצף סבבים, 2018 ס' 55

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
          otherOption(),
        ],
        ruleId: rule.id,
      });
      continue;
    }
    if (a.value === 'other') {
      // שני החוקים שחולקים את השאלה מגיעים לכאן: הקרדיט נרשם פעם אחת.
      if (ctx.pairingHandledBy(p2, 'base_rest_other')) continue;
      ctx.markPairing(p2, 'base_rest_other');
      const rest = `מנוחה בבסיס קצרה מהחוזית לפני ${describePairing(p2)}`;
      if (!applyOtherReason(ctx, a, rule, { what: rest, date: p2.from, pairing: target })) {
        ctx.review(`${what}. ${a.text || 'סיבה אחרת'}. דורש בדיקה ידנית.`, rule);
      }
      continue;
    }
    if (a.value !== params.answer_value) continue;
    ctx.expectPairing(target, keyFor(params.report_column), H(params.hours), rule, what);
  }
}

// ---------- נחיתות לילה (2024 ס' 39–40) ----------

/**
 * טיסות בצי `fleet` שהנחיתה המתוכננת שלהן, בשעון ישראל, בין `window_from` ל-`window_to`,
 * ומסיימת FDP (`legEndsFdp`): הרגל האחרונה בסבב, או רגל שאחריה מנוחה חוקית ביעד. רגל
 * מחברת שממשיכה לרגל הבאה בלי מנוחה לא נבדקת, גם אם זמן נחיתתה בחלון – בסבב סגור בלי
 * מנוחה בדרך רק הנחיתה בבסיס בסוף הסבב רלוונטית (בעל המוצר, 26/09/2026).
 * כשתוכננו לפחות `min_planned_count` כאלה בחודש, מגיע פיצוי על כל טיסה כזאת שבוצעה, החל
 * מה-`paid_from_count`. ביטול או שינוי הצבה ביוזמת החברה נחשב ביצוע (ס' 40).
 * `base_landings_only`: רק נחיתות בבסיס. אחרת גם נחיתה בחו"ל שמסיימת FDP, אחרי המרה לשעון ישראל.
 * `counted_crews`: הרכבי הצוות שנספרים (single = 2 טייסים, augmented = 3, double = 4). נשאל על כל טיסה.
 */
const CREW_LABEL = { single: 'בודד', augmented: 'מוגבר', double: 'כפול' };
const CREW_PILOTS = { single: 2, augmented: 3, double: 4 };

/**
 * רגל i בסבב מסיימת FDP אם היא האחרונה בסבב, או שיש מנוחה חוקית (לפחות `legal`) בין
 * השחרור אחרי הנחיתה שלה לבין ההתייצבות לרגל הבאה (`rest`: הזמנים האלה, OMA 7.2.1). חסר
 * מידע לא נדלג בשקט: נספרת כמסיימת FDP.
 */
function legEndsFdp(ctx, legs, i, legal) {
  if (i === legs.length - 1) return true;
  const [a, b] = [legTimes(legs[i], ctx.tz), legTimes(legs[i + 1], ctx.tz)];
  if (a?.sta == null || !b) return true;
  const rest = ctx.legalRest;
  return b.std - a.sta - (rest?.postMin ?? 0) - (rest?.outstationReportMin ?? 0) >= legal;
}

/** שעת הנחיתה המתוכננת של רגל בשעון הבסיס (`legTimes`), או null. */
function arrivalClock(ctx, leg) {
  const t = legTimes(leg, ctx.tz);
  return t?.sta == null ? null : clockOf(t.sta);
}

/**
 * נחיתת לילה בסבב שבוצע (לזכייה במכרז במקום טיסת לילה מתוכננת): רגל פעילה בצי, שהנחיתה
 * המתוכננת שלה בשעון ישראל בחלון, ומסיימת FDP – הרגל האחרונה, או שאחריה מנוחה חוקית ביעד.
 * מחזירה את הרגל ואת שעת הנחיתה, או null.
 */
function execNightLanding(ctx, pairing, params, inWindow, legal) {
  const dh = (l) => l.dhd || l.type === 'DHO' || l.type === 'DHX';
  for (let i = 0; i < pairing.legs.length; i++) {
    const l = pairing.legs[i];
    if (dh(l) || !legEndsFdp(ctx, pairing.legs, i, legal)) continue;
    if (params.base_landings_only && l.dst !== ctx.domicile) continue;
    if (params.fleet && (l.ac ?? ctx.fleet) !== params.fleet) continue;
    const clock = arrivalClock(ctx, l);
    if (clock != null && inWindow(clock)) return { leg: l, clock };
  }
  return null;
}

function night_landings(ctx, params, rule) {
  if (!ctx.hasPlan) {
    ctx.note(null, `נחיתות לילה נבדקות לפי התכנון, ובלי קובץ תכנון הן לא נבדקו.`, rule);
    return;
  }
  const from = parseClock(params.window_from);
  const to = parseClock(params.window_to);
  const inWindow = (clock) => clock >= from && clock <= to;
  const legal = H(params.legal_rest_hours);

  const night = [];
  const unsure = []; // נחיתה בחו"ל שאי אפשר להמיר לשעון ישראל, ושבטווח ההפרשים האפשרי עשויה להיות בחלון
  for (const p of ctx.planPairings) {
    p.legs.forEach((leg, i) => {
      if (leg.dh || !leg.arr) return;
      if (!legEndsFdp(ctx, p.legs, i, legal)) return;
      if (params.base_landings_only && leg.dst !== ctx.domicile) return;
      if (params.fleet && (leg.ac ?? ctx.fleet) !== params.fleet) return;
      const clock = arrivalClock(ctx, leg);
      if (clock == null) {
        const local = leg.arr.min;
        if ([-180, 0, 180].some((d) => inWindow(mod(local + d, 1440)))) unsure.push(leg);
        return;
      }
      if (inWindow(clock)) night.push({ pairing: p, leg, clock });
    });
  }
  // נחיתה לא ודאית נשלחת לבדיקה רק כשהיא יכולה לשנות את התוצאה.
  if (unsure.length && night.length + unsure.length >= params.min_planned_count) {
    for (const leg of unsure) {
      ctx.review(`${ddmm(leg.date)} ${leg.flight}: הנחיתה ב-${leg.dst} היא ${minToHhmm(leg.arr.min)} שעון מקומי, והשדה לא בטבלת אזורי הזמן, כך שלא ידוע ההפרש לשעון ישראל. ` +
        `לא ניתן לדעת אם היא נחיתת לילה, וזה משנה את ${rule.title}. דורש בדיקה ידנית.`, rule);
    }
  }
  const min = params.min_planned_count;
  const crews = params.counted_crews;
  const crewNames = crews ? crews.map((c) => CREW_LABEL[c] ?? c).join(' או ') : '';
  const nightWord = `טיסות לילה${crews ? ` בצוות ${crewNames}` : ''}`;
  const landing = `שנוחתות בין ${params.window_from} ל-${params.window_to}`;
  const names = (items) => items.map((n) => `${ddmm(n.leg.date)} ${n.leg.flight}`).join(', ');
  // פחות מהמינימום, בכל הרכב צוות: אין פיצוי, ואין הערה (בעל המוצר, 04/10/2026).
  if (night.length < min) return;

  // מה נחשב ביצוע: הטיסה בדוח, או ביטול ושינוי הצבה ביוזמת החברה (ס' 40). הסיבה נשאלת
  // במקום אחד בלבד, בשאלה על הסבב שלא בוצע, וכאן רק קוראים מה יצא ממנה.
  if (ctx.hasExec) {
    for (const n of night) {
      n.target = ctx.execPairings.find((e) => e.legs.some((l) => l.flight === n.leg.flight && l.type !== 'DHO' &&
        Math.abs(Date.parse(l.date) - Date.parse(n.leg.date)) <= dayMs)) ?? null;
      if (n.target) { n.status = 'done'; continue; }
      n.status = cancelStatus(ctx, n.pairing);
      // זכייה במכרז אינה "ביוזמת החברה", אבל זכייה בטיסה עם נחיתת לילה אינה פוגעת בזכאות (ס' 40;
      // בעל המוצר, 05/10/2026): נספרת רק כשהטיסה שבקישור היא גם נחיתת לילה.
      if (n.status === 'bid') {
        const won = bidTarget(ctx, n.pairing);
        const landing = won && execNightLanding(ctx, won, params, inWindow, legal);
        n.status = landing ? 'done' : 'no';
        n.bid = { won, landing };
        if (landing) n.target = won;
      }
    }
  } else {
    for (const n of night) { n.target = n.pairing; n.status = 'done'; }
  }
  // הרגל שהרכב הצוות שלה קובע: הטיסה שבוצעה (בזכייה במכרז – זו שזכה בה). טיסה שלא בוצעה אין
  // את מי לשאול עליה: הצוות החוזי לפי ה-FDP המתוכנן (בעל המוצר, 06/10/2026).
  for (const n of night) {
    n.crewLeg = !ctx.hasExec ? n.leg : n.target ? n.bid?.landing?.leg ?? n.leg : null;
    if (!n.crewLeg) n.contract = contractCrewOf(ctx, n.leg);
  }
  // הרכב הצוות משנה רק כשבלעדיו נספרות לפחות `min` טיסות.
  const live = night.filter((n) => n.status === 'done' || n.status === 'company');
  if (live.length >= min) for (const n of live) if (n.crewLeg) ctx.crewMatters?.(n.crewLeg.date, n.crewLeg.flight);
  const threshold = params.paid_from_count;
  const key = keyFor(params.report_column);
  const hours = H(params.hours);
  // הרכב הצוות נשאל גם בבדיקת מגבלות החוק, על ה-FDP כולו: תשובה אחת משמשת את שתיהן.
  const crewAnswer = (n) => (n.crewLeg
    ? ctx.answer(`night_crew:${n.crewLeg.date}:${n.crewLeg.flight}`) ?? ctx.legalCrewAnswer(n.crewLeg)
    : n.contract && { value: n.contract, source: 'contract' });
  const crewOf = (n) => crewAnswer(n)?.value;
  const byContract = (n) => crewAnswer(n)?.source === 'contract';

  // נספרות רק טיסות בהרכב צוות מ-`counted_crews` (2024 ס' 39–40: בודד או מוגבר). ההרכב אינו
  // בקבצים, ולכן מניחים תחילה שכל טיסה שלא נענתה נספרת: ההרכב יכול רק להוריד את המספר, וזאת
  // התוצאה הגבוהה האפשרית. רק אם תחתיה מגיע פיצוי שהדוח לא זיכה, נשאלת שאלה על הרכב הצוות
  // (החלטת בעל המוצר, 23/09/2026). מרגע שתוכננו `min_planned_count` טיסות לילה, בכל הרכב, כל
  // מסלול מסתיים בהערה שמסבירה את המצב ואת הסיבה – גם כשאין פיצוי (בעל המוצר, 23/09/2026 ו‑04/10/2026).
  const pool = crews ? night.filter((n) => crewOf(n) == null || crews.includes(crewOf(n))) : night;
  const list = (items) => items.map((n) => `${ddmm(n.leg.date)} ${n.leg.flight}${n.status === 'company' ? ' – שינוי ביוזמת החברה'
    : n.bid?.landing ? ` – זכייה במכרז ב-${ddmm(n.bid.landing.leg.date)} ${n.bid.landing.leg.flight}, גם היא נחיתת לילה` : ''}`).join(', ');
  // כשהרכב הצוות ידוע בכל הטיסות, סופרים רק את אלה שבהרכב שנספר (בעל המוצר, 04/10/2026).
  const known = crews && night.every((n) => crewOf(n) != null);
  const base = known ? pool : night;
  const planned = `תוכננו ${base.length} ${known ? nightWord : 'טיסות לילה'} ${landing}`;
  // ליד כל טיסה שהרכב הצוות שלה אינו ידוע – למה: בדרך כלל היא אינה ביומן, כי הוחלפה או בוטלה.
  const listCrew = (items) => items.map((n) => `${list([n])}${crewOf(n) != null ? '' : ctx.inCalendar(n.leg.date, n.leg.flight) === false ? ' – אינה ביומן והרכב הצוות שלה אינו ידוע' : ' – הרכב הצוות אינו ידוע'}`).join(', ');
  // פחות מהמינימום גם כשכל טיסה שהרכב הצוות שלה אינו ידוע נספרת: בטוח שאין פיצוי. ההערה אומרת
  // אילו טיסות אינן נספרות בגלל הרכב הצוות שלהן (בעל המוצר, 04/10/2026).
  if (crews && pool.length < min) {
    const out = night.filter((n) => !pool.includes(n));
    const each = out.map((n) => `${ddmm(n.leg.date)} ${n.leg.flight} ${byContract(n) ? `לא בוצעה, והצוות החוזי בה ${CREW_LABEL[crewOf(n)]}`
      : `בצוות ${CREW_LABEL[crewOf(n)] ?? crewOf(n)}`}`);
    const which = each.length > 1 ? `${each.slice(0, -1).join(', ')} ו-${each.at(-1)}` : each[0];
    ctx.note(null, `תוכננו ${night.length} טיסות לילה ${landing}, אבל ${which}, ו${out.length === 1 ? 'אינה נספרת' : 'אינן נספרות'}. ` +
      `${pool.length === 1 ? 'נשארה אחת' : pool.length ? `נשארו ${pool.length}` : 'לא נשארה אף אחת'}, ולכן אין פיצוי.`, rule);
    return;
  }

  const counted = pool.filter((n) => n.status === 'done' || n.status === 'company');
  const unsettled = pool.filter((n) => n.status === 'unknown' || n.status === 'review');
  if (counted.length + unsettled.length < threshold) {
    const missed = pool.filter((n) => !counted.includes(n));
    // זכייה במכרז בטיסה שאינה נחיתת לילה אינה "ביוזמת החברה" (ס' 40), ולכן אינה נספרת.
    const bids = missed.filter((n) => n.bid);
    const others = missed.filter((n) => !n.bid);
    const reasons = [
      bids.length ? `${names(bids)} ${bids.length === 1 ? 'הוחלפה' : 'הוחלפו'} בזכייה במכרז ` +
        `${bids.every((n) => n.bid.won) ? 'בטיסה שאינה נחיתת לילה' : 'בטיסה שאינה בקבצים של החודש'}, וזכייה במכרז נספרת רק בטיסה שגם היא נחיתת לילה (ס' 40)` : '',
      others.length ? `${others.length === 1 ? 'אחת לא בוצעה (בוטלה או הוחלפה' : `${others.length} לא בוצעו (בוטלו או הוחלפו`} שלא ביוזמת החברה)` : '',
    ].filter(Boolean);
    // כאן תמיד בהרכב שנספר: טיסה שהרכב הצוות שלה אינו ידוע נספרת, וגם כך אין פיצוי (בעל המוצר, 04/10/2026).
    ctx.note(null, `תוכננו ${pool.length} ${nightWord} ${landing}, ונספרות רק ${counted.length}` +
      `${reasons.length ? `, כי ${reasons.join(', ו')}` : ''}. הפיצוי הוא מהטיסה ה-${threshold} שבוצעה, ולכן אין פיצוי.`, rule);
    return;
  }
  // הספירה אינה סגורה כל עוד לא ידוע למה סבב לא בוצע. השאלה על כך כבר נשאלה בחוק הסבב
  // שלא בוצע, ולכן כאן לא שואלים שוב (החלטת בעל המוצר, 23/09/2026), אלא מסבירים במה זה תלוי.
  // גם על הרכב הצוות לא שואלים עד שהיא תיסגר: עד אז לא ידוע אם בכלל מגיע פיצוי.
  if (counted.length < threshold) {
    const why = `נספרות ${counted.length} טיסות מתוך ${pool.length} מתוכננות עם נחיתה בין ` +
      `${params.window_from} ל-${params.window_to}, והפיצוי הוא מהטיסה ה-${threshold} שבוצעה`;
    const reviewed = unsettled.filter((x) => x.status === 'review');
    for (const n of reviewed) {
      ctx.review(`${ddmm(n.leg.date)} ${n.leg.flight} לא בוצעה, והסיבה שנרשמה עליה היא "סיבה אחרת", כך שלא ידוע אם זה היה ביוזמת ` +
        `החברה – ורק אז היא נספרת (ס' 40). ${why}. דורש בדיקה ידנית.`, rule);
    }
    const pending = unsettled.filter((x) => x.status === 'unknown');
    if (pending.length) {
      const many = pending.length > 1;
      ctx.note(null, `${why}. ${list(pending)} ${many ? 'לא בוצעו (בוטלו או הוחלפו שלא ביוזמת החברה)' : 'לא בוצעה (בוטלה או הוחלפה שלא ביוזמת החברה)'}, וביטול או שינוי הצבה ביוזמת החברה ` +
        `נחשב ביצוע (ס' 40). הספירה תיסגר לפי התשובה על ${many ? 'הסבבים שלא בוצעו' : 'הסבב שלא בוצע'}.`, rule);
    } else {
      const many = reviewed.length > 1;
      ctx.note(null, `${why}. ${list(reviewed)} לא ${many ? 'בוצעו' : 'בוצעה'}, והסיבה שנרשמה ` +
        `${many ? 'עליהן' : 'עליה'} היא "סיבה אחרת", ולכן לא ידוע אם ${many ? 'הן נספרות' : 'היא נספרת'} ` +
        `(ס' 40). הספירה תיסגר אחרי הבדיקה הידנית.`, rule);
    }
    return;
  }

  counted.sort((a, b) => a.leg.date.localeCompare(b.leg.date) || a.clock - b.clock);
  const paying = counted.slice(threshold - 1);
  // טיסה שלא בוצעה ואין לה צוות חוזי (FDP שאינו עומד באף הרכב) אינה נשאלת, ונשארת בהנחה שהיא נספרת.
  const open = crews ? pool.filter((n) => crewOf(n) == null && n.crewLeg) : [];
  // בתכנון לבד הרכב הצוות אינו נשאל (בעל המוצר, 03/10/2026): ייתכן שמגיע פיצוי, וזה ייבדק אחרי
  // שתועלה הרומה (בעל המוצר, 04/10/2026).
  if (open.length && !ctx.hasExec) {
    const what = open.length === pool.length ? ` (${names(pool)}), והרכב הצוות ${pool.length === 1 ? 'שלה' : 'שלהן'} אינו ידוע` : ` (${listCrew(pool)})`;
    ctx.note(null, `תוכננו ${pool.length} טיסות לילה ${landing}${what}. ` +
      `המינימום הוא ${min}, כך שייתכן שמגיע פיצוי, וזה ייבדק אחרי הביצוע.`, rule);
    return;
  }
  if (open.length) {
    const unpaid = paying.filter((n) => !(n.target ? ctx.paidOn(n.target, params.report_column, key, hours)
      : ctx.paidOnDate(n.pairing.from, params.report_column, key, hours)));
    if (!unpaid.length) {
      const one = paying.length === 1;
      ctx.note(null, `${planned}, והרומה מזכה ${minToHhmm(hours)} על ` +
        `${names(paying)}. לכן ${one ? 'היא בוצעה' : 'הן בוצעו'} בצוות ${crewNames}, ` +
        'ולא נשאלה שאלה על הרכב הצוות.', rule);
    } else {
      // שואלים אחת בכל פעם, מהטיסה הארוכה ביותר (בקשת בעל המוצר, 23/09/2026): תשובה שאינה
      // נספרת מורידה את המספר ומייתרת את השאר, והסיכוי לכך גדול יותר בטיסה ארוכה.
      const block = (n) => legBlock(ctx, n.crewLeg) ?? n.crewLeg.skdDur ?? 0;
      const next = [...open].sort((a, b) => block(b) - block(a) || a.crewLeg.date.localeCompare(b.crewLeg.date))[0];
      const leg = next.crewLeg;
      const clock = next.bid?.landing?.clock ?? next.clock;
      // השאלה על הרכב הצוות כבר נשאלה בבדיקת מגבלות החוק, על ה-FDP של הטיסה הזאת.
      const pendingLegal = ctx.legalCrewAsked(leg);
      ctx.note(null, `${planned}. תחת ההנחה שכל טיסה שעדיין לא נענתה היא בצוות ` +
        `${crewNames}, מגיע פיצוי של ${minToHhmm(hours)}.`, rule);
      // בתכנון לבד הרכב הצוות אינו נשאל (בעל המוצר, 03/10/2026): ההערה כבר אומרת תחת איזו הנחה מגיע פיצוי.
      if (!pendingLegal && ctx.hasExec) ctx.ask({
        id: `night_crew:${leg.date}:${leg.flight}`,
        date: leg.date,
        title: `נחיתת לילה: באיזה צוות בוצעה ${leg.flight} ב-${ddmm(leg.date)} (נחיתה ${minToHhmm(clock)} שעון ישראל)?`,
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
  const counts = counted.length === base.length
    ? `תוכננו ונספרות ${base.length} ${known ? nightWord : 'טיסות לילה'} ${landing}`
    : `${planned}, ונספרות ${counted.length}`;
  // טיסות שלא בוצעו: הרכב הצוות הוא הצוות החוזי, וההערה אומרת זאת.
  const byPlan = counted.filter(byContract);
  const contractNote = !byPlan.length ? '' : ` הרכב הצוות ב-${names(byPlan)}, ${byPlan.length === 1 ? 'שלא בוצעה, הוא' : 'שלא בוצעו, הוא'} ` +
    `הצוות החוזי (${[...new Set(byPlan.map((n) => CREW_LABEL[crewOf(n)]))].join(' או ')}).`;
  ctx.note(null, `${counts} (${list(counted)}). הפיצוי הוא מהטיסה ה-${threshold} שבוצעה, ` +
    `ולכן מגיע פיצוי של ${minToHhmm(hours)} על ${names(paying)}.${contractNote}`, rule);
  paying.forEach((n) => {
    const why = `${ddmm(n.leg.date)} ${n.leg.flight}, נחיתה ${minToHhmm(n.clock)} שעון ישראל: הטיסה ה-${counted.indexOf(n) + 1} מתוך ` +
      `${base.length} מתוכננות עם נחיתת לילה${known ? ` בצוות ${crewNames}` : ''}` +
      (n.bid?.landing ? ` (זכייה במכרז ב-${ddmm(n.bid.landing.leg.date)} ${n.bid.landing.leg.flight}, גם היא נחיתת לילה)` : '');
    if (n.target) ctx.expectPairing(n.target, key, hours, rule, why);
    else ctx.expect(n.pairing.from, key, hours, rule, `${why} (בוטלה ביוזמת החברה)`);
  });
}

/**
 * סבב מתוכנן שלא בוצע, לעניין ס' 40: ביטול או שינוי הצבה ביוזמת החברה נחשב ביצוע.
 * הסיבה נשאלת פעם אחת בלבד, בשאלה על הסבב שלא בוצע, שרצה לפני החוק הזה. הקריאה כאן היא
 * לפי הסימונים שהחוקים הקודמים שמו על הסבב, ולא לפי התשובה בלבד: כשהדוח כבר מזכה את
 * השעות שהפסיד לא נשאלת שאלה, והסבב מסומן `lost_hours_credit` (החלטת בעל המוצר, 23/09/2026).
 * `company` נספר כבוצע, `no` לא נספר, `review` נדרשת בדיקה ידנית, `unknown` השאלה עוד פתוחה.
 * `bid` – זכייה במכרז: אינה "ביוזמת החברה" (ס' 40), ולכן אינה נספרת, אלא אם הטיסה שזכה בה
 * מאותו סוג (נחיתת לילה, שבת). את זה בודק החוק עצמו, לפי הטיסה שבקישור (`bidTarget`).
 */
function cancelStatus(ctx, planPairing) {
  const m = ctx.matches.find((x) => x.plan === planPairing);
  if (!m) return 'unknown';
  if (m.byLeave) return 'no'; // היעדרות ומחלה אינן ביוזמת החברה
  if (m.how === 'replaced_by_ground' || m.how === 'replaced_by_standby') return 'company'; // החברה הציבה אותו לפעילות קרקע או לכוננות
  if (m.how === 'carried_over') return 'company'; // הצוות עוד היה בחו"ל, בסבב מהחודש הקודם (`explainByCarriedStay`)
  // שרשרת מהיומן: השלב הראשון, זה שהוציא את הסבב מהשיבוץ, קובע (`reduceChain`; בעל המוצר, 06/10/2026).
  const count = ctx.answerFor(m)?.count;
  if (count) {
    if (count === 'voluntary_swap') return 'no';
    if (count === 'bid') return 'bid';
    if (count === 'other') return 'review';
    if (count === 'chain_open') return 'unknown';
    return 'company';
  }
  const by = (tag) => ctx.pairingHandledBy(planPairing, tag);
  if (by('lost_hours_credit') || by('cancelled_no_compensation')) return 'company';
  if (by('voluntary_swap')) return 'no';
  if (by('diversion')) return 'company'; // סטיה לשדה משנה שהונחה מהקבצים (`assumeDiversion`)
  // גם בלי סימון, כשהחוק שמסמן אינו בתוקף בחודש: התשובה עצמה.
  const a = ctx.answerFor(m)?.value;
  if (a === 'voluntary_swap') return 'no';
  if (a === 'bid') return 'bid';
  if (['cancelled', 'wet_lease', 'trainee', 'swap_777', 'replaced', 'diversion'].includes(a)) return 'company';
  if (a === 'other') return 'review';
  return 'unknown';
}

/**
 * הטיסה שזכה בה במכרז במקום הסבב המתוכנן: הקישור שבתשובה, או null (טיסה בחודש אחר). תשובה
 * שהגיעה דרך הסבב שבוצע באותם ימים (`via`) או שנשמרה בלי קישור – הסבב שבוצע באותם ימים,
 * כמו ב-`higher_of_planned_performed`.
 */
function bidTarget(ctx, planPairing) {
  const m = ctx.matches.find((x) => x.plan === planPairing);
  const a = m && ctx.answerFor(m);
  if (!a) return null;
  // שרשרת מהיומן: הסבב שזכה בו בשלב הראשון.
  if ('countLink' in a) return a.countLink ? ctx.pairingById(a.countLink) : null;
  if ('link' in a) return a.link ? ctx.pairingById(a.link) : null;
  return m.exec ?? null;
}

// ---------- פעילות בתאריכים מיוחדים (2024 ס' 42.1–42.5) ----------

/**
 * תאריך אירוע שאינו קבוע משנה לשנה ואינו בקבצים, כמו פתיחת שנת הלימודים: המשתמש בוחר
 * אותו ביומן (בקשת בעל המוצר, 24/09/2026). ברירת המחדל היא `default_day` בחודש, ואם הוא
 * חל באחד מימי `skip_weekdays` – היום שאחריו. עד שנבחר תאריך השאלה היא הפריט הפתוח, ואחרי
 * הבחירה החוק נבדק כרגיל: לפי הביצוע כשיש, ואחרת לפי התכנון. שואלים רק כשהרומה לא זיכתה
 * (בעל המוצר, 01/10/2026): כשהיא כבר מזכה את הפיצוי על פעילות בחלון של ברירת המחדל, התאריך
 * מונח בלי לשאול. `chosen` – התאריך נבחר ביומן.
 */
function occasionDate(ctx, occ) {
  const ask = occ.ask_date;
  const answered = ctx.answer(`${ask.id}:${ctx.period.year}`);
  if (answered?.value) return { date: answered.value, chosen: true };
  let def = isoDate(ctx.period.year, ctx.period.month, ask.default_day ?? 1);
  while ((ask.skip_weekdays ?? []).includes(weekday(def))) def = addDays(def, 1);
  return { date: def, chosen: false };
}

function askOccasionDate(ctx, occ, rule, def) {
  const ask = occ.ask_date;
  const id = `${ask.id}:${ctx.period.year}`;
  ctx.ask({
    id,
    date: def,
    title: `${occ.title}: מה התאריך השנה?`,
    body: `התאריך אינו בקבצים והוא משתנה משנה לשנה. בחר אותו ביומן, ואחריו ייבדק אם הייתה פעילות ` +
      `${ctx.hasExec ? 'בביצוע' : 'בתכנון'} בין ${occ.from.time} ל-${occ.to.time}. ברירת המחדל: ${ddmm(def)}.`,
    options: [],
    dateInput: { value: def, min: ctx.monthFirst, max: ctx.timeline.at(-1).date },
    ruleId: rule.id,
  });
}

/**
 * פעילות בחלון זמן סביב תאריך מסוים: ערב יום הזיכרון ויום הזיכרון, יום העצמאות, היום
 * הראשון ללימודים. התאריכים לכל שנה ב-`occasions[].dates`, או נבחרים ביומן (`ask_date`).
 * חל גם על שהייה מחוץ לבסיס (ס' 42.5), ולכן כל טווח הסבב נבדק, מההתייצבות ועד
 * הנחיתה בבסיס. פיצוי נפרד לכל אירוע.
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
    let date = occ.dates?.[String(ctx.period.year)];
    // תאריך שאינו קבוע משנה לשנה ואינו בקבצים: המשתמש בוחר אותו ביומן. עד הבחירה נבדקת
    // ברירת המחדל, רק כדי לראות אם הרומה כבר מזכה עליה; אם לא – שואלים, ולא בודקים דבר.
    let askDate = null;
    if (!date && occ.ask_date && (occ.months ?? []).includes(ctx.period.month)) {
      const picked = occasionDate(ctx, occ);
      date = picked.date;
      if (!picked.chosen) askDate = () => askOccasionDate(ctx, occ, rule, picked.date);
    }
    if (!date) {
      if ((occ.months ?? []).includes(ctx.period.month)) {
        ctx.review(`${occ.title}: אין ב-rules.json תאריך לשנת ${ctx.period.year}, ולכן החוק לא נבדק. נדרש עדכון של קובץ החוקים.`, rule);
      }
      continue;
    }
    const wFrom = at(addDays(date, occ.from.day_offset), parseClock(occ.from.time));
    const wTo = at(addDays(date, occ.to.day_offset), parseClock(occ.to.time));
    if (wTo <= monthStart || wFrom >= monthEnd) { askDate?.(); continue; }
    const window = `${ddmm(dateOf(wFrom))} ${hhmm(wFrom)} – ${ddmm(dateOf(wTo))} ${hhmm(wTo)}`;
    // ההסבר שמוצג מתחת לטיסה, קצר: שהייתה פעילות מטעם החברה בשעות האלה, בלי הסכום (בעל המוצר,
    // 01/10/2026). שם האירוע בראשו רק כשהוא אינו שם החוק, שמוצג ליד (ערב יום הזיכרון).
    const span = dateOf(wFrom) === dateOf(wTo - 1) ? `בין ${hhmm(wFrom)} ל-${hhmm(wTo)}` : `בחלון ${window}`;
    const explain = `${occ.title === rule.title ? '' : `${occ.title}: `}${ctx.hasExec ? 'בוצעה' : 'מתוכננת'} פעילות מטעם החברה ${span}.`;

    let hit = null;
    for (const p of pairings) {
      const s = pairingTimes(p, ctx.tz, { away: ctx.hasExec });
      const start = s.start != null ? s.start - report : monthStart;
      const end = s.end ?? monthEnd;
      if (start < wTo && end > wFrom) { hit = p; break; }
    }
    if (hit) {
      if (askDate && !ctx.paidOn(hit, params.report_column, key, H(params.hours))) { askDate(); continue; }
      ctx.expectPairing(hit, key, H(params.hours), rule, `${occ.title}: ${describePairing(hit)} בחלון ${window}`, { explain });
      continue;
    }
    if (params.flight_activity_only) { askDate?.(); continue; }

    const days = ctx.timeline.filter((d) => d.date >= dateOf(wFrom) && d.date <= dateOf(wTo - 1));
    const coded = days.find((d) => ctx.activityCodes(d).length);
    if (!coded || (askDate && !ctx.paidOnDate(coded.date, params.report_column, key, H(params.hours)))) { askDate?.(); continue; }
    const id = `occasion:${rule.id}:${date}`;
    const answered = ctx.answer(id);
    const a = answered ?? (ctx.paidOnDate(coded.date, params.report_column, key, H(params.hours)) ? { value: 'yes' } : null);
    if (!a) {
      ctx.ask({
        id,
        date: coded.date,
        title: `${occ.title}: האם היית בפעילות מטעם החברה בין ${hhmm(wFrom)} ל-${hhmm(wTo)}?`,
        body: `ב-${ddmm(coded.date)} רשום ${ctx.activityCodes(coded).join(', ')}, אין בקבצים שעות לפעילות הזאת, והרומה לא מזכה עליה.`,
        options: [
          { value: 'yes', label: 'כן', hint: `${minToHhmm(H(params.hours))} – פער מול הרומה` },
          { value: 'no', label: 'לא', hint: 'אין פיצוי' },
        ],
        ruleId: rule.id,
      });
    } else if (a.value === 'yes') {
      ctx.expect(coded.date, key, H(params.hours), rule, `${occ.title}: ${ctx.activityCodes(coded).join(', ')} בחלון ${window} ` +
        `(${answered ? 'לפי תשובתך' : `הרומה מזכה את הפיצוי`})`, { explain });
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
 * `on_block_until` (כולל) נחשב פנוי. סבב שבוטל ללא קרדיט אינו חוסם את ימיו, גם כשבוצע בהם
 * סבב אחר: הם נספרים כימים ללא פעילות (בעל המוצר, 24/09/2026). המינימום לפי הקרדיט המתוכנן (Sum בסיכום התכנון) והצי
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
  const dropped = ctx.planPairings.filter((p) => ctx.pairingHandledBy(p, 'cancelled_no_compensation'));
  const spans = spansOf(ctx, ctx.planPairings.filter((p) => !dropped.includes(p)), (p) => pairingTimes(p, ctx.tz));
  const free = ctx.timeline.filter((day) => {
    if (ctx.planActivityCodes(day).length) return false;
    const d0 = at(day.date, 0);
    return !spans.some((sp) => overlapsDay(sp, day.date) &&
      !(sp.start >= d0 + offFrom && sp.end >= d0 + 1440) && !(sp.start < d0 && sp.end <= d0 + onUntil));
  }).map((d) => d.date);

  // X ב-1 לחודש בלי טיסה ביום: ייתכן שזו נחיתה של סבב מהחודש הקודם, שאינו בתכנון. עד התשובה
  // היום לא נספר. שואלים רק כשהתשובה יכולה להוריד את מספר הימים מתחת למינימום (החלטת בעל
  // המוצר, 23/09/2026), גם כשחסר יום אחד בלבד ולא מגיע עליו זיכוי: המספר עצמו צריך להיות נכון.
  // עם רומה אין מה לנחש ואין מה לשאול (בעל המוצר, 01/10/2026): היא חוזרת ביום 1 על סבב שיצא
  // בחודש הקודם, ולכן ידוע אם נחתת בו ומתי. בלי סבב כזה ה-X הוא יום פנוי, גם כשבוצעה בו
  // פעילות שלא תוכננה – עליה נשאלת השאלה על פעילות ביום לא מתוכנן. בתכנון לבד, כשהיומן מראה ביום
  // הזה טיסה שיוצאת מהבסיס, גם הוא מראה שלא נחתת בו מסבב של החודש הקודם.
  const first = ctx.timeline.find((d) => d.date === ctx.monthFirst);
  let pendingFirst = false;
  const firstIsX = free.includes(ctx.monthFirst) && (first?.plan?.codes ?? []).includes('X');
  const carried = ctx.hasExec ? ctx.execPairings.find((p) => p.cutAtStart) : null;
  const landed = carried ? pairingTimes(carried, ctx.tz).end : null;
  if (firstIsX && ctx.hasExec && (!carried || landed != null)) {
    if (carried && landed > at(ctx.monthFirst, onUntil)) {
      free.splice(free.indexOf(ctx.monthFirst), 1);
      // הערה רק כשהיום מוריד את המספר מתחת למינימום (בעל המוצר, 04/10/2026).
      if (free.length < due) ctx.note(ctx.monthFirst, `${rule.title}: ב-${ddmm(ctx.monthFirst)} מסומן X, אבל לפי הרומה נחתת מסבב של החודש הקודם (${describePairing(carried)}) ב-${ddmm(dateOf(landed))} ${hhmm(landed)}, אחרי ${params.on_block_until}, ולכן היום אינו נספר.`, rule);
    }
  } else if (firstIsX && ctx.calendarFirstDay(ctx.monthFirst)?.carried === false) {
    // היומן מראה טיסה ב-1 לחודש שיוצאת מהבסיס, ולא סבב מהחודש הקודם: לא נחתת בו מסבב כזה, וה-X
    // הוא יום פנוי לפי התכנון, כמו עם רומה (בעל המוצר, 04/10/2026). הטיסה עצמה בשינויים.
  } else if (firstIsX) {
    const fid = `free_days_first:${ctx.monthFirst.slice(0, 7)}`;
    const fa = ctx.answer(fid);
    if (fa?.value !== 'free') free.splice(free.indexOf(ctx.monthFirst), 1);
    // גם בלי היום יש מספיק ימים: התשובה לא תשנה דבר. היום אינו נספר, בלי הערה ובלי שאלה (בעל המוצר, 04/10/2026).
    if (!fa && free.length < due) {
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
    (dropped.length ? ` (כולל ימי ${dropped.map(describePairing).join(', ')}, שבוטלו ללא קרדיט)` : '') +
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
  // "היום השני" נספר מבין הימים שוויתרת עליהם לבקשת החברה בלבד (2024 ס' 33), ולכן ויתור מרצון
  // על חלק מהימים מוריד את הפיצוי לפי מה שנשאר לבקשת החברה (בעל המוצר, 29/09/2026).
  const paidFor = (companyDays) => Math.max(0, companyDays - (params.paid_from_day - 1));
  const days = (n) => (n === 1 ? 'יום אחד' : `${n} ימים`);
  if (!a) {
    ctx.ask({
      id,
      date: ctx.monthFirst,
      title: `ימים ללא פעילות: חסרים ${missing}. האם הוויתור היה לבקשת החברה?`,
      body: `${what}. הימים הפנויים: ${free.map(ddmm).join(', ')}.`,
      options: [
        { value: 'company', label: 'לבקשת החברה', hint: `מגיע פיצוי ${minToHhmm(paidDays * H(params.hours))}` },
        { value: 'own', label: 'ויתור מרצון', hint: 'אין פיצוי' },
        // ויתור מרצון על כל החסרים הוא האפשרות הקודמת, ולכן הבחירה עד אחד פחות.
        { value: 'partial', label: 'ויתרתי מרצוני על', hint: 'מגיע פיצוי על הימים שלא ויתרתי מרצוני',
          count: Array.from({ length: missing - 1 }, (_, i) => ({ value: i + 1, label: days(i + 1) })) },
      ],
      ruleId: rule.id,
    });
    return;
  }
  const own = a.value === 'own' ? missing : a.value === 'partial' ? Math.min(missing, Math.max(0, Number(a.count) || 0)) : 0;
  const n = paidFor(missing - own);
  if (a.value === 'partial' && n) {
    ctx.expect(ctx.monthFirst, key, n * H(params.hours), rule,
      `${what}: ${missing} ימים חסרים, על ${days(own)} מהם ויתרת מרצונך, פיצוי על ${n} (מהיום השני שלבקשת החברה)`);
  } else if (a.value === 'partial') {
    ctx.note(null, `${what}. ויתרת מרצונך על ${days(own)} מתוך ${missing}, ולבקשת החברה ${missing - own === 1 ? 'נשאר יום אחד' : `נשארו ${missing - own}`}. ` +
      `הפיצוי רק מהיום השני שלבקשת החברה, ולכן לא מגיע.`, rule);
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
  const planSpans = ctx.hasPlan ? spansOf(ctx, ctx.planPairings, (p) => pairingTimes(p, ctx.tz)) : [];
  const execSpans = ctx.hasExec ? spansOf(ctx, ctx.execPairings, (p) => pairingTimes(p, ctx.tz, { away: true })) : [];
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
    if (s.start == null || s.end == null || !isTurnaround(s, legal, ctx)) return [];
    const d0 = dateOf(s.start - report);
    return [d0, addDays(d0, 1)].filter((d) => s.start - report < at(d, to) && s.end > at(d, from));
  };

  const planned = new Map(); // לילה → סבב מתוכנן
  for (const p of planPairingsSorted(ctx)) {
    for (const d of nightsOf(pairingTimes(p, ctx.tz))) if (!planned.has(d)) planned.set(d, p);
  }
  const performed = new Map(); // לילה → סבב ביצוע
  if (ctx.hasExec) {
    for (const e of ctx.execPairings) {
      for (const d of nightsOf(pairingTimes(e, ctx.tz))) if (!performed.has(d)) performed.set(d, e);
    }
  }
  // done / company / no / unknown
  const statusOf = (d) => {
    if (!ctx.hasExec || performed.has(d)) return 'done';
    const st = cancelStatus(ctx, planned.get(d));
    // זכייה במכרז על טיסת סבב לילה כבר נספרת כבוצעה דרך `performed`; אחרת היא אינה נספרת (ס' 40).
    if (st === 'bid') return 'no';
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
            body: `${what}. על יותר משתי טיסות כאלה ברצף מגיע פיצוי, והרומה לא מזכה אותו. הפיצוי רק כשהרצף תוכנן לבקשת החברה.`,
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
 * הרגליים שיכולות להיות טיסה לבנה: יוצאות מהבסיס, ההתייצבות המתוכננת (STD פחות `report_minutes_before_std`,
 * 90 דק' בצי רחב גוף, 2018 ס' 52.2) אחרי `report_after` ועד `report_until`, ובלוק מקובע ארוך מ-`min_block_hours`.
 * `block: null` – אין משך מתוכנן (השדה אינו בטבלת אזורי הזמן). גם מגבלות החוק (לפני החוקים) והצוות החוזי
 * נשענים עליהן: טיסה כזאת לעולם אינה בצוות בודד, ולכן הרכב הצוות שלה נשאל רק בשאלת הטיסה הלבנה (בעל
 * המוצר, 06/10/2026).
 */
export function whiteFlightLegs(ctx, params) {
  const report = params.report_minutes_before_std ?? 0;
  const from = parseClock(params.report_after);
  const to = parseClock(params.report_until);
  const inWindow = (c) => (from < to ? c > from && c <= to : c > from || c <= to);
  const pairings = ctx.hasExec ? ctx.execPairings : ctx.planPairings;
  const out = [];
  for (const p of pairings) {
    for (const l of p.legs) {
      const dh = ctx.hasExec ? l.dhd || l.type === 'DHO' : l.dh;
      const t = legTimes(l, ctx.tz);
      if (dh || l.org !== ctx.domicile || !t) continue;
      const reportAt = t.std - report;
      if (!inWindow(clockOf(reportAt))) continue;
      const block = legBlock(ctx, l);
      if (block != null && block <= H(params.min_block_hours)) continue;
      out.push({ p, l, reportAt, block });
    }
  }
  return out;
}

/** הרכב הצוות לפי התשובה על טיסה לבנה: כן – מוגבר (או כפול עם חניך), לא – כפול. */
export const whiteCrew = (value) => (value === 'yes' ? 'augmented' : value === 'no' ? 'double' : null);

/**
 * טיסה לבנה: רגל מ-`whiteFlightLegs` שבוצעה בצוות מוגבר, או בצוות כפול עם חניך (בעל המוצר, 06/10/2026).
 * הרכב הצוות אינו בקבצים, ולכן שואלים, רק כשהרומה לא זיכתה. מה שנקבע על כל רגלי הסבב (`ctx.whiteLegs`:
 * הרכב הצוות, או null כשעוד לא ידוע) משמש את הצוות החוזי (`legal_crew_composition`).
 */
function white_flight(ctx, params, rule) {
  const key = keyFor(params.report_column);
  const own = ctx.rulesWithLogic('white_flight').map((r) => r.id);
  ctx.whiteLegs ??= new Map();

  for (const { p, l, reportAt, block } of whiteFlightLegs(ctx, params)) {
    if (block == null) {
      ctx.review(`${rule.title}: אין משך מתוכנן ל-${l.flight} ${l.org}→${l.dst} ב-${ddmm(l.date)} (השדה אינו בטבלת אזורי הזמן), ולכן לא נבדק אם היא ארוכה מ-${params.min_block_hours} שעות.`, rule);
      continue;
    }
    ctx.crewMatters?.(l.date, l.flight);

    const what = `${l.flight} ${l.org}→${l.dst} ב-${ddmm(l.date)}, התייצבות ${hhmm(reportAt)}, בלוק ${minToHhmm(block)}`;
    const id = `white:${l.date}:${l.flight}`;
    const answered = ctx.answer(id);
    const a = answered ?? (ctx.paidOn(p, params.report_column, key, H(params.hours), own) ? { value: 'yes' } : null);
    // כל רגלי הסבב: אותו צוות.
    for (const x of p.legs) {
      if (x.flight) ctx.whiteLegs.set(`${x.date}|${x.flight}`, a ? { value: whiteCrew(a.value), source: answered ? answered.source ?? 'white' : 'white_paid' } : null);
    }
    if (!a && !ctx.hasExec) {
      // בתכנון לבד הרכב הצוות אינו נשאל (בעל המוצר, 03/10/2026).
      ctx.note(l.date, `${rule.title}: ${what}. אם תבוצע בצוות מוגבר או בצוות כפול עם חניך, מגיע פיצוי של ${minToHhmm(H(params.hours))}.`, rule);
    } else if (!a) {
      ctx.ask({
        id,
        date: l.date,
        title: `טיסה לבנה: האם ${l.flight} ב-${ddmm(l.date)} בוצעה בצוות מוגבר או בצוות כפול עם חניך?`,
        body: `${what}. הרומה לא מזכה עליה, והיא טיסה לבנה רק אם בוצעה בצוות מוגבר או בצוות כפול עם חניך.`,
        options: [
          { value: 'yes', label: 'כן', hint: `${minToHhmm(H(params.hours))} – פער מול הרומה` },
          { value: 'no', label: 'לא, צוות כפול', hint: 'אין פיצוי' },
        ],
        ruleId: rule.id,
      });
    } else if (a.value === 'yes') {
      ctx.expectPairing(p, key, H(params.hours), rule,
        `${rule.title}: ${what} (${answered ? (answered.source === 'calendar' ? 'צוות מוגבר לפי היומן' : 'צוות מוגבר או כפול עם חניך לפי תשובתך') : `הרומה מזכה את הפיצוי, ולכן צוות מוגבר`})`);
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
      const block = legBlock(ctx, l);
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

// ---------- הרכב צוות חוקי במקום חוזי (2024 ס' 36; הצוות החוזי: 2018 ס' 50–51) ----------

const CREWS = Object.keys(CREW_LABEL); // מהקטן לגדול

/**
 * המגבלות החוזיות לכל הרכב, לפי התכנון (`fdp` מ-`plannedFdp` ב-legal.js), ו-null להרכב שאינו אפשרי.
 * - זמן טיסה: צוות בודד לפי `single_flight_time` – השורה הראשונה שמתאימה לשעת ההתייצבות המקומית,
 *   לשעת ה-On block (`on_block_until`: עד השעה הזאת בלילה שאחרי יום ההתייצבות) ולסבב ליעד
 *   (`round_stations`: סבב למוסקבה, שנוחת בבסיס). מוגבר וכפול – ערך קבוע, חוץ מיעד שיש לו חריגה.
 * - FDP: המגבלה החוקית לאותה התייצבות, פחות `fdp_reduction_minutes` בצוות בודד ובמוגבר, ובכפול בלי
 *   הפחתה. סבב לילה במוגבר עם מתקן מנוחה במחלקה `night_round.rest_class`, שה-FDP שלו עובר את
 *   `night_round.base_clock` ונוחת בבסיס: `night_round.fdp`.
 * - רגליים: כמו בחוק.
 */
function contractLimits(fdp, params, domicile) {
  const dayStart = Math.floor(fdp.reportLocal / 1440) * 1440;
  const reportClock = clockOf(fdp.reportLocal);
  const inWindow = (r) => {
    const from = parseClock(r.report_from);
    const to = parseClock(r.report_to);
    return from <= to ? reportClock >= from && reportClock <= to : reportClock >= from || reportClock <= to;
  };
  const last = fdp.flights.at(-1);
  const round = (r) => !r.round_stations || (last.dst === domicile && fdp.flights.some((f) => r.round_stations.includes(f.dst)));
  const landed = (r) => !r.on_block_until || fdp.onBlockLocal <= dayStart + 1440 + parseClock(r.on_block_until);
  const singleFt = params.single_flight_time.find((r) => inWindow(r) && round(r) && landed(r));
  const exception = (list) => (list ?? []).find((x) => fdp.flights.some((f) => f.dst === x.dst) &&
    (!x.fleets || x.fleets.some((k) => (fdp.ac ?? '').startsWith(k))));
  const red = params.fdp_reduction_minutes ?? 0;
  const n = params.night_round;
  const crossesNight = !!n && last.dst === domicile && fdp.restClass === n.rest_class &&
    [0, 1].some((k) => { const c = Math.floor(fdp.start / 1440) * 1440 + k * 1440 + parseClock(n.base_clock); return c > fdp.start && c < fdp.end; });
  const lim = fdp.legal;
  return {
    single: lim.single && singleFt ? { ft: parseClock(singleFt.max), fdp: lim.single.fdp - red, seg: lim.single.seg } : null,
    augmented: lim.augmented ? { ft: parseClock(exception(params.augmented_exceptions)?.max ?? params.augmented_flight_time),
      fdp: crossesNight ? parseClock(n.fdp) : lim.augmented.fdp - red, seg: lim.augmented.seg } : null,
    double: lim.double ? { ft: parseClock(params.double_flight_time), fdp: lim.double.fdp, seg: lim.double.seg } : null,
  };
}

/**
 * הצוות החוזי של רגל מהתכנון, לפי ה-FDP המתוכנן שלה (`ctx.planFdps`): ההרכב הקטן ביותר שהוא עומד
 * במגבלות ההסכם שלו. null – אין חוק צוות חוזי בתוקף, הרגל אינה ב-FDP, או שאינו עומד באף הרכב.
 */
export function contractCrewOf(ctx, leg) {
  const params = ctx.rulesWithLogic('legal_crew_composition')[0]?.logic?.params;
  const fdp = params && ctx.planFdps?.().find((f) => f.flights.some((x) => x.flight === leg.flight &&
    Math.abs(Date.parse(x.date) - Date.parse(leg.date)) <= dayMs));
  if (!fdp) return null;
  const lim = contractLimits(fdp, params, ctx.domicile);
  return CREWS.find((c) => lim[c] && fdp.ft <= lim[c].ft && fdp.fdp <= lim[c].fdp && fdp.seg <= lim[c].seg) ?? null;
}

/**
 * צוות חוקי ולא חוזי (2024 ס' 36): טיסה בהרכב קטן מהצוות החוזי מזכה כל מי שביצע אותה ב-`hours`.
 * הצוות החוזי הוא ההרכב הקטן ביותר שה-FDP המתוכנן עומד במגבלות ההסכם שלו (`contractLimits`).
 * ההסכם מגביל את הפיצוי ל"יעדים או טיסות כפי שיוסכם מעת לעת מול ועד אצ"א", והרשימה אינה בקבצים:
 * כל טיסה בהרכב קטן מהחוזי נחשבת כזאת (בעל המוצר, 04/10/2026). FDP שאינו עומד באף הרכב חוזי אינו
 * מזכה. הרכב הצוות – מהיומן או מתשובת המשתמש, באותה שאלה של מגבלות החוק (`crew:`). בלעדיו:
 * כשהרומה זיכתה את הפיצוי, מניחים צוות קטן מהחוזי; כשלא – שואלים, רק כשיש רומה (בעל המוצר, 04/10/2026).
 * הערות (בעל המוצר, 04/10/2026): כל טיסה בצוות קטן מהחוזי מקבלת הערה ביום שלה, וכשאין כזאת ואין טיסה
 * שהרכב הצוות שלה עוד לא ידוע – "כל הטיסות עומדות בהרכב צוות חוזי" בסוף ההערות. טיסה שהצוות החוזי שלה
 * מוגבר או כפול והרכב הצוות שלה אינו ידוע (בתכנון לבד, בלי היומן) נמנית בהערה בסוף. ההערות נבנות מחדש
 * בכל הרצה, ולכן מתעדכנות עם היומן ועם התשובות. כשהיומן מראה צוות קטן מהחוזי והרומה אינה מזכה, ייתכן
 * שהיומן אינו מעודכן, וההסבר מבקש לוודא סנכרון מהאורגנייזר.
 */
/**
 * מה ש-`white_flight` קבע על הרגל (`ctx.whiteLegs`, גם ביום שליד): undefined – אינה טיסה לבנה אפשרית,
 * null – הרכב הצוות עוד לא ידוע, אחרת {value, source}.
 */
function whiteLegOf(ctx, f) {
  for (const k of [0, -1, 1]) {
    const key = `${addDays(f.date, k)}|${f.flight}`;
    if (ctx.whiteLegs?.has(key)) return ctx.whiteLegs.get(key);
  }
  return undefined;
}

// בהערה שכבר מתחילה ביום: הטיסה בלי התאריך שבראש התיאור.
const routeOnly = (what) => what.replace(/^⁦[^⁩]*⁩\s*/, '');

function legal_crew_composition(ctx, params, rule) {
  const key = keyFor(params.report_column);
  const own = ctx.rulesWithLogic('legal_crew_composition').map((r) => r.id);
  const pairings = ctx.hasExec ? ctx.execPairings : ctx.planPairings;
  const near = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) <= dayMs;
  const amount = H(params.hours);
  let checked = 0;
  let below = 0;
  const unknown = [];
  const pending = [];
  for (const fdp of ctx.legalFdps ?? []) {
    const lim = contractLimits(fdp, params, ctx.domicile);
    const fits = (c) => lim[c] && fdp.ft <= lim[c].ft && fdp.fdp <= lim[c].fdp && fdp.seg <= lim[c].seg;
    const need = CREWS.find(fits);
    if (!need) continue;
    checked++;
    if (need === 'single') continue;
    const first = fdp.flights[0];
    const pairing = pairings.find((p) => p.legs.some((l) => l.flight === first.flight && near(l.date, first.date)));
    if (!pairing) { checked--; continue; }
    for (const f of fdp.flights) ctx.crewMatters?.(f.date, f.flight);
    const day = pairing.dates.includes(first.date) ? first.date : pairing.from;
    const smallerThan = (c) => CREWS.indexOf(c) < CREWS.indexOf(need);
    const contract = `הצוות החוזי ${CREW_LABEL[need]}`;
    // טיסה לבנה: הרכב הצוות לפי התשובה עליה (`white_flight`), ובלעדיה לא שואלים (בעל המוצר, 06/10/2026).
    const white = fdp.flights.map((f) => whiteLegOf(ctx, f)).find((w) => w !== undefined);
    const answered = ctx.answer(fdp.id) ??
      fdp.flights.map((f) => ctx.answer(`night_crew:${f.date}:${f.flight}`)).find(Boolean) ?? white ?? null;
    if (!answered && white === null) {
      if (ctx.hasExec) pending.push(fdp);
      else unknown.push(`${fdp.what} (${contract})`);
      continue;
    }
    if (answered) {
      if (!smallerThan(answered.value)) continue;
      below++;
      const by = { calendar: 'לפי היומן', white: 'לפי התשובה על הטיסה הלבנה', white_paid: 'לפי הפיצוי על טיסה לבנה ברומה' }[answered.source] ?? 'לפי תשובתך';
      const verb = ctx.hasExec ? 'בוצעה' : 'מתוכננת';
      // היומן מראה צוות קטן מהחוזי והרומה אינה מזכה: ייתכן שהיומן אינו מעודכן.
      const stale = answered.source === 'calendar' && ctx.hasExec && !ctx.paidOn(pairing, params.report_column, key, amount, own)
        ? ' ייתכן שהיומן אינו מעודכן: ודא שבוצע סנכרון של היומן מהאורגנייזר.' : '';
      ctx.expectPairingDay(pairing, day, key, amount, rule,
        `${rule.title}: ${fdp.what} ${verb} בצוות ${CREW_LABEL[answered.value]} ${by}, ו${contract}`,
        { explain: `צוות ${CREW_LABEL[answered.value]} ${by}, ו${contract}.${stale}` });
      ctx.note(fdp.date, `${routeOnly(fdp.what)} ${verb} בצוות ${CREW_LABEL[answered.value]} ${by}, קטן מהצוות החוזי (${CREW_LABEL[need]}).${stale}`, rule, { aside: true });
    } else if (ctx.paidOn(pairing, params.report_column, key, amount, own)) {
      below++;
      ctx.note(fdp.date, `${routeOnly(fdp.what)}: הרומה מזכה את הפיצוי, ולכן הצוות היה קטן מהצוות החוזי (${CREW_LABEL[need]}).`, rule, { aside: true });
      ctx.expectPairingDay(pairing, day, key, amount, rule,
        `${rule.title}: ${fdp.what}. הרומה מזכה את הפיצוי, ולכן הצוות היה קטן מהחוזי (${CREW_LABEL[need]})`,
        { explain: `הרומה מזכה את הפיצוי, ו${contract}. האפליקציה מניחה שהטיסה בוצעה בצוות קטן ממנו.` });
    } else if (ctx.hasExec) {
      pending.push(fdp);
      // נחיתות הלילה כבר שואלות על הרכב הצוות בטיסה מה-FDP הזה, והתשובה עונה גם כאן.
      if (fdp.flights.some((f) => [0, -1, 1].some((k) => ctx.isAsked(`night_crew:${addDays(f.date, k)}:${f.flight}`)))) continue;
      // מה חורג בהרכב הקטן ממנו: למה זה הצוות החוזי.
      const smaller = CREWS[CREWS.indexOf(need) - 1];
      const l = lim[smaller];
      const over = !l ? [] : [
        fdp.ft > l.ft && `זמן הטיסה המתוכנן ${minToHhmm(fdp.ft)}, והמקסימום בצוות ${CREW_LABEL[smaller]} ${minToHhmm(l.ft)}`,
        fdp.fdp > l.fdp && `ה-FDP המתוכנן ${minToHhmm(fdp.fdp)}, והמקסימום בצוות ${CREW_LABEL[smaller]} ${minToHhmm(l.fdp)}`,
        fdp.seg > l.seg && `${fdp.seg} רגליים, והמקסימום בצוות ${CREW_LABEL[smaller]} ${l.seg}`,
      ].filter(Boolean);
      ctx.ask({
        id: fdp.id,
        date: fdp.date,
        title: `באיזה צוות בוצע ${fdp.what}?`,
        body: `${contract}${over.length ? `: ${over.join('; ')}` : ''}. בצוות קטן ממנו מגיע פיצוי, והרומה לא מזכה אותו.`,
        options: CREWS.map((c) => ({ value: c, label: `${CREW_LABEL[c]} (${CREW_PILOTS[c]} טייסים)`,
          ...(smallerThan(c) && { hint: `${minToHhmm(amount)} – פער מול הרומה` }) })),
        ruleId: rule.id,
      });
    } else {
      unknown.push(`${fdp.what} (${contract})`);
    }
  }
  if (unknown.length) {
    ctx.note(null, `הרכב הצוות אינו ידוע ב${unknown.length === 1 ? 'טיסה שהצוות החוזי בה מוגבר או כפול' : `-${unknown.length} טיסות שהצוות החוזי בהן מוגבר או כפול`}, ולכן לא נבדק אם הוא חוזי: ${unknown.join('; ')}.`, rule);
  } else if (checked && !below && !pending.length) {
    ctx.note(null, 'כל הטיסות עומדות בהרכב צוות חוזי.', rule);
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
    const planned = pairingTimes(m.plan, ctx.tz).end;
    const actual = pairingTimes(m.exec, ctx.tz, { away: true }).end;
    if (planned == null || actual == null || actual - planned <= H(params.over_hours)) continue;

    ctx.markPairing(m.exec, 'stay_extension');
    const what = `${describePairing(m.exec)}: החזרה לבסיס ב-${ddmm(dateOf(actual))} ${hhmm(actual)}, ` +
      `${minToHhmm(actual - planned)} אחרי המתוכנן (${ddmm(dateOf(planned))} ${hhmm(planned)})`;
    const unplanned = [];
    for (let d = addDays(dateOf(planned), 1); d <= dateOf(actual); d = addDays(d, 1)) unplanned.push(d);
    // יממה בחודש הבא אינה ברומה של החודש הזה.
    const inMonth = unplanned.filter((d) => ctx.timeline.some((x) => x.date === d));
    const id = `stay_extension:${m.exec.id}`;
    const answered = ctx.answer(id);
    // הדוח כבר מזכה את הסכום הגבוה שאפשרי כאן: אין פער, ולא שואלים. לפי יום: על כל יממה לא מתוכננת, ולא
    // הסכום על הסבב (בעל המוצר, 08/10/2026).
    const a = answered ?? (inMonth.length && inMonth.every((d) => ctx.paidOnDate(d, params.report_column, key, H(params.hours))) ? { value: 'company' } : null);
    if (!a) {
      ctx.ask({
        id,
        date: m.exec.from,
        title: `חזרה מאוחרת לבסיס: ${describePairing(m.exec)}`,
        body: `${what}. הרומה לא מזכה עליה, והפיצוי תלוי בסיבה, שאינה בקבצים. מה קרה?`,
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
      // כל יממה בשורה משלה, כמו בקריאה מיוחדת (`perDay`): היממות הראשונות שאחרי יום החזרה המתוכנן.
      const why = `${what}. אירוע שלא בשליטת החברה, לפי תשובתך: קריאה מיוחדת על ${params.over_hours} השעות הראשונות ` +
        `(${params.capped_days} יממות). מגיע גם אש"ל לכל התקופה, ובתקופה הזאת אין זיכוי שהייה בחו"ל.`;
      for (const d of unplanned.slice(0, params.capped_days).filter((x) => inMonth.includes(x))) {
        ctx.expectPairing(m.exec, key, H(params.hours), rule, why,
          { date: d, dates: [d], perDay: true, explain: `אירוע שלא בשליטת החברה: ${params.over_hours} השעות הראשונות.` });
      }
    } else if (a.value === 'company') {
      const why = `${what}. ${unplanned.length === 1 ? 'יממה לא מתוכננת' : `${unplanned.length} יממות לא מתוכננות`} ` +
        `(${unplanned.map(ddmm).join(', ')}), ${answered ? 'לפי תשובתך' : `לפי מה שהרומה מזכה`}.`;
      for (const d of inMonth) {
        ctx.expectPairing(m.exec, key, H(params.hours), rule, why, { date: d, dates: [d], perDay: true, explain: 'יממה לא מתוכננת.' });
      }
    }
  }
}


// ---------- מיאמי (2026 ס' 24) ----------

/**
 * שהייה בתחנה בתוך סבב: מהנחיתה בה (`actual` – בפועל כשיש) ועד ההתייצבות לרגל שיוצאת ממנה.
 * שעת ההתייצבות אינה בקבצים, ונגזרת מ-STD פחות `report_minutes_before_std`. מוחזרים גם הזמנים
 * בשעון התחנה, כי חלון הלילה של ס' 24.3 הוא מקומי. רגל DH נספרת גם היא: הצוות שוהה בתחנה בכל מקרה.
 */
function stationStay(ctx, pairing, params, actual) {
  const legs = pairing.legs;
  for (let i = 0; i < legs.length - 1; i++) {
    const [inLeg, outLeg] = [legs[i], legs[i + 1]];
    if (inLeg.dst !== params.station || outLeg.org !== params.station) continue;
    const [a, b] = [legTimes(inLeg, ctx.tz), legTimes(outLeg, ctx.tz)];
    const off = ctx.tz.offsetAt(params.station, inLeg.date);
    const arr = actual ? a?.ata ?? a?.sta : a?.sta;
    if (arr == null || !b || off == null) return null;
    const pickup = b.std - (params.report_minutes_before_std ?? 0);
    if (pickup <= arr) return null;
    return { inLeg, outLeg, arr, pickup, localArr: arr + off, localPickup: pickup + off };
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
        body: `${what}. לפי החישוב זה לילה אחד ${window}, והרומה לא מזכה ${minToHhmm(hours)}. ${derived}`,
        options: [
          { value: 'yes', label: 'כן, לילה אחד בלבד', hint: `${minToHhmm(hours)} – פער מול הרומה` },
          { value: 'no', label: 'לא, יותר מלילה אחד', hint: 'אין פיצוי' },
        ],
        ruleId: rule.id,
      });
      continue;
    }
    ctx.markPairing(p, 'miami_one_night');
    ctx.expectPairing(p, key, hours, rule,
      `${why} (${answered ? 'לפי תשובתך' : `לפי מה שהרומה מזכה`})`);
  }
}

/** הדחייה בהמראה מהבסיס: מה-STD המתוכנן ועד ה-ATD בפועל, וכך גם הזזה של לוח הזמנים נכללת. */
function outboundDelay(ctx, execPairing, leg) {
  const t = legTimes(leg, ctx.tz);
  if (t?.atd == null) return null;
  const planLeg = ctx.matches.find((m) => m.exec === execPairing)?.plan?.legs
    .find((l) => l.flight === leg.flight && l.dst === leg.dst && Math.abs(Date.parse(l.date) - Date.parse(leg.date)) <= dayMs);
  const planned = planLeg ? legTimes(planLeg, ctx.tz) : null;
  return t.atd - (planned?.std ?? t.std);
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
          hint: sib && enough(sib.logic.params, delay) ? `${minToHhmm(hours)} – פער מול הרומה` : 'אין פיצוי' };
      };
      ctx.ask({
        id,
        date: p.from,
        title: `דחייה ביציאה ל-${params.station}: מתי חלה הדחייה?`,
        body: `${what}, והמנוחה בתחנה קוצרה ללילה אחד. הרומה לא מזכה ${minToHhmm(hours)}, ` +
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
        `(${answered ? 'לפי תשובתך' : `לפי מה שהרומה מזכה`}), בנוסף לקיצור המנוחה של ס' 24.3.`);
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
        body: `${what}. ${deal} הרומה לא מזכה ${minToHhmm(hours)}, והסיבה אינה בקבצים. ${derived}`,
        options: [
          { value: 'yes', label: 'כן, המנוחה קוצרה', hint: `${minToHhmm(hours)} – פער מול הרומה` },
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
      `${answered ? 'לפי תשובתך' : `לפי מה שהרומה מזכה`}. ${derived}`);
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
          body: 'על הארכת אימון בסימולטור לבקשת החברה מגיע פיצוי, והרומה לא מזכה אותו.',
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
export function execFdpGroups(pairings, tz, legalRest, reportMin, postMin = 0) {
  const sorted = [...pairings].sort((a, b) => a.from.localeCompare(b.from));
  const groups = [];
  let prev = null;
  for (const p of sorted) {
    const span = pairingTimes(p, tz);
    const joins = prev && prev.span.end != null && span.start != null && legalRestBetween(prev.span, span, reportMin, postMin) < legalRest;
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
  legal_crew_composition,
};

export const DUTY_PARAMS = {
  same_fdp_rounds: ['legal_rest_hours', 'report_minutes_before_std', 'hours', 'report_column'],
  second_unplanned_activity: ['legal_rest_hours', 'report_minutes_before_std', 'hours', 'report_column', 'sim_report_codes', 'sim_plan_codes', 'sim_plan_code_prefixes'],
  base_rest_shortfall: ['answer_value', 'hours', 'report_column', 'report_minutes_before_std', 'rest_buffer_minutes', 'legal_rest_hours',
    'short_stay_max_hours', 'short_stay_factor', 'long_stay_share', 'long_stay_min_hours', 'long_stay_max_hours'],
  night_landings: ['fleet', 'window_from', 'window_to', 'min_planned_count', 'paid_from_count', 'hours', 'report_column', 'base_landings_only', 'counted_crews', 'legal_rest_hours'],
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
  legal_crew_composition: ['hours', 'report_column', 'single_flight_time', 'augmented_flight_time', 'augmented_exceptions', 'double_flight_time',
    'fdp_reduction_minutes', 'night_round'],
};
