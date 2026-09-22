// חילוץ PDF ביצוע – "Rainmaker – CrewPayDetails".
//
// שני פורמטים נתמכים (הדפסה ממחשב, והדפסה מ-iPad). שניהם נקראים באותו קוד,
// כי העמודות ממופות לפי שורת הכותרת שבכל דף ולא לפי סדר קבוע.
// העמודות משתנות מחודש לחודש: מופיעות רק עמודות שיש להן ערך באותו חודש.

import { extractPages, toRows, centerX, pageText } from './extract.js';
import { hhmmToMin, toNumber, isoDate, daysInMonth } from '../time.js';

/** עמודות שהאפליקציה יודעת להשתמש בהן. חסרה אחת – מדווחים, לא מנחשים. */
const KNOWN_DAY_COLUMNS = ['Day', 'Src', 'Details', 'Credit', 'Rig', 'FLT', 'TAB', 'DH', 'SIMD', 'SIM', 'CORS', 'VAC', 'SICK', 'SCKFM', 'SBY', 'MEAL', 'COM', 'S/C', 'PDFT', 'ABR', 'MPPD', 'PICK', 'P'];
const LEG_COLUMNS = ['Details', 'Flt', 'Seq', 'DHD', 'DD', 'ORG', 'DST', 'POS', 'STD', 'STA', 'ATD', 'ATA', 'SkdFlt', 'ActFlt', 'SkdDur', 'ActDur', 'Time', 'Occ'];

/** עמודות שהחוקים נשענים עליהן. היעדרן מדווח למשתמש. */
const REQUIRED_COLUMNS = ['Day', 'Details', 'Credit', 'Rig', 'FLT', 'COM', 'S/C'];
/**
 * עמודות פיצוי שהדוח משמיט בחודש שאין בו פיצוי כזה (10/2025: בלי Rig ו-S/C). עמודה כזו
 * שחסרה נקראת כ-0, והאזהרה מוצגת רק כשיש פער בסיכום (evaluate.js).
 */
export const OPTIONAL_COLUMNS = ['Rig', 'COM', 'S/C'];

const MAX_SNAP = 16; // מרחק מרבי בין מרכז פריט למרכז כותרת

export function looksLikeExec(pages) {
  // הדפסה ממחשב כותבת "CrewPayDetails", הדפסה מ-iPad כותבת "Crew Pay Details".
  return /Crew\s*Pay\s*Details/i.test(pageText(pages[0]));
}

export async function parseExec(data) {
  const pages = await extractPages(data);
  if (!looksLikeExec(pages)) {
    throw new Error('הקובץ אינו נראה כמו דוח "Rainmaker – CrewPayDetails". ודא שהעלית את קובץ הביצוע.');
  }

  const warnings = [];
  const header = parseHeader(pages, warnings);
  const days = {};
  const totalsRows = [];
  let dayCols = null;
  let legCols = null;
  const legColumns = new Set();
  let current = null;

  for (const page of pages) {
    for (const row of toRows(page.items)) {
      if (isDayHeaderRow(row)) { dayCols = buildColumnMap(row, KNOWN_DAY_COLUMNS); legCols = null; continue; }
      if (isLegHeaderRow(row)) { legCols = buildColumnMap(row, LEG_COLUMNS); Object.keys(legCols).forEach((c) => legColumns.add(c)); continue; }
      if (!dayCols) continue; // עדיין בכותרת הדוח

      const dayNo = readDayNumber(row, dayCols);
      if (dayNo != null) {
        const date = isoDate(header.period.year, header.period.month, dayNo);
        current = days[date] = { date, day: dayNo, src: null, details: null, values: {}, legs: [], sims: [] };
        fillDayRow(current, row, dayCols);
        legCols = null;
        continue;
      }

      if (legCols && current && isLegRow(row, legCols)) { current.legs.push(readLegRow(row, legCols)); continue; }
      // שורת SIM: אימון בסימולטור, עם התחנה ו-STD/STA בשעון מקומי (שעות האימון בפועל).
      if (legCols && current && isSimRow(row, legCols)) { current.sims.push(readLegRow(row, legCols)); continue; }

      const totals = readTotalsRow(row, dayCols);
      if (totals) totalsRows.push(totals);
    }
  }

  const present = dayCols ? Object.keys(dayCols) : [];
  const missing = REQUIRED_COLUMNS.filter((c) => !present.includes(c));
  if (!dayCols) throw new Error('לא נמצאה טבלת הימים בדוח הביצוע.');
  // האזהרה על עמודות חסרות נבנית ב-evaluate, לפי missingColumns, כדי שגם חודש שנשמר לפני שינוי בכלל יוצג נכון.
  if (header.status && !/closed/i.test(header.status)) {
    warnings.push(`סטטוס החודש הוא "${header.status}" ולא Closed. הנתונים אינם סופיים.`);
  }
  fillMissingDays(days, header.period);

  return {
    kind: 'exec',
    ...header,
    columns: present,
    missingColumns: missing,
    legColumns: [...legColumns],
    days,
    totals: pickBestTotals(totalsRows),
    reportTotals: parseReportTotals(pages),
    warnings,
  };
}

