// Unit tests for the pure break-reminder digest logic in lib/digest.js —
// no server, no store, no network, just the "should this break get an
// email right now" decision. Run with: node test_digest.mjs

import assert from 'node:assert';
import { pickEligibleBreak, digestDaysPhrase, DIGEST_MIN_DAYS, DIGEST_MAX_DAYS } from './lib/digest.js';

function brk(key, daysUntil) {
  return { key, daysUntil };
}

// Test 1: a break right in the middle of the window is picked.
{
  const result = pickEligibleBreak([brk('a', 6)], () => false);
  assert.strictEqual(result?.key, 'a', 'a break 6 days out should be eligible');
}
console.log('Test 1 passed: a break in the middle of the window is picked');

// Test 2: the exact boundary days (5 and 7) are both inclusive.
{
  assert.strictEqual(pickEligibleBreak([brk('min', DIGEST_MIN_DAYS)], () => false)?.key, 'min', 'the minimum boundary day should be eligible');
  assert.strictEqual(pickEligibleBreak([brk('max', DIGEST_MAX_DAYS)], () => false)?.key, 'max', 'the maximum boundary day should be eligible');
}
console.log('Test 2 passed: window boundaries (5 and 7 days) are inclusive');

// Test 3: just outside the window on either side is not picked.
{
  assert.strictEqual(pickEligibleBreak([brk('tooSoon', DIGEST_MIN_DAYS - 1)], () => false), null, 'a break 4 days out should not be eligible yet');
  assert.strictEqual(pickEligibleBreak([brk('tooFar', DIGEST_MAX_DAYS + 1)], () => false), null, 'a break 8 days out should not be eligible yet');
}
console.log('Test 3 passed: breaks just outside the window are rejected');

// Test 4: already-sent breaks are skipped, even if otherwise eligible —
// this is the actual "don't spam" mechanism, not the window itself.
{
  const result = pickEligibleBreak([brk('sent', 6)], key => key === 'sent');
  assert.strictEqual(result, null, 'a break that already got a digest should not be picked again');
}
console.log('Test 4 passed: already-sent breaks are never re-picked');

// Test 5: only the very next break is ever considered, even if a later
// break in the list would otherwise qualify.
{
  const breaks = [brk('next', 20), brk('later', 6)];
  const result = pickEligibleBreak(breaks, () => false);
  assert.strictEqual(result, null, 'a later break being in-window should not matter if the next break is not');
}
console.log('Test 5 passed: only the soonest break is ever considered');

// Test 6: empty/missing input is handled without throwing.
{
  assert.strictEqual(pickEligibleBreak([], () => false), null);
  assert.strictEqual(pickEligibleBreak(null, () => false), null);
  assert.strictEqual(pickEligibleBreak([{ key: 'no-days' }], () => false), null, 'a break with no daysUntil should not be eligible');
}
console.log('Test 6 passed: empty/malformed input handled gracefully');

// Test 7: phrasing helper.
{
  assert.strictEqual(digestDaysPhrase(0), 'starts today');
  assert.strictEqual(digestDaysPhrase(1), 'starts tomorrow');
  assert.strictEqual(digestDaysPhrase(6), 'starts in 6 days');
}
console.log('Test 7 passed: digestDaysPhrase reads naturally at each boundary');

console.log('ALL DIGEST LOGIC TESTS PASSED');
