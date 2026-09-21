// שכבת חילוץ משותפת מעל PDF.js.
// מחזירה פריטי טקסט עם מיקום בקואורדינטות התצוגה (אחרי סיבוב הדף),
// כי בלוח התכנון הטקסט הגולמי מתערבב בין העמודות.

import * as pdfjs from '../../vendor/pdfjs/pdf.mjs';

const WORKER_URL = new URL('../../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;

let workerConfigured = false;
function configureWorker() {
  if (workerConfigured) return;
  // בדפדפן: worker אמיתי. ב-Node (בדיקות) אין Worker, ואז משאירים את ברירת המחדל
  // של PDF.js, שהיא עיבוד בתהליך הראשי.
  if (typeof Worker !== 'undefined') pdfjs.GlobalWorkerOptions.workerSrc = WORKER_URL;
  workerConfigured = true;
}

/**
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {Promise<{width:number, height:number, rotate:number, items:Item[]}[]>}
 * Item = {s: string, x: number, y: number, w: number, h: number}
 *   x,y = הפינה השמאלית-תחתונה של הטקסט כפי שהוא מוצג, y גדל כלפי מטה.
 */
export async function extractPages(data) {
  configureWorker();
  const doc = await pdfjs.getDocument({
    data: toBytes(data),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;

  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const t = pdfjs.Util.transform(vp.transform, it.transform);
      items.push({
        s: it.str.trim(),
        x: round1(t[4]),
        y: round1(t[5]),
        w: round1(it.width || 0),
        h: round1(it.height || 0),
      });
    }
    pages.push({ width: vp.width, height: vp.height, rotate: page.rotate, items });
    page.cleanup();
  }
  await doc.destroy();
  return pages;
}

// PDF.js דורש Uint8Array אמיתי. Buffer של Node ו-ArrayBuffer של הדפדפן שניהם צריכים המרה.
function toBytes(data) {
  return ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
}

const round1 = (n) => Math.round(n * 10) / 10;

/** מרכז אופקי של פריט. העמודות בדוח הביצוע ממורכזות, לא מיושרות לשמאל. */
export const centerX = (it) => it.x + it.w / 2;

/**
 * קיבוץ פריטים לשורות לפי y.
 * @returns {Item[][]} שורות מלמעלה למטה, בכל שורה הפריטים מסודרים משמאל לימין.
 */
export function toRows(items, tol = 3) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  let cur = null;
  for (const it of sorted) {
    if (cur && Math.abs(it.y - cur.y) < tol) cur.items.push(it);
    else { cur = { y: it.y, items: [it] }; rows.push(cur); }
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x);
  return rows.map((r) => r.items);
}

/** הטקסט של כל הדף, לזיהוי סוג הקובץ. */
export const pageText = (page) => page.items.map((i) => i.s).join(' ');
