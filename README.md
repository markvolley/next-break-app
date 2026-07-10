# Next Break

A FIFO/roster travel planner: enter your swing pattern or manual break dates,
see your upcoming breaks, and browse real flight prices for each one — with
a trackable "Book this fare" link that earns an affiliate commission when
someone books. A "things to do in your hometown" section is also included.

**How it makes money:** every deal card links out through a Travelpayouts
(Aviasales) affiliate link. Users pay nothing — the airline/OTA pays a small
commission on completed bookings. No paywall, no fee, no friction between
someone seeing a deal and being able to book it.

## Real prices only — no fake/mock deals

Deals come from the Travelpayouts Data API, which is a **cache of recent
real searches**, not a live GDS lookup — perfect for someone planning weeks
ahead for a scheduled break, but it does mean a given destination won't
always have cached data for the exact dates asked. That's normal, not a bug.

There's deliberately no mock/illustrative price fallback. A made-up price
with a plain Google search link doesn't earn commission when clicked and
risks misleading the user, so instead each break shows one of three honest
states:

- **Real fares** — `TRAVELPAYOUTS_TOKEN` is set, a home airport is entered,
  and at least one of the ~22 curated destinations had a cached fare for
  those dates. Shows real airline, flight number, price, and a working
  "Book this fare" affiliate link.
- **"No cached fares yet"** — token and home airport are both set, but none
  of the destinations queried had cached data for that route/date range.
  No fake price, no dead-end search link — just an honest message.
