#!/usr/bin/env node
// linksee-memory migrate — bring a schema 1–5 memory.db (0.11 and earlier, up to May 2026) to the
// current schema, by hand, without starting the server (0.17.2, L-1-068 / L-1-122).
//
//   npx -y linksee-memory@<version> migrate --dry   # full rehearsal on a temporary copy
//   npx -y linksee-memory@<version> migrate         # migrate a copy, then swap it in
//
// The live files (memory.db and its -wal / -shm / -journal) are never opened for writing and never
// changed until the final swap (Codex review of #19: a writable connection on them recovers a hot
// journal on open and checkpoints a WAL on close, so "rolled back" could not mean "unchanged").
//
//   1. copy memory.db, -wal, -journal byte for byte into <memory.db>.migrating-<ts>/ (plain file
//      copy, no SQLite). If any live file's size or mtime changed during the copy → stop.
//   2. open the COPY: SQLite recovers it (rolls back a hot journal / reads the WAL) there.
//      Read its schema; integrity_check must be ok. schema ≥ 6 → "not needed" (unless the copy
//      had an unfinished write to roll back — then it is recovered and swapped like a migration).
//   3. VACUUM INTO a single-file replica; check it: integrity_check ok, same schema, same rows.
//   4. migrate the replica in one transaction (migrate.ts steps 5→6→…→16). Commit only if no table
//      lost rows, schema = current, quick_check = ok. Any failure → the work folder is removed;
//      the live files were not touched.
//   5. swap: live files unchanged since step 1? (size + mtime), no other writer (rollback-journal
//      files: a writable BEGIN IMMEDIATE probe that writes nothing), then move memory.db and its
//      sidecars into <memory.db>.pre-migrate-<ts>/ (that folder IS the backup, byte for byte) and
//      move the replica in. A failed rename puts back what was already moved.
// It never starts the server, consolidates, merges duplicate entities or deletes rows.

import Database from 'better-sqlite3';
import {
  closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync,
  renameSync, rmSync, rmdirSync, statSync, constants as fsc,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getDbPath, readSchemaVersion, runMigrations, MIN_SUPPORTED_SCHEMA, DbRefusedError, migrateCommand } from '../db/migrate.js';
import { isNativeLoadError, NATIVE_HINT } from '../lib/native-hint.js';

export type MigrateLegacyOpts = {
  dbPath: string;
  dry?: boolean;
  now?: Date;
  /** Called before each step with the connection it is about to use; tests inject failures here.
   *  Steps: 'vacuum-into' (the recovered copy), 'verify-replica' (the replica), every migrate.ts
   *  step (the replica, inside the transaction), 'commit' (the replica, just before COMMIT). */
  onStep?: (step: string, db: Database.Database) => void;
  log?: (line: string) => void;
};

export type MigrateLegacyResult = {
  code: 0 | 1;
  outcome: 'missing' | 'not-needed' | 'dry' | 'migrated' | 'recovered' | 'refused' | 'failed';
  backupDir?: string;
  before?: Record<string, number>;
  after?: Record<string, number>;
  from?: number;
  to?: number;
};

/** The four tables the report shows. Every table is checked; these are the ones people know. */
export const REPORTED = ['memories', 'entities', 'memory_edges', 'drift_anchors'] as const;
const SIDECARS = ['-wal', '-shm', '-journal'] as const;

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

/** Which steps migrate.ts runs from schema `v` (for the report). */
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

/** size + mtime of memory.db and every sidecar (absent = null). Plain stat, no SQLite. */
function liveState(path: string): string {
  return JSON.stringify(['', ...SIDECARS].map((ext) => {
    try { const s = statSync(path + ext); return [ext, s.size, s.mtimeMs]; } catch { return [ext, null]; }
  }));
}

/** Header byte 18 = 2 means WAL mode (read with fs, not SQLite). */
function isWalFile(path: string): boolean {
  const fd = openSync(path, 'r');
  try { const b = Buffer.alloc(20); readSync(fd, b, 0, 20, 0); return b[18] === 2; } finally { closeSync(fd); }
}