// ---------- כותרת הדוח ----------

function parseHeader(pages, warnings) {
  const text = pages.map((p) => toRows(p.items).map((r) => r.map((i) => i.s).join(' ')).join(' \n ')).join(' \n ');
  const period = text.match(/Period:\s*(\d{4})(\d{2})/);
  if (!period) throw new Error('לא נמצאה שורת Period בדוח הביצוע.');

  const employee = text.match(/Employee:\s*([^\n(]+?)\s*\((\d+)\)/);
  // ערך של שדה בכותרת, עד התווית הבאה. תווית עשויה להיות דו-מילית ("Line Type:").
  const pick = (label) => {
    const m = text.match(new RegExp(label + ':\\s*(.+?)(?=\\s+(?:[A-Z][A-Za-z]* )*[A-Z][A-Za-z#]*:|\\s*(?:\\n|$))'));
    return m ? m[1].trim() : null;
  };

  // בפורמט ה-iPad נחתכת לפעמים העמודה הימנית (PICK). אין אזהרה כללית: עמודה שחוק צריך נבדקת ב-missingColumns.
  const format = /Upload Document/i.test(text) ? 'ipad' : 'print';

  return {
    employee: employee ? { name: employee[1].trim(), id: employee[2] } : null,
    period: { year: Number(period[1]), month: Number(period[2]) },
    position: pick('Position'),
    domicile: pick('Domicile'),
    status: pick('Status'),
    lineType: pick('Line Type'),
    modified: pick('Modified'),
    format,
  };
}

// ---------- מיפוי עמודות דינמי ----------

const isDayHeaderRow = (row) => {
  const t = row.map((i) => i.s);
  return t.includes('Day') && t.includes('Src') && t.includes('Credit');
};

const isLegHeaderRow = (row) => {
  const t = row.map((i) => i.s);
  return t.includes('STD') && t.includes('ATA') && t.includes('ORG');
};

/** כותרת → מרכז אופקי. רק עמודות שהקוד מכיר; עמודה חדשה תדווח כלא מוכרת. */
function buildColumnMap(row, known) {
  const map = {};
  for (const it of row) if (known.includes(it.s)) map[it.s] = centerX(it);
  return map;
}

/** שיוך פריט לעמודה הקרובה ביותר לפי מרכז. העמודות בדוח ממורכזות. */
function snap(item, cols) {
  const c = centerX(item);
  let best = null;
  let bestD = MAX_SNAP;
  for (const [name, x] of Object.entries(cols)) {
    const d = Math.abs(c - x);
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}

function cellsOf(row, cols) {
  const out = {};
  for (const it of row) {
    const col = snap(it, cols);
    if (col) out[col] = out[col] == null ? it.s : `${out[col]} ${it.s}`;
  }
  return out;
}

// ---------- שורות ----------

function readDayNumber(row, cols) {
  if (cols.Day == null) return null;
  const first = row[0];
  if (Math.abs(centerX(first) - cols.Day) > MAX_SNAP) return null;
  const m = first.s.match(/^(\d{1,2})$/);
  const n = m ? Number(m[1]) : null;
  return n != null && n >= 1 && n <= 31 ? n : null;
}

function fillDayRow(day, row, cols) {
  const cells = cellsOf(row, cols);
  day.src = cells.Src ?? null;
  day.details = cells.Details ?? null;
  for (const [col, raw] of Object.entries(cells)) {
    if (col === 'Day' || col === 'Src' || col === 'Details') continue;
    day.values[col] = parseValue(raw);
  }
}

/** ערך של תא: משך (hh:mm) נשמר כדקות, ספירה (1.00) כמספר. */
function parseValue(raw) {
  const min = hhmmToMin(raw);
  if (min != null) return { kind: 'duration', min, raw };
  const num = toNumber(raw);
  if (num != null) return { kind: 'count', count: num, raw };
  return { kind: 'text', raw };
}

const isLegRow = (row, cols) => {
  const first = row[0];
  return /^(LEG|DHO)$/.test(first.s) && Math.abs(centerX(first) - (cols.Details ?? centerX(first))) <= MAX_SNAP * 2;
};

const isSimRow = (row, cols) => {
  const first = row[0];
  return first.s === 'SIM' && Math.abs(centerX(first) - (cols.Details ?? centerX(first))) <= MAX_SNAP * 2;
};

function readLegRow(row, cols) {
  const c = cellsOf(row, cols);
  return {
    type: c.Details ?? null,
    flight: c.Flt ? 'LY' + c.Flt : null,
    seq: c.Seq ?? null,
    dhd: c.DHD ?? null,
    dd: c.DD ?? null, // חסר משמעות, נשמר לתצוגה בלבד
    org: c.ORG ?? null,
    dst: c.DST ?? null,
    pos: c.POS ?? null,
    std: hhmmToMin(c.STD),
    sta: hhmmToMin(c.STA),
    atd: hhmmToMin(c.ATD),
    ata: hhmmToMin(c.ATA),
    skdDur: hhmmToMin(c.SkdDur),
    actDur: hhmmToMin(c.ActDur),
    occ: toNumber(c.Occ),
  };
}

/** שורת סיכום של טבלת הימים: ערכי hh:mm בלי מספר יום. */
function readTotalsRow(row, cols) {
  if (row.some((i) => /^\d{1,2}$/.test(i.s) && Math.abs(centerX(i) - cols.Day) <= MAX_SNAP)) return null;
  const cells = cellsOf(row, cols);
  const out = {};
  for (const [col, raw] of Object.entries(cells)) {
    const min = hhmmToMin(raw);
    if (min != null) out[col] = min;
  }
  return Object.keys(out).length >= 3 ? out : null;
}

const pickBestTotals = (rows) => rows.sort((a, b) => Object.keys(b).length - Object.keys(a).length)[0] ?? {};

/** יום שאין לו שורה בדוח מסומן absent. בכל הדוחות שנבדקו מופיעים כל ימי החודש, ולכן evaluate מתריע עליו. */
function fillMissingDays(days, period) {
  for (let d = 1; d <= daysInMonth(period.year, period.month); d++) {
    const date = isoDate(period.year, period.month, d);
    days[date] ||= { date, day: d, src: null, details: null, values: {}, legs: [], absent: true };
  }
}

// ---------- Report Totals ----------

/** מקטע הסיכומים בסוף הדוח: שורת תוויות ומתחתיה שורת ערכים, ממוקמות לפי x. */
function parseReportTotals(pages) {
  const out = {};
  for (const page of pages) {
    const rows = toRows(page.items);
    const start = rows.findIndex((r) => r.length === 1 && r[0].s === 'Report Totals');
    if (start < 0) continue;
    for (let i = start + 1; i < rows.length - 1; i++) {
      const labels = rows[i].filter((it) => it.s !== 'Src' && /^[A-Z][A-Z0-9]{1,9}$/.test(it.s));
      if (!labels.length || !rows[i].some((it) => it.s === 'Src')) continue;
      const values = rows[i + 1];
      for (const label of labels) {
        const v = values.find((it) => Math.abs(it.x - label.x) <= 10 && it.s !== 'S' && it.s !== 'M');
        if (v) out[label.s] = v.s;
      }
    }
  }
  return out;
}
