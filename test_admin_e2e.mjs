// End-to-end test of marketing opt-in + the admin dashboard API, against a
// real running server instance with an isolated scratch data file.
// Run with: ADMIN_EMAIL=admin@example.com node test_admin_e2e.mjs
//
// DATA_FILE and ADMIN_EMAIL must both be set *before* server.js is
// imported, since both are read once at module load time.

process.env.DATA_FILE = '/tmp/next-break-test-admin-data-' + Date.now() + '.json';
process.env.ADMIN_EMAIL = 'admin@example.com';
const { server } = await import('./server.js');
import assert from 'node:assert';

const PORT = 34601;
await new Promise(resolve => server.listen(PORT, resolve));
const BASE = `http://localhost:${PORT}`;

function extractCookie(res) {
  const raw = res.headers.get('set-cookie') || '';
  const m = raw.match(/nb_session=[^;]+/);
  return m ? m[0] : null;
}

async function req(pathPart, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(BASE + pathPart, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, cookie: extractCookie(res), res };
}

// 1. Sign up a regular user WITH marketing opt-in checked.
let r = await req('/api/auth/signup', {
  method: 'POST',
  body: { email: 'fan@example.com', password: 'hunter22', acceptedTerms: true, marketingOptIn: true }
});
assert.strictEqual(r.status, 200, JSON.stringify(r.json));
const fanCookie = r.cookie;

// 1b. Profile GET should reflect the opt-in.
r = await req('/api/profile', { headers: { Cookie: fanCookie } });
assert.strictEqual(r.json.marketingOptIn, true, 'signup opt-in should persist: ' + JSON.stringify(r.json));

// 2. Sign up a second regular user WITHOUT opting in (omit the field entirely).
r = await req('/api/auth/signup', {
  method: 'POST',
  body: { email: 'quiet@example.com', password: 'hunter22', acceptedTerms: true }
});
assert.strictEqual(r.status, 200, JSON.stringify(r.json));
r = await req('/api/profile', { headers: { Cookie: r.cookie } });
assert.strictEqual(r.json.marketingOptIn, false, 'omitted opt-in should default false: ' + JSON.stringify(r.json));

// 3. Flip opt-in off via PUT /api/profile for the first user, then back on.
r = await req('/api/profile', { method: 'PUT', headers: { Cookie: fanCookie }, body: { displayName: 'Fan', marketingOptIn: false } });
assert.strictEqual(r.json.marketingOptIn, false, 'should be able to opt out later: ' + JSON.stringify(r.json));
r = await req('/api/profile', { method: 'PUT', headers: { Cookie: fanCookie }, body: { marketingOptIn: true } });
assert.strictEqual(r.json.marketingOptIn, true);

// 4. Sign up the admin account (also opts in, to make sure counting works).
r = await req('/api/auth/signup', {
  method: 'POST',
  body: { email: 'admin@example.com', password: 'hunter22', acceptedTerms: true, marketingOptIn: true }
});
assert.strictEqual(r.status, 200, JSON.stringify(r.json));
const adminCookie = r.cookie;

// 5. Deal-click tracking requires a real REAL_DESTINATIONS iata code — grab
// one dynamically rather than hardcoding, so this test doesn't silently
// break if the destination list changes.
const { REAL_DESTINATIONS } = await import('./lib/travelpayouts.js');
const dest = REAL_DESTINATIONS[0];

r = await req('/api/deal-click', { method: 'POST', headers: { Cookie: fanCookie }, body: { iata: dest.iata } });
assert.strictEqual(r.status, 200, JSON.stringify(r.json));
r = await req('/api/deal-click', { method: 'POST', headers: { Cookie: fanCookie }, body: { iata: dest.iata } });
assert.strictEqual(r.status, 200, JSON.stringify(r.json));

// 5b. Unknown iata should be rejected, not silently logged.
r = await req('/api/deal-click', { method: 'POST', headers: { Cookie: fanCookie }, body: { iata: 'ZZZ' } });
assert.strictEqual(r.status, 400);

