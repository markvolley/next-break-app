// Unit tests for computePastBreaks (lib/deals.js). Run with:
// node test_past_breaks.mjs

import assert from 'node:assert';
import { computePastBreaks, toISO, addDays } from './lib/deals.js';

function isoDaysAgo(n) {
  return toISO(addDays(new Date(), -n));
}
function isoDaysAhead(n) {
  return toISO(addDays(new Date(), n));
}

// 1. Manual mode: only breaks that have actually ended show up, most
// recent first, future/ongoing ones excluded.
{
  const settings = {
    rosterMode: 'manual',
    manualBreaks: [
      { id: '1', start: isoDaysAgo(30), end: isoDaysAgo(25) }, // past
      { id: '2', start: isoDaysAgo(10), end: isoDaysAgo(5) },  // past, more recent
      { id: '3', start: isoDaysAhead(5), end: isoDaysAhead(10) } // future, excluded
    ]
  };
  const r = computePastBreaks(settings);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].key, `${isoDaysAgo(10)}_${isoDaysAgo(5)}`); // most recent first
  assert.strictEqual(r[1].key, `${isoDaysAgo(30)}_${isoDaysAgo(25)}`);
}
console.log('Test 1 passed: manual mode returns only ended breaks, most-recent-first');

// 2. Manual mode with nothing past yet -> [].
{
  const settings = { rosterMode: 'manual', manualBreaks: [{ id: '1', start: isoDaysAhead(5), end: isoDaysAhead(10) }] };
  assert.deepStrictEqual(computePastBreaks(settings), []);
}
console.log('Test 2 passed: manual mode with only future breaks returns []');

// 3. Pattern mode: a roster with a next-break-start far in the future has
// no genuine past breaks to report yet — never fabricated.
{
  const settings = { rosterMode: 'pattern', pattern: { daysOn: 14, daysOff: 7, nextBreakStart: isoDaysAhead(20) } };
  assert.deepStrictEqual(computePastBreaks(settings), []);
}
console.log('Test 3 passed: pattern mode with a future anchor returns [] (nothing to report yet)');

// 4. Pattern mode: an anchor set up a while ago yields real past breaks,
// each cycleLen apart, most-recent-first, and all genuinely in the past.
{
  // Anchor far enough back that several cycles have already completed.
  const cycleLen = 21; // 14 on + 7 off
  const anchor = addDays(new Date(), -(cycleLen * 4)); // 4 cycles ago
  const settings = { rosterMode: 'pattern', pattern: { daysOn: 14, daysOff: 7, nextBreakStart: toISO(anchor) } };
  const r = computePastBreaks(settings, { limit: 6 });
  assert.ok(r.length >= 2, 'expected at least a couple of past breaks');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const b of r) assert.ok(b.end < today, 'every returned break must have actually ended');
  // Most-recent-first: each break's start should be later than the next one's.
  for (let i = 0; i < r.length - 1; i++) assert.ok(r[i].start > r[i + 1].start);
}
console.log('Test 4 passed: pattern mode returns real, ended breaks, most-recent-first');

// 5. `limit` is respected.
{
  const cycleLen = 21;
  const anchor = addDays(new Date(), -(cycleLen * 10));
  const settings = { rosterMode: 'pattern', pattern: { daysOn: 14, daysOff: 7, nextBreakStart: toISO(anchor) } };
  const r = computePastBreaks(settings, { limit: 3 });
  assert.ok(r.length <= 3);
}
console.log('Test 5 passed: limit is respected');

// 6. No roster configured at all -> [], not a throw.
{
  assert.deepStrictEqual(computePastBreaks({ rosterMode: 'pattern', pattern: {} }), []);
  assert.deepStrictEqual(computePastBreaks({}), []);
}
console.log('Test 6 passed: unconfigured roster returns [] rather than throwing');

console.log('ALL computePastBreaks TESTS PASSED');
