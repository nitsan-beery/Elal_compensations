// ממשק האפליקציה: העלאת קבצים, הרצת המנוע, שאלות, היסטוריה ומסך החוקים.
// כל העיבוד על המכשיר. אין כאן ערכי פיצוי: הכול מגיע מ-rules.json דרך המנוע.

import { parsePlan } from './pdf/plan.js';
import { parseExec } from './pdf/exec.js';
import { parsePerDiem, rateFromSlip } from './pdf/perdiem.js';
import { xlsxBlob } from './xlsx.js';
import { evaluate, monthCalendar, calendarGaps, crewAnswersInCalendar, relatedCrewIds } from './rules/evaluate.js';
import { loadRules, partitionRules } from './rules/catalog.js';
import { appendSnapshot } from './rules/journal.js';
import { minToHhmm, MONTH_NAMES } from './time.js';
import * as store from './store.js';
import * as calendar from './calendar.js';

// מספר הגרסה של הקוד שרץ בדף. עולה יחד עם CACHE ב-sw.js, לאותו מספר (בעל המוצר, 15/10/2026).
const APP_VERSION = 316;

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ddmm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const hm = (v, unit) => (v == null ? '—' : unit === 'count' ? String(v) : minToHhmm(v));
const monthName = (p) => `${MONTH_NAMES[p.month - 1]} ${p.year}`;
const KIND_LABEL = { plan: 'קובץ תכנון', exec: 'קובץ ביצוע' };
const THE_KIND = { plan: 'קובץ התכנון', exec: 'קובץ הביצוע' };
const MODE_LABEL = { full: 'תכנון וביצוע', plan: 'תכנון בלבד', exec: 'ביצוע בלבד' };
const CATEGORY_LABEL = { plan: 'תכנון', exec: 'ביצוע', train: 'הדרכה' };
const KEY_LABEL = { flight: 'קרדיט טיסה', absence: 'קרדיט יום', credit: 'קרדיט', rig: 'Rig', com: 'COM', sc: 'COM' }; // S/C מוצג כ-COM (טיוטה 402)
const CREDIT_KEYS = new Set(['flight', 'absence', 'credit']);
const COM_KEYS = new Set(['com', 'sc']); // S/C נספר יחד עם COM בסיכום
// ימים שזוכו על פעילות שאינה טיסה, לפי החוק שזיכה אותם (ובאימון קרקע – לפי הקוד).
const isHomeRgt = (e) => e.code?.startsWith('HOME_');
const DAY_KINDS = [
  { one: 'יום חופשה אחד', many: 'ימי חופשה', test: (e) => e.ruleId === 'vacation_base_credit' },
  { one: 'יום מחלה אחד', many: 'ימי מחלה', test: (e) => e.ruleId === 'planned_sick_credit' || e.ruleId === 'sick_credit' },
  { one: 'יום מילואים אחד', many: 'ימי מילואים', reserve: true, test: (e) => e.ruleId === 'reserve_day_credit' },
  { one: 'יום סימולטור אחד', many: 'ימי סימולטור', test: (e) => e.ruleId === 'sim_day_credit' },
  { one: 'יום פעילות קרקעית אחד', many: 'ימי פעילות קרקעית', test: (e) => e.ruleId === 'ground_training_credit' && !isHomeRgt(e) },
  { one: 'יום HOME RGT אחד', many: 'ימי HOME RGT', test: (e) => e.ruleId === 'ground_training_credit' && isHomeRgt(e) },
  { one: 'יום כוננות אחד', many: 'ימי כוננות', test: (e) => e.ruleId === 'short_call_standby_credit' },
];
const countText = (n, one, many) => (n === 1 ? one : `<span class="num">${n}</span> ${many}`);
/**
 * כמה ימים זוכו על פעילות שאינה טיסה, לפי סוג ("<span>3</span> ימי חופשה"). כשיש רומה, ימי המילואים שזוכו הם
 * המתוכננים, ואחריהם הלא מתוכננים – סכום MILUP ברומה, בלי קרדיט (בעל המוצר, 21/10/2026).
 */
const dayCounts = (res) => DAY_KINDS.flatMap((k) => {
  const n = new Set(res.expectations.filter((e) => e.key === 'absence' && k.test(e)).map((e) => e.date)).size;
  const exec = k.reserve && res.unplannedReserveDays != null;
  const out = n ? [countText(n, exec ? 'יום מילואים מתוכנן אחד' : k.one, exec ? 'ימי מילואים מתוכננים' : k.many)] : [];
  if (exec && res.unplannedReserveDays) out.push(countText(res.unplannedReserveDays, 'יום מילואים לא מתוכנן אחד', 'ימי מילואים לא מתוכננים'));
  return out;
});
// תוויות לתשובות שנשמרו לפני שהתווית של האפשרות נשמרה איתן (`answer.label`). ערך שאינו כאן מוצג כמות שהוא.
const ANSWER_LABEL = {
  special_call: 'קריאה מיוחדת', voluntary_swap: 'החלפה מרצוני או בהסכמתי', replaced: 'שינוי ביוזמת החברה', bid: 'זכייה במכרז', diversion: 'סטיה לשדה משנה',
  wet_lease: 'הורדה מהטיסה המקורית', trainee: 'הורדה מהטיסה המקורית', swap_777: 'הטיסה עברה ל-777 (לא כשיר MFF)',
  cancelled: 'הטיסה המקורית בוטלה ללא קרדיט', added: 'הוספת טיסה בהסכמה', other: 'סיבה אחרת',
  yes: 'כן', no: 'לא',
  company: 'לבקשת החברה', own: 'ויתור מרצון',
  standby_bid: 'סיום כוננות בגלל זכייה במכרז', standby_activated: 'הפעלת הכוננות', regular_standby: 'מצב הכן רגיל',
  standby_held: 'הכוננות התקיימה', standby_cancelled_mine: 'ביקשתי לבטל את הכוננות',
  single: 'צוות בודד (2 טייסים)', augmented: 'צוות מוגבר (3 טייסים)', double: 'צוות כפול (4 טייסים)',
};

// "כן" ו"לא" שייכים לשאלה, ולא לערך: בלעדי זה תשובה על סטיה לשדה משנה הוצגה "כן, הייתי מוצב" (23/09/2024).
const ANSWER_LABEL_BY_KIND = { assigned: { yes: 'כן, הייתי מוצב', no: 'לא הייתי מוצב' }, fleet: { B737: '737', B787: '787', MFF: '\u20667877\u00a0(MFF)\u2069' } };

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
  calForeign: null, // שם בעל היומן המחובר, כשהוא טייס אחר מזה של החודש הפתוח (`foreignCalendar`)
  calError: null,
  calOffline: false, // העדכון האחרון של היומן לא הגיע לרשת (בעל המוצר, 11/10/2026)
};

// ---------- אתחול ----------

// מפתח החודש הפתוח, לרענון באותו חלון. `sessionStorage` נשאר ברענון ונמחק כשהחלון נסגר, ולכן
// פתיחה חדשה של האפליקציה מתחילה מהחודש האחרון.
const OPEN_MONTH = 'open-month';
addEventListener('pagehide', () => {
  try {
    if (state.record?.key) sessionStorage.setItem(OPEN_MONTH, state.record.key);
    else sessionStorage.removeItem(OPEN_MONTH);
  } catch { /* אחסון חסום */ }
});

init();

async function init() {
  setupTabs();
  setupUploads();
  setupRuleTips();
  registerServiceWorker();
  try {
    const { data, source, error } = await loadRules();
    state.rulesData = data;
    state.rulesSource = source;
    state.rulesError = error;
  } catch (err) {
    showBanner('info', esc(err.message));
    return;
  }
  if (state.rulesSource === 'cache') {
    showBanner('info', `לא ניתן היה לטעון את החוקים מהרשת${state.rulesError ? ` (<bdi dir="ltr">${esc(state.rulesError)}</bdi>)` : ''}. הם נטענו מהעותק השמור על המכשיר (גרסה ${esc(state.rulesData.rules_version)}).`);
  }
  state.calendar = calendarSetting(await safe(() => store.getSetting(CAL_SETTING), null));
  // החודש האחרון שעבדו עליו נפתח אוטומטית. ברענון באותו חלון – החודש שהיה פתוח (בעל המוצר, 17/10/2026).
  const months = await safe(() => store.listMonths(), []);
  let reopen = null;
  try { reopen = sessionStorage.getItem(OPEN_MONTH); } catch { /* אחסון חסום: החודש האחרון */ }
  if (months.length) await openMonth(months.find((m) => m.key === reopen)?.key ?? months[0].key, { quiet: true });
  else renderResults();
  // יומן מחובר: ספריית ההתחברות נטענת מראש, כדי שהחלון של גוגל ייפתח מיד בלחיצה. העדכון עצמו רק
  // בפעולה של המשתמש (`calendarToken`).
  if (state.calendar) calendar.preload();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then((registration) => {
    // הדפדפן בודק אם יש גרסה חדשה רק כשהדף נטען. בדף שנשאר פתוח: בכל חזרה אליו ופעם בשעה, כשיש רשת.
    // גרסה חדשה מותקנת ברקע, ו-`controllerchange` מציג את הכפתור (בעל המוצר, 15/10/2026).
    const check = () => { if (navigator.onLine) registration.update().catch(() => {}); };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    setInterval(check, 60 * 60 * 1000);
  }).catch(() => { /* האפליקציה עובדת גם בלי */ });
  showVersion();
  navigator.serviceWorker.addEventListener('controllerchange', showVersion);
  $('#app-update').addEventListener('click', () => location.reload());
}

/**
 * מספר הגרסה בשורת הקרדיט, בקצה השמאלי ("גרסה 173"), במחשב וב-iPad, ולא בכותרת החלון (בעל המוצר, 08/10/2026).
 * המספר הוא של המטמון של ה-service worker (`CACHE` ב-sw.js), שעולה בכל שינוי בקבצי האפליקציה, כך שאין
 * מספר נוסף לעדכן. בזמן עדכון יש שני מטמונים, והחדש הוא הגבוה.
 */
/**
 * מספר הגרסה בשורת הקרדיט הוא של הקוד שרץ בדף. גרסה חדשה שהותקנה בזמן שהדף פתוח (המטמון שלה חדש
 * מהקוד) אינה מחליפה אותו: לידו הכפתור "גרסה N מוכנה – לחץ לרענון" (בעל המוצר, 15/10/2026 ו-17/10/2026; עד אז המספר
 * נלקח מהמטמון, והתחלף לפני שהקוד התחלף).
 */
