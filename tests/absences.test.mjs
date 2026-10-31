// היעדרויות: איזון חופשה, תקרה חודשית, ומחלה ביום חופשה (ישן כ"ה ס' 13, 15; 2024 ס' 59–65; טיוטה 459).
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, hhmm, notes, reviews, rulesData } from './helpers.mjs';

const pad = (n) => String(n).padStart(2, '0');
const credit = (r) => hhmm(r.comparison.filter((c) => c.column === 'Credit').reduce((s, c) => s + (c.expected ?? 0), 0));
const vacation = (year, m, n, start = 1) => {
  const plan = {}; const codes = {}; const values = {};
  for (let d = start; d < start + n; d++) {
    plan[pad(d)] = 'VAC_FLD';
    codes[pad(d)] = 'VAC_F';
    values[pad(d)] = { Credit: '03:45' };
  }
  return month(year, m, { plan, exec: {}, codes, values });
};

test('איזון 2024: 0.70 ליום (ס\' 59)', () => {
  assert.equal(credit(run(vacation(2024, 8, 5))), '16:00');
  assert.equal(credit(run(vacation(2024, 8, 20))), '64:00');
});

test('איזון 2024: לפי הטבלה מעל 20 ימים', () => {
  assert.equal(credit(run(vacation(2024, 8, 21))), hhmm(21 * 150 + Math.round(21 * 0.63 * 60)));
  assert.equal(credit(run(vacation(2024, 8, 30))), hhmm(30 * 150 + Math.round(30 * 0.24 * 60)));
});

test('איזון 2025: 1.25 ליום, כמו קודם', () => {
  assert.equal(credit(run(vacation(2025, 8, 5))), '18:45');
});

test('הטבלאות תואמות את ההסכם', () => {
  const table = (id) => rulesData.rules.find((r) => r.id === id).logic.params.taper_table;
  assert.deepEqual(Object.values(table('vacation_credit_balance_2024')), [0.7, 0.63, 0.57, 0.52, 0.46, 0.42, 0.38, 0.34, 0.3, 0.26, 0.24]);
  assert.deepEqual(Object.values(table('vacation_credit_balance')), [1.25, 1.13, 1.02, 0.92, 0.83, 0.75, 0.67, 0.6, 0.54, 0.47, 0.42]);
});

test('21 ימי חופשה ובשאר החודש ימים פנויים: בלי תקרה', () => {
  const r = run(vacation(2026, 8, 21));
  assert.equal(credit(r), '76:14');
  assert.ok(!notes(r).some((n) => n.includes('תקרה')));
});

test('חודש מלא של היעדרות: הצפוי יורד ל-75:00', () => {
  const r = run(vacation(2026, 8, 31));
  assert.equal(credit(r), '75:00');
  assert.ok(notes(r).some((n) => n.includes('הצפוי הוא התקרה')));
  assert.deepEqual(reviews(r), []);
});

test('חודש מלא של היעדרות בתכנון לבד: אותה תקרה', () => {
  const r = run(vacation(2026, 8, 31), { planOnly: true });
  assert.equal(hhmm((r.expectations ?? []).filter((e) => e.key === 'absence').reduce((s, e) => s + e.min, 0)), '75:00');
});

// ---------- מחלה ביום חופשה (ישן כ"ה ס' 15.ב) ----------

const sick = (planned, values = {}) => month(2026, 8, { plan: { 10: planned }, exec: {}, codes: { 10: 'SICK' }, values: { 10: values } });

test('מחלה ביום חופשה מתוכננת: 02:30, גם כשהרומה לא זיכתה', () => {
  assert.equal(credit(run(sick('VAC_FLD'))), '02:30');
  assert.equal(credit(run(sick('VAC_FLD', { Credit: '02:30' }))), '02:30');
});

test('מחלה ביום מחלה מתוכנן: 02:30', () => {
  const r = run(sick('SCK_PLAN', { Credit: '02:30' }));
  assert.equal(credit(r), '02:30');
});

test('מחלה ביום חופשה ללא תשלום: בלי קרדיט', () => {
  assert.equal(credit(run(sick('VAC_NOC'))), '00:00');
});

test('מחלה ביום פנוי: בלי קרדיט, כמו קודם', () => {
  const r = run(month(2026, 8, { plan: {}, exec: {}, codes: { 10: 'SICK' } }));
  assert.equal(credit(r), '00:00');
  assert.ok(notes(r).some((n) => n.includes('לא היית מוצב')));
});

test('היום נשאר חופשה ברומה: 03:45, כמו קודם', () => {
  assert.equal(credit(run(vacation(2026, 8, 1, 10))), '03:45');
});

test('טיסה ביום מחלה: הקוד לא מזכה פעמיים', () => {
  const turn = [leg('LY541', 'TLV', 'LCA', '10:00', '11:00'), leg('LY542', 'LCA', 'TLV', '12:00', '13:00')];
  const r = run(month(2026, 8, { plan: { 10: turn }, exec: {}, codes: { 10: 'SICK' }, values: { 10: { Credit: '02:30' } } }));
  assert.equal(credit(r), '02:30');
});
