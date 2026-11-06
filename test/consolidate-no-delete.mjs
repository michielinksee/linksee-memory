#!/usr/bin/env node
// Regression (0.18.1): consolidate never deletes a row.
//
// Up to 0.18.0, consolidate replaced each cluster's originals with a summary and DELETEd them,
// then a forget-sweep DELETEd every other cold row (1,360 rows on 2026-10-29, 559 on 2026-11-05
// on the maintainer's DB, 11 decisions among them). 0.18.1: the summary is still written, the
// originals get `consolidated_into: <summary id>` in their content JSON and stay; nothing else
// is touched. recall hides them by default and reports `consolidated_hidden`.
//
// Covers: lib (counts, decision kept, idempotent, plain text skipped, rollback on failure),
// the MCP recall default/opt-in, and the `consolidate` subcommand (no flag → nothing; --dry-run
// writes nothing; --apply marks and deletes 0). Throwaway DB + HOME; never ~/.linksee-memory.
//
// Run: node test/consolidate-no-delete.mjs   (needs `pnpm build`)

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'linksee-consolidate-nodelete-'));
const home = join(dir, 'home');
mkdirSync(home);
const env = { ...process.env, LINKSEE_MEMORY_DIR: dir, LINKSEE_TELEMETRY: 'off', HOME: home, USERPROFILE: home, LINKSEE_AUTO_CONSOLIDATE: '' };
process.env.LINKSEE_MEMORY_DIR = dir;

const { openDb, runMigrations } = await import('../dist/db/migrate.js');
const { consolidate, planConsolidate } = await import('../dist/lib/consolidate.js');

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); failures++; }
};

