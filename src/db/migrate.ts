import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { normalizeEntityName } from '../lib/normalize.js';

const DEFAULT_DB_DIR = process.env.LINKSEE_MEMORY_DIR ?? join(homedir(), '.linksee-memory');
const DB_PATH = join(DEFAULT_DB_DIR, 'memory.db');

export function getDbPath(): string {
  return DB_PATH;
}

function openAt(path: string): Database.Database {
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL'); // first real read of the file header — throws if it isn't a DB
    db.pragma('foreign_keys = ON');
    return db;
  } catch (e) {
    try { db.close(); } catch { /* ignore */ } // release the handle so a corrupt file can be renamed (Windows locks it otherwise)
    throw e;
  }
}

export function openDb(): Database.Database {
  mkdirSync(DEFAULT_DB_DIR, { recursive: true });
  try {
    return openAt(DB_PATH);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A corrupt / non-database file throws on the first pragma. Don't crash with a raw
    // stack trace: preserve the bad file (so it can be recovered) and start a fresh DB.
    if (/not a database|file is encrypted|malformed|disk image/i.test(msg) && existsSync(DB_PATH)) {
      const backup = `${DB_PATH}.corrupt-${Date.now()}`;
      try { renameSync(DB_PATH, backup); } catch { /* best effort */ }
      for (const ext of ['-wal', '-shm']) {
        try { if (existsSync(DB_PATH + ext)) renameSync(DB_PATH + ext, backup + ext); } catch { /* ignore */ }
      }
      process.stderr.write(
        `[linksee-memory] the memory database was unreadable (${msg}). ` +
        `Moved it to ${backup} and started a fresh one — your old memories are preserved there for recovery.\n`,
      );
      return openAt(DB_PATH);
    }
    throw err; // not a corruption we recognize — surface it
  }
}

