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
  { name: 'Hong Kong', iata: 'HKG', blurb: 'Dense city energy, dim sum, easy stopover.', domestic: false, tags: ['city', 'food', 'nightlife'] },
  // Added to widen the search surface — more candidate destinations means
  // more chances a real, fitting, commissionable fare turns up for a given
  // break, since the underlying Travelpayouts cache is patchy per route.
  { name: 'Canberra, AUS', iata: 'CBR', blurb: 'Museums, lake walks and an easy short capital break.', domestic: true, tags: ['city', 'relax'] },
  { name: 'Newcastle, AUS', iata: 'NTL', blurb: 'Beaches and a laid-back city, close enough for a quick reset.', domestic: true, tags: ['beach', 'relax'] },
  { name: 'Hobart, AUS', iata: 'HBA', blurb: 'Cool-climate wine, MONA and rugged Tasmanian coastline.', domestic: true, tags: ['nature', 'food'] },
  // Domestic short-hops specifically — quicker/cheaper to justify on a
  // shorter break than an international trip, and a notable gap before
  // (no Brisbane or Perth at all).
  { name: 'Brisbane, AUS', iata: 'BNE', blurb: 'River city energy with an easy laid-back pace.', domestic: true, tags: ['city', 'relax'] },
  { name: 'Perth, AUS', iata: 'PER', blurb: 'Sun, river foreshore and an easy WA capital break.', domestic: true, tags: ['city', 'beach'] },
  { name: 'Darwin, AUS', iata: 'DRW', blurb: 'Tropical heat, sunset markets and Top End adventure.', domestic: true, tags: ['adventure', 'nature'] },
  { name: 'Alice Springs, AUS', iata: 'ASP', blurb: 'Red centre desert, Uluru gateway and huge night skies.', domestic: true, tags: ['adventure', 'nature'] },
  { name: 'Launceston, AUS', iata: 'LST', blurb: 'Gorge walks, cool-climate wine and easy Tassie charm.', domestic: true, tags: ['nature', 'food'] },
  { name: 'Sunshine Coast, AUS', iata: 'MCY', blurb: 'Laid-back beaches without the Gold Coast crowds.', domestic: true, tags: ['beach', 'relax'] },
  { name: 'Whitsundays, AUS', iata: 'PPP', blurb: 'Gateway to the Whitsundays — reef, sailing, white sand.', domestic: true, tags: ['beach', 'adventure'] },
  { name: 'Kuala Lumpur, Malaysia', iata: 'KUL', blurb: 'Street food, skyline views and an easy SEA stopover.', domestic: false, region: 'SEA', tags: ['food', 'city'] },
  { name: 'Manila, Philippines', iata: 'MNL', blurb: 'Island-hopping gateway with cheap eats and warm water.', domestic: false, region: 'SEA', tags: ['beach', 'food'] },
  { name: 'Seoul, South Korea', iata: 'ICN', blurb: 'K-culture, street markets and easy shopping.', domestic: false, tags: ['city', 'food', 'nightlife'] },
  { name: 'Dubai, UAE', iata: 'DXB', blurb: 'Desert luxury, skyline views and an easy long-haul stopover.', domestic: false, tags: ['city', 'relax'] },
  { name: 'London, UK', iata: 'LON', blurb: 'History, culture and an easy base for a longer Europe trip.', domestic: false, tags: ['city', 'food'] },
  { name: 'Christchurch, NZ', iata: 'CHC', blurb: "Gateway to the Southern Alps and Canterbury's wine country.", domestic: false, tags: ['nature', 'adventure'] }
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

