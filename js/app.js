// ממשק האפליקציה: העלאת קבצים, הרצת המנוע, שאלות, היסטוריה ומסך החוקים.
// כל העיבוד על המכשיר. אין כאן ערכי פיצוי: הכול מגיע מ-rules.json דרך המנוע.

import { parsePlan } from './pdf/plan.js';
import { parseExec } from './pdf/exec.js';
import { xlsxBlob } from './xlsx.js';
import { evaluate } from './rules/evaluate.js';
import { loadRules, partitionRules } from './rules/catalog.js';
import { minToHhmm } from './time.js';
import * as store from './store.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ddmm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const hm = (v, unit) => (v == null ? '—' : unit === 'count' ? String(v) : minToHhmm(v));
const MONTH_NAMES = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const monthName = (p) => `${MONTH_NAMES[p.month - 1]} ${p.year}`;
const KIND_LABEL = { plan: 'קובץ תכנון', exec: 'קובץ ביצוע' };
const MODE_LABEL = { full: 'תכנון וביצוע', plan: 'תכנון בלבד', exec: 'ביצוע בלבד' };
const CATEGORY_LABEL = { plan: 'תכנון', exec: 'ביצוע', train: 'הדרכה' };
const KEY_LABEL = { flight: 'קרדיט טיסה', absence: 'קרדיט יום', credit: 'קרדיט', rig: 'Rig', com: 'COM', sc: 'S/C' };
const CREDIT_KEYS = new Set(['flight', 'absence', 'credit']);
const COM_KEYS = new Set(['com', 'sc']); // S/C נספר יחד עם COM בסיכום
// ימים שזוכו על פעילות שאינה טיסה, לפי החוק שזיכה אותם (ובאימון קרקע – לפי הקוד).
const isHomeRgt = (e) => e.code?.startsWith('HOME_');
const DAY_KINDS = [
  { one: 'יום חופשה אחד', many: 'ימי חופשה', test: (e) => e.ruleId === 'vacation_base_credit' },
  { one: 'יום מחלה אחד', many: 'ימי מחלה', test: (e) => e.ruleId === 'planned_sick_credit' || e.ruleId === 'sick_credit' },
  { one: 'יום סימולטור אחד', many: 'ימי סימולטור', test: (e) => e.ruleId === 'sim_day_credit' },
  { one: 'יום פעילות קרקעית אחד', many: 'ימי פעילות קרקעית', test: (e) => e.ruleId === 'ground_training_credit' && !isHomeRgt(e) },
  { one: 'יום HOME RGT אחד', many: 'ימי HOME RGT', test: (e) => e.ruleId === 'ground_training_credit' && isHomeRgt(e) },
  { one: 'יום כוננות אחד', many: 'ימי כוננות', test: (e) => e.ruleId === 'short_call_standby_credit' },
];
/** כמה ימים זוכו על פעילות שאינה טיסה, לפי סוג ("<span>3</span> ימי חופשה"). */
const dayCounts = (expectations) => DAY_KINDS.map((k) => {
  const n = new Set(expectations.filter((e) => e.key === 'absence' && k.test(e)).map((e) => e.date)).size;
  return n ? (n === 1 ? k.one : `<span class="num">${n}</span> ${k.many}`) : null;
}).filter(Boolean);
// תוויות לתשובות שכבר ניתנו. ערך שאינו כאן מוצג כמות שהוא.
const ANSWER_LABEL = {
  special_call: 'קריאה מיוחדת', voluntary_swap: 'החלפה מרצוני', replaced: 'החלפה ביוזמת החברה (כולל זכיה במכרז או סטיה לשדה משנה)',
  wet_lease: 'הורדה מהטיסה המקורית', trainee: 'הורדה מהטיסה המקורית', swap_777: 'הטיסה עברה ל-777 (לא כשיר MFF)',
  cancelled: 'הטיסה המקורית בוטלה ללא קרדיט', other: 'סיבה אחרת',
  yes: 'כן, הייתי מוצב', no: 'לא הייתי מוצב',
  company: 'לבקשת החברה', own: 'ויתור מרצון',
  standby_bid: 'סיום כוננות בגלל זכייה במכרז', standby_activated: 'הפעלת הכוננות', regular_standby: 'מצב הכן רגיל',
};

/** ערך תשובה לתצוגה. תאריך שנבחר ביומן מוצג כיום/חודש. */
const answerLabel = (v) => ANSWER_LABEL[v] ?? (/^\d{4}-\d{2}-\d{2}$/.test(v) ? ddmm(v) : v);

const state = {
  rulesData: null,
  rulesSource: null,
  record: null, // רשומת החודש הפתוח
  result: null,
  filter: 'comp',
  notices: [],
  files: {}, // kind → {id: "2026-07:plan", url} של קובץ ה-PDF השמור, לכפתור "פתח קובץ"
};

// ---------- אתחול ----------

init();

async function init() {
  setupTabs();
  setupUploads();
  registerServiceWorker();
  try {
    const { data, source } = await loadRules();
    state.rulesData = data;
    state.rulesSource = source;
  } catch (err) {
    showBanner('bad', esc(err.message));
    return;
  }
  if (state.rulesSource === 'cache') {
    showBanner('warn', `אין חיבור לרשת. החוקים נטענו מהעותק השמור על המכשיר (גרסה ${esc(state.rulesData.rules_version)}).`);
  }
  // החודש האחרון שעבדו עליו נפתח אוטומטית.
  const months = await safe(() => store.listMonths(), []);
  if (months.length) await openMonth(months[0].key, { quiet: true });
  else renderResults();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').catch(() => { /* האפליקציה עובדת גם בלי */ });
}

function showBanner(kind, html) {
  const b = $('#banner');
  b.className = `banner ${kind}`;
  b.innerHTML = html;
  b.hidden = false;
}

async function safe(fn, fallback) {
  try { return await fn(); } catch (err) { console.error(err); return fallback; }
}

// ---------- ניווט ----------

function setupTabs() {
  for (const btn of document.querySelectorAll('.tabs button')) {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  }
}

function showView(view) {
  for (const btn of document.querySelectorAll('.tabs button')) btn.setAttribute('aria-selected', String(btn.dataset.view === view));
  for (const sec of document.querySelectorAll('.view')) sec.hidden = sec.id !== `view-${view}`;
  if (view === 'history') renderHistory();
  if (view === 'rules') renderRules();
  window.scrollTo(0, 0);
}

