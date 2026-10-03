// חיבור ליומן גוגל – רשות (בעל המוצר, 03/10/2026).
//
// הנחת היסוד היא שאין יומן, ומה שחסר בקבצים נשאל כמו תמיד. משתמש שמחבר את היומן שהאורגנייזר
// (El Al Organizer) מסנכרן מהרומה מקבל ממנו השלמות בלבד: מספר הטייסים בתא בכל טיסה (הרכב הצוות)
// ושעות הכוננות. התכנון תמיד מקובץ התכנון והביצוע מהרומה, גם כשהיומן רושם משהו אחר.
//
// פרטיות: הקריאה היא מהדפדפן ישירות ל-Google Calendar API, בהרשאת קריאה בלבד. תיאור האירועים
// (שמות וטלפונים של הצוות) מפוענח בזיכרון ואינו נשמר: על המכשיר נשמרים רק מספר הטייסים לכל טיסה
// ושעות הכוננות (`parseEvents`), והם אינם נכללים בגיבוי. ספריית ההתחברות של גוגל נטענת רק
// כשמתחברים או מעדכנים, כך שמי שלא חיבר יומן אינו פונה לגוגל כלל.

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const API = 'https://www.googleapis.com/calendar/v3/';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
];
/**
 * מזהה ההתחברות (OAuth Client ID) של האפליקציה, של בעל המוצר (03/10/2026). אינו סוד. הוא מורשה רק
 * לכתובת האתר ב-GitHub Pages, וכל עוד האפליקציה במצב בדיקה בגוגל – רק למי שנוסף בה כ-Test user.
 * ריק: כל משתמש מגדיר מזהה משלו בחיבור הראשון.
 */
export const BUILTIN_CLIENT_ID = '438961798736-7ctcj9og1mpao6uumnplvaamusutiroi.apps.googleusercontent.com';
export const CLIENT_ID_PATTERN = /^[\w-]+\.apps\.googleusercontent\.com$/;
// כך מזוהה אירוע של סבב באורגנייזר, וכך מחפשים יומן שיש בו נתונים.
const SLIP_MARK = 'Slip details';
const TOKEN_KEY = 'calendar-token';

let gisPromise = null;

function loadGis() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve();
  gisPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { gisPromise = null; reject(new Error('לא ניתן לטעון את ההתחברות של גוגל. בדוק את החיבור לרשת.')); };
    document.head.append(s);
  });
  return gisPromise;
}

/** אסימון גישה שעוד בתוקף (שעה מההתחברות), לאותה לשונית בלבד. */
export function cachedToken() {
  try {
    const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? 'null');
    return t && t.exp > Date.now() + 60000 ? t.token : null;
  } catch {
    return null;
  }
}

function forgetToken() {
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* אין אחסון לשונית */ }
}

/** טעינת ספריית ההתחברות מראש, כדי שהחלון של גוגל ייפתח מיד בלחיצה. */
export function preload() {
  loadGis().catch(() => { /* תדווח בהתחברות */ });
}

/**
 * אסימון גישה מגוגל. פותח חלון של גוגל, ולכן רק בתגובה ללחיצה של המשתמש, ובלי המתנה לפניו:
 * דפדפנים (במיוחד Safari) חוסמים חלון שנפתח אחרי המתנה. `consent`: מסך ההרשאות גם אם כבר אושרו.
 * `hint`: חשבון הגוגל שכבר חובר, כדי שהחלון ייסגר לבד בלי בחירת חשבון.
 */
export function requestToken(clientId, { consent = false, hint = null } = {}) {
  if (!globalThis.google?.accounts?.oauth2) return loadGis().then(() => tokenNow(clientId, consent, hint));
  return tokenNow(clientId, consent, hint);
}

function tokenNow(clientId, consent, hint) {
  const oauth2 = globalThis.google.accounts.oauth2;
  return new Promise((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES.join(' '),
      prompt: consent ? 'consent' : '',
      ...(hint && { login_hint: hint }),
      callback: (r) => {
        if (r.error) { reject(new Error(r.error === 'access_denied' ? 'לא ניתנה הרשאה לקרוא את היומן.' : `ההתחברות לגוגל נכשלה (${r.error}).`)); return; }
        if (!oauth2.hasGrantedAllScopes(r, ...SCOPES)) { reject(new Error('לא ניתנה הרשאה לקרוא את היומן. סמן את שתי ההרשאות במסך של גוגל.')); return; }
        try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: r.access_token, exp: Date.now() + Number(r.expires_in ?? 3600) * 1000 })); } catch { /* בלי אחסון לשונית */ }
        resolve(r.access_token);
      },
      error_callback: (e) => reject(new Error(e?.type === 'popup_closed' ? 'החלון של גוגל נסגר לפני סיום ההתחברות.'
        : e?.type === 'popup_failed_to_open' ? 'הדפדפן חסם את החלון של גוגל. אפשר חלונות קופצים לאתר ונסה שוב.'
          : 'ההתחברות לגוגל נכשלה.')),
    });
    client.requestAccessToken();
  });
}