// Two different views of the same underlying recent-search cache, queried
// together and merged: prices_for_dates returns the N cheapest fares for
// the whole month regardless of which day (can cluster on 2-3 cheap days
// and miss everything else); grouped_prices returns one fare per calendar
// day (real day-by-day spread, but only for days the cache actually has
// something for). Neither one is reliably "the better one" — for a
// low-traffic route the cache can be thin enough that either view alone
// misses a fare the other one has — so both get queried and combined into
// one candidate pool before fitsBreak/minNights ever run. Worst case one
// of the two comes back empty and this just costs an extra request;
// best case it's the difference between a result and "no results."
async function fetchPricesForDates({ token, origin, destination, departureAt, returnAt, currency, fetchImpl = fetch }) {
  // locale controls the language the returned `link` field points to when
  // someone clicks through to book (see buildBookingUrl below) — without
  // it, Aviasales defaults to Russian (their home market), not English.
  // en-gb is the closest of Aviasales' fixed locale list (en-us/en-gb/ru/
  // de/es/fr/pl) to Australian English.
  const common = { origin, destination, departure_at: departureAt, return_at: returnAt, currency: (currency || 'usd').toLowerCase(), locale: 'en-gb', token };

  async function fetchJson(path, extraParams) {
    const params = new URLSearchParams({ ...common, ...extraParams });
    const url = `${API_BASE}${path}?${params.toString()}`;
    try {
      const res = await fetchImpl(url);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // Logged so a misconfigured/invalid token shows up in server logs
        // instead of silently looking identical to "no cached fare found".
        console.error(`[travelpayouts] ${origin}->${destination} (${path}): HTTP ${res.status} — ${body.slice(0, 200)}`);
        return null;
      }
      return await res.json();
    } catch (e) {
      console.error(`[travelpayouts] ${origin}->${destination} (${path}) threw:`, e.message);
      return null;
    }
  }

  const [byPrice, byDay] = await Promise.all([
    fetchJson('/aviasales/v3/prices_for_dates', { one_way: 'false', sorting: 'price', limit: '30' }),
    fetchJson('/aviasales/v3/grouped_prices', { group_by: 'departure_at', direct: 'false' })
  ]);

  const fromPrice = (byPrice?.success && Array.isArray(byPrice.data)) ? byPrice.data : [];
  const fromDay = (byDay?.success && byDay.data && typeof byDay.data === 'object') ? Object.values(byDay.data) : [];

  if (!fromPrice.length && !fromDay.length) {
    console.error(`[travelpayouts] ${origin}->${destination}: both endpoints returned nothing usable`);
  }

  // Dedupe on (departure_at, return_at, price) — the same fare commonly
  // shows up in both responses, no reason to carry it twice through the
  // fitsBreak/minNights logic downstream.
  const seen = new Set();
  const merged = [];
  for (const f of [...fromPrice, ...fromDay]) {
    const key = `${f.departure_at}|${f.return_at}|${f.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(f);
  }
  return merged;
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
// departureAt/returnAt from the API are ISO date-times with the leg's own
// local offset already baked in (e.g. "2026-07-21T09:00:00+08:00" for a
// Perth departure) — the first 10 characters are already the correct local
// calendar date for that leg. Reparsing through `new Date(...).toISOString()`
// (UTC) would "correct" that back to a different day whenever the local
// time is early morning/late evening relative to UTC — exactly the kind of
// silent off-by-one that would under- or over-count how many nights a trip
// actually is. Taking the date substring directly sidesteps that entirely.
function dateOnly(d) {
  return String(d).slice(0, 10);
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

// The bar for "worth the trip" — a short domestic hop earns its keep
// sooner than a long-haul flight does, so this scales with how far the
// destination actually is: domestic 2+ nights, medium-haul (South East
// Asia) 3+, long-haul (everything else international) 4+. Preferred, not
// an absolute filter — see fetchAllRealFares, which only falls back to
// something shorter when nothing in the whole month clears this bar.
function minNightsFor(dest) {
  if (dest.domestic) return 2;
  if (dest.region === 'SEA') return 3;
  return 4;
}

function nightsBetween(departureAt, returnAt) {
  const dep = new Date(`${dateOnly(departureAt)}T00:00:00Z`);
  const ret = new Date(`${dateOnly(returnAt)}T00:00:00Z`);
  return Math.round((ret - dep) / 86400000);
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
        // grouped_prices returns (up to) one fare per calendar day in the
        // month, unsorted — first narrow to ones that actually land inside
        // the break, then prefer the cheapest of those that's also long
        // enough to be worth the trip. Only fall back to a shorter "quick
        // trip" option when nothing in the whole month clears that bar —
        // a real option beats an empty state, but a proper deal beats a
        // technically-fitting one-nighter whenever there's a choice.
        const fitting = data.filter(f => fitsBreak(f.departure_at, f.return_at, brk));
        if (!fitting.length) return null;
        const minNights = minNightsFor(dest);
        const goodEnough = fitting.filter(f => nightsBetween(f.departure_at, f.return_at) >= minNights);
        const pool = goodEnough.length ? goodEnough : fitting;
        const best = pool.sort((a, b) => a.price - b.price)[0];
        const nights = nightsBetween(best.departure_at, best.return_at);
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
          // Outbound leg duration in minutes — prices_for_dates returns
          // duration_to/duration_back (per-leg) plus a combined duration;
          // grouped_prices only ever returns the combined figure, so fall
          // back to that when the per-leg field isn't present. Either way
          // this is null (not a guess) when neither is available.
          flightMinutes: best.duration_to ?? best.duration ?? null,
          nights,
          isQuickTrip: nights < minNights,
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
 * `fetchAllRealFares`) into the deals shown on the dashboard. First
 * guarantees a mix — 1 domestic, 1 South East Asia, 1 other-international —
 * same as before, skipping any bucket that has nothing (no fake
 * substitutes). Then, if that mix is still under `limit` (either because
 * a bucket came up empty, or because `limit` is bigger than 3), backfills
 * with additional real fares from WHICHEVER bucket has more to offer —
 * cheapest/best-matching first, never repeating a destination already
 * picked, no longer capped at one-per-category. This only ever adds real,
 * genuinely-found fares; it never invents anything.
 *
 * `profile`, if supplied, personalises which fare wins each pick (see
 * pickBest) — pass `{ interests, affinity }` for a logged-in user with
 * preferences set, or omit/pass null for the plain cheapest-first
 * behaviour (logged-out users, or anyone without preferences yet).
 */
export function selectDeals(found, { limit = 6, profile = null } = {}) {
  const picked = [];
  const pickedIatas = new Set();

  function takeBest(bucket) {
    const best = pickBest(bucket, profile);
    if (best) { picked.push(best); pickedIatas.add(best.iata); }
  }

  // Guarantee the mix first, same priority order as before.
  takeBest(found.filter(d => d.domestic));
  takeBest(found.filter(d => !d.domestic && d.region === 'SEA'));
  takeBest(found.filter(d => !d.domestic && d.region !== 'SEA'));

  // Backfill from anything real that's left, regardless of category, until
  // the display limit is hit or there's genuinely nothing more to show.
  let remaining = found.filter(d => !pickedIatas.has(d.iata));
  while (picked.length < limit && remaining.length) {
    const best = pickBest(remaining, profile);
    if (!best) break;
    picked.push(best);
    pickedIatas.add(best.iata);
    remaining = remaining.filter(d => d.iata !== best.iata);
  }

  return picked.slice(0, limit);
}

/** Convenience one-shot wrapper (fetch + select with no personalisation) —
 * kept for callers that don't need the caching split server.js uses. */
export async function findRealDeals(opts) {
  const found = await fetchAllRealFares(opts);
  return selectDeals(found, { limit: opts.limit });
}

// ---------- backfill: "no deal found" destination cards ----------
//
// Real cached fares are often thin for a given break (see the big comment
// on fetchAllRealFares) — a user can legitimately see zero or one real
// fare. Rather than leave that as a dead end, every break always shows at
// least BACKFILL_MINIMUM destination cards: real fares first, and if
// still short, extra destinations with NO price shown at all — just a
// name and a link to a live Aviasales search for the break's own real
// dates (never a mismatched cached date). This never fabricates a price,
// which this app has never done, and it still earns commission if the
// user books, since the affiliate marker rides along on the live-search
// link itself — commission is tracked by the click-through reaching
// Aviasales with the marker attached, not by whether a price was shown
// here first.
export const BACKFILL_MINIMUM = 3;

/** Builds a live Aviasales search-results link for the break's actual
 * dates — no price is fetched or shown by this app; the user sees real,
 * live results only once they click through.
 * Docs: https://support.travelpayouts.com/hc/en-us/articles/5711895629714
 * `locale` isn't optional in practice — leaving it off doesn't fall back
 * to English, it lands on Aviasales' Russian-language default (their home
 * market), which also drags the displayed currency along with it. Always
 * setting it explicitly (en-gb, the closest supported locale to Australian
 * English out of Aviasales' fixed list: en-us/en-gb/ru/de/es/fr/pl) is what
 * keeps origin_iata/destination_iata actually showing up pre-filled in the
 * search form too, rather than a blank-looking form on the wrong locale. */
export function buildLiveSearchUrl({ origin, destination, departDate, returnDate, marker, currency, locale = 'en-gb' }) {
  const params = new URLSearchParams({
    origin_iata: origin,
    destination_iata: destination,
    depart_date: departDate,
    return_date: returnDate,
    adults: '1',
    children: '0',
    infants: '0',
    trip_class: '0',
    one_way: 'false',
    locale
  });
  if (currency) params.set('currency', currency.toLowerCase());
  if (marker) params.set('marker', marker);
  return `https://search.aviasales.com/flights/?${params.toString()}`;
}