// ---------- העלאה ----------

function setupUploads() {
  for (const zone of document.querySelectorAll('.drop')) {
    const input = $('input', zone);
    // הכפתור בתוך אזור ההעלאה: פותח את הקובץ השמור, ולא את בחירת הקובץ.
    $('.drop-open', zone).addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const url = state.files[zone.dataset.kind]?.url;
      if (url) window.open(url, '_blank');
    });
    input.addEventListener('change', () => {
      if (input.files[0]) handleFile(input.files[0], zone.dataset.kind);
      input.value = '';
    });
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file, zone.dataset.kind);
    });
  }
}

const PARSERS = { plan: parsePlan, exec: parseExec };

/**
 * קריאת קובץ. אם הקובץ הועלה לאזור הלא נכון, מזהים אותו לפי התוכן ומעבירים.
 */
async function handleFile(file, expected) {
  if (!state.rulesData) return;
  const zone = $(`.drop[data-kind="${expected}"]`);
  zone.classList.add('busy');
  $('.drop-state', zone).textContent = 'קורא את הקובץ…';
  state.notices = [];
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let kind = expected;
    let parsed;
    try {
      parsed = await PARSERS[expected](bytes.slice());
    } catch (first) {
      const other = expected === 'plan' ? 'exec' : 'plan';
      try {
        parsed = await PARSERS[other](bytes.slice());
        kind = other;
        state.notices.push({ kind: 'info', text: `הקובץ "${file.name}" הוא ${KIND_LABEL[other]}, והוא נקלט ככזה.` });
      } catch (second) {
        throw second.exact ? second : first;
      }
    }

    const key = store.monthKey(parsed.period);
    const prev = state.record;
    const record = (prev?.key === key ? prev : await safe(() => store.getMonth(key), null))
      ?? { key, period: parsed.period, plan: null, exec: null, answers: {} };
    if (kind === 'exec' && !record.plan) {
      state.notices.push({ kind: 'warn', text: 'אין קובץ תכנון לחודש הזה, ולכן אין השוואה לתכנון. אפשר להעלות אותו עכשיו.' });
    }
    record[kind] = parsed;
    record[`${kind}File`] = file.name;
    await safe(() => store.putFile(key, kind, file.name, bytes));
    dropFileLink(kind);
    state.record = record;
    await runAndSave();
  } catch (err) {
    console.error(err);
    if (err.exact) state.result = null;
    state.notices.push({ kind: 'bad', text: err.exact ? err.message : `לא ניתן לקרוא את "${file.name}": ${err.message}` });
    renderResults();
  } finally {
    zone.classList.remove('busy');
    renderUploadState();
  }
}

function renderUploadState() {
  for (const zone of document.querySelectorAll('.drop')) {
    const kind = zone.dataset.kind;
    const r = state.record;
    const loaded = !!r?.[kind];
    zone.classList.toggle('loaded', loaded);
    $('.drop-state', zone).textContent = loaded
      ? `${r[`${kind}File`] ?? 'נטען מהחודשים השמורים'} · ${monthName(r.period)}`
      : 'לא נבחר קובץ. לחץ או גרור לכאן';
    refreshFileLink(zone, kind);
  }
}

/** קובץ ה-PDF השמור של החודש הפתוח, לכפתור "פתח קובץ". חודש שנשמר לפני שהקבצים נשמרו – בלי כפתור. */
async function refreshFileLink(zone, kind) {
  const button = $('.drop-open', zone);
  const r = state.record;
  const id = r?.[kind] ? `${r.key}:${kind}` : null;
  if (state.files[kind]?.id !== id) {
    dropFileLink(kind);
    if (id) {
      // הרשומה נכנסת לפני הקריאה מהמסד, כדי שקריאה מקבילה לא תטען את הקובץ שוב.
      const entry = { id, url: null };
      state.files[kind] = entry;
      const file = await safe(() => store.getFile(r.key, kind), null);
      if (state.files[kind] !== entry) return; // נפתח חודש אחר, או הועלה קובץ חדש, בינתיים
      if (file) entry.url = URL.createObjectURL(new Blob([file.bytes], { type: 'application/pdf' }));
    }
  }
  button.hidden = !state.files[kind]?.url;
}

function dropFileLink(kind) {
  if (state.files[kind]?.url) URL.revokeObjectURL(state.files[kind].url);
  delete state.files[kind];
}

// ---------- הרצה ----------

async function runAndSave() {
  const r = state.record;
  state.result = evaluate({ rulesData: state.rulesData, plan: r.plan, exec: r.exec, answers: r.answers ?? {} });
  r.rulesVersion = state.result.rulesVersion;
  r.summary = summarize(state.result);
  await safe(() => store.putMonth(r));
  renderUploadState();
  renderResults();
}

/** שורות ההשוואה שמוצגות. FLT+DH חוזר על הקרדיט של אותן טיסות, ולכן לא מוצג ולא נספר. */
/** עמודות הפיצויים בדוח. השאר הן קרדיט ועמודות סימון. */
const COMP_COLUMNS = new Set(['Rig', 'COM', 'S/C']);
const MAIN_COLUMNS = ['Credit', 'Rig', 'COM', 'S/C'];

/**
 * שורות הטבלה: לכל יום (או סבב) שורת Credit, ושורות Rig, ‏COM ו-S/C כשיש בהן ערך.
 * FLT+DH, ‏TAB ועמודות הסימון (VAC, SICK...) אינן מוצגות כשורות. פער באחת מהן נרשם
 * על שורת ה-Credit של אותו יום (`marks`), כדי שלא ייעלם. אם אין שורת Credit, היא מוצגת.
 */
function shownComparison(res) {
  const main = res.comparison.filter((c) => MAIN_COLUMNS.includes(c.column)).map((c) => ({ ...c, marks: [] }));
  const orphans = [];
  for (const c of res.comparison) {
    if (MAIN_COLUMNS.includes(c.column) || c.ok !== false) continue;
    const host = main.find((m) => m.column === 'Credit' && m.dates.includes(c.dates[0]));
    if (host) host.marks.push(c); else orphans.push({ ...c, marks: [] });
  }
  const order = (c) => (MAIN_COLUMNS.includes(c.column) ? MAIN_COLUMNS.indexOf(c.column) : MAIN_COLUMNS.length);
  const at = (c) => c.at ?? c.dates[0]; // שורות של סבב שלם מוצגות אחרי היום האחרון שלו
  return [...main, ...orphans].sort((a, b) => at(a).localeCompare(at(b)) || a.dates[0].localeCompare(b.dates[0]) || order(a) - order(b));
}
const isGap = (c) => c.ok === false || c.marks.length > 0;

