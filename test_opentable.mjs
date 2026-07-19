// Unit tests for lib/opentable.js — pure string-matching logic, no network
// calls, so no mocking needed. Run with: node test_opentable.mjs

import assert from 'node:assert';
import { findRestaurantLink, buildRestaurantUrl } from './lib/opentable.js';

// 1. No hometown at all -> null, not a fabricated link.
assert.strictEqual(findRestaurantLink({ hometown: '' }), null);
assert.strictEqual(findRestaurantLink({ hometown: null }), null);
console.log('Test 1 passed: no hometown returns null');

// 2. Known capital city -> exact metro page, matched: true.
{
  const r = findRestaurantLink({ hometown: 'Perth' });
  assert.strictEqual(r.url, 'https://www.opentable.com.au/metro/perth-restaurants');
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.cityLabel, 'Perth');
}
{
  const r = findRestaurantLink({ hometown: 'Sydney' });
  assert.strictEqual(r.url, 'https://www.opentable.com.au/metro/sydney-restaurants');
  assert.strictEqual(r.matched, true);
}
console.log('Test 2 passed: known capital cities resolve to their exact OpenTable metro page');

// 3. Case-insensitivity and trailing state text still match the city.
{
  const r = findRestaurantLink({ hometown: 'melbourne, VIC' });
  assert.strictEqual(r.url, 'https://www.opentable.com.au/metro/melbourne-restaurants');
}
console.log('Test 3 passed: matching is case-insensitive and tolerates trailing state text');

// 4. Unlisted WA mining town -> falls back to the WA state page, not the
// bare homepage — still a real, relevant page.
{
  const r = findRestaurantLink({ hometown: 'Karratha, WA' });
  assert.strictEqual(r.url, 'https://www.opentable.com.au/metro/western-australia');
  assert.strictEqual(r.matched, true);
}
console.log('Test 4 passed: unlisted WA town falls back to the Western Australia state page');

// 5. Something with no state/city match at all -> homepage, matched: false.
// Still a real, functional page (auto-detects location / lets user search).
{
  const r = findRestaurantLink({ hometown: 'Nowhereville' });
  assert.strictEqual(r.url, 'https://www.opentable.com.au');
  assert.strictEqual(r.matched, false);
}
console.log('Test 5 passed: no match falls back to the real OpenTable AU homepage');

// 6. cityLabel only takes the part before a comma.
{
  const r = findRestaurantLink({ hometown: 'Broome, WA' });
  assert.strictEqual(r.cityLabel, 'Broome');
}
console.log('Test 6 passed: cityLabel strips trailing state/country text');

// 7. buildRestaurantUrl is a no-op with no affiliate prefix, wraps when one is set.
{
  const plain = 'https://www.opentable.com.au/metro/perth-restaurants';
  assert.strictEqual(buildRestaurantUrl(plain, ''), plain);
  assert.strictEqual(buildRestaurantUrl(plain, undefined), plain);
  const wrapped = buildRestaurantUrl(plain, 'https://track.example.com/click?u=');
  assert.strictEqual(wrapped, 'https://track.example.com/click?u=' + encodeURIComponent(plain));
}
console.log('Test 7 passed: buildRestaurantUrl is a no-op without an affiliate prefix, wraps when one is set');

// 8. findRestaurantLink applies the affiliate prefix end-to-end when passed through.
{
  const r = findRestaurantLink({ hometown: 'Perth', affiliatePrefix: 'https://track.example.com/click?u=' });
  assert.strictEqual(
    r.url,
    'https://track.example.com/click?u=' + encodeURIComponent('https://www.opentable.com.au/metro/perth-restaurants')
  );
}
console.log('Test 8 passed: affiliatePrefix flows through findRestaurantLink end-to-end');

console.log('ALL opentable TESTS PASSED');
