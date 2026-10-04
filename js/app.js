// ממשק האפליקציה: העלאת קבצים, הרצת המנוע, שאלות, היסטוריה ומסך החוקים.
// כל העיבוד על המכשיר. אין כאן ערכי פיצוי: הכול מגיע מ-rules.json דרך המנוע.

import { parsePlan } from './pdf/plan.js';
import { parseExec } from './pdf/exec.js';
import { xlsxBlob } from './xlsx.js';
import { evaluate, monthCalendar, calendarGaps } from './rules/evaluate.js';
import { loadRules, partitionRules } from './rules/catalog.js';
import { minToHhmm } from './time.js';
import * as store from './store.js';
import * as calendar from './calendar.js';

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
// תוויות לתשובות שנשמרו לפני שהתווית של האפשרות נשמרה איתן (`answer.label`). ערך שאינו כאן מוצג כמות שהוא.
const ANSWER_LABEL = {
  special_call: 'קריאה מיוחדת', voluntary_swap: 'החלפה מרצוני', replaced: 'החלפה ביוזמת החברה (כולל זכיה במכרז או סטיה לשדה משנה)',
  wet_lease: 'הורדה מהטיסה המקורית', trainee: 'הורדה מהטיסה המקורית', swap_777: 'הטיסה עברה ל-777 (לא כשיר MFF)',
  cancelled: 'הטיסה המקורית בוטלה ללא קרדיט', other: 'סיבה אחרת',
  yes: 'כן', no: 'לא',
  company: 'לבקשת החברה', own: 'ויתור מרצון',
  standby_bid: 'סיום כוננות בגלל זכייה במכרז', standby_activated: 'הפעלת הכוננות', regular_standby: 'מצב הכן רגיל',
  single: 'צוות בודד (2 טייסים)', augmented: 'צוות מוגבר (3 טייסים)', double: 'צוות כפול (4 טייסים)',
};

// "כן" ו"לא" שייכים לשאלה, ולא לערך: בלעדי זה תשובה על סטיה לשדה משנה הוצגה "כן, הייתי מוצב" (23/09/2024).
const ANSWER_LABEL_BY_KIND = { assigned: { yes: 'כן, הייתי מוצב', no: 'לא הייתי מוצב' } };

/** ערך תשובה לתצוגה. תאריך שנבחר ביומן מוצג כיום/חודש. */
const answerLabel = (v, kind = null) => ANSWER_LABEL_BY_KIND[kind]?.[v] ?? ANSWER_LABEL[v] ?? (/^\d{4}-\d{2}-\d{2}$/.test(v) ? ddmm(v) : v);

const state = {
  rulesData: null,
  rulesSource: null,
  rulesError: null,
  record: null, // רשומת החודש הפתוח
  result: null,
  filter: 'comp',
  notices: [],
  files: {}, // kind → {id: "2026-07:plan", url} של קובץ ה-PDF השמור, ללחיצה על הקובץ באזור ההעלאה
  sections: { key: null, open: new Map() }, // אילו חלקים בתוצאות של החודש הפתוח פתוחים ואילו מכווצים
  calendar: null, // חיבור היומן: {clientId, calendars: [{id, name}], manual, hint, facts, synced}, או null
  calBusy: false,
  calInfo: false,
  calGaps: null, // {key, items}: פערים שהעדכון האחרון מהיומן מצא בחודש הפתוח (`calendarGaps`)
  calError: null,
};

// ---------- אתחול ----------

init();

async function init() {
  setupTabs();
  setupUploads();
  registerServiceWorker();
  try {
    const { data, source, error } = await loadRules();
    state.rulesData = data;
    state.rulesSource = source;
    state.rulesError = error;
  } catch (err) {
    showBanner('bad', esc(err.message));
    return;
  }
  if (state.rulesSource === 'cache') {
    showBanner('warn', `לא ניתן היה לטעון את החוקים מהרשת${state.rulesError ? ` (<bdi dir="ltr">${esc(state.rulesError)}</bdi>)` : ''}. הם נטענו מהעותק השמור על המכשיר (גרסה ${esc(state.rulesData.rules_version)}).`);
  }
  state.calendar = calendarSetting(await safe(() => store.getSetting(CAL_SETTING), null));
  // החודש האחרון שעבדו עליו נפתח אוטומטית.
  const months = await safe(() => store.listMonths(), []);
  if (months.length) await openMonth(months[0].key, { quiet: true });
  else renderResults();
  // יומן מחובר: ספריית ההתחברות נטענת מראש, כדי שהחלון של גוגל ייפתח מיד בלחיצה. העדכון עצמו רק
  // בפעולה של המשתמש (`calendarToken`).
  if (state.calendar) calendar.preload();
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
    // כשיש קובץ, לחיצה עליו פותחת אותו, וקובץ חדש נבחר רק ב"בחר חודש אחר" (בעל המוצר, 29/09/2026).
    // הלחיצה של `input.click()` עוברת גם היא דרך האזור, ואסור לבטל אותה.
    zone.addEventListener('click', (e) => {
      if (zone.classList.contains('loaded') && e.target !== input) e.preventDefault();
    });
    $('.drop-file', zone).addEventListener('click', () => {
      const url = state.files[zone.dataset.kind]?.url;
      if (url) window.open(url, '_blank');
    });
    $('.drop-pick', zone).addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      if (input.files[0]) handleFile(input.files[0], zone.dataset.kind, calendarToken());
      input.value = '';
    });
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file, zone.dataset.kind, calendarToken());
    });
  }
}

const PARSERS = { plan: parsePlan, exec: parseExec };

/**
 * קריאת קובץ. אם הקובץ הועלה לאזור הלא נכון, מזהים אותו לפי התוכן ומעבירים.
 */
/** `calToken`: ההרשאה ליומן שהתבקשה בבחירת הקובץ (`calendarToken`); היומן מתעדכן אחרי הקריאה. */
async function handleFile(file, expected, calToken = null) {
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
  if (calToken) syncCalendar(calToken);
}

