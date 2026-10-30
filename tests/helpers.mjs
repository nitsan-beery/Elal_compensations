// בונה חודש סינתטי בצורה שקוראי הקבצים מחזירים, ומריץ עליו את המנוע. בלי נתונים אישיים: הקובץ בריפוזיטורי ציבורי.
// טיוטה 436. זמנים הם 'HH:MM' בשעון המקומי של השדה. אתונה ולרנקה באותו שעון כמו הבסיס, ולכן רוב הבדיקות משתמשות בהן.
import fs from 'node:fs';
import { evaluate } from '../js/rules/evaluate.js';

export const rulesData = JSON.parse(fs.readFileSync(new URL('../rules.json', import.meta.url), 'utf8'));

const pad = (n) => String(n).padStart(2, '0');
export const min = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
export const hhmm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const mod = (n) => ((n % 1440) + 1440) % 1440;
const duration = (m) => ({ kind: 'duration', min: m, raw: hhmm(Math.max(0, m)) });
const daysIn = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * רגל. `dur` – בלוק מקובע, כשהיעד בשעון אחר. `atd`, `ata` – בפועל, ובלעדיהם כמתוכנן. `act` – זמן הטיסה בפועל.
 */
export const leg = (flight, org, dst, std, sta, extra = {}) => ({ flight, org, dst, std, sta, ...extra });

const blockOf = (l) => l.dur ?? mod(min(l.sta) - min(l.std));

const planLeg = (l) => ({ flight: l.flight, org: l.org, dst: l.dst, dep: { min: min(l.std), foreign: false }, arr: { min: min(l.sta), foreign: false },
  ac: l.ac ?? 'B737', ...(l.dh ? { dh: true } : {}) });

const execLeg = (l) => {
  const block = blockOf(l);
  return { type: l.dh ? 'DHO' : 'LEG', flight: l.flight, seq: '0', dhd: l.dh ? 'DHD' : null, dd: 'PIC', org: l.org, dst: l.dst, pos: 'CP',
    std: min(l.std), sta: min(l.sta), atd: min(l.atd ?? l.std), ata: min(l.ata ?? l.sta), skdDur: block, actDur: l.act ?? block, occ: 1 };
};

/**
 * חודש. `plan` ו-`exec`: מיום בחודש לרשימת רגליים, או לקוד. `values`: ערכים ברומה שגוברים על המחושב,
 * { '01': { Credit: '03:46', 'S/C': '02:30' } }. בלי `exec` – תכנון לבד.
 */
export function month(year, m, { plan = {}, exec = null, values = {}, codes = {}, columns = null } = {}) {
  const n = daysIn(year, m);
  const dateOf = (d) => `${year}-${pad(m)}-${pad(d)}`;
  const planDays = {};
  let sum = 0;
  const stationOffsets = {};
  for (let d = 1; d <= n; d++) {
    const key = pad(d);
    const entry = plan[key] ?? [];
    const legs = Array.isArray(entry) ? entry : [];
    const ft = legs.reduce((s, l) => s + blockOf(l), 0);
    sum += ft;
    for (const l of legs) for (const st of [l.org, l.dst]) if (st !== 'TLV') (stationOffsets[st] ??= []).push({ date: dateOf(d), off: l.off ?? 0 });
    planDays[dateOf(d)] = { date: dateOf(d), dow: DOW[new Date(Date.UTC(year, m - 1, d)).getUTCDay()],
      codes: Array.isArray(entry) ? [] : [entry], pickup: legs.length ? { org: legs[0].org, dep: { min: min(legs[0].std), foreign: false }, arr: null, dst: null } : null, legs: legs.map(planLeg), info: ft ? { FT: ft } : {} };
  }
  const planFile = { kind: 'plan', employee: { last: 'TEST', first: 'PILOT', id: '000001' }, period: { year, month: m, from: 1, to: n }, printed: null, position: 'CP',
    days: planDays, stationOffsets, codesSeen: [], summary: { flightTime: sum, vacation: 0, sickness: 0, sumNet: sum, fictFlightTime: 0, sum, timeAwayFromBase: 0, offDays: 0 }, warnings: [] };
  if (!exec) return { period: { year, month: m }, plan: planFile, exec: null };

  const execDays = {};
  const totals = {};
  for (let d = 1; d <= n; d++) {
    const key = pad(d);
    const legs = (exec[key] ?? []).filter((l) => typeof l === 'object');
    const credit = legs.reduce((s, l) => s + blockOf(l), 0);
    const vals = {};
    if (credit) Object.assign(vals, { Credit: duration(credit), FLT: duration(credit), TAB: duration(credit) });
    for (const [k, v] of Object.entries(values[key] ?? {})) vals[k] = duration(typeof v === 'number' ? v : min(v));
    for (const [k, v] of Object.entries(vals)) totals[k] = (totals[k] ?? 0) + v.min;
    execDays[dateOf(d)] = { date: dateOf(d), day: d, src: null, details: codes[key] ?? null, values: vals, legs: legs.map(execLeg), sims: [], standby: [],
      ...(legs.length || codes[key] || Object.keys(vals).length ? {} : { absent: true }) };
  }
  const execFile = { kind: 'exec', employee: { name: 'TEST PILOT', id: '000001' }, period: { year, month: m }, position: 'CP', domicile: 'TLV', status: 'Closed', lineType: 'Line',
    modified: null, positions: [], format: 'print', columns: columns ?? ['Day', 'Src', 'Details', 'Credit', 'Rig', 'FLT', 'TAB', 'COM', 'S/C', 'PDFT', 'ABR'], missingColumns: [], headerP: null,
    unknownColumns: [], legColumns: [], days: execDays, totals, reportTotals: {}, warnings: [] };
  return { period: { year, month: m }, plan: planFile, exec: execFile };
}

/** מריץ חודש. `prev`: החודש הקודם, כמו ב-`historyFor`, עם `answers` שלו. */
export function run(m, { answers = {}, prev = null, assumedIgnored = [], planOnly = false, rules = rulesData } = {}) {
  return evaluate({ rulesData: rules, plan: m.plan, exec: planOnly ? null : m.exec, answers, assumedIgnored,
    history: prev ? [{ period: prev.period, plan: prev.plan, exec: prev.exec, answers: prev.answers ?? null }] : [] });
}

const clean = (s) => String(s ?? '').replace(/[⁦-⁩‏]/g, '');

/** שורת ההשוואה בעמודה, שהתווית שלה מכילה את `text`. */
export const row = (r, column, text) => r.comparison.find((c) => c.column === column && clean(c.label).includes(text));
export const expected = (r, column, text) => { const c = row(r, column, text); return c ? hhmm(c.expected) : null; };
export const questions = (r) => r.questions.map((q) => q.id);
export const asked = (r, prefix) => r.questions.some((q) => q.id.startsWith(prefix));
export const notes = (r) => r.notes.map((n) => clean(n.message));
export const explains = (c) => (c?.items ?? []).map((i) => clean(i.explain)).join(' ');
export const reviews = (r) => r.reviews.map((n) => clean(n.message));
