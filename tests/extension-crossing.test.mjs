// סבב שתוכנן לחזור בחודש אחד וחזר בחודש הבא: הארכה אחת, בשני החודשים (טיוטה 455).
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, expected, asked, reviews, notes } from './helpers.mjs';

const clean = (s) => s.replace(/[⁦-⁩‏]/g, '');
const out = () => leg('LY321', 'TLV', 'ATH', '10:00', '13:00');
const back = () => leg('LY322', 'ATH', 'TLV', '09:00', '12:00');
const TAB = (d) => ({ [d]: { TAB: '12:00' } });
// תוכנן לחזור ב-30/08, חזר ב-02/09.
const aug = (values = {}) => month(2026, 8, { plan: { 29: [out()], 30: [back()] }, exec: { 29: [out()] }, values });
const sep = (values = {}) => month(2026, 9, { plan: {}, exec: { '02': [back()] }, values: { ...TAB('02'), ...values } });
const AUG = 'extended:2026-08-29..2026-08-29:ATH';
const SEP = 'extended:2026-09-02..2026-09-02:ATH';
const UNPLANNED = 'unplanned:';
const options = (r, id) => r.questions.find((q) => q.id === id).options.map((o) => o.value);
const sc = (r) => r.comparison.filter((c) => c.column === 'S/C' && c.expected).map((c) => clean(c.label).slice(0, 5));
const withAnswers = (m, answers) => Object.assign(m, { answers });

test('אוגוסט בלי ספטמבר: שורה "הסבב התארך" ושאלה רגילה', () => {
  const r = run(aug());
  assert.equal(asked(r, 'free_day:'), false);
  assert.equal(r.changes.find((c) => c.how === 'extended')?.label, 'הסבב התארך');
  assert.deepEqual(options(r, AUG), ['company', 'agreed']);
});

test('אוגוסט עם ספטמבר: שעת החזרה ידועה, ומעל 48 שעות אפשרות שלישית', () => {
  const r = run(aug(), { next: sep() });
  assert.deepEqual(options(r, AUG), ['company', 'agreed', 'force_majeure']);
  assert.ok(clean(r.questions.find((q) => q.id === AUG).body).includes('החזרה לבסיס ב-02/09 12:00'));
});

test('אוגוסט: קריאה מיוחדת על ימי אוגוסט בלבד', () => {
  assert.deepEqual(sc(run(aug(), { next: sep(), answers: { [AUG]: { value: 'company' } } })), ['31/08']);
});

test('ספטמבר עם אוגוסט שענה: התשובה חלה, בלי שאלה נוספת', () => {
  const r = run(sep(), { prev: withAnswers(aug(), { [AUG]: { value: 'company', label: 'הסבב הוארך ביוזמת החברה' } }) });
  assert.equal(asked(r, 'extended:'), false);
  assert.equal(asked(r, UNPLANNED), false);
  assert.deepEqual(sc(r), ['01/09', '02/09']);
  assert.ok(r.assumptions.some((a) => a.id === SEP));
});

test('ספטמבר עם אוגוסט: בהסכמה – בלי פיצוי, ובלי שאלה על היום', () => {
  const r = run(sep(), { prev: withAnswers(aug(), { [AUG]: { value: 'agreed', label: 'הסבב הוארך בהסכמתי' } }) });
  assert.deepEqual(sc(r), []);
  assert.deepEqual(r.questions.filter((q) => /free_day|second_day|unplanned|extended/.test(q.id)), []);
  assert.deepEqual(reviews(r), []);
});

test('ספטמבר עם אוגוסט שלא ענה: השאלה על ההארכה, ולא על פעילות לא מתוכננת', () => {
  const r = run(sep(), { prev: aug() });
  assert.equal(asked(r, UNPLANNED), false);
  assert.deepEqual(options(r, SEP), ['company', 'agreed', 'force_majeure']);
});

test('אוגוסט קורא תשובה שניתנה בספטמבר', () => {
  const r = run(aug(), { next: withAnswers(sep(), { [SEP]: { value: 'company', label: 'הסבב הוארך ביוזמת החברה' } }) });
  assert.equal(asked(r, 'extended:'), false);
  assert.deepEqual(sc(r), ['31/08']);
});

test('ספטמבר בלי אוגוסט: כמו היום', () => {
  assert.equal(asked(run(sep()), UNPLANNED), true);
});