- **"Add your home airport"** — no home airport entered yet (or
  `TRAVELPAYOUTS_TOKEN` isn't set on the server), so no search was even
  attempted.

If real fares seem to be missing more than expected, check the server logs
(e.g. Render's Logs tab) — `lib/travelpayouts.js` logs a hit-rate line per
lookup (`X/Y destinations had cached fares`) and logs the actual HTTP
status/response body on any API error, so an invalid token shows up
distinctly from a genuine cache miss.

## Things to do — real activities via Viator only

The "things to do in your hometown" section works the same way as flights:
real bookable tours/activities from Viator (owned by TripAdvisor) via
`lib/viator.js`, with a trackable "Book this activity" affiliate link.
Configure `VIATOR_API_KEY`, `VIATOR_PID`, and `VIATOR_MCID` in `.env` (sign
up free at [partners.viator.com/signup](https://partners.viator.com/signup))
to turn it on.

There's no fallback here at all — no generic suggestion cards, no
Google/TripAdvisor search links. Every card shown is a real Viator listing
with an affiliate link attached, so all traffic from this section has a
chance to earn commission. If Viator isn't configured, or no activities are
found for the hometown entered, the section just says so plainly instead of
sending anyone to a non-affiliate link.

**Known unverified area:** the endpoints, auth, and destination-lookup
fields in `lib/viator.js` are confirmed against Viator's published API
docs. The exact field names inside an individual `/search/products` result
(title, image, price, rating) are a best-effort mapping, since Viator's
docs didn't expose a full sample response for that endpoint and this dev
environment has no network access to Viator's API to verify live. The code
logs the raw key names of the first result it gets back
(`[viator] sample raw product keys: ...`) — check that log against what
`normalizeProduct()` in `lib/viator.js` expects the first time you get a
real API key, and adjust the field names there if anything looks off
(e.g. missing prices or images on cards that should have them).

## Why no `npm install`?

The whole backend is built on Node's built-ins only (`http`, `fetch`,
`crypto`, `fs`) — no Express, no Stripe SDK, no database engine. That means:

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
   airport, e.g. `PER`), save, and click a break to see real fares.

Without a token, the app still runs fine — every break just shows
illustrative mock deals instead of real ones.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `TRAVELPAYOUTS_TOKEN` | For real flight prices | — | From your Travelpayouts account. Without it, breaks just prompt the user to add a home airport — no fake prices. |
| `TRAVELPAYOUTS_MARKER` | For commission tracking | `749343` | Your affiliate ID — attached to every booking link so completed bookings are credited to you. |
| `VIATOR_API_KEY` | For real activities | — | From your Viator partner account. Without it, "things to do" shows generic suggestions instead of real listings. |
| `VIATOR_PID` | For commission tracking | — | Your Viator Partner ID — attached to every activity booking link. |
| `VIATOR_MCID` | For commission tracking | — | Your Viator campaign ID — also attached to booking links. |
| `PORT` | No | `3000` | |
| `DATA_FILE` | No | `./data.json` | Where user settings are stored |
| `STRIPE_SECRET_KEY` | No | — | Unused (paywall is off — see below). Only needed if you re-enable it. |
| `STRIPE_WEBHOOK_SECRET` | No | — | Unused unless you re-enable the paywall and wire up webhooks. |
| `UNLOCK_FEE_CENTS` | No | `500` | Unused unless you re-enable the paywall. |

## About the Stripe code

An earlier version of this app gated deals behind a small Stripe Checkout
fee. That's been removed in favor of the affiliate-commission model above —
no fee, no blocker between seeing a deal and booking it. The Stripe
integration (`lib/stripeClient.js`, `/api/checkout*`, `/api/stripe/webhook`)
is still in the codebase, fully implemented and tested, but dormant and
unused. Safe to ignore, or delete if you want to slim things down.

## Project structure

```
server.js                 HTTP server + API routes
lib/deals.js               Break date/scheduling logic (pure functions)
lib/travelpayouts.js        Real flight price lookups + affiliate booking links
lib/viator.js                 Real activity listings + affiliate booking links
lib/store.js                   JSON-file persistence (user settings)
lib/stripeClient.js             Raw Stripe REST calls (dormant, unused — see above)
lib/links.js                     Search-link helpers (generic-suggestion fallback links)
public/index.html                 Frontend (vanilla JS, no build step)
```

## API endpoints

- `GET /api/breaks` — lightweight list of upcoming breaks (dates, status)
  plus `realPricesAvailable` (whether this user can get real prices right
  now). Deliberately excludes deals, so loading the dashboard never waits
  on flight-price lookups.
- `GET /api/deals?breakKey=...` — fetches deals for one specific break,
  called lazily when the user expands it in the accordion. Real fares only
  (see above) — no mock fallback.
- `GET /api/activities` — real Viator activities for the user's saved
  hometown, or a `not-configured`/`no-results` state if unavailable.
- `PUT /api/settings` — save Setup (hometown, home airport, currency,
  roster pattern or manual breaks).

## Deploying

This needs a host that keeps a Node process running continuously (not a
static site host, not a serverless function — the JSON data store needs a
persistent disk). Two ready-made configs are included:

**Render** (`render.yaml`) — easiest option, has a free/starter tier:
1. Push this folder to a GitHub repo.
2. In the Render dashboard: **New → Blueprint**, point it at the repo.
   Render reads `render.yaml` and creates the web service plus a 1GB
   persistent disk automatically.
3. In the service's **Environment** tab, paste your real value into
   `TRAVELPAYOUTS_TOKEN` (left blank in the blueprint on purpose — never
   commit real secrets to git).
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
vars in the config — only the token is a secret you add yourself in the
host's dashboard/CLI, same handling as everything else sensitive so far.

## Known limitations

- **No real login.** Each browser gets a random device ID stored in
  `localStorage` — there's no password, email, or account recovery, and it
  won't sync across devices. Fine for testing or a single-device MVP.
- **`data.json` is not a real database.** It's a single file rewritten on
  every change — it'll get slow and is not safe for concurrent writes at
  any real scale. Swap in Postgres/SQLite-with-a-real-driver before you
  have more than a handful of users.
- **Real prices are a cache, not live search.** Some destinations/dates
  will come back with no cached fare and fall back to mock — this is
  inherent to how the Travelpayouts Data API works, not a bug to fix.
- **No control over the booking experience.** "Book this fare" hands the
  user off to Aviasales/the airline — there's no way to guarantee price
  accuracy at the moment of click, and refunds/changes happen entirely on
  the airline/OTA's side, not in this app.

## Where to go from here

- Deploy: this needs a host that runs a persistent Node process (Render,
  Railway, Fly.io, a VPS) — not a pure static host.
- Add real accounts: email + magic link or OAuth, replacing the
  `X-User-Id` header hack.
- Add a real database once `data.json` starts to strain.
- Expand `REAL_DESTINATIONS` in `lib/travelpayouts.js` with more curated
  destinations to increase the odds of a cache hit per break.
- Track commission performance from your
  [Travelpayouts dashboard](https://www.travelpayouts.com) once real users
  start clicking through.
