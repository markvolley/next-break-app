// Real "find a stay" link-out to Booking.com, for the Staycation tab — a
// local hotel/getaway booked for a specific upcoming break, as opposed to
// the flights tab (travel away) or restaurants tab (dining out any night).
//
// Airbnb has no viable path here: its public affiliate program closed in
// 2021, and what remains is an invite-only "Creators" program with no
// public signup — not something to build against.
//
// Booking.com's real listings/Demand API needs a formal partner
// application and business review (weeks, not guaranteed) — same story as
// OpenTable's Partner API, see lib/opentable.js. Unlike OpenTable though,
// Booking.com's own search page takes free-text location + dates directly
// via URL params, so — unlike the OpenTable metro-page situation — no
// curated city list is needed at all: ANY hometown resolves to a real,
// working, pre-filled search page. Zero dependencies, no network call.
//
// Commission tracking: Booking.com's Affiliate Partner Program (for AU
// partners, applied for via Awin) is a separate, faster-approval track
// from the Demand API. Once accepted, set BOOKING_AFFILIATE_LINK_PREFIX to
// whatever tracking link/prefix Awin gives you and buildStayUrl below
// wraps the plain URL automatically — until then it's just a plain
// (untracked) but still real, working link.

const BASE = 'https://www.booking.com/searchresults.html';

/** Wraps a plain Booking.com URL in an affiliate tracking prefix, if
 * configured — a no-op until you've been accepted into Booking.com's
 * affiliate program (via Awin) and set one. */
export function buildStayUrl(plainUrl, affiliatePrefix) {
  if (!affiliatePrefix) return plainUrl;
  return `${affiliatePrefix}${encodeURIComponent(plainUrl)}`;
}

/** Real link-out to Booking.com's search results for a hometown, ideally
 * pre-filled with a specific break's actual dates so the link is
 * genuinely useful rather than a generic "search here" — never
 * fabricated, always a real working page. Returns null only when there's
 * no hometown to build a link for at all. */
export function findStayLink({ hometown, checkin, checkout, affiliatePrefix }) {
  if (!hometown) return null;

  const params = new URLSearchParams({ ss: hometown.trim(), group_adults: '2', no_rooms: '1' });
  if (checkin) params.set('checkin', checkin);
  if (checkout) params.set('checkout', checkout);

  const plainUrl = `${BASE}?${params.toString()}`;
  return {
    source: 'booking',
    cityLabel: hometown.split(',')[0].trim(),
    datesApplied: Boolean(checkin && checkout),
    url: buildStayUrl(plainUrl, affiliatePrefix)
  };
}
