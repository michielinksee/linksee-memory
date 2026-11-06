// Reversal and attribution for memories (0.18.0).
//
// Two of the four cases an outside developer named (Discussion #16) where decision memory breaks:
//   1. Reversal — "we decided X" then "no, Y". Before 0.18 nothing wrote a `supersedes` edge, so
//      recall returned both and ranked by recency/score. Now `remember({ supersedes })` writes the
//      edge and marks the old row; recall folds it unless asked.
//   2. Who said it — `memories.source` was never filled from the MCP side. Now each new row
//      records the client name/version the MCP host sent in `initialize` (self-reported, not proof).
//
// Rules (fail-closed): an id that does not exist, the new row itself, a row of another entity,
// or a row the next session import will rewrite (raw Stop-hook capture) is refused, and nothing
// is written — no new row, no edge, no state change.

import type Database from '../db/sqlite.js';

export const MAX_SUPERSEDES = 20;

export class SupersedeRefused extends Error {
  constructor(public readonly memoryId: number | null, public readonly reason: string) {
    super(reason);
    this.name = 'SupersedeRefused';
  }
}

/** Normalize the `supersedes` argument to a de-duplicated list of positive integers, or throw. */
export function parseSupersedesArg(raw: unknown): number[] {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) return [];
  if (list.length > MAX_SUPERSEDES) {
    throw new SupersedeRefused(null, `supersedes takes at most ${MAX_SUPERSEDES} ids (got ${list.length})`);
  }
  const out: number[] = [];
  for (const v of list) {
    const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) {
      throw new SupersedeRefused(null, `supersedes must be memory ids (positive integers); got ${JSON.stringify(v)}`);
    }
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

interface OldRow { id: number; entity_id: number; content: string; source: string | null }

/**
 * Check every id against the DB. Throws SupersedeRefused on the first id that cannot be
 * confirmed. Call inside the same transaction as the INSERT so the check and the write agree.
 */
export function checkSupersedes(db: Database, ids: number[], entityId: number, newId?: number): OldRow[] {
  const get = db.prepare('SELECT id, entity_id, content, source FROM memories WHERE id = ?');
  const rows: OldRow[] = [];
  for (const id of ids) {
    if (newId !== undefined && id === newId) throw new SupersedeRefused(id, `memory #${id} is the memory being written — a memory cannot supersede itself`);
    const row = get.get(id) as OldRow | undefined;
    if (!row) throw new SupersedeRefused(id, `memory #${id} does not exist`);
    if (row.entity_id !== entityId) {
      throw new SupersedeRefused(id, `memory #${id} belongs to another entity (entity_id ${row.entity_id}, this one is ${entityId}) — pass the same entity_name, or remember it under that entity`);
    }
    if (isRawSessionCapture(row)) {
      throw new SupersedeRefused(id, `memory #${id} is a raw capture from a Claude Code session; the next import of that session rewrites it with a new id, so the link would not last. Rewrite it first with remember({ memory_id: ${id}, content: { ..., "distilled": true } }) — distilled rows survive re-import — then supersede it`);
    }
    rows.push(row);
  }
  return rows;
}

/** Raw Stop-hook / batch-import row (source carries a session_id) that has not been distilled. */
function isRawSessionCapture(row: OldRow): boolean {
  if (!row.source) return false;
  let src: any;
  try { src = JSON.parse(row.source); } catch { return false; }
  if (!src || typeof src !== 'object' || typeof src.session_id !== 'string') return false;
  try {
    const c = JSON.parse(row.content);
    if (c && typeof c === 'object' && (c.distilled === true || c.distilled === 1)) return false;
  } catch { /* plain text → not distilled */ }
  return true;
}

/**
 * Write the edges (new → old, relation 'supersedes') and mark each old row superseded.
 * JSON content: state → 'superseded' and superseded_by → newId (same representation the edge
 * detector and distill triage already use). Plain-text content is left as written; the edge
 * alone is what recall folds on.
 */
export function applySupersedes(db: Database, newId: number, rows: OldRow[]): void {
  const edge = db.prepare(`INSERT OR IGNORE INTO memory_edges (from_memory_id, to_memory_id, relation) VALUES (?, ?, 'supersedes')`);
  const mark = db.prepare(
    `UPDATE memories SET content = json_set(content, '$.state', 'superseded', '$.superseded_by', ?)
      WHERE id = ? AND json_valid(content) AND json_type(content) = 'object'`,
  );
  for (const r of rows) {
    edge.run(newId, r.id);
    mark.run(newId, r.id);
  }
}

// ── Attribution ──────────────────────────────────────────────────────────────

const clean = (s: unknown, max: number): string =>
  String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

/** source JSON for a row written through MCP. clientInfo is what the host sent in initialize. */
export function mcpSource(clientInfo: { name?: unknown; version?: unknown } | undefined | null): string {
  const name = clientInfo ? clean(clientInfo.name, 64) : '';
  if (!name) return JSON.stringify({ client: 'unknown', via: 'mcp' });
  const version = clientInfo ? clean(clientInfo.version, 32) : '';
  return JSON.stringify(version ? { client: name, version, via: 'mcp' } : { client: name, via: 'mcp' });
}

/** Short "by" label for recall. Only what the row itself recorded; never inferred. */
export function byFromSource(source: string | null | undefined): string | undefined {
  if (!source) return undefined;
  try {
    const s = JSON.parse(source);
    if (s && typeof s === 'object') {
      if (typeof s.client === 'string' && s.client) return s.client;
      if (typeof s.origin === 'string' && s.origin) return s.origin;
    }
  } catch { /* legacy plain-text source */ }
  return undefined;
}
