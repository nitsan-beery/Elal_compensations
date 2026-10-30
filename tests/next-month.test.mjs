// חיבור לחודש הבא (טיוטה 438). חודש ההמראה רואה את החזרה, כשהחודש הבא שמור.
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, expected, row, explains, asked, reviews } from './helpers.mjs';

const assumption = 'שלא ניתן לבדוק כיוון שהטיסה חוזרת בחודש הבא';
const out = (dst) => leg('LY1', 'TLV', dst, '10:00', '13:00');
const back = (org) => leg('LY2', org, 'TLV', '09:00', '12:00');
const mar = (dst, com) => month(2026, 3, { plan: { 31: [out(dst)] }, exec: { 31: [out(dst)] }, values: com ? { 31: { COM: com } } : {} });
const apr = (org, day = '01') => month(2026, 4, { plan: { [day]: [back(org)] }, exec: { [day]: [back(org)] } });

for (const st of ['JFK', 'EWR', 'LAS']) {
  test(`${st}: עם החודש הבא הפיצוי בחודש ההמראה נבדק מול המנוחה, בלי הנחה`, () => {
    const r = run(mar(st, '05:00'), { next: apr(st) });
    assert.equal(expected(r, 'COM', st), '05:00');
    assert.ok(!explains(row(r, 'COM', st)).includes(assumption));
  });
}

test('ניו יורק: מנוחה מלאה לפי החודש הבא – הפיצוי נשאר לא מוסבר', () => {
  const r = run(mar('JFK', '05:00'), { next: apr('JFK', '04') });
  assert.equal(expected(r, 'COM', 'JFK'), '00:00');
});

test('מיאמי: לילה אחד מוסבר, ויותר מלילה לא', () => {
  const oneNight = run(mar('MIA', '05:00'), { next: apr('MIA') });
  assert.equal(expected(oneNight, 'COM', 'MIA'), '05:00');
  assert.ok(!explains(row(oneNight, 'COM', 'MIA')).includes(assumption));
  assert.equal(expected(run(mar('MIA', '05:00'), { next: apr('MIA', '03') }), 'COM', 'MIA'), '00:00');
});

test('בלי החודש הבא: ההנחה נשארת', () => {
  assert.ok(explains(row(run(mar('JFK', '05:00')), 'COM', 'JFK')).includes(assumption));
});

test('בלי פיצוי בחודש ההמראה: אין צפי בו, גם כשהחודש הבא שמור', () => {
  assert.equal(expected(run(mar('JFK'), { next: apr('JFK') }), 'COM', 'JFK'), null);
});

test('החודש הבא בלי רומה: לפי התכנון שלו', () => {
  const r = run(mar('JFK', '05:00'), { next: { ...apr('JFK'), exec: null } });
  assert.equal(expected(r, 'COM', 'JFK'), '05:00');
  assert.ok(!explains(row(r, 'COM', 'JFK')).includes(assumption));
});

test('החודש הבא לא מתחיל מהתחנה: הסבב לא מחובר, וההנחה נשארת', () => {
  const r = run(mar('JFK', '05:00'), { next: apr('LAS') });
  assert.ok(explains(row(r, 'COM', 'JFK')).includes(assumption));
});

// נחיתות לילה: שתי נחיתות בתוך החודש, ושלישית ברגל האחרונה, שה-FDP שלה ממשיך בחודש הבא.
const night = () => [leg('LY5', 'TLV', 'ATH', '01:00', '03:00'), leg('LY6', 'ATH', 'TLV', '03:40', '05:40')];
const last = leg('LY9', 'TLV', 'ATH', '23:00', '03:30', { dur: 270 });
const cont = leg('LY10', 'ATH', 'TLV', '04:10', '06:00');
const nov = () => { const legs = { 10: night(), 20: night(), 31: [last] }; return month(2026, 3, { plan: legs, exec: legs }); };
const counted = (r) => asked(r, 'night_crew:');

test('נחיתת לילה שמסיימת FDP, בלי החודש הבא: נספרת', () => {
  assert.equal(counted(run(nov())), true);
});

test('נחיתת לילה ברגל האחרונה, כשה-FDP ממשיך בחודש הבא: אינה נספרת', () => {
  const next = month(2026, 4, { plan: { '01': [cont] } });
  assert.equal(counted(run(nov(), { next })), false);
});

test('החודש הבא מתחיל במנוחה: הרגל האחרונה עדיין מסיימת FDP', () => {
  const next = month(2026, 4, { plan: { '02': [leg('LY10', 'ATH', 'TLV', '20:00', '22:00')] } });
  assert.equal(counted(run(nov(), { next })), true);
});

test('חודש שאינו החודש הבא אינו מחובר', () => {
  const far = month(2026, 5, { plan: { '01': [cont] } });
  assert.equal(counted(run(nov(), { next: far })), true);
  assert.deepEqual(reviews(run(nov(), { next: far })).filter((m) => m.includes('LY10')), []);
});
