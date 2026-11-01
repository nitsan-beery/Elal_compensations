// יחס טיסה-שהייה בתכנון: הסכם 2014, 2018 ס' 60–62 (טיוטה 477).
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, min, hhmm } from './helpers.mjs';

const plan = { planOnly: true };
const pad = (n) => String(n).padStart(2, '0');
// סבב ליעד: יוצא ב-10:00 ביום `from`, וחוזר ב-15:00 ביום `to`. 2:00 טיסה לכל כיוון.
const trip = (from, to, ac = 'B737', extra = {}) => ({
  [pad(from)]: [leg('LY1', 'TLV', 'ATH', '10:00', '12:00', { ac })],
  [pad(to)]: [leg('LY2', 'ATH', 'TLV', '13:00', '15:00', { ac, ...extra })],
});
// `flight`: Flight time בסיכום התכנון, שאינו כולל DH.
const withFlight = (days, flight, summary = {}) => {
  const m = month(2026, 10, { plan: days });
  m.plan.summary = { ...m.plan.summary, flightTime: min(flight), ...summary };
  return m;
};
const stayOf = (r) => hhmm(r.stayRatio.stay);
const flightOf = (r) => hhmm(r.stayRatio.flight);

test('השהייה מההמראה מהבסיס עד הנחיתה בבסיס, והיחס מול שעות הטיסה', () => {
  const r = run(withFlight(trip(1, 10), '80:00'), plan);
  assert.equal(stayOf(r), '221:00');
  assert.equal(flightOf(r), '80:00');
  assert.equal(r.stayRatio.ratio.toFixed(2), '2.76');
  assert.equal(r.stayRatio.over, false);
});

test('Time away from base שבסיכום אינו נספר: הוא מוסיף זיכוי על ימי חופשה', () => {
  const m = withFlight({ ...trip(1, 10), 12: 'VAC_FLD', 13: 'VAC_FLD' }, '80:00', { timeAwayFromBase: min('250:00') });
  assert.equal(stayOf(run(m, plan)), '221:00');
});

test('DH נוסף לשעות הטיסה', () => {
  const r = run(withFlight(trip(1, 10, 'B737', { dh: true }), '80:00'), plan);
  assert.equal(flightOf(r), '82:00');
});

test('שני סבבים נספרים יחד', () => {
  assert.equal(stayOf(run(withFlight({ ...trip(1, 3), ...trip(5, 6) }, '80:00'), plan)), '82:00');
});

test('בדיוק 1:3: אין חריגה', () => {
  assert.equal(run(withFlight(trip(1, 10), '73:40'), plan).stayRatio.over, false);
});

test('מעל 1:3 ב-70 שעות ומעלה: חריגה', () => {
  const r = run(withFlight(trip(1, 10), '73:39'), plan);
  assert.equal(r.stayRatio.over, true);
  assert.equal(r.stayRatio.maxStay, null);
  assert.equal(r.stayRatio.max, 3);
});

test('70:00 בדיוק: לפי 1:3, ולא לפי 210', () => {
  const r = run(withFlight(trip(1, 10), '70:00'), plan);
  assert.equal(r.stayRatio.over, true);
  assert.equal(r.stayRatio.maxStay, null);
});

test('מתחת ל-70 שעות: יחס מעל 1:3 מותר עד 210 שעות שהייה', () => {
  const r = run(withFlight(trip(1, 9), '60:00'), plan);
  assert.equal(stayOf(r), '197:00');
  assert.equal(r.stayRatio.ratio.toFixed(2), '3.28');
  assert.equal(r.stayRatio.over, false);
  assert.equal(r.stayRatio.maxStay, min('210:00'));
});

test('מתחת ל-70 שעות: מעל 210 שעות שהייה חריגה', () => {
  assert.equal(run(withFlight(trip(1, 10), '60:00'), plan).stayRatio.over, true);
});

test('סבב עם יום הדרכה: מ-70 שעות יוצא מהחישוב, גם השהייה וגם הטיסה', () => {
  const r = run(withFlight({ ...trip(1, 4), '03': 'SIM_BER', ...trip(6, 8) }, '80:00'), plan);
  assert.equal(stayOf(r), '53:00');
  assert.equal(flightOf(r), '76:00');
});

test('סבב עם יום הדרכה: מתחת ל-70 שעות נספר, כי פקודת נסיעה נכנסת ל-210', () => {
  const r = run(withFlight({ ...trip(1, 4), '03': 'SIM_BER', ...trip(6, 8) }, '60:00'), plan);
  assert.equal(stayOf(r), '130:00');
  assert.equal(flightOf(r), '60:00');
});

test('סימולטור בארץ ביום שהסבב נחת בו: הסבב נספר', () => {
  assert.equal(stayOf(run(withFlight({ ...trip(1, 4), ...trip(6, 8), '08': [leg('LY2', 'ATH', 'TLV', '01:00', '03:00')], '09': 'SIM_SHO' }, '80:00'), plan)), '118:00');
});

test('סבב שיוצא בסוף החודש: עד גבול החודש', () => {
  const r = run(withFlight({ 31: [leg('LY1', 'TLV', 'ATH', '10:00', '12:00')] }, '80:00'), plan);
  assert.equal(stayOf(r), '14:00');
});

test('סבב שחוזר בתחילת החודש: מגבול החודש', () => {
  // הרומה קובעת את הבסיס: בלעדיה הוא נגזר מההתייצבויות (`guessDomicile`), וכאן יש רק אחת, בחו"ל.
  const days = { '01': [leg('LY2', 'ATH', 'TLV', '10:00', '12:00')] };
  const m = month(2026, 10, { plan: days, exec: days });
  m.plan.summary = { ...m.plan.summary, flightTime: min('80:00') };
  assert.equal(stayOf(run(m)), '12:00');
});

test('רחב גוף: אין משבצת', () => {
  assert.equal(run(withFlight(trip(1, 10, 'B789'), '80:00'), plan).stayRatio, null);
});

test('בלי תכנון: אין משבצת', () => {
  const m = month(2026, 10, { plan: trip(1, 10), exec: trip(1, 10) });
  assert.equal(run({ ...m, plan: null }).stayRatio, null);
});

test('בלי שעות טיסה: אין משבצת', () => {
  assert.equal(run(withFlight({ '05': 'SIM_SHO' }, '00:00'), plan).stayRatio, null);
});
