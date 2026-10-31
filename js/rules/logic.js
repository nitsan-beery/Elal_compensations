// מימוש הלוגיקות של החוקים.
//
// כל פונקציה מקבלת (ctx, params, rule) ורושמת ציפיות וממצאים ל-ctx.
// הערכים המספריים מגיעים כולם מ-`params` של החוק ב-`rules.json`, ולא מהקוד.
// מזהה לוגיקה שאינו מופיע כאן נחשב "לא נתמך" ומוצג למשתמש.

import { hoursToMin, minToHhmm, MONTH_NAMES } from '../time.js';
import { describePairing, describeRoute, fdpParts, wholePairing } from '../model.js';
import { at, dateOf, legTimes, pairingTimes } from '../flight-times.js';
import { DUTY_LOGIC, DUTY_PARAMS, execFdpGroups, amountWord, otherOption, applyOtherReason, extensionDays, overStay, stayEnd, carriedStay, extensionAnswer, dayActivity, keyFor, paidEarlier } from './duty.js';
import { overlapDays } from './journal.js';

const H = (hours) => hoursToMin(hours) ?? 0;

// ---------- קרדיט טיסה ----------

/**
 * קרדיט כל רגל = STA − STD. הדוח כבר נותן את זה ב-SkdDur, אחרי המרת אזורי זמן.
 *
 * כל יממה קלנדרית מקבלת בדוח את הקרדיט שלה, לפי ההמראה בפועל בשעון הבסיס:
 * - רגל שהמריאה אחרי חצות בשעון הבסיס שייכת כולה ליום שאחרי, גם כשהדוח רושם אותה ביום
 *   הקודם (LY392 ב-03/05/2026: ‏ATD 23:51 בברצלונה = 00:51 → 04/05; ‏LY388 ב-01/06/2026
 *   יצאה ב-00:08 במקום 22:55 → 02/06; ‏LY2368 ב-15/02/2026 → 16/02).
 * - רגל שחוצה חצות מתפצלת: ליום ההמראה הזמן מההמראה בפועל עד חצות, וליום שאחריו השאר מתוך
 *   SkdDur (LY336 ב-16/07/2026, ‏ATD 23:01 → 00:59 ו-03:46; ‏LY5110 ב-06/01/2026).
 * - מה שאחרי סוף החודש שייך לחודש הבא (31/05/2026: LY387 → 04:22). רגל שיצאה בחודש הקודם
 *   מזוכה ב-SkdDur פחות מה שזוכה שם (01/06/2026: ‎−00:07).
 * - בסבב עם יותר מיעד אחד, רגל שלא יוצאת מהבסיס ולא חוזרת אליו זוכה לפי הביצוע (ActDur,
 *   ATA−ATD) ולא לפי SkdDur: שני קצותיה בשעון זר, וההפרש בין השעונים לא תמיד ידוע כמו
 *   בבסיס, ולכן SkdDur של הדוח לא תמיד מדויק לה. רק כשActDur חסר לוקחים SkdDur, כמו רגל
 *   שנוגעת בבסיס (בעל המוצר, 26/09/2026; סוגר את הפער מול הדוח ב-09/09/2024 ‏TLV-SOF-TIV-TLV
 *   וב-23/09/2024 ‏TLV-BUS-LCA-TLV).
 */
function credit_from_scheduled(ctx, params, rule) {
  const monthEnd = ctx.timeline.at(-1).date;
  for (const pairing of ctx.execPairings) {
    if (sumLegs(pairing, ctx.domicile) == null) {
      ctx.review(`${describePairing(pairing)}: חסרות שעות מתוכננות (SkdDur) ברומה, ולא ניתן לחשב קרדיט.`, rule);
      continue;
    }
    const airReturnMatch = ctx.matches.find((m) => m.exec === pairing);
    if (airReturnMatch?.how === 'air_return') {
      const top = minSlipTopUp(ctx, pairing);
      // בלי סכומים: הם בטבלת הפירוט, בשורה של הטיסה (בעל המוצר, 01/10/2026).
      ctx.note(pairing.from, `חזרה לבסיס אחרי היציאה: קרדיט לפי זמן הטיסה בפועל${top ? ' והשלמה לסליפ קצר' : ''}.`, rule, { pairingId: pairing.id });
    }
    const days = new Map(); // date → {min, why[]}
    const add = (date, min, why) => {
      if (date > monthEnd) return;
      const d = days.get(date) ?? { min: 0, why: [] };
      d.min += min;
      if (why) d.why.push(why);
      days.set(date, d);
    };
    let error = null;
    const edges = []; // רגליים שנחתכות בגבול החודש, להערה על הקיזוז (טיוטות 373–374)
    for (const leg of pairing.legs) {
      // בתכנון בלבד הקרדיט הוא ה-FT של כל יום, שכבר רשום ביום שלו. אין מה לפצל.
      if (!ctx.hasExec) { add(leg.date, leg.skdDur); continue; }
      const dur = legCreditDur(leg, pairing, ctx.domicile);
      const basis = isAirReturn(leg)
        ? `${leg.flight} חזרה ל-${leg.org} אחרי היציאה: קרדיט לפי זמן הביצוע בפועל, ${minToHhmm(dur)}`
        : dur !== leg.skdDur
          ? `${leg.flight}: לג שאינו נוגע בבסיס, קרדיט לפי הביצוע ${minToHhmm(dur)} ולא ${minToHhmm(leg.skdDur)} מתוכננות`
          : null;
      const note = (msg) => [basis, msg].filter(Boolean).join('. ');
      const split = splitAtMidnight(leg, ctx.tz);
      if (leg.carryUnknown) {
        // הרומה אינה מכריעה אם הרגל המריאה ב-1 לחודש או ביום האחרון של החודש הקודם (`markCarryIn`; טיוטה 417).
        ctx.ask({
          id: `carry:${leg.date}:${leg.flight}`,
          date: leg.date,
          title: `${leg.flight} ב-${dayOf(leg.date)}: מתי הרגל המריאה?`,
          body: 'הרומה אינה מכריעה, והתשובה קובעת את הקרדיט בחודש הזה.',
          options: [{ value: 'here', label: `ב-${dayOf(leg.date)}` }, { value: 'prev', label: `ב-${dayOf(addDays(leg.date, -1))}` }],
          ruleId: rule.id,
        });
      }
      if (leg.prevMonth) {
        // הרגל רשומה ביום 1 אבל יצאה ביום האחרון של החודש הקודם.
        if (split.error) { error = split.error; break; }
        const prev = split.before ?? dur; // נחתה לפני חצות: כולה זוכתה בחודש הקודם
        // הרומה של החודש הקודם שמורה וזוכה בה עודף: הקיזוז הצפוי הוא העודף שניתן בה בפועל (טיוטה 374).
        // הקרדיט ביום האחרון שם, פחות שאר הרגליים באותו יום: רק החלק של הרגל הזאת (30/09/2026: ‏07:53, מתוכן LY373 ‏06:12
        // ו-LY374 ‏01:41; בעל המוצר, 30/10/2026, טיוטה 420).
        const last = ctx.prevExec?.days?.[addDays(leg.date, -1)];
        const given = ctx.prevExec ? Math.max(0, (last?.values?.Credit?.min ?? 0) - otherCreditOn(ctx, addDays(leg.date, -1), leg)) : null;
        const base = given != null && (prev > dur || given > dur) ? given : prev;
        add(leg.date, dur - base, note(`${leg.flight} יצאה בחודש הקודם, ושם זוכו ${minToHhmm(base)}. בחודש הזה ${minToHhmm(dur - base)} מתוך ${minToHhmm(dur)}`));
        if (base > dur || prev > dur) edges.push({ kind: 'carry', leg, date: leg.date, part: dur - base, dur, prev, given });
        continue;
      }
      if (split.error) {
        // אי אפשר לדעת מתי המריאה בשעון הבסיס. בסוף החודש זה משנה את הסכום, ובאמצעו רק את החלוקה.
        if (leg.date === monthEnd) { error = split.error; break; }
        add(leg.date, dur, note(`${leg.flight}: לא ידועה שעת ההמראה בשעון הבסיס, כל הקרדיט ביום שבו היא רשומה`));
        continue;
      }
      const date = addDays(leg.date, split.shift);
      const moved = split.shift ? `${leg.flight} רשומה ב-${dayOf(leg.date)} אבל המריאה ב-${dayOf(date)} בשעון הבסיס` : null;
      if (split.before == null) { add(date, dur, note(moved)); continue; }
      const next = addDays(date, 1);
      if (next > monthEnd) {
        add(date, split.before, note(`${leg.flight} חוצה את סוף החודש: בחודש הזה ${minToHhmm(split.before)} מההמראה בפועל עד חצות, והשאר בחודש הבא`));
        edges.push({ kind: 'end', leg, date, part: split.before, dur, next });
        continue;
      }
      add(date, split.before, note(`${leg.flight} חוצה חצות: ${minToHhmm(split.before)} מההמראה בפועל עד חצות`));
      add(next, dur - split.before, note(`${leg.flight}: ${minToHhmm(dur - split.before)} אחרי חצות (${minToHhmm(dur)} − ${minToHhmm(split.before)})`));
    }
    if (error) {
      ctx.review(`${describePairing(pairing)}: ${error}`, rule);
      continue;
    }
    // רגל בגבול החודש: מה שהרומה נתנה עליה בפועל – הקרדיט ביום, פחות מה שצפוי בו על שאר הרגליים.
    // ההסבר גם מתחת לשורת הקרדיט בטבלת הפירוט (`creditNote`; טיוטה 376).
    const extras = new Map();
    for (const e of edges) {
      // הסבבים שלפני הסבב הזה כבר רשמו מה שצפוי באותו יום: רגל שנחתה בו אחרי חצות (טיוטה 424).
      const actual = ctx.reportedOnDate(e.date, 'Credit') - ctx.expectedOnDate(e.date, 'flight') - (days.get(e.date).min - e.part);
      if (e.kind === 'carry') carryOffset(ctx, e, actual, rule, extras);
      else if (actual > e.dur) {
        ctx.note(e.date, `${e.leg.flight} זוכתה בקרדיט של ${minToHhmm(actual)} לעומת בלוק מקובע של ${minToHhmm(e.dur)}. ` +
          `צפי לקיזוז של ${offsetText(actual - e.dur)} ב-${dayOf(e.next)}.`, rule, { aside: true });
        extras.set(e.date, { creditNote: `ניתן קרדיט עודף של ${offsetText(actual - e.dur)} (${minToHhmm(actual)} לעומת בלוק מקובע של ${minToHhmm(e.dur)}).` });
      }
    }
    for (const [date, d] of days) {
      ctx.expectPairingDay(pairing, date, 'flight', d.min, rule, ['קרדיט לפי STA − STD', ...d.why].join('. '), extras.get(date));
    }
  }
}

/**
 * קרדיט רגל, לצורך `credit_from_scheduled`: SkdDur, חוץ מרגל בסבב עם יותר מיעד אחד (לא
 * חזרה תוך-אזורית ליעד היחיד, כמו PFO-LCA ב-20/06/2025 בדרך חזרה מ-LCA) שלא יוצאת מהבסיס
 * ולא חוזרת אליו – שם לוקחים את הביצוע (ActDur) כשהוא קיים בדוח.
 */
const legCreditDur = (leg, pairing, domicile) =>
  (isAirReturn(leg) || (pairing.destinations.length > 1 && leg.org !== domicile && leg.dst !== domicile) ? leg.actDur : null) ?? leg.skdDur;

/**
 * מה שהרומה של החודש הקודם זיכתה ביום `date` על טיסות אחרות מלבד `leg`: הרגליים שרשומות בו, והחלק שאחרי חצות של
 * רגל מהיום שלפניו, שנחתה בו בלי שורת רגל (בעל המוצר, 30/10/2026, טיוטה 424).
 */
function otherCreditOn(ctx, date, leg) {
  const before = addDays(date, -1);
  let sum = 0;
  for (const d of [before, date]) {
    for (const raw of ctx.prevExec.days?.[d]?.legs ?? []) {
      if (raw.flight === leg.flight && raw.org === leg.org && raw.dst === leg.dst) continue;
      const l = { ...raw, date: d };
      const dur = (l.org === ctx.domicile || l.dst === ctx.domicile ? l.skdDur : l.actDur ?? l.skdDur) ?? 0;
      const split = splitAtMidnight(l, ctx.tz);
      if (split.error) { if (d === date) sum += dur; continue; }
      const dep = addDays(d, split.shift);
      if (dep === date) sum += split.before ?? dur;
      else if (dep === before && split.before != null) sum += dur - split.before;
    }
  }
  return sum;
}

/** קיזוז בגבול החודש: בדקות עד שעה, ומעבר לשעה ב-H:MM. */
const offsetText = (min) => (min === 1 ? 'דקה אחת' : min < 60 ? `${min} דקות` : minToHhmm(min));

/**
 * רגל שיצאה ביום האחרון של החודש הקודם וזוכתה שם עד חצות יותר מהבלוק המקובע: הקיזוז ב-1 לחודש
 * (01/06/2026 LY387: ‏04:22 לעומת 04:15; בעל המוצר, 18/10/2026, טיוטות 373–374). בלי הרומה של
 * החודש הקודם – הערה לוודא; איתה – הקיזוז הצפוי הוא העודף שניתן בה, ו-`actual` (מה שהרומה הזאת
 * נתנה על הרגל) שונה ממנו הוא פער בשורת הקרדיט. בכל המקרים ההסבר גם מתחת לשורת הקרדיט (`creditNote`; טיוטה 376).
 */
function carryOffset(ctx, { leg, part, dur, prev, given }, actual, rule, extras) {
  const depDate = addDays(leg.date, -1);
  if (given == null) {
    ctx.note(leg.date, `${leg.flight}: קוזזו ${offsetText(prev - dur)}. יש לוודא שב-${dayOf(depDate)} ניתן קרדיט של ${minToHhmm(prev)} ` +
      `(לעומת בלוק מקובע של ${minToHhmm(dur)}).`, rule, { aside: true, severity: 'warn' }); // יש מה לבדוק (טיוטה 375)
    extras.set(leg.date, { creditNote: `קוזזו ${offsetText(prev - dur)}, יש לוודא שב-${dayOf(depDate)} ניתן קרדיט של ${minToHhmm(prev)} ` +
      `לעומת בלוק מקובע של ${minToHhmm(dur)}.` });
    return;
  }
  const excess = given - dur;
  if (actual === part) {
    if (excess > 0) {
      ctx.note(leg.date, `${leg.flight}: קוזזו ${offsetText(excess)}. תואם לקרדיט עודף של ${offsetText(excess)} שניתן ב-${dayOf(depDate)} ` +
        `(${minToHhmm(given)} לעומת בלוק מקובע של ${minToHhmm(dur)}).`, rule, { aside: true });
      extras.set(leg.date, { creditNote: `קוזזו ${offsetText(excess)} בהתאם לקרדיט עודף שניתן ב-${dayOf(depDate)}.` });
    }
    return;
  }
  const before = MONTH_NAMES[Number(depDate.slice(5, 7)) - 1];
  const creditNote = actual >= 0 ? (excess > 0 ? `לא קוזז קרדיט, לעומת קרדיט עודף של ${offsetText(excess)} שניתן ב${before}.`
    : `לא קוזז קרדיט, וב${before} לא ניתן קרדיט עודף.`)
    : excess > 0 ? `קוזזו ${offsetText(-actual)} לעומת קרדיט עודף של ${offsetText(excess)} שניתן ב${before}.`
      : `קוזזו ${offsetText(-actual)}, וב${before} לא ניתן קרדיט עודף.`;
  extras.set(leg.date, { creditNote });
}


/**
 * חזרה לשדה המוצא אחרי ההמראה: מזוכה לפי זמן הביצוע בפועל (בעל המוצר, 28/09/2026). בדוח ה-SkdDur
 * שלה שווה ל-ActDur (LY571 ב-15/09/2025 ‏00:25, ‏LY321 ב-31/03/2025, ‏LY2367 ב-15/02/2026).
 */
const isAirReturn = (leg) => leg.org != null && leg.org === leg.dst;

/**
 * ההמראה בפועל בשעון הבסיס (`legTimes`), ביחס לחצות של היום שבו הרגל רשומה: `shift` – כמה
 * ימים אחרי (או לפני) היום הרשום היא המריאה, ו-`before` – כמה ממנה חל לפני חצות של יום
 * ההמראה, או null אם היא לא חוצה חצות (LY398 ב-24/01/2025: ‏STD 23:05 במדריד = 00:05 ב-24/01,
 * ‏ATD 00:35 → 24/01, לא 25/01).
 */
function splitAtMidnight(leg, tz) {
  const dur = leg.actDur ?? leg.skdDur;
  if ((leg.atd ?? leg.std) == null || dur == null) return { error: `לא ניתן לדעת מתי המריאה ${leg.flight}.` };
  const t = legTimes(leg, tz);
  if (!t) return { error: `לא ניתן לדעת מתי המריאה ${leg.flight} בשעון הבסיס.` };
  const dep = t.atd ?? t.std;
  const clock = dep - at(dateOf(dep), 0);
  return { shift: daysBetween(leg.date, dateOf(dep)), before: clock + dur <= 1440 ? null : 1440 - clock };
}

/**
 * הקרדיט של סבב שבוצע, כפי ש-`credit_from_scheduled` מזכה אותו (`legCreditDur`): כולל רגל שאינה נוגעת
 * בבסיס, שמזוכה לפי הביצוע. כל חוק שמשווה מול "קרדיט הטיסה שבוצעה" (הגבוה מבין השתיים, השלמה
 * לסליפ קצר, כוננות שהופעלה) משווה מול הסכום הזה, כדי שהסך הכול לא יעבור את מה שמגיע
 * (09/09/2024: ‏TLV-SOF-TIV-TLV מזוכה 06:54 ולא 06:33 המתוכננות; 01/10/2026).
 */
const sumLegs = (pairing, domicile) => pairing.legs.reduce((acc, l) => {
  const dur = legCreditDur(l, pairing, domicile);
  return acc == null || dur == null ? null : acc + dur;
}, 0);

/**
 * סליפ שהקרדיט שלו קצר מהמינימום מקבל השלמה, וההפרש נרשם ב-Rig. סליפ שנחתך בגבול
 * החודש נבדק על כולו (`cutSlip`; 28/02/2026: BUD 03:35 בלי Rig, כי הסבב כולו 06:55).
 */
function min_slip_credit(ctx, params, rule) {
  const min = H(params.min_credit_hours);
  for (const group of minSlipGroups(ctx, params)) expectMinSlip(ctx, group, min, params, rule);
  for (const p of ctx.execPairings) if (p.cutAtStart || p.cutAtEnd) cutSlip(ctx, p, min, params, rule);
}

/**
 * סליפ שחוצה חודש (בעל המוצר, 30/10/2026, טיוטה 427). ההשלמה נקבעת על הסליפ כולו, ולכן היא נבדקת בחודש החזרה,
 * כשהרומה של החודש הקודם שמורה (`prevLegs`). ברומות שבדקנו כולם מעל המינימום, ואין בהם Rig באף חודש; סליפ קצר
 * לא נצפה, וחודש החזרה הוא בחירה. בלעדיה, או בחודש ההמראה: Rig ברומה שמשלים את הקרדיט בחודש עד המינימום – הנחה.
 * סבב שנסגר אחרי חצות של היום האחרון נבדק בחודש ההמראה, שבו יש את כל הרגליים.
 */
function cutSlip(ctx, p, min, params, rule) {
  if (ctx.pairingHandledBy(p, 'lost_hours_credit') || p.legs.every((l) => l.prevMonth)) return;
  const note = `השלמה ל-${params.min_credit_hours} שעות`;
  if (p.carriedSource === 'exec' && !p.cutAtEnd) {
    const legs = [...p.prevLegs, ...p.legs];
    const credit = sumLegs({ legs, destinations: [...new Set(legs.map((l) => l.dst).filter((d) => d !== ctx.domicile))] }, ctx.domicile);
    const shortfall = credit ? Math.max(0, min - credit) : 0;
    if (!shortfall) return;
    if (paidEarlier(ctx, p, 'Rig', shortfall)) ctx.note(p.from, `ה${note} רשומה ברומה של החודש הקודם.`, rule);
    else ctx.expectPairing(p, 'rig', shortfall, rule, note, { reason: note, explain: `${note}.` });
    return;
  }
  const extra = ctx.reportDates(p).reduce((s, d) => s + ctx.reportedOnDate(d, 'Rig') - ctx.expectedOnDate(d, 'rig'), 0);
  if (extra <= 0 || ctx.expectedOn(p, 'flight') + extra > min) return;
  const side = p.cutAtEnd ? 'שחוזר בחודש הבא' : 'שהתחיל בחודש הקודם';
  ctx.expectPairing(p, 'rig', extra, rule, note,
    { reason: note, explain: `הרומה מזכה קרדיט נוסף. האפליקציה מניחה שזו ${note}, על סבב ${side}.` });
}

/** הקבוצות שההשלמה נבדקת עליהן: FDP שלם, או כל סבב בנפרד כשחלק מה-FDP אינו נבדק. */
function minSlipGroups(ctx, params) {
  const groups = params.per_fdp
    ? execFdpGroups(ctx, ctx.execPairings, H(params.legal_rest_hours))
    : ctx.execPairings.map((p) => [p]);
  const out = [];
  for (const group of groups) {
    const slips = group.filter((p) => !ctx.pairingHandledBy(p, 'lost_hours_credit') && !p.cutAtStart && !p.cutAtEnd);
    // סבב חתוך או סבב שבוטל בגלל מטוס חכור: שאר ה-FDP נבדק לבד, כל סבב בנפרד.
    if (slips.length !== group.length) out.push(...slips.map((p) => [p]));
    else out.push(group);
  }
  return out;
}

/**
 * ההשלמה שמגיעה לקבוצה: כל סבב לפי הקרדיט שלו לבדו, והעודף של סבב שעבר את המינימום אינו מקוזז
 * מסבב קצר באותו FDP (2018 ס' 27.2 מדבר על סליפ; 04/08/2025: BUS 06:16 ו-LCA 02:20 → Rig 02:40).
 * סבב שהקרדיט שלו אינו ידוע, או אפס, אינו נבדק.
 */
function minSlipShortfall(group, min, domicile) {
  return group.reduce((sum, p) => {
    const credit = sumLegs(p, domicile);
    return credit == null || credit === 0 ? sum : sum + Math.max(0, min - credit);
  }, 0);
}

/**
 * ההשלמה לסליפ קצר שצפויה על סבב ביצוע. `min_slip_credit` רץ אחרי חוקי ההחלפה, ולכן
 * ההערה שם אינה יכולה לקרוא את הציפייה והחישוב חוזר כאן.
 */
function minSlipTopUp(ctx, execPairing) {
  const rule = execPairing ? ctx.rulesWithLogic('min_slip_credit')[0] : null;
  if (!rule) return 0;
  const params = rule.logic.params ?? {};
  const group = minSlipGroups(ctx, params).find((g) => g.some((p) => p.id === execPairing.id));
  return group ? minSlipShortfall(group, H(params.min_credit_hours), ctx.domicile) : 0;
}

/**
 * כל סבב ב-FDP מקבל השלמה למינימום לפי הקרדיט שלו בלבד, והיא רשומה עליו: ההסבר בשורה שלו הוא
 * "השלמה ל-5 שעות", בלי להזכיר את שאר הסבבים שב-FDP, שאינם קשורים אליה (04/08/2025: רק LCA קצר;
 * בעל המוצר, 01/10/2026). ב-25/11/2025 וב-30/12/2025 (BUS 05:04 ו-LCA 02:15) הדוח רשם Rig 02:41,
 * ארבע דקות פחות מ-02:45 של קריאה זו, וזה הפער היחיד שנשאר.
 */
function expectMinSlip(ctx, group, min, params, rule) {
  const note = `השלמה ל-${params.min_credit_hours} שעות`;
  for (const p of group) {
    const shortfall = minSlipShortfall([p], min, ctx.domicile);
    if (!shortfall) continue;
    // סבב אחר מה-FDP שרשום ברומה באותם ימים חולק איתו שורה בפירוט, ולכן ההסבר אומר על איזו טיסה
    // ההשלמה (25/11/2025). כשלסבב הקצר שורה משלו, מספר הטיסה כבר כתוב בה (04/08/2025).
    const days = ctx.reportDates(p).join();
    const shared = group.some((o) => o !== p && ctx.reportDates(o).join() === days);
    ctx.expectPairing(p, 'rig', shortfall, rule, note, { reason: note, explain: `${shared ? `${flightsOf(p)}: ` : ''}${note}.` });
  }
}

// ---------- ימי היעדרות וזיכוי ----------

/**
 * זיכוי יומי לפי קוד: חופשה, מחלה, אימון קרקע, סימולטור וכוננות.
 * כמה חוקים שונים משתמשים בלוגיקה הזאת, כל אחד עם קודים וערכים משלו.
 *
 * `flight_day_takes_higher`: יום שבו הופעל מכוננות לסליפ מזוכה לפי הגבוה מבין קרדיט הסליפ (כולל ההשלמה
 * ל-5 שעות) לבין ערך כל ימי הכוננות שבו (`compareStandbyFlown`). ביום של Soft Start (2018 ס' 91;
 * `ctx.softStart`) אין קרדיט כוננות (91.4), ולכן רק הערה (בעל המוצר, 15/10/2026).
 *
 * `ask_when_missing`: יום שתוכנן בו הקוד, וברומה לא רשום בו כלום – שינוי ושאלה (`standbyMissing`).
 */
