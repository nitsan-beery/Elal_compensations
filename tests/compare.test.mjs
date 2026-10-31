// ההשוואה מול הרומה: קודי הפיצוי, הסיכום מול הימים, ושורה שממתינה לתשובה (טיוטה 469).
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, row, reviews } from './helpers.mjs';
import { addComParts, isUnknownColumn } from '../js/pdf/exec.js';

const turn = () => [leg('LY1', 'TLV', 'LCA', '10:00', '11:00'), leg('LY2', 'LCA', 'TLV', '12:00', '13:00')];
const duration = (min) => ({ kind: 'duration', min, raw: '' });
const CODES = ['HPZ', 'HPM', 'HPS', 'HHT', 'HAM', 'HTF', 'BSP', 'CRN', 'BMB', 'HNB', 'HBT', 'HHM', 'HBH'];
const simple = () => month(2026, 8, { plan: { 10: turn() }, exec: { 10: turn() } });
const totalsReviews = (r) => reviews(r).filter((x) => /ברומה|הרומה/.test(x));

for (const code of CODES) {
  test(`${code} נכנס ל-COM של היום`, () => {
    const values = { COM: duration(120), [code]: duration(30) };
    addComParts(values);
    assert.equal(values.COM.min, 150);
    assert.equal(values[code], undefined);
    assert.equal(isUnknownColumn(code), false);
  });
}

test('קוד פיצוי בלי COM באותו יום', () => {
  const values = { HPS: duration(150) };
  addComParts(values);
  assert.equal(values.COM.min, 150);
});

test('עמודה שאינה ברשימה נשארת לא מוכרת', () => {
  assert.equal(isUnknownColumn('XYZ'), true);
});

test('סיכום שתואם לימים: בלי הודעה', () => {
  assert.deepEqual(totalsReviews(run(simple())), []);
});

test('סיכום גבוה מהימים: הודעה לניצן, והפער בסיכום נשאר', () => {
  const m = simple();
  Object.assign(m.exec.totals, { COM: 150, 'S/C': 0 });
  const r = run(m);
  assert.deepEqual(totalsReviews(r), ['סיכום הרומה ב-COM גבוה ב-02:30 מסכום הימים בה.']);
  assert.equal(r.totals.find((t) => t.column === 'COM').reported, 150);
});

test('סיכום נמוך מהימים', () => {
  const m = simple();
  m.exec.totals.Credit -= 30;
  assert.deepEqual(totalsReviews(run(m)), ['סיכום הרומה ב-Credit נמוך ב-00:30 מסכום הימים בה.']);
});

test('CRTOT ו-COMTOT מול שורת הסיכום', () => {
  const m = month(2026, 8, { plan: { 10: turn() }, exec: { 10: turn() }, values: { 10: { Rig: '03:00', COM: '00:30', 'S/C': '02:30' } } });
  m.exec.reportTotals = { CRTOT: '05:00', COMTOT: '03:00' };
  assert.deepEqual(totalsReviews(run(m)), []);
  m.exec.reportTotals = { CRTOT: '06:00', COMTOT: '02:00' };
  assert.deepEqual(totalsReviews(run(m)), ['CRTOT ברומה גבוה ב-01:00 מ-Credit + Rig.', 'COMTOT ברומה נמוך ב-01:00 מ-COM + S/C.']);
});

test('רומה בלי שורת סיכום: בלי הודעה', () => {
  const m = simple();
  m.exec.totals = {};
  assert.deepEqual(totalsReviews(run(m)), []);
});

const stay = { 10: [leg('LY3', 'TLV', 'ATH', '10:00', '12:00')], 11: [leg('LY4', 'ATH', 'TLV', '12:00', '14:00')] };
const ID = 'cancelled:2026-08-10..2026-08-11:ATH';
const open = (values) => month(2026, 8, { plan: { ...stay, 20: turn() }, exec: { 20: turn() }, values: { 20: { Rig: '03:00', ...values } } });

test('הרומה זיכתה יותר מהצפוי ויש שאלה על יום אחר: ממתין', () => {
  const c = row(run(open({ COM: '02:30' })), 'COM', '20/08');
  assert.equal(c.pending, true);
  assert.equal(c.ok, null);
  assert.equal(c.notes, undefined);
});

test('אחרי התשובה זה פער, עם ההסבר', () => {
  const c = row(run(open({ COM: '02:30' }), { answers: { [ID]: { value: 'cancelled' } } }), 'COM', '20/08');
  assert.equal(c.pending, false);
  assert.equal(c.ok, false);
  assert.ok(c.notes[0].includes('02:30'));
});

test('הרומה זיכתה פחות מהצפוי ושאלה על יום אחר: נשאר פער', () => {
  const c = row(run(open({ Rig: '01:00' })), 'Rig', '20/08');
  assert.equal(c.pending, false);
  assert.equal(c.ok, false);
});
