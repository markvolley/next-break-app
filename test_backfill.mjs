// Unit tests for the "never a dead end" deals backfill logic in
// lib/travelpayouts.js: buildLiveSearchUrl, pickBackfillDestinations, and
// withBackfill. Pure logic, no network, no server. Run with:
//   node test_backfill.mjs

import assert from 'node:assert';
import { buildLiveSearchUrl, pickBackfillDestinations, withBackfill, BACKFILL_MINIMUM, REAL_DESTINATIONS, fetchAllRealFares } from './lib/travelpayouts.js';

function brk(key, start, end) {
  return { key, start: new Date(start), end: new Date(end) };
}

// 1. buildLiveSearchUrl produces a real Aviasales live-search link with the
// break's own dates and the marker attached — no price involved at all.
{
  const url = buildLiveSearchUrl({ origin: 'PER', destination: 'DPS', departDate: '2026-08-01', returnDate: '2026-08-08', marker: '12345', currency: 'aud' });
  const parsed = new URL(url);
  assert.strictEqual(parsed.origin + parsed.pathname, 'https://search.aviasales.com/flights/');
  assert.strictEqual(parsed.searchParams.get('origin_iata'), 'PER');
  assert.strictEqual(parsed.searchParams.get('destination_iata'), 'DPS');
  assert.strictEqual(parsed.searchParams.get('depart_date'), '2026-08-01');
  assert.strictEqual(parsed.searchParams.get('return_date'), '2026-08-08');
  assert.strictEqual(parsed.searchParams.get('marker'), '12345');
  assert.strictEqual(parsed.searchParams.get('currency'), 'aud');
  // Regression: leaving locale off entirely doesn't fall back to English on
  // Aviasales' side -- it lands on their Russian-language default. This
  // must always be set to something, not left to chance.
  assert.strictEqual(parsed.searchParams.get('locale'), 'en-gb', 'locale must default to en-gb, not be left unset');
}
console.log('Test 1 passed: buildLiveSearchUrl builds a real dated, marked, English-locale live-search link');

// 1b. An explicit locale override is respected (e.g. a future per-user locale setting).
{
  const url = buildLiveSearchUrl({ origin: 'PER', destination: 'DPS', departDate: '2026-08-01', returnDate: '2026-08-08', locale: 'de' });
  assert.strictEqual(new URL(url).searchParams.get('locale'), 'de');
}
console.log('Test 1b passed: an explicit locale overrides the en-gb default');

// 2. buildLiveSearchUrl still works with no marker/currency supplied (both optional).
{
  const url = buildLiveSearchUrl({ origin: 'PER', destination: 'DPS', departDate: '2026-08-01', returnDate: '2026-08-08' });
  const parsed = new URL(url);
  assert.strictEqual(parsed.searchParams.has('marker'), false);
  assert.strictEqual(parsed.searchParams.has('currency'), false);
  assert.strictEqual(parsed.searchParams.get('locale'), 'en-gb', 'locale should still default even with nothing else supplied');
}
console.log('Test 2 passed: marker/currency are optional');

// 3. pickBackfillDestinations excludes anything already used as a real fare,
// and returns exactly `count` destinations when enough remain in the pool.
{
  const b = brk('test-key-1', '2026-08-01', '2026-08-08');
  const excludeIatas = new Set(['DPS', 'HKT', 'SIN']);
  const picks = pickBackfillDestinations(b, { excludeIatas, count: 3 });
  assert.strictEqual(picks.length, 3);
  for (const p of picks) assert.ok(!excludeIatas.has(p.iata), `${p.iata} should have been excluded`);
}
console.log('Test 3 passed: pickBackfillDestinations excludes already-used destinations');

// 4. pickBackfillDestinations is deterministic for the same break key (same
// seed every time) but varies between different break keys, same spirit as
// the existing pickCandidates seeded-shuffle.
{
  const b1 = brk('same-key', '2026-08-01', '2026-08-08');
  const b2 = brk('same-key', '2026-08-01', '2026-08-08');
  const b3 = brk('different-key', '2026-09-01', '2026-09-08');
  const picks1 = pickBackfillDestinations(b1, { count: 5 }).map(d => d.iata);
  const picks2 = pickBackfillDestinations(b2, { count: 5 }).map(d => d.iata);
  const picks3 = pickBackfillDestinations(b3, { count: 5 }).map(d => d.iata);
  assert.deepStrictEqual(picks1, picks2, 'same break key should pick the same destinations every time');
  assert.notDeepStrictEqual(picks1, picks3, 'a different break key should (almost certainly) pick a different order/set');
}
console.log('Test 4 passed: backfill picks are seeded/deterministic per break, vary across breaks');

