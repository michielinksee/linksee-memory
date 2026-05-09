// Resources block — expose memories as URI-addressable resources.
//
// Static resources (always present):
//   memory://stats       — DB statistics summary
//   memory://hot         — currently hot memories (top heat band)
//   memory://recent      — recently accessed memories (last 7 days)
//   memory://caveats     — all caveat-layer memories (the never-forget pile)
//
// Resource templates (parameterized):
//   memory://entity/{name}  — all memories for an entity
//   memory://layer/{layer}  — all memories in a layer (goal/context/emotion/implementation/caveat/learning)
//   memory://memory/{id}    — single memory by ID

import type Database from 'better-sqlite3';

export const STATIC_RESOURCES = [
  {
    uri: 'memory://stats',
    name: 'Memory store statistics',
    description: 'Summary counts: entities, memories, layer breakdown, heat distribution.',
    mimeType: 'application/json',
  },
  {
    uri: 'memory://hot',
    name: 'Hot memories',
    description: 'Memories currently in the "hot" heat band — what the agent is actively working with.',
    mimeType: 'application/json',
  },
  {
    uri: 'memory://recent',
    name: 'Recently accessed memories',
    description: 'Memories accessed in the last 7 days, ordered by recency.',
    mimeType: 'application/json',
  },
  {
    uri: 'memory://caveats',
    name: 'All caveats',
    description: 'Every caveat-layer memory — the protected "never forget" pile of pain lessons.',
    mimeType: 'application/json',
  },
];

export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'memory://entity/{name}',
    name: 'Memories for an entity',
    description: 'All memories about a specific entity (person/company/project/concept/file). Replace {name} with the entity name.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'memory://layer/{layer}',
    name: 'Memories in a layer',
    description: 'All memories in a specific layer. Replace {layer} with one of: goal, context, emotion, implementation, caveat, learning.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'memory://memory/{id}',
    name: 'A single memory',
    description: 'Read a single memory by its numeric id. Replace {id} with the memory_id.',
    mimeType: 'application/json',
  },
];

const VALID_LAYERS = new Set(['goal', 'context', 'emotion', 'implementation', 'caveat', 'learning']);

function fmtMemory(row: any): any {
  return {
    id: row.id,
    entity: row.entity_name,
    entity_kind: row.entity_kind,
    layer: row.layer,
    importance: row.importance,
    pinned: row.protected === 1 || row.importance >= 0.9,
    content: row.content,
    created_at: row.created_at ? new Date(row.created_at * 1000).toISOString() : null,
    last_accessed_at: row.last_accessed_at ? new Date(row.last_accessed_at * 1000).toISOString() : null,
    access_count: row.access_count,
  };
}

const SELECT_MEMORY_BASE = `
  SELECT m.id, m.layer, m.content, m.importance, m.protected, m.created_at, m.last_accessed_at, m.access_count,
         e.name as entity_name, e.kind as entity_kind
  FROM memories m JOIN entities e ON e.id = m.entity_id
`;

