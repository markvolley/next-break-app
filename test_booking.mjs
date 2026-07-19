// Unit tests for lib/booking.js — pure URL-building logic, no network
// calls. Run with: node test_booking.mjs

import assert from 'node:assert';
import { findStayLink, buildStayUrl } from './lib/booking.js';

// 1. No hometown -> null, never a fabricated link.
assert.strictEqual(findStayLink({ hometown: '' }), null);
assert.strictEqual(findStayLink({ hometown: null }), null);
console.log('Test 1 passed: no hometown returns null');

// 2. Any hometown resolves to a real, working search URL — no curated
// city list needed (unlike OpenTable).
{
  const r = findStayLink({ hometown: 'Karratha, WA' });
  const url = new URL(r.url);
  assert.strictEqual(url.origin + url.pathname, 'https://www.booking.com/searchresults.html');
  assert.strictEqual(url.searchParams.get('ss'), 'Karratha, WA');
  assert.strictEqual(r.cityLabel, 'Karratha');
  assert.strictEqual(r.datesApplied, false);
}
console.log('Test 2 passed: any hometown (even one with no dedicated city page) resolves to a real search URL');

// 3. checkin/checkout dates get applied when a break is passed through.
{
  const r = findStayLink({ hometown: 'Perth', checkin: '2026-08-06', checkout: '2026-08-12' });
  const url = new URL(r.url);
  assert.strictEqual(url.searchParams.get('checkin'), '2026-08-06');
  assert.strictEqual(url.searchParams.get('checkout'), '2026-08-12');
  assert.strictEqual(r.datesApplied, true);
}
console.log('Test 3 passed: break dates are applied to the search when provided');

// 4. Missing dates are simply omitted, not fabricated as blank/zero values.
{
  const r = findStayLink({ hometown: 'Perth' });
  const url = new URL(r.url);
  assert.strictEqual(url.searchParams.has('checkin'), false);
  assert.strictEqual(url.searchParams.has('checkout'), false);
}
console.log('Test 4 passed: missing dates are omitted rather than fabricated');

// 5. buildStayUrl is a no-op with no affiliate prefix, wraps when one is set.
{
  const plain = 'https://www.booking.com/searchresults.html?ss=Perth';
  assert.strictEqual(buildStayUrl(plain, ''), plain);
  const wrapped = buildStayUrl(plain, 'https://track.example.com/click?u=');
  assert.strictEqual(wrapped, 'https://track.example.com/click?u=' + encodeURIComponent(plain));
}
console.log('Test 5 passed: buildStayUrl is a no-op without an affiliate prefix, wraps when one is set');

console.log('ALL booking TESTS PASSED');