async function showVersion() {
  $('#app-version').textContent = `גרסה ${APP_VERSION}`;
  const keys = await caches.keys().catch(() => []);
  const cached = Math.max(0, ...keys.map((k) => Number(k.match(/^elal-compensations-v(\d+)$/)?.[1] ?? 0)));
  const button = $('#app-update');
  button.hidden = cached <= APP_VERSION;
  if (cached > APP_VERSION) button.textContent = `גרסה ${cached} מוכנה – לחץ לרענון`;
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
// כל סוגי הקבצים באזור ההעלאה, כולל תלוש האש"ל של אפריל (`handleSlip`).
const FILE_KINDS = [...Object.keys(PARSERS), 'perdiem'];

// ---------- תלוש האש"ל של אפריל (בעל המוצר, 18/10/2026) ----------
//
// התעריף מתעדכן באפריל, והאש"ל של אפריל משולם ב-15 במאי. בחודש מאי, רק לבעל המוצר, האפליקציה מבקשת את
// התלוש, ומחילה את התעריף ממנו במכשיר עד ש-rules.json מתעדכן (דרך Claude, "העתק לעדכון אצל כולם").

const POSITION_LABEL = { CP: 'קברניט', FO: 'קצין ראשון' };
const perDiemParams = () => state.rulesData?.rules.find((r) => r.logic?.id === 'per_diem_estimate')?.logic.params ?? null;
const slipFrom = (year, p) => `${year}-${String(p.slip_month).padStart(2, '0')}-01`;
const ratePeriod = (from) => `${from.slice(5, 7)}/${from.slice(0, 4)}`;
const slipPosition = (r, p) => r.exec?.position ?? r.plan?.position ?? p.default_position;

/**
 * משבצת התלוש: בחודש שאחרי חודש העדכון (`slip_month`), רק כשהמשתמש הוא בעל המוצר – בעל היומן המחובר,
 * ובלי יומן מספר העובד בקבצים (`slip_owner_staff`) – וכל עוד ב-rules.json אין תעריף מחודש העדכון.
 */
function slipSlotOpen(r) {
  const p = perDiemParams();
  if (!r?.period || !p?.slip_month || r.period.month !== p.slip_month + 1) return false;
  const user = calendarFacts()?.owner ?? r.staff;
  return String(user ?? '') === String(p.slip_owner_staff) && !p.rates.some((x) => x.from === slipFrom(r.period.year, p));
}

/**
 * החוקים עם התעריפים מתלושי האש"ל שבחודשים השמורים במכשיר (`perdiem.rate`), לתקופות ש-rules.json אינו
 * מכיר: rules.json גובר.
 */
function rulesFor(months) {
  const data = state.rulesData;
  const rule = data?.rules.find((r) => r.logic?.id === 'per_diem_estimate');
  const p = rule?.logic.params;
  if (!p) return data;
  const extra = new Map();
  for (const m of months) {
    const x = m?.perdiem?.rate;
    if (x && !p.rates.some((r) => r.from === x.from) && !extra.has(x.from)) {
      extra.set(x.from, { from: x.from, stay_usd: x.stay_usd, flight_usd: x.flight_usd, source: 'slip' });
    }
  }
  if (!extra.size) return data;
  const params = { ...p, rates: [...p.rates, ...extra.values()] };
  return { ...data, rules: data.rules.map((r) => (r === rule ? { ...r, logic: { ...r.logic, params } } : r)) };
}

async function handleSlip(file) {
  const r = state.record;
  if (!r || !slipSlotOpen(r)) return;
  const zone = $('.drop[data-kind="perdiem"]');
  zone.classList.add('busy');
  $('.drop-state', zone).textContent = 'קורא את הקובץ…';
  state.notices = [];
  const exact = (message) => Object.assign(new Error(message), { exact: true });
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const slip = await parsePerDiem(bytes.slice());
    const p = perDiemParams();
    if (slip.period.year !== r.period.year || slip.period.month !== p.slip_month) {
      throw exact(`זה תלוש של ${String(slip.period.month).padStart(2, '0')}/${slip.period.year}. נדרש תלוש האש"ל של ${MONTH_NAMES[p.slip_month - 1]} ${r.period.year}.`);
    }
    if (slip.staff !== String(p.slip_owner_staff)) throw exact('התלוש שייך לעובד אחר.');
    const position = slipPosition(r, p);
    const rate = rateFromSlip(slip, p.rates, position);
    if (!rate) throw exact('אין ב-rules.json תעריף קודם להשוואה.');
    r.perdiem = { ...slip, position, rate };
    r.perdiemFile = file.name;
    await safe(() => store.putFile(r.key, 'perdiem', file.name, bytes));
    dropFileLink('perdiem');
    await runAndSave();
  } catch (err) {
    console.error(err);
    state.notices.push({ kind: 'warn', text: err.exact ? err.message : `לא ניתן לקרוא את "${file.name}": ${err.message}` });
    renderResults();
  } finally {
    zone.classList.remove('busy');
    renderUploadState();
  }
}

const usd2 = (v) => `${v.toFixed(2)}$`;

/** ההודעה אחרי העלאת התלוש, עם "העתק לעדכון אצל כולם" (הטקסט עצמו אינו מוצג; בעל המוצר, 18/10/2026). */
function slipNotice() {
  const r = state.record;
  const x = r?.perdiem?.rate;
  if (!x || !slipSlotOpen(r)) return '';
  const pos = r.perdiem.position;
  const label = POSITION_LABEL[pos] ?? pos;
  const month = MONTH_NAMES[r.perdiem.period.month - 1];
  const head = x.unchanged
    ? `בתלוש ${month} אותם תעריפים כמו בתקופה הקודמת (שהייה ל${label} ${usd2(x.stay_usd[pos])}, טיסה ${usd2(x.flight_usd)}): התעריף לא השתנה.`
    : `תעריף האש"ל עודכן מ-01/${ratePeriod(x.from)}, לפי תלוש ${month}: `
      + `שהייה ל${label} ${usd2(x.stay_usd[pos])} (היה ${usd2(x.prev.stay_usd[pos])}), טיסה ${usd2(x.flight_usd)} (היה ${usd2(x.prev.flight_usd)}), עלייה של ${x.pct}%.`
      + Object.entries(x.derived).map(([k, d]) => ` שהייה ל${POSITION_LABEL[k] ?? k} ${usd2(d.high)} – נגזר באותו אחוז${d.low !== d.high
        ? `, ויצא בין ${usd2(d.low)} ל-${usd2(d.high)}. נלקח הגבוה. יש לאמת מול תלוש של ${POSITION_LABEL[k] ?? k}.` : '.'}`).join('')
      + ' העדכון חל עכשיו רק במכשיר הזה. כדי שיחול אצל כולם:';
  return `<div class="notice info no-print">${esc(head)}
    <div class="row"><button class="btn" data-action="copy-perdiem">העתק לעדכון אצל כולם</button></div></div>`;
}

/** הטקסט שמועבר לClaude לעדכון `rates` ב-rules.json. */
function slipText(r) {
  const x = r.perdiem.rate;
  const pos = r.perdiem.position;
  return [`עדכון תעריף אש"ל מ-${x.from} (תלוש ${MONTH_NAMES[r.perdiem.period.month - 1]} ${r.perdiem.period.year}, ${r.perdiemFile ?? ''}):`,
    `${pos} שהייה ${x.stay_usd[pos].toFixed(2)}, טיסה ${x.flight_usd.toFixed(2)} (קודם ${x.prev.stay_usd[pos].toFixed(2)} / ${x.prev.flight_usd.toFixed(2)})${x.unchanged ? ' – לא השתנה' : ''}`,
    ...Object.entries(x.derived).map(([k, d]) => `${k} שהייה ${d.high.toFixed(2)} – נגזר באותו אחוז${d.low !== d.high ? ` (בין ${d.low.toFixed(2)} ל-${d.high.toFixed(2)}, לאימות)` : ''}`),
  ].join('\n');
}

// גרסת הקריאה של קובצי ה-PDF. הנתונים שחולצו נשמרים בחודש, ולכן שינוי בקריאה (עמודה שנוספה, קוד שמתווסף
// לעמודה אחרת) מעלה אותה, וחודש שנשמר בגרסה קודמת נקרא מחדש מהקבצים השמורים כשהוא נפתח (בעל המוצר,
// 08/10/2026: HHM ב-COM של היום, ספטמבר 2026 של רון).
// 2: מספר העובד בתכנון (בעל המוצר, 08/10/2026). 5: Pay Queries ברומה מדולגת (15/10/2026).
// 6: העמודה MIL ברומה נקראת, ו-MILUP מדולגת (16/10/2026). 9: MILUP נקראת (21/10/2026).
const PARSE_VERSION = 14;

async function reparseStale(record) {
  if (record.parseVersion === PARSE_VERSION) return;
  let changed = false;
  for (const kind of Object.keys(PARSERS)) {
    if (!record[kind]) continue;
    const file = await safe(() => store.getFile(record.key, kind), null);
    if (!file) continue; // חודש שנשמר לפני שהקבצים נשמרו: נשאר כמו שנקרא
    try {
      record[kind] = await PARSERS[kind](new Uint8Array(file.bytes));
      changed = true;
    } catch (err) {
      console.error(err);
    }
  }
  record.parseVersion = PARSE_VERSION;
  // מה שנקרא מחדש יכול לתת מספר עובד שלא היה (תכנון), ואז החודש עובר למפתח שלו.
  if (changed) await safe(() => store.rekeyMonth(record));
}

/**
 * קריאת קובץ. אם הקובץ הועלה לאזור הלא נכון, מזהים אותו לפי התוכן ומעבירים.
 */
/** `calToken`: ההרשאה ליומן שהתבקשה בבחירת הקובץ (`calendarToken`); היומן מתעדכן אחרי הקריאה. */
async function handleFile(file, expected, calToken = null) {
  if (!state.rulesData) return;
  if (expected === 'perdiem') return handleSlip(file);
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

    // חודש לכל טייס, לפי מספר העובד בקובץ (`store.recordKey`; בעל המוצר, 08/10/2026). קובץ שלא נמצא בו
    // מספר עובד או שם נכנס לחודש הפתוח, כשהוא מאותו חודש.
    const prev = state.record;
    const samePeriod = prev && store.monthKey(prev.period) === store.monthKey(parsed.period);
    const found = store.pilotOf(parsed);
    const pilot = samePeriod && store.samePilot(prev, found)
      ? { staff: found.staff ?? prev.staff ?? null, person: found.person ?? prev.person ?? null }
      : found;
    const key = store.recordKey(parsed.period, pilot);
    const record = (prev?.key === key ? prev : await safe(() => store.getMonth(key), null))
      ?? { key, period: parsed.period, ...pilot, plan: null, exec: null, answers: {} };
    await reparseStale(record);
    // קובץ של טייס אחר מהחודש הפתוח: הקובץ השני של החודש הפתוח נסגר, ומחכים לקובץ המתאים (בעל המוצר, 08/10/2026).
    const other = kind === 'plan' ? 'exec' : 'plan';
    if (samePeriod && prev.key !== record.key && prev[other] && !store.samePilot(prev, pilot)) {
      const was = prev.person ?? `מספר עובד ${prev.staff}`;
      const now = pilot.person ?? `מספר עובד ${pilot.staff}`;
      state.notices.push({ kind: 'info', text: record[other]
        ? `${THE_KIND[other]} שהיה פתוח שייך לטייס אחר (${was}). נפתח החודש השמור של ${now}.`
        : `${THE_KIND[other]} שהיה פתוח שייך לטייס אחר (${was}), ולכן נסגר. העלה את ${THE_KIND[other]} של ${now}.` });
    } else if (kind === 'exec' && !record.plan) {
      state.notices.push({ kind: 'info', text: 'אין קובץ תכנון לחודש הזה, ולכן אין השוואה לתכנון. אפשר להעלות אותו עכשיו.' });
    }
    record[kind] = parsed;
    record[`${kind}File`] = file.name;
    await safe(() => store.putFile(record.key, kind, file.name, bytes));
    dropFileLink(kind);
    state.record = record;
    await runAndSave();
  } catch (err) {
    console.error(err);
    if (err.exact) state.result = null;
    state.notices.push({ kind: 'info', text: err.exact ? err.message : `לא ניתן לקרוא את "${file.name}": ${err.message}` });
    renderResults();
  } finally {
    zone.classList.remove('busy');
    renderUploadState();
  }
  if (calToken) syncCalendar(calToken);
}