/** הסיבה לפיצוי שאינו קרדיט (Rig, ‏COM, ‏S/C), ליד שם העמודה: `reason` כשיש, אחרת `short_title` של החוק, אחרת שמו. */
function reasonOf(c) {
  if (!COMP_COLUMNS.has(c.column)) return '';
  const reasons = [...new Set(c.items.map((e) => e.reason ?? e.shortTitle ?? e.ruleTitle).filter(Boolean))];
  return reasons.length ? `<span class="reason">${esc(reasons.join(' · '))}</span>` : '';
}

function summarize(res) {
  // פער בסיכום נספר רק כשהפערים בשורות של אותה עמודה אינם מסבירים אותו, כדי לא לספור פער אחד פעמיים
  // (נובמבר ודצמבר 2025: Rig של 00:04 בשורה ובסיכום; בעל המוצר, 29/09/2026).
  const rowsDiff = (column) => res.comparison.filter((c) => c.column === column && c.ok === false).reduce((s, c) => s + c.diff, 0);
  return {
    mode: res.mode,
    questions: res.questions.length,
    gaps: shownComparison(res).filter(isGap).length
      + (res.questions.length ? 0 : res.totals.filter((t) => t.ok === false && t.reported - t.expected !== rowsDiff(t.column)).length),
    reviews: res.reviews.length,
    unknownCodes: res.unknownCodes.length,
  };
}

async function openMonth(key, { quiet = false } = {}) {
  const record = await safe(() => store.getMonth(key), null);
  if (!record) return;
  state.record = record;
  state.notices = [];
  state.filter = 'comp';
  if (!quiet) showView('check');
  await runAndSave();
}

// ---------- תוצאות ----------

function renderResults() {
  const root = $('#results');
  const res = state.result;
  const parts = [state.notices.map((n) => `<div class="notice ${n.kind}">${esc(n.text)}</div>`).join('')];
  if (!res) { root.innerHTML = parts.join(''); return; }

  parts.push(renderHead(res));
  parts.push(renderAlerts(res));
  parts.push(renderQuestions(res));
  parts.push(renderTotals(res));
  parts.push(renderComparison(res));
  parts.push(renderExpectations(res));
  parts.push(renderChanges(res));
  parts.push(renderNotes(res));
  parts.push(renderAnswered());
  root.innerHTML = parts.join('');
  bindResults(root);
}

function renderHead(res) {
  const r = state.record;
  const emp = r.exec?.employee?.name ?? (r.plan?.employee ? `${r.plan.employee.last} ${r.plan.employee.first ?? ''}` : '');
  return `<div class="card">
    <div class="result-head">
      <h2>${esc(monthName(res.period))}</h2>
      <span class="meta">${esc(MODE_LABEL[res.mode])} · בסיס ${esc(res.domicile ?? '?')}${res.fleet ? ` · צי ${esc(res.fleet)}` : ''} · חוקים ${esc(res.rulesVersion)}</span>
      <span class="spacer"></span>
      <button class="btn no-print" data-action="print">ייצוא PDF</button>
    </div>
    <p class="print-only small">${esc(emp)} · הופק ${esc(new Date().toLocaleDateString('he-IL'))}</p>
    ${res.mode === 'plan' ? '<p class="small muted">בלי קובץ ביצוע אין השוואה מול מה שזוכה. מוצגים הקרדיט והפיצויים הצפויים לפי התכנון.</p>' : ''}
  </div>`;
}

function renderAlerts(res) {
  const out = [];
  if (res.warnings.length) {
    out.push(`<div class="notice warn"><strong>אזהרות</strong><ul>${res.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`);
  }
  if (res.unknownCodes.length) {
    const open = res.unknownCodes.some((u) => !u.answer);
    out.push(`<div class="notice ${open ? 'bad' : 'warn'}"><strong>קודים שהאפליקציה לא מכירה</strong>
      <ul class="codes">${res.unknownCodes.map(renderUnknownCode).join('')}</ul>
      <p class="small">כדי שהאפליקציה תדע מה מגיע על קוד חדש, ולא תשאל עליו שוב, צריך להוסיף אותו ל-<span class="num">rules.json</span>: לרשימת הקודים, ולפרמטרים של החוק שמזכה עליו. הפרטים כאן הם מה שדרוש לעדכון.</p>
      <button class="btn no-print" data-action="copy-codes">העתק פרטים</button></div>`);
  }
  if (res.reviews.length) {
    out.push(`<div class="notice bad"><strong>לבדיקה ידנית</strong><ul>${res.reviews.map((v) => `<li>${esc(v.message)}${v.ruleTitle ? ` <span class="tag">${esc(v.ruleTitle)}</span>` : ''}</li>`).join('')}</ul></div>`);
  }
  return out.length ? `<div class="card">${out.join('')}</div>` : '';
}

/**
 * קוד לא מוכר, עם כל מה שיודע עליו: התאריכים, מה שהדוח רשם באותם ימים, ותשובת
 * המשתמש עליו אם נשאל. כל אלה מה שדרוש כדי לעדכן את `rules.json` לפי הקוד החדש.
 */
function renderUnknownCode(u) {
  const lines = unknownCodeLines(u).map((l) => `<div class="small">${esc(l)}</div>`).join('');
  return `<li><span class="num">${esc(u.code)}</span> ${esc(whereOf(u))}, בתאריכים ${u.dates.map(ddmm).join(', ')}${lines}</li>`;
}

const whereOf = (u) => (u.where === 'both' ? 'בתכנון ובביצוע' : u.where === 'plan' ? 'בתכנון' : 'בביצוע');