// 5c. Anonymous (logged-out) deal click should now succeed and count too -
// this is the fix for the bug where handleDealClick used to hard-require a
// session and silently drop anonymous clicks. No Cookie header at all here.
r = await req('/api/deal-click', { method: 'POST', body: { iata: dest.iata } });
assert.strictEqual(r.status, 200, 'anonymous deal click should be recorded, not require login: ' + JSON.stringify(r.json));

// 5d. Event-click tracking: logged-in twice on the same event (to prove
// topEvents aggregation), then once anonymously on a different event, then
// a malformed request with neither id nor name.
r = await req('/api/event-click', { method: 'POST', headers: { Cookie: fanCookie }, body: { id: 'evt1', name: 'Test Concert' } });
assert.strictEqual(r.status, 200, JSON.stringify(r.json));
r = await req('/api/event-click', { method: 'POST', headers: { Cookie: fanCookie }, body: { id: 'evt1', name: 'Test Concert' } });
assert.strictEqual(r.status, 200, JSON.stringify(r.json));
r = await req('/api/event-click', { method: 'POST', body: { id: 'evt2', name: 'Other Show' } });
assert.strictEqual(r.status, 200, 'anonymous event click should be recorded too: ' + JSON.stringify(r.json));
r = await req('/api/event-click', { method: 'POST', headers: { Cookie: fanCookie }, body: {} });
assert.strictEqual(r.status, 400, 'event click with neither id nor name should be rejected');

// 5c. Site visits: hitting the real GET / route (not a mock) should record
// a visit each time, through the actual server routing in server.js — not
// calling lib/store.js's recordVisit() directly, so this proves the wiring
// end to end. A request for a static asset (not "/") shouldn't count.
await req('/');
await req('/');
await req('/');
await req('/logo-favicon.svg');

// 6. A non-admin, logged-in user hitting /api/admin/stats -> 403.
r = await req('/api/admin/stats', { headers: { Cookie: fanCookie } });
assert.strictEqual(r.status, 403, JSON.stringify(r.json));

// 7. A logged-out visitor hitting /api/admin/stats -> 401.
r = await req('/api/admin/stats');
assert.strictEqual(r.status, 401, JSON.stringify(r.json));

// 8. The admin account -> 200, with correct aggregate numbers.
const today = new Date().toISOString().slice(0, 10);
r = await req('/api/admin/stats', { headers: { Cookie: adminCookie } });
assert.strictEqual(r.status, 200, JSON.stringify(r.json));
assert.strictEqual(r.json.accounts.total, 3, 'expected 3 accounts total: ' + JSON.stringify(r.json.accounts));
assert.strictEqual(r.json.accounts.marketingOptIn, 2, 'fan + admin opted in, quiet did not: ' + JSON.stringify(r.json.accounts));
// 2 logged-in clicks + 1 anonymous click, all on the same destination.
assert.strictEqual(r.json.dealClicks.total, 3, JSON.stringify(r.json.dealClicks));
assert.strictEqual(r.json.dealClicks.topDestinations[0].iata, dest.iata);
assert.strictEqual(r.json.dealClicks.topDestinations[0].count, 3);
assert.ok(r.json.recentSignups.some(a => a.email === 'fan@example.com' && a.marketingOptIn === true));
assert.ok(r.json.recentClicks.some(c => c.email === 'fan@example.com' && c.iata === dest.iata));
assert.ok(r.json.recentClicks.some(c => c.email === null && c.iata === dest.iata), 'anonymous click should be logged with email: null: ' + JSON.stringify(r.json.recentClicks));

