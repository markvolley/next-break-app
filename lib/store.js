// Tiny JSON-file persistence layer. No database engine, no native
// dependencies — fine for a single-instance demo/MVP. Swap this module
// out for a real database before you have more than a handful of users.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data.json');

function defaultData() {
  return { users: {}, unlocks: {}, accounts: {}, sessions: {}, passwordResets: {}, dealClicks: [], calendarTokens: {} };
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
    dealAffinity: {}
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

export function recordDealClick(email, { iata, name } = {}) {
  const data = readRaw();
  if (!Array.isArray(data.dealClicks)) data.dealClicks = [];
  data.dealClicks.push({ email: email.toLowerCase(), iata, name, at: new Date().toISOString() });
  if (data.dealClicks.length > MAX_DEAL_CLICK_LOG) {
    data.dealClicks = data.dealClicks.slice(-MAX_DEAL_CLICK_LOG);
  }
  writeRaw(data);
}

export function listDealClicks() {
  const data = readRaw();
  return Array.isArray(data.dealClicks) ? data.dealClicks : [];
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
