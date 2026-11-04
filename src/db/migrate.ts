import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdirSync, renameSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { normalizeEntityName } from '../lib/normalize.js';
import { isNativeLoadError } from '../lib/native-hint.js';

const DEFAULT_DB_DIR = process.env.LINKSEE_MEMORY_DIR ?? join(homedir(), '.linksee-memory');
const DB_PATH = join(DEFAULT_DB_DIR, 'memory.db');

export function getDbPath(): string {
  return DB_PATH;
}

/** This package's version (dist/db/migrate.js → ../../package.json), for exact-version guidance. */
export function packageVersion(): string {
  try {
    const pkg = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    return String(JSON.parse(readFileSync(pkg, 'utf8')).version || '');
  } catch { return ''; }
}

/**
 * The command that migrates / recovers this file. Pinned to this exact version: an unpinned
 * `npx linksee-memory` could resolve to a cached older version, and versions before 0.17.2 have
 * no `migrate` subcommand — they would start the MCP server instead (L-1-130).
 */
export function migrateCommand(): string {
  const v = packageVersion();
  // Never fall back to an unpinned command (Codex review of #19): if this version cannot be read,
  // name the first version that has `migrate`, as a fixed string.
  return /^\d+\.\d+\.\d+/.test(v) ? `npx -y linksee-memory@${v} migrate` : `npx -y linksee-memory@${MIGRATE_SINCE} migrate`;
}

/** First version with the `migrate` subcommand. */
export const MIGRATE_SINCE = '0.17.2';

/**
 * Decide, WITHOUT a writable connection, whether this file may be opened for writing at all.
 * (0.17.1, Codex re-review of #15.) A writable connection that is the last one to close
 * checkpoints a leftover WAL into memory.db and deletes it, and rolls back a hot journal — both
 * are writes to a file we are about to refuse. So the schema is read through a read-only
 * connection first (SQLITE_OPEN_READONLY: no checkpoint, no rollback, memory.db and -wal untouched).
 *   • schema 1–5                 → LegacySchemaError
 *   • a hot rollback journal     → HotJournalError (it cannot be read without rolling back)
 *   • not a DB                   → return; the normal open's corruption path moves it aside
 *   • native addon failed        → rethrown as is
 *   • anything else (busy, locked, unreadable) → PrecheckError: could not check, so no writing
 * When the file is refused, the -wal/-shm that the read-only open itself created are removed
 * again, so the folder is left as it was.
 */
export type ReadonlyProbe =
  | { kind: 'missing' }
  | { kind: 'notadb' }
  | { kind: 'hot' }
  | { kind: 'version'; version: number };

/**
 * Read the schema through a read-only connection (no checkpoint, no rollback). Returns what it
 * found plus `tidy`, which removes the -wal/-shm that the read-only open itself added.
 * Throws the native load error as is, and PrecheckError when the file could not be checked at all.
 */
export function probeReadonly(path: string): { probe: ReadonlyProbe; tidy: () => void } {
  if (!existsSync(path)) return { probe: { kind: 'missing' }, tidy: () => {} };
  const had = { wal: existsSync(path + '-wal'), shm: existsSync(path + '-shm') };
  const walStat = had.wal ? statSync(path + '-wal') : null;
  // Remove only what the read-only open itself added: a -wal that was absent and is still empty,
  // and a -shm that was absent (e.g. a leftover -wal with no -shm — the reader builds one).
  // 0.17.2 (Codex fifth review of #15, P2): another process may open the file in the same instant
  // and start using the -shm. Two guards: (1) if the -wal changed while we looked (size or mtime),
  // someone else is active → leave both; (2) the -shm is renamed aside first — on Windows a file
  // another process has open cannot be renamed, so an in-use -shm stays. On POSIX an open -shm can
  // still be renamed, so a writer that starts in the exact window remains a known limit.
  const tidy = () => {
    try {
      if (had.wal) {
        const now = existsSync(path + '-wal') ? statSync(path + '-wal') : null;
        if (!now || !walStat || now.size !== walStat.size || now.mtimeMs !== walStat.mtimeMs) return;
      } else if (existsSync(path + '-wal')) {
        if (statSync(path + '-wal').size !== 0) return; // someone wrote to it: not ours
        unlinkSync(path + '-wal');
      }
      if (!had.shm && existsSync(path + '-shm')) {
        const aside = `${path}-shm.tidy-${process.pid}`;
        renameSync(path + '-shm', aside);
        unlinkSync(aside);
      }
    } catch { /* leave them; memory.db itself is untouched either way */ }
  };
  let v = 0;
  try {
    const ro = new Database(path, { readonly: true, fileMustExist: true });
    try { v = readSchemaVersion(ro); } finally { ro.close(); }
  } catch (e) {
    const code = (e as { code?: string })?.code ?? '';
    const msg = (e as Error)?.message ?? String(e);
    // The file vanished between the check and the open: a new DB, as above.
    if (!existsSync(path) && (code === 'SQLITE_CANTOPEN' || code === 'ENOENT' || /unable to open|does not exist/i.test(msg))) {
      return { probe: { kind: 'missing' }, tidy: () => {} };
    }
    // The native addon itself failed: let it surface as such (the hooks turn it into one line).
    if (isNativeLoadError(e)) throw e;
    // Not a database at all.
    if (code === 'SQLITE_NOTADB' || code === 'SQLITE_CORRUPT' || /not a database|malformed|disk image/i.test(msg)) {
      return { probe: { kind: 'notadb' }, tidy };
    }
    tidy();
    if (code === 'SQLITE_READONLY_ROLLBACK') return { probe: { kind: 'hot' }, tidy: () => {} };
    // Anything else (SQLITE_BUSY, locked, permission, I/O): we could not check it, so we do not
    // write to it either — fail closed (0.17.1, Codex third review of #15).
    throw new PrecheckError(path, code || msg.split('\n')[0]);
  }
  return { probe: { kind: 'version', version: v }, tidy };
}

