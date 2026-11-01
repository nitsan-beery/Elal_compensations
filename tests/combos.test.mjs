// צירופים בין חוקים (טיוטה 474). סינתטי.
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, hhmm } from './helpers.mjs';

const out = () => [leg('LY321', 'TLV', 'ATH', '10:00', '13:00')];
const back = () => [leg('LY322', 'ATH', 'TLV', '09:00', '12:00')];
const turn = (n = 541) => [leg(`LY${n}`, 'TLV', 'LCA', '10:00', '11:00'), leg(`LY${n + 1}`, 'LCA', 'TLV', '12:00', '13:00')];
const other = (d, n) => ({ [d]: turn(n) });
const AUG = { ...other('05', 700), ...other('20', 720), ...other('25', 730) };
const SEP = { ...other('05', 700), ...other('12', 710), ...other('20', 720) };
const OCT = { ...other('08', 740), ...other('15', 750), ...other('22', 760) };
const SICK = { Credit: '02:30', TAB: '11:00' };
const SBY = { Credit: '04:15', TAB: '11:00' };
const aug = (o) => month(2026, 8, { ...o, plan: { ...AUG, ...o.plan }, exec: { ...AUG, ...o.exec } });
const asked = (r, prefix) => r.questions.find((q) => q.id.startsWith(prefix));
const texts = (r) => r.notes.map((n) => n.message).join('\n');
const due = (r, key, date) => r.expectations.filter((e) => e.key === key && e.date === date).reduce((s, e) => s + e.min, 0);
const label = (r, date) => r.changes.filter((c) => c.date === date).map((c) => c.label);

// ---------- 1. זכייה במכרז ביומיים האחרונים (2024 ס' 50) ----------

const go = () => [leg('LY321', 'TLV', 'ATH', '22:00', '23:30')];
const ret = () => [leg('LY322', 'ATH', 'TLV', '09:00', '10:30')];
const lastDays = () => aug({ plan: { 12: 'SBY_S', 13: 'SBY_S' }, exec: { 12: go(), 13: ret() }, codes: { 12: 'SBY_S', 13: 'SBY_S' }, values: { 13: { TAB: '11:00' } } });
const BID = 'standby_bid:2026-08-12..2026-08-13:ATH';

test('לפני התשובה: בלי תוספת עד ערך הכוננות ובלי הערה שהופעלת', () => {
  const r = run(lastDays());
  assert.ok(asked(r, 'standby_bid:'));
  assert.ok(!r.expectations.some((e) => e.ruleId === 'short_call_standby_credit' && e.key === 'rig'));
  assert.ok(!texts(r).includes('הופעלת מכוננות'));
});

test('זכייה במכרז: קריאה מיוחדת, ובלי תוספת עד ערך הכוננות', () => {
  const r = run(lastDays(), { answers: { [BID]: { value: 'standby_bid' } } });
  assert.equal(hhmm(due(r, 'sc', '2026-08-12')), '02:30');
  assert.ok(!r.expectations.some((e) => e.ruleId === 'short_call_standby_credit' && e.key === 'rig'));
});

test('הפעלת הכוננות: התוספת עד ערך הכוננות נשארת', () => {
  const r = run(lastDays(), { answers: { [BID]: { value: 'standby_activated' } } });
  assert.ok(r.expectations.some((e) => e.ruleId === 'short_call_standby_credit' && e.key === 'rig'));
  assert.equal(due(r, 'sc', '2026-08-12'), 0);
});

// ---------- 2. סבב שבוטל עקב מחלה בחודש הקודם ----------

const sick = () => month(2026, 9, { plan: { ...SEP, 29: out() }, exec: SEP, codes: { 29: 'SICK', 30: 'SICK' }, values: { 29: SICK, 30: SICK } });

test('החזרה ב-1 לחודש, והרומה ריקה: בוטל עקב מחלה, בלי שאלה', () => {
  const r = run(month(2026, 10, { plan: { ...OCT, '01': back() }, exec: OCT }), { prev: sick() });
  assert.equal(asked(r, 'cancelled:'), undefined);
  assert.deepEqual(label(r, '2026-10-01'), ['סבב מתוכנן שבוטל עקב מחלה']);
});

test('החזרה ב-1 לחודש, וברומה כוננות וטיסה: בוטל עקב מחלה והוצבת לכוננות, בלי הנחה', () => {
  const m = month(2026, 10, { plan: { ...OCT, '01': back() }, exec: { ...OCT, '01': turn() }, codes: { '01': 'SBY_S' }, values: { '01': { Rig: '03:00' } } });
  const prev = month(2026, 9, { plan: { ...SEP, 29: out() }, exec: SEP, codes: { 29: 'SICK', 30: 'SBY_S' }, values: { 29: SICK, 30: SBY } });
  const r = run(m, { prev });
  assert.ok(label(r, '2026-10-01').includes('סבב מתוכנן שבוטל עקב מחלה והוצבת לכוננות'));
  assert.ok(!r.assumptions.some((a) => a.id.startsWith('cancelled:')));
});

test('בלי מחלה בחודש הקודם: השאלה נשארת', () => {
  const prev = month(2026, 9, { plan: { ...SEP, 29: out() }, exec: SEP });
  assert.ok(asked(run(month(2026, 10, { plan: { ...OCT, '01': back() }, exec: OCT }), { prev }), 'cancelled:'));
});

// ---------- 3. פעילות שבוטלה, וכוננות וטיסה ברומה (ישן כ"ה ס' 12.ב, 12.י) ----------

