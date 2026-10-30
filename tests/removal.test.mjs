// הורדה מהטיסה: 2024 ס' 46 (חניך), 2026 ס' 22.4 (מטוס חכור), 2026 ס' 23.4 (777), וישן כ"ה ס' 12.ו (החלפה מרצון). טיוטה 442.
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, expected, questions, explains } from './helpers.mjs';

const planned = (extra) => [leg('LY541', 'TLV', 'ATH', '10:00', '14:00', extra), leg('LY542', 'ATH', 'TLV', '15:00', '19:00', extra)]; // 08:00
const flown = () => [leg('LY5', 'TLV', 'LCA', '10:00', '13:00'), leg('LY6', 'LCA', 'TLV', '14:00', '17:00')]; // 06:00
const idPlan = 'cancelled:2026-08-05..2026-08-05:ATH';
const link = '2026-08-05..2026-08-05:LCA';
const sameDay = (extra) => month(2026, 8, { plan: { '05': planned(extra) }, exec: { '05': flown() } });
const answered = (value, m = sameDay()) => run(m, { answers: { [idPlan]: value === 'trainee' ? { value } : { value, link } } });
const options = (r) => r.questions.find((q) => q.id === idPlan).options;
const labels = (r) => options(r).map((o) => o.label);
const sum = (r, column) => r.comparison.filter((c) => c.column === column).reduce((s, c) => s + c.expected, 0);
const onlyTrainee = 'הורדתי מהטיסה המקורית עקב הצבת חניך במקומי';
const both = 'הורדתי מהטיסה המקורית עקב העברה למטוס חכור או הצבת חניך במקומי';

test('ס\' 46: חניך, ובוצעה טיסה אחרת: קרדיט על שתיהן, בלי קריאה מיוחדת', () => {
  const r = answered('trainee');
  assert.equal(sum(r, 'Credit'), 360);
  assert.equal(sum(r, 'Rig'), 480);
  assert.equal(sum(r, 'S/C'), 0);
});

test('שינוי ביוזמת החברה וזכייה במכרז: הגבוה מבין השתיים', () => {
  for (const value of ['replaced', 'bid']) {
    const r = answered(value);
    assert.equal(sum(r, 'Credit'), 360);
    assert.equal(sum(r, 'Rig'), 120);
  }
});

test('בוצעה טיסה אחרת באותם ימים: האפשרות על חניך בלבד', () => {
  const r = run(sameDay());
  assert.ok(labels(r).includes(onlyTrainee));
  assert.ok(!labels(r).includes(both));
  assert.equal(options(r).find((o) => o.label === onlyTrainee).value, 'trainee');
});

test('לא בוצעה טיסה אחרת: האפשרות המאוחדת נשארת', () => {
  const r = run(month(2026, 8, { plan: { '05': planned() }, exec: {} }));
  assert.ok(labels(r).includes(both));
  assert.ok(!labels(r).includes(onlyTrainee));
});

test('ס\' 23.4: אפשרות ה-777 רק כשלא נמצאה הצבה באותם ימים', () => {
  const wide = { ac: 'B789' };
  const label = 'הטיסה עברה ל‑777 ואני לא כשיר MFF';
  assert.ok(labels(run(month(2026, 8, { plan: { '05': planned(wide) }, exec: {} }))).includes(label));
  assert.ok(!labels(run(sameDay(wide))).includes(label));
});

test('ס\' 22.4: בלי טיסה אחרת, השעות שהפסיד כולל השלמה ל-5 שעות (28/07/2026)', () => {
  const short = [leg('LY1', 'TLV', 'LCA', '10:00', '11:10'), leg('LY2', 'LCA', 'TLV', '12:00', '13:10')];
  const r = run(month(2026, 8, { plan: { '05': short }, exec: {} }), { answers: { 'cancelled:2026-08-05..2026-08-05:LCA': { value: 'trainee' } } });
  assert.equal(sum(r, 'Rig'), 300);
});

const spills = () => month(2026, 8, { plan: { '05': planned() }, exec: { '05': [leg('LY5', 'TLV', 'LCA', '10:00', '13:00')], '06': [leg('LY6', 'LCA', 'TLV', '10:00', '13:00')] } });

test('חניך, ומה שבוצע נמשך ליום פנוי: קריאה מיוחדת עליו, בלי שאלה', () => {
  const r = answered('trainee', spills());
  assert.equal(sum(r, 'Rig'), 480);
  assert.equal(sum(r, 'S/C'), 150);
  assert.deepEqual(questions(r), []);
});

