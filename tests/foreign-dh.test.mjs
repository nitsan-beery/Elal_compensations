// סבב לניו יורק שממשיך ב-DH בחברה זרה, וטיסה מעל 12 שעות (טיוטה 446). בכל התרחישים אותו שעון, כי רק הפערים נבדקים.
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, asked, expected } from './helpers.mjs';

const NY = 'new_york_rest:';
const out = () => leg('LY3', 'TLV', 'JFK', '10:00', '18:00');
const home = (org = 'JFK', extra = {}) => leg('LY4', org, 'TLV', '20:00', '23:30', extra);
const toLax = (std = '20:00', sta = '23:00') => leg('AA1', 'JFK', 'LAX', std, sta, { dh: true });
const both = (days) => month(2026, 8, { plan: days, exec: days });

test('סליפ לניו יורק ובחזרה, מנוחה קצרה: נשאל', () => {
  assert.equal(asked(run(both({ '05': [out()], '06': [home()] })), NY), true);
});

test('DH בחזרה מניו יורק לבסיס נספר', () => {
  assert.equal(asked(run(both({ '05': [out()], '06': [home('JFK', { dh: true })] })), NY), true);
});

test('קישור ישיר בניו יורק, בלי לינה: לא נשאל', () => {
  assert.equal(asked(run(both({ '05': [out(), toLax()], '07': [home('LAX')] })), NY), false);
});

test('לינה בניו יורק וממשיך ב-DH ללוס אנג\'לס: לא נשאל', () => {
  assert.equal(asked(run(both({ '05': [out()], '06': [toLax()], '08': [home('LAX')] })), NY), false);
});

test('חזרה מלוס אנג\'לס דרך ניו יורק: לא נשאל', () => {
  const back = leg('AA2', 'LAX', 'JFK', '08:00', '12:00', { dh: true });
  assert.equal(asked(run(both({ '05': [leg('LY5', 'TLV', 'LAX', '10:00', '22:00')], '07': [back], '08': [home()] })), NY), false);
});

test('בתכנון לבד: 5 שעות רק על סליפ לניו יורק', () => {
  const com = (r) => (r.expectations ?? []).filter((e) => e.key === 'com').length;
  assert.equal(com(run(both({ '05': [out()], '06': [home()] }), { planOnly: true })), 1);
  assert.equal(com(run(both({ '05': [out()], '06': [toLax()], '08': [home('LAX')] }), { planOnly: true })), 0);
});

const longOut = () => leg('LY3', 'TLV', 'JFK', '06:00', '18:00');

test('טיסה מעל 12 שעות: DH בחברה זרה אינו נספר', () => {
  const r = run(both({ '05': [longOut(), toLax()], '07': [home('LAX')] }));
  assert.equal(expected(r, 'COM', 'JFK'), null);
});

test('גם DH שהרומה רשמה בלי מספר טיסה (DHX)', () => {
  const m = both({ '05': [longOut(), toLax()], '07': [home('LAX')] });
  Object.assign(m.exec.days['2026-08-05'].legs[1], { type: 'DHX', flight: null, dhd: 'D' });
  assert.equal(expected(run(m), 'COM', 'JFK'), null);
});

test('בתכנון לבד, DH בחברה זרה אינו נספר', () => {
  const r = run(both({ '05': [longOut(), toLax()], '07': [home('LAX')] }), { planOnly: true });
  assert.equal((r.expectations ?? []).filter((e) => e.key === 'com').length, 0);
});

test('DH בטיסת אל על נספר (פרשנות בעל המוצר, 21/09/2026)', () => {
  const legs = [leg('LY1', 'TLV', 'DME', '06:00', '12:30'), leg('LY2', 'DME', 'TLV', '13:30', '20:00', { dh: true })];
  assert.equal(expected(run(both({ '05': legs })), 'COM', 'DME'), '02:30');
});

test('הלוך-חזור מעל 12 שעות: 02:30', () => {
  const legs = [leg('LY1', 'TLV', 'DME', '06:00', '12:30'), leg('LY2', 'DME', 'TLV', '13:30', '19:45')];
  assert.equal(expected(run(both({ '05': legs })), 'COM', 'DME'), '02:30');
});
