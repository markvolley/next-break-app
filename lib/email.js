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
    <p>If you didn't request this, you can safely ignore this email. Your password won't change.</p>
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

// Roster-based break reminder — see lib/digest.js for the "when does this
// even get sent" logic and server.js's runDigestSweep for how it's wired
// up. Only ever includes real, already-fetched content (deals/events/
// activities are passed in, never looked up here) and always includes an
// unsubscribe link, both to stay honest and to stay well clear of spam
// rules (the Australian Spam Act 2003 requires a functional unsubscribe
// mechanism in every commercial email).
export async function sendBreakDigestEmail({
  to, hometown, breakStart, breakEnd, daysUntil,
  deals = [], events = [], activities = [],
  unsubscribeUrl, currencySymbol = '$',
  apiKey, fromAddress, fetchImpl = fetch
}) {
  if (!apiKey) return false;

  const phrase = daysUntil === 0 ? 'starts today' : daysUntil === 1 ? 'starts tomorrow' : `starts in ${daysUntil} days`;
  const subject = `Your break ${phrase}, here's what's on`;

  const LINK_STYLE = `style="color:#F5B04C;text-decoration:none;font-weight:700;"`;

  const dealsHtml = deals.length ? `
    <h3 style="margin:22px 0 10px;font-size:15px;color:#101820;">✈️ Flight deals</h3>
    ${deals.slice(0, 3).map(d => `
      <p style="margin:0 0 14px;font-size:14px;line-height:1.5;">
        <a href="${d.bookUrl}" ${LINK_STYLE}>${d.name}</a><br>
        <span style="color:#555;">${currencySymbol}${Math.round(d.price)} &middot; ${d.airline} ${d.flightNumber}</span>
      </p>
    `).join('')}
  ` : '';

  const eventsHtml = events.length ? `
    <h3 style="margin:22px 0 10px;font-size:15px;color:#101820;">🎟️ Happening near home</h3>
    ${events.slice(0, 3).map(e => `
      <p style="margin:0 0 14px;font-size:14px;line-height:1.5;">
        <a href="${e.url}" ${LINK_STYLE}>${e.title}</a><br>
        <span style="color:#555;">${[e.venueName, e.localDate].filter(Boolean).join(' &middot; ')}</span>
      </p>
    `).join('')}
  ` : '';

  // Only shown when there were no deals and no events, same "don't leave a
  // dead end" reasoning as the on-page fallback in index.html.
  const activitiesHtml = (!deals.length && !events.length && activities.length) ? `
    <h3 style="margin:22px 0 10px;font-size:15px;color:#101820;">🧭 Things to do near ${hometown}</h3>
    ${activities.slice(0, 4).map(a => `
      <p style="margin:0 0 14px;font-size:14px;line-height:1.5;">
        <a href="${a.bookUrl || a.mapUrl}" ${LINK_STYLE}>${a.title}</a><br>
        <span style="color:#555;">${a.category || a.duration || (a.source === 'real' ? 'Bookable activity' : 'Free, near you')}</span>
      </p>
    `).join('')}
  ` : '';

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#101820;max-width:520px;">
      <p>Hi,</p>
      <p>Your break (${breakStart} to ${breakEnd}) ${phrase}. Here's what's worth a look before then.</p>
      ${dealsHtml}${eventsHtml}${activitiesHtml}
      <p style="margin-top:26px;"><a href="https://nextbreak.com.au" ${LINK_STYLE}>Open Next Break &rarr;</a></p>
      <hr style="border:none;border-top:1px solid #e8e8e8;margin:30px 0 14px;">
      <p style="font-size:12px;color:#999;line-height:1.5;">
        You're getting this because you opted in to break reminders on Next Break, and this one's tied to your own upcoming break, not a regular schedule.
        <a href="${unsubscribeUrl}" style="color:#999;">Unsubscribe from these reminders</a> any time, no account needed.
      </p>
    </div>
  `;

  try {
    const res = await fetchImpl(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: fromAddress, to: [to], subject, html })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[email] Resend HTTP ${res.status} — ${text.slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[email] digest send threw:', e.message);
    return false;
  }
}
