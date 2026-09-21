// עזרי זמן. כל משכי הזמן באפליקציה נשמרים כדקות שלמות.

/** "05:15" | "5:15" | "-01:30" → דקות. מחזיר null אם אינו משך תקין. */
export function hhmmToMin(s) {
  if (s == null) return null;
  const m = String(s).trim().match(/^(-)?(\d{1,3}):([0-5]\d)$/);
  if (!m) return null;
  const v = Number(m[2]) * 60 + Number(m[3]);
  return m[1] ? -v : v;
}

/** דקות → "05:15". */
export function minToHhmm(min) {
  if (min == null || !Number.isFinite(min)) return '—';
  const sign = min < 0 ? '-' : '';
  const a = Math.abs(Math.round(min));
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** דקות → שעות עשרוניות, כפי שהדוח מציג (92:05 → 92.08). */
export function minToDecimal(min) {
  return min == null ? null : Math.round((min / 60) * 100) / 100;
}

/** שעות עשרוניות (1.25) → דקות. משמש לערכי `amount` ב-rules.json. */
export function hoursToMin(hours) {
  return hours == null ? null : Math.round(hours * 60);
}

/** "!1825" | "1825" → {min, foreign}. הסימן ! מציין שדה מחוץ לאזור הזמן של הבסיס. */
export function clockToMin(s) {
  if (s == null) return null;
  const m = String(s).trim().match(/^(!)?([0-2]\d)([0-5]\d)$/);
  if (!m) return null;
  return { min: Number(m[2]) * 60 + Number(m[3]), foreign: !!m[1] };
}

/** "1.00" | "6.00" → מספר, או null. */
export function toNumber(s) {
  if (s == null) return null;
  const n = Number(String(s).trim().replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** ‏ISO של יום בחודש, בלי תלות באזור הזמן המקומי. */
export function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** מספר הימים בחודש. */
export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
