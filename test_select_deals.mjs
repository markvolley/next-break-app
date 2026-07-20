// Unit tests for selectDeals (lib/travelpayouts.js) — the "2 domestic, 2
// SEA, 2 other-international, always 6 total" real-fare selection rule.
// Run with: node test_select_deals.mjs

import { selectDeals, DEALS_PER_CATEGORY } from './lib/travelpayouts.js';
import assert from 'node:assert';

function fare(iata, domestic, region, price) {
  return { source: 'real', name: iata, iata, blurb: '', domestic, region, tags: [], price, currency: 'AUD', airline: 'XX', flightNumber: '1', departureAt: '2026-07-20T08:00:00', returnAt: '2026-07-25T08:00:00', transfers: 0, nights: 5, isQuickTrip: false, bookUrl: null };
}

function categoryOf(d) {
  if (d.domestic) return 'domestic';
  if (d.region === 'SEA') return 'sea';
  return 'intl';
}

// 0. The per-category guarantee is 2, and 2 categories x 3 = 6 total by default.
assert.strictEqual(DEALS_PER_CATEGORY, 2);
console.log('Test 0 passed: DEALS_PER_CATEGORY is 2 (2+2+2 = 6 total)');

// 1. Plenty of domestic fares, nothing in SEA/international -- should cap
// at 2 real domestic fares (the cheapest 2), NOT pad with more domestic
// just because that's all that's available. The other 4 slots are left
// for withBackfill to fill with real SEA/international destinations.
{
  const onlyDomestic = [
    fare('MEL', true, null, 200), fare('SYD', true, null, 250), fare('OOL', true, null, 180),
    fare('ADL', true, null, 300), fare('CNS', true, null, 220)
  ];
  const result = selectDeals(onlyDomestic, { limit: 6 });
  assert.strictEqual(result.length, 2, 'should cap at 2 real domestic fares, not all 5 available: got ' + result.length);
  assert.ok(result.every(d => d.domestic), 'all should be domestic since nothing else exists');
  const iatas = result.map(d => d.iata);
  assert.ok(iatas.includes('OOL') && iatas.includes('MEL'), 'the 2 cheapest domestic fares (OOL $180, MEL $200) should win: got ' + iatas);
}
console.log('Test 1 passed: real fares cap at 2 per category, never overfilling from one abundant category');

// 2. Plenty in every category -- should return exactly the cheapest 2 from
// EACH category (6 total), never crowding one category out with a cheaper
// fare from another.
{
  const plenty = [
    fare('MEL', true, null, 200), fare('SYD', true, null, 150), fare('OOL', true, null, 400),
    fare('DPS', false, 'SEA', 300), fare('HKT', false, 'SEA', 250), fare('BKK', false, 'SEA', 500),
    fare('TYO', false, null, 900), fare('LAX', false, null, 700), fare('FIJI', false, null, 600)
  ];
  const result = selectDeals(plenty, { limit: 6 });
  assert.strictEqual(result.length, 6, 'should return exactly 6 (2 per category): got ' + result.length);
  const iatas = result.map(d => d.iata);
  assert.strictEqual(new Set(iatas).size, 6, 'no destination should repeat');

  const byCategory = { domestic: [], sea: [], intl: [] };
  for (const d of result) byCategory[categoryOf(d)].push(d.iata);
  assert.strictEqual(byCategory.domestic.length, 2, 'exactly 2 domestic');
  assert.strictEqual(byCategory.sea.length, 2, 'exactly 2 SEA');
  assert.strictEqual(byCategory.intl.length, 2, 'exactly 2 international');

  assert.deepStrictEqual(new Set(byCategory.domestic), new Set(['SYD', 'MEL']), 'cheapest 2 domestic (SYD $150, MEL $200)');
  assert.deepStrictEqual(new Set(byCategory.sea), new Set(['HKT', 'DPS']), 'cheapest 2 SEA (HKT $250, DPS $300)');
  assert.deepStrictEqual(new Set(byCategory.intl), new Set(['FIJI', 'LAX']), 'cheapest 2 international (FIJI $600, LAX $700)');
  assert.ok(!iatas.includes('OOL') && !iatas.includes('BKK') && !iatas.includes('TYO'), 'the 3rd-cheapest in each category should be excluded, not spill into another category\'s slot');
}
console.log('Test 2 passed: exactly 2 per category (6 total), cheapest within each category, no cross-category crowding');

// 3. Fewer real fares than 2-per-category -- should return everything
// found, not pad with anything fake (padding is withBackfill's job).
{
  const few = [fare('MEL', true, null, 200), fare('DPS', false, 'SEA', 300)];
  const result = selectDeals(few, { limit: 6 });
  assert.strictEqual(result.length, 2, 'should return only the 2 real fares that exist, no padding: got ' + result.length);
}
console.log('Test 3 passed: no fake padding when fewer real fares than the per-category guarantee exist');

// 4. `limit` still caps the final returned count as a hard ceiling, applied
// after the per-category selection (e.g. any caller wanting a shorter list).
{
  const plenty = [
    fare('MEL', true, null, 200), fare('SYD', true, null, 150), fare('OOL', true, null, 400),
    fare('DPS', false, 'SEA', 300), fare('HKT', false, 'SEA', 250), fare('BKK', false, 'SEA', 500),
    fare('TYO', false, null, 900), fare('LAX', false, null, 700), fare('FIJI', false, null, 600)
  ];
  const result = selectDeals(plenty, { limit: 3 });
  assert.strictEqual(result.length, 3);
}
console.log('Test 4 passed: limit still works as a hard ceiling for backward compatibility');

// 5. A custom perCategory overrides the default of 2 (e.g. a future caller
// wanting a shorter or longer per-category guarantee).
{
  const plenty = [
    fare('MEL', true, null, 200), fare('SYD', true, null, 150), fare('OOL', true, null, 400),
    fare('DPS', false, 'SEA', 300), fare('HKT', false, 'SEA', 250),
    fare('FIJI', false, null, 600)
  ];
  const result = selectDeals(plenty, { perCategory: 1, limit: 3 });
  assert.strictEqual(result.length, 3, '1 per category x 3 categories = 3');
  const iatas = result.map(d => d.iata);
  assert.ok(iatas.includes('SYD') && iatas.includes('HKT') && iatas.includes('FIJI'));
}
console.log('Test 5 passed: perCategory is configurable, not hardcoded to 2');

console.log('ALL selectDeals TESTS PASSED');
