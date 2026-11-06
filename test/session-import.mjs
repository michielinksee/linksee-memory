#!/usr/bin/env node
// Regression (0.18.1, Codex reviews 1–2 of #23): re-importing a session is append-only.
//
// Up to 0.18.0 every re-import (the Stop hook runs one per turn) DELETEd the session's
// undistilled rows (outside the insert transaction), its session_file_edits (cascading into
// drift_edges: the user's dismiss verdicts) and its events, and inserted them again. The first
// 0.18.1 draft updated rows in place, which overwrote a user's remember({ memory_id }) fix.
// Now: rows already imported — memories and session_file_edits — are not touched; new keys are
// inserted; one BEGIN IMMEDIATE transaction.
//
// Run: node test/session-import.mjs   (needs `pnpm build`; throwaway DB + HOME)

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'linksee-session-import-'));
const home = join(dir, 'home');
mkdirSync(home);
const env = { ...process.env, LINKSEE_MEMORY_DIR: dir, LINKSEE_TELEMETRY: 'off', HOME: home, USERPROFILE: home, LINKSEE_AUTO_CONSOLIDATE: '' };
process.env.LINKSEE_MEMORY_DIR = dir;
process.env.LINKSEE_TELEMETRY = 'off';

const { openDb, runMigrations } = await import('../dist/db/migrate.js');
const { importSession } = await import('../dist/lib/session-import.js');

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); failures++; }
};

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

const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
const sourceJson = (src) => JSON.stringify({ ...src, client: 'claude-code', via: 'stop-hook' });
const mem = (kind, turn, layer, obj, ts = 1_780_000_000) => ({
  layer, content: JSON.stringify({ altitude: 'implementation', type: 'work', state: 'done', session_id: SID, ...obj }),
  importance: 0.6, thread_id: SID, occurred_at: ts, source: { session_id: SID, turn_uuid: turn, kind },
});
const edit = (path, content, turn = 'u2', at = 1_780_000_100) => ({ session_id: SID, memory_content: content, file_path: path, operation: 'edit', turn_uuid: turn, context_snippet: 'x', occurred_at: at });

/** Every table, every column, every row (SELECT *), serialized. */
function dump(db) {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((r) => r.name);
  const out = {};
  for (const t of tables) {
    try { out[t] = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all(); }
    catch { out[t] = db.prepare(`SELECT * FROM "${t}"`).all(); }
  }
  return JSON.stringify(out, (_k, v) => (Buffer.isBuffer(v) ? v.toString('hex') : v));
}

const db = openDb();
runMigrations(db);
const entityId = Number(db.prepare(`INSERT INTO entities (name, kind, normalized_name) VALUES ('hookproj', 'project', 'hookproj')`).run().lastInsertRowid);
const opts = { entityId, sourceJson, startedAt: 1_780_000_000 };
const rows = () => db.prepare(`SELECT id, layer, content FROM memories WHERE source LIKE ? ORDER BY id`).all(`%"session_id":"${SID}"%`);
let server;

