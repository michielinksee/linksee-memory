#!/usr/bin/env node
// Regression: old memory.db files (L-1-106 / audit F3).
//
//  • schema 6–8 (before drift_anchors existed): 0.8.0–0.17.0 ALTERed drift_anchors before
//    creating it and stopped with "no such table". 0.17.1 skips the ALTER when the table is
//    missing and lets schema.sql create it whole.
//  • schema 1–5: refused BEFORE any write — the file stays byte-identical — with "back up, do
//    not open it with another version"; no old version is recommended (a migration command is 0.17.2).
//
// Fixtures are the real schema.sql files from git at schema 5 (e9ca469^) and schema 7 (c4245c1^).
//
// Run: node test/legacy-schema.mjs   (needs `pnpm build`; throwaway DBs)

import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'dist', 'mcp', 'server.js');
const Database = createRequire(import.meta.url)('better-sqlite3');
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const fixture = (v) => readFileSync(join(HERE, 'fixtures', `schema-v${v}.sql`), 'utf8');

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); failures++; }
};
console.log('legacy-schema regression');

const dirs = [];
async function dbAt(v) {
  const dir = mkdtempSync(join(tmpdir(), `linksee-legacy-v${v}-`));
  dirs.push(dir);
  process.env.LINKSEE_MEMORY_DIR = dir;
  // fresh module instance per dir: migrate.js reads LINKSEE_MEMORY_DIR at import time
  const mod = await import(`../dist/db/migrate.js?dir=${encodeURIComponent(dir)}`);
  const db = mod.openDb();
  if (v !== null) {
    db.exec(fixture(v));
    db.prepare(`INSERT INTO entities (name, kind) VALUES ('proj', 'project')`).run();
    db.prepare(`INSERT INTO memories (entity_id, layer, content, importance) VALUES (1, 'learning', '{"what":"keep me","why":"the reason"}', 0.8)`).run();
  }
  return { dir, db, mod };
}
const snapshot = (db) => JSON.stringify({
  master: db.prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`).all(),
  memXinfo: db.prepare(`PRAGMA table_xinfo(memories)`).all(),
  meta: db.prepare(`SELECT * FROM meta ORDER BY key`).all(),
  memories: db.prepare(`SELECT id, content FROM memories ORDER BY id`).all(),
  entities: db.prepare(`SELECT * FROM entities ORDER BY id`).all(),
});
const version = (db) => db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get()?.value;

// 1. schema 5 → refused before ANY write, in four on-disk states (Codex re-review of #15):
//    the check runs on a read-only connection, so a leftover WAL is not checkpointed and a hot
//    journal is not rolled back. memory.db / -wal / -journal must be byte-identical and the folder
//    listing unchanged (-shm, the shared-memory index, may be rewritten by any reader).
const MAKE = join(HERE, 'fixtures', 'make-legacy-db.cjs');
const filesOf = (dir) => readdirSync(dir).sort();
const shaAll = (dir) => Object.fromEntries(filesOf(dir).filter((f) => !f.endsWith('-shm')).map((f) => [f, sha(join(dir, f))]));
for (const state of ['rollback', 'walclean', 'wal', 'hot']) {
  const dir = mkdtempSync(join(tmpdir(), `linksee-legacy-v5-${state}-`));
  dirs.push(dir);
  const file = join(dir, 'memory.db');
  spawnSync(process.execPath, [MAKE, file, join(HERE, 'fixtures', 'schema-v5.sql'), state], { encoding: 'utf8' });
  const listBefore = filesOf(dir).join(',');
  const shaBefore = JSON.stringify(shaAll(dir));
  if (state === 'wal') check(`schema 5 [${state}]: fixture has an un-checkpointed -wal`, existsSync(file + '-wal') && statSync(file + '-wal').size > 0, listBefore);
  if (state === 'hot') check(`schema 5 [${state}]: fixture has a hot -journal`, existsSync(file + '-journal') && statSync(file + '-journal').size > 0, listBefore);

  process.env.LINKSEE_MEMORY_DIR = dir;
  const mod = await import(`../dist/db/migrate.js?dir=${encodeURIComponent(dir)}`);
  let err = null;
  try { mod.openDb(); } catch (e) { err = e; }
  const expected = state === 'hot' ? mod.HotJournalError : mod.LegacySchemaError;
  check(`schema 5 [${state}]: openDb refuses (${expected.name})`, err instanceof expected, String(err));
  check(`schema 5 [${state}]: message says back up, nothing written, no other version`,
    /Back up/.test(err?.message ?? '') && /Stopped before writing anything/.test(err?.message ?? '') && !/linksee-memory@\d/.test(err?.message ?? ''), err?.message);
  check(`schema 5 [${state}]: memory.db / -wal / -journal byte-identical after openDb`, JSON.stringify(shaAll(dir)) === shaBefore);
  check(`schema 5 [${state}]: folder listing unchanged after openDb`, filesOf(dir).join(',') === listBefore, `${listBefore} → ${filesOf(dir).join(',')}`);

  const r = spawnSync(process.execPath, [SERVER], {
    input: '', encoding: 'utf8', timeout: 20000,
    env: { ...process.env, LINKSEE_MEMORY_DIR: dir, LINKSEE_TELEMETRY: 'off' },
  });
  check(`schema 5 [${state}]: server exits 1 with the message, no stack trace`, r.status === 1 && /Back up/.test(r.stderr) && !/\n\s+at /.test(r.stderr), `exit ${r.status} ${r.stderr.slice(0, 200)}`);
  check(`schema 5 [${state}]: byte-identical and same listing after the server`, JSON.stringify(shaAll(dir)) === shaBefore && filesOf(dir).join(',') === listBefore, filesOf(dir).join(','));

  if (state === 'rollback') {
    const conn = new Database(file, { readonly: true });
    let err2 = null;
    try { mod.runMigrations(conn); } catch (e) { err2 = e; }
    conn.close();
    check('schema 5: runMigrations on a caller-supplied connection refuses too', err2 instanceof mod.LegacySchemaError, String(err2));
  }
}

// 2. schema 7 (no drift_anchors) → migrates to current, rows kept
{
  const { db, mod } = await dbAt(7);
  let err = null;
  try { mod.runMigrations(db); } catch (e) { err = e; }
  check('schema 7: migrates without error', err === null, String(err));
  check('schema 7: now at schema 16', version(db) === '16', version(db));
  const cols = new Set(db.prepare('PRAGMA table_info(drift_anchors)').all().map((c) => c.name));
  check('schema 7: drift_anchors created with the v9 columns', ['node_type', 'lifecycle', 'owner', 'last_confirmed_at'].every((c) => cols.has(c)));
  const m = db.prepare('SELECT content FROM memories WHERE id = 1').get();
  check('schema 7: memory kept', m && JSON.parse(m.content).why === 'the reason');
  let err2 = null;
  try { mod.runMigrations(db); } catch (e) { err2 = e; }
  check('schema 7: second run is a no-op', err2 === null && version(db) === '16');
  db.close();
}

// 3. fresh DB still fine
{
  const { db, mod } = await dbAt(null);
  mod.runMigrations(db);
  check('fresh DB: schema 16', version(db) === '16');
  db.close();
}

for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
