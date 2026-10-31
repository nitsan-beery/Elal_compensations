// פעילות שנייה (2024 ס' 42.6–42.7), מנוחה לא חוקית, ושעות הסימולטור ברומה (טיוטה 457).
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, expected, explains, row, asked, notes } from './helpers.mjs';

const clean = (s) => s.replace(/[⁦-⁩‏]/g, '');
const am = () => [leg('LY541', 'TLV', 'LCA', '08:00', '09:10'), leg('LY542', 'LCA', 'TLV', '10:10', '11:15')];
const pm = (s, e, s2, e2) => [leg('LY1', 'TLV', 'ATH', s, e), leg('LY2', 'ATH', 'TLV', s2, e2)];
const U = { 'unplanned:2026-08-10..2026-08-10:ATH': { value: 'special_call' } };
const legal = (r) => (r.legal?.violations ?? []).map((v) => clean(v.message)).join(' ');
const ILLEGAL = 'שתי פעילויות עם מנוחה לא חוקית ביניהן.';
const day = (later, values = {}) => month(2026, 8, { plan: { 10: am() }, exec: { 10: [...am(), ...later] }, values });

test('מנוחה של 10:00: פעילות שנייה, בלי חריגה', () => {
  const r = run(day(pm('22:30', '23:10', '23:20', '23:50')), { answers: U });
  assert.equal(expected(r, 'COM', 'ATH'), '02:30');
  assert.equal(legal(r), '');
});

test('FDP משותף חוקי: אותו FDP, בלי פיצוי (ס\' 42.7)', () => {
  const r = run(day(pm('16:45', '17:55', '18:55', '20:00')), { answers: U });
  assert.equal(expected(r, 'COM', 'ATH'), null);
  assert.equal(legal(r), '');
  assert.ok(notes(r).some((n) => n.includes('באותו FDP')));
});

for (const [name, later] of [['7:00', pm('19:30', '20:40', '21:40', '22:45')], ['9:59', pm('22:14', '23:10', '23:20', '23:50')]]) {
  test(`מנוחה של ${name} ו-FDP משותף שחורג: שתי פעילויות, 02:30, בלי שאלה, והחריגה נשארת`, () => {
    for (const r of [run(day(later)), run(day(later), { answers: U })]) {
      assert.equal(expected(r, 'COM', 'ATH'), '02:30');
      assert.equal(explains(row(r, 'COM', 'ATH')), ILLEGAL);
      assert.equal(asked(r, 'unplanned:'), false);
      assert.equal(asked(r, 'second_activity:'), false);
      assert.ok(legal(r).includes('מנוחה של'));
      assert.ok(!notes(r).some((n) => n.includes('באותו FDP')));
    }
  });
}

test('הרומה זיכתה: כמו קודם', () => {
  const r = run(day(pm('19:30', '20:40', '21:40', '22:45'), { 10: { COM: '02:30' } }));
  assert.equal(expected(r, 'COM', 'ATH'), '02:30');
  assert.equal(asked(r, 'unplanned:'), false);
});

test('הוספה בהסכמה: בלי פיצוי גם כשהמנוחה לא חוקית', () => {
  const r = run(day(pm('19:30', '20:40', '21:40', '22:45')), { answers: { 'unplanned:2026-08-10..2026-08-10:ATH': { value: 'added' } } });
  assert.equal(expected(r, 'COM', 'ATH'), null);
});

// ---------- סימולטור עם שעות ברומה ----------

const M = (h, m = 0) => h * 60 + m;
const withSim = (m, std, sta) => {
  Object.assign(m.exec.days['2026-08-10'], { details: 'SIM', sims: [{ type: 'SIM', std, sta, org: 'TLV', dst: 'TLV' }] });
  return m;
};
const onSim = (flight, std, sta) => withSim(month(2026, 8, { plan: { 10: 'SIM_SHO' }, exec: { 10: flight }, codes: { 10: 'SIM' } }), std, sta);
const QUESTION = 'second_activity:';

test('סימולטור עם מנוחה ברורה: 02:30, בלי שאלה', () => {
  const r = run(onSim(pm('23:30', '23:40', '23:45', '23:55'), M(8), M(12)), { answers: U });
  assert.equal(asked(r, QUESTION), false);
  assert.equal(expected(r, 'COM', 'ATH'), '02:30');
});

test('מנוחה של 9:45 אחרי סימולטור חוקית: בלי חריגה, ו-02:30', () => {
  // סימולטור עד 12:00, התייצבות ב-21:45.
  const r = run(onSim(pm('22:45', '23:00', '23:10', '23:50'), M(8), M(12)), { answers: U });
  assert.equal(asked(r, QUESTION), false);
  assert.equal(legal(r), '');
  assert.equal(expected(r, 'COM', 'ATH'), '02:30');
  assert.notEqual(explains(row(r, 'COM', 'ATH')), ILLEGAL);
});

test('מנוחה של 9:45 לפני סימולטור חוקית', () => {
  // טיסה מ-05:00, שחרור ב-08:15, וסימולטור ב-18:00.
  const m = withSim(month(2026, 8, { plan: { 10: pm('05:00', '06:00', '07:00', '08:00') }, exec: { 10: pm('05:00', '06:00', '07:00', '08:00') }, codes: { 10: 'SIM' } }), M(18), M(22));
  const r = run(m);
  assert.equal(asked(r, QUESTION), false);
  assert.equal(legal(r), '');
  assert.equal(expected(r, 'COM', '10/08'), '02:30');
});

test('מנוחה של 9:44: FDP משותף שחורג, 02:30 וחריגה', () => {
  const r = run(onSim(pm('22:44', '23:00', '23:10', '23:50'), M(8), M(12)), { answers: U });
  assert.equal(asked(r, QUESTION), false);
  assert.ok(legal(r).includes('מנוחה של'));
  assert.equal(explains(row(r, 'COM', 'ATH')), ILLEGAL);
});

test('סימולטור ו-FDP משותף חוקי: אותו FDP, בלי פיצוי ובלי שאלה', () => {
  const r = run(onSim(pm('13:00', '14:00', '15:00', '16:00'), M(8), M(10)), { answers: U });
  assert.equal(asked(r, QUESTION), false);
  assert.equal(expected(r, 'COM', 'ATH'), null);
  assert.ok(notes(r).some((n) => n.includes('באותו FDP')));
});

test('סימולטור בלי שעות: השאלה נשארת', () => {
  const m = month(2026, 8, { plan: { 10: 'SIM_SHO' }, exec: { 10: pm('13:00', '14:00', '15:00', '16:00') }, codes: { 10: 'SIM' } });
  assert.equal(asked(run(m, { answers: U }), QUESTION), true);
});
