// Next Break — backend server.
// Zero external dependencies on purpose: only Node.js built-ins, so
// `npm install` isn't even required. Run with:
//   node --env-file=.env server.js
// or just `npm start`.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { computeUpcomingBreaks, breakStatus, toISO, addDays, CURRENCY_SYMBOLS } from './lib/deals.js';
import {
  getSettings, saveSettings, isUnlocked, markUnlocked, getUnlockRecord,
  getAccount, createAccount, upsertGoogleAccount, createSession, getSessionEmail, deleteSession, migrateUser,
  setAccountPassword, deleteAllSessionsForEmail, createPasswordReset, getPasswordResetEmail, deletePasswordReset,
  setAccountProfile, listAccounts, recordDealClick, listDealClicks, recordEventClick, listEventClicks, recordFeedback, listFeedback, recordVisit, getVisitsByDay,
  getCalendarTokenForUser, setCalendarToken, getUserIdForCalendarToken, _dataFilePath,
  getOrCreateUnsubscribeToken, getEmailByUnsubscribeToken, recordDigestSent, hasDigestSent
} from './lib/store.js';
import { createCheckoutSession, retrieveCheckoutSession, verifyWebhookSignature } from './lib/stripeClient.js';
import { fetchAllRealFares, selectDeals, withBackfill, REAL_DESTINATIONS, INTEREST_TAGS } from './lib/travelpayouts.js';
import { findActivities } from './lib/viator.js';
import { findFreeActivities, geocodeHometown } from './lib/activities.js';
import { findEvents, buildEventUrl } from './lib/ticketmaster.js';
import { findRestaurantLink } from './lib/opentable.js';
import { findStayLink } from './lib/booking.js';
import { getWeatherForDate } from './lib/weather.js';
import { routeContext } from './lib/geo.js';
import { fetchExchangeRates, DEST_CURRENCY_BY_IATA, DEST_CURRENCY_SYMBOLS } from './lib/fx.js';
import { hashPassword, verifyPassword, createSessionToken, createResetToken, createCalendarToken, isValidEmail } from './lib/auth.js';
import { verifyGoogleIdToken } from './lib/googleAuth.js';
import { sendPasswordResetEmail, sendBreakDigestEmail } from './lib/email.js';
import { buildBreaksICS } from './lib/calendar.js';
import { pickEligibleBreak } from './lib/digest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const UNLOCK_FEE_CENTS = parseInt(process.env.UNLOCK_FEE_CENTS, 10) || 500; // $5.00 default — unused while the paywall is off, kept for when it's re-enabled

// Operator-level affiliate credentials — these belong to YOU (whoever runs
// this server), not to individual users, so they live in .env rather than
// in each person's Setup. TRAVELPAYOUTS_MARKER is a public tracking ID
// (safe to hardcode/commit); TRAVELPAYOUTS_TOKEN authenticates API calls
// and should stay secret, same handling as the Stripe key.
const TRAVELPAYOUTS_TOKEN = process.env.TRAVELPAYOUTS_TOKEN || '';
const TRAVELPAYOUTS_MARKER = process.env.TRAVELPAYOUTS_MARKER || '';

// Viator affiliate credentials — same operator-level pattern as above.
// VIATOR_API_KEY is secret (authenticates API calls). VIATOR_PID (Partner
// ID) and VIATOR_MCID (campaign ID) are account identifiers, not secrets,
// but still operator-level (they're yours, not each user's).
const VIATOR_API_KEY = process.env.VIATOR_API_KEY || '';
const VIATOR_PID = process.env.VIATOR_PID || '';
const VIATOR_MCID = process.env.VIATOR_MCID || '';

// Ticketmaster Discovery API — free, self-serve, no approval wait (unlike
// their separate commission-earning Affiliate Program). Get one at
// https://developer.ticketmaster.com. Shows real ticketed events (gigs,
// sport, theatre) near a user's hometown during each specific break.
const TICKETMASTER_API_KEY = process.env.TICKETMASTER_API_KEY || '';

// Optional manual override — you almost certainly don't need this. Once
// your Ticketmaster Affiliate Program application (via Impact) is
// approved, link your Impact Publisher ID directly in the Ticketmaster
// developer portal (My Apps -> your app -> Affiliate IDs -> "Profile
// Edit") — from then on, event URLs from the Discovery API already come
// back commission-tracked automatically, no code-side wrapping needed.
// This env var only matters if you'd rather route through a different
// tracking link than Ticketmaster's own; see buildEventUrl in
// lib/ticketmaster.js.
const TICKETMASTER_AFFILIATE_LINK_PREFIX = process.env.TICKETMASTER_AFFILIATE_LINK_PREFIX || '';

// OpenTable has no self-serve public API for restaurant listings (unlike
// Ticketmaster's Discovery API) — see lib/opentable.js for the full
// reasoning. This links straight to a real OpenTable AU search page for the
// user's hometown instead, so there's no API key to configure at all. Once
// accepted into OpenTable's own affiliate program (applied for via their
// Partner Portal, not Impact), set this to whatever tracking link/prefix
// they give you to make the link commission-tracked — leave unset and it's
// simply a plain, untracked (but still real) link.
const OPENTABLE_AFFILIATE_LINK_PREFIX = process.env.OPENTABLE_AFFILIATE_LINK_PREFIX || '';

// Same story as OpenTable above, but for Booking.com (Staycation tab) — see
// lib/booking.js. No API key needed for the link itself; once accepted into
// Booking.com's Affiliate Partner Program (applied for via Awin, a
// different/faster track than their Demand API), set this to whatever
// tracking prefix Awin gives you. Airbnb has no equivalent self-serve
// program at all (their public affiliate program closed in 2021), so
// there's no Airbnb env var here — Booking.com is the only real option.
const BOOKING_AFFILIATE_LINK_PREFIX = process.env.BOOKING_AFFILIATE_LINK_PREFIX || '';

// Google Sign-In client ID. This is NOT a secret — it's meant to be public
// and embedded in frontend JS (that's how Google Identity Services works),
// same category as a Stripe *publishable* key. Get one free at
// https://console.cloud.google.com/apis/credentials
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

// Transactional email (password resets only, for now) via Resend's REST
// API — see lib/email.js. RESEND_API_KEY is secret; EMAIL_FROM is not, but
// it does need to be a sender address/domain verified in your Resend
// account or Resend will reject the send.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'Next Break <onboarding@resend.dev>';

// Password-reset links use originFromRequest(req) since there's always a
// real incoming request to derive host/protocol from. The break-reminder
// digest (see runDigestSweep) has no request, it's a background job, so it
// needs a fixed base URL instead.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://nextbreak.com.au').replace(/\/$/, '');

const SESSION_COOKIE = 'nb_session';
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

