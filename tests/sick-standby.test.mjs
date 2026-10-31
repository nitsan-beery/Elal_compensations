// סבב שבוטל עקב מחלה, וכוננות בימיו (2018 ס' 92; טיוטה 472). סינתטי.
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, rulesData } from './helpers.mjs';

const out = () => [leg('LY321', 'TLV', 'ATH', '10:00', '13:00')];
const back = () => [leg('LY322', 'ATH', 'TLV', '09:00', '12:00')];
const turn = () => [leg('LY541', 'TLV', 'LCA', '10:00', '11:00'), leg('LY542', 'LCA', 'TLV', '12:00', '13:00')];
const other = (d) => ({ [d]: turn().map((l, i) => ({ ...l, flight: `LY${700 + Number(d) * 2 + i}` })) });
const asked = (r, prefix) => r.questions.find((q) => q.id.startsWith(prefix));
const texts = (r) => r.notes.map((n) => n.message).join('\n');
const row = (r, column, date) => r.comparison.find((c) => c.column === column && c.dates.includes(date));
const flag = (m, date, col) => { m.exec.days[date].values[col] = { kind: 'count', count: 1, raw: '1.00' }; };
const ID = 'standby_bid:2026-10-01..2026-10-01:LCA';
const ACTIVATED = { [ID]: { value: 'standby_activated' } };

// סבב 29/09 שלא חוזר בחודש, מחלה ב-29/09 וכוננות ב-30/09.
function sep({ code = 'SBY_S', sick = true } = {}) {
  const fill = { ...other('05'), ...other('12'), ...other('20') };
  const m = month(2026, 9, { plan: { ...fill, 29: out() }, exec: fill, codes: { 29: sick ? 'SICK' : code, 30: code },
    values: { 29: sick ? { Credit: '02:30', TAB: '11:00' } : { Credit: '04:15', TAB: '11:00' }, 30: { Credit: '04:15', TAB: '11:00' } } });
  flag(m, '2026-09-29', sick ? 'SICK' : 'SBY');
  flag(m, '2026-09-30', 'SBY');
  return m;
}
// X ב-01/10 בתכנון, וברומה כוננות וטיסה באותו יום.
const oct = ({ code = 'SBY_S', values = {} } = {}) => {
  const fill = { ...other('08'), ...other('15'), ...other('22') };
  return month(2026, 10, { plan: { ...fill, '01': 'X' }, exec: { ...fill, '01': turn() }, codes: code ? { '01': code } : {}, values: { '01': { Rig: '03:00', ...values } } });
};

// ---------- מעבר חודש ----------

test('כוננות אחרי מחלה ביום הבא של הסבב: מהיומיים האחרונים, ונשאל על ההפעלה ולא על קריאה מיוחדת', () => {
  const r = run(oct(), { prev: sep() });
  assert.equal(asked(r, 'unplanned:'), undefined);
  const q = asked(r, 'standby_bid:');
  assert.equal(q.options[0].value, 'standby_activated');
  assert.ok(q.body.includes('בוטל עקב מחלה'));
  assert.ok(!q.body.includes('בתכנון כוננות'));
});

test('הפעלת הכוננות: הפעלה מכוננות, בלי קריאה מיוחדת ובלי פער', () => {
  const r = run(oct(), { prev: sep(), answers: ACTIVATED });
  assert.equal(asked(r, 'unplanned:'), undefined);
  assert.ok(r.changes.some((c) => c.date === '2026-10-01' && c.label === 'הפעלה מכוננות'));
  assert.equal(row(r, 'S/C', '2026-10-01'), undefined);
  assert.equal(row(r, 'Rig', '2026-10-01').ok, true);
  assert.ok(texts(r).includes('הופעלת מכוננות'));
  assert.ok(!texts(r).includes('Soft Start'));
});

test('כוננות רגילה: אותו מסלול', () => {
  const r = run(oct({ code: 'SBY_L' }), { prev: sep({ code: 'SBY_L' }) });
  assert.equal(asked(r, 'unplanned:'), undefined);
  assert.ok(asked(r, 'standby_bid:'));
});

test('הרומה זיכתה קריאה מיוחדת ביומיים האחרונים: מניחים זכייה במכרז', () => {
  const r = run(oct({ values: { 'S/C': '02:30' } }), { prev: sep() });
  assert.equal(asked(r, 'standby_bid:'), undefined);
  assert.ok(r.assumptions.some((a) => a.id === ID));
  assert.equal(row(r, 'S/C', '2026-10-01').ok, true);
});

test('בלי החודש הקודם אי אפשר לדעת על הסבב: השאלה על פעילות לא מתוכננת נשארת', () => {
  assert.ok(asked(run(oct()), 'unplanned:'));
});

test('סבב שבוטל בלי מחלה: ס\' 92 אינו חל', () => {
  assert.ok(asked(run(oct(), { prev: sep({ sick: false }) }), 'unplanned:'));
});

test('ברומה אין כוננות ביום הטיסה: השאלה על פעילות לא מתוכננת נשארת', () => {
  assert.ok(asked(run(oct({ code: null }), { prev: sep() }), 'unplanned:'));
});

