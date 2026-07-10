// URL helpers shared by the server when it builds "search fares" links.

export function googleSearchUrl(query) {
  return 'https://www.google.com/search?q=' + encodeURIComponent(query);
}

export function tripAdvisorSearchUrl(query) {
  return 'https://www.tripadvisor.com/Search?q=' + encodeURIComponent(query);
}
