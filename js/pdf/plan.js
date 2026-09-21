// חילוץ PDF תכנון – "Individual duty plan" של NetLine/Crew.
//
// מבנה הדף (אחרי תיקון הסיבוב, 842x595):
//   שורת לוח שנה עליונה, ומתחתיה שורת כותרת עם שלושה בלוקים של ימים:
//   date | H | duty | R dep | arr | AC | info
//   כל בלוק מכסה טווח ימים, והימים בתוכו זה מתחת לזה.
//
// שלושת הבלוקים חולקים את אותן שורות y, ולכן חייבים לסנן לפי x לפני הכל.
// בנוסף, סיכום החודש וטבלת ההדרכות יושבים באותו טווח x של הבלוק השלישי,
// ולכן שיוך פריט לעמודה נעשה רק אם הוא יושב על עוגן עמודה מוכר.

import { extractPages, toRows, pageText } from './extract.js';
import { clockToMin, hhmmToMin, isoDate } from '../time.js';

/** היסטים קבועים מעמודת ה-date של הבלוק. תבנית הדוח זהה בין חודשים. */
const COL = { date: 0, h: 25, duty: 42, flt: 56, r: 95, org: 103, t1: 125, t2: 146, dst: 168, ac: 185, info: 215, val: 240 };
const TOL = 8;

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function looksLikePlan(pages) {
  return /Individual duty plan/i.test(pageText(pages[0]));
}

export async function parsePlan(data) {
  const pages = await extractPages(data);
  if (!looksLikePlan(pages)) {
    throw new Error('הקובץ אינו נראה כמו "Individual duty plan". ודא שהעלית את קובץ התכנון.');
  }

  const warnings = [];
  const header = parseHeader(pages[0], warnings);
  const days = {};
  const rawCodes = new Set();

  for (const page of pages) {
    const rows = toRows(page.items);
    const headerRow = rows.find(isBlockHeaderRow);
    if (!headerRow) continue; // דף בלי טבלת ימים, למשל דף המשך עם הדרכות בלבד
    const origins = headerRow.filter((i) => i.s === 'date').map((i) => i.x);
    const bodyRows = rows.filter((r) => r[0].y > headerRow[0].y + 4);
    for (const origin of origins) {
      parseBlock(bodyRows, origin, header.period, days, rawCodes, warnings);
    }
  }

  const stationOffsets = resolveDeadheads(days);

  return {
    kind: 'plan',
    ...header,
    days,
    stationOffsets,
    codesSeen: [...rawCodes].sort(),
    summary: parseSummary(pages),
    warnings,
  };
}

// ---------- כותרת הדוח ----------

function parseHeader(page, warnings) {
  const text = pageText(page);
  const period = text.match(/Period:\s*(\d{2})([A-Za-z]{3})(\d{2})\s*-\s*(\d{2})([A-Za-z]{3})(\d{2})/);
  const employee = text.match(/\bfor\s+([A-Z][A-Z'\- ]*),\s*([A-Z][A-Z'\- ]*?)\s+NetLine/);
  const printed = text.match(/printed by\s+(\S+)\s+(\d{2}[A-Za-z]{3}\d{2}\s+\d{2}:\d{2})/);

  if (!period) {
    throw new Error('לא נמצאה שורת Period בקובץ התכנון.');
  }
  const month = MONTHS.indexOf(capitalize(period[2])) + 1;
  const year = 2000 + Number(period[3]);
  if (month === 0) throw new Error(`חודש לא מזוהה בשורת Period: ${period[2]}`);
  if (period[2].toLowerCase() !== period[5].toLowerCase()) {
    warnings.push('תקופת התכנון חוצה חודשים. האפליקציה מטפלת בחודש הראשון בלבד.');
  }

  return {
    employee: employee ? { last: employee[1].trim(), first: employee[2].trim() } : null,
    period: { year, month, from: Number(period[1]), to: Number(period[4]) },
    printed: printed ? { by: printed[1], at: printed[2] } : null,
  };
}

const capitalize = (s) => s[0].toUpperCase() + s.slice(1).toLowerCase();

const isBlockHeaderRow = (row) => {
  const t = row.map((i) => i.s);
  return t.includes('date') && t.includes('duty') && t.includes('info');
};

// ---------- בלוק ימים ----------

