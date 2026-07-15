// "While you're there" currency context for international deals, via
// exchangerate-api.com's free open endpoint (no key/signup required, same
// zero-dependency fetch pattern as lib/travelpayouts.js and lib/weather.js).
// Docs: https://www.exchangerate-api.com/docs/free
//
// This is deliberately separate from the flight price itself — Travelpayouts
// already converts flight prices into the user's chosen display currency
// (see lib/deals.js CURRENCY_SYMBOLS, the 5 currencies a user can pick),
// so there's never a mismatched flight price to worry about. This is purely
// a "what's my money worth once I land" reference line for spending money,
// which only makes sense for international (non-domestic) destinations.
//
// The source refreshes once a day (see time_next_update_utc in a raw
// response) — server-side caching at roughly that cadence (see server.js)
// means this is fetched at most once a day per base currency, and there
// are only 5 possible base currencies, so this is a trivial amount of
// traffic.

const FX_API = 'https://open.er-api.com/v6/latest';

// ISO currency code actually used day-to-day at each international
// destination in lib/travelpayouts.js (REAL_DESTINATIONS). Domestic (AUS)
// destinations are intentionally left out — there's no conversion to show
// when the flight price is already in the user's own currency.
export const DEST_CURRENCY_BY_IATA = {
  DPS: 'IDR', HKT: 'THB', ZQN: 'NZD', NAN: 'FJD', TYO: 'JPY', SIN: 'SGD',
  YYJ: 'CAD', PSP: 'USD', AKL: 'NZD', HNL: 'USD', LAX: 'USD', BKK: 'THB',
  SGN: 'VND', VLI: 'VUV', RAR: 'NZD', HKG: 'HKD', KUL: 'MYR', MNL: 'PHP',
  ICN: 'KRW', DXB: 'AED', LON: 'GBP', CHC: 'NZD'
};

// Display symbols for the destination currencies above — separate from
// lib/deals.js CURRENCY_SYMBOLS, which only covers the 5 currencies a user
// can choose to see flight prices in.
export const DEST_CURRENCY_SYMBOLS = {
  IDR: 'Rp', THB: '฿', NZD: 'NZ$', FJD: 'FJ$', JPY: '¥', SGD: 'S$',
  CAD: 'C$', USD: '$', VND: '₫', VUV: 'VT', HKD: 'HK$', MYR: 'RM',
  PHP: '₱', KRW: '₩', AED: 'AED', GBP: '£'
};

/** Fetches today's rates for every currency relative to `base` (one of the
 * 5 home currencies a user can select — see lib/deals.js CURRENCY_SYMBOLS).
 * Returns null on any failure — a missing rate should just hide the FX
 * line for that deal, never show a stale or guessed one. */
export async function fetchExchangeRates({ base, fetchImpl = fetch }) {
  if (!base) return null;
  try {
    const res = await fetchImpl(`${FX_API}/${base.toUpperCase()}`);
    if (!res.ok) return null;
    const json = await res.json();
    if (json.result !== 'success' || !json.rates) return null;
    return json.rates;
  } catch (e) {
    console.error(`[fx] fetchExchangeRates(${base}) threw:`, e.message);
    return null;
  }
}
