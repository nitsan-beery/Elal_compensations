// זיכוי מינימלי לסליפ קצר: 2018 ס' 27.2, ו-2024 ס' 38 ("10 שעות, 5 עבור כל טיסת סבב").
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, expected, hhmm, questions } from './helpers.mjs';

const rigTotal = (r) => hhmm(r.comparison.filter((c) => c.column === 'Rig').reduce((s, c) => s + c.expected, 0));
const flown = (legs, rig) => month(2026, 8, { plan: { '05': legs }, exec: { '05': legs }, values: rig ? { '05': { Rig: rig } } : {} });

test('בדיוק 5 שעות: אין השלמה', () => {
  const legs = [leg('LY1', 'TLV', 'ATH', '10:00', '12:30'), leg('LY2', 'ATH', 'TLV', '13:00', '15:30')];
  assert.equal(expected(run(flown(legs)), 'Rig', 'TLV-ATH-TLV'), null);
});

test('דקה מתחת ל-5 שעות: השלמה של דקה', () => {
  const legs = [leg('LY1', 'TLV', 'ATH', '10:00', '12:30'), leg('LY2', 'ATH', 'TLV', '13:00', '15:29')];
  assert.equal(expected(run(flown(legs, '00:01')), 'Rig', 'TLV-ATH-TLV'), '00:01');
});

test('הסעיף מדבר על סליפ ולא רק על טיסת סבב: גם סבב עם לינה', () => {
  const [a, b] = [leg('LY1', 'TLV', 'ATH', '10:00', '12:00'), leg('LY2', 'ATH', 'TLV', '10:00', '12:00')];
  const m = month(2026, 8, { plan: { '05': [a], '06': [b] }, exec: { '05': [a], '06': [b] }, values: { '06': { Rig: '01:00' } } });
  assert.equal(expected(run(m), 'Rig', 'TLV-ATH-TLV'), '01:00');
});

test('שתי טיסות סבב באותו FDP: 5 שעות לכל אחת (2024 ס\' 38)', () => {
  const legs = [leg('LY1', 'TLV', 'LCA', '06:00', '07:10'), leg('LY2', 'LCA', 'TLV', '08:00', '09:10'), leg('LY3', 'TLV', 'LCA', '10:00', '11:10'), leg('LY4', 'LCA', 'TLV', '12:00', '13:10')];
  assert.equal(rigTotal(run(flown(legs))), '05:20');
});

test('טיסה ארוכה וטיסה קצרה באותו FDP: העודף אינו מקוזז', () => {
  const legs = [leg('LY1', 'TLV', 'ATH', '06:00', '09:08'), leg('LY2', 'ATH', 'TLV', '10:00', '13:08'), leg('LY3', 'TLV', 'LCA', '14:00', '15:10'), leg('LY4', 'LCA', 'TLV', '16:00', '17:10')];
  assert.equal(rigTotal(run(flown(legs))), '02:40');
});

test('חזרה לבסיס אחרי המראה, בלי טיסה אחריה: השלמה ל-5 שעות (15/09/2025)', () => {
  const planned = [leg('LY571', 'TLV', 'ATH', '10:00', '13:00'), leg('LY572', 'ATH', 'TLV', '14:00', '17:00')];
  const back = [leg('LY571', 'TLV', 'TLV', '10:00', '10:25')];
  const m = month(2026, 8, { plan: { '05': planned }, exec: { '05': back } });
  assert.equal(expected(run(m), 'Rig', 'TLV-TLV'), '04:35');
  assert.deepEqual(questions(run(m)).filter((q) => q.startsWith('cancelled:')), []);
});

test('הסבב שבוצע במקום המתוכנן מקבל השלמה לפי עצמו', () => {
  const planned = [leg('LY1', 'TLV', 'ATH', '10:00', '12:00'), leg('LY2', 'ATH', 'TLV', '13:00', '15:00')];
  const short = [leg('LY5', 'TLV', 'LCA', '10:00', '11:00'), leg('LY6', 'LCA', 'TLV', '12:00', '13:00')];
  const m = month(2026, 8, { plan: { '05': planned }, exec: { '05': short } });
  const id = 'cancelled:2026-08-05..2026-08-05:ATH';
  assert.equal(expected(run(m, { answers: { [id]: { value: 'voluntary_swap', link: '2026-08-05..2026-08-05:LCA' } } }), 'Rig', 'TLV-LCA-TLV'), '03:00');
});