function absence_day_credit(ctx, params, rule) {
  const credit = H(params.credit_hours);
  if (params.confirm_code_prefixes?.length) {
    askUnconfirmedCodes(ctx, params, rule);
    const confirmed = confirmedCodes(ctx, params);
    params = { ...params, plan_codes: [...(params.plan_codes ?? []), ...confirmed],
      report_codes: [...(params.report_codes ?? []), ...confirmed.map((c) => c.slice(0, 5))] };
  }
  // קוד תכנון שעבר בביצוע לקוד של חוק אחר (SBY_L → SBY_S) מזוכה לפי הביצוע, בלי הערה: הסכום כבר
  // בטבלה (בעל המוצר, 08/10/2026).
  const onFlightDay = new Set();
  for (const day of ctx.timeline) {
    if (!matchesCode(day, params, ctx)) continue;
    if (params.flight_day_takes_higher) {
      // כל ימי הסבב, גם יום שהייה שאין בו רגל (`standbyDaysFlown`).
      const pairing = ctx.execPairings.find((p) => inStay(p, day.date));
      if (pairing) {
        if (onFlightDay.has(pairing)) continue;
        onFlightDay.add(pairing);
        // מספר הרגל הראשונה ביום בראש ההערה, כמו בשאר ההערות על יום של טיסה (בעל המוצר, 15/10/2026).
        const leg = (day.exec?.legs ?? []).find((l) => l.flight) ?? pairing.legs?.find((l) => l.flight);
        const who = leg ? `${leg.flight} ` : '';
        if (ctx.softStart(day.date)) ctx.note(day.date, `${who}הופעלת מ-Soft Start. אין פיצוי.`, rule);
        compareStandbyFlown(ctx, pairing, rule);
        continue;
      }
    }
    if (params.requires_assigned_activity) {
      // הדוח כבר מזכה על היום: היית מוצב, ואין פער שמצדיק שאלה (החלטת בעל המוצר, 23/09/2026).
      const assigned = ctx.wasAssigned(day.date) ??
        ((ctx.paidOnDate(day.date, 'Credit', 'absence', credit) && !!ctx.assume(`assigned:${day.date}`, 'yes', 'כן, הייתי מוצב')) || null);
      if (assigned == null) {
        ctx.ask({
          id: `assigned:${day.date}`,
          date: day.date,
          title: `${rule.title} ב-${day.date.slice(8, 10)}/${day.date.slice(5, 7)}: האם היית מוצב לפעילות?`,
          body: 'אין קובץ תכנון לחודש הזה, והרומה לא מזכה על היום. קרדיט על היום ניתן רק אם היית מוצב בו לפעילות.',
          options: [
            { value: 'yes', label: 'כן, הייתי מוצב', hint: `${minToHhmm(credit)} – פער מול הרומה` },
            { value: 'no', label: 'לא הייתי מוצב', hint: 'אין קרדיט' },
          ],
          ruleId: rule.id,
        });
        continue;
      }
      if (!assigned) {
        ctx.note(day.date, `${rule.title}: לא היית מוצב לפעילות ביום הזה, ולכן אין קרדיט.`, rule);
        continue;
      }
    }
    creditDay(ctx, day, params, rule, credit, matchedCode(day, params, ctx));
  }
  if (params.ask_when_missing) standbyMissing(ctx, params, rule, credit);
  if (params.unserved_empty_rule) unservedEmptyDays(ctx, params, rule);
}

/** הזיכוי היומי על `day`: הקרדיט, ה-TAB וסימון העמודה, לפי הקוד `code`. `extra` – לציפייה (`explain`). */
function creditDay(ctx, day, params, rule, credit, code, extra = {}) {
  ctx.expect(day.date, 'absence', credit, rule, rule.title, { code, ...extra });
  // יום בתוך סבב, בלי טיסה פעילה משלו (SIM_BER ב-18/11/2025, באמצע סבב BER; SIM_PRG ב-28/01/2025,
  // עם DH ‏PRG→ZRH): ה-TAB הוא של השהייה בחו"ל, וסימון העמודה נרשם ביום תחילת הסבב.
  const active = (legs, dh) => (legs ?? []).some((l) => !dh(l));
  const away = !active(day.exec?.legs, (l) => l.dhd || l.type === 'DHO' || l.type === 'DHX') && !active(day.plan?.legs, (l) => l.dh)
    ? ctx.execPairings.find((p) => p.from < day.date && day.date < p.to) : null;
  if (params.report_flag_column) {
    const flagDate = away && params.away_flag_on_pairing_start ? away.from : day.date;
    ctx.expectFlag(flagDate, params.report_flag_column, 1, rule);
  }
  if (params.tab_hours != null && !away) ctx.expectTab(day.date, H(params.tab_hours), rule);
  ctx.markAbsence(day.date, rule.id);
}

/**
 * יום שתוכננה בו כוננות, וברומה לא רשום בו כלום – לא כוננות, לא טיסה ולא קוד אחר (`ask_when_missing`; בעל
 * המוצר, 15/10/2026). מול רומה הזיכוי היומי לפי הקודים שבה בלבד, ולכן בלי זה היום לא הופיע בשום מקום. ימים
 * עוקבים הם שינוי אחד ושאלה אחת (`standby_missing:`): הכוננות התקיימה – הזיכוי של יום כוננות רגיל, ופער מול
 * הרומה; ביקשתי לבטל אותה – אין קרדיט; או סיבה אחרת. אין ביטול ביוזמת החברה. רק מול רומה, ולא מול היומן.
 */
function standbyMissing(ctx, params, rule, credit) {
  if (!ctx.hasExec || !ctx.hasPlan || ctx.calendarRun) return;
  const planCode = (day) => (day.plan?.codes ?? []).find((c) => codeIn(c, params.plan_codes, params.plan_code_prefixes));
  for (const run of dayRuns(ctx.timeline.filter((day) => planCode(day) && emptyExecDay(ctx, day)))) {
    const from = run[0].date;
    const to = run.at(-1).date;
    const many = run.length > 1;
    const codes = ctx.codeNames(run.map(planCode)); // בשם העברי ("כוננות"; טיוטה 403)
    const when = many ? `${from.slice(8, 10)}–${dayOf(to)}` : dayOf(from);
    const what = many ? 'ימי כוננות שאינם ברומה' : 'יום כוננות שאינו ברומה';
    const id = `standby_missing:${from}`;
    const answer = ctx.answer(id);
    const row = (label, message, byUser = false) => ctx.addChange({
      how: 'standby_missing', label, date: from, lastDay: to, to, planId: null, execId: null,
      // בצד התכנון שם הקוד, בלי הקוד (בעל המוצר, 22/10/2026; טיוטה 403; עד אז SBY, טיוטה 393).
      plan: many ? `${codes} ${when}` : codes, exec: null, notes: [{ message, byUser, ruleTitle: rule.title }],
    });
    if (!answer) {
      ctx.ask({
        id,
        date: from,
        title: `ב-${when} תוכננה ${params.missing_label}, וברומה לא רשום כלום ${many ? 'בימים האלה' : 'ביום הזה'}. מה קרה?`,
        options: [
          { value: 'standby_held', label: 'הכוננות התקיימה', hint: `${minToHhmm(credit * run.length)} – פער מול הרומה` },
          { value: 'standby_cancelled_mine', label: 'ביקשתי לבטל את הכוננות', hint: 'אין קרדיט' },
          otherOption(),
        ],
        ruleId: rule.id,
      });
      row(what, `ממתין לתשובה בשאלה על ${many ? 'הימים' : 'היום'}.`);
    } else if (answer.value === 'standby_held') {
      for (const day of run) creditDay(ctx, day, params, rule, credit, planCode(day));
      row('הכוננות התקיימה', many ? `קרדיט ${run.length} ימי כוננות.` : 'קרדיט יום כוננות.');
    } else if (answer.value === 'standby_cancelled_mine') {
      row('ביטול הכוננות לבקשתי', 'לא מגיע קרדיט.');
    } else {
      applyOtherReason(ctx, answer, rule, { what: `${what} (${when})`, date: from, noteExtra: { placed: true } });
      row('סיבה אחרת', `"${answer.text}" – ${answer.creditMin > 0 ? 'קרדיט נוסף' : 'לא מגיע קרדיט'}.`, true);
    }
  }
}

/** יום שברומה לא רשום בו כלום: לא קוד, לא רגל, ולא בתוך סבב. */
/** האם תוכננה ביום כוננות מסוג כלשהו. */
const standbyPlanned = (ctx, date) => (ctx.timeline.find((d) => d.date === date)?.plan?.codes ?? []).some((c) => c.startsWith('SBY'));

/** יום בשהייה של סבב: גם סבב שלא חזר בסוף החודש, שהרגל האחרונה שלו לפני היום הזה (טיוטה 455). */
const inStay = (p, date) => p.from <= date && (date <= p.to || !!p.cutAtEnd);
const emptyExecDay = (ctx, day) => !ctx.execCodes(day).length && !(day.exec?.legs ?? []).length &&
  !ctx.execPairings.some((p) => inStay(p, day.date));

/** ימים לפי הסדר, ברצפים של ימים עוקבים. */
function dayRuns(days) {
  const runs = [];
  for (const day of days) {
    const run = runs.at(-1);
    if (run && run.at(-1).date === addDays(day.date, -1)) run.push(day);
    else runs.push([day]);
  }
  return runs;
}

/**
 * ימים שתוכנן בהם קוד מ-`prefixes` (מילואים), מול הרומה – לפי מספר הימים ולא לפי היום (בעל המוצר, 22/10/2026; טיוטה 406):
 * יום מתוכנן שהקוד אינו בו ברומה מותאם ליום שהקוד ברומה ולא תוכנן בו (`moved`), קודם הימים שלא רשום בהם כלום ברומה,
 * כדי שטיסה או חופשה ביום המתוכנן לא ייבלעו בהזזה. מה שנשאר (`unserved`) לא בוצע.
 */
function unservedPlanDays(ctx, prefixes) {
  const has = (codes) => codes.some((c) => codeIn(c, [], prefixes));
  const missing = ctx.timeline.filter((d) => has(d.plan?.codes ?? []) && !has(ctx.execCodes(d)));
  const extra = ctx.timeline.filter((d) => has(ctx.execCodes(d)) && !has(d.plan?.codes ?? []));
  const byDate = (a, b) => a.date.localeCompare(b.date);
  const order = [...missing].sort((a, b) => Number(!emptyExecDay(ctx, a)) - Number(!emptyExecDay(ctx, b)) || byDate(a, b));
  const from = order.slice(0, extra.length).sort(byDate);
  return { moved: from.map((d, i) => ({ from: d.date, to: extra[i].date })), unserved: order.slice(extra.length).sort(byDate) };
}

/**
 * מילואים מתוכננים מול הרומה (`unserved_empty_rule`; בעל המוצר, 22/10/2026; טיוטה 406). ימים שזזו – הערה, בלי פער. יום
 * מתוכנן שלא בוצע ולא רשום בו כלום ברומה – ברירת המחדל ברומה היא יום חופשה: הזיכוי של החוק `unserved_empty_rule` (ואחריו
 * איזון החופשה), ושורה בשינויים, כמו יום כוננות שאינו ברומה. טיסה ביום כזה – `training_cancelled_flight` עם
 * `unserved_only`; קוד אחר – הזיכוי של החוק שלו. רק מול רומה, ולא מול היומן.
 */
function unservedEmptyDays(ctx, params, rule) {
  if (!ctx.hasExec || !ctx.hasPlan || ctx.calendarRun) return;
  const prefixes = params.plan_code_prefixes ?? [];
  const { moved, unserved } = unservedPlanDays(ctx, prefixes);
  const planCode = (date) => (ctx.timeline.find((d) => d.date === date)?.plan?.codes ?? []).find((c) => codeIn(c, params.plan_codes, prefixes));
  // בשם העברי, ובמילואים ברבים ("מילואים תוכננו"; `plural` ב-`codes.labels`).
  const verb = (code) => (ctx.codeLabel(code)?.plural ? 'ו' : ctx.codeLabel(code)?.feminine ? 'ה' : '');
  if (moved.length) {
    const code = planCode(moved[0].from);
    const planned = verb(code) ? `תוכננ${verb(code)}` : 'תוכנן'; // נון סופית רק בסוף המילה
    const list = (pre, dates) => dates.map((d, i) => `${i ? 'ו' : ''}${pre}-${dayOf(d)}`).join(' ');
    ctx.note(moved[0].from, `${ctx.codeName(code)} ${planned} ${list('ל', moved.map((m) => m.from))} ובוצע${verb(code)} ${list('ב', moved.map((m) => m.to))}.`, rule);
  }
  const empty = unserved.filter((d) => emptyExecDay(ctx, d));
  if (!empty.length) return;
  const target = ctx.rulesWithLogic('absence_day_credit').find((r) => r.id === params.unserved_empty_rule);
  if (!target) {
    ctx.review(`${rule.title}: ${empty.map((d) => dayOf(d.date)).join(', ')} – לא בוצעו, וברומה לא רשום כלום. החוק "${params.unserved_empty_rule}" אינו בתוקף.`, rule);
    return;
  }
  const p = target.logic.params;
  const one = target.short_title ?? target.title;
  const many = target.short_title_plural ?? (one.startsWith('יום ') ? `ימי ${one.slice(4)}` : `ימי ${one}`);
  for (const run of dayRuns(empty)) {
    const from = run[0].date;
    const to = run.at(-1).date;
    const code = planCode(from);
    const name = ctx.codeName(code);
    for (const day of run) {
      creditDay(ctx, day, p, target, H(p.credit_hours), p.plan_codes?.[0] ?? null,
        { explain: `${name} שלא בוצע${verb(code)}: ברירת המחדל ברומה היא ${one}.` });
    }
    const several = run.length > 1;
    ctx.addChange({
      how: 'reserve_missing', label: several ? `ימי ${name} שאינם ברומה` : `יום ${name} שאינו ברומה`,
      date: from, lastDay: to, to, planId: null, execId: null,
      plan: several ? `${name} ${from.slice(8, 10)}–${dayOf(to)}` : name, exec: null,
      notes: [{ message: several ? `קרדיט ${run.length} ${many}.` : `קרדיט ${one}.`, byUser: false, ruleTitle: rule.title }],
    });
  }
}

/**
 * `confirm_code_prefixes`: קוד שמתחיל בקידומת (SBY), ואף חוק זיכוי יומי אינו מונה אותו במפורש
 * (SBY_S הוא הכן מיידי), עוד לא נראה בקבצים. לא מנחשים: שואלים פעם אחת לכל קוד אם הוא
 * `confirm_label` (מצב הכן רגיל, 3:45). קוד בדוח (5 תווים) שהוא תחילת קוד בתכנון נשאל עליו.
 */
function unconfirmedCandidates(ctx, params) {
  const listed = new Set(ctx.rulesWithLogic('absence_day_credit')
    .flatMap((r) => [...(r.logic.params?.plan_codes ?? []), ...(r.logic.params?.report_codes ?? [])]));
  const byCode = new Map();
  const add = (code, date) => {
    if (listed.has(code) || !params.confirm_code_prefixes.some((x) => code.startsWith(x))) return;
    if (!byCode.has(code)) byCode.set(code, { code, dates: [], credits: new Set() });
    const c = byCode.get(code);
    if (!c.dates.includes(date)) c.dates.push(date);
    return c;
  };
  for (const day of ctx.timeline) for (const code of day.plan?.codes ?? []) add(code, day.date);
  const planCodes = [...byCode.keys()];
  for (const day of ctx.timeline) {
    for (const code of ctx.execCodes(day)) {
      const c = add(planCodes.find((p) => p.slice(0, 5) === code) ?? code, day.date);
      const reported = day.exec?.values?.Credit?.min;
      if (c && reported) c.credits.add(reported);
    }
  }
  return [...byCode.values()];
}

const confirmId = (code) => `standby_code:${code}`;

function confirmedCodes(ctx, params) {
  return unconfirmedCandidates(ctx, params)
    .filter((c) => ctx.answer(confirmId(c.code))?.value === params.confirm_answer).map((c) => c.code);
}

function askUnconfirmedCodes(ctx, params, rule) {
  const value = minToHhmm(H(params.credit_hours));
  for (const c of unconfirmedCandidates(ctx, params)) {
    const answer = ctx.answer(confirmId(c.code));
    const days = c.dates.map(dayOf).join(', ');
    if (!answer) {
      const credits = [...c.credits].map(minToHhmm).join(', ');
      ctx.ask({
        id: confirmId(c.code),
        date: c.dates[0],
        title: `קוד ${c.code}: האם זה ${params.confirm_label}?`,
        body: `הקוד מופיע ב-${days}${credits ? `, וברומה Credit ${credits}` : ''}. הוא עוד לא נראה בקבצים, ` +
          `והאפליקציה לא מנחשת את הזיכוי שלו. ${params.confirm_label} מזכה ב-${value} ליום.`,
        options: [
          { value: params.confirm_answer, label: `כן, ${params.confirm_label}`, hint: `${value} ליום` },
          { value: 'other', label: 'לא, משהו אחר', needsText: true },
        ],
        ruleId: rule.id,
      });
    } else if (answer.value === 'other') {
      ctx.explainCode(c.code, c.dates, answer.text || `לא ${params.confirm_label}`);
    } else {
      ctx.explainCode(c.code, c.dates, `${params.confirm_label} – ${value} ליום (${rule.title})`);
    }
  }
}

/**
 * כשיש דוח ביצוע, רק הדוח קובע: פעילות קרקע שתוכננה ליום אחד יכולה לזוז ליום אחר
 * (HOME_RGT תוכנן ל-07/01/2026 ובוצע ב-05/01). קוד התכנון משמש רק בלי דוח.
 */
const matchesCode = (day, params, ctx) => matchedCode(day, params, ctx) != null;

/**
 * הקוד שבגללו היום מזוכה, כדי שהסיכום יוכל למיין את הימים (HOME_RGT לעומת שאר אימון הקרקע).
 *
 * `exclude_codes` מוציא קוד מכלל הקידומת: VAC_NOC הוא חופשה ללא תשלום, ולכן קידומת VAC
 * של חוקי החופשה אינה חלה עליו (בעל המוצר, 23/09/2026).
 */
function matchedCode(day, params, ctx) {
  const ok = (c) => !(params.exclude_codes ?? []).includes(c);
  if (ctx.hasExec) return ctx.execCodes(day).find((c) => ok(c) && codeIn(c, params.report_codes, params.report_code_prefixes)) ?? null;
  return (day.plan?.codes ?? []).find((c) => ok(c) && codeIn(c, params.plan_codes, params.plan_code_prefixes)) ?? null;
}

const codeIn = (code, list = [], prefixes = []) => list.includes(code) || prefixes.some((p) => code.startsWith(p));

/**
 * איזון קרדיט לימי חופשה. מספר ימי החופשה בחודש קובע תוספת אחת לכל הימים.
 * עד `days_full_rate` ימים התוספת היא `per_day_hours`, ומעבר לזה לפי `taper_table`.
 *
 * הסכום מחושב כתוספת ליום × מספר הימים (החלטת בעל המוצר, 21/09/2026).
 * `taper_monthly_totals` אינו בשימוש בחישוב: הוא שונה מהמכפלה בעד 7 דקות.
 * `yearly_cap_days` נשמר כנתון בלבד: תקרת ימי החופשה השנתית אינה נבדקת בחודש
 * בודד, ואין טעם להעיר על כך בכל בדיקה (החלטת בעל המוצר, 23/09/2026).
 * העיגול לדקות נעשה על הסכום ולא על כל יום, כדי לא לצבור שגיאת עיגול.
 */
/** השורה של `n` ימים, ומעבר לטבלה שבהסכם – השורה האחרונה בה (טיוטה 459). */
const lastRow = (table, n) => String(Math.min(n, Math.max(...Object.keys(table).map(Number))));

function vacation_credit_balance(ctx, params, rule) {
  const days = ctx.timeline.filter((d) => ctx.isAbsenceBy(d.date, 'vacation_base_credit'));
  if (!days.length) return;

  const n = days.length;
  const full = params.days_full_rate ?? 20;
  let rate;
  if (n <= full) {
    rate = params.per_day_hours;
  } else if (params.taper_table_complete && params.taper_table?.[lastRow(params.taper_table, n)] != null) {
    rate = params.taper_table[lastRow(params.taper_table, n)];
  } else {
    ctx.review(`בחודש ${n} ימי חופשה, ואין לכך מדרגה בטבלת איזון החופשה ב-rules.json.`, rule);
    return;
  }

  const total = hoursToMin(n * rate);
  // חלוקת הסכום בין הימים כך שסכום החלקים שווה בדיוק לסכום המעוגל.
  days.forEach((day, i) => {
    const share = Math.round((total * (i + 1)) / n) - Math.round((total * i) / n);
    ctx.expect(day.date, 'absence', share, rule, `איזון חופשה: ${n} ימים × ${rate} ש'`);
  });

  const max = H(params.monthly_max_hours);
  if (max && total > max) {
    ctx.review(`איזון החופשה החודשי (${n} × ${rate}) עובר את התקרה של ${params.monthly_max_hours} שעות.`, rule);
  }
}

/**
 * יום חופשה ללא תשלום (VAC_NOC, בדוח VAC_N): אינו מזכה בכלום, אינו יורד ממכסת החופשה
 * ואינו נספר באיזון החופשה. ההערה מציינת כמה ימים כאלה היו בחודש, כדי שהיום לא ייעלם
 * בשקט מהדוח (בקשת בעל המוצר, 23/09/2026).
 */
function unpaid_leave_days(ctx, params, rule) {
  const days = ctx.timeline.filter((d) => matchesCode(d, params, ctx));
  if (!days.length) return;
  const what = days.length === 1 ? 'יום חופשה אחד ללא תשלום' : `${days.length} ימי חופשה ללא תשלום`;
  ctx.note(null, `${what} (${days.map((d) => dayOf(d.date)).join(', ')}).`, rule);
}

/**
 * ויתור מלון: יום שבעמודה NHTL ברומה רשום בו ערך (12:00 ב-14/03/2025). אינו מזכה בכלום לפי מה
 * שבקבצים; ההערה מציינת כמה ימים כאלה היו בחודש, ומזכירה להגיש עליהם טופס ויתור מלון (בעל המוצר, 09/10/2026).
 */
function hotel_waiver_days(ctx, params, rule) {
  const days = ctx.timeline.filter((d) => {
    const v = d.exec?.values?.[params.report_column];
    return !!(v?.min || v?.count);
  });
  if (!days.length) return;
  const what = days.length === 1 ? 'יום ויתור מלון אחד' : `${days.length} ימי ויתור מלון`;
  // בלי הצהרת ויתור מלון אין תשלום עליו (מצגת הרומה; בעל המוצר, 09/10/2026).
  const form = days.length === 1 ? 'התאריך הזה' : 'התאריכים האלה';
  ctx.note(null, `${what} (${days.map((d) => dayOf(d.date)).join(', ')}): יש להגיש טופס ויתור מלון על ${form}.`, rule, { order: 'first' });
}

/**
 * אש"ל צפוי בחודש (בעל המוצר, 09/10/2026; תלושי האש"ל מ-03/2025 עד 08/2026): שעות השהייה ושעות הטיסה,
 * כל אחת בתעריף שלה לשעה בתקופה (`rates`), ויתור מלון, ופחות ניכוי קטן לכל שעת שהייה ("טיפ" בתלוש).
 * שורה תחתונה בכרטיס הסיכום (`ctx.setPerDiem`), ולא הערה, בלי השוואה (בעל המוצר, 09/10/2026). התלוש משלם לפי העמודות ABR ו-PDFT ברומה, גם כשהן חריגות (35:50 ב-10/06/2026),
 * ולכן כשהן ברומה – לפיהן. כשהן חסרות (נובמבר 2025), ובתכנון לבד, השעות מחושבות מהרגליים ומהקרדיט הצפוי
 * (`perDiemHours`).
 * ויתור מלון (NHTL ברומה; `hotel_waiver`): עד 2025 – שעות ה-NHTL בתעריף השהייה, והן גם בבסיס הניכוי
 * (03/2025: ‏12 שעות, ‏75.00$); מ-2026 – סכום קבוע ליום, מחוץ לבסיס הניכוי (300$ על 2 ימים באוגוסט 2026).
 * השעות עשרוניות ומעוגלות לשתי ספרות, כמו בתלוש, והסכומים לסנטים.
 * תעריף השהייה לפי התפקיד (`stay_usd` לכל תפקיד; הסכם הבסיס, פרק כ"ט; בעל המוצר, 18/10/2026), ותעריף הטיסה משותף.
 * תפקיד לא ידוע, או בלי תעריף – לפי `default_position`, ובשורת האש"ל שהתפקיד לא ידוע (`positionAssumed`).
 */
