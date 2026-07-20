// Tiny JSON-file persistence layer. No database engine, no native
// dependencies — fine for a single-instance demo/MVP. Swap this module
// out for a real database before you have more than a handful of users.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data.json');

function defaultData() {
  return {
    users: {}, unlocks: {}, accounts: {}, sessions: {}, passwordResets: {}, dealClicks: [], eventClicks: [],
    feedback: [], digestsSent: [], calendarTokens: {}, visitsByDay: {},
    savedVenues: {}, breakNotes: {}, shareTokens: {}, priceBaselines: {}
  };
}

// Deal-click log is capped so data.json can't grow without bound on a
// long-running instance — old entries are dropped once the cap is hit.
// Fine for admin-dashboard purposes (recent activity + aggregate counts);
// swap for a real event store if you ever need full history.
const MAX_DEAL_CLICK_LOG = 5000;

function readRaw() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return { ...defaultData(), ...JSON.parse(raw) };
  } catch (e) {
    return defaultData();
  }
}

function writeRaw(data) {
  // Write-to-temp-then-rename so a crash or restart mid-write can never
  // leave data.json half-written/corrupted — rename is atomic on the same
  // filesystem. Still a single-file store (won't work across multiple
  // server instances/replicas), but robust for one persistent instance.
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpFile = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, DATA_FILE);
}

function defaultSettings() {
  return {
    hometown: '',
    originAirport: '',
    currency: 'AUD',
    rosterMode: 'pattern',
    pattern: { daysOn: 14, daysOff: 7, nextBreakStart: '' },
    manualBreaks: [],
    // Personalisation for logged-in users (see server.js buildPersonalizationProfile):
    // `interests` is explicit ("I like beach trips"), set via the profile UI.
    // `dealAffinity` is implicit, a tag -> click-count map built up from which
    // "Book this fare" links they actually click.
    interests: [],
    dealAffinity: {},
    // Opt-in, separate from the break-reminder digest (marketingOptIn on
    // the account record) — see maybeSendPriceAlertForAccount in server.js.
    priceAlerts: false
  };
}

export function getSettings(userId) {
  const data = readRaw();
  return data.users[userId] || defaultSettings();
}

export function saveSettings(userId, settings) {
  const data = readRaw();
  const existing = data.users[userId] || defaultSettings();
  data.users[userId] = {
    ...existing,
    ...settings,
    pattern: { ...existing.pattern, ...(settings.pattern || {}) }
  };
  writeRaw(data);
  return data.users[userId];
}

export function isUnlocked(userId, breakKey) {
  const data = readRaw();
  return !!(data.unlocks[userId] && data.unlocks[userId][breakKey]?.paid);
}

export function markUnlocked(userId, breakKey, info) {
  const data = readRaw();
  if (!data.unlocks[userId]) data.unlocks[userId] = {};
  data.unlocks[userId][breakKey] = { paid: true, ...info };
  writeRaw(data);
}

export function getUnlockRecord(userId, breakKey) {
  const data = readRaw();
  return data.unlocks[userId]?.[breakKey] || null;
}

// ---------- accounts (email/password + Google sign-in) ----------
// One account per email regardless of how they signed in — a user who
// first signed up with a password can later use "Sign in with Google" on
// the same email and it links to the same account, rather than creating a
// second one.

export function getAccount(email) {
  const data = readRaw();
  return data.accounts[email.toLowerCase()] || null;
}

export function createAccount(email, { passwordHash = null, googleSub = null, termsAcceptedAt = null, termsVersion = null, marketingOptIn = false } = {}) {
  const data = readRaw();
  const key = email.toLowerCase();
  data.accounts[key] = { email: key, passwordHash, googleSub, termsAcceptedAt, termsVersion, marketingOptIn: !!marketingOptIn, createdAt: new Date().toISOString() };
  writeRaw(data);
  return data.accounts[key];
}

