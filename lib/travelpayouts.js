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
// `domestic: true` means the destination is inside Australia — used purely
// to show a "Domestic"/"International" tag on each deal card. This app is
// built around Australian FIFO rosters, so "domestic" is simply "in AU"
// rather than something computed from the user's actual origin airport.
// `region: 'SEA'` marks South East Asian destinations — these are always
// included in every search batch (see pickCandidates) since they're
// typically the cheapest, most popular breaks for Australian FIFO workers,
// so we want to maximise the chance a real fare is found for one of them.
// `tags` categorise each destination against the fixed interest taxonomy
// used for personalisation (see INTEREST_TAGS below and selectDeals) —
// kept intentionally short (1-3 tags) and drawn straight from the blurb
// rather than invented separately, so they stay honest about what's
// actually at each destination.
export const REAL_DESTINATIONS = [
  { name: 'Bali, Indonesia', iata: 'DPS', blurb: 'Beaches, surf breaks and cheap luxury villas.', domestic: false, region: 'SEA', tags: ['beach', 'relax'] },
  { name: 'Phuket, Thailand', iata: 'HKT', blurb: 'Island hopping, street food, warm water year-round.', domestic: false, region: 'SEA', tags: ['beach', 'food'] },
  { name: 'Queenstown, NZ', iata: 'ZQN', blurb: 'Adventure sports, hiking and epic scenery.', domestic: false, tags: ['adventure', 'nature'] },
  { name: 'Gold Coast, AUS', iata: 'OOL', blurb: 'Surf beaches, theme parks, easy short break.', domestic: true, tags: ['beach', 'adventure'] },
  { name: 'Fiji', iata: 'NAN', blurb: 'Overwater bungalows and reef diving.', domestic: false, tags: ['beach', 'relax'] },
  { name: 'Tokyo, Japan', iata: 'TYO', blurb: 'City break — food, culture, neon nights.', domestic: false, tags: ['city', 'food', 'nightlife'] },
  { name: 'Singapore', iata: 'SIN', blurb: 'Easy stopover city with great food scene.', domestic: false, region: 'SEA', tags: ['city', 'food'] },
  { name: 'Cairns, AUS', iata: 'CNS', blurb: 'Reef, rainforest, relaxed tropical pace.', domestic: true, tags: ['nature', 'relax'] },
  { name: 'Vancouver Island, CAN', iata: 'YYJ', blurb: 'Coastal hikes, whale watching, cabins.', domestic: false, tags: ['nature', 'adventure'] },
  { name: 'Palm Springs, USA', iata: 'PSP', blurb: 'Desert sun, pools, easy weekend reset.', domestic: false, tags: ['relax', 'city'] },
  { name: 'Melbourne, AUS', iata: 'MEL', blurb: 'Laneways, coffee culture, live sport.', domestic: true, tags: ['city', 'food'] },
  { name: 'Auckland, NZ', iata: 'AKL', blurb: 'Easy short-haul city break with harbour views.', domestic: false, tags: ['city', 'nature'] },
  { name: 'Honolulu, Hawaii', iata: 'HNL', blurb: 'Beaches, surf and an easy US stopover.', domestic: false, tags: ['beach', 'relax'] },
  { name: 'Los Angeles, USA', iata: 'LAX', blurb: 'Gateway to the US West Coast.', domestic: false, tags: ['city', 'nightlife'] },
  { name: 'Bangkok, Thailand', iata: 'BKK', blurb: 'Street food capital, temples, nightlife.', domestic: false, region: 'SEA', tags: ['food', 'nightlife', 'city'] },
  { name: 'Ho Chi Minh City, Vietnam', iata: 'SGN', blurb: 'Cheap eats, coffee culture, history.', domestic: false, region: 'SEA', tags: ['food', 'city'] },
  { name: 'Vanuatu', iata: 'VLI', blurb: 'Volcanoes, diving and slow island life.', domestic: false, tags: ['adventure', 'beach'] },
  { name: 'Rarotonga, Cook Islands', iata: 'RAR', blurb: 'Quiet lagoons and an easy beach reset.', domestic: false, tags: ['beach', 'relax'] },
  { name: 'Sydney, AUS', iata: 'SYD', blurb: 'Harbour views, beaches and big-city energy.', domestic: true, tags: ['city', 'beach'] },
  { name: 'Adelaide, AUS', iata: 'ADL', blurb: 'Wine regions and laid-back coastal breaks.', domestic: true, tags: ['food', 'relax'] },
  { name: 'Broome, AUS', iata: 'BME', blurb: 'Cable Beach and pearling history — an easy WA escape.', domestic: true, tags: ['beach', 'nature'] },
  { name: 'Hong Kong', iata: 'HKG', blurb: 'Dense city energy, dim sum, easy stopover.', domestic: false, tags: ['city', 'food', 'nightlife'] }
];

