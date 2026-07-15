// Booking.com affiliate search links, via the Booking.com program on
// Travelpayouts (Hotellook — the previous accommodation partner in this
// app — was fully shut down by Travelpayouts on 20 October 2025, and
// Booking.com is Travelpayouts' own recommended replacement for the
// "Hotels & Accommodation" category).
//
// Zero dependencies — like lib/hotellook.js before it, this is a pure link
// builder, not a data lookup. There's nothing to fetch or cache here.
//
// CONFIDENCE NOTE (read before relying on this in production): the query
// parameters below (ss, checkin, checkout, group_adults, aid, label) are
// Booking.com's own real, long-standing public search URL scheme — this
// exact pattern is used by essentially every Booking.com affiliate site,
// not something invented for this app. What's NOT independently confirmed
// is the Travelpayouts-specific wrinkle: Travelpayouts' own docs say deep
// links to Booking.com should come from their "Create link" tool rather
// than being hand-built, which suggests the `aid` Travelpayouts assigns
// you for Booking.com specifically may need to be read off a real
// generated link in your dashboard rather than assumed to equal your
// general TRAVELPAYOUTS_MARKER (unlike Hotellook/Aviasales, which do reuse
// that same account-wide marker). Set BOOKING_AID from whatever `aid=`
// value shows up in a link you generate yourself once connected — worth
// clicking through once after deploying and checking Travelpayouts >
// Booking.com > Statistics to confirm it's tracked, same as any new link.

const BOOKING_SEARCH_BASE = 'https://www.booking.com/searchresults.html';

/** Builds a trackable Booking.com search link for a destination + date
 * range. `destinationName` is a real place name (e.g. "Bali, Indonesia") —
 * Booking.com's own `ss` search param accepts free-text place queries.
 * Returns null (not a broken link) when the essentials are missing. */
export function buildBookingSearchUrl({ destinationName, checkIn, checkOut, aid, label, adults = 2 }) {
  if (!destinationName || !aid) return null;
  const params = new URLSearchParams({
    ss: destinationName,
    group_adults: String(adults),
    no_rooms: '1',
    aid
  });
  if (checkIn) params.set('checkin', checkIn);
  if (checkOut) params.set('checkout', checkOut);
  if (label) params.set('label', label);
  return `${BOOKING_SEARCH_BASE}?${params.toString()}`;
}