// Finds-or-creates an account for a Google sign-in, linking the Google
// subject id to an existing password-based account with the same email if
// one exists (so either login method works afterward). termsAcceptedAt/
// termsVersion are only ever set on first creation — logging into an
// already-existing account never touches them, since that account already
// recorded acceptance (or predates this feature) and re-accepting isn't
// meaningful just because someone's logging in again.
export function upsertGoogleAccount(email, googleSub, { termsAcceptedAt = null, termsVersion = null, marketingOptIn = false } = {}) {
  const data = readRaw();
  const key = email.toLowerCase();
  if (data.accounts[key]) {
    if (!data.accounts[key].googleSub) data.accounts[key].googleSub = googleSub;
  } else {
    data.accounts[key] = { email: key, passwordHash: null, googleSub, termsAcceptedAt, termsVersion, marketingOptIn: !!marketingOptIn, createdAt: new Date().toISOString() };
  }
  writeRaw(data);
  return data.accounts[key];
}

// ---------- sessions ----------
export function createSession(token, email) {
  const data = readRaw();
  data.sessions[token] = { email: email.toLowerCase(), createdAt: new Date().toISOString() };
  writeRaw(data);
}

export function getSessionEmail(token) {
  if (!token) return null;
  const data = readRaw();
  return data.sessions[token]?.email || null;
}

export function deleteSession(token) {
  if (!token) return;
  const data = readRaw();
  delete data.sessions[token];
  writeRaw(data);
}

export function setAccountPassword(email, passwordHash) {
  const data = readRaw();
  const key = email.toLowerCase();
  if (!data.accounts[key]) return false;
  data.accounts[key].passwordHash = passwordHash;
  writeRaw(data);
  return true;
}

// Merges only the fields provided — e.g. calling with just {displayName}
// leaves an existing avatarUrl untouched. Returns the updated account, or
// null if there's no account for that email.
export function setAccountProfile(email, { displayName, avatarUrl, marketingOptIn } = {}) {
  const data = readRaw();
  const key = email.toLowerCase();
  if (!data.accounts[key]) return null;
  if (displayName !== undefined) data.accounts[key].displayName = displayName;
  if (avatarUrl !== undefined) data.accounts[key].avatarUrl = avatarUrl;
  if (marketingOptIn !== undefined) data.accounts[key].marketingOptIn = !!marketingOptIn;
  writeRaw(data);
  return data.accounts[key];
}

// A stable, unguessable per-account token used to unsubscribe from the
// break-reminder digest without needing to be logged in (the link is
// clicked from an email client, often on a different device/browser than
// the one they're signed in on). Generated lazily on first use rather than
// at account creation, so existing accounts pick one up automatically the
// first time they'd actually need it.
export function getOrCreateUnsubscribeToken(email) {
  const data = readRaw();
  const key = email.toLowerCase();
  if (!data.accounts[key]) return null;
  if (!data.accounts[key].unsubscribeToken) {
    data.accounts[key].unsubscribeToken = crypto.randomBytes(24).toString('hex');
    writeRaw(data);
  }
  return data.accounts[key].unsubscribeToken;
}

// Linear scan is fine at this scale — same reasoning as
// getCalendarTokenForUser below, just the other direction (token -> email
// here, vs id -> userId there).
export function getEmailByUnsubscribeToken(token) {
  if (!token) return null;
  const data = readRaw();
  const entry = Object.values(data.accounts).find(a => a.unsubscribeToken === token);
  return entry ? entry.email : null;
}

// ---------- admin: accounts + deal-click log ----------
// Read-only listing for the admin dashboard — never exposes passwordHash or
// googleSub, just whether each is set (useful for "how did they sign up").
export function listAccounts() {
  const data = readRaw();
  return Object.values(data.accounts).map(({ passwordHash, googleSub, ...rest }) => ({
    ...rest,
    hasPassword: !!passwordHash,
    hasGoogle: !!googleSub
  }));
}

// email is optional: anonymous visitors (no session) still get their click
// recorded, just with email: null, so aggregate counts on the admin
// dashboard reflect everyone, not only logged-in accounts.
export function recordDealClick(email, { iata, name } = {}) {
  const data = readRaw();
  if (!Array.isArray(data.dealClicks)) data.dealClicks = [];
  data.dealClicks.push({ email: email ? email.toLowerCase() : null, iata, name, at: new Date().toISOString() });
  if (data.dealClicks.length > MAX_DEAL_CLICK_LOG) {
    data.dealClicks = data.dealClicks.slice(-MAX_DEAL_CLICK_LOG);
  }
  writeRaw(data);
}

export function listDealClicks() {
  const data = readRaw();
  return Array.isArray(data.dealClicks) ? data.dealClicks : [];
}