/** שורות הפירוט של קוד לא מוכר, בלי HTML: אותן שורות מוצגות ומועתקות. */
function unknownCodeLines(u) {
  const lines = [];
  const texts = [...new Set((u.report ?? []).map((r) => r.text))];
  if (texts.length === 1) lines.push(`ברומה: ${texts[0]}`);
  else for (const r of u.report ?? []) lines.push(`ברומה ${ddmm(r.date)}: ${r.text}`);
  lines.push(u.answer ? `לפי תשובתך: ${u.answer}` : 'האפליקציה לא יודעת מה מגיע עליו, ולא ניחשה.');
  return lines;
}

/** הפרטים כטקסט, להעתקה ולשליחה לעדכון האפליקציה. */
function unknownCodesText(res) {
  const head = `קודים שהאפליקציה לא מכירה – ${monthName(res.period)} · חוקים ${res.rulesVersion}`;
  const items = res.unknownCodes.map((u) => [
    `${u.code} ${whereOf(u)}, בתאריכים ${u.dates.map(ddmm).join(', ')}`,
    ...unknownCodeLines(u).map((l) => `  ${l}`),
  ].join('\n'));
  return [head, ...items].join('\n');
}

function renderQuestions(res) {
  if (!res.questions.length) return '';
  return `<div class="card">
    <h2>שאלות <span class="count">${res.questions.length}</span></h2>
    <p class="small muted">המידע הזה אינו בקבצים. עד שתענה, השורות שתלויות בתשובה מסומנות "ממתין".</p>
    ${res.questions.map(renderQuestion).join('')}
  </div>`;
}

/** כותרת שאלה: מחרוזת רגילה (בבולד, כברירת המחדל של h3), או מקטעים – רק המסומנים `bold` בבולד. */
function titleHtml(title) {
  if (!Array.isArray(title)) return esc(datesFirst(title));
  return `<span class="mixed">${title.map((part) =>
    typeof part === 'string' ? esc(datesFirst(part)) : `<b>${esc(part.text)}</b>`).join('')}</span>`;
}

function renderQuestion(q, i) {
  const name = `q${i}`;
  const options = q.options.map((o) => `
    <label class="option">
      <input type="radio" name="${name}" value="${esc(o.value)}" ${o.needsLink ? 'data-needs-link' : ''} ${o.needsText ? 'data-needs-text' : ''}>
      <span>${esc(datesFirst(o.label))}${o.count ? ` <select name="count" data-count-for="${esc(o.value)}">${o.count.map((c) => `<option value="${esc(c.value)}">${esc(c.label)}</option>`).join('')}</select>` : ''}${o.hint ? ` <span class="hint-inline">– ${esc(datesFirst(o.hint))}</span>` : ''}</span>
    </label>
    ${o.needsLink ? `<div class="extra" data-for="${esc(o.value)}" hidden>
      <label class="small">עם איזו טיסה הוחלף?
        <select name="link">${(o.linkCandidates ?? []).map((c) => `<option value="${esc(c.id ?? '')}">${esc(datesFirst(c.label))}</option>`).join('')}</select>
      </label></div>` : ''}
    ${o.needsText ? `<div class="extra" data-for="${esc(o.value)}" hidden><textarea name="text" placeholder="פרט מה קרה"></textarea></div>` : ''}`).join('');
  // שאלה שהתשובה בה היא תאריך: יומן עם ברירת מחדל, ואפשר לשמור אותה מיד.
  const picker = q.dateInput ? `<label class="date-pick">בחר תאריך
    <input type="date" name="date" value="${esc(q.dateInput.value)}"${q.dateInput.min ? ` min="${esc(q.dateInput.min)}"` : ''}${q.dateInput.max ? ` max="${esc(q.dateInput.max)}"` : ''} required>
  </label>` : '';
  return `<div class="question">
    <h3>${titleHtml(q.title)}</h3>
    ${q.body ? `<p>${esc(datesFirst(q.body))}</p>` : ''}
    <form data-qid="${esc(q.id)}">
      ${picker}${options}
      <div class="row" style="margin-top:.5rem"><button class="btn primary" type="submit" ${q.dateInput ? '' : 'disabled'}>שמור תשובה</button></div>
    </form>
  </div>`;
}

/** פער לטובת אצ"א (הדוח נתן יותר מהצפוי) בירוק, ולרעתו באדום. */
const gapClass = (diff) => (diff > 0 ? 'gain' : 'bad');
const signed = (min) => (min > 0 ? '+' : '') + minToHhmm(min);

function renderTotals(res) {
  const fd = res.freeDays;
  if (!res.totals.length && !fd) return '';
  // כל עוד יש שאלות פתוחות, פער בסיכום אינו ממצא: הצפוי תלוי בתשובות.
  const pending = res.questions.length > 0;
  const days = res.totals.length ? dayCounts(res.expectations) : [];
  return `<div class="card">
    <h2>${res.totals.length ? 'סיכום' : 'סיכום חודשי'}</h2>
    <div class="totals">${res.totals.map((t) => {
      const gap = `פער <span class="num">${signed(t.reported - t.expected)}</span>`;
      const status = t.ok === true ? '✓' : t.ok === false ? (pending ? `ממתין · ${gap}` : `✗ ${gap}`) : '';
      return `
      <div class="total ${t.ok === true ? 'ok' : t.ok === false && !pending ? gapClass(t.reported - t.expected) : ''}">
        <div class="label">${esc(t.column)}</div>
        <div class="val num">${minToHhmm(t.expected)}</div>
        <div class="rep">ברומה <span class="num">${minToHhmm(t.reported)}</span> ${status}</div>
      </div>`;
    }).join('')}${fd ? `
      <div class="total free ${fd.free >= fd.due ? 'ok' : 'bad'}">
        <div class="label" style="direction:rtl">ימים פנויים בתכנון</div>
        <div class="val num">${fd.free}</div>
        <div class="rep">מינימום <span class="num">${fd.due}</span>${fd.free >= fd.due ? ' ✓' : ''}</div>
      </div>` : ''}
    </div>
    ${days.length ? `<p class="small">${days.join(' · ')}</p>` : ''}
  </div>`;
}

