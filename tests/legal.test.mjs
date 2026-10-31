// מגבלות החוק מול OMA 7.2 (טיוטה 471).
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, rulesData } from './helpers.mjs';
import { acclimatize, limitsFor } from '../js/rules/legal.js';

const limits = rulesData.legal_limits;
const H = (h) => h * 60;
const single = (date, flight) => ({ [`crew:${date}:${flight}`]: { value: 'single' } });
// התייצבות 06:30, זמן קרקע של 4:10 שאינו מנוחה קצרה, ו-FDP של 13:40 מול 13:00 בטבלה B.
const stretched = (no, sta = '20:10') => [leg(no, 'TLV', 'ATH', '07:30', '11:30'), leg(`${no}B`, 'ATH', 'TLV', '15:40', sta)];
const both = (legs) => ({ plan: legs, exec: legs });

test('FDP מעל המותר בביצוע, עד שעתיים: הארכה, גם כשחרג כבר בתכנון (בעל המוצר)', () => {
  const r = run(month(2026, 8, both({ 10: stretched('LY1') })), { answers: single('2026-08-10', 'LY1') });
  assert.equal(r.legal.extensions.length, 1);
  assert.deepEqual(r.legal.violations, []);
});

test('חריגה בזמן טיסה בביצוע נשארת באדום (בעל המוצר)', () => {
  const planned = { 10: [leg('LY1', 'TLV', 'ATH', '08:00', '12:30'), leg('LY2', 'ATH', 'TLV', '13:30', '17:50')] };
  const flown = { 10: [leg('LY1', 'TLV', 'ATH', '08:00', '12:30'), leg('LY2', 'ATH', 'TLV', '13:30', '17:50', { act: 300 })] };
  const r = run(month(2026, 8, { plan: planned, exec: flown }), { answers: single('2026-08-10', 'LY1') });
  assert.equal(r.legal.violations.length, 1);
  assert.deepEqual(r.legal.extensions, []);
});

const twice = (second, sta) => ({ 10: stretched('LY1'), [second]: stretched('LY3', sta) });
const answers = (second) => ({ ...single('2026-08-10', 'LY1'), ...single(`2026-08-${second}`, 'LY3') });

test('הארכה שנייה של יותר מ-30 דקות בלי 30 שעות פנויות: חריגה', () => {
  const r = run(month(2026, 8, both(twice('11'))), { answers: answers('11') });
  assert.equal(r.legal.extensions.length, 1);
  assert.equal(r.legal.violations.length, 1);
  assert.ok(r.legal.violations[0].message.includes('הארכה שנייה'));
});

test('הארכה שנייה אחרי 30 שעות פנויות: מותרת', () => {
  const r = run(month(2026, 8, both(twice('13'))), { answers: answers('13') });
  assert.equal(r.legal.extensions.length, 2);
  assert.deepEqual(r.legal.violations, []);
});

test('הארכה של 30 דקות בדיוק אינה נספרת', () => {
  const r = run(month(2026, 8, both(twice('11', '20:00'))), { answers: answers('11') });
  assert.equal(r.legal.extensions.length, 2);
  assert.deepEqual(r.legal.violations, []);
});

test('המראה מוקדמת אינה מזיזה את תחילת ה-FDP (7.2.9)', () => {
  // התייצבות 06:00, ו-FDP של 12:30 מול 13:00. לפי ההמראה המוקדמת זו התייצבות 05:50, ו-FDP של 12:40 מול 12:00.
  const planned = { 10: [leg('LY1', 'TLV', 'ATH', '07:00', '11:00'), leg('LY2', 'ATH', 'TLV', '14:00', '18:30')] };
  const flown = { 10: [leg('LY1', 'TLV', 'ATH', '07:00', '11:00', { atd: '06:50', ata: '10:50' }), planned[10][1]] };
  const r = run(month(2026, 8, { plan: planned, exec: flown }));
  assert.equal(r.questions.some((q) => q.id.startsWith('crew:')), false);
  assert.deepEqual(r.legal.extensions, []);
  assert.deepEqual(r.legal.violations, []);
});