function per_diem_estimate(ctx, params, rule) {
  const byPeriod = (list) => [...(list ?? [])].sort((a, b) => b.from.localeCompare(a.from)).find((r) => r.from <= ctx.monthFirst);
  const rate = byPeriod(params.rates);
  const hotel = byPeriod(params.hotel_waiver) ?? {};
  if (!rate) return;
  const position = rate.stay_usd[ctx.position] != null ? ctx.position : params.default_position;
  const stayRate = rate.stay_usd[position];
  const column = (c) => ctx.timeline.reduce((s, d) => s + (d.exec?.values?.[c]?.min ?? 0), 0);
  const computed = perDiemHours(ctx);
  const planned = plannedPerDiem(ctx);
  const romeStay = column(params.stay_column);
  // עמודה שאין בה ערך באף יום אינה ברומה של החודש (הרומה מציגה רק עמודות שיש בהן ערך).
  const stay = romeStay || computed.stay + planned.reduce((s, c) => s + c.extra, 0);
  const flight = column(params.flight_column) || computed.flight;
  const waivedDays = ctx.timeline.filter((d) => {
    const v = d.exec?.values?.[params.hotel_waiver_column];
    return !!(v?.min || v?.count);
  });
  if (!stay && !flight && !waivedDays.length) return;
  const hours = (min) => Math.round((min / 60) * 100) / 100;
  const cents = (usd) => Math.round(usd * 100) / 100;
  const flightH = hours(flight);
  const waivedH = hotel.as_stay_hours ? hours(column(params.hotel_waiver_column)) : 0;
  const hotelUsd = hotel.as_stay_hours ? cents(waivedH * stayRate) : waivedDays.length * (hotel.usd_per_day ?? 0);
  const totalFor = (min) => cents(cents(hours(min) * stayRate) + cents(flightH * rate.flight_usd) + hotelUsd
    - cents((hours(min) + waivedH) * params.stay_deduction_usd));
  // הרומה רושמת את השעות לפעמים על טיסה סמוכה (10/06/2026), ולכן ההשוואה על כל החודש (טיוטה 464).
  const gaps = [];
  let due = stay;
  let paid = Math.max(0, romeStay - computed.stay);
  for (const c of romeStay ? planned : []) {
    const missing = c.extra - Math.min(paid, c.extra);
    paid -= c.extra - missing;
    if (missing <= params.higher_stay_tolerance_minutes) continue;
    due += missing;
    gaps.push(`על ${describePairing(c.plans[0])} מגיע אש"ל לפי הטיסה ${c.word}, שהייה של ${minToHhmm(c.stay)}, וברומה חסרה שהייה של ${minToHhmm(missing)}.`);
  }
  // `rateFrom`/`rateSource`: התקופה של התעריף, ו-'slip' כשהוא מתלוש האש"ל במכשיר הזה ולא מ-rules.json (בעל המוצר, 18/10/2026).
  ctx.setPerDiem({ flightHours: flightH, stayHours: hours(due), hotelDays: waivedDays.length, usd: totalFor(due), position,
    rateFrom: rate.from, ...(rate.source && { rateSource: rate.source }),
    ...(position !== ctx.position && { positionAssumed: true }), ...(gaps.length && { gaps, rome: { stayHours: hours(stay), usd: totalFor(stay) } }) });
}

/**
 * שעות השהייה והטיסה של האש"ל, בדקות, מהרגליים ומהקרדיט הצפוי – לרומה בלי ABR ו-PDFT, ולתכנון לבד.
 * נבדקו מול ABR ו-PDFT בכל החודשים שיש בהם רומה (09/10/2026), ובנובמבר 2025 מול התלוש. לכל FDP (סבבים
 * בלי מנוחה חוקית ביניהם):
 * - שהייה: מההמראה הראשונה מהבסיס לחו"ל ועד הנחיתה האחרונה בבסיס – בפועל כשיש רומה, ובתכנון לבד STD
 *   עד STA; גם הזמן בבסיס בין שני סבבים באותו FDP (30/12/2025: BUS ו-LCA, ‏10:17). חזרה לבסיס אחרי
 *   המראה אינה נספרת כשאחריה יציאה לחו"ל (31/03/2025), ולבדה – מההמראה עד הנחיתה (15/09/2025, ‏00:25).
 *   סבב שנחתך בגבול החודש – עד הגבול.
 * - טיסה: הקרדיט וה-Rig הצפויים על הסבבים, וההשלמה לסליפ קצר לפי הקרדיט של כל ה-FDP יחד (30/12/2025:
 *   ‏07:19, בלי ה-Rig ‏02:41). Rig על סבב שלא בוצע (הורדה מהטיסה, 28/07/2026) אינו נכלל, וגם קרדיט של
 *   היעדרות ביום שנחת בו סבב (SICK ב-14/08/2026).
 */
/** השהייה בתוך החודש של סבבים באותו FDP, כולל הזמן בבסיס ביניהם. */
function stayOfGroup(ctx, group, first, last) {
  // לא `pairingTimes` עם `away`: הוא מסיים לפי ה-TAB של היום האחרון, שכולל גם היעדרות באותו יום.
  const legs = group.flatMap((p) => p.legs);
  const abroad = legs.find((l) => l.org === ctx.domicile && l.dst !== ctx.domicile);
  const out = abroad ?? legs.find((l) => l.org === ctx.domicile);
  const home = legs.findLast((l) => l.dst === ctx.domicile);
  const a = out ? legTimes(out, ctx.tz) : null;
  const b = home ? legTimes(home, ctx.tz) : null;
  const start = group[0].cutAtStart ? first : (a?.atd ?? a?.std);
  // ATA ברומה בנחיתה בבסיס הוא כבר שעון הבסיס, ומדויק יותר מ-ATD + ActDur (09/09/2024 TIV-TLV: ‏22:07, ‏ABR 10:07).
  const landed = b?.ata != null && home.ata != null ? b.ata + ((((home.ata - b.ata) % 1440) + 2160) % 1440) - 720 : b?.ata;
  const end = group.at(-1).cutAtEnd ? last : (landed ?? b?.sta);
  return start != null && end != null ? Math.max(0, Math.min(end, last) - Math.max(start, first)) : 0;
}

/**
 * טיסות שמגיע עליהן אש"ל לפי טיסה שלא בוצעה, ומה שנוסף בגללן בשעות שהייה: "[לרבות אש"ל] בגין הטיסה שביצע או בגין הטיסה
 * שהצבתו אליה בוטלה – לפי הגבוה" (2018 ס' 127, 91.1), וכשהועבר ל-777 – הטיסה שבוטלה (2026 ס' 23.4). הגבוה נקבע לפי הקרדיט,
 * כמו ב-`higher_of_planned_performed`, ולא לפי סכום האש"ל (בעל המוצר, 31/10/2026, טיוטה 467).
 */
function plannedPerDiem(ctx) {
  const first = at(ctx.monthFirst, 0);
  const last = at(ctx.timeline.at(-1).date, 1440);
  const stayOf = (list) => list.reduce((s, p) => s + stayOfGroup(ctx, [p], first, last), 0);
  const swaps = ctx.higherPairs.filter(({ diff }) => diff > 0)
    .map(({ plans, exec }) => ({ plans, stay: stayOf(plans), extra: stayOf(plans) - stayOf([exec]), word: 'המתוכננת' }));
  const moved = ctx.matches.filter((m) => m.plan && ctx.answerFor(m)?.value === 'swap_777')
    .map((m) => ({ plans: [m.plan], stay: stayOf([m.plan]), extra: stayOf([m.plan]), word: 'שבוטלה' }));
  return [...swaps, ...moved].filter((c) => c.extra > 0);
}

function perDiemHours(ctx) {
  const first = at(ctx.monthFirst, 0);
  const last = at(ctx.timeline.at(-1).date, 1440);
  const slipRule = ctx.rulesWithLogic('min_slip_credit')[0];
  const slip = slipRule?.logic.params ?? {};
  const groups = slip.per_fdp
    ? execFdpGroups(ctx, ctx.execPairings, H(slip.legal_rest_hours))
    : ctx.execPairings.map((p) => [p]);
  let stay = 0;
  let flight = 0;
  for (const group of groups) {
    stay += stayOfGroup(ctx, group, first, last);
    const credit = group.reduce((s, p) => s + ctx.expectedOn(p, 'flight'), 0);
    const rig = group.reduce((s, p) => s + ctx.expectedOn(p, 'rig', slipRule ? [slipRule.id] : []), 0);
    const slipped = slipRule && group.some((p) => ctx.expectedOn(p, 'rig') > ctx.expectedOn(p, 'rig', [slipRule.id]));
    flight += credit + rig + (slipped ? Math.max(0, H(slip.min_credit_hours) - credit) : 0);
  }
  return { stay, flight };
}

/** בחודש שכולו היעדרות, סך הזיכויים מוגבל. */
function absence_month_cap(ctx, params, rule) {
  ctx.capAbsenceTotal(H(params.cap_hours), rule);
}

// ---------- חוקי ביצוע ----------

/**
 * נחיתה מאוחרת בארץ: משווים ATA מול STA של הנחיתה בבסיס, כולל רגל DHO.
 * עד `grace_minutes` אין פיצוי, ומעבר לכך מדרגה לכל שעה או חלק ממנה.
 *
 * כל איחור מ-`note_from_minutes` ומעלה נרשם כהערה, גם כשמגיע עליו פיצוי: ההערה מפרטת
 * את משך האיחור, כמה מדרגות הן וכמה פיצוי יוצא מהן. משך האיחור בדקות עד שעה, ובשעות
 * (H:MM) מעבר לשעה (בעל המוצר, 24/09/2026).
 *
 * סטיה לשדה משנה (בעל המוצר, 03/10/2026): האיחור נמדד מול הנחיתה המקורית בבסיס, ולא מול
 * ה-STA של הרגל האחרונה, שנקבעה אחרי הסטיה (`diversionOf`). אם הרומה כבר זיכתה לפיו –
 * סטיה; אחרת שואלים (`diversion:`).
 */

/** משך איחור בהערה: בדקות עד שעה, אחרת H:MM בלי "שעות" (בעל המוצר, 24/09/2026 ו-29/09/2026). */
function delayText(min) {
  if (min <= 60) return `${min} דק'`;
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
}

function late_landing_home(ctx, params, rule) {
  const grace = params.grace_minutes ?? 60;
  const step = params.step_minutes ?? 60;
  const perStep = H(params.hours_per_step);
  // איחור קטן מזה אינו מעניין (בעל המוצר, 24/09/2026).
  const noteFrom = params.note_from_minutes ?? 0;
  const stepsOf = (delay) => (delay > grace ? Math.ceil((delay - grace) / step) : 0);
  const flat = ctx.timeline.flatMap((d) => (d.exec?.legs ?? []).map((leg) => ({ leg, date: d.date })));

  for (const [i, { leg, date }] of flat.entries()) {
    if (leg.dst !== ctx.domicile || leg.sta == null) continue;
    // רגל DH בלי ATA ברומה (22/03/2026 LY430 CDG→TLV): האיחור לא ניתן לחישוב. אם הרומה זיכתה COM
    // שחוקים אחרים אינם מסבירים, מניחים נחיתה מאוחרת בגובה מה שזוכה (בעל המוצר, 08/10/2026).
    if (leg.ata == null) {
      const left = ctx.reportedOnDate(date, 'COM') - ctx.expectedOnDate(date, 'com');
      if (leg.dhd && perStep && left > 0 && left % perStep === 0) {
        ctx.expect(date, 'com', left, rule, `${leg.flight}: ברומה חסר ATA והרומה זיכתה נחיתה מאוחרת`, { flight: leg.flight,
          explain: `ברומה חסר ה-ATA של ${leg.flight}, והיא זיכתה. האפליקציה מניחה נחיתה מאוחרת.` });
      }
      continue;
    }
    let delay = wrapDelta(leg.ata - leg.sta);
    let diverted = '';
    const div = diversionOf(flat, i, ctx.tz);
    if (div) {
      const divDelay = wrapDelta(leg.ata - div.sta);
      const divMin = stepsOf(divDelay) * perStep;
      if (divMin > stepsOf(delay) * perStep) {
        const id = `diversion:${date}:${leg.flight}`;
        // שמות השדות מבודדים: בלי זה "RHO (14:30). 6" מוצג כקטע לועזי אחד.
        const via = div.via.map((s) => `⁦${s}⁩`).join(' ו-');
        const answer = ctx.answer(id)?.value;
        if (answer === 'yes' || (!answer && ctx.paidOnDate(date, 'COM', 'com', divMin) && ctx.assume(id, 'yes', `כן, סטתה ל-${via}`))) {
          delay = divDelay;
          diverted = `, מול הנחיתה המתוכננת לפני הסטיה ל-${via} (${minToHhmm(div.sta)})`;
          // כל סטיה מופיעה בשינויים בין התכנון לביצוע, גם בסבב שלא תוכנן (`change`; בעל המוצר, 05/10/2026).
          const pairing = ctx.execPairings.find((p) => p.legs.some((l) => l.flight === leg.flight && l.date === date));
          if (pairing) {
            ctx.markPairing(pairing, 'diversion');
            ctx.note(date, `סטיה לשדה משנה: ${leg.flight} נחתה גם ב-${via}.`, rule, { change: true, pairingId: pairing.id });
          }
        } else if (!answer) {
          ctx.ask({
            id,
            date,
            title: `האם ${leg.flight} ב-${dayOf(date)} סטתה ל-${via} בדרך ל-${ctx.domicile}?`,
            body: `אם כן, הנחיתה המתוכננת ב-${ctx.domicile} הייתה ${minToHhmm(div.sta)}, והאיחור ${delayText(divDelay)}.`,
            options: [
              { value: 'yes', label: `כן, סטתה ל-${via}` },
              { value: 'no', label: `לא, הנחיתה ב-${via} תוכננה` },
            ],
            ruleId: rule.id,
          });
        }
      }
    }
    if (delay <= grace) {
      if (delay >= noteFrom && !leg.prevMonth) ctx.note(date, `${leg.flight} נחתה באיחור של ${delayText(delay)}, לא מעבר לסף של ${grace} דק'. אין פיצוי.`, rule);
      continue;
    }
    const steps = Math.ceil((delay - grace) / step);
    // רגל שהרומה חוזרת עליה ב-1 לחודש נבדקה בחודש ההמראה: נחיתה אחרי חצות נרשמת ביום הרגל (LY374 ‏03/08/2026,
    // ‏LY860 ‏11/03/2026). רק כשהרומה רשמה עליה ב-1 לחודש בדיוק את הסכום הוא מוסבר כאן (בעל המוצר, 30/10/2026, טיוטה 429).
    if (leg.prevMonth && ctx.reportedOnDate(date, 'COM') - ctx.expectedOnDate(date, 'com') !== steps * perStep) continue;
    const stepsWord = steps === 1 ? 'מדרגה אחת' : `${steps} מדרגות`;
    // ההסבר מוצג מתחת לטיסה בטבלת הפירוט, ולא בהערות (בעל המוצר, 01/10/2026). מספר הטיסה
    // נכתב רק כשהיא אינה לבדה בשורה: הפיצוי נרשם לכל FDP, ושורה של רגל אחת כבר נושאת אותו.
    const part = ctx.execPairings.flatMap((p) => fdpParts(p, ctx.fdp)).find((x) => x.legs.some((l) => l.flight === leg.flight && l.date === date));
    const who = part?.legs.length === 1 ? '' : `${leg.flight} `;
    // `flight`: לאיזה סבב שייך הפיצוי, כשהיום משותף לשני סבבים (טבלת הפירוט).
    ctx.expect(date, 'com', steps * perStep, rule, `${leg.flight}: איחור ${delay} דק' ← ${steps} מדרגות`, { flight: leg.flight,
      explain: `${who}נחתה באיחור של ${delayText(delay)}${diverted}. ${stepsWord} (כל ${step} דק' או חלק מהן).` });
  }
}

/**
 * סטיה לשדה משנה בדרך לבסיס: אותו מספר טיסה ממשיך משדה בחו"ל דרך שדה אחד או יותר
 * לבסיס, והרגל שאחרי הנחיתה הראשונה נקבעה רק אחריה (ה-STD שלה אחרי ה-ATA). ברגל
 * הראשונה נשארים ה-STD וזמן הטיסה המתוכנן המקוריים, ומהם הנחיתה המקורית בבסיס, בשעון
 * הבסיס (30/06/2024: LY5102 WAW‑AYT‑RHO‑TLV, ‏09:50 + 3:40 = 14:30, ‏ATA 21:14 → COM 03:00).
 * כשהרגל לבסיס נקבעה מראש זו אינה סטיה (20/06/2025: LY5420 PFO‑LCA‑TLV).
 */
function diversionOf(flat, i, tz) {
  const leg = flat[i].leg;
  if (!leg.flight) return null;
  let j = i;
  while (j > 0 && flat[j - 1].leg.flight === leg.flight && flat[j - 1].leg.dst === flat[j].leg.org) j--;
  if (j === i) return null;
  const first = flat[j].leg, next = flat[j + 1].leg;
  if (first.org === tz.domicile || first.std == null || first.skdDur == null || first.ata == null || next.std == null) return null;
  if (wrapDelta(next.std - first.ata) <= 0) return null;
  const t = legTimes({ ...first, date: flat[j].date }, tz);
  if (!t) return null;
  return { sta: mod(t.sta, 1440), via: flat.slice(j, i).map((x) => x.leg.dst) };
}

/**
 * טיסה ארוכה עם נחיתת ביניים (ישן כ"ה ס' 12.יב, בפרשנות בעל המוצר): הרגליים שהמריאו
 * באותו יום בשעון הבסיס הן יותר מרגל אחת, וסכום הקרדיט המתוכנן שלהן (STA − STD, כולל
 * DH) עולה על `over_flight_hours`. הפיצוי נרשם ב-COM. DH בחברה זרה אינו נספר: זו טיסה אחרת ולא נחיתת ביניים
 * (בעל המוצר, 30/10/2026, טיוטה 446).
 * אומת: DME הלוך-חזור 12:45 → COM 02:30 (18/01, 09/02, 17/05, 03/06/2026).
 */
const foreignDh = (l) => l.type === 'DHX' || (!!(l.dh || l.dhd || l.type === 'DHO') && !/^LY/.test(l.flight ?? ''));

function long_flight_day(ctx, params, rule) {
  const over = H(params.over_flight_hours);
  for (const pairing of ctx.execPairings) {
    const byDate = new Map();
    for (const leg of pairing.legs) {
      if (leg.skdDur == null || leg.prevMonth || foreignDh(leg)) continue; // `prevMonth`: נבדקה בחודש ההמראה (טיוטה 426)
      const d = byDate.get(leg.date) ?? { legs: 0, min: 0 };
      byDate.set(leg.date, { legs: d.legs + 1, min: d.min + leg.skdDur });
    }
    for (const [date, { legs, min: flown }] of byDate) {
      if (legs < 2 || flown <= over) continue;
      ctx.expect(date, 'com', H(params.hours), rule, `${describePairing(pairing)}: זמן טיסה ${minToHhmm(flown)} ביום`,
        { explain: `זמן טיסה ${minToHhmm(flown)}.` });
    }
  }
}

/**
 * מאיץ הדרכה לבוחנים (2024 ס' 12): סליפ הדרכה הוא סבב שבעמודת DD ברומה רשום באחת מהרגליים שלו
 * קוד מ-`dd_codes` (MAZ, ‏RCR; בעל המוצר, 08/10/2026). הסליפים נספרים לפי ההמראה מישראל, כך שסבב
 * שיצא בחודש הקודם אינו נספר. מהסליפ ה-`slip_threshold[צי]` בחודש – `hours` על כל סליפ.
 * אומת: מאי 2025, הסליפ השביעי (BUS ‏22/05) → COM 02:30.
 */
function examiner_training_boost(ctx, params, rule) {
  if (!ctx.hasExec) return;
  const threshold = params.slip_threshold?.[ctx.fleet];
  const codes = params.dd_codes ?? [];
  const slips = ctx.execPairings
    .filter((p) => !p.cutAtStart && p.legs.some((l) => (l.dd ?? '').split(',').some((c) => codes.includes(c.trim()))))
    .sort((a, b) => a.from.localeCompare(b.from));
  if (!slips.length) return;
  if (threshold == null) {
    ctx.review(`${rule.title}: ${slips.length} סליפי הדרכה בחודש, ואין ב-rules.json סף לצי ${ctx.fleet ?? 'לא ידוע'}.`, rule);
    return;
  }
  slips.forEach((pairing, i) => {
    if (i + 1 < threshold) return;
    ctx.expectPairing(pairing, keyFor(params.report_column), H(params.hours), rule,
      `${describePairing(pairing)}: סליפ הדרכה ${i + 1} בחודש`, { explain: `סליפ ההדרכה ה-${i + 1} בחודש.` });
  });
}

/** הפרש בין שעון לשעון, כשנחיתה אחרי חצות שייכת ליום הבא. */
function wrapDelta(delta) {
  if (delta < -720) return delta + 1440;
  if (delta > 720) return delta - 1440;
  return delta;
}

