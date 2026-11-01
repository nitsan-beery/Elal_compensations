// חודשי בעל המוצר מקובץ הגיבוי (טיוטה 481). נתונים סינתטיים בתיקייה זמנית.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newestBackup, ownerMonths } from '../tools/backup.mjs';

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'elal-backup-'));
const write = (dir, name, minutesAgo, body = '{}') => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  const t = new Date(Date.now() - minutesAgo * 60000);
  fs.utimesSync(file, t, t);
  return file;
};
const b64 = (s) => Buffer.from(s).toString('base64');
const backup = (dir) => write(dir, 'b.json', 0, JSON.stringify({
  months: [
    { key: '2026-09|1', staff: '1', period: { year: 2026, month: 9 }, answers: { 'a:1': { value: 'x' } } },
    { key: '2026-10|1', staff: '1', period: { year: 2026, month: 10 }, answers: {} },
    { key: '2026-09|2', staff: '2', period: { year: 2026, month: 9 }, answers: {} },
  ],
  files: [
    { key: '2026-09|1:plan', name: 'p.pdf', data: b64('plan-9') },
    { key: '2026-09|1:exec', name: 'e.pdf', data: b64('exec-9') },
    { key: '2026-10|1:plan', name: 'p.pdf', data: b64('plan-10') },
    { key: '2026-09|2:plan', name: 'p.pdf', data: b64('other') },
  ],
}));

test('הגיבוי האחרון לפי מועד השמירה, ולא לפי השם', () => {
  const dir = folder();
  write(dir, 'zzz-old.json', 60);
  const latest = write(dir, 'aaa-new.json', 1);
  assert.equal(newestBackup(dir), latest);
});

test('גיבוי בלי תאריך בשם, ושם שהשתנה', () => {
  const dir = folder();
  write(dir, 'elal-compensations-backup-2026-11-01.json', 60);
  const latest = write(dir, 'גיבוי ידני.json', 1);
  assert.equal(newestBackup(dir), latest);
});

test('קובץ שאינו JSON אינו נספר', () => {
  const dir = folder();
  const only = write(dir, 'b.json', 60);
  write(dir, 'notes.txt', 1);
  assert.equal(newestBackup(dir), only);
});

test('תיקייה בלי גיבוי: null', () => {
  assert.equal(newestBackup(folder()), null);
});

test('רק החודשים של בעל המוצר, עם קובצי ה-PDF והתשובות', () => {
  const months = ownerMonths(backup(folder()), '1');
  assert.deepEqual([...months.keys()].sort(), ['2026-09', '2026-10']);
  const m = months.get('2026-09');
  assert.equal(m.plan.toString(), 'plan-9');
  assert.equal(m.exec.toString(), 'exec-9');
  assert.deepEqual(m.answers, { 'a:1': { value: 'x' } });
  assert.deepEqual(m.period, { year: 2026, month: 9 });
});

test('חודש בלי רומה: exec ריק', () => {
  assert.equal(ownerMonths(backup(folder()), '1').get('2026-10').exec, null);
});