const t0 = Date.parse('2026-08-10') / 60000;
const chain = (station, start, hours = 10) => ({ station, start, end: start + H(hours) });
const offsetAt = (s) => (s === 'BKK' ? 240 : 0);

test('הפרש של 4 שעות בדיוק הוא אזור אחר', () => {
  const list = [chain('TLV', t0), chain('BKK', t0 + H(34))];
  acclimatize(list, { limits, offsetAt });
  assert.equal(list[1].notAcclimated, true);
});

test('36 שעות פנויות מעבירות את ההתאקלמות', () => {
  const list = [chain('TLV', t0), chain('BKK', t0 + H(46))];
  acclimatize(list, { limits, offsetAt });
  assert.equal(list[1].notAcclimated, false);
});

test('72 שעות באזור מעבירות את ההתאקלמות, גם בלי 36 שעות פנויות', () => {
  const list = [chain('TLV', t0), chain('BKK', t0 + H(30)), chain('BKK', t0 + H(60)), chain('BKK', t0 + H(95))];
  acclimatize(list, { limits, offsetAt });
  assert.deepEqual(list.map((c) => c.notAcclimated), [false, true, true, false]);
});

test('ההפחתה של 30 דקות חלה גם על המגבלה המשולבת', () => {
  const ch = { fdpStart: t0 + H(23), acc: 0, notAcclimated: true, flights: [{ ac: 'B737' }] };
  assert.equal(limitsFor('single', ch, limits).comb, H(14) - 30);
  assert.equal(limitsFor('augmented', ch, limits).comb, H(17) - 30);
});

const turn = () => [leg('LY1', 'TLV', 'LCA', '10:00', '11:00'), leg('LY2', 'LCA', 'TLV', '12:00', '13:00')];

const airport = (to) => {
  const m = month(2026, 8, { plan: { 10: 'SBY_FLD', 20: turn(), 22: turn() } });
  m.plan.days['2026-08-10'].codeTimes = { SBY_FLD: { dep: { min: H(6), foreign: false }, arr: { min: H(to), foreign: false } } };
  return run(m, { planOnly: true });
};

test('כוננות בשדה בלי טיסה מעל טבלה B: חריגה', () => {
  assert.equal(airport(20).legal.violations.length, 1);
  assert.ok(airport(20).legal.violations[0].message.includes('כוננות בשדה של 14:00'));
});

test('כוננות בשדה בתוך טבלה B: בלי חריגה', () => {
  assert.deepEqual(airport(18).legal.violations, []);
});

const dh = () => leg('LY8', 'TLV', 'ATH', '14:00', '13:00', { dh: true });
const after = () => [leg('LY1', 'TLV', 'LCA', '10:00', '11:00'), leg('LY2', 'LCA', 'TLV', '12:00', '13:00')];

test('DH ארוך: מנוחה קצרה לפני ה-FDP הבא, בנוסח לפי מקור הנתונים', () => {
  const legs = { 10: [dh()], 12: after() };
  const inPlan = run(month(2026, 8, { plan: legs }), { planOnly: true }).legal.violations.filter((v) => v.message.includes('DH של'));
  const inRome = run(month(2026, 8, both(legs))).legal.violations.filter((v) => v.message.includes('DH של'));
  assert.ok(inPlan[0].message.includes('ובתכנון'));
  assert.ok(inRome[0].message.includes('ובפועל'));
});

test('DH ארוך: פעילות קרקע אינה ה-FDP הבא', () => {
  const r = run(month(2026, 8, { plan: { 10: [dh()], 12: 'CPT_BAS', 16: after() } }), { planOnly: true });
  assert.deepEqual(r.legal.violations.filter((v) => v.message.includes('DH של')), []);
});

const night = () => [leg('LY1', 'TLV', 'ATH', '17:00', '20:30', { off: 120 }), leg('LY2', 'ATH', 'TLV', '22:45', '02:15', { off: 120 })];

test('חלון השינה בלילות רצופים לפי השעון המקומי בתחנה', () => {
  const r = run(month(2026, 8, { plan: { 10: night(), 11: night(), 12: night(), 13: night() } }), { planOnly: true });
  assert.deepEqual(r.legal.violations.filter((v) => v.message.includes('הזדמנות שינה')), []);
});