function renderUploadState() {
  const slot = slipSlotOpen(state.record);
  $('.uploads').classList.toggle('three', slot);
  for (const zone of document.querySelectorAll('.drop')) {
    const kind = zone.dataset.kind;
    const r = state.record;
    if (kind === 'perdiem') zone.hidden = !slot;
    const loaded = !!r?.[kind];
    const period = kind === 'perdiem' ? r?.perdiem?.period : r?.period;
    zone.classList.toggle('loaded', loaded);
    $('.drop-state', zone).textContent = 'לא נבחר קובץ. לחץ או גרור לכאן';
    // רק החודש והשנה בשתי ספרות, "אוקטובר 26": הכותרת של האזור כבר אומרת איזה קובץ (בעל המוצר, 29/09/2026).
    $('.drop-month', zone).textContent = loaded ? `${MONTH_NAMES[period.month - 1]} ${String(period.year).slice(-2)}` : '';
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
  // דבר מהחודש אינו מוחק את מה שנשמר. טיסה שירדה מהיומן אינה נשמרת (בעל המוצר, 06/10/2026).
  // יומן של טייס אחר אינו משמש, ומה שנשמר ממנו בחודש נמחק (`calendarFor`; בעל המוצר, 08/10/2026).
  const { saved, fresh } = calendarFor(r);
  if (saved !== (r.calendar ?? null)) { r.calendar = null; r.calendarHistory = null; }
  const owner = calendarFacts()?.owner;
  state.calForeign = foreignCalendar(r)
    ? months.find((m) => m.staff === owner)?.person ?? `מספר עובד ${owner}` : null;
  if (fresh?.flights.length || fresh?.standby.length) {
    // לפני הרומה: תמונה של החודש מהיומן, לשרשרת השינויים (`appendSnapshot`; בעל המוצר, 06/10/2026). חודש
    // שנשמר לפני כן מתחיל מהיומן ששמור בו.
    if (!r.exec) r.calendarHistory = appendSnapshot(r.calendarHistory ?? (r.calendar ? [r.calendar] : []), fresh);
    r.calendar = fresh;
  }
  state.fleetPreset = lastFleetAnswer(r, months);
  state.result = evaluate({ rulesData: rulesFor([r, ...months]), plan: r.plan, exec: r.exec, answers: r.answers ?? {}, history: historyFor(r, months), calendar: r.calendar ?? null,
    reopen: r.calendarIgnored ?? [], calendarHistory: r.calendarHistory ?? null, assumedIgnored: r.assumedIgnored ?? [] });
  // שלב שחזר למצב שלפניו יוצא מהשרשרת, יחד עם התשובה עליו (בעל המוצר, 06/10/2026).
  for (const id of state.result.obsoleteAnswers ?? []) delete r.answers?.[id];
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

/**
 * היומן המחובר שייך לטייס אחר מזה של החודש: מספר העובד של בעל היומן (`calendarOwner`) שונה ממספר העובד
 * בקבצים (בעל המוצר, 08/10/2026). כשאחד מהם לא ידוע – היומן משמש, כמו קודם.
 */
const foreignCalendar = (r) => {
  const owner = calendarFacts()?.owner;
  return !!(owner && r?.staff && owner !== r.staff);
};

/**
 * היומן של חודש: `saved` – מה שנשמר בו, ו-`fresh` – החודש ביומן המחובר. ביומן של טייס אחר אין `fresh`,
 * ומה שנשמר נשאר רק כשהוא מהיומן של הטייס עצמו (`owner`): מה שנשמר בלי בעלים בא מהיומן של המכשיר הזה.
 */
function calendarFor(r) {
  if (!foreignCalendar(r)) return { saved: r.calendar ?? null, fresh: monthCalendar(calendarFacts(), r.period) };
  return { saved: r.calendar?.owner === r.staff ? r.calendar : null, fresh: null };
}
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
  // יומן של טייס אחר: בחודש שלו, במקום "יומן מעודכן ל…", ההודעה שהיומן שייך לטייס אחר, ובלי פרטי היומן
  // וכפתור עדכון – רק ניתוק (בעל המוצר, 08/10/2026).
  if (foreignCalendar(state.record)) {
    return {
      label: `<span class="cal-label">היומן המחובר שייך לטייס אחר${state.calForeign ? ` (${esc(state.calForeign)})` : ''}, ולכן אינו משמש בחודש הזה.</span>`,
      buttons: '<button type="button" class="btn" data-cal="disconnect">ניתוק יומן</button>',
      infoHtml: '',
    };
  }
  // ביומן אין אף טיסה מהחודש הפתוח: גם זה בשורת היומן, במקום "יומן מעודכן ל…", ולא כאזהרה (בעל המוצר,
  // 08/10/2026). כשהמשתמש ענה על הרכב הצוות, ההודעה אומרת שההרכבים מהתשובות (04/10/2026).
  if (!state.calBusy && state.result?.calendarNoMonth) {
    const answered = Object.keys(state.record?.answers ?? {}).some((id) => /^(crew|night_crew|white):/.test(id));
    return {
      label: `<span class="cal-label">לא נמצאו ביומן טיסות של החודש הזה.${answered ? ' הרכבי הצוותים נלקחו מהתשובות שנתת.' : ''} ודא שבוצע סנכרון של היומן מהאורגנייזר.</span>`,
      buttons: `<button type="button" class="btn" data-cal="sync">עדכון</button>
    <button type="button" class="btn" data-cal="disconnect">ניתוק יומן</button>`,
      infoHtml: '',
    };
  }
  const n = state.result?.calendarCrew ?? 0;
  const when = state.calBusy ? 'מתעדכן…' : c.synced ? `מעודכן ל-${stamp(c.synced)}` : 'עוד לא עודכן';
  // בלי רשת: במקום פס אדום, בשורת היומן ובאותו צבע (בעל המוצר, 11/10/2026).
  const status = !state.calBusy && state.calOffline ? `אין חיבור לרשת. היומן ${when}` : `יומן ${when}`;
  const noData = c.synced && !c.facts?.flights?.length;
  const info = [`${c.calendars.length === 1 ? 'יומן מחובר' : 'יומנים מחוברים'}: ${c.calendars.map((x) => x.name).join(', ')}`,
    n ? `הרכב הצוות של ${n} ${state.result?.monthFlights >= n ? `מתוך ${state.result.monthFlights} ` : ''}${n === 1 && !(state.result?.monthFlights >= n) ? 'טיסה' : 'טיסות'} בחודש הזה מהיומן` : ''].filter(Boolean);
  const hover = matchMedia('(hover: hover)').matches;
  const label = hover
    ? `<span class="cal-label" title="${esc(info.join('\n'))}">${status}</span>`
    : `<button type="button" class="cal-toggle cal-label" data-cal="info" aria-expanded="${state.calInfo}">${status}</button>`;
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
  // הודעות היומן הן הודעות מערכת: בכחול (בעל המוצר, 14/10/2026; טיוטה 331).
  if (state.calError) notices.push(`<div class="notice info">${esc(state.calError)}</div>`);
  else if (c?.synced && !c.facts?.flights?.length) notices.push(`<div class="notice info">${esc(CAL_NO_DATA)}</div>`);
  // יומן של טייס אחר, וחודש שאין ביומן אף טיסה שלו: ההודעה בשורת היומן, במקום "יומן מעודכן ל…"
  // (`calendarParts`; בעל המוצר, 08/10/2026).
  // בתכנון לבד, טיסה שירדה מהיומן היא שינוי בסבב, והוא נשאל בשאלה עליו. לכן אין עליה הודעה (בעל
  // המוצר, 06/10/2026).
  const gaps = (state.calGaps && state.calGaps.key === state.record?.key ? state.calGaps.items : [])
    .filter((g) => g.kind !== 'removed' || state.result?.mode !== 'plan');
  if (gaps.length) {
    notices.push(`<div class="notice info">היומן המעודכן שונה ממה שנשמר בחודש הזה:<ul>${gaps.map((g) => `<li>${esc(describeGap(g))}</li>`).join('')}</ul></div>`);
  }
  const review = crewReview();
  if (review.length) notices.push(renderCrewReview(review));
  // טיסות שבוצעו ואין ביומן הרכב הצוות שלהן: כנראה שהיומן לא מעודכן (בעל המוצר, 04/10/2026).
  const missing = c && !state.calBusy ? state.result?.calendarMissing ?? [] : [];
  if (missing.length) {
    notices.push(`<div class="notice info">ביומן לא מופיע הרכב הצוות של ${missing.length === 1 ? 'טיסה אחת שבוצעה' : `${missing.length} טיסות שבוצעו`}: ${
      missing.map((m) => esc(`⁦${ddmm(m.date)} ${m.flight}⁩`)).join(', ')}. ודא שבוצע סנכרון של היומן מהאורגנייזר.</div>`);
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
  for (const btn of bar.querySelectorAll('[data-crew-review]')) btn.addEventListener('click', () => applyCrewReview(btn.dataset.crewReview === 'yes'));
}

// ---------- תשובות על הרכב הצוות שהיומן עונה עליהן ----------

/** תשובות של המשתמש על הרכב הצוות בחודש הפתוח שהיומן עונה עליהן, ועוד לא הוחלט בהן מולו. */
function crewReview() {
  const r = state.record;
  if (!r || !state.result) return [];
  return crewAnswersInCalendar({ calendar: r.calendar, answers: r.answers ?? {}, domicile: state.result.domicile, period: r.period, ignored: r.calendarIgnored ?? [] });
}

/**
 * תשובות שנשמרו לפני שהיומן הראה את הרכב הצוות: האם לעדכן מהיומן (בעל המוצר, 04/10/2026). כן –
 * מה שהיומן מאשר עובר אליו, ומה שהוא שונה בו נשאל שוב; לא – התשובות נשארות, וניתנות לשינוי ידני.
 */
function renderCrewReview(review) {
  const n = review.length;
  const diff = review.filter((x) => x.differs);
  const kind = (x) => x.id.split(':')[0];
  const lead = diff.length === n
    ? (n === 1 ? 'היומן שונה מהתשובה שלך, והשאלה תישאל שוב' : 'בכולן היומן שונה מהתשובה שלך, והן יישאלו שוב')
    : `ב-${diff.length} מהן היומן שונה מהתשובה שלך, ו${diff.length === 1 ? 'היא תישאל' : 'הן יישאלו'} שוב`;
  return `<div class="notice info">ביומן מופיע הרכב הצוות של ${n === 1 ? 'טיסה אחת' : `${n} טיסות`} שכבר ענית עליהן. לעדכן אותן מהיומן?
    ${diff.length ? `<p class="small">${lead}:</p>
    <ul>${diff.map((x) => `<li>${esc(describeQuestionId(x.id))}: ענית ${esc(answerLabel(x.answer, kind(x)))}, ביומן ${esc(answerLabel(x.calendar, kind(x)))}</li>`).join('')}</ul>` : ''}
    <div class="row"><button type="button" class="btn primary" data-crew-review="yes">עדכן מהיומן</button>
      <button type="button" class="btn" data-crew-review="no">השאר את התשובות שלי</button></div>
  </div>`;
}

async function applyCrewReview(update) {
  const r = state.record;
  const ignored = new Set(r.calendarIgnored ?? []);
  const hints = { ...(r.crewHints ?? {}) };
  for (const x of crewReview()) {
    const related = relatedCrewIds(x.id, state.result?.crewIdOf);
    if (update) {
      delete r.answers[x.id];
      if (!x.differs) continue;
      // השאלה נשאלת שוב, עם מה שענית קודם ומה שביומן.
      for (const id of related) { ignored.add(id); hints[id] = { answer: x.answer, calendar: x.calendar }; }
    } else {
      for (const id of related) ignored.add(id);
    }
  }
  r.calendarIgnored = [...ignored];
  r.crewHints = hints;
  state.notices = [];
  await runAndSave();
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
      step('info', 'ה-<bdi dir="ltr">Client ID</bdi> אינו תקין. הוא מסתיים ב-<bdi dir="ltr">.apps.googleusercontent.com</bdi>.');
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
      step('info', `לא נמצאו נתוני סבבים באף יומן בחשבון הזה. ייתכן שנבחר חשבון גוגל לא מתאים, או שלא בוצע סנכרון דרך האורגנייזר.
        <label>אפשר לבחור יומן בעצמך <select name="calendarId">${all.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label>
        <button type="button" class="btn" data-cal="pick">חיבור היומן הזה</button>`);
      $('[data-cal="pick"]', dlg).addEventListener('click', async () => {
        const id = $('select[name="calendarId"]', dlg).value;
        dlg.close();
        await connectCalendar(clientId, [all.find((c) => c.id === id)], { manual: true });
      });
    } catch (err) {
      step('info', esc(err.message));
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
  // יומן של טייס אחר אינו מתעדכן בחודש של טייס אחר (בעל המוצר, 08/10/2026).
  if (!c || state.calBusy || foreignCalendar(state.record)) return;
  // בלי רשת (`calendarToken`): ההודעה בשורת היומן.
  if (!pending) { if (state.calOffline) renderCalendarBar(); return; }
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
    state.calGaps = r && state.result && !(facts.owner && r.staff && facts.owner !== r.staff) ? { key: r.key, items: calendarGaps({ prev: r.calendar, fresh: monthCalendar(facts, r.period), domicile: state.result.domicile, period: r.period }) } : null;
    const hint = all.find((x) => x.primary)?.id ?? c.hint ?? null;
    state.calendar = { ...c, calendars: cals, hint, facts: { ...facts, from: timeMin }, synced: new Date().toISOString() };
    await safe(() => store.putSetting(CAL_SETTING, state.calendar));
    state.calOffline = false;
  } catch (err) {
    state.calOffline = !!err.offline;
    if (!err.offline) state.calError = err.message;
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
  // המכשיר יודע שאין רשת: בלי ניסיון, ובלי החלון של גוגל (בעל המוצר, 11/10/2026).
  if (!navigator.onLine) { state.calOffline = true; state.calError = null; return null; }
  const token = calendar.cachedToken();
  if (token) return Promise.resolve(token);
  if (navigator.userActivation && !navigator.userActivation.isActive) return null;
  return calendar.requestToken(c.clientId, { hint: c.hint });
}

async function calendarRange() {
  const keys = (await safe(() => store.listMonths(), [])).map((m) => store.monthKey(m.period)).sort();
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
  state.calOffline = false;
  await safe(() => store.deleteSetting(CAL_SETTING));
  if (state.record) await runAndSave();
  else renderCalendarBar();
}

/**
 * החודשים של אותו טייס שלפני `record`, מהחדש לישן, לחלונות של מגבלות החוק שמתחילים לפני החודש (168 שעות,
 * 672 שעות, 365 ימים). `months` כבר ממוינים מהחדש לישן.
 */
/** התשובה האחרונה על הצי בחודש אחר של אותו טייס, לפי החודש המאוחר ביותר (טיוטה 410). */
function lastFleetAnswer(record, months) {
  const key = store.monthKey(record.period);
  return months.filter((m) => store.samePilot(m, record) && store.monthKey(m.period) !== key)
    .sort((a, b) => store.monthKey(b.period).localeCompare(store.monthKey(a.period)))
    .map((m) => Object.entries(m.answers ?? {}).find(([id]) => id.startsWith('fleet:'))?.[1]?.value)
    .find(Boolean) ?? null;
}

function historyFor(record, months) {
  const key = store.monthKey(record.period);
  return months.filter((m) => store.samePilot(m, record) && store.monthKey(m.period) < key && (m.plan || m.exec)).map((m) => ({ period: m.period, plan: m.plan ?? null, exec: m.exec ?? null }));
}

/** שורות ההשוואה שמוצגות. FLT+DH חוזר על הקרדיט של אותן טיסות, ולכן לא מוצג ולא נספר. */
/** עמודות הפיצויים בדוח. השאר הן קרדיט ועמודות סימון. */
const COMP_COLUMNS = new Set(['Rig', 'COM', 'S/C']);
const MAIN_COLUMNS = ['Credit', 'Rig', 'COM', 'S/C'];

/**
 * שורות הטבלה: לכל יום (או סבב) שורת Credit, ושורות Rig, ‏COM ו-S/C כשיש בהן ערך.
 * FLT+DH, ‏TAB ועמודות הסימון (VAC, SICK...) אינן מוצגות כשורות. פער באחת מהן נרשם
 * על שורת ה-Credit של אותו יום (`marks`), כדי שלא ייעלם. אם אין שורת Credit, היא מוצגת.
 * S/C מוצג כ-COM, ו-COM ו-S/C של אותה שורה הם שורה אחת עם הסכום, שמושווית לסכום שתי העמודות
 * ברומה (בעל המוצר, 22/10/2026; טיוטה 402).
 */
function shownComparison(res) {
  const main = [];
  for (const c of res.comparison.filter((x) => MAIN_COLUMNS.includes(x.column))) {
    const row = { ...c, column: c.column === 'S/C' ? 'COM' : c.column, items: [...c.items], notes: c.notes && [...c.notes], marks: [] };
    const same = row.column === 'COM' && main.find((m) => m.column === 'COM' && m.label === row.label && (m.at ?? m.dates[0]) === (row.at ?? row.dates[0]));
    if (!same) { main.push(row); continue; }
    same.expected += row.expected;
    same.reported += row.reported;
    same.diff = same.reported - same.expected;
    same.pending = (same.pending || row.pending) && same.diff !== 0;
    same.ok = same.pending ? null : same.diff === 0 || Boolean(same.ok && row.ok);
    same.items.push(...row.items);
    if (row.notes) same.notes = [...(same.notes ?? []), ...row.notes];
  }
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
 * (`explain` של כל ציפייה). שם החוק מוצג רק כשלוחצים על השורה (`setupRuleTips`).
 * הסכום אינו בהסבר, כי הוא כבר בשורה; רק כשכמה חוקים חולקים שורה כתוב ליד כל אחד החלק שלו. ציפייה
 * בלי הסבר (קריאה מיוחדת, הורדה מטיסה אחרי תשובה) מוסברת בשם הקצר של החוק, כדי שאף פיצוי לא יישאר
 * בלי שורה מתחת לטיסה (בעל המוצר, 07/10/2026). `notes` של השורה: פיצוי שברומה ואף חוק אינו מסביר.
 */
function explainOf(c) {
  // בשורת קרדיט – רק הקיזוז בגבול החודש (`creditNote`; טיוטות 374, 376).
  if (!COMP_COLUMNS.has(c.column)) return c.items.filter((e) => e.creditNote).map((e) => `<div class="explain">${esc(e.creditNote)}</div>`).join('');
  const share = (e) => (c.items.length > 1 && c.unit !== 'count' ? ` · <span class="num">${minToHhmm(e.min)}</span>` : '');
  const text = (e) => e.explain || e.shortTitle || e.ruleTitle || '';
  const lines = [
    ...c.items.map((e) => `${esc(share(e) ? text(e).replace(/\.$/, '') : text(e))}${share(e)}`.trim()),
    ...(c.notes ?? []).map(esc),
  ];
  return [...new Set(lines.filter(Boolean))].map((l) => `<div class="explain">${l}</div>`).join('');
}

// ---------- שם החוק ----------

/** `data-rule` של שורה: שמות החוקים שמסבירים אותה, שם בכל שורה. */
const ruleAttr = (titles) => {
  const t = [...new Set(titles.filter(Boolean))];
  return t.length ? ` data-rule="${esc(t.join('\n'))}"` : '';
};

// ציור מחדש של התוצאות מסיר את השורה שהחלון מתאר.
function hideRuleTip() {
  const tip = $('.rule-tip');
  if (tip) tip.hidden = true;
}

/**
 * שם החוק אינו כתוב בטבלאות ובהערות (בעל המוצר, 04/10/2026): הוא מוצג כשלוחצים על השורה, גם
 * במחשב ולא בריחוף. לחיצה נוספת, או לחיצה במקום אחר, סוגרת אותו.
 */
function setupRuleTips() {
  const tip = document.createElement('div');
  tip.className = 'rule-tip no-print';
  tip.hidden = true;
  document.body.append(tip);
  let shownFor = null;
  const hide = hideRuleTip;
  const isShown = (el) => !tip.hidden && el === shownFor;
  const show = (el, x) => {
    tip.textContent = el.dataset.rule;
    tip.hidden = false;
    shownFor = el;
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    tip.style.left = `${Math.min(Math.max(8, x - w / 2), innerWidth - w - 8)}px`;
    tip.style.top = `${r.bottom + h + 8 > innerHeight ? r.top - h - 4 : r.bottom + 4}px`;
  };
  document.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-rule]');
    if (!el || e.target.closest('button, a, input, select, textarea, summary, label')) { hide(); return; }
    if (isShown(el)) hide(); else show(el, e.clientX);
  });
  addEventListener('scroll', hide, true);
  addEventListener('resize', hide);
}

