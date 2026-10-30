// הרצת החוקים על חודש אחד, והשוואה מול מה שזוכה בדוח הביצוע.
//
// הקובץ הזה מחבר בין שלושה חלקים: המודל (ציר ימים וסבבים), הלוגיקות של החוקים,
// וההשוואה מול הדוח. הוא לא מכיר ערכי פיצוי: כל מספר מגיע מ-`rules.json` דרך הלוגיקות.
//
// ההשוואה נעשית ב"קבוצות ימים": סבב ביצוע והימים שהקרדיט שלו התפצל אליהם הם קבוצה אחת,
// וכל יום אחר הוא קבוצה לעצמו. כך טיסת לילה שהקרדיט שלה נרשם בשני ימים נבדקת כמכלול.

import { LOGIC, LOGIC_ORDER, DAY_DUES } from './logic.js';
import { rulesInEffect, partitionRules, rulesByLogic, classifyCode, codeLabel, codeName, codeNames } from './catalog.js';
import { buildTimeline, buildPairings, markCarryIn, attachCarried, matchPairings, describePairing, describeRoute, pairingParts, fdpParts, sameFdp } from '../model.js';
import { hoursToMin, minToHhmm } from '../time.js';
import { OPTIONAL_COLUMNS } from '../pdf/exec.js';
import { checkLegalLimits, restDefinition, delayFitsFdp, baseReportMinutes, dutyTimes } from './legal.js';
import { whiteFlightLegs, whiteCrew, contractCrewOf, execFdpGroups } from './duty.js';
import { timeZones, legTimes, pairingTimes, crossesMidnight, dateOf, at } from '../flight-times.js';
import { calendarView, buildJournal, reduceChain, sameAssignment, firstFdpLegs, overlapDays, samePairing, legOrder } from './journal.js';
import { baseTime } from '../airports.js';

/** עמודות הדוח שכל סוג ציפייה נבדק מולן. */
const KEY_COLUMNS = {
  flight: ['Credit', 'FLT+DH'],
  absence: ['Credit'],
  credit: ['Credit'],
  rig: ['Rig'],
  com: ['COM'],
  sc: ['S/C'],
};
const COMPARED_COLUMNS = ['Credit', 'FLT+DH', 'Rig', 'COM', 'S/C'];
/** עמודות הפיצוי: בסבב של כמה FDP נפרדים הן נרשמות לכל FDP, ולא לסבב כולו. */
const COMPENSATION_COLUMNS = ['COM', 'S/C'];
/** עמודות הקרדיט: רק בהן מוצגת בתווית חזרה לבסיס אחרי המראה שמחוברת לסבב שאחריה. */
const CREDIT_LABEL_COLUMNS = ['Credit', 'FLT+DH', 'Rig'];

/**
 * @param {object} input
 * @param {object} input.rulesData  תוכן rules.json
 * @param {object|null} input.plan  פלט parsePlan
 * @param {object|null} input.exec  פלט parseExec
 * @param {Object<string, {value: string, text?: string, link?: string}>} [input.answers]
 *        תשובות המשתמש לשאלות, לפי מזהה השאלה.
 * @param {Array<{period, plan, exec}>} [input.history]  חודשים קודמים מהחדש לישן, לחלונות של
 *        מגבלות החוק שמתחילים לפני החודש (168 שעות, 672 שעות, 365 ימים).
 * @param {{flights: Array, standby: Array}|null} [input.calendar]  השלמות מהיומן, כשהמשתמש חיבר
 *        אותו (`parseEvents` ב-js/calendar.js): הרכב הצוות ושעות הכוננות. תשובה של המשתמש קודמת להן.
 * @param {string[]} [input.reopen]  שאלות שהיומן אינו עונה עליהן, כי המשתמש החליט בהן בעצמו
 *        (`calendarIgnored` ברשומת החודש; בעל המוצר, 04/10/2026).
 * @param {string[]} [input.assumedIgnored]  הנחות שהמשתמש ביטל ב"שנה" (`ctx.assume`; בעל המוצר, 17/10/2026,
 *        טיוטה 365): השאלה נשאלת, כאילו הרומה לא זיכתה.
 * @param {Array<{flights, standby}>} [input.calendarHistory]  התמונות של החודש מהיומן לפני הרומה,
 *        לפי הסדר (`appendSnapshot` ב-js/rules/journal.js). בלעדיהן – היומן עצמו כתמונה אחת.
 *
 * בתכנון לבד, כשיש ביומן נתונים מהחודש, היומן נבדק כמו רומה, בלי פיצויים (בעל המוצר, 13/10/2026;
 * requirements.md סעיף 5.3): החודש רץ פעמיים – לפי התכנון, וכמו מול רומה שנבנתה מהיומן
 * (`calendarExec`) – ומהריצה השנייה נלקחות טבלת השינויים, מגבלות החוק והשאלות על השינויים
 * (`mergeCalendarRun`).
 */
export function evaluate(input) {
  const out = evaluateOnce(input);
  // הנחה ניתנת לשינוי רק כשבלעדיה נשאלת השאלה; אחרת היא אינה מוצגת ב"תשובות שנשמרו", ו-`run-month` מסמן אותה
  // (בעל המוצר, 21/10/2026, טיוטה 388; טל: ZRH ‏01–02/09 – קריאה מחופשה ביטלה את השאלה).
  for (const a of out.assumptions ?? []) {
    const probe = evaluateOnce({ ...input, assumedIgnored: [...(input.assumedIgnored ?? []), a.id] });
    a.changeable = probe.questions.some((q) => q.id === a.id);
  }
  return out;
}

function evaluateOnce(input) {
  const run = input.plan && !input.exec ? calendarExec(input) : null;
  if (!run) return evaluateFiles(input);
  const out = evaluateFiles(input, { journal: false });
  const cal = evaluateFiles({ ...input, exec: run.exec }, { calendarRun: run });
  return mergeCalendarRun(out, cal, input.answers ?? {});
}

/**
 * `journal`: false – בלי יומן השינויים (בריצה לפי התכנון, כשהשינויים באים מהריצה מול היומן).
 * `calendarRun`: הריצה מול הרומה שנבנתה מהיומן (`calendarExec`): השאלות בנוסח של היומן
 * (`ctx.calendarRun`), ומגבלות החוק לפי הזמנים שביומן, כמו בתכנון (`calendarRun.plan`).
 */
function evaluateFiles({ rulesData, plan = null, exec = null, answers = {}, history = [], calendar = null, reopen = [], calendarHistory = null, assumedIgnored = [] },
  { journal: useJournal = true, calendarRun = null } = {}) {
  calendar = withoutKept(calendar);
  // התשובות שהשרשרת מהיומן קובעת נוספות לכאן (`applyJournal`).
  answers = { ...answers };
  if (!plan && !exec) throw new Error('לא הועלה אף קובץ.');
  const period = (exec ?? plan).period;
  const mode = plan && exec ? 'full' : plan ? 'plan' : 'exec';
  // חודש שנשמר בגרסה קודמת מחזיק אזהרת עמודות חסרות מהחילוץ; היא נבנית מחדש כאן.
  const execWarnings = (exec?.warnings ?? []).filter((w) => !w.startsWith(MISSING_COLUMNS_PREFIX) && !w.startsWith(IPAD_WARNING_PREFIX));
  // רומה שאינה סופית אינה חסרה נתונים: הודעת מערכת, בכחול (`infos`; בעל המוצר, 14/10/2026; טיוטה 332).
  const infos = execWarnings.filter((w) => w.startsWith(STATUS_WARNING_PREFIX));
  const warnings = [...(plan?.warnings ?? []).filter((w) => !w.startsWith(CROSS_MONTH_WARNING_PREFIX)),
    ...execWarnings.filter((w) => !w.startsWith(STATUS_WARNING_PREFIX))];
  const missingRequired = (exec?.missingColumns ?? []).filter((c) => !OPTIONAL_COLUMNS.includes(c));
  if (missingRequired.length) {
    warnings.push(`${MISSING_COLUMNS_PREFIX}: ${missingRequired.join(', ')}. ייתכן שהן נחתכו בהדפסה. חוקים שתלויים בהן לא ייבדקו.`);
  }
  checkSameMonthAndEmployee(plan, exec, warnings);
  checkMissingData(plan, exec, warnings);

  const inEffect = rulesInEffect(rulesData, period.year, period.month);
  const { supported: listed, unsupported } = partitionRules(inEffect);
  const timeline = buildTimeline(period, plan, exec);
  // קוד לא מוכר ברומה עם CORS: פעילות קרקע, כמו קוד מוכר (בעל המוצר, 15/10/2026).
  const ground = exec ? assumeGroundCodes(timeline, rulesData.codes ?? {}, listed) : null;
  const supported = ground?.supported ?? listed;
  const codes = ground?.codes ?? rulesData.codes ?? {};
  const domicile = exec?.domicile ?? guessDomicile(plan);
  if (!domicile) warnings.push('לא ניתן לקבוע את בסיס הבית מהקבצים. חוקים שתלויים בבסיס לא ייבדקו.');
  // הצי (בעל המוצר, 25/10/2026; טיוטה 410): מרגלי התכנון, מהפרופיל ברומה, ובלעדיהם מהשאלה על החודש (`fleet:`).
  // עד התשובה – `crew.fleet` מ-rules.json. MFF הוא צי רחב גוף, כמו B787.
  const fleetId = `fleet:${period.year}-${String(period.month).padStart(2, '0')}`;
  const fileFleet = fleetOf(plan) ?? execFleet(exec, period);
  const fleetAnswer = fileFleet ? null : FLEET_ANSWERS[answers[fleetId]?.value] ? answers[fleetId].value : null;
  const mff = fleetAnswer === 'MFF';
  const fleet = fileFleet ?? FLEET_ANSWERS[fleetAnswer] ?? rulesData.crew?.fleet ?? null;
  // התפקיד (CP, ‏FO), לתעריף האש"ל: מהרומה, ובלעדיה מהתכנון (בעל המוצר, 18/10/2026).
  const position = exec?.position ?? plan?.position ?? null;
  if (exec?.position && plan?.position && exec.position !== plan.position) {
    infos.push(`בתכנון רשום ${plan.position} וברומה ${exec.position}. האש"ל לפי הרומה.`);
  }
  const cal = calendarFacts(calendar, domicile);

  const planPairings = plan ? buildPairings(timeline, domicile, planLegsWithCredit).map(ftOnLastDay) : [];
  // החודש הקודם, אם הוא בחודשים השמורים: לזיהוי הסבב שהתחיל בו ולקיזוז בגבול החודש (טיוטות 373, 417, 425).
  const prev = history[0]?.period && (period.month === 1 ? history[0].period.year === period.year - 1 && history[0].period.month === 12
    : history[0].period.year === period.year && history[0].period.month === period.month - 1) ? history[0] : null;
  const prevExec = prev?.exec ?? null;
  if (exec) markCarryIn(timeline, domicile, prev);
  // אזורי הזמן של החודש, לזמני הרגליים והסבבים (js/flight-times.js).
  const tz = timeZones(domicile, plan?.stationOffsets ?? null, timeline);
  // חזרה לבסיס אחרי המראה מצטרפת לטיסה שיוצאת אחריה באותו FDP, לפי הגדרת ה-FDP של הסליפ הקצר.
  const slip = supported.find((r) => r.logic.id === 'min_slip_credit')?.logic.params;
  // המנוחה החוקית לפי ה-OMA: מתחילה 15 דק' אחרי ה-On block (`legal_limits`).
  const legalRest = restDefinition(rulesData.legal_limits);
  // ההתייצבות והשחרור לפי ה-OMA, לכל חוקי הפיצוי (`dutyTimes`; בעל המוצר, 10/10/2026).
  const duty = dutyTimes(rulesData.legal_limits, { domicile, fleet, tz,
    answer: (id) => answers[id] ?? (reopen.includes(id) ? null : cal.answer(id)) ?? null });
  const fdp = slip?.legal_rest_hours != null
    ? { legalRestMin: slip.legal_rest_hours * 60, reportBefore: duty.reportBefore, releaseAfter: duty.releaseAfter, tz } : null;
  const execPairings = exec ? buildPairings(timeline, domicile, (d) => d.exec?.legs, fdp) : [];
  attachCarried(execPairings[0], timeline, domicile, prev);
  attachCarried(planPairings[0], timeline, domicile, prev);
  const reportDays = exec ? attachReportTails(execPairings, timeline, tz, codes, answers) : [];
  markLandingDays(planPairings, execPairings, timeline, tz);
  const dependentAnswers = {};
  // ההחלפות עם טיסה אחרת (`splitSwappedElsewhere`) והפעילות במקום סבב (`explainByActivity`) – אחרי
  // שהשרשרת מהיומן הוסיפה את התשובות שלה, לפני החוקים.
  const matches = mode === 'full' ? matchPairings(planPairings, execPairings)
    : mode === 'exec' ? execPairings.map((e) => ({ plan: null, exec: e, how: 'noplan' })) : [];

  const out = {
    period,
    mode,
    domicile,
    fleet,
    mff,
    fleetPending: !fileFleet && !fleetAnswer,
    rulesVersion: rulesData.rules_version,
    rules: {
      supported: supported.map((r) => r.id),
      unsupported: unsupported.map(({ rule, reason }) => ({ id: rule.id, title: rule.title, category: rule.category, reason })),
    },
    warnings,
    infos,
    changes: [],
    expectations: [],
    flags: [],
    tabs: [],
    notes: [],
    reviews: [],
    questions: [],
    // תשובות שהאפליקציה הניחה כי הרומה זיכתה (`ctx.assume`): שורות ב"תשובות שנשמרו", עם "שנה" (טיוטה 365).
    assumptions: [],
    // תשובות שנשאלו רק בגלל תשובה אחרת: שינוי שלה מוחק גם אותן (`splitSwappedElsewhere`).
    dependentAnswers,
    // לפי הקודים שב-`rules.json`: קוד שהונח כפעילות קרקע נשאר בהתראה, עם ההנחה.
    unknownCodes: collectUnknownCodes(timeline, rulesData.codes ?? {}, listed, exec?.unknownColumns)
      .map((u) => (ground?.assumed.has(u.code) ? { ...u, assumed: `ברומה רשום ${ground.column}, האפליקציה מניחה שזו פעילות קרקע.` } : u)),
    comparison: [],
    totals: [],
    freeDays: null,
    perDiem: null,
    legal: null,
  };

  const assumed = new Map(); // planId → ערכי התשובה שהאפליקציה הניחה בלי לשאול
  const ctx = makeContext({ out, timeline, domicile, codes, holidays: rulesData.holidays ?? {}, answers, plan, exec, supported, matches, planPairings,
    period, fleet, position, fdp, tz, assumed, assumedIgnored, reportDays, calendarAnswer: (id) => (reopen.includes(id) ? null : cal.answer(id)), calendarFirstDay: cal.firstDay,
    calendarRun: !!calendarRun,
    // בלי דוח ביצוע, הסבבים המתוכננים משמשים לחישוב הקרדיט והרי"ג הצפויים.
    execPairings: exec ? execPairings : planPairings });
  ctx.legalRest = legalRest;
  ctx.duty = duty;
  ctx.tz = tz;
  if (out.fleetPending) {
    ctx.ask({
      id: fleetId,
      title: 'הצי',
      body: 'הצי אינו מופיע בקבצים. באיזה צי טסת החודש?',
      options: [{ value: 'B737', label: '737' }, { value: 'B787', label: '787' }, { value: 'MFF', label: '\u20667877\u00a0(MFF)\u2069' }],
    });
  }
  ctx.prevExec = prevExec; // לקיזוז בגבול החודש (`credit_from_scheduled`; טיוטה 373)
  // החודש הקודם, לרצף שחוצה חודש: שבתות וטיסות סבב לילה (טיוטה 431).
  if (prev) {
    const days = buildTimeline(prev.period, prev.plan, prev.exec);
    ctx.prevMonth = { timeline: days, hasExec: !!prev.exec, answers: prev.answers ?? null,
      planPairings: prev.plan ? buildPairings(days, domicile, planLegsWithCredit, fdp).map(ftOnLastDay) : [],
      execPairings: prev.exec ? buildPairings(days, domicile, (d) => d.exec?.legs, fdp) : [] };
  }
  // טיסות שהרכב הצוות שלהן משנה את בדיקת מגבלות החוק או את הזכאות לפיצוי, "date|flight": רק עליהן
  // ההודעה על הרכב צוות שחסר ביומן (`calendarMissing`; בעל המוצר, 04/10/2026).
  const crewMatters = new Set();
  ctx.crewMatters = (date, flight) => crewMatters.add(`${date}|${flight}`);
  // האם היומן מכיר את הטיסה: null כשאין ביומן טיסות.
  ctx.inCalendar = (date, flight) => (calendar?.flights?.length ? cal.has(date, flight) : null);
  // Soft Start (2018 ס' 91): הימים שבהם הופעלת לטיסה מהכן מיידי שהוצב בגלל דחיית ההמראה – לזיכוי הכוננות
  // (`absence_day_credit`) ולמגבלות החוק (בעל המוצר, 15/10/2026).
  const isRap = (c) => (rulesData.legal_limits?.short_call_reserve_codes ?? []).some((x) => c === x || c === x.slice(0, 5));
  const softStart = exec ? softStartDays({ timeline, execPairings, planPairings, codes, answer: ctx.answer, domicile,
    snapshots: (calendarHistory?.length ? calendarHistory : calendar ? [calendar] : []).map(withoutKept), isRap, reportBefore: duty.reportBefore }) : new Set();
  ctx.softStart = (date) => softStart.has(date);

  // מגבלות החוק על התכנון (בעל המוצר, 03/10/2026). לפני החוקים, כדי ששאלת הרכב הצוות שלהן
  // תשמש גם את נחיתות הלילה.
  let crewIdOf = new Map();
  // סבב עם טיסה לבנה אפשרית: הרכב הצוות בכל הרגליים שלו לפי השאלה עליה (`whiteFlightLegs`), כי זה אותו צוות.
  const whiteIds = new Map(); // "date|flight" → מזהה השאלה על הטיסה הלבנה
  for (const rule of rulesByLogic(supported, 'white_flight')) {
    for (const { p, l, block } of whiteFlightLegs(ctx, rule.logic.params ?? {})) {
      if (block == null) continue;
      for (const x of p.legs) if (x.flight) whiteIds.set(`${x.date}|${x.flight}`, `white:${l.date}:${l.flight}`);
    }
  }
  const whiteCrewOf = (date, flight) => {
    const id = [0, -1, 1].map((k) => whiteIds.get(`${new Date(Date.parse(date) + k * 864e5).toISOString().slice(0, 10)}|${flight}`)).find(Boolean);
    return id ? whiteCrew(ctx.answer(id)?.value) : undefined;
  };
  if ((plan || exec) && domicile && rulesData.legal_limits) {
    const leave = new Set(codes.leave ?? []);
    const activity = new Set([...(codes.relevant ?? []).filter((c) => !leave.has(c)), ...(codes.ground_activity ?? [])]);
    const common = {
      limits: rulesData.legal_limits, period, plan, history, domicile, fleet,
      offsetAt: tz.offsetAt,
      classify: {
        notDuty: (c) => isLeaveCode(c, leave, codes) || isIgnoredPlanCode(c, codes),
        isActivity: (c) => !isLeaveCode(c, leave, codes) && (activity.has(c) || activity.has(expandCode(c, codes)) || c.startsWith('SIM')),
        execCodes: (day) => execCodesOf({ exec: day }, codes),
      },
      calendarStandby: cal.standby,
    };
    // מול היומן: לפי הזמנים שביומן, כמו בתכנון – בלי "הארכה בביצוע" ובלי שאלות על הרכב הצוות.
    const legal = checkLegalLimits({ ...common, ...(calendarRun ? { plan: calendarRun.plan, exec: null } : { exec }),
      answer: ctx.answer, ask: ctx.ask, crewMatters: ctx.crewMatters, whiteCrew: whiteCrewOf, softStart });
    out.legal = legal.result;
    crewIdOf = legal.crewIdOf;
    out.crewIdOf = Object.fromEntries(crewIdOf);
    // ה-FDP בזמנים המתוכננים, לצוות החוזי (`legal_crew_composition`).
    ctx.legalFdps = legal.fdps;
    // ה-FDP של התכנון, גם כשיש רומה: לצוות החוזי של טיסה שלא בוצעה (נחיתות לילה; בעל המוצר, 06/10/2026).
    let planFdps = exec ? null : legal.fdps;
    ctx.planFdps = () => (plan ? planFdps ??= checkLegalLimits({ ...common, exec: null, answer: () => null, ask: () => {} }).fdps : null);
  }
  // מזהה השאלה לפי הרגל בקובץ שנבדק; הרגל מהקובץ השני יכולה להיות רשומה ביום שלידו.
  const near = (date, k) => new Date(Date.parse(date) + k * 864e5).toISOString().slice(0, 10);
  const crewKey = (leg) => [0, -1, 1].map((k) => crewIdOf.get(`${near(leg.date, k)}:${leg.flight}`)).find(Boolean);
  ctx.legalCrewAnswer = (leg) => (crewKey(leg) ? ctx.answer(crewKey(leg)) : null);
  ctx.legalCrewAsked = (leg) => !!crewKey(leg) && out.questions.some((q) => q.id === crewKey(leg));
  ctx.isAsked = (id) => out.questions.some((q) => q.id === id);

  // יומן השינויים מהיומן המחובר (בעל המוצר, 06/10/2026; js/rules/journal.js): בתכנון לבד – השאלות על
  // השינויים (`cancelled_no_compensation`); עם הרומה – השרשרת כתשובה אחת על כל סבב מתוכנן.
  const journal = useJournal && plan && domicile ? makeJournal({ ctx, rulesData, planPairings, calendar, calendarHistory, answers, period, domicile, fleet }) : null;
  ctx.journal = journal;
  ctx.journalOpen = [];
  // שינוי תשובה על שלב מוחק גם את התשובות על השלבים שאחריו בשרשרת: הם נשאלו בזכותה.
  for (const ch of journal?.chains ?? []) {
    ch.steps.forEach((s, i) => {
      const later = ch.steps.slice(i + 1).map((x) => x.id);
      if (later.length) dependentAnswers[s.id] = [...(dependentAnswers[s.id] ?? []), ...later];
    });
    // סבב שנוסף כאילו היה בתכנון: השלבים בשרשרת שלו נשאלו בזכות התשובה עליו.
    if (ch.root) dependentAnswers[`unplanned:${ch.plan.id}`] = [...(dependentAnswers[`unplanned:${ch.plan.id}`] ?? []), ...ch.steps.map((s) => s.id)];
  }
  if (journal && mode === 'full') applyJournal(journal, { ctx, matches, execPairings, answers });
  if (mode === 'full') matches.splice(0, matches.length, ...splitSwappedElsewhere(matches, answers, dependentAnswers));
  // סבב שכל הרגליים שלו בחודש המריאו בחודש הקודם (`prevMonth`) הוא הנחיתה של סבב מהחודש הקודם, ואינו בתכנון של
  // החודש (שם היום מסומן X). הוא מופיע רק בקרדיט שבטבלת הפירוט: לא בשינויים, לא בשאלות ולא ברשימת הטיסות להחלפה
  // (בעל המוצר, 30/10/2026; טיוטה 420; LY374 מ-OPO ב-01/10/2026).
  for (const m of matches) {
    if (m.how === 'unplanned' && m.exec.legs.every((l) => l.prevMonth)) { m.how = 'carried_in'; ctx.markPairing(m.exec, 'carried_in'); }
  }
  explainByCarriedStay(matches, fdp);
  explainByActivity(matches, timeline, codes, sickCodeTest(supported), movableCodeTest(supported), reserveCodeTest(supported), ctx);
  out.changes = mergeCarriedStay(matches.map((m) => describeMatch(m, codes)), matches);
  // פעילות קרקע במקום סבב: הזיכוי עליה בא מחוק הקוד שלה. קוד שאף חוק נתמך לא מכסה – לבדיקה ידנית.
  const covered = new Set(supported.flatMap((r) => [...(r.logic.params?.plan_codes ?? []), ...(r.logic.params?.report_codes ?? [])]));
  const coveredPrefixes = supported.flatMap((r) => [...(r.logic.params?.plan_code_prefixes ?? []), ...(r.logic.params?.report_code_prefixes ?? [])]);
  const isCovered = (c) => covered.has(c) || coveredPrefixes.some((p) => c.startsWith(p));
  for (const m of matches) {
    if (m.how !== 'replaced_by_ground') continue;
    const uncovered = [...new Set(m.replacedBy.map((r) => r.code))].filter((c) => !isCovered(c));
    if (!uncovered.length) continue;
    out.reviews.push({ ruleId: null, ruleTitle: null,
      message: `${describePairing(m.plan)} הוחלף בפעילות קרקע (${uncovered.join(', ')}). ` +
        'אין חוק נתמך שקובע מה מגיע במקרה הזה. דורש בדיקה ידנית.' });
  }

  for (const logicId of LOGIC_ORDER) {
    for (const rule of rulesByLogic(supported, logicId)) {
      LOGIC[logicId](ctx, rule.logic.params ?? {}, rule);
    }
  }
  // הפיצויים היומיים על הטיסה, כל אחד עם הימים שלו, בהערות של חוקים שרצו לפניהם (`DAY_DUES`; טיוטות 395, 398).
  const logicById = new Map(supported.map((r) => [r.id, r.logic.id]));
  for (const n of out.notes.filter((x) => x.message.includes(DAY_DUES))) {
    const dues = new Map();
    for (const e of out.expectations) {
      const logic = logicById.get(e.ruleId);
      if (e.pairingId !== n.callOf || !DAY_BOUND_LOGIC.has(logic)) continue;
      const wording = DUE_WORDING[logic] ?? e.shortTitle ?? e.ruleTitle;
      if (!dues.has(wording)) dues.set(wording, new Set());
      for (const d of e.ownDays ? e.dates : [e.date]) dues.get(wording).add(d);
    }
    // לפי היום הראשון של כל אחד.
    const list = [...dues].map(([w, days]) => [w, [...days].sort()]).sort((a, b) => a[1][0].localeCompare(b[1][0]))
      .map(([w, days]) => `${w} על ${days.map(ddmm).join(' ועל ')}`);
    n.message = n.message.replace(DAY_DUES, !list.length ? '' : list.length === 1 ? ` ו${list[0]}` : `, ${list.slice(0, -1).join(', ')} ו${list.at(-1)}`);
  }
  // לוגיקה נתמכת שלא הוכנסה לסדר ההרצה היא באג, ולא חוק שמדלגים עליו בשקט.
  for (const rule of supported) {
    if (!LOGIC_ORDER.includes(rule.logic.id)) {
      out.reviews.push({ ruleId: rule.id, message: `הלוגיקה "${rule.logic.id}" אינה בסדר ההרצה. החוק לא הורץ.` });
    }
  }
  // יום שאף חוק לא קבע מה מגיע עליו אינו נעלם בשקט (`auditDays`; בעל המוצר, 18/10/2026).
  if (mode === 'full' && !calendarRun) auditDays(ctx, out, matches, execPairings, timeline);

  // אותו סבב, ביום שהסבב המתוכנן לא נגע בו (`extendedPairing` ב-js/rules/logic.js): שינוי, ולא "בוצע כמתוכנן".
  for (const c of out.changes) {
    if (c.how === 'exact' && ctx.pairingHandledBy({ id: c.execId }, 'extended')) Object.assign(c, { how: 'extended', label: 'הסבב התארך' });
  }
  attachLinkCandidates(out.questions, matches, ctx, out.assumptions);
  // טיסה עם יום חופשה שנקראת ממנו: "וביטול חופשה" בשורה שלה ב"תשובות שנשמרו" (טיוטה 391).
  out.vacationRecall = execPairings.filter((p) => ctx.pairingHandledBy(p, 'vacation_recall')).map((p) => `unplanned:${p.id}`);
  showSwaps(out, answers, assumed);
  splitChangesByFdp(out, matches, ctx, fdp);
  // טיסה לא מתוכננת בימים שתוכננה בהם פעילות שאינה סבב: הקודים בצד התכנון, ולא "—" (בעל המוצר, 21/10/2026; טיוטה 392).
  for (const c of out.changes) {
    if (c.how !== 'unplanned' || c.plan) continue;
    c.plan = plannedCodes(timeline, codes, c.date, c.lastDay ?? c.date);
    if (ctx.pairingHandledBy({ id: c.execId }, 'standby_activated')) c.label = 'הפעלה מכוננות';
    else if (c.plan && !c.label.startsWith('המשך סבב')) c.label = 'פעילות לא מתוכננת';
  }
  explainChanges(out, supported, movedActivityDays(timeline, codes, supported));
  for (const c of out.changes.filter((x) => x.carriedOver)) {
    c.notes.push({ message: c.carriedOver.length > 1 ? 'הסבבים שתוכננו בימי השהייה לא בוצעו: לא מגיע עליהם קרדיט.'
      : 'הסבב שתוכנן בימי השהייה לא בוצע: לא מגיע עליו קרדיט.', byUser: false });
  }
  if (journal && mode === 'full') chainNotes(out, journal, answers);
  if (mode === 'full') addedNotes(out, answers);
  explainCompensations(out);
  if (exec) {
    const runCompare = () => compare({ out, timeline, execPairings, tz, codes, fdp, hideCode: (d, c) => softStart.has(d) && isRap(c) });
    out.comparison = runCompare();
    if (assignFloating(out)) out.comparison = runCompare();
    explainUnexplained(out, timeline, cal, execPairings.filter((p) => ctx.pairingHandledBy(p, 'diversion_assumed')));
    out.totals = compareTotals(out, exec);
    // ימי מילואים לא מתוכננים: MILUP ברומה, בלי קרדיט – לשורת הימים בסיכום בלבד (בעל המוצר, 21/10/2026).
    out.unplannedReserveDays = Object.values(exec.days ?? {}).reduce((n, d) => n + (d.values?.MILUP?.count ?? 0), 0);
    warnMissingColumns(out, exec);
  }
  // מה שמוסבר בטבלת השינויים אינו חוזר בהערות (בעל המוצר, 01/10/2026).
  out.notes = out.notes.filter((n) => !n.placed);
  // הרכב צוות חוזי ומנוחה חוזית בין הטיסות בלי חריגה: הערה אחת; כשיש חריגה באחד מהם – נפרדות (בעל המוצר, 13/10/2026).
  const crewOk = out.notes.find((n) => n.kind === 'crew_ok');
  const restOk = out.notes.find((n) => n.kind === 'rest_ok');
  if (crewOk && restOk) {
    crewOk.message = 'כל הטיסות עומדות בהרכב צוות חוזי ובמנוחה חוזית בבסיס בין הטיסות.';
    out.notes = out.notes.filter((n) => n !== restOk);
  }
  // סדר ההערות (בעל המוצר, 09/10/2026): ההערות על החודש כולו (בלי תאריך) קודם, וויתור מלון ראשונה ביניהן
  // (`order: 'first'`); אחריהן ההערות על יום מסוים, לפי תאריך; בסוף ההערה על הרכב הצוות החוזי
  // (`order: 'last'`), ואחריה – בממשק – ההערה על מגבלות החוק. בתוך כל קבוצה לפי סדר הרצת החוקים.
  const noteRank = (n) => (n.order === 'first' ? 0 : n.order === 'last' ? 3 : n.date ? 2 : 1);
  out.notes.sort((a, b) => noteRank(a) - noteRank(b) || (a.date ?? '').localeCompare(b.date ?? ''));
  // כמה טיסות בחודש היומן מכיר (בלי קשר לשאלה על הרכב הצוות), לשורת היומן בממשק.
  // כמה טיסות יש בחודש בסך הכול (בלי DH), ליד מספר הטיסות שהרכב הצוות שלהן מהיומן.
  const opLegs = (legs) => (legs ?? []).filter((l) => l.flight && !l.dh && !l.dhd && l.type !== 'DHO' && l.type !== 'DHX');
  const monthKeys = new Set(timeline.flatMap((d) => opLegs(exec ? d.exec?.legs : d.plan?.legs).map((l) => `${d.date}|${l.flight}`)));
  out.monthFlights = monthKeys.size;
  // יום הנחיתה בבסיס לפי מזהה הסבב, כשהוא אחרי יום ה-STD של הרגל האחרונה: לתיאור הסבב ב"תשובות שנשמרו",
  // שם הסבב מתואר מהמזהה (בעל המוצר, 08/10/2026).
  out.landingDays = Object.fromEntries([...planPairings, ...execPairings].filter((p) => p.shownTo).map((p) => [p.id, p.shownTo]));
  // בתכנון לבד, מה שהיומן מראה אחרת מהתכנון: מהריצה מול היומן (`mergeCalendarRun`).
  out.calendarChanges = null;
  // שלבים שחזרו למצב שלפניהם: התשובות עליהם נמחקות מהחודש (בעל המוצר, 06/10/2026).
  // תשובה על הצי מחודש שהצי כבר בקבצים שלו (הועלה תכנון): הקבצים קובעים, והתשובה נמחקת.
  out.obsoleteAnswers = [...(journal?.obsolete ?? []), ...(fileFleet && answers[fleetId] ? [fleetId] : [])];
  out.calendarCrew = [...monthKeys].filter((k) => cal.has(k.slice(0, 10), k.slice(11))).length;
  // טיסות שבוצעו ואין ביומן הרכב הצוות שלהן, כשביומן יש טיסות מהחודש: כנראה שהיומן לא מעודכן.
  // רק טיסות שהרכב הצוות שלהן נדרש לבדיקת מגבלות החוק או הזכאות לפיצוי (`crewMatters`), ולא
  // טיסות שלפני הטווח שנקרא מהיומן (`calendar.from`). כשאין בו אף טיסה מהחודש (למשל חודש ישן שלא
  // נשמר ביומן) – הודעה אחת על החודש, ולא על כל טיסה (בעל המוצר, 04/10/2026).
  const month = `${period.year}-${String(period.month).padStart(2, '0')}`;
  const read = (k) => !calendar?.from || k.slice(0, 10) > baseTime(calendar.from, domicile)?.date;
  const matters = (k) => [0, -1, 1].some((d) => crewMatters.has(`${near(k.slice(0, 10), d)}|${k.slice(11)}`));
  out.calendarNoMonth = !!exec && monthKeys.size > 0 && !cal.hasMonth(month);
  out.calendarMissing = exec && cal.hasMonth(month)
    ? [...monthKeys].filter((k) => k.startsWith(month) && read(k) && matters(k) && !cal.has(k.slice(0, 10), k.slice(11))).sort()
      .map((k) => ({ date: k.slice(0, 10), flight: k.slice(11) }))
    : [];
  return out;
}

