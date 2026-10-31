// אין "לבדיקה ידנית": כל הודעה היא שאלה, הכרעה של האפליקציה, או דיווח לניצן (טיוטה 454).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { month, leg, run, expected, asked, notes, reviews, questions } from './helpers.mjs';

const sat = () => [leg('LY1', 'TLV', 'ATH', '10:00', '12:00'), leg('LY2', 'ATH', 'TLV', '13:00', '15:00')];
const night = () => [leg('LY1', 'TLV', 'ATH', '01:00', '03:00'), leg('LY2', 'ATH', 'TLV', '03:40', '05:40')];
const out = () => leg('LY321', 'TLV', 'ATH', '10:00', '13:00');
const back = () => leg('LY322', 'ATH', 'TLV', '09:00', '12:00');
const turn = () => [leg('LY541', 'TLV', 'LCA', '10:00', '11:00'), leg('LY542', 'LCA', 'TLV', '12:00', '13:00')];
const days = (list, make) => Object.fromEntries(list.map((d) => [d, make()]));
const other = (extra = {}) => ({ value: 'other', label: 'סיבה אחרת', text: 'משהו', creditMin: 0, ...extra });
const COMPANY = 'other_company:';

test('אין בקוד הודעת "דורש בדיקה ידנית"', () => {
  for (const f of ['duty', 'logic', 'evaluate']) {
    assert.ok(!fs.readFileSync(new URL(`../js/rules/${f}.js`, import.meta.url), 'utf8').includes('דורש בדיקה ידנית.`'), f);
  }
});

// ---------- "סיבה אחרת" שמשנה את התוצאה: האם זה היה ביוזמת החברה? ----------

const landings = () => {
  const plan = days(['10', '20', '25'], night);
  return month(2026, 8, { plan, exec: days(['10', '20'], night) });
};
const CUT = 'cancelled:2026-08-25..2026-08-25:ATH';

test('נחיתות לילה: שאלה ולא בדיקה ידנית', () => {
  const r = run(landings(), { answers: { [CUT]: other() } });
  assert.deepEqual(reviews(r), []);
  assert.equal(asked(r, COMPANY), true);
  assert.ok(r.questions.find((q) => q.id.startsWith(COMPANY)).title.includes('LY'));
});

test('נחיתות לילה: "כן" נספרת, ו"לא" לא', () => {
  const answer = (value) => run(landings(), { answers: { [CUT]: other(), [`${COMPANY}2026-08-25..2026-08-25:ATH`]: { value } } });
  assert.equal(asked(answer('yes'), COMPANY), false);
  assert.equal(asked(answer('yes'), 'night_crew:'), true);
  assert.equal(asked(answer('no'), 'night_crew:'), false);
  assert.deepEqual(reviews(answer('no')), []);
});

const saturdays = () => month(2026, 10, { plan: days(['03', '10'], sat), exec: days(['03'], sat) });
const SAT = 'cancelled:2026-10-10..2026-10-10:ATH';

test('שבתות ברצף: "סיבה אחרת" נשאלת, ולא נעלמת בשקט', () => {
  assert.equal(asked(run(saturdays(), { answers: { [SAT]: other() } }), COMPANY), true);
});

test('שבתות ברצף: "כן" נספרת, ו"לא" לא', () => {
  const answer = (value) => run(saturdays(), { answers: { [SAT]: other(), [`${COMPANY}2026-10-10..2026-10-10:ATH`]: { value } } });
  assert.equal(asked(answer('yes'), 'saturdays:2026-10-03'), true);
  assert.equal(asked(answer('no'), 'saturdays:'), false);
});

test('שבת אחת בלבד: השאלה לא משנה דבר, ולא נשאלת', () => {
  const m = month(2026, 10, { plan: days(['10'], sat), exec: {} });
  assert.equal(asked(run(m, { answers: { [SAT]: other() } }), COMPANY), false);
});

// ---------- טיסות סבב לילה (2024 ס' 37): הרצף שבוצע ---------

