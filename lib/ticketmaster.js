// Real, ticketed live events (concerts, sports, theatre, comedy) near a
// user's hometown, via Ticketmaster's Discovery API — a free, self-serve
// public API. Getting a key is immediate (no approval wait), unlike
// Ticketmaster's separate *Affiliate Program* (commission on ticket sales,
// applied for via Impact, approval required — see buildEventUrl's note
// below). Zero dependencies, same pattern as lib/weather.js and
// lib/activities.js.
//
// Docs: https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/
//
// CONFIDENCE NOTE: verified directly against Ticketmaster's own published
// docs and example responses (not guessed) — endpoint, query params, and
// the response field names used below (name, url, images[].ratio/url,
// dates.start.localDate/localTime, classifications[0].segment.name,
// priceRanges[].min/max/currency, _embedded.venues[0].name/city.name) all
// match their documented example payloads. This sandbox has no network
// access to actually call the live API end-to-end though, so it's worth a
// quick sanity check against a real response once TICKETMASTER_API_KEY is
// set. One deliberate choice worth flagging: the `latlong` query param is
// marked deprecated in their docs ("may be removed in a future release,
// please use geoPoint instead") but is still fully documented and
// functional today. geoPoint requires a geohash-encoded string instead of
// plain lat/lon, which needs its own encoder — skipped for now to avoid
// shipping unverified geohash math with no live API to test it against.
// If Ticketmaster ever actually removes `latlong`, this is the first place
// to look.
//
// Default free-tier quota: 5000 calls/day, 5/sec — this app's per-hometown
// caching (see server.js) stays nowhere near that.

const API_BASE = 'https://app.ticketmaster.com/discovery/v2';

/** Real events within `radiusKm` of a point, optionally bounded to a date
 * window. Returns [] (never fabricated) if the key's missing, the request
 * fails, or nothing's on. */
export async function findEvents({
  apiKey, lat, lon, radiusKm = 50, startDateTime, endDateTime,
  countryCode = 'AU', size = 50, fetchImpl = fetch
}) {
  if (!apiKey || lat == null || lon == null) return [];

  const params = new URLSearchParams({
    apikey: apiKey,
    latlong: `${lat},${lon}`,
    radius: String(radiusKm),
    unit: 'km',
    countryCode,
    size: String(size),
    sort: 'date,asc'
  });
  if (startDateTime) params.set('startDateTime', startDateTime);
  if (endDateTime) params.set('endDateTime', endDateTime);

  const url = `${API_BASE}/events.json?${params.toString()}`;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[ticketmaster] HTTP ${res.status} — ${body.slice(0, 200)}`);
      return [];
    }
    const json = await res.json();
    const events = json?._embedded?.events;
    if (!Array.isArray(events)) return []; // no events found this call — a normal, valid response shape, not an error
    return events.map(parseEvent).filter(Boolean);
  } catch (e) {
    console.error('[ticketmaster] findEvents threw:', e.message);
    return [];
  }
}

/** Wraps a plain Ticketmaster event URL in an Impact.com deep link so a
 * booking earns commission — only once the Ticketmaster Affiliate Program
 * application (applied for via Impact, separate from this free Discovery
 * API key) has actually been approved.
 *
 * `affiliatePrefix` is the base tracking link Impact's dashboard gives an
 * approved partner, ending in "?u=" — e.g.
 *   https://{tracking domain}/c/{Account ID}/{Ad ID}/{Campaign ID}?u=
 * That's Impact's standard deep-link format (documented at
 * help.impact.com, "Create a Deep Link for an Ad") — not something
 * Ticketmaster-specific, so the same mechanism would work for any other
 * Impact-network advertiser too. Verified against Impact's own docs, not
 * guessed; the exact Account/Ad/Campaign IDs are only visible inside an
 * approved partner's own Impact dashboard, so there's nothing to sanity
 * check here until that approval comes through.
 *
 * Falls back to the plain event URL — still a real, working ticket link,
 * just without commission tracking — when no prefix is configured. */
export function buildEventUrl(plainUrl, affiliatePrefix) {
  if (!affiliatePrefix || !plainUrl) return plainUrl;
  return `${affiliatePrefix}${encodeURIComponent(plainUrl)}`;
}

function parseEvent(e) {
  const localDate = e?.dates?.start?.localDate;
  if (!e?.name || !e?.url || !localDate) return null; // need the essentials to show something honest

  const venue = e._embedded?.venues?.[0];
  const priceRange = Array.isArray(e.priceRanges) ? e.priceRanges[0] : null;
  // Ticketmaster returns many crops/sizes per event — prefer a landscape
  // one at a reasonable card size, fall back to whatever's first.
  const image = (e.images || []).find(img => img.ratio === '16_9' && img.width >= 400) || (e.images || [])[0];

  return {
    source: 'ticketmaster',
    id: e.id || null,
    title: e.name,
    localDate,
    localTime: e.dates?.start?.localTime || null,
    classification: e.classifications?.[0]?.segment?.name || null,
    venueName: venue?.name || null,
    city: venue?.city?.name || null,
    priceMin: priceRange?.min ?? null,
    priceMax: priceRange?.max ?? null,
    currency: priceRange?.currency || null,
    imageUrl: image?.url || null,
    // Plain, non-commission Ticketmaster event URL — server.js wraps this
    // with buildEventUrl() (see above) using TICKETMASTER_AFFILIATE_LINK_PREFIX
    // if/once the Affiliate Program application is approved.
    url: e.url
  };
}
