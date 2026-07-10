// Real flight prices via the Travelpayouts (Aviasales) Data API, plus
// trackable affiliate booking links. Zero dependencies — plain fetch.
//
// Docs: https://support.travelpayouts.com/hc/en-us/articles/203956163
//
// This is a *cache* of recent real searches (not a live GDS lookup), which
// suits this app well: people are planning weeks ahead for a scheduled
// break, not booking in the next hour. It also means a given destination
// won't always have cached data for the exact dates asked — that's normal,
// not a bug, and the caller should expect some destinations to return
// nothing.

const API_BASE = 'https://api.travelpayouts.com';

// Curated pool of realistic short/long-break destinations, each with a
// real IATA city/airport code so we can query actual cached fares. This is
// deliberately a subset of the old mock DESTINATIONS list — the "no flight
// needed" entries (nearby coastal town, mountain retreat) don't have a
// single real airport to look up, so they stay mock-only.
export const REAL_DESTINATIONS = [
  { name: 'Bali, Indonesia', iata: 'DPS', blurb: 'Beaches, surf breaks and cheap luxury villas.' },
  { name: 'Phuket, Thailand', iata: 'HKT', blurb: 'Island hopping, street food, warm water year-round.' },
  { name: 'Queenstown, NZ', iata: 'ZQN', blurb: 'Adventure sports, hiking and epic scenery.' },
  { name: 'Gold Coast, AUS', iata: 'OOL', blurb: 'Surf beaches, theme parks, easy short break.' },
  { name: 'Fiji', iata: 'NAN', blurb: 'Overwater bungalows and reef diving.' },
  { name: 'Tokyo, Japan', iata: 'TYO', blurb: 'City break — food, culture, neon nights.' },
  { name: 'Singapore', iata: 'SIN', blurb: 'Easy stopover city with great food scene.' },
  { name: 'Cairns, AUS', iata: 'CNS', blurb: 'Reef, rainforest, relaxed tropical pace.' },
  { name: 'Vancouver Island, CAN', iata: 'YYJ', blurb: 'Coastal hikes, whale watching, cabins.' },
  { name: 'Palm Springs, USA', iata: 'PSP', blurb: 'Desert sun, pools, easy weekend reset.' },
  { name: 'Melbourne, AUS', iata: 'MEL', blurb: 'Laneways, coffee culture, live sport.' },
  { name: 'Auckland, NZ', iata: 'AKL', blurb: 'Easy short-haul city break with harbour views.' },
  { name: 'Honolulu, Hawaii', iata: 'HNL', blurb: 'Beaches, surf and an easy US stopover.' },
  { name: 'Los Angeles, USA', iata: 'LAX', blurb: 'Gateway to the US West Coast.' },
  { name: 'Bangkok, Thailand', iata: 'BKK', blurb: 'Street food capital, temples, nightlife.' },
  { name: 'Ho Chi Minh City, Vietnam', iata: 'SGN', blurb: 'Cheap eats, coffee culture, history.' },
  { name: 'Vanuatu', iata: 'VLI', blurb: 'Volcanoes, diving and slow island life.' },
  { name: 'Rarotonga, Cook Islands', iata: 'RAR', blurb: 'Quiet lagoons and an easy beach reset.' },
  { name: 'Sydney, AUS', iata: 'SYD', blurb: 'Harbour views, beaches and big-city energy.' },
  { name: 'Adelaide, AUS', iata: 'ADL', blurb: 'Wine regions and laid-back coastal breaks.' },
  { name: 'Broome, AUS', iata: 'BME', blurb: 'Cable Beach and pearling history — an easy WA escape.' },
  { name: 'Hong Kong', iata: 'HKG', blurb: 'Dense city energy, dim sum, easy stopover.' }
];

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}
function seededRand(seed) {
  let t = seed + 0x6d2b79f5;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function pickCandidates(brk, count) {
  const rand = seededRand(hashStr(brk.key));
  const shuffled = [...REAL_DESTINATIONS];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

async function fetchPricesForDates({ token, origin, destination, departureAt, returnAt, currency, fetchImpl = fetch }) {
  const params = new URLSearchParams({
    origin,
    destination,
    departure_at: departureAt,
    return_at: returnAt,
    one_way: 'false',
    sorting: 'price',
    currency: (currency || 'usd').toLowerCase(),
    limit: '1',
    token
  });
  const url = `${API_BASE}/aviasales/v3/prices_for_dates?${params.toString()}`;
  const res = await fetchImpl(url);
  if (!res.ok) return [];
  const json = await res.json();
  if (!json.success || !Array.isArray(json.data)) return [];
  return json.data;
}

/** Builds a real, trackable Aviasales booking link from the `link` field
 * the Data API returns (a path fragment, e.g. "/search/MAD2807BCN2608...").
 */
export function buildBookingUrl(linkFragment, marker) {
  if (!linkFragment) return null;
  const full = linkFragment.startsWith('http')
    ? linkFragment
    : `https://www.aviasales.com${linkFragment}`;
  if (!marker) return full;
  const separator = full.includes('?') ? '&' : '?';
  return `${full}${separator}marker=${encodeURIComponent(marker)}`;
}

/**
 * Looks up real cached fares for a handful of curated destinations near a
 * break's dates. Queries a batch concurrently and returns whichever come
 * back with real data, up to `limit`. Destinations with no recent cached
 * search for that route just come back empty — that's expected, not an
 * error — so the caller may get fewer than `limit` results.
 */
export async function findRealDeals({ token, marker, origin, currency, brk, limit = 3, batchSize = 12, fetchImpl = fetch }) {
  if (!token || !origin) return [];

  const departureAt = brk.start.toISOString().slice(0, 7); // YYYY-MM — month granularity widens the chance of a cache hit
  const returnAt = brk.end.toISOString().slice(0, 7);
  const candidates = pickCandidates(brk, batchSize);

  const results = await Promise.all(
    candidates.map(async dest => {
      try {
        const data = await fetchPricesForDates({
          token, origin, destination: dest.iata, departureAt, returnAt, currency, fetchImpl
        });
        if (!data.length) return null;
        const best = data[0];
        return {
          source: 'real',
          name: dest.name,
          iata: dest.iata,
          blurb: dest.blurb,
          price: best.price,
          currency: (currency || 'usd').toUpperCase(),
          airline: best.airline,
          flightNumber: best.flight_number,
          departureAt: best.departure_at,
          returnAt: best.return_at,
          transfers: best.transfers,
          bookUrl: buildBookingUrl(best.link, marker)
        };
      } catch (e) {
        return null; // one destination failing shouldn't sink the others
      }
    })
  );

  return results.filter(Boolean).slice(0, limit);
}