const placedOn = (code) => aug({ plan: { 10: code }, exec: { 10: turn() }, codes: { 10: 'SBY_S' }, values: { 10: { Rig: '03:00' } } });

for (const [name, code] of [['מילואים', 'MIL_N'], ['פעילות קרקע', 'CPT_BAS'], ['סימולטור', 'SIM']]) {
  test(`${name} שבוטלו, וכוננות וטיסה: הפעלה, בלי קריאה מיוחדת`, () => {
    const r = run(placedOn(code));
    const q = asked(r, 'standby_bid:');
    assert.equal(q.options[0].value, 'standby_activated');
    assert.ok(q.body.includes('פעילות שבוטלה'));
    assert.equal(due(r, 'sc', '2026-08-10'), 0);
    const a = run(placedOn(code), { answers: { [q.id]: { value: 'standby_activated' } } });
    assert.equal(due(a, 'sc', '2026-08-10'), 0);
    assert.ok(label(a, '2026-08-10').includes('הפעלה מכוננות'));
  });
}

test('פעילות קרקע שבוטלה וטיסה בלי כוננות: קריאה מיוחדת, כמו קודם', () => {
  const r = run(aug({ plan: { 10: 'CPT_BAS' }, exec: { 10: turn() }, values: { 10: { Rig: '03:00' } } }));
  assert.equal(hhmm(due(r, 'sc', '2026-08-10')), '02:30');
});

test('חופשה, וכוננות וטיסה: השאלה על קריאה מחופשה נשארת', () => {
  const r = run(placedOn('VAC_FLD'));
  assert.ok(asked(r, 'vacation_recall:'));
  assert.equal(asked(r, 'standby_bid:'), undefined);
});

// ---------- 4. מחלה ו-HOME באותו סבב ----------

test('מחלה ו-HOME בימי הסבב: בוטל עקב מחלה, בלי שאלה', () => {
  const r = run(aug({ plan: { 10: out(), 12: back(), 28: 'HOME_RGT' }, exec: {}, codes: { 10: 'SICK', 11: 'HOME_' }, values: { 10: SICK, 11: { Credit: '03:45', TAB: '11:00' } } }));
  assert.equal(asked(r, 'cancelled:'), undefined);
  assert.deepEqual(label(r, '2026-08-10'), ['סבב מתוכנן שבוטל עקב מחלה']);
});

test('HOME בלבד בימי הסבב: השאלה נשארת', () => {
  const r = run(aug({ plan: { 10: out(), 12: back(), 28: 'HOME_RGT' }, exec: {}, codes: { 11: 'HOME_' }, values: { 11: { Credit: '03:45', TAB: '11:00' } } }));
  assert.ok(asked(r, 'cancelled:'));
});

// ---------- 5. חלה בחו"ל (ישן כ"ה ס' 10.א(4), 15.ו) ----------

const abroad = () => aug({ plan: { 10: out(), 11: back() }, exec: { 10: out(), 12: [{ ...back()[0], dh: true }] }, codes: { 11: 'SICK', 12: 'SICK' }, values: { 11: SICK } });
const EXT = 'extended:2026-08-10..2026-08-12:ATH';

test('חלה בחו"ל וחזר מאוחר: לא נשאל על הארכה, ובלי קריאה מיוחדת', () => {
  const r = run(abroad());
  assert.equal(asked(r, 'extended:'), undefined);
  assert.equal(due(r, 'sc', '2026-08-12'), 0);
  assert.ok(r.changes.some((c) => (c.notes ?? []).some((n) => (n.message ?? n).includes('מחלה בחו"ל'))));
  assert.ok(!texts(r).includes('לא היית מוצב'));
});

test('ההנחה ניתנת לשינוי: בלעדיה נשאלת השאלה על ההארכה', () => {
  assert.ok(asked(run(abroad(), { assumedIgnored: [EXT] }), 'extended:'));
});

test('יום מחלה שלא היה מוצב בו, מחוץ לסבב: ההערה נשארת', () => {
  const r = run(aug({ plan: {}, exec: {}, codes: { 10: 'SICK' } }));
  assert.ok(texts(r).includes('לא היית מוצב'));
});

// ---------- 6. טיסה מתוכננת בתוך שהייה של הפעלה מכוננות ----------

const inside = () => aug({ plan: { 12: 'SBY_S', 13: 'SBY_S', 14: turn(801) }, exec: { 13: out(), 15: back() }, codes: { 12: 'SBY_S', 13: 'SBY_S' }, values: { 12: SBY, 14: { TAB: '11:00' } } });
const STAY = 'standby_bid:2026-08-13..2026-08-15:ATH';

test('טיסה מתוכננת בזמן ההפעלה: לא נשאלת, ובשורה של הסבב', () => {
  const r = run(inside());
  assert.equal(asked(r, 'cancelled:'), undefined);
  const c = run(inside(), { answers: { [STAY]: { value: 'standby_activated' } } }).changes.find((x) => x.date === '2026-08-13');
  assert.equal(c.label, 'הפעלה מכוננות');
  assert.ok(c.plan.includes('LY801'));
});

test('טיסה מתוכננת אחרי החזרה: השאלה נשארת', () => {
  const m = aug({ plan: { 12: 'SBY_S', 13: 'SBY_S', 16: turn(801) }, exec: { 13: out(), 15: back() }, codes: { 12: 'SBY_S', 13: 'SBY_S' }, values: { 12: SBY, 14: { TAB: '11:00' } } });
  assert.ok(asked(run(m), 'cancelled:'));
});
