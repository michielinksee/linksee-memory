// Static API-key based user resolution for the HTTP transport.
// Config is read once at startup from either:
//   1. LINKSEE_USERS_CONFIG env var (path to a JSON file), or
//   2. ~/.linksee-memory/users.json (default location), or
//   3. LINKSEE_API_KEYS=id:key,id:key  (inline env var, no file needed)
//
// If none of the above are present, auth is disabled and all requests are
// mapped to user_id 'default' (single-user / stdio compat mode).

import { readFileSync, existsSync } from 'node:fs';
import { timingSafeEqual, createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface UserEntry {
  id: string;
  key: string;
}

interface UsersConfig {
  users: UserEntry[];
}

// Internal: store hashed keys so plaintext doesn't linger in heap.
interface HashedEntry {
  id: string;
  keyHash: Buffer; // sha256 of the raw key
  keyLen: number;  // length of the raw key in bytes (for length check before comparison)
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

function buildEntries(users: UserEntry[]): HashedEntry[] {
  return users.map(u => ({
    id: u.id,
    keyHash: sha256(u.key),
    keyLen: Buffer.byteLength(u.key, 'utf8'),
  }));
}

function loadConfig(): HashedEntry[] {
  // Option 1: LINKSEE_API_KEYS=alice:sk-abc,bob:sk-def
  const inline = process.env['LINKSEE_API_KEYS'];
  if (inline) {
    const users: UserEntry[] = inline.split(',').flatMap(pair => {
      const colon = pair.indexOf(':');
      if (colon < 1) return [];
      return [{ id: pair.slice(0, colon).trim(), key: pair.slice(colon + 1).trim() }];
    });
    if (users.length > 0) return buildEntries(users);
  }

  // Option 2: JSON config file
  const configPath = process.env['LINKSEE_USERS_CONFIG'] ??
    join(homedir(), '.linksee-memory', 'users.json');

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf8');
      const cfg = JSON.parse(raw) as UsersConfig;
      if (Array.isArray(cfg.users) && cfg.users.length > 0) {
        return buildEntries(cfg.users);
      }
    } catch (e: any) {
      process.stderr.write(`[linksee-memory] Warning: failed to parse users config at ${configPath}: ${e?.message}\n`);
    }
  }

  return []; // no config → auth disabled
}

const entries: HashedEntry[] = loadConfig();

/** True when at least one user is configured (auth is enforced). */
export const authEnabled: boolean = entries.length > 0;

/**
 * Resolve a Bearer token to a user_id.
 * Returns null if the token doesn't match any registered key.
 * Uses constant-time comparison to resist timing attacks.
 */
export function resolveUser(bearerToken: string): string | null {
  const tokenBuf = Buffer.from(bearerToken, 'utf8');
  const tokenHash = sha256(bearerToken);

  for (const entry of entries) {
    // Length check first (avoids timing leak from hash comparison on different-length inputs)
    if (entry.keyLen !== tokenBuf.length) continue;
    if (timingSafeEqual(entry.keyHash, tokenHash)) return entry.id;
  }
  return null;
}