/** קריאה מיוחדת. S/C בדוח הוא הסימן שהטיסה לא הייתה מתוכננת. */
function special_call(ctx, params, rule) {
  const column = params.report_column ?? 'S/C';
  for (const { date, pairing } of ctx.reportDays) askReportDay(ctx, date, pairing, rule);
  for (const match of ctx.matches) {
    if (!match.exec || ctx.pairingHandledBy(match.exec, 'stay_extension')) continue;
    // הופעל מכוננות (לפי תשובתו): אין קריאה מיוחדת, גם כשהדוח רשם S/C.
    if (ctx.pairingHandledBy(match.exec, 'standby_activated')) continue;
    // סתירה עם סבב מתוכנן שנפתרה נגד הטיסה הזאת (`resolveLinkConflict`).
    if (ctx.pairingHandledBy(match.exec, 'swap_conflict_void')) continue;
    const reported = ctx.reportedOn(match.exec, column);
    const answer = ctx.answerFor(match);
    // הארכה שחוצה חודש (`carriedStay`; טיוטה 455). תשובה שכבר ניתנה על פעילות לא מתוכננת נשארת.
    if (!match.plan && !answer && carriedStay(ctx, match.exec)?.plan && extendedPairing(ctx, params, rule, match, null)) continue;
    // הנחיתה של סבב מהחודש הקודם (`carried_in`): קרדיט, ורק היממה האחרונה של קריאה מיוחדת (טיוטות 420, 428).
    if (match.how === 'carried_in') { carriedInCall(ctx, match.exec, params, rule, column); continue; }
    // סטיה לשדה משנה היא אותה טיסה, ולא קריאה מיוחדת, גם כשהרומה זיכתה S/C (`explainUnexplained`; בעל המוצר, 06/10/2026).
    if (ctx.pairingHandledBy(match.exec, 'diversion_assumed') || answer?.value === 'diversion') continue;

    const training = ctx.pairingHandledBy(match.exec, 'training_cancelled');
    const bid = ctx.pairingHandledBy(match.exec, 'standby_bid');
    // הסבב שתוכנן באותם ימים בוטל ללא קרדיט: מה שבוצע במקומו לא היה מתוכנן.
    const cancelledPlan = !!match.plan && ctx.pairingHandledBy(match.plan, 'cancelled_no_compensation');
    // טיסה ביום שלא תוכנן בו כלום, שבאה במקום סבב מתוכנן בשינוי ביוזמת החברה או בזכייה במכרז: גם קריאה
    // מיוחדת, בנוסף לגבוה מבין השתיים (`companySwapToFreeDay`; בעל המוצר, 06/10/2026). רק הוספה בהסכמה
    // והחלפה מרצוני אינן מזכות בקריאה מיוחדת.
    const companyLinked = companySwapToFreeDay(match, answer);
    // החלפה מרצוני: ההארכה מול לוח הזמנים של הסבב שהחלפת אליו, גם כשהוא בימים אחרים (`extensionMatch`).
    if ((match.plan || answer?.value === 'voluntary_swap') && !cancelledPlan && !training && !bid && extendedPairing(ctx, params, rule, match, answer)) continue;
    // החלפה מרצוני והוספה בהסכמה (לפי תשובת המשתמש): S/C שהרומה רשמה על הסבב אינו הופך אותו לקריאה מיוחדת,
    // והוא מוצג כפיצוי שאף חוק אינו מסביר (DME ‏11/03/2026 שהוחלף מרצון ב-FRA ‏10–12/03; בעל המוצר, 08/10/2026).
    const consented = ['voluntary_swap', 'added'].includes(answer?.value);
    const because = answer?.value === 'special_call' || companyLinked || training || bid || cancelledPlan;
    // טיסה לא מתוכננת שהרומה זיכתה עליה S/C, בלי תשובה: האפליקציה מניחה קריאה מיוחדת (`ctx.assume`), ואחרי ביטול
    // ההנחה – שואלת (טיוטה 365).
    const callId = `unplanned:${match.exec.id}`;
    const assumedCall = match.how === 'unplanned' && !answer && !because;
    if ((reported > 0 && !consented && !(assumedCall && ctx.assumeIgnored(callId))) || because) {
      const whole = wholePairing(match.exec, ctx.domicile);
      const stay = awayFromBase(whole, ctx.tz, ctx.timeline.at(-1).date);
      if (stay.error) {
        ctx.markPairing(match.exec, 'special_call');
        ctx.review(`${describePairing(match.exec)}: ${stay.error} לא ניתן לספור יממות לקריאה המיוחדת.`, rule);
        continue;
      }
      const days = countSpecialCallDays(stay, params, whole, ctx.fdp, seriesSpan(ctx, match.exec, stay));
      // רק יממות החודש הזה: השאר ברומה של החודש השכן (טיוטה 428).
      days.counted = days.counted.filter((d) => ctx.timeline.some((x) => x.date === d));
      // יום חופשה שנקראת ממנו (`vacation_recall`): הפיצוי עליו הוא על ביטול החופשה, ולא קריאה מיוחדת – גם מעל הסף
      // של היממה השנייה – ואין עליו הערה שאין קריאה מיוחדת (בעל המוצר, 21/10/2026, טיוטה 387; טל: ZRH נחתה ב-02/09).
      const recalled = (d) => ctx.pairingHandledBy(match.exec, `vacation_recall:${d}`);
      days.counted = days.counted.filter((d) => !recalled(d));
      // יממה שתוכננה בה כוננות אינה קריאה מיוחדת (ישן כ"ה ס' 12.ב), ועליה הגבוה מבין הרגליים בה לערך הכוננות. החריג:
      // זכייה במכרז (2024 ס' 50; טיוטה 456).
      if (!bid && days.counted.some((d) => standbyPlanned(ctx, d))) {
        days.counted = days.counted.filter((d) => !standbyPlanned(ctx, d));
        compareStandbyFlown(ctx, match.exec, ctx.rulesWithLogic('standby_activation')[0] ?? rule);
      }
      if (days.skipped && recalled(days.skipped.date)) delete days.skipped;
      if (!days.counted.length) {
        // סבב שיצא בחודש הקודם: היממה היחידה בחודש לא עמדה בסף, והרומה רשמה עליה S/C (טיוטה 428).
        if (days.skipped && ctx.reportedOnDate(days.skipped.date, column) > 0) ctx.note(days.skipped.date, `${flightsOf(match.exec)}: ${days.skipped.why}`, rule, { aside: true });
        continue;
      }
      // S/C ברומה שייך ליום שבו נרשם, ולא לסבב כולו (בעל המוצר, 08/10/2026): כשרק הוא הסיבה לקריאה המיוחדת,
      // יממה שתוכנן בה סבב (שלא בוטל ללא קרדיט) נספרת רק כשהרומה רשמה S/C עליה. בלי יממה כזאת – אין קריאה
      // מיוחדת, וה-S/C מוצג כפיצוי שאף חוק אינו מסביר (FRA ‏10–12/03/2026: S/C רק על 12/03).
      // ימי הסבב המתוכנן של הטיסה עצמה אינם קריאה מיוחדת גם כשהרומה רשמה בהם S/C: הוא שייך לפעילות אחרת ביממה
      // (בעל המוצר, 09/10/2026; סינתטי: ATH ‏02/08/2026 שבוצע כמתוכנן, ולפניו טיסה לא מתוכננת).
      // כך גם בהחלפה ביוזמת החברה או בזכייה במכרז ליום פנוי: ימי הסבב שהוחלף מכוסים בגבוה מבין השתיים, והקריאה
      // המיוחדת רק על היממות שלא תוכנן בהן סבב (בעל המוצר, 21/10/2026; טל: OPO ‏09–10/09 במקום TBS ‏10/09 – S/C רק על 09/09).
      // סבב מתוכנן שהתשובה עליו מעבירה אותו לטיסה אחרת (בימים אחרים, בחודש אחר, או מסירה ללא חלופה) אינו מתוכנן
      // בימיו (בעל המוצר, 21/10/2026; טיוטה 397; טל: TBS ‏10/09 שהוחלפה עם ZRH – OPO מקבלת גם על 10/09).
      const daysOf = (p) => (p.shownTo ? [...p.dates, p.shownTo] : p.dates);
      const movedAway = (p) => {
        const a = ctx.answer(`cancelled:${p.id}`);
        return ['voluntary_swap', 'replaced', 'bid'].includes(a?.value) && a.link !== match.exec.id;
      };
      const planned = new Set(ctx.planPairings.filter((p) => !ctx.pairingHandledBy(p, 'cancelled_no_compensation') && !movedAway(p)).flatMap(daysOf));
      // הדרכה שבוטלה (ישן כ"ה ס' 17.ג): על יום ההדרכה ועל ימים פנויים, ולא על יום שתוכננה בו טיסה (טיוטה 452).
      if (!because || companyLinked || (training && !cancelledPlan)) {
        const replaced = companyLinked ? ctx.planPairings.find((p) => `cancelled:${p.id}` === answer.via) : null;
        const own = new Set([match.plan, replaced].filter(Boolean).flatMap(daysOf));
        days.counted = days.counted.filter((d) => !own.has(d) && (!planned.has(d) || ctx.reportedOnDate(d, column) > 0));
        if (!days.counted.length) continue;
      }
      // יממה שלא עמדה בסף: ההערה רק כשהיום פנוי – ביום שתוכננה בו פעילות הקריאה המיוחדת אינה מגיעה בגללה (טיוטה 397).
      if (days.skipped && planned.has(days.skipped.date)) delete days.skipped;
      if (assumedCall) ctx.assume(callId, 'special_call', 'קריאה מיוחדת');
      ctx.markPairing(match.exec, 'special_call');
      // סבב שיצא בחודש הקודם: קריאה מיוחדת רק על יממה שלא תוכנן בה סבב, כמו ברומה (28/02–08/03/2026, BUD:
      // S/C על 01, 06 ו-07/03, ולא על GVA ‏02–03, ‏FCO ‏04–05 ו-VCE ‏08; בעל המוצר, 08/10/2026). יום הנחיתה
      // של סבב מתוכנן שנוחת אחרי חצות (`shownTo`) הוא מימיו.
      if (match.exec.cutAtStart) {
        const planned = new Set(ctx.planPairings.flatMap((p) => p.shownTo ? [...p.dates, p.shownTo] : p.dates));
        days.counted = days.counted.filter((d) => !planned.has(d));
      }
      // כל יממה שמגיעה עליה קריאה מיוחדת היא שורה משלה בטבלת הפירוט (`perDay`), בלי הסבר: הסכום
      // והחוק כבר בשורה (בעל המוצר, 01/10/2026). רק יממה שנספרה אחרי בדיקת הסף מוסברת בשורה שלה
      // (`lastWhy`). יממה שלא עמדה בסף אין לה שורה, ולכן ההסבר עליה בהערות, ביום שלה (`skipped`;
      // 20–21/07/2025: S/C רק על 20/07). `aside`: ההערה נשארת בהערות ואינה עוברת לשורת השינוי.
      // בכמה FDP נפרדים כל יממה נרשמת על ה-FDP שהתחיל בה או לפניה (בעל המוצר, 29/09/2026).
      const parts = fdpParts(match.exec, ctx.fdp);
      const partOf = (d) => parts.findLast((p) => p.from <= d) ?? parts[0];
      if (days.skipped) ctx.note(days.skipped.date, `${flightsOf(match.exec)}: ${days.skipped.why}`, rule, { aside: true });
      if (days.cut) ctx.note(match.exec.from, `${flightsOf(match.exec)}: ${days.cut}`, rule, { aside: true });
      // קריאה מיוחדת רק על יממה שלא תוכננה בה פעילות (`dayActivity`; בעל המוצר, 09/10/2026). ביממה שתוכננה בה
      // פעילות, עם מנוחה חוקית ביניהן – פעילות שנייה במקום הקריאה המיוחדת, באותו סכום, והיא שמוצגת מתחת לטיסה. הרומה
      // זיכתה עליה קריאה מיוחדת – הציפייה בעמודה שהרומה רשמה (S/C), כדי שלא יהיה פער; לא זיכתה – בעמודה של הפעילות
      // השנייה (08/10/2026). באותו FDP – כלום (2024 ס' 42.7); סימולטור מתוכנן – הפעילות השנייה נשאלת
      // ב-`second_unplanned_activity`. ביממה שלא תוכננה בה פעילות ובוצעו בה שתיים – קריאה מיוחדת, ופעילות שנייה על
      // המאוחרת (`second_unplanned_activity`).
      const second = ctx.rulesWithLogic('second_unplanned_activity')[0];
      const moved = new Set();
      for (const d of second ? days.counted : []) {
        const act = dayActivity(ctx, match.exec, d);
        if (!act.planned) continue;
        moved.add(d);
        if (!act.pairing?.planned) continue;
        const prev = act.pairing.pairing;
        ctx.markPairing(match.exec, 'second_activity');
        const flightOf = (p) => p.legs.find((l) => l.date === d && l.org === ctx.domicile)?.flight ?? flightsOf(p);
        // הפעילות המתוכננת לפני הטיסה: "נחתה" (גם אחרי חצות); אחריה: "יצאה".
        const before = (pairingTimes(prev, ctx.tz, { away: true }).end ?? Infinity) <= pairingTimes(match.exec, ctx.tz, { away: true }).start;
        const other = before ? `${prev.legs.findLast((l) => l.dst === ctx.domicile)?.flight ?? flightsOf(prev)} נחתה`
          : `${prev.legs.find((l) => l.org === ctx.domicile)?.flight ?? flightsOf(prev)} יצאה`;
        // S/C מעבר למה שכבר צפוי ביממה.
        const asSc = ctx.paidOnDate(d, column, 'sc', H(second.logic.params.hours));
        ctx.expectPairing(match.exec, asSc ? 'sc' : keyFor(second.logic.params.report_column), H(second.logic.params.hours), second,
          `${flightOf(match.exec)} לא הייתה בתכנון, ובאותה יממה ${other} עם מנוחה חוקית ביניהן`,
          { date: d, dates: [d], perDay: asSc, explain: act.pairing.broken ? 'שתי פעילויות עם מנוחה לא חוקית ביניהן.' : `פעילות שנייה ביממה: ${other} ביממה הזאת.${asSc ? ' הרומה רשמה אותה כקריאה מיוחדת, באותו סכום.' : ''}` });
      }
      // קריאה מיוחדת אחת ליממה: שני סבבים לא מתוכננים באותו FDP ביממה אחת (בעל המוצר, 09/10/2026).
      for (const d of days.counted.filter((x) => !moved.has(x) && !ctx.expectedOnDate(x, 'sc'))) {
        ctx.expectPairing(match.exec, 'sc', H(params.hours), rule, `${flightsOf(partOf(d))}: יממה ${dayOf(d)}.`,
          { date: d, dates: [d], perDay: true, explain: days.lastWhy && d === days.all.at(-1) ? days.lastWhy : '' });
      }
      continue;
    }
    // טיסה לא מתוכננת בלי S/C: לא מנחשים, שואלים.
    // טיסה בסוף כוננות: השאלה עליה היא של סיום כוננות למכרז.
    // טיסה של יממה אחת ביממה שתוכננה בה פעילות: אין קריאה מיוחדת, ומה שתלוי בתשובה הוא הפעילות השנייה – וכשאין
    // מנוחה חוקית ביניהן אין גם אותה, ואין מה לשאול; כשהרומה זיכתה אותה – מניחים (בעל המוצר, 09/10/2026).
    const second = ctx.rulesWithLogic('second_unplanned_activity')[0];
    const act = second && match.how === 'unplanned' && match.exec.from === match.exec.to ? dayActivity(ctx, match.exec, match.exec.from) : null;
    // גם ביממה שלא תוכננה בה פעילות, כשהייתה לפניה פעילות לא מתוכננת והרומה זיכתה פעילות שנייה: מניחים.
    const secondOnly = !!act?.planned;
    const secondPaid = !!act?.pairing && !answer && ctx.paidOnDate(match.exec.from, second.logic.params.report_column ?? 'COM',
      keyFor(second.logic.params.report_column ?? 'COM'), H(second.logic.params.hours)) && !!ctx.assume(callId, 'special_call', 'פעילות שנייה ביוזמת החברה');
    const reopened = ctx.assumeIgnored(callId);
    // קריאה מחופשה: הסיבה ידועה רק כשכל ימי הטיסה ימי חופשה; יום אחר בה נשאל כרגיל (בעל המוצר, 21/10/2026, טיוטה 388;
    // טל: ZRH יצאה ב-01/09, יום HOME_RGT, ונחתה ב-02/09, יום חופשה).
    const flightDays = match.exec.shownTo ? [...match.exec.dates, match.exec.shownTo] : match.exec.dates;
    const allRecalled = flightDays.every((d) => ctx.pairingHandledBy(match.exec, `vacation_recall:${d}`));
    if (match.how === 'unplanned' && params.ask_user_if_no_sc && !answer && !allRecalled &&
      !ctx.pairingHandledBy(match.exec, 'standby_bid_pending') && !secondPaid && !(secondOnly && !act.pairing && !act.sim) && !act?.pairing?.broken) {
      ctx.ask({
        id: `unplanned:${match.exec.id}`,
        date: match.exec.from,
        title: secondOnly ? `פעילות שלא תוכננה ביממה עם פעילות מתוכננת: ${describePairing(match.exec)}`
          : `פעילות ביום שלא תוכננה בו פעילות: ${describePairing(match.exec)}`,
        body: ctx.calendarRun ? 'הסיבה אינה בקבצים, והיא תקבע מה מגיע כשתועלה הרומה. מה קרה?'
          : reopened ? `הרומה מזכה ${secondOnly ? 'פיצוי על פעילות שנייה' : 'קריאה מיוחדת'}, והסיבה אינה בקבצים. מה קרה?`
          : secondOnly ? 'הרומה לא מזכה פיצוי על פעילות שנייה, ולכן לא ניתן לדעת אם הוא מגיע. מה קרה?'
            : 'הרומה לא מזכה קריאה מיוחדת, ולכן לא ניתן לדעת אם היא מגיעה. מה קרה?',
        // הוספת טיסה בהסכמה: רק הקרדיט של הטיסה, בלי קריאה מיוחדת (בעל המוצר, 06/10/2026).
        options: [
          { value: 'special_call', label: secondOnly ? 'פעילות שנייה ביוזמת החברה' : 'קריאה מיוחדת' },
          { value: 'added', label: 'הוספת טיסה בהסכמה' },
          { value: 'voluntary_swap', label: 'החלפה מרצוני או בהסכמתי', needsLink: true },
          otherOption(),
        ],
        ruleId: rule.id,
      });
    } else if (match.how === 'unplanned' && answer?.value === 'other') {
      applyOtherReason(ctx, answer, rule, { what: 'פעילות ביום שלא תוכננה בו פעילות', date: match.exec.from, pairing: match.exec });
    }
  }
}

/**
 * יום ברומה בלי טיסה, עם TAB, אחרי סבב שנחת לפני חצות (`attachReportTails` ב-js/rules/evaluate.js):
 * הקבצים אינם מסבירים למה שייכות השעות, ולא מנחשים (בעל המוצר, 08/10/2026). "המשך" מצרף את היום
 * לסבב, והשהייה והקריאה המיוחדת נספרות לפיו; תשובה אחרת – מה שנכתב בה והקרדיט שנבחר.
 */
function askReportDay(ctx, date, pairing, rule) {
  const id = `report_day:${date}`;
  const answer = ctx.answer(id);
  const values = ctx.timeline.find((d) => d.date === date)?.exec?.values ?? {};
  const cells = ['Credit', 'TAB'].filter((c) => values[c]?.min).map((c) => `${c} ${minToHhmm(values[c].min)}`).join(', ');
  if (answer?.value === 'other') {
    applyOtherReason(ctx, answer, rule, { what: `${dayOf(date)}: ברומה ${cells} בלי טיסה`, date });
    return;
  }
  if (answer) return;
  ctx.ask({
    id,
    date,
    title: `${dayOf(date)}: ברומה ${cells} בלי טיסה`,
    body: `הסבב ${describePairing(pairing)} נחת לפני חצות, ולכן לא ברור למה שייכות השעות האלה. מה קרה?`,
    options: [
      { value: 'continued', label: `הנחיתה של ${pairing.legs.at(-1).flight ?? flightsOf(pairing)} נדחתה ליום הזה`, hint: 'השהייה נמשכת עד היום הזה' },
      { value: 'other', label: 'משהו אחר', needsText: true, needsCredit: true },
    ],
    ruleId: rule.id,
  });
}

/**
 * פעילות ביום שלא תוכנן בו כלום (`unplanned`) שבאה במקום סבב מתוכנן בשינוי ביוזמת החברה או בזכייה
 * במכרז (התשובה על הסבב המתוכנן, דרך הקישור): מגיעים גם קריאה מיוחדת וגם הגבוה מבין השתיים (בעל
 * המוצר, 06/10/2026), ולכן זו אינה סתירה (`checkLinkConflicts`) ואינה מבטלת את "הגבוה מבין השתיים"
 * (`excluded_when_special_call`).
 */
function companySwapToFreeDay(match, answer) {
  return match?.how === 'unplanned' && !!answer?.via?.startsWith('cancelled:') && ['replaced', 'bid'].includes(answer.value);
}

/**
 * סבב שהתארך ליום שהסבב המתוכנן לא נגע בו (`extensionDays` ב-js/rules/duty.js; בעל המוצר, 06/10/2026): זו
 * אותה טיסה, עם הפסקה בין הרגליים או נחיתה באיחור אחרי חצות, ולכן אין "הגבוה מבין השתיים" – הקרדיט הוא
 * אותו קרדיט. על כל יום שלא תוכנן בו כלום מגיעה קריאה מיוחדת, בלי הסף של היממה השנייה, ועל יום שתוכננו
 * בו טיסה או סימולטור – פעילות שנייה לא מתוכננת (`second_unplanned_activity`, שקוראת את התשובה כאן);
 * בשניהם רק אם ההארכה לא הייתה בהסכמה. מעל `over_hours` זו הארכת שהייה (`overStay`): אותו חישוב, ותשובה שלישית,
 * "אירוע שלא בשליטת החברה", ש-`stay_extension` מטפלת בה (טיוטה 449). הסיבה אינה בקבצים, ולכן נשאלת כשהרומה לא
 * זיכתה. סבב שהוחלף באותם ימים (`dates`) – רק אחרי
 * התשובה עליו, וגם אז בנוסף לגבוה מבין השתיים. מחזירה true כשהסבב טופל כאן.
 */
function extendedPairing(ctx, params, rule, match, answer) {
  const ext = extensionDays(ctx, match);
  if (!ext) return false;
  const { exec } = match;
  const plan = match.plan ?? carriedStay(ctx, exec).plan;
  if (match.how === 'exact') ctx.markPairing(exec, 'extended');
  // החלפה מרצוני – מול לוח הזמנים של הסבב שהחלפת אליו (`extensionMatch`; בעל המוצר, 18/10/2026).
  const own = answer?.value === 'voluntary_swap';
  if (answer?.value === 'added') return false;
  if (match.how === 'dates' && !answer) return false;
  const days = ext.free;
  const over = overStay(ctx, match);
  // יום כוננות שהסבב נמשך אליו: בלי קריאה מיוחדת, והגבוה מבין הרגליים בו לערך הכוננות (טיוטה 456).
  if (ext.days.some((d) => standbyPlanned(ctx, d))) compareStandbyFlown(ctx, exec, ctx.rulesWithLogic('standby_activation')[0] ?? rule);
  if (!days.length && !ext.second.length && !over) return false;
  const id = `extended:${exec.id}`;
  const second = ctx.rulesWithLogic('second_unplanned_activity')[0]?.logic.params;
  // לפי יום: S/C על כל יממה פנויה שנוספה, ופעילות שנייה על כל יממה שתוכננה בה פעילות, ולא הסכום על הסבב
  // (בעל המוצר, 08/10/2026).
  const paid = (days.length > 0 || ext.second.length > 0) && days.every((d) => ctx.paidOnDate(d, params.report_column ?? 'S/C', 'sc', H(params.hours))) &&
    ext.second.every((d) => ctx.paidOnDate(d, second.report_column ?? 'COM', keyFor(second.report_column ?? 'COM'), H(second.hours)));
  // סבב שהוחלף באותם ימים בשינוי ביוזמת החברה או בזכייה במכרז: התשובה עליו כבר אומרת שהימים הנוספים
  // אינם בהסכמה, ועל יום שלא תוכנן בו כלום מגיעה קריאה מיוחדת, כמו ב-`companySwapToFreeDay` (בעל המוצר,
  // 08/10/2026; רון, ספטמבר 2026: WAW ב-10/09 שהוחלף ב-BCN ‏09–11/09). כך גם בהורדה עקב חניך: ס' 46 עוסק בקרדיט,
  // ואינו שולל קריאה מיוחדת (בעל המוצר, 30/10/2026, טיוטה 442).
  const swapped = match.how === 'dates' && ['replaced', 'bid', 'trainee'].includes(answer?.value);
  const a = extensionAnswer(ctx, exec) ?? (swapped ? { value: 'company' } : paid ? ctx.assume(id, 'company', 'הסבב הוארך ביוזמת החברה') : null);
  const list = ext.days.map(dayOf).join(', ');
  if (!a) {
    const due = [days.length ? 'קריאה מיוחדת' : null, ext.second.length ? 'פיצוי על פעילות שנייה באותה יממה' : null].filter(Boolean);
    ctx.ask({
      id,
      date: exec.from,
      title: over ? `חזרה מאוחרת לבסיס: ${over.whole}` : `סבב שהתארך: ${describePairing(exec)}`,
      body: over ? `${over.what}. ${ctx.calendarRun ? '' : 'הרומה לא מזכה על כל הימים, ו'}הפיצוי תלוי בסיבה, שאינה בקבצים. מה קרה?`
        : ctx.calendarRun
        ? `הסבב תוכנן ${describePairing(plan)}, וביומן התארך ל-${list}. ${due.join(' ו')} ` +
          `${due.length > 1 ? 'מגיעים' : days.length ? 'מגיעה' : 'מגיע'} רק כשההארכה לא הייתה בהסכמתך. מה קרה?`
        : own ? `הסבב ${describePairing(exec)}, שהחלפת אליו, התארך מעבר ללוח הזמנים שלו ל-${list}. הרומה לא מזכה ${due.join(' ו')}, ` +
          `${due.length > 1 ? 'והם מגיעים' : days.length ? 'והיא מגיעה' : 'והוא מגיע'} רק כשההארכה לא הייתה בהסכמתך. מה קרה?`
        : `הסבב תוכנן ${describePairing(plan)}, והתארך ל-${list}. הרומה לא מזכה ${due.join(' ו')}, ` +
          `${due.length > 1 ? 'והם מגיעים' : days.length ? 'והיא מגיעה' : 'והוא מגיע'} רק כשההארכה לא הייתה בהסכמתך. מה קרה?`,
      options: [
        { value: 'company', label: 'הסבב הוארך ביוזמת החברה' },
        { value: 'agreed', label: 'הסבב הוארך בהסכמתי' },
        ...(over ? [{ value: 'force_majeure', label: 'אירוע שלא בשליטת החברה (שביתה, סגירת נמל תעופה, התנכלות או תאונת כלי טיס)' }] : []),
      ],
      ruleId: over?.ruleId ?? rule.id,
    });
    return true;
  }
  if (a.value === 'agreed') {
    ctx.markPairing(exec, 'extended_agreed');
    if (ext.days.length) ctx.note(ext.days[0], `הסבב התארך: בהסכמתך, ולכן אין פיצוי על ההארכה ל-${list}.`, rule, { pairingId: exec.id });
    return true;
  }
  for (const d of days) {
    ctx.expectPairing(exec, 'sc', H(params.hours), rule, `${flightsOf(exec)}: יממה ${dayOf(d)}.`,
      { date: d, dates: [d], perDay: true, explain: swapped ? '' : 'הסבב התארך ליום שלא תוכנן בו כלום.' });
  }
  // מתחת להחלפה מרצוני גם הקריאה המיוחדת על ההארכה: `DAY_DUES` בהערה של `voluntary_swap`.
  return true;
}

/**
 * זמן שהייה מחוץ לבסיס (פרק כ"ה ס' 1.יא), לפי `pairingTimes` עם `away`: מההמראה המתוכננת או
 * בפועל, המוקדמת מביניהן, ועד הנחיתה בפועל בבסיס. זמנים מוחזרים כדקות מתחילת היממה הראשונה,
 * בשעון הבסיס. סבב שחוזר בחודש הבא – עד סוף החודש; סבב שיצא בחודש הקודם – מתחילת החודש.
 */
function awayFromBase(pairing, tz, monthEnd) {
  const out = pairing.legs.find((l) => l.org === tz.domicile);
  const home = pairing.legs.findLast((l) => l.dst === tz.domicile);
  const carried = !out && pairing.cutAtStart;
  if ((!out && !carried) || (!home && !pairing.cutAtEnd)) return { error: 'הסבב לא יוצא מהבסיס או לא חוזר אליו.' };
  const first = pairing.from;
  const span = pairingTimes(pairing, tz, { away: true });
  if (carried) {
    if (span.end == null) return { error: 'חסרים שעת נחיתה בבסיס או משך הטיסה.' };
    return { first, start: 0, end: span.end - at(first, 0), cutAtStart: true };
  }
  if (span.start == null) return { error: 'חסרה שעת המראה מהבסיס.' };
  const start = span.start - at(first, 0);
  if (!home) return { first, start, end: (daysBetween(first, monthEnd) + 1) * 1440, cutAtEnd: true };
  if (span.end == null) return { error: 'חסרים שעת נחיתה בבסיס או משך הטיסה.' };
  return { first, start, end: span.end - at(first, 0) };
}

/**
 * הנחיתה של סבב מהחודש הקודם (`carried_in`): היממה האחרונה של קריאה מיוחדת שחוצה חודש נבדקת כאן, על השהייה כולה
 * (ישן כ"ה ס' 12.יא; בעל המוצר, 30/10/2026, טיוטה 428). הסבב היה קריאה מיוחדת אם הרומה הקודמת רשמה S/C בימיו.
 * בלעדיה אי אפשר לבדוק את הסף, וה-S/C ב-1 לחודש הוא ההכרעה. קריאה מיוחדת רק על יממה שלא תוכננה בה פעילות.
 */
