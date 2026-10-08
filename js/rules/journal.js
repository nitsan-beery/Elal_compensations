// יומן השינויים של החודש, מהיומן המחובר, לפני שהרומה מועלית (בעל המוצר, 06/10/2026; requirements.md סעיף 5.3).
//
// בכל קריאה מהיומן לפני הרומה נשמרת ברשומת החודש תמונה שלו (`calendarHistory`), כשהיא שונה מהקודמת
// ברמת הסבבים (`appendSnapshot`). השרשרת נבנית מהן מחדש בכל הרצה (`buildJournal`): מקובץ התכנון,
// דרך כל תמונה לפי הסדר. סבב שנעלם הוא שלב, והסיבה נשאלת עליו (`cancelled:<מזהה הסבב>`); תשובה
// עם קישור קובעת לאיזה סבב הוא עבר, וממנו השרשרת ממשיכה. סבב חדש שאינו המשך של שלב הוא פעילות
// שלא תוכננה (`unplanned:`). סבב כזה שנוסף בהסכמה או בזכייה במכרז הוא בסיס: שינוי בו אחר כך הוא שלב
// בשרשרת משלו (`ROOT`). שינוי שחזר למצב שלפניו יוצא מהשרשרת, יחד עם התשובה עליו (`obsolete`).
// כשהרומה מועלית, ההשוואה היא בין התכנון המקורי לרומה, והשרשרת מסבירה כל שינוי (`reduceChain`).

import { buildPairings } from '../model.js';
import { baseTime } from '../airports.js';

const dayMs = 864e5;
const shiftDate = (date, k) => new Date(Date.parse(date) + k * dayMs).toISOString().slice(0, 10);
export const overlapDays = (a, b, k = 0) => shiftDate(a.from, -k) <= b.to && b.from <= shiftDate(a.to, k);
/** מספרי הטיסות של סבב, בלי DH: בתכנון `dh`, ברומה `dhd` או DHO/DHX. */
export const pairingFlights = (p) => p.legs.filter((l) => !l.dh && !l.dhd && l.type !== 'DHO' && l.type !== 'DHX' && l.flight)
  .map((l) => l.flight).sort().join('/');
/** אותו סבב בין היומן לרומה: מספרי הטיסות זהים, או שהיעדים זהים והתאריכים חופפים, כמו בהתאמה לרומה. */
export const samePairing = (p, c) => pairingFlights(c) === pairingFlights(p) || (overlapDays(p, c) && c.destinations.join('-') === p.destinations.join('-'));

/** תשובות שמקשרות סבב לסבב אחר. */
const LINKED = ['voluntary_swap', 'replaced', 'bid'];
const GAVE_AWAY = 'none';
/**
 * תשובות על סבב חדש ביומן (`unplanned:`) שהופכות אותו לבסיס של שרשרת משלו: שינוי בו אחר כך הוא שלב
 * שנשאל, ומול הרומה הוא מושווה כמו סבב מתוכנן (בעל המוצר, 06/10/2026). הוספת טיסה בהסכמה – כאילו היה
 * בתכנון, בלי זכאות לפיצוי על ההוספה; זכייה במכרז – נוספה על התכנון, וכשבוצעה מגיעה עליה קריאה מיוחדת.
 */
export const ROOT = ['added', 'bid'];

/**
 * סבבי היומן בחודש, שנבנים מהטיסות שבו כמו סבבי התכנון, והכוננויות שבו. `first`–`last`: הטווח
 * שהיומן מכסה בחודש (מהטיסה או הכוננות הראשונה בו ועד האחרונה). null – אין ביומן נתונים מהחודש.
 * לכל רגל: זמני ההמראה והנחיתה בדקות בשעון הבסיס (`stdAbs`, `staAbs`), והמשך המתוכנן (`skdDur`),
 * כדי שאפשר יהיה לחשב את הקרדיט שלה. ביומן שנשמר לפני 06/10/2026 אין שעת נחיתה.
 */
