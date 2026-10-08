// היסטוריית החודשים על המכשיר (IndexedDB).
//
// לכל חודש של כל טייס (`recordKey`) נשמרים הנתונים שחולצו מהקבצים, התשובות של המשתמש וגרסת החוקים של החישוב האחרון.
// קובצי ה-PDF עצמם נשמרים בנפרד (`files`), כדי שאפשר יהיה לפתוח אותם שוב (בעל המוצר, 29/09/2026),
// ורשימת החודשים לא טוענת אותם. שום דבר לא יוצא מהמכשיר, חוץ מקובץ גיבוי שהמשתמש מוריד.
// הגדרות (`settings`) – חיבור היומן וההשלמות ממנו – אינן נכללות בגיבוי.

const DB_NAME = 'elal-compensations';
const DB_VERSION = 5;
const STORE = 'months';
const FILES = 'files'; // {key: "2026-07|52616:plan", name, bytes: ArrayBuffer}
const SETTINGS = 'settings'; // {key, value}
const KINDS = ['plan', 'exec'];
const BACKUP_FORMAT = 'elal-compensations-backup';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS, { keyPath: 'key' });
      if (e.oldVersion > 0 && e.oldVersion < 5) migrateToPilot(req.transaction);
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

/** החודש: "2026-07". */
export const monthKey = (period) => `${period.year}-${String(period.month).padStart(2, '0')}`;

/**
 * שם הטייס בקובץ, "שם משפחה שם פרטי" באותיות גדולות ובלי פסיק ("BEERY NITSAN"), או null. התכנון רושם
 * "for BEERY, NITSAN NetLine" והרומה "Employee: BEERY, NITSAN (…)", ושני הקבצים של אותו טייס נותנים אותו שם.
 */
export function personOf(parsed) {
  const e = parsed?.employee;
  const raw = e?.name ?? (e?.last ? `${e.last} ${e.first ?? ''}` : null);
  const name = raw?.toUpperCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  return name || null;
}

/** מספר העובד, בלי אפסים מובילים, או null: "(052616)" ברומה, "TLVELY/CREW/052616/…" בתכנון, "OPR 052616" ביומן. */
export const staffId = (raw) => (raw == null || !/^\d+$/.test(String(raw)) ? null : String(raw).replace(/^0+(?=\d)/, ''));

/** הטייס של קובץ: {staff, person}. */
export const pilotOf = (parsed) => ({ staff: staffId(parsed?.employee?.id), person: personOf(parsed) });

/** אותו טייס: לפי מספר העובד כשהוא ידוע בשניהם, ואחרת לפי השם. לא ידוע באחד מהם – לא נחשב שונה. */
export function samePilot(a, b) {
  if (a?.staff && b?.staff) return a.staff === b.staff;
  if (a?.person && b?.person) return a.person === b.person;
  return true;
}

/**
 * מפתח הרשומה: החודש ומספר העובד, "2026-09|52616". חודש נשמר לכל טייס בנפרד, לפי מספר העובד, כי שמות
 * יכולים לחזור (בעל המוצר, 08/10/2026). השם נשמר ברשומה (`person`) ומוצג בחודשים השמורים. בלי מספר
 * עובד בקבצים – השם, ובלי שניהם – החודש בלבד.
 */
export const recordKey = (period, { staff, person } = {}) => {
  const who = staff ?? person;
  return who ? `${monthKey(period)}|${who}` : monthKey(period);
};
const KEY_RE = /^\d{4}-\d{2}(\|[^:|]+)?$/;

/** מספר העובד לפי השם, מכל הרשומות שיש בהן מספר: לתכנון שנקרא לפני שמספר העובד נקרא ממנו. */
function staffByName(months) {
  const map = new Map();
  for (const m of months) {
    for (const p of [m.exec, m.plan]) {
      const { staff, person } = pilotOf(p);
      if (staff && person && !map.has(person)) map.set(person, staff);
    }
  }
  return map;
}

/**
 * הרשומה במפתח הנכון (`recordKey`), עם `staff` ו-`person`, ו-`kinds` – הקבצים שעוברים איתה. רשומה
 * מלפני ההפרדה לפי טייס (במפתח החודש) או לפי שם (במפתח השם). תכנון ורומה של שני טייסים שונים (תכנון של
 * טייס אחר הועלה לחודש פתוח) – כל קובץ לחודש של הטייס שלו, והתשובות נשארות עם הרומה.
 */
