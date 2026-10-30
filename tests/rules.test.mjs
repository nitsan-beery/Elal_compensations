// חוקים בתוך חודש: נחיתה מאוחרת, קריאה מיוחדת, שינויים, היעדרויות ועמודות שחסרות ברומה.
import test from 'node:test';
import assert from 'node:assert/strict';
import { month, leg, run, expected, row, notes, asked, explains, hhmm } from './helpers.mjs';

const round = (back = {}) => [leg('LY541', 'TLV', 'ATH', '10:00', '13:00'), leg('LY542', 'ATH', 'TLV', '14:00', '17:00', back)];

// ---------- נחיתה מאוחרת (2024 ס' 43) ----------

const clock = (m) => hhmm(m);
const landed = (delay, com) => {
  const flights = round({ ata: clock(17 * 60 + delay) });
  return month(2026, 8, { plan: { '05': round() }, exec: { '05': flights }, values: com ? { '05': { COM: com } } : {} });
};
for (const [delay, due] of [[62, '00:30'], [93, '00:30'], [120, '00:30'], [121, '01:00'], [141, '01:00']]) {
  test(`נחיתה מאוחרת של ${delay} דק': ${due}`, () => {
    assert.equal(expected(run(landed(delay, due)), 'COM', 'TLV-ATH-TLV'), due);
  });
}
test('איחור של שעה בדיוק אינו מזכה, והערה מ-30 דק\'', () => {
  const r = run(landed(60));
  assert.equal(expected(r, 'COM', 'TLV-ATH-TLV'), null);
  assert.ok(notes(r).some((n) => n.includes('נחתה באיחור של 60 דק\'')));
});
test('איחור של 29 דק\': בלי הערה', () => {
  assert.ok(!notes(run(landed(29))).some((n) => n.includes('נחתה באיחור')));
});

// ---------- קריאה מיוחדת (ישן כ"ה ס' 12) ----------

const call = (legs, values, plan = {}) => month(2026, 8, { plan, exec: legs, values });

test('טיסה ביום שלא תוכנן בו כלום, והרומה זיכתה: קריאה מיוחדת, בהנחה', () => {
  const r = run(call({ '05': round() }, { '05': { 'S/C': '02:30' } }));
  assert.equal(expected(r, 'S/C', 'TLV-ATH-TLV'), '02:30');
  assert.ok((r.assumptions ?? []).some((a) => a.id.startsWith('unplanned:')));
});

test('טיסה ביום שלא תוכנן, והרומה לא זיכתה: שאלה', () => {
  assert.equal(asked(run(call({ '05': round() }, {})), 'unplanned:'), true);
});

test('היממה השנייה: שהייה מעל 8 שעות ולפחות 4 ביממה השנייה', () => {
  const flights = [leg('LY1', 'TLV', 'ATH', '18:00', '21:00'), leg('LY2', 'ATH', 'TLV', '01:00', '05:00')];
  const m = call({ '05': [flights[0]], '06': [flights[1]] }, { '05': { 'S/C': '02:30' }, '06': { 'S/C': '02:30' } });
  assert.equal(expected(run(m), 'S/C', '06/08'), '02:30');
});

test('היממה השנייה: פחות מ-4 שעות בה, בלי קריאה מיוחדת עליה, והערה', () => {
  const flights = [leg('LY1', 'TLV', 'ATH', '18:00', '21:00'), leg('LY2', 'ATH', 'TLV', '21:40', '00:40')];
  const m = call({ '05': flights }, { '05': { 'S/C': '02:30', Credit: '06:00' } });
  const r = run(m);
  assert.equal(expected(r, 'S/C', '05/08'), '02:30');
  assert.ok(notes(r).some((n) => n.includes('אין קריאה מיוחדת על היממה השנייה')));
});

test('סבב שבוצע כמתוכנן אינו קריאה מיוחדת, גם כשהרומה רשמה S/C', () => {
  const m = month(2026, 8, { plan: { '05': round() }, exec: { '05': round() }, values: { '05': { 'S/C': '02:30' } } });
  const r = run(m);
  assert.equal(expected(r, 'S/C', 'TLV-ATH-TLV'), '00:00');
  assert.ok(row(r, 'S/C', 'TLV-ATH-TLV').notes.some((n) => n.includes('שאף חוק אינו מסביר')));
});

// ---------- סבב שהוחלף ----------

