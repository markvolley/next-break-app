import { selectDeals } from './lib/travelpayouts.js';
import assert from 'node:assert';

function fare(iata, domestic, region, price) {
  return { source: 'real', name: iata, iata, blurb: '', domestic, region, tags: [], price, currency: 'AUD', airline: 'XX', flightNumber: '1', departureAt: '2026-07-20T08:00:00', returnAt: '2026-07-25T08:00:00', transfers: 0, nights: 5, isQuickTrip: false, bookUrl: null };
}

// 1. Only domestic fares exist (no SEA, no other-intl) -- should backfill
//    with MORE domestic fares up to the limit instead of returning just 1.
const onlyDomestic = [
  fare('MEL', true, null, 200), fare('SYD', true, null, 250), fare('OOL', true, null, 180),
  fare('ADL', true, null, 300), fare('CNS', true, null, 220),
];
let result = selectDeals(onlyDomestic, { limit: 6 });
assert.strictEqual(result.length, 5, 'should return all 5 available domestic fares (capped by availability, not the old 1-per-bucket rule): got ' + result.length);
assert.ok(result.every(d => d.domestic), 'all should be domestic since nothing else exists');
console.log('Test 1 passed: backfill within a single category when others are empty');

// 2. Plenty in every category -- should guarantee 1-per-category, then
//    backfill remaining slots with the next cheapest overall regardless
//    of category, up to limit=6, without repeating a destination.
const plenty = [
  fare('MEL', true, null, 200), fare('SYD', true, null, 150), fare('OOL', true, null, 400),
  fare('DPS', false, 'SEA', 300), fare('HKT', false, 'SEA', 250), fare('BKK', false, 'SEA', 500),
  fare('TYO', false, null, 900), fare('LAX', false, null, 700), fare('FIJI', false, null, 600),
];
result = selectDeals(plenty, { limit: 6 });
assert.strictEqual(result.length, 6, 'should return exactly 6 (the limit): got ' + result.length);
const iatas = result.map(d => d.iata);
assert.strictEqual(new Set(iatas).size, 6, 'no destination should repeat');
assert.ok(iatas.includes('SYD'), 'cheapest domestic (SYD) should be the guaranteed domestic pick');
assert.ok(iatas.includes('HKT'), 'cheapest SEA (HKT) should be the guaranteed SEA pick');
assert.ok(iatas.includes('FIJI'), 'cheapest other-intl (FIJI at $600, cheaper than LAX$700/TYO$900) should be the guaranteed intl pick');
console.log('Test 2 passed: guaranteed mix + cross-category backfill up to limit, iatas:', iatas);

// 3. Fewer real fares than the limit -- should return everything found,
//    not pad with anything fake.
const few = [fare('MEL', true, null, 200), fare('DPS', false, 'SEA', 300)];
result = selectDeals(few, { limit: 6 });
assert.strictEqual(result.length, 2, 'should return only the 2 real fares that exist, no padding: got ' + result.length);
console.log('Test 3 passed: no fake padding when fewer real fares than limit exist');

// 4. Old default behaviour preserved when limit=3 is explicitly passed
//    (e.g. any other caller still using the old cap).
result = selectDeals(plenty, { limit: 3 });
assert.strictEqual(result.length, 3);
console.log('Test 4 passed: limit=3 still works for backward compatibility');

console.log('ALL selectDeals BACKFILL TESTS PASSED');
