import { buildHotelSearchUrl } from './lib/hotellook.js';
import assert from 'node:assert';

// 1. A normal, complete search produces a well-formed URL with the marker
//    and dates as query params.
const url = buildHotelSearchUrl({
  destinationName: 'Bali, Indonesia',
  checkIn: '2026-08-01',
  checkOut: '2026-08-05',
  marker: 'test123'
});
assert.ok(url.startsWith('https://search.hotellook.com/hotels?'), `should hit the Hotellook search host: ${url}`);
const parsed = new URL(url);
assert.strictEqual(parsed.searchParams.get('destination'), 'Bali, Indonesia');
assert.strictEqual(parsed.searchParams.get('checkIn'), '2026-08-01');
assert.strictEqual(parsed.searchParams.get('checkOut'), '2026-08-05');
assert.strictEqual(parsed.searchParams.get('marker'), 'test123');
assert.strictEqual(parsed.searchParams.get('adults'), '2');
console.log('Test 1 passed: builds a well-formed URL with destination/dates/marker');

// 2. Missing the essentials (destination or marker) returns null, not a
//    broken/partial link — a missing hotel link should just not render,
//    same "never fabricate, never half-work" pattern as the rest of the app.
assert.strictEqual(buildHotelSearchUrl({ destinationName: 'Bali, Indonesia', marker: '' }), null, 'no marker should return null');
assert.strictEqual(buildHotelSearchUrl({ destinationName: '', marker: 'test123' }), null, 'no destination should return null');
console.log('Test 2 passed: missing essentials returns null instead of a broken link');

// 3. adults is overridable.
const url2 = buildHotelSearchUrl({ destinationName: 'Tokyo, Japan', marker: 'm', adults: 1 });
assert.strictEqual(new URL(url2).searchParams.get('adults'), '1');
console.log('Test 3 passed: adults count is overridable');

console.log('ALL hotellook TESTS PASSED');
