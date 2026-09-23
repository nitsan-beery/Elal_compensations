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
 *
 * הדוח רושם רגל ביום ה-STD בשעון הבסיס, גם כשבשעון המקומי זה עוד היום הקודם (LY398
 * ב-24/01/2025: ‏STD 23:05 במדריד = 00:05 ב-24/01, ‏ATD 00:35 → 24/01, לא 25/01).
 */
function splitAtMidnight(leg, domicile) {
  const dur = leg.actDur ?? leg.skdDur;
  let local = leg.atd ?? leg.std; // ההמראה בשעון המקומי, ביחס ליום ה-STD המקומי
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
  // ה-STD בשעון הבסיס נופל ביום הרשום; מזיזים את השעון המקומי כך שיתאים לו.
  const std = leg.std ?? local;
  const dep = local - off - (std - off - mod(std - off, 1440));
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
  ctx.expectPairing(group.at(-1), 'rig', min * group.length - credit, rule, note,
    { reason: `השלמה ל-${params.min_credit_hours} שעות` });
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
  if (params.confirm_code_prefixes?.length) {
    askUnconfirmedCodes(ctx, params, rule);
    const confirmed = confirmedCodes(ctx, params);
    params = { ...params, plan_codes: [...(params.plan_codes ?? []), ...confirmed],
      report_codes: [...(params.report_codes ?? []), ...confirmed.map((c) => c.slice(0, 5))] };
    noteUpgrade(ctx, params, rule, credit);
  }
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
        body: `הקוד מופיע ב-${days}${credits ? `, ובדוח Credit ${credits}` : ''}. הוא עוד לא נראה בקבצים, ` +
          `והאפליקציה לא מנחשת את הזיכוי שלו. ${params.confirm_label} מזכה ב-${value} ליום.`,
        options: [
          { value: params.confirm_answer, label: `כן, ${params.confirm_label}`, hint: `${value} ליום` },
          { value: 'other', label: 'לא, משהו אחר', needsText: true },
        ],
        ruleId: rule.id,
      });
    } else if (answer.value === 'other') {
      ctx.review(`קוד ${c.code} (${days}): ${answer.text || 'לא ' + params.confirm_label}. דורש בדיקה ידנית.`, rule);
    }
  }
}

/**
 * יום שבתכנון קוד החוק ובביצוע קוד של חוק זיכוי יומי אחר (הכן רגיל שעבר להכן מיידי): הזיכוי
 * לפי הביצוע, והחוק של קוד הביצוע כבר צופה אותו.
 */
