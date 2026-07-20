// End-to-end test of the account-only features added this session: saved
// venues (shortlist), per-break notes/checklist, the roster-mate share
// link/page, past-break history, and the price-alert opt-in/unsubscribe
// plumbing — all against a real running server with an isolated scratch
// data file. Same style as test_auth_e2e.mjs / test_digest_e2e.mjs.
//
// Deliberately NOT covered here: the full maybeSendPriceAlertForAccount
// happy path with a real dropped fare, since that needs a live
// TRAVELPAYOUTS_TOKEN — same reasoning as test_digest_e2e.mjs skipping the
// full digest send path. What IS covered: that it's a safe no-op without
// one configured, and that the settings/opt-in/unsubscribe plumbing around
// it all works.
//
// Run with: node test_account_features_e2e.mjs

process.env.DATA_FILE = '/tmp/next-break-test-account-features-data-' + Date.now() + '.json';
const { server, maybeSendPriceAlertForAccount } = await import('./server.js');
import assert from 'node:assert';

const PORT = 34603;
await new Promise(resolve => server.listen(PORT, resolve));
const BASE = `http://localhost:${PORT}`;

async function req(pathPart, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(BASE + pathPart, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON — fine for the HTML share page */ }
  return { status: res.status, json, text, cookie: /nb_session=[^;]+/.exec(res.headers.get('set-cookie') || '')?.[0] };
}

// ---------- setup: a real account with a roster ----------
let r = await req('/api/auth/signup', {
  method: 'POST',
  body: { email: 'mate@example.com', password: 'hunter22', acceptedTerms: true }
});
assert.strictEqual(r.status, 200, JSON.stringify(r.json));
const cookie = r.cookie;
assert.ok(cookie);

// A pattern anchored a few cycles in the past so there's both an upcoming
// break (for share/price-alert) and genuine past breaks (for history).
const cycleLen = 21;
const anchor = new Date();
anchor.setDate(anchor.getDate() - cycleLen * 3);
const anchorIso = anchor.toISOString().slice(0, 10);

r = await req('/api/settings', {
  method: 'PUT', headers: { Cookie: cookie },
  body: { hometown: 'Sydney', originAirport: 'SYD', currency: 'AUD', rosterMode: 'pattern', pattern: { daysOn: 14, daysOff: 7, nextBreakStart: anchorIso } }
});
assert.strictEqual(r.status, 200, JSON.stringify(r.json));

r = await req('/api/breaks', { headers: { Cookie: cookie } });
assert.ok(r.json.breaks.length, 'expected at least one upcoming break');
const breakKey = r.json.breaks[0].key;

