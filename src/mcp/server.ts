#!/usr/bin/env node
// linksee-memory MCP server (stdio transport).
// 5 tools: remember / recall / forget / consolidate / read_smart

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { openDb, runMigrations } from '../db/migrate.js';
import { computeHeat } from '../lib/heat-index.js';
import { decideForgetting } from '../lib/forgetting.js';
import { refreshMomentumForEntity } from '../lib/momentum.js';
import { consolidate as runConsolidate } from '../lib/consolidate.js';
import { handleReadSmart as handleReadSmartImpl } from './read-smart.js';

const db = openDb();
runMigrations(db);

const server = new Server(
  { name: 'linksee-memory', version: '0.0.2' },
  { capabilities: { tools: {} } }
);

// ============================================================
// Tool schema declarations
// ============================================================

const TOOLS = [
  {
    name: 'remember',
    description:
      'Store a memory about an entity (person/company/project/concept/file) in one of 6 layers: goal (WHY), context (WHY-THIS-NOW), emotion (USER tone), implementation (HOW — success/failure), caveat (PAIN lesson, never forgotten), learning (GROWTH log). Use this when you discover non-obvious goals, unexpected failures, user preferences, or decisions worth preserving.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_name: { type: 'string', description: 'Name of the entity this memory is about' },
        entity_kind: { type: 'string', enum: ['person', 'company', 'project', 'concept', 'file', 'other'] },
        entity_key: { type: 'string', description: 'Optional canonical key (email, domain, file path)' },
        layer: { type: 'string', enum: ['goal', 'context', 'emotion', 'implementation', 'caveat', 'learning'] },
        content: { type: 'string', description: 'The memory content (plain text or JSON)' },
        importance: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['entity_name', 'entity_kind', 'layer', 'content'],
    },
  },
  {
    name: 'recall',
    description:
      'Retrieve memories relevant to the current context using full-text search (BM25), re-ranked by a composite score of semantic_relevance * heat_score * momentum. Returns only what fits in the token budget. Use at the start of a task to check existing context about the entities involved.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to remember (free-text, entity name, or FTS5 MATCH expression)' },
        entity_name: { type: 'string', description: 'Optional — narrow to a specific entity' },
        layer: {
          type: 'string',
          enum: ['goal', 'context', 'emotion', 'implementation', 'caveat', 'learning'],
        },
        max_tokens: { type: 'number', description: 'Approx token budget. Default 2000.', default: 2000 },
      },
      required: ['query'],
    },
  },
  {
    name: 'forget',
    description:
      'Explicitly delete a memory by id, OR run auto-forgetting across all memories based on forgettingRisk (importance + heat + age). Caveat and goal layer are always preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'number' },
        dry_run: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'consolidate',
    description:
      'Sleep-mode compression. Clusters cold low-importance memories by (entity, layer), summarizes each cluster into a single protected learning-layer entry, deletes originals, and runs a forget-sweep. Run at session end or on demand. Returns a summary of what was compressed.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['all', 'session'], default: 'session' },
        min_age_days: { type: 'number', description: 'Override the default 7-day minimum age for clustering (set to 0 to consolidate everything immediately, useful right after a bulk import).', default: 7 },
      },
    },
  },
  {
    name: 'recall_file',
    description:
      'Get the COMPLETE edit history of a file across all sessions, with per-edit user-intent context. Returns: total edit count, daily breakdown, list of distinct user intents that drove the edits, and the linked memories. Use this when you need to understand WHY a file was modified historically — far more accurate than recall() for file-centric questions because it queries session_file_edits (every physical edit) instead of summary memories.',
    inputSchema: {
      type: 'object',
      properties: {
        path_substring: { type: 'string', description: 'Substring to match against file_path (e.g. "search-services.ts" or full absolute path)' },
        max_intents: { type: 'number', description: 'Max distinct user-intent snippets to return. Default 10.', default: 10 },
      },
      required: ['path_substring'],
    },
  },
  {
    name: 'read_smart',
    description:
      'Read a file with diff-only caching. Returns: (1) full content + chunk metadata on first read, (2) "unchanged" + cached chunk list (~50 tokens) if mtime matches, (3) "unchanged_content" if mtime changed but sha256 matches (touched but not modified), (4) changed chunks with content + unchanged chunks as metadata-only if the file was truly modified. Use INSTEAD of Read for files you have read before — saves 50%+ tokens on re-reads.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
        force: { type: 'boolean', description: 'If true, return full content regardless of cache state', default: false },
      },
      required: ['path'],
    },
  },
];

// ============================================================
// Handlers
// ============================================================