// Admin dashboard access — comma-separated list of emails allowed to load
// /api/admin/stats and public/admin.html. Not a separate password system;
// it piggybacks on the normal login session, so whoever's logged in as one
// of these emails can see it and nobody else can. Leave unset in an
// environment and the dashboard is fully disabled (403 for everyone).
const ADMIN_EMAILS = (process.env.ADMIN_EMAIL || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

// Avatars live next to data.json on the same persistent disk (whatever
// directory DATA_FILE points at — /data on Render, project root locally),
// not in public/, since public/ is just the git-tracked static frontend
// and wouldn't survive a redeploy.
const AVATAR_DIR = path.join(path.dirname(_dataFilePath()), 'avatars');
const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2MB decoded
const AVATAR_MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// ---------- tiny helpers ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readRawBody(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req, limitBytes) {
  const raw = await readRawBody(req, limitBytes);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    const err = new Error('Invalid JSON body');
    err.status = 400;
    throw err;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

// Identity resolution: a logged-in session (cookie) takes priority over
// the anonymous per-device X-User-Id header. This means once someone logs
// in, all their data (settings, unlocks) is keyed by their account email
// instead of the random device id — which is exactly what lets it follow
// them across devices/browsers.
function getUserId(req) {
  const cookies = parseCookies(req);
  const sessionEmail = getSessionEmail(cookies[SESSION_COOKIE]);
  if (sessionEmail) return sessionEmail;
  return req.headers['x-user-id'] || null;
}

function isHttpsRequest(req) {
  return (req.headers['x-forwarded-proto'] || '').includes('https');
}

function setSessionCookie(req, res, token) {
  const maxAge = 60 * 60 * 24 * 90; // 90 days
  const parts = [`${SESSION_COOKIE}=${token}`, 'HttpOnly', 'Path=/', `Max-Age=${maxAge}`, 'SameSite=Lax'];
  if (isHttpsRequest(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
  const parts = [`${SESSION_COOKIE}=`, 'HttpOnly', 'Path=/', 'Max-Age=0', 'SameSite=Lax'];
  if (isHttpsRequest(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function originFromRequest(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// Avatars live outside PUBLIC_DIR (see AVATAR_DIR above), so they get their
// own tiny static handler rather than being folded into serveStatic.
function serveAvatar(req, res, pathname) {
  const rel = pathname.replace(/^\/avatars\//, '');
  const filePath = path.normalize(path.join(AVATAR_DIR, rel));
  if (!filePath.startsWith(AVATAR_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.end(data);
  });
}

// ---------- break presentation (metadata only — no deals) ----------
function presentBreak(brk, settings) {
  const status = breakStatus(brk);
  return {
    key: brk.key,
    start: toISO(brk.start),
    end: toISO(brk.end),
    duration: brk.duration,
    ...status,
    currencySymbol: CURRENCY_SYMBOLS[settings.currency] || 'A$'
  };
}

// ---------- deals for a single break (real fares only — no fake/mock prices) ----------
// Three possible outcomes, distinguished by `source` so the frontend can be
// honest about which one happened rather than always showing a populated
// card. We deliberately do NOT fall back to invented prices with a Google
// search link — a made-up price that doesn't earn commission when clicked
// isn't more useful to the user than an honest "nothing cached yet."
//
// The *fetch* (querying Travelpayouts across every candidate destination)
// is cached in memory per (origin, break, currency) for 24 hours — that's
// the expensive, identical-for-everyone part, so the same break doesn't
// trigger a fresh batch of Travelpayouts lookups on every dashboard load
// from every user. Failed lookups are never cached, so a transient error
// gets retried on the very next request instead of showing "no deals" for
// a full day.
//
// *Selecting* which 3 of those fares to actually show, on the other hand,
// is NOT cached — it's cheap (just sorting/filtering an already-fetched
// list) and depends on the viewer's own preferences (see selectDeals in
// lib/travelpayouts.js), so it's recomputed fresh per request.
const DEALS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const dealsCache = new Map(); // `${origin}|${breakKey}|${currency}` -> { fares, fetchedAt }

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of dealsCache) {
    if (now - entry.fetchedAt > DEALS_CACHE_TTL_MS) dealsCache.delete(key);
  }
}, 60 * 60 * 1000).unref();

async function buildDealsForBreak(brk, settings, { profile = null } = {}) {
  const currency = (settings.currency || 'AUD').toLowerCase();

  if (!TRAVELPAYOUTS_TOKEN || !settings.originAirport) {
    return { source: 'not-configured', deals: [], fetchedAt: null };
  }

  const origin = settings.originAirport.toUpperCase();
  const cacheKey = `${origin}|${brk.key}|${currency}`;
  let cached = dealsCache.get(cacheKey);

  if (!cached || Date.now() - cached.fetchedAt >= DEALS_CACHE_TTL_MS) {
    try {
      const fares = await fetchAllRealFares({
        token: TRAVELPAYOUTS_TOKEN,
        marker: TRAVELPAYOUTS_MARKER,
        origin,
        currency,
        brk
      });
      cached = { fares, fetchedAt: Date.now() };
      dealsCache.set(cacheKey, cached);
    } catch (e) {
      console.error('[travelpayouts] fetchAllRealFares threw:', e.message);
      // Don't cache a transient failure — leave dealsCache unset for this
      // key so the next request retries the real fetch. Still fall through
      // to backfill below, since a live-search link doesn't depend on this
      // fetch having worked at all.
      cached = { fares: [], fetchedAt: Date.now() };
    }
  }

  const realSource = cached.fares.length ? 'real' : 'no-results';

  // Guarantees a domestic/SEA/international mix first, then backfills with
  // any other real fares found (see selectDeals) up to this cap — raised
  // from the old fixed 3-slot limit so a break with plenty of real options
  // actually shows them instead of throwing extras away. If real fares are
  // still short of BACKFILL_MINIMUM after that, withBackfill tops the list
  // up with no-price "optional destination" cards that link to a live
  // Aviasales search for the break's real dates, so nobody ever lands on
  // an empty deals list — see lib/travelpayouts.js for why this is still
  // commissionable and never fabricates a price.
  const deals = withBackfill(
    selectDeals(cached.fares, { limit: 6, profile }),
    { origin, brk, marker: TRAVELPAYOUTS_MARKER, currency: settings.currency }
  );
  await attachWeather(deals);
  // Distance + timezone diff are pure static lookups (no fetch, no cache
  // needed) — see lib/geo.js for why DST isn't modelled here.
  for (const d of deals) Object.assign(d, routeContext(origin, d.iata));
  await attachExchangeContext(deals, settings.currency);
  return {
    source: realSource,
    deals,
    fetchedAt: cached.fetchedAt ? new Date(cached.fetchedAt).toISOString() : null
  };
}

// ---------- weather for the (up to 3) shown deals, per destination+date ----------
// Only fetched for the deals actually being shown, not all 22 candidates —
// piggybacks off the same "real data, cached, honest empty state" approach
// as everything else here (see lib/weather.js). Cached separately from
// dealsCache since it's keyed by exact flight date, not by break/origin.
const WEATHER_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h — forecasts firm up through the day
const weatherCache = new Map(); // `${iata}|${dateISO}` -> { weather, fetchedAt }

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of weatherCache) {
    if (now - entry.fetchedAt > WEATHER_CACHE_TTL_MS) weatherCache.delete(key);
  }
}, 60 * 60 * 1000).unref();

async function attachWeather(deals) {
  await Promise.all(deals.map(async d => {
    const dateISO = (d.departureAt || '').slice(0, 10);
    if (!dateISO) { d.weather = null; return; }

    const key = `${d.iata}|${dateISO}`;
    let cached = weatherCache.get(key);
    if (!cached || Date.now() - cached.fetchedAt >= WEATHER_CACHE_TTL_MS) {
      let weather = null;
      try {
        weather = await getWeatherForDate({ iata: d.iata, dateISO });
      } catch (e) {
        console.error(`[weather] getWeatherForDate for ${d.iata} threw:`, e.message);
      }
      cached = { weather, fetchedAt: Date.now() };
      weatherCache.set(key, cached);
    }
    d.weather = cached.weather;
  }));
}

// ---------- "while you're there" currency context, per home currency ----------
// The source refreshes once a day (see lib/fx.js) so caching at roughly
// that cadence, per base currency, avoids re-fetching on every dashboard
// load — there are only 5 possible base currencies (lib/deals.js
// CURRENCY_SYMBOLS), so this is a tiny amount of state either way.
const FX_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const fxCache = new Map(); // base currency -> { rates, fetchedAt }

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of fxCache) {
    if (now - entry.fetchedAt > FX_CACHE_TTL_MS) fxCache.delete(key);
  }
}, 60 * 60 * 1000).unref();

async function attachExchangeContext(deals, currency) {
  const base = (currency || 'AUD').toUpperCase();
  let cached = fxCache.get(base);
  if (!cached || Date.now() - cached.fetchedAt >= FX_CACHE_TTL_MS) {
    let rates = null;
    try {
      rates = await fetchExchangeRates({ base });
    } catch (e) {
      console.error('[fx] fetchExchangeRates threw:', e.message);
    }
    cached = { rates, fetchedAt: Date.now() };
    fxCache.set(base, cached);
  }
  for (const d of deals) {
    const destCurrency = !d.domestic ? DEST_CURRENCY_BY_IATA[d.iata] : null;
    const rate = (destCurrency && cached.rates) ? cached.rates[destCurrency] : null;
    d.fx = rate ? {
      base, quote: destCurrency, rate,
      baseSymbol: CURRENCY_SYMBOLS[base] || base,
      quoteSymbol: DEST_CURRENCY_SYMBOLS[destCurrency] || destCurrency
    } : null;
  }
}

// ---------- activities for hometown ----------
// Two tiers, both real data, never fabricated: bookable activities via
// Viator when it's configured and has something for this hometown, falling
// back to free public spots (parks, beaches, lookouts, etc.) sourced live
// from OpenStreetMap (see lib/activities.js) when Viator has nothing —
// whether that's because it isn't configured at all, or just doesn't cover
// this particular hometown. The app's whole pitch is "things to do on your
// break," so an empty section here undercuts that even when there's
// nothing to book.
const FREE_ACTIVITIES_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — real-world parks/beaches don't move
// A *negative* result (nothing found — geocoding failed, Overpass timed
// out, a rate limit, or a hometown that genuinely has nothing mapped
// nearby) gets a much shorter TTL than a real result. Without this, one
// transient hiccup on the very first lookup for a hometown would cache an
// empty list for a full 7 days, which looks indistinguishable from "this
// feature is broken" even after whatever caused it has cleared up.
const FREE_ACTIVITIES_EMPTY_TTL_MS = 60 * 60 * 1000; // 1 hour
const freeActivitiesCache = new Map(); // hometown (lowercased) -> { activities, fetchedAt }

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of freeActivitiesCache) {
    const ttl = entry.activities.length ? FREE_ACTIVITIES_CACHE_TTL_MS : FREE_ACTIVITIES_EMPTY_TTL_MS;
    if (now - entry.fetchedAt > ttl) freeActivitiesCache.delete(key);
  }
}, 60 * 60 * 1000).unref();

