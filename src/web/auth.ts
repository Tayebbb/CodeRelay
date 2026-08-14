/**
 * Authentication for the web interface.
 *
 * Single-operator model, matching the rest of the application: one password,
 * hashed with scrypt into a file the operator creates with `remote-agent web
 * setup`. There is no signup route — an unauthenticated visitor must have no
 * way to create an account on a server that can execute code.
 *
 * Sessions are opaque random tokens held in memory: a restart signs everyone
 * out, which for a code-executing agent is the right default.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };

export interface WebAuthRecord {
  salt: string;
  hash: string;
  createdAt: number;
}

export function createPasswordFile(file: string, password: string): void {
  if (password.length < 8) {
    throw new Error('The web password must be at least 8 characters.');
  }
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS).toString('hex');
  const record: WebAuthRecord = { salt, hash, createdAt: Date.now() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
}

export function passwordFileExists(file: string): boolean {
  return fs.existsSync(file);
}

export function verifyPassword(file: string, password: string): boolean {
  let record: WebAuthRecord;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8')) as WebAuthRecord;
  } catch {
    return false;
  }
  if (typeof record?.salt !== 'string' || typeof record?.hash !== 'string') return false;

  const expected = Buffer.from(record.hash, 'hex');
  const actual = scryptSync(password, record.salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

interface Session {
  expiresAt: number;
}

export class SessionStore {
  private sessions = new Map<string, Session>();

  constructor(private readonly ttlMs: number) {}

  create(): string {
    this.prune();
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  /** Constant-shape lookup; token comparison happens via Map key hashing. */
  validate(token: string | null): boolean {
    if (!token) return false;
    const session = this.sessions.get(token);
    if (!session) return false;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  revoke(token: string | null): void {
    if (token) this.sessions.delete(token);
  }

  revokeAll(): void {
    this.sessions.clear();
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt < now) this.sessions.delete(token);
    }
  }
}

/**
 * Login throttle. Fixed small budget per window, keyed by remote address —
 * offline scrypt cracking is already infeasible; this stops online guessing.
 */
export class LoginThrottle {
  private attempts = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly maxAttempts = 5,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  allowed(key: string): boolean {
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry || now - entry.windowStart > this.windowMs) {
      this.attempts.set(key, { count: 1, windowStart: now });
      return true;
    }
    entry.count += 1;
    // Bound the map so an address-rotating client cannot grow it without limit.
    if (this.attempts.size > 10_000) this.attempts.clear();
    return entry.count <= this.maxAttempts;
  }
}
