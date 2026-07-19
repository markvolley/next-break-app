// Real "book a table" link-out to OpenTable Australia, for the Restaurants
// tab. Unlike Ticketmaster (Discovery API) or Viator (Partner API), OpenTable
// doesn't offer a simple self-serve public API for listing individual
// restaurants — their developer portal is a partner-approval "become a
// booking channel" process aimed at full reservation integrations, not
// lightweight discovery, and there's no guarantee (or timeline) an app this
// size gets approved. Rather than wait on that, or fabricate restaurant
// cards, this links straight to OpenTable's own real, live search-results
// page for the user's hometown — the same honest "real search results, not
// invented listings" pattern already used for flight backfill cards. Zero
// dependencies, no network call needed at all.
//
// Commission tracking: OpenTable runs its own affiliate program, applied for
// through their own Partner Portal (dev.opentable.com — "Become a Partner"),
// NOT through Impact like Ticketmaster/Quandoo. Once accepted, whatever
// tracking link or parameter they give you goes in
// OPENTABLE_AFFILIATE_LINK_PREFIX and buildRestaurantUrl below will wrap the
// plain URL in it automatically. Until then this env var is simply unset and
// the plain (untracked) OpenTable URL is used — a real, working link either
// way.

const BASE = 'https://www.opentable.com.au';

// A curated set of AU metro pages, confirmed directly against
// opentable.com.au (checked 2026-07). Not exhaustive — Australia has
// hundreds of towns OpenTable doesn't have a dedicated metro page for — so
// anything not matched here falls back to a state page where possible, or
// the OpenTable AU homepage otherwise, which still lets the user search
// themselves. Never fabricated, always a real, working page.
const CITY_SLUGS = {
  'sydney': 'metro/sydney-restaurants',
  'melbourne': 'metro/melbourne-restaurants',
  'perth': 'metro/perth-restaurants',
  'brisbane': 'metro/south-east-queensland-restaurants',
  'adelaide': 'metro/adelaide-restaurants',
  'canberra': 'metro/canberra-restaurants',
  'hobart': 'metro/tasmania-restaurants',
  'launceston': 'metro/tasmania-restaurants',
  'gold coast': 'metro/gold-coast',
  'sunshine coast': 'metro/sunshine-coast',
  'cairns': 'metro/tropical-north-queensland',
  'toowoomba': 'metro/queensland'
};

// State/territory-level fallback for anywhere not in CITY_SLUGS above —
// most useful for FIFO/mining towns (Karratha, Port Hedland, Newman, etc.)
// that don't have their own OpenTable metro page but still land on a real,
// relevant page instead of the bare homepage.
const STATE_SLUGS = [
  { match: ['western australia', ' wa', ',wa'], slug: 'metro/western-australia' },
  { match: ['victoria', ' vic', ',vic'], slug: 'metro/victoria' },
  { match: ['queensland', ' qld', ',qld'], slug: 'metro/queensland' },
  { match: ['new south wales', ' nsw', ',nsw'], slug: 'metro/au/new-south-wales-restaurants' },
  { match: ['south australia', ' sa', ',sa'], slug: 'metro/south-australia' },
  { match: ['tasmania', ' tas', ',tas'], slug: 'metro/tasmania-restaurants' }
];

function matchCitySlug(hometownLower) {
  for (const city in CITY_SLUGS) {
    if (hometownLower.includes(city)) return CITY_SLUGS[city];
  }
  for (const { match, slug } of STATE_SLUGS) {
    if (match.some(m => hometownLower.includes(m))) return slug;
  }
  return null;
}

/** Wraps a plain OpenTable URL in an affiliate tracking prefix, if
 * configured — a no-op (returns the plain URL unchanged) until you've been
 * accepted into OpenTable's affiliate program and set one. */
export function buildRestaurantUrl(plainUrl, affiliatePrefix) {
  if (!affiliatePrefix) return plainUrl;
  return `${affiliatePrefix}${encodeURIComponent(plainUrl)}`;
}

/** Real link-out to OpenTable for a hometown — never fabricated, always
 * either a specific city/state search page or the OpenTable AU homepage.
 * Returns null only when there's no hometown to build a link for at all. */
export function findRestaurantLink({ hometown, affiliatePrefix }) {
  if (!hometown) return null;

  const lower = hometown.trim().toLowerCase();
  const slug = matchCitySlug(lower);
  const plainUrl = slug ? `${BASE}/${slug}` : BASE;

  return {
    source: 'opentable',
    cityLabel: hometown.split(',')[0].trim(),
    matched: Boolean(slug),
    url: buildRestaurantUrl(plainUrl, affiliatePrefix)
  };
}
