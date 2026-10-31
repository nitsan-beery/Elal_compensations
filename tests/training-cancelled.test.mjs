// ביטול הדרכה או סימולטור והצבה לטיסה (ישן כ"ה ס' 17.ג; טיוטה 452).
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run } from './helpers.mjs';

const clean = (s) => s.replace(/[⁦-⁩‏]/g, '');
const out = () => leg('LY321', 'TLV', 'ATH', '10:00', '13:00');
const back = () => leg('LY322', 'ATH', 'TLV', '09:00', '12:00');
const turn = () => [leg('LY541', 'TLV', 'LCA', '10:00', '11:00'), leg('LY542', 'LCA', 'TLV', '12:00', '13:00')];
const sc = (r) => r.comparison.filter((c) => c.column === 'S/C' && c.expected).map((c) => clean(c.label).slice(0, 5));
const swapped = () => month(2026, 8, { plan: { 10: turn(), 11: 'CPT_BAS' }, exec: { 10: [out()], 11: [back()] } });
const answered = (value) => {
  const q = run(swapped()).questions.find((x) => x.id.startsWith('cancelled:'));
  return run(swapped(), { answers: { [q.id]: { value, link: q.execId } } });
};

test('יום שתוכננה בו טיסה אינו קריאה מיוחדת, עד התשובה ואחריה', () => {
  assert.deepEqual(sc(run(swapped())), ['11/08']);
  for (const value of ['voluntary_swap', 'replaced', 'bid']) assert.deepEqual(sc(answered(value)), ['11/08'], value);
});

test('הטיסה המתוכננת בוטלה ללא קרדיט: גם היום שלה', () => {
  assert.deepEqual(sc(answered('cancelled')), ['10/08', '11/08']);
});

test('יום ההדרכה ויום פנוי אחריו: קריאה מיוחדת על שניהם', () => {
  assert.deepEqual(sc(run(month(2026, 8, { plan: { 10: 'CPT_BAS' }, exec: { 10: [out()], 11: [back()] } }))), ['10/08', '11/08']);
});

test('RGT הוא קורס קרקע: בוטל והוצבת לטיסה – קריאה מיוחדת (טיוטה 468)', () => {
  assert.deepEqual(sc(run(month(2026, 8, { plan: { 10: 'RGT' }, exec: { 10: turn() } }))), ['10/08']);
});

test('HOME_RGT נשאר מחוץ לס\' 17.ג', () => {
  assert.deepEqual(sc(run(month(2026, 8, { plan: { 10: 'HOME_RGT' }, exec: { 10: turn() } }))), []);
});

test('סימולטור שבוטל והוצבת לטיסה: קריאה מיוחדת גם כשהרומה לא רשמה', () => {
  assert.deepEqual(sc(run(month(2026, 8, { plan: { 10: 'SIM' }, exec: { 10: turn() } }))), ['10/08']);
});
