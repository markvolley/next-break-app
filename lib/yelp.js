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

// Higher rating first, so the venues shown are the best-reviewed ones
// Yelp knows about, not just whatever order its own "best_match" relevance
// ranking happened to return. Ties broken by review count — a 5.0 from 400
// reviews is a much stronger signal than a 5.0 from 2, so it's ranked
// above it rather than left to coin-flip ordering. Anything still tied
// after that (including businesses with no rating at all) keeps Yelp's own
// best_match relative order, since Array.prototype.sort is stable.
function sortByRating(businesses) {
  return [...businesses].sort((a, b) => {
    if (a.rating !== b.rating) return (b.rating ?? -1) - (a.rating ?? -1);
    return (b.reviewCount ?? 0) - (a.reviewCount ?? 0);
  });
}

/** Real, named businesses near a hometown with rating/review/photo data,
 * via Yelp Business Search, sorted best-rated first (see sortByRating).
 * `categories` narrows the search (e.g. "restaurants" or
 * "hotels,guesthouses,hostels") — see Yelp's category list. Returns []
 * (never fabricated) if no key is configured, the request fails, or
 * nothing's found — callers should fall back to a free source
 * (lib/activities.js) rather than showing an error. */
export async function findYelpBusinesses({ apiKey, hometown, categories, radiusM = 15000, limit = 6, fetchImpl = fetch }) {
  if (!apiKey || !hometown) return [];

  // Ask Yelp for more candidates than we'll actually show (capped at
  // Yelp's own per-request max of 50) so sortByRating below has a real
  // pool of options to prioritise from — asking for exactly `limit`
  // already sorted by Yelp's own best_match would lock in that order
  // before we ever get a chance to re-rank by rating ourselves.
  const rawLimit = Math.min(Math.max(limit * 3, 20), 50);
  const json = await yelpFetch('/businesses/search', {
    apiKey, fetchImpl,
    params: { location: hometown, categories, radius: Math.min(radiusM, 40000), limit: rawLimit, sort_by: 'best_match' }
  });
  const businesses = json?.businesses;
  if (!Array.isArray(businesses)) return [];
  const normalized = businesses.filter(b => b?.name).map(normalizeBusiness);
  return sortByRating(normalized).slice(0, limit);
}