/** ביטול ההרשאה בגוגל ומחיקת האסימון מהמכשיר. */
export async function revoke() {
  const token = cachedToken();
  forgetToken();
  if (!token) return;
  try {
    await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(token)}` });
  } catch { /* הניתוק על המכשיר כבר נעשה */ }
}

async function api(token, path, params = {}) {
  const url = new URL(path, API);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    forgetToken();
    throw new Error('ההרשאה ליומן פגה. לחץ "עדכון מהיומן" כדי להתחבר שוב.');
  }
  if (!res.ok) throw new Error(`קריאת היומן נכשלה (${res.status}).`);
  return res.json();
}

async function pages(token, path, params) {
  const items = [];
  let pageToken;
  do {
    const r = await api(token, path, { ...params, pageToken });
    items.push(...(r.items ?? []));
    pageToken = r.nextPageToken;
  } while (pageToken);
  return items;
}

/** היומנים של המשתמש: {id, name, primary}. המזהה של היומן הראשי הוא כתובת חשבון הגוגל. */
export async function listCalendars(token) {
  const items = await pages(token, 'users/me/calendarList', { fields: 'items(id,summary,primary),nextPageToken', maxResults: 250 });
  return items.map((c) => ({ id: c.id, name: c.summary ?? c.id, primary: !!c.primary }));
}

/**
 * היומנים שיש בהם אירועי סבב של האורגנייזר בטווח, מהיומן שהסבב האחרון בו מאוחר ביותר.
 * לאותו משתמש יכולים להיות כמה יומנים כאלה, כל אחד לתקופה אחרת (03/10/2026: יומן ישן עם 2025
 * ויומן חדש עם 2026), ולכן נקראים כולם.
 */
export async function findOrganizerCalendars(token, calendars, timeMin, timeMax) {
  const found = [];
  for (const c of calendars) {
    try {
      const items = await pages(token, `calendars/${encodeURIComponent(c.id)}/events`, {
        q: SLIP_MARK, singleEvents: true, maxResults: 2500, fields: 'items(start),nextPageToken', timeMin, timeMax,
      });
      const latest = items.map((e) => e.start?.dateTime ?? e.start?.date ?? '').sort().at(-1);
      if (latest) found.push({ ...c, latest });
    } catch { /* יומן שאין גישה לאירועים שלו */ }
  }
  return found.sort((a, b) => b.latest.localeCompare(a.latest));
}

/**
 * ההשלמות מכל היומנים בטווח: {flights, standby} (`parseEvents`). טיסה שמופיעה בכמה יומנים נלקחת
 * מהראשון ברשימה, שהוא החדש.
 */
export async function fetchFacts(token, calendarIds, timeMin, timeMax) {
  const out = { flights: [], standby: [] };
  const seen = new Set();
  for (const id of calendarIds) {
    const items = await pages(token, `calendars/${encodeURIComponent(id)}/events`, {
      timeMin, timeMax, singleEvents: true, maxResults: 2500, fields: 'items(summary,description,start,end,status),nextPageToken',
    });
    const facts = parseEvents(items);
    for (const f of facts.flights) if (!seen.has(`${f.flight}|${f.std}`)) { seen.add(`${f.flight}|${f.std}`); out.flights.push(f); }
    for (const s of facts.standby) if (!seen.has(`${s.code}|${s.start}`)) { seen.add(`${s.code}|${s.start}`); out.standby.push(s); }
  }
  return out;
}

/**
 * מאירועי האורגנייזר רק מה שהאפליקציה צריכה, בלי שמות ובלי טלפונים:
 * - flights: לכל רגל בסבב {flight, org, dst, std (UTC), pilots}. `pilots` הוא מספר אנשי הצוות
 *   הפעילים (OPR) ברשימת ה-Cockpit של הסבב; DHD אינו נספר. null כשאין רשימה.
 * - standby: אירוע כוננות (SBY…) {code, start, end}, ב-UTC.
 * פורמט האירוע (03/10/2026): בתיאור "Cockpit:" ושורה לכל איש צוות ("OPR 012345 CAP …"), ואחר כך
 * "Slip details (UTC):" ושורה לכל רגל ("1) 0373 EKU TLV-OPO [03.08 12:05 - 03.08 18:17 , 06:12 Hrs]").
 */
export function parseEvents(items) {
  const flights = [];
  const standby = [];
  for (const ev of items ?? []) {
    if (ev.status === 'cancelled') continue;
    const desc = ev.description ?? '';
    const start = utc(ev.start?.dateTime);
    if (desc.includes(SLIP_MARK) && start) {
      const lines = desc.split(/\r?\n/);
      const pilots = cockpitCount(lines);
      const y0 = Number(start.slice(0, 4));
      const m0 = Number(start.slice(5, 7));
      for (const line of lines) {
        const m = line.match(/^\s*\d+\)\s+(\d{1,4})\s+\S+\s+([A-Z]{3})-([A-Z]{3})\s+\[(\d\d)\.(\d\d)\s+(\d\d):(\d\d)/);
        if (!m) continue;
        const [, num, org, dst, dd, mm, hh, mi] = m;
        // השנה מהאירוע; סבב שחוצה את סוף השנה.
        const year = Number(mm) < m0 - 6 ? y0 + 1 : Number(mm) > m0 + 6 ? y0 - 1 : y0;
        flights.push({ flight: `LY${Number(num)}`, org, dst, std: `${year}-${mm}-${dd}T${hh}:${mi}:00.000Z`, pilots });
      }
    } else if (/^SBY/.test(ev.summary ?? '')) {
      const s = utc(ev.start?.dateTime);
      const e = utc(ev.end?.dateTime);
      if (s && e) standby.push({ code: ev.summary.trim().split(/\s+/)[0], start: s, end: e });
    }
  }
  return { flights, standby };
}

function utc(dateTime) {
  const ms = Date.parse(dateTime ?? '');
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function cockpitCount(lines) {
  const i = lines.findIndex((l) => /^\s*Cockpit:\s*$/.test(l));
  if (i < 0) return null;
  let n = 0;
  for (const l of lines.slice(i + 1)) {
    if (!l.trim() || /:\s*$/.test(l)) break;
    if (/^\s*OPR\s+\d+\s+[A-Z]{2,3}\s/.test(l)) n++;
  }
  return n || null;
}
