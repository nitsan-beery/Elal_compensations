// מודל החודש: איחוד התכנון והביצוע לציר ימים אחד, בניית סבבים, והתאמה ביניהם.
//
// ההשוואה נעשית ברמת הסבב ולא ברמת היום, כי הקרדיט של טיסת לילה מתפצל
// בדוח הביצוע בין שני ימים.

import { isoDate, daysInMonth } from './time.js';

/** ציר הימים של החודש, עם התכנון והביצוע של כל יום זה לצד זה. */
export function buildTimeline(period, plan, exec) {
  const days = [];
  for (let d = 1; d <= daysInMonth(period.year, period.month); d++) {
    const date = isoDate(period.year, period.month, d);
    days.push({
      date,
      day: d,
      plan: plan?.days[date] ?? null,
      exec: exec?.days[date] ?? null,
    });
  }
  return days;
}

/**
 * קיבוץ רגלי טיסה לסבבים. סבב מתחיל ביציאה מהבסיס ונסגר בחזרה אליו.
 * רגל שנפתחת בבסיס בזמן שסבב פתוח סוגרת אותו קודם, כדי שתקלה בנתונים
 * לא תבלע ימים שלמים לתוך סבב אחד.
 *
 * חזרה לבסיס אחרי המראה (רגל TLV→TLV) שאחריה יוצאת טיסה מהבסיס באותו FDP היא חלק מהסבב
 * שאחריה ולא סבב נפרד: אותו מספר טיסה (אומת: LY2367 ב-15/02/2026, הקרדיט שלה נכלל בסליפ),
 * או טיסה אחרת כשהמנוחה ביניהן קצרה מ-`fdp.legalRestMin` (בעל המוצר, 28/09/2026). כך
 * ההשלמה ל-5 שעות חלה פעם אחת על כל הרגליים יחד. חזרה שאחריה אין טיסה נשארת סבב לבדה
 * (LY571 ב-15/09/2025).
 *
 * סבב שנחתך בגבול החודש מסומן: `cutAtStart` – הרגל הראשונה בחודש לא יוצאת מהבסיס, או
 * שהיא יצאה עוד בחודש הקודם (`prevMonth`, ראו markCarryIn); `cutAtEnd` – בסוף החודש
 * הסבב עוד לא חזר. החלק השני שלו בדוח של החודש השכן.
 */
export function buildPairings(days, domicile, getLegs, fdp = null) {
  const all = days.flatMap((day) => (getLegs(day) ?? []).map((leg) => ({ ...leg, date: day.date })));
  const pairings = [];
  let open = null;

  all.forEach((leg, i) => {
    if (open && leg.org === domicile && !isAirReturnOnly(open)) { closePairing(pairings, open, false); open = null; }
    if (!open) {
      open = { from: leg.date, to: leg.date, dates: [], legs: [], destinations: [] };
      if (!pairings.length && (leg.org !== domicile || leg.prevMonth)) open.cutAtStart = true;
      // סבב שהתחיל בחודש הקודם מתואר לפי התחנה שבה הוא נמצא בתחילת החודש.
      if (open.cutAtStart && leg.org !== domicile) open.destinations.push(leg.org);
    }
    if (!open.dates.includes(leg.date)) open.dates.push(leg.date);
    open.to = leg.date;
    open.legs.push(leg);
    if (leg.dst && leg.dst !== domicile && !open.destinations.includes(leg.dst)) {
      open.destinations.push(leg.dst);
    }
    const next = all[i + 1];
    const airReturn = leg.org === leg.dst && next?.org === leg.org && (next.flight === leg.flight || sameFdp(leg, next, fdp));
    if (leg.dst === domicile && !airReturn) { closePairing(pairings, open, true); open = null; }
  });
  if (open) { open.cutAtEnd = true; closePairing(pairings, open, false); }
  return pairings;
}

/**
 * דוח הביצוע חוזר ביום 1 על סבב שיצא בחודש הקודם, כולל הרגל שכבר זוכתה שם
 * (01/06/2026: LY387 יצאה ב-31/05 ומופיעה שוב ב-01/06). הסימן: TAB של 24:00 ביום 1,
 * כלומר מחוץ לבסיס מתחילת החודש, והרגל הראשונה יוצאת מהבסיס. רק הרגל הזאת מסומנת.
 */
