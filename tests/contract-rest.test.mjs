// מנוחה חוזית אחרי רצף טיסות (2024 ס' 32) ואחרי רצף כוננות (2018 ס' 94.3; טיוטה 473). סינתטי.
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run } from './helpers.mjs';

const asked = (r, prefix) => r.questions.filter((q) => q.id.startsWith(prefix));
const texts = (r) => r.notes.map((n) => n.message).join('\n');
const planOnly = { planOnly: true };

// טיסת סבב של 8 שעות טיסה: המנוחה החוזית אחריה 16 שעות.
const long = (n, ac = 'B737') => [leg(`LY${n}`, 'TLV', 'ATH', '08:00', '12:00', { ac }), leg(`LY${n + 1}`, 'ATH', 'TLV', '13:00', '17:00', { ac })];
const three = { 10: long(1), 11: long(3), 12: long(5) };
const evening = (ac = 'B737') => [leg('LY7', 'TLV', 'ATH', '20:00', '22:00', { ac }), leg('LY8', 'ATH', 'TLV', '22:30', '00:30', { ac })];

// ---------- 2024 ס' 32 ----------

test('רצף של 3 טיסות, ואחריו 23 שעות מנוחה: קצר מ-30, ונשאל', () => {
  const r = run(month(2026, 8, { plan: { ...three, 13: evening() } }), planOnly);
  const q = asked(r, 'base_rest:');
  assert.equal(q.length, 1);
  assert.ok(q[0].date === '2026-08-13');
  assert.ok(q[0].body.includes('30:00'));
  assert.ok(q[0].body.includes('אחרי רצף טיסות'));
});

test('רצף של 3 טיסות, ואחריו 30 שעות ומעלה: בלי שאלה', () => {
  const r = run(month(2026, 8, { plan: { ...three, 14: long(7) } }), planOnly);
  assert.equal(asked(r, 'base_rest:').length, 0);
});

test('בלי רצף: אותה מנוחה עומדת בחוזית, בלי שאלה', () => {
  const r = run(month(2026, 8, { plan: { 12: long(5), 13: evening() } }), planOnly);
  assert.equal(asked(r, 'base_rest:').length, 0);
});

test('לפני 2024 הסעיף לא חל', () => {
  const r = run(month(2023, 8, { plan: { ...three, 13: evening() } }), planOnly);
  assert.equal(asked(r, 'base_rest:').length, 0);
});

test('רצף של 2 טיסות שאינן חוצות לילה (ס\' 55.3) אינו בסעיף: אחרי התשובה אין שאלה נוספת', () => {
  const m = month(2026, 8, { plan: { 11: long(3), 12: long(5), 13: evening() } });
  const id = asked(run(m, planOnly), 'base_rest:')[0].id;
  assert.equal(asked(run(m, { ...planOnly, answers: { [id]: { value: 'sequence' } } }), 'base_rest:').length, 0);
});

// ---------- 2018 ס' 94.3 ----------

const sby = (days) => Object.fromEntries(days.map((d) => [d, 'SBY_S']));
const days = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => String(a + i));

test('צר גוף, טיסה ביום שאחרי רצף הכוננות: קצר מ-24 שעות, ונשאל', () => {
  const r = run(month(2026, 8, { plan: { ...sby(['10', '11']), 12: long(1) } }), planOnly);
  const q = asked(r, 'base_rest:');
  assert.equal(q.length, 1);
  assert.ok(q[0].body.includes('24:00'));
  assert.ok(q[0].body.includes('אחרי רצף כוננות'));
  assert.ok(texts(r).includes('חריגה ממנוחה חוזית'));
});

test('צר גוף, יום פנוי אחרי הכוננות: בלי שאלה', () => {
  const r = run(month(2026, 8, { plan: { ...sby(['10', '11']), 13: long(1) } }), planOnly);
  assert.equal(asked(r, 'base_rest:').length, 0);
});

test('רחב גוף: 36 שעות, ומעל 6 ימי כוננות 48', () => {
  const wide = (plan) => asked(run(month(2026, 8, { plan }), planOnly), 'base_rest:').length;
  assert.equal(wide({ ...sby(['10', '11']), 13: long(1, 'B787') }), 1);
  assert.equal(wide({ ...sby(['10', '11']), 14: long(1, 'B787') }), 0);
  assert.equal(wide({ ...sby(days(10, 16)), 18: evening('B787') }), 1);
  assert.equal(wide({ ...sby(days(10, 15)), 17: evening('B787') }), 0);
});

test('כוננות בסוף החודש וטיסה ב-1 לחודש הבא: נבדק בחודש הטיסה', () => {
  const prev = month(2026, 9, { plan: { ...sby(['29', '30']), '05': long(9) } });
  const r = run(month(2026, 10, { plan: { '01': long(1) } }), { ...planOnly, prev });
  assert.equal(asked(r, 'base_rest:').length, 1);
});

test('מול הרומה: לפי סוף שורת הכוננות ביום האחרון', () => {
  const build = () => month(2026, 8, { plan: { ...sby(['10', '11']), 13: long(1) }, exec: { 13: long(1) }, codes: { 10: 'SBY_S', 11: 'SBY_S' } });
  const m = build();
  assert.equal(asked(run(m), 'base_rest:').length, 0);
  const late = month(2026, 8, { plan: { ...sby(['10']), 11: long(1) }, exec: { 11: long(1) }, codes: { 10: 'SBY_S' } });
  assert.equal(asked(run(late), 'base_rest:').length, 1);
  late.exec.days['2026-08-10'].standby = [{ type: 'SBY_S', std: 0, sta: 60 }];
  assert.equal(asked(run(late), 'base_rest:').length, 0);
});

test('הרומה לא רשמה כוננות ביום האחרון: אין מה לבדוק', () => {
  const m = month(2026, 8, { plan: { ...sby(['10', '11']), 12: long(1) }, exec: { 12: long(1) }, codes: { 10: 'SBY_S' } });
  assert.equal(asked(run(m), 'base_rest:').length, 0);
});

test('הופעל מהכוננות ביום האחרון: אין מה לבדוק', () => {
  const m = month(2026, 8, { plan: { ...sby(['10', '11']), 12: long(1) }, exec: { 11: long(3), 12: long(1) }, codes: { 10: 'SBY_S', 11: 'SBY_S' } });
  assert.equal(asked(run(m), 'base_rest:').length, 0);
});

test('הרומה זיכתה את הפיצוי: מניחים לבקשת החברה, בלי שאלה', () => {
  const m = month(2026, 8, { plan: { ...sby(['10']), 11: long(1) }, exec: { 11: long(1) }, codes: { 10: 'SBY_S' }, values: { 11: { COM: '02:30' } } });
  const r = run(m);
  assert.equal(asked(r, 'base_rest:').length, 0);
  assert.equal(r.comparison.find((c) => c.column === 'COM' && c.dates.includes('2026-08-11')).ok, true);
});