function carriedInCall(ctx, pairing, params, rule, column) {
  const date = pairing.legs.at(-1).date;
  if (ctx.pairingHandledBy(pairing, `vacation_recall:${date}`)) return;
  if (ctx.planPairings.some((p) => (p.shownTo ? [...p.dates, p.shownTo] : p.dates).includes(date))) return;
  const paid = ctx.reportedOnDate(date, column) > 0;
  const expect = (explain) => {
    ctx.markPairing(pairing, 'special_call');
    ctx.expectPairing(pairing, 'sc', H(params.hours), rule, `${flightsOf(pairing)}: יממה ${dayOf(date)}.`, { date, dates: [date], perDay: true, explain });
  };
  if (pairing.carriedSource !== 'exec') {
    if (paid) expect('הרומה מזכה את הפיצוי. האפליקציה מניחה קריאה מיוחדת על היממה האחרונה של סבב מהחודש הקודם.');
    return;
  }
  if (!paidEarlier(ctx, pairing, column, 1)) return;
  const whole = wholePairing(pairing, ctx.domicile);
  const stay = awayFromBase(whole, ctx.tz, ctx.timeline.at(-1).date);
  if (stay.error) return;
  const days = countSpecialCallDays(stay, params, whole, ctx.fdp);
  if (days.counted.includes(date)) expect(days.lastWhy ?? '');
  else if (paid && days.skipped) ctx.note(date, `${flightsOf(pairing)}: ${days.skipped.why}`, rule, { aside: true });
}

/**
 * יממות לתשלום קריאה מיוחדת. יממה היא יום קלנדרי בשעון מקומי (ישן כ"ה ס' 12.א).
 * "כל יממה או חלק ממנה" (12.ג), אבל היממה האחרונה נספרת רק אם השהייה כולה ארוכה מ-
 * `second_day_min_gap_hours`, ולפחות `second_day_min_hours` ממנה ביממה האחרונה (12.יא) –
 * ורק כשהיממה האחרונה היא המשך של אותו FDP שחוצה חצות. כשהיממה האחרונה פותחת FDP משלה
 * (מנוחה אמיתית לפני, לא רק חיבור בין רגליים) זו יממת עבודה נפרדת לפי 12.ג, ונספרת בלי
 * בדיקת הסף: 19–20/06/2025, TLV-LCA ב-19 ואחרי מנוחה PFO-LCA-TLV שיוצאת כולה ב-20.
 */
function countSpecialCallDays(stay, params, pairing, fdp, series = null) {
  const firstDay = Math.floor(stay.start / 1440);
  const lastDay = Math.floor((stay.end - 1) / 1440);
  const all = [];
  for (let d = firstDay; d <= lastDay; d++) all.push(addDays(stay.first, d));
  // הסבב חוזר בחודש הבא: כל היממות עד סוף החודש נספרות (`cut`: הערה על כך).
  if (stay.cutAtEnd) return { counted: all, all, cut: 'הסבב חוזר בחודש הבא, והיממה האחרונה נבדקת בחודש הבא.' };
  if (all.length === 1) return { counted: all, all };
  // היממה האחרונה פותחת FDP נפרד, אחרי מנוחה חוקית, ולכן נספרת בלי בדיקת סף.
  if (pairing && lastFdpStartsOn(pairing, fdp, all.at(-1))) return { counted: all, all, ownFdp: true };

  // `lastWhy`: ההסבר בשורה של היממה האחרונה, כשהיא נספרת. `skipped`: היממה שלא נספרה, ולמה.
  const total = (series?.end ?? stay.end) - (series?.start ?? stay.start);
  const inLast = (series?.end ?? stay.end) - lastDay * 1440;
  const gap = H(params.second_day_min_gap_hours);
  const min = H(params.second_day_min_hours);
  const which = all.length === 2 ? 'השנייה' : 'האחרונה';
  const need = `שהייה של מעל ${minToHhmm(gap)}, מתוכן לפחות ${minToHhmm(min)} ביממה ${which}`;
  if (total > gap && inLast >= min) return { counted: all, all, lastWhy: `בוצעה ${need}.` };
  return {
    counted: all.slice(0, -1),
    all,
    skipped: { date: all.at(-1), why: `אין קריאה מיוחדת על היממה ${which}. סה"כ זמן שהייה ${minToHhmm(total)}, מתוכן ${minToHhmm(inLast)} ביממה ${which}. נדרשת ${need}.` },
  };
}

/**
 * סדרת טיסות דרך הבסיס: סבבים באותו FDP, בלי חזרה לבסיס למנוחה (ישן כ"ה ס' 1.יד). השהייה נגמרת רק בנחיתה האחרונה (ס' 1.יא(2)),
 * ולכן הסף של היממה השנייה נמדד על כולם, בדקות מתחילת היממה הראשונה של `stay`. null כשהסבב לבדו (בעל המוצר, 31/10/2026, טיוטה 456).
 */
function seriesSpan(ctx, pairing, stay) {
  if (!ctx.fdp) return null;
  const group = execFdpGroups(ctx, ctx.execPairings, ctx.fdp.legalRestMin).find((g) => g.includes(pairing));
  if (!group || group.length < 2) return null;
  const spans = group.map((p) => pairingTimes(p, ctx.tz, { away: true }));
  if (spans.some((s) => s.start == null || s.end == null)) return null;
  const zero = at(stay.first, 0);
  return { start: Math.min(...spans.map((s) => s.start)) - zero, end: Math.max(...spans.map((s) => s.end)) - zero };
}

/** מספרי הטיסות של הסבב לפתיח של הערה: LY5109-LY5110. מספר שחוזר ברצף נכתב פעם אחת. */
function flightsOf(p) {
  const nums = p.legs.map((l) => l.flight ?? (l.type === 'DHX' ? 'DH' : null)).filter(Boolean);
  const unique = nums.filter((f, i) => f !== nums[i - 1]);
  return unique.length ? `⁦${unique.join('-')}⁩` : describePairing(p);
}

/**
 * האם ה-FDP האחרון בסבב (המסתיים בנחיתה בבסיס) מתחיל ביממה `lastDate` עצמה. בלי `fdp` (חסר
 * `legal_rest_hours` בפרמטרים של הסליפ הקצר) אי אפשר לדעת, ומניחים שזה המשך.
 */
function lastFdpStartsOn(pairing, fdp, lastDate) {
  const parts = fdpParts(pairing, fdp);
  return parts.length > 1 && parts.at(-1).from === lastDate;
}

const mod = (n, m) => ((n % m) + m) % m;
const dayMs = 86400000;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / dayMs);
const addDays = (iso, n) => new Date(Date.parse(iso) + n * dayMs).toISOString().slice(0, 10);
const dayOf = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7);

/**
 * תשובות שמשלמות את הגבוה מבין שתי הטיסות: שינוי ביוזמת החברה, זכייה במכרז, וסטיה לשדה משנה – אין
 * עליה סעיף בהסכמים, ושינוי בגלל מזג אוויר הוא שינוי של החברה (ישן, כ"ה; בעל המוצר, 05/10/2026).
 */
const COMPANY_PAID_SWAPS = ['replaced', 'bid', 'diversion'];
const SWAP_WORD = { bid: 'זכייה במכרז', diversion: 'סטיה לשדה משנה' };
const swapWord = (answer) => SWAP_WORD[answer?.value] ?? 'שינוי ביוזמת החברה';

/**
 * שינוי בתוכנית: תשלום לפי הגבוה מבין המתוכנן לבין שבוצע. חל אחרי תשובה "החלפה ביוזמת
 * החברה" בשאלה על הסבב המתוכנן שלא בוצע (`cancelled_no_compensation`), כי טיסה אחרת באותם
 * ימים אינה מוכיחה החלפה (בקשת בעל המוצר, 24/09/2026): ייתכן שהמתוכננת בוטלה ומה שבוצע היה
 * קריאה מיוחדת, וייתכן שמגיעות עליה השעות שהפסיד.
 *
 * הטיסה שבוצעה במקום היא זו שנבחרה בקישור שבתשובה: הסבב שבוצע באותם ימים, או כל פעילות
 * שלא תוכננה. טיסה שאינה בקבצים של החודש – הערה שההפרש לא חושב, כי אי אפשר לחשב את ההפרש.
 */
function higher_of_planned_performed(ctx, params, rule) {
  const column = params.shortfall_column === 'Rig' ? 'rig' : 'com';
  const reportColumn = params.shortfall_column ?? 'COM';
  for (const match of ctx.matches) {
    if (!match.plan) continue;
    // סטיה לשדה משנה שהונחה מהקבצים (`assumeDiversion`) היא כמו תשובה.
    const answer = ctx.answerFor(match) ?? (ctx.pairingHandledBy(match.plan, 'diversion') ? { value: 'diversion' } : null);
    if (params.excluded_when_voluntary_swap && answer?.value === 'voluntary_swap') continue;
    if (answer && !COMPANY_PAID_SWAPS.includes(answer.value)) continue;
    if (!answer && (params.requires_user_answer || match.how !== 'dates')) continue;
    if (ctx.pairingHandledBy(match.plan, 'lost_hours_credit')) continue;
    if (ctx.pairingHandledBy(match.plan, 'cancelled_no_compensation')) continue;
    // סתירה עם החלפה מרצון שנפתרה נגד הסבב הזה (`resolveLinkConflict`).
    if (ctx.pairingHandledBy(match.plan, 'swap_conflict_void')) continue;
    // התשובה מהחודש הקודם: ההשוואה נעשתה שם (`inheritAnswer`).
    if (ctx.pairingHandledBy(match.plan, 'inherited')) continue;

    // תשובה ישנה נשמרה בלי קישור, ואז ההחלפה היא הסבב שבוצע באותם ימים.
    const exec = answer && 'link' in answer ? (answer.link ? ctx.pairingById(answer.link) : null) : match.exec;
    if (!exec) {
      ctx.note(match.plan.from, `${swapWord(answer)} בטיסה שאינה בקבצים של החודש: ההפרש לא חושב.`, rule, { pairingId: match.plan.id });
      continue;
    }
    // שינוי ביוזמת החברה או זכייה במכרז לטיסה ביום שלא תוכנן בו כלום (`companySwapToFreeDay`), וזכייה
    // במכרז ביומן שהוחלפה בטיסה כזאת (`alsoSpecialCall`, `applyRootChain` ב-js/rules/evaluate.js): גם קריאה
    // מיוחדת וגם הגבוה מבין השתיים (בעל המוצר, 06/10/2026).
    const execMatch = ctx.matches.find((x) => x.exec === exec);
    const alsoSc = !!answer?.alsoSpecialCall || (['replaced', 'bid'].includes(answer?.value) && execMatch?.how === 'unplanned');
    if (params.excluded_when_special_call && !alsoSc && ctx.pairingHandledBy(exec, 'special_call')) continue;

    // כמה סבבים שהוחלפו בטיסה אחת: הקרדיט של כולם יחד מול הטיסה, פעם אחת (בעל המוצר, 30/10/2026, טיוטה 440).
    const group = ctx.matches.filter((x) => {
      const a = x.plan ? ctx.answer(`cancelled:${x.plan.id}`) : null;
      return a?.link === exec.id && COMPANY_PAID_SWAPS.includes(a.value);
    });
    if (group.length > 1 && !group.includes(match)) continue;
    if (group.length > 1 && group[0] !== match) {
      ctx.note(match.plan.from, `${swapWord(answer)}: קרדיט של הטיסות שהוחלפו יחד, מול הטיסה שבוצעה${DAY_DUES}.`, rule, { pairingId: match.plan.id, callOf: exec.id });
      continue;
    }
    // בשרשרת מהיומן: הגבוה מבין הסבבים שלא בוצעו (`reduceChain`; בעל המוצר, 06/10/2026).
    const planned0 = answer?.basis ?? match.plan;
    const together = group.length > 1 ? group.reduce((s, x) => s + (ctx.plannedCredit(x.plan) ?? 0), 0) : null;
    const diff = together == null ? plannedMinusPerformed(ctx, planned0, exec) : together - sumLegs(exec, ctx.domicile);
    if (diff == null) continue;
    ctx.higherPairs.push({ plans: group.length > 1 ? group.map((x) => x.plan) : [planned0], exec, diff });

    // "הגבוה מבין השתיים" הוא סך הכול, לא תוספת על ההשלמה למינימום שהסבב שבוצע מקבל בזכות
    // עצמו: כשהמתוכנן גבוה גם מהמינימום, הנוסף הוא רק ההפרש שמעבר להשלמה שכבר צפויה
    // (`min_slip_credit` רץ קודם); כשההשלמה למינימום כבר גבוהה מההפרש, אין תוספת נוספת
    // (יוני 2025: ZRH מתוכנן מול LCA שבוצע, בעל המוצר 24/09/2026).
    const alreadyMinSlip = diff > 0 && column === 'rig' ? minSlipTopUp(ctx, exec) : 0;
    const extra = diff - alreadyMinSlip;

    // הערה בכל החלפה ביוזמת החברה, גם כשהטיסה שבוצעה ארוכה יותר ואין הפרש (בעל המוצר, 29/09/2026).
    const planned = together ?? ctx.plannedCredit(planned0);
    const performed = planned - diff;
    // ההערה היא כותרת בלבד, בלי סכומים: ההשוואה והתוספת בטבלת הפירוט, בשורה של התוספת. רק כשאין
    // שורה כזאת ההערה אומרת למה: הטיסה שבוצעה היא הארוכה, או שההפרש כבר בהשלמה לסליפ קצר
    // (בעל המוצר, 01/10/2026).
    const which = diff <= 0 ? ': הטיסה שבוצעה' : extra <= 0 ? ': ההפרש כבר כלול בהשלמה לסליפ קצר' : '';

    // לפעמים ההשלמה נרשמת על סבב סמוך ולא על המחליף עצמו (10/06/2026: LTN 11–12 → OTP 11,
    // ה-Rig 05:10 נרשם על OTP של 10/06). ההערה אומרת איפה, כדי שהסכום ביום האחר לא ייראה
    // כזיכוי על הטיסה של אותו יום (בעל המוצר, 29/09/2026).
    const m = { ...match, exec };
    const paidOn = extra <= 0 ? null
      : findShortfallPaid(ctx, m, extra, column, reportColumn) ?? findShortfallPaid(ctx, m, extra, column, reportColumn, true);
    const moved = paidOn && paidOn !== exec ? paidOn : null;
    // הפיצויים היומיים על הטיסה שבוצעה – קריאה מיוחדת (גם על הארכה ליום פנוי, `extendedPairing`), קריאה מחופשה, פעילות
    // שנייה – על הימים שהם מגיעים עליהם, לא "על הטיסה שבוצעה" (`DAY_DUES`; בעל המוצר, 21/10/2026; טיוטות 395, 398).
    // `pairingId`: רק בשורה של הסבב, ולא מתחת לטיסה אחרת שבוצעה באותם ימים.
    ctx.note(match.plan.from, `${swapWord(answer)}: קרדיט של הטיסה הארוכה מבין השתיים${which}${DAY_DUES}.`, rule, { pairingId: match.plan.id, callOf: exec.id });
    // הרגל האחרונה של הסבב המתוכנן אינה ידועה בחודש ההמראה (בעל המוצר, 30/10/2026, טיוטה 433).
    if (match.plan.cutAtEnd) ctx.note(match.plan.from, 'הסבב המתוכנן חוזר בחודש הבא, וההשוואה היא רק לחלק שבחודש הזה.', rule, { pairingId: match.plan.id });
    // ביום של הטיסה שבוצעה, כשהוא אחר ובשורה משלו.
    if (exec.from !== match.plan.from && match.exec !== exec) {
      ctx.note(exec.from, `${swapWord(answer)}: קרדיט על הטיסה שבוצעה${DAY_DUES}.`, rule, { pairingId: exec.id, callOf: exec.id });
    }
    if (extra <= 0) continue;

    const where = moved ? `, ונרשם על ${describePairing(moved)}` : '';
    const why = alreadyMinSlip
      ? `ההפרש הכולל לפי "הגבוה מבין השתיים" הוא ${minToHhmm(diff)}, ומתוכו ${minToHhmm(alreadyMinSlip)} כבר בהשלמה למינימום שמוצגת בנפרד; הנוסף כאן ${minToHhmm(extra)}`
      : 'ההפרש לפי "הגבוה מבין השתיים"';
    // `forPlan`: הציפייה שייכת להחלפה של הסבב המתוכנן, גם כשהיא רשומה על סבב אחר (`explainChanges`).
    // `showOn`: בטבלת הפירוט השורה מוצגת על הטיסה שהחליפה, עם מה שהרומה רשמה על הסבב האחר, וההסבר
    // אומר איפה זה ברומה (בעל המוצר, 01/10/2026; 10–11/06/2026). לחוקים הציפייה נשארת על הסבב
    // שעליו הרומה רשמה אותה, כדי שהסכום שם לא ייראה להם כזיכוי בלי הסבר.
    const explain = `${swapWord(answer)}, מגיע הקרדיט של הטיסה הארוכה מבין השתיים (${minToHhmm(planned)} לעומת ${minToHhmm(performed)}).` +
      (alreadyMinSlip ? ` מתוך ההפרש, ${minToHhmm(alreadyMinSlip)} כבר בהשלמה לסליפ קצר.` : '') +
      (moved ? ` הקרדיט הזה מופיע ברומה ב-${dayOf(moved.from)}.` : '');
    ctx.expectPairing(paidOn ?? exec, column, extra, rule,
      `המתוכנן (${describePairing(planned0)}) גבוה מהמבוצע. ${why}${where}.`, { explain, ...(moved ? { forPlan: match.plan.id, showOn: exec.id } : {}) });
  }
}

/** ההפרש בין הקרדיט המתוכנן לבין מה שבוצע במקומו, או null כשאי אפשר לחשב את אחד מהם. */
function plannedMinusPerformed(ctx, planPairing, execPairing) {
  const planned = ctx.plannedCredit(planPairing);
  const performed = execPairing ? sumLegs(execPairing, ctx.domicile) : null;
  return planned == null || performed == null ? null : planned - performed;
}

/**
 * הסבב שעליו הדוח כבר רשם את ההפרש: קודם הסבב המחליף, ואחר כך סבב ביצוע שנוגע בטווח של
 * יום אחד מהסבב המתוכנן. הסכום הוא מה שבדוח פחות מה שכבר צפוי עליו מחוקים אחרים.
 * `atLeast` מרפה את ההשוואה מ"בדיוק ההפרש" ל"לפחות ההפרש", לבדיקה אם הפיצוי כבר התקבל.
 */
function findShortfallPaid(ctx, match, diff, key, column, atLeast = false) {
  const hit = (p) => {
    const extra = ctx.reportedOn(p, column) - ctx.expectedOn(p, key);
    return atLeast ? extra >= diff : extra === diff;
  };
  if (hit(match.exec)) return match.exec;
  const from = addDays(match.plan.from, -1);
  const to = addDays(match.plan.to, 1);
  return ctx.execPairings.find((p) => p !== match.exec && p.dates.some((d) => from <= d && d <= to) && hit(p)) ?? null;
}

/** השעות שהפסיד (מטוס חכור, חניך, 787 שהוחלף ב-777), לפי התשובה `answer_value`. כולל השלמה לסליפ קצר. */
function lost_hours_credit(ctx, params, rule) {
  for (const match of ctx.matches) {
    if (!match.plan) continue;
    const answer = ctx.answerFor(match);
    // בלי תשובה, כשהדוח כבר מזכה את השעות שהפסיד על סבב שלא בוצע: אין פער, ולא שואלים
    // מה קרה (החלטת בעל המוצר, 23/09/2026). הזיכוי נרשם על החוק הראשון שמתאים.
    const assumed = !answer && match.how === 'cancelled' ? paidLostHours(ctx, match.plan) : null;
    // `merged_answer_values`: תשובה שנשמרה לפני שהאפשרויות אוחדו (wet_lease) ממשיכה לעבוד.
    const values = [params.answer_value, ...(params.merged_answer_values ?? [])];
    if (!values.includes(answer?.value) && assumed?.rule !== rule) continue;
    // סתירה עם החלפה מרצון שנפתרה נגד הסבב הזה (`resolveSwapConflict`).
    if (ctx.pairingHandledBy(match.plan, 'swap_conflict_void')) continue;
    if (!lostHoursApplies(ctx, match.plan, params)) continue;

    // בשרשרת מהיומן: השעות של הגבוה מבין הסבבים, ביום של הסבב שממנו הורד (`reduceChain`; בעל המוצר, 06/10/2026).
    const from = answer?.basis ?? match.plan;
    const removed = answer?.lostOn ?? match.plan;
    const lost = lostHours(ctx, from, params, from === match.plan ? match.exec : null);
    if (lost == null) { ctx.review(`${describePairing(from)}: אין שעות מתוכננות, לא ניתן לחשב את השעות שהפסיד.`, rule); continue; }
    const key = params.credit_column === 'Rig' ? 'rig' : 'credit';
    const why = assumed
      ? `הרומה מזכה את השעות שהפסיד, והסיבה אינה בקבצים (${assumed.labels})`
      : match.exec ? params.answer_label_with_flight ?? params.answer_label : params.answer_label;
    const note = `${describePairing(removed)}: ${why}. השעות שהפסיד` +
      (match.exec ? `, בנוסף לקרדיט של ${describePairing(match.exec)}.` : '.');
    // ההסבר בשורת הפירוט קצר (בעל המוצר, 01/10/2026). כשהרומה זיכתה בלי שנשאלה שאלה: "…האפליקציה מניחה:"
    // ושם החוק, שאינו כתוב עוד בתגית (04/10/2026); כשכמה חוקים מתאימים, כולם בשמם.
    // אחרי תשובה: בלי הסבר, ועל טיסה שבוצעה במקום – של איזו טיסה השעות.
    const explain = assumed
      ? `הרומה מזכה את השעות והסיבה אינה בקבצים. האפליקציה מניחה${assumed.titles.length > 1 ? ` אחת מאלה: ${assumed.titles.join(' או ')}` : `: ${assumed.titles[0]}`}.`
      : match.exec || from !== removed || performedOn(ctx, assumed?.date ?? removed.from) ? `השעות של ${unflownOf(from, match.exec)}.` : '';
    if (match.exec) ctx.expectPairing(match.exec, key, lost, rule, note, { explain });
    // בלי טיסה שבוצעה, שורת הפירוט מציגה את הטיסה שתוכננה (בעל המוצר, 29/09/2026).
    // `chainFor`: ביום של שלב אחר בשרשרת, אבל שייך לשינוי של הסבב המתוכנן (`explainChanges`).
    else ctx.expect(assumed?.date ?? removed.from, key, lost, rule, note, { plannedRoute: describeRoute(removed), explain,
      ...(removed !== match.plan ? { chainFor: match.plan.id } : { forPlan: match.plan.id }) });
    ctx.markPairing(match.plan, 'lost_hours_credit');
    for (const v of assumed?.values ?? []) ctx.assumeAnswer(match.plan, v);
    if (assumed) ctx.assume(`cancelled:${match.plan.id}`, assumed.values[0], assumed.labels);
  }
}

/**
 * סבב מתוכנן שלא בוצע, שהדוח כבר מזכה עליו את השעות שהפסיד: מחזיר את החוק הראשון שמתאים,
 * העמודה, הסכום והיום שבו הדוח זיכה. הסיבה עצמה אינה בקבצים, וכל החוקים המזכים נותנים את
 * אותו סכום באותה עמודה, ולכן הנימוק מונה את כולם ואינו בוחר אחד מהם.
 * null כשאי אפשר לחשב את הקרדיט המתוכנן, כשהחוקים שבתוקף אינם מסכימים על הסכום או על
 * העמודה (ואז אי אפשר להסיק מהדוח), או כשהדוח אינו מזכה – ואז נשאלת השאלה.
 */
function paidLostHours(ctx, planPairing) {
  // הנחה שהמשתמש ביטל (`ctx.assume`; טיוטה 365): נשאל, כאילו הרומה לא זיכתה.
  if (ctx.assumeIgnored(`cancelled:${planPairing.id}`)) return null;
  const rules = ctx.rulesWithLogic('lost_hours_credit').filter((r) => lostHoursApplies(ctx, planPairing, r.logic.params ?? {}));
  if (!rules.length) return null;
  const of = (r) => ({ column: r.logic.params?.credit_column ?? 'Credit', lost: lostHours(ctx, planPairing, r.logic.params ?? {}) });
  const first = of(rules[0]);
  if (first.lost == null) return null;
  if (rules.some((r) => of(r).column !== first.column || of(r).lost !== first.lost)) return null;
  const key = first.column === 'Rig' ? 'rig' : 'credit';
  // רק יום שאין בו סבב ביצוע: ביום שבו טסת, הסכום בדוח יכול להיות גם השלמה לסליפ קצר או
  // פיצוי אחר על הטיסה עצמה, ואז אי אפשר לייחס אותו לסבב שבוטל – ושואלים.
  const free = (d) => !ctx.execPairings.some((e) => e.dates.includes(d));
  const date = planPairing.dates.find((d) => free(d) && ctx.paidOnDate(d, first.column, key, first.lost));
  return date ? { rule: rules[0], ...first, date, labels: rules.map((r) => r.logic.params?.answer_label).join(' או '),
    titles: rules.map((r) => r.title), values: rules.map((r) => r.logic.params?.answer_value) } : null;
}

/** מה שלא בוצע מהסבב המתוכנן: כולו, או מספרי הטיסה של הרגליים שלא בוצעו. */
function unflownOf(plan, exec) {
  const flown = exec ? flownAsPlanned(plan, exec) : [];
  return flown.length ? plan.legs.filter((l) => !flown.includes(l)).map((l) => l.flight).filter(Boolean).join('/') : describePairing(plan);
}

/** סוג המטוס כמשפחה: B789 → B787, ‏B738 → B737. */
const acFamily = (ac) => ac?.replace(/^(B7[0-9])[0-9]$/, '$17') ?? null;

/**
 * האם התשובה אפשרית על הסבב: `fleets` – רק כשהצי של הקבצים ברשימה; `plan_aircraft` – רק
 * כשרגל מתוכננת בסבב (לא DH) על אחד מסוגי המטוס (החלפת 787 ב-777, 2026 ס' 23.4).
 */