// Fixed taxonomy for personalisation — shared conceptually with the
// frontend's interest-chip picker (public/index.html INTEREST_TAGS), which
// must use the same keys. Kept small and generic on purpose: broad enough
// that every destination above has a real match, specific enough to
// actually differentiate deals.
export const INTEREST_TAGS = ['beach', 'city', 'adventure', 'nature', 'food', 'relax', 'nightlife'];

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

  // South East Asia destinations are always searched — they're cheap and
  // popular for this audience, so we want every search batch checking them
  // rather than leaving it up to chance. The remaining slots are filled
  // with a seeded shuffle of everything else, so variety still exists.
  const priority = REAL_DESTINATIONS.filter(d => d.region === 'SEA');
  const rest = REAL_DESTINATIONS.filter(d => d.region !== 'SEA');

  const shuffled = [...rest];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return [...priority, ...shuffled].slice(0, count);
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
    // Month-granularity search (see fetchAllRealFares) can match fares
    // scattered across the whole month — asking for more than just the
    // single cheapest one gives fitsBreak() an actual pool to pick a
    // date-fitting result from, rather than being stuck with whatever the
    // outright cheapest (possibly wrong-dates) fare happens to be.
    limit: '30',
    token
  });
  const url = `${API_BASE}/aviasales/v3/prices_for_dates?${params.toString()}`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Logged so a misconfigured/invalid token shows up in server logs
    // instead of silently looking identical to "no cached fare found".
    console.error(`[travelpayouts] ${origin}->${destination}: HTTP ${res.status} — ${body.slice(0, 200)}`);
    return [];
  }
  const json = await res.json();
  if (!json.success || !Array.isArray(json.data)) {
    console.error(`[travelpayouts] ${origin}->${destination}: unexpected response — ${JSON.stringify(json).slice(0, 200)}`);
    return [];
  }
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

// Fares are queried at month granularity (see departureAt/returnAt below)
// to maximise the chance of a cached hit — but that means a "found" fare's
// actual departure/return dates can land anywhere in that month, including
// well outside the break itself (e.g. departing days after the break
// starts, or returning after it's already over). Showing that as if it
// fits the break would directly contradict what this app promises — deals
// "sized to fit each break exactly" — so anything that doesn't genuinely
// fit inside the break's real day range gets dropped in fitsBreak() below,
// same as if no fare had been found at all.
//
// Deliberately zero grace period, on either side: this app is built around
// FIFO/roster workers, who are still on shift right up until the break
// starts and need to be back for the next one — a flight leaving a day
// "early" isn't actually bookable for them, and one returning a day "late"
// isn't a minor rounding error, it's a missed shift.
// departureAt/returnAt from the API are real ISO date-times with an
// explicit UTC offset baked in, so converting through UTC is deterministic
// no matter where this code runs.
function dateOnly(d) {
  return new Date(d).toISOString().slice(0, 10);
}