function renderComparison(res) {
  const all = shownComparison(res);
  if (!all.length) return '';
  const FILTERS = {
    comp: (c) => COMP_COLUMNS.has(c.column),
    all: () => true,
    bad: isGap,
  };
  const counts = {
    comp: all.filter(FILTERS.comp).length,
    all: all.length,
    bad: all.filter(isGap).length,
  };
  const rows = all.filter(FILTERS[state.filter] ?? FILTERS.all);
  const chip = (id, label) => `<button class="chip" data-filter="${id}" aria-pressed="${state.filter === id}">${label} (${counts[id]})</button>`;
  return `<details class="card" open>
    <summary><h2 style="display:inline">פירוט</h2></summary>
    <div class="filters">${chip('comp', 'רק פיצויים')}${chip('all', 'הכול')}${chip('bad', 'פערים')}</div>
    <div class="table-wrap"><table>
      <thead><tr><th>ימים</th><th>פיצוי / קרדיט</th><th>צפוי</th><th>ברומה</th><th>פער</th><th></th></tr></thead>
      <tbody>${rows.map((c) => {
        const gap = c.ok === false ? gapClass(c.diff) : c.marks.length ? 'bad' : '';
        const cls = gap || (c.pending ? 'pending' : '');
        const status = gap ? `<span class="status ${gap}">✗</span>` : c.pending ? '<span class="status pending">ממתין</span>' : '<span class="status ok">✓</span>';
        const why = [
          // שורה תקינה מציגה רק הערה שמסבירה פיצוי בלי ודאות (hint).
          ...c.items.filter((e) => (c.ok !== true || e.hint) && (e.ruleTitle || e.note))
            .map((e) => `${esc(e.ruleTitle ?? '')}${e.note ? `: ${esc(e.note)}` : ''}${e.min != null && c.unit !== 'count' ? ` <span class="num">${minToHhmm(e.min)}</span>` : ''}`),
          ...c.marks.map((m) => `${esc(m.column)}: צפוי <span class="num">${hm(m.expected, m.unit)}</span>, ברומה <span class="num">${hm(m.reported, m.unit)}</span>`),
        ].join('<br>');
        return `<tr class="${cls}">
          <td>${esc(c.label).replace(/\n/g, '<br>')}</td><td class="col">${esc(c.column)}${reasonOf(c)}</td>
          <td class="num">${hm(c.expected, c.unit)}</td><td class="num">${hm(c.reported, c.unit)}</td>
          <td class="num">${c.ok ? '' : (c.diff > 0 ? '+' : '') + hm(c.diff, c.unit)}</td><td>${status}</td></tr>
          ${why ? `<tr class="detail"><td colspan="6">${why}</td></tr>` : ''}`;
      }).join('') || '<tr><td colspan="6" class="muted">אין שורות בסינון הזה.</td></tr>'}</tbody>
    </table></div>
  </details>`;
}

// בתכנון לבד בלבד. עם דוח ביצוע ספירת הימים מוצגת בסיכום החודשי מול הדוח.
function renderExpectations(res) {
  if (!res.expectations.length || res.mode !== 'plan') return '';
  const rows = [...res.expectations].sort((a, b) => a.date.localeCompare(b.date));
  const sumKeys = (keys) => rows.filter((e) => keys.has(e.key)).reduce((s, e) => s + e.min, 0);
  // שורה שנייה: Rig, ואחריו כמה ימים זוכו על פעילות שאינה טיסה, לפי סוג.
  const rig = sumKeys(new Set(['rig']));
  const second = [
    ...(rig ? [`Rig: <span class="num">${minToHhmm(rig)}</span>`] : []),
    ...dayCounts(rows),
  ];
  // הקרדיט של כל טיסה הוא רק רעש: הסך הכול בשורה העליונה, ובטבלה רק הפיצויים.
  const shown = rows.filter((e) => !CREDIT_KEYS.has(e.key));
  return `<details class="card" open>
    <summary><h2 style="display:inline">קרדיט ופיצויים צפויים</h2></summary>
    <p class="small">סה"כ קרדיט: <span class="num">${minToHhmm(sumKeys(CREDIT_KEYS))}</span> · סה"כ COM: <span class="num">${minToHhmm(sumKeys(COM_KEYS))}</span></p>
    ${second.length ? `<p class="small">${second.join(' · ')}</p>` : ''}
    ${!shown.length ? '<p class="small muted">אין פיצויים צפויים לפי התכנון.</p>' : `<div class="table-wrap"><table>
      <thead><tr><th>תאריך</th><th>חוק</th><th>סוג</th><th>צפוי</th><th>הסבר</th></tr></thead>
      <tbody>${shown.map((e) => `<tr>
        <td class="num">${e.dates.length > 1 ? `${ddmm(e.dates[0])}–${ddmm(e.dates.at(-1))}` : ddmm(e.date)}</td>
        <td>${esc(e.ruleTitle)}${e.pairing ? `<div class="small muted">${esc(e.pairing)}</div>` : ''}</td>
        <td>${esc(KEY_LABEL[e.key] ?? e.key)}</td>
        <td class="num">${minToHhmm(e.min)}</td>
        <td class="small">${esc(e.note ?? '')}</td></tr>`).join('')}</tbody>
    </table></div>`}
  </details>`;
}

/**
 * תיאור סבב (`describePairing`) הוא קטע לועזי אחד מבודד. בתא עברי רוצים את התאריכים הכי ימניים
 * ומשמאלם את פרטי הטיסה, אז מפצלים כל תיאור כזה לשני קטעים מבודדים, לפי הסדר הזה.
 */
const datesFirst = (text) => text.replace(/⁦(\S+) ([^⁩]*)⁩/g, '⁦$1⁩ ⁦$2⁩');

function renderChanges(res) {
  const changes = res.changes.filter((c) => c.how !== 'exact' && c.how !== 'noplan');
  if (res.mode !== 'full') return '';
  return `<details class="card" ${changes.length ? 'open' : ''}>
    <summary><h2 style="display:inline">שינויים בין תכנון לביצוע <span class="count">${changes.length}</span></h2></summary>
    ${changes.length ? `<ul class="list">${changes.map((c) => `<li>
      <strong class="num">${ddmm(c.date)}</strong> ${esc(c.label)}
      <div class="small">תכנון: ${esc(datesFirst(c.plan ?? '—'))} · ביצוע: ${esc(datesFirst(c.exec ?? (c.replacedBy?.join(', ') || '—')))}</div>
    </li>`).join('')}</ul>` : '<p class="muted">כל הסבבים בוצעו כמתוכנן.</p>'}
  </details>`;
}

