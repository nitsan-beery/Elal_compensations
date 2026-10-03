// מגבלות החוק על התכנון: זמן טיסה, FDP ומנוחה (OMA חלק A, פרק 7.2; `legal_limits` ב-rules.json).
//
// הבדיקה רצה על קובץ התכנון בלבד (בעל המוצר, 03/10/2026): בביצוע החוק מתיר הארכה בנסיבות לא
// צפויות (7.2.10), ואין לה סימון בקבצים. חריגה מוצגת באדום. אין כאן אף ערך: כולם מ-`legal_limits`.
//
// המודל: כל פעילות בתכנון – רגל, רגל DH, פעילות קרקע, כוננות קצרה או בשדה – היא תפקיד, עם התחלה
// ושחרור. שני תפקידים שאין ביניהם מנוחה חוקית (`rest_hours`, מהשחרור ועד ההתחלה הבאה) הם באותה
// תקופת תפקיד. FDP הוא תקופת תפקיד שיש בה טיסה: מתחילת התפקיד הראשון בה (התייצבות, או פעילות
// קרקע שלפני הטיסה) ועד ה-On block של הטיסה האחרונה (7.2.1). לכן מנוחה קצרה מהחוקית אינה בודקת
// את עצמה: היא מחברת שני FDP לאחד, וה-FDP המחובר נבדק מול הטבלה, וההודעה אומרת שזו הסיבה.
//
// כל הזמנים הם דקות מוחלטות בשעון הבסיס: `at(date, clock)`.

import { minToHhmm } from '../time.js';

