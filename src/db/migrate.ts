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

  // v3 → v4: rebuild memories_fts with trigram tokenizer for JP/CJK support
  const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  if (versionRow && Number(versionRow.value) < 4) {
    // Drop old triggers + table; CREATE statements below will recreate them
    db.exec(`
      DROP TRIGGER IF EXISTS trg_memories_fts_ai;
      DROP TRIGGER IF EXISTS trg_memories_fts_ad;
      DROP TRIGGER IF EXISTS trg_memories_fts_au;
      DROP TABLE IF EXISTS memories_fts;
    `);
  }

  db.exec(sql);

  // After v4 schema is applied, repopulate FTS index from existing memories
  if (versionRow && Number(versionRow.value) < 4) {
    db.exec(`INSERT INTO memories_fts(rowid, content) SELECT id, content FROM memories;`);
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
