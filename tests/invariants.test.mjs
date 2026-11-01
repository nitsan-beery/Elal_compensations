// כללים שתמיד צריכים להתקיים, על צירופים של תכנון וביצוע, באמצע חודש ובמעבר חודש, כולל התשובות על השאלה הראשונה
// (בעל המוצר, 01/11/2026; טיוטה 474). תת-קבוצה מהירה. סינתטי.
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run } from './helpers.mjs';

const out = () => [leg('LY321', 'TLV', 'ATH', '10:00', '13:00')];
const back = () => [leg('LY322', 'ATH', 'TLV', '09:00', '12:00')];
const none = () => [];
const turn = (n = 541) => [leg(`LY${n}`, 'TLV', 'LCA', '10:00', '11:00'), leg(`LY${n + 1}`, 'LCA', 'TLV', '12:00', '13:00')];
const flat = (x) => (Array.isArray(x) ? x.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('') : x);

const PLANS = {
  סבב: [out, none, back], 'טיסה ויומיים פנויים': [turn, 'X', 'X'], כוננות: ['SBY_S', 'SBY_S', 'SBY_S'], 'יום פנוי וכוננות': ['X', 'SBY_S', 'SBY_S'],
  'חופשה': ['VAC_FLD', 'VAC_FLD', 'VAC_FLD'], 'קרקע': ['CPT_BAS', 'X', 'X'],
};
const EXEC = {
  plan: { flown: true }, ריק: {}, מחלה: { code: 'SICK', v: { Credit: '02:30', TAB: '11:00' } }, כוננות: { code: 'SBY_S', v: { Credit: '04:15', TAB: '11:00' } },
  'כוננות וטיסה': { code: 'SBY_S', legs: turn, v: { Rig: '03:00' } }, 'טיסה וקריאה': { legs: turn, v: { Rig: '03:00', 'S/C': '02:30' } },
};
const other = (d, n) => ({ [d]: turn(n) });
const AUG = { ...other('05', 700), ...other('20', 720), ...other('25', 730) };
const SEP = { ...other('05', 700), ...other('12', 710), ...other('20', 720) };
const OCT = { ...other('08', 740), ...other('15', 750), ...other('22', 760) };

function setDay(P, X, C, V, key, p, e) {
  const planned = typeof p === 'function' ? p() : p;
  if (typeof planned === 'string' || planned.length) P[key] = planned;
  const k = EXEC[e];
  if (k.flown) {
    if (typeof planned === 'string') { if (planned !== 'X') C[key] = planned.slice(0, 5); } else if (planned.length) X[key] = p();
    return;
  }
  if (k.legs) X[key] = k.legs();
  if (k.code) C[key] = k.code;
  if (k.v) V[key] = { ...k.v };
}
function cases(pl, ex) {
  const [P, X, C, V] = [{ ...AUG }, { ...AUG }, {}, {}];
  ['10', '11', '12'].forEach((key, i) => setDay(P, X, C, V, key, pl[i], ex[i]));
  const [P1, X1, C1, V1, P2, X2, C2, V2] = [{ ...SEP }, { ...SEP }, {}, {}, { ...OCT }, { ...OCT }, {}, {}];
  setDay(P1, X1, C1, V1, '29', pl[0], ex[0]);
  setDay(P1, X1, C1, V1, '30', pl[1], ex[1]);
  setDay(P2, X2, C2, V2, '01', pl[2], ex[2]);
  const sep = month(2026, 9, { plan: P1, exec: X1, codes: C1, values: V1 });
  const oct = month(2026, 10, { plan: P2, exec: X2, codes: C2, values: V2 });
  return [{ m: month(2026, 8, { plan: P, exec: X, codes: C, values: V }), opts: {} }, { m: sep, opts: { next: oct } }, { m: oct, opts: { prev: sep } }];
}
const answerOf = (o) => ({ value: o.value, ...(o.needsText ? { text: 'בדיקה', creditMin: 0 } : {}), ...(o.needsLink ? { link: 'טיסה בחודש אחר' } : {}) });

function violations(r, answers) {
  const bad = [];
  const texts = [...r.notes.map((n) => n.message), ...r.questions.flatMap((q) => [flat(q.title), q.body]), ...r.changes.flatMap((c) => [c.label, c.plan, c.exec])];
  if (texts.some((t) => /undefined|NaN|\[object/.test(String(t ?? '')))) bad.push('טקסט שבור');
  for (const a of r.assumptions) if (r.questions.some((q) => q.id === a.id)) bad.push(`הנחה וגם שאלה: ${a.id}`);
  for (const id of Object.keys(answers)) if (r.questions.some((q) => q.id === id)) bad.push(`נענה ונשאל שוב: ${id}`);
  if (new Set(r.questions.map((q) => q.id)).size !== r.questions.length) bad.push('שאלה כפולה');
  if (!r.questions.length && r.comparison.some((c) => c.ok == null)) bad.push('שורה ממתינה בלי שאלה');
  for (const n of r.notes.filter((x) => x.message.includes('הופעלת מכוננות'))) {
    if (r.questions.some((q) => q.date === n.date && /^(unplanned|cancelled|standby_bid):/.test(q.id))) bad.push('הערה שהופעלת לצד שאלה על אותו יום');
  }
  const calls = new Map();
  for (const e of r.expectations.filter((x) => x.key === 'sc')) calls.set(e.date, (calls.get(e.date) ?? 0) + 1);
  if ([...calls.values()].some((n) => n > 1)) bad.push('שתי קריאות מיוחדות באותו יום');
  return bad;
}

test('הכללים מתקיימים בכל הצירופים', () => {
  const failed = [];
  for (const [pn, pl] of Object.entries(PLANS)) {
    for (const a of Object.keys(EXEC)) for (const b of Object.keys(EXEC)) for (const c of Object.keys(EXEC)) {
      for (const { m, opts } of cases(pl, [a, b, c])) {
        const r = run(m, opts);
        for (const v of violations(r, {})) failed.push(`${pn} [${a}, ${b}, ${c}] ${m.period.month}: ${v}`);
        const q = r.questions[0];
        for (const o of q?.options ?? []) {
          const answers = { [q.id]: answerOf(o) };
          for (const v of violations(run(m, { ...opts, answers }), answers)) failed.push(`${pn} [${a}, ${b}, ${c}] ${m.period.month} ${q.id}=${o.value}: ${v}`);
        }
      }
    }
  }
  assert.deepEqual(failed.slice(0, 10), []);
});