function parseBlock(bodyRows, origin, period, days, rawCodes, warnings) {
  // רק פריטים שיושבים על עוגן עמודה מוכר של הבלוק הזה.
  const cells = bodyRows.map((row) => {
    const out = {};
    for (const it of row) {
      const off = it.x - origin;
      for (const [name, anchor] of Object.entries(COL)) {
        if (Math.abs(off - anchor) <= TOL) {
          (out[name] ||= []).push(it);
          break;
        }
      }
    }
    return { y: row[0].y, cells: out };
  });

  // עוגני ימים: "Wed01" בעמודת date.
  const anchors = [];
  cells.forEach((row, idx) => {
    for (const it of row.cells.date || []) {
      const m = it.s.match(/^([A-Z][a-z]{2})(\d{2})$/);
      if (m && DOW.includes(m[1])) anchors.push({ idx, dow: m[1], day: Number(m[2]) });
    }
  });

  anchors.forEach((anchor, i) => {
    const from = anchor.idx;
    const to = i + 1 < anchors.length ? anchors[i + 1].idx : cells.length;
    const date = isoDate(period.year, period.month, anchor.day);
    // אחרי היום האחרון מודפס לפעמים "לידיעה בלבד" המשך של סבב לחודש הבא ("Mon01" במאי 2026
    // הוא 1 ביוני). יום בשבוע שאינו תואם לתאריך בחודש המודפס אינו שייך לחודש.
    if (DOW[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7] !== anchor.dow) return;
    const day = (days[date] ||= { date, dow: anchor.dow, codes: [], pickup: null, legs: [], info: {} });
    for (let r = from; r < to; r++) parseDayRow(cells[r].cells, day, rawCodes, warnings, date);
  });
}

function parseDayRow(c, day, rawCodes, warnings, date) {
  // ערכי info: "[FT" + "05:15]". חייבת להיות תווית, אחרת זו לא שורת info.
  for (const label of c.info || []) {
    const m = label.s.match(/^\[(FT|TAB)$/);
    if (!m) continue;
    const val = (c.val || []).find((v) => /^\d{1,3}:\d{2}\]$/.test(v.s) && Math.abs(v.y - label.y) <= 3);
    if (val) day.info[m[1]] = hhmmToMin(val.s.slice(0, -1));
  }

  // רגל DH מתחילה ב-"DH/LY", שיושב שמאלה מעמודת duty ונופל לעמודה H.
  for (const it of c.h || []) {
    if (it.s !== 'DH/LY') continue;
    const leg = readLeg(c, it, warnings, date);
    if (leg) day.legs.push({ ...leg, dh: true });
  }

  for (const it of c.duty || []) {
    const s = it.s;
    if (s === 'LY' || s === 'DH/LY') {
      const leg = readLeg(c, it, warnings, date);
      if (leg) day.legs.push(s === 'LY' ? leg : { ...leg, dh: true });
    } else if (s === 'PICKUP') {
      day.pickup = readTimedRow(c, it);
    } else if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]*)*$/.test(s) && s.length >= 2) {
      rawCodes.add(s);
      if (!day.codes.includes(s)) day.codes.push(s);
      const timed = readTimedRow(c, it);
      if (timed.dep || timed.arr) (day.codeTimes ||= {})[s] = timed;
    } else if (s.length === 1) {
      // סימון בודד, למשל X. מסווג במנוע החוקים ולא כאן.
      rawCodes.add(s);
      if (!day.codes.includes(s)) day.codes.push(s);
    }
  }
}

/** רגל טיסה: מספר, מוצא, יעד, שעות ומטוס, כולם באותה שורת y. */
function readLeg(c, lyItem, warnings, date) {
  const num = near(c.flt, lyItem.y);
  if (!num) {
    warnings.push(`${date}: נמצא "LY" בלי מספר טיסה. השורה דולגה.`);
    return null;
  }
  const timed = readTimedRow(c, lyItem);
  return {
    flight: 'LY' + num.s,
    org: timed.org,
    dst: near(c.dst, lyItem.y)?.s ?? timed.dst ?? null,
    dep: timed.dep,
    arr: timed.arr,
    ac: near(c.ac, lyItem.y)?.s ?? null,
  };
}

/**
 * שעות המראה ונחיתה. לפעמים שתיהן מגיעות כפריט אחד ("1615 !2030"),
 * ולפעמים כשני פריטים בעמודות t1 ו-t2. נחיתה ביום שאחרי ההמראה מגיעה לפעמים עם
 * "+1" והיעד צמודים אליה ("!0118+1TBS", 05/05/2026).
 */
function readTimedRow(c, anchorItem) {
  const y = anchorItem.y;
  const org = near(c.org, y)?.s ?? null;
  const a = near(c.t1, y)?.s ?? null;
  const b = near(c.t2, y)?.s ?? null;
  const [depRaw, arrRaw] = a && /\s/.test(a) ? a.split(/\s+/) : [a, b];
  const m = arrRaw?.match(/^(!?\d{4})(?:\+(\d))?([A-Z]{3})?$/);
  return { org, dep: clockToMin(depRaw), arr: clockToMin(m ? m[1] : arrRaw), dst: m?.[3] ?? null };
}