export function calendarView(calendar, domicile, period) {
  if (!calendar || !domicile) return null;
  const month = `${period.year}-${String(period.month).padStart(2, '0')}`;
  const byDate = new Map();
  for (const f of [...(calendar.flights ?? [])].sort((a, b) => a.std.localeCompare(b.std))) {
    const t = baseTime(f.std, domicile);
    if (!t || t.date.slice(0, 7) !== month) continue;
    const end = f.sta ? baseTime(f.sta, domicile) : null;
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date).push({ flight: f.flight, org: f.org, dst: f.dst, stdAbs: t.abs, staAbs: end?.abs ?? null, skdDur: end ? end.abs - t.abs : null });
  }
  const standby = (calendar.standby ?? []).map((x) => ({ code: x.code, date: baseTime(x.start, domicile)?.date }))
    .filter((x) => x.date?.slice(0, 7) === month);
  const covered = [...byDate.keys(), ...standby.map((x) => x.date)].sort();
  if (!covered.length) return null;
  const pairings = buildPairings([...byDate.keys()].sort().map((date) => ({ date, legs: byDate.get(date) })), domicile, (d) => d.legs);
  // תיאור הסבב עד יום הנחיתה בבסיס, כמו בתכנון ובביצוע (`markLandingDays` ב-js/rules/evaluate.js).
  for (const p of pairings) {
    const leg = p.legs.at(-1);
    const landed = leg?.dst === domicile && leg.staAbs != null ? new Date(Math.floor(leg.staAbs / 1440) * 86400000).toISOString().slice(0, 10) : null;
    if (landed > p.to) p.shownTo = landed;
  }
  // תחילת הטווח שנקרא מהיומן (`from`), כשהיא ידועה: סבב בימים הראשונים של החודש שאין בהם כלום ביומן
  // ירד ממנו, ולא "עוד לא נקרא".
  const from = calendar.from ? baseTime(calendar.from, domicile)?.date : null;
  return { pairings, standby, first: from && from < covered[0] ? from : covered[0], last: covered.at(-1) };
}

/**
 * תמונה חדשה של החודש מהיומן, בסוף ההיסטוריה, כשהיא שונה מהאחרונה ברמת הסבבים: טיסה אחרת, תאריך
 * אחר או כוננות אחרת. שינוי בשעות בלבד אינו נשמר. בלי הרכב הצוות: הוא נשמר בנפרד (`calendar`).
 */
export function appendSnapshot(history, fresh) {
  const snap = {
    flights: (fresh.flights ?? []).map(({ flight, org, dst, std, sta }) => ({ flight, org, dst, std, ...(sta && { sta }) })),
    standby: (fresh.standby ?? []).map(({ code, start, end }) => ({ code, start, end })),
    ...(fresh.from && { from: fresh.from }),
  };
  const key = (c) => JSON.stringify([...(c.flights ?? []).map((f) => `${f.flight}|${f.std.slice(0, 10)}`).sort(),
    ...(c.standby ?? []).map((s) => `${s.code}|${s.start.slice(0, 10)}`).sort()]);
  const list = history ?? [];
  return list.length && key(list.at(-1)) === key(snap) ? list : [...list, snap];
}

/** שעת ההמראה של הרגל הראשונה, בדקות בשעון הבסיס: ביומן מה-STD, בתכנון כשהשעה בשעון הבסיס. */
export function firstStd(p) {
  const l = p.legs[0];
  if (!l) return null;
  if (l.stdAbs != null) return l.stdAbs;
  return l.dep && !l.dep.foreign && l.dep.min != null ? Date.parse(l.date) / 60000 + l.dep.min : null;
}

/** הרגליים של ה-FDP הראשון בסבב מהיומן: עד מנוחה של `restMin` לפחות בין נחיתה להמראה. */
export function firstFdpLegs(p, restMin) {
  const out = [];
  for (const l of p.legs) {
    const prev = out.at(-1);
    if (prev && (prev.staAbs == null || l.stdAbs == null || l.stdAbs - prev.staAbs >= restMin)) break;
    out.push(l);
  }
  return out;
}

/**
 * אותו סבב בין שתי תמונות (בעל המוצר, 06/10/2026): אותם מספרי טיסה, והזמן החדש עדיין ב-FDP המקורי
 * (`delayFits`): טיסה שהוקדמה, או שנדחתה מעבר ל-FDP, היא שינוי. בלי שעות (יומן ישן) – כשהתאריכים
 * חופפים. מספרי טיסה אחרים לאותם יעדים בתאריכים חופפים הם אותו סבב, כמו בהתאמה לרומה.
 */
