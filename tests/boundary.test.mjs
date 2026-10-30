// גבול החודש: רגל שחוצה את סוף החודש, הקיזוז ב-1 לחודש, והזיהוי של סבב מהחודש הקודם.
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, expected, row, notes, questions, reviews, explains } from './helpers.mjs';
import { buildTimeline, buildPairings, markCarryIn, attachCarried } from '../js/model.js';

// יוצאת ב-31 ב-19:38 בפועל, 04:22 עד חצות, יותר מהבלוק של 04:15.
const out = leg('LY387', 'TLV', 'ATH', '18:30', '22:45', { dur: 255, atd: '19:38', ata: '00:19', act: 281 });
const back = leg('LY388', 'ATH', 'TLV', '22:55', '02:55');
const may = () => month(2026, 5, { plan: { 31: [out] }, exec: { 31: [out] }, values: { 31: { Credit: '04:22' } } });
const june = () => month(2026, 6, { plan: { '01': [back] }, exec: { '01': [out, back] }, values: { '01': { Credit: 58, TAB: '24:00' }, '02': { Credit: '02:55' } } });

test('רגל שחוצה את סוף החודש: מההמראה בפועל עד חצות, גם מעל הבלוק', () => {
  const r = run(may());
  assert.equal(expected(r, 'Credit', 'TLV-ATH'), '04:22');
  assert.ok(notes(r).some((n) => n.includes('צפי לקיזוז של 7 דקות')));
});

test('הקיזוז ב-1 לחודש עם הרומה הקודמת: תואם לעודף שניתן', () => {
  const r = run(june(), { prev: may() });
  assert.equal(expected(r, 'Credit', '01/06'), '03:53');
  assert.ok(notes(r).some((n) => n.includes('תואם לקרדיט עודף של 7 דקות')));
});

test('הקיזוז ב-1 לחודש בלי הרומה הקודמת: אותו סכום, והערה לוודא', () => {
  const r = run(june());
  assert.equal(expected(r, 'Credit', '01/06'), '03:53');
  assert.ok(notes(r).some((n) => n.includes('יש לוודא')));
});

test('הקיזוז כשהחודש הקודם זיכה אחרת: פער בשורת הקרדיט', () => {
  const m = may();
  m.exec.days['2026-05-31'].values.Credit.min = 255; // 04:15, בלי עודף
  const r = run(june(), { prev: m });
  assert.equal(expected(r, 'Credit', '01/06'), '04:00');
});

// טיוטה 420: רגל מהחודש הקודם, עם עוד רגל באותו יום.
const outA = leg('LY373', 'TLV', 'ATH', '14:00', '20:00');
const backA = leg('LY374', 'ATH', 'TLV', '21:00', '03:00', { dur: 360 });
const sep = () => month(2026, 9, { plan: { 30: [outA, backA] }, exec: { 30: [outA, backA] }, values: { 30: { Credit: '09:00' } } });
const oct = () => month(2026, 10, { plan: { '01': 'X' }, exec: { '01': [backA] }, values: { '01': { Credit: '03:00', TAB: '03:00' } } });

test('רגל שנחתה ב-1 לחודש: בקרדיט בלבד, גם כשבאותו יום טסה רגל אחרת', () => {
  for (const prev of [sep(), null]) {
    const r = run(oct(), { prev });
    assert.equal(expected(r, 'Credit', 'ATH-TLV'), '03:00');
    assert.deepEqual(questions(r).filter((q) => q.startsWith('unplanned:')), []);
    assert.equal((r.changes ?? []).filter((c) => c.date === '2026-10-01').length, 0);
  }
});

// טיוטה 424: רגל מהיום שלפני האחרון שנחתה בו אחרי חצות, סבב אחר.
test('הקיזוז כשרגל אחרת נחתה ביום האחרון אחרי חצות', () => {
  const before = leg('LY999', 'ATH', 'TLV', '23:40', '02:40');
  const m = month(2026, 5, { plan: { 30: [before], 31: [out] }, exec: { 30: [before], 31: [out] }, values: { 30: { Credit: '00:20' }, 31: { Credit: '07:02' } } });
  assert.ok(notes(run(m)).some((n) => n.includes('זוכתה בקרדיט של 04:22') && n.includes('צפי לקיזוז של 7 דקות')));
  assert.equal(expected(run(june(), { prev: m }), 'Credit', '01/06'), '03:53');
});

// טיוטה 430: תוכננה לנחות לפני חצות, ונחתה אחריו בגלל איחור.
const late = leg('LY374', 'ATH', 'TLV', '18:00', '23:30', { atd: '21:00', ata: '02:30' });
test('רגל שחצתה חצות בגלל איחור, בלי הרומה הקודמת: לפי ה-TAB', () => {
  const landed = month(2026, 10, { plan: { '01': 'X' }, exec: { '01': [late] }, values: { '01': { Credit: '02:30', TAB: '02:30' } } });
  assert.equal(expected(run(landed), 'Credit', 'ATH-TLV'), '02:30');
  const away = month(2026, 10, { plan: { '01': 'X' }, exec: { '01': [late] }, values: { '01': { Credit: '02:30', TAB: '24:00' } } });
  assert.equal(expected(run(away), 'Credit', 'ATH-TLV'), '05:30');
});

// טיוטה 425.
const pairingOf = (m, prev) => {
  const days = buildTimeline(m.period, m.plan, m.exec);
  markCarryIn(days, 'TLV', prev);
  const p = buildPairings(days, 'TLV', (d) => d.exec?.legs)[0];
  attachCarried(p, days, 'TLV', prev);
  return p;
};
const stay = [leg('LY321', 'TLV', 'ATH', '10:00', '13:00'), leg('LY322', 'ATH', 'TLV', '09:00', '12:00')];
const mar = (planned = true) => month(2026, 3, { plan: planned ? { 31: [stay[0]] } : {}, exec: { 31: [stay[0]] } });
const apr = () => month(2026, 4, { plan: { '02': [stay[1]] }, exec: { '02': [stay[1]] }, values: { '01': { TAB: '24:00' } } });

test('הרגליים מהחודש הקודם: מהרומה, ובלעדיה מהתכנון', () => {
  const rome = pairingOf(apr(), mar());
  assert.equal(rome.carriedSource, 'exec');
  assert.deepEqual(rome.prevLegs.map((l) => l.flight), ['LY321']);
  const plan = pairingOf(apr(), { ...mar(), exec: null });
  assert.equal(plan.carriedSource, 'plan');
});

test('התכנון הקודם רק רמז: לא נלקח כשאינו מתאים לרגל הראשונה', () => {
  const other = month(2026, 3, { plan: { 31: [leg('LY1', 'TLV', 'LCA', '10:00', '11:00')] } });
  assert.equal(pairingOf(apr(), { ...other, exec: null }).carriedSource, undefined);
});

test('בלי חודש קודם: הסבב מזוהה כחתוך, בלי רגליים', () => {
  const p = pairingOf(apr(), null);
  assert.equal(p.cutAtStart, true);
  assert.equal(p.prevLegs, undefined);
});

test('מרומה בלי קובץ: אין בדיקה ידנית על רגל מוכרת', () => {
  assert.deepEqual(reviews(run(june(), { prev: may() })).filter((m) => m.includes('LY387')), []);
  assert.ok(row(run(june(), { prev: may() }), 'Credit', '01/06'));
  assert.equal(typeof explains(row(run(may()), 'Credit', 'TLV-ATH')), 'string');
});
