#!/usr/bin/env node
// Regression (0.18.1, Codex review 3 of #23): the real import-sessions CLI, run twice on the same
// session, leaves existing rows of memories / session_file_edits / drift_edges / memory_edges
// unchanged (SELECT *). The only allowed difference is protected 0 → 1: import-sessions runs the
// normal schema migration first, and its pin reconciliation (importance >= 0.9 → protected = 1)
// can raise that flag. Content, relations and verdicts must not move.
//
// Throwaway DB + HOME; the user's ~/.linksee-memory and ~/.claude are never touched.
// Run: node test/import-cli-append-only.mjs   (needs `pnpm build`)

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'linksee-import-cli-'));
const home = join(dir, 'home');
mkdirSync(home);
const env = { ...process.env, LINKSEE_MEMORY_DIR: dir, LINKSEE_TELEMETRY: 'off', HOME: home, USERPROFILE: home, LINKSEE_AUTO_CONSOLIDATE: '' };
process.env.LINKSEE_MEMORY_DIR = dir;

const { openDb, runMigrations } = await import('../dist/db/migrate.js');

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

// A transcript with an intent, a decision and two file edits.
const SID = '99999999-8888-7777-6666-555555555555';
const proj = join(dir, 'cliproj');
mkdirSync(proj);
const transcript = join(dir, `${SID}.jsonl`);
const T = (s) => `2026-11-05T02:00:${String(s).padStart(2, '0')}.000Z`;
writeFileSync(transcript, [
  { type: 'user', sessionId: SID, cwd: proj, uuid: 'u1', timestamp: T(0), message: { role: 'user', content: 'Add retry with exponential backoff to the orders webhook handler in src/webhook.ts' } },
  { type: 'assistant', sessionId: SID, cwd: proj, uuid: 'a1', timestamp: T(5), message: { role: 'assistant', content: [
    { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: join(proj, 'src', 'webhook.ts'), old_string: 'send()', new_string: 'retry(send)' } },
  ] } },
  { type: 'user', sessionId: SID, cwd: proj, uuid: 'u1r', timestamp: T(6), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  { type: 'user', sessionId: SID, cwd: proj, uuid: 'u2', timestamp: T(10), message: { role: 'user', content: 'We decided to use a dead-letter queue for failed webhook deliveries instead of dropping them' } },
  { type: 'assistant', sessionId: SID, cwd: proj, uuid: 'a2', timestamp: T(15), message: { role: 'assistant', content: [
    { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: join(proj, 'src', 'dlq.ts'), content: 'export const dlq = []' } },
  ] } },
  { type: 'user', sessionId: SID, cwd: proj, uuid: 'u2r', timestamp: T(16), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } },
].map((o) => JSON.stringify(o)).join('\n') + '\n');

const runImport = () => spawnSync(process.execPath, ['dist/bin/import-sessions.js', '--session-file', transcript, '--via', 'stop-hook'], { env, encoding: 'utf8', timeout: 60000 });

const TABLES = ['memories', 'session_file_edits', 'drift_edges', 'memory_edges'];
function rowsOf(db) {
  const out = {};
  for (const t of TABLES) out[t] = new Map(db.prepare(`SELECT * FROM "${t}" ORDER BY id`).all().map((r) => [r.id, r]));
  return out;
}
/** Existing rows unchanged, except memories.protected may go 0 → 1. Returns a list of differences. */
function diffExisting(before, after) {
  const diffs = [];
  let raised = 0;
  for (const t of TABLES) {
    for (const [id, b] of before[t]) {
      const a = after[t].get(id);
      if (!a) { diffs.push(`${t}#${id} gone`); continue; }
      for (const col of Object.keys(b)) {
        if (b[col] === a[col]) continue;
        if (t === 'memories' && col === 'protected' && b[col] === 0 && a[col] === 1) { raised++; continue; }
        diffs.push(`${t}#${id}.${col}: ${JSON.stringify(b[col]).slice(0, 60)} → ${JSON.stringify(a[col]).slice(0, 60)}`);
      }
    }
  }
  return { diffs, raised };
}