function renderUploadState() {
  for (const zone of document.querySelectorAll('.drop')) {
    const kind = zone.dataset.kind;
    const r = state.record;
    const loaded = !!r?.[kind];
    zone.classList.toggle('loaded', loaded);
    $('.drop-state', zone).textContent = 'לא נבחר קובץ. לחץ או גרור לכאן';
    // רק החודש והשנה בשתי ספרות, "אוקטובר 26": הכותרת של האזור כבר אומרת איזה קובץ (בעל המוצר, 29/09/2026).
    $('.drop-month', zone).textContent = loaded ? `${MONTH_NAMES[r.period.month - 1]} ${String(r.period.year).slice(-2)}` : '';
    $('.drop-name', zone).textContent = loaded ? r[`${kind}File`] ?? 'נטען מהחודשים השמורים' : '';
    refreshFileLink(zone, kind);
  }
}

/**
 * קובץ ה-PDF השמור של החודש הפתוח, ללחיצה על הקובץ. חודש שנשמר לפני שהקבצים נשמרו – הקובץ מוצג
 * בלי אפשרות לפתוח אותו.
 */
async function refreshFileLink(zone, kind) {
  const button = $('.drop-file', zone);
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
  const url = state.files[kind]?.url;
  button.disabled = !url;
  button.title = url ? 'פתיחת הקובץ' : 'הקובץ לא נשמר במכשיר. בחר אותו שוב כדי לשמור אותו.';
}

function dropFileLink(kind) {
  if (state.files[kind]?.url) URL.revokeObjectURL(state.files[kind].url);
  delete state.files[kind];
}

// ---------- הרצה ----------

async function runAndSave() {
  const r = state.record;
  const months = await safe(() => store.listMonths(), []);
  // ההשלמות מהיומן נשמרות בחודש, ונשארות בו גם אחרי ניתוק (בעל המוצר, 04/10/2026). יומן שאין בו
  // דבר מהחודש אינו מוחק את מה שנשמר.
  const fresh = monthCalendar(calendarFacts(), r.period);
  if (fresh?.flights.length || fresh?.standby.length) r.calendar = fresh;
  state.result = evaluate({ rulesData: state.rulesData, plan: r.plan, exec: r.exec, answers: r.answers ?? {}, history: historyFor(r.key, months), calendar: r.calendar ?? null });
  r.rulesVersion = state.result.rulesVersion;
  r.summary = summarize(state.result);
  await safe(() => store.putMonth(r));
  renderUploadState();
  renderResults();
}

// ---------- יומן (רשות) ----------
//
// הנחת היסוד היא שאין יומן, ומה שחסר בקבצים נשאל (בעל המוצר, 03/10/2026). משתמש שמחבר את יומן
// האורגנייזר מקבל ממנו השלמות בלבד – הרכב הצוות ושעות הכוננות (js/calendar.js) – והן נשמרות על
// המכשיר בלי שמות. התכנון והביצוע תמיד מהקבצים.

const CAL_SETTING = 'calendar';
const CAL_CLIENT = 'calendar-client';
const CAL_NO_DATA = 'לא נמצאו ביומן נתוני סבבים. ייתכן שחובר יומן לא מתאים, או שהיומן מתאים אבל לא בוצע בו סנכרון דרך האורגנייזר.';