/**
 * Soft Start (2018 ס' 91; OMA 7.2.9; בעל המוצר, 15/10/2026): מי שקיבל הודעה על דחיית ההמראה, לפני האיסוף
 * או אחריו ולפני ההתייצבות, עובר להכן מיידי ומופעל משם לטיסה, ואין עליו קרדיט כוננות (91.4). ברומה: SBY_S
 * ביום שבתכנון אין בו כוננות מאף סוג, והרגל הראשונה ביום היא טיסה שהוצבה לפני הכוננות. כוננות שהוצבה
 * קודם והופעלה לטיסה היא הפעלה מכוננות. מה הוצב קודם:
 * 1. יומן השינויים: התמונה הראשונה שמופיעות בה ביום הזה הטיסה או כוננות – כשרק אחת מהן, היא קודמת.
 *    כוננות קודם – הפעלה מכוננות, גם כשהטיסה בתכנון (מחלה ביום הראשון של סבב, וכוננות ביום השני).
 * 2. הטיסה בתכנון המקורי באותו יום.
 * 3. סידרת אותה בעצמך: זכייה במכרז או החלפה מרצוני על הסבב המתוכנן, עם קישור אליה, או הוספה בהסכמה או
 *    החלפה מרצוני עליה. שינוי ביוזמת החברה אינו מראה מה קודם – ביטול, הצבה לכוננות והפעלה ממנה נראים
 *    ברומה אותו דבר, והסכום זהה – ולכן הוא הפעלה מכוננות.
 * אין תנאי על האיחור: גם המראה בזמן היא Soft Start. מחזירה את התאריכים.
 */
const SOFT_START_ROW_MINUTES = 15;

function softStartDays({ timeline, execPairings, planPairings, codes, answer, domicile, snapshots, isRap, reportBefore }) {
  const out = new Set();
  const on = (iso, date) => baseTime(iso, domicile)?.date === date;
  const journalFirst = (date, flight) => {
    for (const s of snapshots) {
      const f = (s.flights ?? []).some((x) => x.flight === flight && on(x.std, date));
      const sby = (s.standby ?? []).some((x) => on(x.start, date));
      if (f || sby) return f && sby ? null : f ? 'flight' : 'standby';
    }
    return null;
  };
  const own = (pairing) => ['added', 'voluntary_swap'].includes(answer(`unplanned:${pairing.id}`)?.value) ||
    planPairings.some((p) => {
      const a = answer(`cancelled:${p.id}`);
      return ['bid', 'voluntary_swap'].includes(a?.value) && a.link === pairing.id;
    });
  // שורת הכוננות ברומה מתחילה בדיוק בהתייצבות המקורית לטיסה ונמשכת דקות ספורות: הכוננות הוצבה בגלל דחיית
  // ההמראה (בעל המוצר, 30/10/2026; טיוטה 419; 07/10/2026: ‏SBY_S ‏05:00–05:01 ו-LY223 ב-06:00; כוננות רגילה רשומה
  // בשעות שלה, 22/06/2026: ‏01:50–09:00).
  const atReport = (day, leg) => leg.org === domicile && leg.std != null && (day.exec.standby ?? []).some((s) =>
    isRap(s.type ?? '') && s.std != null && s.sta != null && (s.sta - s.std + 1440) % 1440 <= SOFT_START_ROW_MINUTES &&
    s.std === (leg.std - reportBefore({ ...leg, date: day.date }) + 1440) % 1440);
  for (const day of timeline) {
    const leg = day.exec?.legs?.[0];
    if (leg?.type !== 'LEG' || !leg.flight || !execCodesOf(day, codes).some(isRap)) continue;
    if ((day.plan?.codes ?? []).some((c) => c.startsWith('SBY'))) continue;
    const first = journalFirst(day.date, leg.flight);
    const pairing = execPairings.find((p) => p.dates.includes(day.date));
    if (first ? first === 'flight' : (day.plan?.legs ?? []).some((l) => !l.dh && l.flight === leg.flight) || (pairing && own(pairing)) || atReport(day, leg)) {
      out.add(day.date);
    }
  }
  return out;
}

/**
 * הרומה בלי סכומים שנבנית מהיומן בתכנון לבד (בעל המוצר, 13/10/2026; requirements.md סעיף 5.3), או null
 * כשאין ביומן נתונים מהחודש. הטיסות בטווח שהיומן מכסה (`calendarView`) והכוננויות שבו – מהיומן; סבבי
 * התכנון שאינם נוגעים בטווח הזה, ופעילויות שאינן ביומן (קרקע, סימולטור, חופשה, מחלה) – מהתכנון, כאילו
 * בוצעו כמתוכנן. רגל ביומן שתוכננה כ-DH (אותה טיסה באותו יום) היא DH. בלי עמודות סכומים. הרגליים
 * בפורמט של הרומה: STD ו-STA בשעון כל שדה, ATD ו-ATA כמתוכנן (`legTimes` ב-js/flight-times.js).
 * `plan`: אותו דבר בפורמט של קובץ התכנון, למגבלות החוק.
 */
function calendarExec({ rulesData, plan, calendar = null, calendarHistory = null }) {
  const domicile = guessDomicile(plan);
  const view = domicile ? calendarView(withoutKept(calendar ?? calendarHistory?.at(-1) ?? null), domicile, plan.period) : null;
  if (!view) return null;
  const timeline = buildTimeline(plan.period, plan, null);
  const tz = timeZones(domicile, plan.stationOffsets ?? null, timeline);
  const touches = (p) => p.to >= view.first && p.from <= view.last;
  const planLeg = new Map(); // "date|flight" → רגל בתכנון
  for (const d of timeline) for (const l of d.plan?.legs ?? []) if (l.flight) planLeg.set(`${d.date}|${l.flight}`, { ...l, date: d.date });
  const legs = []; // {date, flight, org, dst, std, sta, dh, ac} – זמנים בדקות מוחלטות בשעון הבסיס
  for (const p of view.pairings) {
    for (const l of p.legs) {
      const pl = planLeg.get(`${l.date}|${l.flight}`);
      const plt = pl && l.staAbs == null ? legTimes(pl, tz) : null;
      const sta = l.staAbs ?? (plt?.sta != null ? l.stdAbs + (plt.sta - plt.std) : null);
      legs.push({ date: l.date, flight: l.flight, org: l.org, dst: l.dst, std: l.stdAbs, sta, dh: !!pl?.dh, ac: pl?.ac ?? null });
    }
  }
  for (const p of buildPairings(timeline, domicile, (d) => d.plan?.legs)) {
    if (touches(p)) {
      // DH בחברה אחרת (DH/LX 1487): אינו ביומן, ולכן מהתכנון, כשאין ביומן רגל באותו יום בין אותם שדות.
      for (const l of p.legs) {
        if (!l.dh || /^LY/.test(l.flight ?? '') || legs.some((x) => x.date === l.date && x.org === l.org && x.dst === l.dst)) continue;
        const t = legTimes(l, tz);
        if (t) legs.push({ date: l.date, flight: l.flight, org: l.org, dst: l.dst, std: t.std, sta: t.sta, dh: true, ac: l.ac ?? null });
      }
      continue;
    }
    for (const l of p.legs) {
      const t = legTimes(l, tz);
      if (t) legs.push({ date: l.date, flight: l.flight, org: l.org, dst: l.dst, std: t.std, sta: t.sta, dh: !!l.dh, ac: l.ac ?? null });
    }
  }
  const codes = rulesData.codes ?? {};
  const covered = (date) => date >= view.first && date <= view.last;
  const sby = (c) => /^SBY/.test(c);
  const clock = (abs, station, date) => {
    const off = tz.offsetAt(station, date) ?? 0;
    return (((abs + off) % 1440) + 1440) % 1440;
  };
  const execDays = {};
  const planDays = {};
  for (const d of timeline) {
    const own = legs.filter((l) => l.date === d.date).sort(legOrder((l) => l.std));
    // קודי התכנון בלי X (יום פנוי), ובטווח של היומן – הכוננויות מהיומן.
    const planCodes = (d.plan?.codes ?? []).filter((c) => c !== 'X' && !(covered(d.date) && sby(c)));
    const sbyCodes = covered(d.date) ? view.standby.filter((s) => s.date === d.date).map((s) => s.code) : [];
    const details = [...planCodes.map((c) => reportCodeOf(c, codes)), ...sbyCodes.map((c) => c.slice(0, 5))];
    execDays[d.date] = {
      date: d.date, day: d.day, src: null, details: details.length ? details.join(',') : null, values: {}, sims: [],
      legs: own.map((l) => ({
        type: l.dh ? 'DHO' : 'LEG', flight: l.flight, seq: null, dhd: null, dd: null, org: l.org, dst: l.dst, pos: null,
        std: clock(l.std, l.org, d.date), sta: l.sta == null ? null : clock(l.sta, l.dst, d.date),
        atd: clock(l.std, l.org, d.date), ata: l.sta == null ? null : clock(l.sta, l.dst, d.date),
        skdDur: l.sta == null ? null : l.sta - l.std, actDur: l.sta == null ? null : l.sta - l.std, occ: null,
      })),
    };
    const dayStart = Date.parse(d.date) / 60000;
    planDays[d.date] = {
      ...(d.plan ?? { date: d.date, codes: [], legs: [] }),
      codes: [...(d.plan?.codes ?? []).filter((c) => !(covered(d.date) && sby(c))), ...sbyCodes],
      legs: own.map((l) => ({ flight: l.flight, org: l.org, dst: l.dst, ac: l.ac, ...(l.dh && { dh: true }),
        dep: { min: l.std - dayStart, foreign: false }, arr: l.sta == null ? null : { min: (((l.sta - dayStart) % 1440) + 1440) % 1440, foreign: false } })),
    };
  }
  return {
    exec: { kind: 'exec', calendar: true, employee: plan.employee ?? null, period: plan.period, domicile, columns: [], missingColumns: [],
      unknownColumns: [], legColumns: [], days: execDays, totals: {}, reportTotals: {}, warnings: [] },
    plan: { ...plan, days: planDays },
  };
}

/** קוד בתכנון → הקוד ברומה: לפי `plan_to_report`, ובלעדיו חמשת התווים הראשונים, כמו בקודים המקוצרים ברומה. */
function reportCodeOf(code, codes) {
  return codes.plan_to_report?.[code] ?? code.slice(0, 5);
}

/** שאלות על השינויים: מהריצה מול היומן (`mergeCalendarRun`; בעל המוצר, 13/10/2026). */
export const CALENDAR_QUESTIONS = ['cancelled', 'unplanned', 'extended', 'second_activity', 'swap_conflict', 'standby_bid'];

/** כותרת שינוי מול הרומה → מול היומן. */
const CALENDAR_LABEL = [
  [/^הוחלף בסבב אחר באותם ימים$/, 'ביומן רשום סבב אחר באותם ימים'],
  [/^סבב מתוכנן שלא בוצע$/, 'סבב מתוכנן שאינו ביומן'],
  [/ולא בוצע$/, ' וירד מהיומן'],
  [/, ובמקומו בוצע סבב אחר$/, ', ועכשיו רשום במקומו סבב אחר'],
  [/ומה שבוצע לא היה מתוכנן$/, 'ומה שביומן לא היה מתוכנן'],
];
const PENDING_NOTE = 'ממתין לתשובה בשאלה על הסבב.';
/** התשובה על שינוי, מתחת לשורה שלו מול היומן: באותה לשון כמו ב"תשובות שנשמרו" (`ANSWER_LABEL` ב-js/app.js). */
const CALENDAR_REASON = {
  replaced: 'שינוי ביוזמת החברה', diversion: 'סטיה לשדה משנה', bid: 'זכייה במכרז', voluntary_swap: 'החלפה מרצוני או בהסכמתי',
  cancelled: 'הטיסה המקורית בוטלה ללא קרדיט', wet_lease: 'הורדה מהטיסה המקורית', trainee: 'הורדה מהטיסה המקורית',
  swap_777: 'הטיסה עברה ל-777 (לא כשיר MFF)', special_call: 'קריאה מיוחדת', added: 'הוספת טיסה בהסכמה', other: 'סיבה אחרת',
};

/**
 * מתחת לשינוי מול היומן רק הסיבה, בלי מה שמגיע: הסיבות בשרשרת מהיומן (`reasons`, `chainNotes`), או התשובה
 * על הסבב המתוכנן או על הפעילות שלא תוכננה – כשהכותרת אינה כבר אומרת אותה – או "ממתין לתשובה".
 */
function calendarReasons(c, answers) {
  const pending = (n) => n.message.startsWith('ממתין לתשובה');
  // שרשרת שעוד פתוחה, או של כמה שלבים: הסיבות לפי הסדר, חוץ ממה שהכותרת כבר אומרת.
  if (c.reasons && (c.reasons.some(pending) || c.steps?.length > 1)) return c.reasons.filter((n) => n.message !== `${c.label}.`);
  if ((c.notes ?? []).some(pending)) return [{ message: PENDING_NOTE, byUser: false }];
  const a = (c.planId && answers[`cancelled:${c.planId}`]) || (c.execId && answers[`unplanned:${c.execId}`]);
  const label = a && CALENDAR_REASON[a.value];
  if (!label || label === c.label) return [];
  return [{ message: `${label}${a.value === 'other' && a.text ? `: ${a.text}` : ''}.`, byUser: true }];
}

