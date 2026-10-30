// בדיקות על החודש: שבתות ברצף, טיסות סבב לילה, ימים ללא פעילות.
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, asked, notes, rulesData } from './helpers.mjs';

// סבב אתונה בשבת בבוקר. שבתות אוקטובר 2026: 03, 10, 17. ספטמבר: 26.
const sat = () => [leg('LY1', 'TLV', 'ATH', '10:00', '12:00'), leg('LY2', 'ATH', 'TLV', '13:00', '15:00')];
const pair = (o) => month(2026, 10, o);
const twoSat = (plan, exec, extra = {}) => pair({ plan: Object.fromEntries(plan.map((d) => [d, sat()])), exec: Object.fromEntries(exec.map((d) => [d, sat()])), ...extra });

test('שתי שבתות שתוכננו ובוצעו נשאלות', () => {
  assert.equal(asked(run(twoSat(['03', '10'], ['03', '10'])), 'saturdays:2026-10-03'), true);
});

test('שבת שלא תוכננה אינה נספרת, גם כשבוצעה (ס\' 34)', () => {
  assert.equal(asked(run(twoSat(['03'], ['03', '10'])), 'saturdays:'), false);
  assert.equal(asked(run(twoSat([], ['03', '10'])), 'saturdays:'), false);
});

test('שבת מתוכננת שבוטלה ביוזמת החברה נספרת (ס\' 40), ובהחלפה מרצוני לא', () => {
  const m = twoSat(['03', '10'], ['03']);
  const id = 'cancelled:2026-10-10..2026-10-10:ATH';
  assert.equal(asked(run(m, { answers: { [id]: { value: 'cancelled' } } }), 'saturdays:2026-10-03'), true);
  assert.equal(asked(run(m, { answers: { [id]: { value: 'voluntary_swap', link: 'none' } } }), 'saturdays:'), false);
});

test('זכייה במכרז בלי טיסה בשבת אינה נספרת (ס\' 40)', () => {
  const m = twoSat(['03', '10'], ['03']);
  assert.equal(asked(run(m, { answers: { 'cancelled:2026-10-10..2026-10-10:ATH': { value: 'bid', link: 'none' } } }), 'saturdays:'), false);
});

test('בתכנון לבד השבתות נשאלות לפי התכנון', () => {
  assert.equal(asked(run(twoSat(['03', '10'], []), { planOnly: true }), 'saturdays:2026-10-03'), true);
});

const sep = (o) => month(2026, 9, o);

test('זוג שחוצה חודש: שתי השבתות תוכננו ובוצעו', () => {
  const prev = sep({ plan: { 26: sat() }, exec: { 26: sat() } });
  assert.equal(asked(run(twoSat(['03'], ['03']), { prev }), 'saturdays:2026-09-26'), true);
});

test('זוג שחוצה חודש: השבת הקודמת בוצעה ולא תוכננה', () => {
  const prev = sep({ plan: {}, exec: { 26: sat() } });
  assert.equal(asked(run(twoSat(['03'], ['03']), { prev }), 'saturdays:'), false);
});

test('זוג שחוצה חודש: ביטול בחודש הקודם, לפי התשובה שם', () => {
  const id = 'cancelled:2026-09-26..2026-09-26:ATH';
  const base = sep({ plan: { 26: sat() }, exec: {} });
  assert.equal(asked(run(twoSat(['03'], ['03']), { prev: { ...base, answers: { [id]: { value: 'replaced' } } } }), 'saturdays:2026-09-26'), true);
  assert.equal(asked(run(twoSat(['03'], ['03']), { prev: { ...base, answers: { [id]: { value: 'voluntary_swap' } } } }), 'saturdays:'), false);
});

test('בלי רומה קודמת: לפי התכנון הקודם. בלי חודש קודם: בלי בדיקה', () => {
  const prev = { ...sep({ plan: { 26: sat() } }), exec: null };
  assert.equal(asked(run(twoSat(['03'], ['03']), { prev }), 'saturdays:2026-09-26'), true);
  assert.equal(asked(run(twoSat(['03'], ['03'])), 'saturdays:'), false);
});

test('סבב ארוך שחוצה חודש אינו הופך כל שבת לפעילה', () => {
  const out = leg('LY1', 'TLV', 'ATH', '10:00', '12:00');
  const backLeg = leg('LY2', 'ATH', 'TLV', '10:00', '12:00');
  const prev = sep({ plan: { 26: sat(), 30: [out] }, exec: { 26: sat(), 30: [out] } });
  const m = month(2026, 10, { plan: { '02': [backLeg] }, exec: { '02': [backLeg] } });
  assert.deepEqual(run(m, { prev }).questions.filter((q) => q.id.startsWith('saturdays:')).map((q) => q.id), []);
});

