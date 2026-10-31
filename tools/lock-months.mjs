// נעילת החודשים האמיתיים (טיוטה 436). התוצאה של כל חודש נשמרת מחוץ לריפוזיטורי, כי היא מכילה טיסות אישיות.
// node tools/lock-months.mjs            משווה לתוצאה הנעולה, ומציג כל הבדל.
// node tools/lock-months.mjs --write    כותב את התוצאה הנוכחית. מה שנכתב כך "לא מאושר" עד --approve.
// node tools/lock-months.mjs --approve 2026-08,2026-09   מסמן חודשים שבעל המוצר אישר.
// התיקייה: ELAL_SAMPLES, ובלעדיו התיקייה ב-OneDrive.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePlan } from '../js/pdf/plan.js';
import { parseExec } from '../js/pdf/exec.js';
import { evaluate } from '../js/rules/evaluate.js';

const base = process.env.ELAL_SAMPLES ?? path.join(os.homedir(), 'OneDrive/Code_Dev/Claude/Elal_compensations/samples');
const lockFile = path.join(path.dirname(base), 'locked-months.json');
const rulesData = JSON.parse(fs.readFileSync(new URL('../rules.json', import.meta.url), 'utf8'));
const clean = (s) => String(s ?? '').replace(/[⁦-⁩‏]/g, '');
// התשובות השמורות באפליקציה: מהגיבוי האחרון, כי קובצי התשובות בתיקיית הדוגמאות חלקיים.
const backupDir = path.join(path.dirname(base), 'גיבוי חודשים שמורים');
const newest = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((f) => f.endsWith('.json')).sort().at(-1) : null;
const saved = new Map((newest ? JSON.parse(fs.readFileSync(path.join(backupDir, newest), 'utf8')).months : [])
  .map((m) => [`${m.period.year}-${String(m.period.month).padStart(2, '0')}`, m.answers ?? {}]));
const prevKey = (k) => { let [y, m] = k.split('-').map(Number); if (--m === 0) { m = 12; y--; } return `${y}-${String(m).padStart(2, '0')}`; };

const load = async (dir, planFile, execFile, answersFile) => ({
  plan: planFile ? await parsePlan(fs.readFileSync(path.join(dir, planFile))) : null,
  exec: execFile ? await parseExec(fs.readFileSync(path.join(dir, execFile))) : null,
  answers: answersFile && fs.existsSync(path.join(dir, answersFile)) ? JSON.parse(fs.readFileSync(path.join(dir, answersFile), 'utf8')) : {},
});

/** מה שננעל: כל מה שהמשתמש רואה ומשפיע על התוצאה, בלי הטקסט של השאלות. */
const snapshot = (r) => ({
  comparison: r.comparison.map((c) => `${c.column} | ${clean(c.label)} | ${c.expected} | ${c.reported}`),
  totals: (r.totals ?? []).map((t) => `${t.column} | ${t.expected} | ${t.reported}`),
  questions: r.questions.map((q) => q.id),
  notes: r.notes.map((n) => clean(n.message)),
  reviews: r.reviews.map((n) => clean(n.message)),
  freeDays: r.freeDays ? `${r.freeDays.free}/${r.freeDays.due}` : null,
  perDiem: r.perDiem ? `${r.perDiem.flightHours}/${r.perDiem.stayHours}/${r.perDiem.usd}` : null,
});

async function current() {
  const out = {};
  const files = fs.readdirSync(base);
  const months = files.filter((f) => /^duty-plan-\d{4}-\d{2}\.pdf$/.test(f)).map((f) => f.slice(10, 17)).sort();
  const data = new Map();
  for (const k of months) {
    const m = await load(base, `duty-plan-${k}.pdf`, files.find((f) => f.startsWith(`crewpay-${k}`)), `answers-${k}.json`);
    data.set(k, { ...m, answers: { ...m.answers, ...saved.get(k) } });
  }
  for (const k of months) {
    const m = data.get(k);
    const p = data.get(prevKey(k));
    const [y, mo] = prevKey(k).split('-').map(Number);
    const history = p ? [{ period: { year: y, month: mo }, plan: p.plan, exec: p.exec, answers: p.answers }] : [];
    const [ny, nm] = mo === 11 ? [y + 1, 1] : mo === 12 ? [y + 1, 2] : [y, mo + 2];
    const n = data.get(`${ny}-${String(nm).padStart(2, '0')}`);
    const next = n ? { period: { year: ny, month: nm }, plan: n.plan, exec: n.exec, answers: n.answers } : null;
    out[k] = snapshot(evaluate({ rulesData, plan: m.plan, exec: m.exec, answers: m.answers, history, next }));
    out[`${k}-plan`] = snapshot(evaluate({ rulesData, plan: m.plan, exec: null, answers: {}, history, next }));
  }
  for (const name of files.filter((f) => fs.statSync(path.join(base, f)).isDirectory())) {
    const dir = path.join(base, name);
    const list = fs.readdirSync(dir);
    const planFile = list.find((f) => /duty-plan/.test(f));
    if (!planFile) continue;
    const m = await load(dir, planFile, list.find((f) => /rew.*ay.*\.pdf$/i.test(f)), null);
    out[`p-${name}`] = snapshot(evaluate({ rulesData, plan: m.plan, exec: m.exec, answers: {}, history: [] }));
  }
  return out;
}

const read = () => (fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, 'utf8')) : { approved: [], months: {} });
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1] ?? ''; };

if (process.argv.includes('--approve')) {
  const lock = read();
  lock.approved = [...new Set([...lock.approved, ...arg('approve').split(',').filter(Boolean)])].sort();
  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 1));
  console.log(`מאושרים: ${lock.approved.length} מתוך ${Object.keys(lock.months).length}`);
  process.exit(0);
}

const now = await current();
if (process.argv.includes('--write')) {
  const lock = read();
  const months = lock.months;
  const changed = Object.keys(now).filter((k) => JSON.stringify(months[k]) !== JSON.stringify(now[k]));
  lock.months = now;
  lock.approved = lock.approved.filter((k) => !changed.includes(k));
  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 1));
  console.log(`נכתבו ${Object.keys(now).length} חודשים. השתנו: ${changed.length}. מאושרים: ${lock.approved.length}.`);
  process.exit(0);
}

const lock = read();
let diffs = 0;
for (const k of Object.keys({ ...lock.months, ...now })) {
  const [a, b] = [lock.months[k], now[k]];
  if (JSON.stringify(a) === JSON.stringify(b)) continue;
  diffs++;
  console.log(`\n== ${k}${lock.approved.includes(k) ? ' (מאושר)' : ''}`);
  if (!a || !b) { console.log(a ? 'חסר בהרצה' : 'לא נעול'); continue; }
  for (const f of Object.keys(b)) {
    const [x, y] = [a[f], b[f]];
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    if (!Array.isArray(y)) { console.log(`  ${f}: ${x} ← ${y}`); continue; }
    for (const l of x.filter((v) => !y.includes(v))) console.log(`  - ${f}: ${l}`);
    for (const l of y.filter((v) => !x.includes(v))) console.log(`  + ${f}: ${l}`);
  }
}
console.log(diffs ? `\n${diffs} חודשים שונים מהנעילה.` : `\nכל ${Object.keys(now).length} החודשים זהים לנעילה. מאושרים: ${lock.approved.length}.`);
process.exit(diffs ? 1 : 0);
