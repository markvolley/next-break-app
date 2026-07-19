// Free "things to do" fallback — Nominatim (OpenStreetMap) for geocoding a
// hometown to coordinates, Overpass (OpenStreetMap) for real nearby points
// of interest, then each result links out to Google Maps rather than OSM's
// own site (see buildGoogleMapsUrl below) for a more familiar destination.
// All free, public, and need no API key/signup, so this works even if
// Viator (lib/viator.js) is never configured, or simply has no bookable
// products for a given hometown — a real park or beach nearby beats an
// empty "no activities found" state. Zero dependencies, same pattern as
// lib/weather.js.
//
// CONFIDENCE NOTE (read before relying on this in production): Nominatim's
// and Overpass's endpoints, query syntax, and response shapes are
// long-stable, extensively documented public APIs (over a decade unchanged
// in the parts used here), not a guess — but this sandbox couldn't
// complete a live JSON fetch against either host to sanity-check a real
// response end-to-end (same limitation noted in lib/weather.js), so it's
// worth a quick check once deployed.
//
// Nominatim's usage policy requires a descriptive User-Agent and asks for
// roughly 1 request/second — fine here since a hometown is looked up once
// and then cached for a long time (see server.js), not on every request.

const NOMINATIM_API = 'https://nominatim.openstreetmap.org/search';
const OVERPASS_API = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'NextBreak/1.0 (https://nextbreak.com.au; contact: mark.volley@gmail.com)';

const SEARCH_RADIUS_M = 25000; // 25km — "near where you live," not "same postcode"

// OSM tags that reliably mean "a real, almost-always-free public place
// worth a visit" — parks, beaches, lookouts, nature reserves, gardens,
// picnic spots, monuments. Deliberately narrow and specific rather than
// the broad tourism=attraction tag, which is noisy and often paid.
const POI_QUERIES = [
  { tag: 'leisure', value: 'park', label: 'Park' },
  { tag: 'natural', value: 'beach', label: 'Beach' },
  { tag: 'tourism', value: 'viewpoint', label: 'Lookout' },
  { tag: 'leisure', value: 'nature_reserve', label: 'Nature reserve' },
  { tag: 'leisure', value: 'garden', label: 'Garden' },
  { tag: 'tourism', value: 'picnic_site', label: 'Picnic spot' },
  { tag: 'historic', value: 'monument', label: 'Monument' }
];

/** Resolves a free-text hometown (e.g. "Karratha, WA") to coordinates via
 * Nominatim. Returns null (not a guess) if it can't be geocoded. */
export async function geocodeHometown({ hometown, fetchImpl = fetch }) {
  if (!hometown) return null;
  const params = new URLSearchParams({ q: hometown, format: 'json', limit: '1', countrycodes: 'au' });
  try {
    const res = await fetchImpl(`${NOMINATIM_API}?${params.toString()}`, {
      headers: { 'User-Agent': USER_AGENT }
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!Array.isArray(json) || !json.length) return null;
    const lat = parseFloat(json[0].lat);
    const lon = parseFloat(json[0].lon);
    if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
    return { lat, lon };
  } catch (e) {
    console.error('[activities] geocode threw:', e.message);
    return null;
  }
}

// The POI *data* still comes from OpenStreetMap (free, keyless, no rate
// limit worth worrying about at this scale) — only the outbound link
// changes. Google's public "Maps Search" URL scheme
// (https://developers.google.com/maps/documentation/urls/get-started)
// needs no API key either, so this stays a zero-cost, zero-signup link
// like the rest of this module. Passing "name lat,lon" as the query (not
// just the coordinates) means Google will match it to the real place page
// — photos, reviews, opening hours — when it has one indexed, and falls
// back to just centering the map on the pin when it doesn't. That's a
// meaningfully better landing experience than OSM's bare map view, for a
// link most people will open on their phone.
function buildGoogleMapsUrl(name, lat, lon) {
  const query = `${name} @${lat},${lon}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function buildOverpassQuery(lat, lon) {
  // Both nodes and ways — plenty of real parks/beaches/reserves are mapped
  // as polygons (ways), not point nodes, and would be silently missed
  // otherwise. `out center` gives ways a usable lat/lon (their centroid).
  const clauses = POI_QUERIES.flatMap(q => [
    `node["${q.tag}"="${q.value}"](around:${SEARCH_RADIUS_M},${lat},${lon});`,
    `way["${q.tag}"="${q.value}"](around:${SEARCH_RADIUS_M},${lat},${lon});`
  ]).join('\n');
  return `[out:json][timeout:25];(\n${clauses}\n);out center 60;`;
}

/** Real, free things to do near a hometown — parks, beaches, lookouts,
 * nature reserves, etc. sourced live from OpenStreetMap. Returns []
 * (never fabricated placeholders) if geocoding fails or nothing's mapped
 * nearby. */
export async function findFreeActivities({ hometown, limit = 6, fetchImpl = fetch }) {
  const coords = await geocodeHometown({ hometown, fetchImpl });
  if (!coords) return [];

  try {
    const res = await fetchImpl(OVERPASS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'User-Agent': USER_AGENT },
      body: buildOverpassQuery(coords.lat, coords.lon)
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[activities] overpass HTTP ${res.status} — ${body.slice(0, 200)}`);
      return [];
    }
    const json = await res.json();
    const elements = Array.isArray(json.elements) ? json.elements : [];

    const seen = new Set();
    const results = [];
    for (const el of elements) {
      const name = el.tags?.name;
      if (!name || seen.has(name)) continue; // unnamed nodes aren't useful to show; dedupe by name
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (lat == null || lon == null) continue;
      seen.add(name);
      const match = POI_QUERIES.find(q => el.tags?.[q.tag] === q.value);
      results.push({
        source: 'free',
        title: name,
        category: match?.label || 'Local spot',
        mapUrl: buildGoogleMapsUrl(name, lat, lon)
      });
    }
    return results.slice(0, limit);
  } catch (e) {
    console.error('[activities] overpass fetch threw:', e.message);
    return [];
  }
}

