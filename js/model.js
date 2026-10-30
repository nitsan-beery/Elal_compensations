// מודל החודש: איחוד התכנון והביצוע לציר ימים אחד, בניית סבבים, והתאמה ביניהם.
//
// ההשוואה נעשית ברמת הסבב ולא ברמת היום, כי הקרדיט של טיסת לילה מתפצל
// בדוח הביצוע בין שני ימים.

import { isoDate, daysInMonth } from './time.js';
import { legTimes } from './flight-times.js';
import { stationOffset } from './airports.js';

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
 *
 * סבב שהרגל הראשונה שלו בחודש אינה יוצאת מהבסיס הוא סגירה של סבב שיצא בחודש הקודם, ולכן הוא
 * מתחיל ביום הראשון של החודש: כל הימים עד הרגל הזאת הם ימי שהייה מחוץ לבסיס (בעל המוצר,
 * 08/10/2026; 28/02/2026 LY1229 ל-BUD, והחזרה LY1366 ב-08/03). `carriedFrom` – תאריך הרגל, שממנו
 * המזהה, כדי שתשובות שנשמרו לפני כן יישארו.
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
      if (open.cutAtStart && leg.org !== domicile) {
        open.destinations.push(leg.org);
        open.carriedFrom = leg.date;
        open.from = days[0].date;
        open.dates = days.map((d) => d.date).filter((d) => d < leg.date);
      }
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
 * דוח הביצוע חוזר ביום 1 על הרגל שהמריאה ביום האחרון של החודש הקודם ונחתה אחרי חצות, ומזכה בה
 * רק את מה שאחרי חצות (01/06/2026: LY387 יצאה ב-31/05 ומופיעה שוב ב-01/06; 01/10/2026: LY374
 * מ-OPO יצאה ב-30/09). רק הרגל הראשונה ביום 1 נבדקת, ומסומנת `prevMonth`. הזיהוי, לפי הסדר
 * (בעל המוצר, 29/10/2026; טיוטה 417):
 * 1. הרומה של החודש הקודם, כשהיא שמורה (`prevExec`): אותה טיסה, מאותו מוצא לאותו יעד, ביום האחרון שלה.
 * 2. ה-TAB ביום 1, כשהוא סותר המראה ב-1 לחודש: רגל מהבסיס עם TAB של 24:00 (היית בחוץ כל היום),
 *    או רגל מחו"ל לבסיס שחוצה חצות עם TAB קטן מ-24:00 (נחתת בבית ב-1 לחודש).
 * 3. רגל מחו"ל לחו"ל שחוצה חצות (TAB של 24:00 בשני המקרים): הקרדיט ביום 1 ברומה – החלק שאחרי חצות,
 *    ועוד הרגליים שאחריה באותו יום, או החלק שלפני חצות.
 * 4. התכנון של החודש הקודם (`prev.plan`): אותה רגל ביום האחרון שלו (טיוטה 425).
 * 5. בלי הכרעה – `carryUnknown`, לבדיקה ידנית (`credit_from_scheduled`).
 *
 * @param {{period, plan, exec}|null} prev  החודש הקודם, אם הוא בחודשים השמורים.
 */
export function markCarryIn(days, domicile, prev = null) {
  const day = days[0];
  const exec = day?.exec;
  const leg = exec?.legs?.[0];
  const date = day?.date ?? exec?.date;
  if (!leg || !date?.endsWith('-01')) return;
  const carried = carriedIn(leg, exec, date, domicile, prev?.exec ?? null) ?? (plannedInto(prev, days, domicile, leg) || null);
  if (carried) leg.prevMonth = true;
  else if (carried == null) leg.carryUnknown = true;
}

function carriedIn(leg, exec, date, domicile, prevExec) {
  const last = prevExec?.days?.[new Date(Date.parse(date) - 86400000).toISOString().slice(0, 10)];
  if (last) return (last.legs ?? []).some((l) => l.flight === leg.flight && l.org === leg.org && l.dst === leg.dst);
  const tab = exec.values?.TAB?.min;
  if (leg.org === domicile) return (tab ?? 0) >= 1440;
  const split = midnightSplit(leg, date, domicile);
  if (split === false) return false; // נחתה לפני חצות: המריאה ב-1 לחודש
  if (leg.dst === domicile && tab != null) return tab < 1440;
  const credit = exec.values?.Credit?.min;
  if (!split || credit == null) return null;
  const others = exec.legs.slice(1).reduce((sum, l) => sum + ((l.org === domicile || l.dst === domicile ? l.skdDur : l.actDur ?? l.skdDur) ?? 0), 0);
  const near = (a, b) => Math.abs(a - b) <= 1;
  const after = near(credit, split.after + others);
  const before = near(credit, split.before);
  return after === before ? null : after;
}

const sameLeg = (a, b) => a.flight === b.flight && a.org === b.org && a.dst === b.dst;

