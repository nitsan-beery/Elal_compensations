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
 * חזרה לבסיס אחרי המראה (רגל TLV→TLV שאחריה יוצא אותו מספר טיסה מהבסיס) היא חלק
 * מהסבב שאחריה ולא סבב נפרד (אומת: LY2367 ב-15/02/2026, הקרדיט שלה נכלל בסליפ).
 *
 * סבב שנחתך בגבול החודש מסומן: `cutAtStart` – הרגל הראשונה בחודש לא יוצאת מהבסיס;
 * `cutAtEnd` – בסוף החודש הסבב עוד לא חזר. החלק השני שלו בדוח של החודש השכן.
 */
export function buildPairings(days, domicile, getLegs) {
  const all = days.flatMap((day) => (getLegs(day) ?? []).map((leg) => ({ ...leg, date: day.date })));
  const pairings = [];
  let open = null;

  all.forEach((leg, i) => {
    if (open && leg.org === domicile && !isAirReturnOnly(open)) { closePairing(pairings, open, false); open = null; }
    if (!open) {
      open = { from: leg.date, to: leg.date, dates: [], legs: [], destinations: [] };
      if (!pairings.length && leg.org !== domicile) open.cutAtStart = true;
    }
    if (!open.dates.includes(leg.date)) open.dates.push(leg.date);
    open.to = leg.date;
    open.legs.push(leg);
    if (leg.dst && leg.dst !== domicile && !open.destinations.includes(leg.dst)) {
      open.destinations.push(leg.dst);
    }
    const next = all[i + 1];
    const airReturn = leg.org === leg.dst && next?.flight === leg.flight && next?.org === leg.org;
    if (leg.dst === domicile && !airReturn) { closePairing(pairings, open, true); open = null; }
  });
  if (open) { open.cutAtEnd = true; closePairing(pairings, open, false); }
  return pairings;
}

const isAirReturnOnly = (pairing) => pairing.legs.every((l) => l.org === l.dst);

function closePairing(pairings, pairing, closed) {
  pairing.closed = closed;
  pairing.id = `${pairing.from}..${pairing.to}:${pairing.destinations.join('-') || '?'}`;
  pairings.push(pairing);
}

/**
 * התאמה בין סבבי התכנון לסבבי הביצוע.
 * ההתאמה היא לפי חפיפת תאריכים ויעד, ואחר כך לפי חפיפת תאריכים בלבד.
 * מה שלא הותאם הוא סבב שבוטל (בתכנון) או פעילות לא מתוכננת (בביצוע).
 */
export function matchPairings(planPairings, execPairings) {
  const matched = [];
  const usedExec = new Set();

  for (const p of planPairings) {
    let hit = findExec(execPairings, usedExec, (e) => overlaps(p, e) && sameDestinations(p, e));
    let how = 'exact';
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

/** תיאור קריא של סבב, לתצוגה ולשאלות למשתמש. */
export function describePairing(p) {
  if (!p) return '—';
  const flights = p.legs.map((l) => l.flight).filter(Boolean).join('/');
  const where = p.destinations.join('-') || 'מקומי';
  const when = p.from === p.to ? dayOf(p.from) : `${dayOf(p.from)}–${dayOf(p.to)}`;
  return `${when} ${where}${flights ? ` (${flights})` : ''}`;
}

const dayOf = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7);
