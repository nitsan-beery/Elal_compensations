// סבבים שחוצים חודש: קיצור מנוחה, השלמה ל-5 שעות, קריאה מיוחדת, נחיתה מאוחרת, ושינויים בתכנון.
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, expected, row, notes, asked, explains, reviews, rulesData } from './helpers.mjs';

// סבב ATH (שעון הבסיס), 31/03–01/04/2026.
const out = (dst = 'ATH') => leg('LY321', 'TLV', dst, '10:00', '13:00');
const back = (org = 'ATH') => leg('LY322', org, 'TLV', '09:00', '12:00');
const mar = (dst = 'ATH', { com = null, planned = true } = {}) => month(2026, 3, { plan: planned ? { 31: [out(dst)] } : {}, exec: { 31: [out(dst)] }, values: com ? { 31: { COM: com } } : {} });
const apr = (org = 'ATH', { com = null, planned = true } = {}) => month(2026, 4, { plan: planned ? { '01': [back(org)] } : {}, exec: { '01': [back(org)] }, values: com ? { '01': { COM: com } } : {} });

// ---------- קיצור מנוחה (טיוטות 426, 435) ----------

for (const [st, id] of [['JFK', 'new_york_rest:'], ['EWR', 'new_york_rest:'], ['LAS', 'las_vegas_rest:']]) {
  test(`קיצור מנוחה ב-${st} שחוצה חודש נשאל בחודש החזרה`, () => {
    assert.equal(asked(run(mar(st)), id), false);
    assert.equal(asked(run(apr(st), { prev: mar(st) }), id), true);
  });
  test(`${st}, הרומה זיכתה בחודש החזרה: בלי שאלה ובלי פער`, () => {
    const r = run(apr(st, { com: '05:00' }), { prev: mar(st) });
    assert.equal(asked(r, id), false);
    assert.equal(expected(r, 'COM', 'TLV'), '05:00');
  });
  test(`${st}, הפיצוי רשום בחודש הקודם: הערה בחודש החזרה, והנחה בחודש ההמראה`, () => {
    const paid = mar(st, { com: '05:00' });
    const r = run(apr(st), { prev: paid });
    assert.equal(asked(r, id), false);
    assert.equal(expected(r, 'COM', 'TLV'), null);
    assert.ok(notes(r).some((n) => n.includes('הפיצוי רשום ברומה של החודש הקודם')));
    const m = run(paid);
    assert.equal(expected(m, 'COM', st), '05:00');
    assert.ok(explains(row(m, 'COM', st)).includes('שלא ניתן לבדוק כיוון שהטיסה חוזרת בחודש הבא'));
  });
  test(`${st} בלי החודש הקודם: שאלה, עם שם היעד ולא קוד השדה`, () => {
    const r = run(apr(st));
    const q = r.questions.find((x) => x.id.startsWith(id));
    assert.ok(q.body.includes(st === 'LAS' ? 'הנחיתה בלאס וגאס הייתה בחודש הקודם' : 'הנחיתה בניו יורק הייתה בחודש הקודם'));
    assert.ok(!q.body.includes(st));
  });
}

test('בחודש ההמראה, סכום שאינו של קיצור המנוחה נשאר לא מוסבר', () => {
  const r = run(mar('JFK', { com: '02:30' }));
  assert.equal(expected(r, 'COM', 'JFK'), '00:00');
});

test('יעד אחר אינו קיצור מנוחה', () => {
  assert.equal(expected(run(mar('ATH', { com: '05:00' })), 'COM', 'ATH'), '00:00');
});

test('נחיתה ב-JFK והמראה מ-EWR נבדקת כמו שהייה באותו שדה, גם בתוך חודש', () => {
  const pair = [leg('LY1', 'TLV', 'JFK', '10:00', '15:00', { dur: 720 }), leg('LY2', 'EWR', 'TLV', '10:00', '04:00', { dur: 660 })];
  const m = month(2026, 8, { plan: { 10: [pair[0]], 11: [pair[1]] }, exec: { 10: [pair[0]], 11: [pair[1]] } });
  assert.equal(asked(run(m), 'new_york_rest:'), true);
});

// ---------- רגל שהרומה חוזרת עליה (טיוטות 426, 429) ----------

test('ULH נבדק בחודש ההמראה בלבד', () => {
  const long = leg('LY1', 'TLV', 'ATH', '20:00', '14:00', { dur: 1080 });
  const a = month(2026, 5, { plan: { 31: [long] }, exec: { 31: [long] } });
  const b = month(2026, 6, { plan: {}, exec: { '01': [long] }, values: { '01': { TAB: '24:00' } } });
  assert.deepEqual(reviews(run(b, { prev: a })).filter((m) => m.includes('ULH')), []);
});

