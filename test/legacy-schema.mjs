#!/usr/bin/env node
// Regression: old memory.db files (L-1-106 / audit F3).
//
//  • schema 6–8 (before drift_anchors existed): 0.8.0–0.17.0 ALTERed drift_anchors before
//    creating it and stopped with "no such table". 0.17.1 skips the ALTER when the table is
//    missing and lets schema.sql create it whole.
//  • schema 1–5: refused BEFORE any write, with the recovery steps in the error message
//    (a safe direct migration is 0.17.2 work).
//
// Fixtures are the real schema.sql files from git at schema 5 (e9ca469^) and schema 7 (c4245c1^).
//
// Run: node test/legacy-schema.mjs   (needs `pnpm build`; throwaway DBs)

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'dist', 'mcp', 'server.js');
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

// 1. schema 5 → refused, nothing written
{
  const { dir, db, mod } = await dbAt(5);
  const before = snapshot(db);
  let err = null;
  try { mod.runMigrations(db); } catch (e) { err = e; }
  check('schema 5: runMigrations throws LegacySchemaError', err instanceof mod.LegacySchemaError, String(err));
  check('schema 5: error carries the version', err?.schemaVersion === 5);
  check('schema 5: message gives the recovery route', /Back up/.test(err?.message ?? '') && /linksee-memory@0\.7\.2/.test(err?.message ?? '') && /Nothing was written/.test(err?.message ?? ''));
  check('schema 5: DB unchanged (schema, columns, meta, rows)', snapshot(db) === before);
  db.close();

  // the MCP server prints the steps and exits non-zero instead of a stack trace
  const r = spawnSync(process.execPath, [SERVER], {
    input: '', encoding: 'utf8', timeout: 20000,
    env: { ...process.env, LINKSEE_MEMORY_DIR: dir, LINKSEE_TELEMETRY: 'off' },
  });
  check('schema 5: server exits 1', r.status === 1, `exit ${r.status}`);
  check('schema 5: server stderr has the steps, no stack trace', /linksee-memory@0\.7\.2/.test(r.stderr) && !/\n\s+at /.test(r.stderr), r.stderr.slice(0, 300));
  const again = mod.openDb();
  check('schema 5: still schema 5 after the server refused', version(again) === '5');
  again.close();
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
