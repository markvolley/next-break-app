// Tiny JSON-file persistence layer. No database engine, no native
// dependencies — fine for a single-instance demo/MVP. Swap this module
// out for a real database before you have more than a handful of users.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data.json');

function defaultData() {
  return { users: {}, unlocks: {}, accounts: {}, sessions: {} };
}

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
    manualBreaks: []
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

export function createAccount(email, { passwordHash = null, googleSub = null } = {}) {
  const data = readRaw();
  const key = email.toLowerCase();
  data.accounts[key] = { email: key, passwordHash, googleSub, createdAt: new Date().toISOString() };
  writeRaw(data);
  return data.accounts[key];
}

// Finds-or-creates an account for a Google sign-in, linking the Google
// subject id to an existing password-based account with the same email if
// one exists (so either login method works afterward).
export function upsertGoogleAccount(email, googleSub) {
  const data = readRaw();
  const key = email.toLowerCase();
  if (data.accounts[key]) {
    if (!data.accounts[key].googleSub) data.accounts[key].googleSub = googleSub;
  } else {
    data.accounts[key] = { email: key, passwordHash: null, googleSub, createdAt: new Date().toISOString() };
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
