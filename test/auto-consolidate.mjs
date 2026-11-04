#!/usr/bin/env node
// Regression: the MCP server must not consolidate (= delete originals) on its own (L-1-106 / audit F1).
//
// Up to 0.17.0 the server ran consolidate 3 s after every start (weekly gate). consolidate keeps
// a 3 × 200-char summary, ignores thread_id and deletes the original rows and their edges — the
// reasons a hand-over needs, lost without the user doing anything. 0.17.1: off unless
// LINKSEE_AUTO_CONSOLIDATE=1 or `--auto-consolidate`.
//
// Starts the real server against a throwaway DB seeded with rows consolidate would take, waits
// past the 3 s timer, and checks nothing was deleted. Then turns the opt-in on to prove the rows
// were real candidates (so the first half is not passing vacuously).
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

const errOff = await runServerFor(5000);
const afterOff = countRows();
check('server start (default): originals kept', afterOff.context === 3, JSON.stringify(afterOff));
check('server start (default): no consolidation recorded', afterOff.consolidations === 0, JSON.stringify(afterOff));
check('server start (default): no auto-consolidate log line', !/auto-consolidate complete/.test(errOff));

const errOn = await runServerFor(5000, { LINKSEE_AUTO_CONSOLIDATE: '1' });
const afterOn = countRows();
check('opt-in: the seeded rows were real candidates (consolidated)', afterOn.consolidations >= 1 && afterOn.context < 3, `${JSON.stringify(afterOn)} ${errOn.slice(0, 200)}`);

try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