// brk.start/brk.end, by contrast, are constructed as local midnight with NO
// offset (see toDate() in lib/deals.js) — they represent "this calendar
// day," not a precise instant. Converting those through toISOString() (UTC)
// can silently shift them a day depending on the server's local timezone,
// which is exactly the kind of bug that would make a fitting fare look
// like it doesn't fit (or vice versa) depending on where this happens to
// be deployed. Local date components sidestep that entirely.
function localDateOnly(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function fitsBreak(departureAt, returnAt, brk) {
  if (!departureAt || !returnAt) return false;
  const dep = dateOnly(departureAt);
  const ret = dateOnly(returnAt);
  const start = localDateOnly(brk.start);
  const end = localDateOnly(brk.end);
  return dep >= start && dep <= end && ret <= end;
}

/**
 * Looks up real cached fares across every curated destination for a break
 * (queried concurrently) and returns everything found that actually fits
 * the break's dates (see fitsBreak) — the expensive part. This is what
 * callers should cache (see server.js's dealsCache), since it's identical
 * for every user searching the same origin/dates regardless of who they
 * are or what they like. Picking which of these to actually show someone
 * is a separate, cheap step — see `selectDeals` below — so personalisation
 * never requires re-querying Travelpayouts per user.
 */
export async function fetchAllRealFares({ token, marker, origin, currency, brk, batchSize = REAL_DESTINATIONS.length, fetchImpl = fetch }) {
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
        // The API returns fares sorted by price — take the cheapest one that
        // actually fits the break's real dates, not just the cheapest overall
        // (which might depart or return on a totally different week).
        const best = data.find(f => fitsBreak(f.departure_at, f.return_at, brk));
        if (!best) return null;
        return {
          source: 'real',
          name: dest.name,
          iata: dest.iata,
          blurb: dest.blurb,
          domestic: !!dest.domestic,
          region: dest.region || null,
          tags: dest.tags || [],
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
        console.error(`[travelpayouts] ${origin}->${dest.iata} threw:`, e.message);
        return null; // one destination failing shouldn't sink the others
      }
    })
  );

  const found = results.filter(Boolean);
  console.log(`[travelpayouts] ${origin} for ${brk.key}: ${found.length}/${candidates.length} destinations had a cached fare that actually fits the break`);
  return found;
}

// How much more a personalised pick is allowed to cost than the outright
// cheapest fare in its bucket before we just show the cheapest instead —
// keeps "smarter" selection from ever picking something meaningfully more
// expensive purely because it matches someone's interests.
const PERSONALIZATION_PRICE_TOLERANCE = 1.25;

function affinityScore(dest, profile) {
  if (!profile) return 0;
  const tags = dest.tags || [];
  let score = 0;
  for (const t of tags) {
    if (profile.interests?.includes(t)) score += 2; // explicit "I like this" beats implicit signal
    const clicks = profile.affinity?.[t] || 0;
    if (clicks > 0) score += Math.min(clicks, 5); // capped so old click history can't dominate forever
  }
  return score;
}

// Picks the best match within a bucket: the cheapest fare, unless a
// personalisation profile is supplied and something within
// PERSONALIZATION_PRICE_TOLERANCE of the cheapest scores a genuine match —
// in which case that's shown instead. With no profile (logged-out users,
// or logged-in users who haven't set any preference yet), this is
// identical to plain cheapest-first.
function pickBest(bucket, profile) {
  if (!bucket.length) return null;
  const byPrice = [...bucket].sort((a, b) => a.price - b.price);
  const cheapest = byPrice[0];
  if (!profile || (!profile.interests?.length && !Object.keys(profile.affinity || {}).length)) {
    return cheapest;
  }
  const withinBudget = byPrice.filter(d => d.price <= cheapest.price * PERSONALIZATION_PRICE_TOLERANCE);
  const scored = withinBudget
    .map(d => ({ d, s: affinityScore(d, profile) }))
    .sort((a, b) => b.s - a.s || a.d.price - b.d.price);
  return scored[0].s > 0 ? scored[0].d : cheapest;
}

/**
 * Turns the full set of real fares found for a break (from
 * `fetchAllRealFares`) into the fixed 3-slot structure shown on the
 * dashboard: 1 domestic, 1 South East Asia, 1 other-international, in that
 * order. A bucket with no real fare is simply skipped rather than
 * backfilled with something from another bucket (no fake substitutes).
 *
 * `profile`, if supplied, personalises which fare wins each bucket (see
 * pickBest) — pass `{ interests, affinity }` for a logged-in user with
 * preferences set, or omit/pass null for the plain cheapest-first
 * behaviour (logged-out users, or anyone without preferences yet).
 */
export function selectDeals(found, { limit = 3, profile = null } = {}) {
  const domestic = pickBest(found.filter(d => d.domestic), profile);
  const sea = pickBest(found.filter(d => !d.domestic && d.region === 'SEA'), profile);
  const otherIntl = pickBest(found.filter(d => !d.domestic && d.region !== 'SEA'), profile);
  return [domestic, sea, otherIntl].filter(Boolean).slice(0, limit);
}

/** Convenience one-shot wrapper (fetch + select with no personalisation) —
 * kept for callers that don't need the caching split server.js uses. */
export async function findRealDeals(opts) {
  const found = await fetchAllRealFares(opts);
  return selectDeals(found, { limit: opts.limit });
}