const OLD = Math.floor(Date.now() / 1000) - 60 * 86400;
function seed(db, entity, layer, content, extra = {}) {
  return Number(db.prepare(
    `INSERT INTO memories (entity_id, layer, content, importance, protected, access_count, created_at, last_accessed_at)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
  ).run(entity, layer, typeof content === 'string' ? content : JSON.stringify(content), extra.importance ?? 0.3, OLD, OLD).lastInsertRowid);
}
const count = (db, where = '1=1') => db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE ${where}`).get().c;
const snapshot = (db) => db.prepare('SELECT id, content FROM memories ORDER BY id').all();

function startServer() {
  const child = spawn(process.execPath, ['dist/mcp/server.js'], { stdio: ['pipe', 'pipe', 'pipe'], env });
  child.stderr.on('data', () => {});
  let buf = '';
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.method === 'roots/list' && m.id !== undefined) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { roots: [] } }) + '\n');
        continue;
      }
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((res, rej) => {
    const my = ++id;
    const t = setTimeout(() => { pending.delete(my); rej(new Error(`timeout: ${method}`)); }, 30000);
    pending.set(my, (m) => { clearTimeout(t); res(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n');
  });
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const text = r.result?.content?.[0]?.text ?? '';
    try { return JSON.parse(text); } catch { return { _raw: text, _error: r.error }; }
  };
  const ready = (async () => {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  })();
  const stop = async () => {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  };
  return { call, ready, stop };
}

let server;
try {
  console.log('consolidate-no-delete regression (0.18.1)');

  // ── lib ────────────────────────────────────────────────────────────────────────────────
  const db = openDb();
  runMigrations(db);
  const proj = Number(db.prepare(`INSERT INTO entities (name, kind, normalized_name) VALUES ('proj-a', 'project', 'proj-a')`).run().lastInsertRowid);
  const other = Number(db.prepare(`INSERT INTO entities (name, kind, normalized_name) VALUES ('proj-b', 'project', 'proj-b')`).run().lastInsertRowid);

  // cluster A (proj-a / context): 3 JSON rows, one of them a decision
  const a1 = seed(db, proj, 'context', { altitude: 'architecture', type: 'decision', state: 'decided', what: 'use sqlite in one file', why: 'nothing leaves the machine' });
  const a2 = seed(db, proj, 'context', { altitude: 'implementation', type: 'learning', state: 'done', what: 'WAL mode on', why: 'two writers' });
  const a3 = seed(db, proj, 'context', { altitude: 'implementation', type: 'learning', state: 'done', what: 'busy timeout 5s' });
  // plain-text row in the same cluster: cannot carry the mark → skipped, untouched
  const aText = seed(db, proj, 'context', 'plain text note that is cold and old');
  // cluster B (proj-b / implementation): 2 rows
  const b1 = seed(db, other, 'implementation', { altitude: 'implementation', type: 'learning', state: 'done', what: 'b one' });
  const b2 = seed(db, other, 'implementation', { altitude: 'implementation', type: 'learning', state: 'done', what: 'b two' });
  // lone cold row (proj-b / emotion): no cluster → the old forget-sweep would have deleted it
  const lone = seed(db, other, 'emotion', { altitude: 'implementation', type: 'learning', state: 'done', what: 'lonely cold row' });
  // protected caveat and a hot row: never candidates
  const cav = Number(db.prepare(`INSERT INTO memories (entity_id, layer, content, importance, protected, created_at, last_accessed_at) VALUES (?, 'caveat', '{"what":"never again"}', 0.9, 1, ?, ?)`).run(proj, OLD, OLD).lastInsertRowid);
  const hot = Number(db.prepare(`INSERT INTO memories (entity_id, layer, content, importance, protected, access_count, created_at, last_accessed_at) VALUES (?, 'context', '{"what":"hot"}', 0.8, 0, 50, ?, ?)`).run(proj, OLD, Math.floor(Date.now() / 1000)).lastInsertRowid);

  // rows the rest of a run really updates, so the rollback tests prove more than "nothing ran":
  //   stalled: in_progress, untouched 60 days → state 'stalled'
  //   edge + superseded: two same-topic decisions, the later one "replaces" the earlier
  const stalledRow = Number(db.prepare(`INSERT INTO memories (entity_id, layer, content, importance, protected, created_at, last_accessed_at) VALUES (?, 'goal', ?, 0.5, 0, ?, ?)`).run(proj, JSON.stringify({ altitude: 'implementation', type: 'work', state: 'in_progress', what: 'migrate the billing cron' }), OLD, OLD).lastInsertRowid);
  const decOld = Number(db.prepare(`INSERT INTO memories (entity_id, layer, content, importance, protected, created_at, last_accessed_at) VALUES (?, 'learning', ?, 0.7, 0, ?, ?)`).run(other, JSON.stringify({ altitude: 'architecture', type: 'decision', state: 'decided', what: 'Use PostgreSQL database for orders service storage with replication, pgbouncer pooling and nightly backups' }), OLD - 10, OLD).lastInsertRowid);
  const decNew = Number(db.prepare(`INSERT INTO memories (entity_id, layer, content, importance, protected, created_at, last_accessed_at) VALUES (?, 'learning', ?, 0.7, 0, ?, ?)`).run(other, JSON.stringify({ altitude: 'architecture', type: 'decision', state: 'decided', what: 'Switch to SQLite database for orders service storage, replaces PostgreSQL entirely' }), OLD, OLD).lastInsertRowid);

  const before = count(db);
  const beforeRows = snapshot(db);
  check('seeded 12 rows', before === 12, String(before));

  // plan is read-only
  const plan = planConsolidate(db);
  const afterPlan = snapshot(db);
  check('plan: 2 clusters, 5 rows would fold', plan.clusters.length === 2 && plan.wouldFold === 5, JSON.stringify({ c: plan.clusters.length, f: plan.wouldFold }));
  check('plan: lone cold row counted, not acted on', plan.coldUnclustered === 1, String(plan.coldUnclustered));
  check('plan: plain-text row counted as skipped', plan.skippedPlainText === 1, String(plan.skippedPlainText));
  check('plan: writes nothing', JSON.stringify(afterPlan) === JSON.stringify(beforeRows));

  // failure paths first, INSIDE the transaction (after summaries/marks were written; after the
  // stalled sweep and edge detection): the whole run must roll back.
  // every table, every column, every row (SELECT *)
  const fullSnap = () => {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((r) => r.name);
    const out = {};
    for (const t of tables) {
      try { out[t] = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all(); }
      catch { out[t] = db.prepare(`SELECT * FROM "${t}"`).all(); }
    }
    return JSON.stringify(out, (_k, v) => (Buffer.isBuffer(v) ? v.toString('hex') : v));
  };
  const base = fullSnap();
  for (const point of ['consolidate-after-mark', 'consolidate-after-edges']) {
    process.env.LINKSEE_TEST_FAULT = point;
    let threw = false;
    try { consolidate(db); } catch (e) { threw = /injected fault/.test(String(e?.message)); }
    delete process.env.LINKSEE_TEST_FAULT;
    check(`failure at ${point}: consolidate throws the injected fault`, threw);
    check(`failure at ${point}: every table, every column identical (SELECT *)`, fullSnap() === base);
  }
  check('failure: no summary row and no consolidated_into anywhere', count(db, `source LIKE '%"origin":"consolidate"%'`) === 0 && count(db, `json_valid(content) AND json_extract(content, '$.consolidated_into') IS NOT NULL`) === 0);

  // another connection holds the write lock → BEGIN IMMEDIATE refuses; nothing written
  {
    const holder = openDb();
    holder.exec('BEGIN IMMEDIATE');
    db.pragma('busy_timeout = 200');
    let busy = false;
    try { consolidate(db); } catch { busy = true; }
    holder.exec('ROLLBACK');
    holder.close();
    check('write lock held elsewhere: consolidate refuses before reading the plan', busy);
    check('…and nothing was written', fullSnap() === base);
  }

  // the real run
  const r = consolidate(db);
  check('the fixture really exercises the rest of the run: 1 stalled, ≥1 edge, ≥1 superseded', r.stalledTransitions >= 1 && r.memoryEdgesCreated >= 1 && r.decisionsSuperseded >= 1, JSON.stringify(r));
  check('…stalled row is stalled, the older decision superseded', JSON.parse(db.prepare('SELECT content FROM memories WHERE id = ?').get(stalledRow).content).state === 'stalled' && JSON.parse(db.prepare('SELECT content FROM memories WHERE id = ?').get(decOld).content).state === 'superseded' && db.prepare('SELECT COUNT(*) c FROM memory_edges WHERE from_memory_id = ? AND to_memory_id = ?').get(decNew, decOld).c === 1);
  const after = count(db);
  check('result: 2 clusters, 5 folded, 0 dropped', r.clustersCompressed === 2 && r.memoriesFolded === 5 && r.memoriesDropped === 0, JSON.stringify(r));
  check('memories count did not go down (before + summaries == after)', after === before + r.learningIdsCreated.length, `${before} → ${after}`);
  check('every seeded row still exists', [a1, a2, a3, aText, b1, b2, lone, cav, hot].every((id) => db.prepare('SELECT 1 FROM memories WHERE id = ?').get(id)));
  const dec = db.prepare('SELECT content FROM memories WHERE id = ?').get(a1);
  const decJson = JSON.parse(dec.content);
  check('the decision row is kept, with its why', decJson.type === 'decision' && decJson.why === 'nothing leaves the machine', dec.content);
  check('the decision row is marked consolidated_into = its summary id', r.learningIdsCreated.includes(decJson.consolidated_into), String(decJson.consolidated_into));
  const txt = db.prepare('SELECT content FROM memories WHERE id = ?').get(aText).content;
  check('plain-text row untouched (byte-identical)', txt === 'plain text note that is cold and old', txt);
  const loneRow = JSON.parse(db.prepare('SELECT content FROM memories WHERE id = ?').get(lone).content);
  check('lone cold row: not deleted, not marked', loneRow.consolidated_into === undefined && loneRow.what === 'lonely cold row');
  const summary = JSON.parse(db.prepare('SELECT content FROM memories WHERE id = ?').get(r.learningIdsCreated[0]).content);
  check('summary lists the folded ids', Array.isArray(summary.folded_ids) && summary.folded_ids.length >= 2, JSON.stringify(summary.folded_ids));
  check('summary is protected learning', db.prepare(`SELECT protected, layer FROM memories WHERE id = ?`).get(r.learningIdsCreated[0]).protected === 1);
  check('audit row per cluster', db.prepare('SELECT COUNT(*) AS c FROM consolidations').get().c === 2);

  // idempotent: a second run finds nothing to fold and writes nothing
  const snap2 = snapshot(db);
  const r2 = consolidate(db);
  check('second run: nothing folded', r2.clustersCompressed === 0 && r2.memoriesFolded === 0, JSON.stringify(r2));
  check('second run: writes nothing to memories', JSON.stringify(snapshot(db)) === JSON.stringify(snap2));

  // rows the start-up triage used to archive (short, needs_distill, outside the settle window):
  // a caveat and a protected row must stay visible in the default recall after a server start.
  const triProj = Number(db.prepare(`INSERT INTO entities (name, kind, normalized_name) VALUES ('proj-c', 'project', 'proj-c')`).run().lastInsertRowid);
  const triContent = (what) => JSON.stringify({ altitude: 'implementation', type: 'decision', state: 'decided', what, needs_distill: true });
  const triCaveat = Number(db.prepare(`INSERT INTO memories (entity_id, layer, content, importance, protected, created_at, last_accessed_at) VALUES (?, 'caveat', ?, 0.7, 1, ?, ?)`).run(triProj, triContent('rmは使わない'), OLD, OLD).lastInsertRowid);
  const triPinned = Number(db.prepare(`INSERT INTO memories (entity_id, layer, content, importance, protected, created_at, last_accessed_at) VALUES (?, 'learning', ?, 0.95, 1, ?, ?)`).run(triProj, triContent('はい、本番は触らない'), OLD, OLD).lastInsertRowid);
  db.close();

  // ── MCP recall ─────────────────────────────────────────────────────────────────────────
  server = startServer();
  await server.ready;
  const rDefault = await server.call('recall', { entity_name: 'proj-a', layer: 'context', mark_accessed: false });
  const idsDefault = (rDefault.memories ?? []).map((m) => m.id);
  check('recall default: folded rows hidden', !idsDefault.includes(a1) && !idsDefault.includes(a2) && !idsDefault.includes(a3), JSON.stringify(idsDefault));
  check('recall default: plain-text and hot rows still returned', idsDefault.includes(aText) && idsDefault.includes(hot), JSON.stringify(idsDefault));
  check('recall default: consolidated_hidden = 3', rDefault.consolidated_hidden === 3, String(rDefault.consolidated_hidden));
  check('recall default: hint names include_consolidated', /include_consolidated/.test(rDefault.consolidated_hint ?? ''));

  const rAll = await server.call('recall', { entity_name: 'proj-a', layer: 'context', include_consolidated: true, mark_accessed: false });
  const idsAll = (rAll.memories ?? []).map((m) => m.id);
  check('recall include_consolidated: folded rows returned', [a1, a2, a3].every((id) => idsAll.includes(id)), JSON.stringify(idsAll));
  const shownDecision = (rAll.memories ?? []).find((m) => m.id === a1);
  check('…each carries consolidated_into (summary id)', typeof shownDecision?.consolidated_into === 'number', JSON.stringify(shownDecision));
  check('…and no consolidated_hidden count', rAll.consolidated_hidden === undefined, String(rAll.consolidated_hidden));

  const rTri = await server.call('recall', { entity_name: 'proj-c', mark_accessed: false });
  const triIds = (rTri.memories ?? []).map((m) => m.id);
  check('after server start (triage ran): the caveat is in the default recall', triIds.includes(triCaveat), JSON.stringify(rTri).slice(0, 300));
  check('after server start (triage ran): the protected row is in the default recall', triIds.includes(triPinned), JSON.stringify(triIds));

  const rQuery = await server.call('recall', { query: 'sqlite', mark_accessed: false });
  check('recall text search: the folded decision is hidden and counted', !(rQuery.memories ?? []).some((m) => m.id === a1) && rQuery.consolidated_hidden === 1, JSON.stringify({ ids: (rQuery.memories ?? []).map((m) => m.id), hidden: rQuery.consolidated_hidden }));
  await server.stop();
  server = undefined;

  // ── subcommand ────────────────────────────────────────────────────────────────────────
  const run = (args) => spawnSync(process.execPath, ['dist/mcp/server.js', 'consolidate', ...args], { env, encoding: 'utf8' });
  const dbPath = join(dir, 'memory.db');
  const bytesBefore = readFileSync(dbPath).length;
  {
    const db2 = openDb();
    // fresh cluster so --apply has work to do
    const c1 = seed(db2, other, 'context', { altitude: 'implementation', type: 'learning', state: 'done', what: 'cli one' });
    const c2 = seed(db2, other, 'context', { altitude: 'implementation', type: 'learning', state: 'done', what: 'cli two' });
    const n0 = count(db2);
    const s0 = snapshot(db2);
    db2.close();

    const none = run([]);
    check('subcommand without a flag: exit 1', none.status === 1, String(none.status));
    check('subcommand without a flag: says nothing was done', /nothing was done/.test(none.stderr), none.stderr.slice(0, 200));
    const both = run(['--dry-run', '--apply']);
    check('subcommand with both flags: exit 1', both.status === 1, String(both.status));

    const fileState = () => readdirSync(dir).filter((f) => f.startsWith('memory.db')).sort()
      .map((f) => `${f}:${createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')}`).join('|');
    const fsBefore = fileState();
    const dry = run(['--dry-run']);
    check('--dry-run: memory.db / -wal / -shm byte-identical, no file added or removed', fileState() === fsBefore, `${fsBefore}\n→ ${fileState()}`);
    check('--dry-run: exit 0', dry.status === 0, dry.stderr);
    check('--dry-run: shows what would be marked and 0 deletes', /would mark:\s+2/.test(dry.stdout) && /would delete: 0/.test(dry.stdout), dry.stdout);
    check('--dry-run: shows an example cluster', /proj-b \/ context: 2 rows/.test(dry.stdout) && /- cli one/.test(dry.stdout), dry.stdout);
    const db3 = openDb();
    check('--dry-run: writes nothing', JSON.stringify(snapshot(db3)) === JSON.stringify(s0) && count(db3) === n0);
    db3.close();

    const dryJson = run(['--dry-run', '--json']);
    let dj = null; try { dj = JSON.parse(dryJson.stdout); } catch { /* fail below */ }
    check('--dry-run --json: parses, would_delete 0', dj && dj.would_delete === 0 && dj.would_fold === 2, dryJson.stdout.slice(0, 200));

    // an old schema: --dry-run refuses (migrate first), writes nothing
    {
      const oldDir = mkdtempSync(join(tmpdir(), 'linksee-consolidate-oldschema-'));
      const oldEnv = { ...env, LINKSEE_MEMORY_DIR: oldDir };
      const mk = spawnSync(process.execPath, ['-e', `
        process.env.LINKSEE_MEMORY_DIR=${JSON.stringify(oldDir)};
        const m = await import(${JSON.stringify(new URL('../dist/db/migrate.js', import.meta.url).href)});
        const d = m.openDb(); m.runMigrations(d);
        d.prepare("UPDATE meta SET value = '15' WHERE key = 'schema_version'").run();
        d.pragma('journal_mode = DELETE'); d.close();`], { encoding: 'utf8', input: '', env: oldEnv });
      const oldState = () => readdirSync(oldDir).sort().map((f) => `${f}:${createHash('sha256').update(readFileSync(join(oldDir, f))).digest('hex')}`).join('|');
      const st0 = oldState();
      const r = spawnSync(process.execPath, ['dist/mcp/server.js', 'consolidate', '--dry-run'], { env: oldEnv, encoding: 'utf8' });
      check('--dry-run on schema 15: exit 1, says migrate first', mk.status === 0 && r.status === 1 && /Migrate first/.test(r.stderr), `${mk.stderr} ${r.status} ${r.stderr}`);
      check('--dry-run on schema 15: the folder is byte-identical', oldState() === st0, `${st0} → ${oldState()}`);
      try { rmSync(oldDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    const apply = run(['--apply']);
    check('--apply: exit 0', apply.status === 0, apply.stderr + apply.stdout);
    check('--apply: reports 0 deleted', /rows deleted:\s+0/.test(apply.stdout), apply.stdout);
    const db4 = openDb();
    check('--apply: count went up by the summary, never down', count(db4) === n0 + 1, `${n0} → ${count(db4)}`);
    const m1 = JSON.parse(db4.prepare('SELECT content FROM memories WHERE id = ?').get(c1).content);
    const m2 = JSON.parse(db4.prepare('SELECT content FROM memories WHERE id = ?').get(c2).content);
    check('--apply: both originals marked, kept', typeof m1.consolidated_into === 'number' && m1.consolidated_into === m2.consolidated_into && m1.what === 'cli one');
    db4.close();
  }
  void bytesBefore;
} catch (e) {
  console.log(`  FAIL (exception) — ${e?.stack ?? e}`);
  failures++;
} finally {
  if (server) await server.stop();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
