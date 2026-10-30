// קרדיט: STA − STD, פיצול בחצות, רגל שהמריאה אחרי חצות.
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, expected, questions } from './helpers.mjs';

test('קרדיט לפי STA פחות STD, ולא לפי הזמן בפועל', () => {
  const flights = [leg('LY541', 'TLV', 'ATH', '10:00', '12:00', { act: 130, atd: '10:20', ata: '12:30' }), leg('LY542', 'ATH', 'TLV', '13:00', '15:00')];
  const r = run(month(2026, 8, { plan: { '05': flights }, exec: { '05': flights }, values: { '05': { Credit: '04:00', Rig: '01:00' } } }));
  assert.equal(expected(r, 'Credit', 'TLV-ATH-TLV'), '04:00');
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
