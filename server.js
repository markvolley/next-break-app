// Next Break — backend server.
// Zero external dependencies on purpose: only Node.js built-ins, so
// `npm install` isn't even required. Run with:
//   node --env-file=.env server.js
// or just `npm start`.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeUpcomingBreaks, breakStatus, toISO, CURRENCY_SYMBOLS } from './lib/deals.js';
import {
  getSettings, saveSettings, isUnlocked, markUnlocked, getUnlockRecord,
  getAccount, createAccount, upsertGoogleAccount, createSession, getSessionEmail, deleteSession, migrateUser
} from './lib/store.js';
import { createCheckoutSession, retrieveCheckoutSession, verifyWebhookSignature } from './lib/stripeClient.js';
import { findRealDeals } from './lib/travelpayouts.js';
import { findActivities } from './lib/viator.js';
import { hashPassword, verifyPassword, createSessionToken, isValidEmail } from './lib/auth.js';
import { verifyGoogleIdToken } from './lib/googleAuth.js';

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

// Google Sign-In client ID. This is NOT a secret — it's meant to be public
// and embedded in frontend JS (that's how Google Identity Services works),
// same category as a Stripe *publishable* key. Get one free at
// https://console.cloud.google.com/apis/credentials
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

const SESSION_COOKIE = 'nb_session';

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

async function readJsonBody(req) {
  const raw = await readRawBody(req);
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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };

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
async function buildDealsForBreak(brk, settings) {
  const currency = (settings.currency || 'AUD').toLowerCase();

  if (!TRAVELPAYOUTS_TOKEN || !settings.originAirport) {
    return { source: 'not-configured', deals: [] };
  }

  try {
    const real = await findRealDeals({
      token: TRAVELPAYOUTS_TOKEN,
      marker: TRAVELPAYOUTS_MARKER,
      origin: settings.originAirport.toUpperCase(),
      currency,
      brk
    });
    return { source: real.length ? 'real' : 'no-results', deals: real };
  } catch (e) {
    console.error('[travelpayouts] findRealDeals threw:', e.message);
    return { source: 'no-results', deals: [] };
  }
}

// ---------- activities for hometown (real, via Viator — no fake listings) ----------
async function buildActivitiesForSettings(settings) {
  if (!VIATOR_API_KEY || !settings.hometown) {
    return { source: 'not-configured', activities: [] };
  }
  try {
    const real = await findActivities({
      apiKey: VIATOR_API_KEY,
      pid: VIATOR_PID,
      mcid: VIATOR_MCID,
      hometown: settings.hometown,
      currency: settings.currency || 'AUD'
    });
    return { source: real.length ? 'real' : 'no-results', activities: real };
  } catch (e) {
    console.error('[viator] findActivities threw:', e.message);
    return { source: 'no-results', activities: [] };
  }
}

// ---------- auth ----------
// `deviceId` here is whatever anonymous X-User-Id this browser already had
// before logging in/signing up — if it has saved settings, they're carried
// over into the account rather than forcing the person to redo Setup.
async function handleSignup(req, res, deviceId) {
  const body = await readJsonBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (!isValidEmail(email)) return sendJson(res, 400, { error: 'Enter a valid email address.' });
  if (password.length < 8) return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
  if (getAccount(email)) return sendJson(res, 409, { error: 'An account with that email already exists — try logging in instead.' });

  createAccount(email, { passwordHash: hashPassword(password) });
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

  upsertGoogleAccount(claims.email, claims.sub);
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
  sendJson(res, 200, { loggedIn: !!email, email: email || null, googleClientId: GOOGLE_CLIENT_ID || null });
}

// ---------- route handlers ----------
async function handleGetSettings(req, res, userId) {
  sendJson(res, 200, getSettings(userId));
}

async function handlePutSettings(req, res, userId) {
  const body = await readJsonBody(req);
  const allowed = ['hometown', 'originAirport', 'currency', 'rosterMode', 'pattern', 'manualBreaks'];
  const patch = {};
  for (const k of allowed) if (k in body) patch[k] = body[k];
  if (typeof patch.originAirport === 'string') patch.originAirport = patch.originAirport.trim().toUpperCase();
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
    realPricesAvailable: !!(TRAVELPAYOUTS_TOKEN && settings.originAirport)
  });
}

async function handleGetDeals(req, res, userId, query) {
  const breakKey = query.get('breakKey');
  if (!breakKey) return sendJson(res, 400, { error: 'breakKey is required' });

  const settings = getSettings(userId);
  const breaks = computeUpcomingBreaks(settings);
  const brk = breaks.find(b => b.key === breakKey);
  if (!brk) return sendJson(res, 404, { error: 'That break no longer matches your current roster.' });

  const { source, deals } = await buildDealsForBreak(brk, settings);
  sendJson(res, 200, { breakKey, source, currencySymbol: CURRENCY_SYMBOLS[settings.currency] || 'A$', deals });
}

async function handleGetActivities(req, res, userId) {
  const settings = getSettings(userId);
  const { source, activities } = await buildActivitiesForSettings(settings);
  sendJson(res, 200, { source, hometown: settings.hometown || '', activities });
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

      const userId = maybeUserId;
      if (!userId) return sendJson(res, 400, { error: 'Missing X-User-Id header.' });

      if (pathname === '/api/settings' && req.method === 'GET') return await handleGetSettings(req, res, userId);
      if (pathname === '/api/settings' && req.method === 'PUT') return await handlePutSettings(req, res, userId);
      if (pathname === '/api/breaks' && req.method === 'GET') return await handleGetBreaks(req, res, userId);
      if (pathname === '/api/deals' && req.method === 'GET') return await handleGetDeals(req, res, userId, searchParams);
      if (pathname === '/api/activities' && req.method === 'GET') return await handleGetActivities(req, res, userId);
      if (pathname === '/api/checkout' && req.method === 'POST') return await handleCheckout(req, res, userId);
      if (pathname === '/api/checkout/confirm' && req.method === 'GET') return await handleConfirmCheckout(req, res, userId, searchParams);

      return sendJson(res, 404, { error: 'Unknown API route' });
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
    console.log(`Google Sign-In: ${GOOGLE_CLIENT_ID ? 'configured' : 'NOT configured (set GOOGLE_CLIENT_ID in .env — the Google button will be hidden until then)'}`);
    console.log(`Stripe (paywall, currently unused): ${STRIPE_SECRET_KEY ? 'configured' : 'not configured'}`);
  });
}

export { server, presentBreak, buildDealsForBreak, buildActivitiesForSettings };
