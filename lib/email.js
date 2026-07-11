// Sends transactional email (password resets) via Resend's HTTP API — a
// plain `fetch` call, same zero-dependency pattern as lib/stripeClient.js,
// lib/travelpayouts.js, and lib/viator.js. No email SDK needed.
//
// Resend was picked for its simplicity (one endpoint, bearer token auth,
// generous free tier) but nothing else in this file is Resend-specific
// except RESEND_API_URL and the request shape below — swap in another
// provider's REST API here if you'd rather use one you already have.
//
// Docs: https://resend.com/docs/api-reference/emails/send-email

const RESEND_API_URL = 'https://api.resend.com/emails';

/**
 * Returns true if the email was sent, false otherwise (never throws —
 * callers treat a failed send as "log the link instead", not a hard error,
 * since a broken email provider shouldn't block the reset flow entirely).
 */
export async function sendPasswordResetEmail({ to, resetUrl, apiKey, fromAddress, fetchImpl = fetch }) {
  if (!apiKey) return false;

  const html = `
    <p>Someone (hopefully you) asked to reset the password for your Next Break account.</p>
    <p><a href="${resetUrl}">Click here to set a new password</a>. This link expires in 1 hour.</p>
    <p>If you didn't request this, you can safely ignore this email — your password won't change.</p>
  `;

  try {
    const res = await fetchImpl(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [to],
        subject: 'Reset your Next Break password',
        html
      })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[email] Resend HTTP ${res.status} — ${text.slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[email] send threw:', e.message);
    return false;
  }
}
