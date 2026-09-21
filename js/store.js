// היסטוריית החודשים על המכשיר (IndexedDB).
//
// לכל חודש נשמרים הנתונים שחולצו מהקבצים (לא קובצי ה-PDF עצמם), התשובות של המשתמש,
// וגרסת החוקים של החישוב האחרון. שום דבר לא יוצא מהמכשיר, חוץ מקובץ גיבוי שהמשתמש מוריד.

const DB_NAME = 'elal-compensations';
const DB_VERSION = 1;
const STORE = 'months';
const BACKUP_FORMAT = 'elal-compensations-backup';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
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

export const deleteMonth = (key) => tx('readwrite', (s) => s.delete(key));

/** כל ההיסטוריה כקובץ גיבוי, להורדה או להעברה בין מכשירים. */
export async function exportBackup() {
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exported: new Date().toISOString(),
    months: await listMonths(),
  };
}

/**
 * שחזור מקובץ גיבוי. חודש שקיים גם על המכשיר נדרס רק אם הגרסה בגיבוי חדשה יותר.
 * @returns {Promise<{added:number, replaced:number, skipped:number}>}
 */
export async function importBackup(data) {
  if (data?.format !== BACKUP_FORMAT || !Array.isArray(data.months)) {
    throw new Error('הקובץ אינו קובץ גיבוי של האפליקציה.');
  }
  const counts = { added: 0, replaced: 0, skipped: 0 };
  for (const m of data.months) {
    if (!m?.key || !/^\d{4}-\d{2}$/.test(m.key)) { counts.skipped++; continue; }
    const existing = await getMonth(m.key);
    if (existing && (existing.updated ?? '') >= (m.updated ?? '')) { counts.skipped++; continue; }
    await tx('readwrite', (s) => s.put(m));
    counts[existing ? 'replaced' : 'added']++;
  }
  return counts;
}