// Restaurants tab: real restaurant NAMES near a hometown, sourced the same
// free/keyless way as findFreeActivities above — this is deliberately not
// live availability or bookability (OpenTable's real listings API needs
// its own partner approval, see lib/opentable.js), just real, named,
// currently-mapped restaurants, which is all "here are some options near
// you" needs. A tighter radius than the parks/beaches search above (15km
// vs 25km) since restaurants are dense in any city centre and a wider net
// mostly just adds more of the same suburb.
const RESTAURANT_SEARCH_RADIUS_M = 15000;
const RESTAURANT_LIMIT_RAW = 40; // pulled from Overpass before shuffling/slicing to `limit`, so repeat lookups for the same hometown don't always show the exact same 6

function buildRestaurantOverpassQuery(lat, lon) {
  return `[out:json][timeout:25];(
    node["amenity"="restaurant"](around:${RESTAURANT_SEARCH_RADIUS_M},${lat},${lon});
    way["amenity"="restaurant"](around:${RESTAURANT_SEARCH_RADIUS_M},${lat},${lon});
  );out center ${RESTAURANT_LIMIT_RAW};`;
}

// OSM's cuisine tag is free text, e.g. "italian", "pizza;burger" (can be
// semicolon-separated), sometimes missing entirely — takes the first value
// and turns "modern_australian" into "Modern australian" for display.
function formatCuisine(raw) {
  if (!raw) return null;
  const first = raw.split(';')[0].trim().replace(/_/g, ' ');
  if (!first) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// Simple seeded shuffle (mulberry32) rather than Math.random(), so the same
// hometown gives a different-looking sample across separate cache refreshes
// without needing true randomness — good enough for "here are a few
// examples," not trying to be cryptographically fair.
function seededShuffle(arr, seed) {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  return h;
}

/** Real, named restaurants near a hometown, sourced live from OpenStreetMap
 * — not live availability or bookable, just real places worth considering.
 * Returns [] (never fabricated) if geocoding fails or nothing's mapped
 * nearby. `seed` controls which subset of a larger real result set gets
 * shown (see seededShuffle above) — pass something that changes over time
 * (e.g. a cache-refresh timestamp) for variety across refreshes, or leave
 * it out for a stable sample. */
export async function findRealRestaurants({ hometown, limit = 6, seed, fetchImpl = fetch }) {
  const coords = await geocodeHometown({ hometown, fetchImpl });
  if (!coords) return [];

  try {
    const res = await fetchImpl(OVERPASS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'User-Agent': USER_AGENT },
      body: buildRestaurantOverpassQuery(coords.lat, coords.lon)
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[activities] overpass (restaurants) HTTP ${res.status} — ${body.slice(0, 200)}`);
      return [];
    }
    const json = await res.json();
    const elements = Array.isArray(json.elements) ? json.elements : [];

    const seen = new Set();
    const results = [];
    for (const el of elements) {
      const name = el.tags?.name;
      if (!name || seen.has(name)) continue;
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (lat == null || lon == null) continue;
      seen.add(name);
      results.push({
        source: 'osm',
        title: name,
        cuisine: formatCuisine(el.tags?.cuisine),
        mapUrl: buildGoogleMapsUrl(name, lat, lon)
      });
    }

    const seedNum = seed != null ? hashString(String(seed) + hometown) : hashString(hometown);
    return seededShuffle(results, seedNum).slice(0, limit);
  } catch (e) {
    console.error('[activities] overpass (restaurants) fetch threw:', e.message);
    return [];
  }
}
