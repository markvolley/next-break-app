// Email/password auth helpers — built on Node's built-in crypto only (no
// bcrypt/argon2 npm package needed). Passwords are hashed with scrypt (a
// deliberately slow, salted KDF suitable for password storage) and never
// stored or logged in plain text.

import crypto from 'node:crypto';

const SCRYPT_KEYLEN = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const hashBuffer = Buffer.from(hash, 'hex');
  const candidateBuffer = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  // Lengths must match before timingSafeEqual — mismatched lengths throw.
  return hashBuffer.length === candidateBuffer.length && crypto.timingSafeEqual(hashBuffer, candidateBuffer);
}

export function createSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
