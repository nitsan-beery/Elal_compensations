// קריאה מיוחדת (ישן כ"ה ס' 1.יא, 1.יד, 12.ב–יא; טיוטה 456).
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, expected, explains, row, notes } from './helpers.mjs';

const clean = (s) => s.replace(/[⁦-⁩‏]/g, '');
const sc = (r) => r.comparison.filter((c) => c.column === 'S/C' && c.expected).map((c) => clean(c.label).slice(0, 5));
const out = (std, sta) => leg('LY1', 'TLV', 'ATH', std, sta);
const back = (std, sta) => leg('LY2', 'ATH', 'TLV', std, sta);

// הרומה זיכתה את היממה הראשונה, ולכן אין שאלה. ה-TAB ביום הנחיתה קובע את שעת החזרה לבסיס.
const stayed = (std, sta, s2, e2) => month(2026, 8, { plan: {}, exec: { 10: [out(std, sta)], 11: [back(s2, e2)] }, values: { 10: { 'S/C': '02:30' }, 11: { TAB: e2 } } });

test('היממה השנייה: מעל 8 שעות, ולפחות 4 ביממה השנייה (ס\' 12.יא)', () => {
  for (const [name, m, days] of [
    ['8:00 בדיוק', stayed('20:00', '22:00', '02:00', '04:00'), ['10/08']],
    ['8:01, 4:01', stayed('20:00', '22:00', '02:01', '04:01'), ['10/08', '11/08']],
    ['8:01, 3:59', stayed('19:58', '22:00', '02:00', '03:59'), ['10/08']],
    ['9:00, 4:00', stayed('19:00', '22:00', '02:00', '04:00'), ['10/08', '11/08']],
  ]) assert.deepEqual(sc(run(m)), days, name);
});

test('השהייה מתחילה בהמראה המוקדמת מבין המתוכננת לבפועל (ס\' 1.יא)', () => {
  const m = month(2026, 8, { plan: {}, exec: { 10: [leg('LY1', 'TLV', 'ATH', '20:00', '22:00', { atd: '19:30' })], 11: [back('02:00', '04:00')] }, values: { 10: { 'S/C': '02:30' }, 11: { TAB: '04:00' } } });
  assert.deepEqual(sc(run(m)), ['10/08', '11/08']);
});

// ---------- כוננות (ס' 12.ב) ----------

const UNPLANNED = { 'unplanned:2026-08-10..2026-08-11:ATH': { value: 'special_call' } };
const flown = () => ({ 10: [out('10:00', '13:00')], 11: [back('09:00', '12:00')] });
const TAB = { 11: { TAB: '12:00' } };

test('סבב שהתחיל לפני הכוננות: בלי קריאה מיוחדת על יום הכוננות', () => {
  assert.deepEqual(sc(run(month(2026, 8, { plan: { 11: 'SBY_S' }, exec: flown(), values: TAB }), { answers: UNPLANNED })), ['10/08']);
});

test('ועל היום הזה הגבוה מבין הרגליים בו לערך הכוננות', () => {
  const r = run(month(2026, 8, { plan: { 11: 'SBY_S' }, exec: flown(), values: TAB }), { answers: UNPLANNED });
  assert.equal(expected(r, 'Rig', 'ATH'), '01:15');
  assert.equal(explains(row(r, 'Rig', 'ATH')), 'ערך יום הכוננות שבו טסת גבוה מקרדיט הרגליים באותו יום.');
});

test('הרגל ביום הכוננות גבוהה מהערך: בלי תוספת, ובלי "הופעלת"', () => {
  const m = month(2026, 8, { plan: { 11: 'SBY_S' }, exec: { 10: [out('10:00', '13:00')], 11: [back('06:00', '12:00')] }, values: TAB });
  const r = run(m, { answers: UNPLANNED });
  assert.equal(expected(r, 'Rig', 'ATH'), null);
  assert.ok(notes(r).some((n) => n.includes('טסת ביום כוננות') && !n.includes('הופעלת')));
});

test('זכייה במכרז: קריאה מיוחדת גם על ימי הכוננות (2024 ס\' 50)', () => {
  const m = month(2026, 8, { plan: { 11: 'SBY_S', 12: 'SBY_S' }, exec: { 12: [out('10:00', '13:00')], 13: [back('09:00', '12:00')] }, values: { 13: { TAB: '12:00' } } });
  const r = run(m, { answers: { 'standby_bid:2026-08-12..2026-08-13:ATH': { value: 'standby_bid' } } });
  assert.deepEqual(sc(r), ['12/08', '13/08']);
});

test('הארכה ביוזמת החברה ליום כוננות: בלי קריאה מיוחדת עליו, והגבוה מבין', () => {
  const plan = { 10: [out('10:00', '13:00'), back('14:00', '17:00')], 11: 'SBY_S' };
  const m = month(2026, 8, { plan, exec: { 10: [out('10:00', '13:00')], 11: [back('09:00', '12:00')] }, values: TAB });
  const r = run(m, { answers: { 'extended:2026-08-10..2026-08-11:ATH': { value: 'company' } } });
  assert.deepEqual(sc(r), []);
  assert.equal(expected(r, 'Rig', 'ATH'), '01:15');
});

// ---------- סדרת טיסות דרך הבסיס (ס' 1.יא(2), 1.יד) ----------

const series = (values = {}) => ({
  10: [leg('LY1', 'TLV', 'ATH', '16:00', '18:00'), leg('LY2', 'ATH', 'TLV', '18:30', '20:30'), leg('LY3', 'TLV', 'LCA', '22:00', '23:30')],
  11: [leg('LY4', 'LCA', 'TLV', '03:00', '04:30')],
});

test('סדרה עם הבסיס כתחנת מעבר נמדדת יחד: 12:30, ו-4:30 ביממה השנייה', () => {
  const m = month(2026, 8, { plan: {}, exec: series(), values: { 10: { 'S/C': '02:30' }, 11: { TAB: '04:30' } } });
  assert.deepEqual(sc(run(m)), ['10/08', '11/08']);
});

test('אחרי מנוחה בבסיס אלה שתי סדרות: הסף על השנייה לבדה', () => {
  const legs = {
    10: [leg('LY1', 'TLV', 'ATH', '05:00', '06:30'), leg('LY2', 'ATH', 'TLV', '07:00', '08:30'), leg('LY3', 'TLV', 'LCA', '22:00', '23:30')],
    11: [leg('LY4', 'LCA', 'TLV', '03:00', '04:30')],
  };
  const m = month(2026, 8, { plan: {}, exec: legs, values: { 10: { 'S/C': '02:30' }, 11: { TAB: '04:30' } } });
  assert.deepEqual(sc(run(m)), ['10/08']);
});
