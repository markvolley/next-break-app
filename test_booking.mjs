import { buildBookingSearchUrl } from './lib/booking.js';
import assert from 'node:assert';

// 1. A normal, complete search produces a well-formed Booking.com URL with
//    the aid, label and dates as query params.
const url = buildBookingSearchUrl({
  destinationName: 'Bali, Indonesia',
  checkIn: '2026-08-01',
  checkOut: '2026-08-05',
  aid: 'test123',
  label: 'nextbreak'
});
assert.ok(url.startsWith('https://www.booking.com/searchresults.html?'), `should hit the real Booking.com search host: ${url}`);
const parsed = new URL(url);
assert.strictEqual(parsed.searchParams.get('ss'), 'Bali, Indonesia');
assert.strictEqual(parsed.searchParams.get('checkin'), '2026-08-01');
assert.strictEqual(parsed.searchParams.get('checkout'), '2026-08-05');
assert.strictEqual(parsed.searchParams.get('aid'), 'test123');
assert.strictEqual(parsed.searchParams.get('label'), 'nextbreak');
assert.strictEqual(parsed.searchParams.get('group_adults'), '2');
console.log('Test 1 passed: builds a well-formed Booking.com URL with destination/dates/aid/label');

// 2. Missing the essentials (destination or aid) returns null, not a
//    broken/unattributed link.
assert.strictEqual(buildBookingSearchUrl({ destinationName: 'Bali, Indonesia', aid: '' }), null, 'no aid should return null');
assert.strictEqual(buildBookingSearchUrl({ destinationName: '', aid: 'test123' }), null, 'no destination should return null');
console.log('Test 2 passed: missing essentials returns null instead of an unattributed link');

// 3. label is optional — a link without one should still be well-formed
//    (just without a label param).
const url2 = buildBookingSearchUrl({ destinationName: 'Tokyo, Japan', aid: 'm' });
assert.strictEqual(new URL(url2).searchParams.has('label'), false, 'label should be omitted, not sent as empty string');
console.log('Test 3 passed: label is optional and omitted (not empty) when not provided');

console.log('ALL booking TESTS PASSED');
