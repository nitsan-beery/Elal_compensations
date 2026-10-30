// קרדיט: הבלוק המקובע (2018, הגדרות), פיצול בחצות, רגל שהמריאה אחרי חצות, ושני החריגים (טיוטה 445).
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, expected, questions } from './helpers.mjs';

test('קרדיט לפי STA פחות STD, ולא לפי הזמן בפועל', () => {
  const flights = [leg('LY541', 'TLV', 'ATH', '10:00', '12:00', { act: 130, atd: '10:20', ata: '12:30' }), leg('LY542', 'ATH', 'TLV', '13:00', '15:00')];
  const r = run(month(2026, 8, { plan: { '05': flights }, exec: { '05': flights }, values: { '05': { Credit: '04:00', Rig: '01:00' } } }));
  assert.equal(expected(r, 'Credit', 'TLV-ATH-TLV'), '04:00');
});

test('חריג: חזרה לבסיס אחרי המראה, לפי זמן הטיסה בפועל', () => {
  const back = [leg('LY571', 'TLV', 'TLV', '10:00', '10:30', { act: 25 })];
  const r = run(month(2026, 8, { exec: { '05': back } }));
  assert.equal(expected(r, 'Credit', 'TLV-TLV'), '00:25');
});

const twoStations = (act) => [leg('LY1', 'TLV', 'ATH', '10:00', '12:00'), leg('LY2', 'ATH', 'LCA', '13:00', '14:00', { act }), leg('LY3', 'LCA', 'TLV', '15:00', '16:00')];

test('חריג: רגל בין שני שדות בחו"ל, בסבב עם יותר מיעד אחד, לפי זמן הטיסה בפועל', () => {
  const flights = twoStations(75);
  const r = run(month(2026, 8, { plan: { '05': flights }, exec: { '05': flights } }));
  assert.equal(expected(r, 'Credit', 'TLV-ATH-LCA-TLV'), '04:15');
});

test('רגל שנוגעת בבסיס באותו סבב: לפי הבלוק, גם כשזמן הטיסה בפועל שונה', () => {
  const flights = [leg('LY1', 'TLV', 'ATH', '10:00', '12:00', { act: 140 }), leg('LY2', 'ATH', 'LCA', '13:00', '14:00'), leg('LY3', 'LCA', 'TLV', '15:00', '16:00', { act: 50 })];
  const r = run(month(2026, 8, { plan: { '05': flights }, exec: { '05': flights } }));
  assert.equal(expected(r, 'Credit', 'TLV-ATH-LCA-TLV'), '04:00');
});

test('השלמה ל-5 שעות על סבב קצר', () => {
  const flights = [leg('LY541', 'TLV', 'ATH', '10:00', '12:00'), leg('LY542', 'ATH', 'TLV', '13:00', '15:00')];
  const r = run(month(2026, 8, { plan: { '05': flights }, exec: { '05': flights }, values: { '05': { Rig: '01:00' } } }));
  assert.equal(expected(r, 'Rig', 'TLV-ATH-TLV'), '01:00');
  assert.deepEqual(questions(r), []);
});

test('בלי השלמה כשהסבב מעל 5 שעות', () => {
  const flights = [leg('LY541', 'TLV', 'ATH', '10:00', '13:00'), leg('LY542', 'ATH', 'TLV', '14:00', '17:00')];
  const r = run(month(2026, 8, { plan: { '05': flights }, exec: { '05': flights } }));
  assert.equal(expected(r, 'Rig', 'TLV-ATH-TLV'), null);
});

test('רגל שחוצה חצות באמצע החודש: ליום ההמראה עד חצות, והשאר ליום שאחריו', () => {
  const flights = [leg('LY541', 'TLV', 'ATH', '20:00', '22:00'), leg('LY542', 'ATH', 'TLV', '23:00', '01:00')];
  const r = run(month(2026, 8, { plan: { '05': flights }, exec: { '05': flights }, values: { '05': { Credit: '03:00' }, '06': { Credit: '01:00' } } }));
  assert.equal(expected(r, 'Credit', 'TLV-ATH-TLV'), '04:00');
});