// ---------- בתוך חודש ----------

// סבב 10–`last`, מחלה ב-10, כוננות בשאר הימים, וטיסה ב-`flown`.
function inside({ last = '12', flown = '12', values = {}, sick = true } = {}) {
  const fill = { ...other('05'), ...other('20'), ...other('25') };
  const standby = Array.from({ length: Number(last) - 10 }, (_, i) => String(11 + i));
  const codes = { 10: sick ? 'SICK' : 'SBY_S', ...Object.fromEntries(standby.map((d) => [d, 'SBY_S'])) };
  const vals = { 10: { Credit: sick ? '02:30' : '04:15', TAB: '11:00' },
    ...Object.fromEntries(standby.map((d) => [d, d === flown ? { Rig: '03:00', ...values } : { Credit: '04:15', TAB: '11:00' }])) };
  const m = month(2026, 8, { plan: { ...fill, 10: out(), [last]: back() }, exec: { ...fill, [flown]: turn() }, codes, values: vals });
  flag(m, '2026-08-10', sick ? 'SICK' : 'SBY');
  return m;
}

test('טיסה בכוננות בתוך הסבב שבוטל עקב מחלה: הסבב אינו מוחלף, ולא נשאלת השאלה על החלפה', () => {
  const r = run(inside());
  assert.equal(asked(r, 'cancelled:'), undefined);
  assert.ok(r.changes.some((c) => c.label === 'סבב מתוכנן שבוטל עקב מחלה והוצבת לכוננות'));
  assert.ok(asked(r, 'standby_bid:'));
});

test('טיסה לפני היומיים האחרונים: הפעלה מכוננות בלי שאלה', () => {
  const r = run(inside({ last: '13', flown: '11' }));
  assert.equal(asked(r, 'standby_bid:'), undefined);
  assert.equal(asked(r, 'cancelled:'), undefined);
  assert.equal(asked(r, 'unplanned:'), undefined);
  assert.ok(r.changes.some((c) => c.label === 'הפעלה מכוננות'));
  assert.equal(row(r, 'S/C', '2026-08-11'), undefined);
});

test('הרומה זיכתה קריאה מיוחדת על הפעלה: פיצוי שאף חוק אינו מסביר', () => {
  const r = run(inside({ last: '13', flown: '11', values: { 'S/C': '02:30' } }));
  const line = row(r, 'S/C', '2026-08-11');
  assert.equal(line.expected, 0);
  assert.equal(line.ok, false);
  assert.ok(line.notes.join().includes('שאף חוק אינו מסביר'));
});

test('בלי מחלה: סבב אחר באותם ימים נשאל כרגיל', () => {
  assert.ok(asked(run(inside({ sick: false })), 'cancelled:'));
});

// ---------- ימים ללא פעילות ----------

const strict = (days) => {
  const c = structuredClone(rulesData);
  const r = c.rules.find((x) => x.logic?.id === 'free_days_waived');
  for (const k of Object.keys(r.logic.params.min_free_days)) r.logic.params.min_free_days[k] = r.logic.params.min_free_days[k].map((x) => ({ ...x, days }));
  return c;
};
const busy = Object.fromEntries(Array.from({ length: 29 }, (_, i) => [String(2 + i).padStart(2, '0'), 'SIM']));
const tight = () => month(2026, 10, { plan: { ...busy, ...other('08'), 15: 'X', '01': 'X' }, exec: { ...other('08') } });
const freeFirst = (r) => r.freeDays.dates.includes('2026-10-01');

test('הסבב בתכנון הקודם לא חזר, ולא בוצע: ה-X אינו נספר, ואין שאלה כשיש מספיק ימים', () => {
  const r = run(oct(), { prev: sep(), answers: ACTIVATED });
  assert.equal(freeFirst(r), false);
  assert.equal(asked(r, 'free_days_first:'), undefined);
});

test('היום מוריד מתחת למינימום: נשאל על הנחיתה המתוכננת', () => {
  const r = run(tight(), { prev: sep(), rules: strict(3) });
  assert.ok(asked(r, 'free_days_first:').title.includes('תוכננה'));
  assert.equal(freeFirst(r), false);
});

test('התשובה שהנחיתה המתוכננת הייתה עד 01:00: היום נספר', () => {
  const r = run(tight(), { prev: sep(), rules: strict(3), answers: { 'free_days_first:2026-10': { value: 'free' } } });
  assert.equal(freeFirst(r), true);
  assert.equal(asked(r, 'free_days_first:'), undefined);
});

test('בתכנון לבד, כשהרומה הקודמת מראה שהסבב לא בוצע: לפי התכנון, והיום אינו נספר', () => {
  assert.equal(freeFirst(run(oct(), { prev: sep(), planOnly: true })), false);
});

test('בתכנון הקודם הסבב חזר: ה-X נספר, כמו קודם', () => {
  const prev = month(2026, 9, { plan: { ...other('05') }, exec: { ...other('05') } });
  assert.equal(freeFirst(run(oct(), { prev, answers: {} })), true);
});
