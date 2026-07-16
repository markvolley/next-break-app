// Regression test for a real production bug: dealsMarkup() in
// public/index.html used to bail out to the "No fares found yet" dead-end
// message whenever `result.source === 'no-results'`, regardless of
// whether the deals array actually had backfill cards in it (see
// withBackfill in lib/travelpayouts.js / server.js buildDealsForBreak).
// Since a break with zero real fares always has source: 'no-results', this
// meant the backfill feature's cards were built correctly server-side but
// silently never rendered client-side -- the exact bug the user hit live
// on next-break.onrender.com.
//
// This can't be caught by node --check (it's valid JS, just wrong logic)
// or by any of the server-side tests (the bug is entirely in frontend
// rendering). Rather than load the whole 2000+ line inline <script> (which
// has plenty of top-level DOM setup that would need a real browser), this
// extracts just dealsMarkup/searchOnlyCardMarkup by balanced-brace
// scanning and runs them with minimal stand-ins for their few
// dependencies (destPhotoUrl, fmtDateTime, etc.) -- enough to exercise the
// actual branching logic without needing jsdom or a browser.
//
// Run with: node test_deals_markup.mjs

import fs from 'node:fs';
import assert from 'node:assert';

const html = fs.readFileSync('./public/index.html', 'utf8');

function extractFunction(src, name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`could not find function ${name} in index.html`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const searchOnlyCardMarkupSrc = extractFunction(html, 'searchOnlyCardMarkup');
const dealsMarkupSrc = extractFunction(html, 'dealsMarkup');

// Minimal stand-ins for dealsMarkup's few real dependencies -- not trying
// to reproduce their real formatting, just enough that the function runs
// and we can inspect which branch/cards it produced.
const stubs = `
  function destPhotoUrl(iata){ return null; }
  function fmtDateTime(d){ return 'DATE'; }
  function tripFactsLine(d){ return ''; }
  function weatherLine(w){ return ''; }
  function fxLine(fx){ return ''; }
  function fmtRefreshed(d){ return d ? 'just now' : null; }
`;

const factory = new Function(`
  ${stubs}
  ${searchOnlyCardMarkupSrc}
  ${dealsMarkupSrc}
  return { dealsMarkup, searchOnlyCardMarkup };
`);
const { dealsMarkup } = factory();

function backfillDeal(iata) {
  return {
    source: 'search-only', name: iata, iata, blurb: 'blurb', domestic: false, region: null,
    tags: [], price: null, currency: 'AUD', airline: null, flightNumber: null,
    departureAt: null, returnAt: null, nights: null, isQuickTrip: false,
    bookUrl: `https://search.aviasales.com/flights/?destination_iata=${iata}`
  };
}
function realDeal(iata) {
  return {
    source: 'real', name: iata, iata, blurb: 'blurb', domestic: true, region: null, tags: [],
    price: 250, currency: 'AUD', airline: 'XX', flightNumber: '1', departureAt: '2026-08-01T08:00:00',
    returnAt: '2026-08-05T08:00:00', transfers: 0, nights: 4, isQuickTrip: false, bookUrl: 'https://x'
  };
}

// 1. THE bug: source: 'no-results' (no real fares) but the deals array has
// backfill cards -- must render the cards, not the dead-end message.
{
  const result = {
    source: 'no-results',
    deals: [backfillDeal('MEL'), backfillDeal('DPS'), backfillDeal('TYO')],
    currencySymbol: 'A$', fetchedAt: new Date().toISOString(), personalized: false
  };
  const html = dealsMarkup(result);
  assert.ok(!html.includes('No fares found yet'), 'must NOT show the dead-end message when backfill cards exist');
  assert.ok(html.includes('MEL') && html.includes('DPS') && html.includes('TYO'), 'all 3 backfill destinations must be rendered');
  assert.ok(html.includes('Check flights'), 'backfill cards must use the Check flights button');
}
console.log('Test 1 passed: source "no-results" with backfill cards present renders the cards, not the dead-end message (the actual bug)');

// 2. Genuinely empty (e.g. withBackfill had nothing left to offer) still
// falls back to the dead-end message -- this path must still work.
{
  const result = { source: 'no-results', deals: [], currencySymbol: 'A$', fetchedAt: null, personalized: false };
  const html = dealsMarkup(result);
  assert.ok(html.includes('No fares found yet'), 'a genuinely empty deals array should still show the dead-end message');
}
console.log('Test 2 passed: a truly empty deals array still shows the dead-end message');

// 3. Sanity check: the normal "real fares found" path is unaffected.
{
  const result = {
    source: 'real', deals: [realDeal('SYD'), backfillDeal('LON')],
    currencySymbol: 'A$', fetchedAt: new Date().toISOString(), personalized: false
  };
  const html = dealsMarkup(result);
  assert.ok(!html.includes('No fares found yet'));
  assert.ok(html.includes('SYD') && html.includes('Book this fare'), 'real fare card should render normally');
  assert.ok(html.includes('LON') && html.includes('Check flights'), 'a mixed-in backfill card should still render as search-only');
}
console.log('Test 3 passed: real fares mixed with backfill cards both render correctly');

// 4. not-configured still short-circuits before either message.
{
  const result = { source: 'not-configured', deals: [], currencySymbol: 'A$', fetchedAt: null, personalized: false };
  const html = dealsMarkup(result);
  assert.ok(html.includes('Add your home airport'));
  assert.ok(!html.includes('No fares found yet'));
}
console.log('Test 4 passed: not-configured still shows the setup prompt, not the dead-end message');

console.log('ALL dealsMarkup TESTS PASSED');
