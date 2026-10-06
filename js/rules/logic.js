// מימוש הלוגיקות של החוקים.
//
// כל פונקציה מקבלת (ctx, params, rule) ורושמת ציפיות וממצאים ל-ctx.
// הערכים המספריים מגיעים כולם מ-`params` של החוק ב-`rules.json`, ולא מהקוד.
// מזהה לוגיקה שאינו מופיע כאן נחשב "לא נתמך" ומוצג למשתמש.

import { hoursToMin, minToHhmm } from '../time.js';
import { describePairing, describeRoute, fdpParts } from '../model.js';
import { stationOffset } from '../airports.js';
import { DUTY_LOGIC, DUTY_PARAMS, execFdpGroups, amountWord, otherOption, applyOtherReason, extensionDays } from './duty.js';
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
      ctx.note(pairing.from, `חזרה לבסיס אחרי היציאה: קרדיט לפי זמן הטיסה בפועל${top ? ' והשלמה לסליפ קצר' : ''}.`, rule);
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
      const dur = legCreditDur(leg, pairing, ctx.domicile);
      const basis = isAirReturn(leg)
        ? `${leg.flight} חזרה ל-${leg.org} אחרי היציאה: קרדיט לפי זמן הביצוע בפועל, ${minToHhmm(dur)}`
        : dur !== leg.skdDur
          ? `${leg.flight}: לג שאינו נוגע בבסיס, קרדיט לפי הביצוע ${minToHhmm(dur)} ולא ${minToHhmm(leg.skdDur)} מתוכננות`
          : null;
      const note = (msg) => [basis, msg].filter(Boolean).join('. ');
      const split = splitAtMidnight(leg, ctx.domicile);
      if (leg.prevMonth) {
        // הרגל רשומה ביום 1 אבל יצאה ביום האחרון של החודש הקודם.
        if (split.error) { error = split.error; break; }
        const prev = split.before ?? dur; // נחתה לפני חצות: כולה זוכתה בחודש הקודם
        add(leg.date, dur - prev, note(`${leg.flight} יצאה בחודש הקודם, ושם זוכו ${minToHhmm(prev)}. בחודש הזה ${minToHhmm(dur - prev)} מתוך ${minToHhmm(dur)}`));
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
        continue;
      }
      add(date, split.before, note(`${leg.flight} חוצה חצות: ${minToHhmm(split.before)} מההמראה בפועל עד חצות`));
      add(next, dur - split.before, note(`${leg.flight}: ${minToHhmm(dur - split.before)} אחרי חצות (${minToHhmm(dur)} − ${minToHhmm(split.before)})`));
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
 * קרדיט רגל, לצורך `credit_from_scheduled`: SkdDur, חוץ מרגל בסבב עם יותר מיעד אחד (לא
 * חזרה תוך-אזורית ליעד היחיד, כמו PFO-LCA ב-20/06/2025 בדרך חזרה מ-LCA) שלא יוצאת מהבסיס
 * ולא חוזרת אליו – שם לוקחים את הביצוע (ActDur) כשהוא קיים בדוח.
 */
const legCreditDur = (leg, pairing, domicile) =>
  (isAirReturn(leg) || (pairing.destinations.length > 1 && leg.org !== domicile && leg.dst !== domicile) ? leg.actDur : null) ?? leg.skdDur;


/**
 * חזרה לשדה המוצא אחרי ההמראה: מזוכה לפי זמן הביצוע בפועל (בעל המוצר, 28/09/2026). בדוח ה-SkdDur
 * שלה שווה ל-ActDur (LY571 ב-15/09/2025 ‏00:25, ‏LY321 ב-31/03/2025, ‏LY2367 ב-15/02/2026).
 */
const isAirReturn = (leg) => leg.org != null && leg.org === leg.dst;

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
 * החודש לא נבדק: ההשלמה נקבעת על הסליפ כולו (28/02/2026: BUD 03:35 בלי Rig).
 */
function min_slip_credit(ctx, params, rule) {
  const min = H(params.min_credit_hours);
  for (const group of minSlipGroups(ctx, params)) expectMinSlip(ctx, group, min, params, rule);
}