async function buildFreeActivitiesForSettings(settings) {
  const key = settings.hometown.trim().toLowerCase();
  const cached = freeActivitiesCache.get(key);
  if (cached) {
    const ttl = cached.activities.length ? FREE_ACTIVITIES_CACHE_TTL_MS : FREE_ACTIVITIES_EMPTY_TTL_MS;
    if (Date.now() - cached.fetchedAt < ttl) return cached.activities;
  }
  let activities = [];
  try {
    activities = await findFreeActivities({ hometown: settings.hometown });
  } catch (e) {
    console.error('[activities] findFreeActivities threw:', e.message);
  }
  freeActivitiesCache.set(key, { activities, fetchedAt: Date.now() });
  return activities;
}

async function buildActivitiesForSettings(settings) {
  if (!settings.hometown) {
    return { source: 'not-configured', activities: [] };
  }

  if (VIATOR_API_KEY) {
    try {
      const real = await findActivities({
        apiKey: VIATOR_API_KEY,
        pid: VIATOR_PID,
        mcid: VIATOR_MCID,
        hometown: settings.hometown,
        currency: settings.currency || 'AUD'
      });
      if (real.length) return { source: 'real', activities: real };
    } catch (e) {
      console.error('[viator] findActivities threw:', e.message);
    }
  }

  // Viator's not configured, or came back empty — try free public spots
  // near the hometown before giving up entirely.
  const free = await buildFreeActivitiesForSettings(settings);
  return { source: free.length ? 'free' : 'no-results', activities: free };
}

// ---------- ticketed events near hometown, during a specific break ----------
// Separate cache from freeActivitiesCache above since this is keyed by
// hometown *and* break (event listings are date-bound, not just
// location-bound) — a park doesn't care what week it is, but a concert
// does. Same negative-cache lesson learned from the free-activities bug:
// an empty result is cached far more briefly than a real one, so a
// one-off API hiccup or a genuinely quiet week both self-correct quickly
// rather than one looking permanently broken.
const EVENTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — long enough to respect the API's rate limit, short enough that new listings show up promptly
const EVENTS_EMPTY_TTL_MS = 60 * 60 * 1000; // 1h
const eventsCache = new Map(); // `${hometown}|${breakKey}` -> { events, fetchedAt }

// Hometown coordinates don't change, so this can be cached far longer than
// the events themselves — also means the free-activities feature and this
// one could eventually share one geocode cache, but kept separate for now
// to avoid coupling two otherwise-independent features.
const GEOCODE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const GEOCODE_EMPTY_TTL_MS = 60 * 60 * 1000; // 1h — same negative-cache reasoning as above
const eventsGeocodeCache = new Map(); // hometown (lowercased) -> { coords, fetchedAt }

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of eventsCache) {
    const ttl = entry.events.length ? EVENTS_CACHE_TTL_MS : EVENTS_EMPTY_TTL_MS;
    if (now - entry.fetchedAt > ttl) eventsCache.delete(key);
  }
  for (const [key, entry] of eventsGeocodeCache) {
    const ttl = entry.coords ? GEOCODE_CACHE_TTL_MS : GEOCODE_EMPTY_TTL_MS;
    if (now - entry.fetchedAt > ttl) eventsGeocodeCache.delete(key);
  }
}, 60 * 60 * 1000).unref();

async function getEventsGeocode(hometown) {
  const key = hometown.trim().toLowerCase();
  const cached = eventsGeocodeCache.get(key);
  if (cached) {
    const ttl = cached.coords ? GEOCODE_CACHE_TTL_MS : GEOCODE_EMPTY_TTL_MS;
    if (Date.now() - cached.fetchedAt < ttl) return cached.coords;
  }
  let coords = null;
  try {
    coords = await geocodeHometown({ hometown });
  } catch (e) {
    console.error('[ticketmaster] geocode threw:', e.message);
  }
  eventsGeocodeCache.set(key, { coords, fetchedAt: Date.now() });
  return coords;
}

// Ticketmaster's date filters are UTC and this app only knows a hometown's
// *local* calendar dates (no per-city timezone lookup) — rather than guess
// at a UTC offset, the query window is widened by a day on each side and
// results are filtered precisely afterward using each event's own
// dates.start.localDate (already in the venue's local time, no timezone
// math needed — same trick fitsBreak() in lib/travelpayouts.js uses for
// flight dates). This can never show an event outside the break; at worst
// it queries slightly more than needed.
async function buildEventsForBreak(brk, settings) {
  if (!TICKETMASTER_API_KEY || !settings.hometown) {
    return { source: 'not-configured', events: [] };
  }

  const cacheKey = `${settings.hometown.trim().toLowerCase()}|${brk.key}`;
  const cached = eventsCache.get(cacheKey);
  if (cached) {
    const ttl = cached.events.length ? EVENTS_CACHE_TTL_MS : EVENTS_EMPTY_TTL_MS;
    if (Date.now() - cached.fetchedAt < ttl) {
      return { source: cached.events.length ? 'real' : 'no-results', events: cached.events };
    }
  }

  const coords = await getEventsGeocode(settings.hometown);
  if (!coords) {
    eventsCache.set(cacheKey, { events: [], fetchedAt: Date.now() });
    return { source: 'no-results', events: [] };
  }

  const startDateTime = `${toISO(addDays(brk.start, -1))}T00:00:00Z`;
  const endDateTime = `${toISO(addDays(brk.end, 1))}T23:59:59Z`;

  let found = [];
  try {
    found = await findEvents({
      apiKey: TICKETMASTER_API_KEY,
      lat: coords.lat,
      lon: coords.lon,
      startDateTime,
      endDateTime
    });
  } catch (e) {
    console.error('[ticketmaster] findEvents threw:', e.message);
  }

  const breakStart = toISO(brk.start);
  const breakEnd = toISO(brk.end);
  const events = found
    .filter(e => e.localDate >= breakStart && e.localDate <= breakEnd)
    // No-op unless TICKETMASTER_AFFILIATE_LINK_PREFIX is set — the normal
    // path is Ticketmaster auto-tracking `url` once your Impact Publisher
    // ID is linked in their developer portal, see the const above.
    .map(e => ({ ...e, url: buildEventUrl(e.url, TICKETMASTER_AFFILIATE_LINK_PREFIX) }));

  eventsCache.set(cacheKey, { events, fetchedAt: Date.now() });
  return { source: events.length ? 'real' : 'no-results', events };
}

// ---------- auth ----------
// Bumping this forces nothing retroactively (existing accounts keep their
// original acceptance on file), but it's recorded per-account so you have a
// paper trail of who agreed to which version, and could require
// re-acceptance on a version bump later if you ever need to.
const TERMS_VERSION = '2026-07-11';

// `deviceId` here is whatever anonymous X-User-Id this browser already had
// before logging in/signing up — if it has saved settings, they're carried
// over into the account rather than forcing the person to redo Setup.
async function handleSignup(req, res, deviceId) {
  const body = await readJsonBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (!isValidEmail(email)) return sendJson(res, 400, { error: 'Enter a valid email address.' });
  if (password.length < 8) return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
  if (body.acceptedTerms !== true) return sendJson(res, 400, { error: 'You must accept the Terms and Conditions to create an account.' });
  if (getAccount(email)) return sendJson(res, 409, { error: 'An account with that email already exists — try logging in instead.' });

  createAccount(email, {
    passwordHash: hashPassword(password),
    termsAcceptedAt: new Date().toISOString(),
    termsVersion: TERMS_VERSION,
    marketingOptIn: body.marketingOptIn === true
  });
  if (deviceId) migrateUser(deviceId, email);

  const token = createSessionToken();
  createSession(token, email);
  setSessionCookie(req, res, token);
  sendJson(res, 200, { email });
}

async function handleLogin(req, res, deviceId) {
  const body = await readJsonBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  const account = getAccount(email);
  if (!account || !account.passwordHash || !verifyPassword(password, account.passwordHash)) {
    return sendJson(res, 401, { error: 'Incorrect email or password.' });
  }

  if (deviceId) migrateUser(deviceId, email);

  const token = createSessionToken();
  createSession(token, email);
  setSessionCookie(req, res, token);
  sendJson(res, 200, { email });
}

