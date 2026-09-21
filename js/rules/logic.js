// מימוש הלוגיקות של החוקים.
//
// כל פונקציה מקבלת (ctx, params, rule) ורושמת ציפיות וממצאים ל-ctx.
// הערכים המספריים מגיעים כולם מ-`params` של החוק ב-`rules.json`, ולא מהקוד.
// מזהה לוגיקה שאינו מופיע כאן נחשב "לא נתמך" ומוצג למשתמש.

import { hoursToMin, minToHhmm } from '../time.js';
import { describePairing } from '../model.js';
import { DUTY_LOGIC, DUTY_PARAMS } from './duty.js';

const H = (hours) => hoursToMin(hours) ?? 0;

// ---------- קרדיט טיסה ----------

/** קרדיט כל רגל = STA − STD. הדוח כבר נותן את זה ב-SkdDur, אחרי המרת אזורי זמן. */
function credit_from_scheduled(ctx, params, rule) {
  const monthEnd = ctx.timeline.at(-1).date;
  for (const pairing of ctx.execPairings) {
    const credit = sumLegs(pairing);
    if (credit == null) {
      ctx.review(`${describePairing(pairing)}: חסרות שעות מתוכננות (SkdDur) בדוח, ולא ניתן לחשב קרדיט.`, rule);
      continue;
    }
    const cut = pairing.cutAtEnd ? monthEndSplit(pairing, monthEnd, ctx.domicile) : null;
    const carry = pairing.cutAtStart ? carriedIn(pairing, ctx.domicile) : null;
    const error = cut?.error ?? carry?.error;
    if (error) {
      ctx.review(`${describePairing(pairing)}: ${error} דורש בדיקה ידנית.`, rule);
      continue;
    }
    let expected = credit;
    const why = ['קרדיט לפי STA − STD'];
    if (carry) {
      expected -= carry.before;
      why.push(`${carry.leg.flight} יצאה בחודש הקודם, ושם זוכו ${minToHhmm(carry.before)}. בחודש הזה ${minToHhmm(carry.leg.skdDur - carry.before)} מתוך ${minToHhmm(carry.leg.skdDur)}`);
    }
    if (cut) {
      expected += cut.before - cut.leg.skdDur;
      why.push(`${cut.leg.flight} חוצה את סוף החודש: בחודש הזה ${minToHhmm(cut.before)} מההמראה בפועל עד חצות, והשאר בחודש הבא`);
    }
    ctx.expectPairing(pairing, 'flight', expected, rule, why.join('. '));
  }
}

/**
 * רגל שנוחתת אחרי חצות של היום האחרון בחודש: הדוח מזכה בחודש הזה את הזמן מההמראה בפועל
 * ועד חצות בשעון הבסיס, והשאר בחודש הבא (31/05/2026: LY387, ‏ATD 19:38 → 04:22, יותר
 * מ-SkdDur 04:15). כך הדוח מפצל טיסת לילה גם בין שני ימים בתוך החודש (25/01/2026).
 */
function monthEndSplit(pairing, monthEnd, domicile) {
  const leg = pairing.legs.findLast((l) => l.date === monthEnd);
  if (!leg) return null;
  const before = beforeMidnight(leg, domicile);
  if (before?.error) return before;
  if (before == null) return null;
  return { leg, before };
}

/**
 * החלק השני של monthEndSplit: הרגל שיצאה בחודש הקודם מזוכה בחודש הזה ב-SkdDur פחות מה
 * שזוכה עליה שם. 01/06/2026: LY387, ‏SkdDur 04:15, זוכו 04:22 במאי → ‎−00:07 ביוני.
 */
function carriedIn(pairing, domicile) {
  const leg = pairing.legs[0];
  if (!leg?.prevMonth) return null;
  const before = beforeMidnight(leg, domicile);
  if (before?.error) return before;
  return { leg, before: before ?? leg.skdDur }; // נחתה לפני חצות: כולה זוכתה בחודש הקודם
}

/** כמה מהרגל חל לפני חצות בשעון הבסיס, או null אם היא לא חוצה חצות. */
function beforeMidnight(leg, domicile) {
  const dur = leg.actDur ?? leg.skdDur;
  let dep = null; // המראה בשעון הבסיס
  if (leg.org === domicile) dep = leg.atd ?? leg.std;
  else if (leg.dst === domicile && (leg.ata ?? leg.sta) != null && dur != null) dep = mod((leg.ata ?? leg.sta) - dur, 1440);
  if (dep == null || dur == null) return { error: `לא ניתן לדעת כמה מ-${leg.flight} חל לפני חצות של סוף החודש.` };
  return dep + dur <= 1440 ? null : 1440 - dep;
}

