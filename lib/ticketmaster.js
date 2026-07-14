// Real, ticketed live events (concerts, sports, theatre, comedy) near a
// user's hometown, via Ticketmaster's Discovery API — a free, self-serve
// public API. Getting a key is immediate (no approval wait), unlike
// Ticketmaster's separate *Affiliate Program* (commission on ticket sales,
// applied for via Impact, approval required — see buildEventUrl's note
// below). Zero dependencies, same pattern as lib/weather.js and
// lib/activities.js.
//
// Commission tracking, once approved: Ticketmaster's own developer portal
// (My Apps -> your app -> Affiliate IDs -> "Profile Edit") lets you link
// your Impact Publisher ID directly to your API key. Once that's linked on
// their end, every event `url` this module returns already comes back
// commission-tracked from the API itself — no URL-wrapping needed in this
// codebase at all. buildEventUrl() below is kept only as a manual
// fallback/override for the rare case you'd want to route through a
// different tracking link instead; the default (no override configured)
// is correct and does nothing, which is exactly right once the Publisher
// ID is linked.
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

/** Optional manual override — wraps a plain event URL in an Impact.com
 * deep link (their standard format, documented at help.impact.com,
 * "Create a Deep Link for an Ad": `{tracking domain}/c/{Account ID}/
 * {Ad ID}/{Campaign ID}?u={encoded destination}`) if `affiliatePrefix` is
 * supplied. Not needed for the normal path — see the module-level comment
 * above: once your Impact Publisher ID is linked in the Ticketmaster
 * developer portal, `url` already comes back tracked and this is a no-op.
 * Kept around in case you ever want to route through a different link
 * instead of Ticketmaster's own auto-tracking. */
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
    // Whatever URL the API returns — plain today, automatically
    // commission-tracked once your Impact Publisher ID is linked in the
    // Ticketmaster developer portal (see module comment above). server.js
    // only touches this via the optional buildEventUrl() override.
    url: e.url
  };
}