export function sameAssignment(a, b, delayFits) {
  const fa = pairingFlights(a);
  if (fa && fa === pairingFlights(b)) {
    const s0 = firstStd(a);
    const s1 = firstStd(b);
    if (s0 == null || s1 == null) return overlapDays(a, b);
    if (s1 < s0) return false;
    return s1 === s0 || delayFits(a, b, s0, s1);
  }
  return overlapDays(a, b) && a.destinations.length > 0 && a.destinations.join('-') === b.destinations.join('-');
}

/**
 * השרשרת של החודש מהתכנון ומהתמונות שנשמרו (`views`: `calendarView` של כל אחת, לפי הסדר).
 * `same(a, b)`: אותו סבב (`sameAssignment`). מחזיר:
 * - `steps`: השלבים, כל אחד {id, node, fromPairing, how, candidates, answer, to, end, waiting}.
 *   `how`: moved (אותן טיסות בתאריך אחר), retimed (אותן טיסות בשעה אחרת), changed (סבב אחר באותם ימים), standby, missing.
 * - `open`: שלבים שעוד אין עליהם תשובה, או שהסבב שבקישור עוד לא ביומן.
 * - `unplanned`: סבבים ביומן שאינם המשך של שלב, עם הסבב הנוכחי שלהם. `root`: בסיס של שרשרת משלו (`ROOT`).
 * - `chains`: לכל סבב מתוכנן שהשתנה, ולכל סבב שנוסף כאילו היה בתכנון ושהשתנה (`root`) – השלבים לפי
 *   הסדר, והסבב שבו השרשרת נמצאת עכשיו (`last`).
 * - `obsolete`: מזהי שאלות של שלבים שחזרו למצב שלפניהם.
 * - `latest`: התמונה האחרונה.
 */
