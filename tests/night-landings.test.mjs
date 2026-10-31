// נחיתות לילה (2024 ס' 39–40; טיוטה 460).
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, asked, hhmm } from './helpers.mjs';

const night = () => [leg('LY5', 'TLV', 'ATH', '01:00', '03:00'), leg('LY6', 'ATH', 'TLV', '03:40', '05:40')];
const days = (list) => Object.fromEntries(list.map((d) => [d, night()]));
const crew = (list) => Object.fromEntries(list.map((d) => [`night_crew:2026-08-${d}:LY6`, { value: 'single' }]));
const com = (r) => hhmm(r.comparison.filter((c) => c.column === 'COM').reduce((s, c) => s + (c.expected ?? 0), 0));
const swap = (d) => ({ [`cancelled:2026-08-${d}..2026-08-${d}:ATH`]: { value: 'voluntary_swap', link: 'none' } });

test('לילות עוקבים, והאמצעי לא בוצע: אינו נספר, ואין שאלה עליו', () => {
  const r = run(month(2026, 8, { plan: days(['10', '11', '12']), exec: days(['10', '12']) }), { answers: { ...crew(['10', '12']), ...swap('11') } });
  assert.equal(asked(r, 'night_crew:'), false);
  assert.equal(com(r), '00:00');
});

test('לילות עוקבים שכולם בוצעו: פיצוי על השלישי', () => {
  const list = ['10', '11', '12'];
  assert.equal(com(run(month(2026, 8, { plan: days(list), exec: days(list) }), { answers: crew(list) })), '02:30');
});

test('הטיסה רשומה ברומה ביום הסמוך, ואין לה נחיתה מתוכננת שם: נספרת', () => {
  const r = run(month(2026, 8, { plan: days(['10', '15', '20']), exec: days(['10', '15', '21']) }), { answers: crew(['10', '15', '21']) });
  assert.equal(com(r), '02:30');
});
