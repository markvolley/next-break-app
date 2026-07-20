// Unit tests for findRealRestaurants (lib/activities.js) — mocks fetchImpl
// so no real network call happens; exercises the geocode -> Overpass ->
// dedupe/shuffle/slice pipeline the same way findFreeActivities already
// works for parks/beaches. Run with: node test_restaurants.mjs

import assert from 'node:assert';
import { findRealRestaurants } from './lib/activities.js';

function mockFetch({ geocodeOk = true, geocodeBody = [{ lat: '-33.87', lon: '151.21' }], overpassOk = true, overpassElements = [] }) {
  let call = 0;
  return async (url) => {
    call++;
    if (String(url).includes('nominatim')) {
      return {
        ok: geocodeOk,
        json: async () => geocodeBody
      };
    }
    // Overpass
    return {
      ok: overpassOk,
      text: async () => 'error body',
      json: async () => ({ elements: overpassElements })
    };
  };
}

function el(name, { lat = -33.87, lon = 151.21, cuisine, addrTags } = {}) {
  return { tags: { name, ...(cuisine ? { cuisine } : {}), ...(addrTags || {}) }, lat, lon };
}

// 1. No hometown at all — geocodeHometown returns null immediately, no
// Overpass call needed, result is [].
{
  const r = await findRealRestaurants({ hometown: '', fetchImpl: mockFetch({}) });
  assert.deepStrictEqual(r, []);
}
console.log('Test 1 passed: no hometown returns []');

// 2. Geocoding fails (no results) -> [].
{
  const fetchImpl = mockFetch({ geocodeBody: [] });
  const r = await findRealRestaurants({ hometown: 'Nowhereville', fetchImpl });
  assert.deepStrictEqual(r, []);
}
console.log('Test 2 passed: failed geocode returns []');

// 3. Overpass HTTP error -> [], not a thrown exception.
{
  const fetchImpl = mockFetch({ overpassOk: false });
  const r = await findRealRestaurants({ hometown: 'Sydney', fetchImpl });
  assert.deepStrictEqual(r, []);
}
console.log('Test 3 passed: Overpass HTTP error returns [] rather than throwing');

// 4. Real elements come back -> real names, cuisine formatted, real map links.
{
  const elements = [
    el('Test Bistro', { cuisine: 'modern_australian' }),
    el('Noodle House', { cuisine: 'chinese;asian' }),
    el('No Cuisine Tag Cafe')
  ];
  const fetchImpl = mockFetch({ overpassElements: elements });
  const r = await findRealRestaurants({ hometown: 'Sydney', fetchImpl });
  assert.strictEqual(r.length, 3);
  const bistro = r.find(x => x.title === 'Test Bistro');
  assert.strictEqual(bistro.cuisine, 'Modern australian');
  const noodle = r.find(x => x.title === 'Noodle House');
  assert.strictEqual(noodle.cuisine, 'Chinese'); // first cuisine value only
  const cafe = r.find(x => x.title === 'No Cuisine Tag Cafe');
  assert.strictEqual(cafe.cuisine, null);
  assert.ok(bistro.mapUrl.startsWith('https://www.google.com/maps/search/'));
  assert.strictEqual(bistro.source, 'osm');
}
console.log('Test 4 passed: real elements map to real names, formatted cuisine, real Google Maps links');

// 5. Unnamed elements are skipped (not worth showing), duplicates by name
// are deduped.
{
  const elements = [
    { tags: {}, lat: -33.87, lon: 151.21 }, // no name at all
    el('Dupe Restaurant'),
    el('Dupe Restaurant') // same name again
  ];
  const fetchImpl = mockFetch({ overpassElements: elements });
  const r = await findRealRestaurants({ hometown: 'Sydney', fetchImpl });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].title, 'Dupe Restaurant');
}
console.log('Test 5 passed: unnamed elements skipped, duplicate names deduped');

// 6. `limit` is respected even when more real results are available.
{
  const elements = Array.from({ length: 20 }, (_, i) => el(`Restaurant ${i}`));
  const fetchImpl = mockFetch({ overpassElements: elements });
  const r = await findRealRestaurants({ hometown: 'Sydney', limit: 5, fetchImpl });
  assert.strictEqual(r.length, 5);
  // Every returned title must be one of the real 20 — never fabricated.
  const realTitles = new Set(elements.map(e => e.tags.name));
  assert.ok(r.every(x => realTitles.has(x.title)));
}
console.log('Test 6 passed: limit is respected, and every result is a real element (never fabricated)');

// 7. Same hometown + same seed -> same sample (deterministic, not
// re-randomized on every call).
{
  const elements = Array.from({ length: 20 }, (_, i) => el(`Restaurant ${i}`));
  const r1 = await findRealRestaurants({ hometown: 'Sydney', limit: 5, seed: 'fixed', fetchImpl: mockFetch({ overpassElements: elements }) });
  const r2 = await findRealRestaurants({ hometown: 'Sydney', limit: 5, seed: 'fixed', fetchImpl: mockFetch({ overpassElements: elements }) });
  assert.deepStrictEqual(r1.map(x => x.title), r2.map(x => x.title));
}
console.log('Test 7 passed: same hometown + same seed gives a stable, repeatable sample');

// 8. Address/suburb are extracted from OSM addr:* tags when present, and
// stay null (never fabricated) when the source data doesn't have them.
{
  const elements = [
    el('Full Address Bistro', { addrTags: { 'addr:housenumber': '12', 'addr:street': 'Example St', 'addr:suburb': 'Bondi' } }),
    el('City Fallback Cafe', { addrTags: { 'addr:housenumber': '5', 'addr:street': 'Main Rd', 'addr:city': 'Newtown' } }),
    el('No Address Diner')
  ];
  const fetchImpl = mockFetch({ overpassElements: elements });
  const r = await findRealRestaurants({ hometown: 'Sydney', fetchImpl });
  const full = r.find(x => x.title === 'Full Address Bistro');
  assert.strictEqual(full.address, '12 Example St');
  assert.strictEqual(full.suburb, 'Bondi');
  const cityFallback = r.find(x => x.title === 'City Fallback Cafe');
  assert.strictEqual(cityFallback.address, '5 Main Rd');
  assert.strictEqual(cityFallback.suburb, 'Newtown'); // falls back to addr:city
  const none = r.find(x => x.title === 'No Address Diner');
  assert.strictEqual(none.address, null);
  assert.strictEqual(none.suburb, null);
}
console.log('Test 8 passed: address/suburb extracted from OSM tags when present, null when absent');

console.log('ALL findRealRestaurants TESTS PASSED');
