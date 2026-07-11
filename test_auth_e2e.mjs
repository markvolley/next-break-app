// End-to-end test of the /api/auth/* routes against a real running server
// instance, using an isolated scratch data file (never touches data.json).
// Run with: node test_auth_e2e.mjs
//
// Note: DATA_FILE must be set *before* server.js (and therefore lib/store.js)
// is imported, since store.js reads it once at module load time — hence the
// dynamic import() below rather than a static `import { server } from ...`.

process.env.DATA_FILE = '/tmp/next-break-test-data-' + Date.now() + '.json';
const { server } = await import('./server.js');
import assert from 'node:assert';

const PORT = 34599;
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

const deviceId = 'device-abc-123';

// 1. Anonymous device saves settings first
let r = await req('/api/settings', { method: 'PUT', headers: { 'X-User-Id': deviceId }, body: { hometown: 'Perth', originAirport: 'PER', currency: 'AUD' } });
assert.strictEqual(r.status, 200, 'settings save should 200: ' + JSON.stringify(r.json));

// 2. Signup with that device id -> should migrate settings
r = await req('/api/auth/signup', { method: 'POST', headers: { 'X-User-Id': deviceId }, body: { email: 'Test@Example.com', password: 'hunter22' } });
assert.strictEqual(r.status, 200, 'signup should 200: ' + JSON.stringify(r.json));
assert.strictEqual(r.json.email, 'test@example.com');
const sessionCookie = r.cookie;
assert.ok(sessionCookie, 'should set session cookie');

// 3. /api/auth/me with cookie shows logged in
r = await req('/api/auth/me', { headers: { Cookie: sessionCookie } });
assert.strictEqual(r.json.loggedIn, true);
assert.strictEqual(r.json.email, 'test@example.com');

// 4. Settings fetch via session cookie (no X-User-Id) should show migrated Perth settings
r = await req('/api/settings', { headers: { Cookie: sessionCookie } });
assert.strictEqual(r.json.hometown, 'Perth', 'migrated settings expected: ' + JSON.stringify(r.json));
assert.strictEqual(r.json.originAirport, 'PER');

// 5. Duplicate signup should 409 — no identity headers needed at all, since
// auth routes don't require an existing X-User-Id/session.
r = await req('/api/auth/signup', { method: 'POST', body: { email: 'test@example.com', password: 'whatever1' } });
assert.strictEqual(r.status, 409, JSON.stringify(r.json));

// 6. Login with wrong password -> 401
r = await req('/api/auth/login', { method: 'POST', body: { email: 'test@example.com', password: 'wrongpass' } });
assert.strictEqual(r.status, 401);

// 7. Login with correct password -> 200, new session, settings still there (simulating "new device")
r = await req('/api/auth/login', { method: 'POST', headers: { 'X-User-Id': 'brand-new-device-id' }, body: { email: 'test@example.com', password: 'hunter22' } });
assert.strictEqual(r.status, 200, JSON.stringify(r.json));
const sessionCookie2 = r.cookie;
assert.ok(sessionCookie2 && sessionCookie2 !== sessionCookie, 'should be a fresh session token');

r = await req('/api/settings', { headers: { Cookie: sessionCookie2 } });
assert.strictEqual(r.json.hometown, 'Perth', 'settings should follow the account across "devices": ' + JSON.stringify(r.json));

// 8. Logout clears session
r = await req('/api/auth/logout', { method: 'POST', headers: { Cookie: sessionCookie2 } });
assert.strictEqual(r.status, 200);

r = await req('/api/auth/me', { headers: { Cookie: sessionCookie2 } });
assert.strictEqual(r.json.loggedIn, false, 'old token should no longer be valid after logout');

// 9. Signup validation: bad email, short password (no identity headers at all)
r = await req('/api/auth/signup', { method: 'POST', body: { email: 'not-an-email', password: 'hunter22' } });
assert.strictEqual(r.status, 400);
r = await req('/api/auth/signup', { method: 'POST', body: { email: 'valid@example.com', password: 'short' } });
assert.strictEqual(r.status, 400);

// 10. Google auth without GOOGLE_CLIENT_ID configured -> 500
r = await req('/api/auth/google', { method: 'POST', body: { credential: 'fake-token' } });
assert.strictEqual(r.status, 500, JSON.stringify(r.json));

// 11. /api/auth/me with zero identity at all should be fine (loggedIn: false), not an error
r = await req('/api/auth/me');
assert.strictEqual(r.status, 200);
assert.strictEqual(r.json.loggedIn, false);

// 12. Non-auth routes still require X-User-Id/session when neither present
r = await req('/api/settings');
assert.strictEqual(r.status, 400);

console.log('ALL AUTH E2E TESTS PASSED');
server.close();
process.exit(0);