function summarize(res) {
  // פער בסיכום נספר רק כשהפערים בשורות של אותה עמודה אינם מסבירים אותו, כדי לא לספור פער אחד פעמיים
  // (נובמבר ודצמבר 2025: Rig של 00:04 בשורה ובסיכום; בעל המוצר, 29/09/2026).
  // הכיוון כמו בטבלת הפירוט (`gapClass`): `gains` – הרומה זיכתה יותר מהצפוי, `losses` – פחות (בעל המוצר,
  // 18/10/2026). בסיכום החודשי – לפי מה שהשורות אינן מסבירות.
  const rowsDiff = (t) => res.comparison.filter((c) => (t.columns ?? [t.column]).includes(c.column) && c.ok === false).reduce((s, c) => s + c.diff, 0);
  const rows = shownComparison(res).filter(isGap).map((c) => (c.ok === false ? c.diff : -1));
  const totals = res.questions.length ? [] : res.totals.filter((t) => t.ok === false && t.reported - t.expected !== rowsDiff(t))
    .map((t) => t.reported - t.expected - rowsDiff(t));
  const diffs = [...rows, ...totals];
  return {
    mode: res.mode,
    questions: res.questions.length,
    gaps: diffs.length,
    gains: diffs.filter((d) => d > 0).length,
    losses: diffs.filter((d) => d <= 0).length,
    reviews: res.reviews.length,
    unknownCodes: res.unknownCodes.length,
    legal: res.legal?.violations.length ?? 0,
  };
}

async function openMonth(key, { quiet = false } = {}) {
  const record = await safe(() => store.getMonth(key), null);
  if (!record) return;
  await reparseStale(record);
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
  hideRuleTip();
  const root = $('#results');
  const res = state.result;
  const key = state.record?.key ?? null;
  if (state.sections.key !== key) state.sections = { key, open: new Map() };
  else if (keepDom) for (const d of root.querySelectorAll('details[data-section]')) state.sections.open.set(d.dataset.section, d.open);
  renderCalendarBar();
  const parts = [state.notices.map((n) => `<div class="notice ${n.kind}">${esc(n.text)}</div>`).join(''), slipNotice()];
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
  parts.push(renderAnswered(res));
  root.innerHTML = parts.join('');
  for (const d of root.querySelectorAll('details[data-section]')) {
    if (state.sections.open.has(d.dataset.section)) d.open = state.sections.open.get(d.dataset.section);
  }
  bindResults(root);
}

