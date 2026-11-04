#!/usr/bin/env node
// linksee-memory migrate — bring a schema 1–5 memory.db (0.11 and earlier, up to May 2026) to the
// current schema, by hand, without starting the server (0.17.2, L-1-068 / L-1-122).
//
//   npx -y linksee-memory@<version> migrate --dry   # read-only: what would happen
//   npx -y linksee-memory@<version> migrate         # back up, then migrate in one transaction
//
// What it does NOT do: start the MCP server, consolidate, merge duplicate entities, delete rows,
// or switch the journal mode. Every check that cannot be completed stops the run.
//
// Order (each step only runs when the one before succeeded):
//   1. read the schema on a READ-ONLY connection (no checkpoint, no rollback)
//        schema ≥ 6 → "not needed", nothing written;  --dry → report and stop
//   2. hot rollback journal only: copy memory.db + memory.db-journal byte for byte
//        to memory.db.pre-migrate-<ts>-hot(-journal) before anything opens them for writing
//   3. open for writing, BEGIN IMMEDIATE (refused if another process is writing)
//   4. consistent backup: a second connection runs VACUUM INTO memory.db.pre-migrate-<ts>
//        while (3) holds the write lock, then the backup is checked: integrity_check = ok,
//        same row counts as the original
//   5. migrate.ts steps 5→6→…→16 inside the transaction from (3)
//   6. every table's row count ≥ before, schema = current, quick_check = ok → COMMIT
//        otherwise ROLLBACK: the schema version is not advanced and the backup stays

import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, constants as fsc } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  getDbPath, probeReadonly, readSchemaVersion, runMigrations, MIN_SUPPORTED_SCHEMA, DbRefusedError, migrateCommand,
} from '../db/migrate.js';
import { isNativeLoadError, NATIVE_HINT } from '../lib/native-hint.js';

export type MigrateLegacyOpts = {
  dbPath: string;
  dry?: boolean;
  now?: Date;
  /** Called before each migration step; tests throw here to check the rollback. */
  onStep?: (step: string, db: Database.Database) => void;
  log?: (line: string) => void;
};

export type MigrateLegacyResult = {
  code: 0 | 1;
  outcome: 'missing' | 'not-needed' | 'dry' | 'migrated' | 'recovered' | 'refused' | 'failed';
  backup?: string;
  rawCopy?: string;
  before?: Record<string, number>;
  after?: Record<string, number>;
  from?: number;
  to?: number;
};

/** The four tables the report shows. Every table is checked; these are the ones people know. */
export const REPORTED = ['memories', 'entities', 'memory_edges', 'drift_anchors'] as const;

export function currentSchemaVersion(): number {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'schema.sql'), 'utf8');
  const m = sql.match(/VALUES \('schema_version', '(\d+)'\)/);
  if (!m) throw new Error('schema.sql has no schema_version');
  return Number(m[1]);
}

/** Row count of every ordinary table (FTS shadow tables and sqlite_* excluded). */
export function rowCounts(db: Database.Database): Record<string, number> {
  const names = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memories_fts%' ORDER BY name",
  ).all() as Array<{ name: string }>).map((r) => r.name);
  const out: Record<string, number> = {};
  for (const n of names) out[n] = (db.prepare(`SELECT COUNT(*) AS c FROM "${n.replace(/"/g, '""')}"`).get() as { c: number }).c;
  return out;
}

const shown = (c: Record<string, number> | undefined, t: string) => (c && t in c ? String(c[t]) : '(no table)');

/** Which steps migrate.ts would run from schema `v` (for --dry and the report). */
export function planFor(v: number, hasDriftAnchors: boolean): string[] {
  const s: string[] = [];
  if (v < 4) s.push('v3→v4: rebuild the full-text index (trigram) from memories');
  if (v < 5) s.push('v4→v5: add entities.normalized_name and fill it (duplicate entities are NOT merged)');
  if (v < 6) s.push('v5→v6: add the altitude / mem_type / mem_state generated columns');
  if (v < 7) s.push('v6→v7: add memories.thread_id (filled from content.session_id) + memory_edges');
  s.push(hasDriftAnchors ? 'v8→v9: add the newer drift_anchors columns' : 'create drift_anchors (absent before v8) with all its columns');
  s.push(`schema.sql: create the newer tables, schema_version → ${currentSchemaVersion()}`);
  return s;
}