export function runMigrations(db: Database.Database): void {
  const __filename = fileURLToPath(import.meta.url);
  const schemaPath = join(dirname(__filename), 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf8');

  // Safely read current schema version. On a fresh DB the meta table doesn't
  // exist yet, which is fine — treat that as "version 0, full schema apply".
  let currentVersion = 0;
  const metaTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'"
  ).get() as { name?: string } | undefined;
  if (metaTable?.name) {
    const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    if (versionRow) currentVersion = Number(versionRow.value) || 0;
  }

  // v3 → v4: rebuild memories_fts with trigram tokenizer for JP/CJK support.
  // Only runs when upgrading an existing DB from schema v1-3.
  if (currentVersion > 0 && currentVersion < 4) {
    db.exec(`
      DROP TRIGGER IF EXISTS trg_memories_fts_ai;
      DROP TRIGGER IF EXISTS trg_memories_fts_ad;
      DROP TRIGGER IF EXISTS trg_memories_fts_au;
      DROP TABLE IF EXISTS memories_fts;
    `);
  }

  // v4 → v5: add normalized_name column BEFORE schema.sql runs,
  // so the CREATE INDEX IF NOT EXISTS on (kind, normalized_name) succeeds.
  if (currentVersion > 0 && currentVersion < 5) {
    const cols = db.prepare("PRAGMA table_info(entities)").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'normalized_name')) {
      db.exec('ALTER TABLE entities ADD COLUMN normalized_name TEXT');
    }
  }

  // v5 → v6: 3-axis generated columns (altitude, mem_type, mem_state).
  // VIRTUAL generated columns auto-extract from content JSON via json_extract.
  // json_valid() guard returns NULL for plain-text content instead of erroring.
  // Must run BEFORE db.exec(sql) so CREATE INDEX IF NOT EXISTS succeeds.
  //
  // NOTE: VIRTUAL generated columns are hidden from PRAGMA table_info.
  // Use PRAGMA table_xinfo (hidden=2 = VIRTUAL generated column) to detect them.
  if (currentVersion > 0 && currentVersion < 6) {
    const xcols = db.prepare("PRAGMA table_xinfo(memories)").all() as Array<{ name: string; hidden: number }>;
    const hasAltitude = xcols.some(c => c.name === 'altitude' && c.hidden === 2);

    if (hasAltitude) {
      // Repair path: columns may exist from a partial v6 migration with the old
      // json_extract-only definition (no json_valid guard). Drop and re-create.
      db.exec('DROP INDEX IF EXISTS idx_memories_altitude');
      db.exec('DROP INDEX IF EXISTS idx_memories_mem_type');
      db.exec('DROP INDEX IF EXISTS idx_memories_mem_state');
      db.exec('ALTER TABLE memories DROP COLUMN altitude');
      db.exec('ALTER TABLE memories DROP COLUMN mem_type');
      db.exec('ALTER TABLE memories DROP COLUMN mem_state');
    }

    db.exec(`ALTER TABLE memories ADD COLUMN altitude TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(content) THEN json_extract(content, '$.altitude') ELSE NULL END) VIRTUAL`);
    db.exec(`ALTER TABLE memories ADD COLUMN mem_type TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(content) THEN json_extract(content, '$.type') ELSE NULL END) VIRTUAL`);
    db.exec(`ALTER TABLE memories ADD COLUMN mem_state TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(content) THEN json_extract(content, '$.state') ELSE NULL END) VIRTUAL`);
  }

  // v6 → v7: thread_id column on memories + memory_edges table.
  // thread_id groups related memories (session-level or decision chains).
  // memory_edges creates directed relationships between individual memories.
  if (currentVersion > 0 && currentVersion < 7) {
    const cols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'thread_id')) {
      db.exec('ALTER TABLE memories ADD COLUMN thread_id TEXT');
    }
    // Backfill thread_id from content JSON session_id for existing memories
    db.exec(`
      UPDATE memories SET thread_id = json_extract(content, '$.session_id')
      WHERE thread_id IS NULL AND json_valid(content) AND json_extract(content, '$.session_id') IS NOT NULL
    `);
  }

  // v8 → v9: ProjectCoreNode — extend drift_anchors into the Current Truth Map node.
  // ADDITIVE columns only (ADD COLUMN with safe defaults) — NO CHECK rebuild, so the existing
  // detector/dashboard (which read the original columns + status active/retired) are unaffected.
  // `lifecycle` carries the rich state; `status` stays the coarse scan-gate. New tables
  // (reality_events, memory_write_candidates) are created by db.exec(sql) below (CREATE IF NOT EXISTS).
  if (currentVersion > 0 && currentVersion < 9) {
    const have = new Set(
      (db.prepare('PRAGMA table_info(drift_anchors)').all() as Array<{ name: string }>).map((c) => c.name)
    );
    const addCol = (name: string, ddl: string) => {
      if (!have.has(name)) db.exec(`ALTER TABLE drift_anchors ADD COLUMN ${ddl}`);
    };
    addCol('node_type', 'node_type TEXT');
    addCol('domain', 'domain TEXT');
    addCol('decision_mode', 'decision_mode TEXT');
    addCol('confidence', 'confidence REAL NOT NULL DEFAULT 0.8');
    addCol('lifecycle', "lifecycle TEXT NOT NULL DEFAULT 'active'");
    addCol('validity_scope', "validity_scope TEXT NOT NULL DEFAULT '{}'");
    addCol('card_policy', "card_policy TEXT NOT NULL DEFAULT '{}'");
    addCol('reality_manifestations', "reality_manifestations TEXT NOT NULL DEFAULT '[]'");
    addCol('evidence_refs', "evidence_refs TEXT NOT NULL DEFAULT '[]'");
    addCol('review_after', 'review_after INTEGER');
    addCol('last_confirmed_at', 'last_confirmed_at INTEGER');
    addCol('owner', 'owner TEXT');
  }

  // v11 → v12: reconciler overlay columns on map_nodes (the Map shipped at v11
  // without them). Only ALTER if map_nodes already exists; a v10→v12 jump creates
  // it fresh (with the columns) via db.exec(sql) below.
  if (currentVersion > 0 && currentVersion < 12) {
    const hasMapNodes = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='map_nodes'"
    ).get();
    if (hasMapNodes) {
      const have = new Set(
        (db.prepare('PRAGMA table_info(map_nodes)').all() as Array<{ name: string }>).map((c) => c.name)
      );
      const addCol = (name: string, ddl: string) => { if (!have.has(name)) db.exec(`ALTER TABLE map_nodes ADD COLUMN ${ddl}`); };
      addCol('reality', "reality TEXT NOT NULL DEFAULT '{}'");
      addCol('live_verdict', 'live_verdict TEXT');
      addCol('verdict_evidence', "verdict_evidence TEXT NOT NULL DEFAULT '{}'");
      addCol('reconciled_at', 'reconciled_at INTEGER');
    }
  }

  // v12 → v13: edge strength + accounted-for expiry (anti-noise / anti-graveyard).
  if (currentVersion > 0 && currentVersion < 13) {
    const has = (table: string, col: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === col);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='map_edges'").get()) {
      if (!has('map_edges', 'strength')) db.exec('ALTER TABLE map_edges ADD COLUMN strength TEXT');
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='map_nodes'").get()) {
      if (!has('map_nodes', 'review_by')) db.exec('ALTER TABLE map_nodes ADD COLUMN review_by TEXT');
      if (!has('map_nodes', 'revival_condition')) db.exec('ALTER TABLE map_nodes ADD COLUMN revival_condition TEXT');
    }
  }

  // v13 → v14: per-project uniqueness. map_nodes PK was the global `id`, and map_edges
  // UNIQUE was global (from_id,to_id,type) — so two projects couldn't both have a `readme`
  // node or a `readme→docs-site` edge. SQLite can't alter a PK/UNIQUE, so drop + recreate;
  // safe because importMap rebuilds both from map.yaml on every run.
  if (currentVersion > 0 && currentVersion < 14) {
    db.exec('DROP TABLE IF EXISTS map_nodes; DROP TABLE IF EXISTS map_edges;');
  }

  db.exec(sql);

  if (currentVersion > 0 && currentVersion < 4) {
    db.exec(`INSERT INTO memories_fts(rowid, content) SELECT id, content FROM memories;`);
  }

  // v0.1.1 data migration: pin threshold lowered from 1.0 to 0.9.
  //
  // Before v0.1.1, `remember()` only set `protected = 1` for memories
  // inserted with importance >= 1.0. After v0.1.1, the threshold is 0.9.
  // Existing rows written under the old rule need to be reconciled so that
  // `recall().pinned`, `list_entities.pinned_count`, and the auto-forget
  // guard (`WHERE protected = 0 AND importance < 0.9`) all agree.
  //
  // This runs on every startup but is a no-op after the first successful
  // run (UPDATE filter excludes already-protected rows).
  const hasMemories = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'"
  ).get() as { name?: string } | undefined;
  if (hasMemories?.name) {
    db.prepare(
      `UPDATE memories SET protected = 1 WHERE importance >= 0.9 AND protected = 0`
    ).run();
  }

  // v4 → v5: entity name normalization for dedup prevention.
  // Adds normalized_name column + backfills from existing entity names.
  if (currentVersion > 0 && currentVersion < 5) {
    migrateV5EntityNormalization(db);
  }
}

