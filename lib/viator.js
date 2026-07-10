// Real "things to do" listings via the Viator Partner API (Viator is owned
// by TripAdvisor), plus trackable affiliate booking links. Zero
// dependencies — plain fetch, same pattern as lib/travelpayouts.js.
//
// Docs: https://docs.viator.com/partner-api/affiliate/technical/
//
// CONFIDENCE NOTE (read before relying on this in production): the
// endpoints, auth method, destination-taxonomy fields, and the standard
// {data, success, errorMessage} response envelope below are all confirmed
// against Viator's published docs. The individual *product* fields inside
// a /search/products result (title, image, price, rating, booking URL)
// are NOT confirmed — Viator's docs didn't expose a full sample response
// for that endpoint at the time this was written, and this sandbox has no
// network access to call the live API and check. `normalizeProduct` below
// tries several plausible field-name variants defensively, and
// `findActivities` logs the raw shape of the first result so the mapping
// can be corrected quickly once you have a real API key — same process we
// used to dial in the Travelpayouts flight integration.

const API_BASE = 'https://viatorapi.viator.com/service';

async function viatorFetch(path, { apiKey, fetchImpl = fetch, method = 'GET', body } = {}) {
  const url = new URL(`${API_BASE}${path}`);
  url.searchParams.set('apiKey', apiKey);
  let res;
  try {
    res = await fetchImpl(url.toString(), {
      method,
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en-US',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    console.error(`[viator] ${path}: fetch threw —`, e.message);
    return null;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[viator] ${path}: HTTP ${res.status} — ${text.slice(0, 200)}`);
    return null;
  }
  const json = await res.json().catch(() => null);
  if (!json || json.success === false) {
    console.error(`[viator] ${path}: API error — ${JSON.stringify(json?.errorMessage || json).slice(0, 200)}`);
    return null;
  }
  return json;
}

// In-memory cache of the full destination list — it's large (thousands of
// entries) and changes rarely, so refetching per-request would be wasteful.
let destCache = null; // { byName: Map<lowercase name, destId>, fetchedAt }
const DEST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function loadDestinations({ apiKey, fetchImpl }) {
  if (destCache && Date.now() - destCache.fetchedAt < DEST_CACHE_TTL_MS) {
    return destCache.byName;
  }
  const json = await viatorFetch('/taxonomy/destinations', { apiKey, fetchImpl });
  const list = Array.isArray(json?.data) ? json.data : [];
  const byName = new Map();
  for (const d of list) {
    if (d.selectable === false) continue; // country/region nodes aren't directly searchable
    const name = d.destinationName;
    const id = d.destinationId;
    if (name && id != null) byName.set(String(name).toLowerCase(), id);
  }
  destCache = { byName, fetchedAt: Date.now() };
  return byName;
}

/**
 * Resolves a free-text hometown (e.g. "Karratha, WA") to a Viator
 * destination ID. Tries an exact match first, then falls back to matching
 * just the city portion (text before the first comma) against the start of
 * each destination name — hometown text won't always exactly match
 * Viator's naming.
 */
export async function resolveDestinationId({ apiKey, hometown, fetchImpl = fetch }) {
  if (!apiKey || !hometown) return null;
  const byName = await loadDestinations({ apiKey, fetchImpl });
  if (!byName.size) return null;

  const full = hometown.trim().toLowerCase();
  if (byName.has(full)) return byName.get(full);

  const cityOnly = full.split(',')[0].trim();
  for (const [name, id] of byName) {
    if (name === cityOnly || name.startsWith(cityOnly) || cityOnly.startsWith(name)) return id;
  }
  return null;
}

export function buildActivityUrl(productUrl, { pid, mcid, campaign = 'nextbreak' } = {}) {
  if (!productUrl) return null;
  if (!pid) return productUrl;
  const params = new URLSearchParams({ pid, medium: 'api' });
  if (mcid) params.set('mcid', String(mcid));
  if (campaign) params.set('campaign', campaign);
  const sep = productUrl.includes('?') ? '&' : '?';
  return `${productUrl}${sep}${params.toString()}`;
}

// Best-effort mapping from a raw Viator product object to the shape the
// frontend expects — see the CONFIDENCE NOTE at the top of this file.
function normalizeProduct(p, { pid, mcid, currency }) {
  const title = p.title || p.name || p.productName || 'Untitled activity';
  const image = p.thumbnailHiResURL || p.thumbnailURL || p.primaryPhotoURL || p.image || null;
  const rating = p.reviews?.combinedAverageRating ?? p.rating ?? null;
  const reviewCount = p.reviews?.totalReviews ?? p.reviewCount ?? null;
  const price = p.pricing?.summary?.fromPrice ?? p.price?.recommendedRetailPrice ?? p.fromPrice ?? null;
  const duration = p.duration?.description || p.durationText || null;
  const productUrl = p.productUrl || p.webURL || p.url || null;

  return {
    source: 'real',
    title,
    image,
    rating,
    reviewCount,
    price,
    currency,
    duration,
    bookUrl: buildActivityUrl(productUrl, { pid, mcid })
  };
}

/**
 * Looks up real bookable activities for a hometown via Viator's product
 * search. Returns [] (not an error) when there's no API key, no
 * destination match, or no products — callers should show an honest
 * "nothing found" state rather than fabricating listings.
 */
export async function findActivities({ apiKey, pid, mcid, hometown, currency = 'AUD', limit = 6, fetchImpl = fetch }) {
  if (!apiKey || !hometown) return [];

  const destId = await resolveDestinationId({ apiKey, hometown, fetchImpl });
  if (destId == null) {
    console.log(`[viator] no destination match for hometown "${hometown}"`);
    return [];
  }

  const json = await viatorFetch('/search/products', {
    apiKey, fetchImpl, method: 'POST',
    body: { destId, topX: `1-${limit}`, currencyCode: currency, sortOrder: 'TOP_SELLERS' }
  });
  const products = Array.isArray(json?.data) ? json.data : [];
  console.log(`[viator] destId ${destId} ("${hometown}"): ${products.length} products returned`);
  if (!products.length) return [];

  if (products[0]) {
    // One-time-per-lookup shape log — delete once the field mapping above
    // is confirmed against a real response.
    console.log('[viator] sample raw product keys:', Object.keys(products[0]).join(', '));
  }

  return products.slice(0, limit).map(p => normalizeProduct(p, { pid, mcid, currency }));
}
