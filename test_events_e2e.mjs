// End-to-end test of the /api/events route (Ticketmaster events near
// hometown, during a specific break), against a real running server
// instance with an isolated scratch data file.
//
// server.js's internal calls to geocodeHometown()/findEvents() use the
// real global fetch (no injectable fetchImpl at that layer, unlike the
// lower-level lib functions which do accept one) — so this test
// monkey-patches global.fetch to intercept calls to Nominatim and
// Ticketmaster before importing server.js, same technique the old
// test-e2e-server.mjs scratch harness used for Travelpayouts. Real network
// access isn't available in this sandbox anyway.
//
// Run with: node test_events_e2e.mjs

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = new URL(String(url));
  if (u.hostname === 'nominatim.openstreetmap.org') {
    return {
      ok: true,
      json: async () => ([{ lat: '-31.9505', lon: '115.8605' }])
    };
  }
  if (u.hostname === 'app.ticketmaster.com') {
    return {
      ok: true,
      json: async () => ({
        _embedded: {
          events: [
            {
              name: 'In-break Concert',
              id: 'ev1',
              url: 'https://www.ticketmaster.com.au/event/ev1',
              images: [{ ratio: '16_9', url: 'https://img/ev1.jpg', width: 1024 }],
              dates: { start: { localDate: '2026-08-05', localTime: '19:00:00' } },
              classifications: [{ segment: { name: 'Music' } }],
              priceRanges: [{ min: 60, max: 120, currency: 'AUD' }],
              _embedded: { venues: [{ name: 'RAC Arena', city: { name: 'Perth' } }] }
            },
            {
              // Outside the actual break dates but inside the widened query
              // window (break is Aug 1-7, query window is Jul 31 - Aug 8) —
              // must be filtered out client-side by buildEventsForBreak.
              name: 'Just-outside Concert',
              id: 'ev2',
              url: 'https://www.ticketmaster.com.au/event/ev2',
              images: [],
              dates: { start: { localDate: '2026-08-08', localTime: '20:00:00' } },
              classifications: [{ segment: { name: 'Music' } }],
              _embedded: { venues: [{ name: 'Some Other Venue', city: { name: 'Perth' } }] }
            }
          ]
        }
      })
    };
  }
  return realFetch(url, opts);
};

process.env.DATA_FILE = '/tmp/next-break-test-events-data-' + Date.now() + '.json';
process.env.TICKETMASTER_API_KEY = 'fake-test-key';
process.env.TICKETMASTER_AFFILIATE_LINK_PREFIX = 'https://track.example.com/c/111/222/333?u=';

const { server } = await import('./server.js');
import assert from 'node:assert';

const PORT = 34605;
await new Promise(resolve => server.listen(PORT, resolve));
const BASE = `http://localhost:${PORT}`;

async function req(pathPart, { headers = {} } = {}) {
  const res = await fetch(BASE + pathPart, { headers: { 'Content-Type': 'application/json', ...headers } });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const deviceId = 'device-events-test-1';

// 1. Set hometown + a pattern roster whose first break is Aug 1-7, 2026.
let r = await req('/api/settings', {}); // sanity: GET works with no body helper needed
r = await fetch(`${BASE}/api/settings`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'X-User-Id': deviceId },
  body: JSON.stringify({
    hometown: 'Perth, WA',
    rosterMode: 'pattern',
    pattern: { daysOn: 14, daysOff: 7, nextBreakStart: '2026-08-01' }
  })
});
assert.strictEqual(r.status, 200);

r = await req('/api/breaks', { headers: { 'X-User-Id': deviceId } });
assert.strictEqual(r.status, 200, JSON.stringify(r.json));
const breakKey = r.json.breaks[0].key;
assert.strictEqual(r.json.breaks[0].start, '2026-08-01', 'timezone fix should hold here too: ' + JSON.stringify(r.json.breaks[0]));
assert.strictEqual(r.json.breaks[0].end, '2026-08-07');

// 2. Fetch events for that break.
r = await req(`/api/events?breakKey=${encodeURIComponent(breakKey)}`, { headers: { 'X-User-Id': deviceId } });
assert.strictEqual(r.status, 200, JSON.stringify(r.json));
assert.strictEqual(r.json.source, 'real', JSON.stringify(r.json));
assert.strictEqual(r.json.events.length, 1, 'the just-outside event should be filtered out: ' + JSON.stringify(r.json.events));
assert.strictEqual(r.json.events[0].title, 'In-break Concert');
assert.strictEqual(r.json.events[0].localDate, '2026-08-05');

// 3. Affiliate wrapping should be applied since TICKETMASTER_AFFILIATE_LINK_PREFIX is set.
const expectedWrapped = 'https://track.example.com/c/111/222/333?u=' + encodeURIComponent('https://www.ticketmaster.com.au/event/ev1');
assert.strictEqual(r.json.events[0].url, expectedWrapped, 'event url should be wrapped in the affiliate deep link: ' + r.json.events[0].url);

// 4. Second call should be served from cache (still correct), not re-fetched —
// can't directly observe that here without a call counter, but re-asserting
// the same result confirms the cache path doesn't corrupt anything.
r = await req(`/api/events?breakKey=${encodeURIComponent(breakKey)}`, { headers: { 'X-User-Id': deviceId } });
assert.strictEqual(r.json.events.length, 1);

// 5. Missing breakKey -> 400.
r = await req('/api/events', { headers: { 'X-User-Id': deviceId } });
assert.strictEqual(r.status, 400);

// 6. Unknown breakKey -> 404.
r = await req('/api/events?breakKey=bogus', { headers: { 'X-User-Id': deviceId } });
assert.strictEqual(r.status, 404);

console.log('ALL TICKETMASTER EVENTS E2E TESTS PASSED');
server.close();
process.exit(0);
