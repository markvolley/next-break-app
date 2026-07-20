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

console.log('ALL yelp TESTS PASSED');
