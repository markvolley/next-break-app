// Pure decision logic for the roster-based email digest — deliberately
// kept free of any I/O (no fetch, no store access, no email sending) so it
// can be unit tested without a running server. See server.js's
// runDigestSweep for how this gets wired up to real accounts/settings.
//
// Design goal: never feel like spam. A fixed "every Monday" cadence would
// be irrelevant most of the time for a roster that might be 7/7, 14/7, or
// 8/6 — so instead of a calendar schedule, this fires once per upcoming
// break, in a window shortly before it starts. That means the email
// frequency naturally matches how often someone actually has a break
// coming up, not an arbitrary marketing calendar.

// Days-until-break window that counts as "worth emailing about." 7 days
// gives enough runway to actually book something; the 3-day-wide window
// (rather than a single exact day) means a daily sweep won't miss someone
// if a run gets delayed or skipped — dedup (see hasDigestSent in
// lib/store.js) is what actually prevents a repeat, not a narrow window.
export const DIGEST_MIN_DAYS = 5;
export const DIGEST_MAX_DAYS = 7;

/**
 * Given a list of breaks (as returned by computeUpcomingBreaks, already
 * sorted soonest-first) and a function that reports whether a digest was
 * already sent for a given break key, returns the one break (if any) that
 * should get a digest email right now, or null if nothing qualifies.
 *
 * Only ever considers the very next break — a break further out isn't
 * "coming up soon" yet even if a nearer one was already emailed and
 * dismissed from this window by the time of a later sweep.
 */
export function pickEligibleBreak(breaks, alreadySent, { minDays = DIGEST_MIN_DAYS, maxDays = DIGEST_MAX_DAYS } = {}) {
  if (!Array.isArray(breaks) || !breaks.length) return null;
  const next = breaks[0];
  if (next.daysUntil == null || next.daysUntil < minDays || next.daysUntil > maxDays) return null;
  if (alreadySent(next.key)) return null;
  return next;
}

/** "starts in 6 days" / "starts tomorrow" / "starts today" — mirrors the
 * phrasing used elsewhere in the app (daysBadge in index.html) so the
 * email reads consistently with the site. */
export function digestDaysPhrase(daysUntil) {
  if (daysUntil === 0) return 'starts today';
  if (daysUntil === 1) return 'starts tomorrow';
  return `starts in ${daysUntil} days`;
}