// Same domestic -> SEA -> international priority order used for real
// fares (see selectDeals's guaranteed-mix phase above), so a page that's
// part real fare, part backfill still reads as "one domestic, one SEA,
// one international" rather than a random assortment.
const CATEGORY_ORDER = ['domestic', 'sea', 'intl'];
function destCategory(d) {
  if (d.domestic) return 'domestic';
  if (d.region === 'SEA') return 'sea';
  return 'intl';
}

// Picks extra destinations to backfill with, one per category named in
// `categories` (in the order given), each drawn from a seeded shuffle so
// the pick is deterministic per break but still varies which particular
// domestic/SEA/international destination shows up across different
// breaks. Seeded independently from pickCandidates (a different seed
// suffix) so the backfill order doesn't just mirror the real-fare search
// order, and excludes anything already shown as a real fare so a
// destination never appears twice on one break.
export function pickBackfillDestinations(brk, { excludeIatas = new Set(), categories = CATEGORY_ORDER, count = categories.length } = {}) {
  const rand = seededRand(hashStr(`${brk.key}|backfill`));
  const pool = REAL_DESTINATIONS.filter(d => !excludeIatas.has(d.iata));
  const used = new Set();
  const picks = [];

  function pickFrom(bucket) {
    if (!bucket.length) return null;
    const dest = bucket[Math.floor(rand() * bucket.length)];
    used.add(dest.iata);
    return dest;
  }

  for (const cat of categories.slice(0, count)) {
    const dest = pickFrom(pool.filter(d => destCategory(d) === cat && !used.has(d.iata)));
    if (dest) picks.push(dest);
  }

  // Defensive fallback — shouldn't happen given the pool has plenty of
  // destinations in every category, but if a category's bucket is ever
  // genuinely exhausted, still reach `count` rather than silently
  // returning fewer destinations than asked for.
  while (picks.length < count) {
    const dest = pickFrom(pool.filter(d => !used.has(d.iata)));
    if (!dest) break;
    picks.push(dest);
  }

  return picks;
}