export function markCarryIn(days, domicile) {
  const first = days[0]?.exec;
  const leg = first?.legs?.[0];
  if (!leg || leg.org !== domicile || (first.values?.TAB?.min ?? 0) < 1440) return;
  leg.prevMonth = true;
}

const isAirReturnOnly = (pairing) => pairing.legs.every((l) => l.org === l.dst);

/**
 * האם הרגל `next` יוצאת באותו FDP שבו נחתה `leg`: המנוחה ביניהן, פחות זמן ההתייצבות לפני
 * ה-STD, קצרה ממנוחה חוקית. השעות שתיהן בשעון הבסיס, כי שתי הרגליים נוגעות בו.
 */
export function sameFdp(leg, next, fdp) {
  if (!fdp) return false;
  const end = leg.ata ?? leg.sta;
  const starts = [next.std, next.atd].filter((t) => t != null);
  if (end == null || !starts.length) return false;
  const days = (Date.parse(next.date) - Date.parse(leg.date)) / 86400000;
  const rest = days * 1440 + Math.min(...starts) - (fdp.reportMin ?? 0) - end;
  return rest < fdp.legalRestMin;
}

function closePairing(pairings, pairing, closed) {
  pairing.closed = closed;
  const id = `${pairing.from}..${pairing.to}:${pairing.destinations.join('-') || '?'}`;
  // שתי טיסות סבב לאותו יעד באותו יום (שתיהן באותו FDP). המזהה משמש לתשובות שנשמרו,
  // ולכן מוסיפים סיומת רק כשיש התנגשות, והמזהים הקיימים לא משתנים.
  const same = pairings.filter((p) => p.id === id || p.id.startsWith(`${id}#`)).length;
  pairing.id = same ? `${id}#${same + 1}` : id;
  pairings.push(pairing);
}

/**
 * התאמה בין סבבי התכנון לסבבי הביצוע.
 * ההתאמה היא לפי חפיפת תאריכים ויעד, אחר כך חזרה לבסיס אחרי ההמראה של הטיסה הראשונה
 * (`air_return`), ואחר כך לפי חפיפת תאריכים בלבד.
 * מה שלא הותאם הוא סבב שבוטל (בתכנון) או פעילות לא מתוכננת (בביצוע).
 */
export function matchPairings(planPairings, execPairings) {
  const matched = [];
  const usedExec = new Set();

  for (const p of planPairings) {
    // קודם לפי מספרי הטיסות: שתי טיסות סבב לאותו יעד באותו יום (באותו FDP) נבדלות רק בהם.
    let hit = findExec(execPairings, usedExec, (e) => overlaps(p, e) && sameDestinations(p, e) && sameFlights(p, e))
      ?? findExec(execPairings, usedExec, (e) => overlaps(p, e) && sameDestinations(p, e));
    let how = 'exact';
    // הטיסה הראשונה של הסבב חזרה לבסיס אחרי ההמראה, והסבב לא הושלם: זה אותו סבב ולא החלפה.
    if (!hit) { hit = findExec(execPairings, usedExec, (e) => overlaps(p, e) && isAirReturnOnly(e) && sameFlights(p, e)); how = 'air_return'; }
    if (!hit) { hit = findExec(execPairings, usedExec, (e) => overlaps(p, e)); how = 'dates'; }
    if (hit) { usedExec.add(hit); matched.push({ plan: p, exec: hit, how }); }
    else matched.push({ plan: p, exec: null, how: 'cancelled' });
  }

  for (const e of execPairings) {
    if (!usedExec.has(e)) matched.push({ plan: null, exec: e, how: 'unplanned' });
  }

  return matched.sort((a, b) => firstDate(a).localeCompare(firstDate(b)));
}

const findExec = (execPairings, used, test) => execPairings.find((e) => !used.has(e) && test(e)) ?? null;
const firstDate = (m) => (m.plan ?? m.exec).from;
const overlaps = (a, b) => a.dates.some((d) => b.dates.includes(d));
const sameDestinations = (a, b) =>
  a.destinations.length > 0 && a.destinations.join() === b.destinations.join();