async function handleGoogleAuth(req, res, deviceId) {
  if (!GOOGLE_CLIENT_ID) return sendJson(res, 500, { error: 'Google sign-in is not configured on this server.' });
  const body = await readJsonBody(req);
  const idToken = body.credential || body.idToken;
  if (!idToken) return sendJson(res, 400, { error: 'Missing Google credential.' });

  const claims = await verifyGoogleIdToken({ idToken, clientId: GOOGLE_CLIENT_ID });
  if (!claims) return sendJson(res, 401, { error: 'Could not verify Google sign-in. Please try again.' });

  // Terms acceptance is only required when this Google sign-in is actually
  // creating a brand-new account — an existing user (password or Google)
  // signing back in already accepted at their original signup and
  // shouldn't be blocked on re-accepting just to log in.
  const isNewAccount = !getAccount(claims.email);
  if (isNewAccount && body.acceptedTerms !== true) {
    return sendJson(res, 400, { error: 'You must accept the Terms and Conditions to create an account.' });
  }

  upsertGoogleAccount(claims.email, claims.sub, isNewAccount
    ? { termsAcceptedAt: new Date().toISOString(), termsVersion: TERMS_VERSION, marketingOptIn: body.marketingOptIn === true }
    : {});
  if (deviceId) migrateUser(deviceId, claims.email);

  const token = createSessionToken();
  createSession(token, claims.email);
  setSessionCookie(req, res, token);
  sendJson(res, 200, { email: claims.email });
}

async function handleLogout(req, res) {
  const cookies = parseCookies(req);
  deleteSession(cookies[SESSION_COOKIE]);
  clearSessionCookie(req, res);
  sendJson(res, 200, { loggedOut: true });
}

async function handleMe(req, res) {
  const cookies = parseCookies(req);
  const email = getSessionEmail(cookies[SESSION_COOKIE]);
  // isAdmin drives whether the frontend shows a nav link to /admin.html at
  // all (see renderAccountArea in index.html) — purely a discoverability
  // convenience, not the actual access control. /admin.html and
  // /api/admin/stats both re-check ADMIN_EMAILS themselves server-side
  // regardless of what this flag says, so a non-admin can't see real data
  // even if they somehow forced the link to render.
  const isAdmin = !!(email && ADMIN_EMAILS.includes(email.toLowerCase()));
  sendJson(res, 200, { loggedIn: !!email, email: email || null, googleClientId: GOOGLE_CLIENT_ID || null, isAdmin });
}

// Always responds with the same generic message regardless of whether the
// account exists — otherwise this endpoint could be used to check which
// emails have an account here (email enumeration).
async function handleForgotPassword(req, res) {
  const body = await readJsonBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const genericMessage = { message: "If an account exists for that email, we've sent a password reset link." };

  if (!isValidEmail(email)) return sendJson(res, 200, genericMessage);

  const account = getAccount(email);
  if (account) {
    const token = createResetToken();
    createPasswordReset(token, email, PASSWORD_RESET_TTL_MS);
    const resetUrl = `${originFromRequest(req)}/?resetToken=${token}`;

    const sent = RESEND_API_KEY
      ? await sendPasswordResetEmail({ to: email, resetUrl, apiKey: RESEND_API_KEY, fromAddress: EMAIL_FROM })
      : false;

    if (!sent) {
      // No email provider configured (or the send failed) — log the link
      // so local/dev testing still works without needing a real inbox.
      // This is a deliberate fallback, not silent failure: the server logs
      // make it obvious a real email was never actually sent.
      console.log(`[auth] Password reset link for ${email} (RESEND_API_KEY ${RESEND_API_KEY ? 'set but send failed' : 'not set'}): ${resetUrl}`);
    }
  }

  sendJson(res, 200, genericMessage);
}

async function handleResetPassword(req, res) {
  const body = await readJsonBody(req);
  const token = String(body.token || '');
  const password = String(body.password || '');

  if (password.length < 8) return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });

  const email = getPasswordResetEmail(token);
  if (!email) return sendJson(res, 400, { error: 'This reset link is invalid or has expired — request a new one.' });

  setAccountPassword(email, hashPassword(password));
  deletePasswordReset(token);
  deleteAllSessionsForEmail(email); // force re-login everywhere, including whoever is mid-reset right now

  sendJson(res, 200, { success: true });
}

// ---------- profile (display name + avatar — real accounts only) ----------
// Unlike the rest of the app, profile data belongs to an *account*, not a
// device — there's no meaningful "anonymous profile," so this checks for an
// actual session rather than falling back to X-User-Id like getUserId does.
function requireSessionEmail(req, res) {
  const cookies = parseCookies(req);
  const email = getSessionEmail(cookies[SESSION_COOKIE]);
  if (!email) {
    sendJson(res, 401, { error: 'You need to be logged in to do that.' });
    return null;
  }
  return email;
}

async function handleGetProfile(req, res) {
  const email = requireSessionEmail(req, res);
  if (!email) return;
  const account = getAccount(email);
  sendJson(res, 200, { email, displayName: account?.displayName || '', avatarUrl: account?.avatarUrl || null, marketingOptIn: !!account?.marketingOptIn });
}

