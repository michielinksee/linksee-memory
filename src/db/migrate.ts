import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const DEFAULT_DB_DIR = process.env.LINKSEE_MEMORY_DIR ?? join(homedir(), '.linksee-memory');
const DB_PATH = join(DEFAULT_DB_DIR, 'memory.db');

export function getDbPath(): string {
  return DB_PATH;
}

export function openDb(): Database.Database {
  mkdirSync(DEFAULT_DB_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
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
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  const db = openDb();
  runMigrations(db);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  console.log(`[linksee-memory] migrated ${DB_PATH} (schema v${row?.value ?? '?'})`);
  db.close();
}