/** הסבב האחרון בקובץ של החודש הקודם, והאם הרגל האחרונה שלו ביום האחרון של אותו חודש. */
function lastPairingOf(monthDays, domicile, getLegs, firstOfMonth) {
  const pairing = buildPairings(monthDays, domicile, getLegs).at(-1) ?? null;
  const lastDay = new Date(Date.parse(firstOfMonth) - 86400000).toISOString().slice(0, 10);
  return pairing ? { pairing, onLastDay: pairing.legs.at(-1).date === lastDay } : null;
}

const prevPlanLast = (prev, days, domicile) => (prev?.plan && days[0]?.date
  ? lastPairingOf(buildTimeline(prev.period, prev.plan, null), domicile, (d) => d.plan?.legs, days[0].date) : null);

/** בתכנון של החודש הקודם הרגל הזאת היא האחרונה ביום האחרון שלו. */
function plannedInto(prev, days, domicile, leg) {
  const last = prevPlanLast(prev, days, domicile);
  return !!last?.onLastDay && sameLeg(last.pairing.legs.at(-1), leg);
}

/**
 * הסבב הראשון בחודש שהתחיל בחודש הקודם מקבל את הרגליים שלו משם: `prevLegs`, בלי הרגל שהרומה חוזרת עליה
 * ביום 1 (היא כבר ב-`legs`), ו-`carriedSource` – 'exec' או 'plan'. הרומה של החודש הקודם מכריעה. התכנון רק רמז:
 * הוא שונה לא פעם ממה שבוצע (03/2026 BUD לא תוכנן; 09/2025 ATH ו-05/2026 BUD שונו), ולכן הוא נלקח רק
 * כשהוא מתאים לרגל הראשונה בחודש. בלי שניהם השדות חסרים (בעל המוצר, 30/10/2026, טיוטה 425).
 */
export function attachCarried(pairing, days, domicile, prev = null) {
  if (!pairing?.cutAtStart || !days[0]?.date) return;
  const first = pairing.legs[0];
  const fits = ({ pairing: last, onLastDay }, strict) => onLastDay &&
    (sameLeg(last.legs.at(-1), first) || (last.cutAtEnd && (!strict || last.legs.at(-1).dst === first.org)));
  const rome = prev?.exec
    ? lastPairingOf(Object.values(prev.exec.days).sort((a, b) => a.date.localeCompare(b.date)), domicile, (d) => d.legs, days[0].date) : null;
  const planned = prev?.exec ? null : prevPlanLast(prev, days, domicile);
  const found = rome ? (fits(rome, false) ? rome : null) : planned && fits(planned, true) ? planned : null;
  if (!found) return;
  pairing.prevLegs = found.pairing.legs.filter((l) => !sameLeg(l, first));
  pairing.carriedSource = rome ? 'exec' : 'plan';
}

/**
 * סבב שלא חזר בסוף החודש מקבל את הרגליים שלו מהחודש הבא, כשהוא שמור: `nextLegs`, בלי הרגל שהרומה הבאה חוזרת עליה
 * (היא כבר ב-`legs`), ו-`nextSource` – 'exec' או 'plan'. הרומה הבאה מכריעה, ובלעדיה התכנון הבא. `side`: 'plan' לסבב מתוכנן,
 * שנשען רק על התכנון הבא (בעל המוצר, 30/10/2026, טיוטה 438).
 */
export function attachNext(pairing, domicile, next, side) {
  if (!pairing?.cutAtEnd || !next) return;
  const source = side === 'exec' && next.exec ? 'exec' : 'plan';
  if (!next[source]) return;
  const days = buildTimeline(next.period, next.plan, next.exec);
  const first = buildPairings(days, domicile, (d) => d[source]?.legs)[0];
  const last = pairing.legs.at(-1);
  if (!first || !(sameLeg(first.legs[0], last) || first.legs[0].org === last.dst)) return;
  pairing.nextLegs = first.legs.filter((l) => !sameLeg(l, last));
  pairing.nextSource = source;
}

/**
 * הסבב כולו, כולל מה שטס בחודש הקודם (`prevLegs`, והרגל שהרומה חוזרת עליה ב-1 לחודש), כשיש בו את היציאה
 * מהבסיס. בלעדיה – הסבב כמו שהוא, מתחילת החודש (בעל המוצר, 30/10/2026, טיוטה 428).
 */
export function wholePairing(pairing, domicile) {
  if (!pairing.cutAtStart) return pairing;
  const legs = [...(pairing.prevLegs ?? []), ...pairing.legs];
  if (legs[0].org !== domicile) return pairing;
  const from = legs[0].prevMonth ? new Date(Date.parse(legs[0].date) - 86400000).toISOString().slice(0, 10) : legs[0].date;
  return { ...pairing, legs, cutAtStart: false, from };
}

/**
 * החלוקה של הרגל בחצות בשעון הבסיס: `before` מההמראה בפועל (ובלעדיה המתוכננת) עד חצות, ו-`after`
 * השאר מתוך הקרדיט שלה. false כשאינה חוצה חצות, לא לפי התכנון ולא בפועל (המריאה לפניו ונחתה אחריו בגלל איחור;
 * בעל המוצר, 30/10/2026, טיוטה 430), null כשאי אפשר לדעת.
 */
