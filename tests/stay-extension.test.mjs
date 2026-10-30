// הארכת שהייה: חזרה לבסיס מעל 48 שעות אחרי המתוכנן (ישן כ"ה ס' 10.א(5), 10.ב; טיוטה 449).
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, hhmm, questions, asked, notes, changeNotes, reviews } from './helpers.mjs';

const ID = 'extended:2026-08-10..2026-08-14:ATH';
const out = (dst = 'ATH') => leg('LY321', 'TLV', dst, '10:00', '13:00');
const back = (org = 'ATH') => leg('LY322', org, 'TLV', '09:00', '12:00');
const lca = () => [leg('LY541', 'TLV', 'LCA', '10:00', '11:00'), leg('LY542', 'LCA', 'TLV', '12:00', '13:00')];
const PLAN = { 10: [out()], 11: [back()] };
const EXEC = { 10: [out()], 14: [back()] };
// TAB ביום הנחיתה קובע את שעת החזרה לבסיס (`reportEnd`).
const late = (plan = PLAN, exec = EXEC, values = {}) => month(2026, 8, { plan, exec, values: { 14: { TAB: '12:00' }, ...values } });
const answer = (m, value) => run(m, { answers: { [ID]: { value } } });
const clean = (s) => s.replace(/[⁦-⁩‏]/g, '');
const sc = (r) => r.comparison.filter((c) => c.column === 'S/C' && c.expected).map((c) => clean(c.label).slice(0, 5));
const total = (r, column) => hhmm(r.comparison.filter((c) => c.column === column).reduce((s, c) => s + (c.expected ?? 0), 0));
const changeOf = (r, id) => r.changes.find((c) => c.execId === id);

test('מעל 48 שעות: שאלה אחת עם שלוש תשובות, ובלי השאלה הישנה', () => {
  const r = run(late());
  assert.deepEqual(questions(r), [ID]);
  assert.deepEqual(r.questions[0].options.map((o) => o.value), ['company', 'agreed', 'force_majeure']);
  assert.ok(r.questions[0].options.every((o) => !o.hint));
  assert.ok(r.questions[0].options[0].label.includes('ביוזמת החברה'));
});

test('עד 48 שעות: שתי תשובות', () => {
  const r = run(month(2026, 8, { plan: PLAN, exec: { 10: [out()], 12: [back()] }, values: { 12: { TAB: '12:00' } } }));
  assert.deepEqual(r.questions[0].options.map((o) => o.value), ['company', 'agreed']);
});

test('ביוזמת החברה, ימים פנויים: קריאה מיוחדת על כל יום', () => {
  assert.equal(total(answer(late(), 'company'), 'S/C'), '07:30');
});

test('בהסכמתי: בלי פיצוי', () => {
  const r = answer(late(), 'agreed');
  assert.equal(total(r, 'S/C'), '00:00');
  assert.ok([...notes(r), ...changeNotes(r)].some((n) => n.includes('בהסכמתך')));
});

test('ביוזמת החברה: כוננות, קרקע וחופשה מתוכננות אינן מזכות בקריאה מיוחדת', () => {
  for (const code of ['SBY_S', 'HOME_RGT', 'VAC']) {
    const r = answer(late({ ...PLAN, 13: code }), 'company');
    assert.equal(total(r, 'S/C'), '05:00', code);
    assert.ok(!sc(r).includes('13/08'), code);
  }
});

test('אירוע שלא בשליטת החברה: שתי היממות הראשונות ויום החזרה', () => {
  assert.deepEqual(sc(answer(late(), 'force_majeure')), ['12/08', '13/08', '14/08']);
  assert.equal(total(answer(late(), 'force_majeure'), 'S/C'), '07:30');
});

test('אירוע שלא בשליטת החברה, הארכה ארוכה: הימים שבאמצע בלי קריאה מיוחדת', () => {
  const m = month(2026, 8, { plan: PLAN, exec: { 10: [out()], 16: [back()] }, values: { 16: { TAB: '12:00' } } });
  const r = run(m, { answers: { 'extended:2026-08-10..2026-08-16:ATH': { value: 'force_majeure' } } });
  assert.deepEqual(sc(r), ['12/08', '13/08', '16/08']);
});

test('אירוע שלא בשליטת החברה: יום החזרה שתוכננה בו כוננות אינו מזכה', () => {
  assert.equal(total(answer(late({ ...PLAN, 14: 'SBY_S' }), 'force_majeure'), 'S/C'), '05:00');
});