/**
 * v5 migration: add normalized_name column and backfill + merge duplicates.
 */
function migrateV5EntityNormalization(db: Database.Database): void {
  // Column + index already added before db.exec(sql) above.
  // Now backfill normalized_name for all entities.
  const entities = db.prepare('SELECT id, name FROM entities').all() as Array<{ id: number; name: string }>;
  const updateStmt = db.prepare('UPDATE entities SET normalized_name = ? WHERE id = ?');
  db.transaction(() => {
    for (const e of entities) {
      updateStmt.run(normalizeEntityName(e.name), e.id);
    }
  })();

  // 4. Auto-merge duplicate entities (same kind + normalized_name)
  const dupes = db.prepare(`
    SELECT kind, normalized_name, GROUP_CONCAT(id) as ids
    FROM entities
    WHERE normalized_name IS NOT NULL
    GROUP BY kind, normalized_name
    HAVING COUNT(*) > 1
  `).all() as Array<{ kind: string; normalized_name: string; ids: string }>;

  if (dupes.length > 0) {
    console.log(`[linksee-memory] v5 migration: merging ${dupes.length} duplicate entity clusters`);
    db.transaction(() => {
      for (const dupe of dupes) {
        const ids = dupe.ids.split(',').map(Number);
        mergeEntityCluster(db, ids);
      }
    })();
  }
}

