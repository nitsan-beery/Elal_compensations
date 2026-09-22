// מימוש הלוגיקות של החוקים.
//
// כל פונקציה מקבלת (ctx, params, rule) ורושמת ציפיות וממצאים ל-ctx.
// הערכים המספריים מגיעים כולם מ-`params` של החוק ב-`rules.json`, ולא מהקוד.
// מזהה לוגיקה שאינו מופיע כאן נחשב "לא נתמך" ומוצג למשתמש.

import { hoursToMin, minToHhmm } from '../time.js';
import { describePairing } from '../model.js';
import { stationOffset } from '../airports.js';
import { DUTY_LOGIC, DUTY_PARAMS, execFdpGroups } from './duty.js';

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
 */
function credit_from_scheduled(ctx, params, rule) {
  const monthEnd = ctx.timeline.at(-1).date;
  for (const pairing of ctx.execPairings) {
    if (sumLegs(pairing) == null) {
      ctx.review(`${describePairing(pairing)}: חסרות שעות מתוכננות (SkdDur) בדוח, ולא ניתן לחשב קרדיט.`, rule);
      continue;
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
    for (const leg of pairing.legs) {
      // בתכנון בלבד הקרדיט הוא ה-FT של כל יום, שכבר רשום ביום שלו. אין מה לפצל.
      if (!ctx.hasExec) { add(leg.date, leg.skdDur); continue; }
      const split = splitAtMidnight(leg, ctx.domicile);
      if (leg.prevMonth) {
        // הרגל רשומה ביום 1 אבל יצאה ביום האחרון של החודש הקודם.
        if (split.error) { error = split.error; break; }
        const prev = split.before ?? leg.skdDur; // נחתה לפני חצות: כולה זוכתה בחודש הקודם
        add(leg.date, leg.skdDur - prev, `${leg.flight} יצאה בחודש הקודם, ושם זוכו ${minToHhmm(prev)}. בחודש הזה ${minToHhmm(leg.skdDur - prev)} מתוך ${minToHhmm(leg.skdDur)}`);
        continue;
      }
      if (split.error) {
        // אי אפשר לדעת מתי המריאה בשעון הבסיס. בסוף החודש זה משנה את הסכום, ובאמצעו רק את החלוקה.
        if (leg.date === monthEnd) { error = split.error; break; }
        add(leg.date, leg.skdDur, `${leg.flight}: לא ידועה שעת ההמראה בשעון הבסיס, כל הקרדיט ביום שבו היא רשומה`);
        continue;
      }
      const date = addDays(leg.date, split.shift);
      const moved = split.shift ? `${leg.flight} רשומה ב-${dayOf(leg.date)} אבל המריאה ב-${dayOf(date)} בשעון הבסיס` : null;
      if (split.before == null) { add(date, leg.skdDur, moved); continue; }
      const next = addDays(date, 1);
      if (next > monthEnd) {
        add(date, split.before, `${leg.flight} חוצה את סוף החודש: בחודש הזה ${minToHhmm(split.before)} מההמראה בפועל עד חצות, והשאר בחודש הבא`);
        continue;
      }
      add(date, split.before, `${leg.flight} חוצה חצות: ${minToHhmm(split.before)} מההמראה בפועל עד חצות`);
      add(next, leg.skdDur - split.before, `${leg.flight}: ${minToHhmm(leg.skdDur - split.before)} אחרי חצות (${minToHhmm(leg.skdDur)} − ${minToHhmm(split.before)})`);
    }
    if (error) {
      ctx.review(`${describePairing(pairing)}: ${error} דורש בדיקה ידנית.`, rule);
      continue;
    }
    for (const [date, d] of days) {
      ctx.expectPairingDay(pairing, date, 'flight', d.min, rule, ['קרדיט לפי STA − STD', ...d.why].join('. '));
    }
  }
}

/**
 * ההמראה בפועל בשעון הבסיס, ביחס לחצות של היום שבו הרגל רשומה: `shift` – כמה ימים
 * אחרי (או לפני) היום הרשום היא המריאה, ו-`before` – כמה ממנה חל לפני חצות של יום
 * ההמראה, או null אם היא לא חוצה חצות. השעות בדוח מקומיות, ולכן ההפרש של שדה המוצא
 * נלמד מהנחיתה בבסיס, או לפי אזור הזמן של השדה.
 */
function splitAtMidnight(leg, domicile) {
  const dur = leg.actDur ?? leg.skdDur;
  let local = leg.atd ?? leg.std; // ההמראה בשעון המקומי, ביחס ליום הרשום
  if (local == null || dur == null) return { error: `לא ניתן לדעת מתי המריאה ${leg.flight}.` };
  if (leg.atd != null && leg.std != null) {
    if (leg.atd - leg.std < -720) local += 1440; // עיכוב אל מעבר לחצות
    else if (leg.atd - leg.std > 720) local -= 1440; // הקדמה לפני חצות
  }
  let off = null; // שעון מקומי בשדה המוצא פחות שעון הבסיס
  if (leg.org === domicile) off = 0;
  else if (leg.dst === domicile && (leg.ata ?? leg.sta) != null) {
    const depBase = mod((leg.ata ?? leg.sta) - dur, 1440);
    off = mod(local - depBase + 720, 1440) - 720;
  } else off = stationOffset(leg.org, leg.date, domicile);
  if (off == null) return { error: `לא ניתן לדעת מתי המריאה ${leg.flight} בשעון הבסיס.` };
  const dep = local - off;
  const shift = Math.floor(dep / 1440);
  const clock = dep - shift * 1440;
  return { shift, before: clock + dur <= 1440 ? null : 1440 - clock };
}

const sumLegs = (pairing) =>
  pairing.legs.reduce((acc, l) => (acc == null || l.skdDur == null ? null : acc + l.skdDur), 0);

/**
 * סליפ שהקרדיט שלו קצר מהמינימום מקבל השלמה, וההפרש נרשם ב-Rig. סליפ שנחתך בגבול
 * החודש לא נבדק: ההשלמה נקבעת על הסליפ כולו (28/02/2026: BUD 03:35 בלי Rig).
 */
function min_slip_credit(ctx, params, rule) {
  const min = H(params.min_credit_hours);
  const groups = params.per_fdp
    ? execFdpGroups(ctx.execPairings, ctx.domicile, H(params.legal_rest_hours), params.report_minutes_before_std ?? 0)
    : ctx.execPairings.map((p) => [p]);
  for (const group of groups) {
    const slips = group.filter((p) => !ctx.pairingHandledBy(p, 'lost_hours_credit') && !p.cutAtStart && !p.cutAtEnd);
    if (slips.length !== group.length) {
      // סבב חתוך או סבב שבוטל בגלל מטוס חכור: שאר ה-FDP נבדק לבד, כל סבב בנפרד.
      for (const p of slips) expectMinSlip(ctx, [p], min, params, rule);
      continue;
    }
    expectMinSlip(ctx, group, min, params, rule);
  }
}

/**
 * המינימום ל-FDP הוא המינימום לסליפ כפול מספר הסבבים שבו, מול הקרדיט של כולם יחד
 * (25/11/2025: BUS 05:04 ו-LCA 02:15 → Rig 02:41 = 2 × 5:00 − 07:19, ולא 02:45).
 */
function expectMinSlip(ctx, group, min, params, rule) {
  const credits = group.map(sumLegs);
  if (credits.some((c) => c == null)) return;
  const credit = credits.reduce((s, c) => s + c, 0);
  if (credit === 0 || credit >= min * group.length) return;
  const note = group.length === 1
    ? `השלמה ל-${params.min_credit_hours} שעות`
    : `השלמה ל-${group.length} × ${params.min_credit_hours} שעות על ${group.length} סבבים באותו FDP (${group.map(describePairing).join(', ')})`;
  ctx.expectPairing(group.at(-1), 'rig', min * group.length - credit, rule, note);
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
    ctx.expect(day.date, 'absence', credit, rule, rule.title, { code: matchedCode(day, params, ctx) });
    // יום בתוך סבב, בלי טיסה משלו (SIM_BER ב-18/11/2025, באמצע סבב BER): ה-TAB הוא של השהייה בחו"ל,
    // וסימון העמודה נרשם ביום תחילת הסבב.
    const away = !day.exec?.legs?.length && !day.plan?.legs?.length
      ? ctx.execPairings.find((p) => p.from < day.date && day.date < p.to) : null;
    if (params.report_flag_column) {
      const flagDate = away && params.away_flag_on_pairing_start ? away.from : day.date;
      ctx.expectFlag(flagDate, params.report_flag_column, 1, rule);
    }
    if (params.tab_hours != null && !away) ctx.expectTab(day.date, H(params.tab_hours), rule);
    ctx.markAbsence(day.date, rule.id);
  }
}

