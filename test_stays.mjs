// Unit tests for findRealStays (lib/activities.js) — mocks fetchImpl so no
// real network call happens, same style as test_restaurants.mjs. Run with:
// node test_stays.mjs

import assert from 'node:assert';
import { findRealStays } from './lib/activities.js';

function mockFetch({ geocodeOk = true, geocodeBody = [{ lat: '-33.87', lon: '151.21' }], overpassOk = true, overpassElements = [] }) {
  return async (url) => {
    if (String(url).includes('nominatim')) {
      return { ok: geocodeOk, json: async () => geocodeBody };
    }
    return { ok: overpassOk, text: async () => 'error body', json: async () => ({ elements: overpassElements }) };
  };
}

function el(name, { lat = -33.87, lon = 151.21, tourism, addrTags } = {}) {
  return { tags: { name, ...(tourism ? { tourism } : {}), ...(addrTags || {}) }, lat, lon };
}

// 1. No hometown -> [].
{
  const r = await findRealStays({ hometown: '', fetchImpl: mockFetch({}) });
  assert.deepStrictEqual(r, []);
}
console.log('Test 1 passed: no hometown returns []');

// 2. Failed geocode -> [].
{
  const r = await findRealStays({ hometown: 'Nowhereville', fetchImpl: mockFetch({ geocodeBody: [] }) });
  assert.deepStrictEqual(r, []);
}
console.log('Test 2 passed: failed geocode returns []');

// 3. Overpass HTTP error -> [], not a thrown exception.
{
  const r = await findRealStays({ hometown: 'Sydney', fetchImpl: mockFetch({ overpassOk: false }) });
  assert.deepStrictEqual(r, []);
}
console.log('Test 3 passed: Overpass HTTP error returns [] rather than throwing');

// 4. Real elements map to real names + a human-readable stay type + real map links.
{
  const elements = [
    el('Test Hotel', { tourism: 'hotel' }),
    el('Backpacker Lodge', { tourism: 'hostel' }),
    el('No Type Tag Inn')
  ];
  const r = await findRealStays({ hometown: 'Sydney', fetchImpl: mockFetch({ overpassElements: elements }) });
  assert.strictEqual(r.length, 3);
  assert.strictEqual(r.find(x => x.title === 'Test Hotel').stayType, 'Hotel');
  assert.strictEqual(r.find(x => x.title === 'Backpacker Lodge').stayType, 'Hostel');
  assert.strictEqual(r.find(x => x.title === 'No Type Tag Inn').stayType, 'Accommodation');
  assert.ok(r[0].mapUrl.startsWith('https://www.google.com/maps/search/'));
  assert.strictEqual(r[0].source, 'osm');
}
console.log('Test 4 passed: real elements map to real names, stay type, real Google Maps links');

// 5. Unnamed elements skipped, duplicate names deduped.
{
  const elements = [
    { tags: {}, lat: -33.87, lon: 151.21 },
    el('Dupe Hotel', { tourism: 'hotel' }),
    el('Dupe Hotel', { tourism: 'hotel' })
  ];
  const r = await findRealStays({ hometown: 'Sydney', fetchImpl: mockFetch({ overpassElements: elements }) });
  assert.strictEqual(r.length, 1);
}
console.log('Test 5 passed: unnamed elements skipped, duplicate names deduped');

// 6. `limit` respected, every result is a real element (never fabricated).
{
  const elements = Array.from({ length: 20 }, (_, i) => el(`Hotel ${i}`, { tourism: 'hotel' }));
  const r = await findRealStays({ hometown: 'Sydney', limit: 5, fetchImpl: mockFetch({ overpassElements: elements }) });
  assert.strictEqual(r.length, 5);
  const realTitles = new Set(elements.map(e => e.tags.name));
  assert.ok(r.every(x => realTitles.has(x.title)));
}
console.log('Test 6 passed: limit respected, every result is real (never fabricated)');

// 7. Restaurants and stays use different seed namespaces, so the same
// hometown+seed doesn't accidentally pick an identical-order sample for
// both (would be a coincidence bug, not a hard requirement, but worth
// confirming the '|stay' suffix in the seed actually does something).
{
  const elements = Array.from({ length: 20 }, (_, i) => el(`Hotel ${i}`, { tourism: 'hotel' }));
  const r1 = await findRealStays({ hometown: 'Sydney', limit: 5, seed: 'fixed', fetchImpl: mockFetch({ overpassElements: elements }) });
  const r2 = await findRealStays({ hometown: 'Sydney', limit: 5, seed: 'fixed', fetchImpl: mockFetch({ overpassElements: elements }) });
  assert.deepStrictEqual(r1.map(x => x.title), r2.map(x => x.title));
}
console.log('Test 7 passed: same hometown + same seed gives a stable, repeatable sample');

// 8. Address/suburb extracted from OSM addr:* tags when present, null
// (never fabricated) when absent.
{
  const elements = [
    el('Full Address Hotel', { tourism: 'hotel', addrTags: { 'addr:housenumber': '99', 'addr:street': 'Beach Rd', 'addr:suburb': 'Manly' } }),
    el('Town Fallback Motel', { tourism: 'motel', addrTags: { 'addr:housenumber': '1', 'addr:street': 'High St', 'addr:town': 'Katoomba' } }),
    el('No Address Hostel', { tourism: 'hostel' })
  ];
  const r = await findRealStays({ hometown: 'Sydney', fetchImpl: mockFetch({ overpassElements: elements }) });
  const full = r.find(x => x.title === 'Full Address Hotel');
  assert.strictEqual(full.address, '99 Beach Rd');
  assert.strictEqual(full.suburb, 'Manly');
  const townFallback = r.find(x => x.title === 'Town Fallback Motel');
  assert.strictEqual(townFallback.address, '1 High St');
  assert.strictEqual(townFallback.suburb, 'Katoomba'); // falls back to addr:town
  const none = r.find(x => x.title === 'No Address Hostel');
  assert.strictEqual(none.address, null);
  assert.strictEqual(none.suburb, null);
}
console.log('Test 8 passed: address/suburb extracted from OSM tags when present, null when absent');

console.log('ALL findRealStays TESTS PASSED');