async function handlePutProfile(req, res) {
  const email = requireSessionEmail(req, res);
  if (!email) return;

  // Avatar images arrive as a base64 data URL rather than multipart form
  // data — Node's http module doesn't parse multipart bodies itself, and
  // pulling in a library for it would break the zero-dependency rule for
  // what's otherwise a small image. A data URL keeps this a plain JSON
  // body like every other endpoint here.
  //
  // The raw-body limit here is intentionally well above MAX_AVATAR_BYTES:
  // base64 inflates size by ~4/3, and a too-tight transport-level limit
  // would hard-reset the connection (readRawBody's req.destroy()) before a
  // friendly "image too large" JSON response could be sent for a
  // moderately-oversized upload. The real size enforcement is the
  // MAX_AVATAR_BYTES check below, on the *decoded* bytes.
  const body = await readJsonBody(req, 10_000_000);
  const patch = {};

  if (typeof body.displayName === 'string') {
    const name = body.displayName.trim().slice(0, 60);
    patch.displayName = name;
  }

  if (typeof body.marketingOptIn === 'boolean') {
    patch.marketingOptIn = body.marketingOptIn;
  }

  if (typeof body.avatarDataUrl === 'string' && body.avatarDataUrl.length) {
    const match = body.avatarDataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/);
    if (!match) return sendJson(res, 400, { error: 'Unsupported image format — please use PNG, JPEG, or WebP.' });

    const mime = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
    const ext = AVATAR_MIME_EXT[mime];
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > MAX_AVATAR_BYTES) {
      return sendJson(res, 400, { error: 'Image too large — please use an image under 2MB.' });
    }

    if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });

    // Clean up the previous avatar file (if any) so they don't pile up on
    // disk every time someone changes their picture.
    const existing = getAccount(email);
    if (existing?.avatarUrl) {
      const oldPath = path.join(AVATAR_DIR, path.basename(existing.avatarUrl));
      fs.unlink(oldPath, () => {}); // best-effort; fine if it's already gone
    }

    const filename = `${crypto.createHash('sha256').update(email).digest('hex')}-${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(AVATAR_DIR, filename), buffer);
    patch.avatarUrl = `/avatars/${filename}`;
  }

  const updated = setAccountProfile(email, patch);
  sendJson(res, 200, { email, displayName: updated?.displayName || '', avatarUrl: updated?.avatarUrl || null, marketingOptIn: !!updated?.marketingOptIn });
}

// ---------- route handlers ----------
async function handleGetSettings(req, res, userId) {
  sendJson(res, 200, getSettings(userId));
}

async function handlePutSettings(req, res, userId) {
  const body = await readJsonBody(req);
  const allowed = ['hometown', 'originAirport', 'currency', 'rosterMode', 'pattern', 'manualBreaks', 'interests'];
  const patch = {};
  for (const k of allowed) if (k in body) patch[k] = body[k];
  if (typeof patch.originAirport === 'string') patch.originAirport = patch.originAirport.trim().toUpperCase();
  if (Array.isArray(patch.interests)) {
    // Only keep known tags — junk from a stale client or a hand-crafted
    // request shouldn't end up steering deal selection.
    patch.interests = patch.interests.filter(t => INTEREST_TAGS.includes(t));
  }
  const updated = saveSettings(userId, patch);
  sendJson(res, 200, updated);
}

async function handleGetBreaks(req, res, userId) {
  const settings = getSettings(userId);
  const breaks = computeUpcomingBreaks(settings);
  const result = breaks.map(b => presentBreak(b, settings));
  sendJson(res, 200, {
    breaks: result,
    hometown: settings.hometown || '',
    realPricesAvailable: !!(TRAVELPAYOUTS_TOKEN && settings.originAirport),
    rosterMode: settings.rosterMode || 'pattern',
    pattern: settings.pattern || null,
    interests: settings.interests || []
  });
}

// ---------- calendar export ----------
// The token endpoint is behind the normal userId gate (device id or
// session), but the .ics feed itself is deliberately NOT — calendar apps
// (Google/Apple/Outlook) fetch subscribed feeds unattended on their own
// schedule with no login, so the token in the URL is the only thing
// protecting it. Same trust model as e.g. a Google Calendar "secret
// address" ICS link.
async function handleGetCalendarToken(req, res, userId) {
  let token = getCalendarTokenForUser(userId);
  if (!token) {
    token = createCalendarToken();
    setCalendarToken(token, userId);
  }
  const origin = originFromRequest(req);
  sendJson(res, 200, { icsUrl: `${origin}/calendar/${token}.ics` });
}

async function handleCalendarFeed(req, res, token) {
  const userId = getUserIdForCalendarToken(token);
  if (!userId) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Calendar feed not found.');
  }
  const settings = getSettings(userId);
  const breaks = computeUpcomingBreaks(settings);
  const ics = buildBreaksICS(breaks, { calendarName: 'My Next Break', domain: 'nextbreak.com.au' });
  res.writeHead(200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'inline; filename="next-break.ics"',
    'Cache-Control': 'no-store'
  });
  res.end(ics);
}

// Personalisation only applies for a real logged-in session, not the
// anonymous per-device id — "learn what a logged-in user likes" was the
// ask, and it also means a signed-out visitor never gets nudged off the
// plain cheapest-fare result by leftover local data.
function buildPersonalizationProfile(req, settings) {
  const cookies = parseCookies(req);
  const loggedIn = !!getSessionEmail(cookies[SESSION_COOKIE]);
  if (!loggedIn) return null;
  const interests = settings.interests || [];
  const affinity = settings.dealAffinity || {};
  if (!interests.length && !Object.keys(affinity).length) return null;
  return { interests, affinity };
}

async function handleGetDeals(req, res, userId, query) {
  const breakKey = query.get('breakKey');
  if (!breakKey) return sendJson(res, 400, { error: 'breakKey is required' });

  const settings = getSettings(userId);
  const breaks = computeUpcomingBreaks(settings);
  const brk = breaks.find(b => b.key === breakKey);
  if (!brk) return sendJson(res, 404, { error: 'That break no longer matches your current roster.' });

  const profile = buildPersonalizationProfile(req, settings);
  const { source, deals, fetchedAt } = await buildDealsForBreak(brk, settings, { profile });
  sendJson(res, 200, { breakKey, source, currencySymbol: CURRENCY_SYMBOLS[settings.currency] || 'A$', deals, fetchedAt, personalized: !!profile });
}

// ---------- implicit learning: which real fares a logged-in user actually
// clicks "Book this fare" on. A click nudges up the affinity score for
// every tag on that destination (see selectDeals/pickBest in
// lib/travelpayouts.js) — capped per-tag influence there, so this can't
// snowball into always showing the same handful of places. The affinity
// nudge itself only makes sense for a logged-in account (it lives on their
// saved settings), but the click is still logged for the admin dashboard's
// aggregate count either way, so anonymous browsing (which this app fully
// supports) isn't invisible to "how many people click travel deals."
async function handleDealClick(req, res) {
  const body = await readJsonBody(req);
  const dest = REAL_DESTINATIONS.find(d => d.iata === body.iata);
  if (!dest) return sendJson(res, 400, { error: 'Unknown destination.' });

  const cookies = parseCookies(req);
  const email = getSessionEmail(cookies[SESSION_COOKIE]);
  if (email) {
    const settings = getSettings(email);
    const affinity = { ...(settings.dealAffinity || {}) };
    for (const tag of dest.tags || []) affinity[tag] = (affinity[tag] || 0) + 1;
    saveSettings(email, { dealAffinity: affinity });
  }

  // Separate from the affinity nudge above — this is a durable, aggregate
  // log for the admin dashboard (which destinations get clicked, when, and
  // by whom if logged in), not something used to steer deal selection.
  recordDealClick(email, { iata: dest.iata, name: dest.name });

  sendJson(res, 200, { ok: true });
}

// Same shape and same anonymous-inclusive reasoning as handleDealClick
// above, for the Ticketmaster "Tickets ->" link. There's no fixed catalog
// to validate an event id against (unlike REAL_DESTINATIONS for flights),
// so this just does basic shape/length checks to keep the log honest and
// stop it being used to stuff arbitrary junk into data.json.
async function handleEventClick(req, res) {
  const body = await readJsonBody(req);
  const id = typeof body.id === 'string' ? body.id.slice(0, 200) : null;
  const name = typeof body.name === 'string' ? body.name.slice(0, 200) : null;
  if (!id && !name) return sendJson(res, 400, { error: 'Missing event id/name.' });

  const cookies = parseCookies(req);
  const email = getSessionEmail(cookies[SESSION_COOKIE]);

  recordEventClick(email, { id, name });

  sendJson(res, 200, { ok: true });
}

// ---------- feedback bubble ----------
// A reaction is required (that's the one-tap minimum the bubble is built
// around); topics and comment are both optional extras. Anonymous-safe,
// same reasoning as deal/event clicks above — most people giving quick
// feedback won't be logged in, and that shouldn't stop it being recorded.
const FEEDBACK_REACTIONS = ['love', 'good', 'meh', 'frustrated'];
const FEEDBACK_TOPICS = ['flights', 'events', 'setup', 'pricing', 'bug', 'other'];

async function handleFeedback(req, res) {
  const body = await readJsonBody(req);
  if (!FEEDBACK_REACTIONS.includes(body.reaction)) {
    return sendJson(res, 400, { error: 'A valid reaction is required.' });
  }
  const topics = Array.isArray(body.topics)
    ? [...new Set(body.topics.filter(t => FEEDBACK_TOPICS.includes(t)))]
    : [];
  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 1000) : '';
  const view = typeof body.view === 'string' ? body.view.slice(0, 40) : null;

  const cookies = parseCookies(req);
  const email = getSessionEmail(cookies[SESSION_COOKIE]);

  recordFeedback(email, { reaction: body.reaction, topics, comment, view });

  sendJson(res, 200, { ok: true });
}

async function handleGetActivities(req, res, userId) {
  const settings = getSettings(userId);
  const { source, activities } = await buildActivitiesForSettings(settings);
  sendJson(res, 200, { source, hometown: settings.hometown || '', activities });
}

// Hometown-based like activities, not break-based like deals/events — a
// restaurant search link doesn't depend on the break's dates, so there's
// nothing to look up per-break. No network call at all (see
// lib/opentable.js), so this never needs caching either.
function buildRestaurantForSettings(settings) {
  if (!settings.hometown) return { source: 'not-configured', restaurant: null };
  const restaurant = findRestaurantLink({
    hometown: settings.hometown,
    affiliatePrefix: OPENTABLE_AFFILIATE_LINK_PREFIX
  });
  return { source: 'real', restaurant };
}

async function handleGetRestaurants(req, res, userId) {
  const settings = getSettings(userId);
  const { source, restaurant } = buildRestaurantForSettings(settings);
  sendJson(res, 200, { source, hometown: settings.hometown || '', restaurant });
}

// Break-based like events, not hometown-only like restaurants above — a
// staycation is booked for a specific break's actual dates, so the link
// needs breakKey to know which break's start/end to pre-fill. No network
// call at all (see lib/booking.js), so no caching needed either.
function buildStayForBreak(brk, settings) {
  if (!settings.hometown) return { source: 'not-configured', stay: null };
  const stay = findStayLink({
    hometown: settings.hometown,
    checkin: toISO(brk.start),
    checkout: toISO(brk.end),
    affiliatePrefix: BOOKING_AFFILIATE_LINK_PREFIX
  });
  return { source: 'real', stay };
}

async function handleGetStay(req, res, userId, query) {
  const breakKey = query.get('breakKey');
  if (!breakKey) return sendJson(res, 400, { error: 'breakKey is required' });

  const settings = getSettings(userId);
  const breaks = computeUpcomingBreaks(settings);
  const brk = breaks.find(b => b.key === breakKey);
  if (!brk) return sendJson(res, 404, { error: 'That break no longer matches your current roster.' });

  const { source, stay } = buildStayForBreak(brk, settings);
  sendJson(res, 200, { breakKey, source, hometown: settings.hometown || '', stay });
}

async function handleGetEvents(req, res, userId, query) {
  const breakKey = query.get('breakKey');
  if (!breakKey) return sendJson(res, 400, { error: 'breakKey is required' });

  const settings = getSettings(userId);
  const breaks = computeUpcomingBreaks(settings);
  const brk = breaks.find(b => b.key === breakKey);
  if (!brk) return sendJson(res, 404, { error: 'That break no longer matches your current roster.' });

  const { source, events } = await buildEventsForBreak(brk, settings);
  sendJson(res, 200, { breakKey, source, hometown: settings.hometown || '', events });
}

// ---------- break-reminder digest ----------
// Roster-based, not calendar-based: this runs a sweep on a fixed interval
// (see the setInterval near the bottom of this file), but each account
// only ever gets an email when THEIR next break is 5-7 days out, and only
// once per break (see hasDigestSent/recordDigestSent in lib/store.js and
// pickEligibleBreak in lib/digest.js). That means the frequency naturally
// matches how often someone actually has a break coming up, not a fixed
// weekly/daily marketing schedule — the goal is for this to never feel
// like spam.
async function runDigestSweep() {
  if (!RESEND_API_KEY) return; // nothing to send through — skip the work entirely

  const accounts = listAccounts().filter(a => a.marketingOptIn);
  for (const account of accounts) {
    try {
      await maybeSendDigestForAccount(account.email);
    } catch (e) {
      // One account's failure (bad settings, a transient fetch error) should
      // never stop the rest of the sweep from running.
      console.error(`[digest] sweep failed for ${account.email}:`, e.message);
    }
  }
}

async function maybeSendDigestForAccount(email) {
  const settings = getSettings(email);
  if (!settings.hometown) return; // nothing meaningful to report without a roster set up

  const breaks = computeUpcomingBreaks(settings).map(b => ({ ...b, ...breakStatus(b) }));
  const brk = pickEligibleBreak(breaks, key => hasDigestSent(email, key));
  if (!brk) return;

  const [dealsResult, eventsResult] = await Promise.all([
    buildDealsForBreak(brk, settings),
    buildEventsForBreak(brk, settings)
  ]);
  const deals = dealsResult.deals || [];
  const events = eventsResult.events || [];

  // Only bother looking up the free/bookable fallback if there's actually
  // nothing else to report — same "don't do work nobody will see" reasoning
  // as the on-page version in index.html.
  const activities = (!deals.length && !events.length)
    ? (await buildActivitiesForSettings(settings)).activities
    : [];

  if (!deals.length && !events.length && !activities.length) {
    // Genuinely nothing to say — better to skip the email than send an
    // empty one just to say something.
    recordDigestSent(email, brk.key);
    return;
  }

  const token = getOrCreateUnsubscribeToken(email);
  const sent = await sendBreakDigestEmail({
    to: email,
    hometown: settings.hometown,
    breakStart: toISO(brk.start),
    breakEnd: toISO(brk.end),
    daysUntil: brk.daysUntil,
    deals,
    events,
    activities,
    unsubscribeUrl: `${PUBLIC_BASE_URL}/api/unsubscribe?token=${token}`,
    currencySymbol: CURRENCY_SYMBOLS[settings.currency] || 'A$',
    apiKey: RESEND_API_KEY,
    fromAddress: EMAIL_FROM
  });

  // Recorded either way — a failed send shouldn't be retried every sweep
  // for the same break; if it matters, it'll show up in server logs.
  recordDigestSent(email, brk.key);
  if (!sent) console.error(`[digest] send failed for ${email}, break ${brk.key}`);
}

async function handleUnsubscribe(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const token = url.searchParams.get('token');
  const email = token && getEmailByUnsubscribeToken(token);

  if (!email) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<p>That unsubscribe link looks invalid or has expired.</p>');
  }

  setAccountProfile(email, { marketingOptIn: false });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center;">
    <p>You've been unsubscribed from Next Break's break reminders. You won't get any more of these emails.</p>
    <p><a href="${PUBLIC_BASE_URL}">Back to Next Break</a></p>
  </body></html>`);
}

