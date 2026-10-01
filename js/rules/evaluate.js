// הרצת החוקים על חודש אחד, והשוואה מול מה שזוכה בדוח הביצוע.
//
// הקובץ הזה מחבר בין שלושה חלקים: המודל (ציר ימים וסבבים), הלוגיקות של החוקים,
// וההשוואה מול הדוח. הוא לא מכיר ערכי פיצוי: כל מספר מגיע מ-`rules.json` דרך הלוגיקות.
//
// ההשוואה נעשית ב"קבוצות ימים": סבב ביצוע והימים שהקרדיט שלו התפצל אליהם הם קבוצה אחת,
// וכל יום אחר הוא קבוצה לעצמו. כך טיסת לילה שהקרדיט שלה נרשם בשני ימים נבדקת כמכלול.

import { LOGIC, LOGIC_ORDER } from './logic.js';
import { rulesInEffect, partitionRules, rulesByLogic, classifyCode } from './catalog.js';
import { buildTimeline, buildPairings, markCarryIn, matchPairings, describePairing, describeRoute, pairingParts, fdpParts } from '../model.js';
import { hoursToMin, minToHhmm } from '../time.js';
import { OPTIONAL_COLUMNS } from '../pdf/exec.js';

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
 */
export function evaluate({ rulesData, plan = null, exec = null, answers = {} }) {
  if (!plan && !exec) throw new Error('לא הועלה אף קובץ.');
  const period = (exec ?? plan).period;
  const mode = plan && exec ? 'full' : plan ? 'plan' : 'exec';
  // חודש שנשמר בגרסה קודמת מחזיק אזהרת עמודות חסרות מהחילוץ; היא נבנית מחדש כאן.
  const warnings = [...(plan?.warnings ?? []), ...(exec?.warnings ?? []).filter((w) => !w.startsWith(MISSING_COLUMNS_PREFIX) && !w.startsWith(IPAD_WARNING_PREFIX))];
  const missingRequired = (exec?.missingColumns ?? []).filter((c) => !OPTIONAL_COLUMNS.includes(c));
  if (missingRequired.length) {
    warnings.push(`${MISSING_COLUMNS_PREFIX}: ${missingRequired.join(', ')}. ייתכן שהן נחתכו בהדפסה. חוקים שתלויים בהן לא ייבדקו.`);
  }
  checkSameMonthAndEmployee(plan, exec, warnings);
  checkMissingData(plan, exec, warnings);

  const inEffect = rulesInEffect(rulesData, period.year, period.month);
  const { supported, unsupported } = partitionRules(inEffect);
  const codes = rulesData.codes ?? {};

  const timeline = buildTimeline(period, plan, exec);
  const domicile = exec?.domicile ?? guessDomicile(plan);
  if (!domicile) warnings.push('לא ניתן לקבוע את בסיס הבית מהקבצים. חוקים שתלויים בבסיס לא ייבדקו.');
  const fleet = fleetOf(plan) ?? rulesData.crew?.fleet ?? null;

  const planPairings = plan ? buildPairings(timeline, domicile, planLegsWithCredit).map(ftOnLastDay) : [];
  if (exec) markCarryIn(timeline, domicile);
  // חזרה לבסיס אחרי המראה מצטרפת לטיסה שיוצאת אחריה באותו FDP, לפי הגדרת ה-FDP של הסליפ הקצר.
  const slip = supported.find((r) => r.logic.id === 'min_slip_credit')?.logic.params;
  const fdp = slip?.legal_rest_hours != null
    ? { legalRestMin: slip.legal_rest_hours * 60, reportMin: slip.report_minutes_before_std ?? 0 } : null;
  const execPairings = exec ? buildPairings(timeline, domicile, (d) => d.exec?.legs, fdp) : [];
  const matches = mode === 'full'
    ? matchPairings(planPairings, execPairings)
    : mode === 'exec' ? execPairings.map((e) => ({ plan: null, exec: e, how: 'noplan' })) : [];
  explainByActivity(matches, timeline, codes, sickCodeTest(supported));

  const out = {
    period,
    mode,
    domicile,
    fleet,
    rulesVersion: rulesData.rules_version,
    rules: {
      supported: supported.map((r) => r.id),
      unsupported: unsupported.map(({ rule, reason }) => ({ id: rule.id, title: rule.title, category: rule.category, reason })),
    },
    warnings,
    changes: matches.map(describeMatch),
    expectations: [],
    flags: [],
    tabs: [],
    notes: [],
    reviews: [],
    questions: [],
    unknownCodes: collectUnknownCodes(timeline, codes, supported),
    comparison: [],
    totals: [],
    freeDays: null,
  };

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

  const assumed = new Map(); // planId → ערכי התשובה שהאפליקציה הניחה בלי לשאול
  const ctx = makeContext({ out, timeline, domicile, codes, holidays: rulesData.holidays ?? {}, answers, plan, exec, supported, matches, planPairings,
    period, fleet, fdp, assumed,
    // בלי דוח ביצוע, הסבבים המתוכננים משמשים לחישוב הקרדיט והרי"ג הצפויים.
    execPairings: exec ? execPairings : planPairings });

  for (const logicId of LOGIC_ORDER) {
    for (const rule of rulesByLogic(supported, logicId)) {
      LOGIC[logicId](ctx, rule.logic.params ?? {}, rule);
    }
  }
  // לוגיקה נתמכת שלא הוכנסה לסדר ההרצה היא באג, ולא חוק שמדלגים עליו בשקט.
  for (const rule of supported) {
    if (!LOGIC_ORDER.includes(rule.logic.id)) {
      out.reviews.push({ ruleId: rule.id, message: `הלוגיקה "${rule.logic.id}" אינה בסדר ההרצה. החוק לא הורץ.` });
    }
  }

  attachLinkCandidates(out.questions, matches, ctx);
  showSwaps(out, answers, assumed);
  splitChangesByFdp(out, matches, ctx, fdp);
  explainChanges(out, supported);
  explainCompensations(out);
  if (exec) {
    out.comparison = compare({ out, timeline, execPairings, domicile, codes, fdp });
    explainUnexplained(out);
    out.totals = compareTotals(out, exec);
    warnMissingColumns(out, exec);
  }
  // מה שמוסבר בטבלת השינויים אינו חוזר בהערות (בעל המוצר, 01/10/2026).
  out.notes = out.notes.filter((n) => !n.placed);
  // כמו שאר הטבלאות: לפי תאריך. הערה בלי תאריך (על החודש כולו) בסוף.
  out.notes.sort((a, b) => (a.date ?? '￿').localeCompare(b.date ?? '￿'));
  return out;
}