// ---------- event-click log (mirrors the deal-click log above) ----------
// Same shape, same reasoning, same anonymous-safe email handling. Kept as a
// separate array (rather than reusing dealClicks with a "type" field) since
// events don't have a fixed IATA-style catalog to validate against — the id
// here is whatever Ticketmaster's own event id was at click time.
const MAX_EVENT_CLICK_LOG = 5000;

export function recordEventClick(email, { id, name } = {}) {
  const data = readRaw();
  if (!Array.isArray(data.eventClicks)) data.eventClicks = [];
  data.eventClicks.push({ email: email ? email.toLowerCase() : null, id, name, at: new Date().toISOString() });
  if (data.eventClicks.length > MAX_EVENT_CLICK_LOG) {
    data.eventClicks = data.eventClicks.slice(-MAX_EVENT_CLICK_LOG);
  }
  writeRaw(data);
}

export function listEventClicks() {
  const data = readRaw();
  return Array.isArray(data.eventClicks) ? data.eventClicks : [];
}

// ---------- in-app feedback bubble ----------
// Same anonymous-safe shape and cap pattern as the click logs above. Kept
// intentionally lightweight (a reaction, up to a few preset topic tags, and
// an optional free-text comment) since the whole point of the feedback
// bubble is that it takes a few seconds, not that it's a full survey.
const MAX_FEEDBACK_LOG = 2000;

export function recordFeedback(email, { reaction, topics = [], comment = '', view = null } = {}) {
  const data = readRaw();
  if (!Array.isArray(data.feedback)) data.feedback = [];
  data.feedback.push({
    email: email ? email.toLowerCase() : null,
    reaction,
    topics: Array.isArray(topics) ? topics : [],
    comment: comment || '',
    view: view || null,
    at: new Date().toISOString()
  });
  if (data.feedback.length > MAX_FEEDBACK_LOG) {
    data.feedback = data.feedback.slice(-MAX_FEEDBACK_LOG);
  }
  writeRaw(data);
}

export function listFeedback() {
  const data = readRaw();
  return Array.isArray(data.feedback) ? data.feedback : [];
}

// ---------- break-reminder digest: send dedup ----------
// One digest per (account, break) ever — see lib/digest.js for why a
// 3-day-wide "days until break" window is used upstream of this check.
// Without this log, a break sitting in that window across multiple daily
// sweeps (or a sweep re-running after a restart) would re-send the same
// email every time it ran.
export function recordDigestSent(email, breakKey) {
  const data = readRaw();
  if (!Array.isArray(data.digestsSent)) data.digestsSent = [];
  data.digestsSent.push({ email: email.toLowerCase(), breakKey, at: new Date().toISOString() });
  writeRaw(data);
}

export function hasDigestSent(email, breakKey) {
  const data = readRaw();
  if (!Array.isArray(data.digestsSent)) return false;
  const key = email.toLowerCase();
  return data.digestsSent.some(d => d.email === key && d.breakKey === breakKey);
}

// ---------- site visits (privacy-first pageview counter) ----------
// Deliberately just a per-day total, not a per-visit log with IPs, cookies,
// or any other identifier — this app's own Privacy Policy says "we don't
// run analytics or advertising trackers on the Service," and a per-day
// count with nothing else attached to it keeps that true: there's no way
// to tell two visits on the same day apart, let alone identify who made
// them. Capped to the last MAX_VISIT_DAYS days so data.json can't grow
// without bound on a long-running instance, same reasoning as the
// deal-click cap above.
const MAX_VISIT_DAYS = 400; // just over a year of daily buckets

export function recordVisit() {
  const data = readRaw();
  if (!data.visitsByDay || typeof data.visitsByDay !== 'object') data.visitsByDay = {};
  const day = new Date().toISOString().slice(0, 10);
  data.visitsByDay[day] = (data.visitsByDay[day] || 0) + 1;
  const days = Object.keys(data.visitsByDay).sort();
  if (days.length > MAX_VISIT_DAYS) {
    for (const old of days.slice(0, days.length - MAX_VISIT_DAYS)) delete data.visitsByDay[old];
  }
  writeRaw(data);
}

export function getVisitsByDay() {
  const data = readRaw();
  return (data.visitsByDay && typeof data.visitsByDay === 'object') ? data.visitsByDay : {};
}