export function migrateLegacy(o: MigrateLegacyOpts): MigrateLegacyResult {
  const log = o.log ?? ((l: string) => console.log(l));
  const path = resolve(o.dbPath);
  const name = basename(path);
  const target = currentSchemaVersion();
  const step = (s: string, db: Database.Database) => o.onStep?.(s, db);

  if (!existsSync(path)) {
    log(`No memory.db at ${path} — nothing to migrate.`);
    return { code: 0, outcome: 'missing' };
  }
  const stamp = stampOf(o.now ?? new Date());
  const backupDir = `${path}.pre-migrate-${stamp}`;
  const work = o.dry ? mkdtempSync(join(tmpdir(), 'linksee-migrate-dry-')) : `${path}.migrating-${stamp}`;
  if (!o.dry) {
    if (existsSync(work) || existsSync(backupDir)) {
      log(`${existsSync(work) ? work : backupDir} already exists; run again in a second. Nothing was changed.`);
      return { code: 1, outcome: 'refused' };
    }
    mkdirSync(work);
  }
  const conns: Database.Database[] = [];
  const open = (p: string) => { const d = new Database(p, { fileMustExist: true, timeout: 0 }); conns.push(d); return d; };
  const closeAll = () => { for (const d of conns.splice(0)) { try { if (d.open) d.close(); } catch { /* ignore */ } } };
  const state0 = liveState(path);
  /** Say "unchanged" only when it is checked to be true. */
  const liveNote = () => (liveState(path) === state0
    ? `${name} and its -wal / -shm / -journal were not changed (all work happened on a copy, now removed).`
    : `${name} or a sidecar changed during the run — another client is probably using it. This command did not write to them.`);
  const tag = o.dry ? '[dry] ' : '';

  try {
    // 1. byte copy, no SQLite on the live files
    const raw = join(work, 'raw.db');
    for (const ext of ['', '-wal', '-journal']) {
      if (existsSync(path + ext)) copyFileSync(path + ext, raw + ext, fsc.COPYFILE_EXCL);
    }
    if (liveState(path) !== state0) {
      log(`${name} changed while it was being copied: another client is writing to it. Close every Claude Code / Cursor / other client using linksee-memory and run again. Nothing was changed.`);
      return { code: 1, outcome: 'refused' };
    }

    // 2. recover and read the copy
    const hadJournal = existsSync(raw + '-journal') && statSync(raw + '-journal').size > 0;
    let rdb!: Database.Database; let from!: number;
    try {
      rdb = open(raw);
      from = readSchemaVersion(rdb);
    } catch (e) {
      log(`${path} could not be read as a SQLite database (${(e as { code?: string })?.code ?? (e as Error)?.message}). ${liveNote()}`);
      return { code: 1, outcome: 'refused' };
    }
    const recovered = hadJournal && !(existsSync(raw + '-journal') && statSync(raw + '-journal').size > 0);
    if (from === 0) {
      log(`${path} has no schema_version: not a linksee-memory database this command knows. ${liveNote()}`);
      return { code: 1, outcome: 'refused' };
    }
    if (from >= MIN_SUPPORTED_SCHEMA && !recovered) {
      log(`${path} is at schema ${from}: migrate is not needed (the server migrates schema ${MIN_SUPPORTED_SCHEMA} and newer itself). Nothing was changed.`);
      return { code: 0, outcome: 'not-needed', from };
    }
    const ic0 = rdb.pragma('integrity_check', { simple: true });
    if (ic0 !== 'ok') {
      log(`integrity_check on a copy of ${name} returned ${String(ic0)}: the file is damaged, so it is not migrated. ${liveNote()}`);
      return { code: 1, outcome: 'refused', from };
    }
    const before = rowCounts(rdb);
    if (recovered) log(`${tag}The copy had an unfinished write (a hot -journal); SQLite rolled it back in the copy.`);

    // 3. single-file replica + check
    const replica = join(work, 'replica.db');
    try {
      step('vacuum-into', rdb);
      rdb.exec(`VACUUM INTO '${replica.replace(/'/g, "''")}'`);
    } catch (e) {
      log(`Making a clean copy failed (${(e as Error)?.message ?? e}). ${liveNote()}`);
      return { code: 1, outcome: 'failed', from };
    }
    rdb.close();
    const rep = open(replica);
    try {
      rep.pragma('journal_mode = DELETE'); // the replica stays one file; the server switches to WAL on start
      rep.pragma('foreign_keys = ON');
      step('verify-replica', rep);
      const ic = rep.pragma('integrity_check', { simple: true });
      if (ic !== 'ok') throw new Error(`integrity_check returned ${String(ic)}`);
      if (readSchemaVersion(rep) !== from) throw new Error('schema version differs from the original');
      if (JSON.stringify(rowCounts(rep)) !== JSON.stringify(before)) throw new Error('row counts differ from the original');
    } catch (e) {
      log(`The clean copy did not match the original (${(e as Error)?.message ?? e}). ${liveNote()}`);
      return { code: 1, outcome: 'failed', from };
    }

    // 4. migrate the replica in one transaction
    let after: Record<string, number> = before;
    if (from < MIN_SUPPORTED_SCHEMA) {
      try {
        rep.exec('BEGIN IMMEDIATE');
        runMigrations(rep, { allowLegacy: true, mergeDuplicateEntities: false, onStep: o.onStep });
        after = rowCounts(rep);
        const lost = Object.keys(before).filter((t) => (after[t] ?? -1) < before[t]);
        const to = readSchemaVersion(rep);
        const qc = rep.pragma('quick_check', { simple: true });
        if (lost.length) throw new Error(`rows would be lost in: ${lost.map((t) => `${t} ${before[t]}→${after[t] ?? 'gone'}`).join(', ')}`);
        if (to !== target) throw new Error(`schema ended at ${to}, expected ${target}`);
        if (qc !== 'ok') throw new Error(`quick_check returned ${String(qc)}`);
        step('commit', rep);
        rep.exec('COMMIT');
      } catch (e) {
        let rb = '';
        if (rep.inTransaction) { try { rep.exec('ROLLBACK'); rb = ' (rolled back in the copy)'; } catch { rb = ''; } }
        log(`Migration failed${rb}: ${(e as Error)?.message ?? e}`);
        log(liveNote());
        return { code: 1, outcome: 'failed', before, from };
      }
      const fk = rep.pragma('foreign_key_check') as unknown[];
      if (fk.length) log(`${tag}note: foreign_key_check lists ${fk.length} row(s) that were already orphaned before; kept as they are.`);
    }
    rep.close();

    const outcome = from < MIN_SUPPORTED_SCHEMA ? 'migrated' : 'recovered';
    const report = () => {
      for (const t of REPORTED) log(`  ${t.padEnd(14)} ${shown(before, t).padStart(8)} → ${shown(after, t)}`);
    };
    if (o.dry) {
      log(`[dry] ${path}: schema ${from}. Rehearsed on a temporary copy — nothing was written next to ${name}.`);
      if (from < MIN_SUPPORTED_SCHEMA) {
        log(`[dry] steps (one transaction, rolled back on any failure):`);
        for (const s of planFor(from, 'drift_anchors' in before)) log(`        • ${s}`);
        log(`[dry] rehearsal: schema ${from} → ${target}, no rows lost:`);
      }
      report();
      log(`[dry] a real run would move ${name} and its sidecars into ${backupDir}/ and put the migrated copy in its place.`);
      log(`[dry] liveness: ${liveState(path) === state0 ? 'live files unchanged' : 'live files CHANGED during the rehearsal (a client is using them)'}.`);
      return { code: 0, outcome: 'dry', before, after, from, to: from < MIN_SUPPORTED_SCHEMA ? target : from };
    }

    // 5. swap
    if (liveState(path) !== state0) {
      log(`${name} changed while the copy was being migrated: another client is using it. Close every client using linksee-memory and run again. Not swapped; ${name} was not changed by this command.`);
      return { code: 1, outcome: 'refused', from };
    }
    // Writer probe for rollback-journal files without a journal: BEGIN IMMEDIATE takes RESERVED
    // and fails if another connection holds it; nothing is written (no page changes → no journal).
    // Skipped for WAL files and when a -journal exists (opening those for writing changes them).
    if (!existsSync(path + '-wal') && !existsSync(path + '-journal') && !isWalFile(path)) {
      const p = new Database(path, { fileMustExist: true, timeout: 0 });
      try { p.exec('BEGIN IMMEDIATE'); p.exec('ROLLBACK'); } catch (e) {
        p.close();
        log(`Another client holds ${name} (${(e as { code?: string })?.code ?? (e as Error)?.message}). Close every client using linksee-memory and run again. Not swapped; ${liveNote()}`);
        return { code: 1, outcome: 'refused', from };
      }
      p.close();
      if (liveState(path) !== state0) {
        log(`${name} changed during the final check. Not swapped. Run again with every client closed.`);
        return { code: 1, outcome: 'refused', from };
      }
    }
    mkdirSync(backupDir);
    const done: string[] = [];
    const putBack = () => {
      const stuck: string[] = [];
      for (const ext of done.reverse()) {
        try { renameSync(join(backupDir, name + ext), path + ext); } catch { stuck.push(name + ext); }
      }
      if (stuck.length === 0) { try { rmdirSync(backupDir); } catch { /* leave the empty folder */ } }
      return stuck;
    };
    try {
      for (const ext of ['', ...SIDECARS]) {
        if (!existsSync(path + ext)) continue;
        renameSync(path + ext, join(backupDir, name + ext));
        done.push(ext);
      }
      renameSync(replica, path);
    } catch (e) {
      const stuck = putBack();
      log(`Could not swap the files (${(e as { code?: string })?.code ?? (e as Error)?.message}) — on Windows this means another process has ${name} open.`);
      if (stuck.length) log(`  Could not move back: ${stuck.join(', ')} — they are in ${backupDir}; move them back to ${dirname(path)} by hand.`);
      else log(`  Everything was moved back. Close every client using linksee-memory and run again.`);
      return { code: 1, outcome: 'failed', from };
    }

    log(from < MIN_SUPPORTED_SCHEMA ? `Migrated ${path}: schema ${from} → ${target}.` : `Recovered ${path} (schema ${from}): the unfinished write was rolled back.`);
    report();
    log(`The original files, byte for byte, are in ${backupDir}/. To go back: close every client, move ${name} out of the way, and move the files from that folder back.`);
    log(`Nothing was consolidated or deleted. The server switches the file to WAL on its next start.`);
    return { code: 0, outcome, backupDir, before, after, from, to: from < MIN_SUPPORTED_SCHEMA ? target : from };
  } finally {
    closeAll();
    // Whatever happened, the work folder goes (after a swap only the raw copies are left in it).
    try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function usage(): string {
  return `Usage: ${migrateCommand()} [--dry] [--db <path to memory.db>]

Migrates a memory.db at schema 1–5 (linksee-memory 0.11 and earlier) to the current schema.
  --dry   rehearse on a temporary copy; nothing is written next to memory.db
  --db    a memory.db other than ${getDbPath()}
It migrates a copy, checks it (no table loses rows, integrity ok), and only then moves the
original files into memory.db.pre-migrate-<time>/ and the migrated copy into place.
Close Claude Code / Cursor / other clients using linksee-memory before running it.`;
}

function main(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(usage()); return 0; }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') { i++; continue; }
    if (argv[i] !== '--dry') { console.error(`Unknown argument: ${argv[i]}\n\n${usage()}`); return 1; }
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