// ---------- ctx: מה שהלוגיקות רואות ----------

function makeContext({ out, timeline, domicile, codes, holidays, answers, plan, exec, supported, matches, planPairings, period, fleet, execPairings, fdp, assumed }) {
  const absenceBy = new Map(); // date → Set(ruleId)
  const pairingTags = new Map(); // pairing.id → Set(tag)
  const askedIds = new Set();
  const noteKeys = new Set();
  const reviewKeys = new Set();
  const ruleRef = (rule) => ({ ruleId: rule.id, ruleTitle: rule.title, ...(rule.short_title && { shortTitle: rule.short_title }) });
  const linkedSwap = (prefix, pairingId) => {
    const hit = Object.entries(answers).find(([id, a]) =>
      id.startsWith(prefix) && LINKED_VALUES.includes(a.value) && a.link === pairingId);
    return hit ? { value: hit[1].value, via: hit[0] } : null;
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
    /** הגדרת ה-FDP של הסליפ הקצר (מנוחה חוקית, זמן התייצבות), null בלי הפרמטרים שלה. */
    fdp,
    monthFirst: timeline[0].date,
    /** ימי חג לפי שנה (`holidays` ב-rules.json). */
    holidays: (year) => holidays[String(year)] ?? null,
    stationOffsets: plan?.stationOffsets ?? null,
    planSummary: plan?.summary ?? null,
    hasExec: !!exec,
    hasPlan: !!plan,
    answer: (id) => answers[id] ?? null,
    /** תשובה על סבב מתוכנן שהאפליקציה מניחה בלי לשאול, כי הדוח כבר זיכה: לשורת השינוי ולהערה עליו. */
    assumeAnswer(pairing, value) {
      assumed.set(pairing.id, [...new Set([...(assumed.get(pairing.id) ?? []), value])]);
    },

    /** קודי פעילות ביום (קרקע, סימולטור, כוננות), בלי היעדרות, הערות ו-DUM. לפי הדוח כשיש. */
    activityCodes(day) {
      const list = exec ? execCodesOf(day, codes) : (day.plan?.codes ?? []);
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
    expectPairingDay(pairing, date, key, min, rule, note) {
      if (!min) return;
      out.expectations.push({ date, dates: [date], pairingId: pairing.id,
        pairing: describePairing(pairing), key, min, note, ...ruleRef(rule) });
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
    isAbsenceBy: (date, ruleId) => absenceBy.get(date)?.has(ruleId) ?? false,
    execCodes: (day) => execCodesOf(day, codes),
    /** ימים ללא פעילות בתכנון מול המינימום בהסכם, לסיכום החודשי. */
    setFreeDays(v) { out.freeDays = v; },
    /** קודים בתכנון שאינם היעדרות, הערה או DUM: פעילות, וגם קוד לא מוכר (לא מניחים שהוא יום פנוי). */
    planActivityCodes: (day) => (day.plan?.codes ?? []).filter((c) => !isLeaveCode(c, leave, codes) && !isIgnoredPlanCode(c, codes)),

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
     * שהמשתמש כתב, ומוצגת עם "לפי תשובת המשתמש".
     */
    note(date, message, rule, extra) {
      const k = `${date}|${message}`;
      if (noteKeys.has(k)) return;
      noteKeys.add(k);
      out.notes.push({ date, message, ...ruleRef(rule), ...extra });
    },
    /**
     * חוק שרשם הערה על סבב בלי לדעת כמה מגיע (`extra.dueFor`, מזהה הסבב) משאיר אותה פתוחה,
     * והחוק שקובע את הסכום משלים אותה, במקום הערה שנייה על אותו פיצוי (בעל המוצר, 01/10/2026).
     */
    amendNote(pairing, text) {
      for (const n of out.notes) if (n.dueFor === pairing.id) n.message = n.message.replace(/[.]$/, '') + text;
    },
    ask(question) {
      if (askedIds.has(question.id) || answers[question.id]) return;
      askedIds.add(question.id);
      out.questions.push(question);
    },

    /**
     * התשובה שרלוונטית להתאמה. החלפה מרצון שקושרה לסבב בצד השני סוגרת גם את
     * השאלה עליו, בשני הכיוונים: ביצוע לא מתוכנן ↔ תכנון שלא בוצע.
     */
    answerFor(match) {
      if (match.exec) {
        const direct = answers[`unplanned:${match.exec.id}`];
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

    /** סכום עמודה בדוח על ימי הסבב, כולל יום שהקרדיט התפצל אליו. */
    reportedOn(pairing, column) {
      return reportDates(pairing, timeline, domicile)
        .reduce((s, date) => s + (dayOf(timeline, date)?.exec?.values?.[column]?.min ?? 0), 0);
    },

    /** מה שכבר צפוי על סבב בסוג מסוים (למשל השלמה לסליפ קצר ב-Rig), בלי החוקים שב-`except`. */
    expectedOn: (pairing, key, except = []) => out.expectations
      .filter((e) => e.pairingId === pairing.id && e.key === key && !except.includes(e.ruleId)).reduce((s, e) => s + e.min, 0),

    /** מה שצפוי על ימי הסבב בדוח: ציפיות של הסבב, וציפיות לפי תאריך שנופלות בימים שלו. */
    expectedAround(pairing, key) {
      const dates = reportDates(pairing, timeline, domicile);
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
      const reported = reportDates(pairing, timeline, domicile)
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
 */
function explainByActivity(matches, timeline, codes, isSick) {
  const ground = new Set(codes.ground_activity ?? []);
  const reportLeave = new Set(Object.entries(codes.plan_to_report ?? {})
    .filter(([full]) => (codes.leave ?? []).includes(full)).map(([, short]) => short));
  for (const c of codes.leave ?? []) reportLeave.add(c);
  const kindOf = (code) => isStandbyCode(code) ? 'standby' : isSick(code) ? 'sick' :
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
    if (kinds.has('other')) continue; // קוד לא מוכר: לא מסיקים ממנו, והשאלה תישאל
    m.replacedBy = found;
    m.byLeave = kinds.has('leave') || kinds.has('sick'); // היעדרות או מחלה, גם כשמעורבת גם כוננות
    m.how = kinds.has('ground') ? 'replaced_by_ground'
      : kinds.has('sick') && kinds.has('standby') ? 'replaced_by_sick_standby'
      : kinds.has('sick') ? 'replaced_by_sick'
      : kinds.has('standby') ? 'replaced_by_standby'
      : 'replaced_by_leave';
  }
}

/** קוד כוננות: כל קוד שמתחיל ב-SBY. כוננות אינה פעילות קרקע, גם ש-SBY_S/SBY_L ברשימת הקודים ל-`ground_activity` (בעל המוצר, 27/09/2026). */
const isStandbyCode = (code) => code.startsWith('SBY');

/** קודי מחלה (כולל מחלת בן משפחה): הקודים של חוקי זיכוי היום שמסמנים את עמודת SICK או SCKFM בדוח. */
function sickCodeTest(supported) {
  const sick = supported.filter((r) => r.logic.id === 'absence_day_credit' &&
    [r.logic.params?.report_flag_column ?? []].flat().some((c) => c === 'SICK' || c === 'SCKFM'));
  const exact = new Set(sick.flatMap((r) => [...(r.logic.params.plan_codes ?? []), ...(r.logic.params.report_codes ?? [])]));
  const prefixes = sick.flatMap((r) => [...(r.logic.params.plan_code_prefixes ?? []), ...(r.logic.params.report_code_prefixes ?? [])]);
  return (c) => exact.has(c) || prefixes.some((p) => c.startsWith(p));
}

function describeMatch(m) {
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
    replaced_by_standby: 'סבב מתוכנן שבוטל והוצבת לכוננות',
    replaced_by_sick_standby: 'סבב מתוכנן שבוטל עקב מחלה והוצבת לכוננות',
  };
  return {
    how: m.how,
    label: labels[m.how] ?? m.how,
    date: (m.plan ?? m.exec).from,
    planId: m.plan?.id ?? null,
    execId: m.exec?.id ?? null,
    plan: m.plan ? describePairing(m.plan) : null,
    exec: m.exec ? describePairing(m.exec) : null,
    replacedBy: m.replacedBy?.map((r) => `${r.code} ${r.date.slice(8, 10)}/${r.date.slice(5, 7)}`) ?? null,
  };
}

/**
 * פעילות לא מתוכננת שהמשתמש ענה שהיא החלפה מרצון: בשינויים היא מוצגת "במקום" הסבב
 * שתוכנן בימים אחרים. כשהיא קושרה לסבב שלא בוצע, גם הסבב שלא בוצע נשאר בשינויים, ביום
 * שלו, עם ההחלפה בצד הביצוע: זה עדיין שינוי (בעל המוצר, 29/09/2026).
 * בלי קישור (טיסה בחודש אחר) – "בחודש אחר" בצד התכנון.
 * סבב שלא בוצע ונענה – התשובה מוצגת בצד הביצוע.
 * בלי תשובה, כשהדוח כבר זיכה והאפליקציה הניחה אותה (`assumed`, planId → ערכים), מוצגת ההנחה
 * באותה לשון (בעל המוצר, 29/09/2026).
 */
function showSwaps(out, answers, assumed) {
  const linkOf = new Map(); // execId → { planId | null, value }
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
    if (!planned) continue;
    c.planId = planned.planId;
    planned.exec = `${value === 'replaced' ? 'החלפה ביוזמת החברה' : 'החלפה מרצוני'} – ${c.exec}`;
  }

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
    c.exec = a.value === 'voluntary_swap' ? (a.link === GAVE_AWAY ? GAVE_AWAY_LABEL : `החלפה מרצוני – ${linked ?? 'טיסה בחודש אחר'}`)
      : a.value === 'replaced' ? `החלפה ביוזמת החברה – ${linked ?? 'טיסה בחודש אחר'}`
      : a.value === 'other' ? `סיבה אחרת${a.text ? `: ${a.text}` : ''}`
      : CANCELLED_OUTCOME[a.value] ?? a.value;
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
    return parts.map((p, i) => ({ ...c, date: p.from, until: parts[i + 1]?.from ?? null, exec: describePairing(p) }));
  });
}

/** לוגיקות שהערה שלהן מסבירה שינוי בין התכנון לביצוע. */
const CHANGE_LOGIC = new Set(['credit_from_scheduled', 'cancelled_no_compensation', 'voluntary_swap', 'higher_of_planned_performed',
  'lost_hours_credit', 'special_call', 'training_cancelled_flight', 'standby_end_for_bid', 'standby_activation', 'vacation_recall', 'dh_activated']);
/** לוגיקות שהזיכוי שלהן הוא חלק ממה שמגיע על השינוי עצמו (ולא, למשל, נחיתה מאוחרת). */
const CHANGE_DUE_LOGIC = new Set([...CHANGE_LOGIC, 'absence_day_credit', 'min_slip_credit']);
/** ניסוח קצר של מה שמגיע בהערה על שינוי, במקום שם החוק. */
const DUE_WORDING = {
  credit_from_scheduled: 'קרדיט הטיסה',
  lost_hours_credit: 'קרדיט של הטיסה',
  special_call: 'קריאה מיוחדת',
  min_slip_credit: 'השלמה לסליפ קצר',
  higher_of_planned_performed: 'קרדיט נוסף (הגבוה מבין השתיים)',
};

/**
 * מה מגיע על כל שינוי בין התכנון לביצוע, מתחת לשורה שלו בטבלת השינויים ולא בהערות (`notes` של
 * השינוי; בעל המוצר, 01/10/2026). הערה שחוק רשם על השינוי עוברת לשם (`placed`); לשאר נבנה משפט
 * כללי: מה מגיע עליו לפי החוקים, שלא מגיע דבר, או שממתינים לתשובה.
 */
function explainChanges(out, supported) {
  const logicOf = new Map(supported.map((r) => [r.id, r.logic.id]));
  const rangeOf = (id) => String(id ?? '').match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2}):/)?.slice(1) ?? null;
  for (const c of out.changes) {
    if (c.how === 'exact' || c.how === 'noplan') continue;
    const ids = [c.planId, c.execId].filter(Boolean);
    // סבב שבוצע במקום סבב שתוכנן בימים אחרים, כשלסבב שלא בוצע יש שורה משלו: כל שורה עם ההערה של הימים
    // שלה, ולא "לא מגיע קרדיט על היום הזה" גם מתחת לטיסה שבוצעה (09/09/2024, בעל המוצר 01/10/2026).
    const planRow = !!c.execId && !!c.planId && out.changes.some((p) => p !== c && p.planId === c.planId && !p.execId);
    const ranges = (planRow ? [c.execId] : ids).map(rangeOf).filter(Boolean);
    // שורה אחת מכמה על אותו סבב (`splitChangesByFdp`): רק מה שנרשם בימים שלה.
    const own = (d) => c.until === undefined || (c.date <= d && (!c.until || d < c.until));
    const within = (d) => !!d && own(d) && ranges.some(([from, to]) => from <= d && d <= to);
    const ruled = out.notes.filter((n) => !n.aside && CHANGE_LOGIC.has(logicOf.get(n.ruleId)) && within(n.date));
    if (ruled.length) {
      // שם השינוי כבר בשורה שלו, ולכן הוא יורד מראש ההערה.
      const leads = [c.label, c.label.replace('מרצוני', 'מרצון')].map((l) => `${l}: `);
      c.notes = ruled.map((n) => {
        n.placed = true;
        const lead = leads.find((l) => n.message.startsWith(l));
        return { message: lead ? n.message.slice(lead.length) : n.message, byUser: !!n.byUser };
      });
      continue;
    }

    // קצר ובלי מספרי הטיסות, שכבר מופיעים בשינויים: רק מה מגיע או לא מגיע (בעל המוצר, 29/09/2026).
    // התוצאה לפי התשובה (למשל "הורדה מהטיסה ביוזמת החברה") כשהיא אינה תיאור של טיסה.
    const outcome = c.how === 'cancelled' && !c.execId && c.exec ? `${c.exec}, ` : '';
    let due;
    let elsewhere = '';
    if (out.questions.some((q) => ids.some((id) => q.id.endsWith(`:${id}`)))) {
      due = 'ממתין לתשובה בשאלה על הסבב';
    } else {
      const byWhat = new Map();
      for (const e of out.expectations) {
        const logic = logicOf.get(e.ruleId);
        if (!CHANGE_DUE_LOGIC.has(logic)) continue;
        if (e.pairingId ? !ids.includes(e.pairingId) || !own(e.date) : !within(e.date)) continue;
        // רשום על הטיסה הזאת, אבל שייך להחלפה של סבב מתוכנן אחר (`forPlan`): לא חלק ממה שמגיע עליה
        // (10/06/2026: ה-RIG ‏05:10 של ההחלפה של LTN ב-11/06, בעל המוצר 29/09/2026).
        if (e.forPlan && !ids.includes(e.forPlan)) {
          const on = rangeOf(e.forPlan)?.[0];
          elsewhere += ` בנוסף, ברומה רשום ביום הזה ${minToHhmm(e.min)} כקרדיט נוסף (${e.key === 'rig' ? 'RIG' : e.key.toUpperCase()}) ` +
            `על החלפה ביוזמת החברה${on ? ` ב-${on.slice(8, 10)}/${on.slice(5, 7)}` : ''}.`;
          continue;
        }
        const what = DUE_WORDING[logic] ?? (logic === 'absence_day_credit' ? `קרדיט ${e.ruleTitle}` : e.shortTitle ?? e.ruleTitle);
        if (!byWhat.has(what)) byWhat.set(what, { min: 0, days: new Map() });
        const g = byWhat.get(what);
        g.min += e.min;
        // זיכוי יומי (בלי סבב): כמה ביום ועל אילו ימים, כדי שהסכום יהיה מובן (13/07/2026: 2 × 02:30).
        if (!e.pairingId) g.days.set(e.date, (g.days.get(e.date) ?? 0) + e.min);
      }
      const items = [...byWhat].map(([what, { min, days }]) => {
        if (days.size < 2 || [...days.values()].reduce((s, m) => s + m, 0) !== min) return `${what} ${minToHhmm(min)}`;
        const ds = [...days.keys()].sort().map((d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`);
        const on = `${ds.slice(0, -1).join(', ')} ו-${ds.at(-1)}`;
        const amounts = new Set(days.values());
        const each = amounts.size === 1 ? `${minToHhmm([...amounts][0])} ליום על ${on}`
          : [...days].sort(([a], [b]) => a.localeCompare(b)).map(([d, m]) => `${minToHhmm(m)} ב-${d.slice(8, 10)}/${d.slice(5, 7)}`).join(', ');
        return `${what} ${each}, סה"כ ${minToHhmm(min)}`;
      });
      // בלי "מגיע" בראש המשפט, כמו בהערות שהחוקים רושמים על שינוי (בעל המוצר, 01/10/2026).
      due = items.length ? (items.length > 1 ? `${items.slice(0, -1).join(', ')} ו${items.at(-1)}` : items[0]) : 'לא מגיע קרדיט ולא פיצוי';
    }
    c.notes = [{ message: `${outcome}${due}.${elsewhere}`, byUser: false }];
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
    const why = String(e.note ?? '').replace(/^\u2066[^\u2069]*\u2069(?: (?:→ |ו-)\u2066[^\u2069]*\u2069)*: /, '').replace(/\.$/, '');
    e.explain = why ? `${why}.` : '';
  }
}

/** פיצוי שרשום ברומה ואף חוק אינו מסביר: גם הוא בשורה שלו (`notes`). שורה שממתינה לתשובה אינה ממצא עדיין. */
function explainUnexplained(out) {
  for (const row of out.comparison) {
    if (!COMPENSATION_COLUMNS.includes(row.column) || row.pending || row.reported <= row.expected) continue;
    row.notes = [`ברומה רשום פיצוי ${minToHhmm(row.reported - row.expected)} שאף חוק אינו מסביר.`];
  }
}

/** תשובות שמקשרות בין סבב מתוכנן שלא בוצע לבין הטיסה שבוצעה במקומו בתאריכים אחרים. */
const LINKED_VALUES = ['voluntary_swap', 'replaced'];

/** קישור של החלפה מרצון על סבב שלא בוצע: הטיסה נמסרה בלי לקבל טיסה אחרת במקומה. */
const GAVE_AWAY = 'none';
const GAVE_AWAY_LABEL = 'מסירת הטיסה ללא חלופה';

/** מה קרה לסבב שבמקומו בוצע סבב אחר באותם ימים, לפי התשובה לשאלה עליו. */
const DATES_OUTCOME = {
  replaced: 'החלפה ביוזמת החברה',
  voluntary_swap: 'החלפה מרצוני',
  cancelled: 'המתוכנן בוטל, ומה שבוצע לא היה מתוכנן',
  wet_lease: 'הורדה מהטיסה ביוזמת החברה',
  trainee: 'הורדה מהטיסה ביוזמת החברה',
  swap_777: 'הועבר ל-777 (לא כשיר MFF)',
  other: 'סיבה אחרת',
  diversion: 'סטיה לשדה משנה', // הנחה בלבד (`assumeDiversion`), אינה אפשרות בשאלה
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
function attachLinkCandidates(questions, matches, ctx) {
  const cancelled = matches.filter((m) => m.how === 'cancelled').map((m) => ({ id: m.plan.id, label: describePairing(m.plan) }));
  // פעילות שזוהתה כקריאה מיוחדת (S/C בדוח), או טיסה בסוף כוננות, אינה החלפה.
  const notSwap = ['special_call', 'standby_bid_pending', 'standby_bid', 'standby_activated'];
  const unplanned = matches.filter((m) => m.how === 'unplanned' && !notSwap.some((t) => ctx.pairingHandledBy(m.exec, t)))
    .map((m) => ({ id: m.exec.id, label: describePairing(m.exec) }));
  const otherMonth = { id: null, label: 'טיסה בחודש אחר' };
  const gaveAway = { id: GAVE_AWAY, label: GAVE_AWAY_LABEL };
  const execLabel = new Map(matches.filter((m) => m.exec).map((m) => [m.exec.id, describePairing(m.exec)]));
  for (const q of questions) {
    const onCancelled = q.id.startsWith('cancelled:');
    const own = onCancelled && q.execId ? [{ id: q.execId, label: execLabel.get(q.execId) ?? q.execId }] : [];
    const pool = q.id.startsWith('unplanned:') ? cancelled : onCancelled ? [...own, ...unplanned] : [];
    for (const o of q.options ?? []) {
      if (o.needsLink) o.linkCandidates = [...pool, otherMonth, ...(onCancelled && !own.length && o.value === 'voluntary_swap' ? [gaveAway] : [])];
    }
  }
}

// ---------- קודים ----------

/**
 * קודי היום בדוח הביצוע, בלי מסלולי הטיסה ("TLV-AMS"). רגל שחוזרת לשדה המוצא
 * (TLV→TLV) מופיעה במסלולים כ-"LEG" (15/02/2026), ולכן גם הוא מסלול ביום שיש בו רגל כזו.
 * קוד מ-`ignored_report_codes` (UNF_B) אינו מזכה בכלום ואינו מוצג, ולכן מושמט כאן.
 */
function execCodesOf(day, codes) {
  const details = day?.exec?.details;
  if (!details) return [];
  const hasReturnLeg = (day.exec.legs ?? []).some((l) => l.org && l.org === l.dst);
  const hidden = new Set(codes?.ignored_report_codes ?? []);
  return details.split(/[,\s]+/).filter((t) => t && !/^[A-Z]{3}-[A-Z]{3}$/.test(t) && !(hasReturnLeg && t === 'LEG') && !hidden.has(t));
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
 */
function collectUnknownCodes(timeline, codes, supported) {
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
  return [...found.values()];
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
 * הקרדיט של רגל כזו מתפצל בדוח בין שני הימים (אומת: LY336, 16–17/07).
 */
function reportDates(pairing, timeline, domicile) {
  const dates = [...pairing.dates];
  const last = pairing.legs.at(-1);
  if (last?.dst === domicile) {
    const crossesSked = last.sta != null && last.skdDur != null && last.sta - last.skdDur < 0;
    const crossesAct = last.ata != null && last.actDur != null && last.ata - last.actDur < 0;
    const next = timeline[timeline.findIndex((d) => d.date === pairing.to) + 1];
    if ((crossesSked || crossesAct) && next && !dates.includes(next.date)) dates.push(next.date);
  }
  return dates;
}

const dayOf = (timeline, date) => timeline.find((d) => d.date === date);

function reportedValue(day, column) {
  const v = day?.exec?.values ?? {};
  if (column === 'FLT+DH') return (v.FLT?.min ?? 0) + (v.DH?.min ?? 0);
  return v[column]?.min ?? 0;
}

function compare({ out, timeline, execPairings, domicile, codes: catalog, fdp }) {
  // קבוצות ימים: סבב וימי הפיצול שלו מתאחדים; ימים שחולקים סבב מתאחדים גם הם.
  const parent = new Map(timeline.map((d) => [d.date, d.date]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  const union = (a, b) => parent.set(find(b), find(a));
  const pairingOf = new Map(); // date → הסבבים שנוגעים בו (כמה סבבים באותו יום, 25/11/2025)
  for (const p of execPairings) {
    const dates = reportDates(p, timeline, domicile);
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
  const expectations = out.expectations.map((e) => {
    const to = e.showOn && execPairings.find((p) => p.id === e.showOn);
    if (!to) return e;
    const column = KEY_COLUMNS[e.key][0];
    const from = execPairings.find((p) => p.id === e.pairingId);
    const days = from ? reportDates(from, timeline, domicile) : e.dates;
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

  const rows = [];
  const range = (ds) => (ds.length === 1 ? ddmm(ds[0]) : `${ddmm(ds[0])}–${ddmm(ds.at(-1))}`);
  // קטעים לועזיים, כל אחד מבודד (LRI/PDI): התאריכים הכי ימניים, ומשמאלם פרטי הטיסה. בלי בידוד
  // הדפדפן הופך את שני התאריכים, ובלי הפרדה התווית כולה נקראת משמאל לימין והתאריכים יוצאים משמאל.
  // כל סבב בשורה משלו, עם התאריכים שלו בשורה, והקודים בסוף השורה האחרונה (בעל המוצר, 28/09/2026).
  // חזרה לבסיס אחרי המראה שמחוברת לסבב שאחריה מוצגת כסבב נפרד (`pairingParts`), ורק בשורות הקרדיט:
  // פיצוי (COM, S/C) שייך לסבב שאחריה (15/02/2026: נחיתה מאוחרת של LY2368).
  // `only`: הסבבים של השורה, ו-`dayCodes`: קודי היום שבה, כשהקבוצה פוצלה (`splitByPairing`).
  const labelOf = (dates, column, only = null, dayCodes = null) => {
    const parts = (only ?? [...new Set(dates.flatMap((d) => pairingOf.get(d) ?? []))]).flatMap(pairingParts)
      .map((part) => ({ part, days: reportDates(part, timeline, domicile).filter((d) => dates.includes(d)) }))
      .filter(({ part, days }) => days.length && (CREDIT_LABEL_COLUMNS.includes(column) || !part.legs.every((l) => l.org === l.dst)));
    const lines = parts.length === 1
      ? [[range(dates), describeRoute(parts[0].part)]]
      : parts.map(({ part, days }) => [range(days), describeRoute(part)]);
    const codes = (dayCodes ?? dates.flatMap((d) => execCodesOf(dayOf(timeline, d), catalog))).join(' ');
    // בלי סבב שבוצע: הטיסה שתוכננה, כשציפייה עליה נושאת אותה (`plannedRoute`, הורדה מהטיסה).
    const planned = [...new Set(expectations.filter((e) => e.plannedRoute && dates.includes(e.dates[0])).map((e) => e.plannedRoute))];
    if (!lines.length) lines.push([range(dates), planned.join(', ')]);
    if (codes) lines.at(-1)[1] = [lines.at(-1)[1], codes].filter(Boolean).join(' · ');
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
      : own.flatMap((d) => execCodesOf(dayOf(timeline, d), catalog).filter((c) => !split.has(`${c}@${d}`))));
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
        push({ dates, at: dates.at(-1), label: labelOf(dates, column, only, codes), column, expected, reported, items });
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
 */
function compareTotals(out, exec) {
  const sum = (column) => out.comparison.filter((r) => r.column === column).reduce((s, r) => s + r.expected, 0);
  const t = { ...exec.totals };
  for (const c of exec.missingColumns ?? []) if (OPTIONAL_COLUMNS.includes(c)) t[c] ??= 0;
  const rows = [
    { column: 'Credit', expected: sum('Credit'), reported: t.Credit ?? null },
    { column: 'Rig', expected: sum('Rig'), reported: t.Rig ?? null },
    { column: 'COM', expected: sum('COM'), reported: t.COM ?? null },
    { column: 'S/C', expected: sum('S/C'), reported: t['S/C'] ?? null },
  ];
  return rows.map((r) => ({ ...r, ok: r.reported == null ? null : r.reported === r.expected }));
}

/**
 * עמודת פיצוי חסרה אינה תקלה, אבל אם יש פער בסיכום שהיא חלק ממנו, ייתכן שהיא נחתכה בהדפסה.
 */
function warnMissingColumns(out, exec) {
  const missing = (exec.missingColumns ?? []).filter((c) => OPTIONAL_COLUMNS.includes(c));
  for (const column of missing) {
    if (out.totals.find((t) => t.column === column)?.ok !== false) continue;
    out.warnings.push(`יש פער ב-${column}, והעמודה לא מופיעה ברומה. ` +
      'בדרך כלל זה אומר שלא היה פיצוי כזה בחודש, אבל ייתכן שהעמודה נחתכה בהדפסה.');
  }
}

const MISSING_COLUMNS_PREFIX = 'עמודות חסרות ברומה';
// אזהרה שהייתה נשמרת בחודשים שחולצו לפני שהוסרה (קובץ שהודפס מ-iPad).
const IPAD_WARNING_PREFIX = 'הקובץ הודפס מ-iPad';

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
        // DHX היא DH בחברה אחרת, ואין לה מספר טיסה של אל על (Flt 0).
        const gaps = Object.entries(EXEC_LEG_FIELDS)
          .filter(([c, f]) => l[f] == null && exec.legColumns?.includes(c) && !(c === 'Flt' && l.type === 'DHX'))
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

const ddmm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
