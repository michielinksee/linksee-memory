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

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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

// 1. schema 5 → refused before ANY write: memory.db byte-identical, no -wal/-shm created
{
  const dir = mkdtempSync(join(tmpdir(), 'linksee-legacy-v5-'));
  dirs.push(dir);
  const file = join(dir, 'memory.db');
  // build the fixture with plain better-sqlite3 in the default rollback-journal mode, as an old
  // install may have left it — so any write (including a journal-mode switch) changes the bytes
  const raw = new Database(file);
  raw.exec(fixture(5));
  raw.prepare(`INSERT INTO entities (name, kind) VALUES ('proj', 'project')`).run();
  raw.prepare(`INSERT INTO memories (entity_id, layer, content, importance) VALUES (1, 'learning', '{"what":"keep me","why":"the reason"}', 0.8)`).run();
  raw.close();
  const before = sha(file);
  const filesBefore = readdirSync(dir).sort().join(',');

  process.env.LINKSEE_MEMORY_DIR = dir;
  const mod = await import(`../dist/db/migrate.js?dir=${encodeURIComponent(dir)}`);
  let err = null;
  try { mod.openDb(); } catch (e) { err = e; }
  check('schema 5: openDb throws LegacySchemaError', err instanceof mod.LegacySchemaError, String(err));
  check('schema 5: error carries the version', err?.schemaVersion === 5);
  check('schema 5: message says back up and that nothing was written', /Back up/.test(err?.message ?? '') && /before writing anything/.test(err?.message ?? ''));
  check('schema 5: message recommends no other version', !/linksee-memory@\d/.test(err?.message ?? ''), err?.message);
  check('schema 5: memory.db byte-identical after openDb', sha(file) === before);
  check('schema 5: no -wal / -shm / journal files created', readdirSync(dir).sort().join(',') === filesBefore, readdirSync(dir).join(','));

  // runMigrations on a caller-supplied connection also refuses (second line)
  const conn = new Database(file, { readonly: true });
  let err2 = null;
  try { mod.runMigrations(conn); } catch (e) { err2 = e; }
  conn.close();
  check('schema 5: runMigrations refuses too', err2 instanceof mod.LegacySchemaError, String(err2));

  // the MCP server prints the message and exits non-zero instead of a stack trace, file untouched
  const r = spawnSync(process.execPath, [SERVER], {
    input: '', encoding: 'utf8', timeout: 20000,
    env: { ...process.env, LINKSEE_MEMORY_DIR: dir, LINKSEE_TELEMETRY: 'off' },
  });
  check('schema 5: server exits 1', r.status === 1, `exit ${r.status}`);
  check('schema 5: server stderr has the message, no stack trace', /Back up/.test(r.stderr) && !/\n\s+at /.test(r.stderr), r.stderr.slice(0, 300));
  check('schema 5: memory.db byte-identical after the server refused', sha(file) === before);
  check('schema 5: still no extra files after the server', readdirSync(dir).sort().join(',') === filesBefore, readdirSync(dir).join(','));
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