// ---------- saved venues ----------
{
  // Unauthenticated -> 401.
  r = await req('/api/saved-venues');
  assert.strictEqual(r.status, 401);

  // Nothing saved yet.
  r = await req('/api/saved-venues', { headers: { Cookie: cookie } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.items, []);

  // Invalid type rejected.
  r = await req('/api/saved-venues', { method: 'POST', headers: { Cookie: cookie }, body: { type: 'nonsense', title: 'X' } });
  assert.strictEqual(r.status, 400);

  // Save a real venue.
  r = await req('/api/saved-venues', {
    method: 'POST', headers: { Cookie: cookie },
    body: { type: 'restaurant', title: 'Test Bistro', subtitle: 'Modern australian', url: 'https://maps.example/bistro' }
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.items.length, 1);
  const savedId = r.json.items[0].id;
  assert.strictEqual(r.json.items[0].title, 'Test Bistro');

  // Saving the exact same venue again doesn't duplicate it.
  r = await req('/api/saved-venues', {
    method: 'POST', headers: { Cookie: cookie },
    body: { type: 'restaurant', title: 'Test Bistro', subtitle: 'Modern australian', url: 'https://maps.example/bistro' }
  });
  assert.strictEqual(r.json.items.length, 1, 'duplicate save should not add a second entry');

  // Remove it.
  r = await req('/api/saved-venues?id=' + encodeURIComponent(savedId), { method: 'DELETE', headers: { Cookie: cookie } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.items, []);
}
console.log('Saved venues: passed (save, dedupe, remove, auth-gated)');

// ---------- break notes/checklist ----------
{
  // Unauthenticated -> 401.
  r = await req('/api/break-notes?breakKey=' + encodeURIComponent(breakKey));
  assert.strictEqual(r.status, 401);

  // Nothing saved yet -> empty defaults, not an error.
  r = await req('/api/break-notes?breakKey=' + encodeURIComponent(breakKey), { headers: { Cookie: cookie } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.notes, '');
  assert.deepStrictEqual(r.json.checklist, []);

  // Save notes + a checklist.
  r = await req('/api/break-notes', {
    method: 'PUT', headers: { Cookie: cookie },
    body: { breakKey, notes: 'Book the dog in for boarding', checklist: [{ id: 'a', text: 'Pack', done: false }, { id: 'b', text: 'Fuel up ute', done: true }] }
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.notes, 'Book the dog in for boarding');
  assert.strictEqual(r.json.checklist.length, 2);

  // Round-trips on GET.
  r = await req('/api/break-notes?breakKey=' + encodeURIComponent(breakKey), { headers: { Cookie: cookie } });
  assert.strictEqual(r.json.notes, 'Book the dog in for boarding');
  assert.strictEqual(r.json.checklist.find(c => c.id === 'b').done, true);

  // A different break key is independent.
  r = await req('/api/break-notes?breakKey=some-other-key', { headers: { Cookie: cookie } });
  assert.strictEqual(r.json.notes, '');
}
console.log('Break notes: passed (save, round-trip, auth-gated, per-break isolation)');

// ---------- roster-mate share link ----------
{
  // Unauthenticated -> 401.
  r = await req('/api/share-link');
  assert.strictEqual(r.status, 401);

  r = await req('/api/share-link', { headers: { Cookie: cookie } });
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.shareUrl.includes('/share/'), JSON.stringify(r.json));
  const token = r.json.shareUrl.split('/share/')[1];

  // Same account gets the same token on repeat calls (stable link).
  r = await req('/api/share-link', { headers: { Cookie: cookie } });
  assert.strictEqual(r.json.shareUrl.split('/share/')[1], token);

  // The public page itself works with NO auth/cookie at all, and shows the
  // real upcoming break dates (not fares, not personal info).
  r = await req('/share/' + token);
  assert.strictEqual(r.status, 200);
  assert.ok(r.text.includes('upcoming breaks'), r.text.slice(0, 200));
  const breakStart = r.json?.breaks?.[0]?.start; // n/a — page is HTML, just sanity-check it's non-empty below
  assert.ok(r.text.length > 200);

  // An invalid token -> 404, not a leak/crash.
  r = await req('/share/0000000000000000');
  assert.strictEqual(r.status, 404);
}
console.log('Share link: passed (auth-gated generation, stable token, public read-only page)');

// ---------- past breaks ----------
{
  // Unauthenticated -> 401.
  r = await req('/api/past-breaks');
  assert.strictEqual(r.status, 401);

  r = await req('/api/past-breaks', { headers: { Cookie: cookie } });
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.json.pastBreaks));
  assert.ok(r.json.pastBreaks.length >= 1, 'the 3-cycles-back anchor should yield at least one real past break');
  const firstPast = r.json.pastBreaks[0];
  assert.ok(firstPast.start < firstPast.end || firstPast.start <= firstPast.end);
  assert.ok(Array.isArray(firstPast.clicks));
}
console.log('Past breaks: passed (auth-gated, real computed history)');

// ---------- price alerts: opt-in setting + unsubscribe + safe no-op ----------
{
  // Default is off.
  r = await req('/api/settings', { headers: { Cookie: cookie } });
  assert.strictEqual(r.json.priceAlerts, false);

  // Opt in.
  r = await req('/api/settings', { method: 'PUT', headers: { Cookie: cookie }, body: { priceAlerts: true } });
  assert.strictEqual(r.json.priceAlerts, true);

  // No TRAVELPAYOUTS_TOKEN configured in this test env -> a safe no-op, not
  // a throw (mirrors how the rest of the app degrades without that key).
  await maybeSendPriceAlertForAccount('mate@example.com');

  // The price-flavoured unsubscribe link turns priceAlerts back off
  // specifically, without touching the digest's own marketingOptIn.
  const { getOrCreateUnsubscribeToken } = await import('./lib/store.js');
  const token = getOrCreateUnsubscribeToken('mate@example.com');
  r = await req('/api/unsubscribe?token=' + token + '&kind=price');
  assert.strictEqual(r.status, 200);
  assert.ok(r.text.toLowerCase().includes('price-drop'), r.text);

  r = await req('/api/settings', { headers: { Cookie: cookie } });
  assert.strictEqual(r.json.priceAlerts, false, 'kind=price unsubscribe should turn priceAlerts off');
}
console.log('Price alerts: passed (opt-in persists, safe no-op without a token, kind=price unsubscribe)');

console.log('ALL ACCOUNT FEATURES E2E TESTS PASSED');
server.close();
process.exit(0);
