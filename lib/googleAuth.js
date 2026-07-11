// Verifies a Google Sign-In ID token via Google's `tokeninfo` endpoint.
// This deliberately avoids implementing JWT/JWKS signature verification
// ourselves — Google checks the signature and expiry server-side and just
// hands back the decoded claims if the token is valid, which keeps this
// zero-dependency (plain fetch, same pattern as the other lib/*.js files).
//
// Docs: https://developers.google.com/identity/gsi/web/guides/verify-google-id-token

const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';

/**
 * Returns { email, sub, name } if the token is valid AND was issued for
 * `clientId`, otherwise null. The audience check is the important part —
 * without it, any valid Google ID token (issued for any app) would be
 * accepted here, letting someone log in as anyone.
 */
export async function verifyGoogleIdToken({ idToken, clientId, fetchImpl = fetch }) {
  if (!idToken || !clientId) return null;

  const url = `${TOKENINFO_URL}?id_token=${encodeURIComponent(idToken)}`;
  let res;
  try {
    res = await fetchImpl(url);
  } catch (e) {
    console.error('[google-auth] tokeninfo fetch threw:', e.message);
    return null;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[google-auth] tokeninfo HTTP ${res.status} — ${text.slice(0, 200)}`);
    return null;
  }
  const claims = await res.json().catch(() => null);
  if (!claims) return null;

  if (claims.aud !== clientId) {
    console.error('[google-auth] token audience mismatch — expected this server\'s client ID, got', claims.aud);
    return null;
  }
  if (claims.email_verified !== 'true' && claims.email_verified !== true) {
    console.error('[google-auth] rejected — email not verified on the Google account');
    return null;
  }
  if (!claims.email || !claims.sub) return null;

  return { email: String(claims.email).toLowerCase(), sub: claims.sub, name: claims.name || null };
}