/**
 * Merge a cluster of duplicate entity IDs into one canonical entity.
 * Picks the entity with the most memories (ties broken by canonical_key presence).
 * Reassigns all memories, events, edges, consolidations to the kept entity.
 */
function mergeEntityCluster(db: Database.Database, ids: number[]): void {
  if (ids.length < 2) return;

  // Score each entity: prefer most memories, then has canonical_key, then lowest id
  const rows = db.prepare(`
    SELECT e.id, e.name, e.canonical_key, COUNT(m.id) as mem_count
    FROM entities e LEFT JOIN memories m ON m.entity_id = e.id
    WHERE e.id IN (${ids.map(() => '?').join(',')})
    GROUP BY e.id
    ORDER BY mem_count DESC, (e.canonical_key IS NOT NULL) DESC, e.id ASC
  `).all(...ids) as Array<{ id: number; name: string; canonical_key: string | null; mem_count: number }>;

  const keep = rows[0];
  const mergeIds = rows.slice(1).map(r => r.id);

  console.log(`  merge: keeping "${keep.name}" (id=${keep.id}, ${keep.mem_count} memories), absorbing ids=[${mergeIds.join(',')}]`);

  // Inherit canonical_key if the kept entity lacks one
  // Clear donor's key first to avoid UNIQUE constraint violation
  if (!keep.canonical_key) {
    const donor = rows.find(r => r.id !== keep.id && r.canonical_key);
    if (donor) {
      db.prepare('UPDATE entities SET canonical_key = NULL WHERE id = ?').run(donor.id);
      db.prepare('UPDATE entities SET canonical_key = ? WHERE id = ?').run(donor.canonical_key, keep.id);
    }
  }

  for (const mid of mergeIds) {
    // Reassign memories
    db.prepare('UPDATE memories SET entity_id = ? WHERE entity_id = ?').run(keep.id, mid);
    // Reassign events
    db.prepare('UPDATE events SET entity_id = ? WHERE entity_id = ?').run(keep.id, mid);
    // Reassign edges (both directions)
    // Handle UNIQUE constraint: delete duplicates first
    db.prepare(`
      DELETE FROM edges WHERE from_id = ? AND EXISTS (
        SELECT 1 FROM edges e2 WHERE e2.from_id = ? AND e2.to_id = edges.to_id AND e2.relation = edges.relation
      )
    `).run(mid, keep.id);
    db.prepare('UPDATE edges SET from_id = ? WHERE from_id = ?').run(keep.id, mid);
    db.prepare(`
      DELETE FROM edges WHERE to_id = ? AND EXISTS (
        SELECT 1 FROM edges e2 WHERE e2.to_id = ? AND e2.from_id = edges.from_id AND e2.relation = edges.relation
      )
    `).run(mid, keep.id);
    db.prepare('UPDATE edges SET to_id = ? WHERE to_id = ?').run(keep.id, mid);
    // Reassign consolidations
    db.prepare('UPDATE consolidations SET entity_id = ? WHERE entity_id = ?').run(keep.id, mid);
    // Delete the duplicate entity
    db.prepare('DELETE FROM entities WHERE id = ?').run(mid);
  }
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  const db = openDb();
  runMigrations(db);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  console.log(`[linksee-memory] migrated ${DB_PATH} (schema v${row?.value ?? '?'})`);
  db.close();
}