function noteUpgrade(ctx, params, rule, credit) {
  if (!ctx.hasExec) return;
  for (const day of ctx.timeline) {
    if (!(day.plan?.codes ?? []).some((c) => codeIn(c, params.plan_codes, params.plan_code_prefixes))) continue;
    if (matchesCode(day, params, ctx)) continue;
    const other = ctx.execCodes(day).map((c) => ({ c, r: ctx.rulesWithLogic('absence_day_credit').find((r) => r !== rule &&
      codeIn(c, r.logic.params?.report_codes, r.logic.params?.report_code_prefixes)) })).find((x) => x.r);
    if (!other) continue;
    ctx.note(day.date, `בתכנון ${rule.title} (${minToHhmm(credit)}), ובביצוע ${other.c}: ${other.r.title} ` +
      `(${minToHhmm(H(other.r.logic.params.credit_hours))}). הזיכוי לפי הביצוע.`, rule);
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
 * `yearly_cap_days` נשמר כנתון בלבד: תקרת ימי החופשה השנתית אינה נבדקת בחודש
 * בודד, ואין טעם להעיר על כך בכל בדיקה (החלטת בעל המוצר, 23/09/2026).
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
}

/** בחודש שכולו היעדרות, סך הזיכויים מוגבל. */
function absence_month_cap(ctx, params, rule) {
  const hasFlights = ctx.timeline.some((d) => (d.exec?.legs?.length ?? 0) > 0 || (d.plan?.legs?.length ?? 0) > 0);
  if (hasFlights) return;
  ctx.capAbsenceTotal(H(params.cap_hours), rule);
}

/**
 * פיצוי בדוח שאף חוק אינו מסביר, בגובה `hours` בדיוק על סבב, עשוי להיות החוק הזה. החוק תלוי
 * במידע שאינו בקבצים (למשל הרכב הצוות), ולכן לא מנחשים שהפיצוי מגיע; כשהוא כבר בדוח, הוא
 * נרשם כצפוי עם הערה `hint`. רץ אחרי כל שאר החוקים.
 */
function unexplained_report_amount(ctx, params, rule) {
  if (!ctx.hasExec) return;
  const key = params.report_column === 'S/C' ? 'sc' : 'com';
  for (const p of ctx.execPairings) {
    const extra = ctx.reportedOn(p, params.report_column) - ctx.expectedAround(p, key);
    if (extra !== H(params.hours)) continue;
    ctx.expectPairing(p, key, extra, rule, `${describePairing(p)}: ${minToHhmm(extra)} ב-${params.report_column} שאף חוק אחר אינו מסביר. ${params.hint}`, { hint: true });
  }
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
    if (!match.exec || ctx.pairingHandledBy(match.exec, 'stay_extension')) continue;
    // הופעל מכוננות (לפי תשובתו): אין קריאה מיוחדת, גם כשהדוח רשם S/C.
    if (ctx.pairingHandledBy(match.exec, 'standby_activated')) continue;
    const reported = ctx.reportedOn(match.exec, column);
    const answer = ctx.answerFor(match);

    const training = ctx.pairingHandledBy(match.exec, 'training_cancelled');
    const bid = ctx.pairingHandledBy(match.exec, 'standby_bid');
    if (reported > 0 || answer?.value === 'special_call' || training || bid) {
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
    // טיסה בסוף כוננות: השאלה עליה היא של סיום כוננות למכרז.
    if (match.how === 'unplanned' && params.ask_user_if_no_sc && !answer && !ctx.pairingHandledBy(match.exec, 'vacation_recall') &&
      !ctx.pairingHandledBy(match.exec, 'standby_bid_pending')) {
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

/**
 * שינוי בתוכנית: תשלום לפי הגבוה מבין המתוכנן לבין שבוצע.
 * סבב מתוכנן שבמקומו בוצע סבב אחר באותם ימים. שואלים כשהמבוצע קצר מהמתוכנן, וגם כשיש על
 * הסבב שבוצע Rig שאף חוק אחר אינו מסביר. לא מניחים החלפה של החברה גם כשה-Rig בדוח שווה
 * בדיוק להפרש (החלטת בעל המוצר, 22/09/2026): ה-Rig יכול להיות גם השעות שהפסיד בגלל מטוס
 * חכור או חניך (`lost_hours_credit`).
 */
function higher_of_planned_performed(ctx, params, rule) {
  const column = params.shortfall_column === 'Rig' ? 'rig' : 'com';
  const reportColumn = params.shortfall_column ?? 'COM';
  for (const match of ctx.matches) {
    if (!match.plan) continue;
    const answer = ctx.answerFor(match);
    // מועמד להחלפה = בוצע סבב אחר באותם ימים, או שהמשתמש ענה שהסבב הוחלף. סבב שהפך
    // למחלה או לפעילות קרקע אינו החלפת טיסה.
    const candidate = (match.exec && match.how === 'dates') || answer?.value === 'replaced';
    if (!candidate) continue;
    if (ctx.pairingHandledBy(match.plan, 'lost_hours_credit')) continue;
    if (params.excluded_when_special_call && ctx.pairingHandledBy(match.exec, 'special_call')) continue;
    if (params.excluded_when_voluntary_swap && answer?.value === 'voluntary_swap') continue;

    const performed = match.exec ? sumLegs(match.exec) : 0;
    const planned = ctx.plannedCredit(match.plan);
    if (planned == null || performed == null) continue;
    const diff = planned - performed;
    const unexplained = match.exec ? ctx.reportedOn(match.exec, reportColumn) - ctx.expectedOn(match.exec, column) : 0;
    if (diff <= 0 && unexplained <= 0) continue;

    const what = `${describePairing(match.plan)} → ${describePairing(match.exec ?? match.plan)}`;
    if (!answer && params.requires_user_answer) {
      const facts = [
        diff > 0 ? `המתוכנן ארוך מהמבוצע ב-${minToHhmm(diff)}.` : `המבוצע אינו קצר מהמתוכנן.`,
        unexplained > 0 ? `בדוח ${reportColumn} ${minToHhmm(unexplained)} על ${describePairing(match.exec)}, שאף חוק אחר אינו מסביר.` : '',
      ].filter(Boolean).join(' ');
      ctx.ask({
        id: `replaced:${match.plan.id}`,
        date: match.plan.from,
        title: diff > 0 ? `סבב שהוחלף בסבב קצר יותר: ${what}` : `${reportColumn} לא מוסבר על סבב שהחליף סבב מתוכנן: ${what}`,
        body: `${facts} הסיבה אינה בקבצים, והיא קובעת מה מגיע. מה קרה?`,
        options: [
          { value: 'replaced', label: 'החלפה ביוזמת החברה (כולל זכיה במכרז)', hint: diff > 0 ? `ההפרש ${minToHhmm(diff)} ב-${reportColumn}` : 'אין הפרש לתשלום' },
          ...lostHoursOptions(ctx, match.plan, 'בנוסף לקרדיט של מה שבוצע'),
          { value: 'voluntary_swap', label: 'החלפה מרצוני', hint: 'רק הקרדיט של מה שבוצע' },
          { value: 'other', label: 'סיבה אחרת', needsText: true },
        ],
        ruleId: rule.id,
      });
      continue;
    }
    if (answer?.value === 'other') {
      ctx.review(`${what}: ${answer.text || 'סיבה אחרת'}. דורש בדיקה ידנית.`, rule);
      continue;
    }
    if (answer && answer.value !== 'replaced') continue;
    if (diff <= 0) continue;

    // לפעמים ההשלמה נרשמת על סבב סמוך ולא על המחליף עצמו (10/06/2026: LTN 11–12 → OTP 11,
    // ה-Rig 05:10 נרשם על OTP של 10/06).
    const paidOn = match.exec ? findShortfallPaid(ctx, match, diff, column, reportColumn) : null;
    const where = paidOn && paidOn !== match.exec ? `, ונרשם על ${describePairing(paidOn)}` : '';
    ctx.expectPairing(paidOn ?? match.exec ?? match.plan, column, diff, rule,
      `המתוכנן (${describePairing(match.plan)}) גבוה מהמבוצע. ההפרש לפי "הגבוה מבין השתיים"${where}.`);
  }
}

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

/** השעות שהפסיד (מטוס חכור, חניך, 787 שהוחלף ב-777), לפי התשובה `answer_value`. כולל השלמה לסליפ קצר. */
function lost_hours_credit(ctx, params, rule) {
  for (const match of ctx.matches) {
    if (!match.plan) continue;
    const answer = ctx.answerFor(match);
    if (answer?.value !== params.answer_value) continue;
    if (!lostHoursApplies(ctx, match.plan, params)) {
      ctx.review(`${describePairing(match.plan)}: התשובה "${params.answer_label}" אינה מתאימה לצי או לסוג המטוס בתכנון. דורש בדיקה ידנית.`, rule);
      continue;
    }

    const lost = lostHours(ctx, match.plan, params);
    if (lost == null) { ctx.review(`${describePairing(match.plan)}: אין שעות מתוכננות בקובץ, לא ניתן לחשב את השעות שהפסיד.`, rule); continue; }
    const key = params.credit_column === 'Rig' ? 'rig' : 'credit';
    const note = `${describePairing(match.plan)}: ${params.answer_label}. השעות שהפסיד` +
      (match.exec ? `, בנוסף לקרדיט של ${describePairing(match.exec)}.` : '.');
    if (match.exec) ctx.expectPairing(match.exec, key, lost, rule, note);
    else ctx.expect(match.plan.from, key, lost, rule, note);
    ctx.markPairing(match.plan, 'lost_hours_credit');
  }
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

/** השעות שהפסיד על סבב מתוכנן: הקרדיט המתוכנן, כולל השלמה לסליפ קצר. */
function lostHours(ctx, planPairing, params) {
  const planned = ctx.plannedCredit(planPairing);
  if (planned == null) return null;
  const min = params.include_min_slip_credit ? ctx.minSlipMinutes() : null;
  return min && planned < min ? min : planned;
}

/** תשובות "השעות שהפסיד" לפי החוקים שבתוקף בחודש (מטוס חכור, הורדה בגלל חניך). */
function lostHoursOptions(ctx, planPairing, extra) {
  return ctx.rulesWithLogic('lost_hours_credit').filter((r) => lostHoursApplies(ctx, planPairing, r.logic.params ?? {})).map((r) => {
    const p = r.logic.params ?? {};
    const lost = lostHours(ctx, planPairing, p);
    const amount = lost == null ? 'השעות שהפסיד' : `השעות שהפסיד (${minToHhmm(lost)})`;
    return { value: p.answer_value, label: p.answer_label, hint: `${amount} ב-${p.credit_column ?? 'Credit'}${extra ? `, ${extra}` : ''}` };
  });
}

/** החלפה מרצון: רק הקרדיט של הטיסה שבוצעה. אין קריאה מיוחדת ואין "הגבוה". */
function voluntary_swap(ctx, params, rule) {
  for (const match of ctx.matches) {
    const answer = ctx.answerFor(match);
    if (answer?.value !== 'voluntary_swap') continue;
    const target = match.exec ?? match.plan;
    ctx.markPairing(target, 'voluntary_swap');
    ctx.note((match.plan ?? match.exec).from, answer.link === 'none'
      ? `${describePairing(match.plan)}: הטיסה נמסרה ללא חלופה. אין עליה קרדיט ואין פיצוי.`
      : 'החלפה מרצון: רק הקרדיט של הטיסה שבוצעה, כולל השלמה לסליפ קצר. אין פיצוי נוסף.', rule);
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
          ...lostHoursOptions(ctx, match.plan),
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
      const answer = ctx.answer(id);
      const range = run.length === 1 ? dayOf(run[0]) : `${dayOf(run[0])}–${dayOf(run.at(-1))}`;
      if (!answer) {
        ctx.markPairing(pairing, 'standby_bid_pending');
        ctx.ask({
          id,
          date: pairing.from,
          title: `טיסה ביומיים האחרונים של כוננות: ${describePairing(pairing)}`,
          body: `בתכנון כוננות ב-${range}, והטיסה יצאה ב-${dayOf(pairing.from)}. ` +
            (run.at(-1) === monthEnd ? 'הכוננות מגיעה לסוף החודש, וייתכן שהיא נמשכת בחודש הבא. ' : '') +
            'אם החברה אישרה לך לסיים את הכוננות בגלל זכייה במכרז, מגיעה קריאה מיוחדת על ימי הטיסה. אם הכוננות הופעלה, מגיע רק קרדיט הטיסה. מה קרה?',
          options: [
            { value: 'standby_bid', label: 'סיום כוננות בגלל זכייה במכרז', hint: bidHint(pairing, ctx, sc) },
            { value: 'standby_activated', label: 'הפעלת הכוננות', hint: 'קרדיט הטיסה, בלי קריאה מיוחדת' },
            { value: 'other', label: 'סיבה אחרת', needsText: true },
          ],
          ruleId: rule.id,
        });
        continue;
      }
      if (answer.value === 'standby_bid') {
        ctx.markPairing(pairing, 'standby_bid');
        ctx.note(pairing.from, `${describePairing(pairing)}: סיום כוננות (${range}) בגלל זכייה במכרז. קרדיט הטיסה וקריאה מיוחדת על ימי הטיסה.`, rule);
      } else if (answer.value === 'standby_activated') {
        // הקרדיט על ימי ההפעלה נבדק בחוק ההפעלה מכוננות.
        ctx.markPairing(pairing, 'standby_activated');
      } else {
        ctx.markPairing(pairing, 'standby_bid_pending');
        ctx.review(`${describePairing(pairing)}, ביומיים האחרונים של הכוננות (${range}): ${answer.text || 'סיבה אחרת'}. דורש בדיקה ידנית.`, rule);
      }
    }
  }
}

/** רצפי כוננות בתכנון: ימים עוקבים עם קוד כוננות (`plan_codes` / `plan_code_prefixes`). */
function standbyRuns(ctx, params) {
  const runs = [];
  for (const day of ctx.timeline) {
    if (!(day.plan?.codes ?? []).some((c) => codeIn(c, params.plan_codes, params.plan_code_prefixes))) continue;
    const run = runs.at(-1);
    if (run && run.at(-1) === addDays(day.date, -1)) run.push(day.date);
    else runs.push([day.date]);
  }
  return runs;
}

/**
 * הפעלה מכוננות. טיסה שיוצאת ביום כוננות בתכנון היא הפעלה של הכוננות, ולא קריאה מיוחדת (ישן כ"ה
 * ס' 12.ב: קריאה מיוחדת היא ביממה שבה לא היה משובץ לטיסה או לכוננות), ולא שואלים עליה. היומיים
 * האחרונים של הרצף הם של חוק סיום הכוננות למכרז, ומגיעים לכאן רק אחרי התשובה "הפעלת הכוננות".
 *
 * - הקרדיט על ימי הכוננות שבהם טס: הגבוה מבין קרדיט הטיסה לבין ערך ימי הכוננות האלה (2018 ס' 98.1–98.3,
 *   98.5). ערך יום הכוננות לפי חוק זיכוי היום של הקוד (הקוד בדוח הוא 5 התווים הראשונים של הקוד בתכנון).
 *   כשקוד הכוננות רשום גם בדוח ביום הטיסה, חוק זיכוי היום כבר בודק את זה.
 * - החזרה אחרי סוף הכוננות: החברה רשאית להפעיל רק כשהחזרה מתוכננת בתוך הכוננות (2018 ס' 88). בדיקה ידנית.
 * - טיסה מתוכננת ביום כוננות, שלא במסגרת הכוננות: מגיעים גם קרדיט הטיסה וגם זיכוי הכוננות (ישן כ"ה
 *   ס' 11.י). הדוח עוד לא הראה איך זה נרשם, ולכן בדיקה ידנית.
 */
function standby_activation(ctx, params, rule) {
  if (!ctx.hasPlan || !ctx.hasExec) return;
  const pending = ['standby_bid', 'standby_bid_pending'];
  for (const run of standbyRuns(ctx, params)) {
    const range = run.length === 1 ? dayOf(run[0]) : `${dayOf(run[0])}–${dayOf(run.at(-1))}`;
    const planCode = ctx.timeline.find((d) => d.date === run[0]).plan.codes.find((c) => codeIn(c, params.plan_codes, params.plan_code_prefixes));
    const value = standbyDayRule(ctx, planCode);

    for (const date of run) {
      const day = ctx.timeline.find((d) => d.date === date);
      if (day.plan?.legs?.length) {
        ctx.review(`${dayOf(date)}: בתכנון גם כוננות (${planCode}) וגם טיסה. על טיסה שלא במסגרת הכוננות מגיעים גם קרדיט הטיסה ` +
          `וגם זיכוי הכוננות${value ? ` (${minToHhmm(value.min)})` : ''} (ישן כ"ה ס' 11.י). דורש בדיקה ידנית.`, rule);
      }
    }

    for (const match of ctx.matches) {
      if (match.how !== 'unplanned' || !run.includes(match.exec.from)) continue;
      const pairing = match.exec;
      if (pending.some((t) => ctx.pairingHandledBy(pairing, t))) continue;
      ctx.markPairing(pairing, 'standby_activated');
      const flown = run.filter((d) => pairing.from <= d && d <= pairing.to);
      const beyond = pairing.to > run.at(-1);
      ctx.note(pairing.from, `${describePairing(pairing)}: הפעלה מהכוננות (${range}). קרדיט הטיסה, בלי קריאה מיוחדת.`, rule);
      if (beyond) {
        ctx.review(`${describePairing(pairing)}: הופעלת מהכוננות (${range}), והחזרה אחרי סוף הכוננות. החברה רשאית להפעיל ` +
          'כונן רק כשהחזרה מתוכננת להסתיים בתוך הכוננות (2018 ס\' 88). דורש בדיקה ידנית.', rule);
      }

      // הכוננות רשומה בדוח בימי הטיסה: חוק זיכוי היום כבר משווה בין הטיסה לכוננות.
      if (value && flown.some((d) => ctx.execCodes(ctx.timeline.find((x) => x.date === d)).some((c) => codeIn(c, value.rule.logic.params.report_codes, value.rule.logic.params.report_code_prefixes)))) continue;
      const credit = sumLegs(pairing);
      const what = `${flown.length === 1 ? 'יום הכוננות שבו' : `${flown.length} ימי הכוננות שבהם`} טסת (${flown.map(dayOf).join(', ')})`;
      if (!value) {
        ctx.review(`${describePairing(pairing)}: על ${what} מגיע הגבוה מבין קרדיט הטיסה לבין ערך ימי הכוננות (2018 ס' 98). ` +
          `אין חוק שקובע את ערך הכוננות לקוד ${planCode}. דורש בדיקה ידנית.`, rule);
      } else if (credit == null || credit < value.min * flown.length) {
        ctx.review(`${describePairing(pairing)}: על ${what} מגיע הגבוה מבין קרדיט הטיסה (${credit == null ? 'לא ידוע' : minToHhmm(credit)}) ` +
          `לבין ${flown.length} × ${minToHhmm(value.min)} (${value.rule.title}; 2018 ס' 98). הכוננות גבוהה יותר, ועוד לא ראינו איך זה נרשם בדוח. דורש בדיקה ידנית.`, rule);
      } else {
        ctx.note(pairing.from, `${describePairing(pairing)}: קרדיט הטיסה (${minToHhmm(credit)}) גבוה מערך ${what} (${flown.length} × ${minToHhmm(value.min)}), ולכן אין תוספת (2018 ס' 98).`, rule);
      }
    }
  }
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
  const stay = awayFromBase(pairing, ctx.domicile, ctx.timeline.at(-1).date);
  if (stay.error) return `קריאה מיוחדת על ימי הטיסה, ב-${p.report_column ?? 'S/C'}`;
  const n = countSpecialCallDays(stay, p).counted.length;
  return `קריאה מיוחדת: ${n === 1 ? 'יממה אחת' : `${n} יממות`}, ${minToHhmm(n * H(p.hours))} ב-${p.report_column ?? 'S/C'}`;
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
  standby_end_for_bid,
  standby_activation,
  unexplained_report_amount,
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
  absence_day_credit: ['plan_codes', 'report_codes', 'plan_code_prefixes', 'report_code_prefixes', 'report_flag_column', 'credit_hours', 'tab_hours', 'requires_assigned_activity', 'flight_day_takes_higher', 'away_flag_on_pairing_start', 'confirm_code_prefixes', 'confirm_label', 'confirm_answer'],
  vacation_credit_balance: ['per_day_hours', 'days_full_rate', 'monthly_max_hours', 'yearly_cap_days', 'taper_table', 'taper_table_complete', 'taper_monthly_totals'],
  absence_month_cap: ['cap_hours'],
  late_landing_home: ['grace_minutes', 'step_minutes', 'hours_per_step'],
  long_flight_day: ['over_flight_hours', 'hours'],
  special_call: ['hours', 'report_column', 'second_day_min_gap_hours', 'second_day_min_hours', 'ask_user_if_no_sc'],
  higher_of_planned_performed: ['requires_user_answer', 'excluded_when_special_call', 'excluded_when_voluntary_swap', 'shortfall_column'],
  lost_hours_credit: ['requires_user_answer', 'credit_column', 'include_min_slip_credit', 'answer_value', 'answer_label', 'fleets', 'plan_aircraft'],
  voluntary_swap: ['requires_user_answer'],
  cancelled_no_compensation: ['requires_user_answer'],
  vacation_recall: ['plan_codes', 'plan_code_prefixes', 'report_codes', 'report_code_prefixes', 'hours', 'report_column'],
  training_cancelled_flight: ['plan_codes', 'plan_code_prefixes', 'moved_ok_prefixes'],
  dh_activated: ['hours', 'report_column', 'report_dh_types'],
  standby_end_for_bid: ['requires_user_answer', 'plan_codes', 'plan_code_prefixes', 'last_days'],
  standby_activation: ['plan_codes', 'plan_code_prefixes'],
  unexplained_report_amount: ['hours', 'report_column', 'hint'],
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
  'free_days_waived',
  'consecutive_saturdays',
  'consecutive_night_rounds',
  'sim_night_session',
  'sim_extension',
  'sim_friday_holiday_eve',
  'covered_by',
  // אחרון מבין חוקי הפיצוי: מה שנשאר בדוח בלי הסבר.
  'unexplained_report_amount',
  'absence_month_cap',
];
