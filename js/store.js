// היסטוריית החודשים על המכשיר (IndexedDB).
//
// לכל חודש נשמרים הנתונים שחולצו מהקבצים, התשובות של המשתמש וגרסת החוקים של החישוב האחרון.
// קובצי ה-PDF עצמם נשמרים בנפרד (`files`), כדי שאפשר יהיה לפתוח אותם שוב (בעל המוצר, 29/09/2026),
// ורשימת החודשים לא טוענת אותם. שום דבר לא יוצא מהמכשיר, חוץ מקובץ גיבוי שהמשתמש מוריד.
// הגדרות (`settings`) – חיבור היומן וההשלמות ממנו – אינן נכללות בגיבוי.

const DB_NAME = 'elal-compensations';
const DB_VERSION = 3;
const STORE = 'months';
const FILES = 'files'; // {key: "2026-07:plan", name, bytes: ArrayBuffer}
const SETTINGS = 'settings'; // {key, value}
const KINDS = ['plan', 'exec'];
const BACKUP_FORMAT = 'elal-compensations-backup';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS, { keyPath: 'key' });
    };
    req.onsuccess = () => {
      // גרסה חדשה של המסד בלשונית אחרת: לסגור, כדי לא לחסום את השדרוג שלה.
      req.result.onversionchange = () => { req.result.close(); dbPromise = null; };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn, name = STORE) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(name, mode);
    const result = fn(t.objectStore(name));
    t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** מפתח החודש: "2026-07". */
export const monthKey = (period) => `${period.year}-${String(period.month).padStart(2, '0')}`;

/**
 * רשומת חודש:
 * {key, period, plan, planFile, exec, execFile, answers, rulesVersion, summary, updated}
 */
export const getMonth = (key) => tx('readonly', (s) => s.get(key));

export const listMonths = async () => {
  const all = await tx('readonly', (s) => s.getAll());
  return all.sort((a, b) => b.key.localeCompare(a.key));
};

export const putMonth = (record) => tx('readwrite', (s) => s.put({ ...record, updated: new Date().toISOString() }));

export async function deleteMonth(key) {
  await tx('readwrite', (s) => s.delete(key));
  await tx('readwrite', (s) => { for (const kind of KINDS) s.delete(`${key}:${kind}`); }, FILES);
}

/**
 * ניקוי כל החודשים השמורים: הנתונים, התשובות וקובצי ה-PDF (בעל המוצר, 08/10/2026). ההגדרות (`settings`)
 * – חיבור היומן וההשלמות ממנו – נשארות.
 */
export async function clearMonths() {
  await tx('readwrite', (s) => s.clear());
  await tx('readwrite', (s) => s.clear(), FILES);
}

/** קובץ ה-PDF של חודש: {name, bytes}, או undefined כשלא נשמר (חודש שנשמר לפני שהקבצים נשמרו). */
export const getFile = (key, kind) => tx('readonly', (s) => s.get(`${key}:${kind}`), FILES);

export const putFile = (key, kind, name, bytes) =>
  tx('readwrite', (s) => s.put({ key: `${key}:${kind}`, name, bytes: new Uint8Array(bytes).slice().buffer }), FILES);

const listFiles = () => tx('readonly', (s) => s.getAll(), FILES);

/** הגדרה שמורה, או null. */
export const getSetting = async (key) => (await tx('readonly', (s) => s.get(key), SETTINGS))?.value ?? null;
export const putSetting = (key, value) => tx('readwrite', (s) => s.put({ key, value }), SETTINGS);
export const deleteSetting = (key) => tx('readwrite', (s) => s.delete(key), SETTINGS);

/** ArrayBuffer ↔ base64, בחתיכות: `String.fromCharCode` על קובץ שלם חורג ממגבלת הארגומנטים. */
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text) {
  const s = atob(text);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

/** כל ההיסטוריה כקובץ גיבוי, להורדה או להעברה בין מכשירים, כולל קובצי ה-PDF (מגרסה 2, ב-base64). */
export async function exportBackup() {
  return {
    format: BACKUP_FORMAT,
    version: 2,
    exported: new Date().toISOString(),
    months: await listMonths(),
    files: (await listFiles()).map((f) => ({ key: f.key, name: f.name, data: toBase64(f.bytes) })),
  };
}

/**
 * שחזור מקובץ גיבוי. חודש שקיים גם על המכשיר נדרס רק אם הגרסה בגיבוי חדשה יותר.
 * קובץ PDF משוחזר עם החודש שלו, או כשאין במכשיר קובץ לאותו חודש (חודש שנשמר לפני שהקבצים
 * נשמרו). גיבוי מגרסה 1 אינו מכיל קבצים.
 * @returns {Promise<{added:number, replaced:number, skipped:number, files:number}>}
 */
export async function importBackup(data) {
  if (data?.format !== BACKUP_FORMAT || !Array.isArray(data.months)) {
    throw new Error('הקובץ אינו קובץ גיבוי של האפליקציה.');
  }
  const counts = { added: 0, replaced: 0, skipped: 0, files: 0 };
  const taken = new Set();
  for (const m of data.months) {
    if (!m?.key || !/^\d{4}-\d{2}$/.test(m.key)) { counts.skipped++; continue; }
    const existing = await getMonth(m.key);
    if (existing && (existing.updated ?? '') >= (m.updated ?? '')) { counts.skipped++; continue; }
    await tx('readwrite', (s) => s.put(m));
    taken.add(m.key);
    counts[existing ? 'replaced' : 'added']++;
  }
  for (const f of Array.isArray(data.files) ? data.files : []) {
    const [key, kind] = String(f?.key ?? '').split(':');
    if (!/^\d{4}-\d{2}$/.test(key) || !KINDS.includes(kind) || typeof f.data !== 'string') continue;
    if (!taken.has(key) && await getFile(key, kind)) continue;
    await putFile(key, kind, f.name ?? '', fromBase64(f.data));
    counts.files++;
  }
  return counts;
}