// טיסות סבב לילה (ס' 37): הרצף נספר גם כשהוא חוצה חודשים.
const round = () => [leg('LY1', 'TLV', 'ATH', '01:00', '03:00'), leg('LY2', 'ATH', 'TLV', '03:40', '05:40')];
const nights = (m, days) => month(2026, m, { plan: Object.fromEntries(days.map((d) => [d, round()])), exec: Object.fromEntries(days.map((d) => [d, round()])) });

test('שלוש טיסות סבב לילה עוקבות בתוך חודש', () => {
  assert.equal(asked(run(nights(10, ['05', '06', '07'])), 'night_rounds:2026-10-05'), true);
});

test('רצף שחוצה חודש, הלילה השלישי בחודש הזה (ס\' 37)', () => {
  assert.equal(asked(run(nights(10, ['01', '02']), { prev: nights(9, ['30']) }), 'night_rounds:2026-09-30'), true);
  assert.equal(asked(run(nights(10, ['01']), { prev: nights(9, ['29', '30']) }), 'night_rounds:2026-09-29'), true);
});

test('רצף שהלילה השלישי שלו בחודש הקודם: נבדק שם בלבד', () => {
  assert.equal(asked(run(nights(10, ['01']), { prev: nights(9, ['28', '29', '30']) }), 'night_rounds:'), false);
});

test('לילה בחודש הקודם שתוכנן ולא בוצע שובר את הרצף', () => {
  const prev = month(2026, 9, { plan: { 30: round() }, exec: {} });
  assert.equal(asked(run(nights(10, ['01', '02']), { prev }), 'night_rounds:'), false);
});

test('בלי החודש הקודם אין רצף', () => {
  assert.equal(asked(run(nights(10, ['01', '02'])), 'night_rounds:'), false);
});

// ימים ללא פעילות: X ב-1 לחודש (טיוטה 432). מינימום גבוה, כדי שהיום יקבע.
const strict = (days) => {
  const c = structuredClone(rulesData);
  const r = c.rules.find((x) => x.logic?.id === 'free_days_waived');
  for (const k of Object.keys(r.logic.params.min_free_days)) r.logic.params.min_free_days[k] = r.logic.params.min_free_days[k].map((x) => ({ ...x, days }));
  return c;
};
const busy = (from = 2, to = 30) => Object.fromEntries(Array.from({ length: to - from + 1 }, (_, i) => [String(from + i).padStart(2, '0'), 'HOME_RGT']));
// טיסה אחת לפחות: מהרגליים האפליקציה לומדת את הבסיס ואת הצי.
const onlyX = () => month(2026, 10, { plan: { '01': 'X', ...busy(2, 14), 15: sat(), ...busy(16, 30) } });
const freeOf = (r) => r.freeDays?.dates ?? [];

test('X ב-1 לחודש בתכנון לבד, בלי החודש הקודם: אינו נספר, ושאלה רק כשזה משנה', () => {
  assert.equal(freeOf(run(onlyX(), { planOnly: true })).includes('2026-10-01'), false);
  assert.equal(asked(run(onlyX(), { planOnly: true, rules: strict(2) }), 'free_days_first:'), true);
});

test('X ב-1 לחודש בתכנון לבד, הרומה הקודמת בלי סבב פתוח: נספר, בלי שאלה', () => {
  const prev = month(2026, 9, { plan: { 10: round() }, exec: { 10: round() } });
  const r = run(onlyX(), { planOnly: true, prev, rules: strict(2) });
  assert.equal(freeOf(r).includes('2026-10-01'), true);
  assert.equal(asked(r, 'free_days_first:'), false);
});

test('X ב-1 לחודש בתכנון לבד, הרומה הקודמת מראה נחיתה אחרי 01:00: אינו נספר, הערה', () => {
  const late = [leg('LY1', 'TLV', 'ATH', '20:00', '22:00'), leg('LY2', 'ATH', 'TLV', '23:00', '03:00', { dur: 240 })];
  const prev = month(2026, 9, { plan: { 30: late }, exec: { 30: late } });
  const r = run(onlyX(), { planOnly: true, prev, rules: strict(2) });
  assert.equal(freeOf(r).includes('2026-10-01'), false);
  assert.equal(asked(r, 'free_days_first:'), false);
  assert.ok(notes(r).some((n) => n.includes('מסומן X')));
});

test('X ב-1 לחודש, תכנון קודם בלבד: השאלה נשארת', () => {
  const prev = { ...month(2026, 9, { plan: { 10: round() } }), exec: null };
  assert.equal(asked(run(onlyX(), { planOnly: true, prev, rules: strict(2) }), 'free_days_first:'), true);
});
