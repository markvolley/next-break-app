// Unit tests for lib/yelp.js — mocks fetchImpl so no real network call
// happens. Run with: node test_yelp.mjs

import assert from 'node:assert';
import { findYelpBusinesses } from './lib/yelp.js';

function mockFetch({ ok = true, status = 200, businesses = [] } = {}) {
  return async (url, opts) => ({
    ok,
    status,
    text: async () => 'error body',
    json: async () => ({ businesses })
  });
}

function biz(name, { rating = 4.5, review_count = 100, image_url = 'https://img.example/x.jpg', url = 'https://yelp.com/biz/x', price = '$$', category = 'Italian', location } = {}) {
  return { name, rating, review_count, image_url, url, price, categories: [{ title: category, alias: category.toLowerCase() }], location };
}

// 1. No API key -> [], no fetch attempted at all.
{
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({ businesses: [] }) }; };
  const r = await findYelpBusinesses({ apiKey: '', hometown: 'Sydney', fetchImpl });
  assert.deepStrictEqual(r, []);
  assert.strictEqual(called, false);
}
console.log('Test 1 passed: no API key returns [] without attempting a fetch');

// 2. No hometown -> [].
{
  const r = await findYelpBusinesses({ apiKey: 'key123', hometown: '', fetchImpl: mockFetch({}) });
  assert.deepStrictEqual(r, []);
}
console.log('Test 2 passed: no hometown returns []');

// 3. HTTP error -> [], not a thrown exception.
{
  const r = await findYelpBusinesses({ apiKey: 'key123', hometown: 'Sydney', fetchImpl: mockFetch({ ok: false, status: 401 }) });
  assert.deepStrictEqual(r, []);
}
console.log('Test 3 passed: HTTP error returns [] rather than throwing');

// 4. Real businesses map to the expected shape.
{
  const businesses = [biz('Test Bistro', { rating: 4.5, review_count: 210, category: 'Italian' })];
  const r = await findYelpBusinesses({ apiKey: 'key123', hometown: 'Sydney', fetchImpl: mockFetch({ businesses }) });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].source, 'yelp');
  assert.strictEqual(r[0].title, 'Test Bistro');
  assert.strictEqual(r[0].rating, 4.5);
  assert.strictEqual(r[0].reviewCount, 210);
  assert.strictEqual(r[0].categoryLabel, 'Italian');
  assert.strictEqual(r[0].imageUrl, 'https://img.example/x.jpg');
  assert.strictEqual(r[0].url, 'https://yelp.com/biz/x');
  assert.strictEqual(r[0].price, '$$');
}
console.log('Test 4 passed: real businesses map to the expected card shape');

// 5. Businesses with no name are filtered out, never shown blank.
{
  const businesses = [{ name: '', rating: 5 }, biz('Real Place')];
  const r = await findYelpBusinesses({ apiKey: 'key123', hometown: 'Sydney', fetchImpl: mockFetch({ businesses }) });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].title, 'Real Place');
}
console.log('Test 5 passed: businesses with no name are filtered out');

// 6. Malformed response (no businesses array) -> [], not a throw.
{
  const fetchImpl = async () => ({ ok: true, json: async () => ({}) });
  const r = await findYelpBusinesses({ apiKey: 'key123', hometown: 'Sydney', fetchImpl });
  assert.deepStrictEqual(r, []);
}
console.log('Test 6 passed: malformed response returns [] rather than throwing');

// 7. The `categories` param is passed through to the request (so callers
// can narrow restaurants vs hotels searches).
{
  let capturedUrl;
  const fetchImpl = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({ businesses: [] }) }; };
  await findYelpBusinesses({ apiKey: 'key123', hometown: 'Sydney', categories: 'hotels,guesthouses', fetchImpl });
  assert.ok(String(capturedUrl).includes('categories=hotels%2Cguesthouses') || String(capturedUrl).includes('categories=hotels,guesthouses'));
}
console.log('Test 7 passed: categories param is passed through to the request');