test('כמו בשינוי ביוזמת החברה ובזכייה במכרז', () => {
  for (const value of ['replaced', 'bid']) {
    const r = run(spills(), { answers: { [idPlan]: { value, link: '2026-08-05..2026-08-06:LCA' } } });
    assert.equal(sum(r, 'S/C'), 150);
    assert.deepEqual(questions(r), []);
  }
});

test('חניך, והטיסה כולה ביום פנוי: שאלה נפרדת עליה, וקריאה מיוחדת לפי התשובה', () => {
  const m = () => month(2026, 8, { plan: { '05': planned() }, exec: { '07': flown() } });
  const id = 'unplanned:2026-08-07..2026-08-07:LCA';
  assert.deepEqual(questions(run(m(), { answers: { [idPlan]: { value: 'trainee' } } })), [id]);
  const r = run(m(), { answers: { [idPlan]: { value: 'trainee' }, [id]: { value: 'special_call' } } });
  assert.equal(sum(r, 'Rig'), 480);
  assert.equal(sum(r, 'S/C'), 150);
});

test('ישן כ"ה ס\' 12.ו: החלפה מרצון – רק מה שבוצע', () => {
  const r = answered('voluntary_swap');
  assert.equal(sum(r, 'Credit'), 360);
  assert.equal(sum(r, 'Rig'), 0);
  assert.equal(sum(r, 'S/C'), 0);
  assert.equal(expected(r, 'Rig', 'TLV-LCA-TLV'), null);
});

test('החלפה מרצון ליום פנוי: בלי קריאה מיוחדת, גם כשהרומה רשמה', () => {
  const m = month(2026, 8, { plan: { '05': planned() }, exec: { '07': flown() }, values: { '07': { 'S/C': '02:30' } } });
  const r = run(m, { answers: { [idPlan]: { value: 'voluntary_swap', link: '2026-08-07..2026-08-07:LCA' } } });
  assert.equal(sum(r, 'S/C'), 0);
});

// סבב שחלק ממנו בוצע כמתוכנן: LY1 בוצעה, ובמקום LY2 בוצעה חזרה דרך לרנקה (טיוטה 447).
const partPlan = () => ({ '05': [leg('LY1', 'TLV', 'ATH', '10:00', '14:00')], '06': [leg('LY2', 'ATH', 'TLV', '10:00', '14:00')] }); // 08:00
const partExec = () => ({ '05': [leg('LY1', 'TLV', 'ATH', '10:00', '14:00')], '06': [leg('LY7', 'ATH', 'LCA', '10:00', '12:00'), leg('LY8', 'LCA', 'TLV', '13:00', '15:00')] }); // 08:00
const partly = (values = {}) => month(2026, 8, { plan: partPlan(), exec: partExec(), values });
const idPart = 'cancelled:2026-08-05..2026-08-06:ATH';
const partOptions = (r) => r.questions.find((q) => q.id === idPart).options;

test('טיסה מתוכננת בוצעה: אין אפשרות "בוטלה ללא קרדיט"', () => {
  assert.ok(!partOptions(run(partly())).some((o) => o.value === 'cancelled'));
});

test('אף טיסה מתוכננת לא בוצעה: האפשרות נשארת', () => {
  assert.ok(options(run(sameDay())).some((o) => o.value === 'cancelled'));
});

test('הרומה זיכתה קריאה מיוחדת, וטיסה מתוכננת בוצעה: לא מונח שבוטל', () => {
  const r = run(partly({ '06': { 'S/C': '02:30' } }));
  assert.ok(questions(r).includes(idPart));
});

test('הורדה עקב חניך, וחלק מהסבב בוצע: רק השעות של מה שלא בוצע', () => {
  const r = run(partly(), { answers: { [idPart]: { value: 'trainee' } } });
  assert.equal(sum(r, 'Rig'), 240);
  assert.equal(sum(r, 'Credit'), 480);
  assert.ok(explains(r.comparison.find((c) => c.column === 'Rig')).includes('LY2'));
});

test('הרמז בשאלה מראה את אותו סכום', () => {
  const hint = partOptions(run(partly())).find((o) => o.value === 'trainee').hint;
  assert.ok(hint.includes('04:00'));
});

test('שינוי ביוזמת החברה, וחלק מהסבב בוצע: הגבוה מבין השתיים על הסבב כולו', () => {
  const m = month(2026, 8, { plan: partPlan(), exec: { '05': partExec()['05'], '06': [leg('LY7', 'ATH', 'LCA', '10:00', '11:00'), leg('LY8', 'LCA', 'TLV', '12:00', '13:00')] } });
  const q = run(m).questions.find((x) => x.id === idPart);
  assert.equal(sum(run(m, { answers: { [idPart]: { value: 'replaced', link: q.execId } } }), 'Rig'), 120);
});
