#!/usr/bin/env node
// Regression (0.18.1, Codex review 1 of #23): re-importing a session deletes no memory.
//
// Up to 0.18.0 every re-import (the Stop hook runs one per turn) DELETEd the session's
// undistilled rows outside the transaction that re-inserted them: a failed insert lost them, a
// successful one renumbered them. Now: stable key (kind | turn | layer | path-or-ordinal),
// UPDATE in place, INSERT new keys, leave unmatched rows, one BEGIN IMMEDIATE transaction.
//
// Run: node test/session-import.mjs   (needs `pnpm build`; throwaway DB)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'linksee-session-import-'));
process.env.LINKSEE_MEMORY_DIR = dir;
process.env.LINKSEE_TELEMETRY = 'off';

const { openDb, runMigrations } = await import('../dist/db/migrate.js');
const { importSession } = await import('../dist/lib/session-import.js');

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); failures++; }
};

const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
const sourceJson = (src) => JSON.stringify({ ...src, client: 'claude-code', via: 'stop-hook' });
const mem = (kind, turn, layer, obj, ts = 1_780_000_000) => ({
  layer, content: JSON.stringify({ altitude: 'implementation', type: 'work', state: 'done', session_id: SID, ...obj }),
  importance: 0.6, thread_id: SID, occurred_at: ts, source: { session_id: SID, turn_uuid: turn, kind },
});
const edit = (path, content) => ({ session_id: SID, memory_content: content, file_path: path, operation: 'edit', turn_uuid: 'u2', context_snippet: 'x', occurred_at: 1_780_000_100 });

const db = openDb();
runMigrations(db);
const entityId = Number(db.prepare(`INSERT INTO entities (name, kind, normalized_name) VALUES ('hookproj', 'project', 'hookproj')`).run().lastInsertRowid);
const opts = { entityId, sourceJson, startedAt: 1_780_000_000 };
const rows = () => db.prepare(`SELECT id, layer, content FROM memories WHERE source LIKE ? ORDER BY id`).all(`%"session_id":"${SID}"%`);
const snap = () => JSON.stringify({
  m: db.prepare('SELECT id, layer, content, importance, source, created_at FROM memories ORDER BY id').all(),
  e: db.prepare('SELECT session_id, memory_id, file_path FROM session_file_edits ORDER BY id').all(),
  ev: db.prepare('SELECT COUNT(*) c FROM events').get().c,
});

try {
  console.log('session-import regression (0.18.1)');

  // turn 1
  const goal = mem('first_intent', 'u1', 'goal', { what: 'add retry to the webhook' });
  const fe1 = mem('file_edit', 'u2', 'implementation', { what: 'Edit a.ts (1 ops)', affects: ['a.ts'], op_count: 1 });
  const r1 = importSession(db, { session_id: SID, memories: [goal, fe1], file_edits: [edit('a.ts', fe1.content)], stats: {} }, opts);
  check('first import inserts 2', r1.inserted === 2 && r1.updated === 0, JSON.stringify(r1));
  const first = rows();
  const goalId = first[0].id, feId = first[1].id;

  // something else points at the goal row (an edge), and triage archived the file_edit row
  const other = Number(db.prepare(`INSERT INTO memories (entity_id, layer, content) VALUES (?, 'learning', '{"what":"links to the goal"}')`).run(entityId).lastInsertRowid);
  db.prepare(`INSERT INTO memory_edges (from_memory_id, to_memory_id, relation) VALUES (?, ?, 'extends')`).run(other, goalId);
  db.prepare(`UPDATE memories SET content = json_set(content, '$.distill_verdict', 'auto-noise', '$.state', 'superseded', '$.type', 'note') WHERE id = ?`).run(feId);

  // turn 2: the session grew — a second op on a.ts (content changes), a new file, a new decision
  const fe1b = mem('file_edit', 'u2', 'implementation', { what: 'Edit a.ts (2 ops)', affects: ['a.ts'], op_count: 2 });
  const fe2 = mem('file_edit', 'u3', 'implementation', { what: 'Edit b.ts (1 ops)', affects: ['b.ts'], op_count: 1 });
  const dec = mem('decision', 'u4', 'learning', { what: 'use a dead-letter queue', type: 'decision', state: 'decided' });
  const r2 = importSession(db, { session_id: SID, memories: [goal, fe1b, fe2, dec], file_edits: [edit('a.ts', fe1b.content), edit('b.ts', fe2.content)], stats: {} }, opts);
  check('re-import: 1 unchanged, 1 updated, 2 inserted, nothing left over', r2.unchanged === 1 && r2.updated === 1 && r2.inserted === 2 && r2.leftInPlace === 0, JSON.stringify(r2));
  const second = rows();
  check('re-import keeps the ids of earlier rows', second.some((r) => r.id === goalId) && second.some((r) => r.id === feId), JSON.stringify(second.map((r) => r.id)));
  check('re-import: no duplicate rows', second.length === 4, String(second.length));
  check('the edge to the goal row survives', db.prepare('SELECT COUNT(*) c FROM memory_edges WHERE to_memory_id = ?').get(goalId).c === 1);
  const feNow = JSON.parse(db.prepare('SELECT content FROM memories WHERE id = ?').get(feId).content);
  check('updated row has the new content (op_count 2)', feNow.op_count === 2, JSON.stringify(feNow));
  check('…and keeps the triage verdict, type and state', feNow.distill_verdict === 'auto-noise' && feNow.state === 'superseded' && feNow.type === 'note', JSON.stringify(feNow));
  check('file_edits point at the kept id', db.prepare(`SELECT memory_id FROM session_file_edits WHERE file_path = 'a.ts'`).get().memory_id === feId);

  // turn 3, extractor no longer produces the decision: it is left, not deleted
  const r3 = importSession(db, { session_id: SID, memories: [goal, fe1b, fe2], file_edits: [], stats: {} }, opts);
  check('a row whose key is gone is left in place (not deleted)', r3.leftInPlace === 1 && rows().length === 4, JSON.stringify(r3));

  // failure inside the transaction, after memories were written → everything as it was
  const before = snap();
  const fe1c = mem('file_edit', 'u2', 'implementation', { what: 'Edit a.ts (3 ops)', affects: ['a.ts'], op_count: 3 });
  const fe3 = mem('file_edit', 'u5', 'implementation', { what: 'Edit c.ts', affects: ['c.ts'] });
  process.env.LINKSEE_TEST_FAULT = 'import-after-memories';
  let threw = false;
  try { importSession(db, { session_id: SID, memories: [goal, fe1c, fe2, fe3], file_edits: [], stats: {} }, opts); } catch { threw = true; }
  delete process.env.LINKSEE_TEST_FAULT;
  check('injected failure after the memory writes: import throws', threw);
  check('…and memories, file_edits and events are exactly as before (rolled back)', snap() === before);

  // a writer holding the lock → the import waits, then fails; nothing written
  const other2 = openDb();
  other2.exec('BEGIN IMMEDIATE');
  db.pragma('busy_timeout = 200');
  let busy = false;
  try { importSession(db, { session_id: SID, memories: [goal, fe1c, fe2, fe3], file_edits: [], stats: {} }, opts); } catch { busy = true; }
  other2.exec('ROLLBACK');
  other2.close();
  check('another connection holds the write lock: import refuses (BEGIN IMMEDIATE)', busy);
  check('…and nothing was written', snap() === before);
} catch (e) {
  console.log(`  FAIL (exception) — ${e?.stack ?? e}`);
  failures++;
} finally {
  db.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