export function buildJournal({ planPairings, views, answers, same }) {
  const steps = [];
  const obsolete = new Set();
  const planNodes = planPairings.filter((p) => pairingFlights(p)).map((p) => ({ id: p.id, pairing: p, plan: true, from: null, step: null }));
  let live = [...planNodes];
  let open = [];
  let unplanned = [];
  const roots = [];
  // החלפה מרצון שנענתה על הסבב שביומן (`unplanned:`) וקושרה לסבב שנעלם, עונה גם על השלב שלו.
  const linkedFrom = (nodeId) => {
    const hit = Object.entries(answers).find(([id, a]) => id.startsWith('unplanned:') && LINKED.includes(a?.value) && a.link === nodeId);
    return hit ? { value: hit[1].value, link: hit[0].slice(10), via: hit[0] } : null;
  };
  const answerOf = (node) => answers[`cancelled:${node.id}`] ?? linkedFrom(node.id);
  const dropStep = (s) => {
    obsolete.add(s.id);
    s.node.step = null;
    steps.splice(steps.indexOf(s), 1);
  };

  for (const v of views) {
    const used = new Set();
    const inCov = (p) => p.to >= v.first && p.from <= v.last;
    const gone = [];
    for (const n of live) {
      if (!inCov(n.pairing)) continue;
      const c = v.pairings.find((x) => !used.has(x) && same(n.pairing, x));
      if (c) { used.add(c); n.pairing = c; } else gone.push(n);
    }
    // שינוי שחזר: שלב שעוד לא הוכרע, והסבב שלו חזר ליומן.
    open = open.filter((s) => {
      const c = v.pairings.find((x) => !used.has(x) && same(s.fromPairing, x));
      if (!c) return true;
      used.add(c);
      s.node.pairing = c;
      live.push(s.node);
      dropStep(s);
      return false;
    });
    for (const n of gone) {
      live = live.filter((x) => x !== n);
      // סבב שהופיע ביומן ונעלם, בלי שהיה המשך של שלב ובלי שנוסף כאילו היה בתכנון: לא בוצע, ואין על מה לשאול.
      if (!n.plan && !n.from && !n.root) {
        unplanned = unplanned.filter((x) => x !== n);
        continue;
      }
      // סבב שנעלם, והסבב שלפניו בשרשרת חזר: השלבים ביניהם יוצאים מהשרשרת.
      let back = null;
      for (let s = n.from; s && !back; s = s.node.from) {
        const c = v.pairings.find((x) => !used.has(x) && same(s.fromPairing, x));
        if (c) back = { s, c };
      }
      if (back) {
        for (let s = n.from; s; s = s.node.from) {
          dropStep(s);
          if (s === back.s) break;
        }
        used.add(back.c);
        back.s.node.pairing = back.c;
        live.push(back.s.node);
        continue;
      }
      const s = { id: `cancelled:${n.id}`, node: n, fromPairing: n.pairing, how: 'missing', candidates: [], answer: null, to: null, end: null };
      n.step = s;
      steps.push(s);
      open.push(s);
    }
    for (const s of open) {
      const p = s.fromPairing;
      const flights = pairingFlights(p);
      const gap = (x) => Math.abs(Date.parse(x.from) - Date.parse(p.from));
      const moved = flights ? v.pairings.filter((x) => !used.has(x) && pairingFlights(x) === flights).sort((a, b) => gap(a) - gap(b))[0] : null;
      const hits = moved ? [moved] : v.pairings.filter((x) => !used.has(x) && overlapDays(p, x));
      const sby = v.standby.filter((x) => x.date >= p.from && x.date <= p.to);
      // אותן טיסות בימים חופפים, בשעה אחרת: הוקדמו, או נדחו מעבר ל-FDP המקורי.
      s.how = moved ? (overlapDays(p, moved) ? 'retimed' : 'moved') : hits.length ? 'changed' : sby.length ? 'standby' : 'missing';
      s.candidates = hits;
      s.standby = sby;
      s.waiting = false;
      const a = answerOf(s.node);
      if (!a) {
        // כוננות במקום הסבב אינה נשאלת: מול הרומה היא "בוטל והוצבת לכוננות", בלי שאלה.
        if (s.how === 'standby') { s.end = 'standby'; s.done = true; continue; }
        hits.forEach((x) => used.add(x));
        continue;
      }
      s.answer = a;
      if (!LINKED.includes(a.value) || !a.link || a.link === GAVE_AWAY) { s.end = a.value; s.done = true; continue; }
      // הסבב שבקישור: סבב חדש בתמונה הזאת, או סבב שכבר נרשם כפעילות שלא תוכננה.
      const known = unplanned.find((n) => !n.root && (n.id === a.link || n.pairing.id === a.link));
      if (known) {
        unplanned = unplanned.filter((n) => n !== known);
        known.from = s;
        s.to = known;
        s.done = true;
        continue;
      }
      const target = v.pairings.find((x) => !used.has(x) && x.id === a.link);
      if (!target) { s.waiting = true; continue; }
      used.add(target);
      const node = { id: target.id, pairing: target, plan: false, from: s, step: null };
      live.push(node);
      s.to = node;
      s.done = true;
    }
    open = open.filter((s) => !s.done);
    for (const x of v.pairings) {
      if (used.has(x)) continue;
      const root = ROOT.includes(answers[`unplanned:${x.id}`]?.value);
      const node = { id: x.id, pairing: x, plan: false, from: null, step: null, ...(root && { root, origin: x }) };
      live.push(node);
      unplanned.push(node);
      if (root) roots.push(node);
    }
  }

  const chains = [...planNodes, ...roots].filter((n) => n.step).map((n) => {
    const list = [];
    let node = n;
    while (node.step) {
      list.push(node.step);
      if (!node.step.to) break;
      node = node.step.to;
    }
    return { plan: n.root ? n.origin : planPairings.find((p) => p.id === n.id), ...(n.root && { root: true }), steps: list, last: list.at(-1).to ? node : null };
  });
  return { steps, open, unplanned, chains, obsolete: [...obsolete].filter((id) => !steps.some((s) => s.id === id)), latest: views.at(-1) ?? null };
}

/** תשובות שהן שינוי ביוזמת החברה בשרשרת: הגבוה מבין כל הסבבים (בעל המוצר, 06/10/2026). זכייה במכרז ביניהן. */
const COMPANY = ['replaced', 'bid', 'diversion'];

