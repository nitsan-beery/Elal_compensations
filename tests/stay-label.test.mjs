// תאריכים ותוויות בפירוט: יום בלי טיסה בתוך סבב, וסבב שיצא בחודש הקודם (טיוטה 482).
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, row } from './helpers.mjs';

const clean = (s) => String(s ?? '').replace(/[⁦-⁩‏]/g, '');
const turn = () => [leg('LY541', 'TLV', 'LCA', '10:00', '11:00'), leg('LY542', 'LCA', 'TLV', '12:00', '13:00')];
const stayDay = { 'S/C': '02:30', TAB: '24:00' };

// יצא ב-28/02 בלי תכנון, נשאר בחו"ל, וחזר ב-08/03.
const stuck = () => {
  const prev = month(2026, 2, { plan: { '05': turn() }, exec: { '05': turn(), 28: [leg('LY1', 'TLV', 'ATH', '11:00', '13:00')] }, values: { 28: { 'S/C': '02:30' } } });
  const days = Object.fromEntries(['01', '02', '03', '04', '05', '06', '07'].map((d) => [d, stayDay]));
  const m = month(2026, 3, { plan: { 20: turn() }, exec: { '08': [leg('LY2', 'ATH', 'TLV', '10:00', '12:00')], 20: turn() }, values: days });
  return run(m, { prev });
};

test('סבב שיצא בחודש הקודם: יום בלי טיסה הוא שהייה בשדה, בלי מספר טיסה', () => {
  const r = stuck();
  for (const d of ['01/03', '06/03']) assert.equal(clean(row(r, 'S/C', d).label), `${d} · שהייה ב-ATH`);
});

test('שהייה מבודדת מימין לשמאל, אחרת היא מוצגת הפוכה', () => {
  assert.ok(row(stuck(), 'S/C', '01/03').label.includes('\u2067שהייה ב-ATH\u2069'));
});

test('סבב שיצא בחודש הקודם: שורת הקרדיט בתאריך הטיסה בלבד', () => {
  assert.equal(clean(row(stuck(), 'Credit', 'ATH-TLV').label), '08/03 · ATH-TLV (LY2)');
});

test('סבב שיצא בחודש הקודם: בטבלת השינויים הכותרת על כל השהייה, והביצוע בתאריך הטיסה', () => {
  const c = stuck().changes.find((x) => clean(x.exec).includes('ATH-TLV'));
  assert.equal(c.date, '2026-03-01');
  assert.equal(c.to, '2026-03-08');
  assert.equal(clean(c.exec), '08/03 ATH-TLV (LY2)');
});

test('סבב בתוך החודש: יום באמצע השהייה הוא שהייה, וימי הטיסות נשארים עם הטיסה', () => {
  const m = month(2026, 10, { plan: { 20: turn() },
    exec: { 10: [leg('LY1', 'TLV', 'ATH', '10:00', '12:00')], 13: [leg('LY2', 'ATH', 'TLV', '13:00', '15:00')], 20: turn() },
    values: { 10: { 'S/C': '02:30' }, 11: stayDay, 12: stayDay, 13: { 'S/C': '02:30' } } });
  const r = run(m);
  assert.equal(clean(row(r, 'S/C', '11/10').label), '11/10 · שהייה ב-ATH');
  assert.ok(clean(row(r, 'S/C', '10/10').label).includes('LY1'));
  assert.ok(clean(row(r, 'S/C', '13/10').label).includes('LY2'));
});

test('יום שטיסה נוחתת בו אחרי חצות נשאר עם הטיסה', () => {
  const m = month(2026, 10, { plan: { 20: turn() },
    exec: { 10: [leg('LY1', 'TLV', 'ATH', '10:00', '12:00')], 12: [leg('LY2', 'ATH', 'TLV', '23:00', '02:00')], 20: turn() },
    values: { 10: { 'S/C': '02:30' }, 11: stayDay, 12: { 'S/C': '02:30' }, 13: { 'S/C': '02:30' } } });
  const label = clean(row(run(m), 'S/C', '13/10').label);
  assert.ok(label.includes('LY2'), label);
});