/**
 * כשיש דוח ביצוע, רק הדוח קובע: פעילות קרקע שתוכננה ליום אחד יכולה לזוז ליום אחר
 * (HOME_RGT תוכנן ל-07/01/2026 ובוצע ב-05/01). קוד התכנון משמש רק בלי דוח.
 */
const matchesCode = (day, params, ctx) => matchedCode(day, params, ctx) != null;

/** הקוד שבגללו היום מזוכה, כדי שהסיכום יוכל למיין את הימים (HOME_RGT לעומת שאר אימון הקרקע). */
function matchedCode(day, params, ctx) {
  if (ctx.hasExec) return ctx.execCodes(day).find((c) => codeIn(c, params.report_codes, params.report_code_prefixes)) ?? null;
  return (day.plan?.codes ?? []).find((c) => codeIn(c, params.plan_codes, params.plan_code_prefixes)) ?? null;
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

    const training = ctx.pairingHandledBy(match.exec, 'training_cancelled');
    if (reported > 0 || answer?.value === 'special_call' || training) {
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
    if (match.how === 'unplanned' && params.ask_user_if_no_sc && !answer && !ctx.pairingHandledBy(match.exec, 'vacation_recall')) {
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

// ---------- שינויים בפעילות שאינה טיסה ----------

/**
 * קריאה מחופשה (ישן כ"ה ס' 13.ג): יום שתוכנן בו VAC ובדוח יש בו טיסה או פעילות אחרת, ואין VAC.
 * התשלום הוא לכל יממה או חלק ממנה של פעילות בתקופת החופשה, בנוסף לקרדיט של מה שבוצע.
 * הסבב מסומן, וקריאה מיוחדת לא שואלת עליו "מה קרה": ידוע שהחברה קראה לחזור מחופשה.
 */
function vacation_recall(ctx, params, rule) {
  if (!ctx.hasPlan || !ctx.hasExec) return;
  const hours = H(params.hours);
  const key = params.report_column === 'S/C' ? 'sc' : 'com';
  const byPairing = new Map();
  for (const day of ctx.timeline) {
    if (!(day.plan?.codes ?? []).some((c) => codeIn(c, params.plan_codes, params.plan_code_prefixes))) continue;
    if (ctx.execCodes(day).some((c) => codeIn(c, params.report_codes, params.report_code_prefixes))) continue;
    const pairing = ctx.execPairings.find((p) => p.from <= day.date && day.date <= p.to);
    if (pairing) {
      if (!byPairing.has(pairing)) byPairing.set(pairing, []);
      byPairing.get(pairing).push(day.date);
      continue;
    }
    const activity = ctx.activityCodes(day);
    if (activity.length) ctx.expect(day.date, key, hours, rule, `${rule.title}: ${activity.join(', ')} ביום חופשה מתוכנן.`);
  }
  for (const [pairing, dates] of byPairing) {
    ctx.markPairing(pairing, 'vacation_recall');
    ctx.expectPairing(pairing, key, dates.length * hours, rule,
      `${rule.title}: ${dates.length === 1 ? 'יממה אחת' : `${dates.length} יממות`} של טיסה בימי חופשה מתוכננים (${dates.map(dayOf).join(', ')}).`);
  }
}

/**
 * ביטול הדרכה והצבה לטיסה (ישן כ"ה ס' 17.ג): יום שתוכננו בו סימולטור או הדרכת קרקע,
 * ובדוח יש בו טיסה. הטיסה היא קריאה מיוחדת, גם כשהדוח לא רשם S/C. הסבב מסומן, והחישוב
 * עצמו נעשה בקריאה מיוחדת.
 *
 * פעילות שמתחילה ב-`moved_ok_prefixes` (HOME) אינה הדרכה לעניין הזה: אם היא זזה ליום אחר
 * בחודש אין פיצוי (07/06/2026: HOME_RGT תוכנן ל-07 ובוצע ב-09). אם לא זזה – בדיקה ידנית.
 */
function training_cancelled_flight(ctx, params, rule) {
  if (!ctx.hasPlan || !ctx.hasExec) return;
  const marked = new Set();
  for (const day of ctx.timeline) {
    // רק טיסה שהמריאה ביום הזה. יום שהייה בחו"ל בתוך סבב אינו הצבה לטיסה: SIM_BER ב-18/11/2025
    // הוא סימולטור בברלין, בתוך סבב BER 17–19 שתוכנן בשבילו.
    if (!day.exec?.legs?.length || (day.plan?.legs?.length ?? 0) > 0) continue;
    const pairing = ctx.execPairings.find((p) => p.from <= day.date && day.date <= p.to);
    if (!pairing) continue;
    const planCodes = day.plan?.codes ?? [];

    const training = planCodes.filter((c) => codeIn(c, params.plan_codes, params.plan_code_prefixes));
    if (training.length && !marked.has(pairing)) {
      marked.add(pairing);
      ctx.markPairing(pairing, 'training_cancelled');
      ctx.note(day.date, `${training.join(', ')} תוכנן ל-${dayOf(day.date)}, ובמקומו הוצבת ל-${describePairing(pairing)}. ` +
        'זו קריאה מיוחדת לפי ס\' 17.ג.', rule);
    }

    for (const code of planCodes.filter((c) => codeIn(c, [], params.moved_ok_prefixes))) {
      const prefix = params.moved_ok_prefixes.find((p) => code.startsWith(p));
      const movedTo = ctx.timeline.filter((d) => d.date !== day.date && ctx.execCodes(d).some((c) => c.startsWith(prefix)) &&
        !(d.plan?.codes ?? []).some((c) => c.startsWith(prefix)));
      if (movedTo.length) {
        ctx.note(day.date, `${code} תוכנן ל-${dayOf(day.date)} ובוצע ב-${movedTo.map((d) => dayOf(d.date)).join(', ')}, ` +
          `ובמקומו הוצבת ל-${describePairing(pairing)}. הזזה בתוך החודש אינה מזכה בפיצוי.`, rule);
      } else {
        ctx.review(`${code} תוכנן ל-${dayOf(day.date)}, ובמקומו הוצבת ל-${describePairing(pairing)}. ` +
          `${code} לא בוצע ביום אחר בחודש. דורש בדיקה ידנית.`, rule);
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
        `${rule.title}: ${leg.flight} ${leg.org}→${leg.dst} ב-${dayOf(day.date)} תוכננה כ-DH ובוצעה כאיש צוות פעיל.`);
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
  vacation_recall,
  training_cancelled_flight,
  dh_activated,
  ...DUTY_LOGIC,
};

/**
 * הפרמטרים שכל לוגיקה מכירה. פרמטר שאינו ברשימה פירושו שהחוק השתנה בלוגיקה
 * ולא רק בערך, ואז החוק מסומן "לא נתמך, דורש עדכון" במקום לרוץ בלי הפרמטר.
 * פרמטר חדש מתווסף כאן רק יחד עם הקוד שמשתמש בו.
 */
export const KNOWN_PARAMS = {
  credit_from_scheduled: [],
  min_slip_credit: ['min_credit_hours', 'per_fdp', 'legal_rest_hours', 'report_minutes_before_std'],
  absence_day_credit: ['plan_codes', 'report_codes', 'plan_code_prefixes', 'report_code_prefixes', 'report_flag_column', 'credit_hours', 'tab_hours', 'requires_assigned_activity', 'flight_day_takes_higher', 'away_flag_on_pairing_start'],
  vacation_credit_balance: ['per_day_hours', 'days_full_rate', 'monthly_max_hours', 'yearly_cap_days', 'taper_table', 'taper_table_complete', 'taper_monthly_totals'],
  absence_month_cap: ['cap_hours'],
  late_landing_home: ['grace_minutes', 'step_minutes', 'hours_per_step'],
  long_flight_day: ['over_flight_hours', 'hours'],
  special_call: ['hours', 'report_column', 'second_day_min_gap_hours', 'second_day_min_hours', 'ask_user_if_no_sc'],
  higher_of_planned_performed: ['requires_user_answer', 'excluded_when_special_call', 'excluded_when_voluntary_swap', 'shortfall_column'],
  lost_hours_credit: ['requires_user_answer', 'credit_column', 'include_min_slip_credit'],
  voluntary_swap: ['requires_user_answer'],
  cancelled_no_compensation: ['requires_user_answer'],
  vacation_recall: ['plan_codes', 'plan_code_prefixes', 'report_codes', 'report_code_prefixes', 'hours', 'report_column'],
  training_cancelled_flight: ['plan_codes', 'plan_code_prefixes', 'moved_ok_prefixes'],
  dh_activated: ['hours', 'report_column', 'report_dh_types'],
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
  // מסמנים סבבים שקריאה מיוחדת צריכה להכיר: קריאה מחופשה, והדרכה שבוטלה.
  'vacation_recall',
  'training_cancelled_flight',
  'dh_activated',
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
  'free_days_waived',
  'consecutive_saturdays',
  'absence_month_cap',
];