// ---------- personal stats ----------
// Logged-in only, same reasoning as personalisation/deal-click tracking
// above — an anonymous device id has no durable click history worth
// showing. Deliberately built only from data we actually record: real
// upcoming breaks from the roster, and "Book this fare" clicks. We never
// see whether a click actually turned into a completed booking (that
// happens on the airline/OTA's own site), so this is framed as "deals
// you've clicked into," not "trips you've taken" — no fabricated numbers.
async function handleGetStats(req, res) {
  const email = requireSessionEmail(req, res);
  if (!email) return;

  const account = getAccount(email);
  const settings = getSettings(email);
  const breaks = computeUpcomingBreaks(settings);

  let nextBreak = null;
  if (breaks.length) {
    const b = breaks[0];
    const status = breakStatus(b);
    nextBreak = {
      start: toISO(b.start),
      end: toISO(b.end),
      duration: b.duration,
      daysUntil: status.daysUntil,
      isOngoing: status.isOngoing
    };
  }

  const myClicks = listDealClicks().filter(c => c.email === email.toLowerCase());
  const byDestination = new Map();
  for (const c of myClicks) {
    const key = c.iata || 'unknown';
    if (!byDestination.has(key)) byDestination.set(key, { iata: key, name: c.name || key, count: 0 });
    byDestination.get(key).count++;
  }
  const topDestinations = [...byDestination.values()].sort((a, b) => b.count - a.count).slice(0, 5);
  const recentClicks = [...myClicks].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 5);

  sendJson(res, 200, {
    memberSince: account?.createdAt || null,
    interests: settings.interests || [],
    upcomingBreaksCount: breaks.length,
    nextBreak,
    dealClicks: {
      total: myClicks.length,
      uniqueDestinations: byDestination.size,
      topDestinations,
      recent: recentClicks
    }
  });
}

// ---------- admin dashboard ----------
// Not a separate login — reuses the normal session cookie and just checks
// the logged-in email against ADMIN_EMAILS (see const above). Returns 401
// if nobody's logged in, 403 if they're logged in as someone who isn't an
// admin, so a regular user hitting these routes by accident/curiosity gets
// a clear "not authorized" rather than leaking whether the route exists.
function requireAdminEmail(req, res) {
  const email = requireSessionEmail(req, res); // sends its own 401 if not logged in
  if (!email) return null;
  if (!ADMIN_EMAILS.length || !ADMIN_EMAILS.includes(email.toLowerCase())) {
    sendJson(res, 403, { error: 'Not authorized.' });
    return null;
  }
  return email;
}

// ---------- day-bucketing helpers for admin trend charts ----------
// Turn a list of records with an ISO-timestamp field into a { 'YYYY-MM-DD':
// count } map. Used to build both the dense 30-point series the line charts
// draw and the week-over-week growth comparison below.
function bucketByDay(items, dateField) {
  const map = {};
  for (const item of items) {
    const iso = item[dateField];
    if (!iso) continue;
    const key = String(iso).slice(0, 10);
    map[key] = (map[key] || 0) + 1;
  }
  return map;
}

// Sums a day-map over an exact calendar-day window, offsetStart..offsetEnd
// days back from today (offsetStart inclusive, offsetEnd exclusive) — same
// "walk backward by real day, missing day = 0" approach as sumLastNDays
// below, generalised so it can express "the 7 days before last week" too.
function sumDayRange(dayMap, offsetStart, offsetEnd) {
  let sum = 0;
  const cursor = new Date();
  for (let i = offsetStart; i < offsetEnd; i++) {
    const d = new Date(cursor);
    d.setUTCDate(d.getUTCDate() - i);
    sum += dayMap[d.toISOString().slice(0, 10)] || 0;
  }
  return sum;
}

// A continuous, oldest-to-newest run of exactly `days` points (zero-filled
// for days with no activity) — what the line charts on the admin page plot.
// Deliberately different from the sparse day-map above: a chart needs every
// x position to exist, a table/total doesn't.
function denseDailySeries(dayMap, days) {
  const out = [];
  const cursor = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(cursor);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, count: dayMap[key] || 0 });
  }
  return out;
}

// This-week-vs-last-week growth, with a direction the frontend can colour
// directly (green up / red down / grey flat) without redoing the math.
// prev7 === 0 with last7 > 0 is "new" activity where there was none the
// week before — there's no meaningful percentage for that, so pct stays
// null but direction is still 'up'.
function computeGrowth(dayMap) {
  const last7 = sumDayRange(dayMap, 0, 7);
  const prev7 = sumDayRange(dayMap, 7, 14);
  let pct = null;
  let direction = 'flat';
  if (prev7 > 0) {
    pct = Math.round(((last7 - prev7) / prev7) * 1000) / 10;
    direction = pct > 0 ? 'up' : (pct < 0 ? 'down' : 'flat');
  } else if (last7 > 0) {
    direction = 'up';
  }
  return { last7, prev7, pct, direction };
}

