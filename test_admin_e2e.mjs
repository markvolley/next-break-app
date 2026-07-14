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

// 6. A non-admin, logged-in user hitting /api/admin/stats -> 403.
r = await req('/api/admin/stats', { headers: { Cookie: fanCookie } });
assert.strictEqual(r.status, 403, JSON.stringify(r.json));

// 7. A logged-out visitor hitting /api/admin/stats -> 401.
r = await req('/api/admin/stats');
assert.strictEqual(r.status, 401, JSON.stringify(r.json));

// 8. The admin account -> 200, with correct aggregate numbers.
r = await req('/api/admin/stats', { headers: { Cookie: adminCookie } });
assert.strictEqual(r.status, 200, JSON.stringify(r.json));
assert.strictEqual(r.json.accounts.total, 3, 'expected 3 accounts total: ' + JSON.stringify(r.json.accounts));
assert.strictEqual(r.json.accounts.marketingOptIn, 2, 'fan + admin opted in, quiet did not: ' + JSON.stringify(r.json.accounts));
assert.strictEqual(r.json.dealClicks.total, 2, JSON.stringify(r.json.dealClicks));
assert.strictEqual(r.json.dealClicks.topDestinations[0].iata, dest.iata);
assert.strictEqual(r.json.dealClicks.topDestinations[0].count, 2);
assert.ok(r.json.recentSignups.some(a => a.email === 'fan@example.com' && a.marketingOptIn === true));
assert.ok(r.json.recentClicks.some(c => c.email === 'fan@example.com' && c.iata === dest.iata));

console.log('ALL ADMIN E2E TESTS PASSED');
server.close();
process.exit(0);