function renderAnswered() {
  const answers = Object.entries(state.record?.answers ?? {});
  if (!answers.length) return '';
  return `<details class="card">
    <summary><h2 style="display:inline">תשובות שנשמרו <span class="count">${answers.length}</span></h2></summary>
    <ul class="list">${answers.map(([id, a]) => `<li class="row">
      <span>${esc(describeQuestionId(id))}: <strong>${esc(a.value === 'partial' && a.count ? `ויתרתי מרצוני על ${a.count === 1 ? 'יום אחד' : `${a.count} ימים`}` : answerLabel(a.value))}</strong>
        ${a.link !== undefined ? `<span class="small muted">(${a.link === 'none' ? 'מסירת הטיסה ללא חלופה' : a.link ? `עם ${esc(describePairingId(a.link))}` : 'בחודש אחר'})</span>` : ''}
        ${a.text ? `<span class="small muted">– ${esc(a.text)}</span>` : ''}</span>
      <span class="spacer"></span>
      <button class="btn no-print" data-unanswer="${esc(id)}">שנה</button>
    </li>`).join('')}</ul>
  </details>`;
}

function renderNotes(res) {
  if (!res.notes.length) return '';
  return `<details class="card">
    <summary><h2 style="display:inline">הערות <span class="count">${res.notes.length}</span></h2></summary>
    <ul class="list">${res.notes.map((n) => `<li>${n.date ? `<strong class="num">${ddmm(n.date)}</strong> ` : ''}${esc(n.message)}${n.ruleTitle ? ` <span class="tag">${esc(n.ruleTitle)}</span>` : ''}</li>`).join('')}</ul>
  </details>`;
}

const QUESTION_KIND = { cancelled: 'סבב שלא בוצע', unplanned: 'פעילות לא מתוכננת', replaced: 'סבב שהוחלף', assigned: 'מוצב לפעילות', standby_bid: 'טיסה בסוף כוננות', standby_code: 'קוד כוננות',
  school_start: 'פתיחת שנת הלימודים', free_days: 'ימים ללא פעילות', free_days_first: 'ימים ללא פעילות, X ב-1 לחודש' };

function describeQuestionId(id) {
  const [kind, ...rest] = id.split(':');
  const ref = rest.join(':');
  const what = /^\d{4}-\d{2}-\d{2}$/.test(ref) ? ddmm(ref) : /^\d{4}-\d{2}$/.test(ref) ? `${ref.slice(5)}/${ref.slice(0, 4)}` : describePairingId(ref);
  return `${QUESTION_KIND[kind] ?? kind} ${what}`;
}

/** "2026-07-21..2026-07-22:ATH" → "21/07–22/07 ATH". */
function describePairingId(id) {
  const m = String(id).match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2}):(.*)$/);
  if (!m) return id;
  return `⁦${m[1] === m[2] ? ddmm(m[1]) : `${ddmm(m[1])}–${ddmm(m[2])}`} ${m[3]}⁩`;
}

function bindResults(root) {
  $('[data-action="print"]', root)?.addEventListener('click', () => {
    // ה-PDF מציג הכול בפירוט וכל שאר החלקים פתוחים, בלי קשר למה שמוצג כרגע על המסך.
    const prevFilter = state.filter;
    state.filter = 'all';
    renderResults();
    for (const d of $('#results').querySelectorAll('details')) d.open = true;
    const restore = () => {
      window.removeEventListener('afterprint', restore);
      state.filter = prevFilter;
      renderResults();
    };
    window.addEventListener('afterprint', restore);
    window.print();
  });
  const copy = $('[data-action="copy-codes"]', root);
  copy?.addEventListener('click', async () => {
    const text = unknownCodesText(state.result);
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = 'הועתק';
      setTimeout(() => { copy.textContent = 'העתק פרטים'; }, 2000);
    } catch {
      // דפדפן שאינו מרשה העתקה: מציגים את הטקסט מסומן, להעתקה ידנית.
      const box = document.createElement('textarea');
      box.className = 'copy-text';
      box.readOnly = true;
      box.value = text;
      box.rows = Math.min(12, text.split('\n').length);
      copy.replaceWith(box);
      box.focus();
      box.select();
    }
  });
  for (const chip of root.querySelectorAll('[data-filter]')) {
    chip.addEventListener('click', () => { state.filter = chip.dataset.filter; renderResults(); });
  }
  for (const btn of root.querySelectorAll('[data-unanswer]')) {
    btn.addEventListener('click', async () => {
      delete state.record.answers[btn.dataset.unanswer];
      state.notices = [];
      await runAndSave();
    });
  }
  for (const form of root.querySelectorAll('form[data-qid]')) {
    const submit = $('button[type="submit"]', form);
    form.addEventListener('change', (e) => {
      // בחירת מספר באפשרות שיש בה בחירה כזו בוחרת גם את האפשרות עצמה.
      const countFor = e.target.dataset?.countFor;
      if (countFor) { const radio = $(`input[type="radio"][value="${CSS.escape(countFor)}"]`, form); if (radio) radio.checked = true; }
      const chosen = $('input[type="radio"]:checked', form);
      for (const extra of form.querySelectorAll('.extra')) extra.hidden = extra.dataset.for !== chosen?.value;
      submit.disabled = !chosen && !$('input[type="date"]', form);
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const picker = $('input[type="date"]', form);
      const chosen = $('input[type="radio"]:checked', form);
      if (!chosen && !picker) return;
      if (picker && !picker.value) { alert('בחר תאריך.'); return; }
      const answer = { value: picker ? picker.value : chosen.value };
      if (chosen?.hasAttribute('data-needs-link')) {
        const sel = $(`.extra[data-for="${CSS.escape(chosen.value)}"] select`, form);
        answer.link = sel?.value || null;
      }
      const count = chosen && $(`select[data-count-for="${CSS.escape(chosen.value)}"]`, form);
      if (count) answer.count = Number(count.value);
      if (chosen?.hasAttribute('data-needs-text')) {
        const text = $(`.extra[data-for="${CSS.escape(chosen.value)}"] textarea`, form)?.value.trim();
        if (!text) { alert('פרט בבקשה מה קרה.'); return; }
        answer.text = text;
      }
      state.record.answers = { ...(state.record.answers ?? {}), [form.dataset.qid]: answer };
      state.notices = [];
      await runAndSave();
    });
  }
}

