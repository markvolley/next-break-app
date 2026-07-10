// Next Break — backend server.
// Zero external dependencies on purpose: only Node.js built-ins, so
// `npm install` isn't even required. Run with:
//   node --env-file=.env server.js
// or just `npm start`.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeUpcomingBreaks, generateDeals, breakStatus, toISO, CURRENCY_SYMBOLS } from './lib/deals.js';
import { getSettings, saveSettings, isUnlocked, markUnlocked, getUnlockRecord } from './lib/store.js';
import { createCheckoutSession, retrieveCheckoutSession, verifyWebhookSignature } from './lib/stripeClient.js';
import { googleSearchUrl } from './lib/links.js';
import { findRealDeals } from './lib/travelpayouts.js';

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

function getUserId(req) {
  return req.headers['x-user-id'] || null;
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

// ---------- deals for a single break (real, with mock fallback) ----------
async function buildDealsForBreak(brk, settings) {
  const currency = (settings.currency || 'AUD').toLowerCase();

  if (TRAVELPAYOUTS_TOKEN && settings.originAirport) {
    try {
      const real = await findRealDeals({
        token: TRAVELPAYOUTS_TOKEN,
        marker: TRAVELPAYOUTS_MARKER,
        origin: settings.originAirport.toUpperCase(),
        currency,
        brk
      });
      if (real.length) {
        return { source: 'real', deals: real };
      }
      // No cached fares found for any candidate destination this time —
      // fall through to mock rather than showing an empty panel.
    } catch (e) {
      // Fall through to mock on any API error too.
    }
  }

  const mock = generateDeals(brk).map(d => {
    const destShort = d.name.split(',')[0];
    const searchUrl = googleSearchUrl(`flights to ${destShort} ${toISO(brk.start)} to ${toISO(brk.end)}`);
    return { ...d, source: 'mock', searchUrl };
  });
  return { source: 'mock', deals: mock };
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
      const userId = getUserId(req);
      if (!userId) return sendJson(res, 400, { error: 'Missing X-User-Id header.' });

      if (pathname === '/api/settings' && req.method === 'GET') return await handleGetSettings(req, res, userId);
      if (pathname === '/api/settings' && req.method === 'PUT') return await handlePutSettings(req, res, userId);
      if (pathname === '/api/breaks' && req.method === 'GET') return await handleGetBreaks(req, res, userId);
      if (pathname === '/api/deals' && req.method === 'GET') return await handleGetDeals(req, res, userId, searchParams);
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
    console.log(`Travelpayouts real prices: ${TRAVELPAYOUTS_TOKEN ? 'configured' : 'NOT configured (set TRAVELPAYOUTS_TOKEN in .env — falling back to illustrative mock deals)'}`);
    console.log(`Stripe (paywall, currently unused): ${STRIPE_SECRET_KEY ? 'configured' : 'not configured'}`);
  });
}

export { server, presentBreak, buildDealsForBreak };