const rounds = (plan, exec) => month(2026, 10, { plan: days(plan, night), exec: days(exec, night) });
const cut = (d) => `cancelled:2026-10-${d}..2026-10-${d}:ATH`;

test('"סיבה אחרת" על לילה ברצף: שאלה', () => {
  const r = run(rounds(['05', '06', '07'], ['05', '06']), { answers: { [cut('07')]: other() } });
  assert.deepEqual(reviews(r), []);
  assert.equal(asked(r, COMPANY), true);
});

test('שלושה לילות ברצף בוצעו, והרביעי לא: הרצף שבוצע מזכה', () => {
  const r = run(rounds(['05', '06', '07', '08'], ['05', '06', '07']), { answers: { [cut('08')]: { value: 'voluntary_swap', link: 'none' } } });
  assert.deepEqual(reviews(r), []);
  assert.equal(asked(r, 'night_rounds:2026-10-05'), true);
});

test('הלילה השני לא בוצע: אין רצף של שלושה, ואין פיצוי', () => {
  const r = run(rounds(['05', '06', '07', '08'], ['05', '07', '08']), { answers: { [cut('06')]: { value: 'voluntary_swap', link: 'none' } } });
  assert.deepEqual(reviews(r), []);
  assert.equal(asked(r, 'night_rounds:'), false);
});

// ---------- רגל ב-1 לחודש ----------

const carry = () => month(2026, 8, { plan: {}, exec: { '01': [leg('LY9', 'ATH', 'LCA', '23:00', '01:00')] }, values: { '01': { Credit: '01:00' } } });
const CARRY = 'carry:2026-08-01:LY9';

test('הרומה לא מכריעה מתי הרגל המריאה: שאלה', () => {
  const r = run(carry());
  assert.deepEqual(reviews(r), []);
  const q = r.questions.find((x) => x.id === CARRY);
  assert.deepEqual(q.options.map((o) => o.value), ['here', 'prev']);
  assert.ok(q.options[1].label.includes('31/07'));
});

test('התשובה קובעת את הקרדיט, ואפשר לשנות אותה', () => {
  const m = carry();
  const credit = (value) => {
    const r = run(m, { answers: { [CARRY]: { value } } });
    assert.equal(asked(r, 'carry:'), false);
    return r.comparison.filter((c) => c.column === 'Credit').reduce((s, c) => s + c.expected, 0);
  };
  assert.equal(credit('prev'), 60);
  assert.equal(credit('here'), 120);
  assert.equal(credit('prev'), 60);
});

// ---------- יום שאף חוק לא קבע מה מגיע עליו ----------

// טיסה שנוספה בהסכמה ונחתה אחרי חצות, ביום פנוי: אף חוק לא קובע מה מגיע עליו.
const lateLeg = () => [leg('LY321', 'TLV', 'ATH', '20:00', '21:00'), leg('LY322', 'ATH', 'TLV', '22:00', '23:30', { act: 150 })];
const ADDED = { 'unplanned:2026-08-10..2026-08-10:ATH': { value: 'added' } };
const late = () => month(2026, 8, { plan: {}, exec: { 10: lateLeg() } });
const FREE = 'free_day:2026-08-11';

test('יום פנוי שנגעה בו טיסה: שאלה ולא בדיקה ידנית', () => {
  const r = run(late(), { answers: ADDED });
  assert.deepEqual(reviews(r), []);
  assert.deepEqual(r.questions.find((q) => q.id === FREE).options.map((o) => o.value), ['due', 'agreed', 'other']);
});

test('התשובה "מגיעה קריאה מיוחדת" נספרת, ו"בהסכמתי" לא', () => {
  assert.equal(expected(run(late(), { answers: { ...ADDED, [FREE]: { value: 'due' } } }), 'S/C', '11/08'), '02:30');
  const r = run(late(), { answers: { ...ADDED, [FREE]: { value: 'agreed' } } });
  assert.equal(expected(r, 'S/C', '11/08'), null);
  assert.deepEqual(reviews(r), []);
});

