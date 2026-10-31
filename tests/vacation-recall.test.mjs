// קריאה מחופשה (ישן כ"ה ס' 13.ג; טיוטה 458).
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, hhmm, asked, notes, explains, row, reviews } from './helpers.mjs';

const turn = () => [leg('LY541', 'TLV', 'LCA', '10:00', '11:00'), leg('LY542', 'LCA', 'TLV', '12:00', '13:00')];
const out = () => leg('LY321', 'TLV', 'ATH', '10:00', '13:00');
const back = () => leg('LY322', 'ATH', 'TLV', '09:00', '12:00');
const vac = (days, code = 'VAC_FLD') => Object.fromEntries(days.map((d) => [d, code]));
const com = (r) => hhmm(r.comparison.filter((c) => c.column === 'COM').reduce((s, c) => s + (c.expected ?? 0), 0));
const ID = 'vacation_recall:2026-08-10..2026-08-10:LCA';
const flight = (values = {}) => month(2026, 8, { plan: vac(['10']), exec: { 10: turn() }, values });

test('טיסה ביום חופשה, הרומה לא זיכתה: שאלה', () => {
  const r = run(flight());
  const q = r.questions.find((x) => x.id === ID);
  assert.deepEqual(q.options.map((o) => o.value), ['recalled', 'mine']);
  assert.ok(q.title.includes('LY541') && q.title.includes('10/08'));
  assert.equal(com(r), '00:00');
});

test('"נקראתי לחזור מחופשה": 02:30', () => {
  assert.equal(com(run(flight(), { answers: { [ID]: { value: 'recalled' } } })), '02:30');
});

test('"טסתי לבקשתי": בלי פיצוי ובלי קריאה מיוחדת, ובלי שאלה נוספת', () => {
  const r = run(flight(), { answers: { [ID]: { value: 'mine' } } });
  assert.equal(com(r), '00:00');
  assert.equal(r.comparison.some((c) => c.column === 'S/C' && c.expected), false);
  assert.equal(asked(r, 'unplanned:'), false);
  assert.deepEqual(reviews(r), []);
  assert.ok(r.changes.flatMap((c) => c.notes ?? []).map((n) => n.message ?? n).concat(notes(r)).some((n) => n.includes('לבקשתך')));
});

test('הרומה זיכתה: בלי שאלה', () => {
  const r = run(flight({ 10: { COM: '02:30' } }));
  assert.equal(asked(r, 'vacation_recall:'), false);
  assert.equal(com(r), '02:30');
});

test('הרומה זיכתה רק יום אחד מתוך שניים: שאלה', () => {
  const m = month(2026, 8, { plan: vac(['10', '11']), exec: { 10: [out()], 11: [back()] }, values: { 10: { COM: '02:30' }, 11: { TAB: '12:00' } } });
  assert.equal(asked(run(m), 'vacation_recall:'), true);
});

test('יום שהייה באמצע: כל יממה של הסבב', () => {
  const m = month(2026, 8, { plan: vac(['10', '11', '12']), exec: { 10: [out()], 12: [back()] }, values: { 12: { TAB: '12:00' } } });
  assert.equal(com(run(m, { answers: { 'vacation_recall:2026-08-10..2026-08-12:ATH': { value: 'recalled' } } })), '07:30');
});

test('סבב שחוזר בחודש הבא: גם ימי החופשה בסוף החודש', () => {
  const m = month(2026, 8, { plan: vac(['30', '31']), exec: { 29: [out()] }, values: { 30: { TAB: '24:00' }, 31: { TAB: '24:00' } } });
  assert.equal(com(run(m, { answers: { 'vacation_recall:2026-08-29..2026-08-29:ATH': { value: 'recalled' } } })), '05:00');
});

for (const [name, code, value] of [['סימולטור', 'SIM', '03:45'], ['פעילות קרקע', 'CPT_B', '03:45'], ['כוננות', 'SBY_S', '04:15']]) {
  const m = (extra = {}) => month(2026, 8, { plan: vac(['10']), exec: {}, codes: { 10: code }, values: { 10: { Credit: value, ...extra } } });

  test(`${name} ביום חופשה: בלי פיצוי, ועם הערה`, () => {
    const r = run(m());
    assert.equal(com(r), '00:00');
    assert.ok(notes(r).some((n) => n.includes('רק על טיסה')));
  });

  test(`${name} ביום חופשה, והרומה זיכתה: בלי פער`, () => {
    const r = run(m({ COM: '02:30' }));
    assert.equal(com(r), '02:30');
    assert.ok(explains(row(r, 'COM', '10/08')).includes('הרומה מזכה'));
  });
}

test('חופשה ללא תשלום אינה קריאה מחופשה', () => {
  const r = run(month(2026, 8, { plan: vac(['10'], 'VAC_NOC'), exec: { 10: turn() } }));
  assert.equal(asked(r, 'vacation_recall:'), false);
  assert.equal(com(r), '00:00');
});
