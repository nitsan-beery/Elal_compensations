// "סיבה אחרת" על סבב שעבר דרך יומן השינויים (טיוטה 453).
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../js/rules/evaluate.js';
import { reduceChain } from '../js/rules/journal.js';
import { month, leg, rulesData, hhmm, changeNotes, reviews, notes } from './helpers.mjs';

const ID = 'cancelled:2026-08-10..2026-08-10:LCA';
const TEXT = 'טיסה אחרת החליפה גם אותה';
const lca = () => [leg('LY541', 'TLV', 'LCA', '10:00', '11:00'), leg('LY542', 'LCA', 'TLV', '12:00', '13:00')];
const ath = () => [leg('LY321', 'TLV', 'ATH', '10:00', '13:00'), leg('LY322', 'ATH', 'TLV', '14:00', '17:00')];
const flight = (flight, org, dst, std, sta) => ({ flight, org, dst, std: `2026-08-20T${std}:00+03:00`, sta: `2026-08-20T${sta}:00+03:00` });
// היומן: LCA ירדה ממנו, ו-ATH נשארה.
const calendar = { from: '2026-08-01T00:00:00+03:00', standby: [], flights: [flight('LY321', 'TLV', 'ATH', '10:00', '13:00'), flight('LY322', 'ATH', 'TLV', '14:00', '17:00')] };

const go = (creditMin, withCalendar = true) => {
  const m = month(2026, 8, { plan: { 10: lca(), 20: ath() }, exec: { 20: ath() } });
  return evaluate({ rulesData, plan: m.plan, exec: m.exec, history: [], answers: { [ID]: { value: 'other', label: 'סיבה אחרת', text: TEXT, creditMin } },
    ...(withCalendar && { calendar, calendarHistory: [calendar] }) });
};
const rig = (r) => hhmm(r.comparison.filter((c) => c.column === 'Rig').reduce((s, c) => s + (c.expected ?? 0), 0));

test('התשובה עוברת ביומן השינויים עם הבחירה בקרדיט', () => {
  const plan = { id: 'p' };
  const chain = { plan, last: null, steps: [{ answer: { value: 'other', text: TEXT, creditMin: 150 }, fromPairing: plan, to: null, node: { id: 'p' } }] };
  const eff = reduceChain(chain, { toExec: () => null, credit: () => 0, execAnswer: () => null, byExecId: () => null });
  assert.equal(eff.creditMin, 150);
  assert.equal(eff.text, TEXT);
});

test('לא מגיע קרדיט: בלי בדיקה ידנית, ועם שורה אחת מתחת לשינוי', () => {
  const r = go(0);
  assert.deepEqual(reviews(r), []);
  assert.equal(rig(r), '00:00');
  assert.deepEqual(changeNotes(r).filter((n) => n.includes(TEXT)), [`"${TEXT}" – לא מגיע קרדיט.`]);
});

test('מגיע קרדיט: נספר ב-Rig, בלי בדיקה ידנית', () => {
  const r = go(150);
  assert.deepEqual(reviews(r), []);
  assert.equal(rig(r), '02:30');
  assert.deepEqual(changeNotes(r).filter((n) => n.includes(TEXT)), [`"${TEXT}" – קרדיט נוסף.`]);
});

test('אותה תוצאה בלי היומן', () => {
  for (const credit of [0, 150]) {
    assert.equal(rig(go(credit, false)), rig(go(credit)));
    assert.deepEqual(changeNotes(go(credit, false)).filter((n) => n.includes(TEXT)), changeNotes(go(credit)).filter((n) => n.includes(TEXT)));
  }
});

test('תשובה ישנה בלי בחירה בקרדיט: השאלה נפתחת מחדש', () => {
  const r = go(undefined);
  assert.deepEqual(reviews(r), []);
  assert.equal(r.questions.find((q) => q.id === ID).previous.text, TEXT);
  assert.equal(notes(r).some((n) => n.includes('קרדיט נוסף')), false);
});
