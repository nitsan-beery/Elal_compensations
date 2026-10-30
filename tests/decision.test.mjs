// ההחלטה על סבב מתוכנן (טיוטה 439): כל ענף, בנפרד מהחוקים שקוראים אותה.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pairingDecision } from '../js/rules/decision.js';

const decide = (match, { answer = null, tags = [] } = {}) => pairingDecision({ answerFor: () => answer, pairingHandledBy: (_, tag) => tags.includes(tag) }, { plan: { id: 'p' }, ...match });
const reason = (...a) => decide(...a).reason;

test('בלי התאמה: לא ידוע', () => {
  assert.deepEqual(pairingDecision({}, null), { reason: 'unknown', source: 'none' });
});

test('היעדרות אינה ביוזמת החברה, גם כשיש תשובה', () => {
  assert.deepEqual(decide({ byLeave: true }, { answer: { value: 'replaced' } }), { reason: 'no', source: 'leave' });
});

test('סבב שהתארך בהסכמה: מה שתוכנן בימיו אינו ביוזמת החברה', () => {
  const ctx = (value) => ({ answer: () => ({ value }) });
  const match = { how: 'carried_over', carriedBy: { id: 'x' } };
  assert.equal(pairingDecision(ctx('agreed'), match).reason, 'no');
  assert.equal(pairingDecision(ctx('company'), match).reason, 'company');
});

test('הוחלף בפעילות קרקע או בכוננות: ביוזמת החברה', () => {
  assert.equal(reason({ how: 'replaced_by_ground' }), 'company');
  assert.equal(reason({ how: 'replaced_by_standby' }), 'company');
});

test('הצוות עוד היה בחו"ל בסבב מהחודש הקודם: ביוזמת החברה', () => {
  assert.deepEqual(decide({ how: 'carried_over' }), { reason: 'company', source: 'stay' });
});

test('שרשרת מהיומן: השלב הראשון קובע, גם מול התשובה', () => {
  for (const [count, want] of [['voluntary_swap', 'no'], ['bid', 'bid'], ['other', 'review'], ['chain_open', 'unknown'], ['replaced', 'company']]) {
    assert.deepEqual(decide({}, { answer: { value: 'cancelled', count } }), { reason: want, source: 'chain' });
  }
});

test('סימון של חוק גובר על התשובה', () => {
  assert.equal(reason({}, { tags: ['lost_hours_credit'], answer: { value: 'voluntary_swap' } }), 'company');
  assert.equal(reason({}, { tags: ['cancelled_no_compensation'] }), 'company');
  assert.equal(reason({}, { tags: ['voluntary_swap'] }), 'no');
  assert.equal(reason({}, { tags: ['diversion'] }), 'company');
});

test('תשובה בלי סימון', () => {
  for (const [value, want] of [['voluntary_swap', 'no'], ['bid', 'bid'], ['cancelled', 'company'], ['wet_lease', 'company'], ['trainee', 'company'], ['swap_777', 'company'], ['replaced', 'company'], ['diversion', 'company'], ['other', 'review']]) {
    assert.deepEqual(decide({}, { answer: { value } }), { reason: want, source: 'answer' });
  }
});

test('בלי תשובה ובלי סימון: השאלה עוד פתוחה', () => {
  assert.deepEqual(decide({}), { reason: 'unknown', source: 'none' });
});