const planned = () => [leg('LY541', 'TLV', 'ATH', '10:00', '14:00'), leg('LY542', 'ATH', 'TLV', '15:00', '19:00')]; // 08:00
const flown = () => [leg('LY5', 'TLV', 'LCA', '10:00', '13:00'), leg('LY6', 'LCA', 'TLV', '14:00', '17:00')]; // 06:00
const idPlan = 'cancelled:2026-08-05..2026-08-05:ATH';
const idExec = '2026-08-05..2026-08-05:LCA';
const swapped = (rig) => month(2026, 8, { plan: { '05': planned() }, exec: { '05': flown() }, values: rig ? { '05': { Rig: rig } } : {} });

test('סבב שהוחלף באותם ימים נשאל', () => {
  assert.equal(asked(run(swapped()), idPlan), true);
});

test('שינוי ביוזמת החברה: הגבוה מבין השתיים, וההפרש ב-Rig', () => {
  assert.equal(expected(run(swapped('02:00'), { answers: { [idPlan]: { value: 'replaced', link: idExec } } }), 'Rig', 'TLV-LCA-TLV'), '02:00');
});

test('החלפה מרצוני: רק מה שבוצע', () => {
  assert.equal(expected(run(swapped(), { answers: { [idPlan]: { value: 'voluntary_swap', link: idExec } } }), 'Rig', 'TLV-LCA-TLV'), null);
});

test('"הגבוה מבין השתיים" אינו נוסף על ההשלמה ל-5 שעות', () => {
  const short = [leg('LY5', 'TLV', 'LCA', '10:00', '11:00'), leg('LY6', 'LCA', 'TLV', '12:00', '13:00')]; // 02:00
  const m = month(2026, 8, { plan: { '05': planned() }, exec: { '05': short }, values: { '05': { Rig: '06:00' } } });
  assert.equal(expected(run(m, { answers: { [idPlan]: { value: 'replaced', link: idExec } } }), 'Rig', 'TLV-LCA-TLV'), '06:00');
});

test('סטיה לשדה משנה באותם מספרי טיסה אינה נשאלת', () => {
  const div = [leg('LY541', 'TLV', 'LCA', '10:00', '14:00'), leg('LY541', 'LCA', 'ATH', '15:00', '16:00'), leg('LY542', 'ATH', 'TLV', '17:00', '21:00')];
  const m = month(2026, 8, { plan: { '05': planned() }, exec: { '05': div } });
  assert.equal(asked(run(m), idPlan), false);
});

// ---------- היעדרויות ----------

const absent = (planCode, execCode, column, credit) => month(2026, 8, { plan: { '05': planCode, 15: round() }, exec: { 15: round() }, codes: { '05': execCode }, values: { '05': { Credit: credit, ...(column ? { [column]: 1 } : {}) } } });

for (const [name, planCode, execCode, due] of [['יום חופשה', 'VAC_FLD', 'VAC_F', '03:45'], ['מחלה מתוכננת', 'SCK_PLAN', 'SCK_P', '02:30'], ['יום אימון קרקע', 'HOME_RGT', 'HOME_', '03:45']]) {
  test(`${name}: קרדיט ${due}`, () => {
    assert.equal(expected(run(absent(planCode, execCode, null, due)), 'Credit', '05/08'), due);
  });
}

// ---------- עמודה שחסרה ברומה (טיוטות 421–423) ----------

const noCom = (columns, headerP = null) => {
  const m = month(2026, 8, { plan: { '05': round() }, exec: { '05': round({ ata: '19:00' }) }, columns });
  m.exec.headerP = headerP;
  return m;
};
const cut = (r) => r.infos.some((x) => x.includes('ייתכן שהעמודה נחתכה בהדפסה'));

test('פיצוי צפוי, אין עמודה, ו-PDFT ברומה: לא נחתכה, בלי הודעה', () => {
  assert.equal(cut(run(noCom(['Day', 'Details', 'Credit', 'FLT', 'TAB', 'PDFT', 'ABR']))), false);
});
test('בלי PDFT, אבל עמודה שמתחילה ב-P: בלי הודעה', () => {
  assert.equal(cut(run(noCom(['Day', 'Details', 'Credit', 'FLT', 'TAB'], 'PD'))), false);
});
test('בלי PDFT ובלי עמודה שמתחילה ב-P: הודעה בכחול', () => {
  assert.equal(cut(run(noCom(['Day', 'Details', 'Credit', 'FLT', 'TAB']))), true);
});
test('הסבר בשורת הפיצוי קיים', () => {
  assert.ok(explains(row(run(landed(93, '00:30')), 'COM', 'TLV-ATH-TLV')).includes('נחתה באיחור של 1:33'));
});
