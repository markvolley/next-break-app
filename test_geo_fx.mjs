import { haversineKm, routeContext, ORIGIN_AIRPORT_GEO, DEST_UTC_OFFSET } from './lib/geo.js';
import { fetchExchangeRates, DEST_CURRENCY_BY_IATA, DEST_CURRENCY_SYMBOLS } from './lib/fx.js';
import { REAL_DESTINATIONS } from './lib/travelpayouts.js';
import { DESTINATION_COORDS } from './lib/weather.js';
import assert from 'node:assert';

// 1. Every curated destination has a timezone offset and weather
//    coordinates — a silent gap here would mean a new destination added to
//    REAL_DESTINATIONS quietly loses trip-facts/weather with no error.
for (const dest of REAL_DESTINATIONS) {
  assert.ok(dest.iata in DEST_UTC_OFFSET, `${dest.iata} missing from DEST_UTC_OFFSET`);
  assert.ok(dest.iata in DESTINATION_COORDS, `${dest.iata} missing from DESTINATION_COORDS`);
}
console.log('Test 1 passed: every REAL_DESTINATIONS entry has a timezone offset + coordinates');

// 2. Every international (non-domestic) destination has an FX currency +
//    symbol mapping — domestic ones deliberately don't need one.
for (const dest of REAL_DESTINATIONS.filter(d => !d.domestic)) {
  const currency = DEST_CURRENCY_BY_IATA[dest.iata];
  assert.ok(currency, `${dest.iata} (international) missing from DEST_CURRENCY_BY_IATA`);
  assert.ok(currency in DEST_CURRENCY_SYMBOLS, `${currency} missing a display symbol in DEST_CURRENCY_SYMBOLS`);
}
console.log('Test 2 passed: every international destination has an FX currency + symbol');

// 3. haversineKm sanity check against a known real-world distance:
//    Perth to Sydney is ~3300km great-circle.
const perSydKm = haversineKm(ORIGIN_AIRPORT_GEO.PER, DESTINATION_COORDS.SYD);
assert.ok(perSydKm > 3000 && perSydKm < 3400, `Perth->Sydney distance out of expected range: ${perSydKm}km`);
console.log(`Test 3 passed: Perth->Sydney haversine distance is plausible (${perSydKm}km)`);

// 4. routeContext returns real numbers for a known route, and null (not a
//    guess/zero) when either side is unrecognised.
const ctx = routeContext('PER', 'DPS'); // Perth -> Bali
assert.ok(ctx.distanceKm > 2500 && ctx.distanceKm < 3200, `Perth->Bali distance out of expected range: ${ctx.distanceKm}km`);
assert.strictEqual(ctx.tzDiffHours, 0, 'Perth (UTC+8) and Bali (UTC+8) should show 0h diff');
const unknownOrigin = routeContext('ZZZ', 'DPS');
assert.strictEqual(unknownOrigin.distanceKm, null, 'unknown origin airport should return null distance, not a guess');
assert.strictEqual(unknownOrigin.tzDiffHours, null, 'unknown origin airport should return null tz diff, not a guess');
console.log('Test 4 passed: routeContext gives plausible numbers for known routes, null for unknown ones');

// 5. Timezone diff direction: Tokyo (UTC+9) from Perth (UTC+8) should be
//    +1h ahead, not -1h.
const perTyo = routeContext('PER', 'TYO');
assert.strictEqual(perTyo.tzDiffHours, 1, `Perth->Tokyo should be +1h ahead: got ${perTyo.tzDiffHours}`);
console.log('Test 5 passed: timezone diff sign is correct (destination ahead of origin is positive)');

// 6. fetchExchangeRates: mocked success response is parsed correctly, and
//    failures (bad HTTP status, malformed body) return null rather than
//    throwing or returning a guessed rate.
const okRates = await fetchExchangeRates({
  base: 'AUD',
  fetchImpl: async () => ({ ok: true, json: async () => ({ result: 'success', rates: { NZD: 1.2, USD: 0.7 } }) })
});
assert.deepStrictEqual(okRates, { NZD: 1.2, USD: 0.7 }, 'should parse a successful response into the rates object');

const httpFail = await fetchExchangeRates({
  base: 'AUD',
  fetchImpl: async () => ({ ok: false, text: async () => 'server error' })
});
assert.strictEqual(httpFail, null, 'non-ok HTTP response should return null, not throw');

const badBody = await fetchExchangeRates({
  base: 'AUD',
  fetchImpl: async () => ({ ok: true, json: async () => ({ result: 'error' }) })
});
assert.strictEqual(badBody, null, 'a non-success API result should return null, not a guessed rate');
console.log('Test 6 passed: fetchExchangeRates parses success, fails safe on HTTP/API errors');

console.log('ALL geo + fx TESTS PASSED');