// ---------- calendar feed tokens ----------
// One token per userId (device id or account email — whatever getUserId()
// in server.js currently resolves to), created lazily on first request.
// Deliberately NOT keyed the other way (userId -> token lookup only) since
// the token itself is the only thing an unauthenticated calendar app ever
// presents — a linear scan here is fine at this scale.
export function getCalendarTokenForUser(userId) {
  const data = readRaw();
  const entry = Object.entries(data.calendarTokens || {}).find(([, uid]) => uid === userId);
  return entry ? entry[0] : null;
}

export function setCalendarToken(token, userId) {
  const data = readRaw();
  if (!data.calendarTokens) data.calendarTokens = {};
  data.calendarTokens[token] = userId;
  writeRaw(data);
}

export function getUserIdForCalendarToken(token) {
  if (!token) return null;
  const data = readRaw();
  return data.calendarTokens?.[token] || null;
}

// Deletes every active session belonging to an email — used after a
// password reset so a stolen/leaked session token elsewhere is kicked out
// the moment someone resets their password.
export function deleteAllSessionsForEmail(email) {
  const data = readRaw();
  const key = email.toLowerCase();
  for (const token of Object.keys(data.sessions)) {
    if (data.sessions[token]?.email === key) delete data.sessions[token];
  }
  writeRaw(data);
}

// ---------- password resets ----------
// Single-use, time-limited tokens. Expired entries are cleaned up lazily on
// read rather than needing a background job — fine at this scale.
export function createPasswordReset(token, email, ttlMs) {
  const data = readRaw();
  data.passwordResets[token] = { email: email.toLowerCase(), expiresAt: Date.now() + ttlMs };
  writeRaw(data);
}

// Returns the email for a valid, unexpired token, or null. Does NOT delete
// the token itself — callers should call deletePasswordReset once the
// reset is actually completed, so a token stays valid if e.g. the password
// update step fails partway and needs retrying.
export function getPasswordResetEmail(token) {
  if (!token) return null;
  const data = readRaw();
  const record = data.passwordResets[token];
  if (!record) return null;
  if (Date.now() > record.expiresAt) {
    delete data.passwordResets[token];
    writeRaw(data);
    return null;
  }
  return record.email;
}

export function deletePasswordReset(token) {
  if (!token) return;
  const data = readRaw();
  delete data.passwordResets[token];
  writeRaw(data);
}

// Copies one user's settings/unlocks from one key to another — used when
// an anonymous device (keyed by its random device id) signs up or logs in,
// so their in-progress setup carries over into the account instead of
// forcing them to redo it. Never overwrites data the target already has.
export function migrateUser(fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return;
  const data = readRaw();
  if (data.users[fromKey] && !data.users[toKey]) {
    data.users[toKey] = data.users[fromKey];
  }
  if (data.unlocks[fromKey] && !data.unlocks[toKey]) {
    data.unlocks[toKey] = data.unlocks[fromKey];
  }
  writeRaw(data);
}

// Used only by tests / local dev to point the store at a scratch file.
export function _dataFilePath() {
  return DATA_FILE;
}

// ---------- saved venues (shortlist) ----------
// A logged-in user's own bookmarked restaurants/stays/events, so a good
// find doesn't disappear the moment they close the tab. Deliberately a
// plain id (type|title|url), not a hash — it's stored server-side only
// (never rendered raw to anyone else), and being human-readable makes it
// trivial to reason about while debugging. Capped per-account the same way
// the click logs are capped, just much higher, since this is a small
// user-curated list, not a firehose.
const MAX_SAVED_VENUES = 300;

export function venueIdFor({ type, title, url }) {
  return `${type}|${title}|${url || ''}`;
}

export function listSavedVenues(email) {
  const data = readRaw();
  const key = email.toLowerCase();
  return Array.isArray(data.savedVenues?.[key]) ? data.savedVenues[key] : [];
}

// No-ops (returns the list unchanged) if this exact venue is already
// saved, so double-clicking the save button never creates a duplicate.
export function saveVenue(email, venue) {
  const data = readRaw();
  const key = email.toLowerCase();
  if (!data.savedVenues) data.savedVenues = {};
  if (!Array.isArray(data.savedVenues[key])) data.savedVenues[key] = [];
  const id = venueIdFor(venue);
  if (data.savedVenues[key].some(v => v.id === id)) return data.savedVenues[key];
  data.savedVenues[key].unshift({
    id,
    type: venue.type,
    title: venue.title,
    subtitle: venue.subtitle || null,
    url: venue.url || null,
    imageUrl: venue.imageUrl || null,
    savedAt: new Date().toISOString()
  });
  if (data.savedVenues[key].length > MAX_SAVED_VENUES) {
    data.savedVenues[key] = data.savedVenues[key].slice(0, MAX_SAVED_VENUES);
  }
  writeRaw(data);
  return data.savedVenues[key];
}

