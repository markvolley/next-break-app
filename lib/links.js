// URL helpers — currently unused/dormant. These built non-affiliate
// "search on Google/TripAdvisor" links for the things-to-do section, but
// that fallback was removed so all things-to-do traffic goes through the
// Viator affiliate link instead (see lib/viator.js). Kept here in case a
// non-affiliate fallback link is ever wanted again.

export function googleSearchUrl(query) {
  return 'https://www.google.com/search?q=' + encodeURIComponent(query);
}

export function tripAdvisorSearchUrl(query) {
  return 'https://www.tripadvisor.com/Search?q=' + encodeURIComponent(query);
}
