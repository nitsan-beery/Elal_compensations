// אש"ל לפי הגבוה מבין שתי הטיסות (2018 ס' 127, 91.1; 2026 ס' 23.4; טיוטה 464).
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, notes } from './helpers.mjs';

const out = () => leg('LY3', 'TLV', 'ATH', '10:00', '12:00');
const back = () => leg('LY4', 'ATH', 'TLV', '12:00', '14:00');
const turn = () => [leg('LY1', 'TLV', 'LCA', '10:00', '11:00'), leg('LY2', 'LCA', 'TLV', '12:00', '13:00')];
const stayPlan = { 10: [out()], 11: [back()] };
const ID = 'cancelled:2026-08-10..2026-08-11:ATH';
const swapped = (values, extra = {}) => month(2026, 8, { plan: stayPlan, exec: { 10: turn(), ...extra }, values });
const answers = (value) => ({ [ID]: { value } });
const shortNote = (r) => r.perDiem?.gaps?.[0];

test('הרומה שילמה את השהייה של הטיסה המתוכננת: בלי הערה', () => {
  const r = run(swapped({ 10: { ABR: '28:00', PDFT: '05:00' } }), { answers: answers('replaced') });
  assert.equal(shortNote(r), undefined);
  assert.equal(r.perDiem.stayHours, 28);
  assert.equal(r.perDiem.rome, undefined);
});

test('הרומה לא שילמה: השורה לפי מה שמגיע, ולידה מה שברומה ומה שחסר, ולא בהערות', () => {
  const r = run(swapped({ 10: { ABR: '03:00', PDFT: '05:00' } }), { answers: answers('replaced') });
  const n = shortNote(r);
  assert.ok(n);
  assert.ok(n.includes('28:00') && n.includes('25:00'));
  assert.ok(!n.includes('שעות'));
  assert.ok(!notes(r).some((x) => x.includes('אש"ל לפי הטיסה')));
  assert.equal(r.perDiem.stayHours, 28);
  assert.equal(r.perDiem.rome.stayHours, 3);
  assert.ok(Math.abs(r.perDiem.usd - r.perDiem.rome.usd - 169.5) < 0.02);
});

test('הרומה רשמה את השעות על טיסה סמוכה: בלי הערה', () => {
  const r = run(swapped({ 10: { ABR: '03:00' }, '09': { ABR: '28:00' } }, { '09': turn() }), { answers: answers('replaced') });
  assert.equal(shortNote(r), undefined);
});

test('פער של עד שעה אינו מוצג', () => {
  assert.equal(shortNote(run(swapped({ 10: { ABR: '27:00' } }), { answers: answers('replaced') })), undefined);
  assert.ok(shortNote(run(swapped({ 10: { ABR: '26:59' } }), { answers: answers('replaced') })));
});

test('זכייה במכרז: אותה בדיקה', () => {
  assert.ok(shortNote(run(swapped({ 10: { ABR: '03:00' } }), { answers: answers('bid') })));
});

test('החלפה מרצון: בלי בדיקה', () => {
  assert.equal(shortNote(run(swapped({ 10: { ABR: '03:00' } }), { answers: answers('voluntary_swap') })), undefined);
});

test('הטיסה שבוצעה גבוהה יותר: בלי בדיקה', () => {
  const long = [leg('LY5', 'TLV', 'ATH', '10:00', '12:00'), leg('LY6', 'ATH', 'TLV', '13:00', '15:00')];
  const short = { 10: [leg('LY1', 'TLV', 'LCA', '10:00', '10:30'), leg('LY2', 'LCA', 'TLV', '11:00', '11:30')] };
  const r = run(month(2026, 8, { plan: short, exec: { 10: long }, values: { 10: { ABR: '05:00' } } }), { answers: { 'cancelled:2026-08-10..2026-08-10:LCA': { value: 'replaced' } } });
  assert.equal(shortNote(r), undefined);
});

test('הגבוה נקבע לפי הקרדיט: קרדיט גבוה יותר למה שבוצע, גם כשהשהייה המתוכננת ארוכה יותר', () => {
  const long = [leg('LY5', 'TLV', 'ATH', '10:00', '12:30'), leg('LY6', 'ATH', 'TLV', '13:00', '15:30')];
  const r = run(month(2026, 8, { plan: stayPlan, exec: { 10: long }, values: { 10: { ABR: '05:30' } } }), { answers: answers('bid') });
  assert.equal(shortNote(r), undefined);
  assert.equal(r.perDiem.stayHours, 5.5);
});

test('חודש בלי עמודת ABR: השעות החסרות בשורת האש"ל', () => {
  const r = run(swapped({}), { answers: answers('replaced') });
  assert.equal(shortNote(r), undefined);
  assert.equal(r.perDiem.stayHours, 28);
});

test('תעודת 777: לפי הטיסה שבוטלה, גם בלי טיסה במקומה', () => {
  const wide = (l) => ({ ...l, ac: 'B789' });
  const m = month(2026, 8, { plan: { 10: [wide(out())], 11: [wide(back())], 20: turn().map(wide) }, exec: { 20: turn().map(wide) }, values: { 20: { ABR: '03:00' } } });
  const r = run(m, { answers: answers('swap_777') });
  assert.ok(shortNote(r).includes('שבוטלה'));
});

test('הטיסה בוטלה ללא קרדיט: בלי בדיקה', () => {
  const m = month(2026, 8, { plan: { ...stayPlan, 20: turn() }, exec: { 20: turn() }, values: { 20: { ABR: '03:00' } } });
  assert.equal(shortNote(run(m, { answers: answers('cancelled') })), undefined);
});
