// כלי פיתוח: החודשים של בעל המוצר מקובץ הגיבוי של האפליקציה (בעל המוצר, 01/11/2026, טיוטה 481). לא חלק מהאפליקציה.
// קובצי ה-PDF נשלפים מהגיבוי ונקראים מחדש, ולא הנתונים שחולצו בו, כדי ששינוי ב-js/pdf/ ייתפס.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** תיקיית הפרויקט ב-OneDrive, מחוץ לריפוזיטורי. `ELAL_SAMPLES` מצביע על `samples` שבתוכה. */
export const projectDir = process.env.ELAL_SAMPLES ? path.dirname(process.env.ELAL_SAMPLES)
  : path.join(os.homedir(), 'OneDrive/Code_Dev/Claude/Elal_compensations');
export const backupDir = path.join(projectDir, 'גיבוי חודשים שמורים');

/** קובץ הגיבוי שנשמר אחרון, לפי מועד השמירה ולא לפי השם, כי השם יכול להשתנות. null כשאין. */
export function newestBackup(dir = backupDir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f));
  return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
}

/** מספר העובד של בעל המוצר, מ-`rules.json`. */
export const ownerStaff = (rulesData) => rulesData.rules.map((r) => r.logic?.params?.slip_owner_staff).find(Boolean);

/** החודשים של העובד בגיבוי: 'YYYY-MM' → { period, plan, exec, answers }, כש-`plan` ו-`exec` הם קובצי ה-PDF. */
export function ownerMonths(file, staff) {
  const { months, files } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pdf = (key, kind) => {
    const f = files.find((x) => x.key === `${key}:${kind}`);
    return f ? Buffer.from(f.data, 'base64') : null;
  };
  return new Map(months.filter((m) => m.staff === String(staff)).map((m) => [m.key.split('|')[0],
    { period: m.period, plan: pdf(m.key, 'plan'), exec: pdf(m.key, 'exec'), answers: m.answers ?? {} }]));
}