function renderHead(res) {
  const r = state.record;
  const emp = r.person ?? store.personOf(r.exec) ?? store.personOf(r.plan) ?? '';
  // פרטי החישוב לא על המסך: בחלון צף במעבר עם העכבר, ובמכשיר בלי עכבר (אייפד) בלחיצה על שם החודש. בהדפסה הם מופיעים.
  const meta = `${MODE_LABEL[res.mode]} · בסיס ${res.domicile ?? '?'}${res.fleetPending ? ' · צי ?' : res.mff ? ' · צי \u20667877\u00a0(MFF)\u2069' : res.fleet ? ` · צי ${res.fleet}` : ''} · חוקים ${res.rulesVersion}`;
  const hover = matchMedia('(hover: hover)').matches;
  // שם הטייס ליד שם החודש, לפני היומן; "ייצוא PDF" בכרטיס הסיכום, וכאן רק כשאין כזה (בעל המוצר, 08/10/2026).
  return `<div class="card">
    <div class="result-head">
      <h2${hover ? ` title="${esc(meta)}"` : ''}>${hover ? '' : '<button type="button" class="cal-toggle" data-action="head-info">'}${esc(monthName(res.period))}${hover ? '' : '</button>'}</h2>
      ${emp.trim() ? `<span class="head-name">${esc(emp.trim())}</span>` : ''}
      <span class="meta head-meta">${esc(meta)}</span>
      <span class="cal-inline no-print" id="head-cal"></span>
      ${hasTotals(res) ? '' : `<span class="spacer"></span>${PRINT_BUTTON}`}
    </div>
    <div class="no-print" id="head-cal-info"></div>
    ${hover ? '' : `<p class="small muted no-print" data-head-info hidden>${esc(meta)}</p>`}
    <p class="print-only small">הופק ${esc(new Date().toLocaleDateString('he-IL'))}</p>
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
  const pending = res.questions.filter((q) => q.id.startsWith('crew:')).length;
  const status = pending
    ? `נבדקה עמידה בכל מגבלות החוק: אין חריגה, חוץ מ${pending === 1 ? '-FDP אחד שממתין' : `-${pending} FDP שממתינים`} לתשובה על הרכב הצוות.`
    : `נבדקה עמידה בכל מגבלות החוק: אין חריגה.`;
  return crew ? `${status} ${crew}` : status;
}


function renderAlerts(res) {
  const out = [];
  if (res.warnings.length) {
    // בלי כותרת "אזהרות" ובלי תבליטים: רק ההודעות, כל אחת בשורה משלה (בעל המוצר, 08/10/2026).
    out.push(`<div class="notice warn">${res.warnings.map((w) => `<div>${esc(w)}</div>`).join('')}</div>`);
  }
  if (res.infos?.length) {
    // רומה שאינה סופית: הודעת מערכת, בכחול (טיוטה 332).
    out.push(`<div class="notice info">${res.infos.map((w) => `<div>${esc(w)}</div>`).join('')}</div>`);
  }
  if (res.unknownCodes.length) {
    const open = res.unknownCodes.some((u) => !u.answer);
    // קוד לא מוכר הוא הודעת מערכת: בכחול עד התשובה, ואחריה בלי צבע (טיוטה 331).
    out.push(`<div class="notice${open ? ' info' : ''}"><strong>${esc(unknownCodesMessage(res))}</strong>
      <ul class="codes">${res.unknownCodes.map(renderUnknownCode).join('')}</ul>
      <button class="btn no-print" data-action="copy-codes">העתק פרטים</button></div>`);
  }
  if (res.reviews.length) {
    out.push(`<div class="notice warn"><strong>לבדיקה ידנית</strong><ul>${res.reviews.map((v) => `<li${ruleAttr([v.ruleTitle])}>${esc(v.message)}</li>`).join('')}</ul></div>`);
  }
  return out.length ? `<div class="card">${out.join('')}</div>` : '';
}

/**
 * קוד לא מוכר, עם כל מה שיודע עליו: התאריכים, מה שהדוח רשם באותם ימים, ותשובת
 * המשתמש עליו אם נשאל. כל אלה מה שדרוש כדי לעדכן את `rules.json` לפי הקוד החדש.
 */
function renderUnknownCode(u) {
  // קוד שהונח כפעילות קרקע: רק ההנחה; מה שהרומה רשמה – בטקסט שמועתק (בעל המוצר, 15/10/2026).
  const lines = (u.assumed ? [u.assumed] : unknownCodeLines(u)).map((l) => `<div class="small">${esc(l)}</div>`).join('');
  return `<li><span class="num">${esc(u.code)}</span> ${esc(whereOf(u))}, בתאריכים ${u.dates.map(ddmm).join(', ')}${lines}</li>`;
}

/** הכותרת: קודים ועמודות לא מוכרים, ולמי להעביר (בעל המוצר, 08/10/2026). */
const unknownCodesMessage = (res) =>
  `האפליקציה זיהתה קודים לא מוכרים (${[...new Set(res.unknownCodes.map((u) => u.code))].join(', ')}) אנא העבר לניצן לבדיקה`;

const whereOf = (u) => (u.column ? 'עמודה ברומה' : u.where === 'both' ? 'בתכנון ובביצוע' : u.where === 'plan' ? 'בתכנון' : 'בביצוע');

/** שורות הפירוט של קוד לא מוכר, בלי HTML: אותן שורות מוצגות ומועתקות (קוד שהונח כפעילות קרקע – רק מועתקות). */
function unknownCodeLines(u) {
  const lines = [];
  const texts = [...new Set((u.report ?? []).map((r) => r.text))];
  if (texts.length === 1) lines.push(`ברומה: ${texts[0]}`);
  else for (const r of u.report ?? []) lines.push(`ברומה ${ddmm(r.date)}: ${r.text}`);
  lines.push(u.answer ? `לפי תשובתך: ${u.answer}` : u.assumed ?? 'האפליקציה לא יודעת מה מגיע עליו, ולא ניחשה.');
  return lines;
}

/** הפרטים כטקסט, להעתקה ולשליחה לעדכון האפליקציה. */
function unknownCodesText(res) {
  const head = `${unknownCodesMessage(res)} – ${monthName(res.period)} · חוקים ${res.rulesVersion}`;
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
    ${res.questions.map((q, i) => renderQuestion(q, i)).join('')}
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

/** `edit`: השאלה נפתחה ב"תשובות שנשמרו" ("answer" או "assumed"; `editAnswer`), עם "ביטול". */
function renderQuestion(q, i, edit = null) {
  const name = `q${i}`;
  const options = q.options.map((o) => `
    <label class="option">
      <input type="radio" name="${name}" value="${esc(o.value)}" ${o.needsLink ? 'data-needs-link' : ''} ${o.needsText ? 'data-needs-text' : ''}>
      <span>${esc(datesFirst(o.label))}${o.count ? ` <select name="count" data-count-for="${esc(o.value)}">${o.count.map((c) => `<option value="${esc(c.value)}">${esc(c.label)}</option>`).join('')}</select>` : ''}${o.reasons ? ` <select name="reason" data-reason-for="${esc(o.value)}"><option value="">סיבה: בחר</option>${o.reasons.map((c) => `<option value="${esc(c.value)}">${esc(c.label)}</option>`).join('')}</select>` : ''}${o.hint ?` <span class="hint-inline">– ${esc(datesFirst(o.hint))}</span>` : ''}</span>
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
  const hint = state.record?.crewHints?.[q.id];
  const kind = q.id.split(':')[0];
  return `<div class="question">
    <h3>${titleHtml(q.title)}</h3>
    ${q.body ? `<p>${esc(datesFirst(q.body))}</p>` : ''}
    ${hint ? `<p class="small muted">ענית קודם ${esc(answerLabel(hint.answer, kind))}, וביומן ${esc(answerLabel(hint.calendar, kind))}.</p>` : ''}
    <form data-qid="${esc(q.id)}"${edit ? ` data-edit="${edit}"` : ''}>
      ${picker}${options}
      <div class="row" style="margin-top:.5rem"><button class="btn primary" type="submit" ${q.dateInput ? '' : 'disabled'}>שמור תשובה</button><button class="btn" type="button" ${edit ? 'data-cancel-edit' : 'data-clear-answer'}>ביטול</button></div>
    </form>
  </div>`;
}

/** פער לטובת אצ"א (הדוח נתן יותר מהצפוי) בירוק, ולרעתו באדום. */
const gapClass = (diff) => (diff > 0 ? 'gain' : 'bad');
const signed = (min) => (min > 0 ? '+' : '') + minToHhmm(min);

const PRINT_BUTTON = '<button class="btn no-print" data-action="print">ייצוא PDF</button>';
const hasTotals = (res) => res.totals.length > 0 || planTotals(res).length > 0 || !!res.freeDays || !!res.perDiem;
const usd = (v) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** האש"ל הצפוי, שורה תחתונה בסיכום אחרי ספירת הימים (בעל המוצר, 09/10/2026). */
function perDiemLine(pd) {
  if (!pd) return '';
  const num = (v) => `<span class="num">${v}</span>`;
  const parts = [`${num(usd(pd.flightHours))} שעות טיסה`, `${num(usd(pd.stayHours))} שעות שהייה`];
  if (pd.hotelDays) parts.push(pd.hotelDays === 1 ? 'יום ויתור מלון אחד' : `${num(pd.hotelDays)} ימי ויתור מלון`);
  // תפקיד לא ידוע: לפי תעריף קברניט (בעל המוצר, 18/10/2026).
  const assumed = pd.positionAssumed ? ' · תפקיד לא ידוע – לפי תעריף קברניט' : '';
  // מקור התעריף, רק כשמשבצת תלוש האש"ל מוצגת (בעל המוצר, 18/10/2026).
  const source = !slipSlotOpen(state.record) || !pd.rateFrom ? ''
    : pd.rateSource === 'slip' ? ` · תעריף ${ratePeriod(pd.rateFrom)}, מתלוש האש"ל של ${MONTH_NAMES[Number(pd.rateFrom.slice(5, 7)) - 1]}`
      : ` · לפי התעריף האחרון הידוע (${ratePeriod(pd.rateFrom)})`;
  return `<p class="small">אש"ל צפוי: ${parts.join(' · ')} · סה"כ לתשלום ${num(`${usd(pd.usd)}$`)}${assumed}${source}</p>`;
}

/** בתכנון לבד: הקרדיט, ה-Rig וה-COM הצפויים לפי התכנון, בלי השוואה (בעל המוצר, 10/10/2026). S/C נספר עם COM. */
function planTotals(res) {
  if (res.mode !== 'plan' || !res.expectations.length) return [];
  const sum = (keys) => res.expectations.filter((e) => keys.has(e.key)).reduce((s, e) => s + e.min, 0);
  return [
    { column: 'Credit', expected: sum(CREDIT_KEYS) },
    { column: 'Rig', expected: sum(new Set(['rig'])) },
    { column: 'COM', expected: sum(COM_KEYS) },
  ];
}

/** שם המשבצת בסיכום. ליד Rig: השעות שלו כבר בקרדיט (בעל המוצר, 22/10/2026; טיוטה 400). */
const totalLabel = (column) => (column === 'Rig'
  ? '<div class="label" style="direction:rtl">Rig <span class="sub">(מוכל בקרדיט)</span></div>'
  : `<div class="label">${esc(column)}</div>`);

function renderTotals(res) {
  const fd = res.freeDays;
  if (!hasTotals(res)) return '';
  // כל עוד יש שאלות פתוחות, פער בסיכום אינו ממצא: הצפוי תלוי בתשובות.
  const pending = res.questions.length > 0;
  const plan = planTotals(res);
  const days = res.totals.length || plan.length ? dayCounts(res) : [];
  return `<div class="card">
    <h2>${res.totals.length || plan.length ? 'סיכום' : 'סיכום חודשי'}<span class="spacer"></span>${PRINT_BUTTON}</h2>
    <div class="totals">${res.totals.map((t) => {
      const gap = `פער <span class="num">${signed(t.reported - t.expected)}</span>`;
      // ✗ רק כשהרומה זיכתה פחות מהצפוי. כשזיכתה יותר – הפער בירוק, בלי סימן (בעל המוצר, 17/10/2026).
      const status = t.ok === true ? '✓' : t.ok === false ? (pending ? `ממתין · ${gap}` : t.reported > t.expected ? `· ${gap}` : `✗ ${gap}`) : '';
      return `
      <div class="total ${t.ok === true ? 'ok' : t.ok === false && !pending ? gapClass(t.reported - t.expected) : ''}">
        ${totalLabel(t.column)}
        <div class="val num">${minToHhmm(t.expected)}</div>
        <div class="rep">ברומה <span class="num">${minToHhmm(t.reported)}</span> ${status}</div>
      </div>`;
    }).join('')}${plan.map((t) => `
      <div class="total">
        ${totalLabel(t.column)}
        <div class="val num">${minToHhmm(t.expected)}</div>
        <div class="rep">צפוי לפי התכנון</div>
      </div>`).join('')}${fd ? `
      <div class="total free ${fd.free >= fd.due ? 'ok' : 'warn'}">
        <div class="label" style="direction:rtl">ימים פנויים בתכנון</div>
        <div class="val num">${fd.free}</div>
        <div class="rep">מינימום <span class="num">${fd.due}</span>${fd.free >= fd.due ? ' ✓' : ''}</div>
      </div>` : ''}
    </div>
    ${days.length ? `<p class="small">${days.join(' · ')}</p>` : ''}
    ${perDiemLine(res.perDiem)}
  </div>`;
}

/**
 * תווית של שורה בפירוט: התאריך (או הטווח) בראש כל שורה בבולד, כמו בטבלת השינויים (בעל המוצר, 17/10/2026; טיוטה 368).
 */
