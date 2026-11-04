#!/usr/bin/env node
// linksee-memory migrate — bring a schema 1–5 memory.db (0.11 and earlier, up to May 2026) to the
// current schema, by hand, without starting the server (0.17.2, L-1-068 / L-1-122).
//
//   npx -y linksee-memory@<version> migrate --dry   # full rehearsal on a temporary copy
//   npx -y linksee-memory@<version> migrate         # migrate a copy, then swap it in
//
// EVERY CLIENT MUST BE CLOSED FOR THE WHOLE RUN. Nothing here is a lock: size/mtime checks and the
// writer probe below only catch a client that is visibly active. A WAL-mode file is never probed,
// so an idle client that keeps it open is detected only on Windows (the rename is refused).
//
// The live files (memory.db and its -wal / -shm / -journal) are not written by this command until
// the final swap (Codex review of #19: a writable connection on them recovers a hot journal on
// open and checkpoints a WAL on close). One exception, which writes nothing: step 5's probe.
//
//   0. free space where the work happens must be >= 3 x (memory.db + sidecars); unknown -> stop.
//   1. copy memory.db, -wal, -journal byte for byte into <memory.db>.migrating-<ts>-<pid>/ (plain
//      file copy, no SQLite). If any live file's size or mtime changed during the copy -> stop.
//   2. open the COPY: SQLite recovers it (rolls back a hot journal / reads the WAL) there.
//      Read its schema; integrity_check must be ok. schema >= 6 -> "not needed" (unless the copy
//      had an unfinished write to roll back - then it is recovered and swapped like a migration).
//   3. VACUUM INTO a single-file replica; check it: integrity_check ok, same schema, same rows.
//   4. migrate the replica in one transaction (migrate.ts steps 5->6->...->16). Commit only if no
//      table lost rows, schema = current, quick_check = ok. Any failure -> stop; the live files
//      were not written to.
//   5. swap: live size + mtime unchanged since step 1; for a rollback-journal file with no -journal
//      / -wal, a writable connection tries BEGIN IMMEDIATE then ROLLBACK (writes nothing; fails if
//      another connection holds a write lock) and is closed again. Then <memory.db>.pre-migrate-<ts>/
//      is created with a README.txt, memory.db and its sidecars are renamed into it (the backup,
//      byte for byte, one set) and the replica is renamed into place. If a rename fails it tries to
//      put back what was already moved and names anything it could not.
//   The work folder is removed at the end; if that fails it says so.
// It never starts the server, consolidates, merges duplicate entities or deletes rows.

import Database from 'better-sqlite3';
import {
  closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync,
  readdirSync, rmdirSync, statSync, statfsSync, writeFileSync, constants as fsc,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getDbPath, readSchemaVersion, runMigrations, MIN_SUPPORTED_SCHEMA, DbRefusedError, migrateCommand } from '../db/migrate.js';
import { isNativeLoadError, NATIVE_HINT } from '../lib/native-hint.js';
import { renameGuarded, rmGuarded } from '../lib/test-faults.js';

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
  /** Set when the work folder could not be removed. */
  workLeft?: string;
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

/** How to go back to a backup set - always as one set, never mixing generations. */
export function restoreSteps(path: string, backupDir: string): string[] {
  const name = basename(path);
  return [
    `To go back to the files in ${backupDir}/:`,
    `  1. Close every Claude Code / Cursor / Codex / other client using linksee-memory.`,
    `  2. Move the CURRENT ${name} and every ${name}-wal / ${name}-shm / ${name}-journal next to it into a new, separate folder, all of them together, as one set.`,
    `  3. Move ALL the files from ${backupDir}/ (${name} and any -wal / -shm / -journal) back to ${dirname(path)}, as one set.`,
    `  Never combine a ${name} from one set with a -wal / -shm / -journal from the other: SQLite would read them as one database and can corrupt it.`,
  ];
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
  const ctx: { work?: string } = {};
  let r: MigrateLegacyResult | undefined;
  try {
    r = migrateInner(o, log, ctx);
    return r;
  } finally {
    // The work folder goes in every case, also when migrateInner threw (after a swap only the raw
    // copies are left in it). If it cannot be removed, say so.
    if (ctx.work && existsSync(ctx.work)) {
      try { rmGuarded(ctx.work, { recursive: true, force: true }); } catch (e) {
        log(`Could not remove the work folder ${ctx.work} (${(e as Error)?.message ?? e}); delete it by hand. It holds copies only.`);
      }
      if (existsSync(ctx.work) && r) r.workLeft = ctx.work;
    }
  }
}