// 5. withBackfill is a no-op once the real picks already meet the minimum.
{
  const b = brk('test-key-2', '2026-08-01', '2026-08-08');
  const picked = [
    { source: 'real', iata: 'MEL', domestic: true, price: 200 },
    { source: 'real', iata: 'DPS', domestic: false, price: 300 },
    { source: 'real', iata: 'TYO', domestic: false, price: 900 }
  ];
  const result = withBackfill(picked, { origin: 'PER', brk: b, marker: '999' });
  assert.strictEqual(result.length, 3);
  assert.strictEqual(result, picked, 'should return the same array reference untouched when already at minimum');
}
console.log('Test 5 passed: withBackfill does nothing once the minimum is already met');

// 6. withBackfill tops up a short list to BACKFILL_MINIMUM with no-price
// search-only cards, each carrying a live-search bookUrl built from the
// break's real dates -- never an off-date, never a fabricated price.
{
  const b = brk('test-key-3', '2026-08-01', '2026-08-08');
  const picked = [{ source: 'real', iata: 'MEL', domestic: true, price: 200 }];
  const result = withBackfill(picked, { origin: 'PER', brk: b, marker: 'MK1', currency: 'AUD' });
  assert.strictEqual(result.length, BACKFILL_MINIMUM);
  assert.strictEqual(result[0].iata, 'MEL', 'the real fare should stay first, untouched');

  const backfilled = result.slice(1);
  assert.strictEqual(backfilled.length, BACKFILL_MINIMUM - 1);
  for (const d of backfilled) {
    assert.strictEqual(d.source, 'search-only');
    assert.strictEqual(d.price, null, 'a backfill card must never show a price');
    assert.strictEqual(d.departureAt, null);
    assert.strictEqual(d.returnAt, null);
    assert.notStrictEqual(d.iata, 'MEL', 'must not repeat the destination already used for a real fare');
    assert.ok(d.bookUrl.includes('search.aviasales.com'), 'must link to a live search, not a specific booked fare');
    assert.ok(d.bookUrl.includes('depart_date=2026-08-01'), "must use the break's real start date");
    assert.ok(d.bookUrl.includes('return_date=2026-08-08'), "must use the break's real end date");
    assert.ok(d.bookUrl.includes('marker=MK1'));
  }
}
console.log('Test 6 passed: withBackfill tops up to the minimum with dated, marked, no-price live-search cards');

// 7. withBackfill never fabricates more destinations than actually exist in
// the curated pool (defensive, not expected to bite in practice given the
// pool size, but should degrade gracefully rather than throw or pad).
{
  const b = brk('test-key-4', '2026-08-01', '2026-08-08');
  const hugeMinimum = REAL_DESTINATIONS.length + 50;
  const result = withBackfill([], { origin: 'PER', brk: b, marker: 'MK2', minimum: hugeMinimum });
  assert.ok(result.length <= REAL_DESTINATIONS.length, 'should never exceed the size of the real destination pool');
  const iatas = result.map(d => d.iata);
  assert.strictEqual(new Set(iatas).size, iatas.length, 'no destination should repeat even when asked for more than exist');
}
console.log('Test 7 passed: withBackfill degrades gracefully when asked for more than the pool has');

// 8. withBackfill is a no-op (returns picked unchanged) when origin or brk
// is missing, rather than throwing -- keeps buildDealsForBreak's other
// early-return paths (not-configured) safe if ever routed through here.
{
  const b = brk('test-key-5', '2026-08-01', '2026-08-08');
  const picked = [{ source: 'real', iata: 'MEL', domestic: true, price: 200 }];
  assert.strictEqual(withBackfill(picked, { origin: null, brk: b }), picked);
  assert.strictEqual(withBackfill(picked, { origin: 'PER', brk: null }), picked);
}
console.log('Test 8 passed: withBackfill is a safe no-op without origin/brk');

// 9. Regression: fetchAllRealFares must request an English locale from the
// Travelpayouts Data API itself, not just the live-search deep link above
// -- the `link` field it returns for a real, bookable fare (see
// buildBookingUrl) otherwise defaults to Aviasales' Russian-language site,
// which is exactly the "Check flights opened in Russian" bug this guards
// against for the "Book this fare" button too, not only the backfill one.
{
  const b = brk('locale-check', '2026-08-01', '2026-08-08');
  const seenUrls = [];
  const fakeFetch = async (url) => {
    seenUrls.push(url.toString());
    return { ok: true, json: async () => ({ success: true, data: [] }) };
  };
  await fetchAllRealFares({ token: 'fake-token', marker: 'MK', origin: 'PER', currency: 'aud', brk: b, batchSize: 2, fetchImpl: fakeFetch });
  assert.ok(seenUrls.length > 0, 'the fake fetch should have been called at least once');
  for (const u of seenUrls) {
    const params = new URL(u).searchParams;
    assert.strictEqual(params.get('locale'), 'en-gb', `every Travelpayouts request must set locale=en-gb, saw: ${u}`);
  }
}
console.log('Test 9 passed: fetchAllRealFares requests an English locale so real-fare booking links are English too');

console.log('ALL BACKFILL TESTS PASSED');