test('אירוע שלא בשליטת החברה: ההערה על אש"ל ועל השהייה מוצגת', () => {
  const r = answer(late(), 'force_majeure');
  assert.ok(notes(r).some((n) => n.includes('אש"ל לכל התקופה') && n.includes('אין זיכוי שהייה')));
});

test('הרומה זיכתה את כל הימים: מונח ביוזמת החברה, בלי שאלה', () => {
  const values = { 12: { 'S/C': '02:30' }, 13: { 'S/C': '02:30' }, 14: { 'S/C': '02:30', TAB: '12:00' } };
  const r = run(late(PLAN, EXEC, values));
  assert.equal(asked(r, 'extended:'), false);
  assert.equal(total(r, 'S/C'), '07:30');
});

test('הארכה שכל ימיה מתוכננים לקרקע: עדיין נשאלת הסיבה', () => {
  const m = late({ ...PLAN, 12: 'HOME_RGT', 13: 'HOME_RGT', 14: 'HOME_RGT' });
  assert.equal(asked(run(m), 'extended:'), true);
  assert.equal(total(answer(m, 'force_majeure'), 'S/C'), '05:00');
});

test('בטבלת השינויים: "הסבב התארך"', () => {
  for (const r of [run(late()), answer(late(), 'force_majeure'), answer(late(), 'agreed')]) {
    assert.equal(changeOf(r, '2026-08-10..2026-08-14:ATH').label, 'הסבב התארך');
  }
});

test('סבב שהוחלף בסבב ארוך ליעד אחר אינו "חזרה מאוחרת"', () => {
  const m = () => month(2026, 8, { plan: { 10: lca() }, exec: { 10: [out('BKK')], 14: [back('BKK')] }, values: { 14: { TAB: '12:00' } } });
  const r = run(m());
  assert.deepEqual(questions(r), ['cancelled:2026-08-10..2026-08-10:LCA']);
  const q = r.questions[0];
  const after = run(m(), { answers: { [q.id]: { value: 'replaced', link: q.execId } } });
  assert.deepEqual(questions(after), []);
  assert.equal(total(after, 'S/C'), '10:00');
});

test('טיסה מתוכננת בימי ההארכה אינה נשאלת, ומוצגת בשורת הסבב', () => {
  const r = run(late({ ...PLAN, 13: lca() }));
  assert.equal(asked(r, 'cancelled:'), false);
  const c = changeOf(r, '2026-08-10..2026-08-14:ATH');
  assert.ok(c.plan.includes('LY541'));
  assert.equal(r.changes.some((x) => x.how === 'cancelled'), false);
  assert.ok(answer(late({ ...PLAN, 13: lca() }), 'company').changes.flatMap((x) => x.notes ?? []).some((n) => (n.message ?? n).includes('לא מגיע עליו קרדיט')));
});

test('גם בהארכה של עד 48 שעות: טיסה מתוכננת לפני הנחיתה אינה נשאלת', () => {
  const m = month(2026, 8, { plan: { ...PLAN, 12: lca() }, exec: { 10: [out()], 12: [back()] }, values: { 12: { TAB: '12:00' } } });
  assert.equal(asked(run(m), 'cancelled:'), false);
});

test('טיסה מתוכננת אחרי הנחיתה נשארת שאלה', () => {
  const m = month(2026, 8, { plan: { ...PLAN, 15: lca() }, exec: { 10: [out()], 14: [back()] }, values: { 14: { TAB: '12:00' } } });
  assert.equal(asked(run(m), 'cancelled:'), true);
});

test('באותו יום אחרי הנחיתה, עם מנוחה חוקית: נשארת שאלה', () => {
  const evening = [leg('LY541', 'TLV', 'LCA', '23:00', '23:50'), leg('LY542', 'LCA', 'TLV', '23:55', '23:59')];
  const m = month(2026, 8, { plan: { ...PLAN, 14: evening }, exec: { 10: [out()], 14: [leg('LY322', 'ATH', 'TLV', '03:00', '06:00')] }, values: { 14: { TAB: '06:00' } } });
  assert.equal(asked(run(m), 'cancelled:'), true);
});

test('טיסה מתוכננת לפני היציאה אינה מוסברת בשהייה', () => {
  const m = month(2026, 8, { plan: { '05': lca(), ...PLAN }, exec: { 10: [out()], 14: [back()] }, values: { 14: { TAB: '12:00' } } });
  assert.equal(asked(run(m), 'cancelled:'), true);
});

test('סבב שחוזר בזמן אינו משנה דבר', () => {
  const r = run(month(2026, 8, { plan: PLAN, exec: PLAN }));
  assert.deepEqual(questions(r), []);
  assert.deepEqual(reviews(r), []);
});
