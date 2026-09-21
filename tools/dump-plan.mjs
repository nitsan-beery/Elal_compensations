// כלי פיתוח: מדפיס את התכנון המחולץ. לא חלק מהאפליקציה.
// שימוש:  node tools/dump-plan.mjs samples/duty-plan-2026-07.pdf
import fs from 'node:fs';
import { parsePlan } from '../js/pdf/plan.js';
import { minToHhmm } from '../js/time.js';

const p = await parsePlan(fs.readFileSync(process.argv[2]));
const t = (c) => (c == null ? '----' : (c.foreign ? '!' : ' ') + String(Math.floor(c.min / 60)).padStart(2, '0') + String(c.min % 60).padStart(2, '0'));

console.log('employee:', p.employee, '| period:', p.period, '| printed:', p.printed);
console.log('summary :', Object.entries(p.summary).map(([k, v]) => `${k}=${typeof v === 'number' && k !== 'offDays' ? minToHhmm(v) : v}`).join('  '));
console.log('codes   :', p.codesSeen.join(', '));
if (p.warnings.length) console.log('warnings:', p.warnings);
console.log('days    :', Object.keys(p.days).length);
console.log();

for (const d of Object.values(p.days).sort((a, b) => a.date.localeCompare(b.date))) {
  const info = Object.entries(d.info).map(([k, v]) => `${k} ${minToHhmm(v)}`).join(' ');
  const bits = [];
  if (d.codes.length) bits.push(d.codes.join('+'));
  if (d.pickup) bits.push(`PICKUP ${d.pickup.org} ${t(d.pickup.dep)}/${t(d.pickup.arr)}`);
  for (const l of d.legs) bits.push(`${l.flight} ${l.org}${t(l.dep)}->${l.dst}${t(l.arr)} ${l.ac || ''}`.trim());
  console.log(`${d.date} ${d.dow}  ${(bits.join(' | ') || '-').padEnd(76)} ${info}`);
}