const dayMs = 86400000;
const at = (date, clock) => Date.parse(date) / 60000 + clock;
const mod = (n, m) => ((n % m) + m) % m;
const clockOf = (abs) => mod(abs, 1440);
const dateOf = (abs) => new Date(Math.floor(abs / 1440) * dayMs).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso) + n * dayMs).toISOString().slice(0, 10);
const ddmm = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7);
const hm = (min) => minToHhmm(min);
const clockText = (abs) => minToHhmm(clockOf(abs));
const H = (hours) => Math.round(hours * 60);
const parseClock = (s) => {
  const m = String(s ?? '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

export const LEGAL_TITLE = 'מגבלות החוק (OMA 7.2)';
const CREW = { single: { label: 'בודד', pilots: 2 }, augmented: { label: 'מוגבר', pilots: 3 }, double: { label: 'כפול', pilots: 4 } };

/**
 * הגדרת המנוחה החוקית לחוקי הפיצוי שתלויים ב-FDP: המנוחה מתחילה `postMin` אחרי ה-On block
 * (תפקיד אחרי הטיסה, 7.2.1) ונגמרת בהתייצבות, שבחו"ל היא `outstationReportMin` לפני STD.
 */
export function restDefinition(limits) {
  if (!limits) return null;
  return { restMin: H(limits.rest_hours), postMin: limits.post_flight_minutes ?? 0, outstationReportMin: limits.report_minutes_outstation ?? 0 };
}

/**
 * @param {object} o
 * @param {object} o.limits      `legal_limits`
 * @param {object} o.period      החודש שנבדק
 * @param {object} o.plan        פלט parsePlan של החודש
 * @param {object|null} o.exec   הרומה של החודש, אם יש: FDP שאף טיסה בו לא בוצעה אינו נשאל ואינו
 *                               מוזכר כ"לא נבדק" (בעל המוצר, 03/10/2026)
 * @param {Array}  o.history     חודשים קודמים: [{period, plan, exec}], מהחדש לישן
 * @param {string} o.domicile
 * @param {string|null} o.fleet
 * @param {Function} o.offsetAt  (station, date) → דקות (שעון מקומי − שעון הבסיס), או null
 * @param {object} o.classify    {notDuty(code), isActivity(code), execCodes(execDay)}
 * @param {Function} o.answer    (id) → תשובה או null
 * @param {Function} o.ask       (question) → void
 * @returns {{result: object, crewIdOf: Map<string, string>}}
 */
export function checkLegalLimits(o) {
  const { limits, period, domicile } = o;
  const result = { violations: [], unchecked: [], source: limits.source };
  const crewIdOf = new Map(); // "date:flight" → מזהה שאלת הרכב הצוות של ה-FDP
  const monthStart = at(isoMonth(period), 0);
  const monthEnd = at(isoMonth(nextMonth(period)), 0);
  if (limits.valid_from && Date.parse(isoMonth(period)) < Date.parse(limits.valid_from.slice(0, 7) + '-01')) {
    result.skipped = `מגבלות החוק נבדקות מ-${limits.valid_from.slice(5, 7)}/${limits.valid_from.slice(0, 4)}, לפי גרסת ה-OMA שבידינו.`;
    return { result, crewIdOf };
  }

  const unchecked = new Set();
  const own = planDuties(o.plan, o, unchecked);
  // החודשים הקודמים: לפי הרומה, כי המגבלות חלות על מה שבוצע בפועל; בלי רומה – לפי התכנון.
  // רק חודשים רצופים לאחור נחשבים כיסוי.
  let coverStart = monthStart;
  const older = [];
  let expect = prevMonth(period);
  for (const m of o.history ?? []) {
    if (m.period.year !== expect.year || m.period.month !== expect.month) break;
    const items = m.exec ? execDuties(m.exec, o) : m.plan ? planDuties(m.plan, o, null) : null;
    if (!items) break;
    older.push(...items);
    coverStart = at(isoMonth(m.period), 0);
    expect = prevMonth(m.period);
  }
  const seen = new Set();
  const items = [...older, ...own].filter((it) => {
    const k = `${it.kind}|${it.flight ?? it.code}|${it.std ?? it.start}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  for (const it of items) setTimes(it, o);
  items.sort((a, b) => a.start - b.start);

  const chains = buildChains(items, H(limits.rest_hours));
  const inMonth = (t) => t >= monthStart && t < monthEnd;
  const flag = (date, message) => result.violations.push({ date, message });

  // ---- כל FDP: זמן טיסה, משך ה-FDP ומספר הרגליים, לפי הרכב הצוות ----
  acclimatize(chains, o);
  const flown = flownTest(o.exec);
  for (const ch of chains) {
    if (!ch.flights.length) continue;
    const first = ch.flights[0];
    const id = `crew:${first.date}:${first.flight}`;
    for (const f of ch.flights) crewIdOf.set(`${f.date}:${f.flight}`, id);
    if (!inMonth(ch.fdpStart)) continue;
    checkFdp(ch, id, flown(ch) ? o : { ...o, ask: () => {} }, flag);
  }
  // ה-FDP הראשון התחיל בחודש הקודם, וה-FDP האחרון נמשך לחודש הבא: חלק מהם אינו בקבצים.
  const firstFdp = chains.find((c) => c.flights.length && c.release > monthStart);
  if (firstFdp && flown(firstFdp) && coverStart === monthStart && firstFdp.flights[0].org !== domicile && firstFdp.fdpStart < monthStart + 1440) {
    unchecked.add(`ה-FDP של ${ddmm(firstFdp.flights[0].date)} ${firstFdp.flights[0].flight} התחיל בחודש הקודם, שאינו בהיסטוריה`);
  }
  const lastFdp = [...chains].reverse().find((c) => c.flights.length);
  if (lastFdp && flown(lastFdp) && lastFdp.flights.at(-1).dst !== domicile && lastFdp.end > monthEnd - 1440) {
    unchecked.add(`ה-FDP של ${ddmm(lastFdp.flights.at(-1).date)} ${lastFdp.flights.at(-1).flight} נמשך לחודש הבא`);
  }

  // מגבלה שהחלון שלה מתחיל לפני החודש, ובלי החודשים האלה בהיסטוריה אין חריגה: שורה אחת לכולן.
  const needsHistory = [];
  checkReserve(chains, limits, inMonth, flag);
  checkDeadheadRest(chains, o, inMonth, flag);
  checkFreeTime(chains, limits, inMonth, coverStart, needsHistory, flag);
  checkLongTripRest(chains, o, inMonth, flag);
  checkConsecutiveNights(chains, limits, inMonth, flag);
  checkCumulative(chains, items, limits, inMonth, coverStart, needsHistory, flag);
  if (needsHistory.length) unchecked.add(`${needsHistory.join(', ')}: תלוי בחודשים קודמים שאינם בהיסטוריה`);

  result.violations.sort((a, b) => a.date.localeCompare(b.date));
  result.unchecked = [...unchecked];
  return { result, crewIdOf };
}

// ---------- התפקידים מהקבצים ----------

/**
 * האם FDP מהתכנון בוצע: בלי רומה – כן; עם רומה – אם אחת הטיסות שלו רשומה בה, באותו יום או ביום
 * שלידו (הרומה רושמת את הרגל ביום ה-STD בשעון הבסיס).
 */
function flownTest(exec) {
  if (!exec) return () => true;
  const flights = new Set();
  for (const day of Object.values(exec.days)) {
    for (const leg of day.legs ?? []) if (leg.flight) flights.add(`${day.date}:${leg.flight}`);
  }
  const near = (date, k) => new Date(Date.parse(date) + k * 864e5).toISOString().slice(0, 10);
  return (ch) => ch.flights.some((f) => [-1, 0, 1].some((k) => flights.has(`${near(f.date, k)}:${f.flight}`)));
}

/** תפקידים מקובץ תכנון: רגליים, ופעילויות עם שעות. קוד פעילות בלי שעות מקבל את שעות ברירת המחדל. */
function planDuties(plan, o, unchecked) {
  const { limits, domicile, offsetAt, classify } = o;
  const out = [];
  const note = (s) => unchecked?.add(s);
  for (const day of Object.values(plan.days).sort((a, b) => a.date.localeCompare(b.date))) {
    for (const leg of day.legs) {
      if (!leg.dep || !leg.arr) { note(`${ddmm(day.date)} ${leg.flight}: חסרות שעות בתכנון`); continue; }
      const offDep = leg.dep.foreign ? offsetAt(leg.org, day.date) : 0;
      const offArr = leg.arr.foreign ? offsetAt(leg.dst, day.date) : 0;
      if (offDep == null || offArr == null) {
        note(`${ddmm(day.date)} ${leg.flight}: ${offDep == null ? leg.org : leg.dst} אינו בטבלת אזורי הזמן`);
        continue;
      }
      // הרגל רשומה ביום ההמראה בשעון הבסיס, ולכן ההמרה נשארת באותו יום.
      const depBase = mod(leg.dep.min - offDep, 1440);
      const std = at(day.date, depBase);
      const block = mod(leg.arr.min - offArr - depBase, 1440);
      out.push({ kind: leg.dh ? 'dh' : 'flight', date: day.date, flight: leg.flight, org: leg.org, dst: leg.dst, ac: leg.ac, std, sta: std + block, block });
    }
    for (const code of day.codes) {
      const kind = reserveKind(code, limits);
      if (kind === 'long' || (!kind && classify.notDuty(code))) continue;
      const t = day.codeTimes?.[code];
      if (t?.dep && t?.arr) {
        const station = t.org ?? domicile;
        const off = (x) => (x.foreign ? offsetAt(station, day.date) : 0);
        if (off(t.dep) == null || off(t.arr) == null) { note(`${ddmm(day.date)} ${code}: ${station} אינו בטבלת אזורי הזמן`); continue; }
        const s = mod(t.dep.min - off(t.dep), 1440);
        const start = at(day.date, s);
        out.push({ kind: kind ?? 'ground', date: day.date, code, station, start, end: start + mod(t.arr.min - off(t.arr) - s, 1440) });
      } else if (kind) {
        note(`${ddmm(day.date)} ${code}: אין שעות לכוננות בתכנון`);
      } else if (classify.isActivity(code)) {
        out.push(defaultGround(day.date, code, limits, domicile));
      }
    }
  }
  return out;
}

/**
 * תפקידים מרומת ביצוע של חודש קודם: הזמנים בפועל (ATD ו-ActDur), ובלעדיהם המתוכננים. השעות
 * מקומיות, והרגל רשומה ביום ההמראה בשעון הבסיס. לפעילות קרקע אין שעות ברומה.
 */
function execDuties(exec, o) {
  const { limits, domicile, offsetAt, classify } = o;
  const out = [];
  for (const day of Object.values(exec.days)) {
    for (const leg of day.legs ?? []) {
      const actual = leg.atd != null && leg.actDur != null;
      const dep = actual ? leg.atd : leg.std;
      const dur = actual ? leg.actDur : leg.skdDur;
      if (dep == null || dur == null || !leg.org) continue;
      const off = offsetAt(leg.org, day.date);
      if (off == null) continue;
      const std = at(day.date, mod(dep - off, 1440));
      out.push({ kind: leg.type === 'LEG' ? 'flight' : 'dh', date: day.date, flight: leg.flight ?? leg.type, org: leg.org, dst: leg.dst, ac: null, std, sta: std + dur, block: dur });
    }
    for (const sim of day.sims ?? []) {
      if (sim.std == null || sim.sta == null) continue;
      const off = offsetAt(sim.org ?? domicile, day.date) ?? 0;
      const start = at(day.date, mod(sim.std - off, 1440));
      out.push({ kind: 'ground', date: day.date, code: 'SIM', station: sim.org ?? domicile, start, end: start + mod(sim.sta - sim.std, 1440) });
    }
    for (const code of classify.execCodes(day)) {
      if (code === 'SIM' && day.sims?.length) continue;
      const kind = reserveKind(code, limits);
      if (kind === 'long' || kind) continue; // לכוננות ברומה אין שעות
      if (classify.isActivity(code)) out.push(defaultGround(day.date, code, limits, domicile));
    }
  }
  return out;
}

function defaultGround(date, code, limits, domicile) {
  const d = limits.default_ground_duty;
  const s = parseClock(d.from);
  const e = parseClock(d.to);
  return { kind: 'ground', date, code, station: domicile, start: at(date, s), end: at(date, s) + mod(e - s, 1440), assumed: true };
}

function reserveKind(code, limits) {
  const has = (list) => (list ?? []).some((c) => code === c || code === c.slice(0, 5));
  if (has(limits.airport_reserve_codes)) return 'airport';
  if (has(limits.short_call_reserve_codes)) return 'rap';
  if (has(limits.long_call_reserve_codes)) return 'long';
  return null;
}

/**
 * התחלת התפקיד והשחרור ממנו. טיסה: התייצבות לפני STD (בבסיס לפי הצי, בחו"ל `report_minutes_outstation`),
 * ושחרור `post_flight_minutes` אחרי ה-On block. DH: מ-`deadhead_report_minutes` לפני STD ועד ה-On block.
 */
function setTimes(it, o) {
  const { limits, domicile, fleet } = o;
  if (it.kind === 'flight') {
    it.start = it.std - reportMinutes(it, o);
    it.release = it.sta + (limits.post_flight_minutes ?? 0);
    it.station = it.org;
  } else if (it.kind === 'dh') {
    it.start = it.std - (limits.deadhead_report_minutes ?? 0);
    it.release = it.sta;
    it.station = it.org;
  } else {
    it.release = it.end;
  }
  it.ac ??= fleet;
  it.station ??= domicile;
}

/** זמן ההתייצבות לפני STD (7.2.1, Report Time). */
function reportMinutes(it, o) {
  const { limits, domicile, fleet, answer } = o;
  if (it.org !== domicile) return limits.report_minutes_outstation;
  const ac = it.ac ?? fleet ?? '';
  const byFleet = Object.entries(limits.report_minutes_base).find(([k]) => k !== 'default' && ac.startsWith(k));
  if (byFleet) return byFleet[1];
  // צי אחר: 90 דק', וצוות בודד בין 05:00 ל-06:30 – 60 דק'. הרכב הצוות לפי התשובה, אם ניתנה.
  const w = limits.report_single_crew_window;
  const crew = answer(`crew:${it.date}:${it.flight}`)?.value ?? answer(`night_crew:${it.date}:${it.flight}`)?.value;
  const report = clockOf(it.std - w.minutes);
  if (w && crew === 'single' && report >= parseClock(w.from) && report <= parseClock(w.to)) return w.minutes;
  return limits.report_minutes_base.default;
}

/** תקופות תפקיד: תפקידים שאין ביניהם מנוחה חוקית. `gaps`: המנוחות הקצרות שבתוכן. */
function buildChains(items, restMin) {
  const chains = [];
  let cur = null;
  let release = -Infinity;
  let last = null;
  for (const it of items) {
    if (cur && it.start - release < restMin) {
      cur.gaps.push({ prev: last, next: it, rest: it.start - release });
      cur.items.push(it);
    } else {
      cur = { items: [it], gaps: [] };
      chains.push(cur);
    }
    if (it.release >= release) { release = it.release; last = it; }
    cur.release = release;
  }
  for (const ch of chains) {
    ch.start = ch.items[0].start;
    ch.end = Math.max(...ch.items.map((i) => i.release));
    ch.flights = ch.items.filter((i) => i.kind === 'flight');
    const lastFlight = ch.flights.at(-1);
    const before = lastFlight ? ch.items.filter((i) => i.start <= lastFlight.start && i.kind !== 'rap') : [];
    ch.fdpStart = before.length ? Math.min(...before.map((i) => i.start)) : null;
    ch.fdpEnd = lastFlight?.sta ?? null;
    if (!lastFlight && ch.items.some((i) => i.kind === 'airport')) {
      // כוננות בשדה היא FDP כולה (7.2.12), גם בלי טיסה.
      ch.fdpStart = ch.start;
      ch.fdpEnd = ch.end;
    }
    ch.station = ch.items[0].station;
  }
  return chains;
}

/**
 * התאקלמות (7.2.1, Acclimated): 72 שעות באזור, או 36 שעות רצופות פנויות. אזור אחר = הפרש של
 * יותר מ-60° קו אורך; כאן לפי הפרש השעון, יותר מ-`acclimated.offset_hours` (15° לשעה), כי אין
 * קווי אורך בטבלת השדות. מנוחה של 36 שעות ומעלה בתחנה מעבירה את ההתאקלמות אליה.
 */
function acclimatize(chains, o) {
  const a = o.limits.acclimated;
  const theater = H(a.offset_hours);
  let acc = 0;
  let prev = null;
  for (const ch of chains) {
    const off = o.offsetAt(ch.station, dateOf(ch.start)) ?? 0;
    if (prev && Math.abs(off - acc) > theater && ch.start - prev.end >= H(a.free_hours)) acc = off;
    ch.acc = acc;
    ch.notAcclimated = Math.abs(off - acc) > theater;
    prev = ch;
  }
}

// ---------- FDP ----------

function tableRow(rows, clock) {
  return rows.find((r) => clock >= parseClock(r.from) && clock <= parseClock(r.to)) ?? null;
}

function restClass(ac, limits) {
  const hit = Object.entries(limits.rest_facility_class ?? {}).find(([k]) => (ac ?? '').startsWith(k));
  return hit ? hit[1] : null;
}

/** המגבלות לפי הרכב הצוות: {ft, fdp, seg}, או null כשאין מתקן מנוחה (צוות מוגבר אינו מאריך). */
function limitsFor(crew, ch, limits) {
  const report = clockOf(ch.fdpStart + ch.acc);
  const red = ch.notAcclimated ? limits.not_acclimated_reduction_minutes ?? 0 : 0;
  const seg = ch.flights.length;
  if (crew === 'single') {
    const ftRow = tableRow(limits.flight_time_unaugmented, report);
    const fdpRow = tableRow(limits.fdp_unaugmented, report);
    return { ft: H(ftRow.hours), fdp: H(fdpRow.hours[Math.min(seg, fdpRow.hours.length) - 1]) - red, seg: Infinity };
  }
  const pilots = CREW[crew].pilots;
  const cls = restClass(ch.flights[0].ac, limits);
  if (!cls) return null;
  const row = tableRow(limits.fdp_augmented, report);
  return { ft: H(limits.flight_time_augmented[String(pilots)]), fdp: H(row[`class${cls}`][pilots - 3]) - red, seg: limits.augmented_max_segments ?? Infinity };
}

function describeChain(ch) {
  const f = ch.flights;
  const days = f[0].date === f.at(-1).date ? ddmm(f[0].date) : `${ddmm(f[0].date)}–${ddmm(f.at(-1).date)}`;
  if (f.length > 4) return `${days} ${f.length} רגליים (${f[0].flight} עד ${f.at(-1).flight})`;
  const route = [f[0].org, ...f.map((l) => l.dst)].join('-');
  return `${days} ${route} (${f.map((l) => l.flight).join('/')})`;
}

function describeItem(it) {
  return it.kind === 'flight' || it.kind === 'dh' ? `${ddmm(it.date)} ${it.flight}` : `${ddmm(it.date)} ${it.code}`;
}

function checkFdp(ch, id, o, flag) {
  const { limits, answer, ask } = o;
  const ft = ch.flights.reduce((s, f) => s + f.block, 0);
  const fdp = ch.fdpEnd - ch.fdpStart;
  const seg = ch.flights.length;
  const fits = (lim) => lim && ft <= lim.ft && fdp <= lim.fdp && seg <= lim.seg;
  const crewAnswer = answer(id)?.value ?? ch.flights.map((f) => answer(`night_crew:${f.date}:${f.flight}`)?.value).find(Boolean) ?? null;
  const single = limitsFor('single', ch, limits);
  const lim = { single, augmented: limitsFor('augmented', ch, limits), double: limitsFor('double', ch, limits) };
  // מנוחה קצרה מהחוקית בתוך ה-FDP (שלוש שעות ומעלה, כלומר לא זמן קרקע בין רגליים) היא הסיבה
  // שזה FDP אחד, ולכן היא בראש ההודעה.
  const longest = [...ch.gaps].sort((a, b) => b.rest - a.rest)[0];
  const why = longest && longest.rest >= 180
    ? `מנוחה של ${hm(longest.rest)} בלבד בין ${describeItem(longest.prev)} ל-${describeItem(longest.next)} (המינימום ${hm(H(limits.rest_hours))}), ולכן זה FDP אחד: `
    : '';
  // רק מה שחורג מהמגבלה, עם המקסימום שלו (בעל המוצר, 03/10/2026).
  const over = (l, crew) => {
    const parts = [];
    if (ft > l.ft) parts.push([`זמן טיסה ${hm(ft)}`, hm(l.ft)]);
    if (fdp > l.fdp) parts.push([`FDP ${hm(fdp)}`, hm(l.fdp)]);
    if (seg > l.seg) parts.push([`${seg} רגליים`, `${l.seg} רגליים`]);
    return `${parts.map((p) => p[0]).join(' ו-')}, והמקסימום בצוות ${CREW[crew].label} ${parts.map((p) => p[1]).join(' ו-')}`;
  };
  const date = ch.flights[0].date;
  if (crewAnswer) {
    const l = lim[crewAnswer] ?? single;
    if (!fits(l)) flag(date, `${describeChain(ch)}: ${why}${over(l, lim[crewAnswer] ? crewAnswer : 'single')}.`);
    return;
  }
  if (fits(single)) return;
  // אף הרכב אינו עומד במגבלות: ההשוואה לצוות בודד, בלי לשאול.
  if (!['augmented', 'double'].some((c) => fits(lim[c]))) {
    flag(date, `${describeChain(ch)}: ${why}${over(single, 'single')}. חורג גם בצוות מוגבר או כפול.`);
    return;
  }
  ask({
    id,
    date,
    title: `מגבלות החוק: באיזה צוות מתוכנן ${describeChain(ch)}?`,
    body: `${why}${over(single, 'single')}.`,
    options: Object.entries(CREW).map(([value, c]) => ({ value, label: `${c.label} (${c.pilots} טייסים)` })),
    ruleId: null,
    ruleTitle: LEGAL_TITLE,
  });
}

// ---------- מנוחה ----------

/** כוננות קצרה (7.2.12): עד `max_rap_hours`, מנוחה חוקית לפניה, ועם FDP אחריה – עד המגבלה המשולבת. */
function checkReserve(chains, limits, inMonth, flag) {
  const restMin = H(limits.rest_hours);
  chains.forEach((ch) => {
    ch.items.forEach((it) => {
      if (it.kind !== 'rap' || !inMonth(it.start)) return;
      if (it.end - it.start > H(limits.max_rap_hours)) {
        flag(it.date, `${describeItem(it)}: כוננות של ${hm(it.end - it.start)}, מעל ${hm(H(limits.max_rap_hours))}.`);
      }
      const gap = ch.gaps.find((g) => g.next === it);
      if (gap) flag(it.date, `${describeItem(it)}: מנוחה של ${hm(gap.rest)} בלבד לפני הכוננות, אחרי ${describeItem(gap.prev)}. המינימום ${hm(restMin)}.`);
      if (ch.fdpEnd != null && ch.fdpStart >= it.start) {
        const fdpRow = tableRow(limits.fdp_unaugmented, clockOf(ch.fdpStart + ch.acc));
        const max = Math.min(H(fdpRow.hours[Math.min(ch.flights.length, 7) - 1] + limits.rap_fdp_extra_hours), H(limits.rap_fdp_max_hours));
        if (ch.fdpEnd - it.start > max) flag(it.date, `${describeItem(it)}: כוננות ו-FDP אחריה ${hm(ch.fdpEnd - it.start)}, מעל ${hm(max)}.`);
      }
    });
  });
}

/** DH שחורג מה-FDP שבטבלה B: מנוחה באורך ה-DH, ולא פחות מהמנוחה החוקית (7.2.14). */
function checkDeadheadRest(chains, o, inMonth, flag) {
  const { limits } = o;
  chains.forEach((ch, i) => {
    const lastFlight = ch.flights.at(-1);
    const dh = ch.items.filter((it) => it.kind === 'dh' && (!lastFlight || it.std > lastFlight.std));
    const next = chains[i + 1];
    if (!dh.length || !next || !inMonth(dh[0].start)) return;
    const len = Math.max(...dh.map((d) => d.sta)) - dh[0].start;
    const row = tableRow(limits.fdp_unaugmented, clockOf(dh[0].start + ch.acc));
    if (len <= H(row.hours[0])) return;
    const need = Math.max(len, H(limits.rest_hours));
    const rest = next.start - ch.end;
    if (rest < need) {
      flag(dh[0].date, `${describeItem(dh[0])}: DH של ${hm(len)}, יותר מה-FDP המותר. נדרשת מנוחה של ${hm(need)} אחריו, ובתכנון ${hm(rest)} עד ${describeItem(next.items[0])}.`);
    }
  });
}

/** 30 שעות רצופות פנויות ב-168 השעות שלפני כל FDP או כוננות (7.2.7). */
function checkFreeTime(chains, limits, inMonth, coverStart, needsHistory, flag) {
  const need = H(limits.free_time.hours);
  const window = H(limits.free_time.window_hours);
  chains.forEach((ch, i) => {
    const isDutyStart = ch.flights.length || ch.items.some((it) => it.kind === 'rap' || it.kind === 'airport');
    if (!isDutyStart || !inMonth(ch.start)) return;
    const from = ch.start - window;
    let best = overlap(coverStart, chains[0].start, from, ch.start);
    for (let j = 0; j < i; j++) best = Math.max(best, overlap(chains[j].end, chains[j + 1].start, from, ch.start));
    if (best >= need) return;
    if (from < coverStart) {
      const name = `${limits.free_time.hours} ש' פנויות ב-${limits.free_time.window_hours} ש'`;
      if (!needsHistory.includes(name)) needsHistory.push(name);
      return;
    }
    const what = ch.flights.length ? describeChain(ch) : describeItem(ch.items[0]);
    flag(dateOf(ch.start), `${what}: ב-${limits.free_time.window_hours} השעות שלפני התפקיד המנוחה הרצופה הארוכה ביותר היא ${hm(best)}, פחות מ-${hm(need)}.`);
  });
}

/**
 * חזרה לבסיס אחרי מעבר של יותר מ-60° קו אורך ו-168 שעות מחוץ לבסיס: 56 שעות מנוחה, שכוללות 3
 * לילות (01:00–07:00) (7.2.7). קו האורך לפי הפרש השעון, כמו בהתאקלמות.
 */
function checkLongTripRest(chains, o, inMonth, flag) {
  const { limits, domicile, offsetAt } = o;
  const t = limits.long_trip_rest;
  let tripStart = null;
  let far = false;
  chains.forEach((ch, i) => {
    for (const f of ch.items.filter((it) => it.kind === 'flight' || it.kind === 'dh')) {
      if (f.org === domicile && tripStart == null) { tripStart = f.std; far = false; }
      if (tripStart != null && Math.abs(offsetAt(f.dst, f.date) ?? 0) > H(t.offset_hours)) far = true;
      if (f.dst !== domicile || tripStart == null) continue;
      const away = f.sta - tripStart;
      tripStart = null;
      const next = chains[i + 1];
      if (!far || away < H(t.away_hours) || !next || !inMonth(f.sta)) continue;
      const rest = next.start - ch.end;
      const n0 = parseClock(t.night_from);
      const n1 = parseClock(t.night_to);
      let nights = 0;
      for (let d = dateOf(ch.end); at(d, n1) <= next.start; d = addDays(d, 1)) if (at(d, n0) >= ch.end) nights++;
      if (rest < H(t.rest_hours) || nights < t.nights) {
        flag(f.date, `${describeItem(f)}: חזרה אחרי ${hm(away)} מחוץ לבסיס ומעבר של יותר מ-${t.longitude_degrees}° קו אורך. ` +
          `נדרשות ${t.rest_hours} שעות מנוחה עם ${t.nights} לילות, ובתכנון ${hm(rest)} עם ${nights} לילות.`);
      }
    }
  });
}

/**
 * FDP לילה רצופים שנוגעים בשפל הצירקדי (WOCL, 02:00–05:59 באזור ההתאקלמות; 7.2.15): עד 3 בלי
 * תנאים, עד 5 כשבכל FDP יש הזדמנות שינה של שעתיים בין 22:00 ל-05:00 אחרי הרגל הראשונה, ולא יותר.
 * הזדמנות השינה נבדקת כזמן קרקע בין שתי רגליים; אם יש שם מקום לינה מתאים – אינו בקבצים.
 */
function checkConsecutiveNights(chains, limits, inMonth, flag) {
  const w0 = parseClock(limits.wocl.from);
  const w1 = parseClock(limits.wocl.to);
  const c = limits.consecutive_nights;
  const nightOf = (ch) => {
    for (let d = dateOf(ch.fdpStart + ch.acc - 1440); d <= dateOf(ch.fdpEnd + ch.acc); d = addDays(d, 1)) {
      if (overlap(ch.fdpStart + ch.acc, ch.fdpEnd + ch.acc, at(d, w0), at(d, w1)) > 0) return d;
    }
    return null;
  };
  const nights = chains.filter((ch) => ch.flights.length).map((ch) => ({ ch, night: nightOf(ch) })).filter((n) => n.night);
  let run = [];
  const close = () => {
    if (run.length > c.free) {
      run.forEach((n, k) => {
        if (!inMonth(n.ch.fdpStart)) return;
        const desc = describeChain(n.ch);
        if (k >= c.max) {
          flag(n.ch.flights[0].date, `${desc}: ה-FDP ה-${k + 1} ברצף שנוגע בשעות ${limits.wocl.from}–${clockText(w1 - 1)}, ומותרים ${c.max} לכל היותר.`);
        } else if (!hasSleep(n.ch, c)) {
          flag(n.ch.flights[0].date, `${desc}: ${run.length} FDP רצופים שנוגעים בשעות ${limits.wocl.from}–${clockText(w1 - 1)}. ` +
            `מעל ${c.free} נדרשת בכל אחד הזדמנות שינה של ${c.sleep_hours} שעות בין ${c.sleep_from} ל-${c.sleep_to} אחרי הרגל הראשונה, וב-FDP הזה אין.`);
        }
      });
    }
    run = [];
  };
  for (const n of nights) {
    if (run.length && n.night !== addDays(run.at(-1).night, 1)) close();
    run.push(n);
  }
  close();
}

function hasSleep(ch, c) {
  const s0 = parseClock(c.sleep_from);
  const s1 = parseClock(c.sleep_to);
  const f = ch.flights;
  for (let i = 1; i < f.length; i++) {
    const a = f[i - 1].sta + ch.acc;
    const b = f[i].std + ch.acc;
    for (let d = dateOf(a - 1440); d <= dateOf(b); d = addDays(d, 1)) {
      if (overlap(a, b, at(d, s0), at(d, s0) + mod(s1 - s0, 1440)) >= H(c.sleep_hours)) return true;
    }
  }
  return false;
}

/** מגבלות מצטברות (7.2.6): זמן טיסה ו-FDP בחלון שמסתיים בסוף כל FDP. */
function checkCumulative(chains, items, limits, inMonth, coverStart, needsHistory, flag) {
  const flights = items.filter((it) => it.kind === 'flight');
  const fdps = chains.filter((ch) => ch.fdpEnd != null);
  for (const c of limits.cumulative) {
    const list = c.what === 'flight' ? flights.map((f) => [f.std, f.sta]) : fdps.map((ch) => [ch.fdpStart, ch.fdpEnd]);
    const name = `${c.what === 'flight' ? 'זמן טיסה' : 'FDP'} ${c.hours.toLocaleString('en-US')} ש' ב-${c.window_days ? `${c.window_days} ימים` : `${c.window_hours} ש'`}`;
    let missing = false;
    for (const ch of fdps) {
      if (!inMonth(ch.fdpEnd)) continue;
      const end = ch.fdpEnd;
      const from = c.window_days ? at(addDays(dateOf(end), 1 - c.window_days), 0) : end - H(c.window_hours);
      const sum = list.reduce((s, [a, b]) => s + overlap(a, b, from, end), 0);
      if (sum > H(c.hours)) {
        flag(dateOf(end), `${describeChain(ch)}: ${c.what === 'flight' ? 'זמן הטיסה' : 'סך ה-FDP'} ב-${c.window_days ? `${c.window_days} הימים` : `${c.window_hours} השעות`} שמסתיימים בנחיתה הוא ${hm(sum)}, מעל ${hm(H(c.hours))}.`);
        missing = false;
        break;
      }
      if (from < coverStart) missing = true;
    }
    // בלי החודשים הקודמים אין חריגה במה שידוע. מגבלה שמסומנת `silent_without_history` אינה
    // מוזכרת אז ב"לא נבדק" (1,000 שעות ב-365 ימים; בעל המוצר, 03/10/2026).
    if (missing && !c.silent_without_history) needsHistory.push(name);
  }
}

// ---------- חודשים ----------

const isoMonth = (p) => `${p.year}-${String(p.month).padStart(2, '0')}-01`;
const prevMonth = (p) => (p.month === 1 ? { year: p.year - 1, month: 12 } : { year: p.year, month: p.month - 1 });
const nextMonth = (p) => (p.month === 12 ? { year: p.year + 1, month: 1 } : { year: p.year, month: p.month + 1 });