async function handleAdminStats(req, res) {
  const email = requireAdminEmail(req, res);
  if (!email) return;

  const accounts = listAccounts();
  const clicks = listDealClicks();
  const eventClicks = listEventClicks();
  const feedbackItems = listFeedback();

  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const withinDays = (iso, days) => {
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && now - t <= days * DAY_MS;
  };

  const byDestination = new Map();
  for (const c of clicks) {
    const key = c.iata || 'unknown';
    if (!byDestination.has(key)) byDestination.set(key, { iata: key, name: c.name || key, count: 0 });
    byDestination.get(key).count++;
  }
  const topDestinations = [...byDestination.values()].sort((a, b) => b.count - a.count).slice(0, 10);

  const byEvent = new Map();
  for (const c of eventClicks) {
    const key = c.id || c.name || 'unknown';
    if (!byEvent.has(key)) byEvent.set(key, { id: c.id, name: c.name || key, count: 0 });
    byEvent.get(key).count++;
  }
  const topEvents = [...byEvent.values()].sort((a, b) => b.count - a.count).slice(0, 10);

  const byReaction = { love: 0, good: 0, meh: 0, frustrated: 0 };
  for (const f of feedbackItems) {
    if (byReaction[f.reaction] !== undefined) byReaction[f.reaction]++;
  }
  // Newest-first, capped at 50 rather than the usual 25 — this is the one
  // list you actually want to read through (not just skim aggregates of),
  // since the whole point of the feedback bubble is to surface real
  // comments, so give it a bit more room.
  const recentFeedback = [...feedbackItems]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 50);

  const recentSignups = [...accounts]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 25)
    .map(a => ({ email: a.email, createdAt: a.createdAt, marketingOptIn: !!a.marketingOptIn, signedUpVia: a.hasGoogle ? 'Google' : 'Password' }));

  const recentClicks = [...clicks]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 25);

  const recentEventClicks = [...eventClicks]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 25);

  // Site visits — a plain per-day count (see lib/store.js recordVisit for
  // why). Summed over exact calendar-day windows rather than just slicing
  // the last N keys out of visitsByDay, since a day with zero visits never
  // gets a key at all — slicing would silently reach further back in time
  // on any low-traffic stretch instead of correctly counting that day as 0.
  const visitsByDay = getVisitsByDay();
  const days = Object.keys(visitsByDay).sort(); // oldest -> newest, for the total below
  function sumLastNDays(n) {
    let sum = 0;
    const cursor = new Date();
    for (let i = 0; i < n; i++) {
      sum += visitsByDay[cursor.toISOString().slice(0, 10)] || 0;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    return sum;
  }
  const dailyVisits = days.slice(-30).map(date => ({ date, count: visitsByDay[date] })).reverse();

  const visits30 = sumLastNDays(30);
  const signups30 = accounts.filter(a => withinDays(a.createdAt, 30)).length;
  const dealClicks30 = clicks.filter(c => withinDays(c.at, 30)).length;
  const eventClicks30 = eventClicks.filter(c => withinDays(c.at, 30)).length;
  // Rough, deidentified engagement ratios over the last 30 days — "rough"
  // because a single visitor can account for multiple visits/clicks (there's
  // no per-visitor id to dedupe against, by design, see recordVisit), so
  // read these as engagement intensity, not a literal "% of people who...".
  const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

  // Day-maps for the other 3 metrics, same shape as visitsByDay above, so
  // the trend charts and growth badges can treat all 4 metrics uniformly.
  const signupsByDay = bucketByDay(accounts, 'createdAt');
  const dealClicksByDay = bucketByDay(clicks, 'at');
  const eventClicksByDay = bucketByDay(eventClicks, 'at');

  const series = {
    visits: denseDailySeries(visitsByDay, 30),
    signups: denseDailySeries(signupsByDay, 30),
    dealClicks: denseDailySeries(dealClicksByDay, 30),
    eventClicks: denseDailySeries(eventClicksByDay, 30)
  };

  // Week-over-week growth (last 7 days vs the 7 days before that), with a
  // ready-to-colour direction per metric.
  const growth = {
    visits: computeGrowth(visitsByDay),
    signups: computeGrowth(signupsByDay),
    dealClicks: computeGrowth(dealClicksByDay),
    eventClicks: computeGrowth(eventClicksByDay)
  };

  sendJson(res, 200, {
    accounts: {
      total: accounts.length,
      last7Days: accounts.filter(a => withinDays(a.createdAt, 7)).length,
      last30Days: signups30,
      marketingOptIn: accounts.filter(a => a.marketingOptIn).length
    },
    dealClicks: {
      total: clicks.length,
      last7Days: clicks.filter(c => withinDays(c.at, 7)).length,
      last30Days: dealClicks30,
      topDestinations
    },
    eventClicks: {
      total: eventClicks.length,
      last7Days: eventClicks.filter(c => withinDays(c.at, 7)).length,
      last30Days: eventClicks30,
      topEvents
    },
    visits: {
      total: days.reduce((sum, d) => sum + visitsByDay[d], 0),
      today: visitsByDay[new Date().toISOString().slice(0, 10)] || 0,
      last7Days: sumLastNDays(7),
      last30Days: visits30,
      dailyVisits
    },
    engagement: {
      // Per-visit rates over the last 30 days, e.g. 4.2 means "4.2 signups
      // per 100 visits" — useful as a trend to watch even though it's not a
      // true unique-visitor conversion rate (see note above).
      signupsPer100Visits: pct(signups30, visits30),
      dealClicksPer100Visits: pct(dealClicks30, visits30),
      eventClicksPer100Visits: pct(eventClicks30, visits30)
    },
    series,
    growth,
    feedback: {
      total: feedbackItems.length,
      last7Days: feedbackItems.filter(f => withinDays(f.at, 7)).length,
      last30Days: feedbackItems.filter(f => withinDays(f.at, 30)).length,
      byReaction,
      recent: recentFeedback
    },
    recentSignups,
    recentClicks,
    recentEventClicks
  });
}

