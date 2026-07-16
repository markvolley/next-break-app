# Next Break

A FIFO/roster travel planner: enter your swing pattern or manual break dates,
see your upcoming breaks, and browse real flight prices, real events, and
real things to do for each one — with trackable affiliate links that earn a
commission when someone books. Every break always shows at least 3
destination options, one domestic, one South East Asian, one other
international, even on routes/dates with no cached fare.

**How it makes money:** deal cards link out through Travelpayouts (Aviasales),
Viator, and Ticketmaster affiliate links. Users pay nothing — the airline,
activity operator, or ticketing provider pays a small commission on completed
bookings. No paywall, no fee, no friction between seeing an option and being
able to book it.

## Real data only — nothing is ever fabricated

This is the one rule the whole app is built around: no made-up prices, no
generic placeholder suggestions, no illustrative anything. Every number and
every listing shown is either a real cached fare, a real event, a real
bookable activity, or an honest "we don't have one of those for this" state.

### Flights

Deals come from the Travelpayouts Data API, which is a **cache of recent
real searches**, not a live GDS lookup — perfect for someone planning weeks
ahead for a scheduled break, but it does mean a given destination won't
always have cached data for the exact dates asked. That's normal, not a bug.
`REAL_DESTINATIONS` in `lib/travelpayouts.js` curates 38 real airports across
domestic, South East Asian, and other-international routes to widen the
chance of a cache hit.

Each break shows one of these states, never a fake price:

- **Real fares** — `TRAVELPAYOUTS_TOKEN` is set, a home airport is entered,
  and at least one destination had a cached fare that actually fits the
  break's exact dates (no grace period either side — see
  `fitsBreak()` in `lib/travelpayouts.js`). Shows real airline, flight
  number, price, flight time, distance, timezone diff, weather, and a
  working "Book this fare" affiliate link.
- **Backfilled "Check flights" cards** — whenever there are fewer than 3 real
  fares for a break, the remaining slots are filled with real destinations
  that show **no price at all**, just a "Check flights" button linking
  straight to a live Aviasales search for the break's own real dates. These
  are still real, trackable affiliate links (commission is earned on the
  click-through regardless of whether a price was shown here first) — see
  `withBackfill()`/`buildLiveSearchUrl()` in `lib/travelpayouts.js`. This is
  what guarantees every break always shows at least 3 options, in
  domestic → SEA → international order, real or backfilled.
- **"Add your home airport"** — no home airport entered yet, or
  `TRAVELPAYOUTS_TOKEN` isn't set on the server, so no search was even
  attempted.

If real fares seem to be missing more than expected, check the server logs
(e.g. Render's Logs tab) — `lib/travelpayouts.js` logs a hit-rate line per
lookup (`X/Y destinations had cached fares`) and logs the actual HTTP
status/response body on any API error, so an invalid token shows up
distinctly from a genuine cache miss.

**Locale note:** every Travelpayouts request and every backfill link
explicitly sets `locale=en-gb`. Leaving it unset doesn't fall back to
English — Aviasales defaults to Russian, its home market, for both the
search page language and the currency shown. This bit us once already (see
git history), hence the regression test in `test_backfill.mjs`.

### Events

Real ticketed events (concerts, sport, theatre) near the user's hometown
during each break, via Ticketmaster's Discovery API (`lib/ticketmaster.js`).
Configure `TICKETMASTER_API_KEY` to turn it on — leave it blank to hide the
events section entirely, no placeholder shown.

### Things to do — real activities, never a dead end

Shown as a fallback specifically when a break has **no real flight fare and
no event** — never replacing real flights/events, only filling the gap when
neither exists:

1. **Viator** (`lib/viator.js`), if `VIATOR_API_KEY`/`VIATOR_PID`/`VIATOR_MCID`
   are configured — real, bookable local tours/activities with a trackable
   affiliate link.
2. **Free public spots** (`lib/activities.js`), if Viator isn't configured or
   has nothing for that hometown — real places sourced live from
   OpenStreetMap (beaches, parks, lookouts, nature reserves near the user's
   geocoded hometown), no affiliate link, just a map link, because a beach
   doesn't need one.

There's still no generic/mock fallback below that — if neither source has
anything, the section just doesn't render.

**Known unverified area (Viator):** the endpoints, auth, and
destination-lookup fields in `lib/viator.js` are confirmed against Viator's
published API docs. The exact field names inside an individual
`/search/products` result (title, image, price, rating) are a best-effort
mapping, since Viator's docs didn't expose a full sample response for that
endpoint. The code logs the raw key names of the first result it gets back
(`[viator] sample raw product keys: ...`) — check that log against what
`normalizeProduct()` expects the first time you get a real API key.

## Accounts — email/password and Google Sign-In

People can save their setup to a real account instead of relying on their
browser's local storage, so it follows them across devices. Two ways in,
both optional and both landing in the same account if used with the same
email:

- **Email + password.** Passwords are hashed with Node's built-in
  `crypto.scryptSync` (a slow, salted KDF) — there's no bcrypt/argon2
  dependency, and plain-text passwords are never stored or logged.
- **Google Sign-In**, if `GOOGLE_CLIENT_ID` is set (see below). Verified
  server-side against Google's `tokeninfo` endpoint, checking both the
  token's audience (so a token issued for a different app can't be used
  here) and that the Google account's email is verified.