/**
 * Decide, WITHOUT a writable connection, whether this file may be opened for writing at all.
 * (0.17.1, Codex re-review of #15.) A writable connection that is the last one to close
 * checkpoints a leftover WAL into memory.db and deletes it, and rolls back a hot journal — both
 * are writes to a file we are about to refuse. So the schema is read through a read-only
 * connection first (SQLITE_OPEN_READONLY: no checkpoint, no rollback, memory.db and -wal untouched).
 *   • schema 1–5                 → LegacySchemaError
 *   • a hot rollback journal     → HotJournalError (it cannot be read without rolling back)
 *   • not a DB                   → return; the normal open's corruption path moves it aside
 *   • native addon failed        → rethrown as is
 *   • anything else (busy, locked, unreadable) → PrecheckError: could not check, so no writing
 * When the file is refused, the -wal/-shm that the read-only open itself created are removed
 * again, so the folder is left as it was.
 */
function precheckBeforeWrite(path: string): void {
  const { probe, tidy } = probeReadonly(path);
  if (probe.kind === 'hot') throw new HotJournalError(path);
  if (probe.kind === 'version' && probe.version > 0 && probe.version < MIN_SUPPORTED_SCHEMA) {
    tidy();
    throw new LegacySchemaError(probe.version, path);
  }
}