function lostHoursApplies(ctx, planPairing, params) {
  if (params.fleets?.length && !params.fleets.includes(ctx.fleet)) return false;
  if (params.plan_aircraft?.length &&
      !planPairing.legs.some((l) => !l.dh && params.plan_aircraft.includes(acFamily(l.ac)))) return false;
  return true;
}

/**
 * הרגליים של הסבב המתוכנן שבוצעו: אותה טיסה, מאותו שדה לאותו שדה, בהפרש של עד יום, כי התכנון לפי התאריך המקומי
 * והרומה לפי שעון הבסיס (בעל המוצר, 30/10/2026, טיוטה 447).
 */
const flownAsPlanned = (plan, exec) => plan.legs.filter((l) => l.flight && exec.legs.some((x) => x.flight === l.flight &&
  x.org === l.org && x.dst === l.dst && Math.abs(daysBetween(l.date, x.date)) <= 1));

/** טיסה מתוכננת, שאינה DH, בוצעה: הסבב לא בוטל. */
const partlyFlown = (plan, exec) => flownAsPlanned(plan, exec).some((l) => !l.dh);

/** השעות שהפסיד על סבב מתוכנן: הקרדיט המתוכנן, כולל השלמה לסליפ קצר, פחות מה שבוצע ממנו ב-`exec`. */
function lostHours(ctx, planPairing, params, exec = null) {
  const planned = ctx.plannedCredit(planPairing);
  if (planned == null) return null;
  const min = params.include_min_slip_credit ? ctx.minSlipMinutes() : null;
  const flown = exec ? flownAsPlanned(planPairing, exec) : [];
  return (min && planned < min ? min : planned) - (flown.length ? ctx.plannedCredit({ legs: flown }) ?? 0 : 0);
}

/**
 * תשובות "השעות שהפסיד" לפי החוקים שבתוקף בחודש (מטוס חכור, הורדה בגלל חניך). הרמז מנוסח
 * על הטיסה המקורית, ו-`extra` מוסיף את הקרדיט על הטיסה שבוצעה כשיש כזאת (בקשת בעל המוצר,
 * 23/09/2026). כשיש טיסה כזאת, רק ס' 46 נותן קרדיט על שתיהן: `answer_label_with_flight` הוא הנוסח
 * אז, ו-`only_without_flight` – תשובה שאז אינה מוצעת (בעל המוצר, 30/10/2026, טיוטה 442).
 */
function lostHoursOptions(ctx, planPairing, extra, exec = null) {
  const offered = (p) => lostHoursApplies(ctx, planPairing, p) && !(extra && p.only_without_flight);
  return ctx.rulesWithLogic('lost_hours_credit').filter((r) => offered(r.logic.params ?? {})).map((r) => {
    const p = r.logic.params ?? {};
    const lost = lostHours(ctx, planPairing, p, exec);
    const word = amountWord(p.credit_column ?? 'Credit');
    const amount = lost == null ? `מגיע ${word}` : `מגיע ${word} של ${minToHhmm(lost)}`;
    return { value: p.answer_value, label: (extra && p.answer_label_with_flight) || p.answer_label, hint: extra ? `${amount} על הטיסה המקורית ${extra}` : amount };
  });
}

/** ביום `date` בוצעה טיסה: ציפייה על סבב מתוכנן שלא בוצע תוצג בפירוט בשורה שלה, ולכן ההסבר אומר על איזה סבב. */
const performedOn = (ctx, date) => ctx.execPairings.some((p) => p.dates.includes(date));

/**
 * החלפה מרצון: רק הקרדיט של הטיסה שבוצעה. אין קריאה מיוחדת ואין "הגבוה".
 * ההשלמה לסליפ קצר מוזכרת בהערה רק כשהיא באמת מגיעה (בעל המוצר, 24/09/2026).
 */
function voluntary_swap(ctx, params, rule) {
  for (const match of ctx.matches) {
    const answer = ctx.answerFor(match);
    if (answer?.value !== 'voluntary_swap') continue;
    const target = match.exec ?? match.plan;
    // הסתירה עם תשובה סותרת על הסבב המתוכנן נפתרה נגד ההחלפה מרצון (`resolveSwapConflict`).
    if (ctx.pairingHandledBy(target, 'swap_conflict_void')) continue;
    ctx.markPairing(target, 'voluntary_swap');
    const date = (match.plan ?? match.exec).from;
    // ההערה ביום של כל צד: ביום המתוכנן שלא בוצע – אין קרדיט; ביום של הטיסה שבוצעה – הקרדיט שלה
    // (בעל המוצר, 29/09/2026).
    if (answer.link === 'none') {
      ctx.note(date, 'החלפה מרצוני או בהסכמתי: הטיסה נמסרה ללא חלופה, ולא מגיע עליה קרדיט.', rule, { pairingId: match.plan.id });
      continue;
    }
    if (!match.exec) {
      // `pairingId`: ההערה של הסבב המתוכנן, ולא של טיסה אחרת שבוצעה באותם ימים (`splitSwappedElsewhere`).
      ctx.note(date, `החלפה מרצוני או בהסכמתי: לא מגיע קרדיט על ${match.plan.dates.length > 1 ? 'הימים האלה' : 'היום הזה'}.`, rule, { pairingId: match.plan.id });
      continue;
    }
    const slip = minSlipTopUp(ctx, match.exec) ? ', כולל השלמה לסליפ קצר' : '';
    // הפיצויים היומיים על הטיסה (קריאה מחופשה, קריאה מיוחדת על הארכה) – עם הימים שלהם (`DAY_DUES`; טיוטה 398).
    ctx.note(date, `החלפה מרצוני או בהסכמתי: קרדיט על הטיסה שבוצעה${slip}${DAY_DUES}.`, rule, { pairingId: match.exec.id, callOf: match.exec.id });
  }
}

/**
 * סבב מתוכנן שלא בוצע כמתוכנן. הסיבה אינה בקבצים והיא קובעת מה מגיע, ולכן נשאלת עליה שאלה
 * אחת: גם כשלא בוצע דבר באותם ימים, וגם כשבוצע בהם סבב אחר – טיסה אחרת באותם ימים אינה
 * מוכיחה החלפה (בקשת בעל המוצר, 24/09/2026). שש התשובות ומה שכל אחת גוררת:
 * שינוי ביוזמת החברה, זכייה במכרז וסטיה לשדה משנה – הגבוה מבין שתי הטיסות (`higher_of_planned_performed`);
 * החלפה מרצוני – רק הקרדיט של הטיסה שבוצעה (`voluntary_swap`);
 * המתוכננת בוטלה ללא קרדיט – מה שבוצע בימיה לא היה מתוכנן,
 * כלומר מגיעה עליו קריאה מיוחדת (`special_call`);
 * הורדה מהטיסה המקורית – השעות שהפסיד, בנוסף לקרדיט של מה שבוצע (`lost_hours_credit`).
 * בשינוי, במכרז ובהחלפה מרצוני נבחרת הטיסה שבוצעה במקום: קודם זו שבאותם ימים, ואחריה כל פעילות שלא תוכננה.
 *
 * סטיה לשדה משנה (אותם מספרי טיסה, עם נחיתה ביעד שלא תוכנן) אינה נשאלת: מניחים אותה, ומגיע הגבוה
 * מבין השתיים, כמו בשינוי ביוזמת החברה (`assumeDiversion`). כשהיא אינה ברורה מהקבצים, היא אפשרות
 * בשאלה.
 */
function cancelled_no_compensation(ctx, params, rule) {
  askJournal(ctx, rule);
  checkLinkConflicts(ctx, rule);
  for (const match of ctx.matches) {
    if (!match.plan || (match.how !== 'cancelled' && match.how !== 'dates')) continue;
    if (ctx.pairingHandledBy(match.plan, 'swap_conflict_void')) continue;
    dropUnfitAnswer(ctx, match);
    const answer = ctx.answerFor(match);
    if (!answer) {
      if (inheritAnswer(ctx, match, rule)) continue;
      if (assumeDiversion(ctx, match, rule)) continue;
      if (assumeLegOmitted(ctx, match, rule)) continue;
      if (!assumeCancelled(ctx, match, rule)) askWhatHappened(ctx, match, rule);
      continue;
    }
    if (answer.value === 'cancelled') noteCancelled(ctx, match, rule, null);
    if (answer.value === 'diversion' && match.exec) noteDiversion(ctx, match, rule);
    if (answer.value === 'other') applyOtherReason(ctx, answer, rule, {
      what: match.exec ? 'סבב מתוכנן שבמקומו בוצע סבב אחר' : 'סבב מתוכנן שלא בוצע',
      date: match.plan.from, pairing: match.exec, planId: match.plan.id, extra: { plannedRoute: describeRoute(match.plan),
        ...(!match.exec && performedOn(ctx, match.plan.from) && { explain: `סבב מתוכנן שלא בוצע, ${describePairing(match.plan)}: "${answer.text}".` }) },
    });
  }
}

/** הורדה מהטיסה שאינה מתאימה לצי או למטוס בתכנון, למשל אחרי שהצי התברר: השאלה נפתחת מחדש (טיוטה 454). */
function dropUnfitAnswer(ctx, match) {
  const value = ctx.answerFor(match)?.value;
  const unfit = ctx.rulesWithLogic('lost_hours_credit').find((r) => [r.logic.params.answer_value, ...(r.logic.params.merged_answer_values ?? [])].includes(value));
  if (unfit && !lostHoursApplies(ctx, match.plan, unfit.logic.params)) ctx.dropAnswer(`cancelled:${match.plan.id}`);
}

/**
 * החלק בחודש הזה של סבב מתוכנן שיצא בחודש הקודם: התשובה על הסבב שם חלה גם עליו, ואינו נשאל שוב (אוגוסט–ספטמבר
 * 2025: ATH ‏31/08–01/09 שהוחלף ב-MUC). הנחה שניתנת לשינוי. אין עליו קרדיט והפרש: ההשוואה בחודש ההמראה. "סיבה
 * אחרת" אינה עוברת, כי היא נוגעת לסבב שבה נכתבה (בעל המוצר, 30/10/2026, טיוטה 433).
 */
function inheritAnswer(ctx, match, rule) {
  const { plan } = match;
  const last = ctx.prevMonth?.planPairings.at(-1);
  if (!plan.cutAtStart || !last?.cutAtEnd || last.legs.at(-1).dst !== plan.legs[0].org) return false;
  const before = ctx.prevMonth.answers?.[`cancelled:${last.id}`];
  if (!before?.value || before.value === 'other') return false;
  const label = before.label ?? 'התשובה על הסבב בחודש הקודם';
  if (!ctx.assume(`cancelled:${plan.id}`, before.value, label, 'התשובה על הסבב בחודש הקודם')) return false;
  ctx.assumeAnswer(plan, before.value);
  ctx.markPairing(plan, 'inherited');
  ctx.note(plan.from, 'המשך של סבב מהחודש הקודם, לפי התשובה שם: בלי קרדיט ובלי הפרש בחודש הזה.', rule, { pairingId: plan.id });
  return true;
}

/**
 * ההנחה שחוק `assumeCancelled` היה עושה, בלי תופעות לוואי: אין תשובה, אבל הדוח כבר מזכה
 * את מה שמתאים (השעות שהפסיד על סבב שלא בוצע, או קריאה מיוחדת על סבב באותם ימים).
 */
function wouldAssumeCancelled(ctx, match) {
  if (ctx.assumeIgnored(`cancelled:${match.plan.id}`)) return false;
  if (!match.exec) return !!paidLostHours(ctx, match.plan);
  return !partlyFlown(match.plan, match.exec) && paidCallOnPlanDays(ctx, match) > 0;
}

/**
 * הקריאה המיוחדת שהרומה זיכתה על הסבב שבוצע, רק בימים של הסבב המתוכנן: קריאה מיוחדת ביום אחר אינה
 * אומרת דבר על המתוכנן (בעל המוצר, 08/10/2026; DME ‏11/03/2026 – ‏LY860 מ-FRA נחתה באיחור ב-12/03 ב-01:05,
 * יום שתוכנן פנוי, והקריאה המיוחדת על 12/03 בלבד).
 */
function paidCallOnPlanDays(ctx, match) {
  const sc = ctx.rulesWithLogic('special_call')[0]?.logic?.params?.report_column ?? 'S/C';
  const days = (p) => (p.shownTo ? [...p.dates, p.shownTo] : p.dates);
  const planned = new Set(days(match.plan));
  return [...new Set(days(match.exec))].filter((d) => planned.has(d)).reduce((s, d) => s + ctx.reportedOnDate(d, sc), 0);
}

/**
 * סתירה בין ההחלטה (תשובה של המשתמש, או הנחה מהדוח) על סבב מתוכנן שלא בוצע כמתוכנן לבין
 * ההחלטה על טיסה אחרת שקושרה אליו מהצד השני, לפני שמישהו מהחוקים משלם על פיהן. בודקים בשני
 * הכיוונים: סבב עם תשובה "החלפה ביוזמת החברה" או "החלפה מרצוני" שהקישור שלה מצביע על טיסה
 * שכבר סומנה אחרת (למשל קריאה מיוחדת עצמאית, או החלפה מרצוני של סבב אחר), וטיסה עם תשובה
 * "החלפה מרצוני" שהקישור שלה מצביע על סבב שכבר סומן אחרת. כשיש סתירה שואלים מי מהשתיים
 * נכונה, ומקפיאים את שני הצדדים עד לתשובה כדי לא לשלם על שניהם (בעל המוצר, 24/09/2026).
 */
function checkLinkConflicts(ctx, rule) {
  const scColumn = ctx.rulesWithLogic('special_call')[0]?.logic?.params?.report_column ?? 'S/C';

  const planResolution = new Map(); // plan.id -> {match, value, link}
  for (const m of ctx.matches) {
    if (!m.plan || (m.how !== 'cancelled' && m.how !== 'dates')) continue;
    const a = ctx.answerFor(m);
    // `alsoSpecialCall`: הקריאה המיוחדת על הטיסה שבקישור היא חלק מהתשובה, ולא סתירה.
    if (a && !('via' in a) && !a.alsoSpecialCall) planResolution.set(m.plan.id, { match: m, value: a.value, link: a.link ?? null });
    else if (!a && wouldAssumeCancelled(ctx, m)) planResolution.set(m.plan.id, { match: m, value: 'assumed', link: null });
  }

  const execResolution = new Map(); // exec.id -> {match, value, link}
  for (const m of ctx.matches) {
    if (!m.exec || m.how !== 'unplanned') continue;
    const a = ctx.answerFor(m);
    if (a && !('via' in a)) execResolution.set(m.exec.id, { match: m, value: a.value, link: a.link ?? null });
    else if (!a && ctx.reportedOn(m.exec, scColumn) > 0) execResolution.set(m.exec.id, { match: m, value: 'special_call', link: null });
  }

  const conflicts = new Map(); // "planId|execId" -> {planEntry, execEntry}
  const addConflict = (planEntry, execEntry) => {
    const key = planEntry.match.plan.id + '|' + execEntry.match.exec.id;
    if (!conflicts.has(key)) conflicts.set(key, { planEntry, execEntry });
  };

  // סבב מתוכנן עם קישור, מול מה שכבר סומן על הטיסה שהוא מצביע עליה.
  for (const entry of planResolution.values()) {
    if (![...COMPANY_PAID_SWAPS, 'voluntary_swap'].includes(entry.value) || !entry.link || entry.link === 'none') continue;
    const exec = execResolution.get(entry.link);
    if (!exec) continue;
    // שינוי ביוזמת החברה או זכייה במכרז לטיסה ביום שלא תוכנן בו כלום, שהיא קריאה מיוחדת: שניהם מגיעים
    // (`companySwapToFreeDay`; בעל המוצר, 06/10/2026).
    const compatible = (entry.value === 'voluntary_swap' && exec.value === 'voluntary_swap' && exec.link === entry.match.plan.id) ||
      (['replaced', 'bid'].includes(entry.value) && exec.value === 'special_call');
    if (!compatible) addConflict(entry, exec);
  }

  // פעילות עם קישור "החלפה מרצוני", מול מה שכבר סומן על הסבב שהיא מצביעה עליו.
  for (const entry of execResolution.values()) {
    if (entry.value !== 'voluntary_swap' || !entry.link || entry.link === 'none') continue;
    const plan = planResolution.get(entry.link);
    if (plan && plan.value !== 'voluntary_swap') addConflict(plan, entry);
  }

  for (const { planEntry, execEntry } of conflicts.values()) resolveLinkConflict(ctx, planEntry, execEntry, rule);
}

/**
 * השאלה ממוקדת בסבב המתוכנן עצמו, כי שתי ההחלטות הסותרות הן שתי גרסאות של "מה קרה" לו, לא
 * שתי החלטות נפרדות שיש לבחור ביניהן בלשון מופשטת (בעל המוצר, 24/09/2026): כל אפשרות
 * מתוארת באותה לשון שהשאלה הרגילה (`whatHappenedOptions`, דרך `claimLabel`) הייתה
 * משתמשת בה, עם שם הטיסה הספציפית שקושרה אליה. מקפיאים את שני הצדדים
 * (`swap_conflict_void`) עד לתשובה: הסבב המתוכנן אינו מקבל את מה שהתשובה עליו קובעת
 * (`lost_hours_credit`, `higher_of_planned_performed`, `cancelled_no_compensation`),
 * והטיסה שקושרה אליו אינה מקבלת את מה שכבר סומן עליה (`voluntary_swap`, `special_call`).
 */
function resolveLinkConflict(ctx, planEntry, execEntry, rule) {
  const planMatch = planEntry.match, execMatch = execEntry.match;
  const id = `swap_conflict:${planMatch.plan.id}:${execMatch.exec.id}`;
  const resolved = ctx.answer(id)?.value;
  if (resolved !== 'plan') ctx.markPairing(planMatch.plan, 'swap_conflict_void');
  if (resolved !== 'exec') ctx.markPairing(execMatch.exec, 'swap_conflict_void');
  if (resolved) return;
  const planLabel = describePairing(planMatch.plan);
  const execLabel = describePairing(execMatch.exec);
  ctx.ask({
    id,
    date: planMatch.plan.from,
    title: `מה קרה ב${planLabel}?`,
    body: ctx.calendarRun ? `יש שתי תשובות סותרות על מה שקרה ב${planLabel}. מה נכון?`
      : `יש שתי החלטות סותרות (תשובה, או הנחה מהרומה) על מה שקרה ב${planLabel}. מה נכון?`,
    options: [
      { value: 'plan', label: claimLabel(ctx, planEntry, planLabel, execLabel, planMatch) },
      { value: 'exec', label: claimLabel(ctx, execEntry, planLabel, execLabel, planMatch) },
    ],
    ruleId: rule.id,
  });
}

/**
 * הלשון שמתארת מה קרה בסבב המתוכנן, לפי ערך ההחלטה (תשובה או הנחה): אותה לשון בדיוק
 * שהשאלה הרגילה הייתה משתמשת בה (`whatHappenedOptions`), עם שם הטיסה הספציפית שקושרה
 * אליה במקום ניסוח כללי. `entry` יכול להיות מהצד המתוכנן או מהצד שבוצע.
 */
function claimLabel(ctx, entry, planLabel, execLabel, planMatch) {
  const { value, match } = entry;
  if (value === 'assumed') {
    return match.exec
      ? `לפי הרומה, ${planLabel} בוטלה ללא קרדיט נוסף (מה שבוצע באותם ימים נחשב קריאה מיוחדת)`
      : `לפי הרומה, מגיעות על ${planLabel} השעות שהפסיד`;
  }
  if (value === 'special_call') return `${execLabel} היא קריאה מיוחדת עצמאית, ולא קשורה ל${planLabel}`;
  if (value === 'voluntary_swap') return `${planLabel} הוחלפה מרצוני או בהסכמתי עם ${execLabel}`;
  if (value === 'other') return ctx.answerFor(match)?.text || 'סיבה אחרת';
  const opt = whatHappenedOptions(ctx, planMatch.plan, planMatch.exec).find((o) => o.value === value);
  return opt ? opt.label : value;
}

/**
 * הדוח כבר זיכה, ולכן מניחים את התשובה המזכה ולא שואלים (החלטת בעל המוצר, 23/09/2026):
 * על סבב שלא בוצע – השעות שהפסיד, ש-`lost_hours_credit` רושם; על סבב שבמקומו בוצע סבב אחר –
 * קריאה מיוחדת על הסבב שבוצע, באחד מימי הסבב המתוכנן (`paidCallOnPlanDays`), שפירושה שהמתוכנן בוטל.
 * זיכוי של ההפרש בלבד אינו מספיק, כי הוא
 * מתאים גם להחלפה וגם לשעות שהפסיד, ולכן עליו שואלים (בקשת בעל המוצר, 24/09/2026).
 */
function assumeCancelled(ctx, match, rule) {
  if (!match.exec) return !!paidLostHours(ctx, match.plan);
  if (partlyFlown(match.plan, match.exec)) return false;
  if (!paidCallOnPlanDays(ctx, match) || !ctx.assume(`cancelled:${match.plan.id}`, 'cancelled', 'הטיסה המקורית בוטלה ללא קרדיט')) return false;
  noteCancelled(ctx, match, rule, `הרומה מזכה קריאה מיוחדת על ${describePairing(match.exec)}`);
  ctx.assumeAnswer(match.plan, 'cancelled');
  return true;
}

/** לפחות אחד ממספרי הטיסה המתוכננים (בלי DH) נמצא בסבב שבוצע. */
function sharesFlight(plan, exec) {
  const flights = new Set(exec.legs.map((l) => l.flight).filter(Boolean));
  return plan.legs.some((l) => !l.dh && l.flight && flights.has(l.flight));
}

/**
 * סטיה לשדה משנה: הסבב שבוצע הוא הסבב המתוכנן – כל מספרי הטיסה המתוכננים (בלי DH) נמצאים בו – אבל
 * נחת ביעד שלא תוכנן: בנוסף ליעדים המתוכננים (בדרך אליהם או בחזרה מהם), או במקום אחד מהם (05/02/2026:
 * ‏LY5115/LY5116 ל-BUS נחתה ב-KUT בגלל מזג אוויר בבטומי). מספר טיסה אחר הוא סבב אחר, ונשאל (בעל
 * המוצר, 05/10/2026).
 */
function isDiversion(plan, exec) {
  if (!plan.destinations.length || !exec.destinations.some((d) => !plan.destinations.includes(d))) return false;
  const flights = new Set(exec.legs.map((l) => l.flight).filter(Boolean));
  return plan.legs.every((l) => l.dh || !l.flight || flights.has(l.flight));
}

/**
 * סטיה לשדה משנה במהלך הטיסה, למשל בגלל מזג אוויר: לא החלפה בסבב אחר, אלא אותה טיסה עם נחיתה
 * בשדה שלא תוכנן. מניחים ולא שואלים. אין עליה סעיף בהסכמים, ולכן היא שינוי ביוזמת החברה: הגבוה מבין
 * המתוכנן למה שבוצע, לפי STA − STD (`higher_of_planned_performed`, לפי הסימון `diversion`; בעל המוצר,
 * 26/09/2026 ו-05/10/2026). לחוקים של 2024 ס' 34–37 ו-39 היא ביוזמת החברה (`cancelStatus`).
 */
function assumeDiversion(ctx, match, rule) {
  if (!match.exec || !isDiversion(match.plan, match.exec) || !ctx.assume(`cancelled:${match.plan.id}`, 'diversion', 'סטיה לשדה משנה')) return false;
  noteDiversion(ctx, match, rule);
  // גם כשהרומה זיכתה קריאה מיוחדת: אותם מספרי טיסה הם אותה טיסה (`explainUnexplained`; בעל המוצר, 06/10/2026).
  ctx.markPairing(match.exec, 'diversion_assumed');
  ctx.assumeAnswer(match.plan, 'diversion');
  return true;
}

/**
 * גריעת קטע טיסה אינה שינוי (ישן כ"ה ס' 9.ב(2)): כל מה שבוצע הוא מספרי הטיסה המתוכננים, בלי יעד חדש, ופחות רגליים.
 * לא נשאל, ואין עליו הגבוה מבין השתיים. הנחה שניתנת לשינוי: הסעיף מסויג ב"אם לא דרוש שינוי במבנה הצוות", שאינו בקבצים
 * (בעל המוצר, 30/10/2026, טיוטה 440).
 */
function assumeLegOmitted(ctx, match, rule) {
  const { plan, exec } = match;
  if (!exec || exec.legs.length >= plan.legs.length) return false;
  const flights = new Set(plan.legs.map((l) => l.flight).filter(Boolean));
  if (!exec.legs.every((l) => flights.has(l.flight)) || !exec.destinations.every((d) => plan.destinations.includes(d))) return false;
  if (!ctx.assume(`cancelled:${plan.id}`, 'leg_omitted', 'נגרע קטע טיסה')) return false;
  ctx.markPairing(plan, 'leg_omitted');
  ctx.note(plan.from, 'נגרע קטע טיסה: אין זה שינוי בתכנית, והקרדיט לפי מה שבוצע.', rule, { pairingId: plan.id });
  return true;
}

/**
 * סטיה לשדה משנה, שהונחה או שנענתה: סימון לחוקים אחרים. בלי הערה על השדות: הכותרת בשינויים היא "סטיה
 * לשדה משנה", והשדות בצד הביצוע, ומתחת לשינוי רק מה שמגיע (בעל המוצר, 15/10/2026).
 */