export function readResource(db: Database.Database, uri: string, userId = 'default'): { uri: string; mimeType: string; text: string } {
  // Static endpoints
  if (uri === 'memory://stats') {
    const entityCount = (db.prepare('SELECT COUNT(*) as c FROM entities WHERE user_id = ?').get(userId) as any).c;
    const memCount = (db.prepare('SELECT COUNT(*) as c FROM memories WHERE user_id = ?').get(userId) as any).c;
    const byLayer = db.prepare('SELECT layer, COUNT(*) as c FROM memories WHERE user_id = ? GROUP BY layer').all(userId) as any[];
    const byKind = db.prepare('SELECT kind, COUNT(*) as c FROM entities WHERE user_id = ? GROUP BY kind').all(userId) as any[];
    const pinned = (db.prepare('SELECT COUNT(*) as c FROM memories WHERE user_id = ? AND (importance >= 0.9 OR protected = 1)').get(userId) as any).c;
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify(
        {
          entity_count: entityCount,
          memory_count: memCount,
          pinned_count: pinned,
          by_layer: Object.fromEntries(byLayer.map((r) => [r.layer, r.c])),
          by_entity_kind: Object.fromEntries(byKind.map((r) => [r.kind, r.c])),
          // Note: heat_band is computed at recall-time, not stored — see recall tool for live heat.
        },
        null,
        2
      ),
    };
  }
  if (uri === 'memory://hot') {
    // heat_band is dynamic; approximate "hot" via access_count + recent access desc.
    // For exact heat scoring, use the recall tool with band='hot'.
    const rows = db
      .prepare(
        `${SELECT_MEMORY_BASE}
         WHERE m.last_accessed_at IS NOT NULL AND m.user_id = ?
         ORDER BY m.access_count DESC, m.last_accessed_at DESC
         LIMIT 50`
      )
      .all(userId) as any[];
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify(
        { count: rows.length, note: 'Approximation by access_count + last_accessed_at. Use the recall tool with band="hot" for exact heat scoring.', memories: rows.map(fmtMemory) },
        null,
        2
      ),
    };
  }
  if (uri === 'memory://recent') {
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
    const rows = db.prepare(`${SELECT_MEMORY_BASE} WHERE m.last_accessed_at >= ? AND m.user_id = ? ORDER BY m.last_accessed_at DESC LIMIT 50`).all(cutoff, userId) as any[];
    return { uri, mimeType: 'application/json', text: JSON.stringify({ count: rows.length, memories: rows.map(fmtMemory) }, null, 2) };
  }
  if (uri === 'memory://caveats') {
    const rows = db.prepare(`${SELECT_MEMORY_BASE} WHERE m.layer = 'caveat' AND m.user_id = ? ORDER BY m.importance DESC, m.created_at DESC`).all(userId) as any[];
    return { uri, mimeType: 'application/json', text: JSON.stringify({ count: rows.length, memories: rows.map(fmtMemory) }, null, 2) };
  }

  // Templates
  const entityMatch = uri.match(/^memory:\/\/entity\/(.+)$/);
  if (entityMatch) {
    const name = decodeURIComponent(entityMatch[1]);
    const rows = db
      .prepare(`${SELECT_MEMORY_BASE} WHERE LOWER(e.name) = LOWER(?) AND m.user_id = ? ORDER BY m.importance DESC, m.created_at DESC`)
      .all(name, userId) as any[];
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({ entity: name, count: rows.length, memories: rows.map(fmtMemory) }, null, 2),
    };
  }
  const layerMatch = uri.match(/^memory:\/\/layer\/(.+)$/);
  if (layerMatch) {
    const layer = decodeURIComponent(layerMatch[1]).toLowerCase();
    if (!VALID_LAYERS.has(layer)) {
      throw new Error(`unknown layer "${layer}". Known: goal, context, emotion, implementation, caveat, learning`);
    }
    const rows = db
      .prepare(`${SELECT_MEMORY_BASE} WHERE m.layer = ? AND m.user_id = ? ORDER BY m.importance DESC, m.created_at DESC LIMIT 200`)
      .all(layer, userId) as any[];
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({ layer, count: rows.length, memories: rows.map(fmtMemory) }, null, 2),
    };
  }
  const idMatch = uri.match(/^memory:\/\/memory\/(\d+)$/);
  if (idMatch) {
    const id = Number(idMatch[1]);
    const row = db.prepare(`${SELECT_MEMORY_BASE} WHERE m.id = ? AND m.user_id = ?`).get(id, userId) as any;
    if (!row) throw new Error(`memory id ${id} not found`);
    return { uri, mimeType: 'application/json', text: JSON.stringify(fmtMemory(row), null, 2) };
  }

  throw new Error(`unknown resource URI: ${uri}`);
}