// ---------- משך רגלי DH ----------

/**
 * ה-FT בתכנון אינו כולל רגלי DH, והשעות בתכנון הן שעון מקומי (עם !) או שעון הבסיס.
 * כדי לחשב STA − STD של רגל DH צריך את הפרש השעון של התחנה, ולומדים אותו מאותו
 * קובץ: יום עם תחנה זרה אחת שה-FT שלו מתיישב עם הפרש אחד בלבד. הלוך-חזור באותו
 * יום לא מלמד כלום, כי ההפרש מתקזז. בוחרים את ההפרש שנלמד ביום הקרוב ביותר,
 * בגלל מעברי שעון קיץ. אם אין – `dur` נשאר null, והמנוע מנסה את הדוח.
 * מחזיר את ההפרשים שנלמדו (תחנה → [{date, off}], ‏off = שעון מקומי − שעון הבסיס בדקות),
 * כדי שחוקים יוכלו להמיר שעת נחיתה בחו"ל לשעון הבסיס.
 */
function resolveDeadheads(days) {
  const learned = {}; // station → [{date, off}]
  for (const day of Object.values(days)) {
    const legs = day.legs.filter((l) => !l.dh);
    if (!legs.length || day.info.FT == null || legs.some((l) => !l.dep || !l.arr)) continue;
    const foreign = new Set(legs.flatMap((l) => [l.dep.foreign && l.org, l.arr.foreign && l.dst]).filter(Boolean));
    if (foreign.size !== 1) continue;
    const [station] = foreign;
    const fits = [];
    for (let off = -720; off <= 840; off += 15) {
      const sum = legs.reduce((s, l) => s + legDuration(l, { [station]: off }), 0);
      if (sum === day.info.FT) fits.push(off);
    }
    if (fits.length === 1) (learned[station] ||= []).push({ date: day.date, off: fits[0] });
  }

  for (const day of Object.values(days)) {
    for (const leg of day.legs) {
      if (!leg.dh) continue;
      leg.dur = null;
      if (!leg.dep || !leg.arr) continue;
      const offsets = {};
      for (const [t, station] of [[leg.dep, leg.org], [leg.arr, leg.dst]]) {
        if (!t.foreign) continue;
        const closest = (learned[station] || []).sort((a, b) => dist(a.date, day.date) - dist(b.date, day.date))[0];
        if (closest) offsets[station] = closest.off;
      }
      const missing = [[leg.dep, leg.org], [leg.arr, leg.dst]].some(([t, s]) => t.foreign && offsets[s] == null);
      if (!missing) leg.dur = legDuration(leg, offsets);
    }
  }
  return learned;
}

/** STA − STD בדקות, כשזמן עם ! מומר לשעון הבסיס לפי ההפרש של התחנה. */
function legDuration(leg, offsets) {
  const base = (t, station) => (t.foreign ? t.min - offsets[station] : t.min);
  return (((base(leg.arr, leg.dst) - base(leg.dep, leg.org)) % 1440) + 1440) % 1440;
}

const dist = (a, b) => Math.abs(Date.parse(a) - Date.parse(b));

const near = (list, y, tol = 3) => (list || []).find((i) => Math.abs(i.y - y) <= tol) || null;

// ---------- סיכום החודש ----------

function parseSummary(pages) {
  // סדר הפריטים הגולמי ב-PDF אינו סדר הקריאה, ולכן בונים את הטקסט לפי שורות.
  const text = pages
    .flatMap((p) => toRows(p.items).map((row) => row.map((i) => i.s).join(' ')))
    .join(' \n ');
  const grab = (re) => {
    const m = text.match(re);
    return m ? hhmmToMin(m[1]) : null;
  };
  const offDays = text.match(/Off\s+days\s+(\d+)/);
  return {
    flightTime: grab(/(?:^|\s)Flight time\s+(\d{1,4}:\d{2})/),
    vacation: grab(/Vacation\s+(\d{1,4}:\d{2})/),
    sickness: grab(/Sickness\s+(\d{1,4}:\d{2})/),
    sumNet: grab(/Sum \(net\)\s+(\d{1,4}:\d{2})/),
    fictFlightTime: grab(/Fict\.\s*flight time\s+(\d{1,4}:\d{2})/),
    sum: grab(/(?:^|\n|\s)Sum\s+(\d{1,4}:\d{2})/),
    timeAwayFromBase: grab(/Time\s+away from base\s+(\d{1,4}:\d{2})/),
    offDays: offDays ? Number(offDays[1]) : null,
  };
}