let server;
try {
  console.log('import-sessions CLI append-only regression (0.18.1)');

  // first import through the real CLI
  const first = runImport();
  check('first CLI import exits 0', first.status === 0, first.stderr + first.stdout);
  let db = openDb();
  runMigrations(db);
  const sessRows = db.prepare(`SELECT id, layer, content FROM memories WHERE source LIKE ? ORDER BY id`).all(`%"session_id":"${SID}"%`);
  const edits = db.prepare('SELECT id FROM session_file_edits WHERE session_id = ? ORDER BY id').all(SID);
  check('fixture: the session produced memories and file edits', sessRows.length >= 2 && edits.length >= 1, JSON.stringify({ m: sessRows.length, e: edits.length }));

  // user state on top: a dismissed drift verdict, a memory edge, a row the pin rule will raise
  const anchorId = Number(db.prepare(`INSERT INTO drift_anchors (kind, statement) VALUES ('decision', 'webhooks do not retry')`).run().lastInsertRowid);
  db.prepare(`INSERT INTO drift_edges (anchor_id, edit_id, verdict, status) VALUES (?, ?, 'contradicts', 'dismissed')`).run(anchorId, edits[0].id);
  const entityId = db.prepare('SELECT entity_id FROM memories WHERE id = ?').get(sessRows[0].id).entity_id;
  const note = Number(db.prepare(`INSERT INTO memories (entity_id, layer, content) VALUES (?, 'learning', '{"what":"follows up on the intent"}')`).run(entityId).lastInsertRowid);
  db.prepare(`INSERT INTO memory_edges (from_memory_id, to_memory_id, relation) VALUES (?, ?, 'extends')`).run(note, sessRows[0].id);
  const pinned = Number(db.prepare(`INSERT INTO memories (entity_id, layer, content, importance, protected) VALUES (?, 'context', '{"what":"pinned before the pin rule ran"}', 0.95, 0)`).run(entityId).lastInsertRowid);
  db.close();

  // a captured row corrected by the user through remember({ memory_id, content })
  server = startServer();
  await server.ready;
  const target = sessRows[sessRows.length - 1].id;
  const fixedContent = JSON.stringify({ altitude: 'architecture', type: 'decision', state: 'decided', session_id: SID, what: 'Failed webhook deliveries go to a dead-letter queue, retried hourly', why: 'corrected by the user' });
  const upd = await server.call('remember', { memory_id: target, content: fixedContent });
  await server.stop();
  server = undefined;
  check('remember({ memory_id, content }) corrected a captured row', upd.ok === true, JSON.stringify(upd).slice(0, 200));

  db = openDb();
  // the server start above ran the pin rule; lower the flag again so the CLI's migration has
  // something to raise (the one difference the comparison allows)
  db.prepare('UPDATE memories SET protected = 0 WHERE id = ?').run(pinned);
  const before = rowsOf(db);
  check('fixture: dismissed drift edge, memory edge and the unprotected pin are in place',
    [...before.drift_edges.values()].some((r) => r.status === 'dismissed') && before.memory_edges.size >= 1 && before.memories.get(pinned).protected === 0);
  db.close();

  // the same session through the real CLI, twice
  for (const n of [2, 3]) {
    const r = runImport();
    check(`CLI import #${n} exits 0`, r.status === 0, r.stderr + r.stdout);
    check(`CLI import #${n} reports append-only, 0 inserted`, /inserted 0m \+ 0e/.test(r.stdout) && /append-only, 0 deleted/.test(r.stdout), r.stdout.trim());
  }

  db = openDb();
  const after = rowsOf(db);
  const { diffs, raised } = diffExisting(before, after);
  check('existing rows of memories / session_file_edits / drift_edges / memory_edges unchanged (SELECT *), protected 0→1 aside', diffs.length === 0, diffs.slice(0, 10).join('; '));
  check('the only allowed difference happened where expected: the pin row was raised to protected', raised === 1 && after.memories.get(pinned).protected === 1, String(raised));
  check('no rows added to those tables by the re-imports', TABLES.every((t) => after[t].size === before[t].size), JSON.stringify(TABLES.map((t) => [t, before[t].size, after[t].size])));
  const fixedNow = JSON.parse(after.memories.get(target).content);
  check('the user-corrected row still reads as corrected', fixedNow.why === 'corrected by the user', JSON.stringify(fixedNow));
  check('the dismissed drift verdict is still there', [...after.drift_edges.values()].some((r) => r.edit_id === edits[0].id && r.status === 'dismissed'));
  db.close();
} catch (e) {
  console.log(`  FAIL (exception) — ${e?.stack ?? e}`);
  failures++;
} finally {
  if (server) await server.stop();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