function midnightSplit(leg, date, domicile) {
  if (leg.std == null || leg.skdDur == null) return null;
  let depBase;
  if (leg.dst === domicile) {
    if (leg.sta == null) return null;
    depBase = mod(leg.sta - leg.skdDur, 1440);
  } else {
    const off = stationOffset(leg.org, date, domicile);
    if (off == null) return null;
    depBase = mod(leg.std - off, 1440);
  }
  const dur = leg.dst === domicile ? leg.skdDur : leg.actDur ?? leg.skdDur;
  const dep = leg.atd != null ? depBase + nearest(leg.atd - leg.std) : depBase;
  if (depBase + leg.skdDur <= 1440 && (dep >= 1440 || dep + (leg.actDur ?? dur) <= 1440)) return false;
  const before = Math.min(dur, Math.max(0, 1440 - dep));
  return { before, after: dur - before };
}

const mod = (n, m) => ((n % m) + m) % m;
const nearest = (n) => mod(n + 720, 1440) - 720;

const isAirReturnOnly = (pairing) => pairing.legs.every((l) => l.org === l.dst);

/**
 * האם הרגל `next` יוצאת באותו FDP שבו נחתה `leg`: המנוחה מהשחרור אחרי הנחיתה (בפועל, ובלעדיה
 * המתוכננת) ועד ההתייצבות להמראה (המתוכננת או בפועל, המוקדמת) קצרה ממנוחה חוקית. ההתייצבות והשחרור
 * לפי OMA 7.2.1 (`fdp.reportBefore`, `fdp.releaseAfter`; `dutyTimes` ב-js/rules/legal.js). הזמנים
 * מ-`legTimes`, לפי אזורי הזמן שב-`fdp.tz`.
 */
export function sameFdp(leg, next, fdp) {
  if (!fdp?.tz) return false;
  const [a, b] = [legTimes(leg, fdp.tz), legTimes(next, fdp.tz)];
  const end = a ? a.ata ?? a.sta : null;
  if (end == null || !b) return false;
  const rest = Math.min(b.std, b.atd ?? b.std) - (fdp.reportBefore?.(next) ?? 0) - end - (fdp.releaseAfter?.(leg) ?? 0);
  return rest < fdp.legalRestMin;
}

function closePairing(pairings, pairing, closed) {
  pairing.closed = closed;
  const id = `${pairing.carriedFrom ?? pairing.from}..${pairing.to}:${pairing.destinations.join('-') || '?'}`;
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
    // סבב שיצא בחודש הקודם (`cutAtStart`) הוא רק המשך של סבב כזה בתכנון, ולא החלפה של סבב שתוכנן בימיו.
    const overlaps = (a, b) => (!b.cutAtStart || a.cutAtStart) && overlapsDates(a, b);
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
const overlapsDates = (a, b) => a.dates.some((d) => b.dates.includes(d));
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
  // עד יום הנחיתה בבסיס (`shownTo`), ולא עד יום ה-STD של הרגל האחרונה (בעל המוצר, 08/10/2026).
  const to = p.shownTo ?? p.to;
  const when = p.from === to ? dayOf(p.from) : `${dayOf(p.from)}–${dayOf(to)}`;
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
  return parts.map((legs, i) => ({ from: legs[0].date, to: legs.at(-1).date, dates: [...new Set(legs.map((l) => l.date))], legs,
    ...(i === parts.length - 1 && p.shownTo ? { shownTo: p.shownTo } : {}) }));
}

const isAirReturnLeg = (l) => l.org != null && l.org === l.dst;

/**
 * חלוקת הסבב ל-FDP: רגל שלפניה מנוחה חוקית (לא `sameFdp`) פותחת FDP חדש. הקרדיט וההשלמה
 * ל-5 שעות על הסבב כולו, אבל פיצוי (COM, ‏S/C) נרשם על ה-FDP שלו: 19–20/06/2025, ‏S/C על
 * TLV-LCA ב-19 ועל PFO-LCA-TLV ב-20, והנחיתה המאוחרת רק על השני (בעל המוצר, 29/09/2026).
 * בלי `fdp`, או כשאין מנוחה בדרך, מוחזר הסבב עצמו.
 */
export function fdpParts(p, fdp) {
  if (!fdp) return [p];
  const parts = [];
  p.legs.forEach((leg, i) => {
    if (!i || !sameFdp(p.legs[i - 1], leg, fdp)) parts.push([]);
    parts.at(-1).push(leg);
  });
  if (parts.length < 2) return [p];
  return parts.map((legs, i) => ({ from: legs[0].date, to: legs.at(-1).date, dates: [...new Set(legs.map((l) => l.date))], legs,
    ...(i === parts.length - 1 && p.shownTo ? { shownTo: p.shownTo } : {}) }));
}

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