/**
 * בתכנון לבד עם יומן (בעל המוצר, 13/10/2026): הריצה לפי התכנון (`out`) עם מה שהריצה מול היומן (`cal`)
 * קובעת – טבלת השינויים (השורות של הרומה; מתחת לשינוי רק הסיבה, בלי מה שמגיע), מגבלות החוק לפי הזמנים
 * שביומן, והשאלות על השינויים (`CALENDAR_QUESTIONS`). הקרדיט, הפיצויים, ההערות ושאר השאלות – לפי התכנון.
 */
function mergeCalendarRun(out, cal, answers) {
  const kind = (q) => q.id.split(':')[0];
  out.questions = [...out.questions.filter((q) => !CALENDAR_QUESTIONS.includes(kind(q))), ...cal.questions.filter((q) => CALENDAR_QUESTIONS.includes(kind(q)))];
  out.calendarChanges = cal.changes.filter((c) => c.how !== 'exact' && c.how !== 'noplan').map((c) => ({
    date: c.date, to: c.to, ...(c.dates && { dates: c.dates }), how: c.how,
    label: CALENDAR_LABEL.reduce((s, [re, to]) => s.replace(re, to), c.label),
    // סבב שאינו ביומן: בצד היומן רק הסבב שהוחלף בו (או "טיסה בחודש אחר"), ולא מה שמגיע לפי התשובה.
    plan: c.plan, planId: c.planId ?? null, calendar: c.how === 'cancelled' && !LINKED_VALUES.includes(answers[`cancelled:${c.planId}`]?.value) ? null
      : c.exec ?? (c.replacedBy?.join(', ') || null),
    notes: calendarReasons(c, answers), ...(c.steps && { steps: c.steps }),
  }));
  out.legal = cal.legal;
  for (const [id, list] of Object.entries(cal.dependentAnswers)) out.dependentAnswers[id] = [...new Set([...(out.dependentAnswers[id] ?? []), ...list])];
  out.obsoleteAnswers = cal.obsoleteAnswers;
  out.landingDays = { ...cal.landingDays, ...out.landingDays };
  return out;
}

/**
 * יומן השינויים של החודש (בעל המוצר, 06/10/2026; js/rules/journal.js): מהתמונות שנשמרו מהיומן לפני
 * הרומה, ובלעדיהן מהיומן עצמו. אותו סבב בין שתי תמונות – אותן טיסות, והזמן החדש עדיין ב-FDP המקורי:
 * כוננות קצרה מההתייצבות המקורית אפשרית, בלי הארכה, ולפי הצוות החוזי של ה-FDP המתוכנן (`delayFitsFdp`).
 * null – אין ביומן נתונים מהחודש.
 */
function makeJournal({ ctx, rulesData, planPairings, calendar, calendarHistory, answers, period, domicile, fleet }) {
  const snapshots = (calendarHistory?.length ? calendarHistory : calendar ? [calendar] : []).map(withoutKept);
  const views = snapshots.map((s) => calendarView(s, domicile, period)).filter(Boolean);
  if (!views.length) return null;
  const limits = rulesData.legal_limits;
  const restMin = hoursToMin(limits?.rest_hours ?? 10);
  const delayFits = (a, b, s0, s1) => {
    const legs = firstFdpLegs(b, restMin);
    const end = legs.at(-1)?.staAbs;
    if (!limits || end == null) return overlapDays(a, b);
    const ac = a.legs.find((l) => l.ac)?.ac ?? fleet;
    const report = baseReportMinutes(limits, ac);
    const crew = (a.legs[0] && contractCrewOf(ctx, a.legs[0])) ?? 'single';
    return delayFitsFdp(limits, { crew, ac, oldReport: s0 - report, newReport: s1 - report,
      end: end + (limits.post_flight_minutes ?? 0), segments: legs.length });
  };
  return buildJournal({ planPairings, views, answers, same: (a, b) => sameAssignment(a, b, delayFits) });
}

/**
 * כשהרומה מועלית: השרשרת של כל סבב מתוכנן שלא בוצע כמתוכנן היא התשובה על השאלה עליו (`reduceChain`),
 * ותשובה על סבב חדש ביומן עוברת לסבב שבוצע שהוא אותו סבב. שרשרת שנעצרה בסבב שביומן ולא ידוע מה קרה
 * בו – השאלה נשאלת עליו מול הרומה (`ctx.journalOpen`). כשהשאלה הפתוחה היא על הסבב המתוכנן עצמו, השאלה
 * הרגילה עליו נשאלת, בלי תשובה מהשרשרת.
 */
function applyJournal(journal, { ctx, matches, execPairings, answers }) {
  const byExecId = (id) => execPairings.find((p) => p.id === id) ?? null;
  const toExec = (p) => execPairings.find((e) => overlapDays(p, e, 1) && samePairing(p, e)) ?? null;
  const credit = (p) => sumSkd(p.legs) || null;
  const execAnswer = (id) => answers[`cancelled:${id}`] ?? null;
  for (const ch of journal.chains) {
    if (ch.root) { applyRootChain(ch, { ctx, matches, execPairings, answers, toExec, credit, execAnswer, byExecId }); continue; }
    const m = matches.find((x) => x.plan?.id === ch.plan.id);
    if (!m || m.how === 'exact' || m.how === 'air_return') continue;
    const eff = reduceChain(ch, { toExec, credit, execAnswer, byExecId });
    if (!eff || (eff.open && eff.open.id === ch.plan.id)) continue;
    answers[`cancelled:${ch.plan.id}`] = eff;
    if (eff.open) ctx.journalOpen.push(eff.open);
    // התשובות על השלבים שאחרי הסבב המתוכנן כבר בתוך התשובה עליו. בלעדיהן לחוקים: סבב ביומן יכול
    // להיות עם אותו מזהה כמו סבב ברומה, ותשובה עליו הייתה נראית כתשובה על הסבב שבוצע.
    for (const s of ch.steps) if (!s.node.plan && !(eff.open && s.node.id === eff.open.id)) delete answers[s.id];
    if (ch.last && !eff.open) delete answers[`cancelled:${ch.last.id}`];
  }
  // סבב שהשתנה אחרי שנוסף כאילו היה בתכנון: השרשרת שלו היא התשובה, והוא עצמו עובר לשינויים.
  for (const n of journal.unplanned) {
    if (n.step) continue;
    const a = answers[`unplanned:${n.id}`];
    const e = a && toExec(n.pairing);
    // זכייה במכרז ביומן היא טיסה שנוספה על התכנון, ומגיעה עליה קריאה מיוחדת (בעל המוצר, 06/10/2026).
    if (e && (!answers[`unplanned:${e.id}`] || e.id === n.id)) answers[`unplanned:${e.id}`] = a.value === 'bid' ? { ...a, value: 'special_call' } : a;
    // נוסף כאילו היה בתכנון ואינו ברומה: כמו סבב מתוכנן שלא בוצע, והשאלה הרגילה נשאלת עליו.
    if (n.root && !e) addAsPlanned(matches, { ...n.origin, id: n.id }, execPairings.find((x) => overlapDays(n.pairing, x)) ?? null);
  }
}

/**
 * עם הרומה, סבב שנוסף ביומן כאילו היה בתכנון (הוספה בהסכמה או זכייה במכרז) והשתנה אחר כך (בעל המוצר,
 * 06/10/2026): הוא נכנס להשוואה כאילו היה בתכנון – במקום הפעילות הלא מתוכננת שבה השרשרת נגמרת, או
 * כסבב שלא בוצע – והשרשרת שלו היא התשובה עליו, כמו בסבב מתוכנן (`addedInCalendar`).
 */
function applyRootChain(ch, { ctx, matches, execPairings, answers, toExec, credit, execAnswer, byExecId }) {
  const eff = reduceChain(ch, { toExec, credit, execAnswer, byExecId });
  for (const s of ch.steps) if (!(eff?.open && s.node.id === eff.open.id)) delete answers[s.id];
  if (ch.last && !eff?.open) delete answers[`cancelled:${ch.last.id}`];
  if (!eff) return;
  // השלב הראשון עוד פתוח: הסבב נכנס להשוואה כאילו היה בתכנון, והשאלה הרגילה נשאלת עליו, כמו על סבב
  // מתוכנן. כך גם לפני התשובה הוא בטבלת השינויים (בעל המוצר, 06/10/2026).
  if (eff.open?.id === ch.plan.id) {
    addAsPlanned(matches, ch.plan, execPairings.find((x) => overlapDays(ch.plan, x) && matches.some((m) => m.exec === x && m.how === 'unplanned')) ?? null);
    return;
  }
  if (eff.open) ctx.journalOpen.push(eff.open);
  const e = execPairings.includes(eff.endsAt) ? eff.endsAt : null;
  // זכייה במכרז שהשרשרת שלה נגמרה בטיסה שבוצעה ביום שלא תוכננה בו פעילות במקור: מגיעה עליה קריאה
  // מיוחדת, באותם ימים או ביום אחר. רק הוספה בהסכמה היא כאילו הייתה בתכנון. ימי הזכייה, בלי פעילות,
  // אינם מזכים (בעל המוצר, 06/10/2026). אחרי שינוי ביוזמת החברה מגיע בנוסף הגבוה מבין הזכייה לטיסה
  // שבוצעה (`alsoSpecialCall`: גובר על `excluded_when_special_call`), והזכייה נכנסת להשוואה כסבב שלא
  // בוצע, עם השרשרת מתחתיו; אחרת – השרשרת מתחת לטיסה שבוצעה (`movedTo`, `chainNotes`).
  if (e && answers[`unplanned:${ch.plan.id}`]?.value === 'bid' && matches.some((x) => x.exec === e && x.how === 'unplanned')) {
    answers[`unplanned:${e.id}`] ??= { value: 'special_call' };
    if (['replaced', 'bid', 'diversion'].includes(eff.value)) {
      addAsPlanned(matches, ch.plan, null);
      answers[`cancelled:${ch.plan.id}`] = { ...eff, alsoSpecialCall: true };
    } else {
      ch.movedTo = e.id;
    }
    return;
  }
  addAsPlanned(matches, ch.plan, e);
  answers[`cancelled:${ch.plan.id}`] = eff;
}

/**
 * סבב שנוסף ביומן כאילו היה בתכנון, בהשוואה לרומה: במקום הפעילות הלא מתוכננת `exec` כשהיא כזאת,
 * ובלעדיה כסבב שלא בוצע.
 */
function addAsPlanned(matches, pairing, exec) {
  const plan = { ...pairing, addedInCalendar: true };
  const i = exec ? matches.findIndex((x) => x.exec === exec && x.how === 'unplanned') : -1;
  if (i >= 0) matches[i] = { plan, exec, how: 'dates' };
  else matches.push({ plan, exec: null, how: 'cancelled' });
  matches.sort((a, b) => (a.plan ?? a.exec).from.localeCompare((b.plan ?? b.exec).from));
}

/**
 * עם הרומה: מתחת לשינוי של סבב מתוכנן שהשתנה ביומן – השלבים של השרשרת, כל אחד עם התשובה עליו
 * (`note`, `askJournal` ב-js/rules/logic.js). כשהשלב האחרון עוד פתוח – "ממתין לתשובה".
 */