// 8b. Event clicks: 2 logged-in on evt1 + 1 anonymous on evt2 = 3 total,
// evt1 tops the list with 2.
assert.strictEqual(r.json.eventClicks.total, 3, JSON.stringify(r.json.eventClicks));
assert.strictEqual(r.json.eventClicks.topEvents[0].id, 'evt1', JSON.stringify(r.json.eventClicks.topEvents));
assert.strictEqual(r.json.eventClicks.topEvents[0].count, 2);
assert.ok(r.json.recentEventClicks.some(c => c.email === 'fan@example.com' && c.id === 'evt1'));
assert.ok(r.json.recentEventClicks.some(c => c.email === null && c.id === 'evt2'), 'anonymous event click should be logged with email: null: ' + JSON.stringify(r.json.recentEventClicks));

// 8c. Engagement rates should be present and numeric (or null if visits
// were 0, which won't be the case here since we hit GET / three times).
assert.strictEqual(typeof r.json.engagement.signupsPer100Visits, 'number', JSON.stringify(r.json.engagement));
assert.strictEqual(typeof r.json.engagement.dealClicksPer100Visits, 'number', JSON.stringify(r.json.engagement));
assert.strictEqual(typeof r.json.engagement.eventClicksPer100Visits, 'number', JSON.stringify(r.json.engagement));

// 8d. Daily series for the trend charts: exactly 30 points each, oldest to
// newest, ending on today, with today's count matching the same numbers
// already asserted above (3 visits, 3 accounts, 3 deal clicks, 3 event
// clicks all happened today, in this single test run).
for (const key of ['visits', 'signups', 'dealClicks', 'eventClicks']) {
  const series = r.json.series[key];
  assert.strictEqual(series.length, 30, `${key} series should have 30 points: ` + JSON.stringify(series));
  assert.strictEqual(series[29].date, today, `${key} series should end on today: ` + JSON.stringify(series[29]));
}
assert.strictEqual(r.json.series.visits[29].count, 3, JSON.stringify(r.json.series.visits[29]));
assert.strictEqual(r.json.series.signups[29].count, 3, JSON.stringify(r.json.series.signups[29]));
assert.strictEqual(r.json.series.dealClicks[29].count, 3, JSON.stringify(r.json.series.dealClicks[29]));
assert.strictEqual(r.json.series.eventClicks[29].count, 3, JSON.stringify(r.json.series.eventClicks[29]));

// 8e. Growth: everything happened today (all in the "last 7 days" bucket,
// nothing in the "previous 7 days" bucket), so every metric should read as
// "up" with no percentage (can't divide by a zero prior week).
for (const key of ['visits', 'signups', 'dealClicks', 'eventClicks']) {
  const g = r.json.growth[key];
  assert.strictEqual(g.direction, 'up', `${key} growth should be 'up': ` + JSON.stringify(g));
  assert.strictEqual(g.prev7, 0, `${key} should have 0 in the previous week: ` + JSON.stringify(g));
  assert.strictEqual(g.pct, null, `${key} pct should be null with a zero prior week: ` + JSON.stringify(g));
}
assert.strictEqual(r.json.growth.visits.last7, 3, JSON.stringify(r.json.growth.visits));
assert.strictEqual(r.json.growth.signups.last7, 3, JSON.stringify(r.json.growth.signups));
assert.strictEqual(r.json.growth.dealClicks.last7, 3, JSON.stringify(r.json.growth.dealClicks));
assert.strictEqual(r.json.growth.eventClicks.last7, 3, JSON.stringify(r.json.growth.eventClicks));

// 9. Site visits: exactly the 3 GET / requests should be counted (the
// static-asset request should not have added a 4th), all landing on
// today's date since the test runs in a few milliseconds.
assert.strictEqual(r.json.visits.today, 3, 'expected exactly 3 visits today: ' + JSON.stringify(r.json.visits));
assert.strictEqual(r.json.visits.total, 3, JSON.stringify(r.json.visits));
assert.strictEqual(r.json.visits.last7Days, 3, JSON.stringify(r.json.visits));
assert.ok(r.json.visits.dailyVisits.some(v => v.date === today && v.count === 3), 'dailyVisits should include today with count 3: ' + JSON.stringify(r.json.visits.dailyVisits));

console.log('ALL ADMIN E2E TESTS PASSED');
server.close();
process.exit(0);