function splitByPilot(m, names = new Map()) {
  const who = (parsed) => {
    const p = pilotOf(parsed);
    return { staff: p.staff ?? names.get(p.person) ?? null, person: p.person };
  };
  const pp = who(m.plan);
  const pe = who(m.exec);
  if (m.plan && m.exec && !samePilot(pp, pe)) {
    return [
      { record: { ...m, key: recordKey(m.period, pe), ...pe, plan: null, planFile: null }, kinds: ['exec'] },
      { record: { key: recordKey(m.period, pp), period: m.period, ...pp, plan: m.plan, planFile: m.planFile, exec: null, answers: {}, parseVersion: m.parseVersion, updated: m.updated }, kinds: ['plan'] },
    ];
  }
  const pilot = { staff: pe.staff ?? pp.staff ?? m.staff ?? null, person: pe.person ?? pp.person ?? m.person ?? null };
  return [{ record: { ...m, key: recordKey(m.period, pilot), ...pilot }, kinds: KINDS }];
}

/** שדרוג מגרסה 3 או 4: החודשים והקבצים שלהם עוברים למפתח של מספר העובד (`splitByPilot`). */
function migrateToPilot(t) {
  const months = t.objectStore(STORE);
  const files = t.objectStore(FILES);
  months.getAll().onsuccess = (ev) => {
    const all = ev.target.result;
    const names = staffByName(all);
    for (const m of all) {
      const parts = splitByPilot(m, names);
      if (parts.length === 1 && parts[0].record.key === m.key) {
        months.put(parts[0].record);
        continue;
      }
      months.delete(m.key);
      for (const { record, kinds } of parts) {
        months.put(record);
        for (const kind of kinds) {
          files.get(`${m.key}:${kind}`).onsuccess = (fe) => {
            const f = fe.target.result;
            if (!f) return;
            files.delete(f.key);
            files.put({ ...f, key: `${record.key}:${kind}` });
          };
        }
      }
    }
  };
}

/**
 * רשומה שהמפתח שלה השתנה אחרי קריאה מחדש של הקבצים (תכנון שנקרא לפני שמספר העובד נקרא ממנו): עוברת,
 * עם הקבצים שלה, למפתח החדש. מחזירה את הרשומה המעודכנת.
 */
export async function rekeyMonth(record) {
  const [{ record: next }] = splitByPilot(record);
  if (next.key === record.key || await getMonth(next.key)) return Object.assign(record, next, { key: record.key });
  const files = await Promise.all(KINDS.map((kind) => getFile(record.key, kind)));
  await deleteMonth(record.key);
  await tx('readwrite', (s) => s.put(next));
  for (const [i, kind] of KINDS.entries()) if (files[i]) await putFile(next.key, kind, files[i].name, files[i].bytes);
  return Object.assign(record, next);
}

/**
 * רשומת חודש:
 * {key, period, staff, person, plan, planFile, exec, execFile, answers, rulesVersion, summary, updated}
 */
export const getMonth = (key) => tx('readonly', (s) => s.get(key));

export const listMonths = async () => {
  const all = await tx('readonly', (s) => s.getAll());
  return all.sort((a, b) => monthKey(b.period).localeCompare(monthKey(a.period)) || (a.person ?? '').localeCompare(b.person ?? ''));
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
 * שחזור מקובץ גיבוי. חודש שקיים גם על המכשיר נדרס רק אם הגרסה בגיבוי חדשה יותר. גיבוי מלפני ההפרדה לפי
 * טייס עובר למפתח החדש (`splitByPilot`).
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
  const moved = new Map(); // "2026-07:plan" בגיבוי מלפני ההפרדה לפי טייס → המפתח החדש של החודש (`splitByPilot`)
  const names = staffByName(data.months.filter((m) => m?.period));
  for (const m of data.months) {
    if (!m?.key || !KEY_RE.test(m.key) || !m.period) { counts.skipped++; continue; }
    for (const { record, kinds } of splitByPilot(m, names)) {
      for (const kind of kinds) moved.set(`${m.key}:${kind}`, record.key);
      const existing = await getMonth(record.key);
      if (existing && (existing.updated ?? '') >= (record.updated ?? '')) { counts.skipped++; continue; }
      await tx('readwrite', (s) => s.put(record));
      taken.add(record.key);
      counts[existing ? 'replaced' : 'added']++;
    }
  }
  for (const f of Array.isArray(data.files) ? data.files : []) {
    const full = String(f?.key ?? '');
    const kind = full.slice(full.lastIndexOf(':') + 1);
    const key = moved.get(full) ?? full.slice(0, full.lastIndexOf(':'));
    if (!KEY_RE.test(key) || !KINDS.includes(kind) || typeof f.data !== 'string') continue;
    if (!taken.has(key) && await getFile(key, kind)) continue;
    await putFile(key, kind, f.name ?? '', fromBase64(f.data));
    counts.files++;
  }
  return counts;
}