/**
 * השרשרת של סבב מתוכנן כתשובה אחת על השאלה עליו (`cancelled:<תכנון>`), כשהרומה מועלית (בעל המוצר,
 * 06/10/2026). הבסיס הוא התכנון, או הסבב שעבר אליו בהחלפה מרצוני האחרונה; כל שינוי ביוזמת החברה
 * (כולל זכייה במכרז) אחריו מוסיף סבב. מה שמגיע:
 * - בוצע הסבב האחרון: הגבוה מבין הבסיס, הסבבים שבאמצע ומה שבוצע (`basis`: הגבוה מבין אלה שלא בוצעו);
 *   כשהשלב האחרון החלפה מרצוני – רק מה שבוצע.
 * - הורדה מהטיסה בסוף: השעות של הגבוה מבין הבסיס והסבבים שאחריו, ביום של הסבב שממנו הורד (`lostOn`).
 * - בוטל ללא קרדיט, כוננות או סיבה אחרת: כמו התשובה עצמה.
 * - השלב האחרון עוד פתוח: `open` – הסבב שעליו נשאלת השאלה מול הרומה.
 * לחוקים שסופרים טיסות מתוכננות (2024 ס' 34–37 ו-39) קובע השלב הראשון, זה שהוציא את הסבב מהשיבוץ
 * (`count`; בזכייה במכרז – הסבב שזכה בו, `countLink`). `endsAt`: הסבב שבו השרשרת נגמרת, כדי שמה
 * שבוצע בימי התכנון בלי קשר אליה ייחשב פעילות שלא תוכננה (`splitSwappedElsewhere`).
 * null – אין מה להסביר: השלב היחיד הוא כוננות במקום הסבב, והרומה מראה אותה.
 *
 * `toExec(pairing)`: הסבב ברומה שהוא אותו סבב, או null. `credit(pairing)`: הקרדיט המתוכנן שלו.
 * `execAnswer(id)`: תשובה שניתנה מול הרומה על סבב שהשרשרת נעצרה בו. `byExecId(id)`: סבב ברומה.
 */
export function reduceChain(chain, { toExec, credit, execAnswer, byExecId }) {
  const first = chain.steps[0];
  if (first.end === 'standby' && !first.answer) return null;
  let base = chain.plan;
  let company = [];
  let count = null;
  let countLink;
  let lastValue = null;
  const result = (value, extra = {}) => ({ value, chain: true, count: count ?? value, ...(countLink !== undefined && { countLink }), ...extra });
  const basis = (list) => {
    const b = list.filter(Boolean).reduce((m, p) => ((credit(p) ?? -1) > (credit(m) ?? -1) ? p : m), chain.plan);
    return b !== chain.plan ? { basis: b } : {};
  };
  // שלב אחרון ידוע: `a` התשובה עליו, `at` הסבב שעליו נשאל, `e` הסבב ברומה שבקישור.
  const last = (a, at, e) => {
    if (a.value === 'voluntary_swap') return result('voluntary_swap', { link: e?.id ?? a.link ?? null, endsAt: e ?? at });
    const pool = [base, ...company];
    if (COMPANY.includes(a.value)) return result(a.value, { link: e?.id ?? null, endsAt: e ?? at, ...basis(pool) });
    return result(a.value, { ...(a.text && { text: a.text }), endsAt: at, ...(at !== chain.plan && { lostOn: at }), ...basis(pool) });
  };
  const open = (id, pairing) => result('chain_open', { open: { id, pairing }, endsAt: pairing });

  for (const s of chain.steps) {
    if (s.end === 'standby' && !s.answer) return result('standby', { endsAt: s.fromPairing });
    const a = s.answer;
    if (!a) return open(s.node.id, s.fromPairing);
    // התשובה ניתנה מול הרומה, והקישור שלה לסבב שבוצע ולא לסבב ביומן.
    const e = s.waiting ? (a.link ? byExecId(a.link) : null) : null;
    if (s.waiting && !e) return open(s.node.id, s.fromPairing);
    count ??= a.value;
    if (count === 'bid' && countLink === undefined) countLink = (e ?? (s.to ? toExec(s.to.pairing) : null))?.id ?? null;
    if (e) return last(a, s.fromPairing, e);
    if (!s.to) return last(a, s.fromPairing, null);
    lastValue = a.value;
    if (a.value === 'voluntary_swap') {
      base = s.to.pairing;
      company = [];
    } else {
      company.push(s.to.pairing);
    }
  }
  // השרשרת נמצאת בסבב שביומן: בוצע, או שמה שקרה בו נשאל מול הרומה.
  const node = chain.last;
  const e = toExec(node.pairing);
  if (e) {
    if (lastValue === 'voluntary_swap') return result('voluntary_swap', { link: e.id, endsAt: e });
    return result(lastValue, { link: e.id, endsAt: e, ...basis([base, ...company.slice(0, -1)]) });
  }
  const asked = execAnswer(node.id);
  if (!asked) return open(node.id, node.pairing);
  return last(asked, node.pairing, asked.link && asked.link !== 'none' ? byExecId(asked.link) : null);
}