test('אירוע שלא בשליטת החברה: שתי היממות ויום החזרה, כל אחד בחודש שלו', () => {
  const a = { [AUG]: { value: 'force_majeure', label: 'אירוע שלא בשליטת החברה' } };
  assert.deepEqual(sc(run(aug(), { next: sep(), answers: a })), ['31/08']);
  assert.deepEqual(sc(run(sep(), { prev: withAnswers(aug(), a) })), ['01/09', '02/09']);
  assert.ok(notes(run(sep(), { prev: withAnswers(aug(), a) })).some((n) => n.includes('אש"ל לכל התקופה')));
});

test('הארכה של יום: באוגוסט אין ימים נוספים, והשאלה בספטמבר על ההארכה', () => {
  const a = month(2026, 8, { plan: { 30: [out()], 31: [back()] }, exec: { 30: [out()] } });
  const b = month(2026, 9, { plan: {}, exec: { '01': [back()] }, values: TAB('01') });
  assert.deepEqual(run(a).questions.filter((q) => /extended|free_day/.test(q.id)), []);
  assert.equal(run(a).changes.find((c) => c.how === 'extended')?.label, 'הסבב התארך');
  const r = run(b, { prev: a });
  assert.equal(asked(r, UNPLANNED), false);
  assert.equal(asked(r, 'extended:2026-09-01..2026-09-01:ATH'), true);
});

test('תשובה קיימת על "פעילות לא מתוכננת" בספטמבר נשארת', () => {
  const r = run(sep(), { prev: aug(), answers: { 'unplanned:2026-09-02..2026-09-02:ATH': { value: 'special_call' } } });
  assert.equal(asked(r, 'extended:'), false);
  assert.ok(sc(r).includes('02/09'));
});

test('הרומה זיכתה את ימי אוגוסט: מונח ביוזמת החברה', () => {
  const r = run(aug({ 31: { 'S/C': '02:30' } }));
  assert.equal(asked(r, 'extended:'), false);
  assert.deepEqual(sc(r), ['31/08']);
});

test('סבב שהתכנון שלו חוצה גם הוא: כמו קודם', () => {
  const a = month(2026, 8, { plan: { 31: [out()] }, exec: { 31: [out()] } });
  const b = month(2026, 9, { plan: { '01': [back()] }, exec: { '04': [back()] }, values: TAB('04') });
  assert.equal(asked(run(a), 'extended:'), false);
  assert.equal(asked(run(b, { prev: a }), 'extended:2026-09-04..2026-09-04:ATH'), true);
});

// ---------- הפעלה מכוננות שנמשכת לחודש הבא ----------

const sby = (list) => Object.fromEntries(list.map((d) => [d, 'SBY_S']));
const stay = (d) => ({ [d]: { TAB: '24:00' } });
const a3 = (days = ['28', '29']) => month(2026, 8, { plan: sby(days), exec: { 28: [out()] }, values: { ...stay(29), ...stay(30), ...stay(31) } });
const b3 = () => month(2026, 9, { plan: {}, exec: { '02': [back()] }, values: { ...TAB('02'), ...stay('01') } });

test('ימי הכוננות בזמן השהייה נכנסים להשוואה', () => {
  // 28–31/08: ארבעה ימי כוננות, 17:00, מול LY321 ‏03:00.
  const r = run(a3(['28', '29', '30', '31']), { next: b3(), answers: {} });
  assert.equal(expected(r, 'Rig', 'ATH'), '14:00');
});

test('חזרה בחודש הבא: קריאה מיוחדת על הימים הפנויים אחרי הכוננות, בשני החודשים', () => {
  const answers = { 'standby_bid:2026-08-28..2026-08-28:ATH': { value: 'standby_activated', label: 'הפעלת הכוננות' } };
  assert.deepEqual(sc(run(a3(), { next: b3(), answers })), ['30/08', '31/08']);
  const r = run(b3(), { prev: withAnswers(a3(), answers) });
  assert.equal(asked(r, UNPLANNED), false);
  assert.deepEqual(sc(r), ['01/09', '02/09']);
});

test('ספטמבר עם הפעלה מכוננות בלי תשובה בחודש הקודם: קריאה מיוחדת, כי ההפעלה ידועה', () => {
  const m = month(2026, 8, { plan: sby(['28', '29', '30', '31']), exec: { 28: [out()] }, values: { ...stay(29), ...stay(30), ...stay(31) } });
  const r = run(b3(), { prev: m });
  assert.equal(asked(r, UNPLANNED), false);
  assert.deepEqual(sc(r), ['01/09', '02/09']);
});