const sumLegs = (pairing) =>
  pairing.legs.reduce((acc, l) => (acc == null || l.skdDur == null ? null : acc + l.skdDur), 0);

/**
 * סליפ שהקרדיט שלו קצר מהמינימום מקבל השלמה, וההפרש נרשם ב-Rig. סליפ שנחתך בגבול
 * החודש לא נבדק: ההשלמה נקבעת על הסליפ כולו (28/02/2026: BUD 03:35 בלי Rig).
 */
function min_slip_credit(ctx, params, rule) {
  const min = H(params.min_credit_hours);
  for (const pairing of ctx.execPairings) {
    if (ctx.pairingHandledBy(pairing, 'lost_hours_credit')) continue;
    if (pairing.cutAtStart || pairing.cutAtEnd) continue;
    const credit = sumLegs(pairing);
    if (credit == null || credit === 0 || credit >= min) continue;
    ctx.expectPairing(pairing, 'rig', min - credit, rule, `השלמה ל-${params.min_credit_hours} שעות`);
  }
}

// ---------- ימי היעדרות וזיכוי ----------

/**
 * זיכוי יומי לפי קוד: חופשה, מחלה, אימון קרקע, סימולטור וכוננות.
 * כמה חוקים שונים משתמשים בלוגיקה הזאת, כל אחד עם קודים וערכים משלו.
 *
 * `flight_day_takes_higher`: יום שבו הופעל לסליפ (כוננות, 03/06/2026) מזוכה לפי הגבוה מבין
 * קרדיט הסליפ לבין ערך ימי הקוד שבו. כשהסליפ גבוה – הקרדיט שלו כבר צפוי ואין תוספת.
 */