const boldDates = (label) => label.split('\n').map((line) => esc(line)
  .replace(/^(⁦?\d{2}\/\d{2}(?:[–-]\d{2}\/\d{2})?⁩?)/, '<strong class="num">$1</strong>')).join('<br>');

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
        const status = gap === 'gain' ? '' : gap ? `<span class="status ${gap}">✗</span>` : c.pending ? '<span class="status pending">ממתין</span>' : '<span class="status ok">✓</span>';
        const why = [
          // שורת פיצוי או Rig כבר מוסברת מתחת לטיסה. שורת קרדיט מפורטת רק כשיש בה פער.
          ...c.items.filter((e) => !COMP_COLUMNS.has(c.column) && c.ok !== true && (e.ruleTitle || e.note))
            .map((e) => `${esc(e.ruleTitle ?? '')}${e.note ? `: ${esc(e.note)}` : ''}${e.min != null && c.unit !== 'count' ? ` <span class="num">${minToHhmm(e.min)}</span>` : ''}`),
          ...c.marks.map((m) => `${esc(m.column)}: צפוי <span class="num">${hm(m.expected, m.unit)}</span>, ברומה <span class="num">${hm(m.reported, m.unit)}</span>`),
        ].join('<br>');
        const rule = ruleAttr([...c.items, ...c.marks.flatMap((m) => m.items)].map((e) => e.ruleTitle));
        return `<tr class="${cls}"${rule}>
          <td>${boldDates(c.label)}${explainOf(c)}</td><td class="col">${esc(c.column)}</td>
          <td class="num">${hm(c.expected, c.unit)}</td><td class="num">${hm(c.reported, c.unit)}</td>
          <td class="num">${c.ok ? '' : (c.diff > 0 ? '+' : '') + hm(c.diff, c.unit)}</td><td>${status}</td></tr>
          ${why ? `<tr class="detail"${rule}><td colspan="6">${why}</td></tr>` : ''}`;
      }).join('') || '<tr><td colspan="6" class="muted">אין שורות בסינון הזה.</td></tr>'}</tbody>
    </table></div>
  </details>`;
}

/** הסבב של ציפייה, מתחת לשם החוק: שלה, או תיאור הסבב שבראש ההסבר של ציפייה לפי תאריך (ב-`explain` הוא כבר אינו מופיע). */
const pairingOf = (e) => e.pairing ?? String(e.note ?? '').match(/^⁦[^⁩]*⁩/)?.[0] ?? null;

// בתכנון לבד בלבד. עם דוח ביצוע ספירת הימים מוצגת בסיכום החודשי מול הדוח.
function renderExpectations(res) {
  if (!res.expectations.length || res.mode !== 'plan') return '';
  // ציפייה על החודש כולו (ימים ללא פעילות) – ראשונה, בלי תאריך.
  const rows = [...res.expectations].sort((a, b) => (b.monthly ?? false) - (a.monthly ?? false) || a.date.localeCompare(b.date));
  // הקרדיט של כל טיסה הוא רק רעש: הסך הכול בכרטיס הסיכום (`planTotals`), ובטבלה רק הפיצויים.
  const shown = rows.filter((e) => !CREDIT_KEYS.has(e.key));
  return `<details class="card" data-section="expected" open>
    <summary><h2 style="display:inline">קרדיט ופיצויים צפויים</h2></summary>
    ${!shown.length ? '<p class="small muted">אין פיצויים צפויים לפי התכנון.</p>' : `<div class="table-wrap"><table>
      <thead><tr><th>תאריך</th><th>חוק</th><th>סוג</th><th>צפוי</th><th>הסבר</th></tr></thead>
      <tbody>${shown.map((e) => `<tr>
        <td class="num"><strong>${e.monthly ? '' : e.dates.length > 1 ? `${ddmm(e.dates[0])}–${ddmm(e.dates.at(-1))}` : ddmm(e.date)}</strong></td>
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

/**
 * שורת התכנון והביצוע של שינוי. כשהוא שרשרת של שינויים ביומן, לחיצה עליה פותחת את הפירוט: איך הסבב עבר
 * מהתכנון, דרך הסבבים שביומן, עד מה שבוצע בסוף (`steps`; בעל המוצר, 06/10/2026).
 */
function chainSides(c, sides) {
  if (!c.steps?.length) return `<div class="small">${sides}</div>`;
  return `<details class="chain"><summary class="small">${sides}</summary>
    ${c.steps.map((n) => `<div class="explain small">${esc(datesFirst(n.message))}</div>`).join('')}
  </details>`;
}

/** התאריך בכותרת השינוי: בכמה ימים – עד יום הנחיתה (`to`; טיוטה 394); החלפה עם שני תאריכים – "08/09 · 09/09". */
const changeDates = (c) => (c.dates ? c.dates.map(ddmm).join(' · ') : c.to > c.date ? `${ddmm(c.date)}–${ddmm(c.to)}` : ddmm(c.date));

function renderChanges(res) {
  if (res.mode === 'plan') return renderCalendarChanges(res);
  const changes = res.changes.filter((c) => c.how !== 'exact' && c.how !== 'noplan');
  if (res.mode !== 'full') return '';
  return `<details class="card" data-section="changes" ${changes.length ? 'open' : ''}>
    <summary><h2 style="display:inline">שינויים בין תכנון לביצוע <span class="count">${changes.length}</span></h2></summary>
    ${changes.length ? `<ul class="list">${changes.map((c) => `<li${ruleAttr((c.notes ?? []).map((n) => n.ruleTitle))}>
      <strong class="num">${changeDates(c)}</strong> ${esc(c.label)}
      ${chainSides(c, `<span class="side-plan">תכנון: ${esc(datesFirst(c.plan ?? '—'))}</span> · <span class="side-exec">ביצוע: ${esc(datesFirst(c.exec ?? (c.replacedBy?.join(', ') || '—')))}</span>`)}
      ${(c.notes ?? []).map((n) => `<div class="explain">${esc(n.message)}</div>`).join('')}
    </li>`).join('')}</ul>` : '<p class="muted">כל הסבבים בוצעו כמתוכנן.</p>'}
  </details>`;
}

/**
 * בתכנון לבד, כשיש ביומן נתונים מהחודש: השינויים בין התכנון ליומן (בעל המוצר, 04/10/2026) – השורות של
 * הרומה, כשהיומן נבדק כמו רומה בלי סכומים (`mergeCalendarRun` ב-js/rules/evaluate.js; 13/10/2026). הפיצויים
 * עליהם ייבדקו כשתועלה הרומה. מתחת לשינוי – התשובה על הסיבה, או שהיא ממתינה (06/10/2026).
 */
function renderCalendarChanges(res) {
  const changes = res.calendarChanges;
  if (!changes) return '';
  return `<details class="card" data-section="changes" ${changes.length ? 'open' : ''}>
    <summary><h2 style="display:inline">שינויים בין תכנון לביצוע <span class="count">${changes.length}</span></h2></summary>
    <p class="small muted">הקרדיט והפיצויים על השינויים ייבדקו כשתועלה הרומה.</p>
    ${changes.length ? `<ul class="list">${changes.map((c) => `<li>
      <strong class="num">${changeDates(c)}</strong> ${esc(c.label)}
      ${chainSides(c, `<span class="side-plan">תכנון: ${esc(datesFirst(c.plan ?? '—'))}</span> · <span class="side-exec">יומן: ${esc(datesFirst(c.calendar ?? '—'))}</span>`)}
      ${(c.notes ?? []).map((n) => `<div class="explain">${esc(datesFirst(n.message))}</div>`).join('')}
    </li>`).join('')}</ul>` : '<p class="muted">היומן תואם את התכנון.</p>'}
  </details>`;
}

// לפי תאריך הטיסה או היום שבמזהה, ולא לפי סדר השאלות (בעל המוצר, 06/10/2026). בלי תאריך במזהה – התאריך
// שנבחר בתשובה (פתיחת שנת הלימודים), ובלי שניהם – בסוף.
const ISO_DATE = /\d{4}-\d{2}-\d{2}/;
// שאלה על החודש כולו (ימים ללא פעילות) – בראש הרשימה (טיוטה 367).
const answerDate = ([id, a]) => id.match(ISO_DATE)?.[0] ?? (/:\d{4}-\d{2}$/.test(id) ? '0000' : null) ??
  String(a?.value ?? '').match(ISO_DATE)?.[0] ?? '9999';
// סדר קבוע, שאינו תלוי בכך שהשורה תשובה או הנחה, כדי ש"שנה" לא יזיז אותה (טיוטה 389): באותו תאריך שאלה
// שהתאריך שלה מהתשובה לפני הטיסות של אותו יום, ובשוויון – לפי המזהה.
const answerOrder = (a, b) => answerDate(a).localeCompare(answerDate(b)) ||
  Number(ISO_DATE.test(a[0])) - Number(ISO_DATE.test(b[0])) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/**
 * התשובות שנשמרו, ובינן ההנחות של האפליקציה כשהרומה זיכתה (`res.assumptions`; בעל המוצר, 17/10/2026, טיוטה 365):
 * "שנה" על הנחה מבטל אותה (`assumedIgnored`), והשאלה נשאלת.
 */
function renderAnswered(res) {
  const saved = state.record?.answers ?? {};
  // הנחה שאין בה מה לשנות – בלי שאלה כשמבטלים אותה – אינה מוצגת (`changeable`; טיוטה 388).
  const assumed = (res.assumptions ?? []).filter((x) => !saved[x.id] && x.changeable !== false).map((x) => [x.id, { value: x.value, label: x.label, why: x.why }, true]);
  const answers = [...Object.entries(saved), ...assumed].sort(answerOrder);
  if (!answers.length) return '';
  const recall = (id) => (res.vacationRecall?.includes(id) ? ' וביטול חופשה' : '');
  return `<details class="card" data-section="answered">
    <summary><h2 style="display:inline">תשובות שנשמרו <span class="count">${answers.length}</span></h2></summary>
    <ul class="list">${answers.map(([id, a, byApp]) => byApp ? `<li class="row">
      <span>${answeredHead(id)}: <strong>${esc(a.label ?? answerLabel(a.value, id.split(':')[0]))}${recall(id)}</strong>
        <div class="explain">הנחת האפליקציה: ${esc(a.why ?? 'הרומה מזכה את הפיצוי')}</div></span>
      <span class="spacer"></span>
      <button class="btn no-print" data-unassume="${esc(id)}">שנה</button>
    </li>` : `<li class="row">
      <span>${answeredHead(id)}: <strong>${esc(a.value === 'partial' && a.count ? `ויתרתי מרצוני על ${a.count === 1 ? 'יום אחד' : `${a.count} ימים`}` : a.label ?? answerLabel(a.value, id.split(':')[0]))}${recall(id)}</strong>
        ${a.link !== undefined ? `<span class="small muted">(${a.link === 'none' ? 'מסירת הטיסה ללא חלופה' : a.link ? esc(describePairingId(a.link)) : 'בחודש אחר'})</span>` : ''}
        ${a.text ? `<span class="small muted">– ${esc(a.text)}</span>` : ''}
        ${typeof a.creditMin === 'number' ? `<span class="small muted">(${a.creditMin ? `מגיע קרדיט ${minToHhmm(a.creditMin)}` : 'לא מגיע קרדיט'})</span>` : ''}</span>
      <span class="spacer"></span>
      <button class="btn no-print" data-unanswer="${esc(id)}">שנה</button>
    </li>`).join('')}</ul>
  </details>`;
}

// מה נבדק, בחלונית של ההערה כשאין חריגה (כמו שם החוק: בלחיצה על ההערה; בעל המוצר, 04/10/2026).
const LEGAL_TIP = 'נבדקו לכל לג/סבב שעות טיסה ו-FDP, מנוחה בין טיסות, ומגבלות טיסה מצטברות';

function renderNotes(res) {
  const legal = legalNote(res);
  const legalTip = res.legal && !res.legal.skipped && !res.legal.violations?.length ? LEGAL_TIP : null;
  const count = res.notes.length + (legal ? 1 : 0);
  if (!count) return '';
  return `<details class="card" data-section="notes">
    <summary><h2 style="display:inline">הערות <span class="count">${count}</span></h2></summary>
    <ul class="list">${res.notes.map((n) => `<li${n.severity ? ` class="${n.severity}"` : ''}${ruleAttr([n.ruleTitle])}>${n.date ? `<strong class="num">${ddmm(n.date)}${n.to && n.to !== n.date ? `–${ddmm(n.to)}` : ''}</strong> ` : ''}${esc(n.message)}</li>`).join('')}${legal ? `<li${ruleAttr([legalTip])}>${esc(legal)}</li>` : ''}</ul>
  </details>`;
}

const QUESTION_KIND = { fleet: 'הצי', cancelled: 'סבב שלא בוצע', unplanned: 'פעילות לא מתוכננת', replaced: 'סבב שהוחלף', assigned: 'מוצב לפעילות', standby_bid: 'טיסה בסוף כוננות', standby_code: 'קוד כוננות',
  school_start: 'פתיחת שנת הלימודים', free_days: 'ימים ללא פעילות', free_days_first: 'ימים ללא פעילות, X ב-1 לחודש',
  crew: 'הרכב הצוות', night_crew: 'הרכב הצוות', white: 'טיסה לבנה', diversion: 'סטיה לשדה משנה', swap_conflict: 'סבב שהוחלף',
  base_rest: 'מנוחה בבסיס', second_activity: 'פעילות נוספת באותו FDP', occasion: 'תאריך מיוחד', night_rounds: 'טיסות סבב לילה עוקבות',
  stay_extension: 'הארכת שהייה', miami_short_rest: 'קיצור מנוחה במיאמי', miami_delay: 'דחייה במיאמי', las_vegas_rest: 'קיצור מנוחה בלאס וגאס',
  sim_extension: 'הארכת סימולטור', extended: 'סבב שהתארך', saturdays: 'שתי שבתות ברצף' };

/**
 * ראש השורה ב"תשובות שנשמרו": התאריך (או טווח הסבב) בבולד, הכי מימין, ואחריו היעד או הטיסה וסוג השאלה
 * ("<b>07/07</b> LCA סבב שלא בוצע"); שאלה על החודש כולו – בלי תאריך ובלי חודש (בעל המוצר, 17/10/2026; טיוטה 367).
 */
function answeredHead(id) {
  const [kind, ...rest] = id.split(':');
  const ref = rest.join(':').replace(/^(?:[a-z][a-z_]*:)+/, '');
  const name = QUESTION_KIND[kind] ?? kind;
  const m = ref.match(/^(\d{4}-\d{2}-\d{2})(?:\.\.(\d{4}-\d{2}-\d{2}))?(?::([^:]+))?/);
  if (!m) return esc(/^\d{4}-\d{2}$/.test(ref) ? name : describeQuestionId(id));
  const to = m[2] ? state.result?.landingDays?.[m[0]] ?? m[2] : m[1];
  const date = to === m[1] ? ddmm(m[1]) : `${ddmm(m[1])}–${ddmm(to)}`;
  // מיד אחרי התאריך (טיוטה 368): היעד של סבב או מספר טיסה; לא מה שמבדיל בין שאלות באותו יום (`sim_extension:<תאריך>:<STD>`).
  const what = m[3] && (m[2] || /^[A-Z]{2}\d+$/.test(m[3])) ? ` ⁦${esc(m[3])}⁩` : '';
  return `<strong class="num">${date}</strong>${what} ${esc(name)}`;
}

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

/**
 * "2026-07-21..2026-07-22:ATH" → "21/07–22/07 ATH". "2026-08-03:LY373" (טיסה) → "03/08 LY373". סבב שנחת בבסיס
 * אחרי חצות – עד יום הנחיתה, כמו בטבלת השינויים (`landingDays`; בעל המוצר, 08/10/2026).
 */
function describePairingId(id) {
  const leg = String(id).match(/^(\d{4}-\d{2}-\d{2}):(.+)$/);
  if (leg) return `⁦${ddmm(leg[1])} ${leg[2]}⁩`;
  const m = String(id).match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2}):(.*)$/);
  if (!m) return id;
  const to = state.result?.landingDays?.[id] ?? m[2];
  return `⁦${m[1] === to ? ddmm(m[1]) : `${ddmm(m[1])}–${ddmm(to)}`} ${m[3]}⁩`;
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
  const copySlip = $('[data-action="copy-perdiem"]', root);
  copySlip?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(slipText(state.record));
      copySlip.textContent = 'הועתק';
      setTimeout(() => { copySlip.textContent = 'העתק לעדכון אצל כולם'; }, 2000);
    } catch {
      // דפדפן שאינו מרשה העתקה: הטקסט מוצג מסומן, להעתקה ידנית.
      const box = document.createElement('textarea');
      box.className = 'copy-text';
      box.readOnly = true;
      box.value = slipText(state.record);
      box.rows = 4;
      copySlip.replaceWith(box);
      box.focus();
      box.select();
    }
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
  for (const btn of root.querySelectorAll('[data-unanswer]')) btn.addEventListener('click', () => editAnswer(btn.closest('li'), btn.dataset.unanswer, false));
  for (const btn of root.querySelectorAll('[data-unassume]')) btn.addEventListener('click', () => editAnswer(btn.closest('li'), btn.dataset.unassume, true));
  for (const form of root.querySelectorAll('form[data-qid]')) {
    bindQuestionForm(form);
    // הצי: התשובה האחרונה מחודש אחר של אותו טייס מסומנת מראש (בעל המוצר, 25/10/2026; טיוטה 410).
    if (form.dataset.qid.startsWith('fleet:') && state.fleetPreset) preselectAnswer(form, { value: state.fleetPreset });
  }
}