// 8. Address/suburb extracted from Yelp's location object when present,
// null (never fabricated) when absent.
{
  const businesses = [
    biz('Full Address Place', { location: { address1: '10 King St', city: 'Newtown' } }),
    biz('No Location Place', { location: undefined })
  ];
  const r = await findYelpBusinesses({ apiKey: 'key123', hometown: 'Sydney', fetchImpl: mockFetch({ businesses }) });
  const full = r.find(x => x.title === 'Full Address Place');
  assert.strictEqual(full.address, '10 King St');
  assert.strictEqual(full.suburb, 'Newtown');
  const none = r.find(x => x.title === 'No Location Place');
  assert.strictEqual(none.address, null);
  assert.strictEqual(none.suburb, null);
}
console.log('Test 8 passed: address/suburb extracted from Yelp location, null when absent');

// 9. Results are sorted best-rated first, not left in whatever order Yelp
// returned them (best_match) — the whole point of "prioritise higher
// ratings" being a real, testable behaviour rather than just a request param.
{
  const businesses = [
    biz('Mid Rated', { rating: 4.0 }),
    biz('Top Rated', { rating: 4.9 }),
    biz('Low Rated', { rating: 3.2 })
  ];
  const r = await findYelpBusinesses({ apiKey: 'key123', hometown: 'Sydney', fetchImpl: mockFetch({ businesses }) });
  assert.deepStrictEqual(r.map(x => x.title), ['Top Rated', 'Mid Rated', 'Low Rated']);
}
console.log('Test 9 passed: results are sorted highest-rating-first');

// 10. Equal ratings are tie-broken by review count — a well-reviewed 4.5
// should rank above a barely-reviewed 4.5, not be a coin flip.
{
  const businesses = [
    biz('Few Reviews', { rating: 4.5, review_count: 3 }),
    biz('Many Reviews', { rating: 4.5, review_count: 500 })
  ];
  const r = await findYelpBusinesses({ apiKey: 'key123', hometown: 'Sydney', fetchImpl: mockFetch({ businesses }) });
  assert.deepStrictEqual(r.map(x => x.title), ['Many Reviews', 'Few Reviews']);
}
console.log('Test 10 passed: equal ratings tie-broken by review count (more reviews ranks higher)');

// 11. `limit` still caps the final returned count, applied AFTER sorting —
// so the top-rated ones survive the cut, not an arbitrary prefix of
// whatever Yelp happened to return first.
{
  const businesses = [
    biz('Rank 3', { rating: 4.0 }),
    biz('Rank 1', { rating: 4.9 }),
    biz('Rank 4', { rating: 3.5 }),
    biz('Rank 2', { rating: 4.6 })
  ];
  const r = await findYelpBusinesses({ apiKey: 'key123', hometown: 'Sydney', limit: 2, fetchImpl: mockFetch({ businesses }) });
  assert.deepStrictEqual(r.map(x => x.title), ['Rank 1', 'Rank 2']);
}
console.log('Test 11 passed: limit keeps the top-rated results, applied after sorting not before');

// 12. The raw Yelp request asks for more than `limit` so there's an actual
// pool to sort/prioritise from, rather than locking in Yelp's own
// best_match order by only ever requesting the final display count.
{
  let capturedUrl;
  const fetchImpl = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({ businesses: [] }) }; };
  await findYelpBusinesses({ apiKey: 'key123', hometown: 'Sydney', limit: 6, fetchImpl });
  const requestedLimit = Number(new URL(capturedUrl).searchParams.get('limit'));
  assert.ok(requestedLimit > 6, `expected a larger raw pool than the display limit, got limit=${requestedLimit}`);
}
console.log('Test 12 passed: requests a larger raw pool from Yelp than the final display limit');

console.log('ALL yelp TESTS PASSED');
