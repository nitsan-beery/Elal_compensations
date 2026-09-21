// כלי פיתוח: מריץ את מנוע החוקים על חודש ומדפיס את הדוח. לא חלק מהאפליקציה.
// שימוש:  node tools/run-month.mjs --plan samples/duty-plan-2026-07.pdf --exec samples/crewpay-2026-07.pdf [--answers samples/answers-2026-07.json]
import fs from 'node:fs';
import { parsePlan } from '../js/pdf/plan.js';
import { parseExec } from '../js/pdf/exec.js';
import { evaluate } from '../js/rules/evaluate.js';
import { minToHhmm } from '../js/time.js';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const rulesData = JSON.parse(fs.readFileSync(new URL('../rules.json', import.meta.url), 'utf8'));
const plan = arg('plan') ? await parsePlan(fs.readFileSync(arg('plan'))) : null;
const exec = arg('exec') ? await parseExec(fs.readFileSync(arg('exec'))) : null;
const answers = arg('answers') ? JSON.parse(fs.readFileSync(arg('answers'), 'utf8')) : {};

const r = evaluate({ rulesData, plan, exec, answers });
const hm = (v, unit) => (unit === 'count' ? String(v) : minToHhmm(v));

console.log(`חודש ${r.period.month}/${r.period.year} · מצב ${r.mode} · בסיס ${r.domicile} · חוקים ${r.rulesVersion}`);
console.log(`חוקים נתמכים: ${r.rules.supported.length} · לא נתמכים: ${r.rules.unsupported.length}`);
for (const w of r.warnings) console.log('אזהרה:', w);

console.log('\n== שינויים ==');
for (const c of r.changes) console.log(`${c.date.slice(8)}  ${c.label.padEnd(34)} תכנון: ${c.plan ?? '—'}  |  ביצוע: ${c.exec ?? '—'}${c.replacedBy ? '  ← ' + c.replacedBy.join(', ') : ''}`);

console.log('\n== השוואה מול הדוח ==');
for (const row of r.comparison) {
  const mark = row.pending ? '…' : row.ok ? '✓' : '✗';
  console.log(`${mark} ${row.label.padEnd(40)} ${row.column.padEnd(7)} צפוי ${hm(row.expected, row.unit).padStart(6)}  בדוח ${hm(row.reported, row.unit).padStart(6)}${row.ok ? '' : `  פער ${hm(row.diff, row.unit)}`}`);
  if (row.ok === false) for (const e of row.items) console.log(`      · ${e.ruleTitle ?? ''}: ${e.note ?? ''} ${e.min != null ? minToHhmm(e.min) : ''}`);
}

console.log('\n== סיכומים ==');
for (const t of r.totals) console.log(`${t.ok == null ? '?' : t.ok ? '✓' : '✗'} ${t.column.padEnd(7)} צפוי ${minToHhmm(t.expected)}  בדוח ${minToHhmm(t.reported)}`);
if (r.planCheck) console.log(`${r.planCheck.ok ? '✓' : '✗'} Fict. flight time בתכנון: צפוי ${minToHhmm(r.planCheck.expected)}  בקובץ ${minToHhmm(r.planCheck.reported)}`);

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
  for (const n of r.notes) console.log(`- ${n.date.slice(8)} ${n.message}`);
}
if (r.unknownCodes.length) {
  console.log('\n== קודים לא מוכרים ==');
  for (const u of r.unknownCodes) console.log(`- ${u.code} (${u.where}) ב-${u.dates.map((d) => d.slice(8)).join(', ')}`);
}