const sameFlights = (a, b) => a.legs[0]?.flight != null && a.legs[0].flight === b.legs[0]?.flight;

/**
 * תיאור קריא של סבב, לתצוגה ולשאלות למשתמש. עטוף ב-LRI/PDI (בידי-איזולציה) כדי שכמה תיאורים
 * כאלה זה לצד זה בתוך משפט עברי (למשל "X → Y", או רשימה עם פסיקים) לא יתערבבו זה בזה: בלי
 * הבידוד, הדפדפן מציג לפעמים את שני התיאורים הפוכים, ואפילו הופך את סדר התאריך בתוכם.
 */
export function describePairing(p) {
  if (!p) return '—';
  const parts = pairingParts(p);
  if (parts.length > 1) return parts.map(describePairing).join(' + ');
  const when = p.from === p.to ? dayOf(p.from) : `${dayOf(p.from)}–${dayOf(p.to)}`;
  return `⁦${when} ${describeRoute(p)}⁩`;
}

/** מסלול הסבב ומספרי הטיסות, בלי תאריכים ובלי בידוד: "TLV-BUD-TLV (LY2367/LY2368)". */
export function describeRoute(p) {
  // DH בחברה אחרת מופיע בדוח בלי מספר טיסה (DHX), ובכל זאת מזוכה: PRG→ZRH ב-28/01/2025.
  const flights = p.legs.map((l) => l.flight ?? (l.type === 'DHX' ? 'DH' : null)).filter(Boolean).join('/');
  return `${route(p) || 'מקומי'}${flights ? ` (${flights})` : ''}`;
}

/**
 * חלקי הסבב לתצוגה. חזרה לבסיס אחרי המראה שמחוברת לטיסה שאחריה היא חלק מאותו סבב בחישוב
 * (ההשלמה ל-5 שעות על כולן יחד), אבל מוצגת כסבב נפרד: TLV-TLV (LY2367) ו-TLV-BUD-TLV
 * (LY2367/LY2368) ב-15/02/2026, ולא TLV-BUD-TLV (LY2367/LY2367/LY2368) (בעל המוצר, 28/09/2026).
 */
export function pairingParts(p) {
  const parts = [];
  p.legs.forEach((leg, i) => {
    const prev = p.legs[i - 1];
    if (!prev || isAirReturnLeg(prev) !== isAirReturnLeg(leg)) parts.push([]);
    parts.at(-1).push(leg);
  });
  if (parts.length < 2) return [p];
  return parts.map((legs) => ({ from: legs[0].date, to: legs.at(-1).date, dates: [...new Set(legs.map((l) => l.date))], legs }));
}

const isAirReturnLeg = (l) => l.org != null && l.org === l.dst;

/**
 * מסלול הסבב לפי סדר הרגלים בפועל, כולל הבסיס בקצוות: TLV-SOF-TIV-TLV, לא רק היעדים.
 * רגל שהתחנה שלה אינה התחנה שבה נחתה הרגל הקודמת (מעבר לא-מתועד, כמו LCA→PFO ב-20/06/2025
 * שם הדוח מדלג ישר לרגל הבאה מ-PFO) פותחת קטע חדש, מופרד בפסיק ולא במקף: TLV-LCA, PFO-LCA-TLV
 * ולא TLV-LCA-PFO-LCA-TLV, כדי לא לרמז על טיסה שאינה בדוח.
 */
function route(p) {
  // סבב שכולו חזרה לבסיס אחרי המראה: TLV-TLV ולא רק TLV (15/09/2025 LY571).
  if (p.legs.length && isAirReturnOnly(p)) return `${p.legs[0].org}-${p.legs[0].dst}`;
  const segments = [];
  let stops = [];
  for (const l of p.legs) {
    if (stops.length && stops[stops.length - 1] !== l.org) { segments.push(stops); stops = []; }
    if (!stops.length) stops.push(l.org);
    if (stops[stops.length - 1] !== l.dst) stops.push(l.dst);
  }
  if (stops.length) segments.push(stops);
  return segments.map((s) => s.join('-')).join(', ');
}

const dayOf = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7);
