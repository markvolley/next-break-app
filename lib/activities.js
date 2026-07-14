// Free "things to do" fallback via OpenStreetMap — Nominatim for geocoding
// a hometown to coordinates, Overpass for real nearby points of interest.
// Both are free, public, and need no API key/signup, so this works even
// if Viator (lib/viator.js) is never configured, or simply has no bookable
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
        mapUrl: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`
      });
    }
    return results.slice(0, limit);
  } catch (e) {
    console.error('[activities] overpass fetch threw:', e.message);
    return [];
  }
}