function upsertEntity(args: { name: string; kind: string; key?: string }): number {
  if (args.key) {
    const byKey = db.prepare('SELECT id FROM entities WHERE canonical_key = ?').get(args.key) as { id: number } | undefined;
    if (byKey) return byKey.id;
  }
  const byName = db
    .prepare('SELECT id FROM entities WHERE kind = ? AND LOWER(name) = LOWER(?)')
    .get(args.kind, args.name) as { id: number } | undefined;
  if (byName) {
    if (args.key) {
      db.prepare('UPDATE entities SET canonical_key = ?, updated_at = unixepoch() WHERE id = ? AND canonical_key IS NULL').run(args.key, byName.id);
    }
    return byName.id;
  }
  const result = db
    .prepare('INSERT INTO entities (kind, name, canonical_key) VALUES (?, ?, ?)')
    .run(args.kind, args.name, args.key ?? null);
  return Number(result.lastInsertRowid);
}

function handleRemember(args: any): string {
  const entityId = upsertEntity({ name: args.entity_name, kind: args.entity_kind, key: args.entity_key });
  const importance = args.importance ?? 0.5;

  const result = db
    .prepare('INSERT INTO memories (entity_id, layer, content, importance) VALUES (?, ?, ?, ?)')
    .run(entityId, args.layer, args.content, importance);

  db.prepare('INSERT INTO events (entity_id, kind, payload) VALUES (?, ?, ?)').run(
    entityId,
    'memory_stored',
    JSON.stringify({ layer: args.layer, memory_id: result.lastInsertRowid })
  );

  // Refresh momentum — Day 2 addition. Cheap per-call since it's one entity.
  const mom = refreshMomentumForEntity(db, entityId);

  return JSON.stringify({
    ok: true,
    memory_id: Number(result.lastInsertRowid),
    entity_id: entityId,
    layer: args.layer,
    momentum: { score: mom.score, band: mom.band },
  });
}