/** הקבוצות שההשלמה נבדקת עליהן: FDP שלם, או כל סבב בנפרד כשחלק מה-FDP אינו נבדק. */
function minSlipGroups(ctx, params) {
  const groups = params.per_fdp
    ? execFdpGroups(ctx.execPairings, ctx.domicile, H(params.legal_rest_hours), params.report_minutes_before_std ?? 0, ctx.legalRest?.postMin)
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
  }
  // `note_code_upgrade`: החוק שקוד התכנון שלו יכול לעבור בביצוע לקוד של חוק אחר (SBY_L → SBY_S).
  if (params.confirm_code_prefixes?.length || params.note_code_upgrade) noteUpgrade(ctx, params, rule, credit);
  const onFlightDay = new Set();
  for (const day of ctx.timeline) {
    if (!matchesCode(day, params, ctx)) continue;
    if (params.flight_day_takes_higher) {
      const pairing = ctx.execPairings.find((p) => p.dates.includes(day.date));
      if (pairing) {
        if (onFlightDay.has(pairing)) continue;
        onFlightDay.add(pairing);
        const days = ctx.timeline.filter((d) => pairing.dates.includes(d.date) && matchesCode(d, params, ctx)).length;
        const flown = sumLegs(pairing, ctx.domicile);
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
      // הדוח כבר מזכה על היום: היית מוצב, ואין פער שמצדיק שאלה (החלטת בעל המוצר, 23/09/2026).
      const assigned = ctx.wasAssigned(day.date) ?? (ctx.paidOnDate(day.date, 'Credit', 'absence', credit) || null);
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
      ctx.review(`קוד ${c.code} (${days}): ${answer.text || 'לא ' + params.confirm_label}. דורש בדיקה ידנית.`, rule);
    } else {
      ctx.explainCode(c.code, c.dates, `${params.confirm_label} – ${value} ליום (${rule.title})`);
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
    if (leg.dst !== ctx.domicile || leg.sta == null || leg.ata == null) continue;
    let delay = wrapDelta(leg.ata - leg.sta);
    let diverted = '';
    const div = diversionOf(flat, i, ctx.domicile);
    if (div) {
      const divDelay = wrapDelta(leg.ata - div.sta);
      const divMin = stepsOf(divDelay) * perStep;
      if (divMin > stepsOf(delay) * perStep) {
        const id = `diversion:${date}:${leg.flight}`;
        // שמות השדות מבודדים: בלי זה "RHO (14:30). 6" מוצג כקטע לועזי אחד.
        const via = div.via.map((s) => `⁦${s}⁩`).join(' ו-');
        const answer = ctx.answer(id)?.value;
        if (answer === 'yes' || (!answer && ctx.paidOnDate(date, 'COM', 'com', divMin))) {
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
      if (delay >= noteFrom) ctx.note(date, `${leg.flight} נחתה באיחור של ${delayText(delay)}, לא מעבר לסף של ${grace} דק'. אין פיצוי.`, rule);
      continue;
    }
    const steps = Math.ceil((delay - grace) / step);
    const stepsWord = steps === 1 ? 'מדרגה אחת' : `${steps} מדרגות`;
    // ההסבר מוצג מתחת לטיסה בטבלת הפירוט, ולא בהערות (בעל המוצר, 01/10/2026). מספר הטיסה
    // נכתב רק כשהיא אינה לבדה בשורה: הפיצוי נרשם לכל FDP, ושורה של רגל אחת כבר נושאת אותו.
    const part = ctx.execPairings.flatMap((p) => fdpParts(p, ctx.fdp)).find((x) => x.legs.some((l) => l.flight === leg.flight && l.date === date));
    const who = part?.legs.length === 1 ? '' : `${leg.flight} `;
    // `flight`: לאיזה סבב שייך הפיצוי, כשהיום משותף לשני סבבים (טבלת הפירוט).
    ctx.expect(date, 'com', steps * perStep, rule, `${leg.flight}: איחור ${delay} דק' → ${steps} מדרגות`, { flight: leg.flight,
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
function diversionOf(flat, i, domicile) {
  const leg = flat[i].leg;
  if (!leg.flight) return null;
  let j = i;
  while (j > 0 && flat[j - 1].leg.flight === leg.flight && flat[j - 1].leg.dst === flat[j].leg.org) j--;
  if (j === i) return null;
  const first = flat[j].leg, next = flat[j + 1].leg;
  if (first.org === domicile || first.std == null || first.skdDur == null || first.ata == null || next.std == null) return null;
  if (wrapDelta(next.std - first.ata) <= 0) return null;
  const off = stationOffset(first.org, flat[j].date, domicile);
  if (off == null) return null;
  return { sta: mod(first.std - off + first.skdDur, 1440), via: flat.slice(j, i).map((x) => x.leg.dst) };
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
      ctx.expect(date, 'com', H(params.hours), rule, `${describePairing(pairing)}: זמן טיסה ${minToHhmm(flown)} ביום`,
        { explain: `זמן טיסה ${minToHhmm(flown)}.` });
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
    // סתירה עם סבב מתוכנן שנפתרה נגד הטיסה הזאת (`resolveLinkConflict`).
    if (ctx.pairingHandledBy(match.exec, 'swap_conflict_void')) continue;
    const reported = ctx.reportedOn(match.exec, column);
    const answer = ctx.answerFor(match);
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
    if (match.plan && !cancelledPlan && !training && !bid && extendedPairing(ctx, params, rule, match, answer)) continue;
    if (reported > 0 || answer?.value === 'special_call' || companyLinked || training || bid || cancelledPlan) {
      ctx.markPairing(match.exec, 'special_call');
      const stay = awayFromBase(match.exec, ctx.domicile, ctx.timeline.at(-1).date);
      if (stay.error) {
        ctx.review(`${describePairing(match.exec)}: ${stay.error} לא ניתן לספור יממות לקריאה המיוחדת. דורש בדיקה ידנית.`, rule);
        continue;
      }
      const days = countSpecialCallDays(stay, params, match.exec, ctx.fdp);
      // כל יממה שמגיעה עליה קריאה מיוחדת היא שורה משלה בטבלת הפירוט (`perDay`), בלי הסבר: הסכום
      // והחוק כבר בשורה (בעל המוצר, 01/10/2026). רק יממה שנספרה אחרי בדיקת הסף מוסברת בשורה שלה
      // (`lastWhy`). יממה שלא עמדה בסף אין לה שורה, ולכן ההסבר עליה בהערות, ביום שלה (`skipped`;
      // 20–21/07/2025: S/C רק על 20/07). `aside`: ההערה נשארת בהערות ואינה עוברת לשורת השינוי.
      // בכמה FDP נפרדים כל יממה נרשמת על ה-FDP שהתחיל בה או לפניה (בעל המוצר, 29/09/2026).
      const parts = fdpParts(match.exec, ctx.fdp);
      const partOf = (d) => parts.findLast((p) => p.from <= d) ?? parts[0];
      if (days.skipped) ctx.note(days.skipped.date, `${flightsOf(match.exec)}: ${days.skipped.why}`, rule, { aside: true });
      if (days.cut) ctx.note(match.exec.from, `${flightsOf(match.exec)}: ${days.cut}`, rule, { aside: true });
      for (const d of days.counted) {
        ctx.expectPairing(match.exec, 'sc', H(params.hours), rule, `${flightsOf(partOf(d))}: יממה ${dayOf(d)}.`,
          { date: d, dates: [d], perDay: true, explain: days.lastWhy && d === days.counted.at(-1) ? days.lastWhy : '' });
      }
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
        body: 'הרומה לא מזכה קריאה מיוחדת, ולכן לא ניתן לדעת אם היא מגיעה. מה קרה?',
        // הוספת טיסה בהסכמה: רק הקרדיט של הטיסה, בלי קריאה מיוחדת (בעל המוצר, 06/10/2026).
        options: [
          { value: 'special_call', label: 'קריאה מיוחדת' },
          { value: 'added', label: 'הוספת טיסה בהסכמה' },
          { value: 'voluntary_swap', label: 'החלפה מרצוני', needsLink: true },
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
 * בשניהם רק אם ההארכה לא הייתה בהסכמה. מעל `over_hours` זו הארכת שהייה (`stay_extension`), שאינה מגיעה
 * לכאן. הסיבה אינה בקבצים, ולכן נשאלת כשהרומה לא זיכתה. סבב שהוחלף באותם ימים (`dates`) – רק אחרי
 * התשובה עליו, וגם אז בנוסף לגבוה מבין השתיים. מחזירה true כשהסבב טופל כאן.
 */
function extendedPairing(ctx, params, rule, match, answer) {
  const ext = extensionDays(ctx, match);
  if (!ext) return false;
  const { plan, exec } = match;
  if (match.how === 'exact') ctx.markPairing(exec, 'extended');
  if (['voluntary_swap', 'added'].includes(answer?.value)) return false;
  if (match.how === 'dates' && !answer) return false;
  const days = ext.free;
  if (!days.length && !ext.second.length) return false;
  const id = `extended:${exec.id}`;
  const second = ctx.rulesWithLogic('second_unplanned_activity')[0]?.logic.params;
  const paid = (!days.length || ctx.paidOn(exec, params.report_column ?? 'S/C', 'sc', days.length * H(params.hours))) &&
    (!ext.second.length || ctx.paidOn(exec, second.report_column ?? 'COM', 'com', ext.second.length * H(second.hours)));
  const a = ctx.answer(id) ?? (paid ? { value: 'company' } : null);
  const list = ext.days.map(dayOf).join(', ');
  if (!a) {
    const due = [days.length ? 'קריאה מיוחדת' : null, ext.second.length ? 'פיצוי על פעילות שנייה באותה יממה' : null].filter(Boolean);
    ctx.ask({
      id,
      date: exec.from,
      title: `סבב שהתארך: ${describePairing(exec)}`,
      body: `הסבב תוכנן ${describePairing(plan)}, והתארך ל-${list}. הרומה לא מזכה ${due.join(' ו')}, ` +
        `${due.length > 1 ? 'והם מגיעים' : days.length ? 'והיא מגיעה' : 'והוא מגיע'} רק כשההארכה לא הייתה בהסכמתך. מה קרה?`,
      options: [
        { value: 'company', label: 'הסבב הוארך ביוזמת החברה' },
        { value: 'agreed', label: 'הסבב הוארך בהסכמתי' },
      ],
      ruleId: rule.id,
    });
    return true;
  }
  if (a.value === 'agreed') {
    ctx.note(ext.days[0], `הסבב התארך: בהסכמתך, ולכן אין פיצוי על ההארכה ל-${list}.`, rule, { pairingId: exec.id });
    return true;
  }
  for (const d of days) {
    ctx.expectPairing(exec, 'sc', H(params.hours), rule, `${flightsOf(exec)}: יממה ${dayOf(d)}.`,
      { date: d, dates: [d], perDay: true, explain: 'הסבב התארך ליום שלא תוכנן בו כלום.' });
  }
  return true;
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
 * `second_day_min_gap_hours`, ולפחות `second_day_min_hours` ממנה ביממה האחרונה (12.יא) –
 * ורק כשהיממה האחרונה היא המשך של אותו FDP שחוצה חצות. כשהיממה האחרונה פותחת FDP משלה
 * (מנוחה אמיתית לפני, לא רק חיבור בין רגליים) זו יממת עבודה נפרדת לפי 12.ג, ונספרת בלי
 * בדיקת הסף: 19–20/06/2025, TLV-LCA ב-19 ואחרי מנוחה PFO-LCA-TLV שיוצאת כולה ב-20.
 */
function countSpecialCallDays(stay, params, pairing, fdp) {
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
  const total = stay.end - stay.start;
  const inLast = stay.end - lastDay * 1440;
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
 * שלא תוכננה. טיסה שאינה בקבצים של החודש עוברת לבדיקה ידנית, כי אי אפשר לחשב את ההפרש.
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

    // תשובה ישנה נשמרה בלי קישור, ואז ההחלפה היא הסבב שבוצע באותם ימים.
    const exec = answer && 'link' in answer ? (answer.link ? ctx.pairingById(answer.link) : null) : match.exec;
    if (!exec) {
      ctx.review(`${describePairing(match.plan)}: ${swapWord(answer)} בטיסה שאינה בקבצים של החודש, ` +
        'ולכן לא ניתן לחשב את ההפרש. דורש בדיקה ידנית.', rule);
      continue;
    }
    // שינוי ביוזמת החברה או זכייה במכרז לטיסה ביום שלא תוכנן בו כלום (`companySwapToFreeDay`), וזכייה
    // במכרז ביומן שהוחלפה בטיסה כזאת (`alsoSpecialCall`, `applyRootChain` ב-js/rules/evaluate.js): גם קריאה
    // מיוחדת וגם הגבוה מבין השתיים (בעל המוצר, 06/10/2026).
    const execMatch = ctx.matches.find((x) => x.exec === exec);
    const alsoSc = !!answer?.alsoSpecialCall || (['replaced', 'bid'].includes(answer?.value) && execMatch?.how === 'unplanned');
    if (params.excluded_when_special_call && !alsoSc && ctx.pairingHandledBy(exec, 'special_call')) continue;

    // בשרשרת מהיומן: הגבוה מבין הסבבים שלא בוצעו (`reduceChain`; בעל המוצר, 06/10/2026).
    const planned0 = answer?.basis ?? match.plan;
    const diff = plannedMinusPerformed(ctx, planned0, exec);
    if (diff == null) continue;

    // "הגבוה מבין השתיים" הוא סך הכול, לא תוספת על ההשלמה למינימום שהסבב שבוצע מקבל בזכות
    // עצמו: כשהמתוכנן גבוה גם מהמינימום, הנוסף הוא רק ההפרש שמעבר להשלמה שכבר צפויה
    // (`min_slip_credit` רץ קודם); כשההשלמה למינימום כבר גבוהה מההפרש, אין תוספת נוספת
    // (יוני 2025: ZRH מתוכנן מול LCA שבוצע, בעל המוצר 24/09/2026).
    const alreadyMinSlip = diff > 0 && column === 'rig' ? minSlipTopUp(ctx, exec) : 0;
    const extra = diff - alreadyMinSlip;

    // הערה בכל החלפה ביוזמת החברה, גם כשהטיסה שבוצעה ארוכה יותר ואין הפרש (בעל המוצר, 29/09/2026).
    const planned = ctx.plannedCredit(planned0);
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
    const sc = alsoSc ? ' וקריאה מיוחדת על הטיסה שבוצעה' : '';
    // `pairingId`: רק בשורה של הסבב, ולא מתחת לטיסה אחרת שבוצעה באותם ימים.
    ctx.note(match.plan.from, `${swapWord(answer)}: קרדיט של הטיסה הארוכה מבין השתיים${which}${sc}.`, rule, { pairingId: match.plan.id });
    // ביום של הטיסה שבוצעה, כשהוא אחר.
    if (exec.from !== match.plan.from) ctx.note(exec.from, `${swapWord(answer)}: קרדיט על הטיסה שבוצעה${sc ? ' וקריאה מיוחדת' : ''}.`, rule, { pairingId: exec.id });
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
    if (!lostHoursApplies(ctx, match.plan, params)) {
      ctx.review(`${describePairing(match.plan)}: התשובה "${params.answer_label}" אינה מתאימה לצי או לסוג המטוס בתכנון. דורש בדיקה ידנית.`, rule);
      continue;
    }

    // בשרשרת מהיומן: השעות של הגבוה מבין הסבבים, ביום של הסבב שממנו הורד (`reduceChain`; בעל המוצר, 06/10/2026).
    const from = answer?.basis ?? match.plan;
    const removed = answer?.lostOn ?? match.plan;
    const lost = lostHours(ctx, from, params);
    if (lost == null) { ctx.review(`${describePairing(from)}: אין שעות מתוכננות, לא ניתן לחשב את השעות שהפסיד.`, rule); continue; }
    const key = params.credit_column === 'Rig' ? 'rig' : 'credit';
    const why = assumed
      ? `הרומה מזכה את השעות שהפסיד, והסיבה אינה בקבצים (${assumed.labels})`
      : params.answer_label;
    const note = `${describePairing(removed)}: ${why}. השעות שהפסיד` +
      (match.exec ? `, בנוסף לקרדיט של ${describePairing(match.exec)}.` : '.');
    // ההסבר בשורת הפירוט קצר (בעל המוצר, 01/10/2026). כשהרומה זיכתה בלי שנשאלה שאלה: "…האפליקציה מניחה:"
    // ושם החוק, שאינו כתוב עוד בתגית (04/10/2026); כשכמה חוקים מתאימים, כולם בשמם.
    // אחרי תשובה: בלי הסבר, ועל טיסה שבוצעה במקום – של איזו טיסה השעות.
    const explain = assumed
      ? `הרומה מזכה את השעות והסיבה אינה בקבצים. האפליקציה מניחה${assumed.titles.length > 1 ? ` אחת מאלה: ${assumed.titles.join(' או ')}` : `: ${assumed.titles[0]}`}.`
      : match.exec ? `השעות של ${describePairing(from)}.` : from !== removed ? `השעות של ${describePairing(from)}.` : '';
    if (match.exec) ctx.expectPairing(match.exec, key, lost, rule, note, { explain });
    // בלי טיסה שבוצעה, שורת הפירוט מציגה את הטיסה שתוכננה (בעל המוצר, 29/09/2026).
    // `chainFor`: ביום של שלב אחר בשרשרת, אבל שייך לשינוי של הסבב המתוכנן (`explainChanges`).
    else ctx.expect(assumed?.date ?? removed.from, key, lost, rule, note, { plannedRoute: describeRoute(removed), explain,
      ...(removed !== match.plan && { chainFor: match.plan.id }) });
    ctx.markPairing(match.plan, 'lost_hours_credit');
    for (const v of assumed?.values ?? []) ctx.assumeAnswer(match.plan, v);
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

/**
 * תשובות "השעות שהפסיד" לפי החוקים שבתוקף בחודש (מטוס חכור, הורדה בגלל חניך). הרמז מנוסח
 * על הטיסה המקורית, ו-`extra` מוסיף את הקרדיט על הטיסה שבוצעה כשיש כזאת (בקשת בעל המוצר,
 * 23/09/2026).
 */
function lostHoursOptions(ctx, planPairing, extra) {
  return ctx.rulesWithLogic('lost_hours_credit').filter((r) => lostHoursApplies(ctx, planPairing, r.logic.params ?? {})).map((r) => {
    const p = r.logic.params ?? {};
    const lost = lostHours(ctx, planPairing, p);
    const word = amountWord(p.credit_column ?? 'Credit');
    const amount = lost == null ? `מגיע ${word}` : `מגיע ${word} של ${minToHhmm(lost)}`;
    return { value: p.answer_value, label: p.answer_label, hint: extra ? `${amount} על הטיסה המקורית ${extra}` : amount };
  });
}

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
      ctx.note(date, 'החלפה מרצון: הטיסה נמסרה ללא חלופה, ולא מגיע עליה קרדיט.', rule, { pairingId: match.plan.id });
      continue;
    }
    if (!match.exec) {
      // `pairingId`: ההערה של הסבב המתוכנן, ולא של טיסה אחרת שבוצעה באותם ימים (`splitSwappedElsewhere`).
      ctx.note(date, `החלפה מרצון: לא מגיע קרדיט על ${match.plan.dates.length > 1 ? 'הימים האלה' : 'היום הזה'}.`, rule, { pairingId: match.plan.id });
      continue;
    }
    const slip = minSlipTopUp(ctx, match.exec) ? ', כולל השלמה לסליפ קצר' : '';
    ctx.note(date, `החלפה מרצון: קרדיט על הטיסה שבוצעה${slip}.`, rule);
  }
}

/**
 * סבב מתוכנן שלא בוצע כמתוכנן. הסיבה אינה בקבצים והיא קובעת מה מגיע, ולכן נשאלת עליה שאלה
 * אחת: גם כשלא בוצע דבר באותם ימים, וגם כשבוצע בהם סבב אחר – טיסה אחרת באותם ימים אינה
 * מוכיחה החלפה (בקשת בעל המוצר, 24/09/2026). שש התשובות ומה שכל אחת גוררת:
 * שינוי ביוזמת החברה, זכייה במכרז וסטיה לשדה משנה – הגבוה מבין שתי הטיסות (`higher_of_planned_performed`);
 * החלפה מרצוני – רק הקרדיט של הטיסה שבוצעה (`voluntary_swap`);
 * המתוכננת בוטלה ללא קרדיט – ימיה נחשבים ימים ללא פעילות, ומה שבוצע בהם לא היה מתוכנן,
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
    const answer = ctx.answerFor(match);
    if (!answer) {
      if (assumeDiversion(ctx, match, rule)) continue;
      if (!assumeCancelled(ctx, match, rule)) askWhatHappened(ctx, match, rule);
      continue;
    }
    if (answer.value === 'cancelled') noteCancelled(ctx, match, rule, null);
    if (answer.value === 'diversion' && match.exec) noteDiversion(ctx, match, rule);
    if (answer.value === 'other' && !applyOtherReason(ctx, answer, rule, {
      what: match.exec ? 'סבב מתוכנן שבמקומו בוצע סבב אחר' : 'סבב מתוכנן שלא בוצע',
      date: match.plan.from, pairing: match.exec, extra: { plannedRoute: describeRoute(match.plan) },
    })) {
      ctx.review(`${describePairing(match.plan)}: ${answer.text || 'סיבה אחרת'}. דורש בדיקה ידנית.`, rule);
    }
  }
}

/**
 * ההנחה שחוק `assumeCancelled` היה עושה, בלי תופעות לוואי: אין תשובה, אבל הדוח כבר מזכה
 * את מה שמתאים (השעות שהפסיד על סבב שלא בוצע, או קריאה מיוחדת על סבב באותם ימים).
 */
function wouldAssumeCancelled(ctx, match) {
  if (!match.exec) return !!paidLostHours(ctx, match.plan);
  const sc = ctx.rulesWithLogic('special_call')[0]?.logic?.params?.report_column ?? 'S/C';
  return ctx.reportedOn(match.exec, sc) > 0;
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
    body: `יש שתי החלטות סותרות (תשובה, או הנחה מהרומה) על מה שקרה ב${planLabel}. מה נכון?`,
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
  if (value === 'voluntary_swap') return `${planLabel} הוחלפה מרצון עם ${execLabel}`;
  if (value === 'other') return ctx.answerFor(match)?.text || 'סיבה אחרת';
  const opt = whatHappenedOptions(ctx, planMatch.plan, planMatch.exec).find((o) => o.value === value);
  return opt ? opt.label : value;
}

/**
 * הדוח כבר זיכה, ולכן מניחים את התשובה המזכה ולא שואלים (החלטת בעל המוצר, 23/09/2026):
 * על סבב שלא בוצע – השעות שהפסיד, ש-`lost_hours_credit` רושם; על סבב שבמקומו בוצע סבב אחר –
 * קריאה מיוחדת על הסבב שבוצע, שפירושה שהמתוכנן בוטל. זיכוי של ההפרש בלבד אינו מספיק, כי הוא
 * מתאים גם להחלפה וגם לשעות שהפסיד, ולכן עליו שואלים (בקשת בעל המוצר, 24/09/2026).
 */
function assumeCancelled(ctx, match, rule) {
  if (!match.exec) return !!paidLostHours(ctx, match.plan);
  const sc = ctx.rulesWithLogic('special_call')[0]?.logic?.params?.report_column ?? 'S/C';
  if (!ctx.reportedOn(match.exec, sc)) return false;
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
  if (!match.exec || !isDiversion(match.plan, match.exec)) return false;
  noteDiversion(ctx, match, rule);
  // גם כשהרומה זיכתה קריאה מיוחדת: אותם מספרי טיסה הם אותה טיסה (`explainUnexplained`; בעל המוצר, 06/10/2026).
  ctx.markPairing(match.exec, 'diversion_assumed');
  ctx.assumeAnswer(match.plan, 'diversion');
  return true;
}

/** סטיה לשדה משנה, שהונחה או שנענתה: סימון לחוקים אחרים, והערה בשורת השינוי עם השדות. */
function noteDiversion(ctx, match, rule) {
  ctx.markPairing(match.plan, 'diversion');
  // הנחיתה המאוחרת כבר רשמה את הסטיה על הסבב שבוצע (`late_landing_home`).
  if (!ctx.pairingHandledBy(match.exec, 'diversion')) {
    const list = (ds) => ds.map((d) => `⁦${d}⁩`).join(' ו-');
    const extra = match.exec.destinations.filter((d) => !match.plan.destinations.includes(d));
    const missing = match.plan.destinations.filter((d) => !match.exec.destinations.includes(d));
    if (extra.length) {
      ctx.note(match.plan.from, `סטיה לשדה משנה: נחיתה ${missing.length ? `ב-${list(extra)} במקום ${list(missing)}` : `גם ב-${list(extra)}`}.`, rule);
    }
  }
  ctx.markPairing(match.exec, 'diversion');
}

/** סבב שבוטל ללא קרדיט: ימיו נספרים כימים ללא פעילות, ומה שבוצע בהם לא היה מתוכנן. */
function noteCancelled(ctx, match, rule, why) {
  ctx.markPairing(match.plan, 'cancelled_no_compensation');
  ctx.note(match.plan.from, `סבב מתוכנן שלא בוצע: בוטל ללא קרדיט${why ? ` (${why})` : ''}. ` +
    'ימיו נספרים כימים ללא פעילות' +
    (match.exec ? ', ומה שבוצע בהם הוא פעילות שלא תוכננה.' : '.'), rule);
}

/**
 * אפשרויות "מה קרה" לסבב מתוכנן שלא בוצע כמתוכנן, בלי "סיבה אחרת": משותפות לשאלה הרגילה
 * (`askWhatHappened`) ולשאלת הסתירה (`resolveLinkConflict`, דרך `claimLabel`), כדי שאותו
 * ערך תמיד יתואר באותה לשון.
 */
function whatHappenedOptions(ctx, plan, exec, calendar = null) {
  const diff = plannedMinusPerformed(ctx, plan, exec);
  // בתכנון לבד הסבב שבמקומו הוא זה שביומן (`askJournal`), והוא עוד לא בוצע.
  const other = exec ?? calendar;
  const performed = ctx.hasExec ? 'הטיסה שבוצעה' : 'הטיסה שביומן';
  const shortfall = ctx.rulesWithLogic('higher_of_planned_performed')[0]?.logic?.params?.shortfall_column ?? 'COM';
  const higher = 'מגיע הגבוה מבין שתי הטיסות' + (diff == null ? ''
    : diff > 0 ? `: ${amountWord(shortfall)} של ${minToHhmm(diff)}`
    : '; מה שבוצע אינו קצר מהמתוכנן, ולכן אין הפרש לתשלום');
  return [
    { value: 'replaced', label: 'שינוי ביוזמת החברה', hint: higher, needsLink: true },
    // אותה טיסה, עם נחיתה ביעד שלא תוכנן: רק מול הסבב שבוצע באותם ימים, ולכן בלי קישור. משלמת כמו
    // שינוי ביוזמת החברה, ומוצגת בשמה בשינויים (בעל המוצר, 05/10/2026). רק כשלפחות אחד ממספרי הטיסה
    // המתוכננים נמצא במה שבוצע: בלי אף אחד זו טיסה אחרת, ולא סטיה (04/06/2024: SKG → WAW).
    ...(other && sharesFlight(plan, other) && other.destinations.join() !== plan.destinations.join() ? [{ value: 'diversion', label: 'סטיה לשדה משנה', hint: higher }] : []),
    // זכייה במכרז משלמת כמו שינוי ביוזמת החברה, אבל אינה "ביוזמת החברה" לעניין 2024 ס' 34–37 ו-39
    // (ס' 40): נחיתות לילה, שבתות ברצף וטיסות סבב לילה עוקבות (בעל המוצר, 05/10/2026).
    { value: 'bid', label: 'זכייה במכרז', hint: higher, needsLink: true },
    { value: 'voluntary_swap', label: 'החלפה מרצוני', hint: `רק הקרדיט של ${performed}`, needsLink: true },
    { value: 'cancelled', label: 'הטיסה המקורית בוטלה ללא קרדיט',
      hint: other ? `מגיע פיצוי של קריאה מיוחדת על ${performed}` : 'לא מגיע כלום' },
    ...lostHoursOptions(ctx, plan, other ? `בנוסף לקרדיט של ${performed}` : undefined),
  ];
}

/**
 * השאלה על סבב מתוכנן שלא בוצע כמתוכנן. `execId` הוא הסבב שבוצע באותם ימים, והוא האפשרות
 * הראשונה בקישור שבהחלפה.
 */
function askWhatHappened(ctx, match, rule) {
  const { plan, exec } = match;
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
 * יומן השינויים מהיומן המחובר (`ctx.journal`, js/rules/journal.js; בעל המוצר, 06/10/2026).
 * בתכנון לבד: על כל שלב בלי תשובה – סבב שנעלם מהיומן, ביומן במקומו סבב אחר או אותו סבב בתאריך אחר –
 * נשאלת הסיבה, באותה שאלה ובאותו מזהה כמו מול הרומה (`cancelled:`), עם הסבבים שביומן במקום אלה
 * שבוצעו; ועל כל סבב ביומן שאינו המשך של שלב – אותה שאלה כמו על פעילות שלא תוכננה (`unplanned:`).
 * כוננות במקום הסבב אינה נשאלת: מול הרומה היא "בוטל והוצבת לכוננות", בלי שאלה. הקרדיט והפיצויים
 * נשארים לפי התכנון עד שהרומה מועלית. עם הרומה: על סבב ביומן שהשרשרת נעצרה בו נשאלת השאלה מול
 * הרומה (`ctx.journalOpen`). בשני המקרים לכל שלב שנענה נבנה התיאור שמתחת לשינוי (`note`).
 */
function askJournal(ctx, rule) {
  const j = ctx.journal;
  if (!j) return;
  for (const st of j.steps) st.note = stepNote(ctx, st);
  for (const n of j.unplanned) n.note = unplannedNote(ctx, n);
  if (ctx.hasExec) {
    for (const o of ctx.journalOpen ?? []) askChainOpen(ctx, o, rule);
    return;
  }
  const label = (p) => ({ id: p.id, label: describePairing(p) });
  // סבב חדש ביומן שכבר נענה (למשל נוסף בהסכמה) אינו מה שבא במקום סבב אחר.
  const newOnes = j.unplanned.filter((n) => !ctx.answer(`unplanned:${n.id}`)).map((n) => ({ ...label(n.pairing), id: n.id }));
  for (const st of j.open) {
    if (st.answer) continue;
    const p = st.fromPairing;
    const cal = st.candidates[0] ?? null;
    // סבב מתוכנן, או סבב שהשרשרת כבר עברה אליו ביומן.
    const planned = st.node.plan;
    const was = planned ? 'תוכנן ' : 'היה ביומן ';
    const now = planned ? ', ביומן ' : ', עכשיו ביומן ';
    const plan = { ...p, id: st.node.id };
    ctx.ask({
      id: st.id,
      date: p.from,
      execId: cal?.id ?? null,
      title: st.how === 'moved' || st.how === 'retimed'
        ? [`${planned ? `סבב מתוכנן שביומן הוא ${st.how === 'moved' ? 'בתאריך אחר' : 'בשעה אחרת, מחוץ ל-FDP המקורי'}`
            : `סבב שביומן עבר ${st.how === 'moved' ? 'לתאריך אחר' : 'לשעה אחרת, מחוץ ל-FDP המקורי'}`}:\n`,
            { bold: true, text: was }, describePairing(p), { bold: true, text: now }, describePairing(cal)]
        : cal
          ? [planned ? 'סבב מתוכנן שביומן רשום במקומו סבב אחר:\n' : 'סבב שביומן, ועכשיו רשום במקומו סבב אחר:\n', { bold: true, text: was },
              describePairing(p), { bold: true, text: now }, st.candidates.map(describePairing).join(', ')]
          : planned ? `סבב מתוכנן שאינו ביומן: ${describePairing(p)}` : `סבב שירד מהיומן: ${describePairing(p)}`,
      body: 'הסיבה אינה בקבצים, והיא תקבע מה מגיע כשתועלה הרומה. מה קרה?',
      options: [...whatHappenedOptions(ctx, plan, null, cal), otherOption()],
      linkPool: [...st.candidates.map(label), ...newOnes.filter((x) => !st.candidates.some((c) => c.id === x.id))],
      ruleId: rule.id,
    });
  }
  const gone = j.open.filter((st) => !st.answer).map((st) => ({ id: st.node.id, label: describePairing(st.fromPairing) }));
  // בתכנון לבד אין פיצויים, ולכן אין כאן "קריאה מיוחדת": השאלה היא איך הסבב נכנס לשיבוץ. החלפה, מרצוני
  // או ביוזמת החברה – מול הסבב שיצא; זכייה במכרז – נוספה על התכנון, ומול הרומה מגיעה עליה קריאה מיוחדת;
  // הוספה בהסכמה – כאילו היה בתכנון, בלי פיצוי על ההוספה. בשתי האחרונות שינוי בו אחר כך הוא שלב בשרשרת
  // משלו (`ROOT` ב-js/rules/journal.js; בעל המוצר, 06/10/2026).
  for (const n of j.unplanned) {
    ctx.ask({
      id: `unplanned:${n.id}`,
      date: n.pairing.from,
      title: `ביומן סבב שאינו בתכנון: ${describePairing(n.pairing)}`,
      body: 'הסיבה אינה בקבצים, והיא תקבע מה מגיע כשתועלה הרומה. מה קרה?',
      options: [
        { value: 'bid', label: 'זכייה במכרז' },
        { value: 'voluntary_swap', label: 'החלפה מרצוני', needsLink: true },
        { value: 'replaced', label: 'שינוי ביוזמת החברה', needsLink: true },
        { value: 'added', label: 'הוספת טיסה בהסכמה' },
        otherOption(),
      ],
      linkPool: gone,
      ruleId: rule.id,
    });
  }
}

/**
 * עם הרומה, כשהשרשרת מהיומן נעצרה בסבב שביומן ולא ידוע מה קרה בו: אותה שאלה כמו על סבב מתוכנן
 * שלא בוצע, על הסבב שביומן (בעל המוצר, 06/10/2026). התשובה היא השלב האחרון בשרשרת.
 */
function askChainOpen(ctx, open, rule) {
  const p = { ...open.pairing, id: open.id };
  const exec = ctx.execPairings.find((e) => overlapDays(p, e)) ?? null;
  const diff = plannedMinusPerformed(ctx, p, exec);
  ctx.ask({
    id: `cancelled:${open.id}`,
    date: p.from,
    execId: exec?.id ?? null,
    title: exec
      ? ['סבב שביומן, ובמקומו בוצע סבב אחר באותם ימים:\n', { bold: true, text: 'ביומן ' }, describePairing(p),
          { bold: true, text: ', בוצע ' }, describePairing(exec)]
      : `סבב שביומן ולא בוצע: ${describePairing(p)}`,
    body: 'הסבב הוא שלב בשינויים שהיומן הראה מהתכנון. ' + (diff != null && diff > 0 ? `הוא ארוך ממה שבוצע ב-${minToHhmm(diff)}. ` : '') +
      'הסיבה אינה בקבצים, והיא קובעת מה מגיע. מה קרה?',
    options: [...whatHappenedOptions(ctx, p, exec), otherOption()],
    ruleId: rule.id,
  });
}

/** שלב בשרשרת לטבלת השינויים: מה היה, לאן עבר, ובלשון האפשרות שנבחרה. */
function stepNote(ctx, st) {
  const from = describePairing(st.fromPairing);
  // `reason`: רק הסיבה, לשורה של שלב יחיד, שבה הסבבים כבר כתובים (`journalRows`; בעל המוצר, 06/10/2026).
  st.reason = null;
  if (!st.answer) return st.end === 'standby' ? `${from}: ביומן רשומה כוננות במקום הסבב` : null;
  const a = st.answer;
  const to = st.to?.pairing ?? (a.link && a.link !== 'none' ? ctx.pairingById(a.link) : null);
  const opt = whatHappenedOptions(ctx, { ...st.fromPairing, id: st.node.id }, null, st.candidates[0] ?? null).find((o) => o.value === a.value);
  const label = a.value === 'other' ? `סיבה אחרת${a.text ? `: ${a.text}` : ''}` : opt?.label ?? a.value;
  const where = to ? describePairing(to) : opt?.needsLink ? (a.link === 'none' ? 'מסירת הטיסה ללא חלופה' : 'טיסה בחודש אחר') : null;
  st.reason = !to && where ? `${label}: ${where}` : label;
  return `${from}${where ? ` → ${where}` : ''}: ${label}`;
}

/** התשובה על סבב ביומן שאינו בתכנון, לטבלת השינויים. */
function unplannedNote(ctx, n) {
  const a = ctx.answer(`unplanned:${n.id}`);
  if (!a) return null;
  const simple = { special_call: 'קריאה מיוחדת', bid: 'זכייה במכרז', added: 'הוספת טיסה בהסכמה' };
  if (simple[a.value]) return simple[a.value];
  if (a.value === 'other') return `סיבה אחרת${a.text ? `: ${a.text}` : ''}`;
  const what = { voluntary_swap: 'החלפה מרצוני', replaced: 'שינוי ביוזמת החברה' }[a.value];
  if (!what) return a.value;
  const gone = ctx.journal.steps.find((st) => st.node.id === a.link);
  return `${what}: ${gone ? describePairing(gone.fromPairing) : a.link ? a.link : 'טיסה בחודש אחר'}`;
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
  const ok = (c) => !(params.exclude_codes ?? []).includes(c);
  for (const day of ctx.timeline) {
    if (!(day.plan?.codes ?? []).some((c) => ok(c) && codeIn(c, params.plan_codes, params.plan_code_prefixes))) continue;
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
 * הטיסה שבוצעה ביום המקורי מוזכרת בהערה רק כשהיא לא מוסברת כבר בפני עצמה (`ctx.matches`):
 * ב-07/06/2026 הטיסה שם היא BER, שכבר מוסברת משלה כהחלפה מרצונית של FRA (סבב אחר לגמרי,
 * לא קשור ל-HOME) – ולכן אין טעם לצרף אותה להערה על ה-HOME (בעל המוצר, 26/09/2026).
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
      ctx.note(day.date, `${training.join(', ')} בוטל והוצבת לטיסה: קריאה מיוחדת.`, rule);
    }

    const own = ctx.matches.find((m) => m.exec === pairing);
    const placed = own && own.how !== 'unplanned' ? '' : ', ובמקומו הוצבת לטיסה';
    for (const code of planCodes.filter((c) => codeIn(c, [], params.moved_ok_prefixes))) {
      const prefix = params.moved_ok_prefixes.find((p) => code.startsWith(p));
      const movedTo = ctx.timeline.filter((d) => d.date !== day.date && ctx.execCodes(d).some((c) => c.startsWith(prefix)) &&
        !(d.plan?.codes ?? []).some((c) => c.startsWith(prefix)));
      if (movedTo.length) {
        // `aside`: הטיסה של אותם ימים אינה קשורה להזזה, ולכן ההערה נשארת בהערות ולא עוברת לשורת
        // השינוי של הטיסה (07/06/2026: HOME_RGT שזז, ו-BER שהוא החלפה מרצון של FRA).
        ctx.note(day.date, `${code} תוכנן ל-${dayOf(day.date)} ובוצע ב-${movedTo.map((d) => dayOf(d.date)).join(', ')}${placed}. ` +
          'הזזה בתוך החודש אינה מזכה בפיצוי.', rule, { aside: !placed });
      } else {
        ctx.review(`${code} תוכנן ל-${dayOf(day.date)}${placed}. ` +
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
      // הדוח כבר מזכה את הקריאה המיוחדת: זו זכייה במכרז, ואין מה לשאול.
      const answer = ctx.answer(id) ??
        (ctx.paidOn(pairing, sc?.logic?.params?.report_column ?? 'S/C', 'sc', bidAmount(pairing, ctx, sc)) ? { value: 'standby_bid' } : null);
      const range = run.length === 1 ? dayOf(run[0]) : `⁦${dayOf(run[0])}–${dayOf(run.at(-1))}⁩`;
      if (!answer) {
        ctx.markPairing(pairing, 'standby_bid_pending');
        ctx.ask({
          id,
          date: pairing.from,
          title: `טיסה ביומיים האחרונים של כוננות: ${describePairing(pairing)}`,
          body: `בתכנון כוננות ב-${range}, והטיסה יצאה ב-${dayOf(pairing.from)}. ` +
            (run.at(-1) === monthEnd ? 'הכוננות מגיעה לסוף החודש, וייתכן שהיא נמשכת בחודש הבא. ' : '') +
            'הרומה לא מזכה קריאה מיוחדת. אם החברה אישרה לך לסיים את הכוננות בגלל זכייה במכרז, מגיעה קריאה מיוחדת על ימי הטיסה. אם הכוננות הופעלה, מגיע רק קרדיט הטיסה. מה קרה?',
          options: [
            { value: 'standby_bid', label: 'סיום כוננות בגלל זכייה במכרז', hint: bidHint(pairing, ctx, sc) },
            { value: 'standby_activated', label: 'הפעלת הכוננות', hint: 'קרדיט הטיסה, בלי קריאה מיוחדת' },
            otherOption(),
          ],
          ruleId: rule.id,
        });
        continue;
      }
      if (answer.value === 'standby_bid') {
        ctx.markPairing(pairing, 'standby_bid');
        ctx.note(pairing.from, `סיום כוננות (${range}) בגלל זכייה במכרז: קרדיט הטיסה וקריאה מיוחדת על ימי הטיסה.`, rule);
      } else if (answer.value === 'standby_activated') {
        // הקרדיט על ימי ההפעלה נבדק בחוק ההפעלה מכוננות.
        ctx.markPairing(pairing, 'standby_activated');
      } else {
        ctx.markPairing(pairing, 'standby_bid_pending');
        if (!applyOtherReason(ctx, answer, rule, { what: `טיסה ביומיים האחרונים של הכוננות (${range})`, date: pairing.from, pairing })) {
          ctx.review(`${describePairing(pairing)}, ביומיים האחרונים של הכוננות (${range}): ${answer.text || 'סיבה אחרת'}. דורש בדיקה ידנית.`, rule);
        }
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
    const range = run.length === 1 ? dayOf(run[0]) : `⁦${dayOf(run[0])}–${dayOf(run.at(-1))}⁩`;
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
      ctx.note(pairing.from, `הפעלה מהכוננות (${range}): קרדיט הטיסה, בלי קריאה מיוחדת.`, rule);
      if (beyond) {
        ctx.review(`${describePairing(pairing)}: הופעלת מהכוננות (${range}), והחזרה אחרי סוף הכוננות. החברה רשאית להפעיל ` +
          'כונן רק כשהחזרה מתוכננת להסתיים בתוך הכוננות (2018 ס\' 88). דורש בדיקה ידנית.', rule);
      }

      // הכוננות רשומה בדוח בימי הטיסה: חוק זיכוי היום כבר משווה בין הטיסה לכוננות.
      if (value && flown.some((d) => ctx.execCodes(ctx.timeline.find((x) => x.date === d)).some((c) => codeIn(c, value.rule.logic.params.report_codes, value.rule.logic.params.report_code_prefixes)))) continue;
      const credit = sumLegs(pairing, ctx.domicile);
      const what = `${flown.length === 1 ? 'יום הכוננות שבו' : `${flown.length} ימי הכוננות שבהם`} טסת (${flown.map(dayOf).join(', ')})`;
      if (!value) {
        ctx.review(`${describePairing(pairing)}: על ${what} מגיע הגבוה מבין קרדיט הטיסה לבין ערך ימי הכוננות (2018 ס' 98). ` +
          `אין חוק שקובע את ערך הכוננות לקוד ${planCode}. דורש בדיקה ידנית.`, rule);
      } else if (credit == null || credit < value.min * flown.length) {
        ctx.review(`${describePairing(pairing)}: על ${what} מגיע הגבוה מבין קרדיט הטיסה (${credit == null ? 'לא ידוע' : minToHhmm(credit)}) ` +
          `לבין ${flown.length} × ${minToHhmm(value.min)} (${value.rule.title}; 2018 ס' 98). הכוננות גבוהה יותר, ועוד לא ראינו איך זה נרשם ברומה. דורש בדיקה ידנית.`, rule);
      } else {
        ctx.note(pairing.from, 'הפעלה מהכוננות: קרדיט הטיסה גבוה מערך הכוננות, ולכן אין תוספת.', rule);
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
  const n = countSpecialCallDays(stay, p, pairing, ctx.fdp).counted.length;
  return `קריאה מיוחדת: ${n === 1 ? 'יממה אחת' : `${n} יממות`}, ${minToHhmm(n * H(p.hours))} ב-${p.report_column ?? 'S/C'}`;
}

/** הסכום שזכייה במכרז הייתה מזכה בו, לבדיקה אם הדוח כבר זיכה אותו. 0 כשאי אפשר לחשב. */
function bidAmount(pairing, ctx, sc) {
  if (!sc) return 0;
  const p = sc.logic.params ?? {};
  const stay = awayFromBase(pairing, ctx.domicile, ctx.timeline.at(-1).date);
  if (stay.error) return 0;
  return countSpecialCallDays(stay, p, pairing, ctx.fdp).counted.length * H(p.hours);
}

export const LOGIC = {
  credit_from_scheduled,
  min_slip_credit,
  absence_day_credit,
  vacation_credit_balance,
  unpaid_leave_days,
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
  absence_day_credit: ['plan_codes', 'report_codes', 'plan_code_prefixes', 'report_code_prefixes', 'report_flag_column', 'credit_hours', 'tab_hours', 'requires_assigned_activity', 'flight_day_takes_higher', 'away_flag_on_pairing_start', 'confirm_code_prefixes', 'confirm_label', 'confirm_answer', 'note_code_upgrade', 'exclude_codes'],
  unpaid_leave_days: ['plan_codes', 'report_codes', 'plan_code_prefixes', 'report_code_prefixes'],
  vacation_credit_balance: ['per_day_hours', 'days_full_rate', 'monthly_max_hours', 'yearly_cap_days', 'taper_table', 'taper_table_complete', 'taper_monthly_totals'],
  absence_month_cap: ['cap_hours'],
  late_landing_home: ['grace_minutes', 'step_minutes', 'hours_per_step', 'note_from_minutes'],
  long_flight_day: ['over_flight_hours', 'hours'],
  special_call: ['hours', 'report_column', 'second_day_min_gap_hours', 'second_day_min_hours', 'ask_user_if_no_sc'],
  higher_of_planned_performed: ['requires_user_answer', 'excluded_when_special_call', 'excluded_when_voluntary_swap', 'shortfall_column'],
  lost_hours_credit: ['requires_user_answer', 'credit_column', 'include_min_slip_credit', 'answer_value', 'answer_label', 'merged_answer_values', 'fleets', 'plan_aircraft'],
  voluntary_swap: ['requires_user_answer'],
  cancelled_no_compensation: ['requires_user_answer'],
  vacation_recall: ['plan_codes', 'plan_code_prefixes', 'report_codes', 'report_code_prefixes', 'hours', 'report_column', 'exclude_codes'],
  training_cancelled_flight: ['plan_codes', 'plan_code_prefixes', 'moved_ok_prefixes'],
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
  // קיצור המנוחה במיאמי מסמן את הסבב, ושני חוקי הדחייה של ס' 24.4 נשענים על הסימון.
  'short_rest_miami',
  'miami_delay',
  'short_rest_las_vegas',
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
];