const calendarFacts = () => state.calendar?.facts ?? null;
// חיבור שנשמר לפני 03/10/2026, ליומן אחד.
const calendarSetting = (c) => (c && !c.calendars ? { ...c, calendars: [{ id: c.calendarId, name: c.calendarName }] } : c);
const pad2 = (n) => String(n).padStart(2, '0');
const stamp = (iso) => { const d = new Date(iso); return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

/**
 * חלקי שורת היומן המחובר: הטקסט ("יומן מעודכן ל…") והכפתורים, ופרטי היומן. במחשב עם עכבר הפרטים בחלון צף
 * על הטקסט, ובמכשיר בלי עכבר (אייפד) בלחיצה עליו (בעל המוצר, 03/10/2026).
 */
function calendarParts(c) {
  if (!c) {
    return { label: '<span class="cal-label">יומן: לא מחובר</span>', buttons: '<button type="button" class="btn" data-cal="connect">חיבור יומן</button>', infoHtml: '' };
  }
  const n = state.result?.calendarCrew ?? 0;
  const when = state.calBusy ? 'מתעדכן…' : c.synced ? `מעודכן ל-${stamp(c.synced)}` : 'עוד לא עודכן';
  const noData = c.synced && !c.facts?.flights?.length;
  const info = [`${c.calendars.length === 1 ? 'יומן מחובר' : 'יומנים מחוברים'}: ${c.calendars.map((x) => x.name).join(', ')}`,
    n ? `הרכב הצוות של ${n} ${state.result?.monthFlights >= n ? `מתוך ${state.result.monthFlights} ` : ''}${n === 1 && !(state.result?.monthFlights >= n) ? 'טיסה' : 'טיסות'} בחודש הזה מהיומן` : ''].filter(Boolean);
  const hover = matchMedia('(hover: hover)').matches;
  const label = hover
    ? `<span class="cal-label" title="${esc(info.join('\n'))}">יומן ${when}</span>`
    : `<button type="button" class="cal-toggle cal-label" data-cal="info" aria-expanded="${state.calInfo}">יומן ${when}</button>`;
  const buttons = `${noData ? '<button type="button" class="btn" data-cal="connect">יומן אחר</button>' : ''}
    <button type="button" class="btn" data-cal="sync" ${state.calBusy ? 'disabled' : ''}>עדכון</button>
    <button type="button" class="btn" data-cal="disconnect">ניתוק יומן</button>`;
  const infoHtml = !hover && state.calInfo ? `<div class="small muted cal-info">${info.map(esc).join('<br>')}</div>` : '';
  return { label, buttons, infoHtml };
}

function bindCalendar(scope) {
  if (!scope) return;
  $('[data-cal="connect"]', scope)?.addEventListener('click', openCalendarDialog);
  $('[data-cal="info"]', scope)?.addEventListener('click', () => { state.calInfo = !state.calInfo; renderCalendarBar(); });
  $('[data-cal="sync"]', scope)?.addEventListener('click', () => syncCalendar());
  $('[data-cal="disconnect"]', scope)?.addEventListener('click', disconnectCalendar);
}

/** פער בין היומן המעודכן לבין מה שנשמר בחודש, לתצוגה. */
function describeGap(g) {
  const crew = (v) => answerLabel(v, 'crew');
  if (g.kind === 'answer') {
    const kind = g.id.split(':')[0];
    return `${describeQuestionId(g.id)}: תשובתך ${answerLabel(g.answer, kind)}, וביומן ${answerLabel(g.calendar, kind)}. התשובה שלך קובעת. אפשר לשנות אותה ב"תשובות שנשמרו".`;
  }
  const what = `⁦${ddmm(g.date)} ${g.flight}⁩`;
  return g.kind === 'removed'
    ? `${what}: הטיסה כבר אינה ביומן. קודם: ${crew(g.before)}.`
    : `${what}: ביומן הקודם ${crew(g.before)}, עכשיו ${crew(g.after)}.`;
}

/** שורת היומן: בראש התוצאות, ליד שם החודש, כשיש חודש פתוח; אחרת מתחת לאזור ההעלאה. */
function renderCalendarBar() {
  const bar = $('#calendar-bar');
  if (!bar) return;
  const c = state.calendar;
  const notices = [];
  if (state.calError) notices.push(`<div class="notice bad">${esc(state.calError)}</div>`);
  else if (c?.synced && !c.facts?.flights?.length) notices.push(`<div class="notice warn">${esc(CAL_NO_DATA)}</div>`);
  const gaps = state.calGaps?.key === state.record?.key ? state.calGaps.items : [];
  if (gaps.length) {
    notices.push(`<div class="notice warn">היומן המעודכן שונה ממה שנשמר בחודש הזה:<ul>${gaps.map((g) => `<li>${esc(describeGap(g))}</li>`).join('')}</ul></div>`);
  }
  const parts = calendarParts(c);
  if (state.result) {
    bar.innerHTML = notices.join('');
    const host = $('#head-cal');
    if (host) {
      host.innerHTML = parts.label + parts.buttons;
      $('#head-cal-info').innerHTML = parts.infoHtml;
      bindCalendar(host);
    }
  } else {
    bar.innerHTML = `<div class="row">${parts.label}<span class="spacer"></span>${parts.buttons}</div>${parts.infoHtml}${notices.join('')}`;
  }
  bindCalendar(bar);
}

/**
 * חלון החיבור: הסבר, הגדרה חד-פעמית של מזהה ההתחברות (כשאין מזהה מובנה), התחברות לגוגל, ואיתור
 * יומן האורגנייזר. כשלא נמצא יומן עם נתונים – הודעה ובחירה ידנית מרשימת היומנים.
 */
async function openCalendarDialog() {
  const dlg = $('#calendar-dialog');
  const builtin = calendar.BUILTIN_CLIENT_ID;
  const saved = builtin || (await safe(() => store.getSetting(CAL_CLIENT), null)) || '';
  calendar.preload();
  dlg.innerHTML = `<h2>חיבור יומן</h2>
    <p class="small muted">היומן נקרא מגוגל ישירות למכשיר הזה, בהרשאת קריאה בלבד. נשמרים רק מספר הטייסים בכל טיסה ופרטי טיסה שלא ניתן למצוא בקבצי התכנון והביצוע, בלי שמות וטלפונים.</p>
    ${builtin ? '' : `<details dir="ltr" lang="en" ${saved ? '' : 'open'}><summary>One-time setup: Google Client ID</summary>
      <ol class="small">
        <li>Open <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud Console</a> and sign in with the Google account that holds your calendar. Click Select a project › New project, enter any name, and click Create. Make sure the new project is selected at the top of the page.</li>
        <li>In the search bar, type Google Calendar API, open it, and click Enable.</li>
        <li>Search for Google Auth Platform and click Get started. Enter any app name and your email, choose Audience: External, and click Create.</li>
        <li>Go to Audience › Test users, click Add users, enter your Gmail address, and click Save.</li>
        <li>Go to Clients › Create client and choose Web application. Under Authorized JavaScript origins, add ${esc(location.origin)}, then click Create.</li>
        <li>Copy the Client ID (it ends with .apps.googleusercontent.com) and paste it below.</li>
      </ol>
      <p class="small muted">When you sign in, Google will show "Google hasn't verified this app". Click Continue.</p></details>
    <label>Client ID <input name="clientId" dir="ltr" autocomplete="off" spellcheck="false" value="${esc(saved)}"></label>`}
    <p class="small">בלחיצה על "התחברות לגוגל" ייפתח חלון של גוגל: בחר את חשבון הגוגל שאליו האורגנייזר מסנכרן את היומן, ואשר את שתי ההרשאות לקריאת היומן.</p>
    <p class="small muted" dir="auto">אם גוגל מציג <bdi dir="ltr">Google hasn't verified this app</bdi>, לחץ על <bdi dir="ltr">Advanced</bdi> ואז על <bdi dir="ltr">Go to … (unsafe)</bdi>.</p>
    <p class="small muted"><a href="privacy.html" target="_blank" rel="noopener">מדיניות פרטיות</a></p>
    <div class="cal-step"></div>
    <div class="row"><button type="button" class="btn primary" data-cal="login">התחברות לגוגל</button>
      <button type="button" class="btn" data-cal="close">ביטול</button></div>`;
  const step = (kind, html) => { $('.cal-step', dlg).innerHTML = html ? `<div class="notice ${kind}">${html}</div>` : ''; };
  $('[data-cal="close"]', dlg).addEventListener('click', () => dlg.close());
  $('[data-cal="login"]', dlg).addEventListener('click', async () => {
    const clientId = (builtin || $('input[name="clientId"]', dlg).value).trim();
    if (!calendar.CLIENT_ID_PATTERN.test(clientId)) {
      step('bad', 'ה-<bdi dir="ltr">Client ID</bdi> אינו תקין. הוא מסתיים ב-<bdi dir="ltr">.apps.googleusercontent.com</bdi>.');
      return;
    }
    // החלון של גוגל נפתח מיד, בלי המתנה לפניו בתוך הלחיצה.
    const pending = calendar.requestToken(clientId, { consent: true });
    step('info', 'מתחבר לגוגל…');
    try {
      const token = await pending;
      if (!builtin) await safe(() => store.putSetting(CAL_CLIENT, clientId));
      step('info', 'מחפש את יומן האורגנייזר…');
      const all = await calendar.listCalendars(token);
      const { timeMin, timeMax } = await calendarRange();
      const found = await calendar.findOrganizerCalendars(token, all, timeMin, timeMax);
      if (found.length) {
        dlg.close();
        await connectCalendar(clientId, found);
        return;
      }
      step('warn', `לא נמצאו נתוני סבבים באף יומן בחשבון הזה. ייתכן שנבחר חשבון גוגל לא מתאים, או שלא בוצע סנכרון דרך האורגנייזר.
        <label>אפשר לבחור יומן בעצמך <select name="calendarId">${all.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label>
        <button type="button" class="btn" data-cal="pick">חיבור היומן הזה</button>`);
      $('[data-cal="pick"]', dlg).addEventListener('click', async () => {
        const id = $('select[name="calendarId"]', dlg).value;
        dlg.close();
        await connectCalendar(clientId, [all.find((c) => c.id === id)], { manual: true });
      });
    } catch (err) {
      step('bad', esc(err.message));
    }
  });
  dlg.showModal();
}

/** `manual`: יומן שהמשתמש בחר, ולא מחפשים במקומו. אחרת כל עדכון מחפש מחדש (`syncCalendar`). */
async function connectCalendar(clientId, cals, { manual = false } = {}) {
  state.calendar = { clientId, calendars: cals.map(({ id, name }) => ({ id, name })), manual, facts: null, synced: null };
  state.calError = null;
  await safe(() => store.putSetting(CAL_SETTING, state.calendar));
  await syncCalendar();
}

/**
 * ההשלמות מהיומן לכל החודשים השמורים, ועד חודשיים קדימה. `pending`: ההרשאה (`calendarToken`). היומנים עם אירועי האורגנייזר נמצאים מחדש בכל
 * עדכון, כי האורגנייזר יכול לפתוח יומן חדש (03/10/2026); בלי ממצא – היומנים שכבר מחוברים.
 */
async function syncCalendar(pending = calendarToken()) {
  const c = state.calendar;
  if (!c || state.calBusy || !pending) return;
  state.calBusy = true;
  state.calError = null;
  renderCalendarBar();
  try {
    const token = await pending;
    const { timeMin, timeMax } = await calendarRange();
    let cals = c.calendars;
    const all = await calendar.listCalendars(token);
    if (!c.manual) {
      const found = await calendar.findOrganizerCalendars(token, all, timeMin, timeMax);
      if (found.length) cals = found.map(({ id, name }) => ({ id, name }));
    }
    const facts = await calendar.fetchFacts(token, cals.map((x) => x.id), timeMin, timeMax);
    // הפערים נבדקים מול החודש הפתוח בלבד (בעל המוצר, 04/10/2026), לפני שהיומן המעודכן נשמר בו.
    const r = state.record;
    state.calGaps = r && state.result ? { key: r.key, items: calendarGaps({ prev: r.calendar, fresh: monthCalendar(facts, r.period), answers: r.answers ?? {}, domicile: state.result.domicile, period: r.period }) } : null;
    const hint = all.find((x) => x.primary)?.id ?? c.hint ?? null;
    state.calendar = { ...c, calendars: cals, hint, facts, synced: new Date().toISOString() };
    await safe(() => store.putSetting(CAL_SETTING, state.calendar));
  } catch (err) {
    state.calError = err.message;
  }
  state.calBusy = false;
  if (state.record) await runAndSave();
  else renderCalendarBar();
}

/**
 * היומן מתעדכן רק בפעולה של המשתמש: "עדכון מהיומן", בחירת קובץ ופתיחת חודש שמור (בעל המוצר,
 * 03/10/2026). ההרשאה מתבקשת מיד, בתוך הפעולה: כשהקודמת פגה גוגל פותח חלון, ודפדפן חוסם חלון שלא
 * נפתח בתגובה ישירה ללחיצה. null – אין יומן, או שאין הרשאה בתוקף והפעולה כבר אינה נחשבת לחיצה
 * (גרירת קובץ, או בחירת קובץ אחרי שהלחיצה פגה).
 */
function calendarToken() {
  const c = state.calendar;
  if (!c || state.calBusy) return null;
  const token = calendar.cachedToken();
  if (token) return Promise.resolve(token);
  if (navigator.userActivation && !navigator.userActivation.isActive) return null;
  return calendar.requestToken(c.clientId, { hint: c.hint });
}

async function calendarRange() {
  const keys = (await safe(() => store.listMonths(), [])).map((m) => m.key).sort();
  const now = Date.now();
  const day = 864e5;
  const first = keys.length ? Date.parse(`${keys[0]}-01T00:00:00Z`) - 2 * day : now - 400 * day;
  const last = keys.length ? Date.parse(`${keys.at(-1)}-01T00:00:00Z`) + 33 * day : now;
  return { timeMin: new Date(Math.max(first, now - 760 * day)).toISOString(), timeMax: new Date(Math.max(last, now) + 62 * day).toISOString() };
}

async function disconnectCalendar() {
  await calendar.revoke();
  state.calendar = null;
  state.calError = null;
  await safe(() => store.deleteSetting(CAL_SETTING));
  if (state.record) await runAndSave();
  else renderCalendarBar();
}

/**
 * החודשים שלפני `key`, מהחדש לישן, לחלונות של מגבלות החוק שמתחילים לפני החודש (168 שעות,
 * 672 שעות, 365 ימים). `months` כבר ממוינים מהחדש לישן.
 */
function historyFor(key, months) {
  return months.filter((m) => m.key < key && (m.plan || m.exec)).map((m) => ({ period: m.period, plan: m.plan ?? null, exec: m.exec ?? null }));
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

/**
 * שורת פיצוי או Rig מוסברת בטבלה עצמה, ולא בהערות (בעל המוצר, 01/10/2026): מתחת לטיסה ההסבר
 * (`explain` של כל ציפייה) ואחריו שם החוק בתגית, כמו בהערות. הסכום אינו בהסבר, כי הוא כבר בשורה;
 * רק כשכמה חוקים חולקים שורה כתוב ליד כל אחד החלק שלו. קריאה מיוחדת היא תגית בלבד. `notes` של
 * השורה: פיצוי שברומה ואף חוק אינו מסביר.
 */
function explainOf(c) {
  if (!COMP_COLUMNS.has(c.column)) return '';
  const share = (e) => (c.items.length > 1 && c.unit !== 'count' ? ` · <span class="num">${minToHhmm(e.min)}</span>` : '');
  const lines = [
    ...c.items.map((e) => `${esc(share(e) ? (e.explain ?? '').replace(/\.$/, '') : e.explain ?? '')}${share(e)}${e.ruleTitle ? ` <span class="tag">${esc(e.ruleTitle)}</span>` : ''}`.trim()),
    ...(c.notes ?? []).map(esc),
  ];
  return [...new Set(lines.filter(Boolean))].map((l) => `<div class="explain">${l}</div>`).join('');
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
    legal: res.legal?.violations.length ?? 0,
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

/**
 * מה שהמשתמש פתח או כיווץ נשאר כך בין ציור לציור של אותו חודש (בעל המוצר, 01/10/2026): שינוי
 * תשובה, תשובה חדשה וסינון אינם מחזירים את החלקים לברירת המחדל. חודש אחר מתחיל מברירת המחדל.
 * `keepDom` false: המצב שעל המסך אינו של המשתמש (ההדפסה פותחת הכול), ולכן לא נקרא ממנו.
 */
function renderResults(keepDom = true) {
  const root = $('#results');
  const res = state.result;
  const key = state.record?.key ?? null;
  if (state.sections.key !== key) state.sections = { key, open: new Map() };
  else if (keepDom) for (const d of root.querySelectorAll('details[data-section]')) state.sections.open.set(d.dataset.section, d.open);
  renderCalendarBar();
  const parts = [state.notices.map((n) => `<div class="notice ${n.kind}">${esc(n.text)}</div>`).join('')];
  if (!res) { root.innerHTML = parts.join(''); return; }

  parts.push(renderHead(res));
  parts.push(renderLegal(res));
  parts.push(renderAlerts(res));
  parts.push(renderQuestions(res));
  parts.push(renderTotals(res));
  parts.push(renderComparison(res));
  parts.push(renderExpectations(res));
  parts.push(renderChanges(res));
  parts.push(renderNotes(res));
  parts.push(renderAnswered());
  root.innerHTML = parts.join('');
  for (const d of root.querySelectorAll('details[data-section]')) {
    if (state.sections.open.has(d.dataset.section)) d.open = state.sections.open.get(d.dataset.section);
  }
  bindResults(root);
}

function renderHead(res) {
  const r = state.record;
  const emp = r.exec?.employee?.name ?? (r.plan?.employee ? `${r.plan.employee.last} ${r.plan.employee.first ?? ''}` : '');
  // פרטי החישוב לא על המסך: בחלון צף במעבר עם העכבר, ובמכשיר בלי עכבר (אייפד) בלחיצה על שם החודש. בהדפסה הם מופיעים.
  const meta = `${MODE_LABEL[res.mode]} · בסיס ${res.domicile ?? '?'}${res.fleet ? ` · צי ${res.fleet}` : ''} · חוקים ${res.rulesVersion}`;
  const hover = matchMedia('(hover: hover)').matches;
  return `<div class="card">
    <div class="result-head">
      <h2${hover ? ` title="${esc(meta)}"` : ''}>${hover ? '' : '<button type="button" class="cal-toggle" data-action="head-info">'}${esc(monthName(res.period))}${hover ? '' : '</button>'}</h2>
      <span class="meta head-meta">${esc(meta)}</span>
      <span class="cal-inline no-print" id="head-cal"></span>
      <span class="spacer"></span>
      <button class="btn no-print" data-action="print">ייצוא PDF</button>
    </div>
    <div class="no-print" id="head-cal-info"></div>
    ${hover ? '' : `<p class="small muted no-print" data-head-info hidden>${esc(meta)}</p>`}
    <p class="print-only small">${esc(emp)} · הופק ${esc(new Date().toLocaleDateString('he-IL'))}</p>
    ${res.mode === 'plan' ? '<p class="small muted">בלי קובץ ביצוע אין השוואה מול מה שזוכה. מוצגים הקרדיט והפיצויים הצפויים לפי התכנון.</p>' : ''}
  </div>`;
}

/**
 * מגבלות החוק (OMA 7.2), לפי הרומה כשיש ובלעדיה לפי התכנון: חריגה בראש הדף, באדום, ובטבלה היום
 * שלה מסומן. בביצוע, חריגה שהארכה מותרת יכולה להסביר (7.2.10) – בכתום. בלי שתיהן – ההערה האחרונה
 * בהערות (`legalNote`; בעל המוצר, 03/10/2026).
 */
function renderLegal(res) {
  const l = res.legal;
  const ext = l?.extensions ?? [];
  if (!l?.violations?.length && !ext.length) return '';
  const list = (items) => `<ul>${items.map((v) => `<li>${esc(v.message)}</li>`).join('')}</ul>`;
  return `<div class="card">
    ${l.violations.length ? `<div class="notice bad"><strong>חריגה ממגבלות החוק ${l.basis === 'exec' ? 'בביצוע' : 'בתכנון'}</strong>${list(l.violations)}</div>` : ''}
    ${ext.length ? `<div class="notice warn"><strong>הארכה בביצוע</strong>${list(ext)}
      <p class="small list-note">הארכת FDP של עד שעתיים מותרת רק בנסיבות לא צפויות, באישור הקברניט (OMA 7.2.10).</p></div>` : ''}
  </div>`;
}

/** ההערה על מגבלות החוק כשאין חריגה: אחרונה בהערות. מה שלא נבדק כתוב בקצרה, כדי שלא ייראה שהכול נבדק. */
function legalNote(res) {
  const l = res.legal;
  if (!l) return null;
  if (l.skipped) return l.skipped;
  // בתכנון לבד: באיזה הרכב צוות FDP עומד בחוק, במקום שאלה (בעל המוצר, 03/10/2026).
  const byCrews = new Map();
  for (const c of l.crewNeeded ?? []) byCrews.set(c.crews, [...(byCrews.get(c.crews) ?? []), c.what]);
  const crew = [...byCrews].map(([crews, what]) => `כדי לעמוד בחוק, ${what.length > 1
    ? `הטיסות ${what.slice(0, -1).join(', ')} ו-${what.at(-1)} נדרשות להיות מבוצעות` : `הטיסה ${what[0]} נדרשת להיות מבוצעת`} בצוות ${crews}.`).join(' ');
  if (l.violations?.length) return crew || null;
  const by = l.basis === 'exec' ? ' לפי הרומה' : '';
  const pending = res.questions.filter((q) => q.id.startsWith('crew:')).length;
  const status = pending
    ? `מגבלות החוק נבדקו${by}: אין חריגה, חוץ מ${pending === 1 ? '-FDP אחד שממתין' : `-${pending} FDP שממתינים`} לתשובה על הרכב הצוות.`
    : `מגבלות החוק נבדקו${by}: אין חריגה.`;
  return crew ? `${status} ${crew}` : status;
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

/** "סיבה אחרת": האם מגיע קרדיט, וכמה – מחצי שעה עד חמש שעות (בעל המוצר, 29/09/2026). */
const CREDIT_STEPS = Array.from({ length: 10 }, (_, i) => (i + 1) * 30);

function creditPicker() {
  return `<div class="credit-pick">
    <label class="small">מגיע קרדיט?
      <select name="credit"><option value="">בחר</option><option value="no">לא מגיע</option><option value="yes">מגיע</option></select>
    </label>
    <label class="small" data-credit-hours hidden>כמה שעות?
      <select name="creditMin">${CREDIT_STEPS.map((m) => `<option value="${m}">${minToHhmm(m)}</option>`).join('')}</select>
    </label>
  </div>`;
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
    ${o.needsText ? `<div class="extra" data-for="${esc(o.value)}" hidden><textarea name="text" placeholder="פרט מה קרה"></textarea>${o.needsCredit ? creditPicker() : ''}</div>` : ''}`).join('');
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
  return `<details class="card" data-section="detail" open>
    <summary><h2 style="display:inline">פירוט</h2></summary>
    <div class="filters">${chip('comp', 'רק פיצויים')}${chip('all', 'הכול')}${chip('bad', 'פערים')}</div>
    <div class="table-wrap"><table>
      <thead><tr><th>ימים</th><th>פיצוי / קרדיט</th><th>צפוי</th><th>ברומה</th><th>פער</th><th></th></tr></thead>
      <tbody>${rows.map((c) => {
        const gap = c.ok === false ? gapClass(c.diff) : c.marks.length ? 'bad' : '';
        const cls = gap || (c.pending ? 'pending' : '');
        const status = gap ? `<span class="status ${gap}">✗</span>` : c.pending ? '<span class="status pending">ממתין</span>' : '<span class="status ok">✓</span>';
        const why = [
          // שורת פיצוי או Rig כבר מוסברת מתחת לטיסה. שורת קרדיט מפורטת רק כשיש בה פער.
          ...c.items.filter((e) => !COMP_COLUMNS.has(c.column) && c.ok !== true && (e.ruleTitle || e.note))
            .map((e) => `${esc(e.ruleTitle ?? '')}${e.note ? `: ${esc(e.note)}` : ''}${e.min != null && c.unit !== 'count' ? ` <span class="num">${minToHhmm(e.min)}</span>` : ''}`),
          ...c.marks.map((m) => `${esc(m.column)}: צפוי <span class="num">${hm(m.expected, m.unit)}</span>, ברומה <span class="num">${hm(m.reported, m.unit)}</span>`),
        ].join('<br>');
        return `<tr class="${cls}">
          <td>${esc(c.label).replace(/\n/g, '<br>')}${explainOf(c)}</td><td class="col">${esc(c.column)}</td>
          <td class="num">${hm(c.expected, c.unit)}</td><td class="num">${hm(c.reported, c.unit)}</td>
          <td class="num">${c.ok ? '' : (c.diff > 0 ? '+' : '') + hm(c.diff, c.unit)}</td><td>${status}</td></tr>
          ${why ? `<tr class="detail"><td colspan="6">${why}</td></tr>` : ''}`;
      }).join('') || '<tr><td colspan="6" class="muted">אין שורות בסינון הזה.</td></tr>'}</tbody>
    </table></div>
  </details>`;
}

/** הסבב של ציפייה, מתחת לשם החוק: שלה, או תיאור הסבב שבראש ההסבר של ציפייה לפי תאריך (ב-`explain` הוא כבר אינו מופיע). */
const pairingOf = (e) => e.pairing ?? String(e.note ?? '').match(/^⁦[^⁩]*⁩/)?.[0] ?? null;

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
  return `<details class="card" data-section="expected" open>
    <summary><h2 style="display:inline">קרדיט ופיצויים צפויים</h2></summary>
    <p class="small">סה"כ קרדיט: <span class="num">${minToHhmm(sumKeys(CREDIT_KEYS))}</span> · סה"כ COM: <span class="num">${minToHhmm(sumKeys(COM_KEYS))}</span></p>
    ${second.length ? `<p class="small">${second.join(' · ')}</p>` : ''}
    ${!shown.length ? '<p class="small muted">אין פיצויים צפויים לפי התכנון.</p>' : `<div class="table-wrap"><table>
      <thead><tr><th>תאריך</th><th>חוק</th><th>סוג</th><th>צפוי</th><th>הסבר</th></tr></thead>
      <tbody>${shown.map((e) => `<tr>
        <td class="num">${e.dates.length > 1 ? `${ddmm(e.dates[0])}–${ddmm(e.dates.at(-1))}` : ddmm(e.date)}</td>
        <td>${esc(e.ruleTitle)}${pairingOf(e) ? `<div class="small muted">${esc(pairingOf(e))}</div>` : ''}</td>
        <td>${esc(KEY_LABEL[e.key] ?? e.key)}</td>
        <td class="num">${minToHhmm(e.min)}</td>
        <td class="small">${esc(e.explain ?? e.note ?? '')}</td></tr>`).join('')}</tbody>
    </table></div>`}
  </details>`;
}

/**
 * תיאור סבב (`describePairing`) הוא קטע לועזי אחד מבודד. בתא עברי רוצים את התאריכים הכי ימניים
 * ומשמאלם את פרטי הטיסה, אז מפצלים כל תיאור כזה לשני קטעים מבודדים, לפי הסדר הזה.
 */
const datesFirst = (text) => text.replace(/⁦(\d[^\s⁦⁩]*) ([^⁦⁩]*)⁩/g, '⁦$1⁩ ⁦$2⁩');

function renderChanges(res) {
  const changes = res.changes.filter((c) => c.how !== 'exact' && c.how !== 'noplan');
  if (res.mode !== 'full') return '';
  return `<details class="card" data-section="changes" ${changes.length ? 'open' : ''}>
    <summary><h2 style="display:inline">שינויים בין תכנון לביצוע <span class="count">${changes.length}</span></h2></summary>
    ${changes.length ? `<ul class="list">${changes.map((c) => `<li>
      <strong class="num">${ddmm(c.date)}</strong> ${esc(c.label)}
      <div class="small"><span class="side-plan">תכנון: ${esc(datesFirst(c.plan ?? '—'))}</span> · <span class="side-exec">ביצוע: ${esc(datesFirst(c.exec ?? (c.replacedBy?.join(', ') || '—')))}</span></div>
      ${(c.notes ?? []).map((n) => `<div class="explain">${esc(n.message)}${n.byUser ? ' <span class="muted">לפי תשובת המשתמש</span>' : ''}</div>`).join('')}
    </li>`).join('')}</ul>` : '<p class="muted">כל הסבבים בוצעו כמתוכנן.</p>'}
  </details>`;
}

function renderAnswered() {
  const answers = Object.entries(state.record?.answers ?? {});
  if (!answers.length) return '';
  return `<details class="card" data-section="answered">
    <summary><h2 style="display:inline">תשובות שנשמרו <span class="count">${answers.length}</span></h2></summary>
    <ul class="list">${answers.map(([id, a]) => `<li class="row">
      <span>${esc(describeQuestionId(id))}: <strong>${esc(a.value === 'partial' && a.count ? `ויתרתי מרצוני על ${a.count === 1 ? 'יום אחד' : `${a.count} ימים`}` : a.label ?? answerLabel(a.value, id.split(':')[0]))}</strong>
        ${a.link !== undefined ? `<span class="small muted">(${a.link === 'none' ? 'מסירת הטיסה ללא חלופה' : a.link ? `עם ${esc(describePairingId(a.link))}` : 'בחודש אחר'})</span>` : ''}
        ${a.text ? `<span class="small muted">– ${esc(a.text)}</span>` : ''}
        ${typeof a.creditMin === 'number' ? `<span class="small muted">(${a.creditMin ? `מגיע קרדיט ${minToHhmm(a.creditMin)}` : 'לא מגיע קרדיט'})</span>` : ''}</span>
      <span class="spacer"></span>
      <button class="btn no-print" data-unanswer="${esc(id)}">שנה</button>
    </li>`).join('')}</ul>
  </details>`;
}

function renderNotes(res) {
  const legal = legalNote(res);
  const count = res.notes.length + (legal ? 1 : 0);
  if (!count) return '';
  return `<details class="card" data-section="notes">
    <summary><h2 style="display:inline">הערות <span class="count">${count}</span></h2></summary>
    <ul class="list">${res.notes.map((n) => `<li>${n.date ? `<strong class="num">${ddmm(n.date)}</strong> ` : ''}${esc(n.message)}${n.byUser ? ' <span class="small muted">לפי תשובת המשתמש</span>' : ''}${n.ruleTitle ? ` <span class="tag">${esc(n.ruleTitle)}</span>` : ''}</li>`).join('')}${legal ? `<li>${esc(legal)}</li>` : ''}</ul>
  </details>`;
}

const QUESTION_KIND = { cancelled: 'סבב שלא בוצע', unplanned: 'פעילות לא מתוכננת', replaced: 'סבב שהוחלף', assigned: 'מוצב לפעילות', standby_bid: 'טיסה בסוף כוננות', standby_code: 'קוד כוננות',
  school_start: 'פתיחת שנת הלימודים', free_days: 'ימים ללא פעילות', free_days_first: 'ימים ללא פעילות, X ב-1 לחודש',
  crew: 'הרכב הצוות', night_crew: 'הרכב הצוות', white: 'טיסה לבנה', diversion: 'סטיה לשדה משנה', swap_conflict: 'סבב שהוחלף',
  base_rest: 'מנוחה בבסיס', second_activity: 'פעילות נוספת באותו FDP', occasion: 'תאריך מיוחד', night_rounds: 'טיסות סבב לילה עוקבות',
  stay_extension: 'הארכת שהייה', miami_short_rest: 'קיצור מנוחה במיאמי', miami_delay: 'דחייה במיאמי', las_vegas_rest: 'קיצור מנוחה בלאס וגאס',
  sim_extension: 'הארכת סימולטור' };

/**
 * "diversion:2024-09-23:LY5104" → "סטיה לשדה משנה 23/09 LY5104". בחלק מהמזהים לפני התאריך יש מילה
 * (`occasion:<חוק>:`, `second_activity:sim:`), ואחריו מה שמבדיל בין שאלות באותו יום (`sim_extension:<תאריך>:<STD>`):
 * מוצגים הסבב, או הטיסה, או היום.
 */
function describeQuestionId(id) {
  const [kind, ...rest] = id.split(':');
  const ref = rest.join(':').replace(/^(?:[a-z][a-z_]*:)+/, '');
  const pairing = ref.match(/^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}:[^:]+/)?.[0];
  const what = pairing ? describePairingId(pairing)
    : /^\d{4}-\d{2}-\d{2}:[A-Z]{2}\d+$/.test(ref) ? describePairingId(ref)
      : /^\d{4}-\d{2}-\d{2}/.test(ref) ? ddmm(ref.slice(0, 10))
        : /^\d{4}-\d{2}$/.test(ref) ? `${ref.slice(5)}/${ref.slice(0, 4)}` : describePairingId(ref);
  return `${QUESTION_KIND[kind] ?? kind} ${what}`;
}

/** "2026-07-21..2026-07-22:ATH" → "21/07–22/07 ATH". "2026-08-03:LY373" (טיסה) → "03/08 LY373". */
function describePairingId(id) {
  const leg = String(id).match(/^(\d{4}-\d{2}-\d{2}):(.+)$/);
  if (leg) return `⁦${ddmm(leg[1])} ${leg[2]}⁩`;
  const m = String(id).match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2}):(.*)$/);
  if (!m) return id;
  return `⁦${m[1] === m[2] ? ddmm(m[1]) : `${ddmm(m[1])}–${ddmm(m[2])}`} ${m[3]}⁩`;
}

function bindResults(root) {
  const host = $('#head-cal', root);
  if (host) {
    const p = calendarParts(state.calendar);
    host.innerHTML = p.label + p.buttons;
    $('#head-cal-info', root).innerHTML = p.infoHtml;
    bindCalendar(host);
  }
  $('[data-action="head-info"]', root)?.addEventListener('click', () => { const p = $('[data-head-info]', root); p.hidden = !p.hidden; });
  $('[data-action="print"]', root)?.addEventListener('click', () => {
    // ה-PDF מציג הכול בפירוט וכל שאר החלקים פתוחים, בלי קשר למה שמוצג כרגע על המסך.
    const prevFilter = state.filter;
    state.filter = 'all';
    renderResults();
    for (const d of $('#results').querySelectorAll('details')) d.open = true;
    const restore = () => {
      window.removeEventListener('afterprint', restore);
      state.filter = prevFilter;
      renderResults(false);
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
      const id = btn.dataset.unanswer;
      // שאלה שנשאלה רק בגלל התשובה הזאת נפתחת מחדש יחד איתה.
      for (const dep of [id, ...(state.result?.dependentAnswers?.[id] ?? [])]) delete state.record.answers[dep];
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
      for (const pick of form.querySelectorAll('.credit-pick')) {
        $('[data-credit-hours]', pick).hidden = $('select[name="credit"]', pick).value !== 'yes';
      }
      submit.disabled = !chosen && !$('input[type="date"]', form);
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const picker = $('input[type="date"]', form);
      const chosen = $('input[type="radio"]:checked', form);
      if (!chosen && !picker) return;
      if (picker && !picker.value) { alert('בחר תאריך.'); return; }
      const answer = { value: picker ? picker.value : chosen.value };
      // התווית של האפשרות שנבחרה, כפי שהופיעה בשאלה: "תשובות שנשמרו" מציג אותה.
      const label = state.result?.questions.find((q) => q.id === form.dataset.qid)?.options?.find((o) => o.value === answer.value)?.label;
      if (label) answer.label = label;
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
      const credit = chosen && $(`.extra[data-for="${CSS.escape(chosen.value)}"] .credit-pick`, form);
      if (credit) {
        const due = $('select[name="credit"]', credit).value;
        if (!due) { alert('בחר אם מגיע קרדיט.'); return; }
        answer.creditMin = due === 'yes' ? Number($('select[name="creditMin"]', credit).value) : 0;
      }
      state.record.answers = { ...(state.record.answers ?? {}), [form.dataset.qid]: answer };
      state.notices = [];
      await runAndSave();
    });
  }
}

// ---------- היסטוריה ----------

/** הסיכום של חודש שמור לפי החוקים והקוד הנוכחיים, ולא זה שנשמר בהרצה האחרונה שלו. */
function currentSummary(m, months) {
  if (!state.rulesData || !(m.plan || m.exec)) return m.summary ?? {};
  try {
    return summarize(evaluate({ rulesData: state.rulesData, plan: m.plan, exec: m.exec, answers: m.answers ?? {}, history: historyFor(m.key, months), calendar: m.calendar ?? monthCalendar(calendarFacts(), m.period) }));
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
        const s = currentSummary(m, months);
        const tags = [
          m.plan ? '<span class="tag">תכנון</span>' : '',
          m.exec ? '<span class="tag">ביצוע</span>' : '',
          s.legal ? `<span class="tag bad">${s.legal === 1 ? 'חריגה ממגבלות החוק' : `${s.legal} חריגות ממגבלות החוק`}</span>` : '',
          s.questions ? `<span class="tag warn">${s.questions === 1 ? 'שאלה פתוחה אחת' : `${s.questions} שאלות פתוחות`}</span>` : '',
          s.gaps ? `<span class="tag bad">${s.gaps === 1 ? 'פער אחד' : `${s.gaps} פערים`}</span>` : '',
          m.exec && !s.gaps && !s.questions ? '<span class="tag ok">תואם לרומה</span>' : '',
        ].join(' ');
        return `<li class="month-item">
          <span class="name">${esc(monthName(m.period))}</span> ${tags}
          <span class="small muted">עודכן ${esc(m.updated ? new Date(m.updated).toLocaleDateString('he-IL') : '')}</span>
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

  for (const b of root.querySelectorAll('[data-open]')) {
    b.addEventListener('click', async () => {
      const calToken = calendarToken();
      await openMonth(b.dataset.open);
      if (calToken) syncCalendar(calToken);
    });
  }
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
      // ייתכן ששוחזר קובץ לחודש הפתוח: לטעון אותו מחדש, כדי שאפשר יהיה לפתוח אותו.
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
          <span class="search-box">
            <input type="search" placeholder="חיפוש בחוקים…" aria-label="חיפוש">
            <button type="button" class="search-clear" data-action="clear-search" aria-label="נקה חיפוש" title="נקה חיפוש" hidden>×</button>
          </span>
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
    const searchInput = $('input[type="search"]', root);
    const clearSearch = $('[data-action="clear-search"]', root);
    searchInput.addEventListener('input', (e) => {
      rulesUi.q = e.target.value;
      clearSearch.hidden = !rulesUi.q;
      renderRuleList();
    });
    clearSearch.addEventListener('click', () => {
      searchInput.value = '';
      rulesUi.q = '';
      clearSearch.hidden = true;
      renderRuleList();
      searchInput.focus();
    });
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