// ---------- היסטוריה ----------

/** הסיכום של חודש שמור לפי החוקים והקוד הנוכחיים, ולא זה שנשמר בהרצה האחרונה שלו. */
function currentSummary(m) {
  if (!state.rulesData || !(m.plan || m.exec)) return m.summary ?? {};
  try {
    return summarize(evaluate({ rulesData: state.rulesData, plan: m.plan, exec: m.exec, answers: m.answers ?? {} }));
  } catch {
    return m.summary ?? {};
  }
}

async function renderHistory() {
  const root = $('#view-history');
  const months = await safe(() => store.listMonths(), []);
  root.innerHTML = `
    <div class="card">
      <h2>חודשים שמורים על המכשיר</h2>
      ${months.length ? `<ul class="list">${months.map((m) => {
        const s = currentSummary(m);
        const tags = [
          m.plan ? '<span class="tag">תכנון</span>' : '',
          m.exec ? '<span class="tag">ביצוע</span>' : '',
          s.questions ? `<span class="tag warn">${s.questions === 1 ? 'שאלה פתוחה אחת' : `${s.questions} שאלות פתוחות`}</span>` : '',
          s.gaps ? `<span class="tag bad">${s.gaps === 1 ? 'פער אחד' : `${s.gaps} פערים`}</span>` : '',
          m.exec && !s.gaps && !s.questions ? '<span class="tag ok">תואם לרומה</span>' : '',
        ].join(' ');
        return `<li class="month-item">
          <span class="name">${esc(monthName(m.period))}</span> ${tags}
          <span class="small muted">חוקים ${esc(m.rulesVersion ?? '?')} · עודכן ${esc(m.updated ? new Date(m.updated).toLocaleDateString('he-IL') : '')}</span>
          <span class="spacer"></span>
          <button class="btn" data-open="${esc(m.key)}">פתח</button>
          <button class="btn danger" data-delete="${esc(m.key)}">מחק</button>
        </li>`;
      }).join('')}</ul>` : '<p class="muted">עדיין אין חודשים שמורים. העלה קובץ במסך הבדיקה.</p>'}
    </div>
    <div class="card">
      <h2>גיבוי ושחזור</h2>
      <p class="small muted">קובץ הגיבוי מכיל את קובצי התכנון והביצוע, את הנתונים שחולצו מהם ואת התשובות שלך, כולל שמות, מספרי טלפון ומספרי סבבים. שמור אותו במקום פרטי. אפשר להעביר איתו את החודשים השמורים בין ה‑iPad למחשב.</p>
      <div class="row">
        <button class="btn" data-action="backup" ${months.length ? '' : 'disabled'}>הורד גיבוי</button>
        <label class="btn">שחזר מקובץ<input type="file" accept="application/json,.json" hidden data-action="restore"></label>
      </div>
    </div>`;

  for (const b of root.querySelectorAll('[data-open]')) b.addEventListener('click', () => openMonth(b.dataset.open));
  for (const b of root.querySelectorAll('[data-delete]')) {
    b.addEventListener('click', async () => {
      if (!confirm('למחוק את החודש מהחודשים השמורים? התשובות שנתת עליו יימחקו.')) return;
      await store.deleteMonth(b.dataset.delete);
      if (state.record?.key === b.dataset.delete) { state.record = null; state.result = null; state.notices = []; renderUploadState(); renderResults(); }
      renderHistory();
    });
  }
  $('[data-action="backup"]', root)?.addEventListener('click', async () => {
    const data = await store.exportBackup();
    download(`elal-compensations-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
  });
  $('[data-action="restore"]', root)?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const c = await store.importBackup(JSON.parse(await file.text()));
      alert(`שוחזרו ${c.added} חודשים חדשים, ${c.replaced} עודכנו, ${c.skipped} דולגו (הגרסה במכשיר חדשה יותר).` +
        (c.files ? ` שוחזרו ${c.files === 1 ? 'קובץ PDF אחד' : `${c.files} קובצי PDF`}.` : ''));
      // ייתכן ששוחזר קובץ לחודש הפתוח: לטעון אותו מחדש לכפתור "פתח קובץ".
      for (const kind of Object.keys(PARSERS)) dropFileLink(kind);
      renderUploadState();
    } catch (err) {
      alert(`השחזור נכשל: ${err.message}`);
    }
    renderHistory();
  });
}

function download(name, content, type) {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- מסך החוקים ----------

const rulesUi = { q: '', category: '', showCancelled: false };

function renderRules() {
  const root = $('#view-rules');
  const data = state.rulesData;
  if (!data) { root.innerHTML = '<p class="muted">החוקים לא נטענו.</p>'; return; }
  if (!root.dataset.built) {
    root.innerHTML = `
      <div class="card">
        <div class="result-head">
          <h2>טבלת החוקים</h2>
          <span class="meta">גרסה ${esc(data.rules_version)} · עודכן ${esc(data.updated)}${state.rulesSource === 'cache' ? ' · עותק שמור' : ''}</span>
        </div>
        <p class="small muted">${esc(data.precedence ?? '')}</p>
        <div class="rules-tools no-print">
          <input type="search" placeholder="חיפוש בחוקים…" aria-label="חיפוש">
          <select aria-label="קטגוריה">
            <option value="">כל הקטגוריות</option>
            ${Object.entries(CATEGORY_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
            <option value="unsupported">לא נתמך</option>
          </select>
          <label class="small"><input type="checkbox"> הצג חוקים מבוטלים</label>
          <span class="spacer"></span>
          <button class="btn" data-action="export-json">ייצוא rules.json</button>
          <button class="btn" data-action="export-xlsx">ייצוא ל-Excel</button>
        </div>
        <div class="small muted" data-role="count"></div>
      </div>
      <div data-role="list"></div>`;
    root.dataset.built = '1';
    $('input[type="search"]', root).addEventListener('input', (e) => { rulesUi.q = e.target.value; renderRuleList(); });
    $('select', root).addEventListener('change', (e) => { rulesUi.category = e.target.value; renderRuleList(); });
    $('input[type="checkbox"]', root).addEventListener('change', (e) => { rulesUi.showCancelled = e.target.checked; syncCancelledOption(root); renderRuleList(); });
    $('[data-action="export-json"]', root).addEventListener('click', exportRulesJson);
    $('[data-action="export-xlsx"]', root).addEventListener('click', exportRulesXlsx);
  }
  renderRuleList();
}

/**
 * אפשרות הסינון "מבוטל" קיימת רק כשהתיבה מסומנת. כשמורידים את הסימון בזמן שהיא
 * נבחרה, הסינון חוזר לכל הקטגוריות.
 */
function syncCancelledOption(root) {
  const select = $('select', root);
  const option = $('option[value="cancelled"]', select);
  if (rulesUi.showCancelled) {
    if (!option) select.add(new Option('מבוטל', 'cancelled'));
    return;
  }
  option?.remove();
  if (rulesUi.category === 'cancelled') { rulesUi.category = ''; select.value = ''; }
}

/** החוקים לפי החיפוש והסינון שבמסך, והסיבה לכל חוק שאינו נתמך. */
function filteredRules() {
  const data = state.rulesData;
  const { unsupported } = partitionRules(data.rules);
  const reasonOf = new Map(unsupported.map((u) => [u.rule.id, u.reason]));
  const q = rulesUi.q.trim().toLowerCase();

  const rules = data.rules.filter((r) => {
    // חוק שבוטל היה בתוקף עד שבוטל; `valid_from`/`valid_to` משמשים לחישוב חודשי עבר
    // ולא לתצוגה. למשתמש מוצג רק "בוטל", וכברירת מחדל הוא מוסתר.
    const isCancelled = r.status === 'cancelled';
    if (isCancelled && !rulesUi.showCancelled) return false;
    if (rulesUi.category === 'cancelled') { if (!isCancelled) return false; }
    else if (rulesUi.category === 'unsupported') { if (!reasonOf.has(r.id)) return false; }
    else if (rulesUi.category && r.category !== rulesUi.category) return false;
    if (!q) return true;
    return [r.id, r.title, r.when, r.amount?.text, r.source, r.note, r.logic?.id].some((s) => String(s ?? '').toLowerCase().includes(q));
  });
  return { rules, reasonOf };
}

const dmy = (iso) => (iso ? iso.split('-').reverse().join('/') : null);
/** סוף התוקף. חוק שבוטל בלי `valid_to` הוא חוק שמועד הביטול שלו אינו ידוע. */
const validTo = (r) => dmy(r.valid_to) ?? (r.status === 'cancelled' ? 'מועד לא ידוע' : 'היום');
const amountText = (r) => r.amount?.text ?? (r.amount?.value != null ? `${r.amount.value}` : '—');

function renderRuleList() {
  const root = $('#view-rules');
  const data = state.rulesData;
  const { rules, reasonOf } = filteredRules();

  $('[data-role="count"]', root).textContent = `מוצגים ${rules.length} מתוך ${data.rules.length} חוקים (מתוכם ${rules.filter((r) => reasonOf.has(r.id)).length} לא נתמכים)`;
  $('[data-role="list"]', root).innerHTML = rules.map((r) => {
    const reason = reasonOf.get(r.id);
    const tags = [
      `<span class="tag">${esc(CATEGORY_LABEL[r.category] ?? r.category)}</span>`,
      r.status === 'cancelled' ? '<span class="tag bad">בוטל</span>' : '',
      r.status === 'changed' ? '<span class="tag warn">שונה</span>' : '',
      reason ? '<span class="tag warn">לא נתמך</span>' : '<span class="tag ok">נתמך</span>',
    ].join(' ');
    const validity = `מ-${dmy(r.valid_from) ?? 'תמיד'} עד ${validTo(r)}`;
    return `<article class="rule ${r.status === 'cancelled' ? 'inactive' : ''}">
      <div class="rule-head"><h3>${esc(r.title)}</h3>${tags}</div>
      <dl>
        <dt>מתי</dt><dd>${esc(r.when)}</dd>
        <dt>כמה</dt><dd>${esc(amountText(r))}</dd>
        <dt>מקור</dt><dd>${esc(r.source)}</dd>
        <dt>תוקף</dt><dd>${esc(validity)}</dd>
        ${r.note ? `<dt>הערה</dt><dd>${esc(r.note)}</dd>` : ''}
        ${reason ? `<dt>למה לא נתמך</dt><dd>${esc(reason)}</dd>` : ''}
        <dt>מזהה</dt><dd><code>${esc(r.id)}</code> · <code>${esc(r.logic?.id ?? '')}</code></dd>
      </dl>
    </article>`;
  }).join('') || '<p class="muted">לא נמצאו חוקים.</p>';
}

/** הקובץ המקורי כמו שהוא בשרת, כדי לשמור על הפורמט. בלי רשת – מהעותק השמור. */
async function exportRulesJson() {
  let text;
  try {
    const res = await fetch(new URL('../rules.json', import.meta.url), { cache: 'no-cache' });
    if (!res.ok) throw new Error();
    text = await res.text();
  } catch {
    text = JSON.stringify(state.rulesData, null, 2);
  }
  download('rules.json', text, 'application/json');
}

/** כל החוקים כגיליון Excel, בלי קשר לחיפוש ולסינון שבמסך. */
function exportRulesXlsx() {
  const { reasonOf } = filteredRules();
  const rules = state.rulesData.rules;
  const STATUS = { ok: '', cancelled: 'בוטל', changed: 'שונה' };
  const header = ['שם', 'קטגוריה', 'מתי', 'כמה', 'מקור', 'בתוקף מ-', 'בתוקף עד', 'סטטוס', 'נתמך', 'הערה', 'למה לא נתמך', 'מזהה', 'לוגיקה'];
  const rows = rules.map((r) => [
    r.title,
    CATEGORY_LABEL[r.category] ?? r.category,
    r.when,
    amountText(r),
    r.source,
    dmy(r.valid_from) ?? 'תמיד',
    validTo(r),
    STATUS[r.status] ?? r.status,
    reasonOf.has(r.id) ? 'לא' : 'כן',
    r.note,
    reasonOf.get(r.id),
    r.id,
    r.logic?.id,
  ]);
  const blob = xlsxBlob(header, rows, { sheet: 'חוקים', widths: [30, 10, 50, 30, 25, 11, 11, 10, 7, 40, 40, 28, 24] });
  download(`rules-${state.rulesData.rules_version}.xlsx`, blob);
}