function chainNotes(out, journal, answers) {
  const chained = new Set();
  for (const c of out.changes) {
    // זכייה במכרז שעברה ליום אחר (`applyRootChain`): השרשרת מתחת לטיסה שבוצעה.
    // שורת "במקום סבב שתוכנן בימים אחרים" (`showSwaps`, סבב בחודש אחר): אין סבב מתוכנן לשרשרת.
    if (c.how === 'swap' && !c.merged) continue;
    const moved = !c.planId && c.execId && journal.chains.find((x) => x.movedTo === c.execId);
    const ch = moved || (c.planId && journal.chains.find((x) => x.plan.id === c.planId));
    const eff = moved ? { chain: true } : ch && answers[`cancelled:${c.planId}`];
    if (!eff?.chain) continue;
    const root = ch.root && journal.unplanned.find((n) => n.id === ch.plan.id);
    const view = chainView(ch, root);
    // בצד התכנון כל השרשרת, ובצד הביצוע רק מה שבוצע בסוף (בעל המוצר, 06/10/2026): הסבב האחרון ביומן
    // נכנס לשרשרת רק כשהוא אינו מה שבוצע – מספרי טיסה אחרים. באותם מספרי טיסה ובתאריכים אחרים (נחיתה
    // באיחור אחרי חצות) – רק בפירוט שבלחיצה (בעל המוצר, 18/10/2026; מרץ 2026: DME ‏11/03 → FRA ‏10–11/03,
    // ו-LY860 נחתה ב-12/03). אותו סבב: אותו מסלול ואותה טיסה ראשונה, גם כשהחזרה בוצעה בטיסה אחרת
    // (טיוטה 380; 22/03/2026 CDG: ביומן LY519/LY520, ברומה LY519/430 – DH בחברה אחרת).
    const path = ch.steps.map((s) => describePairing(s.fromPairing));
    const end = ch.last?.pairing ? describePairing(ch.last.pairing) : null;
    const keyOf = (t) => [...(t ?? '').matchAll(/([A-Z]{3}(?:-[A-Z]{3})+) \(([^()/]*)/g)].map((x) => `${x[1]} ${x[2]}`).join('+');
    const sameFlights = end && end !== c.exec && keyOf(end) && keyOf(end) === keyOf(c.exec);
    if (end && end !== c.exec && !sameFlights) path.push(end);
    if (!moved) c.plan = path.join(' ← '); // בטקסט עברי החץ שמאלה (טיוטה 381)
    // בפירוט שבלחיצה כל השרשרת: בשלב האחרון גם מה שבוצע, כשמספרי הטיסה בו שונים מהסבב האחרון ביומן
    // (22/03/2026: CDG ‏LY519/LY520 ← LY519/430), ובלי סיבה שהיא כבר הכותרת (בעל המוצר, 18/10/2026, טיוטה 381).
    const flightsOf = (t) => [...(t ?? '').matchAll(/\(([^()]*)\)/g)].map((x) => x[1]).join('+');
    const tail = sameFlights && flightsOf(end) !== flightsOf(c.exec) ? ` ← ${c.exec}` : '';
    const steps = view.steps.map((s, i) => {
      const [, head, why] = s.message.match(/^(⁦[^⁩]*⁩(?: (?:← |ו-)⁦[^⁩]*⁩)*)(?:: (.*))?$/) ?? [];
      if (head == null) return s;
      const own = why && why.replace(/\.$/, '') !== c.label ? `: ${why}` : '';
      return { ...s, message: `${head}${i === view.steps.length - 1 ? tail : ''}${own}` };
    });
    // הפירוט רק כשהוא מוסיף על השורה: כמה שלבים, או מה שבוצע במספרי טיסה אחרים. תאריכים אחרים באותן
    // טיסות אינם פותחים אותו (11/03/2026 DME ← FRA; בעל המוצר, 18/10/2026, טיוטה 382).
    if (steps.length > 1 || tail || root || moved) c.steps = steps;
    // מתחת לשורה רק הסיבה, ומה שמגיע עליה; כשהיא כבר הכותרת של השורה, או בראש ההערה על מה שמגיע
    // ("החלפה מרצוני או בהסכמתי: לא מגיע קרדיט על היום הזה."), – רק מה שמגיע (בעל המוצר, 07/10/2026; 21/07/2026 ATH).
    const norm = (t) => t.replace(/\.$/, '');
    const said = view.reason && (c.notes ?? []).some((n) => norm(n.message) === norm(view.reason) || norm(n.message).startsWith(`${norm(view.reason)}:`));
    const reason = view.reason && view.reason !== `${c.label}.` && !said ? [{ message: view.reason, byUser: true }] : [];
    c.notes = eff.value === 'chain_open' ? [...reason, { message: 'ממתין לתשובה בשאלה על הסבב.', byUser: false }] : [...reason, ...(c.notes ?? [])];
    // מול היומן מתחת לשורה רק הסיבות (`calendarReasons`), גם כשהכותרת כבר אומרת אותן.
    c.reasons = eff.value === 'chain_open' ? [...(view.reason ? [{ message: view.reason, byUser: true }] : []), { message: 'ממתין לתשובה בשאלה על הסבב.', byUser: false }]
      : view.reason ? [{ message: view.reason, byUser: true }] : [];
    chained.add(c);
  }
  // סבב שנוסף ביומן אינו בתכנון, גם כשהוא נכנס להשוואה כאילו היה בו (בעל המוצר, 06/10/2026): בצד
  // התכנון "—" לפניו, ומתחת לשורה התשובה על ההוספה, לפני מה שמגיע.
  for (const c of out.changes) {
    const root = c.planId && journal.unplanned.find((n) => n.root && n.id === c.planId);
    if (!root || !c.plan) continue;
    c.plan = `— ← ${c.plan}`;
    if (!chained.has(c) && root.note) c.notes = [{ message: `${root.note}.`, byUser: true }, ...(c.notes ?? [])];
  }
}

/**
 * פעילות לא מתוכננת שנענתה "הוספת טיסה בהסכמה": שינוי מהתכנון, גם כשאין עליה קריאה מיוחדת, ולכן
 * התשובה בראש מה שמתחת לשורה (בעל המוצר, 06/10/2026; 26/08/2026 ATH).
 */
function addedNotes(out, answers) {
  for (const c of out.changes) {
    if (c.how !== 'unplanned' || answers[`unplanned:${c.execId}`]?.value !== 'added' || !c.notes?.length) continue;
    const [first, ...rest] = c.notes;
    if (first.message.startsWith('הוספת טיסה בהסכמה')) continue;
    c.notes = [{ ...first, message: `הוספת טיסה בהסכמה: ${first.message}`, byUser: true }, ...rest];
  }
}

/**
 * שרשרת השינויים ביומן בטבלת השינויים (בעל המוצר, 06/10/2026): `reason` – מתחת לשורה, רק הסיבות לפי
 * הסדר, בלי הסבבים, שכבר בשורה (`reason` של השלב ב-`stepNote`); `steps` – הפירוט שנפתח בלחיצה על
 * השורה: כל שלב עם הסבבים שלו והתשובה עליו.
 */
function chainView(ch, root) {
  const reasons = [root?.note, ...ch.steps.map((s) => s.reason)].filter(Boolean);
  return {
    reason: reasons.length ? `${reasons.join(', ואחר כך ')}.` : null,
    steps: [...(root?.note ? [{ message: `${describePairing(ch.plan)}: ${root.note}.`, byUser: true }] : []),
      ...ch.steps.filter((s) => s.note).map((s) => ({ message: `${s.note}.`, byUser: !!s.answer }))],
  };
}

/**
 * ההשלמות מהיומן שנוגעות לחודש, לשמירה ברשומה שלו (בעל המוצר, 04/10/2026): כך הן נשארות גם אחרי
 * ניתוק היומן. יומיים לפני החודש ואחריו, כי היום של רגל נקבע בשעון הבסיס. null – אין יומן.
 */
export function monthCalendar(facts, period) {
  if (!facts) return null;
  // `from`: תחילת הטווח שנקרא מהיומן. טיסה שלפניה אינה חסרה ביומן, אלא לא נקראה.
  const range = facts.from ? { from: facts.from } : {};
  const from = Date.UTC(period.year, period.month - 1, 1) - 2 * 864e5;
  const to = Date.UTC(period.year, period.month, 1) + 2 * 864e5;
  const inMonth = (iso) => { const t = Date.parse(iso); return t >= from && t < to; };
  // `owner`: מספר העובד של בעל היומן (`calendarOwner` ב-js/calendar.js), כדי לדעת אחר כך מאיזה יומן זה נשמר.
  return { flights: (facts.flights ?? []).filter((f) => inMonth(f.std)), standby: (facts.standby ?? []).filter((s) => inMonth(s.start)), ...range,
    ...(facts.owner && { owner: facts.owner }) };
}

const crewClass = (pilots) => (pilots >= 4 ? 'double' : pilots === 3 ? 'augmented' : 'single');

/**
 * חודש שנשמר לפני 06/10/2026 יכול להחזיק טיסות שירדו מהיומן, עם הרכב הצוות שהיה רשום בהן (`kept`).
 * הן אינן נקראות: טיסה שלא בוצעה מקבלת את הצוות החוזי, וטיסה שבוצעה נמצאת ביומן המעודכן (בעל המוצר,
 * 06/10/2026).
 */
function withoutKept(calendar) {
  return calendar?.flights?.some((f) => f.kept) ? { ...calendar, flights: calendar.flights.filter((f) => !f.kept) } : calendar;
}

/**
 * פערים בהרכב הצוות בין היומן המעודכן לבין מה שכבר שמור בחודש הפתוח (בעל המוצר, 04/10/2026):
 * - `changed` / `removed`: טיסה של החודש שהרכב הצוות שלה ביומן השמור (`prev`) שונה ביומן המעודכן, או שאינה בו.
 *   כשביומן המעודכן אין אף טיסה של החודש (למשל, החודש מחוץ לטווח שנקרא) – לא משווים.
 * תשובות של המשתמש שהיומן עונה עליהן: `crewAnswersInCalendar`.
 */
export function calendarGaps({ prev, fresh, domicile, period }) {
  if (!domicile || !fresh) return [];
  const month = `${period.year}-${String(period.month).padStart(2, '0')}`;
  const crewOf = (cal) => {
    const m = new Map();
    for (const f of cal?.flights ?? []) {
      const t = f.pilots >= 2 ? baseTime(f.std, domicile) : null;
      if (t && t.date.slice(0, 7) === month) m.set(`${t.date}|${f.flight}`, crewClass(f.pilots));
    }
    return m;
  };
  const gaps = [];
  const before = crewOf(withoutKept(prev));
  const after = crewOf(fresh);
  if (after.size) {
    for (const [k, was] of before) {
      const [date, flight] = k.split('|');
      if (!after.has(k)) gaps.push({ kind: 'removed', date, flight, before: was });
      else if (after.get(k) !== was) gaps.push({ kind: 'changed', date, flight, before: was, after: after.get(k) });
    }
  }
  return gaps.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * תשובות של המשתמש על הרכב הצוות (`crew:`, ‏`night_crew:`, ‏`white:`) שהיומן של החודש עונה עליהן, חוץ
 * ממה שב-`ignored` (שאלות שהמשתמש כבר החליט בהן מול היומן). האפליקציה שואלת אם לעדכן אותן מהיומן
 * (בעל המוצר, 04/10/2026). `calendar`: היומן ששמור בחודש. `differs`: היומן עונה אחרת.
 */
export function crewAnswersInCalendar({ calendar, answers = {}, domicile, period, ignored = [] }) {
  if (!domicile || !calendar?.flights?.length) return [];
  const month = `${period.year}-${String(period.month).padStart(2, '0')}`;
  const cal = calendarFacts(withoutKept(calendar), domicile);
  const out = [];
  for (const [id, a] of Object.entries(answers)) {
    const m = /^(?:crew|night_crew|white):(\d{4}-\d{2}-\d{2}):/.exec(id);
    const c = m && m[1].slice(0, 7) === month && !ignored.includes(id) ? cal.answer(id) : null;
    if (c) out.push({ id, date: m[1], answer: a.value, calendar: c.value, differs: c.value !== a.value });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * כל השאלות על הרכב הצוות שהיומן יכול לענות עליהן במקום `id`: שאלת מגבלות החוק של ה-FDP שלו
 * (`crew:`), ושאלות נחיתות הלילה והטיסה הלבנה של כל טיסה בו, גם ביום שליד. התשובה לאחת משמשת את
 * האחרות, ולכן החלטה של המשתמש על אחת מהן חלה על כולן (`reopen`; בעל המוצר, 04/10/2026). `crewIdOf`: מהתוצאה.
 */
export function relatedCrewIds(id, crewIdOf = {}) {
  const m = /^(crew|night_crew|white):(\d{4}-\d{2}-\d{2}):(.+)$/.exec(id);
  if (!m) return [id];
  const near = (date, k) => new Date(Date.parse(date) + k * 864e5).toISOString().slice(0, 10);
  const chain = m[1] === 'crew' ? id : [0, -1, 1].map((k) => crewIdOf[`${near(m[2], k)}:${m[3]}`]).find(Boolean);
  const flights = chain ? Object.keys(crewIdOf).filter((k) => crewIdOf[k] === chain) : [];
  const ids = new Set([id, ...(chain ? [chain] : [])]);
  for (const [date, flight] of [[m[2], m[3]], ...flights.map((k) => [k.slice(0, 10), k.slice(11)])]) {
    for (const k of [0, -1, 1]) for (const kind of ['night_crew', 'white']) ids.add(`${kind}:${near(date, k)}:${flight}`);
  }
  return [...ids];
}

/**
 * השלמות מהיומן (רשות; בעל המוצר, 03/10/2026), בשעון הבסיס. היומן משלים רק מה שאינו בקבצים:
 * - `answer(id)`: שאלות הרכב הצוות (`crew:`, `night_crew:`, `white:`) לפי מספר הטייסים בטיסה:
 *   2 – בודד, 3 – מוגבר, 4 ומעלה – כפול. התשובה מסומנת `source: 'calendar'`.
 * - `standby(date, code)`: שעות כוננות שאינה בתכנון, לפי חמשת התווים הראשונים של הקוד.
 * - `firstDay(date)`: טיסה ביומן ביום הראשון של החודש: null – אין; `carried` – היא חלק מסבב שיצא
 *   בחודש הקודם (הטיסה הראשונה ביום אינה יוצאת מהבסיס, או שהטיסה שלפניה לא חזרה אליו).
 */
function calendarFacts(calendar, domicile) {
  const crew = new Map(); // "date|flight" → מספר הטייסים
  const standby = [];
  for (const f of calendar?.flights ?? []) {
    const t = f.pilots >= 2 && domicile ? baseTime(f.std, domicile) : null;
    if (t) crew.set(`${t.date}|${f.flight}`, f.pilots);
  }
  for (const s of calendar?.standby ?? []) {
    const a = domicile ? baseTime(s.start, domicile) : null;
    const b = domicile ? baseTime(s.end, domicile) : null;
    if (a && b) standby.push({ code: s.code, date: a.date, start: a.abs, end: b.abs });
  }
  const near = (date, k) => new Date(Date.parse(date) + k * 864e5).toISOString().slice(0, 10);
  const legs = (calendar?.flights ?? []).map((f) => ({ ...f, t: domicile ? baseTime(f.std, domicile) : null }))
    .filter((f) => f.t).sort((a, b) => a.std.localeCompare(b.std));
  // הרגל בקובץ יכולה להיות רשומה ביום שליד היום שלה בשעון הבסיס.
  const find = (map, date, flight) => [0, -1, 1].map((k) => `${near(date, k)}|${flight}`).find((k) => map.has(k));
  const parse = (id) => /^(crew|night_crew|white):(\d{4}-\d{2}-\d{2}):(.+)$/.exec(id);
  const valueOf = (kind, pilots) => (kind === 'white' ? (pilots >= 3 ? 'yes' : 'no') : crewClass(pilots));
  return {
    firstDay(date) {
      const i = legs.findIndex((f) => f.t.date === date);
      if (i < 0) return null;
      const prev = legs[i - 1];
      const carried = legs[i].org !== domicile || (!!prev && prev.t.date >= near(date, -2) && prev.dst !== domicile);
      return { carried, flight: legs[i].flight };
    },
    answer(id) {
      const m = parse(id);
      if (!m) return null;
      const key = find(crew, m[2], m[3]);
      return key ? { value: valueOf(m[1], crew.get(key)), source: 'calendar' } : null;
    },
    // האם היומן מכיר את הטיסה, בלי קשר לשאלה על הרכב הצוות.
    has: (date, flight) => !!find(crew, date, flight),
    // האם ביומן יש טיסות מהחודש ("YYYY-MM"), גם בלי הרכב צוות.
    hasMonth: (month) => legs.some((f) => f.t.date.startsWith(month)),
    standby: (date, code) => standby.find((s) => s.date === date && s.code.slice(0, 5) === code.slice(0, 5)) ?? null,
  };
}

// ---------- ctx: מה שהלוגיקות רואות ----------

function makeContext({ out, timeline, domicile, codes, holidays, answers, plan, exec, supported, matches, planPairings, period, fleet, position = null, execPairings, fdp, tz, assumed, assumedIgnored = [], reportDays = [], calendarAnswer, calendarFirstDay, calendarRun = false }) {
  const absenceBy = new Map(); // date → Set(ruleId)
  const pairingTags = new Map(); // pairing.id → Set(tag)
  const askedIds = new Set();
  const noteKeys = new Set();
  const reviewKeys = new Set();
  const ruleRef = (rule) => ({ ruleId: rule.id, ruleTitle: rule.title, ...(rule.short_title && { shortTitle: rule.short_title }),
    ...(rule.short_title_plural && { shortTitlePlural: rule.short_title_plural }) });
  const linkedSwap = (prefix, pairingId) => {
    const hit = Object.entries(answers).find(([id, a]) =>
      id.startsWith(prefix) && LINKED_VALUES.includes(a.value) && a.link === pairingId);
    if (!hit) return null;
    // תשובה מהשרשרת ביומן (`reduceChain`): גם מה שהיא קובעת מעבר לערך – הסבב הגבוה, הספירה לס' 40.
    const { chain, count, countLink, basis, lostOn, endsAt } = hit[1];
    return { value: hit[1].value, via: hit[0], ...(chain && { chain, count, ...(countLink !== undefined && { countLink }), basis, lostOn, endsAt }) };
  };

  const planRanges = plan ? buildPairings(timeline, domicile, (d) => d.plan?.legs) : [];
  const leave = new Set(codes.leave ?? []);
  const activityCodes = new Set([...(codes.relevant ?? []).filter((c) => !leave.has(c)), ...(codes.ground_activity ?? [])]);

  return {
    timeline,
    execPairings,
    planPairings,
    matches,
    domicile,
    period,
    fleet,
    /** התפקיד בקבצים (CP, ‏FO), null כשאינו בהם. */
    position,
    /** הגדרת ה-FDP של הסליפ הקצר (מנוחה חוקית, זמן התייצבות), null בלי הפרמטרים שלה. */
    fdp,
    monthFirst: timeline[0].date,
    /** ימי חג לפי שנה (`holidays` ב-rules.json). */
    holidays: (year) => holidays[String(year)] ?? null,
    stationOffsets: plan?.stationOffsets ?? null,
    planSummary: plan?.summary ?? null,
    hasExec: !!exec,
    hasPlan: !!plan,
    // בתכנון לבד, מול הרומה שנבנתה מהיומן (`calendarExec`): השאלות בנוסח של היומן ובלי סכומים (בעל המוצר, 13/10/2026).
    calendarRun,
    // תשובת המשתמש, ובלעדיה – השלמה מהיומן, אם חובר.
    answer: (id) => answers[id] ?? calendarAnswer?.(id) ?? null,
    // מה היומן מראה ב-1 לחודש (`calendarFacts`).
    calendarFirstDay: (date) => calendarFirstDay?.(date) ?? null,
    /** תשובה על סבב מתוכנן שהאפליקציה מניחה בלי לשאול, כי הדוח כבר זיכה: לשורת השינוי ולהערה עליו. */
    assumeAnswer(pairing, value) {
      assumed.set(pairing.id, [...new Set([...(assumed.get(pairing.id) ?? []), value])]);
    },
    /**
     * תשובה שהאפליקציה מניחה בלי לשאול, כי הרומה כבר זיכתה: `{ value }`, ושורה ב"תשובות שנשמרו" עם "שנה"
     * (`out.assumptions`; בעל המוצר, 17/10/2026, טיוטה 365). null כשהמשתמש ביטל את ההנחה (`assumedIgnored`):
     * החוק שואל כרגיל, כאילו הרומה לא זיכתה. `label`: התשובה, כפי שהיא בשאלה. `why`: על מה ההנחה נשענת, כשזו
     * אינה הרומה שזיכתה ("ברומה רשום מילואים בימי הסבב"; טיוטה 405).
     */
    assume(id, value, label, why) {
      if (assumedIgnored.includes(id)) return null;
      if (!out.assumptions.some((a) => a.id === id)) out.assumptions.push({ id, value, label, ...(why ? { why } : {}) });
      return { value, assumed: true };
    },
    /** האם המשתמש ביטל את ההנחה על השאלה (`assume`). */
    assumeIgnored: (id) => assumedIgnored.includes(id),

    /** השם העברי של קוד (`codes.labels`; טיוטה 403): `codeName` – השם או הקוד, `codeLabel` – הרשומה (`feminine`) או null. */
    codeName: (code) => codeName(code, codes),
    codeLabel: (code) => codeLabel(code, codes),
    codeNames: (list) => codeNames(list, codes),

    /** קודי פעילות ביום (קרקע, סימולטור, כוננות), בלי היעדרות, הערות ו-DUM. לפי הדוח כשיש. */
    activityCodes(day, fromPlan = false) {
      const list = exec && !fromPlan ? execCodesOf(day, codes) : (day.plan?.codes ?? []);
      return list.filter((c) => !isLeaveCode(c, leave, codes) && !isIgnoredPlanCode(c, codes) &&
        (activityCodes.has(c) || activityCodes.has(expandCode(c, codes))));
    },

    expect(date, key, min, rule, note, extra) {
      if (!min) return;
      out.expectations.push({ date, dates: [date], key, min, note, ...ruleRef(rule), ...extra });
    },
    expectPairing(pairing, key, min, rule, note, extra) {
      if (!min) return;
      out.expectations.push({ date: pairing.from, dates: [...pairing.dates], pairingId: pairing.id,
        pairing: describePairing(pairing), key, min, note, ...ruleRef(rule), ...extra });
    },
    /** ציפייה של סבב שנרשמת ביום מסוים (הקרדיט של כל יממה בסבב). */
    expectPairingDay(pairing, date, key, min, rule, note, extra) {
      if (!min && !extra?.creditNote) return;
      out.expectations.push({ date, dates: [date], pairingId: pairing.id,
        pairing: describePairing(pairing), key, min, note, ...ruleRef(rule), ...extra });
    },
    /**
     * קוד שאינו ב-`rules.json`, ומה שהמשתמש ענה עליו. גם קוד שהקוד מזהה לפי קידומת
     * (SBY_X הוא כוננות, בלי שידוע מה מגיע עליו) נרשם כאן, כדי שאפשר יהיה לעדכן את
     * האפליקציה לפיו (בקשת בעל המוצר, 23/09/2026). הקוד בדוח מקוצר ל-5 תווים, ולכן ההשוואה לשני הכיוונים.
     */
    explainCode(code, dates, text) {
      const same = (a, b) => a === b || a === b.slice(0, 5) || b === a.slice(0, 5);
      const hits = out.unknownCodes.filter((u) => same(u.code, code));
      if (hits.length) {
        for (const u of hits) u.answer = text;
        return;
      }
      const days = dates.map((d) => dayOf(timeline, d)).filter(Boolean);
      const inPlan = days.some((d) => (d.plan?.codes ?? []).some((c) => same(c, code)));
      const inExec = days.some((d) => execCodesOf(d, codes).some((c) => same(c, code)));
      out.unknownCodes.push({ code, where: inPlan && inExec ? 'both' : inExec ? 'exec' : 'plan', dates: [...dates], answer: text,
        report: days.map((d) => ({ date: d.date, text: reportedCells(d) })).filter((r) => r.text) });
    },
    expectFlag(date, column, count, rule) {
      out.flags.push({ date, column, count, ...ruleRef(rule) });
    },
    expectTab(date, min, rule) {
      out.tabs.push({ date, min, ...ruleRef(rule) });
    },
    markAbsence(date, ruleId) {
      if (!absenceBy.has(date)) absenceBy.set(date, new Set());
      absenceBy.get(date).add(ruleId);
    },
    /** שינוי שאינו סבב (יום כוננות שאינו ברומה, `standbyMissing`), עם מה שמתחתיו, במקום שלו לפי התאריך. */
    addChange(row) {
      const i = out.changes.findIndex((c) => c.date > row.date);
      out.changes.splice(i < 0 ? out.changes.length : i, 0, row);
    },
    isAbsenceBy: (date, ruleId) => absenceBy.get(date)?.has(ruleId) ?? false,
    execCodes: (day) => execCodesOf(day, codes),
    /** ימים ללא פעילות בתכנון מול המינימום בהסכם, לסיכום החודשי. */
    setFreeDays(v) { out.freeDays = v; },
    /** האש"ל הצפוי בחודש, לשורה התחתונה בסיכום: שעות טיסה ושהייה, ימי ויתור מלון וסה"כ בדולרים. */
    setPerDiem(v) { out.perDiem = v; },
    /** קודים בתכנון שאינם היעדרות, הערה או DUM: פעילות, וגם קוד לא מוכר (לא מניחים שהוא יום פנוי). */
    planActivityCodes: (day) => (day.plan?.codes ?? []).filter((c) => !isLeaveCode(c, leave, codes) && !isIgnoredPlanCode(c, codes)),
    /**
     * יום שלא תוכנן בו כלום: בלי פעילות, היעדרות או סבב – גם לא יום שהייה באמצע סבב, או נחיתה מתוכננת
     * אחרי חצות (03/08/2026 OPO, נחיתה מתוכננת 03:32 ב-04/08).
     */
    planFreeDay(date) {
      const day = dayOf(timeline, date);
      if (!day || (day.plan?.codes ?? []).some((c) => isLeaveCode(c, leave, codes) || !isIgnoredPlanCode(c, codes))) return false;
      const d0 = Date.parse(date) / 60000;
      return !planPairings.some((p) => {
        if (p.from <= date && date <= p.to) return true;
        const s = pairingTimes(p, tz);
        return (s.start ?? -Infinity) < d0 + 1440 && (s.end ?? Infinity) > d0;
      });
    },

    /**
     * האם אצ"א היה מוצב לפעילות ביום. בלי קובץ תכנון – לפי תשובת המשתמש, או null.
     * קוד שאינו מוכר מחזיר null: לא מנחשים אם הוא פעילות.
     */
    wasAssigned(date) {
      if (!plan) {
        const a = answers[`assigned:${date}`];
        return a ? a.value === 'yes' : null;
      }
      const day = plan.days[date];
      if (day?.legs?.length || day?.pickup) return true;
      if (planRanges.some((p) => p.from <= date && date <= p.to)) return true;
      let unknown = false;
      for (const code of day?.codes ?? []) {
        if (activityCodes.has(code)) return true;
        if (isLeaveCode(code, leave, codes) || isIgnoredPlanCode(code, codes)) continue;
        unknown = true;
      }
      if (!unknown) return false;
      const a = answers[`assigned:${date}`];
      return a ? a.value === 'yes' : null;
    },

    review(message, rule) {
      // שני חוקים שחולקים בדיקה (מנוחה בבסיס) מגיעים לאותה הודעה. מציגים אותה פעם אחת.
      if (reviewKeys.has(message)) return;
      reviewKeys.add(message);
      out.reviews.push({ message, ...ruleRef(rule) });
    },
    /**
     * `date` הוא null בהערה על החודש כולו, בלי יום מסוים. `extra.byUser`: ההערה מצטטת את מה
     * שהמשתמש כתב. `extra.order`: 'first' או 'last' – מקום קבוע ברשימה.
     * `extra.to`: היום האחרון, כשההערה על כמה ימים. `extra.severity`: 'warn' – הערה צהובה, כשיש מה לטפל בו (טיוטה 330).
     */
    note(date, message, rule, extra) {
      const k = `${date}|${message}`;
      if (noteKeys.has(k)) return;
      noteKeys.add(k);
      out.notes.push({ date, message, ...ruleRef(rule), ...extra });
    },
    /** הערה שכבר נרשמה על סבב ומשתנה אחרי חוק מאוחר יותר (קריאה מיוחדת על הארכה אחרי החלפה מרצוני, `extendedPairing`). */
    amendNote(pairingId, prefix, change) {
      const n = out.notes.find((x) => x.pairingId === pairingId && x.message.startsWith(prefix));
      if (n) n.message = change(n.message);
    },
    ask(question) {
      if (askedIds.has(question.id) || answers[question.id]) return;
      askedIds.add(question.id);
      // הנחה שהמשתמש ביטל (`assume`): הרומה כן מזכה, והשאלה אומרת זאת (טיוטה 365).
      if (assumedIgnored.includes(question.id) && question.body) {
        const [, text, ask] = question.body.replaceAll('הרומה לא מזכה', 'הרומה מזכה').match(/^(.*?)(\s*מה קרה\?)?$/s);
        question = { ...question, body: `${text} ביקשת לשנות את הנחת האפליקציה.${ask ?? ''}` };
      }
      out.questions.push(question);
    },

    /**
     * התשובה שרלוונטית להתאמה. החלפה מרצון שקושרה לסבב בצד השני סוגרת גם את
     * השאלה עליו, בשני הכיוונים: ביצוע לא מתוכנן ↔ תכנון שלא בוצע.
     */
    answerFor(match) {
      if (match.exec) {
        // השאלה על פעילות לא מתוכננת נשאלת רק עליה. תשובה שנשארה ממנה אחרי שהתשובה על הסבב
        // המתוכנן באותם ימים השתנתה (`splitSwappedElsewhere`) אינה חלה על ההתאמה המשותפת.
        const direct = match.how === 'unplanned' ? answers[`unplanned:${match.exec.id}`] : null;
        if (direct) return direct;
        const linked = linkedSwap('cancelled:', match.exec.id);
        if (linked) return linked;
      }
      if (match.plan) {
        const direct = answers[`cancelled:${match.plan.id}`] ?? answers[`replaced:${match.plan.id}`];
        if (direct) return direct;
        const linked = linkedSwap('unplanned:', match.plan.id);
        if (linked) return linked;
      }
      return null;
    },

    /** סבב ביצוע לפי המזהה שנבחר בקישור של תשובה. */
    pairingById: (id) => execPairings.find((p) => p.id === id) ?? null,
    pairingHandledBy: (pairing, tag) => !!pairing && (pairingTags.get(pairing.id)?.has(tag) ?? false),
    markPairing(pairing, tag) {
      if (!pairingTags.has(pairing.id)) pairingTags.set(pairing.id, new Set());
      pairingTags.get(pairing.id).add(tag);
    },

    /** קרדיט מתוכנן של סבב: ה-FT בתכנון (כבר מתוקן לאזורי זמן) ועוד רגלי DH. */
    plannedCredit(planPairing) {
      if (!plan) return null;
      return sumSkd(planPairing.legs) || null;
    },

    /** החוקים שבתוקף ונתמכים עם לוגיקה מסוימת. */
    rulesWithLogic: (logicId) => rulesByLogic(supported, logicId),

    minSlipMinutes() {
      const rule = rulesByLogic(supported, 'min_slip_credit')[0];
      return rule ? hoursToMin(rule.logic.params?.min_credit_hours) : null;
    },

    /** הימים שבהם הסבב רשום בדוח, כולל יום שהקרדיט התפצל אליו: הימים של השורה שלו בפירוט. */
    reportDates: (pairing) => reportDates(pairing, timeline, tz),

    /** ימים ברומה בלי טיסה, עם TAB, אחרי סבב שנחת לפני חצות: נשאלים (`attachReportTails`). */
    reportDays,

    /** סכום עמודה בדוח על ימי הסבב, כולל יום שהקרדיט התפצל אליו (`columnDates`). */
    reportedOn(pairing, column) {
      return columnDates(pairing, column, timeline, tz, execPairings)
        .reduce((s, date) => s + (dayOf(timeline, date)?.exec?.values?.[column]?.min ?? 0), 0);
    },

    /** מה שכבר צפוי על סבב בסוג מסוים (למשל השלמה לסליפ קצר ב-Rig), בלי החוקים שב-`except`. */
    expectedOn: (pairing, key, except = []) => out.expectations
      .filter((e) => e.pairingId === pairing.id && e.key === key && !except.includes(e.ruleId)).reduce((s, e) => s + e.min, 0),

    /** מה שצפוי על ימי הסבב בדוח: ציפיות של הסבב, וציפיות לפי תאריך שנופלות בימים שלו. */
    expectedAround(pairing, key) {
      const dates = reportDates(pairing, timeline, tz);
      return out.expectations.filter((e) => e.key === key &&
        (e.pairingId === pairing.id || (!e.pairingId && dates.includes(e.date)))).reduce((s, e) => s + e.min, 0);
    },

    /** עמודה בדוח ביום אחד, ומה שכבר צפוי באותו יום. */
    reportedOnDate: (date, column) => dayOf(timeline, date)?.exec?.values?.[column]?.min ?? 0,
    expectedOnDate: (date, key) => out.expectations
      .filter((e) => e.date === date && e.key === key).reduce((s, e) => s + e.min, 0),

    /**
     * האם הדוח כבר זיכה את הסכום על הסבב (או על היום), מעבר למה שחוקים אחרים כבר מסבירים.
     * שאלה למשתמש נשאלת רק כשהתשובה שלילית (החלטת בעל המוצר, 23/09/2026): כשהדוח זיכה
     * אין פער, ואין על מה לשאול. בלי דוח ביצוע אין מה להשוות, ולכן false.
     */
    paidOn(pairing, column, key, min, except = []) {
      if (!exec || !min) return false;
      const reported = columnDates(pairing, column, timeline, tz, execPairings)
        .reduce((s, date) => s + (dayOf(timeline, date)?.exec?.values?.[column]?.min ?? 0), 0);
      const explained = out.expectations
        .filter((e) => e.pairingId === pairing.id && e.key === key && !except.includes(e.ruleId)).reduce((s, e) => s + e.min, 0);
      return reported - explained >= min;
    },
    paidOnDate(date, column, key, min) {
      if (!exec || !min) return false;
      const reported = dayOf(timeline, date)?.exec?.values?.[column]?.min ?? 0;
      const explained = out.expectations.filter((e) => e.date === date && e.key === key).reduce((s, e) => s + e.min, 0);
      return reported - explained >= min;
    },

    capAbsenceTotal(capMin, rule) {
      const total = out.expectations.filter((e) => e.key === 'absence').reduce((s, e) => s + e.min, 0);
      if (total > capMin) {
        out.reviews.push({ message: `סך הזיכויים בחודש של היעדרות מלאה (${fmt(total)}) עובר את התקרה של ${fmt(capMin)}. הצפוי הוא התקרה.`, ...ruleRef(rule) });
      }
    },
  };
}

// ---------- מודל ----------

/**
 * רגלי התכנון, עם קרדיט לכל רגל כדי שהלוגיקות יוכלו לסכם אותו. בתכנון ה-FT מופיע
 * על הרגל האחרונה של היום בלבד, והוא הקרדיט של כל הרגליים באותו יום חוץ מ-DH.
 * רגל DH מזוכה כמו טיסה רגילה. המשך שלה מחושב בחילוץ, ואם לא הצליח – נלקח מאותה
 * רגל בדוח הביצוע.
 */
function planLegsWithCredit(day) {
  const legs = day.plan?.legs ?? [];
  if (!legs.length) return legs;
  const ft = day.plan.info?.FT ?? null;
  const lastFlown = legs.findLastIndex((l) => !l.dh);
  return legs.map((l, i) => {
    if (l.dh) {
      const reported = day.exec?.legs?.find((e) => e.flight === l.flight)?.skdDur ?? null;
      return { ...l, skdDur: l.dur ?? reported };
    }
    return { ...l, skdDur: i === lastFlown ? ft : ft == null ? null : 0 };
  });
}

/**
 * בטיסת לילה ה-FT של הסבב כולו רשום ביום הנחיתה, וביום ההמראה אין FT (05–06/05/2026).
 * לכן רגל ביום בלי FT מקבלת 0 כשיום אחר באותו סבב נושא FT. סבב שאין בו FT בכלל נשאר null.
 */
function ftOnLastDay(pairing) {
  if (!pairing.legs.some((l) => !l.dh && l.skdDur != null)) return pairing;
  return { ...pairing, legs: pairing.legs.map((l) => (!l.dh && l.skdDur == null ? { ...l, skdDur: 0 } : l)) };
}

const sumSkd = (legs) => legs.reduce((acc, l) => (acc == null || l.skdDur == null ? null : acc + l.skdDur), 0);

/** בסיס הבית בלי דוח ביצוע: שדה ההתייצבות הנפוץ בתכנון. */
function guessDomicile(plan) {
  const count = {};
  for (const d of Object.values(plan?.days ?? {})) if (d.pickup?.org) count[d.pickup.org] = (count[d.pickup.org] ?? 0) + 1;
  return Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * הצי לפי סוג המטוס ברגלי התכנון (עמודת A/C), בלי DH. סוגי משנה מאוחדים למשפחה
 * (B738 → B737, ‏B789 → B787). בלי תכנון, או כשאין סוג מטוס, נלקח `crew.fleet` מ-rules.json.
 */
/** התשובה בשאלה על הצי → הצי בחוקים. */
const FLEET_ANSWERS = { B737: 'B737', B787: 'B787', MFF: 'B787' };

/**
 * הצי מהטבלה "Domiciles and Positions" ברומה: השורה שהתאריכים שלה כוללים את החודש (בעל המוצר, 25/10/2026).
 * הטבלה מופיעה רק כשהרומה הודפסה עם פרופיל איש הצוות פתוח.
 */
function execFleet(exec, period) {
  const first = `${period.year}-${String(period.month).padStart(2, '0')}-01`;
  const last = `${first.slice(0, 8)}31`;
  const row = (exec?.positions ?? []).filter((p) => p.from <= last && p.to >= first).sort((a, b) => b.from.localeCompare(a.from))[0];
  return row ? row.fleet.replace(/^(B7[0-9])[0-9]$/, '$17') : null;
}

function fleetOf(plan) {
  const count = {};
  for (const d of Object.values(plan?.days ?? {})) {
    for (const l of d.legs ?? []) {
      if (l.dh || !l.ac) continue;
      const fleet = l.ac.replace(/^(B7[0-9])[0-9]$/, '$17');
      count[fleet] = (count[fleet] ?? 0) + 1;
    }
  }
  return Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * סבב מתוכנן שלא בוצע, אבל בימיו רשומה בדוח מחלה, כוננות או פעילות קרקע: הסיבה ידועה מהקובץ,
 * ולכן לא שואלים "מה קרה". כוננות (קוד שמתחיל ב-SBY) ומחלה (קוד שמתחיל ב-SCK, וגם SICK) אינן
 * פעילות קרקע (בעל המוצר, 27/09/2026): מחלה מתוארת "בוטל עקב מחלה", כוננות "בוטל והוצבת
 * לכוננות", ושילוב של שתיהן (21/06/2026: SCK_F ‏21/06 ואחריו SBY_S ‏22/06) מפרט את התאריך של
 * כל אחת, כדי להבחין ביניהן. פעילות קרקע שאין חוק נתמך לקוד שלה עוברת לבדיקה ידנית.
 *
 * פעילות קרקע מזוהה גם בקוד המקוצר של הרומה (CPT_B הוא CPT_BAS; 17/06/2025: TBS שהוחלף ב-CPT_B).
 * פעילות שאפשר להזיז בלי פיצוי (HOME, `moved_ok_prefixes`) אינה מסבירה למה הסבב לא בוצע, כי
 * היא יכולה לזוז לימיו גם בלי קשר אליו, ולכן השאלה נשאלת (בעל המוצר, 01/10/2026).
 *
 * מילואים (כל MIL) – כמו מחלה: "בוטל עקב מילואים", לא ביוזמת החברה. זו הנחה שניתנת לשינוי (`ctx.assume`), ואחרי
 * "שנה" נשאלת השאלה הרגילה על הסבב (בעל המוצר, 22/10/2026; טיוטה 405).
 */
function explainByActivity(matches, timeline, codes, isSick, isMovable, isReserve, ctx) {
  const groundCodes = new Set(codes.ground_activity ?? []);
  const ground = { has: (c) => !isMovable(c) && (groundCodes.has(c) || groundCodes.has(expandCode(c, codes))) };
  const reportLeave = new Set(Object.entries(codes.plan_to_report ?? {})
    .filter(([full]) => (codes.leave ?? []).includes(full)).map(([, short]) => short));
  for (const c of codes.leave ?? []) reportLeave.add(c);
  const kindOf = (code) => isStandbyCode(code) ? 'standby' : isSick(code) ? 'sick' : isReserve(code) ? 'reserve' :
    isLeaveCode(code, reportLeave, codes) ? 'leave' : ground.has(code) ? 'ground' : 'other';

  for (const m of matches) {
    if (m.how !== 'cancelled') continue;
    const found = [];
    for (const day of timeline) {
      if (day.date < m.plan.from || day.date > m.plan.to) continue;
      for (const code of execCodesOf(day, codes)) found.push({ date: day.date, code, kind: kindOf(code) });
    }
    if (!found.length) continue;
    const kinds = new Set(found.map((f) => f.kind));
    if (kinds.has('other')) continue; // קוד לא מוכר, או פעילות שאפשר להזיז: לא מסיקים ממנו, והשאלה תישאל
    const id = `cancelled:${m.plan.id}`;
    if (kinds.has('reserve') && (ctx.answer(id) || !ctx.assume(id, 'reserve', 'בוטל עקב מילואים', 'ברומה רשום מילואים בימי הסבב'))) continue;
    m.replacedBy = found;
    m.byLeave = kinds.has('leave') || kinds.has('sick') || kinds.has('reserve'); // היעדרות, מחלה או מילואים, גם כשמעורבת גם כוננות
    m.how = kinds.has('ground') ? 'replaced_by_ground'
      : kinds.has('sick') && kinds.has('standby') ? 'replaced_by_sick_standby'
      : kinds.has('sick') ? 'replaced_by_sick'
      : kinds.has('standby') ? 'replaced_by_standby'
      : kinds.size === 1 && kinds.has('reserve') ? 'replaced_by_reserve'
      : 'replaced_by_leave';
  }
}

/**
 * סבב מתוכנן שיוצא לפני שסבב מהחודש הקודם (`cutAtStart`) חזר לבסיס, או ביום הנחיתה בלי מנוחה חוקית אחריה:
 * לא היה אפשר לבצע אותו, ולכן לא שואלים מה קרה בו (`carried_over`). אין עליו קרדיט, והקריאה המיוחדת רק
 * על הימים שלא תוכנן בהם סבב (`special_call`). כך גם כשהסבב מהחודש הקודם היה בתכנון (בעל המוצר,
 * 08/10/2026; 28/02–08/03/2026 BUD, ובימיו GVA, ‏FCO ו-VCE).
 */
function explainByCarriedStay(matches, fdp) {
  for (const stay of matches.map((m) => m.exec).filter((e) => e?.cutAtStart)) {
    const landed = stay.closed ? stay.shownTo ?? stay.to : null;
    for (const m of matches) {
      const first = m.plan?.legs[0];
      if (m.how !== 'cancelled' || !first) continue;
      if (landed && first.date > landed) continue;
      if (landed && first.date === landed && !sameFdp(stay.legs.at(-1), first, fdp)) continue;
      m.how = 'carried_over';
      m.carriedBy = stay;
    }
  }
}

/**
 * הסבבים שלא בוצעו בגלל שהייה בסבב מהחודש הקודם (`explainByCarriedStay`) בשורה אחת עם הסבב הזה בטבלת
 * השינויים: בצד התכנון הם, ובצד הביצוע הסבב (בעל המוצר, 08/10/2026).
 */
function mergeCarriedStay(changes, matches) {
  const over = matches.filter((m) => m.how === 'carried_over');
  // הנחיתה של סבב מהחודש הקודם אינה שינוי (טיוטה 420).
  if (!over.length) return changes.filter((c) => c.how !== 'carried_in');
  for (const c of changes) {
    const plans = over.filter((m) => m.carriedBy.id === c.execId).map((m) => m.plan);
    if (!plans.length) continue;
    c.carriedOver = plans.map((p) => p.id);
    c.plan = [c.plan, ...plans.map(describePairing)].filter(Boolean).join(', ');
    // הסבב מהחודש הקודם היה בתכנון: הוא התארך לימים של סבבים אחרים.
    if (c.how === 'exact') Object.assign(c, { how: 'extended', label: 'הסבב התארך' });
  }
  return changes.filter((c) => c.how !== 'carried_over' && c.how !== 'carried_in');
}

/** קוד כוננות: כל קוד שמתחיל ב-SBY. כוננות אינה פעילות קרקע, גם ש-SBY_S/SBY_L ברשימת הקודים ל-`ground_activity` (בעל המוצר, 27/09/2026). */
const isStandbyCode = (code) => code.startsWith('SBY');

/** פעילות קרקע שאפשר להזיז ליום אחר בחודש בלי פיצוי: `moved_ok_prefixes` של החוקים הנתמכים (HOME). */
function movableCodeTest(supported) {
  const prefixes = supported.flatMap((r) => r.logic.params?.moved_ok_prefixes ?? []);
  return (c) => prefixes.some((p) => c.startsWith(p));
}

/** קודי מחלה (כולל מחלת בן משפחה): הקודים של חוקי זיכוי היום שמסמנים את עמודת SICK או SCKFM בדוח. */
const sickCodeTest = (supported) => flagCodeTest(supported, ['SICK', 'SCKFM']);

/** קודי מילואים: הקודים של חוקי זיכוי היום שמסמנים את עמודת MIL בדוח (טיוטה 405). */
const reserveCodeTest = (supported) => flagCodeTest(supported, ['MIL']);

/** הקודים של חוקי זיכוי היום שמסמנים בדוח אחת מהעמודות `columns`. */
function flagCodeTest(supported, columns) {
  const sick = supported.filter((r) => r.logic.id === 'absence_day_credit' &&
    [r.logic.params?.report_flag_column ?? []].flat().some((c) => columns.includes(c)));
  const exact = new Set(sick.flatMap((r) => [...(r.logic.params.plan_codes ?? []), ...(r.logic.params.report_codes ?? [])]));
  const prefixes = sick.flatMap((r) => [...(r.logic.params.plan_code_prefixes ?? []), ...(r.logic.params.report_code_prefixes ?? [])]);
  return (c) => exact.has(c) || prefixes.some((p) => c.startsWith(p));
}

/** פעילות לא מתוכננת: ביום אחד, או על פני כמה ימים עד הנחיתה בבסיס (בעל המוצר, 08/10/2026). */
const unplannedLabel = (p) => (p.carriedFrom ? 'המשך סבב מהחודש הקודם'
  : (p.shownTo ?? p.to) > p.from ? 'פעילות בימים לא מתוכננים' : 'פעילות ביום לא מתוכנן');

function describeMatch(m, codes) {
  const labels = {
    exact: 'בוצע כמתוכנן',
    dates: 'הוחלף בסבב אחר באותם ימים',
    air_return: 'חזר לבסיס אחרי היציאה והסבב לא הושלם',
    cancelled: 'סבב מתוכנן שלא בוצע',
    unplanned: 'פעילות ביום לא מתוכנן',
    noplan: 'בוצע (אין קובץ תכנון להשוואה)',
    replaced_by_leave: 'סבב מתוכנן שהוחלף בהיעדרות',
    replaced_by_ground: 'סבב מתוכנן שהוחלף בפעילות קרקע',
    replaced_by_sick: 'סבב מתוכנן שבוטל עקב מחלה',
    replaced_by_reserve: 'סבב מתוכנן שבוטל עקב מילואים',
    replaced_by_standby: 'סבב מתוכנן שבוטל והוצבת לכוננות',
    replaced_by_sick_standby: 'סבב מתוכנן שבוטל עקב מחלה והוצבת לכוננות',
  };
  // סבב שנוסף ביומן כאילו היה בתכנון (`applyRootChain`).
  const added = m.plan?.addedInCalendar ? (m.exec ? 'סבב שנוסף ביומן, ובמקומו בוצע סבב אחר' : 'סבב שנוסף ביומן ולא בוצע') : null;
  return {
    how: m.how,
    label: added ?? (m.how === 'unplanned' ? unplannedLabel(m.exec) : labels[m.how] ?? m.how),
    lastDay: m.exec ? m.exec.shownTo ?? m.exec.to : null,
    date: (m.plan ?? m.exec).from,
    // סוף הטווח בכותרת: יום הנחיתה בבסיס, המאוחר מבין המתוכנן ומה שבוצע (בעל המוצר, 21/10/2026; טיוטה 394).
    to: [m.plan, m.exec].filter(Boolean).map((p) => p.shownTo ?? p.to).sort().at(-1),
    planId: m.plan?.id ?? null,
    execId: m.exec?.id ?? null,
    plan: m.plan ? describePairing(m.plan) : null,
    exec: m.exec ? describePairing(m.exec) : null,
    replacedBy: m.replacedBy ? nameRuns(m.replacedBy, codes) : null,
  };
}

/** מה שבוצע במקום סבב, בשמות: ימים רצופים באותו שם – טווח אחד ("מחלה 13/07–14/07"; בעל המוצר, 22/10/2026; טיוטה 404). */
function nameRuns(list, codes) {
  const runs = [];
  for (const r of [...list].sort((a, b) => a.date.localeCompare(b.date))) {
    const name = codeName(r.code, codes);
    const last = runs.findLast((x) => x.name === name);
    if (last && (last.to === r.date || addDay(last.to) === r.date)) last.to = r.date;
    else runs.push({ name, from: r.date, to: r.date });
  }
  return runs.map((x) => `${x.name} ${x.from === x.to ? ddmm(x.from) : `${ddmm(x.from)}–${ddmm(x.to)}`}`);
}

/**
 * פעילות לא מתוכננת שקושרה בהחלפה (מרצון, ביוזמת החברה או בזכייה במכרז) לסבב שתוכנן בימים
 * אחרים: שורה אחת לשניהם, ביום המוקדם מבין השניים, ובראשה שני התאריכים (`dates`); הכותרת
 * היא סיבת ההחלפה, ומתחת מה שמגיע (בעל המוצר, 11/10/2026; 09/09/2024: VIE ‏08/09 ↔ SOF ‏09/09;
 * עד אז שורה לכל צד, 29/09/2026). בצד הביצוע רק הטיסה שבוצעה במקומו, בלי הסיבה לפניה (בעל המוצר,
 * 01/10/2026). פעילות שהוחלפה בסבב בחודש אחר – "במקום סבב שתוכנן בימים אחרים", ו"בחודש אחר" בצד התכנון.
 * סבב שלא בוצע ונענה – התשובה מוצגת בצד הביצוע; בהחלפה עם טיסה בחודש אחר הכותרת היא סיבת ההחלפה.
 * בלי תשובה, כשהדוח כבר זיכה והאפליקציה הניחה אותה (`assumed`, planId → ערכים), מוצגת ההנחה
 * באותה לשון (בעל המוצר, 29/09/2026).
 */
function showSwaps(out, answers, assumed) {
  const linkOf = new Map(); // execId → { planId | null, value }
  const mergedInto = new Map(); // שורת הסבב שלא בוצע → השורה המאוחדת
  for (const [id, a] of Object.entries(answers)) {
    if (!LINKED_VALUES.includes(a?.value)) continue;
    if (id.startsWith('unplanned:') && !linkOf.get(id.slice(10))?.planId) linkOf.set(id.slice(10), { planId: a.link ?? null, value: a.value });
    if (id.startsWith('cancelled:') && a.link && a.link !== GAVE_AWAY) linkOf.set(a.link, { planId: id.slice(10), value: a.value });
  }
  for (const c of out.changes) {
    if (c.how !== 'unplanned' || !linkOf.has(c.execId)) continue;
    const { planId, value } = linkOf.get(c.execId);
    const planned = out.changes.find((p) => p.how === 'cancelled' && p.planId === planId);
    c.how = 'swap';
    c.label = 'במקום סבב שתוכנן בימים אחרים';
    c.plan = planned?.plan ?? 'בחודש אחר';
    // סבב שנוסף ביומן (`addAsPlanned`), גם כשהוא באותם ימים.
    if (planned?.label.startsWith('סבב שנוסף ביומן')) c.label = 'במקום סבב שנוסף ביומן';
    if (!planned) continue;
    c.planId = planned.planId;
    c.label = DATES_OUTCOME[value] ?? c.label;
    c.merged = value;
    if (planned.date !== c.date) c.dates = [planned.date, c.date].sort();
    mergedInto.set(planned, c);
  }
  // השורה המאוחדת במקום של המוקדם מבין השניים.
  const atPlan = new Set([...mergedInto].filter(([p, c]) => p.date <= c.date).map(([, c]) => c));
  out.changes = out.changes.flatMap((p) => {
    const c = mergedInto.get(p);
    if (c) return atPlan.has(c) ? [Object.assign(c, { date: p.date })] : [];
    return atPlan.has(p) ? [] : [p];
  });

  // סבב שבמקומו בוצע סבב אחר באותם ימים: אחרי התשובה, השורה אומרת מה קרה ולא רק מה הוחלף.
  for (const c of out.changes) {
    if (c.how !== 'dates') continue;
    const a = answers[`cancelled:${c.planId}`] ?? answers[`replaced:${c.planId}`];
    if (a) c.label = DATES_OUTCOME[a.value] ?? c.label;
    else if (assumed.has(c.planId)) c.label = outcomeOf(assumed.get(c.planId), DATES_OUTCOME) || c.label;
  }

  // סבב שלא בוצע: אחרי התשובה, בצד הביצוע מה שקרה לפיה. ריק רק עד שעונים.
  for (const c of out.changes) {
    if (c.how !== 'cancelled' || c.exec) continue;
    const a = answers[`cancelled:${c.planId}`];
    if (!a) {
      if (assumed.has(c.planId)) c.exec = outcomeOf(assumed.get(c.planId), CANCELLED_OUTCOME) || null;
      continue;
    }
    const linked = a.link && out.changes.find((x) => x.execId === a.link)?.exec;
    c.exec = a.value === 'voluntary_swap' ? (a.link === GAVE_AWAY ? GAVE_AWAY_LABEL : linked ?? 'טיסה בחודש אחר')
      : a.value === 'replaced' || a.value === 'bid' ? linked ?? 'טיסה בחודש אחר'
      : a.value === 'other' ? `סיבה אחרת${a.text ? `: ${a.text}` : ''}`
      : CANCELLED_OUTCOME[a.value] ?? a.value;
    // החלפה עם טיסה בחודש אחר: הכותרת היא סיבת ההחלפה (בעל המוצר, 11/10/2026).
    if (LINKED_VALUES.includes(a.value) && a.link !== GAVE_AWAY) c.label = DATES_OUTCOME[a.value];
  }
}

/**
 * פעילות לא מתוכננת בכמה FDP נפרדים, שעל כל אחד מגיעה קריאה מיוחדת: שורה לכל FDP בשינויים,
 * ולכן גם הערה לכל אחד (בעל המוצר, 29/09/2026; 19–20/06/2025). `until` הוא היום שבו מתחיל
 * ה-FDP הבא: יממה בלי רגל שייכת ל-FDP שלפניה, כמו בספירת הקריאה המיוחדת.
 */
function splitChangesByFdp(out, matches, ctx, fdp) {
  out.changes = out.changes.flatMap((c) => {
    const m = c.how === 'unplanned' && matches.find((x) => x.exec?.id === c.execId);
    if (!m || !ctx.pairingHandledBy(m.exec, 'special_call')) return [c];
    const parts = fdpParts(m.exec, fdp);
    if (parts.length < 2) return [c];
    return parts.map((p, i) => ({ ...c, date: p.from, until: parts[i + 1]?.from ?? null, exec: describePairing(p),
      label: unplannedLabel(p), lastDay: p.shownTo ?? p.to, to: p.shownTo ?? p.to }));
  });
}

/**
 * הקודים שתוכננו בימים from–to (לא סבבים, ובלי קודים שמושמטים מהתכנון), ורצף ימים באותם קודים בטווח אחד:
 * "HOME_RGT 01/09 · VAC 02/09", "SBY 27/09–30/09". בלי קודים – null.
 */
function plannedCodes(timeline, codes, from, to) {
  // כל קוד בשם העברי שלו ("כוננות", "חופשה", "חופשה ללא תשלום"; בעל המוצר, 22/10/2026; טיוטה 403).
  const short = (c) => codeName(c, codes);
  const runs = [];
  for (const day of timeline) {
    if (day.date < from || day.date > to) continue;
    const cs = [...new Set((day.plan?.codes ?? []).filter((c) => !isIgnoredPlanCode(c, codes)).map(short))].join(', ');
    const last = runs.at(-1);
    if (cs && last?.cs === cs && last.next === day.date) Object.assign(last, { to: day.date, next: addDay(day.date) });
    else runs.push({ cs, from: day.date, to: day.date, next: addDay(day.date) });
  }
  const shown = runs.filter((r) => r.cs).map((r) => `${r.cs} ${r.from === r.to ? ddmm(r.from) : `${ddmm(r.from)}–${ddmm(r.to)}`}`);
  return shown.length ? shown.join(' · ') : null;
}

/** לוגיקות שהערה שלהן מסבירה שינוי בין התכנון לביצוע. */
const CHANGE_LOGIC = new Set(['credit_from_scheduled', 'cancelled_no_compensation', 'voluntary_swap', 'higher_of_planned_performed',
  'lost_hours_credit', 'special_call', 'training_cancelled_flight', 'standby_end_for_bid', 'standby_activation', 'vacation_recall', 'dh_activated']);
/** לוגיקות שהזיכוי שלהן הוא חלק ממה שמגיע על השינוי עצמו (ולא, למשל, נחיתה מאוחרת). */
const CHANGE_DUE_LOGIC = new Set([...CHANGE_LOGIC, 'absence_day_credit', 'min_slip_credit', 'second_unplanned_activity']);
/** ניסוח קצר של מה שמגיע בהערה על שינוי, במקום שם החוק. */
const DUE_WORDING = {
  credit_from_scheduled: 'קרדיט הטיסה',
  lost_hours_credit: 'קרדיט הטיסה המקורית',
  special_call: 'קריאה מיוחדת',
  min_slip_credit: 'השלמה לסליפ קצר',
  higher_of_planned_performed: 'קרדיט נוסף (הגבוה מבין השתיים)',
  second_unplanned_activity: 'פיצוי על פעילות שנייה באותה יממה',
};
/** פיצוי שמגיע על ימים מסוימים: מתחת לשינוי של כמה ימים – עם הימים שלו (טיוטה 395). */
const DAY_BOUND_LOGIC = new Set(['special_call', 'vacation_recall', 'second_unplanned_activity']);

/**
 * ימים שפעילות קרקע שזזה בתוך החודש (`moved_ok_prefixes`, HOME) בוצעה בהם, ולא תוכננה בהם: הזיכוי היומי
 * עליה אינו חלק ממה שמגיע על שינוי בימים האלה (בעל המוצר, 15/10/2026; HOME_RGT שזז ל-09/06/2026, ביום של FRA).
 */
function movedActivityDays(timeline, codes, supported) {
  const prefixes = supported.filter((r) => r.logic.id === 'training_cancelled_flight').flatMap((r) => r.logic.params?.moved_ok_prefixes ?? []);
  const out = new Set();
  for (const day of timeline) {
    for (const p of prefixes) {
      if (!execCodesOf(day, codes).some((c) => c.startsWith(p)) || (day.plan?.codes ?? []).some((c) => c.startsWith(p))) continue;
      if (timeline.some((d) => d.date !== day.date && (d.plan?.codes ?? []).some((c) => c.startsWith(p)))) out.add(day.date);
    }
  }
  return out;
}

/**
 * מה מגיע על כל שינוי בין התכנון לביצוע, מתחת לשורה שלו בטבלת השינויים ולא בהערות (`notes` של
 * השינוי; בעל המוצר, 01/10/2026). הערה שחוק רשם על השינוי עוברת לשם (`placed`); לשאר נבנה משפט
 * כללי: מה מגיע עליו לפי החוקים, שלא מגיע דבר, או שממתינים לתשובה.
 *
 * ההערה היא כותרת, בלי סכומים: כל סכום כתוב בטבלת הפירוט, בשורה של הטיסה או היום, והכפילות
 * מיותרת (בעל המוצר, 01/10/2026). רק מה שמגיע: לא תיאור של מה שקרה, ולא הסיבה כשהיא כבר בכותרת או
 * בצד הביצוע (בעל המוצר, 15/10/2026). `moved`: ימים של פעילות קרקע שזזה (`movedActivityDays`).
 */
function explainChanges(out, supported, moved = new Set()) {
  const logicOf = new Map(supported.map((r) => [r.id, r.logic.id]));
  const rangeOf = (id) => String(id ?? '').match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2}):/)?.slice(1) ?? null;
  for (const c of out.changes) {
    // יום כוננות שאינו ברומה: מה שמתחתיו כבר נכתב בחוק (`standbyMissing`).
    if (c.how === 'exact' || c.how === 'noplan' || c.how === 'standby_missing' || c.how === 'reserve_missing') continue;
    const ids = [c.planId, c.execId].filter(Boolean);
    const ranges = ids.map(rangeOf).filter(Boolean);
    // שורה אחת מכמה על אותו סבב (`splitChangesByFdp`): רק מה שנרשם בימים שלה.
    const own = (d) => c.until === undefined || (c.date <= d && (!c.until || d < c.until));
    const within = (d) => !!d && own(d) && ranges.some(([from, to]) => from <= d && d <= to);
    // הערה על סבב מסוים (`pairingId`) – רק בשורה שלו, גם כשסבב אחר בוצע באותם ימים.
    let ruled = out.notes.filter((n) => !n.aside && CHANGE_LOGIC.has(logicOf.get(n.ruleId)) && within(n.date) &&
      (!n.pairingId || ids.includes(n.pairingId)));
    // החלפה עם טיסה בימים אחרים, בשורה אחת (`showSwaps`): הערה אחת על מה שמגיע (בעל המוצר, 11/10/2026).
    // מרצון – זו של הטיסה שבוצעה, ולא "לא מגיע קרדיט על היום הזה" של הסבב שלא בוצע; ביוזמת החברה
    // ובמכרז – זו של הסבב המתוכנן, שכבר אומרת גם מה מגיע על הטיסה שבוצעה.
    if (c.merged) {
      const dup = (n) => (c.merged === 'voluntary_swap' ? n.pairingId === c.planId : n.pairingId === c.execId);
      for (const n of ruled.filter(dup)) n.placed = true;
      ruled = ruled.filter((n) => !dup(n));
    }
    // סטיה לשדה משנה שהנחיתה המאוחרת זיהתה (`late_landing_home`): בכותרת, גם כשהסבב לא היה מתוכנן (בעל המוצר,
    // 05/10/2026: כל סטיה מופיעה בשינויים). השדות בצד הביצוע, ומתחת לשינוי רק מה שמגיע (15/10/2026).
    const change = out.notes.filter((n) => n.change && within(n.date) && (!n.pairingId || ids.includes(n.pairingId)));
    for (const n of change) n.placed = true;
    const label = c.label;
    if (change.length && !c.label.includes(DATES_OUTCOME.diversion)) c.label = `${c.label}, עם ${DATES_OUTCOME.diversion}`;
    // מה שמגיע לפי החוקים על הסבבים `of` (בדרך כלל `ids`, השורה כולה), כמשפט קצר בלי סכומים.
    // `from`–`last`: הימים ל"קריאה מיוחדת על כל אחד מהימים".
    const rowEnd = c.until ? new Date(Date.parse(c.until) - 86400000).toISOString().slice(0, 10) : c.lastDay;
    const dueOf = (of, from = c.date, last = rowEnd) => {
      if (out.questions.some((q) => of.some((id) => q.id.endsWith(`:${id}`)))) return 'ממתין לתשובה בשאלה על הסבב';
      let items = new Set();
      // זיכוי יומי על כמה ימים: במספר המדויק וברבים ("קרדיט 2 ימי מחלה"; בעל המוצר, 07/10/2026).
      const days = new Map();
      // פיצוי שמגיע על ימים מסוימים: הימים של כל אחד (טיוטה 395).
      const dayBound = new Map();
      for (const e of out.expectations) {
        const logic = logicOf.get(e.ruleId);
        if (!CHANGE_DUE_LOGIC.has(logic)) continue;
        if (e.chainFor ? !of.includes(e.chainFor) : e.pairingId ? !of.includes(e.pairingId) || !own(e.date) : !within(e.date)) continue;
        // רשום על הטיסה הזאת, אבל שייך להחלפה של סבב מתוכנן אחר (`forPlan`): לא חלק ממה שמגיע עליה,
        // ובפירוט הוא מוצג על הטיסה שהחליפה (10/06/2026: ה-RIG ‏05:10 של ההחלפה של LTN ב-11/06).
        if (e.forPlan && !of.includes(e.forPlan)) continue;
        if (logic === 'absence_day_credit') {
          if (moved.has(e.date)) continue;
          if (!days.has(e.ruleId)) days.set(e.ruleId, { e, dates: new Set() });
          days.get(e.ruleId).dates.add(e.date);
          items.add(`absence:${e.ruleId}`);
          continue;
        }
        const wording = DUE_WORDING[logic] ?? e.shortTitle ?? e.ruleTitle;
        items.add(wording);
        if (DAY_BOUND_LOGIC.has(logic)) {
          if (!dayBound.has(wording)) dayBound.set(wording, new Set());
          for (const d of e.ownDays ? e.dates : [e.date]) dayBound.get(wording).add(d);
        }
      }
      // שורה שמשתרעת על כמה ימים, עד הנחיתה בבסיס: קריאה מיוחדת, קריאה מחופשה ופעילות שנייה – עם הימים שלהן
      // ("קריאה מחופשה על 02/09"), ועל כל ימי השורה "על כל אחד מהימים" (בעל המוצר, 08/10/2026 ו-21/10/2026; טיוטה 395;
      // ‏BCN ‏23–25/09/2026). בשורה של יום אחד – בלי תאריך.
      const rowDays = [];
      for (let d = from; last && d <= last; d = new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10)) rowDays.push(d);
      if (rowDays.length > 1 || c.dates?.length > 1) {
        // השאר במקומם, והפיצויים היומיים אחריהם לפי היום הראשון של כל אחד (טיוטה 398).
        const first = (t) => [...dayBound.get(t)].sort()[0];
        const bound = [...items].filter((t) => dayBound.has(t)).sort((a, b) => first(a).localeCompare(first(b)));
        items = new Set([...[...items].filter((t) => !dayBound.has(t)), ...bound.map((t) => {
          const set = dayBound.get(t);
          if (rowDays.length > 1 && rowDays.every((d) => set.has(d))) return `${t} על כל אחד מהימים`;
          return `${t} על ${[...set].sort().map(ddmm).join(' ועל ')}`;
        })]);
      }
      const dayWording = ({ e, dates }) => {
        const one = e.shortTitle ?? e.ruleTitle;
        if (dates.size < 2) return `קרדיט ${one}`;
        return `קרדיט ${dates.size} ${e.shortTitlePlural ?? (one.startsWith('יום ') ? `ימי ${one.slice(4)}` : `ימי ${one}`)}`;
      };
      // בלי "מגיע" בראש המשפט, כמו בהערות שהחוקים רושמים על שינוי (בעל המוצר, 01/10/2026).
      // השעות שהפסיד בהורדה מהטיסה, לצד הטיסה שבוצעה: איזו טיסה היא איזו (בעל המוצר, 15/10/2026).
      if (items.has(DUE_WORDING.lost_hours_credit) && items.delete(DUE_WORDING.credit_from_scheduled)) {
        items = new Set([`${DUE_WORDING.credit_from_scheduled} שבוצעה`, ...items]);
      }
      const list = [...items].map((t) => (t.startsWith('absence:') ? dayWording(days.get(t.slice(8))) : t));
      return list.length ? (list.length > 1 ? `${list.slice(0, -1).join(', ')} ו${list.at(-1)}` : list[0]) : 'לא מגיע קרדיט ולא פיצוי';
    };
    if (ruled.length) {
      // שם השינוי כבר בשורה שלו, ולכן הוא יורד מראש ההערה.
      // סבב שבוטל ללא קרדיט ובמקומו טיסה באותם ימים: השורה כבר אומרת שהמתוכנן לא בוצע.
      const leads = [`${label}: `, 'סבב מתוכנן שלא בוצע: ', ...(label.startsWith('חזר לבסיס') ? ['חזרה לבסיס אחרי היציאה: '] : [])];
      c.notes = ruled.flatMap((n) => {
        n.placed = true;
        const lead = leads.find((l) => n.message.startsWith(l));
        // סבב שבוטל ללא קרדיט, ובאותם ימים בוצעה טיסה: מה שמגיע עליה, לפי התשובה (בעל המוצר, 14/10/2026).
        // בלי טיסה כזאת – התשובה עצמה, כמו בשרשרת מהיומן, כדי שתמיד תהיה שורה מתחת לשינוי.
        const p = n.performed;
        const performed = p ? `על הטיסה שבוצעה: ${dueOf([p.id], p.from, p.to)}.` : '';
        const own = n.plain ? (p ? '' : `${CALENDAR_REASON.cancelled}.`) : lead ? n.message.slice(lead.length) : n.message;
        const message = [own, performed].filter(Boolean).join(' ');
        return message ? [{ message, byUser: !!n.byUser }] : [];
      });
      continue;
    }

    // קצר ובלי מספרי הטיסות, שכבר מופיעים בשינויים: רק מה מגיע או לא מגיע (בעל המוצר, 29/09/2026), בלי
    // התוצאה לפי התשובה, שכבר בצד הביצוע ("הורדה מהטיסה ביוזמת החברה"; 15/10/2026).
    c.notes = [{ message: `${dueOf(ids)}.`, byUser: false }];
  }
}

/** ציפייה שיש לה שורה משלה בטבלת הפירוט, עם הסבר: פיצוי (COM ו-S/C) ו-Rig. */
const EXPLAINED_KEYS = new Set(['com', 'sc', 'rig']);

/**
 * כל פיצוי וכל Rig מוסבר בשורה שלו, מתחת לטיסה, ולא בהערות (`explain`; בעל המוצר, 01/10/2026):
 * בטבלת הפירוט, ובתכנון לבד בטבלת הצפוי. חוק שיש לו נוסח משלו מעביר אותו בציפייה (`extra.explain`,
 * וריק כשאין מה להוסיף: קריאה מיוחדת); לשאר: ההסבר של הציפייה בלי תיאור הסבב שבראשו. הסכום
 * אינו בהסבר, כי הוא כבר בשורה, וגם לא שם החוק, שמוצג אחריו.
 */
function explainCompensations(out) {
  for (const e of out.expectations) {
    if (!EXPLAINED_KEYS.has(e.key) || e.explain != null) continue;
    // תיאור הסבב (או שני הסבבים) שבראש ההסבר מיותר: הוא כבר בשורה.
    const why = String(e.note ?? '').replace(/^\u2066[^\u2069]*\u2069(?: (?:[←→] |ו-)\u2066[^\u2069]*\u2069)*: /, '').replace(/\.$/, '');
    e.explain = why ? `${why}.` : '';
  }
}

/**
 * שיוך פיצוי חסר (בעל המוצר, 17/10/2026; `requirements.md` סעיף 11, טיוטה 364): פיצוי שאינו מוצמד לתאריך
 * (ימים ללא פעילות, שבתות ברצף) ומגיע לפי התשובה, אבל הרומה לא רשמה אותו במקום שלו (`floating`), משויך
 * לשורות בפירוט שיש בהן פיצוי לא מוסבר באותה עמודה: פיצוי אחד לשורה אחת או לכמה שורות שהסכום שלהן שווה
 * לו, או כמה פיצויים לשורה אחת בסכום שלהם. לפי סדר הציפיות (ימים פנויים לפני שבתות), ושורות מוקדמות קודם.
 * הציפייה עוברת לשורה, ובהערות ההנחה. פברואר 2026 של יונתן: COM 02:30 ב-07/02. מחזירה אם השתנה משהו.
 */
function assignFloating(out) {
  let pool = out.expectations.filter((e) => e.floating);
  if (!pool.length) return false;
  let rows = out.comparison
    .filter((r) => COMPENSATION_COLUMNS.includes(r.column) && !r.pending && r.reported > r.expected && !r.items.some((e) => e.floating))
    .map((r) => ({ row: r, min: r.reported - r.expected }));
  const columnOf = (e) => KEY_COLUMNS[e.key][0];
  const sum = (xs) => xs.reduce((s, x) => s + x.min, 0);
  // כל תת-הקבוצות עד `max` איברים, הקטנות קודם ובכל גודל לפי הסדר.
  const subsets = (xs, max) => {
    const out = [[]];
    for (const x of xs) for (const s of [...out]) if (s.length < max) out.push([...s, x]);
    return out.filter((s) => s.length).sort((a, b) => a.length - b.length);
  };
  const where = (r) => (r.row.dates.length > 1 ? `${ddmm(r.row.dates[0])}–${ddmm(r.row.dates.at(-1))}` : ddmm(r.row.dates[0]));
  const moveTo = (e, r, min = e.min) => {
    const { pairingId, pairing, monthly, floating, ...rest } = e;
    return { ...rest, min, date: r.row.dates[0], dates: [r.row.dates[0]] };
  };
  const moved = new Map(); // ציפייה → הציפיות שבמקומה
  const find = () => {
    for (const e of pool) {
      const s = subsets(rows.filter((r) => r.row.column === columnOf(e)), 4).find((rs) => sum(rs) === e.min);
      if (s) return { es: [e], rs: s };
    }
    for (const es of subsets(pool, pool.length).filter((x) => x.length > 1)) {
      const r = rows.find((x) => es.every((e) => columnOf(e) === x.row.column) && sum(es) === x.min);
      if (r) return { es, rs: [r] };
    }
    return null;
  };
  for (let m = find(); m; m = find()) {
    const { es, rs } = m;
    if (es.length === 1) moved.set(es[0], rs.map((r) => moveTo(es[0], r, r.min)));
    else for (const e of es) moved.set(e, [moveTo(e, rs[0])]);
    const amounts = rs.map((r) => `${minToHhmm(r.min)} ב-${where(r)}`);
    const one = rs.length === 1;
    const what = es.length === 1 ? `לפיצוי על ${es[0].floating}` : `לפיצויים על ${es.slice(0, -1).map((e) => e.floating).join(', ')} ועל ${es.at(-1).floating}`;
    out.notes.push({ date: rs[0].row.dates[0], ruleId: es[0].ruleId, ruleTitle: es[0].ruleTitle,
      message: `האפליקציה מניחה ש${one ? 'הזיכוי' : 'הזיכויים'} ${amounts.slice(0, -1).join(', ')}${one ? '' : ' ו-'}${amounts.at(-1)} ${one ? 'שייך' : 'שייכים'} ${what}.` });
    pool = pool.filter((e) => !es.includes(e));
    rows = rows.filter((r) => !rs.includes(r));
  }
  if (!moved.size) return false;
  out.expectations = out.expectations.flatMap((e) => moved.get(e) ?? [e]);
  return true;
}

/**
 * פיצוי שרשום ברומה ואף חוק אינו מסביר: גם הוא בשורה שלו (`notes`). שורה שממתינה לתשובה אינה ממצא עדיין.
 * כשהיומן מכיר את הטיסות בשורה, הרכב הצוות ידוע ואינו יכול להסביר את הפיצוי: "לא נמצא הסבר מתאים"
 * (בעל המוצר, 04/10/2026; 11/11/2025 DME: ‏05:00 בצוות כפול). קריאה מיוחדת על סבב שהאפליקציה הניחה בו
 * סטיה לשדה משנה (`assumeDiversion`, אותם מספרי טיסה): ההנחה נשארת, ומתחת לטיסה כתוב שהסטיה אינה
 * מזכה בקריאה מיוחדת (בעל המוצר, 06/10/2026).
 */
function explainUnexplained(out, timeline, cal, diverted) {
  const known = (dates) => dates.some((d) => (dayOf(timeline, d)?.exec?.legs ?? []).some((l) => l.flight && cal.has(d, l.flight)));
  const onDiverted = (dates) => diverted.some((p) => dates.some((d) => p.dates.includes(d)));
  for (const row of out.comparison) {
    if (!COMPENSATION_COLUMNS.includes(row.column) || row.pending || row.reported <= row.expected) continue;
    const amount = minToHhmm(row.reported - row.expected);
    row.notes = [known(row.dates ?? []) ? `ברומה רשום פיצוי ${amount}. לא נמצא הסבר מתאים לפיצוי.` : `ברומה רשום פיצוי ${amount} שאף חוק אינו מסביר.`];
    if (row.column === 'S/C' && onDiverted(row.dates ?? [])) {
      row.notes.push('האפליקציה מניחה סטיה לשדה משנה (אותם מספרי טיסה), ועל סטיה אין קריאה מיוחדת.');
    }
  }
}

/** תשובות שמקשרות בין סבב מתוכנן שלא בוצע לבין הטיסה שבוצעה במקומו בתאריכים אחרים. */
const LINKED_VALUES = ['voluntary_swap', 'replaced', 'bid'];

/**
 * סבב מתוכנן שבמקומו בוצע סבב אחר באותם ימים, והתשובה עליו היא החלפה עם טיסה אחרת – בחודש אחר
 * או פעילות לא מתוכננת בימים אחרים: מה שבוצע באותם ימים אינו חלק מההחלפה. הוא פעילות לא מתוכננת,
 * עם השאלה עליה (קריאה מיוחדת או לא), והסבב המתוכנן – סבב שלא בוצע (בעל המוצר, 03/10/2026;
 * 06/08/2025: ZRH הוחלפה מרצון בטיסה בחודש אחר, ו-NCE בוצעה באותו יום). השאלה על הטיסה שבוצעה
 * תלויה בתשובה על הסבב המתוכנן, ולכן שינוי שלה מוחק גם את התשובה עליה (`dependents`).
 * כך גם כשהשרשרת מהיומן (`reduceChain`) נגמרת בסבב שאינו בימים של מה שבוצע: הסבב המתוכנן עבר
 * לימים אחרים, ומה שבוצע בימיו הוא פעילות חדשה (בעל המוצר, 06/10/2026).
 */
function splitSwappedElsewhere(matches, answers, dependents) {
  return matches.flatMap((m) => {
    if (m.how !== 'dates') return [m];
    const a = answers[`cancelled:${m.plan.id}`];
    const linked = LINKED_VALUES.includes(a?.value);
    const elsewhere = linked ? a.link !== undefined && a.link !== m.exec.id
      : !!a?.chain && !!a.endsAt && a.endsAt !== m.exec && !overlapDays(a.endsAt, m.exec);
    if (!elsewhere) return [m];
    dependents[`cancelled:${m.plan.id}`] = [`unplanned:${m.exec.id}`];
    return [{ plan: m.plan, exec: null, how: 'cancelled' }, { plan: null, exec: m.exec, how: 'unplanned' }];
  });
}

/** קישור של החלפה מרצון על סבב שלא בוצע: הטיסה נמסרה בלי לקבל טיסה אחרת במקומה. */
const GAVE_AWAY = 'none';
const GAVE_AWAY_LABEL = 'מסירת הטיסה ללא חלופה';

/** מה קרה לסבב שבמקומו בוצע סבב אחר באותם ימים, לפי התשובה לשאלה עליו. */
const DATES_OUTCOME = {
  replaced: 'שינוי ביוזמת החברה',
  bid: 'זכייה במכרז',
  voluntary_swap: 'החלפה מרצוני או בהסכמתי',
  cancelled: 'המתוכנן בוטל, ומה שבוצע לא היה מתוכנן',
  wet_lease: 'הורדה מהטיסה ביוזמת החברה',
  trainee: 'הורדה מהטיסה ביוזמת החברה',
  swap_777: 'הועבר ל-777 (לא כשיר MFF)',
  other: 'סיבה אחרת',
  diversion: 'סטיה לשדה משנה', // תשובה, או הנחה מהקבצים (`assumeDiversion`)
  standby: 'בוטל והוצבת לכוננות', // שלב בשרשרת מהיומן (`reduceChain`)
};

/** ההנחה בלשון התשובות. כמה חוקים יכולים להסביר את אותו זיכוי, ואז כולם מופיעים. */
const outcomeOf = (values, labels) => [...new Set(values.map((v) => labels[v]).filter(Boolean))].join(' או ');

/** מה קרה לסבב שלא בוצע, לפי התשובה לשאלה עליו. */
const CANCELLED_OUTCOME = {
  cancelled: 'בוטל ללא פיצוי',
  wet_lease: 'הורדה מהטיסה ביוזמת החברה', // תשובה שנשמרה לפני שהאפשרויות אוחדו
  trainee: 'הורדה מהטיסה ביוזמת החברה',
  swap_777: 'הועבר ל-777 (לא כשיר MFF)',
  replaced: 'הוחלף בטיסה אחרת', // בלי קישור: תשובה שנשמרה בגרסה ישנה
  standby: 'בוטל והוצבת לכוננות', // שלב בשרשרת מהיומן (`reduceChain`)
  chain_open: 'ממתין לתשובה',
};

/**
 * לשאלה שמבקשת לקשר החלפה לסבב בצד השני: על פעילות לא מתוכננת – הסבבים המתוכננים
 * שלא בוצעו; על סבב שלא בוצע – הפעילויות הלא מתוכננות. כשבמקום הסבב המתוכנן בוצע סבב אחר
 * באותם ימים, הוא האפשרות הראשונה, אבל ההחלפה יכולה להיות גם עם כל טיסה אחרת שלא תוכננה
 * (בקשת בעל המוצר, 24/09/2026). תמיד אפשר גם "טיסה בחודש אחר", כי ההחלפה יכולה להיות עם
 * טיסה שאינה בקבצים של החודש. "מסירת הטיסה ללא חלופה" היא רק בהחלפה מרצון על סבב שלא בוצע
 * כלל: החלפה ביוזמת החברה בלי טיסה אחרת מכוסה באפשרות "הורדתי מהטיסה המקורית"
 * (בעל המוצר, 23/09/2026).
 */
function attachLinkCandidates(questions, matches, ctx, assumptions = []) {
  const cancelled = matches.filter((m) => m.how === 'cancelled').map((m) => ({ id: m.plan.id, label: describePairing(m.plan) }));
  // פעילות שזוהתה כקריאה מיוחדת (S/C בדוח), או טיסה בסוף כוננות, אינה החלפה. חוץ מקריאה מיוחדת שהאפליקציה הניחה
  // (S/C ברומה, בלי תשובה): בדרך כלל היא זכייה במכרז או שינוי ביוזמת החברה במקום סבב שבוטל, והקישור מחליף את
  // ההנחה (בעל המוצר, 21/10/2026, טיוטה 384; טל: OPO ‏09–10/09 במקום TBS ‏10/09).
  const notSwap = ['special_call', 'standby_bid_pending', 'standby_bid', 'standby_activated'];
  const assumedCall = (m) => assumptions.some((a) => a.id === `unplanned:${m.exec.id}` && a.value === 'special_call');
  const unplanned = matches.filter((m) => m.how === 'unplanned' && (assumedCall(m) || !notSwap.some((t) => ctx.pairingHandledBy(m.exec, t))))
    .map((m) => ({ id: m.exec.id, label: describePairing(m.exec) }));
  const otherMonth = { id: null, label: 'טיסה בחודש אחר' };
  const gaveAway = { id: GAVE_AWAY, label: GAVE_AWAY_LABEL };
  const execLabel = new Map(matches.filter((m) => m.exec).map((m) => [m.exec.id, describePairing(m.exec)]));
  // מה שחופף לימי הסבב שבשאלה, גם חלקית – ראשון, ואחריו השאר לפי תאריך (בעל המוצר, 21/10/2026; טיוטה 396).
  const span = new Map(matches.flatMap((m) => [m.plan, m.exec]).filter(Boolean).map((p) => [p.id, [p.from, p.shownTo ?? p.to]]));
  const overlaps = (a, b) => !!a && !!b && a[0] <= b[1] && b[0] <= a[1];
  const overlapFirst = (list, subject) => [...list.filter((c) => overlaps(span.get(c.id), subject)),
    ...list.filter((c) => !overlaps(span.get(c.id), subject))];
  for (const q of questions) {
    const onCancelled = q.id.startsWith('cancelled:');
    const own = onCancelled && q.execId ? [{ id: q.execId, label: execLabel.get(q.execId) ?? q.execId }] : [];
    const subject = span.get(q.id.slice(q.id.indexOf(':') + 1));
    const pool = q.id.startsWith('unplanned:') ? overlapFirst(cancelled, subject) : onCancelled ? [...own, ...overlapFirst(unplanned, subject)] : [];
    for (const o of q.options ?? []) {
      if (o.needsLink) o.linkCandidates = [...pool, otherMonth, ...(onCancelled && !own.length && o.value === 'voluntary_swap' ? [gaveAway] : [])];
    }
  }
}

// ---------- קודים ----------

/**
 * קודי היום בדוח הביצוע, בלי מסלולי הטיסה ("TLV-AMS"). רגל שחוזרת לשדה המוצא
 * (TLV→TLV) מופיעה במסלולים כ-"LEG" (15/02/2026), ולכן גם הוא מסלול ביום שיש בו רגל כזו.
 * קוד מ-`ignored_report_codes` (UNF_B, ‏MEAL), שמתחיל ב-`ignored_report_code_prefixes` (DUM: ‏DUM_A
 * לצד LCA ב-08/01/2026), או שמכיל מילה מ-`ignored_report_code_contains` (BASE: ‏BASE_ ב-06/04/2026),
 * אינו מזכה בכלום ואינו מוצג, ולכן מושמט כאן.
 */
function execCodesOf(day, codes) {
  const details = day?.exec?.details;
  if (!details) return [];
  const hasReturnLeg = (day.exec.legs ?? []).some((l) => l.org && l.org === l.dst);
  const hidden = new Set(codes?.ignored_report_codes ?? []);
  const hiddenPrefixes = codes?.ignored_report_code_prefixes ?? [];
  const hiddenParts = codes?.ignored_report_code_contains ?? [];
  return details.split(/[,\s]+/).filter((t) => t && !/^[A-Z]{3}-[A-Z]{3}$/.test(t) && !(hasReturnLeg && t === 'LEG') &&
    !hidden.has(t) && !hiddenPrefixes.some((p) => t.startsWith(p)) && !hiddenParts.some((p) => t.includes(p)));
}

/** קוד היעדרות: ברשימה, או מתחיל בקידומת היעדרות (SCK_F, 21/06/2026). */
const isLeaveCode = (code, list, codes) => list.has(code) || (codes.leave_prefixes ?? []).some((p) => code.startsWith(p));

/** קוד מקוצר בדוח → הקוד המלא בתכנון (HOME_ → HOME_RGT). */
function expandCode(code, codes) {
  return Object.entries(codes.plan_to_report ?? {}).find(([, short]) => short === code)?.[0] ?? code;
}

function isIgnoredPlanCode(code, codes) {
  return (codes.ignored_plan_notes ?? []).some((n) => code === n || code.startsWith(n));
}

/**
 * קוד שאינו מוכר מוצג למשתמש עם כל מה שיש עליו בקבצים: התאריכים, ומה שהדוח רשם באותם ימים.
 * זה מה שדרוש כדי לעדכן את `rules.json` לפי הקוד החדש (בקשת בעל המוצר, 23/09/2026).
 * `answer` מתווסף אחר כך, אם המשתמש נשאל על הקוד וענה (`ctx.explainCode`).
 * עמודה בטבלת הימים ברומה שהאפליקציה אינה מכירה (`unknownColumns` מ-js/pdf/exec.js) מוצגת באותה
 * רשימה (`column`), עם הימים שיש בה ערך, ולא נזרקת בשקט (בעל המוצר, 08/10/2026; HHM בספטמבר 2026).
 */
function collectUnknownCodes(timeline, codes, supported, unknownColumns = []) {
  const found = new Map();
  const add = (code, where, day) => {
    const k = `${where}|${code}`;
    if (!found.has(k)) found.set(k, { code, where, dates: [], report: [] });
    const u = found.get(k);
    u.dates.push(day.date);
    const text = reportedCells(day);
    if (text) u.report.push({ date: day.date, text });
  };
  for (const day of timeline) {
    for (const c of day.plan?.codes ?? []) if (classifyCode(c, codes, supported) === 'unknown') add(c, 'plan', day);
    for (const c of execCodesOf(day, codes)) if (classifyCode(c, codes, supported) === 'unknown') add(c, 'exec', day);
  }
  for (const col of unknownColumns) {
    const days = timeline.filter((d) => { const v = d.exec?.values?.[col]; return v && (v.min || v.count || v.raw); });
    if (!days.length) continue;
    found.set(`column|${col}`, { code: col, where: 'exec', column: true, dates: days.map((d) => d.date),
      report: days.map((d) => ({ date: d.date, text: reportedCells(d) })) });
  }
  return [...found.values()];
}

/**
 * קוד לא מוכר ברומה שבכל הימים שלו רשום CORS (העמודה ב-`assume_unknown_codes` של חוק אימון הקרקע), ובלי
 * סימולטור ביום, הוא פעילות קרקע (בעל המוצר, 15/10/2026): CORS הוא מונה ימי פעילות הקרקע שבוצעו, ואינו
 * רשום בסימולטור, בחופשה או בטיסה. הקוד נוסף לקודים של החוק ול-`ground_activity`, ומכאן הוא כמו CPT_B.
 * קוד לא מוכר בתכנון שחמשת התווים הראשונים שלו הם הקוד ברומה באותו יום – גם הוא. בתכנון אין CORS.
 * @returns {{supported, codes, assumed: Set<string>, column: string}|null}
 */
function assumeGroundCodes(timeline, codes, supported) {
  const rule = supported.find((r) => r.logic.params?.assume_unknown_codes);
  if (!rule) return null;
  const column = rule.logic.params.assume_unknown_codes;
  const unknown = (c) => classifyCode(c, codes, supported) === 'unknown';
  const daysOf = new Map();
  for (const day of timeline) for (const c of execCodesOf(day, codes)) if (unknown(c)) daysOf.set(c, [...(daysOf.get(c) ?? []), day]);
  const values = (day) => day.exec?.values ?? {};
  const marked = (day) => values(day)[column]?.count > 0 && !values(day).SIM && !values(day).SIMD && !(day.exec.sims ?? []).length;
  const report = [...daysOf].filter(([, days]) => days.every(marked)).map(([c]) => c);
  if (!report.length) return null;
  const planCodes = [...new Set(timeline.flatMap((day) => (day.plan?.codes ?? []).filter((c) => unknown(c) &&
    (report.includes(c) || execCodesOf(day, codes).some((x) => report.includes(x) && x === c.slice(0, 5))))))];
  const p = rule.logic.params;
  const widened = { ...rule, logic: { ...rule.logic, params: { ...p,
    report_codes: [...(p.report_codes ?? []), ...report], plan_codes: [...(p.plan_codes ?? []), ...planCodes] } } };
  return {
    supported: supported.map((r) => (r === rule ? widened : r)),
    codes: { ...codes, ground_activity: [...(codes.ground_activity ?? []), ...new Set([...report, ...planCodes])],
      plan_to_report: { ...(codes.plan_to_report ?? {}),
        ...Object.fromEntries(planCodes.filter((c) => !report.includes(c)).map((c) => [c, c.slice(0, 5)])) } },
    assumed: new Set([...report, ...planCodes]),
    column,
  };
}

/** מה שהדוח רשם ביום, כלשונו: "Credit 03:45 · SBY 1.00". ריק כשאין דוח, או שאין בו ערך ביום. */
function reportedCells(day) {
  return Object.entries(day.exec?.values ?? {})
    .filter(([, v]) => (v.kind === 'duration' ? v.min : v.kind === 'count' ? v.count : v.raw))
    .map(([column, v]) => `${column} ${v.raw}`).join(' · ');
}

// ---------- השוואה מול הדוח ----------

/**
 * ימי הדוח של סבב: ימי הרגליים, ועוד היום שאחריו אם הנחיתה בבסיס עברה את חצות.
 * הקרדיט של רגל כזו מתפצל בדוח בין שני הימים (אומת: LY336, 16–17/07). סבב ברומה שימי ההמשך
 * שלו כבר נקבעו (`reportTail`, `attachReportTails`) – לפיהם.
 */
function reportDates(pairing, timeline, tz) {
  const dates = [...pairing.dates];
  if (pairing.reportTail) return [...dates, ...pairing.reportTail.filter((d) => !dates.includes(d))];
  const last = pairing.legs.at(-1);
  if (last?.dst === tz.domicile) {
    const next = timeline[timeline.findIndex((d) => d.date === pairing.to) + 1];
    if (crossesMidnight(last, tz) && next && !dates.includes(next.date)) dates.push(next.date);
  }
  return dates;
}

/**
 * הימים שאחרי סבב שהרומה רושמת עליו (`pairing.reportTail`). הרומה רושמת את הרגל ביום ה-STD, ואת
 * השעות שאחרי חצות ביום שאחריו, בלי שורת רגל (25/09/2026: LY392 מ-BCN, ‏STD 22:40, המריאה ב-00:01 ונחתה
 * ב-05:16; ב-25/09 Credit 04:25 ו-TAB 05:16). יום כזה, וכל יום שאחריו בלי טיסה, עם TAB או Credit ובלי
 * קוד, הוא המשך של השהייה: עיכוב של יותר מיממה מקבל קריאה מיוחדת על כל יממה נוספת (בעל המוצר,
 * 08/10/2026). יום כזה אחרי סבב שנחת לפני חצות אינו מוסבר בקבצים, ונשאל (`report_day:` בחוק הקריאה
 * המיוחדת); בתשובה "המשך" הוא נוסף לסבב. כמה סבבים שמסתיימים באותו יום נבדקים כולם (17/06/2024).
 * @returns {{date: string, pairing: object}[]} הימים שנשאלים
 */
function attachReportTails(execPairings, timeline, tz, codes, answers) {
  const index = new Map(timeline.map((d, i) => [d.date, i]));
  const inOther = (date, self) => execPairings.some((p) => p !== self && (p.dates.includes(date) || (p.from < date && date < p.to)));
  const loose = (day) => !!day && !(day.exec?.legs ?? []).length && !(day.exec?.sims ?? []).length &&
    !!(day.exec?.values?.TAB?.min || day.exec?.values?.Credit?.min) && !execCodesOf(day, codes).length;
  const extend = (p, i) => {
    for (; loose(timeline[i]) && !inOther(timeline[i].date, p); i++) p.reportTail.push(timeline[i].date);
  };
  const waiting = [];
  for (const p of execPairings) {
    p.reportTail = [];
    const last = p.legs.at(-1);
    if (last?.dst !== tz.domicile || p.cutAtEnd) continue;
    const i = index.get(p.to) + 1;
    const next = timeline[i];
    if (!next || p.dates.includes(next.date)) continue;
    if (crossesMidnight(last, tz)) {
      p.reportTail.push(next.date);
      // יום ההמשך שסבב אחר יוצא בו אינו עיכוב שנמשך.
      if (!inOther(next.date, p)) extend(p, i + 1);
    } else if (loose(next) && !inOther(next.date, p)) waiting.push({ p, i });
  }
  const tails = new Set(execPairings.flatMap((p) => p.reportTail));
  const asked = [];
  for (const { p, i } of waiting) {
    const date = timeline[i].date;
    if (tails.has(date) || asked.some((a) => a.date === date)) continue;
    if (answers[`report_day:${date}`]?.value === 'continued') extend(p, i);
    else asked.push({ date, pairing: p });
  }
  for (const p of execPairings) p.reportEnd = reportEnd(p, execPairings, timeline, tz);
  return asked;
}

/**
 * סוף השהייה מחוץ לבסיס לפי הרומה (`pairing.reportEnd`; `pairingTimes` עם `away` ב-js/flight-times.js):
 * היום האחרון של הסבב ברומה, והדקות בו. הרומה כבר חישבה אותן ב-TAB של היום, לפי
 * הזמנים בפועל; כשסבב אחר יוצא באותו יום, ה-TAB של שניהם, והחלק של הסבב שנחת הוא מחצות עד הנחיתה
 * (בעל המוצר, 08/10/2026). null בסבב של יום אחד, או בלי TAB.
 */
function reportEnd(pairing, execPairings, timeline, tz) {
  const home = pairing.legs.findLast((l) => l.dst === tz.domicile);
  const date = reportDates(pairing, timeline, tz).at(-1);
  if (!home || pairing.cutAtEnd || date === pairing.from) return null;
  if (!execPairings.some((p) => p !== pairing && p.dates.includes(date))) {
    const min = dayOf(timeline, date)?.exec?.values?.TAB?.min;
    return min ? { date, min } : null;
  }
  const t = legTimes(home, tz);
  const landed = t ? t.ata ?? t.sta : null;
  return landed ? { date: dateOf(landed), min: landed - Date.parse(dateOf(landed)) / 60000 } : null;
}

/**
 * יום הנחיתה בבסיס, לתיאור הסבב (`shownTo`, ‏`describePairing`): סבב שחוזר אחרי חצות מתואר עד היום
 * שבו נחת, בשני הצדדים (בעל המוצר, 08/10/2026; ‏LY392 מ-BCN: 23/09–25/09, ולא 23/09–24/09). בביצוע –
 * היום האחרון שהרומה רושמת על הסבב (`reportDates`, כולל עיכוב של יותר מיממה; בסוף החודש – הרגל
 * חוצה את חצות); בתכנון – יום הנחיתה המתוכננת (`pairingTimes`).
 */
function markLandingDays(planPairings, execPairings, timeline, tz) {
  const dayAfter = (date) => new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
  for (const p of execPairings) {
    const last = reportDates(p, timeline, tz).at(-1);
    const leg = p.legs.at(-1);
    if (last > p.to) p.shownTo = last;
    else if (!p.cutAtEnd && leg?.dst === tz.domicile && crossesMidnight(leg, tz) && p.to === timeline.at(-1)?.date) p.shownTo = dayAfter(p.to);
  }
  for (const p of planPairings) {
    const { end } = pairingTimes(p, tz);
    if (end != null && p.legs.at(-1)?.dst === tz.domicile && dateOf(end) > p.to) p.shownTo = dateOf(end);
  }
}

/** העמודות שמתפצלות ליום שאחרי נחיתה אחרי חצות, יחד עם הקרדיט. */
const SPLIT_COLUMNS = ['Credit', 'FLT', 'DH', 'PDFT', 'TAB', 'ABR'];

/**
 * הימים שבהם עמודה בדוח שייכת לסבב. יום שהקרדיט התפצל אליו, וסבב אחר יוצא בו, נספר רק לעמודות
 * שמתפצלות: פיצוי שהרומה רשמה בו (S/C, ‏COM, ‏Rig) שייך לסבב שיוצא (22–23/09/2026: LY2524 מ-PRG
 * נחתה אחרי חצות, וה-S/C של 23/09 הוא של BCN שיצאה באותו יום, ולא קריאה מיוחדת על PRG).
 */
function columnDates(pairing, column, timeline, tz, execPairings) {
  const dates = reportDates(pairing, timeline, tz);
  if (SPLIT_COLUMNS.includes(column)) return dates;
  return dates.filter((d) => pairing.dates.includes(d) || !execPairings.some((p) => p !== pairing && p.dates.includes(d)));
}

const dayOf = (timeline, date) => timeline.find((d) => d.date === date);

function reportedValue(day, column) {
  const v = day?.exec?.values ?? {};
  if (column === 'FLT+DH') return (v.FLT?.min ?? 0) + (v.DH?.min ?? 0);
  return v[column]?.min ?? 0;
}

function compare({ out, timeline, execPairings, tz, codes: catalog, fdp, hideCode = () => false }) {
  // קבוצות ימים: סבב וימי הפיצול שלו מתאחדים; ימים שחולקים סבב מתאחדים גם הם.
  const parent = new Map(timeline.map((d) => [d.date, d.date]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  const union = (a, b) => parent.set(find(b), find(a));
  const pairingOf = new Map(); // date → הסבבים שנוגעים בו (כמה סבבים באותו יום, 25/11/2025)
  for (const p of execPairings) {
    const dates = reportDates(p, timeline, tz);
    for (const d of dates) { union(dates[0], d); pairingOf.set(d, [...(pairingOf.get(d) ?? []), p]); }
  }

  /**
   * ציפייה שמוצגת על סבב אחר מזה שעליו הרומה רשמה אותה (`showOn`: ההפרש של החלפה ביוזמת החברה,
   * שמוצג על הטיסה שהחליפה; בעל המוצר, 01/10/2026; 10–11/06/2026). גם מה שהרומה רשמה עובר איתה,
   * כדי שהשורה של הסבב האחר לא תציג סכום בלי הסבר: `shift` הוא התיקון לכל יום ועמודה.
   */
  const shift = new Map();
  const raw = (d, column) => reportedValue(dayOf(timeline, d), column);
  const bump = (d, column, min) => shift.set(`${d}|${column}`, (shift.get(`${d}|${column}`) ?? 0) + min);
  // ציפייה על החודש כולו (`monthly`: ימים ללא פעילות, בלי יום ברומה) – שורה בלי תאריך, בראש הפירוט.
  const monthly = out.expectations.filter((e) => e.monthly);
  const expectations = out.expectations.filter((e) => !e.monthly).map((e) => {
    const to = e.showOn && execPairings.find((p) => p.id === e.showOn);
    if (!to) return e;
    const column = KEY_COLUMNS[e.key][0];
    const from = execPairings.find((p) => p.id === e.pairingId);
    const days = from ? reportDates(from, timeline, tz) : e.dates;
    bump(days.find((d) => raw(d, column) >= e.min) ?? days[0], column, -e.min);
    bump(to.from, column, e.min);
    return { ...e, date: to.from, dates: [...to.dates], pairingId: to.id, pairing: describePairing(to) };
  });
  for (const e of expectations) for (const d of e.dates) if (parent.has(d)) union(e.dates[0], d);

  const groups = new Map();
  for (const d of timeline) {
    const root = find(d.date);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(d.date);
  }

  const rows = monthly.map((e) => ({ dates: [e.date], at: '', monthly: true, label: e.label ?? e.ruleTitle, column: KEY_COLUMNS[e.key][0],
    expected: e.min, reported: 0, diff: -e.min, ok: false, pending: false, items: [e] }));
  const range = (ds) => (ds.length === 1 ? ddmm(ds[0]) : `${ddmm(ds[0])}–${ddmm(ds.at(-1))}`);
  // קטעים לועזיים, כל אחד מבודד (LRI/PDI): התאריכים הכי ימניים, ומשמאלם פרטי הטיסה. בלי בידוד
  // הדפדפן הופך את שני התאריכים, ובלי הפרדה התווית כולה נקראת משמאל לימין והתאריכים יוצאים משמאל.
  // כל סבב בשורה משלו, עם התאריכים שלו בשורה, והקודים בסוף השורה האחרונה (בעל המוצר, 28/09/2026).
  // חזרה לבסיס אחרי המראה שמחוברת לסבב שאחריה מוצגת כסבב נפרד (`pairingParts`), ורק בשורות הקרדיט:
  // פיצוי (COM, S/C) שייך לסבב שאחריה (15/02/2026: נחיתה מאוחרת של LY2368).
  // `only`: הסבבים של השורה, ו-`dayCodes`: קודי היום שבה, כשהקבוצה פוצלה (`splitByPairing`).
  const labelOf = (dates, column, only = null, dayCodes = null) => {
    const parts = (only ?? [...new Set(dates.flatMap((d) => pairingOf.get(d) ?? []))]).flatMap(pairingParts)
      .map((part) => ({ part, days: reportDates(part, timeline, tz).filter((d) => dates.includes(d)) }))
      .filter(({ part, days }) => days.length && (CREDIT_LABEL_COLUMNS.includes(column) || !part.legs.every((l) => l.org === l.dst)));
    const lines = parts.length === 1
      ? [[range(dates), describeRoute(parts[0].part)]]
      : parts.map(({ part, days }) => [range(days), describeRoute(part)]);
    // ביום של Soft Start קוד הכוננות אינו בשורת הטיסה: ההערה כבר אומרת זאת (`hideCode`; בעל המוצר, 15/10/2026).
    // יום שאין עליו קוד ברומה (יום כוננות שאינו ברומה, `standbyMissing`): הקוד שבציפייה, מהתכנון.
    const codesOn = (d) => {
      const own = execCodesOf(dayOf(timeline, d), catalog);
      return own.length ? own.filter((c) => !hideCode(d, c)) : [...new Set(expectations.filter((e) => e.code && e.dates[0] === d).map((e) => e.code))];
    };
    // כל קוד בשם העברי שלו, ובקטע משלו אחרי הטיסה (בעל המוצר, 22/10/2026; טיוטה 403).
    const codes = codeNames(dayCodes ?? dates.flatMap(codesOn), catalog);
    // בלי סבב שבוצע: הטיסה שתוכננה, כשציפייה עליה נושאת אותה (`plannedRoute`, הורדה מהטיסה).
    const planned = [...new Set(expectations.filter((e) => e.plannedRoute && dates.includes(e.dates[0])).map((e) => e.plannedRoute))];
    if (!lines.length) lines.push([range(dates), planned.join(', ')]);
    if (codes) lines.at(-1).push(codes);
    return lines.map((l) => l.filter(Boolean).map((t) => `⁦${t}⁩`).join(' · ')).join('\n');
  };
  const reportedOn = (d, column) => raw(d, column) + (shift.get(`${d}|${column}`) ?? 0);

  /**
   * קבוצה של כמה סבבים שחולקים יום מתפצלת לשורה לכל סבב (בעל המוצר, 28/09/2026): LY548 מאתונה
   * המריאה אחרי חצות ונזקפה ל-28/09/2025, יום היציאה ללוטון, וה-Credit של 28/09 בדוח הוא של שתיהן.
   * היום המשותף מתחלק לפי הציפיות של כל סבב בו, כלומר לפי SkdDur של כל רגל. זה אפשרי רק כשבכל
   * עמודה הסכום בדוח ביום המשותף שווה לצפוי בו, וכל ציפייה בקבוצה שייכת לסבב ידוע ונופלת ביום
   * שלו. אחרת נשארת שורה אחת לקבוצה, כדי שפער לא ייוחס לסבב הלא נכון (25/11/2025: Rig של BUS ו-LCA).
   * פיצוי על שני הסבבים יחד (`jointWith`, שתי טיסות סבב באותו FDP) הוא שורה אחת לשניהם (04/08/2025).
   * פעילות של יום (קוד כמו HOME_RGT או חופשה) ביום שהסבב נזקף אליו היא שורה משלה, כמו סבב נוסף
   * (בעל המוצר, 28/09/2026): LY544 מאתונה נחתה אחרי חצות, וה-Credit של 25/07/2025 בדוח הוא 01:33
   * שלה ועוד 03:45 של HOME_RGT.
   */
  const splitByPairing = (dates) => {
    const inGroup = expectations.filter((e) => dates.includes(e.dates[0]));
    const whole = [{ dates, only: null, items: inGroup, reported: (column) => dates.reduce((s, d) => s + reportedOn(d, column), 0), reportedDay: reportedOn }];
    // פעילות יום: ציפייה עם קוד ובלי סבב, ביום שיש בו סבב. מתנהגת כמו סבב של יום אחד.
    const activityOf = (e) => (e.code && !e.pairingId && !e.flight && pairingOf.has(e.dates[0]) ? `${e.code}@${e.dates[0]}` : null);
    const activities = new Map();
    for (const e of inGroup) {
      const id = activityOf(e);
      if (id && !activities.has(id)) activities.set(id, { id, activity: true, code: e.code, dates: [e.dates[0]] });
    }
    const occupants = (d) => [...(pairingOf.get(d) ?? []), ...[...activities.values()].filter((a) => a.dates[0] === d)];
    const pairings = [...new Set(dates.flatMap(occupants))];
    const shared = dates.filter((d) => occupants(d).length > 1);
    if (pairings.length < 2 || !shared.length || dates.some((d) => !occupants(d).length)) return whole;
    // הבעלים של ציפייה: רשימת הסבבים שהיא שייכת להם (אחד, או כמה כשהפיצוי משותף).
    const ownersOf = (e) => {
      if (activityOf(e)) return [activities.get(activityOf(e))];
      if (e.pairingId) return [e.pairingId, ...(e.jointWith ?? [])].map((id) => pairings.find((p) => p.id === id));
      if (e.flight) return [pairings.find((p) => p.legs?.some((l) => l.flight === e.flight && l.date === e.date))];
      const on = occupants(e.dates[0]);
      return on.length === 1 ? on : [null];
    };
    const units = new Map(); // מפתח → הסבבים
    const owner = new Map();
    for (const e of inGroup) {
      const ps = ownersOf(e);
      if (ps.some((p) => !p || !occupants(e.dates[0]).includes(p))) return whole;
      ps.sort((a, b) => pairings.indexOf(a) - pairings.indexOf(b));
      const key = ps.map((p) => p.id).join('+');
      units.set(key, ps);
      owner.set(e, key);
    }
    for (const p of pairings) if (!units.has(p.id)) units.set(p.id, [p]);
    const expectedOn = (d, column, key) => inGroup
      .filter((e) => e.dates[0] === d && KEY_COLUMNS[e.key]?.includes(column) && (!key || owner.get(e) === key))
      .reduce((s, e) => s + e.min, 0);
    if (shared.some((d) => COMPARED_COLUMNS.some((c) => expectedOn(d, c) !== reportedOn(d, c)))) return whole;
    // קודי היום של כל שורה: פעילות היום בשורה שלה, ושאר הקודים בשורות הסבבים.
    const split = new Set([...activities.values()].map((a) => a.id));
    const codesOf = (ps, own) => (ps.every((p) => p.activity) ? ps.map((p) => p.code)
      : own.flatMap((d) => execCodesOf(dayOf(timeline, d), catalog).filter((c) => !split.has(`${c}@${d}`) && !hideCode(d, c))));
    return [...units].map(([key, ps]) => {
      const own = dates.filter((d) => ps.some((p) => occupants(d).includes(p)));
      // שורה משותפת כוללת רק את הציפיות המשותפות; ימים שאינם משותפים שייכים לשורה של כל סבב.
      const onlyShared = ps.length > 1;
      const reportedDay = (d, column) => (shared.includes(d) ? expectedOn(d, column, key) : onlyShared ? 0 : reportedOn(d, column));
      return { dates: own, only: ps.filter((p) => !p.activity), codes: codesOf(ps, own), items: inGroup.filter((e) => owner.get(e) === key),
        reported: (column) => own.reduce((s, d) => s + reportedDay(d, column), 0), reportedDay };
    });
  };

  /**
   * סבב אחד בכמה FDP נפרדים (מנוחה חוקית בדרך): הפיצוי (COM, ‏S/C) בשורה לכל FDP, והקרדיט
   * וה-Rig על הסבב כולו (בעל המוצר, 29/09/2026; 19–20/06/2025: ‏S/C על TLV-LCA ב-19 ועל
   * PFO-LCA-TLV ב-20, ‏COM של הנחיתה המאוחרת רק על השני). יממה בלי רגל שייכת ל-FDP שלפניה.
   * רק כשכל ציפייה בעמודה נופלת כולה ב-FDP אחד; אחרת העמודה נשארת שורה אחת לסבב.
   */
  const splitByFdp = (dates, inGroup, column) => {
    if (!COMPENSATION_COLUMNS.includes(column)) return null;
    const touching = [...new Set(dates.flatMap((d) => pairingOf.get(d) ?? []))];
    if (touching.length !== 1) return null;
    const parts = fdpParts(touching[0], fdp);
    if (parts.length < 2) return null;
    const partOf = (d) => parts.findLastIndex((p) => p.from <= d);
    const items = inGroup.filter((e) => KEY_COLUMNS[e.key]?.includes(column));
    if (items.some((e) => e.dates.some((d) => partOf(d) !== partOf(e.dates[0])))) return null;
    return parts.map((part, i) => {
      const own = dates.filter((d) => partOf(d) === i);
      return { part, dates: own, items: items.filter((e) => own.includes(e.dates[0])) };
    }).filter((x) => x.dates.length);
  };

  /**
   * פיצוי שנרשם יום-יום (`perDay`: קריאה מיוחדת) הוא שורה לכל יום שמגיע עליו (בעל המוצר, 01/10/2026),
   * עם ה-FDP של אותו יום כשהסבב בכמה FDP. רק כשכל הציפיות בעמודה הן כאלה. כשהרומה רשמה את הסכום
   * כולו אבל לא באותם ימים, הוא מיוחס לימים לפי הצפוי, כדי שלא ייווצרו שני פערים שמתקזזים.
   */
  const splitByDay = (dates, inGroup, column, only, codes, reportedDay) => {
    if (!COMPENSATION_COLUMNS.includes(column)) return null;
    const items = inGroup.filter((e) => KEY_COLUMNS[e.key]?.includes(column));
    if (!items.length || !items.every((e) => e.perDay)) return null;
    const touching = only ?? [...new Set(dates.flatMap((d) => pairingOf.get(d) ?? []))];
    const parts = touching.length === 1 ? fdpParts(touching[0], fdp) : null;
    const expectedOn = (d) => items.filter((e) => e.dates[0] === d).reduce((s, e) => s + e.min, 0);
    const matches = dates.reduce((s, d) => s + reportedDay(d, column), 0) === items.reduce((s, e) => s + e.min, 0);
    return dates.map((d) => ({ d, expected: expectedOn(d), reported: matches ? expectedOn(d) : reportedDay(d, column) }))
      .filter((x) => x.expected || x.reported)
      .map(({ d, expected, reported }) => ({ dates: [d], at: d, column, expected, reported, items: items.filter((e) => e.dates[0] === d),
        label: labelOf([d], column, parts ? [parts.findLast((p) => p.from <= d) ?? parts[0]] : only, codes ? [] : null) }));
  };

  for (const group of groups.values()) {
    group.sort();
    for (const { dates, only, codes, items: inGroup, reported: reportedFor, reportedDay } of splitByPairing(group)) {
      // פער בקבוצה שיש עליה שאלה פתוחה אינו ממצא עדיין: הצפוי תלוי בתשובה.
      const asked = out.questions.some((q) => dates.includes(q.date));
      const push = (row) => {
        const ok = row.reported === row.expected;
        const pending = !ok && asked;
        rows.push({ ...row, diff: row.reported - row.expected, ok: pending ? null : ok, pending });
      };

      // כל עמודה על הקבוצה כולה, ומוצגת אחרי היום האחרון. גם Credit: סבב שחוצה תאריכים הוא שורה אחת,
      // עם סכום הקרדיט של כל ימיו, ולא שורה לכל יממה כמו בדוח (בעל המוצר, 28/09/2026). הפירוט לימים
      // נשאר בהערות של הציפיות. הדוח רושם Rig של סבב ביום הראשון שלו.
      for (const column of COMPARED_COLUMNS) {
        const byDay = splitByDay(dates, inGroup, column, only, codes, reportedDay);
        if (byDay) { byDay.forEach(push); continue; }
        const byFdp = splitByFdp(dates, inGroup, column);
        if (byFdp) {
          for (const { part, dates: own, items } of byFdp) {
            const expected = items.reduce((s, e) => s + e.min, 0);
            const reported = own.reduce((s, d) => s + reportedOn(d, column), 0);
            if (!expected && !reported) continue;
            push({ dates: own, at: own.at(-1), label: labelOf(own, column, [part], codes ? [] : null), column, expected, reported, items });
          }
          continue;
        }
        const items = inGroup.filter((e) => KEY_COLUMNS[e.key]?.includes(column));
        const expected = items.reduce((s, e) => s + e.min, 0);
        const reported = reportedFor(column);
        if (!expected && !reported) continue;
        // פיצוי על ימים מסוימים של הסבב (`ownDays`: קריאה מחופשה) – בראש השורה רק הימים שלו; ההשוואה על הסבב כולו
        // (בעל המוצר, 21/10/2026; טיוטה 392).
        const days = items.length && items.every((e) => e.ownDays) ? dates.filter((d) => items.some((e) => e.dates.includes(d))) : [];
        const own = days.length ? days : dates;
        push({ dates: own, at: own.at(-1), label: labelOf(own, column, only, codes), column, expected, reported, items });
      }
    }
  }

  // עמודות הסימון (VAC, SICK...) ו-TAB בימי היעדרות: יום-יום.
  // לחוק יכולות להיות כמה עמודות סימון אפשריות (מחלה: SICK או SCKFM, לפי הקוד).
  for (const f of out.flags) {
    const columns = [].concat(f.column);
    const values = dayOf(timeline, f.date)?.exec?.values ?? {};
    const reported = columns.reduce((s, c) => s + (values[c]?.count ?? 0), 0);
    rows.push({ dates: [f.date], label: ddmm(f.date), column: columns.join('/'), expected: f.count, reported,
      diff: reported - f.count, ok: reported === f.count, unit: 'count', items: [f] });
  }
  for (const t of out.tabs) {
    // ביום שחלק ממנו שייך לסבב, ה-TAB בדוח כולל גם את זמן השהייה של הסבב.
    if (pairingOf.has(t.date)) continue;
    const reported = dayOf(timeline, t.date)?.exec?.values?.TAB?.min ?? 0;
    rows.push({ dates: [t.date], label: ddmm(t.date), column: 'TAB', expected: t.min, reported,
      diff: reported - t.min, ok: reported === t.min, items: [t] });
  }
  const at = (r) => r.at ?? r.dates[0];
  // באותו יום אחרון, השורה שמתחילה קודם קודמת: סבב שנחת אחרי חצות לפני פעילות היום שאחריו.
  return rows.sort((a, b) => at(a).localeCompare(at(b)) || a.dates[0].localeCompare(b.dates[0])
    || COMPARED_COLUMNS.indexOf(a.column) - COMPARED_COLUMNS.indexOf(b.column));
}

/**
 * סיכום חודשי מול שורת הסיכום בדוח.
 * עמודת פיצוי שאינה בדוח פירושה שלא היה פיצוי כזה בחודש, והיא נקראת כ-0.
 * שעות טיסה משולמות כקרדיט או כפיצוי, וקריאה מיוחדת היא פיצוי: COM כולל את S/C, בצפוי וברומה
 * (`columns`; בעל המוצר, 22/10/2026; טיוטה 400).
 */
function compareTotals(out, exec) {
  const sum = (columns) => out.comparison.filter((r) => columns.includes(r.column)).reduce((s, r) => s + r.expected, 0);
  const t = { ...exec.totals };
  for (const c of exec.missingColumns ?? []) if (OPTIONAL_COLUMNS.includes(c)) t[c] ??= 0;
  const reported = (columns) => (columns.some((c) => t[c] == null) ? null : columns.reduce((s, c) => s + t[c], 0));
  return [['Credit'], ['Rig'], ['COM', 'S/C']].map((columns) => {
    const r = { column: columns[0], columns, expected: sum(columns), reported: reported(columns) };
    return { ...r, ok: r.reported == null ? null : r.reported === r.expected };
  });
}

/** מה צפוי בעמודה, בהודעה על עמודה חסרה. */
const EXPECTED_IN_COLUMN = { 'S/C': 'צפויה קריאה מיוחדת', COM: 'צפוי פיצוי', Rig: 'צפוי Rig', TAB: 'צפויות שעות שהייה',
  MIL: 'צפוי סימון מילואים', SICK: 'צפוי סימון מחלה', SCKFM: 'צפוי סימון מחלת בן משפחה', VAC: 'צפוי סימון חופשה',
  SIM: 'צפוי סימון סימולטור', CORS: 'צפוי סימון פעילות קרקע', SBY: 'צפוי סימון כוננות' };

/**
 * עמודה חסרה אינה תקלה, אבל כשהאפליקציה מצפה לערך בה, ייתכן שהיא נחתכה בהדפסה – הודעה בכחול, רק כשאין שאלות
 * פתוחות (עד התשובות הציפייה עוד יכולה להשתנות; טיוטה 407). קודם PDFT: כשהיא ברומה, בטוח שלא נחתכה עמודה שלפניה.
 * רק בלעדיה – עמודה אחרת בכותרת שמתחילה ב-P (`headerP`; PICKUP, ‏Pay Queries, או PDFT חתוכה). כולן באות תמיד אחרי
 * עמודות הפיצוי, וההדפסה נחתכת מימין (33 רומות; בעל המוצר, 30/10/2026; טיוטות 421–423). כל עמודה שהאפליקציה
 * משווה, לא רק עמודות הפיצוי.
 */
function warnMissingColumns(out, exec) {
  const present = new Set(exec.columns ?? []);
  if (out.questions.length) return;
  if (present.has('PDFT')) return;
  if (exec.headerP?.startsWith('P')) return;
  const seen = new Set();
  for (const r of out.comparison) {
    const columns = r.column === 'S/C' ? [r.column] : String(r.column).split(/[/+]/);
    if (!(r.expected > 0) || columns.some((c) => present.has(c)) || seen.has(r.column)) continue;
    seen.add(r.column);
    out.infos.push(`${EXPECTED_IN_COLUMN[columns[0]] ?? `צפוי ${columns[0]}`}, והעמודה ${columns.join(' או ')} לא מופיעה ברומה. ייתכן שהעמודה נחתכה בהדפסה.`);
  }
}

const MISSING_COLUMNS_PREFIX = 'עמודות חסרות ברומה';
// אזהרה שהייתה נשמרת בחודשים שחולצו לפני שהוסרה (קובץ שהודפס מ-iPad).
const IPAD_WARNING_PREFIX = 'הקובץ הודפס מ-iPad';
// אזהרה שהייתה נשמרת בחודשים שחולצו לפני שהוסרה: כל נתוני החודש בקובץ, ואין מה להזהיר (טיוטה 331).
const CROSS_MONTH_WARNING_PREFIX = 'תקופת התכנון חוצה חודשים';
// מ-`parseExec`: "סטטוס החודש הוא "Open" ולא Closed. הנתונים אינם סופיים."
const STATUS_WARNING_PREFIX = 'סטטוס החודש הוא';

/** שעות רגל שהחישובים צריכים, בדוח הביצוע (עמודה והשדה שנקרא ממנה). */
const EXEC_LEG_FIELDS = { Flt: 'flight', ORG: 'org', DST: 'dst', STD: 'std', STA: 'sta', ATD: 'atd', ATA: 'ata', SkdDur: 'skdDur' };

/**
 * מידע שהחישובים צריכים וחסר בקבצים: יום שאין לו שורה בדוח (בכל הדוחות שנבדקו מופיעים כל ימי
 * החודש), עמודת רגל שלא נמצאה, רגל בלי זמנים, שורת סיכום שלא נמצאה ורגל תכנון בלי שדות או שעות.
 * עמודות הימים נבדקות לפי missingColumns, ו-Sum שלא נקרא – בחוק הימים ללא פעילות.
 */
function checkMissingData(plan, exec, warnings) {
  const list = (items) => (items.length > 6 ? `${items.slice(0, 6).join(', ')} ועוד ${items.length - 6}` : items.join(', '));
  const dm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  if (exec) {
    const absent = Object.values(exec.days ?? {}).filter((d) => d.absent).map((d) => dm(d.date));
    if (absent.length) warnings.push(`ברומת הביצוע לא נמצאו שורות ${absent.length === 1 ? 'ליום' : 'לימים'} ${list(absent)}. ייתכן שעמוד חסר או נחתך. ${absent.length === 1 ? 'היום נבדק' : 'הימים נבדקים'} כאילו לא הייתה בהם פעילות.`);
    if (exec.legColumns?.length) {
      const cols = Object.keys(EXEC_LEG_FIELDS).filter((c) => !exec.legColumns.includes(c));
      if (cols.length) warnings.push(`בטבלת הרגליים ברומת הביצוע ${cols.length === 1 ? 'חסרה העמודה' : 'חסרות העמודות'} ${cols.join(', ')}. ייתכן ש${cols.length === 1 ? 'היא נחתכה' : 'הן נחתכו'} בהדפסה. חוקים שתלויים בזמני הטיסות לא ייבדקו כראוי.`);
    }
    const incomplete = [];
    for (const d of Object.values(exec.days ?? {})) {
      for (const l of d.legs ?? []) {
        // DHX היא DH בחברה אחרת, ואין לה מספר טיסה של אל על (Flt 0). ברגל DH בלי ATD ו-ATA אין
        // אזהרה: נחיתה מאוחרת שהרומה זיכתה מוסברת מתחת לטיסה (`late_landing_home`; בעל המוצר, 08/10/2026).
        const gaps = Object.entries(EXEC_LEG_FIELDS)
          .filter(([c, f]) => l[f] == null && exec.legColumns?.includes(c) && !(c === 'Flt' && l.type === 'DHX') && !(l.dhd && (c === 'ATD' || c === 'ATA')))
          .map(([c]) => c);
        if (gaps.length) incomplete.push(`${dm(d.date)} ${l.flight ?? ''} (${gaps.join(', ')})`.replace('  ', ' '));
      }
    }
    if (incomplete.length) warnings.push(`ברומת הביצוע חסרים ערכים ברגליים: ${list(incomplete)}. החישובים של הרגליים האלה עלולים להיות שגויים.`);
    if (!Object.keys(exec.totals ?? {}).length) warnings.push('לא נמצאה שורת הסיכום של טבלת הימים ברומת הביצוע, ולכן אין השוואה של הסיכומים.');
  }
  if (plan) {
    const incomplete = Object.values(plan.days ?? {}).flatMap((d) => (d.legs ?? [])
      .filter((l) => !l.dep || !l.arr || !/^[A-Z]{3}$/.test(l.org ?? '') || !/^[A-Z]{3}$/.test(l.dst ?? ''))
      .map((l) => `${dm(d.date)} ${l.flight}`));
    if (incomplete.length) warnings.push(`בקובץ התכנון לא נקראו השדות או השעות של ${list(incomplete)}. החישובים של הטיסות האלה עלולים להיות שגויים.`);
  }
}

function checkSameMonthAndEmployee(plan, exec, warnings) {
  if (!plan || !exec) return;
  if (plan.period.year !== exec.period.year || plan.period.month !== exec.period.month) {
    warnings.push(`קובץ התכנון הוא של ${plan.period.month}/${plan.period.year} וקובץ הביצוע של ${exec.period.month}/${exec.period.year}.`);
  }
  const last = plan.employee?.last?.toUpperCase();
  if (last && exec.employee?.name && !exec.employee.name.toUpperCase().includes(last)) {
    warnings.push(`שם העובד שונה בין הקבצים: "${plan.employee.last} ${plan.employee.first ?? ''}" בתכנון, "${exec.employee.name}" בביצוע.`);
  }
}

/**
 * בדיקת ביטחון לפי ימים (בעל המוצר, 18/10/2026; טיוטה 371). החוקים עוברים סבב אחרי סבב, וכל מקרה הוא מסלול
 * משלו: מקרה שאף מסלול אינו מכסה נפל בשקט (FRA ‏10–11/03/2026, שנחת באיחור ב-12/03, יום שתוכנן פנוי).
 * כאן, אחרי כל החוקים, נבדקים הימים עצמם:
 * - יום שתוכנן פנוי (`planFreeDay`) ונגעה בו טיסה שבוצעה, מההמראה מהבסיס ועד הנחיתה בבסיס בפועל;
 * - יממה שנגעו בה שני FDP נפרדים (`execFdpGroups`), שאחד מהם לא תוכנן. החלפה מרצוני והוספה בהסכמה – מתוכננים;
 *   סבב שבוטל ללא קרדיט – לא. נגיעה ביממה כמו ב-`dayActivity`: מימי הסבב, או נחיתה בה.
 * כל אחד צריך ציפייה ביום (קריאה מיוחדת או פעילות שנייה), שאלה פתוחה על הסבב או על היום, או סיבה מפורשת
 * שאין כלום. אחרת – לבדיקה ידנית. סימולטור אינו בבדיקה השנייה: אין לו שעות, וסימון SIM מופיע גם באמצע סבב.
 */
function auditDays(ctx, out, matches, execPairings, timeline) {
  const sc = ctx.rulesWithLogic('special_call')[0];
  const second = ctx.rulesWithLogic('second_unplanned_activity')[0];
  const inMonth = new Set(timeline.map((d) => d.date));
  const matchOf = (o) => matches.find((m) => m.exec === o) ?? null;
  const answerOf = (o) => { const m = matchOf(o); return m ? ctx.answerFor(m) : null; };
  // סיבות מפורשות שאין פיצוי על כל ימי הסבב. `special_call` בלי ציפייה ביום פנוי – יממה שנייה מתחת לסף (`countSpecialCallDays`).
  const quiet = (o) => ['standby_activated', 'diversion_assumed', 'stay_extension', 'swap_conflict_void', 'carried_in'].some((t) => ctx.pairingHandledBy(o, t)) ||
    answerOf(o)?.value === 'other' || ctx.answer(`extended:${o.id}`)?.value === 'agreed';
  const expected = (d, test) => out.expectations.some((e) => (e.date === d || e.dates?.includes(d)) && test(e));
  const asked = (o, d) => { const m = matchOf(o); return out.questions.some((q) => q.date === d || q.id.includes(o.id) || (m?.plan && q.id.includes(m.plan.id))); };
  const consented = (o) => ['voluntary_swap', 'added'].includes(answerOf(o)?.value);
  const span = (o) => ctx.duty.span(o, { away: true });
  // בתוך לוח הזמנים של הסבב עצמו (STD עד STA), בלי ההארכה.
  const scheduled = (o, d) => { const s = pairingTimes(o, ctx.tz); return s.start != null && s.end != null && s.start < at(d, 1440) && s.end > at(d, 0); };
  const flightsOn = (o, d) => {
    const own = o.legs.filter((l) => l.date === d).map((l) => l.flight).filter(Boolean);
    return [...new Set(own.length ? own : [o.legs.findLast((l) => l.dst === ctx.domicile)?.flight ?? o.legs.at(-1)?.flight].filter(Boolean))].join('/');
  };

  if (sc) {
    for (const o of execPairings) {
      const s = span(o);
      const first = s.start != null && !o.cutAtStart ? dateOf(s.start) : o.from;
      const last = s.end != null && !o.cutAtEnd ? dateOf(s.end - 1) : timeline.at(-1).date;
      for (let d = first; d <= last; d = addDay(d)) {
        if (!inMonth.has(d) || !ctx.planFreeDay(d)) continue;
        if (expected(d, (e) => e.key === 'sc' || e.ruleId === second?.id) || asked(o, d) || quiet(o)) continue;
        if (ctx.pairingHandledBy(o, 'special_call') || (consented(o) && scheduled(o, d))) continue;
        ctx.review(`${ddmm(d)}: נגעה בו טיסה שבוצעה (${flightsOn(o, d)}), והיום תוכנן פנוי, ואף חוק לא קבע מה מגיע עליו. דורש בדיקה ידנית.`, sc);
      }
    }
  }

  if (second) {
    const planned = (o) => consented(o) || (!!matchOf(o)?.plan && !ctx.pairingHandledBy(matchOf(o).plan, 'cancelled_no_compensation'));
    const groups = execFdpGroups(ctx, execPairings, hoursToMin(second.logic.params.legal_rest_hours));
    const touches = (o, d) => o.dates.includes(d) || (span(o).end != null && dateOf(span(o).end) === d);
    for (const d of inMonth) {
      const here = groups.filter((g) => g.some((o) => touches(o, d)));
      if (here.length < 2) continue;
      const unplanned = here.filter((g) => !g.some(planned)).flat();
      if (!unplanned.length) continue;
      if (expected(d, (e) => e.ruleId === second.id) || here.flat().some((o) => asked(o, d)) || unplanned.some(quiet)) continue;
      const what = here.map((g) => g.filter((o) => touches(o, d)).map((o) => flightsOn(o, d)).join('/')).join(', ');
      ctx.review(`${ddmm(d)}: שתי פעילויות ב-FDP נפרדים (${what}), אחת מהן לא בתכנון, ואף חוק לא קבע מה מגיע עליה. דורש בדיקה ידנית.`, second);
    }
  }
}

const addDay = (iso) => new Date(Date.parse(iso) + 864e5).toISOString().slice(0, 10);

const ddmm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