/** שאלות שתשובה עליהן נפתחה בשורה שלה, וחלק מהשאלה שאינו בטופס (התווית של האפשרות). */
const editedQuestions = new Map();
let editSeq = 0;

/** תשובות שנמחקות עם התשובה: היא עצמה, והשאלות שנשאלו רק בגללה. */
const answerWithDependents = (id) => [id, ...(state.result?.dependentAnswers?.[id] ?? [])];

/** שאלת הרכב צוות: גם השאלות שהיומן עונה עליהן דרכה (בלי זה היומן היה עונה במקום התשובה; 04/10/2026). */
const crewReopen = (id) => (/^(crew|night_crew|white):/.test(id) ? relatedCrewIds(id, state.result?.crewIdOf) : []);

/**
 * "שנה" ב"תשובות שנשמרו": השאלה נפתחת בשורה שלה, ולא בכרטיס השאלות בראש הדף (בעל המוצר, 21/10/2026; טיוטה 385).
 * החודש רץ בלי התשובה (ובלי התשובות שתלויות בה), ועל הנחה – בלי ההנחה, בלי לשמור; השאלה שחזרה מוצגת עם התשובה
 * הנוכחית מסומנת. שום דבר אינו נמחק עד "שמור תשובה", ו"ביטול" מחזיר את השורה. כשהשאלה אינה חוזרת (היומן עונה
 * עליה) – כמו קודם: התשובה נמחקת, או ההנחה מתבטלת (`assumedIgnored`; טיוטה 365), והשאלה בכרטיס השאלות.
 */
async function editAnswer(li, id, assumed) {
  const r = state.record;
  const answers = { ...(r.answers ?? {}) };
  if (!assumed) for (const dep of answerWithDependents(id)) delete answers[dep];
  const months = await safe(() => store.listMonths(), []);
  let trial = null;
  try {
    trial = evaluate({ rulesData: rulesFor([r, ...months]), plan: r.plan, exec: r.exec, answers, history: historyFor(r, months), calendar: r.calendar ?? null,
      reopen: [...(r.calendarIgnored ?? []), ...crewReopen(id)], calendarHistory: r.calendarHistory ?? null, assumedIgnored: assumed ? [...(r.assumedIgnored ?? []), id] : r.assumedIgnored ?? [] });
  } catch { /* כמו קודם, למטה */ }
  const q = trial?.questions.find((x) => x.id === id);
  if (!q || !li) {
    if (assumed) r.assumedIgnored = [...new Set([...(r.assumedIgnored ?? []), id])];
    else {
      for (const dep of answerWithDependents(id)) delete r.answers[dep];
      r.calendarIgnored = [...new Set([...(r.calendarIgnored ?? []), ...crewReopen(id)])];
    }
    state.notices = [];
    await runAndSave();
    return;
  }
  const current = assumed ? state.result?.assumptions?.find((a) => a.id === id) : r.answers?.[id];
  editedQuestions.set(id, q);
  li.className = 'editing';
  li.innerHTML = renderQuestion(q, `e${++editSeq}`, assumed ? 'assumed' : 'answer');
  const form = $('form', li);
  bindQuestionForm(form);
  preselectAnswer(form, current);
  $('[data-cancel-edit]', li).addEventListener('click', () => renderResults());
}

/** התשובה הנוכחית מסומנת בטופס שנפתח ב"שנה": האפשרות, הטיסה בקישור, המספר, הטקסט והקרדיט ב"סיבה אחרת". */
function preselectAnswer(form, a) {
  if (!a) return;
  const date = $('input[type="date"]', form);
  if (date && a.value) date.value = a.value;
  const radio = [...form.querySelectorAll('input[type="radio"]')].find((x) => x.value === a.value);
  if (radio) {
    radio.checked = true;
    const extra = $(`.extra[data-for="${CSS.escape(a.value)}"]`, form);
    const link = extra && $('select[name="link"]', extra);
    if (link && a.link !== undefined && [...link.options].some((o) => o.value === (a.link ?? ''))) link.value = a.link ?? '';
    const text = extra && $('textarea', extra);
    if (text && a.text) text.value = a.text;
    const credit = extra && $('.credit-pick', extra);
    if (credit && typeof a.creditMin === 'number') {
      $('select[name="credit"]', credit).value = a.creditMin ? 'yes' : 'no';
      if (a.creditMin) $('select[name="creditMin"]', credit).value = String(a.creditMin);
    }
    const count = $(`select[data-count-for="${CSS.escape(a.value)}"]`, form);
    if (count && a.count != null) count.value = String(a.count);
    const reason = $(`select[data-reason-for="${CSS.escape(a.value)}"]`, form);
    if (reason && a.reason) reason.value = a.reason;
  }
  form.dispatchEvent(new Event('change'));
}

function bindQuestionForm(form) {
  const submit = $('button[type="submit"]', form);
  form.addEventListener('change', (e) => {
    // בחירת מספר או סיבה באפשרות שיש בה בחירה כזו בוחרת גם את האפשרות עצמה.
    const countFor = e.target.dataset?.countFor ?? e.target.dataset?.reasonFor;
    if (countFor) { const radio = $(`input[type="radio"][value="${CSS.escape(countFor)}"]`, form); if (radio) radio.checked = true; }
    const chosen = $('input[type="radio"]:checked', form);
    for (const extra of form.querySelectorAll('.extra')) extra.hidden = extra.dataset.for !== chosen?.value;
    for (const pick of form.querySelectorAll('.credit-pick')) {
      $('[data-credit-hours]', pick).hidden = $('select[name="credit"]', pick).value !== 'yes';
    }
    submit.disabled = !chosen && !$('input[type="date"]', form);
  });
  // "ביטול" בכרטיס השאלות: מנקה את הבחירה, והשאלה נשארת בלי תשובה (בעל המוצר, 25/10/2026; טיוטה 411).
  $('[data-clear-answer]', form)?.addEventListener('click', () => {
    form.reset();
    for (const radio of form.querySelectorAll('input[type="radio"]')) radio.checked = false;
    form.dispatchEvent(new Event('change'));
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const picker = $('input[type="date"]', form);
    const chosen = $('input[type="radio"]:checked', form);
    if (!chosen && !picker) return;
    if (picker && !picker.value) { alert('בחר תאריך.'); return; }
    const answer = { value: picker ? picker.value : chosen.value };
    // התווית של האפשרות שנבחרה, כפי שהופיעה בשאלה: "תשובות שנשמרו" מציג אותה.
    const question = form.dataset.edit ? editedQuestions.get(form.dataset.qid) : state.result?.questions.find((q) => q.id === form.dataset.qid);
    const label = question?.options?.find((o) => o.value === answer.value)?.label;
    if (label) answer.label = label;
    if (chosen?.hasAttribute('data-needs-link')) {
      const sel = $(`.extra[data-for="${CSS.escape(chosen.value)}"] select`, form);
      answer.link = sel?.value || null;
    }
    const count = chosen && $(`select[data-count-for="${CSS.escape(chosen.value)}"]`, form);
    if (count) answer.count = Number(count.value);
    // סיבה מתפריט ליד התשובה ("לא מגיע פיצוי – חודש עומס"; בעל המוצר, 29/10/2026; טיוטה 414).
    const reason = chosen && $(`select[data-reason-for="${CSS.escape(chosen.value)}"]`, form);
    if (reason) {
      if (!reason.value) { alert('בחר סיבה.'); return; }
      answer.reason = reason.value;
      answer.label = `${answer.label} – ${reason.selectedOptions[0].textContent}`;
    }
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
    // תשובה שהוחלפה ב"שנה" (`editAnswer`): השאלות שנשאלו רק בגללה נפתחות מחדש, כמו כשהיא נמחקת.
    if (form.dataset.edit === 'answer') {
      for (const dep of answerWithDependents(form.dataset.qid)) delete state.record.answers[dep];
      state.record.calendarIgnored = [...new Set([...(state.record.calendarIgnored ?? []), ...crewReopen(form.dataset.qid)])];
    }
    state.record.answers = { ...(state.record.answers ?? {}), [form.dataset.qid]: answer };
    if (state.record.crewHints) for (const id of relatedCrewIds(form.dataset.qid, state.result?.crewIdOf)) delete state.record.crewHints[id];
    state.notices = [];
    await runAndSave();
  });
}

// ---------- היסטוריה ----------

