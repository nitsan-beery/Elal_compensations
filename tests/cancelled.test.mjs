// סבב מתוכנן שבוטל: ישן כ"ה ס' 9.ד, וההבהרה של בעל המוצר מ-24/09/2026 (טיוטה 443).
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, asked, questions } from './helpers.mjs';

const planned = () => [leg('LY541', 'TLV', 'ATH', '10:00', '14:00'), leg('LY542', 'ATH', 'TLV', '15:00', '19:00')]; // 08:00
const flown = () => [leg('LY5', 'TLV', 'LCA', '10:00', '13:00'), leg('LY6', 'LCA', 'TLV', '14:00', '17:00')]; // 06:00
const idPlan = 'cancelled:2026-08-05..2026-08-05:ATH';
const cancelled = { [idPlan]: { value: 'cancelled' } };
const sum = (r, column) => r.comparison.filter((c) => c.column === column).reduce((s, c) => s + c.expected, 0);

test('בוטל ולא בוצעה טיסה אחרת: נשאל, ואחרי התשובה לא מגיע כלום', () => {
  const m = () => month(2026, 8, { plan: { '05': planned() }, exec: {} });
  assert.equal(asked(run(m()), idPlan), true);
  const r = run(m(), { answers: cancelled });
  assert.deepEqual(questions(r), []);
  for (const column of ['Credit', 'Rig', 'COM', 'S/C']) assert.equal(sum(r, column), 0);
});

test('בוטל, ובוצעה טיסה אחרת באותם ימים: קריאה מיוחדת, בלי הגבוה מבין השתיים', () => {
  const r = run(month(2026, 8, { plan: { '05': planned() }, exec: { '05': flown() } }), { answers: cancelled });
  assert.equal(sum(r, 'Credit'), 360);
  assert.equal(sum(r, 'S/C'), 150);
  assert.equal(sum(r, 'Rig'), 0);
});

test('הרומה לא זיכתה את הקריאה המיוחדת: פער', () => {
  const r = run(month(2026, 8, { plan: { '05': planned() }, exec: { '05': flown() } }), { answers: cancelled });
  const row = r.comparison.find((c) => c.column === 'S/C');
  assert.equal(row.expected - row.reported, 150);
});

test('הרומה זיכתה קריאה מיוחדת בימי הסבב: מונח שבוטל, בלי שאלה', () => {
  const r = run(month(2026, 8, { plan: { '05': planned() }, exec: { '05': flown() }, values: { '05': { 'S/C': '02:30' } } }));
  assert.equal(asked(r, idPlan), false);
  assert.equal(sum(r, 'S/C'), 150);
});

test('בלי תשובה, ובוצעה טיסה אחרת באותם ימים: נשאל, גם כשהרומה זיכתה את ההפרש בלבד', () => {
  const m = month(2026, 8, { plan: { '05': planned() }, exec: { '05': flown() }, values: { '05': { Rig: '02:00' } } });
  assert.equal(asked(run(m), idPlan), true);
});
