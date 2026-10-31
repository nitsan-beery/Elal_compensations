// שתי שבתות ברצף: איפה הרומה רשמה את הפיצוי (2024 ס' 34; טיוטה 461).
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, asked, expected, explains, row } from './helpers.mjs';

const sat = () => [leg('LY1', 'TLV', 'ATH', '10:00', '12:00'), leg('LY2', 'ATH', 'TLV', '13:00', '15:00')];
const days = (list) => Object.fromEntries(list.map((d) => [d, sat()]));
const two = (values) => month(2026, 10, { plan: days(['03', '10']), exec: days(['03', '10']), values });

test('הרומה רשמה על השבת השנייה: בלי שאלה', () => {
  const r = run(two({ 10: { COM: '05:00' } }));
  assert.equal(asked(r, 'saturdays:'), false);
  assert.equal(expected(r, 'COM', '10/10'), '05:00');
});

test('הרומה רשמה על השבת הראשונה: בלי שאלה, והפיצוי מוסבר בשורה הזאת', () => {
  const r = run(two({ '03': { COM: '05:00' } }));
  assert.equal(asked(r, 'saturdays:'), false);
  assert.equal(expected(r, 'COM', '03/10'), '05:00');
  assert.ok(explains(row(r, 'COM', '03/10')).length > 0);
});

test('הרומה רשמה ביום אחר: השאלה נשארת', () => {
  assert.equal(asked(run(two({ 20: { COM: '05:00' } })), 'saturdays:'), true);
});

test('שלוש שבתות, ופיצוי אחד על האמצעית: הזוג השני עדיין נשאל', () => {
  const m = month(2026, 10, { plan: days(['03', '10', '17']), exec: days(['03', '10', '17']), values: { 10: { COM: '05:00' } } });
  const r = run(m);
  assert.equal(asked(r, 'saturdays:2026-10-03'), false);
  assert.equal(asked(r, 'saturdays:2026-10-10'), true);
});

test('השבת הראשונה בחודש הקודם: הבדיקה רק על מה שבחודש הזה', () => {
  const prev = month(2026, 9, { plan: days(['26']), exec: days(['26']) });
  const m = month(2026, 10, { plan: days(['03']), exec: days(['03']), values: { '03': { COM: '05:00' } } });
  assert.equal(asked(run(m, { prev }), 'saturdays:'), false);
});