function noteDiversion(ctx, match, rule) {
  ctx.markPairing(match.plan, 'diversion');
  ctx.markPairing(match.exec, 'diversion');
}

/**
 * סבב שבוטל ללא קרדיט: מה שבוצע בימיו לא היה מתוכנן. ימיו אינם נספרים כימים ללא פעילות, שהם לפי
 * התכנון בלבד (בעל המוצר, 14/10/2026). מתחת לשינוי ההערה עצמה רק כשיש סיבה בסוגריים (`plain`), וכשבוצעה
 * טיסה באותם ימים – מה שמגיע עליה (`performed`, `explainChanges` ב-js/rules/evaluate.js). `pairingId`: רק
 * בשורה של הסבב, ולא בשורה של החלפה אחרת שהטיסה שלה עוברת בימיו (בעל המוצר, 14/10/2026).
 */
function noteCancelled(ctx, match, rule, why) {
  ctx.markPairing(match.plan, 'cancelled_no_compensation');
  // ימי הטיסה שבוצעה, עד סוף החודש: "קריאה מיוחדת על כל אחד מהימים" לפיהם.
  const last = ctx.timeline.at(-1).date;
  const to = match.exec ? match.exec.shownTo ?? match.exec.to : null;
  ctx.note(match.plan.from, `סבב מתוכנן שלא בוצע: בוטל ללא קרדיט${why ? ` (${why})` : ''}.`, rule, {
    plain: !why,
    pairingId: match.plan.id,
    ...(match.exec ? { performed: { id: match.exec.id, from: match.exec.from, to: to < last ? to : last } } : {}),
  });
}

/**
 * אפשרויות "מה קרה" לסבב מתוכנן שלא בוצע כמתוכנן, בלי "סיבה אחרת": משותפות לשאלה הרגילה
 * (`askWhatHappened`) ולשאלת הסתירה (`resolveLinkConflict`, דרך `claimLabel`), כדי שאותו
 * ערך תמיד יתואר באותה לשון.
 */
function whatHappenedOptions(ctx, plan, exec, calendar = null) {
  // מול היומן (`ctx.calendarRun`) בלי סכומים, והסבב שבמקומו הוא זה שביומן, שעוד לא בוצע (בעל המוצר, 13/10/2026).
  const diff = ctx.calendarRun ? null : plannedMinusPerformed(ctx, plan, exec);
  const other = exec ?? calendar;
  const performed = ctx.hasExec && !ctx.calendarRun ? 'הטיסה שבוצעה' : 'הטיסה שביומן';
  const shortfall = ctx.rulesWithLogic('higher_of_planned_performed')[0]?.logic?.params?.shortfall_column ?? 'COM';
  const higher = 'מגיע הגבוה מבין שתי הטיסות' + (diff == null ? ''
    : diff > 0 ? `: ${amountWord(shortfall)} של ${minToHhmm(diff)}`
    : '; מה שבוצע אינו קצר מהמתוכנן, ולכן אין הפרש לתשלום');
  // בלי טיסה באותם ימים, הטיסה השנייה נבחרת רק אחרי הבחירה, בקישור (בעל המוצר, 17/10/2026; טיוטה 366).
  const later = (what) => `${what} תיבחר בהמשך.`;
  return [
    { value: 'replaced', label: 'שינוי ביוזמת החברה', hint: other ? higher : `${later('הטיסה שבאה במקומה')} מגיע הגבוה מבין שתיהן`, needsLink: true },
    // אותה טיסה, עם נחיתה ביעד שלא תוכנן: רק מול הסבב שבוצע באותם ימים, ולכן בלי קישור. משלמת כמו
    // שינוי ביוזמת החברה, ומוצגת בשמה בשינויים (בעל המוצר, 05/10/2026). רק כשלפחות אחד ממספרי הטיסה
    // המתוכננים נמצא במה שבוצע: בלי אף אחד זו טיסה אחרת, ולא סטיה (04/06/2024: SKG → WAW).
    ...(other && sharesFlight(plan, other) && other.destinations.join() !== plan.destinations.join() ? [{ value: 'diversion', label: 'סטיה לשדה משנה', hint: higher }] : []),
    // זכייה במכרז משלמת כמו שינוי ביוזמת החברה, אבל אינה "ביוזמת החברה" לעניין 2024 ס' 34–37 ו-39
    // (ס' 40): נחיתות לילה, שבתות ברצף וטיסות סבב לילה עוקבות (בעל המוצר, 05/10/2026).
    { value: 'bid', label: 'זכייה במכרז', hint: other ? higher : `${later('הטיסה שזכית בה')} מגיע הגבוה מבין שתיהן`, needsLink: true },
    { value: 'voluntary_swap', label: 'החלפה מרצוני או בהסכמתי',
      hint: other ? `רק הקרדיט של ${performed}` : `${later('הטיסה שבאה במקומה, אם יש,')} רק הקרדיט שלה`, needsLink: true },
    // טיסה מתוכננת בוצעה: הסבב לא בוטל (בעל המוצר, 30/10/2026, טיוטה 447).
    ...(other && partlyFlown(plan, other) ? [] : [{ value: 'cancelled', label: 'הטיסה המקורית בוטלה ללא קרדיט',
      hint: other ? `מגיע פיצוי של קריאה מיוחדת על ${performed}` : 'לא מגיע כלום' }]),
    ...lostHoursOptions(ctx, plan, other ? `בנוסף לקרדיט של ${performed}` : undefined, other),
  ];
}

/**
 * השאלה על סבב מתוכנן שלא בוצע כמתוכנן. `execId` הוא הסבב שבוצע באותם ימים, והוא האפשרות
 * הראשונה בקישור שבהחלפה.
 */
function askWhatHappened(ctx, match, rule) {
  const { plan, exec } = match;
  if (ctx.calendarRun) { askWhatHappenedInCalendar(ctx, match, rule); return; }
  const diff = plannedMinusPerformed(ctx, plan, exec);
  ctx.ask({
    id: `cancelled:${plan.id}`,
    date: plan.from,
    execId: exec?.id ?? null,
    // תוכנן/בוצע בבולד, פרטי הטיסות והתאריכים לא (בעל המוצר, 27/09/2026). סבב שנוסף ביומן כאילו היה
    // בתכנון (`addedInCalendar`, js/rules/evaluate.js) מתואר כך.
    title: plan.addedInCalendar
      ? (exec
        ? ['סבב שנוסף ביומן, ובמקומו בוצע סבב אחר באותם ימים:\n', { bold: true, text: 'ביומן ' }, describePairing(plan),
            { bold: true, text: ', בוצע ' }, describePairing(exec)]
        : `סבב שנוסף ביומן ולא בוצע: ${describePairing(plan)}`)
      : exec
        ? ['סבב מתוכנן שבמקומו בוצע סבב אחר באותם ימים:\n', { bold: true, text: 'תוכנן ' }, describePairing(plan),
            { bold: true, text: ', בוצע ' }, describePairing(exec)]
        : `סבב מתוכנן שלא בוצע: ${describePairing(plan)}`,
    body: (diff != null && diff > 0 ? `המתוכנן ארוך ממה שבוצע ב-${minToHhmm(diff)}. ` : '') +
      'הסיבה אינה בקבצים, והיא קובעת מה מגיע. מה קרה?',
    options: [
      ...whatHappenedOptions(ctx, plan, exec),
      otherOption(),
    ],
    ruleId: rule.id,
  });
}

/**
 * השאלה על סבב מתוכנן מול היומן, בתכנון לבד (`ctx.calendarRun`; בעל המוצר, 13/10/2026): אותה שאלה ואותו
 * מזהה כמו מול הרומה, בנוסח של היומן ובלי סכומים.
 */
function askWhatHappenedInCalendar(ctx, match, rule) {
  const { plan, exec } = match;
  ctx.ask({
    id: `cancelled:${plan.id}`,
    date: plan.from,
    execId: exec?.id ?? null,
    title: plan.addedInCalendar
      ? (exec
        ? ['סבב שנוסף ביומן, ועכשיו רשום במקומו סבב אחר באותם ימים:\n', { bold: true, text: 'היה ביומן ' }, describePairing(plan),
            { bold: true, text: ', עכשיו ביומן ' }, describePairing(exec)]
        : `סבב שנוסף ביומן וירד ממנו: ${describePairing(plan)}`)
      : exec
        ? ['סבב מתוכנן שביומן רשום במקומו סבב אחר באותם ימים:\n', { bold: true, text: 'תוכנן ' }, describePairing(plan),
            { bold: true, text: ', ביומן ' }, describePairing(exec)]
        : `סבב מתוכנן שאינו ביומן: ${describePairing(plan)}`,
    body: 'הסיבה אינה בקבצים, והיא תקבע מה מגיע כשתועלה הרומה. מה קרה?',
    options: [...whatHappenedOptions(ctx, plan, exec), otherOption()],
    ruleId: rule.id,
  });
}

/**
 * יומן השינויים מהיומן המחובר (`ctx.journal`, js/rules/journal.js; בעל המוצר, 06/10/2026). השאלות הן
 * אלה שמול הרומה – גם בתכנון לבד, שבו היומן נבדק כמו רומה (`ctx.calendarRun`; בעל המוצר, 13/10/2026):
 * על סבב ביומן שהשרשרת נעצרה בו נשאלת השאלה מול הרומה, או מול היומן (`ctx.journalOpen`). לכל שלב
 * שנענה נבנה התיאור שמתחת לשינוי (`note`).
 */
function askJournal(ctx, rule) {
  const j = ctx.journal;
  if (!j) return;
  for (const st of j.steps) st.note = stepNote(ctx, st);
  for (const n of j.unplanned) n.note = unplannedNote(ctx, n);
  for (const o of ctx.journalOpen ?? []) askChainOpen(ctx, o, rule);
}

/**
 * עם הרומה, כשהשרשרת מהיומן נעצרה בסבב שביומן ולא ידוע מה קרה בו: אותה שאלה כמו על סבב מתוכנן
 * שלא בוצע, על הסבב שביומן (בעל המוצר, 06/10/2026). התשובה היא השלב האחרון בשרשרת.
 */
function askChainOpen(ctx, open, rule) {
  const p = { ...open.pairing, id: open.id };
  const exec = ctx.execPairings.find((e) => overlapDays(p, e)) ?? null;
  const diff = ctx.calendarRun ? null : plannedMinusPerformed(ctx, p, exec);
  ctx.ask({
    id: `cancelled:${open.id}`,
    date: p.from,
    execId: exec?.id ?? null,
    // מול היומן (`ctx.calendarRun`): מה שביומן עכשיו (בעל המוצר, 13/10/2026).
    title: ctx.calendarRun
      ? (exec
        ? ['סבב שביומן, ועכשיו רשום במקומו סבב אחר באותם ימים:\n', { bold: true, text: 'היה ביומן ' }, describePairing(p),
            { bold: true, text: ', עכשיו ביומן ' }, describePairing(exec)]
        : `סבב שירד מהיומן: ${describePairing(p)}`)
      : exec
        ? ['סבב שביומן, ובמקומו בוצע סבב אחר באותם ימים:\n', { bold: true, text: 'ביומן ' }, describePairing(p),
            { bold: true, text: ', בוצע ' }, describePairing(exec)]
        : `סבב שביומן ולא בוצע: ${describePairing(p)}`,
    body: ctx.calendarRun ? 'הסיבה אינה בקבצים, והיא תקבע מה מגיע כשתועלה הרומה. מה קרה?' : 'הסבב הוא שלב בשינויים שהיומן הראה מהתכנון. ' + (diff != null && diff > 0 ? `הוא ארוך ממה שבוצע ב-${minToHhmm(diff)}. ` : '') +
      'הסיבה אינה בקבצים, והיא קובעת מה מגיע. מה קרה?',
    options: [...whatHappenedOptions(ctx, p, exec), otherOption()],
    ruleId: rule.id,
  });
}

/** שלב בשרשרת לטבלת השינויים: מה היה, לאן עבר, ובלשון האפשרות שנבחרה. */
function stepNote(ctx, st) {
  const from = describePairing(st.fromPairing);
  // `reason`: רק הסיבה, לשורה שבה הסבבים כבר כתובים (בעל המוצר, 06/10/2026).
  st.reason = null;
  if (!st.answer) return st.end === 'standby' ? `${from}: ביומן רשומה כוננות במקום הסבב` : null;
  const a = st.answer;
  const to = st.to?.pairing ?? (a.link && a.link !== 'none' ? ctx.pairingById(a.link) : null);
  const opt = whatHappenedOptions(ctx, { ...st.fromPairing, id: st.node.id }, null, st.candidates[0] ?? null).find((o) => o.value === a.value);
  const label = a.value === 'other' ? `סיבה אחרת${a.text ? `: ${a.text}` : ''}` : opt?.label ?? a.value;
  const where = to ? describePairing(to) : opt?.needsLink && 'link' in a ? (a.link === 'none' ? 'מסירת הטיסה ללא חלופה' : 'טיסה בחודש אחר') : null;
  st.reason = !to && where ? `${label}: ${where}` : label;
  return `${from}${where ? ` ← ${where}` : ''}: ${label}`; // בטקסט עברי החץ שמאלה (טיוטה 381)
}

/** התשובה על סבב ביומן שאינו בתכנון, לטבלת השינויים. */
function unplannedNote(ctx, n) {
  const a = ctx.answer(`unplanned:${n.id}`);
  if (!a) return null;
  const simple = { special_call: 'קריאה מיוחדת', bid: 'זכייה במכרז', added: 'הוספת טיסה בהסכמה' };
  if (simple[a.value]) return simple[a.value];
  if (a.value === 'other') return `סיבה אחרת${a.text ? `: ${a.text}` : ''}`;
  const what = { voluntary_swap: 'החלפה מרצוני או בהסכמתי', replaced: 'שינוי ביוזמת החברה' }[a.value];
  if (!what) return a.value;
  const gone = ctx.journal.steps.find((st) => st.node.id === a.link);
  return `${what}: ${gone ? describePairing(gone.fromPairing) : a.link ? a.link : 'טיסה בחודש אחר'}`;
}

// ---------- שינויים בפעילות שאינה טיסה ----------

/**
 * קריאה מחופשה (ישן כ"ה ס' 13.ג): יום שתוכנן בו VAC ובדוח יש בו טיסה, ואין VAC. התשלום הוא לכל יממה או חלק ממנה של
 * "פעילות טיסתית" בתקופת החופשה, בנוסף לקרדיט של מה שבוצע. "נקרא ע"י ההנהלה" אינו בקבצים: הרומה זיכתה – מניחים, ולא
 * זיכתה – שואלים. סימולטור, פעילות קרקע וכוננות אינם פעילות טיסתית (בעל המוצר, 31/10/2026, טיוטה 458).
 */
function vacation_recall(ctx, params, rule) {
  if (!ctx.hasPlan || !ctx.hasExec) return;
  const hours = H(params.hours);
  const key = params.report_column === 'S/C' ? 'sc' : 'com';
  const byPairing = new Map();
  const ok = (c) => !(params.exclude_codes ?? []).includes(c);
  for (const day of ctx.timeline) {
    if (!(day.plan?.codes ?? []).some((c) => ok(c) && codeIn(c, params.plan_codes, params.plan_code_prefixes))) continue;
    if (ctx.execCodes(day).some((c) => codeIn(c, params.report_codes, params.report_code_prefixes))) continue;
    // גם יום הנחיתה אחרי חצות (`shownTo`; בעל המוצר, 21/10/2026; טל: ZRH ‏01/09 נחתה ב-02:47 ב-02/09, יום חופשה).
    const pairing = ctx.execPairings.find((p) => inStay(p, day.date) || (p.from <= day.date && day.date <= (p.shownTo ?? p.to)));
    if (pairing) {
      if (!byPairing.has(pairing)) byPairing.set(pairing, []);
      byPairing.get(pairing).push(day.date);
      continue;
    }
    const activity = ctx.activityCodes(day);
    if (!activity.length) continue;
    if (ctx.paidOnDate(day.date, params.report_column, key, hours) && ctx.assume(`vacation_activity:${day.date}`, 'paid', 'הרומה מזכה קריאה מחופשה')) {
      ctx.expect(day.date, key, hours, rule, `${rule.title}: ${activity.join(', ')} ביום חופשה מתוכנן.`, { explain: 'הרומה מזכה את הפיצוי, והאפליקציה מניחה שזו קריאה מחופשה.' });
    } else {
      ctx.note(day.date, `${ctx.codeNames(activity)} ביום חופשה: קריאה מחופשה מגיעה רק על טיסה, ולכן אין פיצוי.`, rule);
    }
  }
  for (const [pairing, dates] of byPairing) {
    // כל יום חופשה בנפרד: הוא אינו קריאה מיוחדת (`special_call`; טיוטה 387).
    for (const d of dates) ctx.markPairing(pairing, `vacation_recall:${d}`);
    const id = `vacation_recall:${pairing.id}`;
    const a = ctx.answer(id) ?? (ctx.paidOn(pairing, params.report_column, key, dates.length * hours) ? ctx.assume(id, 'recalled', 'נקראתי לחזור מחופשה') : null);
    const when = `${pairing.legs.find((l) => l.date === dates[0])?.flight ?? flightsOf(pairing)} ב-${dates.map(dayOf).join(', ')}`;
    if (!a) {
      ctx.ask({ id, date: dates[0], title: `${when} בוצעה ביום חופשה`, body: 'הרומה לא מזכה קריאה מחופשה. מה קרה?',
        options: [{ value: 'recalled', label: 'נקראתי לחזור מחופשה' }, { value: 'mine', label: 'טסתי לבקשתי' }], ruleId: rule.id });
      continue;
    }
    if (a.value === 'mine') {
      ctx.note(dates[0], `${when}: טסת לבקשתך, בלי פיצוי על קריאה מחופשה.`, rule, { pairingId: pairing.id });
      continue;
    }
    ctx.markPairing(pairing, 'vacation_recall');
    // שורה משלה בפירוט, רק בימי החופשה (`ownDays`; בעל המוצר, 21/10/2026; טיוטה 392).
    ctx.expectPairing(pairing, key, dates.length * hours, rule,
      `${rule.title}: ${dates.length === 1 ? 'יממה אחת' : `${dates.length} יממות`} של טיסה בימי חופשה מתוכננים (${dates.map(dayOf).join(', ')}).`,
      { date: dates[0], dates, ownDays: true, explain: dates.length > 1 ? `${rule.title} על כל אחד מהימים` : '' });
  }
}

/**
 * ביטול הדרכה והצבה לטיסה (ישן כ"ה ס' 17.ג): יום שתוכננו בו סימולטור או הדרכת קרקע,
 * ובדוח יש בו טיסה. הטיסה היא קריאה מיוחדת, גם כשהדוח לא רשם S/C. הסבב מסומן, והחישוב
 * עצמו נעשה בקריאה מיוחדת.
 *
 * פעילות שמתחילה ב-`moved_ok_prefixes` (HOME) אינה הדרכה לעניין הזה: אם היא זזה ליום אחר
 * בחודש אין פיצוי (07/06/2026: HOME_RGT תוכנן ל-07 ובוצע ב-09). אם לא זזה – השאלה על הטיסה מכריעה (טיוטה 454).
 * הטיסה שבוצעה ביום המקורי מוזכרת בהערה רק כשהיא לא מוסברת כבר בפני עצמה (`ctx.matches`):
 * ב-07/06/2026 הטיסה שם היא BER, שכבר מוסברת משלה כהחלפה מרצונית של FRA (סבב אחר לגמרי,
 * לא קשור ל-HOME) – ולכן אין טעם לצרף אותה להערה על ה-HOME (בעל המוצר, 26/09/2026).
 */
function training_cancelled_flight(ctx, params, rule) {
  if (!ctx.hasPlan || !ctx.hasExec) return;
  const marked = new Set();
  // `unserved_only` (מילואים): רק יום מתוכנן שלא בוצע ולא זז ליום אחר (`unservedPlanDays`; טיוטה 406).
  const unserved = params.unserved_only ? new Set(unservedPlanDays(ctx, params.plan_code_prefixes ?? []).unserved.map((d) => d.date)) : null;
  for (const day of ctx.timeline) {
    // רק טיסה שהמריאה ביום הזה. יום שהייה בחו"ל בתוך סבב אינו הצבה לטיסה: SIM_BER ב-18/11/2025
    // הוא סימולטור בברלין, בתוך סבב BER 17–19 שתוכנן בשבילו.
    if (!day.exec?.legs?.length || (day.plan?.legs?.length ?? 0) > 0) continue;
    const pairing = ctx.execPairings.find((p) => p.from <= day.date && day.date <= p.to);
    if (!pairing) continue;
    const planCodes = day.plan?.codes ?? [];

    const training = unserved && !unserved.has(day.date) ? [] : planCodes.filter((c) => codeIn(c, params.plan_codes, params.plan_code_prefixes));
    if (training.length && !marked.has(pairing)) {
      marked.add(pairing);
      ctx.markPairing(pairing, 'training_cancelled');
      // בשם העברי ("פעילות קרקעית בוטלה", "מילואים בוטלו"; טיוטות 403, 406).
      const names = ctx.codeNames(training);
      const label = ctx.codeLabel(training[0]);
      const verb = names.includes(', ') || label?.plural ? 'בוטלו' : label?.feminine ? 'בוטלה' : 'בוטל';
      ctx.note(day.date, `${names} ${verb} והוצבת לטיסה: קרדיט הטיסה${DAY_DUES}.`, rule, { pairingId: pairing.id, callOf: pairing.id });
    }

    const own = ctx.matches.find((m) => m.exec === pairing);
    const placed = own && own.how !== 'unplanned' ? '' : ', ובמקומו הוצבת לטיסה';
    for (const code of planCodes.filter((c) => codeIn(c, [], params.moved_ok_prefixes))) {
      const prefix = params.moved_ok_prefixes.find((p) => code.startsWith(p));
      const movedTo = ctx.timeline.filter((d) => d.date !== day.date && ctx.execCodes(d).some((c) => c.startsWith(prefix)) &&
        !(d.plan?.codes ?? []).some((c) => c.startsWith(prefix)));
      if (movedTo.length) {
        // `aside`: ההזזה אינה מה שמגיע על הטיסה של אותם ימים, ולכן ההערה נשארת בהערות, ומתחת לשינוי
        // של הטיסה מה שמגיע עליה (07/06/2026: HOME_RGT שזז, ו-BER; בעל המוצר, 15/10/2026).
        const f = ctx.codeLabel(code)?.feminine ? 'ה' : ''; // בשם העברי ("HOME RGT תוכנן"; טיוטה 403)
        ctx.note(day.date, `${ctx.codeName(code)} תוכנן${f} ל-${dayOf(day.date)} ובוצע${f} ב-${movedTo.map((d) => dayOf(d.date)).join(', ')}${placed}. ` +
          'הזזה בתוך החודש אינה מזכה בפיצוי.', rule, { aside: true, pairingId: pairing.id });
      }
    }
  }
}

/**
 * הפעלה כאיש צוות פעיל (2018 ס' 27.1): רגל שתוכננה כ-DH ובדוח הביצוע אותה טיסה, באותו יום,
 * רשומה כרגל פעילה ולא כ-DH (`report_dh_types`, בדוח DHO). הפיצוי נרשם על הסבב.
 * רגל DH שלא נמצאה בדוח אינה הפעלה, ואין עליה פיצוי מהחוק הזה.
 */
function dh_activated(ctx, params, rule) {
  if (!ctx.hasPlan || !ctx.hasExec) return;
  const dhTypes = params.report_dh_types ?? [];
  for (const day of ctx.timeline) {
    for (const leg of (day.plan?.legs ?? []).filter((l) => l.dh)) {
      const same = (l) => l.flight === leg.flight && l.date === day.date && l.org === leg.org;
      const pairing = ctx.execPairings.find((p) => p.legs.some(same));
      const flown = pairing?.legs.find(same);
      if (!flown || dhTypes.includes(flown.type) || flown.dhd) continue;
      ctx.expectPairing(pairing, params.report_column === 'S/C' ? 'sc' : 'com', H(params.hours), rule,
        `${rule.title}: ${leg.flight} ${leg.org}→${leg.dst} ב-${dayOf(day.date)} תוכננה כ-DH ובוצעה כאיש צוות פעיל.`,
        { explain: `${leg.flight} תוכננה כ-DH ובוצעה כאיש צוות פעיל.` });
    }
  }
}

/**
 * סיום כוננות לטובת מכרז (2024 ס' 50): החברה רשאית לאשר לכונן לסיים כוננות ביומיים האחרונים
 * של רצף הכוננות בגלל זכייה במכרז. אז מגיעים לו קרדיט הטיסה, וגם קריאה מיוחדת על ימי הכוננות
 * שבהם טס ועל הימים הפנויים שאחריה.
 *
 * רצף כוננות = ימים עוקבים בתכנון עם קוד כוננות. טיסה שיוצאת ב-`last_days` הימים האחרונים שלו
 * יכולה להיות זכייה במכרז או הפעלה של הכוננות, והסיבה אינה בקבצים, ולכן שואלים. זכייה במכרז –
 * הסבב מסומן, והקריאה המיוחדת מחושבת בחוק הקריאה המיוחדת. הפעלה – אין פיצוי. עד התשובה חוק
 * הקריאה המיוחדת לא שואל על הסבב שאלה משלו.
 */
