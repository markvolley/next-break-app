// Hotellook (Travelpayouts' hotel booking product) affiliate search links.
// Zero dependencies — this is a pure link builder, not a data lookup like
// lib/travelpayouts.js (Aviasales flights) or lib/ticketmaster.js. There's
// nothing to fetch or cache here, so this file is a single small function.
//
// CONFIDENCE NOTE (read before relying on this in production): Travelpayouts'
// own docs confirm deep links to Hotellook route through search.hotellook.com
// by default, and are tracked with the same account-wide `marker` parameter
// used everywhere else in this app (see
// https://support.travelpayouts.com/hc/en-us/articles/360027634052). The
// destination/checkIn/checkOut/adults query parameters below match the
// pattern Hotellook itself uses in its own affiliate examples. What's NOT
// independently confirmed here is a live click-through, since — unlike
// lib/travelpayouts.js, which gets a ready-made `link` fragment back from a
// real Aviasales API call — there's no public Data API for Hotellook that
// hands back a guaranteed-correct URL per search. Worth clicking through
// once after deploying and checking it shows up under Hotellook >
// Statistics in the Travelpayouts dashboard, the same way you'd sanity-check
// any new affiliate link before trusting it.
//
// Requires actually joining the Hotellook program in the Travelpayouts
// dashboard first (Programs > browse/search "Hotellook" > Connect) — the
// marker alone doesn't earn a commission on a program you haven't joined.

const HOTELLOOK_SEARCH_BASE = 'https://search.hotellook.com/hotels';

/** Builds a trackable Hotellook search link for a destination + date range.
 * `destinationName` is a real place name (e.g. "Bali, Indonesia") — free-
 * text, not an internal Hotellook location ID, since there's no API here to
 * resolve one. Returns null (not a broken link) when the essentials are
 * missing. */
export function buildHotelSearchUrl({ destinationName, checkIn, checkOut, marker, adults = 2 }) {
  if (!destinationName || !marker) return null;
  const params = new URLSearchParams({
    destination: destinationName,
    adults: String(adults),
    marker
  });
  if (checkIn) params.set('checkIn', checkIn);
  if (checkOut) params.set('checkOut', checkOut);
  return `${HOTELLOOK_SEARCH_BASE}?${params.toString()}`;
}
