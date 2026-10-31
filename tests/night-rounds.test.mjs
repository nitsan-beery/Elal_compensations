// טיסות סבב לילה עוקבות (2024 ס' 37, 40; טיוטה 462).
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, hhmm, asked, notes } from './helpers.mjs';

const round = () => [leg('LY1', 'TLV', 'ATH', '00:10', '01:00'), leg('LY2', 'ATH', 'TLV', '01:20', '02:30')];
const other = () => [leg('LY3', 'TLV', 'ATH', '00:10', '01:00'), leg('LY4', 'ATH', 'TLV', '01:20', '02:30')];
const days = (list, f = round) => Object.fromEntries(list.map((d) => [d, f()]));
const com = (r) => r.comparison.filter((c) => c.column === 'COM').map((c) => [c.label.replace(/[⁦-⁩‏]/g, '').slice(0, 5), hhmm(c.expected ?? 0), hhmm(c.reported ?? 0)]);
const oct = (list, values = {}) => month(2026, 10, { plan: days(list), exec: days(list), values });
const cancelledSep30 = (answers) => ({ ...month(2026, 9, { plan: days(['30'], other), exec: {} }), answers });
const SEP30 = 'cancelled:2026-09-30..2026-09-30:ATH';

test('לילה בחודש הקודם שבוטל ביוזמת החברה נספר ברצף', () => {
  const prev = cancelledSep30({ [SEP30]: { value: 'replaced' } });
  assert.equal(asked(run(oct(['01', '02']), { prev }), 'night_rounds:2026-09-30'), true);
  const r = run(oct(['01', '02']), { prev, answers: { 'night_rounds:2026-09-30': { value: 'company' } } });
  assert.deepEqual(com(r), [['02/10', '02:30', '00:00']]);
});

test('לילה בחודש הקודם, "סיבה אחרת" ביוזמת החברה: נספר', () => {
  const prev = cancelledSep30({ [SEP30]: { value: 'other' }, 'other_company:2026-09-30..2026-09-30:ATH': { value: 'yes' } });
  assert.equal(asked(run(oct(['01', '02']), { prev }), 'night_rounds:2026-09-30'), true);
});

test('לילה בחודש הקודם שהוחלף מרצון אינו נספר', () => {
  const prev = cancelledSep30({ [SEP30]: { value: 'voluntary_swap' } });
  assert.equal(asked(run(oct(['01', '02']), { prev }), 'night_rounds:'), false);
});

test('הרומה זיכתה ביום אחר: אחרי התשובה הזיכוי משויך לרצף, בלי פער', () => {
  const answers = { 'night_rounds:2026-10-05': { value: 'company' } };
  const r = run(oct(['05', '06', '07'], { 20: { COM: '02:30' } }), { answers });
  assert.deepEqual(com(r), [['20/10', '02:30', '02:30']]);
  assert.ok(notes(r).some((n) => n.includes('האפליקציה מניחה שהזיכוי')));
});

test('הרומה זיכתה ביום אחר, בלי תשובה: השאלה נשארת', () => {
  assert.equal(asked(run(oct(['05', '06', '07'], { 20: { COM: '02:30' } })), 'night_rounds:2026-10-05'), true);
});

test('תכנון לבד: בלי שאלה, כמו היום', () => {
  const r = run(oct(['05', '06', '07']), { planOnly: true });
  assert.equal(asked(r, 'night_rounds:'), false);
  assert.ok((r.expectations ?? []).some((e) => e.min === 150));
});

test('ראשון, שלישי וחמישי אינן עוקבות: רק ימים קלנדריים רצופים', () => {
  const r = run(oct(['04', '06', '08']));
  assert.equal(asked(r, 'night_rounds:'), false);
  assert.deepEqual(com(r), []);
});

test('יום בלי לילה באמצע רצף: שני הצדדים נספרים בנפרד', () => {
  assert.equal(asked(run(oct(['05', '06', '08', '09'])), 'night_rounds:'), false);
  assert.equal(asked(run(oct(['05', '06', '07', '09'])), 'night_rounds:2026-10-05'), true);
});

test('ראשון, שני ושלישי עוקבות', () => {
  assert.equal(asked(run(oct(['04', '05', '06'])), 'night_rounds:2026-10-04'), true);
});

// רגל שהרומה חוזרת עליה ב-1 לחודש (`markCarryIn`).
test('אותה טיסה ב-30/09 וב-01/10, ונחתה לפני חצות: זו טיסה חדשה, לא רגל חוזרת', () => {
  const r = run(oct(['01']), { prev: month(2026, 9, { plan: days(['30']), exec: days(['30']) }) });
  assert.equal(asked(r, 'unplanned:'), false);
  assert.equal(r.comparison.find((c) => c.column === 'Credit')?.expected > 0, true);
});

test('רצף שחוצה חודש באותם מספרי טיסה: בלי שאלה על פעילות לא מתוכננת', () => {
  const r = run(oct(['01']), { prev: month(2026, 9, { plan: days(['29', '30']), exec: days(['29', '30']) }) });
  assert.equal(asked(r, 'unplanned:'), false);
  assert.equal(asked(r, 'night_rounds:2026-09-29'), true);
});

test('רגל שיצאה ב-30/09 ונחתה אחרי חצות: עדיין רגל חוזרת', () => {
  const cross = () => [leg('LY5', 'ATH', 'TLV', '23:30', '02:00')];
  const out = [leg('LY6', 'TLV', 'ATH', '10:00', '12:00')];
  const prev = month(2026, 9, { plan: { 29: out, 30: cross() }, exec: { 29: out, 30: cross() } });
  const r = run(month(2026, 10, { plan: {}, exec: { '01': cross() }, values: { '01': { Credit: '02:00' } } }), { prev });
  assert.equal(asked(r, 'unplanned:'), false);
});