function standby_end_for_bid(ctx, params, rule) {
  if (!ctx.hasPlan || !ctx.hasExec) return;
  const lastDays = params.last_days ?? 2;
  const runs = standbyRuns(ctx, params);
  const monthEnd = ctx.timeline.at(-1).date;
  const sc = ctx.rulesWithLogic('special_call')[0];

  for (const run of runs) {
    const tail = run.slice(-lastDays);
    for (const match of ctx.matches) {
      if (match.how !== 'unplanned' || !tail.includes(match.exec.from)) continue;
      const pairing = match.exec;
      const id = `standby_bid:${pairing.id}`;
      // הדוח כבר מזכה את הקריאה המיוחדת: זו זכייה במכרז, ואין מה לשאול.
      // לפי יום: הרומה זיכתה S/C על כל יממה שמגיעה עליה קריאה מיוחדת (בעל המוצר, 08/10/2026).
      const bidDays = scDays(pairing, ctx, sc);
      const answer = ctx.answer(id) ?? (bidDays.length &&
        bidDays.every((d) => ctx.paidOnDate(d, sc.logic.params?.report_column ?? 'S/C', 'sc', H(sc.logic.params?.hours)))
        ? ctx.assume(id, 'standby_bid', 'סיום כוננות בגלל זכייה במכרז') : null);
      const range = run.length === 1 ? dayOf(run[0]) : `⁦${dayOf(run[0])}–${dayOf(run.at(-1))}⁩`;
      if (!answer) {
        ctx.markPairing(pairing, 'standby_bid_pending');
        ctx.ask({
          id,
          date: pairing.from,
          title: `טיסה ביומיים האחרונים של כוננות: ${describePairing(pairing)}`,
          body: `בתכנון כוננות ב-${range}, והטיסה ${ctx.calendarRun ? 'ביומן' : 'יצאה'} ב-${dayOf(pairing.from)}. ` +
            (run.at(-1) === monthEnd && !ctx.nextPlan ? 'הכוננות מגיעה לסוף החודש, וייתכן שהיא נמשכת בחודש הבא. ' : '') +
            (ctx.calendarRun ? '' : 'הרומה לא מזכה קריאה מיוחדת. ') + 'אם הכוננות הופעלה, מגיע רק קרדיט הטיסה. אם החברה אישרה לך לסיים את הכוננות בגלל זכייה במכרז, מגיעה קריאה מיוחדת על ימי הטיסה. מה קרה?',
          // הפעלת הכוננות ראשונה (בעל המוצר, 21/10/2026; טיוטה 390).
          options: [
            { value: 'standby_activated', label: 'הפעלת הכוננות',
              hint: daysAfterStandby(ctx, pairing, run).length ? 'קרדיט הטיסה, וקריאה מיוחדת רק על הימים שאחרי הכוננות' : 'קרדיט הטיסה, בלי קריאה מיוחדת' },
            { value: 'standby_bid', label: 'סיום כוננות בגלל זכייה במכרז', hint: bidHint(pairing, ctx, sc) },
            otherOption(),
          ],
          ruleId: rule.id,
        });
        continue;
      }
      if (answer.value === 'standby_bid') {
        ctx.markPairing(pairing, 'standby_bid');
        ctx.note(pairing.from, `סיום כוננות (${range}) בגלל זכייה במכרז: קרדיט הטיסה${DAY_DUES}.`, rule, { pairingId: pairing.id, callOf: pairing.id });
      } else if (answer.value === 'standby_activated') {
        // הקרדיט על ימי ההפעלה נבדק בחוק ההפעלה מכוננות.
        ctx.markPairing(pairing, 'standby_activated');
      } else {
        ctx.markPairing(pairing, 'standby_bid_pending');
        applyOtherReason(ctx, answer, rule, { what: `טיסה ביומיים האחרונים של הכוננות (${range})`, date: pairing.from, pairing });
      }
    }
  }
}

/**
 * רצפי כוננות בתכנון: ימים עוקבים עם קוד כוננות (`plan_codes` / `plan_code_prefixes`). רצף שמגיע לסוף החודש נמשך
 * בתכנון של החודש הבא, כשהוא שמור, כי היומיים האחרונים נספרים מסוף הרצף (2024 ס' 50; טיוטה 451).
 */
function standbyRuns(ctx, params) {
  const isStandby = (plan) => (plan?.codes ?? []).some((c) => codeIn(c, params.plan_codes, params.plan_code_prefixes));
  const runs = [];
  for (const day of ctx.timeline) {
    if (!isStandby(day.plan)) continue;
    const run = runs.at(-1);
    if (run && run.at(-1) === addDays(day.date, -1)) run.push(day.date);
    else runs.push([day.date]);
  }
  const end = runs.at(-1);
  if (end?.at(-1) === ctx.timeline.at(-1).date) {
    for (let d = addDays(end.at(-1), 1); isStandby(ctx.nextPlan?.days[d]); d = addDays(d, 1)) end.push(d);
  }
  return runs;
}

/**
 * הפעלה מכוננות. טיסה שיוצאת ביום כוננות בתכנון היא הפעלה של הכוננות, ולא קריאה מיוחדת (ישן כ"ה
 * ס' 12.ב: קריאה מיוחדת היא ביממה שבה לא היה משובץ לטיסה או לכוננות), ולא שואלים עליה. היומיים
 * האחרונים של הרצף הם של חוק סיום הכוננות למכרז, ומגיעים לכאן רק אחרי התשובה "הפעלת הכוננות".
 *
 * - הקרדיט על ימי הכוננות שבהם טס: הגבוה מבין קרדיט הרגליים באותם ימים, כולל ההשלמה לסליפ קצר (`minSlipTopUp`), לבין
 *   סכום הערכים של ימי הכוננות האלה, כל יום לפי הקוד שלו (2018 ס' 98.1–98.3, 98.5; `compareStandbyFlown`).
 *   כשהכוננות גבוהה – ההפרש ב-Rig (סבב של יומיים ומעלה; ביום אחד הטיסה תמיד גבוהה; בעל המוצר, 10/10/2026).
 * - החזרה אחרי סוף הכוננות: החברה רשאית להפעיל רק כשהחזרה מתוכננת בתוך הכוננות (2018 ס' 88), ולכן הימים
 *   שאחריה הם בהסכמה, ועל כל יום מהם שלא תוכנן בו כלום מגיעה קריאה מיוחדת, בלי הסף של היממה השנייה (בעל
 *   המוצר, 10/10/2026). ימי הכוננות עצמם – הפעלה, כמו בכל סבב.
 *
 * יום בתכנון הוא טיסה או כוננות, לא שניהם (בעל המוצר, 10/10/2026), ולכן אין בדיקה של טיסה מתוכננת ביום כוננות.
 */
function standby_activation(ctx, params, rule) {
  if (!ctx.hasPlan || !ctx.hasExec) return;
  const pending = ['standby_bid', 'standby_bid_pending'];
  for (const run of standbyRuns(ctx, params)) {
    const range = run.length === 1 ? dayOf(run[0]) : `⁦${dayOf(run[0])}–${dayOf(run.at(-1))}⁩`;
    for (const match of ctx.matches) {
      if (match.how !== 'unplanned' || !run.includes(match.exec.from)) continue;
      const pairing = match.exec;
      if (pending.some((t) => ctx.pairingHandledBy(pairing, t))) continue;
      ctx.markPairing(pairing, 'standby_activated');
      const after = daysAfterStandby(ctx, pairing, run);
      compareStandbyFlown(ctx, pairing, rule);
      // מתחת לשינוי מה שמגיע, בלי סכומים: הקרדיט של הסליפ מול הכוננות בהערות (בעל המוצר, 15/10/2026).
      const due = ['קרדיט הטיסה', ...(ctx.pairingHandledBy(pairing, 'standby_rig') ? ['תוספת עד ערך ימי הכוננות'] : []),
        ...(after.length ? [`קריאה מיוחדת על ${after.length === 1 ? 'היום' : 'הימים'} שאחרי הכוננות`] : [])];
      const without = [...(ctx.pairingHandledBy(pairing, 'standby_flight_higher') ? ['תוספת על הכוננות'] : []), ...(after.length ? [] : ['קריאה מיוחדת'])];
      // הכותרת בשינויים "הפעלה מכוננות", וימי הכוננות בצד התכנון: מתחת לשינוי רק מה שמגיע (טיוטה 392).
      ctx.note(pairing.from, `הפעלה מכוננות: ${due.length > 1 ? `${due.slice(0, -1).join(', ')} ו${due.at(-1)}` : due[0]}` +
        `${without.length ? `, בלי ${without.join(' ובלי ')}` : ''}.`, rule, { pairingId: pairing.id });
      // החזרה אחרי סוף הכוננות: הימים שאחריה בהסכמה, וכל יום שלא תוכנן בו כלום הוא קריאה מיוחדת (2018 ס' 88;
      // בעל המוצר, 10/10/2026). חוק הקריאה המיוחדת מדלג על סבב שהופעל מכוננות, ולכן הציפייה כאן.
      const sc = ctx.rulesWithLogic('special_call')[0];
      for (const d of sc ? after : []) {
        ctx.expectPairing(pairing, 'sc', H(sc.logic.params.hours), sc, `${flightsOf(pairing)}: יממה ${dayOf(d)}, אחרי סוף הכוננות (${range}).`,
          { date: d, dates: [d], perDay: true, explain: 'הסבב נמשך אחרי סוף הכוננות.' });
      }

    }
  }
  activatedBefore(ctx, params);
}

/**
 * סבב שהופעל מכוננות בחודש הקודם וחזר בחודש הזה: על הימים הפנויים כאן מגיעה קריאה מיוחדת, גם בלי תשובה שם. גם הפעלה
 * וגם זכייה במכרז מזכות בה על הימים שאחרי הכוננות (בעל המוצר, 31/10/2026, טיוטה 455).
 */
function activatedBefore(ctx, params) {
  const pairing = ctx.execPairings[0];
  const stay = pairing?.cutAtStart ? carriedStay(ctx, pairing) : null;
  const sc = ctx.rulesWithLogic('special_call')[0];
  if (!stay || stay.plan || !sc || ctx.matches.find((m) => m.exec === pairing)?.plan) return;
  const planned = ctx.prevMonth.timeline.find((d) => d.date === stay.before.from)?.plan?.codes ?? [];
  if (!planned.some((c) => codeIn(c, params.plan_codes, params.plan_code_prefixes))) return;
  if (ctx.prevMonth.answers?.[`standby_bid:${stay.before.id}`]?.value === 'other' || ctx.answer(`unplanned:${pairing.id}`)) return;
  ctx.markPairing(pairing, 'standby_activated');
  const days = daysAfterStandby(ctx, pairing, [addDays(ctx.monthFirst, -1)]);
  for (const d of days) {
    ctx.expectPairing(pairing, 'sc', H(sc.logic.params.hours), sc, `${flightsOf(pairing)}: יממה ${dayOf(d)}, אחרי סוף הכוננות.`,
      { date: d, dates: [d], perDay: true, explain: 'הסבב נמשך אחרי סוף הכוננות.' });
  }
}

/**
 * ימי הכוננות שבהם טס בסבב, וערך כל אחד (2018 ס' 98.1–98.3): לפי קוד הכוננות שברומה – מי שעבר ביממה ממצב
 * הכן רגיל למיידי משולם עליה כמיידי (98.5) – ובלעדיו לפי הקוד שבתכנון. יום של Soft Start אינו יום כוננות
 * (91.4). כל ימי הסבב, מההמראה עד הנחיתה, גם יום שהייה שאין בו רגל. רק קודים של חוקי זיכוי יומי עם
 * `flight_day_takes_higher`. [{date, code, value}], ו-value ריק
 * כשאין חוק לקוד שבתכנון.
 */
function standbyDaysFlown(ctx, pairing) {
  const valueOf = (code) => {
    const v = standbyDayRule(ctx, code);
    return v?.rule.logic.params?.flight_day_takes_higher ? v : null;
  };
  const out = [];
  for (const day of ctx.timeline) {
    if (!inStay(pairing, day.date) || ctx.softStart(day.date)) continue;
    const reported = ctx.execCodes(day).find(valueOf);
    const planned = (day.plan?.codes ?? []).find((c) => c.startsWith('SBY'));
    const code = reported ?? planned;
    if (code) out.push({ date: day.date, code, value: valueOf(code) });
  }
  return out;
}

/**
 * הפעלה מכוננות לסליפ (2018 ס' 98.1–98.3, 98.5): הגבוה מבין קרדיט הרגליים באותם ימים (כולל ההשלמה לסליפ קצר) לבין
 * סכום הערכים של ימי הכוננות שבהם טס (`standbyDaysFlown`). רגל אחרי סוף הכוננות אינה נכנסת להשוואה, ומזוכה בנוסף
 * (בעל המוצר, 30/10/2026, טיוטה 451). פעם אחת לסבב, בין שהכוננות רשומה ברומה ביום הטיסה
 * (`absence_day_credit`) ובין שרק בתכנון (`standby_activation`). הכוננות גבוהה – ההפרש ב-Rig (בעל המוצר,
 * 10/10/2026; כל יום לפי הקוד שלו – 15/10/2026; העמודה לא אומתה מול הרומה).
 */
function compareStandbyFlown(ctx, pairing, rule) {
  if (ctx.pairingHandledBy(pairing, 'standby_compared')) return;
  ctx.markPairing(pairing, 'standby_compared');
  const days = standbyDaysFlown(ctx, pairing);
  if (!days.length) return;
  const inside = pairing.legs.filter((l) => days.some((d) => d.date === l.date));
  const partial = inside.length < pairing.legs.length;
  const legs = sumLegs({ ...pairing, legs: inside }, ctx.domicile);
  const credit = legs == null ? null : legs + minSlipTopUp(ctx, pairing);
  const n = days.length;
  const what = `${n === 1 ? 'יום הכוננות שבו' : `${n} ימי הכוננות שבהם`} טסת (${days.map((d) => dayOf(d.date)).join(', ')})`;
  const unknown = days.find((d) => !d.value);
  if (unknown) {
    ctx.review(`${describePairing(pairing)}: על ${what} מגיע הגבוה מבין קרדיט הטיסה לבין ערך ימי הכוננות (2018 ס' 98). ` +
      `אין חוק שקובע את ערך הכוננות לקוד ${unknown.code}.`, rule);
    return;
  }
  const value = days.reduce((s, d) => s + d.value.min, 0);
  const parts = days.map((d) => `${dayOf(d.date)} ${d.code} ${minToHhmm(d.value.min)}`).join(', ');
  if (credit == null) {
    ctx.review(`${describePairing(pairing)}: על ${what} מגיע הגבוה מבין קרדיט הטיסה לבין ${minToHhmm(value)} (${parts}; 2018 ס' 98), ` +
      'וקרדיט הטיסה אינו ידוע.', rule);
  } else if (credit < value) {
    ctx.markPairing(pairing, 'standby_rig');
    ctx.expectPairing(pairing, 'rig', value - credit, rule,
      `${describePairing(pairing)}: ${parts} על ${what}, יחד ${minToHhmm(value)}, גבוה מקרדיט הטיסה ${minToHhmm(credit)}`,
      { explain: `ערך ${n === 1 ? 'יום הכוננות שבו' : `${n} ימי הכוננות שבהם`} טסת גבוה מקרדיט ${partial ? `הרגליים ${n === 1 ? 'באותו יום' : 'באותם ימים'}` : 'הסבב'}.` });
  } else {
    ctx.markPairing(pairing, 'standby_flight_higher');
    // מספר הרגל הראשונה ביום בראש ההערה, כמו בשאר ההערות על יום של טיסה. `aside`: בהערות, ולא מתחת
    // לשינוי, שבו אין סכומים (בעל המוצר, 15/10/2026).
    const day = ctx.timeline.find((d) => d.date === days[0].date);
    const leg = (day?.exec?.legs ?? []).find((l) => l.flight) ?? pairing.legs?.find((l) => l.flight);
    ctx.note(days[0].date, `${leg ? `${leg.flight} ` : ''}${days[0].date === pairing.from ? 'הופעלת מכוננות' : 'טסת ביום כוננות'}, וקרדיט ${partial ? 'הרגליים בימי הכוננות' : 'הסליפ'} (${minToHhmm(credit)}) גבוה מערך הכוננות, ולכן אין תוספת.`,
      rule, { pairingId: pairing.id, aside: true });
  }
}

/**
 * ימי הסבב אחרי סוף רצף הכוננות שלא תוכנן בהם כלום (`ctx.planFreeDay`), מההמראה ועד הנחיתה בבסיס בפועל,
 * כולל נחיתה אחרי חצות, כמו ב-`extensionDays`.
 */
function daysAfterStandby(ctx, pairing, run) {
  if (!pairing.cutAtEnd && pairing.to <= run.at(-1)) return [];
  const { end } = stayEnd(ctx, pairing);
  if (end == null) return [];
  const days = [];
  for (let d = addDays(run.at(-1), 1); at(d, 0) < end; d = addDays(d, 1)) {
    if (ctx.timeline.some((x) => x.date === d) && ctx.planFreeDay(d)) days.push(d);
  }
  return days;
}

/** חוק זיכוי היום של קוד כוננות בתכנון, וערך היום שלו. בדוח הקוד מקוצר ל-5 תווים (SBY_S). */
function standbyDayRule(ctx, planCode) {
  if (!planCode) return null;
  const rule = ctx.rulesWithLogic('absence_day_credit').find((r) => {
    const p = r.logic.params ?? {};
    const confirmed = p.confirm_code_prefixes?.length ? confirmedCodes(ctx, p) : [];
    return codeIn(planCode, p.plan_codes, p.plan_code_prefixes) || codeIn(planCode.slice(0, 5), p.report_codes, p.report_code_prefixes) ||
      confirmed.includes(planCode);
  });
  return rule ? { rule, min: H(rule.logic.params.credit_hours) } : null;
}

/** כמה קריאה מיוחדת מגיעה על הסבב, לרמז בתשובה "זכייה במכרז". */
function bidHint(pairing, ctx, sc) {
  if (!sc) return 'קריאה מיוחדת על ימי הטיסה';
  const p = sc.logic.params ?? {};
  const stay = awayFromBase(pairing, ctx.tz, ctx.timeline.at(-1).date);
  if (stay.error) return `קריאה מיוחדת על ימי הטיסה, ב-${p.report_column ?? 'S/C'}`;
  const n = countSpecialCallDays(stay, p, pairing, ctx.fdp).counted.length;
  return `קריאה מיוחדת: ${n === 1 ? 'יממה אחת' : `${n} יממות`}, ${minToHhmm(n * H(p.hours))} ב-${p.report_column ?? 'S/C'}`;
}

/** היממות שמגיעה עליהן קריאה מיוחדת על סבב (`countSpecialCallDays`); ריק כשאי אפשר לספור. */
function scDays(pairing, ctx, sc) {
  if (!sc) return [];
  const stay = awayFromBase(pairing, ctx.tz, ctx.timeline.at(-1).date);
  return stay.error ? [] : countSpecialCallDays(stay, sc.logic.params ?? {}, pairing, ctx.fdp).counted;
}

/**
 * מקום בהערה של הפיצויים היומיים על הטיסה `callOf` – קריאה מיוחדת, קריאה מחופשה ופעילות שנייה, כל אחד עם הימים שלו
 * (" וקריאה מיוחדת על 09/09", ", קריאה מיוחדת על 01/09 וקריאה מחופשה על 02/09"): חוק שרץ לפניהם אינו יודע על אילו
 * ימים הם מגיעים, ו-`evaluate` משלים אחרי כל החוקים לפי הציפיות שלהם, ובלעדיהן מוחק (בעל המוצר, 21/10/2026; טיוטות 395, 398).
 */
export const DAY_DUES = '⁣dues⁣';

export const LOGIC = {
  credit_from_scheduled,
  min_slip_credit,
  absence_day_credit,
  vacation_credit_balance,
  unpaid_leave_days,
  hotel_waiver_days,
  per_diem_estimate,
  absence_month_cap,
  late_landing_home,
  long_flight_day,
  examiner_training_boost,
  special_call,
  higher_of_planned_performed,
  lost_hours_credit,
  voluntary_swap,
  cancelled_no_compensation,
  vacation_recall,
  training_cancelled_flight,
  dh_activated,
  standby_end_for_bid,
  standby_activation,
  ...DUTY_LOGIC,
};

/**
 * הפרמטרים שכל לוגיקה מכירה. פרמטר שאינו ברשימה פירושו שהחוק השתנה בלוגיקה
 * ולא רק בערך, ואז החוק מסומן "לא נתמך, דורש עדכון" במקום לרוץ בלי הפרמטר.
 * פרמטר חדש מתווסף כאן רק יחד עם הקוד שמשתמש בו.
 */
export const KNOWN_PARAMS = {
  credit_from_scheduled: [],
  min_slip_credit: ['min_credit_hours', 'per_fdp', 'legal_rest_hours'],
  absence_day_credit: ['plan_codes', 'report_codes', 'plan_code_prefixes', 'report_code_prefixes', 'report_flag_column', 'credit_hours', 'tab_hours', 'requires_assigned_activity', 'flight_day_takes_higher', 'away_flag_on_pairing_start', 'confirm_code_prefixes', 'confirm_label', 'confirm_answer', 'exclude_codes', 'ask_when_missing', 'missing_label', 'assume_unknown_codes', 'unserved_empty_rule'],
  unpaid_leave_days: ['plan_codes', 'report_codes', 'plan_code_prefixes', 'report_code_prefixes'],
  hotel_waiver_days: ['report_column'],
  per_diem_estimate: ['higher_stay_tolerance_minutes', 'rates', 'default_position', 'slip_month', 'slip_owner_staff', 'stay_column', 'flight_column', 'stay_deduction_usd', 'hotel_waiver_column', 'hotel_waiver'],
  vacation_credit_balance: ['per_day_hours', 'days_full_rate', 'monthly_max_hours', 'yearly_cap_days', 'taper_table', 'taper_table_complete', 'taper_monthly_totals'],
  absence_month_cap: ['cap_hours'],
  late_landing_home: ['grace_minutes', 'step_minutes', 'hours_per_step', 'note_from_minutes'],
  long_flight_day: ['over_flight_hours', 'hours'],
  examiner_training_boost: ['dd_codes', 'slip_threshold', 'hours', 'report_column'],
  special_call: ['hours', 'report_column', 'second_day_min_gap_hours', 'second_day_min_hours', 'ask_user_if_no_sc'],
  higher_of_planned_performed: ['requires_user_answer', 'excluded_when_special_call', 'excluded_when_voluntary_swap', 'shortfall_column'],
  lost_hours_credit: ['requires_user_answer', 'credit_column', 'include_min_slip_credit', 'answer_value', 'answer_label', 'answer_label_with_flight', 'only_without_flight', 'merged_answer_values', 'fleets', 'plan_aircraft'],
  voluntary_swap: ['requires_user_answer'],
  cancelled_no_compensation: ['requires_user_answer'],
  vacation_recall: ['plan_codes', 'plan_code_prefixes', 'report_codes', 'report_code_prefixes', 'hours', 'report_column', 'exclude_codes'],
  training_cancelled_flight: ['plan_codes', 'plan_code_prefixes', 'moved_ok_prefixes', 'unserved_only'],
  dh_activated: ['hours', 'report_column', 'report_dh_types'],
  standby_end_for_bid: ['requires_user_answer', 'plan_codes', 'plan_code_prefixes', 'last_days'],
  standby_activation: ['plan_codes', 'plan_code_prefixes'],
  ...DUTY_PARAMS,
};

/** סדר ההרצה. חוקים שמסמנים סבבים חייבים לרוץ לפני חוקים שבודקים את הסימון. */
export const LOGIC_ORDER = [
  'absence_day_credit',
  'vacation_credit_balance',
  'unpaid_leave_days',
  'hotel_waiver_days',
  'credit_from_scheduled',
  'late_landing_home',
  'long_flight_day',
  'cancelled_no_compensation',
  'voluntary_swap',
  // מסמנים סבבים שקריאה מיוחדת צריכה להכיר: קריאה מחופשה, הדרכה שבוטלה, וסיום כוננות למכרז.
  'vacation_recall',
  'training_cancelled_flight',
  'dh_activated',
  'standby_end_for_bid',
  // אחרי סיום כוננות למכרז: ההפעלה נבדקת רק על מה שלא נשאל שם, או שנענה "הפעלת הכוננות".
  'standby_activation',
  // לפני הקריאה המיוחדת: סבב שהשהייה בו הוארכה אינו נספר כולו כקריאה מיוחדת.
  'stay_extension',
  'special_call',
  'lost_hours_credit',
  'min_slip_credit',
  'higher_of_planned_performed',
  // אחרי החוקים שמסמנים סבבים ועונים על שאלות ההחלפה: נחיתות לילה נספרות לפי הסיבה לביטול.
  'night_landings',
  'same_fdp_rounds',
  'second_unplanned_activity',
  'base_rest_shortfall',
  'special_date_activity',
  'white_flight',
  'ulh_flight',
  'examiner_training_boost',
  // קיצור המנוחה במיאמי מסמן את הסבב, ושני חוקי הדחייה של ס' 24.4 נשענים על הסימון.
  'short_rest_miami',
  'miami_delay',
  'short_rest_las_vegas',
  'short_rest_new_york',
  'free_days_waived',
  'consecutive_saturdays',
  'consecutive_night_rounds',
  'sim_night_session',
  'sim_extension',
  'sim_friday_holiday_eve',
  'covered_by',
  // אחרון מבין חוקי הפיצוי: בלי הרכב צוות, הוא מניח צוות חוקי רק כשהפיצוי ברומה ושאר החוקים אינם מסבירים אותו.
  'legal_crew_composition',
  'absence_month_cap',
  // אחרי כל החוקים שמזכים קרדיט ו-Rig: שעות הטיסה של האש"ל הן מה שצפוי עליהם.
  'per_diem_estimate',
];