// Sanitize query for FTS5 MATCH (strip chars that break the grammar, quote it).
// Note: with trigram tokenizer, tokens shorter than 3 chars cannot match anything.
// Such tokens are dropped here and the caller falls back to LIKE if FTS yields no hits.
function toFtsQuery(raw: string): string {
  const cleaned = raw
    .replace(/["*:()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const tokens = cleaned.split(' ').filter((t) => t.length >= 3);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

function runFtsQuery(query: string, layer: string | undefined, limit: number): any[] {
  let sql = `
    SELECT m.id, m.entity_id, e.name as entity_name, e.kind as entity_kind, e.momentum_score,
           m.layer, m.content, m.importance, m.created_at, m.last_accessed_at, m.access_count,
           bm25(memories_fts) as bm25_score
    FROM memories_fts
    JOIN memories m ON m.id = memories_fts.rowid
    JOIN entities e ON e.id = m.entity_id
    WHERE memories_fts MATCH ?
  `;
  const params: any[] = [query];
  if (layer) { sql += ' AND m.layer = ?'; params.push(layer); }
  sql += ' ORDER BY bm25_score ASC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params) as any[];
}

function runLikeQuery(query: string | undefined, entityName: string | undefined, layer: string | undefined, limit: number): any[] {
  let sql = `
    SELECT m.id, m.entity_id, e.name as entity_name, e.kind as entity_kind, e.momentum_score,
           m.layer, m.content, m.importance, m.created_at, m.last_accessed_at, m.access_count,
           0 as bm25_score
    FROM memories m
    JOIN entities e ON e.id = m.entity_id
    WHERE 1=1
  `;
  const params: any[] = [];
  if (entityName) { sql += ' AND e.name LIKE ?'; params.push(`%${entityName}%`); }
  if (layer) { sql += ' AND m.layer = ?'; params.push(layer); }
  if (query && !entityName) {
    sql += ' AND (e.name LIKE ? OR m.content LIKE ?)';
    params.push(`%${query}%`, `%${query}%`);
  }
  sql += ' ORDER BY m.importance DESC, m.last_accessed_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params) as any[];
}

function handleRecall(args: any): string {
  const maxTokens = args.max_tokens ?? 2000;
  const approxTokensPerMemory = 100;
  const limit = Math.max(1, Math.floor(maxTokens / approxTokensPerMemory));
  const fetchLimit = limit * 2; // extra for composite re-rank

  let rows: any[] = [];
  let searchMethod: 'fts5' | 'like' | 'fts5+like' = 'like';

  const ftsQuery = toFtsQuery(args.query ?? '');
  const canUseFts = !!ftsQuery && !args.entity_name;

  if (canUseFts) {
    // 1st pass: FTS5 over content
    const ftsRows = runFtsQuery(ftsQuery, args.layer, fetchLimit);
    // 2nd pass: entity-name LIKE — catches queries that ARE entity names
    //   (FTS only indexes memory content, not entity names)
    const likeRows = runLikeQuery(args.query, undefined, args.layer, fetchLimit);
    // merge, dedup by memory id (prefer the FTS row for its bm25_score)
    const seen = new Map<number, any>();
    for (const r of ftsRows) seen.set(r.id, r);
    for (const r of likeRows) if (!seen.has(r.id)) seen.set(r.id, r);
    rows = Array.from(seen.values());
    if (ftsRows.length > 0 && likeRows.length > 0) searchMethod = 'fts5+like';
    else if (ftsRows.length > 0) searchMethod = 'fts5';
    else searchMethod = 'like';
  } else {
    rows = runLikeQuery(args.query, args.entity_name, args.layer, fetchLimit);
    searchMethod = 'like';
  }

  const useFts = searchMethod !== 'like';

  const now = Math.floor(Date.now() / 1000);

  // Composite score: 0.5 * relevance + 0.3 * heat + 0.2 * momentum
  // relevance: if FTS used, normalize bm25 (lower = better → invert). Otherwise 0.5 baseline.
  const bm25Values = rows.map((r) => r.bm25_score);
  const minBm = Math.min(...bm25Values, 0);
  const maxBm = Math.max(...bm25Values, 1);
  const bmSpan = Math.max(0.001, maxBm - minBm);

  const scored = rows.map((r) => {
    const daysSince = (now - r.last_accessed_at) / 86400;
    const heat = computeHeat({
      accessesLast30d: daysSince < 30 ? r.access_count : 0,
      accessesLast90d: daysSince < 90 ? r.access_count : 0,
      daysSinceLastAccess: daysSince,
      totalAccesses: r.access_count,
      baseImportance: r.importance,
    });

    // Normalize BM25: lower = more relevant. Map to 0..1 (1 = most relevant).
    const relevance = useFts ? 1 - (r.bm25_score - minBm) / bmSpan : 0.5;
    const heatNorm = heat.score / 100;
    const momNorm = Math.min(1, (r.momentum_score ?? 0) / 10);

    const composite = 0.5 * relevance + 0.3 * heatNorm + 0.2 * momNorm;

    return {
      ...r,
      heat_score: heat.score,
      heat_band: heat.band,
      composite_score: composite,
      relevance_score: relevance,
    };
  });

  scored.sort((a, b) => b.composite_score - a.composite_score);
  const top = scored.slice(0, limit);

  // Mark accessed
  if (top.length > 0) {
    const markAccessed = db.prepare(
      'UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?'
    );
    const tx = db.transaction((ids: number[]) => {
      for (const id of ids) markAccessed.run(now, id);
    });
    tx(top.map((r) => r.id));
  }

  return JSON.stringify({
    ok: true,
    count: top.length,
    search: searchMethod,
    memories: top.map((r) => ({
      id: r.id,
      entity: { name: r.entity_name, kind: r.entity_kind, momentum: r.momentum_score },
      layer: r.layer,
      content: r.content,
      importance: r.importance,
      heat: Number(r.heat_score.toFixed(1)),
      band: r.heat_band,
      composite: Number(r.composite_score.toFixed(3)),
    })),
  });
}

function handleForget(args: any): string {
  if (args.memory_id) {
    const res = db.prepare('DELETE FROM memories WHERE id = ? AND protected = 0').run(args.memory_id);
    return JSON.stringify({ ok: true, deleted: res.changes });
  }

  const rows = db
    .prepare(
      `SELECT id, layer, importance, access_count, last_accessed_at, protected FROM memories WHERE protected = 0`
    )
    .all() as any[];

  const now = Math.floor(Date.now() / 1000);
  const actions: { id: number; action: string }[] = [];

  for (const r of rows) {
    const daysSince = (now - r.last_accessed_at) / 86400;
    const heat = computeHeat({
      accessesLast30d: daysSince < 30 ? r.access_count : 0,
      accessesLast90d: daysSince < 90 ? r.access_count : 0,
      daysSinceLastAccess: daysSince,
      totalAccesses: r.access_count,
      baseImportance: r.importance,
    });
    const action = decideForgetting({
      daysSinceLastAccess: daysSince,
      importance: r.importance,
      heatScore: heat.score,
      protected: r.protected === 1,
      layer: r.layer,
    });
    if (action !== 'keep') actions.push({ id: r.id, action });
  }

  if (!args.dry_run) {
    const del = db.prepare('DELETE FROM memories WHERE id = ?');
    const tx = db.transaction((items: typeof actions) => {
      for (const a of items) if (a.action === 'drop') del.run(a.id);
    });
    tx(actions);
  }

  return JSON.stringify({
    ok: true,
    dry_run: !!args.dry_run,
    scanned: rows.length,
    to_drop: actions.filter((a) => a.action === 'drop').length,
    to_compress: actions.filter((a) => a.action === 'compress').length,
  });
}

function handleConsolidate(args: any): string {
  const result = runConsolidate(db, {
    scope: args?.scope ?? 'session',
    min_age_days: typeof args?.min_age_days === 'number' ? args.min_age_days : undefined,
  });
  return JSON.stringify({ ok: true, ...result });
}

function handleRecallFile(args: any): string {
  const sub = String(args.path_substring ?? '').trim();
  if (!sub) return JSON.stringify({ ok: false, error: 'path_substring required' });
  const maxIntents = Math.max(1, Math.min(50, args.max_intents ?? 10));

  const totalRow = db.prepare(`SELECT COUNT(*) as c, MIN(occurred_at) as first_at, MAX(occurred_at) as last_at, COUNT(DISTINCT session_id) as sessions FROM session_file_edits WHERE file_path LIKE ?`).get(`%${sub}%`) as any;
  if (!totalRow || totalRow.c === 0) {
    return JSON.stringify({ ok: true, count: 0, note: 'No edits found for that path substring.' });
  }

  // Daily breakdown
  const daily = db.prepare(`
    SELECT DATE(occurred_at, 'unixepoch') as day, operation, COUNT(*) as edits
    FROM session_file_edits WHERE file_path LIKE ?
    GROUP BY day, operation ORDER BY day
  `).all(`%${sub}%`) as any[];

  // Distinct context_snippets (intents) — deduped, ordered by recency
  const intents = db.prepare(`
    SELECT DISTINCT context_snippet, MAX(occurred_at) as last_at, COUNT(*) as freq
    FROM session_file_edits
    WHERE file_path LIKE ? AND context_snippet IS NOT NULL AND LENGTH(context_snippet) > 20
    GROUP BY context_snippet
    ORDER BY last_at DESC
    LIMIT ?
  `).all(`%${sub}%`, maxIntents) as any[];

  // Linked memories
  const memories = db.prepare(`
    SELECT DISTINCT m.id, m.layer, m.content, m.importance, e.name as entity_name
    FROM session_file_edits sfe
    JOIN memories m ON m.id = sfe.memory_id
    JOIN entities e ON e.id = m.entity_id
    WHERE sfe.file_path LIKE ?
    ORDER BY m.importance DESC
    LIMIT 20
  `).all(`%${sub}%`) as any[];

  // Distinct file paths matched (the substring may match multiple files)
  const paths = db.prepare(`SELECT file_path, COUNT(*) as edits FROM session_file_edits WHERE file_path LIKE ? GROUP BY file_path ORDER BY edits DESC`).all(`%${sub}%`) as any[];

  return JSON.stringify({
    ok: true,
    path_substring: sub,
    paths_matched: paths,
    summary: {
      total_edits: totalRow.c,
      first_edit_at: new Date(totalRow.first_at * 1000).toISOString(),
      last_edit_at: new Date(totalRow.last_at * 1000).toISOString(),
      sessions_involved: totalRow.sessions,
    },
    daily_breakdown: daily,
    user_intents: intents.map((i) => ({
      when: new Date(i.last_at * 1000).toISOString(),
      occurrences: i.freq,
      intent: i.context_snippet,
    })),
    linked_memories: memories.map((m) => ({
      id: m.id,
      entity: m.entity_name,
      layer: m.layer,
      importance: m.importance,
      preview: m.content.length > 300 ? m.content.slice(0, 300) + '...' : m.content,
    })),
  });
}

function handleReadSmart(args: any): string {
  return handleReadSmartImpl(db, { path: args.path, force: args.force });
}

// ============================================================
// MCP wiring
// ============================================================

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let text: string;
    switch (name) {
      case 'remember': text = handleRemember(args); break;
      case 'recall': text = handleRecall(args); break;
      case 'forget': text = handleForget(args); break;
      case 'consolidate': text = handleConsolidate(args); break;
      case 'recall_file': text = handleRecallFile(args); break;
      case 'read_smart': text = handleReadSmart(args); break;
      default: throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text }] };
  } catch (err: any) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err?.message ?? String(err) }) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[linksee-memory] MCP server ready on stdio (v0.0.2)\n');
