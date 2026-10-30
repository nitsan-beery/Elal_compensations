// הפעלה מכוננות, כוננות בשדה, ורצף כוננות שחוצה חודש (2018 ס' 88, 98; 2024 ס' 50, 52; טיוטה 451).
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, expected, explains, row, asked, notes, rulesData } from './helpers.mjs';

const out = (dst = 'ATH') => leg('LY321', 'TLV', dst, '10:00', '13:00');
const back = (org = 'ATH') => leg('LY322', org, 'TLV', '09:00', '12:00');
const shortOut = () => leg('LY321', 'TLV', 'ATH', '10:00', '11:00');
const shortBack = () => leg('LY322', 'ATH', 'TLV', '09:00', '10:00');
const longOut = () => leg('LY321', 'TLV', 'ATH', '07:00', '13:00');
const turn = () => [leg('LY541', 'TLV', 'LCA', '10:00', '11:00'), leg('LY542', 'LCA', 'TLV', '12:00', '13:00')];
const standby = (days, code = 'SBY_S') => Object.fromEntries(days.map((d) => [d, code]));
const BID = 'standby_bid:';
const last = (m, id) => run(m, { answers: { [id]: { value: 'standby_activated' } } });

// ---------- כוננות בשדה (2024 ס' 52.3) ----------

test('כוננות בשדה: 06:00 ליום, ולא קוד לא מוכר', () => {
  const r = run(month(2026, 8, { plan: standby(['10'], 'SBY_FLD'), exec: {}, codes: { 10: 'SBY_F' }, values: { 10: { Credit: '06:00', TAB: '11:00' } } }));
  assert.equal(expected(r, 'Credit', 'כוננות'), '06:00');
  assert.deepEqual(r.unknownCodes, []);
});

test('כוננות בשדה בתכנון לבד: 06:00, בלי קוד לא מוכר', () => {
  const r = run(month(2026, 8, { plan: standby(['10'], 'SBY_FLD') }));
  assert.equal((r.expectations ?? []).find((e) => e.key === 'absence')?.min, 360);
  assert.deepEqual(r.unknownCodes, []);
});

test('הפעלה מכוננות בשדה: הגבוה מבין קרדיט הטיסה לערך הימים', () => {
  const r = run(month(2026, 8, { plan: standby(['10', '11', '12', '13'], 'SBY_FLD'), exec: { 10: [out()], 11: [back()] } }));
  assert.equal(expected(r, 'Rig', 'ATH'), '06:00');
});

// ---------- הגבוה מבין "באותם ימים" (2018 ס' 98) ----------

test('הסליפ כולו בימי הכוננות: 08:30 מול 06:00', () => {
  const r = run(month(2026, 8, { plan: standby(['10', '11', '12', '13']), exec: { 10: [out()], 11: [back()] } }));
  assert.equal(expected(r, 'Rig', 'ATH'), '02:30');
  assert.equal(explains(row(r, 'Rig', 'ATH')), 'ערך 2 ימי הכוננות שבהם טסת גבוה מקרדיט הסבב.');
});

test('רגל אחרי סוף הכוננות אינה נכנסת להשוואה: 04:15 מול 03:00', () => {
  const m = month(2026, 8, { plan: standby(['13']), exec: { 13: [out()], 14: [back()] }, values: { 14: { TAB: '12:00' } } });
  const r = last(m, 'standby_bid:2026-08-13..2026-08-14:ATH');
  assert.equal(expected(r, 'Rig', 'ATH'), '01:15');
  assert.equal(expected(r, 'S/C', '14/08'), '02:30');
  assert.equal(explains(row(r, 'Rig', 'ATH')), 'ערך יום הכוננות שבו טסת גבוה מקרדיט הרגליים באותו יום.');
});

test('יום שהייה בכוננות נספר, והרגל שאחריה לא: 12:45 מול 03:00', () => {
  const r = run(month(2026, 8, { plan: standby(['10', '11', '12']), exec: { 10: [out()], 14: [back()] }, values: { 14: { TAB: '12:00' } } }));
  assert.equal(expected(r, 'Rig', 'ATH'), '09:45');
});

test('ההשלמה ל-5 שעות אינה נספרת פעמיים', () => {
  // רגל של 01:00 בכל צד. בכוננות: 12:45 מול 01:00, ועל הרגל שאחריה 01:00 = 13:45, מול קרדיט 02:00.
  const r = run(month(2026, 8, { plan: standby(['10', '11', '12']), exec: { 10: [shortOut()], 14: [shortBack()] }, values: { 14: { TAB: '10:00' } } }));
  assert.equal(expected(r, 'Rig', 'ATH'), '11:45');
});

test('הרגל בימי הכוננות גבוהה מהערך: בלי תוספת, והערה על הרגליים באותם ימים', () => {
  const m = month(2026, 8, { plan: standby(['13']), exec: { 13: [longOut()], 14: [back()] }, values: { 14: { TAB: '12:00' } } });
  const r = last(m, 'standby_bid:2026-08-13..2026-08-14:ATH');
  assert.equal(expected(r, 'Rig', 'ATH'), null);
  assert.ok(notes(r).some((n) => n.includes('קרדיט הרגליים בימי הכוננות (06:00) גבוה מערך הכוננות')));
});

// ---------- רצף שחוצה חודש (2024 ס' 50) ----------

const aug = (flown) => month(2026, 8, { plan: standby(['30', '31']), exec: { [flown]: turn() } });
const sep = (days) => month(2026, 9, { plan: standby(days) });

test('בלי התכנון של החודש הבא: נשאל, ועם הזכרה שהכוננות אולי נמשכת', () => {
  const r = run(aug('30'));
  assert.equal(asked(r, BID), true);
  assert.ok(r.questions.find((q) => q.id.startsWith(BID)).body.includes('ייתכן שהיא נמשכת'));
});

test('הרצף נמשך בחודש הבא: 30/08 אינו מהיומיים האחרונים, והטיסה היא הפעלה', () => {
  const r = run(aug('30'), { next: sep(['01', '02']) });
  assert.equal(asked(r, BID), false);
  assert.ok(r.changes.some((c) => c.label === 'הפעלה מכוננות'));
});

test('היומיים האחרונים חוצים חודש: 31/08 ו-01/09', () => {
  assert.equal(asked(run(aug('31'), { next: sep(['01']) }), BID), true);
  assert.equal(asked(run(aug('30'), { next: sep(['01']) }), BID), false);
});

test('החודש הבא שמור ואין בו כוננות: בלי ההערה שהיא אולי נמשכת', () => {
  const r = run(aug('30'), { next: sep([]) });
  assert.equal(asked(r, BID), true);
  assert.ok(!r.questions.find((q) => q.id.startsWith(BID)).body.includes('ייתכן שהיא נמשכת'));
});

// ---------- טיסת מטען (ישן כ"ה ס' 11.יג) ----------

test('טיסת מטען שנדחתה: במסך החוקים כלא נתמך, עם הסיבה', () => {
  const rule = rulesData.rules.find((x) => x.source.includes('11.יג'));
  assert.equal(rule.logic.supported, false);
  assert.ok(rule.unsupported_reason.length > 0);
});
