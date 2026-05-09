// Factory: createLinkseeServer(db) → MCP Server instance (not yet connected to any transport).
// Used by both the stdio entry point (server.ts) and the HTTP entry point (http-server.ts).
// Each call creates an independent Server with its own roots cache, so HTTP sessions
// don't share per-client state while still sharing the single SQLite db.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type Database from 'better-sqlite3';
import { computeHeat } from '../lib/heat-index.js';
import { decideForgetting } from '../lib/forgetting.js';
import { refreshMomentumForEntity } from '../lib/momentum.js';
import { consolidate as runConsolidate } from '../lib/consolidate.js';
import { isPastedExternalContent } from '../lib/session-parser.js';
import { handleReadSmart as handleReadSmartImpl } from './read-smart.js';
import { STATIC_RESOURCES, RESOURCE_TEMPLATES, readResource } from './resources.js';
import { PROMPTS, getPrompt } from './prompts.js';
import { makeRootsCache, fetchRoots, isInsideRoots } from './roots.js';
import { sampleConsolidation } from './sampling.js';
import { confirmForget } from './elicitation.js';

const SERVER_VERSION = '0.3.0';

const LAYER_ALIASES: Record<string, string> = {
  goal: 'goal', context: 'context', emotion: 'emotion',
  implementation: 'implementation', caveat: 'caveat', learning: 'learning',
  why: 'goal', goals: 'goal', target: 'goal', targets: 'goal', intent: 'goal',
  background: 'context', reason: 'context', situation: 'context', timing: 'context',
  tone: 'emotion', feelings: 'emotion', mood: 'emotion',
  impl: 'implementation', success: 'implementation', failure: 'implementation',
  how: 'implementation', tried: 'implementation', attempts: 'implementation',
  warning: 'caveat', warnings: 'caveat', pain: 'caveat', rule: 'caveat',
  rules: 'caveat', pitfall: 'caveat', pitfalls: 'caveat', dont: 'caveat',
  decision: 'learning', decisions: 'learning', learned: 'learning',
  insight: 'learning', insights: 'learning', growth: 'learning',
};

function resolveLayer(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const k = String(input).toLowerCase().trim();
  return LAYER_ALIASES[k] ?? k;
}

const LAYER_ENUM = ['goal', 'context', 'emotion', 'implementation', 'caveat', 'learning'] as const;

