// Real restaurant/accommodation ratings, review counts and photos via
// Yelp's Fusion "Business Search" endpoint — free, self-serve (no billing
// required, unlike Google Places), a single API key from
// https://www.yelp.com/developers/v3/manage_app. Zero dependencies, same
// pattern as lib/ticketmaster.js and lib/viator.js.
//
// This is a genuine upgrade over lib/activities.js's OSM-sourced
// findRealRestaurants/findRealStays: OSM has real venue *names* but
// essentially no rating/review/photo data at scale, while Yelp's search
// response includes all three directly, no second per-venue call needed.
// Used as the preferred source when YELP_API_KEY is configured, falling
// back to the OSM-sourced functions when it isn't — same "try the richer
// real source first, fall back to the free real source" shape as
// buildActivitiesForSettings (Viator -> free OSM activities) in server.js.
//
// Docs: https://docs.developer.yelp.com/reference/v3_business_search
//
// CONFIDENCE NOTE: the endpoint, auth (Bearer token), and query params
// (location, term, categories, radius, limit, sort_by) are confirmed
// directly against Yelp's published API reference. The business object's
// field names (id, name, rating, review_count, image_url, url, price,
// categories[].title, coordinates) match Yelp's long-stable, widely
// documented v3 response shape, but this sandbox has no network access to
// call the live API end-to-end — worth a quick sanity check against a real
// response once YELP_API_KEY is set (normalizeBusiness below logs the raw
// shape of the first result on the first successful call, same
// dial-it-in approach used for lib/viator.js).
//
// DISPLAY REQUIREMENTS: Yelp's API terms require attributing their data
// (a visible link back to the business's Yelp page, at minimum) wherever
// it's shown — see https://www.yelp.com/developers/display_requirements
// before shipping this to real traffic. The frontend card for a
// source:'yelp' result links out to Yelp's own business page (the `url`
// field below) rather than a generic Google Maps link for exactly this
// reason.

const API_BASE = 'https://api.yelp.com/v3';

async function yelpFetch(path, { apiKey, params, fetchImpl = fetch }) {
  if (!apiKey) return null;
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null && v !== '') url.searchParams.set(k, v);
  }
  try {
    const res = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[yelp] ${path}: HTTP ${res.status} — ${body.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error(`[yelp] ${path}: fetch threw —`, e.message);
    return null;
  }
}

let loggedSampleShape = false;

function normalizeBusiness(b) {
  if (!loggedSampleShape) {
    console.log('[yelp] sample raw business keys:', Object.keys(b).join(', '));
    loggedSampleShape = true;
  }
  return {
    source: 'yelp',
    title: b.name,
    categoryLabel: b.categories?.[0]?.title || null,
    rating: b.rating ?? null,
    reviewCount: b.review_count ?? null,
    price: b.price || null, // e.g. "$$" — Yelp's own scale, not a real amount
    imageUrl: b.image_url || null,
    url: b.url || null, // Yelp's own business page — required attribution link, see module comment
    address: b.location?.address1 || null,
    suburb: b.location?.city || null
  };
}

/** Real, named businesses near a hometown with rating/review/photo data,
 * via Yelp Business Search. `categories` narrows the search (e.g.
 * "restaurants" or "hotels,guesthouses,hostels") — see Yelp's category
 * list. Returns [] (never fabricated) if no key is configured, the
 * request fails, or nothing's found — callers should fall back to a free
 * source (lib/activities.js) rather than showing an error. */
export async function findYelpBusinesses({ apiKey, hometown, categories, radiusM = 15000, limit = 6, fetchImpl = fetch }) {
  if (!apiKey || !hometown) return [];

  const json = await yelpFetch('/businesses/search', {
    apiKey, fetchImpl,
    params: { location: hometown, categories, radius: Math.min(radiusM, 40000), limit, sort_by: 'best_match' }
  });
  const businesses = json?.businesses;
  if (!Array.isArray(businesses)) return [];
  return businesses.filter(b => b?.name).map(normalizeBusiness);
}