test('סיבה אחרת על יום כזה: הקרדיט שנבחר', () => {
  assert.ok(run(late(), { answers: { ...ADDED, [FREE]: other({ creditMin: 60 }) } }).comparison.some((c) => c.column === 'Rig' && c.expected >= 60));
});

test('שתי פעילויות נפרדות ביממה, ואחת לא מתוכננת: שאלה', () => {
  const m = month(2026, 8, { plan: {}, exec: { 10: [...turn(), leg('LY7', 'TLV', 'ATH', '23:30', '23:50')] } });
  const ids = questions(run(m));
  const answers = Object.fromEntries(ids.filter((x) => x.startsWith('unplanned:')).map((x, i) => [x, { value: i ? 'added' : 'special_call' }]));
  const r = run(m, { answers });
  assert.deepEqual(reviews(r), []);
});

// ---------- יום ברומה בלי טיסה ----------

test('"משהו אחר" על יום ברומה בלי טיסה: עם קרדיט, ובלי בדיקה ידנית', () => {
  const m = () => month(2026, 8, { plan: { 10: turn() }, exec: { 10: turn() }, values: { 11: { Credit: '01:00', TAB: '05:00' } } });
  const q = run(m()).questions.find((x) => x.id === 'report_day:2026-08-11');
  assert.ok(q.options.find((o) => o.value === 'other').needsCredit);
  const r = run(m(), { answers: { [q.id]: other({ creditMin: 60 }) } });
  assert.deepEqual(reviews(r), []);
  assert.equal(expected(r, 'Rig', '11/08'), '01:00');
});

// ---------- תשובה שצריך לענות עליה שוב ----------

const gone = () => month(2026, 8, { plan: { 10: turn() }, exec: {} });
const LCA = 'cancelled:2026-08-10..2026-08-10:LCA';

test('תשובה ישנה בלי בחירה בקרדיט: השאלה נפתחת מחדש עם הטקסט', () => {
  const r = run(gone(), { answers: { [LCA]: { value: 'other', text: 'משהו' } } });
  assert.deepEqual(reviews(r), []);
  assert.equal(r.questions.find((q) => q.id === LCA).previous.text, 'משהו');
});

test('תשובה שאינה מתאימה לצי: השאלה נפתחת מחדש', () => {
  const r = run(gone(), { answers: { [LCA]: { value: 'swap_777' } } });
  assert.deepEqual(reviews(r), []);
  assert.equal(asked(r, LCA), true);
});

// ---------- הכרעה בלי הודעה ----------

test('HOME שלא בוצע בחודש: בלי בדיקה ידנית, והשאלה על הטיסה מכריעה', () => {
  const r = run(month(2026, 8, { plan: { 10: 'HOME_RGT' }, exec: { 10: turn() } }));
  assert.deepEqual(reviews(r), []);
  assert.equal(asked(r, 'unplanned:'), true);
});

test('החלפה בטיסה בחודש אחר: הערה, בלי בדיקה ידנית', () => {
  const r = run(gone(), { answers: { [LCA]: { value: 'replaced', link: null } } });
  assert.deepEqual(reviews(r), []);
  assert.ok(notes(r).concat(r.changes.flatMap((c) => (c.notes ?? []).map((n) => n.message ?? n))).some((n) => n.includes('ההפרש לא חושב')));
});

test('טיסת ULH שבוצעה ולא תוכננה: מגיע פיצוי', () => {
  const long = () => leg('LY1', 'TLV', 'ATH', '20:00', '14:00', { dur: 1080, ac: 'B789' });
  const plan = { '05': [leg('LY3', 'TLV', 'ATH', '10:00', '12:00', { ac: 'B789' }), leg('LY4', 'ATH', 'TLV', '13:00', '15:00', { ac: 'B789' })] };
  const r = run(month(2026, 8, { plan, exec: { ...plan, 10: [long()] } }));
  assert.deepEqual(reviews(r).filter((m) => m.includes('ULH')), []);
  assert.ok((r.expectations ?? []).some((e) => e.ruleId === 'ulh_787' && e.min === 300));
});
