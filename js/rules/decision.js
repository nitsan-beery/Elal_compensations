// ההחלטה על סבב מתוכנן (שלב 1, בעל המוצר, 30/10/2026, טיוטה 439): מה קרה בו ולמה, במקום אחד. כל מה שתלוי
// בסיבה קורא מכאן, ולא מסיק אותה בעצמו מהסימונים שהחוקים שמו על הסבב.

/** תשובות שמשמעותן "לא ביוזמתי": לעניין 2024 ס' 40 הן נחשבות ביצוע. */
export const COMPANY_CANCEL = ['cancelled', 'wet_lease', 'trainee', 'swap_777', 'replaced', 'diversion'];

/**
 * ההחלטה על סבב מתוכנן, לפי ההתאמה שלו מול הביצוע. הסיבה נשאלת פעם אחת בלבד, בשאלה על הסבב שלא בוצע,
 * וכשהרומה כבר הכריעה לא נשאלת שאלה, והסבב מסומן (החלטת בעל המוצר, 23/09/2026).
 *
 * `reason`: `company` – ביוזמת החברה, נספר כבוצע (ס' 40); `no` – לא נספר; `bid` – זכייה במכרז: אינה ביוזמת החברה,
 * ונספרת רק כשהטיסה שזכה בה מאותו סוג, ואת זה בודק החוק עצמו; `review` – בדיקה ידנית; `unknown` – השאלה עוד פתוחה.
 * `source`: מאיפה זה ידוע – `leave`, ‏`activity`, ‏`stay` (סבב מהחודש הקודם), `chain` (יומן השינויים), `rule` (סימון של חוק),
 * `answer`, או `none`.
 */
export function pairingDecision(ctx, match) {
  if (!match) return { reason: 'unknown', source: 'none' };
  const plan = match.plan;
  if (match.byLeave) return { reason: 'no', source: 'leave' }; // היעדרות ומחלה אינן ביוזמת החברה
  if (match.how === 'replaced_by_ground' || match.how === 'replaced_by_standby') return { reason: 'company', source: 'activity' }; // החברה הציבה אותו לפעילות קרקע או לכוננות
  // הצוות עוד היה בחו"ל, בסבב מהחודש הקודם או בסבב שהתארך (`explainByCarriedStay`); בהסכמה – לא ביוזמת החברה (טיוטה 449).
  if (match.how === 'carried_over') return { reason: match.carriedBy && ctx.answer(`extended:${match.carriedBy.id}`)?.value === 'agreed' ? 'no' : 'company', source: 'stay' };
  const answer = ctx.answerFor(match);
  // שרשרת מהיומן: השלב הראשון, זה שהוציא את הסבב מהשיבוץ, קובע (`reduceChain`; בעל המוצר, 06/10/2026).
  const count = answer?.count;
  if (count) {
    const reason = { voluntary_swap: 'no', bid: 'bid', other: 'review', chain_open: 'unknown' }[count] ?? 'company';
    return { reason, source: 'chain' };
  }
  const by = (tag) => ctx.pairingHandledBy(plan, tag);
  if (by('lost_hours_credit') || by('cancelled_no_compensation')) return { reason: 'company', source: 'rule' };
  if (by('voluntary_swap')) return { reason: 'no', source: 'rule' };
  if (by('diversion')) return { reason: 'company', source: 'rule' }; // סטיה לשדה משנה שהונחה מהקבצים (`assumeDiversion`)
  if (by('leg_omitted')) return { reason: 'company', source: 'rule' }; // גריעת קטע אינה שינוי, והסבב בוצע (`assumeLegOmitted`)
  // גם בלי סימון, כשהחוק שמסמן אינו בתוקף בחודש: התשובה עצמה.
  const value = answer?.value;
  if (value === 'voluntary_swap') return { reason: 'no', source: 'answer' };
  if (value === 'bid') return { reason: 'bid', source: 'answer' };
  if (COMPANY_CANCEL.includes(value)) return { reason: 'company', source: 'answer' };
  if (value === 'other') return { reason: 'review', source: 'answer' };
  return { reason: 'unknown', source: 'none' };
}
