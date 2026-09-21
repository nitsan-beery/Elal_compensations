// אזור הזמן של כל שדה, כדי להמיר שעה מקומית (עם ! בתכנון) לשעון הבסיס.
//
// הטבלה מחזיקה רק שם אזור זמן (IANA), ואת ההפרש בתאריך מסוים מחשב הדפדפן (Intl), כולל
// שעון קיץ בשני הצדדים. זה מקור משני: הפרש שנלמד מהקבצים עצמם קודם לו. שדה שאינו
// בטבלה מחזיר null, והחוק מבקש בדיקה ידנית כמו קודם.

const ZONES = {
  // ישראל
  TLV: 'Asia/Jerusalem', ETM: 'Asia/Jerusalem', VDA: 'Asia/Jerusalem', HFA: 'Asia/Jerusalem',
  // בריטניה ואירלנד
  LHR: 'Europe/London', LTN: 'Europe/London', LGW: 'Europe/London', STN: 'Europe/London',
  MAN: 'Europe/London', EDI: 'Europe/London', DUB: 'Europe/Dublin',
  // מערב ומרכז אירופה
  CDG: 'Europe/Paris', ORY: 'Europe/Paris', NCE: 'Europe/Paris', MRS: 'Europe/Paris', LYS: 'Europe/Paris',
  FRA: 'Europe/Berlin', MUC: 'Europe/Berlin', BER: 'Europe/Berlin', TXL: 'Europe/Berlin', DUS: 'Europe/Berlin',
  HAM: 'Europe/Berlin', CGN: 'Europe/Berlin', STR: 'Europe/Berlin',
  AMS: 'Europe/Amsterdam', BRU: 'Europe/Brussels', LUX: 'Europe/Luxembourg',
  ZRH: 'Europe/Zurich', GVA: 'Europe/Zurich', BSL: 'Europe/Zurich',
  VIE: 'Europe/Vienna', SZG: 'Europe/Vienna',
  FCO: 'Europe/Rome', MXP: 'Europe/Rome', LIN: 'Europe/Rome', VCE: 'Europe/Rome', NAP: 'Europe/Rome',
  BLQ: 'Europe/Rome', CTA: 'Europe/Rome', PMO: 'Europe/Rome', PSA: 'Europe/Rome', VRN: 'Europe/Rome',
  MAD: 'Europe/Madrid', BCN: 'Europe/Madrid', AGP: 'Europe/Madrid', PMI: 'Europe/Madrid', VLC: 'Europe/Madrid',
  LIS: 'Europe/Lisbon', OPO: 'Europe/Lisbon', MLA: 'Europe/Malta',
  CPH: 'Europe/Copenhagen', ARN: 'Europe/Stockholm', OSL: 'Europe/Oslo', HEL: 'Europe/Helsinki',
  PRG: 'Europe/Prague', BUD: 'Europe/Budapest', WAW: 'Europe/Warsaw', KRK: 'Europe/Warsaw',
  ZAG: 'Europe/Zagreb', SPU: 'Europe/Zagreb', DBV: 'Europe/Zagreb', LJU: 'Europe/Ljubljana',
  BEG: 'Europe/Belgrade', TGD: 'Europe/Podgorica', TIV: 'Europe/Podgorica', TIA: 'Europe/Tirane',
  SKP: 'Europe/Skopje', SJJ: 'Europe/Sarajevo',
  // מזרח אירופה, יוון, קפריסין וטורקיה
  OTP: 'Europe/Bucharest', CLJ: 'Europe/Bucharest', IAS: 'Europe/Bucharest',
  SOF: 'Europe/Sofia', VAR: 'Europe/Sofia', BOJ: 'Europe/Sofia',
  ATH: 'Europe/Athens', SKG: 'Europe/Athens', HER: 'Europe/Athens', RHO: 'Europe/Athens', JTR: 'Europe/Athens',
  CFU: 'Europe/Athens', KGS: 'Europe/Athens', CHQ: 'Europe/Athens', JMK: 'Europe/Athens',
  LCA: 'Asia/Nicosia', PFO: 'Asia/Nicosia',
  IST: 'Europe/Istanbul', SAW: 'Europe/Istanbul', AYT: 'Europe/Istanbul', DLM: 'Europe/Istanbul', BJV: 'Europe/Istanbul',
  KIV: 'Europe/Chisinau', KBP: 'Europe/Kyiv', ODS: 'Europe/Kyiv', LWO: 'Europe/Kyiv',
  RIX: 'Europe/Riga', VNO: 'Europe/Vilnius', TLL: 'Europe/Tallinn', MSQ: 'Europe/Minsk',
  SVO: 'Europe/Moscow', DME: 'Europe/Moscow', VKO: 'Europe/Moscow', LED: 'Europe/Moscow',
  // קווקז ומרכז אסיה
  TBS: 'Asia/Tbilisi', BUS: 'Asia/Tbilisi', EVN: 'Asia/Yerevan', GYD: 'Asia/Baku',
  TAS: 'Asia/Tashkent', ALA: 'Asia/Almaty', NQZ: 'Asia/Almaty',
  // מזרח תיכון ואפריקה
  DXB: 'Asia/Dubai', AUH: 'Asia/Dubai', BAH: 'Asia/Bahrain', AMM: 'Asia/Amman', AQJ: 'Asia/Amman',
  CAI: 'Africa/Cairo', SSH: 'Africa/Cairo', RAK: 'Africa/Casablanca', CMN: 'Africa/Casablanca',
  ADD: 'Africa/Addis_Ababa', NBO: 'Africa/Nairobi', JNB: 'Africa/Johannesburg', CPT: 'Africa/Johannesburg',
  SEZ: 'Indian/Mahe',
  // אסיה
  BKK: 'Asia/Bangkok', HKT: 'Asia/Bangkok', DEL: 'Asia/Kolkata', BOM: 'Asia/Kolkata', GOI: 'Asia/Kolkata',
  PEK: 'Asia/Shanghai', PVG: 'Asia/Shanghai', CAN: 'Asia/Shanghai', HKG: 'Asia/Hong_Kong',
  NRT: 'Asia/Tokyo', HND: 'Asia/Tokyo', ICN: 'Asia/Seoul', MNL: 'Asia/Manila',
  SGN: 'Asia/Ho_Chi_Minh', HAN: 'Asia/Ho_Chi_Minh', SIN: 'Asia/Singapore', CMB: 'Asia/Colombo', MLE: 'Indian/Maldives',
  // צפון ודרום אמריקה, אוסטרליה
  JFK: 'America/New_York', EWR: 'America/New_York', BOS: 'America/New_York', IAD: 'America/New_York',
  PHL: 'America/New_York', ATL: 'America/New_York', MIA: 'America/New_York', FLL: 'America/New_York',
  MCO: 'America/New_York', ORD: 'America/Chicago', DFW: 'America/Chicago',
  LAX: 'America/Los_Angeles', SFO: 'America/Los_Angeles', LAS: 'America/Los_Angeles',
  YYZ: 'America/Toronto', YUL: 'America/Toronto', MEX: 'America/Mexico_City', PTY: 'America/Panama',
  GRU: 'America/Sao_Paulo', MEL: 'Australia/Melbourne',
};

/** ההפרש בדקות בין אזור זמן ל-UTC ברגע נתון. */
function utcOffset(zone, ms) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return Math.round((asUtc - Math.floor(ms / 60000) * 60000) / 60000);
}

/**
 * שעון מקומי בתחנה פחות שעון הבסיס, בדקות, בתאריך נתון (YYYY-MM-DD). נמדד בצהריים UTC,
 * כי מעברי שעון קיץ הם בלילה. null כששדה לא מוכר או שהדפדפן לא מכיר את האזור.
 */
export function stationOffset(station, date, base = 'TLV') {
  const zone = ZONES[station];
  const baseZone = ZONES[base];
  if (!zone || !baseZone) return null;
  try {
    const ms = Date.parse(`${date}T12:00:00Z`);
    return utcOffset(zone, ms) - utcOffset(baseZone, ms);
  } catch {
    return null;
  }
}