export function removeSavedVenue(email, id) {
  const data = readRaw();
  const key = email.toLowerCase();
  if (!Array.isArray(data.savedVenues?.[key])) return [];
  data.savedVenues[key] = data.savedVenues[key].filter(v => v.id !== id);
  writeRaw(data);
  return data.savedVenues[key];
}

// ---------- per-break notes + checklist ----------
// Free-text notes plus a small checklist, scoped to one account + one
// break's stable key (see computeUpcomingBreaks in lib/deals.js — the key
// is derived from the break's actual dates, so this survives roster
// re-generation the same way unlocks do).
export function getBreakNotes(email, breakKey) {
  const data = readRaw();
  const key = email.toLowerCase();
  return data.breakNotes?.[key]?.[breakKey] || { notes: '', checklist: [] };
}

export function saveBreakNotes(email, breakKey, { notes, checklist }) {
  const data = readRaw();
  const key = email.toLowerCase();
  if (!data.breakNotes) data.breakNotes = {};
  if (!data.breakNotes[key]) data.breakNotes[key] = {};
  data.breakNotes[key][breakKey] = {
    notes: typeof notes === 'string' ? notes.slice(0, 4000) : '',
    checklist: Array.isArray(checklist) ? checklist.slice(0, 50).map(c => ({
      id: String(c.id || '').slice(0, 40) || crypto.randomBytes(6).toString('hex'),
      text: String(c.text || '').slice(0, 200),
      done: !!c.done
    })) : [],
    updatedAt: new Date().toISOString()
  };
  writeRaw(data);
  return data.breakNotes[key][breakKey];
}

// ---------- roster-mate share link ----------
// One unguessable token per account, same lazy-create-on-first-use pattern
// as getOrCreateUnsubscribeToken above — a stable, human-shareable link a
// FIFO worker can send a roster-mate or partner so they can see upcoming
// break dates without needing their own account. Linear scan for the
// reverse lookup is fine at this scale, same reasoning as
// getCalendarTokenForUser below.
export function getOrCreateShareToken(email) {
  const data = readRaw();
  const key = email.toLowerCase();
  if (!data.shareTokens) data.shareTokens = {};
  const existing = Object.entries(data.shareTokens).find(([, e]) => e === key);
  if (existing) return existing[0];
  const token = crypto.randomBytes(16).toString('hex');
  data.shareTokens[token] = key;
  writeRaw(data);
  return token;
}

export function getEmailForShareToken(token) {
  if (!token) return null;
  const data = readRaw();
  return data.shareTokens?.[token] || null;
}

// ---------- price-drop / new-fare alert baseline ----------
// One record per (account, break): the cheapest real fare we've already
// told them about (or first noticed, without emailing — see
// maybeSendPriceAlertForAccount in server.js for why the very first sight
// of a break never fires an email), plus when we last actually sent an
// alert, so a sweep can throttle repeat emails for the same break even as
// the price keeps moving around.
export function getPriceBaseline(email, breakKey) {
  const data = readRaw();
  const key = email.toLowerCase();
  return data.priceBaselines?.[key]?.[breakKey] || null;
}

export function setPriceBaseline(email, breakKey, { price, iata, name, lastAlertAt }) {
  const data = readRaw();
  const key = email.toLowerCase();
  if (!data.priceBaselines) data.priceBaselines = {};
  if (!data.priceBaselines[key]) data.priceBaselines[key] = {};
  const existing = data.priceBaselines[key][breakKey] || {};
  data.priceBaselines[key][breakKey] = {
    price,
    iata: iata ?? existing.iata ?? null,
    name: name ?? existing.name ?? null,
    lastAlertAt: lastAlertAt !== undefined ? lastAlertAt : (existing.lastAlertAt || null),
    seenAt: new Date().toISOString()
  };
  writeRaw(data);
  return data.priceBaselines[key][breakKey];
}
