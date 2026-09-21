// כלי פיתוח: מדפיס את דוח הביצוע המחולץ. לא חלק מהאפליקציה.
// שימוש:  node tools/dump-exec.mjs samples/crewpay-2026-07.pdf
import fs from 'node:fs';
import { parseExec } from '../js/pdf/exec.js';
import { minToHhmm } from '../js/time.js';

const e = await parseExec(fs.readFileSync(process.argv[2]));
const fmt = (v) => (v == null ? '' : v.kind === 'duration' ? minToHhmm(v.min) : v.kind === 'count' ? String(v.count) : v.raw);

console.log('employee:', e.employee, '| period:', e.period, '| format:', e.format);
console.log('status  :', e.status, '| position:', e.position, '| domicile:', e.domicile, '| modified:', e.modified);
console.log('columns :', e.columns.join(' '));
if (e.missingColumns.length) console.log('MISSING :', e.missingColumns.join(' '));
console.log('totals  :', Object.entries(e.totals).map(([k, v]) => `${k}=${minToHhmm(v)}`).join('  '));
console.log('report  :', Object.entries(e.reportTotals).map(([k, v]) => `${k}=${v}`).join('  '));
if (e.warnings.length) console.log('warnings:', e.warnings);
console.log();

const cols = e.columns.filter((c) => !['Day', 'Src', 'Details'].includes(c));
console.log('day src details'.padEnd(30) + cols.map((c) => c.padStart(7)).join(''));
for (const d of Object.values(e.days).sort((a, b) => a.day - b.day)) {
  if (d.absent) { console.log(String(d.day).padStart(2) + '  (אין פעילות)'); continue; }
  console.log(
    String(d.day).padStart(2) + ' ' + (d.src || ' ').padEnd(2) + ' ' + (d.details || '').padEnd(25) +
    cols.map((c) => fmt(d.values[c]).padStart(7)).join('')
  );
  for (const l of d.legs) {
    console.log(`      ${l.type} ${l.flight} ${l.org}->${l.dst}  STD ${minToHhmm(l.std)} STA ${minToHhmm(l.sta)}  ATD ${minToHhmm(l.atd)} ATA ${minToHhmm(l.ata)}  skd ${minToHhmm(l.skdDur)} act ${minToHhmm(l.actDur)}`);
  }
}
