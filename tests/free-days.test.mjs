// ימים ללא פעילות: רצפים שנחשבים פנויים (2018 ס' 71.1; טיוטה 463).
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run } from './helpers.mjs';

const pad = (n) => String(n).padStart(2, '0');
const fill = (from, to, code) => Object.fromEntries(Array.from({ length: to - from + 1 }, (_, i) => [pad(from + i), code]));
const turn = (ac) => () => [leg('LY1', 'TLV', 'ATH', '10:00', '12:00', { ac }), leg('LY2', 'ATH', 'TLV', '13:00', '15:00', { ac })];
const flights = (ac, days = ['20', '22', '24']) => Object.fromEntries(days.map((d) => [d, turn(ac)()]));
const oct = (plan, ac = 'B737') => month(2026, 10, { plan: { ...plan, ...flights(ac) } });
const sep = (plan, ac = 'B737') => month(2026, 9, { plan: { ...plan, ...flights(ac, ['02', '04', '06']) } });
const days = (r, from, to) => r.freeDays.dates.map((d) => d.slice(5)).filter((d) => d >= from && d <= to);
const plan = { planOnly: true };

// ---------- הדרכה: מהיום החמישי, והרצף מתאפס במעבר חודש ----------

test('שישה ימי הדרכה: החמישי והשישי פנויים', () => {
  assert.deepEqual(days(run(oct(fill(10, 15, 'CPT_BAS')), plan), '10-10', '10-15'), ['10-14', '10-15']);
});

test('כל פעילויות הקרקע נספרות, כולל HOME_RGT', () => {
  const r = run(oct({ 10: 'CPT_BAS', 11: 'CRM_CRS', 12: 'HOME_RGT', 13: 'RGT', 14: 'ENGL_TST' }), plan);
  assert.deepEqual(days(r, '10-10', '10-14'), ['10-14']);
});

test('סימולטור אינו הדרכה: אינו פנוי, ושובר את הרצף', () => {
  const r = run(oct({ ...fill(10, 13, 'CPT_BAS'), 14: 'SIM', 15: 'CPT_BAS' }), plan);
  assert.deepEqual(days(r, '10-10', '10-15'), []);
});

test('יום פנוי באמצע מאפס את הרצף', () => {
  assert.deepEqual(days(run(oct({ ...fill(10, 13, 'CPT_BAS'), ...fill(15, 18, 'CPT_BAS') }), plan), '10-15', '10-18'), []);
});

test('כוננות אינה הדרכה', () => {
  assert.deepEqual(days(run(oct(fill(10, 15, 'SBY_S')), plan), '10-10', '10-15'), []);
});

test('רצף הדרכה שחוצה חודש מתאפס', () => {
  const r = run(oct(fill(1, 4, 'CPT_BAS')), { ...plan, prev: sep(fill(28, 30, 'CPT_BAS')) });
  assert.deepEqual(days(r, '10-01', '10-04'), []);
});

test('מילואים שחוצים חודש מתאפסים, כמו היום', () => {
  const r = run(oct(fill(1, 2, 'MIL_NOR')), { ...plan, prev: sep(fill(29, 30, 'MIL_NOR')) });
  assert.deepEqual(days(r, '10-01', '10-02'), []);
});

// ---------- כוננות ברחב גוף: החמישי והשישי, גם בחודש הבא ----------

test('רחב גוף, שבעה ימי כוננות: רק החמישי והשישי פנויים', () => {
  assert.deepEqual(days(run(oct(fill(10, 16, 'SBY_S'), 'B789'), plan), '10-10', '10-16'), ['10-14', '10-15']);
});

test('צר גוף: כוננות אינה נספרת', () => {
  assert.deepEqual(days(run(oct(fill(10, 16, 'SBY_S')), plan), '10-10', '10-16'), []);
});

test('כוננות שחוצה חודש: החמישי והשישי בחודש הבא פנויים', () => {
  const r = run(oct(fill(1, 4, 'SBY_S'), 'B789'), { ...plan, prev: sep(fill(28, 30, 'SBY_S'), 'B789') });
  assert.deepEqual(days(r, '10-01', '10-04'), ['10-02', '10-03']);
});

test('כוננות שחוצה חודש: החמישי בחודש הקודם והשישי בחודש הזה', () => {
  const r = run(oct(fill(1, 2, 'SBY_S'), 'B789'), { ...plan, prev: sep(fill(26, 30, 'SBY_S'), 'B789') });
  assert.deepEqual(days(r, '10-01', '10-02'), ['10-01']);
});

test('כוננות בסוף החודש: מה שבחודש הזה לא משתנה', () => {
  assert.deepEqual(days(run(oct(fill(28, 31, 'SBY_S'), 'B789'), plan), '10-28', '10-31'), []);
});

test('בלי החודש הקודם: הרצף נספר מ-1 לחודש', () => {
  assert.deepEqual(days(run(oct(fill(1, 5, 'SBY_S'), 'B789'), plan), '10-01', '10-05'), ['10-05']);
});