try {
  console.log('session-import regression (0.18.1, append-only)');

  // turn 1
  const goal = mem('first_intent', 'u1', 'goal', { what: 'add retry to the webhook', why: 'Session intent — first user message' });
  const fe1 = mem('file_edit', 'u2', 'implementation', { what: 'Edit a.ts (1 ops)', affects: ['a.ts'], op_count: 1 });
  const turn1 = { session_id: SID, memories: [goal, fe1], file_edits: [edit('a.ts', fe1.content)], stats: {} };
  const r1 = importSession(db, turn1, opts);
  check('first import inserts 2 memories + 1 edit', r1.inserted === 2 && r1.edits === 1, JSON.stringify(r1));
  const [goalRow, feRow] = rows();

  // the user corrects the goal through MCP: remember({ memory_id, content })
  db.pragma('wal_checkpoint(PASSIVE)');
  server = startServer();
  await server.ready;
  const fixed = JSON.stringify({ altitude: 'implementation', type: 'work', state: 'done', session_id: SID, what: 'add retry with jitter to the orders webhook', why: 'the user corrected this' });
  const upd = await server.call('remember', { memory_id: goalRow.id, content: fixed });
  await server.stop();
  server = undefined;
  check('remember({ memory_id, content }) succeeded', upd.ok === true, JSON.stringify(upd).slice(0, 200));

  // the user dismissed a drift verdict on the file edit
  const editId = db.prepare(`SELECT id FROM session_file_edits WHERE session_id = ? AND file_path = 'a.ts'`).get(SID).id;
  const anchorId = Number(db.prepare(`INSERT INTO drift_anchors (kind, statement) VALUES ('decision', 'a.ts keeps no retries')`).run().lastInsertRowid);
  db.prepare(`INSERT INTO drift_edges (anchor_id, edit_id, verdict, status) VALUES (?, ?, 'contradicts', 'dismissed')`).run(anchorId, editId);
  // and something points at the goal row
  const other = Number(db.prepare(`INSERT INTO memories (entity_id, layer, content) VALUES (?, 'learning', '{"what":"links to the goal"}')`).run(entityId).lastInsertRowid);
  db.prepare(`INSERT INTO memory_edges (from_memory_id, to_memory_id, relation) VALUES (?, ?, 'extends')`).run(other, goalRow.id);

  // same session re-imported unchanged → nothing at all changes
  const beforeSame = dump(db);
  const rSame = importSession(db, turn1, opts);
  check('identical re-import: 0 inserted, everything kept', rSame.inserted === 0 && rSame.kept === 2 && rSame.edits === 0 && rSame.editsKept === 1, JSON.stringify(rSame));
  const afterSame = JSON.parse(dump(db)); const bs = JSON.parse(beforeSame);
  delete afterSame.events; delete bs.events; // the session_imported payload is refreshed in place
  check('identical re-import: every other table byte-identical (SELECT *)', JSON.stringify(afterSame) === JSON.stringify(bs));
  const goalNow = JSON.parse(db.prepare('SELECT content FROM memories WHERE id = ?').get(goalRow.id).content);
  check('the user-corrected what/why survive the re-import', goalNow.what === 'add retry with jitter to the orders webhook' && goalNow.why === 'the user corrected this', JSON.stringify(goalNow));
  check('the dismissed drift verdict survives (1 row, status dismissed)', db.prepare('SELECT COUNT(*) c FROM drift_edges WHERE edit_id = ? AND status = ?').get(editId, 'dismissed').c === 1);

  // turn 2: the session grew — a second op on a.ts (extraction changes), a new file, a decision
  const fe1b = mem('file_edit', 'u2', 'implementation', { what: 'Edit a.ts (2 ops)', affects: ['a.ts'], op_count: 2 });
  const fe2 = mem('file_edit', 'u3', 'implementation', { what: 'Edit b.ts (1 ops)', affects: ['b.ts'], op_count: 1 });
  const dec = mem('decision', 'u4', 'learning', { what: 'use a dead-letter queue', type: 'decision', state: 'decided' });
  const turn2 = { session_id: SID, memories: [goal, fe1b, fe2, dec], file_edits: [edit('a.ts', fe1.content), edit('a.ts', fe1b.content, 'u2', 1_780_000_150), edit('b.ts', fe2.content, 'u3', 1_780_000_200)], stats: {} };
  const r2 = importSession(db, turn2, opts);
  check('growing re-import: 2 kept, 2 inserted; 1 edit kept, 2 inserted', r2.kept === 2 && r2.inserted === 2 && r2.editsKept === 1 && r2.edits === 2, JSON.stringify(r2));
  check('ids of earlier rows unchanged, no duplicates', rows().length === 4 && rows()[0].id === goalRow.id && rows()[1].id === feRow.id);
  const feNow = JSON.parse(db.prepare('SELECT content FROM memories WHERE id = ?').get(feRow.id).content);
  check('an already-imported row is not updated (known limit: op_count stays 1)', feNow.op_count === 1, JSON.stringify(feNow));
  check('goal still the corrected text', JSON.parse(db.prepare('SELECT content FROM memories WHERE id = ?').get(goalRow.id).content).why === 'the user corrected this');
  check('drift verdict still there', db.prepare('SELECT status FROM drift_edges WHERE edit_id = ?').get(editId)?.status === 'dismissed');
  check('the edge to the goal row survives', db.prepare('SELECT COUNT(*) c FROM memory_edges WHERE to_memory_id = ?').get(goalRow.id).c === 1);
  check('one session_imported event for the session', db.prepare(`SELECT COUNT(*) c FROM events WHERE kind = 'session_imported' AND json_extract(payload, '$.session_id') = ?`).get(SID).c === 1);

  // extractor no longer produces the decision: left, not deleted
  const r3 = importSession(db, { session_id: SID, memories: [goal, fe1b, fe2], file_edits: [], stats: {} }, opts);
  check('a row whose key is gone is left in place', r3.leftInPlace === 1 && rows().length === 4, JSON.stringify(r3));

  // failures inside the transaction → every table, every column as before
  const fe3 = mem('file_edit', 'u5', 'implementation', { what: 'Edit c.ts', affects: ['c.ts'] });
  const turn4 = { session_id: SID, memories: [goal, fe1b, fe2, fe3], file_edits: [edit('c.ts', fe3.content, 'u5', 1_780_000_300)], stats: { n: 4 } };
  for (const point of ['import-after-memories', 'import-after-edits']) {
    const before = dump(db);
    process.env.LINKSEE_TEST_FAULT = point;
    let threw = false;
    try { importSession(db, turn4, opts); } catch (e) { threw = /injected fault/.test(String(e?.message)); }
    delete process.env.LINKSEE_TEST_FAULT;
    check(`injected failure at ${point}: import throws`, threw);
    check(`…every table, every column identical (rolled back)`, dump(db) === before);
  }

  // a writer holding the lock → the import refuses; nothing written
  {
    const before = dump(db);
    const holder = openDb();
    holder.exec('BEGIN IMMEDIATE');
    db.pragma('busy_timeout = 200');
    let busy = false;
    try { importSession(db, turn4, opts); } catch { busy = true; }
    holder.exec('ROLLBACK');
    holder.close();
    check('another connection holds the write lock: import refuses (BEGIN IMMEDIATE)', busy);
    check('…and nothing was written', dump(db) === before);
  }
} catch (e) {
  console.log(`  FAIL (exception) — ${e?.stack ?? e}`);
  failures++;
} finally {
  if (server) await server.stop();
  db.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
