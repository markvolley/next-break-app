// Talks to Stripe's plain REST API directly (no `stripe` npm package),
// so this project has zero external dependencies and `npm install` is
// unnecessary. See https://docs.stripe.com/api for the underlying API.

import crypto from 'node:crypto';

const STRIPE_API = 'https://api.stripe.com/v1';

/** Stripe's API takes application/x-www-form-urlencoded bodies, and
 * nested objects/arrays use PHP-style bracket notation, e.g.
 * line_items[0][price_data][currency]=aud
 */
export function flattenParams(obj, prefix = '') {
  const pairs = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const paramKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item !== null && typeof item === 'object') {
          pairs.push(...flattenParams(item, `${paramKey}[${i}]`));
        } else {
          pairs.push([`${paramKey}[${i}]`, String(item)]);
        }
      });
    } else if (typeof value === 'object') {
      pairs.push(...flattenParams(value, paramKey));
    } else {
      pairs.push([paramKey, String(value)]);
    }
  }
  return pairs;
}

function toFormBody(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of flattenParams(params)) usp.append(k, v);
  return usp;
}

async function stripeRequest(secretKey, method, urlPath, params, fetchImpl = fetch) {
  if (!secretKey) {
    throw new Error('Stripe is not configured — set STRIPE_SECRET_KEY.');
  }
  const opts = {
    method,
    headers: {
      Authorization: 'Bearer ' + secretKey,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  };
  let url = `${STRIPE_API}${urlPath}`;
  if (params && method === 'GET') {
    url += '?' + toFormBody(params).toString();
  } else if (params) {
    opts.body = toFormBody(params);
  }
  const res = await fetchImpl(url, opts);
  const json = await res.json();
  if (!res.ok) {
    const msg = json?.error?.message || `Stripe API error (HTTP ${res.status})`;
    const err = new Error(msg);
    err.stripeError = json?.error;
    throw err;
  }
  return json;
}

/**
 * Creates a hosted Stripe Checkout Session for a single one-off fee.
 * Returns the session object; session.url is where you redirect the user.
 */
export async function createCheckoutSession({
  secretKey,
  amountCents,
  currency,
  productName,
  successUrl,
  cancelUrl,
  clientReferenceId,
  metadata,
  fetchImpl
}) {
  return stripeRequest(secretKey, 'POST', '/checkout/sessions', {
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: clientReferenceId,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: currency.toLowerCase(),
          unit_amount: amountCents,
          product_data: { name: productName }
        }
      }
    ],
    metadata
  }, fetchImpl);
}

export async function retrieveCheckoutSession(secretKey, sessionId, fetchImpl) {
  return stripeRequest(secretKey, 'GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`, null, fetchImpl);
}

/**
 * Manual re-implementation of Stripe's webhook signature check
 * (normally `stripe.webhooks.constructEvent`) so we don't need the SDK.
 * https://docs.stripe.com/webhooks#verify-manually
 */
export function verifyWebhookSignature(rawBody, sigHeader, webhookSecret, toleranceSeconds = 300) {
  if (!sigHeader) throw new Error('Missing Stripe-Signature header');
  const parts = Object.fromEntries(
    sigHeader.split(',').map(kv => {
      const idx = kv.indexOf('=');
      return [kv.slice(0, idx), kv.slice(idx + 1)];
    })
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) throw new Error('Malformed Stripe-Signature header');

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', webhookSecret).update(signedPayload, 'utf8').digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(signature, 'hex');
  const isValid =
    expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);

  if (!isValid) throw new Error('Webhook signature verification failed');

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > toleranceSeconds) throw new Error('Webhook timestamp too old');

  return JSON.parse(rawBody);
}