function migrateInner(o: MigrateLegacyOpts, log: (l: string) => void, ctx: { work?: string }): MigrateLegacyResult {
  const path = resolve(o.dbPath);
  const name = basename(path);
  const target = currentSchemaVersion();
  const step = (s: string, db: Database.Database) => o.onStep?.(s, db);

  if (!existsSync(path)) {
    // A run killed during the swap can leave memory.db inside a backup folder: say so, do not say "nothing".
    let left: string[] = [];
    try { left = readdirSync(dirname(path)).filter((f) => f.startsWith(`${name}.pre-migrate-`)); } catch { /* none visible */ }
    if (left.length) {
      log(`No ${name} at ${path}, but ${left.map((f) => join(dirname(path), f)).join(', ')} exists — an earlier migrate may have stopped half-way. Read README.txt there (if any) and check which original files are in it before doing anything else.`);
      return { code: 1, outcome: 'refused' };
    }
    log(`No memory.db at ${path} — nothing to migrate.`);
    return { code: 0, outcome: 'missing' };
  }
  const stamp = stampOf(o.now ?? new Date());
  // 0. free space: the raw copy and the replica each need about the size of the live set.
  const liveBytes = ['', ...SIDECARS].reduce((n, ext) => { try { return n + statSync(path + ext).size; } catch { return n; } }, 0);
  const workParent = o.dry ? tmpdir() : dirname(path);
  try {
    const fs = statfsSync(workParent);
    const free = Number(fs.bavail) * Number(fs.bsize);
    if (free < 3 * liveBytes) {
      log(`Not enough free space in ${workParent}: ${Math.round(free / 1048576)} MB free, need at least ${Math.ceil((3 * liveBytes) / 1048576)} MB (3 x ${name} and its sidecars). This command did not write to ${path}.`);
      return { code: 1, outcome: 'refused' };
    }
  } catch (e) {
    log(`Could not check the free space in ${workParent} (${(e as Error)?.message ?? e}). This command did not write to ${path}.`);
    return { code: 1, outcome: 'refused' };
  }
  const backupDir = `${path}.pre-migrate-${stamp}`;
  // The work folder name carries the pid so two runs never share it; the backup folder name is
  // checked only at the swap (a run that ends "not needed" must not be refused by an earlier backup).
  const work = o.dry ? mkdtempSync(join(tmpdir(), 'linksee-migrate-dry-')) : `${path}.migrating-${stamp}-${process.pid}`;
  if (!o.dry) {
    if (existsSync(work)) {
      log(`${work} already exists; run again in a second. This command did not write to ${path}.`);
      return { code: 1, outcome: 'refused' };
    }
    mkdirSync(work);
  }
  ctx.work = work;
  const conns: Database.Database[] = [];
  const open = (p: string) => { const d = new Database(p, { fileMustExist: true, timeout: 0 }); conns.push(d); return d; };
  const closeAll = () => { for (const d of conns.splice(0)) { try { if (d.open) d.close(); } catch { /* ignore */ } } };
  const state0 = liveState(path);
  /** Say "unchanged" only when it is checked to be true. */
  const liveNote = () => (liveState(path) === state0
    ? `This command did not write to ${path} or its -wal / -shm / -journal (the work happened on a copy in ${work}).`
    : `This command did not write to ${path} or its sidecars, but they changed during the run: another client is using them.`);
  const tag = o.dry ? '[dry] ' : '';

  try {
    // 1. byte copy, no SQLite on the live files
    const raw = join(work, 'raw.db');
    for (const ext of ['', '-wal', '-journal']) {
      if (existsSync(path + ext)) copyFileSync(path + ext, raw + ext, fsc.COPYFILE_EXCL);
    }
    if (liveState(path) !== state0) {
      log(`${name} changed while it was being copied: another client is writing to it. Close every Claude Code / Cursor / other client using linksee-memory and run again. This command did not write to ${path}.`);
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
      log(`${path} is at schema ${from}: migrate is not needed (the server migrates schema ${MIN_SUPPORTED_SCHEMA} and newer itself). This command did not write to ${path}.`);
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
    // The swap. Where every original file is, is tracked file by file, so a failure can say exactly
    // what to move where (Codex third review of #19: a fixed "move the current set aside, restore
    // the backup set" text would split a set that is half here, half there).
    const readme = join(backupDir, 'README.txt');
    const originals = ['', ...SIDECARS].filter((ext) => existsSync(path + ext)).map((ext) => name + ext);
    const where: Record<string, 'live' | 'backup'> = Object.fromEntries(originals.map((f) => [f, 'live']));
    let created = false; // only a folder this run created may be removed again
    try {
      mkdirSync(backupDir);
      created = true;
    } catch (e) {
      log(`Could not create ${backupDir} (${(e as { code?: string })?.code ?? (e as Error)?.message}); run again in a second. Not swapped; ${liveNote()}`);
      return { code: 1, outcome: 'refused', from };
    }
    const writeReadme = (lines: string[]) => {
      try { writeFileSync(readme, lines.join('\n') + '\n'); return true; } catch (e) {
        log(`  (could not write ${readme}: ${(e as Error)?.message ?? e})`);
        return false;
      }
    };
    try {
      for (const f of originals) {
        renameGuarded(join(dirname(path), f), join(backupDir, f));
        where[f] = 'backup';
      }
      renameGuarded(replica, path);
    } catch (e) {
      log(`Could not swap the files (${(e as { code?: string })?.code ?? (e as Error)?.message}); on Windows this usually means another process has ${name} open.`);
      // put back, newest first; record each result
      for (const f of originals.slice().reverse()) {
        if (where[f] !== 'backup') continue;
        try { renameGuarded(join(backupDir, f), join(dirname(path), f)); where[f] = 'live'; } catch { /* stays in backup */ }
      }
      const stuck = originals.filter((f) => where[f] === 'backup');
      if (stuck.length === 0) {
        try { rmdirSync(backupDir); } catch { /* empty folder left; harmless */ }
        log(`  Every original file was moved back: ${originals.join(', ')}. Close every client using linksee-memory and run again.`);
        return { code: 1, outcome: 'failed', from };
      }
      const table = originals.map((f) => `    ${f.padEnd(name.length + 9)} ${where[f] === 'live' ? `in ${dirname(path)} (in place)` : `in ${backupDir}/`}`);
      const moves = stuck.map((f) => `    move ${join(backupDir, f)} → ${join(dirname(path), f)}`);
      const body = [
        `This migration FAILED during the swap. The original files (one set, unchanged) are now split:`,
        ...table,
        `The migrated copy was NOT put in place. To put the original set back together, with every client closed:`,
        ...moves,
        `Move exactly these and nothing else. Do not move ${originals.filter((f) => where[f] === 'live').join(', ') || 'anything else'} — those are already in place.`,
        `Do not open linksee-memory before this is done: ${name} is missing or incomplete without them.`,
      ];
      for (const l of body) log(`  ${l}`);
      writeReadme([`linksee-memory migrate (${stamp})`, '', ...body]);
      return { code: 1, outcome: 'failed', from };
    }

    log(from < MIN_SUPPORTED_SCHEMA ? `Migrated ${path}: schema ${from} → ${target}.` : `Recovered ${path} (schema ${from}): the unfinished write was rolled back.`);
    report();
    log(`The original files, byte for byte and as one set, are in ${backupDir}/ (see README.txt there).`);
    for (const l of restoreSteps(path, backupDir)) log(l);
    writeReadme([
      `linksee-memory migrate (${stamp}) moved the original files here, unchanged, as one set:`,
      `  ${originals.join(', ')} (from ${dirname(path)})`,
      `They were at schema ${from}; the migrated database (schema ${from < MIN_SUPPORTED_SCHEMA ? target : from}) took their place.`,
      '',
      ...restoreSteps(path, backupDir),
    ]);
    log(`Nothing was consolidated or deleted. The server switches the file to WAL on its next start.`);
    return { code: 0, outcome, backupDir, before, after, from, to: from < MIN_SUPPORTED_SCHEMA ? target : from };
  } finally {
    closeAll(); // the work folder itself is removed by migrateLegacy()
  }
}

function usage(): string {
  return `Usage: ${migrateCommand()} [--dry] [--db <path to memory.db>]

Migrates a memory.db at schema 1–5 (linksee-memory 0.11 and earlier) to the current schema.
  --dry   rehearse on a temporary copy; nothing is written next to memory.db
  --db    a memory.db other than ${getDbPath()}
Close every Claude Code / Cursor / Codex / other client using linksee-memory first, and keep them
closed until it finishes: an idle client on a WAL-mode file cannot be detected (except on Windows).
It migrates a copy, checks it (no table loses rows, integrity ok), and only then moves the
original files into memory.db.pre-migrate-<time>/ (with a README.txt) and the migrated copy into place.`;
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
