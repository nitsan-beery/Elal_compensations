// הגבוה מבין השתיים: 2018 ס' 126–127, 91.1, וישן כ"ה ס' 9 (טיוטה 440).
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, expected, asked, changeNotes } from './helpers.mjs';

const planned = () => [leg('LY541', 'TLV', 'ATH', '10:00', '14:00'), leg('LY542', 'ATH', 'TLV', '15:00', '19:00')]; // 08:00
const flown = () => [leg('LY5', 'TLV', 'LCA', '10:00', '13:00'), leg('LY6', 'LCA', 'TLV', '14:00', '17:00')]; // 06:00
const longer = () => [leg('LY5', 'TLV', 'LCA', '10:00', '15:00'), leg('LY6', 'LCA', 'TLV', '16:00', '21:00')]; // 10:00
const idPlan = 'cancelled:2026-08-05..2026-08-05:ATH';
const link = '2026-08-05..2026-08-05:LCA';
const swap = (exec = flown()) => month(2026, 8, { plan: { '05': planned() }, exec: { '05': exec } });
const answered = (value, exec) => run(swap(exec), { answers: { [idPlan]: { value, link } } });

test('שינוי ביוזמת החברה: הגבוה, וההפרש ב-Rig', () => {
  assert.equal(expected(answered('replaced'), 'Rig', 'TLV-LCA-TLV'), '02:00');
});

test('זכייה במכרז: הגבוה', () => {
  assert.equal(expected(answered('bid'), 'Rig', 'TLV-LCA-TLV'), '02:00');
});

test('החלפה מרצוני: רק מה שבוצע', () => {
  assert.equal(expected(answered('voluntary_swap'), 'Rig', 'TLV-LCA-TLV'), null);
});

test('הטיסה שבוצעה ארוכה יותר: אין הפרש', () => {
  const r = answered('replaced', longer());
  assert.equal(expected(r, 'Rig', 'TLV-LCA-TLV'), null);
  assert.ok(changeNotes(r).some((n) => n.includes('הטיסה הארוכה מבין השתיים: הטיסה שבוצעה')));
});

test('בלי תשובה: נשאל, ואין ציפייה', () => {
  const r = run(swap());
  assert.equal(asked(r, idPlan), true);
  assert.equal(expected(r, 'Rig', 'TLV-LCA-TLV'), null);
});

test('אותה טיסה בשעה אחרת באותו יום אינה שינוי (ס\' 9.ב(1))', () => {
  const later = [leg('LY541', 'TLV', 'ATH', '14:00', '18:00'), leg('LY542', 'ATH', 'TLV', '19:00', '23:00')];
  const r = run(month(2026, 8, { plan: { '05': planned() }, exec: { '05': later } }));
  assert.equal(asked(r, 'cancelled:'), false);
});

// ישן ס' 9.ב(2): גריעת קטע והוספת קטע.
const three = () => [leg('LY541', 'TLV', 'ATH', '10:00', '13:00'), leg('LY541', 'ATH', 'LCA', '14:00', '15:00'), leg('LY542', 'LCA', 'TLV', '16:00', '19:00')]; // 07:00
const two = () => [leg('LY541', 'TLV', 'LCA', '10:00', '13:00'), leg('LY542', 'LCA', 'TLV', '16:00', '19:00')]; // 06:00
const idOmit = 'cancelled:2026-08-05..2026-08-05:ATH-LCA';
const omitted = () => month(2026, 8, { plan: { '05': three() }, exec: { '05': two() } });

test('גריעת קטע אינה שינוי: לא נשאל, בלי הגבוה, עם הערה', () => {
  const r = run(omitted());
  assert.equal(asked(r, idOmit), false);
  assert.equal(expected(r, 'Rig', 'TLV-LCA-TLV'), null);
  assert.ok(changeNotes(r).some((n) => n.includes('נגרע קטע טיסה')));
  assert.ok((r.assumptions ?? []).some((a) => a.id === idOmit && a.changeable !== false));
});

test('גריעת קטע: ביטול ההנחה מחזיר את השאלה', () => {
  assert.equal(asked(run(omitted(), { assumedIgnored: [idOmit] }), idOmit), true);
});

test('אותם מספרי טיסה עם יעד חדש הם סטיה, ולא גריעת קטע', () => {
  const other = [leg('LY541', 'TLV', 'BUD', '10:00', '13:00'), leg('LY542', 'BUD', 'TLV', '16:00', '19:00')];
  const r = run(month(2026, 8, { plan: { '05': three() }, exec: { '05': other } }));
  assert.equal((r.assumptions ?? []).find((a) => a.id === idOmit)?.value, 'diversion');
});

test('מספר טיסה אחר אינו גריעת קטע: נשאל', () => {
  const other = [leg('LY7', 'TLV', 'LCA', '10:00', '13:00'), leg('LY8', 'LCA', 'TLV', '16:00', '19:00')];
  assert.equal(asked(run(month(2026, 8, { plan: { '05': three() }, exec: { '05': other } })), idOmit), true);
});

// שני סבבים שהוחלפו בטיסה אחת: הקרדיט של שניהם יחד מול הטיסה.
const a = () => [leg('LY1', 'TLV', 'ATH', '08:00', '12:00'), leg('LY2', 'ATH', 'TLV', '13:00', '17:00')]; // 08:00
const b = () => [leg('LY3', 'TLV', 'BUD', '08:00', '12:30'), leg('LY4', 'BUD', 'TLV', '13:30', '18:00')]; // 09:00
const both = () => month(2026, 8, { plan: { '05': a(), '06': b() }, exec: { '05': flown() } });
const idB = 'cancelled:2026-08-06..2026-08-06:BUD';

test('שני סבבים ביוזמת החברה לטיסה אחת: שניהם יחד מול הטיסה, פעם אחת', () => {
  const r = run(both(), { answers: { [idPlan]: { value: 'replaced', link }, [idB]: { value: 'replaced', link } } });
  assert.equal(expected(r, 'Rig', 'TLV-LCA-TLV'), '11:00');
});

test('שני סבבים, אחד ביוזמת החברה ואחד בזכייה במכרז: אותו דבר', () => {
  const r = run(both(), { answers: { [idPlan]: { value: 'replaced', link }, [idB]: { value: 'bid', link } } });
  assert.equal(expected(r, 'Rig', 'TLV-LCA-TLV'), '11:00');
});

test('שני סבבים, אחד מהם החלפה מרצוני: רק השני נספר', () => {
  const r = run(both(), { answers: { [idPlan]: { value: 'replaced', link }, [idB]: { value: 'voluntary_swap', link } } });
  assert.equal(expected(r, 'Rig', 'TLV-LCA-TLV'), '02:00');
});
