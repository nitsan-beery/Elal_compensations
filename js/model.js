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
 */
export function buildPairings(days, domicile, getLegs) {
  const pairings = [];
  let open = null;

  for (const day of days) {
    const legs = getLegs(day) ?? [];
    for (const leg of legs) {
      if (open && leg.org === domicile) closePairing(pairings, open, false);
      if (!open) open = { from: day.date, to: day.date, dates: [], legs: [], destinations: [] };
      if (!open.dates.includes(day.date)) open.dates.push(day.date);
      open.to = day.date;
      open.legs.push({ ...leg, date: day.date });
      if (leg.dst && leg.dst !== domicile && !open.destinations.includes(leg.dst)) {
        open.destinations.push(leg.dst);
      }
      if (leg.dst === domicile) { closePairing(pairings, open, true); open = null; }
    }
  }
  if (open) closePairing(pairings, open, false);
  return pairings;
}

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
