#!/usr/bin/env node
// Regression: the MCP server must not consolidate on its own (L-1-106 / audit F1), and when it
// is asked to (0.18.1) it must not delete.
//
// Up to 0.18.0 the server's consolidate deleted the original rows and their edges and then swept
// every other cold row — the reasons a hand-over needs, lost without the user doing anything.
// 0.17.1 / 0.18.1: off unless LINKSEE_AUTO_CONSOLIDATE=1 or `--auto-consolidate`; when off, one
// stderr line says how many rows a run would fold. 0.18.1: a run marks rows (consolidated_into)
// and deletes nothing.
//
// Starts the real server against a throwaway DB seeded with rows consolidate would take, waits
// past the 3 s timer, and checks nothing changed. Then turns the opt-in on to prove the rows
// were real candidates (so the first half is not passing vacuously) — and that they survived.
//
// Run: node test/auto-consolidate.mjs   (needs `pnpm build`; throwaway DB)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'mcp', 'server.js');
const dir = mkdtempSync(join(tmpdir(), 'linksee-autocons-'));
process.env.LINKSEE_MEMORY_DIR = dir;

const { openDb, runMigrations } = await import('../dist/db/migrate.js');
const { autoConsolidateEnabled } = await import('../dist/lib/consolidate.js');

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); failures++; }
};
console.log('auto-consolidate regression');

// the switch
check('default: off', !autoConsolidateEnabled({}, []));
check('LINKSEE_AUTO_CONSOLIDATE=1: on', autoConsolidateEnabled({ LINKSEE_AUTO_CONSOLIDATE: '1' }, []));
check('LINKSEE_AUTO_CONSOLIDATE=0: off', !autoConsolidateEnabled({ LINKSEE_AUTO_CONSOLIDATE: '0' }, []));
check('--auto-consolidate: on', autoConsolidateEnabled({}, ['--auto-consolidate']));

// seed: 3 cold, old, unprotected context rows on one entity — a cluster consolidate would merge
{
  const db = openDb();
  runMigrations(db);
  const entity = Number(db.prepare(`INSERT INTO entities (name, kind, normalized_name) VALUES ('proj', 'project', 'proj')`).run().lastInsertRowid);
  const old = Math.floor(Date.now() / 1000) - 60 * 86400;
  for (const what of ['why we chose sqlite', 'why WAL', 'why one file']) {
    db.prepare(
      `INSERT INTO memories (entity_id, layer, content, importance, protected, access_count, created_at, last_accessed_at)
       VALUES (?, 'context', ?, 0.3, 0, 0, ?, ?)`,
    ).run(entity, JSON.stringify({ what, why: 'reason that must survive' }), old, old);
  }
  db.close();
}

function contents() {
  const db = openDb();
  const rows = db.prepare(`SELECT content FROM memories WHERE layer = 'context' ORDER BY id`).all().map((r) => JSON.parse(r.content));
  db.close();
  return rows;
}
const seededContents = contents();

function countRows() {
  const db = openDb();
  const m = db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE layer = 'context'`).get().c;
  const c = db.prepare(`SELECT COUNT(*) AS c FROM consolidations`).get().c;
  db.close();
  return { context: m, consolidations: c };
}

function runServerFor(ms, extraEnv = {}, args = []) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SERVER, ...args], {
      env: { ...process.env, LINKSEE_MEMORY_DIR: dir, LINKSEE_TELEMETRY: 'off', LINKSEE_AUTO_CONSOLIDATE: '', ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    setTimeout(() => { p.stdin.end(); p.kill(); }, ms);
    p.on('exit', () => resolve(err));
  });
}

const before = countRows();
check('seeded 3 candidate rows', before.context === 3, JSON.stringify(before));

const errOff = await runServerFor(7000);
const afterOff = countRows();
check('server start (default): originals kept', afterOff.context === 3, JSON.stringify(afterOff));
check('server start (default): no consolidation recorded', afterOff.consolidations === 0, JSON.stringify(afterOff));
check('server start (default): no auto-consolidate log line', !/auto-consolidate complete/.test(errOff));
check('server start (default): stderr says it is off and how many rows would fold', /auto-consolidate is off \(set LINKSEE_AUTO_CONSOLIDATE=1 to enable\); 3 cold memories would be folded/.test(errOff), errOff.slice(0, 300));
check('server start (default): originals byte-identical', JSON.stringify(contents()) === JSON.stringify(seededContents));

const errOn = await runServerFor(9000, { LINKSEE_AUTO_CONSOLIDATE: "1" }); // 3 s timer + the run; generous for a loaded CI box
const afterOn = countRows();
check('opt-in: the seeded rows were real candidates (consolidation recorded)', afterOn.consolidations >= 1, `${JSON.stringify(afterOn)} ${errOn.slice(0, 200)}`);
check('opt-in: the originals are still there (0.18.1: marked, not deleted)', afterOn.context === 3, JSON.stringify(afterOn));
check('opt-in: each original carries consolidated_into and its reason', contents().every((c) => typeof c.consolidated_into === 'number' && c.why === 'reason that must survive'), JSON.stringify(contents()));
check('opt-in: log line reports 0 deleted', /0 deleted/.test(errOn), errOn.slice(0, 300));

try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