/**
 * Tops up an already-selected deals list to BACKFILL_MINIMUM using no-price
 * "optional destination" cards, always using the break's own real dates.
 * Each backfill card carries `source: 'search-only'` so the frontend can
 * render it distinctly — no price line, a "no deal found yet" tag, and a
 * button that goes to a live search instead of a specific booked fare.
 * A no-op (returns `picked` unchanged) once the minimum is already met.
 *
 * The final list — real fares plus backfill cards together — is always
 * ordered domestic, then SEA, then international, matching the same rule
 * `selectDeals` uses for real fares. `picked` coming in already has at
 * most one entry per category (selectDeals only ever guarantees the mix
 * that way when there are fewer than BACKFILL_MINIMUM real fares, which is
 * the only time this function does any work), so backfill only needs to
 * fill in whichever categories `picked` doesn't already cover.
 */
export function withBackfill(picked, { origin, brk, marker, currency, minimum = BACKFILL_MINIMUM } = {}) {
  if (picked.length >= minimum || !origin || !brk) return picked;

  const covered = new Set(picked.map(destCategory));
  const missingCategories = CATEGORY_ORDER.filter(cat => !covered.has(cat));
  const need = minimum - picked.length;
  const excludeIatas = new Set(picked.map(d => d.iata));
  const extras = pickBackfillDestinations(brk, { excludeIatas, categories: missingCategories, count: need });
  const departDate = localDateOnly(brk.start);
  const returnDate = localDateOnly(brk.end);

  const backfillDeals = extras.map(dest => ({
    source: 'search-only',
    name: dest.name,
    iata: dest.iata,
    blurb: dest.blurb,
    domestic: !!dest.domestic,
    region: dest.region || null,
    tags: dest.tags || [],
    price: null,
    currency: (currency || 'usd').toUpperCase(),
    airline: null,
    flightNumber: null,
    departureAt: null,
    returnAt: null,
    nights: null,
    isQuickTrip: false,
    bookUrl: buildLiveSearchUrl({ origin, destination: dest.iata, departDate, returnDate, marker, currency })
  }));

  return [...picked, ...backfillDeals]
    .sort((a, b) => CATEGORY_ORDER.indexOf(destCategory(a)) - CATEGORY_ORDER.indexOf(destCategory(b)));
}