const lateOut = leg('LY373', 'TLV', 'ATH', '14:00', '20:00');
const lateBack = (delay) => leg('LY374', 'ATH', 'TLV', '21:00', '03:00', { dur: 360, ata: delay });
const lateSep = (delay, com) => month(2026, 9, { plan: { 30: [lateOut, lateBack()] }, exec: { 30: [lateOut, lateBack(delay)] }, values: { 30: { Credit: '09:00', ...(com ? { COM: com } : {}) } } });
const lateOct = (delay, com) => month(2026, 10, { plan: { '01': 'X' }, exec: { '01': [lateBack(delay)] }, values: { '01': { Credit: '03:00', TAB: '03:00', ...(com ? { COM: com } : {}) } } });

test('נחיתה מאוחרת של רגל שחוצה חודש: רק בחודש ההמראה', () => {
  const a = lateSep('04:35', '00:30');
  assert.equal(expected(run(a), 'COM', 'TLV-ATH-TLV'), '00:30');
  assert.equal(expected(run(lateOct('04:35'), { prev: a }), 'COM', 'ATH-TLV'), null);
});

test('נחיתה מאוחרת שהרומה רשמה ב-1 לחודש, בדיוק בסכום: מוסברת', () => {
  assert.equal(expected(run(lateOct('04:35', '00:30'), { prev: lateSep('04:35') }), 'COM', 'ATH-TLV'), '00:30');
});

test('איחור שאינו מזכה: הערה רק בחודש ההמראה', () => {
  const has = (r) => notes(r).some((n) => n.includes('נחתה באיחור של 45 דק'));
  assert.equal(has(run(lateSep('03:45'))), true);
  assert.equal(has(run(lateOct('03:45'), { prev: lateSep('03:45') })), false);
});

// ---------- השלמה ל-5 שעות (טיוטה 427) ----------

const shortOut = leg('LY1', 'TLV', 'ATH', '10:00', '11:30');
const shortBack = leg('LY2', 'ATH', 'TLV', '09:00', '10:30');
const sMar = (rig) => month(2026, 3, { plan: { 31: [shortOut] }, exec: { 31: [shortOut] }, values: rig ? { 31: { Rig: rig } } : {} });
const sApr = (rig) => month(2026, 4, { plan: { '01': [shortBack] }, exec: { '01': [shortBack] }, values: rig ? { '01': { Rig: rig } } : {} });

test('סבב קצר שחוצה חודש: השלמה בחודש החזרה, על הסבב כולו', () => {
  assert.equal(expected(run(sApr(), { prev: sMar() }), 'Rig', 'ATH-TLV'), '02:00');
  assert.equal(expected(run(sMar()), 'Rig', 'TLV-ATH'), null);
});

test('ההשלמה רשומה בחודש הקודם: בלי צפי, והערה', () => {
  const r = run(sApr(), { prev: sMar('02:00') });
  assert.equal(expected(r, 'Rig', 'ATH-TLV'), null);
  assert.ok(notes(r).some((n) => n.includes('ההשלמה ל-5 שעות רשומה ברומה של החודש הקודם')));
});

test('בלי החודש הקודם: Rig שמשלים עד 5 שעות מוסבר, ו-Rig גדול יותר לא', () => {
  const ok = run(sApr('03:30'));
  assert.equal(expected(ok, 'Rig', 'ATH-TLV'), '03:30');
  assert.ok(explains(row(ok, 'Rig', 'ATH-TLV')).includes('על סבב שהתחיל בחודש הקודם'));
  assert.equal(expected(run(sApr('04:00')), 'Rig', 'ATH-TLV'), '00:00');
  assert.equal(expected(run(sApr()), 'Rig', 'ATH-TLV'), null);
});

test('סבב מעל 5 שעות שחוצה חודש: בלי השלמה', () => {
  assert.equal(expected(run(apr(), { prev: mar() }), 'Rig', 'ATH-TLV'), null);
});

// ---------- קריאה מיוחדת (טיוטה 428) ----------

const callOut = leg('LY373', 'TLV', 'ATH', '14:00', '20:00');
const callBack = (sta) => leg('LY374', 'ATH', 'TLV', '21:00', sta, { dur: sta === '04:59' ? 479 : 389 });
const callSep = (sta) => month(2026, 9, { plan: {}, exec: { 30: [callOut, callBack(sta)] }, values: { 30: { Credit: '09:00', 'S/C': '02:30' } } });
const callOct = (sta, sc) => month(2026, 10, { plan: { '01': 'X' }, exec: { '01': [callBack(sta)] }, values: { '01': { Credit: '02:00', TAB: sta, ...(sc ? { 'S/C': sc } : {}) } } });

