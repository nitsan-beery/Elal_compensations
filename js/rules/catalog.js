// טעינת `rules.json` וסיווג קודים.
//
// `rules.json` הוא המקור הקובע. אין ערכי פיצוי מוטמעים בקוד: הקוד מכיר `logic.id`
// בלבד, וכל סף וכל סכום מגיעים מ-`logic.params`.
//
// חוק שאינו נתמך אינו מדולג בשקט. הוא נאסף לרשימה שמוצגת למשתמש כ"דורש עדכון".

import { LOGIC, KNOWN_PARAMS } from './logic.js';

const RULES_URL = new URL('../../rules.json', import.meta.url).href;
const CACHE_KEY = 'elal.rules.cache';

/**
 * טוען את החוקים. מנסה רשת, ונופל לעותק השמור על המכשיר כדי שהאפליקציה
 * תעבוד גם בלי חיבור.
 * @returns {Promise<{data: object, source: 'network'|'cache'}>}
 */
export async function loadRules() {
  try {
    const res = await fetch(RULES_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    } catch {
      // מכסת אחסון מלאה. לא קריטי: החוקים ייטענו מהרשת בפעם הבאה.
    }
    return { data, source: 'network' };
  } catch (err) {
    const cached = safeReadCache();
    if (!cached) throw new Error(`לא ניתן לטעון את קובץ החוקים ואין עותק שמור על המכשיר. ${err.message}`);
    return { data: cached, source: 'cache' };
  }
}

function safeReadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * החוקים שהיו בתוקף בחודש שנבדק. בדיקה של חודש קודם רצה לפי החוקים
 * שהיו בתוקף אז, ולא לפי החוקים של היום.
 */
export function rulesInEffect(data, year, month) {
  const last = `${year}-${String(month).padStart(2, '0')}-28`;
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  return data.rules.filter((r) => {
    if (r.valid_from && r.valid_from > last) return false;
    if (r.valid_to && r.valid_to < first) return false;
    return true;
  });
}

/**
 * מפריד בין חוקים שהקוד יודע להריץ לבין חוקים שדורשים עדכון.
 * חוק מסומן `supported: false`, או `logic.id` שהקוד לא מכיר, נכנס ל-`unsupported`.
 */
export function partitionRules(rules) {
  const supported = [];
  const unsupported = [];
  for (const rule of rules) {
    const logic = rule.logic || {};
    if (!logic.supported) {
      unsupported.push({ rule, reason: 'מסומן בקובץ החוקים כלא נתמך' });
    } else if (!LOGIC[logic.id]) {
      unsupported.push({ rule, reason: `הקוד אינו מכיר את הלוגיקה "${logic.id}". נדרש עדכון של האפליקציה.` });
    } else {
      const unknown = Object.keys(logic.params || {}).filter((k) => !KNOWN_PARAMS[logic.id].includes(k));
      if (unknown.length) {
        unsupported.push({ rule, reason: `פרמטרים חדשים שהקוד לא מכיר: ${unknown.join(', ')}. החוק השתנה בלוגיקה ונדרש עדכון של האפליקציה.` });
      } else {
        supported.push(rule);
      }
    }
  }
  return { supported, unsupported };
}

/** כל החוקים שמשתמשים בלוגיקה מסוימת, לפי סדר הופעתם בקובץ. */
export const rulesByLogic = (rules, logicId) => rules.filter((r) => r.logic.id === logicId);

/** חוק בודד לפי מזהה. */
export const ruleById = (rules, id) => rules.find((r) => r.id === id) || null;

// ---------- קודים ----------

/**
 * סיווג קוד שנמצא בקובץ. קוד שאינו מוכר מוחזר כ-'unknown' ומוצג למשתמש,
 * ולא מנוחש ולא מדולג.
 * @returns {'relevant'|'ignored'|'ground'|'unknown'}
 */
export function classifyCode(code, codes, supportedRules) {
  if (!code) return 'unknown';
  if (codes.relevant?.includes(code)) return 'relevant';
  if (codes.ground_activity?.includes(code)) return 'ground';
  if (isIgnored(code, codes)) return 'ignored';
  // קוד שמופיע בפרמטרים של חוק נתמך נחשב מוכר גם אם אינו ברשימת `relevant`. קידומת מספיקה
  // רק בחוק שקובע כמה מגיע על היום (`credit_hours`): חוק שרק משתמש בקידומת, כמו רצף כוננות
  // שמזהה כל קוד SBY, אינו יודע מה שווה SBY_FLD, וקוד כזה נשאר לא מוכר ומוצג למשתמש
  // (החלטת בעל המוצר, 23/09/2026).
  for (const rule of supportedRules) {
    const p = rule.logic.params || {};
    if (p.plan_codes?.includes(code) || p.report_codes?.includes(code)) return 'relevant';
    if (p.credit_hours == null) continue;
    const prefixes = [...(p.plan_code_prefixes ?? []), ...(p.report_code_prefixes ?? [])];
    if (prefixes.some((x) => code.startsWith(x))) return 'relevant';
  }
  return 'unknown';
}

function isIgnored(code, codes) {
  const lists = [codes.ignored_plan_notes, codes.ignored_report_dd];
  for (const list of lists || []) {
    if (!list) continue;
    // ההערות בתכנון מגיעות לפעמים כקידומת, למשל "REQ, SIK" או "DH/123".
    if (list.some((n) => code === n || code.startsWith(n))) return true;
  }
  return false;
}

/** קוד מקוצר בדוח הביצוע → הקוד המלא כפי שהוא בתכנון. */
export function expandReportCode(code, codes) {
  const map = codes.plan_to_report || {};
  for (const [full, short] of Object.entries(map)) if (short === code) return full;
  return code;
}
