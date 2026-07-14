// End-to-end test of the calendar feed (.ics) and personal stats endpoints,
// against a real running server instance with an isolated scratch data file.
// Run with: node test_calendar_stats_e2e.mjs

process.env.DATA_FILE = '/tmp/next-break-test-cal-data-' + Date.now() + '.json';
const { server } = await import('./server.js');
import assert from 'node:assert';

const PORT = 34603;
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
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : await res.text();
  return { status: res.status, payload, cookie: extractCookie(res), res };
}

const deviceId = 'device-cal-test-1';

// 1. Set up a pattern roster for an anonymous device — calendar export
// shouldn't require an account.
let r = await req('/api/settings', {
  method: 'PUT',
  headers: { 'X-User-Id': deviceId },
  body: { rosterMode: 'pattern', pattern: { daysOn: 14, daysOff: 7, nextBreakStart: '2026-08-01' } }
});
assert.strictEqual(r.status, 200, JSON.stringify(r.payload));

// 2. Fetch a calendar token for that device.
r = await req('/api/calendar-token', { headers: { 'X-User-Id': deviceId } });
assert.strictEqual(r.status, 200, JSON.stringify(r.payload));
assert.ok(r.payload.icsUrl.includes('/calendar/'), 'should return a calendar URL: ' + JSON.stringify(r.payload));
const icsPath = new URL(r.payload.icsUrl).pathname;

// 2b. Calling it again should return the SAME token (stable subscribe link).
r = await req('/api/calendar-token', { headers: { 'X-User-Id': deviceId } });
assert.strictEqual(new URL(r.payload.icsUrl).pathname, icsPath, 'token should be stable across calls');

// 3. Fetch the actual .ics feed — no auth headers at all, just the token in
// the URL, simulating a calendar app polling it unattended.
r = await req(icsPath);
assert.strictEqual(r.status, 200, JSON.stringify(r.payload));
assert.ok(r.res.headers.get('content-type').includes('text/calendar'), 'wrong content-type: ' + r.res.headers.get('content-type'));
const ics = r.payload;
assert.ok(ics.startsWith('BEGIN:VCALENDAR'), 'should start with BEGIN:VCALENDAR');
assert.ok(ics.includes('END:VCALENDAR'), 'should end with END:VCALENDAR');
assert.ok(ics.includes('BEGIN:VEVENT'), 'should contain at least one VEVENT');
assert.ok(ics.includes('DTSTART;VALUE=DATE:20260801'), 'first break should start 2026-08-01: ' + ics);
// daysOff=7 means the break covers Aug 1-7 inclusive -> exclusive DTEND is Aug 8.
assert.ok(ics.includes('DTEND;VALUE=DATE:20260808'), 'DTEND should be exclusive (day after the break ends): ' + ics);
// Should project multiple future breaks (computeUpcomingBreaks returns up to 6).
assert.strictEqual((ics.match(/BEGIN:VEVENT/g) || []).length, 6, 'expected 6 projected breaks: ' + ics);

// 4. An unknown/garbage token should 404, not 500 or leak data.
r = await req('/calendar/deadbeefdeadbeefdeadbeefdeadbeef.ics');
assert.strictEqual(r.status, 404, JSON.stringify(r.payload));

// 5. Personal stats: sign up a user, set their roster, click a couple of
// deals, and check the aggregation.
r = await req('/api/auth/signup', {
  method: 'POST',
  headers: { 'X-User-Id': deviceId },
  body: { email: 'stats-fan@example.com', password: 'hunter22', acceptedTerms: true }
});
assert.strictEqual(r.status, 200, JSON.stringify(r.payload));
const cookie = r.cookie;

// migrateUser should have carried the pattern roster over from the device.
r = await req('/api/settings', { headers: { Cookie: cookie } });
assert.strictEqual(r.payload.pattern.nextBreakStart, '2026-08-01', 'roster should carry over on signup: ' + JSON.stringify(r.payload));

const { REAL_DESTINATIONS } = await import('./lib/travelpayouts.js');
const [destA, destB] = REAL_DESTINATIONS;

r = await req('/api/deal-click', { method: 'POST', headers: { Cookie: cookie }, body: { iata: destA.iata } });
assert.strictEqual(r.status, 200, JSON.stringify(r.payload));
r = await req('/api/deal-click', { method: 'POST', headers: { Cookie: cookie }, body: { iata: destA.iata } });
assert.strictEqual(r.status, 200, JSON.stringify(r.payload));
r = await req('/api/deal-click', { method: 'POST', headers: { Cookie: cookie }, body: { iata: destB.iata } });
assert.strictEqual(r.status, 200, JSON.stringify(r.payload));

r = await req('/api/stats', { headers: { Cookie: cookie } });
assert.strictEqual(r.status, 200, JSON.stringify(r.payload));
assert.strictEqual(r.payload.upcomingBreaksCount, 6, JSON.stringify(r.payload));
assert.ok(r.payload.nextBreak, 'should have a next break: ' + JSON.stringify(r.payload));
assert.strictEqual(r.payload.nextBreak.start, '2026-08-01');
assert.strictEqual(r.payload.dealClicks.total, 3, JSON.stringify(r.payload.dealClicks));
assert.strictEqual(r.payload.dealClicks.uniqueDestinations, 2, JSON.stringify(r.payload.dealClicks));
assert.strictEqual(r.payload.dealClicks.topDestinations[0].iata, destA.iata, 'destA clicked twice should rank first: ' + JSON.stringify(r.payload.dealClicks));
assert.strictEqual(r.payload.dealClicks.topDestinations[0].count, 2);
assert.ok(r.payload.memberSince, 'should report memberSince: ' + JSON.stringify(r.payload));

// 6. Logged-out visitor should get 401, not a crash or someone else's data.
r = await req('/api/stats');
assert.strictEqual(r.status, 401, JSON.stringify(r.payload));

console.log('ALL CALENDAR + STATS E2E TESTS PASSED');
server.close();
process.exit(0);
