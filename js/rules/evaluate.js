// הרצת החוקים על חודש אחד, והשוואה מול מה שזוכה בדוח הביצוע.
//
// הקובץ הזה מחבר בין שלושה חלקים: המודל (ציר ימים וסבבים), הלוגיקות של החוקים,
// וההשוואה מול הדוח. הוא לא מכיר ערכי פיצוי: כל מספר מגיע מ-`rules.json` דרך הלוגיקות.
//
// ההשוואה נעשית ב"קבוצות ימים": סבב ביצוע והימים שהקרדיט שלו התפצל אליהם הם קבוצה אחת,
// וכל יום אחר הוא קבוצה לעצמו. כך טיסת לילה שהקרדיט שלה נרשם בשני ימים נבדקת כמכלול.

import { LOGIC, LOGIC_ORDER } from './logic.js';
import { rulesInEffect, partitionRules, rulesByLogic, classifyCode } from './catalog.js';
import { buildTimeline, buildPairings, matchPairings, describePairing } from '../model.js';
import { hoursToMin } from '../time.js';

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
  const warnings = [...(plan?.warnings ?? []), ...(exec?.warnings ?? [])];
  checkSameMonthAndEmployee(plan, exec, warnings);

  const inEffect = rulesInEffect(rulesData, period.year, period.month);
  const { supported, unsupported } = partitionRules(inEffect);
  const codes = rulesData.codes ?? {};

  const timeline = buildTimeline(period, plan, exec);
  const domicile = exec?.domicile ?? guessDomicile(plan);
  if (!domicile) warnings.push('לא ניתן לקבוע את בסיס הבית מהקבצים. חוקים שתלויים בבסיס לא ייבדקו.');

  const planPairings = plan ? buildPairings(timeline, domicile, (d) => planLegsWithCredit(d.plan)) : [];
  const execPairings = exec ? buildPairings(timeline, domicile, (d) => d.exec?.legs) : [];
  const matches = mode === 'full'
    ? matchPairings(planPairings, execPairings)
    : mode === 'exec' ? execPairings.map((e) => ({ plan: null, exec: e, how: 'noplan' })) : [];
  explainByActivity(matches, timeline, codes);

  const out = {
    period,
    mode,
    domicile,
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
    planCheck: null,
  };

  for (const m of matches) {
    if (m.how !== 'replaced_by_ground') continue;
    out.reviews.push({ ruleId: null, ruleTitle: null,
      message: `${describePairing(m.plan)} הוחלף בפעילות קרקע (${m.replacedBy.map((r) => r.code).join(', ')}). ` +
        'אין חוק נתמך שקובע מה מגיע במקרה הזה. דורש בדיקה ידנית.' });
  }

  const ctx = makeContext({ out, timeline, domicile, codes, answers, plan, supported, matches,
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

  attachLinkCandidates(out.questions, matches);
  if (exec) {
    out.comparison = compare({ out, timeline, execPairings, domicile, codes });
    out.totals = compareTotals(out, exec);
  }
  if (plan) out.planCheck = checkPlanFictTime(plan, mode === 'plan' ? out : evaluate({ rulesData, plan }));
  return out;
}

// ---------- ctx: מה שהלוגיקות רואות ----------

function makeContext({ out, timeline, domicile, codes, answers, plan, supported, matches, execPairings }) {
  const absenceBy = new Map(); // date → Set(ruleId)
  const pairingTags = new Map(); // pairing.id → Set(tag)
  const askedIds = new Set();
  const noteKeys = new Set();
  const ruleRef = (rule) => ({ ruleId: rule.id, ruleTitle: rule.title });

  const planRanges = plan ? buildPairings(timeline, domicile, (d) => d.plan?.legs) : [];
  const leave = new Set(codes.leave ?? []);
  const activityCodes = new Set([...(codes.relevant ?? []).filter((c) => !leave.has(c)), ...(codes.ground_activity ?? [])]);

  return {
    timeline,
    execPairings,
    matches,
    domicile,

    expect(date, key, min, rule, note) {
      if (!min) return;
      out.expectations.push({ date, dates: [date], key, min, note, ...ruleRef(rule) });
    },
    expectPairing(pairing, key, min, rule, note) {
      if (!min) return;
      out.expectations.push({ date: pairing.from, dates: [...pairing.dates], pairingId: pairing.id,
        pairing: describePairing(pairing), key, min, note, ...ruleRef(rule) });
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
        if (leave.has(code) || isIgnoredPlanCode(code, codes)) continue;
        unknown = true;
      }
      if (!unknown) return false;
      const a = answers[`assigned:${date}`];
      return a ? a.value === 'yes' : null;
    },

    review(message, rule) {
      out.reviews.push({ message, ...ruleRef(rule) });
    },
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

    /** התשובה שרלוונטית להתאמה. החלפה מרצון שקושרה לסבב מתוכנן סוגרת גם את השאלה עליו. */
    answerFor(match) {
      if (match.exec && answers[`unplanned:${match.exec.id}`]) return answers[`unplanned:${match.exec.id}`];
      if (match.plan) {
        const direct = answers[`cancelled:${match.plan.id}`] ?? answers[`replaced:${match.plan.id}`];
        if (direct) return direct;
        const linked = Object.entries(answers).find(([id, a]) =>
          id.startsWith('unplanned:') && a.value === 'voluntary_swap' && a.link === match.plan.id);
        if (linked) return { value: 'voluntary_swap', via: linked[0] };
      }
      return null;
    },

    pairingHandledBy: (pairing, tag) => !!pairing && (pairingTags.get(pairing.id)?.has(tag) ?? false),
    markPairing(pairing, tag) {
      if (!pairingTags.has(pairing.id)) pairingTags.set(pairing.id, new Set());
      pairingTags.get(pairing.id).add(tag);
    },

    /** קרדיט מתוכנן של סבב: סכום ה-FT בתכנון. FT כבר מתוקן לאזורי זמן. */
    plannedCredit(planPairing) {
      if (!plan) return null;
      let sum = 0;
      for (const date of planPairing.dates) {
        const ft = plan.days[date]?.info?.FT;
        if (ft == null) return null;
        sum += ft;
      }
      return sum || null;
    },

    minSlipMinutes() {
      const rule = rulesByLogic(supported, 'min_slip_credit')[0];
      return rule ? hoursToMin(rule.logic.params?.min_credit_hours) : null;
    },

    /** סכום עמודה בדוח על ימי הסבב, כולל יום שהקרדיט התפצל אליו. */
    reportedOn(pairing, column) {
      return reportDates(pairing, timeline, domicile)
        .reduce((s, date) => s + (dayOf(timeline, date)?.exec?.values?.[column]?.min ?? 0), 0);
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
 * על הרגל האחרונה של היום בלבד, והוא הקרדיט של כל הרגליים באותו יום.
 */
function planLegsWithCredit(planDay) {
  const legs = planDay?.legs ?? [];
  if (!legs.length) return legs;
  const ft = planDay.info?.FT ?? null;
  return legs.map((l, i) => ({ ...l, skdDur: i === legs.length - 1 ? ft : ft == null ? null : 0 }));
}

/** בסיס הבית בלי דוח ביצוע: שדה ההתייצבות הנפוץ בתכנון. */
function guessDomicile(plan) {
  const count = {};
  for (const d of Object.values(plan?.days ?? {})) if (d.pickup?.org) count[d.pickup.org] = (count[d.pickup.org] ?? 0) + 1;
  return Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * סבב מתוכנן שלא בוצע, אבל בימים שלו רשומה בדוח מחלה או פעילות קרקע: הסיבה ידועה
 * מהקובץ, ולכן לא שואלים "מה קרה". פעילות קרקע במקום סבב עוברת לבדיקה ידנית,
 * כי אין חוק נתמך שקובע מה מגיע עליה.
 */
function explainByActivity(matches, timeline, codes) {
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
    const kinds = new Set(found.map((f) => (reportLeave.has(f.code) ? 'leave' : ground.has(f.code) ? 'ground' : 'other')));
    if (kinds.has('other')) continue; // קוד לא מוכר: לא מסיקים ממנו, והשאלה תישאל
    m.how = kinds.has('ground') ? 'replaced_by_ground' : 'replaced_by_leave';
    m.replacedBy = found;
  }
}

function describeMatch(m) {
  const labels = {
    exact: 'בוצע כמתוכנן',
    dates: 'הוחלף בסבב אחר באותם ימים',
    cancelled: 'סבב מתוכנן שלא בוצע',
    unplanned: 'פעילות ביום שלא תוכננה בו פעילות',
    noplan: 'בוצע (אין קובץ תכנון להשוואה)',
    replaced_by_leave: 'סבב מתוכנן שהוחלף בהיעדרות',
    replaced_by_ground: 'סבב מתוכנן שהוחלף בפעילות קרקע',
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

/** לשאלה שמבקשת לקשר לסבב אחר: הסבבים המתוכננים שלא בוצעו. */
function attachLinkCandidates(questions, matches) {
  const candidates = matches.filter((m) => m.how === 'cancelled').map((m) => ({ id: m.plan.id, label: describePairing(m.plan) }));
  for (const q of questions) {
    for (const o of q.options ?? []) if (o.needsLink) o.linkCandidates = candidates;
  }
}

// ---------- קודים ----------

/** קודי היום בדוח הביצוע, בלי מסלולי הטיסה ("TLV-AMS"). */
function execCodesOf(day) {
  const details = day?.exec?.details;
  if (!details) return [];
  return details.split(/[,\s]+/).filter((t) => t && !/^[A-Z]{3}-[A-Z]{3}$/.test(t));
}

function isIgnoredPlanCode(code, codes) {
  return (codes.ignored_plan_notes ?? []).some((n) => code === n || code.startsWith(n));
}

function collectUnknownCodes(timeline, codes, supported) {
  const found = new Map();
  const add = (code, where, date) => {
    const k = `${where}|${code}`;
    if (!found.has(k)) found.set(k, { code, where, dates: [] });
    found.get(k).dates.push(date);
  };
  for (const day of timeline) {
    for (const c of day.plan?.codes ?? []) if (classifyCode(c, codes, supported) === 'unknown') add(c, 'plan', day.date);
    for (const c of execCodesOf(day)) if (classifyCode(c, codes, supported) === 'unknown') add(c, 'exec', day.date);
  }
  return [...found.values()];
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
  const pairingOf = new Map();
  for (const p of execPairings) {
    const dates = reportDates(p, timeline, domicile);
    for (const d of dates) { union(dates[0], d); pairingOf.set(d, p); }
  }
  for (const e of out.expectations) for (const d of e.dates) if (parent.has(d)) union(e.dates[0], d);

  const groups = new Map();
  for (const d of timeline) {
    const root = find(d.date);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(d.date);
  }

  const rows = [];
  for (const dates of groups.values()) {
    dates.sort();
    const inGroup = out.expectations.filter((e) => dates.includes(e.dates[0]));
    const pairings = [...new Set(dates.map((d) => pairingOf.get(d)).filter(Boolean))];
    const codes = dates.flatMap((d) => execCodesOf(dayOf(timeline, d)));
    const label = [
      dates.length === 1 ? ddmm(dates[0]) : `${ddmm(dates[0])}–${ddmm(dates.at(-1))}`,
      pairings.map((p) => describePairing(p).replace(/^\S+\s/, '')).join(' + '),
      codes.join(' '),
    ].filter(Boolean).join(' · ');

    for (const column of COMPARED_COLUMNS) {
      const items = inGroup.filter((e) => KEY_COLUMNS[e.key]?.includes(column));
      const expected = items.reduce((s, e) => s + e.min, 0);
      const reported = dates.reduce((s, d) => s + reportedValue(dayOf(timeline, d), column), 0);
      if (!expected && !reported) continue;
      const ok = reported === expected;
      // פער בקבוצה שיש עליה שאלה פתוחה אינו ממצא עדיין: הצפוי תלוי בתשובה.
      const pending = !ok && out.questions.some((q) => dates.includes(q.date));
      rows.push({ dates, label, column, expected, reported, diff: reported - expected, ok: pending ? null : ok, pending, items });
    }
  }

  // עמודות הסימון (VAC, SICK...) ו-TAB בימי היעדרות: יום-יום.
  for (const f of out.flags) {
    const reported = dayOf(timeline, f.date)?.exec?.values?.[f.column]?.count ?? 0;
    rows.push({ dates: [f.date], label: ddmm(f.date), column: f.column, expected: f.count, reported,
      diff: reported - f.count, ok: reported === f.count, unit: 'count', items: [f] });
  }
  for (const t of out.tabs) {
    // ביום שחלק ממנו שייך לסבב, ה-TAB בדוח כולל גם את זמן השהייה של הסבב.
    if (pairingOf.has(t.date)) continue;
    const reported = dayOf(timeline, t.date)?.exec?.values?.TAB?.min ?? 0;
    rows.push({ dates: [t.date], label: ddmm(t.date), column: 'TAB', expected: t.min, reported,
      diff: reported - t.min, ok: reported === t.min, items: [t] });
  }
  return rows.sort((a, b) => a.dates[0].localeCompare(b.dates[0]) || COMPARED_COLUMNS.indexOf(a.column) - COMPARED_COLUMNS.indexOf(b.column));
}

/** סיכום חודשי מול שורת הסיכום בדוח. COMTOT = COM + S/C. */
function compareTotals(out, exec) {
  const sum = (column) => out.comparison.filter((r) => r.column === column).reduce((s, r) => s + r.expected, 0);
  const t = exec.totals ?? {};
  const rows = [
    { column: 'Credit', expected: sum('Credit'), reported: t.Credit ?? null },
    { column: 'Rig', expected: sum('Rig'), reported: t.Rig ?? null },
    { column: 'COM', expected: sum('COM'), reported: t.COM ?? null },
    { column: 'S/C', expected: sum('S/C'), reported: t['S/C'] ?? null },
    { column: 'COMTOT', expected: sum('COM') + sum('S/C'), reported: t.COM != null || t['S/C'] != null ? (t.COM ?? 0) + (t['S/C'] ?? 0) : null },
    { column: 'CRTOT', expected: sum('Credit') + sum('Rig'), reported: t.Credit != null ? t.Credit + (t.Rig ?? 0) : null },
  ];
  return rows.map((r) => ({ ...r, ok: r.reported == null ? null : r.reported === r.expected }));
}

/**
 * Fict. flight time בסיכום התכנון = סך הזיכויים שאינם טיסה. משווים לסך זיכויי
 * ההיעדרות בהרצה על התכנון לבד (`alone`).
 */
function checkPlanFictTime(plan, alone) {
  if (plan.summary?.fictFlightTime == null) return null;
  const expected = alone.expectations.filter((e) => e.key === 'absence').reduce((s, e) => s + e.min, 0);
  const reported = plan.summary.fictFlightTime;
  return { expected, reported, ok: expected === reported };
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