Sessions are a random 32-byte token in an HttpOnly, SameSite=Lax cookie
(Secure too, once served over HTTPS) — no JWT, no session-store dependency,
just an entry in `data.json`.

Signing up or logging in from a browser that already has anonymous
in-progress setup (device-scoped, pre-login) carries that setup into the
account automatically, so nobody has to redo Setup just because they
decided to make an account. Existing account data is never overwritten by
this migration.

Logging in is entirely optional — the app works exactly as before (settings
tied to a random per-browser device ID) if nobody signs up.

### Setting up Google Sign-In

1. Go to [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials).
2. Create an **OAuth 2.0 Client ID** of type **Web application**.
3. Add your site's URL(s) (e.g. `https://www.nextbreak.com.au`, and
   `http://localhost:3000` for local testing) under **Authorized JavaScript origins**.
4. Copy the Client ID into `GOOGLE_CLIENT_ID` in `.env` (or your host's
   Environment tab). It's not a secret — it's meant to be public, the same
   category as a Stripe *publishable* key — so it's fine to paste directly
   rather than needing extra protection.
5. Leave it blank to hide the Google button entirely and offer
   email/password login only.

### Forgot password

Signing up requires accepting the [Terms and Conditions](public/terms.html)
(see below), and once someone has an account, they can reset a forgotten
password via **Forgot password?** on the login form. That flow:

1. Generates a random, single-use token good for 1 hour, stored in
   `data.json` (not the password itself — the token just proves "this
   person controls that inbox").
2. Emails a reset link (`https://yoursite/?resetToken=...`) via
   [Resend](https://resend.com)'s HTTP API, if `RESEND_API_KEY` is set.
3. If Resend isn't configured (or a send fails), the link is logged to the
   server console instead — handy for local dev, not a substitute for real
   email in production.
4. Resetting the password invalidates every existing session for that
   account, so a leaked/stolen session cookie elsewhere gets kicked out the
   moment someone resets.

The response to **Forgot password?** is deliberately the same generic
message whether or not an account exists for that email, so this endpoint
can't be used to check which emails have accounts here.

To turn on real emails: sign up free at [resend.com](https://resend.com)
(no credit card needed), grab an API key from
[resend.com/api-keys](https://resend.com/api-keys), and set
`RESEND_API_KEY` in `.env`. `EMAIL_FROM` defaults to Resend's shared test
sender (`onboarding@resend.dev`), which works without any setup but is for
testing only — verify your own domain at
[resend.com/domains](https://resend.com/domains) before sending real users
real reset emails from it.

## Break-reminder emails

Also sent via Resend, separate from password resets. Once a day
(`runDigestSweep()` in `server.js`), the server checks accounts that opted
into marketing emails (checkbox at signup, or toggle in Profile) and sends
anyone whose next break is 5–7 days away a one-off reminder — real deals,
events, or things to do for that specific break.

- **Roster-based, not calendar-based.** Only ever tied to the account's own
  upcoming break, never a fixed weekly/monthly schedule.
- **Once per break, ever** — deduped via `hasDigestSent()`/`recordDigestSent()`
  in `lib/store.js`, so nobody gets the same reminder twice.
- **Skips sending if there's genuinely nothing to report** (no deals, no
  events, no activities) — an empty email is worse than no email.
- **Always includes a working unsubscribe link** (`/api/unsubscribe?token=...`),
  effective immediately, no login needed — required for Australian Spam Act
  2003 compliance, see `public/terms.html` section 5 and `public/privacy.html`.

`PUBLIC_BASE_URL` must be set to your real deployed domain (there's no
incoming request to derive it from for a background job, unlike password
resets, which reuse the request's own host). Leave `RESEND_API_KEY` blank to
disable this entirely.

## Personal stats and admin dashboard

- **`/` → My Stats tab** (logged-in users): their own upcoming breaks, days
  to next break, and which destinations they've clicked into — built from
  their own account activity, not projections.
- **`/admin.html`**: site-wide traffic, sign-ups, deal/event clicks,
  marketing opt-ins, feedback, and 30-day trend charts with week-over-week
  growth badges (all zero-dependency inline SVG, no charting library).
  Gated by `ADMIN_EMAIL` (comma-separated list) — log in as that email on
  the site first, then visit `/admin.html`; anyone else gets a 403 from
  `/api/admin/stats` even if they guess the URL.

## Feedback widget

A small persistent "💬 Feedback" bubble (bottom-right, on every page except
the legal pages and admin) — one tap to leave a reaction (love/good/meh/
frustrated), optional topic tags, and an optional free-text comment.
Anonymous-safe (recorded whether or not you're logged in). Shows up in the
admin dashboard with an unread-count indicator (`nb_admin_feedback_seen` in
the admin's own browser local storage, not shared server state).

## Calendar sync

Logged-in or anonymous, from the dashboard's "📅 Sync to calendar" button:
a subscribe link (`/calendar/<token>.ics`) that Google/Apple/Outlook
calendar can subscribe to, staying in sync automatically as the roster
changes, or a one-off `.ics` download. The token is a random, unguessable
string (`lib/calendar.js`/`lib/auth.js`) — treat it like a password, since
anyone with the link can see that account's upcoming breaks with no other
authentication.

## Terms and Conditions / Privacy Policy

`public/terms.html` and `public/privacy.html` are general-purpose templates
covering the affiliate-commission model, the "cached fares, not live
quotes" disclaimer, account rules, break-reminder emails, data handling
(including every third-party service actually called and what each
receives), and a liability/consumer-law section. **They're a starting
point, not legal advice** — have them reviewed before relying on them
commercially, especially if you're serving users outside Australia.

Accepting the Terms is mandatory, not just a link in the footer: the
checkbox on the signup form must be checked before `POST /api/auth/signup`
will create an account, and the same applies to a brand-new account created
via Google Sign-In (an existing account signing back in via Google is never
asked to re-accept). The server enforces this — the frontend checkbox is a
convenience, not the actual gate — and each account records *when* and
*which version* of the Terms it accepted (`termsAcceptedAt`, `termsVersion`
in `data.json`), so bumping the terms later and requiring re-acceptance from
existing users is possible without extra plumbing.

## Profile — display name and avatar

Logged-in users get a **Profile** page (linked from the header) to set a
display name, upload an avatar, and toggle break-reminder emails on/off.

- Avatars are uploaded as a base64 data URL in a normal JSON body, not a
  multipart form — Node's built-in `http` module doesn't parse multipart
  bodies, and adding a library for it would break the zero-dependency rule
  for what's otherwise a small image (PNG/JPEG/WebP, max 2MB, enforced
  both client- and server-side).
- Uploaded images are written to an `avatars/` folder next to `data.json`
  — i.e. on the same persistent disk in production (`/data` on Render), not
  under `public/`, since `public/` is just the git-tracked static frontend
  and wouldn't survive a redeploy. They're served back via a small
  dedicated `/avatars/<file>` route.
- Replacing an avatar deletes the previous file, so they don't pile up on
  disk over time.
- Profile routes require an actual logged-in session — unlike the rest of
  the app, there's no meaningful "anonymous profile," so an anonymous
  device ID doesn't grant access here.

## Why no `npm install`?

The whole backend is built on Node's built-ins only (`http`, `fetch`,
`crypto`, `fs`) — no Express, no Stripe SDK, no database engine, no
charting library. That means:

- `npm install` is not required — there's nothing to install.
- Nothing here needs native compilation or a database server.
- It's easy to read end-to-end; there's no framework layer hiding what's
  happening.

The tradeoff: this is intentionally minimal. Swap in Express and a real
database (Postgres, etc.) once you outgrow it — see **Where to go from
here** below.

## Requirements

- Node.js **20.6+** (needs built-in `fetch` and `--env-file` support). Check with `node -v`.

## Quick start

1. `cp .env.example .env`
2. Sign up free at [travelpayouts.com](https://www.travelpayouts.com), grab
   your API token from
   [the API tools page](https://www.travelpayouts.com/programs/100/tools/api),
   and paste it into `TRAVELPAYOUTS_TOKEN` in `.env`. Your affiliate
   `TRAVELPAYOUTS_MARKER` is already filled in.
3. Start the server:
   ```bash
   npm start
   # equivalent to: node server.js
   ```
4. Open **http://localhost:3000**, fill in Setup (including your home
   airport, e.g. `PER`), save, and click a break to see real fares (and
   backfilled destination options if the exact route/dates have no cached
   fare yet).

Without `TRAVELPAYOUTS_TOKEN` set, the app still runs fine — it just prompts
for a home airport and doesn't show any flight options at all. There's no
mock/illustrative fallback anywhere in this app.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `TRAVELPAYOUTS_TOKEN` | For real flight prices | — | From your Travelpayouts account. Without it, breaks just prompt the user to add a home airport — no fake prices, no options shown. |
| `TRAVELPAYOUTS_MARKER` | For commission tracking | `749343` | Your affiliate ID — attached to every booking link and every backfilled "Check flights" live-search link, so completed bookings are credited to you. |
| `VIATOR_API_KEY` | For real activities | — | From your Viator partner account. Without it, the things-to-do fallback uses free OpenStreetMap-sourced public spots instead. |
| `VIATOR_PID` | For commission tracking | — | Your Viator Partner ID — attached to every activity booking link. |
| `VIATOR_MCID` | For commission tracking | — | Your Viator campaign ID — also attached to booking links. |
| `TICKETMASTER_API_KEY` | For real events | — | Consumer Key from [developer.ticketmaster.com](https://developer.ticketmaster.com). Leave blank to hide the events section entirely. |
| `TICKETMASTER_AFFILIATE_LINK_PREFIX` | No | — | Only for routing Ticketmaster links through a custom Impact deep-link instead of Ticketmaster's own auto-tracking. See `.env.example` for the normal (recommended) affiliate setup path. |
| `GOOGLE_CLIENT_ID` | For Google Sign-In | — | Not secret — from Google Cloud Console (see **Accounts** above). Leave blank to hide the Google button; email/password login always works regardless. |
| `RESEND_API_KEY` | For real emails | — | From [resend.com/api-keys](https://resend.com/api-keys). Powers both password-reset emails and break-reminder digest emails. Without it, reset links are just logged to the server console and the digest sweep is disabled entirely. |
| `EMAIL_FROM` | No | `Next Break <onboarding@resend.dev>` | Sender address on all emails — must be a domain verified in your Resend account for real (non-test) sending. |
| `PUBLIC_BASE_URL` | For break-reminder emails | `https://nextbreak.com.au` | Used to build links inside digest emails (unlike password resets, there's no incoming request to derive the host from for a background job). Set to your real deployed domain. |
| `ADMIN_EMAIL` | For the admin dashboard | — | Comma-separated list of account emails allowed to load `/admin.html` and `/api/admin/stats`. Log in as that email first, then visit `/admin.html`. Leave blank to disable the dashboard for everyone. |
| `PORT` | No | `3000` | |
| `DATA_FILE` | No | `./data.json` | Where user settings, accounts, and logs are stored. |
| `STRIPE_SECRET_KEY` | No | — | Unused (paywall is off — see below). Only needed if you re-enable it. |
| `STRIPE_WEBHOOK_SECRET` | No | — | Unused unless you re-enable the paywall and wire up webhooks. |
| `UNLOCK_FEE_CENTS` | No | `500` | Unused unless you re-enable the paywall. |

## About the Stripe code

An earlier version of this app gated deals behind a small Stripe Checkout
fee. That's been removed in favor of the affiliate-commission model above —
no fee, no blocker between seeing an option and booking it. The Stripe
integration (`lib/stripeClient.js`, `/api/checkout*`, `/api/stripe/webhook`)
is still in the codebase, fully implemented and tested, but dormant and
unused. Safe to ignore, or delete if you want to slim things down.

## Project structure

```
server.js                    HTTP server + API routes
lib/deals.js                 Break date/scheduling logic (pure functions)
lib/travelpayouts.js         Real flight price lookups, affiliate links, backfill destinations
lib/viator.js                Real activity listings + affiliate booking links
lib/activities.js            Free public spots near a hometown (OpenStreetMap), no affiliate link
lib/ticketmaster.js          Real event listings + affiliate booking links
lib/weather.js               Short-range forecast / historical-average weather per destination+date
lib/fx.js                    Currency exchange rates for "while you're there" context
lib/geo.js                   Distance + timezone-diff between origin and destination (static lookups)
lib/digest.js                Pure logic for "should this break get a reminder email right now"
lib/email.js                 Password-reset + break-reminder email sending (Resend REST API)
lib/calendar.js              Builds the .ics calendar feed
lib/store.js                 JSON-file persistence (settings, accounts, sessions, clicks, feedback)
lib/auth.js                  Password hashing + token generation (built-in crypto only)
lib/googleAuth.js            Google ID token verification (tokeninfo endpoint)
lib/stripeClient.js          Raw Stripe REST calls (dormant, unused — see above)
lib/links.js                 Dormant search-link helpers, unused (kept in case a non-affiliate fallback is wanted again)
public/index.html            Main frontend (vanilla JS, no build step)
public/admin.html            Admin dashboard (traffic, clicks, feedback, trend charts)
public/terms.html            Terms and Conditions page
public/privacy.html          Privacy Policy page
data/avatars/                Uploaded profile pictures (created at runtime, next to data.json)
test_*.mjs                   Zero-dependency test suite (node test_<name>.mjs), one file per feature area
```

## API endpoints

- `GET /api/breaks` — lightweight list of upcoming breaks (dates, status)
  plus `realPricesAvailable`. Deliberately excludes deals, so loading the
  dashboard never waits on flight-price lookups.
- `GET /api/deals?breakKey=...` — fetches deals for one specific break,
  called lazily when the user expands it. Real fares first, backfilled to a
  minimum of 3 destinations — see **Real data only** above.
- `GET /api/events?breakKey=...` — real Ticketmaster events near the user's
  hometown during that break.
- `GET /api/activities` — real Viator activities, or free OpenStreetMap
  public spots, for the user's saved hometown.
- `PUT /api/settings` / `GET /api/settings` — save/read Setup (hometown,
  home airport, currency, interests, roster pattern or manual breaks).
- `POST /api/deal-click` / `POST /api/event-click` — fire-and-forget click
  tracking (anonymous-safe), feeds personalisation and admin stats.
- `POST /api/feedback` — records a feedback-widget submission (anonymous-safe).
- `GET /api/unsubscribe?token=...` — unsubscribes an account from
  break-reminder emails; the link every digest email includes.
- `GET /api/calendar-token` — returns this user's `.ics` subscribe URL.
- `GET /calendar/<token>.ics` — the actual calendar feed (outside `/api/`,
  no auth header, fetched unattended by calendar apps).
- `GET /api/stats` — the logged-in user's own account activity (My Stats tab).
- `GET /api/admin/stats` — site-wide stats; 403 unless the logged-in email
  is in `ADMIN_EMAIL`.
- `POST /api/auth/signup` / `POST /api/auth/login` — create/log into an
  account, sets a session cookie, migrates any in-progress anonymous setup.
- `POST /api/auth/google` — log in/sign up via a Google ID token
  (`{credential}`), verified server-side against Google.
- `POST /api/auth/logout` — clear the session cookie.
- `GET /api/auth/me` — current login state
  (`{loggedIn, email, googleClientId, isAdmin}`).
- `POST /api/auth/forgot-password` / `POST /api/auth/reset-password` —
  password-reset flow (see **Forgot password** above).
- `GET /api/profile` / `PUT /api/profile` — display name, avatar, and
  marketing opt-in for the logged-in account. Requires a real session.

## Deploying

This needs a host that keeps a Node process running continuously (not a
static site host, not a serverless function — the JSON data store and
uploaded avatars need a persistent disk). Two ready-made configs are
included:

**Render** (`render.yaml`) — easiest option, has a free/starter tier:
1. Push this folder to a GitHub repo.
2. In the Render dashboard: **New → Blueprint**, point it at the repo.
   Render reads `render.yaml` and creates the web service plus a 1GB
   persistent disk automatically.
3. In the service's **Environment** tab, paste your real values in (left
   blank in the blueprint on purpose — never commit real secrets to git).
4. Once it's live at `*.onrender.com`, go to **Settings → Custom Domains**
   and add `www.nextbreak.com.au` (and `nextbreak.com.au` with a redirect
   to www, or vice versa — pick one as canonical). Render gives you a
   CNAME/A record to add at your domain registrar; propagation + free TLS
   cert usually takes a few minutes to an hour.

**Fly.io** (`fly.toml`) — more control, also has a free allowance, region
set to Sydney for AU latency:
```bash
fly launch          # detects fly.toml
fly volumes create next_break_data --size 1
fly secrets set TRAVELPAYOUTS_TOKEN=your_token_here
fly deploy
fly certs add www.nextbreak.com.au
```
`fly certs add` prints the DNS records to add at your registrar.

Either way, `TRAVELPAYOUTS_MARKER` and `PORT` are already set as plain env
vars in the config — only tokens/keys are secrets you add yourself in the
host's dashboard/CLI, same handling as everything else sensitive so far.

## Known limitations

- **Login is optional.** Signing up saves your setup to an account
  (email/password or Google) that follows you across devices, with a
  working password-reset flow. Anyone not signed in still falls back to
  the original per-browser device ID (fine for testing, but not a real
  durable identity).
- **`data.json` is not a real database.** It's a single file rewritten on
  every change — it'll get slow and is not safe for concurrent writes at
  any real scale. Swap in Postgres/SQLite-with-a-real-driver before you
  have more than a handful of users.
- **Real fares are a cache, not a live GDS search.** Some destinations/dates
  will genuinely have no cached fare — this is inherent to how the
  Travelpayouts Data API works, not a bug to fix. That's exactly what the
  backfill destinations (see **Real data only**) exist to soften, without
  ever inventing a price.
- **No control over the booking experience.** "Book this fare"/"Check
  flights" hand the user off to Aviasales/the airline — there's no way to
  guarantee price accuracy at the moment of click, and refunds/changes
  happen entirely on the airline/OTA's side, not in this app.

## Where to go from here

- Deploy: this needs a host that runs a persistent Node process (Render,
  Railway, Fly.io, a VPS) — not a pure static host.
- Have a lawyer review `public/terms.html` and `public/privacy.html` before
  relying on them commercially.
- Add a real database once `data.json` starts to strain.
- Expand `REAL_DESTINATIONS` in `lib/travelpayouts.js` with more curated
  destinations to increase the odds of a cache hit per break.
- Track commission performance from your
  [Travelpayouts dashboard](https://www.travelpayouts.com),
  [Viator partner dashboard](https://partners.viator.com), and Ticketmaster's
  Impact account once real users start clicking through.