async function handleCheckout(req, res, userId) {
  if (!STRIPE_SECRET_KEY) {
    return sendJson(res, 500, { error: 'Stripe is not configured on this server yet. Set STRIPE_SECRET_KEY in .env (see README).' });
  }
  const body = await readJsonBody(req);
  const { breakKey } = body;
  if (!breakKey) return sendJson(res, 400, { error: 'breakKey is required' });

  const settings = getSettings(userId);
  const breaks = computeUpcomingBreaks(settings);
  const brk = breaks.find(b => b.key === breakKey);
  if (!brk) return sendJson(res, 404, { error: 'That break no longer matches your current roster.' });

  if (isUnlocked(userId, breakKey)) {
    return sendJson(res, 200, { alreadyUnlocked: true });
  }

  const origin = originFromRequest(req);
  const currency = (settings.currency || 'AUD').toLowerCase();
  try {
    const session = await createCheckoutSession({
      secretKey: STRIPE_SECRET_KEY,
      amountCents: UNLOCK_FEE_CENTS,
      currency,
      productName: `Unlock travel deals — break ${brk.key.replace('_', ' to ')}`,
      successUrl: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}&break=${encodeURIComponent(breakKey)}`,
      cancelUrl: `${origin}/?checkout=cancelled`,
      clientReferenceId: userId,
      metadata: { user_id: userId, break_key: breakKey }
    });
    sendJson(res, 200, { url: session.url, id: session.id });
  } catch (e) {
    sendJson(res, 502, { error: e.message });
  }
}

async function handleConfirmCheckout(req, res, userId, query) {
  if (!STRIPE_SECRET_KEY) {
    return sendJson(res, 500, { error: 'Stripe is not configured on this server yet.' });
  }
  const sessionId = query.get('session_id');
  if (!sessionId) return sendJson(res, 400, { error: 'session_id is required' });

  try {
    const session = await retrieveCheckoutSession(STRIPE_SECRET_KEY, sessionId);
    const breakKey = session.metadata?.break_key;
    const paidUserId = session.client_reference_id;

    if (session.payment_status !== 'paid') {
      return sendJson(res, 200, { unlocked: false, status: session.payment_status });
    }
    if (!breakKey || !paidUserId) {
      return sendJson(res, 500, { error: 'Session is missing expected metadata.' });
    }
    if (!isUnlocked(paidUserId, breakKey)) {
      markUnlocked(paidUserId, breakKey, {
        sessionId,
        amountCents: session.amount_total,
        currency: session.currency,
        paidAt: new Date().toISOString()
      });
    }
    sendJson(res, 200, { unlocked: true, breakKey });
  } catch (e) {
    sendJson(res, 502, { error: e.message });
  }
}

async function handleWebhook(req, res) {
  const rawBody = await readRawBody(req);
  if (!STRIPE_WEBHOOK_SECRET) {
    // Webhook forwarding needs a public URL / `stripe listen`, which isn't
    // set up by default. The confirm-on-return flow above still works
    // without this — see README. We accept the request without acting on
    // it so Stripe doesn't retry forever, but do nothing unsafe.
    return sendJson(res, 200, { received: true, note: 'STRIPE_WEBHOOK_SECRET not set — ignoring.' });
  }
  try {
    const sig = req.headers['stripe-signature'];
    const event = verifyWebhookSignature(rawBody, sig, STRIPE_WEBHOOK_SECRET);
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const breakKey = session.metadata?.break_key;
      const userId = session.client_reference_id;
      if (breakKey && userId && session.payment_status === 'paid' && !isUnlocked(userId, breakKey)) {
        markUnlocked(userId, breakKey, {
          sessionId: session.id,
          amountCents: session.amount_total,
          currency: session.currency,
          paidAt: new Date().toISOString(),
          via: 'webhook'
        });
      }
    }
    sendJson(res, 200, { received: true });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
}

// ---------- router ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname, searchParams } = url;

    if (pathname === '/api/stripe/webhook' && req.method === 'POST') {
      return await handleWebhook(req, res);
    }

    if (pathname.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');

      // Auth routes deliberately come before the "userId required" check
      // below — a brand-new visitor with no X-User-Id yet (or one who
      // cleared localStorage) still needs to be able to sign up/log in.
      // getUserId(req) here is either an existing session email, an
      // existing anonymous device id, or null — all three are valid
      // inputs to the handlers (migrateUser no-ops on a falsy deviceId).
      const maybeUserId = getUserId(req);
      if (pathname === '/api/auth/signup' && req.method === 'POST') return await handleSignup(req, res, maybeUserId);
      if (pathname === '/api/auth/login' && req.method === 'POST') return await handleLogin(req, res, maybeUserId);
      if (pathname === '/api/auth/google' && req.method === 'POST') return await handleGoogleAuth(req, res, maybeUserId);
      if (pathname === '/api/auth/logout' && req.method === 'POST') return await handleLogout(req, res);
      if (pathname === '/api/auth/me' && req.method === 'GET') return await handleMe(req, res);
      if (pathname === '/api/auth/forgot-password' && req.method === 'POST') return await handleForgotPassword(req, res);
      if (pathname === '/api/auth/reset-password' && req.method === 'POST') return await handleResetPassword(req, res);

      // Profile routes also sit before the userId-required check — they use
      // requireSessionEmail internally (a real account, not a device id) and
      // return their own 401 rather than the generic 400 below.
      if (pathname === '/api/profile' && req.method === 'GET') return await handleGetProfile(req, res);
      if (pathname === '/api/profile' && req.method === 'PUT') return await handlePutProfile(req, res);
      if (pathname === '/api/deal-click' && req.method === 'POST') return await handleDealClick(req, res);
      if (pathname === '/api/event-click' && req.method === 'POST') return await handleEventClick(req, res);
      if (pathname === '/api/feedback' && req.method === 'POST') return await handleFeedback(req, res);
      if (pathname === '/api/unsubscribe' && req.method === 'GET') return await handleUnsubscribe(req, res);
      if (pathname === '/api/admin/stats' && req.method === 'GET') return await handleAdminStats(req, res);
      if (pathname === '/api/stats' && req.method === 'GET') return await handleGetStats(req, res);

      const userId = maybeUserId;
      if (!userId) return sendJson(res, 400, { error: 'Missing X-User-Id header.' });

      if (pathname === '/api/settings' && req.method === 'GET') return await handleGetSettings(req, res, userId);
      if (pathname === '/api/settings' && req.method === 'PUT') return await handlePutSettings(req, res, userId);
      if (pathname === '/api/breaks' && req.method === 'GET') return await handleGetBreaks(req, res, userId);
      if (pathname === '/api/deals' && req.method === 'GET') return await handleGetDeals(req, res, userId, searchParams);
      if (pathname === '/api/activities' && req.method === 'GET') return await handleGetActivities(req, res, userId);
      if (pathname === '/api/restaurants' && req.method === 'GET') return await handleGetRestaurants(req, res, userId);
      if (pathname === '/api/stay' && req.method === 'GET') return await handleGetStay(req, res, userId, searchParams);
      if (pathname === '/api/events' && req.method === 'GET') return await handleGetEvents(req, res, userId, searchParams);
      if (pathname === '/api/checkout' && req.method === 'POST') return await handleCheckout(req, res, userId);
      if (pathname === '/api/checkout/confirm' && req.method === 'GET') return await handleConfirmCheckout(req, res, userId, searchParams);
      if (pathname === '/api/calendar-token' && req.method === 'GET') return await handleGetCalendarToken(req, res, userId);

      return sendJson(res, 404, { error: 'Unknown API route' });
    }

    // Calendar feed — deliberately outside /api/ and NOT behind the userId
    // check above, since it's fetched unattended by calendar apps with no
    // X-User-Id header or session cookie. See handleCalendarFeed for the
    // token-is-the-auth reasoning.
    const calendarMatch = pathname.match(/^\/calendar\/([a-f0-9]+)\.ics$/);
    if (calendarMatch && req.method === 'GET') return await handleCalendarFeed(req, res, calendarMatch[1]);

    if (pathname.startsWith('/avatars/') && req.method === 'GET') return serveAvatar(req, res, pathname);

    // Site visit counter — only the actual app shell load, not every
    // asset/API call under it, so this tracks "someone loaded the page"
    // roughly once per visit (or per hard refresh) rather than inflating
    // on every JS/CSS/image request. See lib/store.js recordVisit for why
    // this is a bare per-day count and nothing more identifying.
    if (pathname === '/' && req.method === 'GET') {
      try { recordVisit(); } catch (e) { console.error('[visits] recordVisit threw:', e.message); }
    }

    // static frontend
    if (req.method === 'GET') return serveStatic(req, res, pathname);

    res.writeHead(405);
    res.end('Method not allowed');
  } catch (e) {
    const status = e.status || 500;
    sendJson(res, status, { error: e.message || 'Internal error' });
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, () => {
    console.log(`Next Break server running at http://localhost:${PORT}`);
    console.log(`Travelpayouts real prices: ${TRAVELPAYOUTS_TOKEN ? 'configured' : 'NOT configured (set TRAVELPAYOUTS_TOKEN in .env — deals will show as "add your home airport" until then)'}`);
    console.log(`Viator activities: ${VIATOR_API_KEY ? 'configured' : 'NOT configured (set VIATOR_API_KEY in .env — things-to-do will show generic suggestions until then)'}`);
    console.log(`Ticketmaster events: ${TICKETMASTER_API_KEY ? 'configured' : 'NOT configured (set TICKETMASTER_API_KEY in .env — no events section will show until then)'}`);
    console.log(`OpenTable restaurant links: always on (no API key needed) — affiliate tracking ${OPENTABLE_AFFILIATE_LINK_PREFIX ? 'configured' : 'NOT configured (set OPENTABLE_AFFILIATE_LINK_PREFIX in .env once your OpenTable affiliate application is approved)'}`);
    console.log(`Booking.com staycation links: always on (no API key needed) — affiliate tracking ${BOOKING_AFFILIATE_LINK_PREFIX ? 'configured' : 'NOT configured (set BOOKING_AFFILIATE_LINK_PREFIX in .env once your Booking.com affiliate application via Awin is approved)'}`);
    console.log(`Google Sign-In: ${GOOGLE_CLIENT_ID ? 'configured' : 'NOT configured (set GOOGLE_CLIENT_ID in .env — the Google button will be hidden until then)'}`);
    console.log(`Password reset emails: ${RESEND_API_KEY ? 'configured (Resend)' : 'NOT configured (set RESEND_API_KEY in .env — reset links will be logged here instead of emailed until then)'}`);
    console.log(`Stripe (paywall, currently unused): ${STRIPE_SECRET_KEY ? 'configured' : 'not configured'}`);
    console.log(`Admin dashboard: ${ADMIN_EMAILS.length ? `configured for ${ADMIN_EMAILS.join(', ')}` : 'NOT configured (set ADMIN_EMAIL in .env — /admin.html will 403 for everyone until then)'}`);
    console.log(`Break-reminder digest: ${RESEND_API_KEY ? `configured (Resend), checking every ${Math.round(DIGEST_SWEEP_INTERVAL_MS / 3600000)}h for opted-in accounts with a break 5-7 days out` : 'NOT configured (set RESEND_API_KEY in .env — no digest emails will send until then)'}`);
  });

  // Only scheduled behind the same "ran directly, not imported by a test"
  // guard as server.listen above, so importing server.js in a test file
  // never spins up a real background timer that could fire mid-suite.
  const DIGEST_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day is plenty for a 3-day-wide eligibility window
  setTimeout(() => { runDigestSweep().catch(e => console.error('[digest] sweep threw:', e.message)); }, 60 * 1000); // small delay so it's not competing with server startup
  setInterval(() => { runDigestSweep().catch(e => console.error('[digest] sweep threw:', e.message)); }, DIGEST_SWEEP_INTERVAL_MS).unref();
}

export { server, presentBreak, buildDealsForBreak, buildActivitiesForSettings, runDigestSweep, maybeSendDigestForAccount };
