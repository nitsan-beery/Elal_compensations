// הרצת החוקים על חודש אחד, והשוואה מול מה שזוכה בדוח הביצוע.
//
// הקובץ הזה מחבר בין שלושה חלקים: המודל (ציר ימים וסבבים), הלוגיקות של החוקים,
// וההשוואה מול הדוח. הוא לא מכיר ערכי פיצוי: כל מספר מגיע מ-`rules.json` דרך הלוגיקות.
//
// ההשוואה נעשית ב"קבוצות ימים": סבב ביצוע והימים שהקרדיט שלו התפצל אליהם הם קבוצה אחת,
// וכל יום אחר הוא קבוצה לעצמו. כך טיסת לילה שהקרדיט שלה נרשם בשני ימים נבדקת כמכלול.

import { LOGIC, LOGIC_ORDER } from './logic.js';
import { rulesInEffect, partitionRules, rulesByLogic, classifyCode } from './catalog.js';
import { buildTimeline, buildPairings, markCarryIn, matchPairings, describePairing } from '../model.js';
import { hoursToMin } from '../time.js';
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
  const execPairings = exec ? buildPairings(timeline, domicile, (d) => d.exec?.legs) : [];
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

  const ctx = makeContext({ out, timeline, domicile, codes, holidays: rulesData.holidays ?? {}, answers, plan, exec, supported, matches, planPairings,
    period, fleet,
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
  showSwaps(out, answers);
  if (exec) {
    out.comparison = compare({ out, timeline, execPairings, domicile, codes });
    out.totals = compareTotals(out, exec);
    warnMissingColumns(out, exec);
  }
  return out;
}

// ---------- ctx: מה שהלוגיקות רואות ----------

function makeContext({ out, timeline, domicile, codes, holidays, answers, plan, exec, supported, matches, planPairings, period, fleet, execPairings }) {
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
    monthFirst: timeline[0].date,
    /** ימי חג לפי שנה (`holidays` ב-rules.json). */
    holidays: (year) => holidays[String(year)] ?? null,
    stationOffsets: plan?.stationOffsets ?? null,
    planSummary: plan?.summary ?? null,
    hasExec: !!exec,
    hasPlan: !!plan,
    answer: (id) => answers[id] ?? null,

    /** קודי פעילות ביום (קרקע, סימולטור, כוננות), בלי היעדרות, הערות ו-DUM. לפי הדוח כשיש. */
    activityCodes(day) {
      const list = exec ? execCodesOf(day) : (day.plan?.codes ?? []);
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
      const inExec = days.some((d) => execCodesOf(d).some((c) => same(c, code)));
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
    execCodes: (day) => execCodesOf(day),
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
    /** `date` הוא null בהערה על החודש כולו, בלי יום מסוים. */
    note(date, message, rule) {
      const k = `${date}|${message}`;
      if (noteKeys.has(k)) return;
      noteKeys.add(k);
      out.notes.push({ date, message, ...ruleRef(rule) });
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
 * סבב מתוכנן שלא בוצע, אבל בימים שלו רשומה בדוח מחלה או פעילות קרקע: הסיבה ידועה
 * מהקובץ, ולכן לא שואלים "מה קרה". פעילות קרקע במקום סבב עוברת לבדיקה ידנית,
 * כי אין חוק נתמך שקובע מה מגיע עליה.
 */
function explainByActivity(matches, timeline, codes, isSick) {
  const ground = new Set(codes.ground_activity ?? []);
  const reportLeave = new Set(Object.entries(codes.plan_to_report ?? {})
    .filter(([full]) => (codes.leave ?? []).includes(full)).map(([, short]) => short));
  for (const c of codes.leave ?? []) reportLeave.add(c);

  for (const m of matches) {
    if (m.how !== 'cancelled') continue;
    const found = [];
    for (const day of timeline) {
      if (day.date < m.plan.from || day.date > m.plan.to) continue;
      for (const code of execCodesOf(day)) found.push({ date: day.date, code });
    }
    if (!found.length) continue;
    const kinds = new Set(found.map((f) => (isLeaveCode(f.code, reportLeave, codes) ? 'leave' : ground.has(f.code) ? 'ground' : 'other')));
    if (kinds.has('other')) continue; // קוד לא מוכר: לא מסיקים ממנו, והשאלה תישאל
    m.how = kinds.has('ground') ? 'replaced_by_ground' : 'replaced_by_leave';
    m.replacedBy = found;
    m.byLeave = kinds.has('leave'); // היעדרות של אצ"א בימי הסבב, גם כשאחריה פעילות קרקע
    m.bySick = found.every((f) => isSick(f.code));
  }
}

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
    cancelled: 'סבב מתוכנן שלא בוצע',
    unplanned: 'פעילות ביום לא מתוכנן',
    noplan: 'בוצע (אין קובץ תכנון להשוואה)',
    replaced_by_leave: 'סבב מתוכנן שהוחלף בהיעדרות',
    replaced_by_ground: 'סבב מתוכנן שהוחלף בפעילות קרקע',
  };
  return {
    how: m.how,
    label: m.bySick
      ? `סבב מתוכנן שהוחלף ב${new Set(m.replacedBy.map((r) => r.date)).size > 1 ? 'ימי' : 'יום'} מחלה`
      : labels[m.how] ?? m.how,
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
 * שתוכנן בימים אחרים. כשהיא קושרה לסבב שלא בוצע, שתי השורות מתאחדות לשורה אחת.
 * בלי קישור (טיסה בחודש אחר) – "בחודש אחר" בצד התכנון.
 * סבב שלא בוצע ונענה – התשובה מוצגת בצד הביצוע.
 */
function showSwaps(out, answers) {
  const linkOf = new Map(); // execId → planId | null
  for (const [id, a] of Object.entries(answers)) {
    if (!LINKED_VALUES.includes(a?.value)) continue;
    if (id.startsWith('unplanned:') && !linkOf.get(id.slice(10))) linkOf.set(id.slice(10), a.link ?? null);
    if (id.startsWith('cancelled:') && a.link && a.link !== GAVE_AWAY) linkOf.set(a.link, id.slice(10));
  }
  const drop = new Set();
  for (const c of out.changes) {
    if (c.how !== 'unplanned' || !linkOf.has(c.execId)) continue;
    const planned = out.changes.find((p) => p.how === 'cancelled' && p.planId === linkOf.get(c.execId));
    c.how = 'swap';
    c.label = 'במקום סבב שתוכנן בימים אחרים';
    c.plan = planned?.plan ?? 'בחודש אחר';
    if (planned) { c.planId = planned.planId; drop.add(planned); }
  }
  out.changes = out.changes.filter((c) => !drop.has(c));

  // סבב שבמקומו בוצע סבב אחר באותם ימים: אחרי התשובה, השורה אומרת מה קרה ולא רק מה הוחלף.
  for (const c of out.changes) {
    if (c.how !== 'dates') continue;
    const a = answers[`cancelled:${c.planId}`] ?? answers[`replaced:${c.planId}`];
    if (a) c.label = DATES_OUTCOME[a.value] ?? c.label;
  }

  // סבב שלא בוצע: אחרי התשובה, בצד הביצוע מה שקרה לפיה. ריק רק עד שעונים.
  for (const c of out.changes) {
    if (c.how !== 'cancelled' || c.exec) continue;
    const a = answers[`cancelled:${c.planId}`];
    if (!a) continue;
    const linked = a.link && out.changes.find((x) => x.execId === a.link)?.exec;
    c.exec = a.value === 'voluntary_swap' ? (a.link === GAVE_AWAY ? GAVE_AWAY_LABEL : `החלפה מרצוני – ${linked ?? 'טיסה בחודש אחר'}`)
      : a.value === 'replaced' ? `החלפה ביוזמת החברה – ${linked ?? 'טיסה בחודש אחר'}`
      : a.value === 'other' ? `סיבה אחרת${a.text ? `: ${a.text}` : ''}`
      : CANCELLED_OUTCOME[a.value] ?? a.value;
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
  wet_lease: 'הורדה מהטיסה המקורית',
  trainee: 'הורדה מהטיסה המקורית',
  swap_777: 'הועבר ל-777 (לא כשיר MFF)',
  other: 'סיבה אחרת',
};

/** מה קרה לסבב שלא בוצע, לפי התשובה לשאלה עליו. */
const CANCELLED_OUTCOME = {
  cancelled: 'בוטל ללא פיצוי',
  wet_lease: 'הורדה מהטיסה המקורית', // תשובה שנשמרה לפני שהאפשרויות אוחדו
  trainee: 'הורדה מהטיסה המקורית',
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
 */
function execCodesOf(day) {
  const details = day?.exec?.details;
  if (!details) return [];
  const hasReturnLeg = (day.exec.legs ?? []).some((l) => l.org && l.org === l.dst);
  return details.split(/[,\s]+/).filter((t) => t && !/^[A-Z]{3}-[A-Z]{3}$/.test(t) && !(hasReturnLeg && t === 'LEG'));
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
    for (const c of execCodesOf(day)) if (classifyCode(c, codes, supported) === 'unknown') add(c, 'exec', day);
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

function compare({ out, timeline, execPairings, domicile }) {
  // קבוצות ימים: סבב וימי הפיצול שלו מתאחדים; ימים שחולקים סבב מתאחדים גם הם.
  const parent = new Map(timeline.map((d) => [d.date, d.date]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  const union = (a, b) => parent.set(find(b), find(a));
  const pairingOf = new Map(); // date → הסבבים שנוגעים בו (כמה סבבים באותו יום, 25/11/2025)
  for (const p of execPairings) {
    const dates = reportDates(p, timeline, domicile);
    for (const d of dates) { union(dates[0], d); pairingOf.set(d, [...(pairingOf.get(d) ?? []), p]); }
  }
  for (const e of out.expectations) for (const d of e.dates) if (parent.has(d)) union(e.dates[0], d);

  const groups = new Map();
  for (const d of timeline) {
    const root = find(d.date);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(d.date);
  }

  const rows = [];
  const labelOf = (dates) => {
    const pairings = [...new Set(dates.flatMap((d) => pairingOf.get(d) ?? []))];
    const codes = dates.flatMap((d) => execCodesOf(dayOf(timeline, d)));
    return [
      dates.length === 1 ? ddmm(dates[0]) : `${ddmm(dates[0])}–${ddmm(dates.at(-1))}`,
      pairings.map((p) => describePairing(p).replace(/^\S+\s/, '')).join(' + '),
      codes.join(' '),
    ].filter(Boolean).join(' · ');
  };
  for (const dates of groups.values()) {
    dates.sort();
    const inGroup = out.expectations.filter((e) => dates.includes(e.dates[0]));
    // פער בקבוצה שיש עליה שאלה פתוחה אינו ממצא עדיין: הצפוי תלוי בתשובה.
    const asked = out.questions.some((q) => dates.includes(q.date));
    const push = (row) => {
      const ok = row.reported === row.expected;
      const pending = !ok && asked;
      rows.push({ ...row, diff: row.reported - row.expected, ok: pending ? null : ok, pending });
    };

    // Credit: כל יממה קלנדרית בנפרד, כמו בדוח. ציפייה של כמה ימים (סבב) נרשמת ביום הראשון שלה.
    for (const date of dates) {
      const items = inGroup.filter((e) => KEY_COLUMNS[e.key]?.includes('Credit') && e.dates[0] === date);
      const expected = items.reduce((s, e) => s + e.min, 0);
      const reported = reportedValue(dayOf(timeline, date), 'Credit');
      if (!expected && !reported) continue;
      push({ dates: [date], at: date, label: labelOf([date]), column: 'Credit', expected, reported, items });
    }

    // שאר העמודות על הקבוצה כולה (הדוח רושם Rig של סבב ביום הראשון שלו), ומוצגות אחרי היום האחרון.
    for (const column of COMPARED_COLUMNS) {
      if (column === 'Credit') continue;
      const items = inGroup.filter((e) => KEY_COLUMNS[e.key]?.includes(column));
      const expected = items.reduce((s, e) => s + e.min, 0);
      const reported = dates.reduce((s, d) => s + reportedValue(dayOf(timeline, d), column), 0);
      if (!expected && !reported) continue;
      push({ dates, at: dates.at(-1), label: labelOf(dates), column, expected, reported, items });
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
  return rows.sort((a, b) => at(a).localeCompare(at(b)) || COMPARED_COLUMNS.indexOf(a.column) - COMPARED_COLUMNS.indexOf(b.column));
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
    out.warnings.push(`יש פער ב-${column}, והעמודה לא מופיעה בדוח. ` +
      'בדרך כלל זה אומר שלא היה פיצוי כזה בחודש, אבל ייתכן שהעמודה נחתכה בהדפסה.');
  }
}

const MISSING_COLUMNS_PREFIX = 'עמודות חסרות בדוח';
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
    if (absent.length) warnings.push(`בדוח הביצוע לא נמצאו שורות ${absent.length === 1 ? 'ליום' : 'לימים'} ${list(absent)}. ייתכן שעמוד חסר או נחתך. ${absent.length === 1 ? 'היום נבדק' : 'הימים נבדקים'} כאילו לא הייתה בהם פעילות.`);
    if (exec.legColumns?.length) {
      const cols = Object.keys(EXEC_LEG_FIELDS).filter((c) => !exec.legColumns.includes(c));
      if (cols.length) warnings.push(`בטבלת הרגליים בדוח הביצוע ${cols.length === 1 ? 'חסרה העמודה' : 'חסרות העמודות'} ${cols.join(', ')}. ייתכן ש${cols.length === 1 ? 'היא נחתכה' : 'הן נחתכו'} בהדפסה. חוקים שתלויים בזמני הטיסות לא ייבדקו כראוי.`);
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
    if (incomplete.length) warnings.push(`בדוח הביצוע חסרים ערכים ברגליים: ${list(incomplete)}. החישובים של הרגליים האלה עלולים להיות שגויים.`);
    if (!Object.keys(exec.totals ?? {}).length) warnings.push('לא נמצאה שורת הסיכום של טבלת הימים בדוח הביצוע, ולכן אין השוואה של הסיכומים.');
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
