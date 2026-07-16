// End-to-end test of the digest infrastructure that doesn't require real
// network calls: unsubscribe tokens, the /api/unsubscribe endpoint, and the
// send-dedup log, all against a real running server with an isolated
// scratch data file.
//
// Deliberately NOT covered here: the full maybeSendDigestForAccount path
// with a real hometown set, since that always falls through to
// lib/activities.js's free-activities lookup (real Nominatim/Overpass
// calls, no way to disable via env config, same caveat already noted in
// lib/activities.js itself) whenever deals/events are empty — which they
// always are in this test env since TRAVELPAYOUTS_TOKEN/TICKETMASTER_API_KEY
// aren't set. That full path was checked manually instead (see the commit
// message / PR notes) rather than baked into the automated suite, to keep
// this suite fast and non-flaky.
//
// Run with: node test_digest_e2e.mjs

// NOTE: everything that touches DATA_FILE must be a dynamic import()
// placed after the assignment below, not a static `import ... from`. A
// static import is hoisted above all other top-level code (including this
// assignment) regardless of where it's textually written, which would make
// lib/store.js read process.env.DATA_FILE before it's set and silently
// fall back to the real project data.json instead of this scratch file.
process.env.DATA_FILE = '/tmp/next-break-test-digest-data-' + Date.now() + '.json';
const { server } = await import('./server.js');
const { getOrCreateUnsubscribeToken, getEmailByUnsubscribeToken, recordDigestSent, hasDigestSent } = await import('./lib/store.js');
import assert from 'node:assert';

const PORT = 34602;
await new Promise(resolve => server.listen(PORT, resolve));
const BASE = `http://localhost:${PORT}`;

async function req(pathPart, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(BASE + pathPart, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  // A response body can only be read once — read as text first (works for
  // both the JSON API responses and the plain-HTML unsubscribe page), then
  // try to parse it as JSON on top of that, rather than racing two reads.
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON — that's fine, callers use .text for those */ }
  return { status: res.status, json, text };
}

// 1. Sign up an account with marketing opt-in on.
let r = await req('/api/auth/signup', {
  method: 'POST',
  body: { email: 'roster@example.com', password: 'hunter22', acceptedTerms: true, marketingOptIn: true }
});
assert.strictEqual(r.status, 200, JSON.stringify(r.json));

// 2. getOrCreateUnsubscribeToken is idempotent — same token on repeat calls,
// not a fresh one every time (a real email might be re-sent, and the link
// in an older email must keep working).
const token1 = getOrCreateUnsubscribeToken('roster@example.com');
const token2 = getOrCreateUnsubscribeToken('roster@example.com');
assert.ok(token1 && token1.length >= 32, 'token should be a real random string, not empty: ' + token1);
assert.strictEqual(token1, token2, 'the same account should keep the same unsubscribe token across calls');

// 3. An unknown email has no token to create.
assert.strictEqual(getOrCreateUnsubscribeToken('nobody@example.com'), null);

// 4. Token -> email lookup round-trips correctly.
assert.strictEqual(getEmailByUnsubscribeToken(token1), 'roster@example.com');
assert.strictEqual(getEmailByUnsubscribeToken('not-a-real-token'), null);

// 5. GET /api/unsubscribe with a bad/missing token -> 400, doesn't touch any account.
r = await req('/api/unsubscribe');
assert.strictEqual(r.status, 400);
r = await req('/api/unsubscribe?token=garbage');
assert.strictEqual(r.status, 400);

// 6. GET /api/unsubscribe with the real token -> 200, and actually flips
// marketingOptIn off (checked via a real login + profile fetch, not by
// reaching into the store directly, to prove the HTTP endpoint itself did
// the work end to end).
r = await req('/api/unsubscribe?token=' + token1);
assert.strictEqual(r.status, 200, JSON.stringify(r.text));
assert.ok(r.text.toLowerCase().includes('unsubscribed'), 'the confirmation page should say so: ' + r.text);

// req() above doesn't expose response headers, and the session cookie only
// comes back via Set-Cookie — fetch directly here to grab it.
const loginRes = await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'roster@example.com', password: 'hunter22' })
});
const sessionCookie = /nb_session=[^;]+/.exec(loginRes.headers.get('set-cookie') || '')?.[0];
const profileRes = await fetch(BASE + '/api/profile', { headers: { Cookie: sessionCookie } });
const profile = await profileRes.json();
assert.strictEqual(profile.marketingOptIn, false, 'unsubscribing via the token link should turn marketingOptIn off: ' + JSON.stringify(profile));

// 7. Digest send-dedup: nothing recorded yet for a fresh break key.
assert.strictEqual(hasDigestSent('roster@example.com', '2026-08-01_2026-08-07'), false);
recordDigestSent('roster@example.com', '2026-08-01_2026-08-07');
assert.strictEqual(hasDigestSent('roster@example.com', '2026-08-01_2026-08-07'), true, 'should be marked sent immediately after recording');
// A different break key for the same account is independent.
assert.strictEqual(hasDigestSent('roster@example.com', '2026-09-01_2026-09-07'), false);
// A different account with the same break key is also independent.
assert.strictEqual(hasDigestSent('someone-else@example.com', '2026-08-01_2026-08-07'), false);

console.log('ALL DIGEST E2E TESTS PASSED');
server.close();
process.exit(0);