function absence_day_credit(ctx, params, rule) {
  const credit = H(params.credit_hours);
  const onFlightDay = new Set();
  for (const day of ctx.timeline) {
    if (!matchesCode(day, params, ctx)) continue;
    if (params.flight_day_takes_higher) {
      const pairing = ctx.execPairings.find((p) => p.dates.includes(day.date));
      if (pairing) {
        if (onFlightDay.has(pairing)) continue;
        onFlightDay.add(pairing);
        const days = ctx.timeline.filter((d) => pairing.dates.includes(d.date) && matchesCode(d, params, ctx)).length;
        const flown = sumLegs(pairing);
        if (flown == null || flown < credit * days) {
          ctx.review(`${describePairing(pairing)}: ${rule.title} ביום שבו הופעלת לסליפ. הקרדיט הוא הגבוה מבין הסליפ ` +
            `(${flown == null ? 'לא ידוע' : minToHhmm(flown)}) לבין ${days} ימים × ${minToHhmm(credit)}. דורש בדיקה ידנית.`, rule);
        } else {
          ctx.note(day.date, `${rule.title}: הופעלת לסליפ, וקרדיט הסליפ (${minToHhmm(flown)}) גבוה מערך הכוננות, ולכן אין תוספת.`, rule);
        }
        continue;
      }
    }
    if (params.requires_assigned_activity) {
      const assigned = ctx.wasAssigned(day.date);
      if (assigned == null) {
        ctx.ask({
          id: `assigned:${day.date}`,
          date: day.date,
          title: `${rule.title} ב-${day.date.slice(8, 10)}/${day.date.slice(5, 7)}: האם היית מוצב לפעילות?`,
          body: 'אין קובץ תכנון לחודש הזה. קרדיט על היום ניתן רק אם היית מוצב בו לפעילות.',
          options: [
            { value: 'yes', label: 'כן, הייתי מוצב' },
            { value: 'no', label: 'לא הייתי מוצב' },
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
    ctx.expect(day.date, 'absence', credit, rule, rule.title);
    if (params.report_flag_column) ctx.expectFlag(day.date, params.report_flag_column, 1, rule);
    if (params.tab_hours != null) ctx.expectTab(day.date, H(params.tab_hours), rule);
    ctx.markAbsence(day.date, rule.id);
  }
}

/**
 * כשיש דוח ביצוע, רק הדוח קובע: פעילות קרקע שתוכננה ליום אחד יכולה לזוז ליום אחר
 * (HOME_RGT תוכנן ל-07/01/2026 ובוצע ב-05/01). קוד התכנון משמש רק בלי דוח.
 */
function matchesCode(day, params, ctx) {
  if (ctx.hasExec) return ctx.execCodes(day).some((c) => codeIn(c, params.report_codes, params.report_code_prefixes));
  return (day.plan?.codes ?? []).some((c) => codeIn(c, params.plan_codes, params.plan_code_prefixes));
}

const codeIn = (code, list = [], prefixes = []) => list.includes(code) || prefixes.some((p) => code.startsWith(p));

/**
 * איזון קרדיט לימי חופשה. מספר ימי החופשה בחודש קובע תוספת אחת לכל הימים.
 * עד `days_full_rate` ימים התוספת היא `per_day_hours`, ומעבר לזה לפי `taper_table`.
 *
 * הסכום מחושב כתוספת ליום × מספר הימים (החלטת בעל המוצר, 21/09/2026).
 * `taper_monthly_totals` אינו בשימוש בחישוב: הוא שונה מהמכפלה בעד 7 דקות.
 * העיגול לדקות נעשה על הסכום ולא על כל יום, כדי לא לצבור שגיאת עיגול.
 */
function vacation_credit_balance(ctx, params, rule) {
  const days = ctx.timeline.filter((d) => ctx.isAbsenceBy(d.date, 'vacation_base_credit'));
  if (!days.length) return;

  const n = days.length;
  const full = params.days_full_rate ?? 20;
  let rate;
  if (n <= full) {
    rate = params.per_day_hours;
  } else if (params.taper_table_complete && params.taper_table?.[String(n)] != null) {
    rate = params.taper_table[String(n)];
  } else {
    ctx.review(`בחודש ${n} ימי חופשה, ואין לכך מדרגה בטבלת איזון החופשה ב-rules.json. דורש בדיקה ידנית.`, rule);
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
  if (params.yearly_cap_days != null) {
    ctx.note(days[0].date, `תקרת ${params.yearly_cap_days} ימי חופשה בשנה אינה נבדקת בחודש בודד.`, rule);
  }
}

/** בחודש שכולו היעדרות, סך הזיכויים מוגבל. */
function absence_month_cap(ctx, params, rule) {
  const hasFlights = ctx.timeline.some((d) => (d.exec?.legs?.length ?? 0) > 0 || (d.plan?.legs?.length ?? 0) > 0);
  if (hasFlights) return;
  ctx.capAbsenceTotal(H(params.cap_hours), rule);
}

// ---------- חוקי ביצוע ----------

/**
 * נחיתה מאוחרת בארץ: משווים ATA מול STA של הנחיתה בבסיס, כולל רגל DHO.
 * עד `grace_minutes` אין פיצוי, ומעבר לכך מדרגה לכל שעה או חלק ממנה.
 */
function late_landing_home(ctx, params, rule) {
  const grace = params.grace_minutes ?? 60;
  const step = params.step_minutes ?? 60;
  const perStep = H(params.hours_per_step);

  for (const day of ctx.timeline) {
    for (const leg of day.exec?.legs ?? []) {
      if (leg.dst !== ctx.domicile || leg.sta == null || leg.ata == null) continue;
      const delay = wrapDelta(leg.ata - leg.sta);
      if (delay <= grace) {
        if (delay > 0) ctx.note(day.date, `${leg.flight} נחתה באיחור של ${delay} דק', לא מעבר לסף של ${grace} דק'. אין פיצוי.`, rule);
        continue;
      }
      const steps = Math.ceil((delay - grace) / step);
      ctx.expect(day.date, 'com', steps * perStep, rule, `${leg.flight}: איחור ${delay} דק' → ${steps} מדרגות`);
    }
  }
}

/**
 * טיסה ארוכה עם נחיתת ביניים (ישן כ"ה ס' 12.יב, בפרשנות בעל המוצר): הרגליים שהמריאו
 * באותו יום בשעון הבסיס הן יותר מרגל אחת, וסכום הקרדיט המתוכנן שלהן (STA − STD, כולל
 * DH) עולה על `over_flight_hours`. הפיצוי נרשם ב-COM.
 * אומת: DME הלוך-חזור 12:45 → COM 02:30 (18/01, 09/02, 17/05, 03/06/2026).
 */
function long_flight_day(ctx, params, rule) {
  const over = H(params.over_flight_hours);
  for (const pairing of ctx.execPairings) {
    const byDate = new Map();
    for (const leg of pairing.legs) {
      if (leg.skdDur == null) continue;
      const d = byDate.get(leg.date) ?? { legs: 0, min: 0 };
      byDate.set(leg.date, { legs: d.legs + 1, min: d.min + leg.skdDur });
    }
    for (const [date, { legs, min: flown }] of byDate) {
      if (legs < 2 || flown <= over) continue;
      ctx.expect(date, 'com', H(params.hours), rule, `${describePairing(pairing)}: ${minToHhmm(flown)} שעות טיסה ביום`);
    }
  }
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
  for (const match of ctx.matches) {
    if (!match.exec) continue;
    const reported = ctx.reportedOn(match.exec, column);
    const answer = ctx.answerFor(match);

    if (reported > 0 || answer?.value === 'special_call') {
      ctx.markPairing(match.exec, 'special_call');
      const stay = awayFromBase(match.exec, ctx.domicile, ctx.timeline.at(-1).date);
      if (stay.error) {
        ctx.review(`${describePairing(match.exec)}: ${stay.error} לא ניתן לספור יממות לקריאה המיוחדת. דורש בדיקה ידנית.`, rule);
        continue;
      }
      const days = countSpecialCallDays(stay, params);
      ctx.expectPairing(match.exec, 'sc', days.counted.length * H(params.hours), rule,
        `קריאה מיוחדת: ${days.counted.length === 1 ? 'יממה אחת' : `${days.counted.length} יממות`} ` +
        `(${days.counted.map(dayOf).join(', ')}). ${days.reason}`);
      continue;
    }
    // טיסה לא מתוכננת בלי S/C: לא מנחשים, שואלים.
    if (match.how === 'unplanned' && params.ask_user_if_no_sc && !answer) {
      ctx.ask({
        id: `unplanned:${match.exec.id}`,
        date: match.exec.from,
        title: `פעילות ביום שלא תוכננה בו פעילות: ${describePairing(match.exec)}`,
        body: `לא נרשם ${column} בדוח, ולכן לא ניתן לדעת אם מגיעה קריאה מיוחדת. מה קרה?`,
        options: [
          { value: 'special_call', label: 'קריאה מיוחדת' },
          { value: 'voluntary_swap', label: 'החלפה מרצוני', needsLink: true },
          { value: 'other', label: 'סיבה אחרת', needsText: true },
        ],
        ruleId: rule.id,
      });
    }
  }
}

/**
 * זמן שהייה מחוץ לבסיס (פרק כ"ה ס' 1.יא): מההמראה המתוכננת או בפועל, המוקדם מביניהם,
 * ועד סיום הטיסה האחרונה בבסיס. זמנים מוחזרים כדקות מתחילת היממה הראשונה, בשעון הבסיס.
 *
 * בדוח הביצוע כל שעה רשומה בשעון המקומי של התחנה. רגל היציאה מהבסיס היא כבר בשעון
 * הבסיס. בנחיתה בבסיס ידוע השעון בבסיס, ושעת ההמראה בשעון הבסיס מחושבת לאחור לפי משך
 * הטיסה. הרגל רשומה בדוח תחת יום ההמראה בשעון הבסיס, גם כשבשעון המקומי ההמראה כבר
 * ביום הבא (אומת: LY336 ב-16/07; LY5110 ב-06/01, 25/01 ו-29/01/2026, המראה אחרי חצות בטביליסי).
 */
function awayFromBase(pairing, domicile, monthEnd) {
  const out = pairing.legs.find((l) => l.org === domicile);
  const home = [...pairing.legs].reverse().find((l) => l.dst === domicile);
  if (!out || (!home && !pairing.cutAtEnd)) return { error: 'הסבב לא יוצא מהבסיס או לא חוזר אליו.' };

  const first = pairing.from;
  const depClock = [out.std, out.atd].filter((t) => t != null);
  if (!depClock.length) return { error: 'חסרה שעת המראה מהבסיס.' };
  const start = daysBetween(first, out.date) * 1440 + Math.min(...depClock);
  // הסבב חוזר בחודש הבא: בחודש הזה נספרות היממות עד סוף החודש.
  if (!home) return { first, start, end: (daysBetween(first, monthEnd) + 1) * 1440, cutAtEnd: true };

  const arrClock = home.ata ?? home.sta;
  const dur = home.ata != null ? (home.actDur ?? home.skdDur) : home.skdDur;
  if (arrClock == null || dur == null) return { error: 'חסרים שעת נחיתה בבסיס או משך הטיסה.' };
  const homeDep = mod(arrClock - dur, 1440); // שעת ההמראה של רגל החזרה, בשעון הבסיס
  const end = daysBetween(first, home.date) * 1440 + homeDep + dur;
  return { first, start, end };
}

/**
 * יממות לתשלום קריאה מיוחדת. יממה היא יום קלנדרי בשעון מקומי (ישן כ"ה ס' 12.א).
 * "כל יממה או חלק ממנה" (12.ג), אבל היממה האחרונה נספרת רק אם השהייה כולה ארוכה מ-
 * `second_day_min_gap_hours`, ולפחות `second_day_min_hours` ממנה ביממה האחרונה (12.יא).
 */
function countSpecialCallDays(stay, params) {
  const firstDay = Math.floor(stay.start / 1440);
  const lastDay = Math.floor((stay.end - 1) / 1440);
  const all = [];
  for (let d = firstDay; d <= lastDay; d++) all.push(addDays(stay.first, d));
  if (stay.cutAtEnd) return { counted: all, reason: 'הסבב חוזר בחודש הבא; נספרות היממות עד סוף החודש, והיממה האחרונה נבדקת בחודש הבא.' };
  if (all.length === 1) return { counted: all, reason: 'יממה אחת.' };

  const total = stay.end - stay.start;
  const inLast = stay.end - lastDay * 1440;
  const gap = H(params.second_day_min_gap_hours);
  const min = H(params.second_day_min_hours);
  const facts = `שהייה ${minToHhmm(total)}, מתוכה ${minToHhmm(inLast)} ביממה האחרונה`;
  if (total > gap && inLast >= min) return { counted: all, reason: `${facts}: היממה האחרונה נספרת.` };
  return {
    counted: all.slice(0, -1),
    reason: `${facts}. היממה האחרונה לא נספרת: נדרשים מעל ${minToHhmm(gap)} ברצף ולפחות ${minToHhmm(min)} בה.`,
  };
}

const mod = (n, m) => ((n % m) + m) % m;
const dayMs = 86400000;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / dayMs);
const addDays = (iso, n) => new Date(Date.parse(iso) + n * dayMs).toISOString().slice(0, 10);
const dayOf = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7);

/** שינוי בתוכנית: תשלום לפי הגבוה מבין המתוכנן לבין שבוצע. */
function higher_of_planned_performed(ctx, params, rule) {
  for (const match of ctx.matches) {
    if (!match.plan) continue;
    const answer = ctx.answerFor(match);
    // מועמד להחלפה = בוצע סבב אחר באותם ימים, או שהמשתמש ענה שהסבב הוחלף. סבב שהפך
    // למחלה או לפעילות קרקע אינו החלפת טיסה.
    const candidate = (match.exec && match.how === 'dates') || answer?.value === 'replaced';
    if (!candidate) continue;
    if (params.excluded_when_special_call && ctx.pairingHandledBy(match.exec, 'special_call')) continue;
    if (params.excluded_when_voluntary_swap && answer?.value === 'voluntary_swap') continue;

    const performed = match.exec ? sumLegs(match.exec) : 0;
    const planned = ctx.plannedCredit(match.plan);
    if (planned == null || performed == null) continue;
    if (planned <= performed) continue;

    // יש הפרש לתשלום. החלפה לבקשת אצ"א אינה מזכה, והסיבה לא בקבצים: שואלים. אבל אם
    // הדוח כבר השלים בדיוק את ההפרש, החברה עצמה קבעה שזו החלפה שלה (05/05/2026: TBS → BUD,
    // Rig 00:06), ואין מה לשאול. לפעמים ההשלמה נרשמת על סבב סמוך ולא על המחליף עצמו
    // (10/06/2026: LTN 11–12 → OTP 11, ה-Rig 05:10 נרשם על OTP של 10/06).
    const column = params.shortfall_column === 'Rig' ? 'rig' : 'com';
    const paidOn = match.exec && !answer ? findShortfallPaid(ctx, match, planned - performed, column, params.shortfall_column ?? 'COM') : null;
    if (paidOn) {
      const where = paidOn === match.exec ? '' : `, ונרשם על ${describePairing(paidOn)}`;
      ctx.note(match.plan.from, `${describePairing(match.plan)} → ${describePairing(match.exec)}: הדוח השלים את ההפרש ` +
        `${minToHhmm(planned - performed)} לפי "הגבוה מבין השתיים"${where}. לכן לא נשאלת שאלה.`, rule);
    } else if (params.requires_user_answer && answer?.value !== 'replaced') {
      if (answer) continue;
      ctx.ask({
        id: `replaced:${match.plan.id}`,
        date: match.plan.from,
        title: `סבב שהוחלף בסבב קצר יותר: ${describePairing(match.plan)} → ${describePairing(match.exec)}`,
        body: `המתוכנן ארוך מהמבוצע ב-${minToHhmm(planned - performed)}. אם החברה החליפה את הטיסה, ההפרש מגיע לפי "הגבוה מבין השתיים". מה קרה?`,
        options: [
          { value: 'replaced', label: 'החברה החליפה את הטיסה', hint: `ההפרש ${minToHhmm(planned - performed)} ב-Rig` },
          { value: 'voluntary_swap', label: 'החלפה מרצוני', hint: 'רק הקרדיט של מה שבוצע' },
          { value: 'other', label: 'סיבה אחרת', needsText: true },
        ],
        ruleId: rule.id,
      });
      continue;
    }

    const target = paidOn ?? match.exec ?? match.plan;
    ctx.expectPairing(target, column, planned - performed, rule,
      `המתוכנן (${describePairing(match.plan)}) גבוה מהמבוצע. ההפרש לפי "הגבוה מבין השתיים".`);
  }
}

/** ביטול בגלל מטוס חכור: השעות שהפסיד, כולל השלמה לסליפ קצר. */
/**
 * הסבב שעליו הדוח כבר רשם בדיוק את ההפרש: קודם הסבב המחליף, ואחר כך סבב ביצוע שנוגע
 * בטווח של יום אחד מהסבב המתוכנן. "בדיוק" = מה שבדוח פחות מה שכבר צפוי עליו מחוקים אחרים.
 */
function findShortfallPaid(ctx, match, diff, key, column) {
  const extra = (p) => ctx.reportedOn(p, column) - ctx.expectedOn(p, key);
  if (extra(match.exec) === diff) return match.exec;
  const from = addDays(match.plan.from, -1);
  const to = addDays(match.plan.to, 1);
  return ctx.execPairings.find((p) => p !== match.exec && p.dates.some((d) => from <= d && d <= to) && extra(p) === diff) ?? null;
}

function lost_hours_credit(ctx, params, rule) {
  for (const match of ctx.matches) {
    if (!match.plan) continue;
    const answer = ctx.answerFor(match);
    if (answer?.value !== 'wet_lease') continue;

    let lost = ctx.plannedCredit(match.plan);
    if (lost == null) { ctx.review(`${describePairing(match.plan)}: אין שעות מתוכננות בקובץ, לא ניתן לחשב את השעות שהפסיד.`, rule); continue; }
    if (params.include_min_slip_credit) {
      const min = ctx.minSlipMinutes();
      if (min && lost < min) lost = min;
    }
    ctx.expect(match.plan.from, params.credit_column === 'Rig' ? 'rig' : 'credit', lost, rule,
      `${describePairing(match.plan)} בוטלה בגלל מטוס חכור`);
    ctx.markPairing(match.plan, 'lost_hours_credit');
  }
}

/** החלפה מרצון: רק הקרדיט של הטיסה שבוצעה. אין קריאה מיוחדת ואין "הגבוה". */
function voluntary_swap(ctx, params, rule) {
  for (const match of ctx.matches) {
    const answer = ctx.answerFor(match);
    if (answer?.value !== 'voluntary_swap') continue;
    const target = match.exec ?? match.plan;
    ctx.markPairing(target, 'voluntary_swap');
    ctx.note((match.plan ?? match.exec).from,
      'החלפה מרצון: רק הקרדיט של הטיסה שבוצעה, כולל השלמה לסליפ קצר. אין פיצוי נוסף.', rule);
  }
}

/** טיסה שבוטלה ללא פיצוי. */
function cancelled_no_compensation(ctx, params, rule) {
  for (const match of ctx.matches) {
    if (!match.plan || match.how !== 'cancelled') continue;
    const answer = ctx.answerFor(match);
    if (!answer) {
      ctx.ask({
        id: `cancelled:${match.plan.id}`,
        date: match.plan.from,
        title: `סבב מתוכנן שלא בוצע: ${describePairing(match.plan)}`,
        body: 'הסיבה אינה מופיעה בקבצים, והיא קובעת מה מגיע. מה קרה?',
        options: [
          { value: 'replaced', label: 'הוחלפה בטיסה אחרת', hint: 'הגבוה מבין השתיים, וההפרש ב-Rig' },
          { value: 'wet_lease', label: 'הועברה למטוס חכור ולא נמצאה חלופה', hint: 'השעות שהפסיד, ב-Rig' },
          { value: 'cancelled', label: 'בוטלה ללא פיצוי', hint: 'לא מגיע כלום' },
          { value: 'voluntary_swap', label: 'החלפה מרצוני', hint: 'רק הקרדיט של מה שבוצע', needsLink: true },
          { value: 'other', label: 'סיבה אחרת', needsText: true },
        ],
        ruleId: rule.id,
      });
      continue;
    }
    if (answer.value === 'cancelled') {
      ctx.note(match.plan.from, `${describePairing(match.plan)} בוטלה ללא פיצוי.`, rule);
      ctx.markPairing(match.plan, 'cancelled_no_compensation');
    }
    if (answer.value === 'other') {
      ctx.review(`${describePairing(match.plan)}: ${answer.text || 'סיבה אחרת'}. דורש בדיקה ידנית.`, rule);
    }
  }
}

export const LOGIC = {
  credit_from_scheduled,
  min_slip_credit,
  absence_day_credit,
  vacation_credit_balance,
  absence_month_cap,
  late_landing_home,
  long_flight_day,
  special_call,
  higher_of_planned_performed,
  lost_hours_credit,
  voluntary_swap,
  cancelled_no_compensation,
  ...DUTY_LOGIC,
};

/**
 * הפרמטרים שכל לוגיקה מכירה. פרמטר שאינו ברשימה פירושו שהחוק השתנה בלוגיקה
 * ולא רק בערך, ואז החוק מסומן "לא נתמך, דורש עדכון" במקום לרוץ בלי הפרמטר.
 * פרמטר חדש מתווסף כאן רק יחד עם הקוד שמשתמש בו.
 */
export const KNOWN_PARAMS = {
  credit_from_scheduled: [],
  min_slip_credit: ['min_credit_hours'],
  absence_day_credit: ['plan_codes', 'report_codes', 'plan_code_prefixes', 'report_code_prefixes', 'report_flag_column', 'credit_hours', 'tab_hours', 'requires_assigned_activity', 'flight_day_takes_higher'],
  vacation_credit_balance: ['per_day_hours', 'days_full_rate', 'monthly_max_hours', 'yearly_cap_days', 'taper_table', 'taper_table_complete', 'taper_monthly_totals'],
  absence_month_cap: ['cap_hours'],
  late_landing_home: ['grace_minutes', 'step_minutes', 'hours_per_step'],
  long_flight_day: ['over_flight_hours', 'hours'],
  special_call: ['hours', 'report_column', 'second_day_min_gap_hours', 'second_day_min_hours', 'ask_user_if_no_sc'],
  higher_of_planned_performed: ['requires_user_answer', 'excluded_when_special_call', 'excluded_when_voluntary_swap', 'shortfall_column'],
  lost_hours_credit: ['requires_user_answer', 'credit_column', 'include_min_slip_credit'],
  voluntary_swap: ['requires_user_answer'],
  cancelled_no_compensation: ['requires_user_answer'],
  ...DUTY_PARAMS,
};

/** סדר ההרצה. חוקים שמסמנים סבבים חייבים לרוץ לפני חוקים שבודקים את הסימון. */
export const LOGIC_ORDER = [
  'absence_day_credit',
  'vacation_credit_balance',
  'credit_from_scheduled',
  'late_landing_home',
  'long_flight_day',
  'cancelled_no_compensation',
  'voluntary_swap',
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
  'absence_month_cap',
];