const TOOLS = [
  {
    name: 'remember',
    description:
      'Store a memory about an entity (person/company/project/concept/file) in one of 6 layers: goal (WHY), context (WHY-THIS-NOW), emotion (USER tone), implementation (HOW — success/failure), caveat (PAIN lesson, never forgotten), learning (GROWTH log). Use this when you discover non-obvious goals, unexpected failures, user preferences, or decisions worth preserving. Pasted assistant output or CI logs are rejected (use force=true only if you are sure).',
    inputSchema: {
      type: 'object',
      properties: {
        entity_name: { type: 'string', description: 'Name of the entity this memory is about' },
        entity_kind: { type: 'string', enum: ['person', 'company', 'project', 'concept', 'file', 'other'] },
        entity_key: { type: 'string', description: 'Optional canonical key (email, domain, file path)' },
        layer: { type: 'string', description: 'One of: goal / context / emotion / implementation / caveat / learning. Common aliases (why, decisions, warnings, how, ...) are accepted.' },
        content: { type: 'string', description: 'The memory content (plain text or JSON)' },
        importance: { type: 'number', minimum: 0, maximum: 1, description: '0.0-1.0. Set to 0.9 or higher to "pin" a memory (protects from forgetting even outside caveat layer).' },
        force: { type: 'boolean', default: false, description: 'Bypass the paste-back/CI-log quality check. Only set when you are sure the content is original user or agent thought.' },
      },
      required: ['entity_name', 'entity_kind', 'layer', 'content'],
    },
  },
  {
    name: 'recall',
    description:
      'Retrieve memories relevant to the current context using full-text search (BM25) + entity-name match, re-ranked by a composite score (relevance × heat × momentum × importance). Returns only what fits in the token budget, with match_reasons explaining WHY each memory was returned. Opportunistically refreshes stale momentum scores for entities in the result set. Supports pagination via offset/has_more. Layer aliases accepted. Use at the start of any task that might involve prior work.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to remember (free-text, entity name, or FTS5 MATCH expression)' },
        entity_name: { type: 'string', description: 'Optional — narrow to a specific entity' },
        layer: { type: 'string', description: 'Optional layer filter. Accepts aliases (decisions/warnings/how/etc.) as well as canonical names.' },
        band: { type: 'string', enum: ['hot', 'warm', 'cold', 'frozen'], description: 'Optional — only return memories whose heat_band matches.' },
        max_tokens: { type: 'number', description: 'Approx token budget. Default 2000. Either max_tokens or limit stops iteration (whichever fires first).', default: 2000 },
        limit: { type: 'number', description: 'Optional hard cap on number of memories. Stops at min(max_tokens-budget, limit).' },
        offset: { type: 'number', description: 'Skip this many top results (pagination). Use has_more from prior response to decide next offset.', default: 0 },
        mark_accessed: { type: 'boolean', default: true, description: 'Set false for preview / listing queries that should not bump heat.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'update_memory',
    description:
      'Atomically edit an existing memory in-place. Preferred over forget+remember because it preserves memory_id, which matters for session_file_edits links and referential integrity. Use to correct facts, update deadlines in goal entries, refine caveats, or re-score importance. Caveat-layer memories can be updated but cannot have their protected flag removed.',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'number', description: 'The memory.id to update' },
        content: { type: 'string', description: 'New content (plain text or JSON). If omitted, content is kept.' },
        layer: { type: 'string', description: 'Move to a different layer (aliases accepted). If omitted, layer is kept.' },
        importance: { type: 'number', minimum: 0, maximum: 1, description: 'New importance 0-1. Set to 0.9 or higher to pin.' },
      },
      required: ['memory_id'],
    },
  },
  {
    name: 'list_entities',
    description:
      'List the entities currently known to this memory store, sorted by recent activity. Use at the start of a new session ("what do I know about?") before issuing specific recall queries. Cheaper than recall for the "give me an overview" question.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['person', 'company', 'project', 'concept', 'file', 'other'], description: 'Filter by entity kind.' },
        min_memories: { type: 'number', description: 'Only include entities with at least N memories. Default 1.', default: 1 },
        limit: { type: 'number', description: 'Max entities to return. Default 30.', default: 30 },
        offset: { type: 'number', default: 0 },
      },
    },
  },
  {
    name: 'forget',
    description:
      'Explicitly delete a memory by id, OR run auto-forgetting across all memories based on forgettingRisk (importance + heat + age). Caveat-layer, goal-layer, and pinned (importance>=0.9) memories are always preserved. Prefer update_memory for corrections — forget is destructive.',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'number' },
        dry_run: { type: 'boolean', default: false, description: 'Report what would be deleted without actually deleting.' },
      },
    },
  },
  {
    name: 'consolidate',
    description:
      'Sleep-mode compression. Clusters cold low-importance memories by (entity, layer), summarizes each cluster into a single protected learning-layer entry, deletes originals, and runs a forget-sweep. Run at session end or on demand. Set dry_run=true to preview without writing.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['all', 'session'], default: 'session' },
        min_age_days: { type: 'number', description: 'Override the default 7-day minimum age for clustering (set to 0 to consolidate everything immediately, useful right after a bulk import).', default: 7 },
        dry_run: { type: 'boolean', default: false, description: 'Preview what would be compressed without modifying the DB.' },
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

export function createLinkseeServer(db: Database.Database, userId: string = 'default'): Server {
  const server = new Server(
    { name: 'linksee-memory', version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
      },
    }
  );

  // Per-server roots cache: HTTP sessions each get their own Server instance,
  // so this cache is naturally per-client rather than shared across sessions.
  const rootsCache = makeRootsCache();

  // ──────────────────────────────────────────────────────────────
  // Handlers
  // ──────────────────────────────────────────────────────────────

  function upsertEntity(args: { name: string; kind: string; key?: string }): number {
    if (args.key) {
      const byKey = db.prepare('SELECT id FROM entities WHERE canonical_key = ? AND user_id = ?').get(args.key, userId) as { id: number } | undefined;
      if (byKey) return byKey.id;
    }
    const byName = db
      .prepare('SELECT id FROM entities WHERE kind = ? AND LOWER(name) = LOWER(?) AND user_id = ?')
      .get(args.kind, args.name, userId) as { id: number } | undefined;
    if (byName) {
      if (args.key) {
        db.prepare('UPDATE entities SET canonical_key = ?, updated_at = unixepoch() WHERE id = ? AND canonical_key IS NULL').run(args.key, byName.id);
      }
      return byName.id;
    }
    const result = db
      .prepare('INSERT INTO entities (kind, name, canonical_key, user_id) VALUES (?, ?, ?, ?)')
      .run(args.kind, args.name, args.key ?? null, userId);
    return Number(result.lastInsertRowid);
  }

  function handleRemember(args: any): string {
    const layer = resolveLayer(args.layer);
    if (!layer || !(LAYER_ENUM as readonly string[]).includes(layer)) {
      return JSON.stringify({
        ok: false,
        error: `unknown layer "${args.layer}". Known: ${LAYER_ENUM.join(', ')} (aliases: decisions, warnings, how, why, ...)`,
      });
    }
    const rawContent = String(args.content ?? '');
    if (!args.force && isPastedExternalContent(rawContent)) {
      return JSON.stringify({
        ok: false,
        rejected: 'quality_check',
        reason: 'Content looks like pasted assistant output, CI log, or external paste. Pass force:true if this really is original thought worth keeping.',
        hint: 'If you meant to save an extracted insight from that paste, summarize it in your own words first.',
      });
    }
    const entityId = upsertEntity({ name: args.entity_name, kind: args.entity_kind, key: args.entity_key });
    const importance = Math.min(1, Math.max(0, Number(args.importance ?? 0.5)));
    const result = db
      .prepare('INSERT INTO memories (entity_id, layer, content, importance, protected, user_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(entityId, layer, rawContent, importance, importance >= 0.9 ? 1 : 0, userId);
    db.prepare('INSERT INTO events (entity_id, kind, payload, user_id) VALUES (?, ?, ?, ?)').run(
      entityId,
      'memory_stored',
      JSON.stringify({ layer, memory_id: result.lastInsertRowid }),
      userId
    );
    const mom = refreshMomentumForEntity(db, entityId);
    return JSON.stringify({
      ok: true,
      memory_id: Number(result.lastInsertRowid),
      entity_id: entityId,
      layer,
      pinned: importance >= 0.9,
      momentum: { score: mom.score, band: mom.band },
    });
  }

  function toFtsQuery(raw: string): string {
    const cleaned = raw.replace(/["*:()]/g, ' ').replace(/\s+/g, ' ').trim();
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
      WHERE memories_fts MATCH ? AND m.user_id = ?
    `;
    const params: any[] = [query, userId];
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
      WHERE m.user_id = ?
    `;
    const params: any[] = [userId];
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

  const MOMENTUM_STALE_SECS = 3600;
  function refreshStaleMomentum(entityIds: number[]): void {
    if (entityIds.length === 0) return;
    const unique = Array.from(new Set(entityIds));
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - MOMENTUM_STALE_SECS;
    const placeholders = unique.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id FROM entities WHERE id IN (${placeholders}) AND (momentum_at IS NULL OR momentum_at < ?)`)
      .all(...unique, cutoff) as Array<{ id: number }>;
    for (const r of rows) {
      try { refreshMomentumForEntity(db, r.id); } catch { /* non-fatal */ }
    }
  }

  function handleRecall(args: any): string {
    const maxTokens = Math.max(100, Number(args.max_tokens ?? 2000));
    const approxTokensPerMemory = 100;
    const tokenBudgetLimit = Math.max(1, Math.floor(maxTokens / approxTokensPerMemory));
    const hardLimit = Number.isFinite(args.limit) ? Math.max(1, Math.min(200, args.limit)) : tokenBudgetLimit;
    const returnLimit = Math.min(tokenBudgetLimit, hardLimit);
    const offset = Math.max(0, Number(args.offset ?? 0));
    const markAccessed = args.mark_accessed !== false;
    const layer = resolveLayer(args.layer);
    const band = args.band as string | undefined;
    const fetchLimit = Math.max(returnLimit * 3, 30) + offset;

    let rows: any[] = [];
    let searchMethod: 'fts5' | 'like' | 'fts5+like' = 'like';
    const ftsQuery = toFtsQuery(args.query ?? '');
    const canUseFts = !!ftsQuery && !args.entity_name;

    if (canUseFts) {
      const ftsRows = runFtsQuery(ftsQuery, layer, fetchLimit);
      const likeRows = runLikeQuery(args.query, undefined, layer, fetchLimit);
      const seen = new Map<number, any>();
      for (const r of ftsRows) seen.set(r.id, { ...r, _via: 'fts' });
      for (const r of likeRows) {
        if (seen.has(r.id)) { seen.get(r.id)._via = 'fts+like'; }
        else { seen.set(r.id, { ...r, _via: 'like' }); }
      }
      rows = Array.from(seen.values());
      if (ftsRows.length > 0 && likeRows.length > 0) searchMethod = 'fts5+like';
      else if (ftsRows.length > 0) searchMethod = 'fts5';
      else searchMethod = 'like';
    } else {
      rows = runLikeQuery(args.query, args.entity_name, layer, fetchLimit).map((r) => ({ ...r, _via: 'like' }));
      searchMethod = 'like';
    }

    const useFts = searchMethod !== 'like';
    const now = Math.floor(Date.now() / 1000);

    refreshStaleMomentum(rows.map((r) => r.entity_id));
    if (rows.length > 0) {
      const ids = Array.from(new Set(rows.map((r) => r.entity_id)));
      const ph = ids.map(() => '?').join(',');
      const fresh = db.prepare(`SELECT id, momentum_score FROM entities WHERE id IN (${ph})`).all(...ids) as any[];
      const byId = new Map(fresh.map((f) => [f.id, f.momentum_score]));
      for (const r of rows) r.momentum_score = byId.get(r.entity_id) ?? r.momentum_score;
    }

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
      const relevance = useFts && r._via !== 'like' ? 1 - (r.bm25_score - minBm) / bmSpan : 0.5;
      const heatNorm = heat.score / 100;
      const momNorm = Math.min(1, (r.momentum_score ?? 0) / 10);
      const importanceBoost = r.importance;
      const w_rel = 0.45, w_heat = 0.25, w_mom = 0.15, w_imp = 0.15;
      const composite = w_rel * relevance + w_heat * heatNorm + w_mom * momNorm + w_imp * importanceBoost;
      const reasons: string[] = [];
      if (r._via === 'fts' || r._via === 'fts+like') reasons.push(`content_match_${r._via === 'fts+like' ? 'dual' : 'fts'}`);
      if (r._via === 'like' || r._via === 'fts+like') {
        if (args.entity_name || (args.query && String(r.entity_name || '').toLowerCase().includes(String(args.query).toLowerCase()))) {
          reasons.push('entity_name_match');
        } else {
          reasons.push('content_substring');
        }
      }
      if (heat.band === 'hot') reasons.push('heat:hot');
      else if (heat.band === 'warm') reasons.push('heat:warm');
      if (r.momentum_score >= 5) reasons.push('entity_active');
      if (r.importance >= 0.9) reasons.push('pinned');
      else if (r.importance >= 0.8) reasons.push('high_importance');
      if (r.protected === 1 && r.layer === 'caveat') reasons.push('caveat_protected');
      return {
        ...r, heat_score: heat.score, heat_band: heat.band, composite_score: composite,
        relevance_score: relevance, _reasons: reasons,
        _breakdown: {
          relevance: Number(relevance.toFixed(3)),
          heat: Number(heatNorm.toFixed(3)),
          momentum: Number(momNorm.toFixed(3)),
          importance: Number(importanceBoost.toFixed(3)),
        },
      };
    });

    const filtered = band ? scored.filter((s) => s.heat_band === band) : scored;
    filtered.sort((a, b) => b.composite_score - a.composite_score);
    const total = filtered.length;
    const windowed = filtered.slice(offset, offset + returnLimit);
    const hasMore = total > offset + windowed.length;

    if (markAccessed && windowed.length > 0) {
      const mark = db.prepare('UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?');
      const tx = db.transaction((ids: number[]) => { for (const id of ids) mark.run(now, id); });
      tx(windowed.map((r) => r.id));
    }

    let stoppedBy: 'tokens' | 'limit' | 'end' = 'end';
    if (windowed.length === returnLimit && total > offset + returnLimit) {
      stoppedBy = hardLimit <= tokenBudgetLimit ? 'limit' : 'tokens';
    }

    return JSON.stringify({
      ok: true,
      count: windowed.length,
      total_candidates: total,
      offset,
      has_more: hasMore,
      stopped_by: stoppedBy,
      search: searchMethod,
      resolved_layer: layer ?? null,
      memories: windowed.map((r) => {
        let parsedContent: unknown = r.content;
        try { parsedContent = JSON.parse(r.content); } catch { /* leave as string */ }
        return {
          id: r.id,
          entity: { id: r.entity_id, name: r.entity_name, kind: r.entity_kind, momentum: Number((r.momentum_score ?? 0).toFixed(2)) },
          layer: r.layer,
          content: parsedContent,
          content_raw: r.content,
          importance: r.importance,
          pinned: r.importance >= 0.9,
          heat: Number(r.heat_score.toFixed(1)),
          band: r.heat_band,
          composite: Number(r.composite_score.toFixed(3)),
          match_reasons: r._reasons,
          score_breakdown: r._breakdown,
        };
      }),
    });
  }

  function handleForget(args: any): string {
    if (args.memory_id) {
      const target = db.prepare('SELECT id, layer, importance, protected FROM memories WHERE id = ? AND user_id = ?').get(args.memory_id, userId) as any;
      if (!target) return JSON.stringify({ ok: false, error: `memory_id ${args.memory_id} not found` });
      if (target.protected === 1 || target.importance >= 0.9) {
        const isLayerProtected = target.protected === 1;
        return JSON.stringify({
          ok: false,
          preserved: true,
          reason: isLayerProtected ? `${target.layer}-layer is auto-protected` : 'pinned (importance>=0.9)',
          hint: isLayerProtected
            ? `${target.layer} memories are permanently protected. If you truly need to delete, copy its content to another layer via remember() first, then drop the DB row manually via a SQLite client.`
            : 'Use update_memory to lower importance below 0.9 first, then forget.',
        });
      }
      const res = db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(args.memory_id, userId);
      return JSON.stringify({ ok: true, deleted: res.changes, memory_id: args.memory_id });
    }

    const rows = db
      .prepare(`SELECT id, layer, importance, access_count, last_accessed_at, protected FROM memories WHERE protected = 0 AND importance < 0.9 AND user_id = ?`)
      .all(userId) as any[];
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
    const toDropIds = actions.filter((a) => a.action === 'drop').map((a) => a.id);
    if (!args.dry_run) {
      const del = db.prepare('DELETE FROM memories WHERE id = ?');
      const tx = db.transaction((ids: number[]) => { for (const id of ids) del.run(id); });
      tx(toDropIds);
    }
    return JSON.stringify({
      ok: true,
      dry_run: !!args.dry_run,
      scanned: rows.length,
      to_drop: toDropIds.length,
      to_compress: actions.filter((a) => a.action === 'compress').length,
      sample_ids_to_drop: toDropIds.slice(0, 10),
    });
  }

  function handleConsolidate(args: any): string {
    const dryRun = !!args?.dry_run;
    if (dryRun) {
      const now = Math.floor(Date.now() / 1000);
      const ageCutoff = now - (args.min_age_days ?? 7) * 86400;
      const candidates = db.prepare(`
        SELECT m.entity_id, e.name as entity_name, m.layer, COUNT(*) as c
        FROM memories m JOIN entities e ON e.id = m.entity_id
        WHERE m.protected = 0 AND m.importance < 0.9
          AND m.layer IN ('context', 'emotion', 'implementation')
          AND m.created_at <= ? AND m.user_id = ?
        GROUP BY m.entity_id, m.layer HAVING c >= 2 ORDER BY c DESC
      `).all(ageCutoff, userId) as any[];
      const totalReplaced = candidates.reduce((s, c) => s + c.c, 0);
      return JSON.stringify({
        ok: true,
        dry_run: true,
        clusters: candidates.length,
        memories_replaced_if_run: totalReplaced,
        preview: candidates.slice(0, 20).map((c) => ({ entity: c.entity_name, layer: c.layer, count: c.c })),
        hint: 'Set dry_run=false to actually consolidate.',
      });
    }
    const result = runConsolidate(db, {
      scope: args?.scope ?? 'session',
      min_age_days: typeof args?.min_age_days === 'number' ? args.min_age_days : undefined,
    }, userId);
    return JSON.stringify({ ok: true, ...result });
  }

  function handleUpdateMemory(args: any): string {
    const memoryId = Number(args.memory_id);
    if (!Number.isFinite(memoryId)) return JSON.stringify({ ok: false, error: 'memory_id (number) required' });
    const existing = db.prepare('SELECT id, entity_id, layer, content, importance, protected FROM memories WHERE id = ? AND user_id = ?').get(memoryId, userId) as any;
    if (!existing) return JSON.stringify({ ok: false, error: `memory_id ${memoryId} not found` });
    const patch: Record<string, any> = {};
    if (typeof args.content === 'string') patch.content = args.content;
    if (typeof args.layer === 'string') {
      const resolved = resolveLayer(args.layer);
      if (!resolved || !(LAYER_ENUM as readonly string[]).includes(resolved)) {
        return JSON.stringify({ ok: false, error: `unknown layer "${args.layer}"` });
      }
      if (existing.layer === 'caveat' && resolved !== 'caveat' && existing.protected === 1) {
        return JSON.stringify({ ok: false, error: 'Cannot move a protected caveat memory to another layer. Create a new memory in the target layer instead.' });
      }
      patch.layer = resolved;
    }
    if (args.importance !== undefined) {
      const imp = Math.min(1, Math.max(0, Number(args.importance)));
      patch.importance = imp;
      patch.protected = imp >= 0.9 || existing.protected === 1 ? 1 : 0;
    }
    const keys = Object.keys(patch);
    if (keys.length === 0) return JSON.stringify({ ok: false, error: 'no fields to update (provide content, layer, or importance)' });
    const setClause = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => patch[k]);
    db.prepare(`UPDATE memories SET ${setClause} WHERE id = ? AND user_id = ?`).run(...values, memoryId, userId);
    db.prepare('INSERT INTO events (entity_id, kind, payload, user_id) VALUES (?, ?, ?, ?)').run(
      existing.entity_id, 'memory_updated', JSON.stringify({ memory_id: memoryId, changed: keys }), userId
    );
    return JSON.stringify({ ok: true, memory_id: memoryId, updated_fields: keys, pinned: (patch.importance ?? existing.importance) >= 0.9 });
  }

  function handleListEntities(args: any): string {
    const kind = args?.kind as string | undefined;
    const minMemories = Math.max(1, Number(args?.min_memories ?? 1));
    const limit = Math.max(1, Math.min(200, Number(args?.limit ?? 30)));
    const offset = Math.max(0, Number(args?.offset ?? 0));
    let sql = `
      SELECT e.id, e.name, e.kind, e.canonical_key, e.momentum_score,
             e.updated_at, e.created_at,
             COUNT(m.id) as memory_count,
             MAX(m.last_accessed_at) as last_memory_access,
             SUM(CASE WHEN m.layer = 'goal' THEN 1 ELSE 0 END) as goal_count,
             SUM(CASE WHEN m.layer = 'caveat' THEN 1 ELSE 0 END) as caveat_count,
             SUM(CASE WHEN m.layer = 'learning' THEN 1 ELSE 0 END) as learning_count,
             SUM(CASE WHEN m.layer = 'implementation' THEN 1 ELSE 0 END) as impl_count,
             SUM(CASE WHEN m.importance >= 0.9 THEN 1 ELSE 0 END) as pinned_count
      FROM entities e LEFT JOIN memories m ON m.entity_id = e.id AND m.user_id = ? WHERE e.user_id = ?
    `;
    const params: any[] = [userId, userId];
    if (kind) { sql += ' AND e.kind = ?'; params.push(kind); }
    sql += ' GROUP BY e.id';
    if (minMemories > 1) { sql += ' HAVING memory_count >= ?'; params.push(minMemories); }
    sql += ' ORDER BY (COALESCE(e.momentum_score,0) * 10 + memory_count * 0.5 + (last_memory_access / 86400.0 / 365) * 2) DESC';
    sql += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);
    const rows = db.prepare(sql).all(...params) as any[];
    const totalRow = db.prepare(
      kind ? 'SELECT COUNT(*) as c FROM entities WHERE kind = ? AND user_id = ?' : 'SELECT COUNT(*) as c FROM entities WHERE user_id = ?'
    ).get(...(kind ? [kind, userId] : [userId])) as { c: number };
    return JSON.stringify({
      ok: true,
      total: totalRow.c,
      returned: rows.length,
      offset,
      has_more: offset + rows.length < totalRow.c,
      entities: rows.map((r) => ({
        id: r.id, name: r.name, kind: r.kind, canonical_key: r.canonical_key,
        momentum: Number((r.momentum_score ?? 0).toFixed(2)),
        memory_count: r.memory_count,
        last_memory_access: r.last_memory_access ? new Date(r.last_memory_access * 1000).toISOString() : null,
        layer_breakdown: { goal: r.goal_count, caveat: r.caveat_count, learning: r.learning_count, implementation: r.impl_count },
        pinned_count: r.pinned_count,
      })),
    });
  }

  function handleRecallFile(args: any): string {
    const sub = String(args.path_substring ?? '').trim();
    if (!sub) return JSON.stringify({ ok: false, error: 'path_substring required' });
    const maxIntents = Math.max(1, Math.min(50, args.max_intents ?? 10));
    const totalRow = db.prepare(
      `SELECT COUNT(*) as c, MIN(occurred_at) as first_at, MAX(occurred_at) as last_at, COUNT(DISTINCT session_id) as sessions FROM session_file_edits WHERE file_path LIKE ? AND user_id = ?`
    ).get(`%${sub}%`, userId) as any;
    if (!totalRow || totalRow.c === 0) return JSON.stringify({ ok: true, count: 0, note: 'No edits found for that path substring.' });
    const daily = db.prepare(
      `SELECT DATE(occurred_at, 'unixepoch') as day, operation, COUNT(*) as edits FROM session_file_edits WHERE file_path LIKE ? AND user_id = ? GROUP BY day, operation ORDER BY day`
    ).all(`%${sub}%`, userId) as any[];
    const intents = db.prepare(
      `SELECT DISTINCT context_snippet, MAX(occurred_at) as last_at, COUNT(*) as freq FROM session_file_edits WHERE file_path LIKE ? AND user_id = ? AND context_snippet IS NOT NULL AND LENGTH(context_snippet) > 20 GROUP BY context_snippet ORDER BY last_at DESC LIMIT ?`
    ).all(`%${sub}%`, userId, maxIntents) as any[];
    const memories = db.prepare(
      `SELECT DISTINCT m.id, m.layer, m.content, m.importance, e.name as entity_name FROM session_file_edits sfe JOIN memories m ON m.id = sfe.memory_id JOIN entities e ON e.id = m.entity_id WHERE sfe.file_path LIKE ? AND sfe.user_id = ? ORDER BY m.importance DESC LIMIT 20`
    ).all(`%${sub}%`, userId) as any[];
    const paths = db.prepare(
      `SELECT file_path, COUNT(*) as edits FROM session_file_edits WHERE file_path LIKE ? AND user_id = ? GROUP BY file_path ORDER BY edits DESC`
    ).all(`%${sub}%`, userId) as any[];
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
      user_intents: intents.map((i) => ({ when: new Date(i.last_at * 1000).toISOString(), occurrences: i.freq, intent: i.context_snippet })),
      linked_memories: memories.map((m) => ({
        id: m.id, entity: m.entity_name, layer: m.layer, importance: m.importance,
        preview: m.content.length > 300 ? m.content.slice(0, 300) + '...' : m.content,
      })),
    });
  }

  function handleReadSmart(args: any): string {
    return handleReadSmartImpl(db, { path: args.path, force: args.force, userId });
  }

  // ──────────────────────────────────────────────────────────────
  // Async handlers using client capabilities (sampling / roots / elicitation)
  // ──────────────────────────────────────────────────────────────

  async function handleRecallFileWithRoots(args: any): Promise<string> {
    const baseJson = handleRecallFile(args);
    if (!args?.scope_to_roots) return baseJson;
    let parsed: any;
    try { parsed = JSON.parse(baseJson); } catch { return baseJson; }
    if (!parsed?.ok || !Array.isArray(parsed.paths_matched)) return baseJson;
    const roots = await fetchRoots(server, rootsCache);
    if (roots.length === 0) {
      parsed.roots_filter = { applied: false, reason: 'client provided no roots' };
      return JSON.stringify(parsed);
    }
    const filtered = parsed.paths_matched.filter((p: any) => isInsideRoots(p.file_path, roots));
    parsed.roots_filter = { applied: true, root_count: roots.length, before: parsed.paths_matched.length, after: filtered.length };
    parsed.paths_matched = filtered;
    return JSON.stringify(parsed);
  }

  async function handleConsolidateWithSampling(args: any): Promise<string> {
    if (!args?.use_llm || args?.dry_run) return handleConsolidate(args);
    const ageCutoff = Math.floor(Date.now() / 1000) - (typeof args?.min_age_days === 'number' ? args.min_age_days : 7) * 86400;
    const snapshot = new Map<number, { id: number; content: string; entity_name: string }>();
    const candidateRows = db.prepare(
      `SELECT m.id, m.content, e.name as entity_name FROM memories m JOIN entities e ON e.id = m.entity_id WHERE m.protected = 0 AND m.layer IN ('context','emotion','implementation') AND m.created_at <= ? AND m.user_id = ?`
    ).all(ageCutoff, userId) as any[];
    for (const r of candidateRows) snapshot.set(r.id, r);
    const baseJson = handleConsolidate(args);
    let parsed: any;
    try { parsed = JSON.parse(baseJson); } catch { return baseJson; }
    if (!parsed?.ok || !Array.isArray(parsed.learningIdsCreated)) {
      parsed = parsed ?? {};
      parsed.sampling = { applied: false, reason: 'consolidate returned no learning entries' };
      return JSON.stringify(parsed);
    }
    let upgraded = 0;
    let declined = 0;
    const declineReasons: string[] = [];
    for (const learningId of parsed.learningIdsCreated as number[]) {
      const audit = db.prepare('SELECT replaced_ids FROM consolidations WHERE learning_id = ?').get(learningId) as any;
      if (!audit) { declined++; continue; }
      let replaced: number[];
      try { replaced = JSON.parse(audit.replaced_ids); } catch { declined++; continue; }
      if (!Array.isArray(replaced) || replaced.length < 2) { declined++; continue; }
      const sources = replaced.map((id) => snapshot.get(id)).filter((s): s is NonNullable<typeof s> => Boolean(s));
      if (sources.length < 2) { declined++; continue; }
      const entityName = sources[0]?.entity_name ?? '<entity>';
      const result = await sampleConsolidation(server, sources.map((s) => s.content), entityName);
      if (result.ok && result.text) {
        db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(result.text.trim(), learningId);
        upgraded++;
      } else {
        declined++;
        if (result.reason && declineReasons.length < 3) declineReasons.push(result.reason);
      }
    }
    parsed.sampling = { applied: true, upgraded, declined, ...(declineReasons.length ? { decline_reasons: declineReasons } : {}) };
    return JSON.stringify(parsed);
  }

  async function handleForgetInteractive(args: any): Promise<string> {
    if (!args?.interactive || !args?.memory_id) return handleForget(args);
    const id = Number(args.memory_id);
    const row = db.prepare(
      `SELECT m.id, m.layer, m.content, m.importance, e.name as entity FROM memories m JOIN entities e ON e.id = m.entity_id WHERE m.id = ?`
    ).get(id) as any;
    if (!row) return JSON.stringify({ ok: false, error: `memory ${id} not found` });
    const ok = await confirmForget(server, { id: row.id, entity: row.entity, layer: row.layer, importance: row.importance, preview: row.content });
    if (!ok) return JSON.stringify({ ok: false, declined: true, memory_id: id, reason: 'user declined elicitation' });
    return handleForget({ memory_id: id });
  }

  // Append optional flags to existing tool schemas (backward-compatible).
  const RECALL_FILE_TOOL = TOOLS.find((t) => t.name === 'recall_file');
  if (RECALL_FILE_TOOL) {
    (RECALL_FILE_TOOL.inputSchema as any).properties.scope_to_roots = {
      type: 'boolean', default: false,
      description: 'If true, filter results to files inside the client-provided roots (Roots block). Skip silently when client provides no roots.',
    };
  }
  const CONSOLIDATE_TOOL = TOOLS.find((t) => t.name === 'consolidate');
  if (CONSOLIDATE_TOOL) {
    (CONSOLIDATE_TOOL.inputSchema as any).properties.use_llm = {
      type: 'boolean', default: false,
      description: 'If true, request the client LLM (Sampling block) to write the consolidated summary instead of the heuristic. Falls back gracefully if the client refuses.',
    };
  }
  const FORGET_TOOL = TOOLS.find((t) => t.name === 'forget');
  if (FORGET_TOOL) {
    (FORGET_TOOL.inputSchema as any).properties.interactive = {
      type: 'boolean', default: false,
      description: 'If true, ask the user to confirm via Elicitation before deleting. Only applies when memory_id is set.',
    };
  }

  // ──────────────────────────────────────────────────────────────
  // MCP wiring
  // ──────────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      let text: string;
      switch (name) {
        case 'remember':      text = handleRemember(args); break;
        case 'recall':        text = handleRecall(args); break;
        case 'update_memory': text = handleUpdateMemory(args); break;
        case 'list_entities': text = handleListEntities(args); break;
        case 'forget':        text = await handleForgetInteractive(args); break;
        case 'consolidate':   text = await handleConsolidateWithSampling(args); break;
        case 'recall_file':   text = await handleRecallFileWithRoots(args); break;
        case 'read_smart':    text = handleReadSmart(args); break;
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

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: STATIC_RESOURCES }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: RESOURCE_TEMPLATES }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const { uri } = req.params;
    const result = readResource(db, uri, userId);
    return { contents: [result] };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const { name, arguments: promptArgs } = req.params;
    return getPrompt(name, promptArgs as Record<string, string> | undefined);
  });

  return server;
}
