// כלי פיתוח: מריץ את מנוע החוקים על חודש ומדפיס את הדוח. לא חלק מהאפליקציה.
// שימוש:  node tools/run-month.mjs --plan samples/duty-plan-2026-07.pdf --exec samples/crewpay-2026-07.pdf [--answers samples/answers-2026-07.json]
// החודשים הקודמים (למגבלות החוק) נטענים מאותה תיקייה, לפי שמות הקבצים, כמו ההיסטוריה באפליקציה.
// --no-history: בלי חודשים קודמים.
import fs from 'node:fs';
import path from 'node:path';
import { parsePlan } from '../js/pdf/plan.js';
import { parseExec } from '../js/pdf/exec.js';
import { evaluate } from '../js/rules/evaluate.js';
import { minToHhmm } from '../js/time.js';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const rulesData = JSON.parse(fs.readFileSync(new URL('../rules.json', import.meta.url), 'utf8'));
const plan = arg('plan') ? await parsePlan(fs.readFileSync(arg('plan'))) : null;
const exec = arg('exec') ? await parseExec(fs.readFileSync(arg('exec'))) : null;
const answers = arg('answers') ? JSON.parse(fs.readFileSync(arg('answers'), 'utf8')) : {};
const history = process.argv.includes('--no-history') ? [] : await loadHistory();

async function loadHistory() {
  const ref = arg('plan') ?? arg('exec');
  const period = (plan ?? exec)?.period;
  if (!ref || !period) return [];
  const dir = path.dirname(ref);
  const files = fs.readdirSync(dir);
  const out = [];
  let { year, month } = period;
  for (let i = 0; i < 13; i++) {
    [year, month] = month === 1 ? [year - 1, 12] : [year, month - 1];
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const p = files.find((f) => f === `duty-plan-${key}.pdf`);
    const e = files.find((f) => f.startsWith(`crewpay-${key}`) && f.endsWith('.pdf'));
    if (!p && !e) break;
    out.push({ period: { year, month },
      plan: p && !e ? await parsePlan(fs.readFileSync(path.join(dir, p))) : null,
      exec: e ? await parseExec(fs.readFileSync(path.join(dir, e))) : null });
  }
  return out;
}

const r = evaluate({ rulesData, plan, exec, answers, history });
const hm = (v, unit) => (unit === 'count' ? String(v) : minToHhmm(v));

console.log(`חודש ${r.period.month}/${r.period.year} · מצב ${r.mode} · בסיס ${r.domicile} · חוקים ${r.rulesVersion}`);
console.log(`חוקים נתמכים: ${r.rules.supported.length} · לא נתמכים: ${r.rules.unsupported.length}`);
for (const w of r.warnings) console.log('אזהרה:', w);
if (r.legal) {
  console.log('\n== מגבלות החוק ==');
  if (r.legal.skipped) console.log(r.legal.skipped);
  else if (!r.legal.violations.length) console.log('אין חריגה');
  for (const v of r.legal.violations) console.log(`✗ ${v.date.slice(8)} ${v.message}`);
  for (const u of r.legal.unchecked) console.log(`  לא נבדק: ${u}`);
}

console.log('\n== שינויים ==');
for (const c of r.changes) {
  console.log(`${c.date.slice(8)}  ${c.label.padEnd(34)} תכנון: ${c.plan ?? '—'}  |  ביצוע: ${c.exec ?? '—'}${c.replacedBy ? '  ← ' + c.replacedBy.join(', ') : ''}`);
  for (const n of c.notes ?? []) console.log(`      ${n.message}${n.byUser ? ' (לפי תשובת המשתמש)' : ''}`);
}

console.log('\n== השוואה מול הדוח ==');
for (const row of r.comparison) {
  const mark = row.pending ? '…' : row.ok ? '✓' : '✗';
  console.log(`${mark} ${row.label.padEnd(40)} ${row.column.padEnd(7)} צפוי ${hm(row.expected, row.unit).padStart(6)}  בדוח ${hm(row.reported, row.unit).padStart(6)}${row.ok ? '' : `  פער ${hm(row.diff, row.unit)}`}`);
  if (['Rig', 'COM', 'S/C'].includes(row.column)) for (const x of [...row.items.map((e) => `${e.explain ?? ''} [${e.ruleTitle}]`.trim()), ...(row.notes ?? [])]) console.log(`      > ${x}`);
  if (row.ok === false) for (const e of row.items) console.log(`      · ${e.ruleTitle ?? ''}: ${e.note ?? ''} ${e.min != null ? minToHhmm(e.min) : ''}`);
}

if (r.mode === 'plan') {
  console.log('\n== פיצויים צפויים ==');
  for (const e of r.expectations) if (e.explain != null) console.log(`${e.date.slice(8)}  ${e.key.padEnd(4)} ${minToHhmm(e.min)}  ${e.explain} [${e.ruleTitle}]`);
}

console.log('\n== סיכומים ==');
if (r.freeDays) console.log(`${r.freeDays.free >= r.freeDays.due ? '✓' : '✗'} ימים פנויים ${r.freeDays.free} מתוך ${r.freeDays.due}`);
for (const t of r.totals) console.log(`${t.ok == null ? '?' : t.ok ? '✓' : '✗'} ${t.column.padEnd(7)} צפוי ${minToHhmm(t.expected)}  בדוח ${minToHhmm(t.reported)}`);

if (r.questions.length) {
  console.log('\n== שאלות למשתמש ==');
  for (const q of r.questions) console.log(`? [${q.id}] ${q.title}\n    ${q.options.map((o) => o.value).join(' / ')}`);
}
if (r.reviews.length) {
  console.log('\n== לבדיקה ידנית ==');
  for (const v of r.reviews) console.log('!', v.message);
}
if (r.notes.length) {
  console.log('\n== הערות ==');
  for (const n of r.notes) console.log(`- ${n.date ? n.date.slice(8) + " " : ""}${n.message}${n.byUser ? ' (לפי תשובת המשתמש)' : ''}`);
}
if (r.unknownCodes.length) {
  console.log('\n== קודים לא מוכרים ==');
  for (const u of r.unknownCodes) console.log(`- ${u.code} (${u.where}) ב-${u.dates.map((d) => d.slice(8)).join(', ')}`);
}