/** הסיכום של חודש שמור לפי החוקים והקוד הנוכחיים, ולא זה שנשמר בהרצה האחרונה שלו. */
function currentSummary(m, months) {
  if (!state.rulesData || !(m.plan || m.exec)) return m.summary ?? {};
  const cal = calendarFor(m);
  try {
    return summarize(evaluate({ rulesData: rulesFor(months), plan: m.plan, exec: m.exec, answers: m.answers ?? {}, history: historyFor(m, months), calendar: cal.saved ?? cal.fresh, reopen: m.calendarIgnored ?? [], calendarHistory: cal.saved ? m.calendarHistory ?? null : null, assumedIgnored: m.assumedIgnored ?? [] }));
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
        // סיכום שנשמר לפני טיוטה 369 אינו מבחין בכיוון: כל הפערים בו – לרעתך, כמו קודם.
        const gains = s.gains ?? 0;
        const losses = s.losses ?? s.gaps ?? 0;
        const tags = [
          m.plan ? '<span class="tag">תכנון</span>' : '',
          m.exec ? '<span class="tag">ביצוע</span>' : '',
          s.legal ? `<span class="tag bad">${s.legal === 1 ? 'חריגה ממגבלות החוק' : `${s.legal} חריגות ממגבלות החוק`}</span>` : '',
          s.questions ? `<span class="tag info">${s.questions === 1 ? 'שאלה פתוחה אחת' : `${s.questions} שאלות פתוחות`}</span>` : '',
          gains ? `<span class="tag ok">${gains === 1 ? 'פער לטובתך' : `${gains} פערים לטובתך`}</span>` : '',
          losses ? `<span class="tag bad">${losses === 1 ? 'פער לרעתך' : `${losses} פערים לרעתך`}</span>` : '',
          m.exec && !s.gaps && !s.questions ? '<span class="small muted">תואם לרומה</span>' : '',
        ].join(' ');
        return `<li class="month-item">
          <span class="name">${esc(monthName(m.period))}</span>${m.person ? ` <span class="muted">${esc(m.person)}</span>` : ''} ${tags}
          <span class="small muted">עודכן ${esc(m.updated ? new Date(m.updated).toLocaleDateString('he-IL') : '')}</span>
          <span class="spacer"></span>
          <button class="btn" data-open="${esc(m.key)}">פתח</button>
          <button class="btn danger" data-delete="${esc(m.key)}">מחק</button>
        </li>`;
      }).join('')}</ul>` : '<p class="muted">עדיין אין חודשים שמורים. העלה קובץ במסך הבדיקה.</p>'}
    </div>
    <div class="card">
      <h2>גיבוי ושחזור</h2>
      <p class="small muted">קובץ הגיבוי מכיל את קובצי התכנון והביצוע, את הנתונים שחולצו מהם ואת התשובות שלך. שמור אותו במקום פרטי. אפשר להעביר איתו את החודשים השמורים בין מכשירים שונים.</p>
      <div class="row">
        <button class="btn" data-action="backup" ${months.length ? '' : 'disabled'}>שמור</button>
        <label class="btn">שחזר מקובץ<input type="file" accept="application/json,.json" hidden data-action="restore"></label>
        <button class="btn danger" data-action="clear" ${months.length ? '' : 'disabled'}>נקה</button>
      </div>
    </div>`;

  for (const b of root.querySelectorAll('[data-open]')) {
    b.addEventListener('click', async () => {
      // בחודש של טייס אחר היומן אינו מתעדכן, ולכן גם לא מבקשים הרשאה.
      const calToken = foreignCalendar(months.find((m) => m.key === b.dataset.open)) ? null : calendarToken();
      await openMonth(b.dataset.open);
      if (calToken) syncCalendar(calToken);
    });
  }
  for (const b of root.querySelectorAll('[data-delete]')) {
    b.addEventListener('click', async () => {
      if (!await confirmDialog('למחוק את החודש מהחודשים השמורים? התשובות שנתת עליו יימחקו.', 'מחק')) return;
      await store.deleteMonth(b.dataset.delete);
      if (state.record?.key === b.dataset.delete) { state.record = null; state.result = null; state.notices = []; renderUploadState(); renderResults(); }
      renderHistory();
    });
  }
  $('[data-action="backup"]', root)?.addEventListener('click', () => saveFile(
    `elal-compensations-backup-${new Date().toISOString().slice(0, 10)}.json`,
    async () => JSON.stringify(await store.exportBackup()),
    { type: 'application/json', description: 'חודשים שמורים' },
  ));
  // כל החודשים השמורים, עם התשובות וקובצי ה-PDF; חיבור היומן נשאר (בעל המוצר, 08/10/2026).
  $('[data-action="clear"]', root)?.addEventListener('click', async () => {
    if (!await confirmDialog(`למחוק את כל החודשים השמורים (${months.length})? הנתונים יימחקו מהמכשיר. ` +
      'ניתן יהיה לשחזר אותם רק מקובץ גיבוי. מומלץ לשמור את הנתונים לפני מחיקה.', 'מחק')) return;
    await store.clearMonths();
    if (state.record) { state.record = null; state.result = null; state.notices = []; }
    for (const kind of FILE_KINDS) dropFileLink(kind);
    renderUploadState();
    renderResults();
    renderHistory();
  });
  $('[data-action="restore"]', root)?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const c = await store.importBackup(JSON.parse(await file.text()));
      alert(`שוחזרו ${c.added} חודשים חדשים, ${c.replaced} עודכנו, ${c.skipped} דולגו (הגרסה במכשיר חדשה יותר).` +
        (c.files ? ` שוחזרו ${c.files === 1 ? 'קובץ PDF אחד' : `${c.files} קובצי PDF`}.` : ''));
      // ייתכן ששוחזר קובץ לחודש הפתוח: לטעון אותו מחדש, כדי שאפשר יהיה לפתוח אותו.
      for (const kind of FILE_KINDS) dropFileLink(kind);
      renderUploadState();
    } catch (err) {
      alert(`השחזור נכשל: ${err.message}`);
    }
    renderHistory();
  });
}

/**
 * חלון אישור עם הכפתורים `okLabel` ו"ביטול", במקום `confirm` של הדפדפן, שהכפתורים בו OK ו-Cancel (בעל המוצר, 08/10/2026).
 * הפוקוס על "ביטול", כך ש-Enter או Esc אינם מוחקים.
 */
function confirmDialog(message, okLabel) {
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog no-print';
  dlg.innerHTML = `<form method="dialog"><p>${esc(message)}</p>
    <div class="row"><button class="btn danger" value="ok">${esc(okLabel)}</button>
      <button class="btn" value="cancel" autofocus>ביטול</button></div></form>`;
  document.body.append(dlg);
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => { dlg.remove(); resolve(dlg.returnValue === 'ok'); });
    dlg.showModal();
  });
}

/**
 * שמירת קובץ: במחשב (Edge/Chrome) חלון "שמירה בשם", כדי לבחור איפה לשמור (בעל המוצר, 08/10/2026);
 * בלעדיו (Safari, Firefox) – הורדה רגילה. `make` בונה את התוכן רק אחרי החלון, כי הדפדפן מתיר אותו רק מיד אחרי הלחיצה.
 */
async function saveFile(name, make, { type, description }) {
  if (!window.showSaveFilePicker) {
    download(name, await make(), type);
    return;
  }
  let handle;
  try {
    handle = await window.showSaveFilePicker({
      suggestedName: name,
      types: [{ description, accept: { [type]: [name.slice(name.lastIndexOf('.'))] } }],
    });
  } catch (err) {
    if (err.name !== 'AbortError') alert(`השמירה נכשלה: ${err.message}`);
    return;
  }
  try {
    const writable = await handle.createWritable();
    await writable.write(await make());
    await writable.close();
  } catch (err) {
    alert(`השמירה נכשלה: ${err.message}`);
  }
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

/**
 * חוקי ההסכמים, והסיבה לכל חוק שאינו נתמך. חוק שהאפליקציה צריכה לבדיקה ואינו סעיף בהסכם
 * (`agreement: false`) אינו מוצג – חוץ מכשאינו נתמך, כדי שלא ייעלם בשקט.
 */
function agreementRules() {
  const { unsupported } = partitionRules(state.rulesData.rules);
  const reasonOf = new Map(unsupported.map((u) => [u.rule.id, u.rule.unsupported_reason ?? u.reason]));
  const all = state.rulesData.rules.filter((r) => r.agreement !== false || reasonOf.has(r.id));
  return { all, reasonOf };
}

/** החוקים לפי החיפוש והסינון שבמסך, והסיבה לכל חוק שאינו נתמך. */
function filteredRules() {
  const { all, reasonOf } = agreementRules();
  const q = rulesUi.q.trim().toLowerCase();

  const rules = all.filter((r) => {
    // חוק שבוטל היה בתוקף עד שבוטל; `valid_from`/`valid_to` משמשים לחישוב חודשי עבר
    // ולא לתצוגה. למשתמש מוצג רק "בוטל", וכברירת מחדל הוא מוסתר.
    const isCancelled = r.status === 'cancelled';
    if (isCancelled && !rulesUi.showCancelled) return false;
    if (rulesUi.category === 'cancelled') { if (!isCancelled) return false; }
    else if (rulesUi.category === 'unsupported') { if (!reasonOf.has(r.id)) return false; }
    else if (rulesUi.category && r.category !== rulesUi.category) return false;
    if (!q) return true;
    return [r.title, r.when, r.amount?.text, r.source, r.agreement_note].some((s) => String(s ?? '').toLowerCase().includes(q));
  });
  return { rules, all, reasonOf };
}

const dmy = (iso) => (iso ? iso.split('-').reverse().join('/') : null);
/** סוף התוקף. חוק שבוטל בלי `valid_to` הוא חוק שמועד הביטול שלו אינו ידוע. */
const validTo = (r) => dmy(r.valid_to) ?? (r.status === 'cancelled' ? 'מועד לא ידוע' : 'היום');
const amountText = (r) => r.amount?.text ?? (r.amount?.value != null ? `${r.amount.value}` : '—');

function renderRuleList() {
  const root = $('#view-rules');
  const { rules, all, reasonOf } = filteredRules();

  $('[data-role="count"]', root).textContent = `מוצגים ${rules.length} מתוך ${all.length} חוקים (מתוכם ${rules.filter((r) => reasonOf.has(r.id)).length} לא נתמכים)`;
  $('[data-role="list"]', root).innerHTML = rules.map((r) => {
    const reason = reasonOf.get(r.id);
    const tags = [
      `<span class="tag">${esc(CATEGORY_LABEL[r.category] ?? r.category)}</span>`,
      r.status === 'cancelled' ? '<span class="tag">בוטל</span>' : '',
      r.status === 'changed' ? '<span class="tag">שונה</span>' : '',
      reason ? '<span class="tag info">לא נתמך</span>' : '<span class="tag ok">נתמך</span>',
    ].join(' ');
    const validity = `מ-${dmy(r.valid_from) ?? 'תמיד'} עד ${validTo(r)}`;
    return `<article class="rule ${r.status === 'cancelled' ? 'inactive' : ''}">
      <div class="rule-head"><h3>${esc(r.title)}</h3>${tags}</div>
      <dl>
        <dt>מתי</dt><dd>${esc(r.when)}</dd>
        <dt>כמה</dt><dd>${esc(amountText(r))}</dd>
        <dt>מקור</dt><dd>${esc(r.source)}</dd>
        <dt>תוקף</dt><dd>${esc(validity)}</dd>
        ${r.agreement_note ? `<dt>הערה</dt><dd>${esc(r.agreement_note)}</dd>` : ''}
        ${reason ? `<dt>למה לא נתמך</dt><dd>${esc(reason)}</dd>` : ''}
      </dl>
    </article>`;
  }).join('') || '<p class="muted">לא נמצאו חוקים.</p>';
}

/** הקובץ המקורי כמו שהוא בשרת, כדי לשמור על הפורמט. בלי רשת – מהעותק השמור. */
function exportRulesJson() {
  return saveFile('rules.json', async () => {
    try {
      const res = await fetch(new URL('../rules.json', import.meta.url), { cache: 'no-cache' });
      if (!res.ok) throw new Error();
      return await res.text();
    } catch {
      return JSON.stringify(state.rulesData, null, 2);
    }
  }, { type: 'application/json', description: 'קובץ החוקים' });
}

/** חוקי ההסכמים כגיליון Excel, כמו במסך, בלי קשר לחיפוש ולסינון שבו. */
function exportRulesXlsx() {
  const { all, reasonOf } = agreementRules();
  const STATUS = { ok: '', cancelled: 'בוטל', changed: 'שונה' };
  const header = ['שם', 'קטגוריה', 'מתי', 'כמה', 'מקור', 'בתוקף מ-', 'בתוקף עד', 'סטטוס', 'נתמך', 'הערה', 'למה לא נתמך'];
  const rows = all.map((r) => [
    r.title,
    CATEGORY_LABEL[r.category] ?? r.category,
    r.when,
    amountText(r),
    r.source,
    dmy(r.valid_from) ?? 'תמיד',
    validTo(r),
    STATUS[r.status] ?? r.status,
    reasonOf.has(r.id) ? 'לא' : 'כן',
    r.agreement_note,
    reasonOf.get(r.id),
  ]);
  const blob = xlsxBlob(header, rows, { sheet: 'חוקים', widths: [30, 10, 50, 30, 25, 11, 11, 10, 7, 40, 40] });
  return saveFile(`rules-${state.rulesData.rules_version}.xlsx`, () => blob,
    { type: blob.type, description: 'גיליון Excel' });
}
