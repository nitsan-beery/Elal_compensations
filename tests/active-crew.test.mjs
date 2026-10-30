// הפעלה כאיש צוות פעיל (2018 ס' 27.1; טיוטה 450).
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, expected, row, explains } from './helpers.mjs';

const out = (extra = {}) => leg('LY321', 'TLV', 'ATH', '10:00', '13:00', extra);
const back = (extra = {}) => leg('LY322', 'ATH', 'TLV', '09:00', '12:00', extra);
const DH = { dh: true };
const PLAN = { 10: [out()], 11: [back(DH)] };
const shown = (r) => r.changes.filter((c) => c.how !== 'exact');

test('DH שבוצעה כאיש צוות פעיל: 02:30, והסבר קצר בלי שם החוק', () => {
  const r = run(month(2026, 8, { plan: PLAN, exec: { 10: [out()], 11: [back()] }, values: { 11: { COM: '02:30' } } }));
  assert.equal(expected(r, 'COM', 'ATH'), '02:30');
  assert.equal(explains(row(r, 'COM', 'ATH')), 'LY322 תוכננה כ-DH ובוצעה כאיש צוות פעיל.');
});

test('אינה שורה בטבלת השינויים', () => {
  assert.equal(shown(run(month(2026, 8, { plan: PLAN, exec: { 10: [out()], 11: [back()] } }))).length, 0);
});

test('שתי רגלי DH: 05:00', () => {
  const r = run(month(2026, 8, { plan: { 10: [out(DH)], 11: [back(DH)] }, exec: { 10: [out()], 11: [back()] } }));
  assert.equal(expected(r, 'COM', 'ATH'), '05:00');
});

test('נשארה DH: בלי פיצוי', () => {
  assert.equal(expected(run(month(2026, 8, { plan: PLAN, exec: PLAN })), 'COM', 'ATH'), null);
});

test('אותו מספר טיסה ביום אחר אינו אותה טיסה', () => {
  const r = run(month(2026, 8, { plan: PLAN, exec: { 10: [out()], 12: [back()] }, values: { 12: { TAB: '12:00' } } }));
  assert.equal(expected(r, 'COM', 'ATH'), null);
});

test('רגל פעילה שבוצעה כ-DH: בלי פיצוי', () => {
  assert.equal(expected(run(month(2026, 8, { plan: { 10: [out()], 11: [back()] }, exec: PLAN })), 'COM', 'ATH'), null);
});