test('היממה האחרונה בחודש החזרה: 4 שעות ומעלה, והרומה זיכתה – בלי פער', () => {
  assert.equal(expected(run(callOct('04:59', '02:30'), { prev: callSep('04:59') }), 'S/C', '01/10'), '02:30');
});

test('היממה האחרונה בחודש החזרה: 4 שעות ומעלה, והרומה לא זיכתה – פער', () => {
  assert.equal(expected(run(callOct('04:59'), { prev: callSep('04:59') }), 'S/C', '01/10'), '02:30');
});

test('היממה האחרונה בחודש החזרה: פחות מ-4 שעות – בלי צפי', () => {
  assert.equal(expected(run(callOct('03:29'), { prev: callSep('03:29') }), 'S/C', '01/10'), null);
});

test('בלי הרומה הקודמת: S/C ב-1 לחודש מכריע', () => {
  assert.equal(expected(run(callOct('04:59', '02:30')), 'S/C', '01/10'), '02:30');
  assert.equal(expected(run(callOct('04:59')), 'S/C', '01/10'), null);
});

// ---------- סבב מתוכנן ששונה (טיוטה 433) ----------

const swapOct = () => month(2026, 9, { plan: { '01': [leg('LY540', 'ATH', 'TLV', '02:00', '04:00')] }, exec: {} });
const swapAug = (answers) => ({ ...month(2026, 8, { plan: { 31: [leg('LY549', 'TLV', 'ATH', '22:00', '00:00', { dur: 120 })] }, exec: { 31: [leg('LY353', 'TLV', 'LCA', '10:00', '11:00'), leg('LY354', 'LCA', 'TLV', '12:00', '13:00')] } }), answers });
const idPrev = 'cancelled:2026-08-31..2026-08-31:ATH';
const idHere = 'cancelled:2026-09-01..2026-09-01:ATH';

test('התשובה על הסבב בחודש הקודם חלה על החלק בחודש הזה, בלי שאלה ובלי בדיקה ידנית', () => {
  const r = run(swapOct(), { prev: swapAug({ [idPrev]: { value: 'replaced', label: 'שינוי ביוזמת החברה', link: null } }) });
  assert.equal(asked(r, idHere), false);
  assert.deepEqual(reviews(r).filter((m) => m.includes('LY540')), []);
  assert.ok((r.assumptions ?? []).some((a) => a.id === idHere));
});

test('בלי תשובה בחודש הקודם, או עם "סיבה אחרת": השאלה נשארת', () => {
  assert.equal(asked(run(swapOct(), { prev: swapAug({}) }), idHere), true);
  assert.equal(asked(run(swapOct(), { prev: swapAug({ [idPrev]: { value: 'other', text: 'x' } }) }), idHere), true);
});

test('ביטול ההנחה מחזיר את השאלה', () => {
  const r = run(swapOct(), { prev: swapAug({ [idPrev]: { value: 'replaced' } }), assumedIgnored: [idHere] });
  assert.equal(asked(r, idHere), true);
});

test('הגבוה מבין השתיים על סבב שחוזר בחודש הבא: הערה שההשוואה על החלק שבחודש', () => {
  const planned = leg('LY1', 'TLV', 'ATH', '19:00', '23:00');
  const flown = [leg('LY5', 'TLV', 'LCA', '10:00', '11:00'), leg('LY6', 'LCA', 'TLV', '12:00', '13:00')];
  const m = month(2026, 4, { plan: { 30: [planned] }, exec: { 30: flown } });
  const id = 'cancelled:2026-04-30..2026-04-30:ATH';
  const r = run(m, { answers: { [id]: { value: 'replaced', link: '2026-04-30..2026-04-30:LCA' } } });
  const c = (r.changes ?? []).find((x) => x.planId === '2026-04-30..2026-04-30:ATH');
  assert.ok(JSON.stringify(c.notes).includes('ההשוואה היא רק לחלק שבחודש הזה'));
});

test('סבב שהתארך בחודש החזרה, ליום פנוי: שאלה, ולא בדיקה ידנית', () => {
  const p = month(2026, 4, { plan: { '01': [back()] }, exec: { '02': [back()] }, values: { '01': { TAB: '24:00' } } });
  const r = run(p, { prev: mar() });
  assert.equal(asked(r, 'extended:'), true);
  assert.deepEqual(reviews(r).filter((m) => m.includes('LY322')), []);
  assert.ok(rulesData.rules.length);
});
