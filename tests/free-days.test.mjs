// ימים ללא פעילות: רצפים שנחשבים פנויים (2018 ס' 71.1; טיוטה 463).
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, min, asked, notes, expected } from './helpers.mjs';

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

// ---------- יום שנגרע בהגדלת המכסה: 2024 ס' 66, ומ-2026 ס' 25 (2024 ס' 33, המשפט האחרון; טיוטות 475–476) ----------

const PEAK = 'free_days_peak:2026-10';
const WAIVED = 'free_days:2026-10';
// הימים האחרונים בחודש פנויים, והטיסה ב-1 לחודש קובעת את הצי. `ground`: מספר ימי סימולטור, או רשימת קודים. `exec`: אותה טיסה ברומה.
const raised = (free, { sum = '97:00', fict = '12:00', ac = 'B737', exec = false, values = {}, first = null, ground = 4, ym = [2026, 10] } = {}) => {
  const start = first ? 3 : 2;
  const codes = Array.isArray(ground) ? ground : Array(ground).fill('SIM');
  const m = month(ym[0], ym[1], { plan: { ...fill(start, 31 - free, 'SBY_S'), ...Object.fromEntries(codes.map((c, i) => [pad(start + i), c])),
    ...(first ? { '01': first, '02': turn(ac)() } : { '01': turn(ac)() }) },
    ...(exec ? { exec: { '01': turn(ac)() }, values } : {}) });
  m.plan.summary = { ...m.plan.summary, sum: min(sum), fictFlightTime: min(fict) };
  return m;
};
const answer = (...pairs) => Object.fromEntries(pairs.map(([id, value]) => [id, { value }]));

test('8 ימים פנויים: נשאל על חודש עומס, לפני הוויתור', () => {
  const r = run(raised(8), plan);
  assert.equal(asked(r, PEAK), true);
  assert.equal(asked(r, WAIVED), false);
  assert.equal(r.freeDays.due, 9);
});

test('חודש עומס: המינימום 9, וחסר יום אחד בלי פיצוי', () => {
  const r = run(raised(8), { ...plan, answers: answer([PEAK, 'peak']) });
  assert.equal(r.freeDays.due, 9);
  assert.equal(asked(r, WAIVED), false);
  assert.ok(notes(r).some((n) => n.includes('חסר יום אחד')));
});

test('לא חודש עומס: היום שנגרע נספר, וחסרים 2', () => {
  const r = run(raised(8), { ...plan, answers: answer([PEAK, 'regular']) });
  assert.equal(r.freeDays.due, 10);
  assert.ok(r.questions.find((q) => q.id === WAIVED).title.includes('חסרים 2'));
  assert.ok(r.questions.find((q) => q.id === WAIVED).body.includes('ועוד יום שנגרע בגלל הגדלת המכסה ל-100 שעות, כלומר 10'));
});

test('לא חודש עומס, לבקשת החברה: פיצוי על היום השני', () => {
  const r = run(raised(8, { exec: true }), { answers: answer([PEAK, 'regular'], [WAIVED, 'company']) });
  assert.equal(expected(r, 'COM', 'ימים ללא פעילות'), '02:30');
});

test('7 ימים פנויים: חודש עומס 02:30, אחרת 05:00', () => {
  assert.equal(expected(run(raised(7, { exec: true }), { answers: answer([PEAK, 'peak'], [WAIVED, 'company']) }), 'COM', 'ימים ללא פעילות'), '02:30');
  assert.equal(expected(run(raised(7, { exec: true }), { answers: answer([PEAK, 'regular'], [WAIVED, 'company']) }), 'COM', 'ימים ללא פעילות'), '05:00');
});

test('9 ימים פנויים: אין פיצוי בכל מקרה, ולכן בלי שאלה ובלי הערה', () => {
  const r = run(raised(9), plan);
  assert.equal(asked(r, PEAK), false);
  assert.equal(r.freeDays.due, 9);
  assert.ok(!notes(r).some((n) => n.includes('ימים ללא פעילות')));
});

test('95:00 בדיוק: בתוך התקרה הרגילה, ואין יום שנגרע', () => {
  assert.equal(asked(run(raised(8, { sum: '95:00' }), plan), PEAK), false);
});

test('מ-2026: 3 ימי קרקע וסימולטור אינם מספיקים, וכוננות אינה נספרת', () => {
  assert.equal(asked(run(raised(8, { ground: 3 }), plan), PEAK), false);
});

test('מ-2026: 4 ימים מספיקים, גם בלי קרדיט לא טיסתי מעל 10', () => {
  const r = run(raised(8, { fict: '00:00' }), plan);
  assert.ok(r.questions.find((q) => q.id === PEAK).body.includes('עם 4 ימי קרקע וסימולטור'));
});

test('מ-2026: קרקע וסימולטור נספרים יחד', () => {
  assert.equal(asked(run(raised(8, { ground: ['SIM_SHO', 'CPT_BAS', 'SIM', 'HOME_RGT'] }), plan), PEAK), true);
});

test('מ-2026: קרדיט לא טיסתי גבוה אינו מספיק', () => {
  assert.equal(asked(run(raised(8, { ground: 3, fict: '40:00' }), plan), PEAK), false);
});

test('ינואר 2026: כבר לפי ימי הקרקע', () => {
  assert.equal(asked(run(raised(8, { ground: 0, ym: [2026, 1] }), plan), 'free_days_peak:'), false);
});

test('עד 2025: לפי הקרדיט הלא טיסתי, בלי קשר לימי קרקע', () => {
  const r = run(raised(8, { ground: 0, ym: [2025, 12] }), plan);
  assert.ok(r.questions.find((q) => q.id === 'free_days_peak:2025-12').body.includes('מתוכו 12:00 לא טיסתי'));
});

test('עד 2025: 10:00 בדיוק לא טיסתי אינו מספיק', () => {
  assert.equal(asked(run(raised(8, { fict: '10:00', ym: [2025, 12] }), plan), 'free_days_peak:'), false);
});

test('רחב גוף: אין יום שנגרע, והמינימום לפי הטבלה שלו', () => {
  const r = run(raised(8, { ac: 'B789', ground: 22 }), plan);
  assert.equal(asked(r, PEAK), false);
  assert.equal(asked(r, WAIVED), true);
  assert.equal(r.freeDays.due, 10);
});

test('הרומה זיכתה את הסכום המלא: מניחים, בלי שאלה', () => {
  const r = run(raised(8, { exec: true, values: { '01': { COM: '02:30' } } }));
  assert.equal(asked(r, PEAK), false);
  assert.equal(asked(r, WAIVED), false);
  assert.equal(r.freeDays.due, 10);
  assert.ok(r.assumptions.some((a) => a.id === PEAK && a.value === 'regular'));
});

test('ביטול ההנחה: השאלה חוזרת', () => {
  const r = run(raised(8, { exec: true, values: { '01': { COM: '02:30' } } }), { assumedIgnored: [PEAK] });
  assert.equal(asked(r, PEAK), true);
});

test('הרומה זיכתה רק את הסכום של חודש עומס: נשאל', () => {
  assert.equal(asked(run(raised(7, { exec: true, values: { '01': { COM: '02:30' } } })), PEAK), true);
});

test('X ב-1 לחודש שטרם נענה: קודם השאלה עליו', () => {
  const r = run(raised(8, { first: 'X' }), plan);
  assert.equal(asked(r, 'free_days_first:'), true);
  assert.equal(asked(r, PEAK), false);
});