function openAt(path: string): Database.Database {
  precheckBeforeWrite(path);
  const db = new Database(path);
  try {
    // Second line (the read-only precheck is the real gate): refuse before the journal-mode pragma.
    // This is also the first real read of the file — it throws if the file isn't a DB.
    const v = readSchemaVersion(db);
    if (v > 0 && v < MIN_SUPPORTED_SCHEMA) throw new LegacySchemaError(v, path);
    db.pragma('journal_mode = WAL');
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

/** Oldest schema this version migrates in place. Older files are refused before any write. */
export const MIN_SUPPORTED_SCHEMA = 6;

/** Base class: openDb() refused this file without writing to it. The message says what to do. */
export class DbRefusedError extends Error {}

/**
 * Thrown for a schema older than MIN_SUPPORTED_SCHEMA (a DB last opened by a 2026-05-or-earlier
 * version). Raised by openDb() from a read-only connection, before any writable connection exists,
 * and again by runMigrations() as a second line.
 *
 * No old version is recommended as a stepping stone: 0.8.0–0.17.0 stop on `no such table:
 * drift_anchors` after partly altering the file, and 0.7.2 has no subcommands — `npx
 * linksee-memory@0.7.2 <anything>` starts its MCP server, whose start-up consolidate can delete
 * original rows (Codex review of PR #15). 0.17.2: `linksee-memory migrate` (src/bin/migrate-legacy.ts).
 */
export class LegacySchemaError extends DbRefusedError {
  readonly schemaVersion: number;
  constructor(schemaVersion: number, dbPath: string) {
    super(
      `[linksee-memory] ${dbPath} is at schema ${schemaVersion}; this version migrates schema ${MIN_SUPPORTED_SCHEMA} and newer only. ` +
      `Stopped before writing anything to the file.
\n` +
      `  1. Close every Claude Code / Cursor / other client using linksee-memory.
\n` +
      `  2. Back up the folder that holds memory.db (copy memory.db and any memory.db-wal / -shm / -journal) and keep the copy.
\n` +
      `  3. Do not open this file with another linksee-memory version in the meantime — older versions can delete or half-migrate rows.
\n` +
      `  4. Migrate it (it backs the file up first; --dry only reports): ${migrateCommand()} --dry, then the same without --dry.
\n` +
      `To start fresh instead, point LINKSEE_MEMORY_DIR at an empty folder.`,
    );
    this.name = 'LegacySchemaError';
    this.schemaVersion = schemaVersion;
  }
}

/** The read-only check could not run (busy, locked, unreadable): refused rather than guessed. */
export class PrecheckError extends DbRefusedError {
  readonly reason: string;
  constructor(dbPath: string, reason: string) {
    super(
      `[linksee-memory] could not check ${dbPath} before opening it for writing (${reason}). ` +
      `Stopped before writing anything. Another client may have it open or locked: close other ` +
      `Claude Code / Cursor / linksee-memory processes and try again.`,
    );
    this.name = 'PrecheckError';
    this.reason = reason;
  }
}

/** A rollback journal left by an interrupted write: it cannot be read without being rolled back. */
export class HotJournalError extends DbRefusedError {
  constructor(dbPath: string) {
    super(
      `[linksee-memory] ${dbPath} has an unfinished write from an interrupted process (memory.db-journal), ` +
      `so it cannot be checked without changing it. Stopped before writing anything.
\n` +
      `  Back up the folder that holds memory.db (all memory.db* files) before anything else opens it, ` +
      `then run: ${migrateCommand()} (it copies the files first, then lets SQLite roll the unfinished write back).`,
    );
    this.name = 'HotJournalError';
  }
}

/** Read meta.schema_version without writing (0 when the table or row is absent). */
export function readSchemaVersion(db: Database.Database): number {
  const metaTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'"
  ).get() as { name?: string } | undefined;
  if (!metaTable?.name) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  return row ? Number(row.value) || 0 : 0;
}

export type MigrateOptions = {
  /** Migrate schema 1–5 too. Only the `migrate` command sets this (inside its own transaction). */
  allowLegacy?: boolean;
  /** v4→v5 dedupe merges duplicate entities (deletes rows). Default true; `migrate` passes false. */
  mergeDuplicateEntities?: boolean;
  /** Called before each step (tests inject a failure here). */
  onStep?: (step: string, db: Database.Database) => void;
};

export function runMigrations(db: Database.Database, opts: MigrateOptions = {}): void {
  const step = (name: string) => opts.onStep?.(name, db);
  const __filename = fileURLToPath(import.meta.url);
  const schemaPath = join(dirname(__filename), 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf8');

  // Safely read current schema version. On a fresh DB the meta table doesn't
  // exist yet, which is fine — treat that as "version 0, full schema apply".
  const currentVersion = readSchemaVersion(db);

  // 0.17.1 (L-1-106 / audit F3): refuse schema 1–5 BEFORE any write. Their path through here
  // (v5 → v6 generated columns, then the v5 entity merge running after the version has already
  // been bumped to 16, with no transaction around it) can leave a half-migrated file. A safe,
  // tested path is the `migrate` command (0.17.2): it backs up, sets allowLegacy and runs all of
  // this inside one transaction. openDb() already refused these before any write; this is the
  // second line for callers that hand in their own connection.
  if (currentVersion > 0 && currentVersion < MIN_SUPPORTED_SCHEMA && !opts.allowLegacy) {
    throw new LegacySchemaError(currentVersion, getDbPath());
  }

  // v3 → v4: rebuild memories_fts with trigram tokenizer for JP/CJK support.
  // Only runs when upgrading an existing DB from schema v1-3.
  if (currentVersion > 0 && currentVersion < 4) {
    step('v3-v4');
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
    step('v4-v5');
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
    step('v5-v6');
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
    step('v6-v7');
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
  // 0.17.1 (L-1-106 / audit F3): drift_anchors only exists from v8 on. On an older DB the table is
  // missing, PRAGMA table_info returns nothing, and every ALTER below threw "no such table" — so
  // any pre-0.12 DB could not start. If the table is absent, skip: db.exec(sql) below creates it
  // with all of these columns.
  const hasDriftAnchors = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='drift_anchors'"
  ).get();
  if (currentVersion > 0 && currentVersion < 9 && hasDriftAnchors) {
    step('v8-v9');
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
    step('v11-v12');
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
    step('v12-v13');
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
    step('v13-v14');
    db.exec('DROP TABLE IF EXISTS map_nodes; DROP TABLE IF EXISTS map_edges;');
  }

  step('schema.sql');
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
    step('v5-backfill');
    migrateV5EntityNormalization(db, opts.mergeDuplicateEntities !== false);
  }
}

/**
 * v5 migration: add normalized_name column and backfill + merge duplicates.
 */
function migrateV5EntityNormalization(db: Database.Database, merge: boolean): void {
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

  if (dupes.length > 0 && !merge) {
    console.log(`[linksee-memory] v5 migration: ${dupes.length} duplicate entity clusters left as they are (not merged)`);
    return;
  }
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