function stampOf(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function restoreSteps(dbPath: string, backup: string | undefined, log: (l: string) => void): void {
  log(`  memory.db was rolled back: its schema version and rows are as they were before this run.`);
  if (backup && existsSync(backup)) {
    log(`  A consistent copy from before the run is at ${backup}. To go back to it by hand:`);
    log(`    1. close every Claude Code / Cursor / other client using linksee-memory`);
    log(`    2. move memory.db and any memory.db-wal / -shm / -journal out of ${dirname(dbPath)}`);
    log(`    3. copy ${backup} to ${dbPath}`);
  }
}

export function migrateLegacy(o: MigrateLegacyOpts): MigrateLegacyResult {
  const log = o.log ?? ((l: string) => console.log(l));
  const path = o.dbPath;
  const target = currentSchemaVersion();

  // 1. read-only look. Throws PrecheckError (busy / unreadable) or the native error: the caller stops.
  const { probe, tidy } = probeReadonly(path);
  if (probe.kind === 'missing') {
    log(`No memory.db at ${path} — nothing to migrate.`);
    return { code: 0, outcome: 'missing' };
  }
  if (probe.kind === 'notadb') {
    tidy();
    log(`${path} is not a readable SQLite database. Nothing was changed.`);
    return { code: 1, outcome: 'refused' };
  }
  if (probe.kind === 'version' && probe.version >= MIN_SUPPORTED_SCHEMA) {
    tidy();
    log(`${path} is at schema ${probe.version}: migrate is not needed (the server migrates schema ${MIN_SUPPORTED_SCHEMA} and newer itself). Nothing was changed.`);
    return { code: 0, outcome: 'not-needed', from: probe.version };
  }
  if (probe.kind === 'version' && probe.version === 0) {
    tidy();
    log(`${path} has no schema_version: not a linksee-memory database this command knows. Nothing was changed.`);
    return { code: 1, outcome: 'refused' };
  }

  const stamp = stampOf(o.now ?? new Date());
  const backup = `${path}.pre-migrate-${stamp}`;
  const rawCopy = probe.kind === 'hot' ? `${backup}-hot` : undefined;

  if (o.dry) {
    // Read the version and counts without writing. A hot journal cannot be read in place, so a
    // throwaway copy of the pair is opened instead (SQLite rolls the copy back, not the original).
    let v = 0; let counts: Record<string, number> = {}; let hasDA = false;
    let tmp: string | null = null;
    try {
      let file = path;
      if (probe.kind === 'hot') {
        tmp = mkdtempSync(join(tmpdir(), 'linksee-migrate-dry-'));
        file = join(tmp, 'memory.db');
        copyFileSync(path, file);
        copyFileSync(path + '-journal', file + '-journal');
      }
      const ro = new Database(file, { readonly: probe.kind !== 'hot', fileMustExist: true });
      try {
        v = readSchemaVersion(ro); counts = rowCounts(ro);
        hasDA = 'drift_anchors' in counts;
      } finally { ro.close(); }
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      tidy();
    }
    log(`[dry] ${path}: schema ${v}${probe.kind === 'hot' ? ' (after rolling back an unfinished write, read from a temporary copy)' : ''}. Nothing was written.`);
    if (v >= MIN_SUPPORTED_SCHEMA) {
      log(`[dry] Only the unfinished write would be rolled back (raw copy first: ${rawCopy}); no migration needed.`);
      return { code: 0, outcome: 'dry', from: v };
    }
    if (rawCopy) log(`[dry] would copy memory.db + memory.db-journal byte for byte to ${rawCopy}(-journal)`);
    log(`[dry] would back up (VACUUM INTO, then integrity_check) to ${backup}`);
    log(`[dry] would run, in one transaction (rolled back on any failure):`);
    for (const s of planFor(v, hasDA)) log(`        • ${s}`);
    log(`[dry] rows now: ${REPORTED.map((t) => `${t} ${shown(counts, t)}`).join(' · ')}`);
    log(`[dry] the server is not started and nothing is consolidated or deleted.`);
    return { code: 0, outcome: 'dry', from: v, before: counts };
  }

  if (existsSync(backup) || (rawCopy && existsSync(rawCopy))) {
    log(`${backup} already exists; run again in a second. Nothing was changed.`);
    return { code: 1, outcome: 'refused' };
  }

  // 2. hot journal: keep the exact bytes before SQLite rolls the unfinished write back.
  if (rawCopy) {
    try {
      copyFileSync(path, rawCopy, fsc.COPYFILE_EXCL);
      copyFileSync(path + '-journal', rawCopy + '-journal', fsc.COPYFILE_EXCL);
    } catch (e) {
      log(`Could not copy the files before recovery (${(e as Error)?.message ?? e}). Nothing was changed.`);
      return { code: 1, outcome: 'refused' };
    }
    log(`Copied memory.db + memory.db-journal as they were to ${rawCopy}(-journal).`);
  }

  // 3. the write lock. Readers may stay; another writer makes this fail.
  const db = new Database(path, { timeout: 2000 });
  let before: Record<string, number> = {};
  let from = 0;
  try {
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (e) {
      log(`Could not take the write lock (${(e as { code?: string })?.code ?? (e as Error)?.message}). ` +
        `Close every Claude Code / Cursor / other client using linksee-memory and run again. Nothing was migrated.`);
      return { code: 1, outcome: 'refused', rawCopy };
    }
    from = readSchemaVersion(db);
    if (from >= MIN_SUPPORTED_SCHEMA) {
      db.exec('COMMIT');
      log(`The unfinished write was rolled back by SQLite. ${path} is at schema ${from}: no migration needed.`);
      return { code: 0, outcome: 'recovered', rawCopy, from };
    }
    if (from === 0) {
      db.exec('ROLLBACK');
      log(`${path} has no schema_version: not a linksee-memory database this command knows. Nothing was migrated.`);
      return { code: 1, outcome: 'refused', rawCopy };
    }
    before = rowCounts(db);

    // 4. consistent backup, taken while this connection holds the write lock.
    try {
      const b = new Database(path, { timeout: 2000, fileMustExist: true });
      try { b.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`); } finally { b.close(); }
      const c = new Database(backup, { readonly: true, fileMustExist: true });
      try {
        const ic = c.pragma('integrity_check', { simple: true });
        const bc = rowCounts(c);
        const bv = readSchemaVersion(c);
        if (ic !== 'ok') throw new Error(`integrity_check on the backup returned ${String(ic)}`);
        if (bv !== from || JSON.stringify(bc) !== JSON.stringify(before)) throw new Error('the backup does not match the original (schema or row counts)');
      } finally { c.close(); }
    } catch (e) {
      db.exec('ROLLBACK');
      log(`Backup failed (${(e as Error)?.message ?? e}). Nothing was migrated; memory.db is as it was.`);
      return { code: 1, outcome: 'failed', backup: existsSync(backup) ? backup : undefined, rawCopy, from };
    }
    log(`Backed up to ${backup} (integrity_check ok, same row counts).`);

    // 5 + 6. migrate in the open transaction, check, and only then commit.
    let after: Record<string, number> = {};
    try {
      runMigrations(db, { allowLegacy: true, mergeDuplicateEntities: false, onStep: o.onStep });
      after = rowCounts(db);
      const lost = Object.keys(before).filter((t) => (after[t] ?? -1) < before[t]);
      const to = readSchemaVersion(db);
      const qc = db.pragma('quick_check', { simple: true });
      if (lost.length) throw new Error(`rows would be lost in: ${lost.map((t) => `${t} ${before[t]}→${after[t] ?? 'gone'}`).join(', ')}`);
      if (to !== target) throw new Error(`schema ended at ${to}, expected ${target}`);
      if (qc !== 'ok') throw new Error(`quick_check returned ${String(qc)}`);
      db.exec('COMMIT');
    } catch (e) {
      if (db.inTransaction) { try { db.exec('ROLLBACK'); } catch { /* the close below rolls back */ } }
      log(`Migration failed: ${(e as Error)?.message ?? e}`);
      restoreSteps(path, backup, log);
      return { code: 1, outcome: 'failed', backup, rawCopy, before, from };
    }

    log(`Migrated ${path}: schema ${from} → ${target}.`);
    for (const t of REPORTED) log(`  ${t.padEnd(14)} ${shown(before, t).padStart(8)} → ${shown(after, t)}`);
    log(`The backup stays at ${backup}; delete it yourself once linksee-memory works for you.`);
    log(`Nothing was consolidated or deleted. The server switches the file to WAL on its next start.`);
    return { code: 0, outcome: 'migrated', backup, rawCopy, before, after, from, to: target };
  } finally {
    if (db.inTransaction) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } }
    db.close();
  }
}

function usage(): string {
  return `Usage: ${migrateCommand()} [--dry] [--db <path to memory.db>]

Migrates a memory.db at schema 1–5 (linksee-memory 0.11 and earlier) to the current schema.
  --dry   only report what would happen; nothing is written
  --db    a memory.db other than ${getDbPath()}
It backs the file up first (memory.db.pre-migrate-<time>), runs every step in one transaction,
and rolls back if any step fails or any table would lose rows. It does not start the server.
Close Claude Code / Cursor / other clients using linksee-memory before running it.`;
}

function main(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(usage()); return 0; }
  const known = new Set(['--dry', '--db']);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') { i++; continue; }
    if (!known.has(argv[i])) { console.error(`Unknown argument: ${argv[i]}\n\n${usage()}`); return 1; }
  }
  const di = argv.indexOf('--db');
  if (di >= 0 && !argv[di + 1]) { console.error(`--db needs a path\n\n${usage()}`); return 1; }
  const dbPath = di >= 0 ? resolve(argv[di + 1]) : getDbPath();
  try {
    return migrateLegacy({ dbPath, dry: argv.includes('--dry') }).code;
  } catch (e) {
    if (e instanceof DbRefusedError) { console.error(e.message); return 1; }
    if (isNativeLoadError(e)) { console.error(NATIVE_HINT); return 1; }
    console.error(`[linksee-memory] migrate stopped: ${(e as Error)?.message ?? e}`);
    return 1;
  }
}

const isMain = (() => {
  try {
    const a = process.argv[1] ? realpathSync(process.argv[1]) : '';
    const b = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch { return false; }
})();
if (isMain) process.exit(main(process.argv.slice(2)));
