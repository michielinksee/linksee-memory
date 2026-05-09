// Roots block — track the client's working roots (directories the agent is operating in).
//
// The server pulls roots from the client via server.request({method: 'roots/list'}) and caches them.
// Used by recall_file and read_smart to bias path-substring matches toward files inside a current root.
//
// MCP semantics: client owns the root list, server is informed. We refresh on demand
// (lazily on first use) and on roots/list_changed notification.

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

interface Root {
  uri: string; // typically "file:///abs/path"
  name?: string;
}

export interface RootsCache {
  roots: Root[] | null;
  fetchedAt: number;
}

export function makeRootsCache(): RootsCache {
  return { roots: null, fetchedAt: 0 };
}

// Backward-compat global cache used by the stdio single-session path (cache arg omitted).
const _globalCache: RootsCache = { roots: null, fetchedAt: 0 };
const STALE_MS = 60_000; // re-fetch at most once a minute

export async function fetchRoots(server: Server, cache: RootsCache = _globalCache): Promise<Root[]> {
  const now = Date.now();
  if (cache.roots && now - cache.fetchedAt < STALE_MS) return cache.roots;
  try {
    const res: any = await (server as any).request({ method: 'roots/list', params: {} }, ListRootsRequestSchema);
    cache.roots = Array.isArray(res?.roots) ? res.roots : [];
    cache.fetchedAt = now;
  } catch {
    // Client may not support roots; treat as empty.
    cache.roots = [];
    cache.fetchedAt = now;
  }
  return cache.roots ?? [];
}

export function invalidateRootsCache(cache: RootsCache = _globalCache): void {
  cache.roots = null;
  cache.fetchedAt = 0;
}

// Convert "file:///C:/Users/HP/foo" → "C:/Users/HP/foo" (or "/Users/foo" on POSIX)
export function rootPathFromUri(uri: string): string {
  if (uri.startsWith('file:///')) {
    let p = uri.slice('file:///'.length);
    // Windows: convert "C:/Users/..." (already POSIX-ish) — leave as-is, caller normalizes.
    if (process.platform === 'win32') {
      // also handle "C%3A/" encoding
      p = p.replace(/^([A-Za-z])(?:%3A|:)\//, '$1:/');
    } else {
      p = '/' + p;
    }
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  }
  return uri;
}

// Returns true if filePath is inside any of the roots (case-insensitive on win32).
export function isInsideRoots(filePath: string, roots: Root[]): boolean {
  if (roots.length === 0) return true; // no roots → no filtering
  const norm = process.platform === 'win32' ? filePath.toLowerCase().replace(/\\/g, '/') : filePath;
  return roots.some((r) => {
    const rp = rootPathFromUri(r.uri);
    const rpn = process.platform === 'win32' ? rp.toLowerCase().replace(/\\/g, '/') : rp;
    return norm.startsWith(rpn);
  });
}
