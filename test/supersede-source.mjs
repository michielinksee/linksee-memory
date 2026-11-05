#!/usr/bin/env node
// Regression (0.18.0): reversal (`remember({ supersedes })`) and attribution (`memories.source`).
//
// Two of the four cases an outside developer named in Discussion #16, both confirmed weak by the
// 2026-11-04 audit: no `supersedes` edge was ever written (recall returned a reversed decision
// next to its replacement), and no row written through MCP recorded who wrote it.
//
// Drives the real MCP server over stdio and the real Stop-hook entrypoint against a throwaway
// DB and a throwaway HOME. Never touches ~/.linksee-memory or ~/.claude.
//
// Run: node test/supersede-source.mjs

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'linksee-supersede-source-'));
const home = join(dir, 'home');
mkdirSync(home);
const env = { ...process.env, LINKSEE_MEMORY_DIR: dir, LINKSEE_TELEMETRY: 'off', HOME: home, USERPROFILE: home };
process.env.LINKSEE_MEMORY_DIR = dir; // for the in-process DB reads below

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); failures++; }
};

// One MCP server process per clientInfo (clientInfo arrives once, in initialize).
function startServer(clientInfo) {
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
    const params = { protocolVersion: '2024-11-05', capabilities: {} };
    if (clientInfo !== undefined) params.clientInfo = clientInfo;
    await rpc('initialize', params);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  })();
  const stop = async () => {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  };
  return { call, ready, stop };
}

const servers = [];
let db;
try {
  console.log('supersede-source regression');
  const a = startServer({ name: 'claude-code', version: '2.1.0' });
  servers.push(a);
  await a.ready;

  const { openDb } = await import('../dist/db/migrate.js');
  db = openDb();
  const count = (sql, ...p) => db.prepare(sql).get(...p).n;
  const sourceOf = (id) => JSON.parse(db.prepare('SELECT source FROM memories WHERE id = ?').get(id).source);

  // ① A, then B supersedes A → recall shows only B; include_superseded shows both.
  const A = await a.call('remember', { entity_name: 'repo-a', content: 'Primary store decision: use MongoDB for orders storage.' });
  check('A saved', A.ok === true, JSON.stringify(A).slice(0, 160));
  const B = await a.call('remember', { entity_name: 'repo-a', content: 'Primary store decision: use Postgres for orders storage instead.', supersedes: A.memory_id });
  check('B saved with supersedes', B.ok === true && JSON.stringify(B.supersedes) === JSON.stringify([A.memory_id]), JSON.stringify(B).slice(0, 200));
  check('one supersedes edge B → A', count(`SELECT COUNT(*) n FROM memory_edges WHERE relation='supersedes' AND from_memory_id=? AND to_memory_id=?`, B.memory_id, A.memory_id) === 1);
  check('A state is superseded', db.prepare('SELECT mem_state s FROM memories WHERE id = ?').get(A.memory_id).s === 'superseded');

  const r1 = await a.call('recall', { query: 'Primary store decision orders storage', mark_accessed: false });
  const ids1 = (r1.memories ?? []).map((m) => m.id);
  check('recall returns B', ids1.includes(B.memory_id), JSON.stringify(ids1));
  check('recall folds A by default', !ids1.includes(A.memory_id), JSON.stringify(ids1));
  check('recall says how many were hidden', r1.superseded_hidden === 1, String(r1.superseded_hidden));
  const bRow = (r1.memories ?? []).find((m) => m.id === B.memory_id);
  check('B carries "supersedes #A"', bRow?.supersedes === `#${A.memory_id}`, JSON.stringify(bRow?.supersedes));
  check('B carries by: claude-code', bRow?.by === 'claude-code', JSON.stringify(bRow?.by));

  const r2 = await a.call('recall', { query: 'Primary store decision orders storage', include_superseded: true, mark_accessed: false });
  const ids2 = (r2.memories ?? []).map((m) => m.id);
  check('include_superseded returns both', ids2.includes(A.memory_id) && ids2.includes(B.memory_id), JSON.stringify(ids2));
  const aRow = (r2.memories ?? []).find((m) => m.id === A.memory_id);
  check('A carries superseded_by B', aRow?.superseded_by === B.memory_id, JSON.stringify(aRow?.superseded_by));

  // A plain-text row (pre-0.5 shape) is folded by the edge alone; its text is not rewritten.
  const plain = Number(db.prepare(`INSERT INTO memories (entity_id, layer, content) VALUES (?, 'context', ?)`).run(A.entity_id, 'legacy plain text: orders queue uses RabbitMQ').lastInsertRowid);
  const P2 = await a.call('remember', { entity_name: 'repo-a', content: 'orders queue uses SQS now, RabbitMQ retired', supersedes: [plain] });
  check('plain-text row can be superseded', P2.ok === true, JSON.stringify(P2).slice(0, 160));
  check('plain-text content left as written', db.prepare('SELECT content c FROM memories WHERE id = ?').get(plain).c === 'legacy plain text: orders queue uses RabbitMQ');
  const r3 = await a.call('recall', { query: 'orders queue', mark_accessed: false });
  check('plain-text superseded row folded', !(r3.memories ?? []).some((m) => m.id === plain), JSON.stringify((r3.memories ?? []).map((m) => m.id)));

  // ② Refusals: missing id / the new row itself / another entity / raw session capture / update mode.
  const before = { m: count('SELECT COUNT(*) n FROM memories'), e: count('SELECT COUNT(*) n FROM memory_edges'), ent: count('SELECT COUNT(*) n FROM entities') };
  const missing = await a.call('remember', { entity_name: 'repo-a', content: 'refers to a memory that is not there', supersedes: 999999 });
  check('missing id refused', missing.ok === false && missing.rejected === 'supersedes' && /does not exist/.test(missing.reason), JSON.stringify(missing).slice(0, 200));
  const nextId = Number(db.prepare(`SELECT seq FROM sqlite_sequence WHERE name='memories'`).get().seq) + 1;
  const self = await a.call('remember', { entity_name: 'repo-a', content: 'tries to supersede its own future id', supersedes: nextId });
  check('own id refused', self.ok === false && self.rejected === 'supersedes' && /itself/.test(self.reason), JSON.stringify(self).slice(0, 200));
  const other = await a.call('remember', { entity_name: 'repo-b', content: 'repo-b decision trying to reach into repo-a', supersedes: B.memory_id });
  check('other entity refused', other.ok === false && other.rejected === 'supersedes' && /another entity/.test(other.reason), JSON.stringify(other).slice(0, 200));
  const mixed = await a.call('remember', { entity_name: 'repo-a', content: 'one good id and one missing id', supersedes: [B.memory_id, 999998] });
  check('one bad id in a list refuses the whole call', mixed.ok === false, JSON.stringify(mixed).slice(0, 160));
  const junk = await a.call('remember', { entity_name: 'repo-a', content: 'not an id', supersedes: 'abc' });
  check('non-numeric id refused', junk.ok === false && junk.rejected === 'supersedes', JSON.stringify(junk).slice(0, 160));
  const upd = await a.call('remember', { memory_id: B.memory_id, content: 'edit', supersedes: A.memory_id });
  check('supersedes with memory_id (update mode) refused', upd.ok === false && upd.rejected === 'supersedes', JSON.stringify(upd).slice(0, 160));
  const after = { m: count('SELECT COUNT(*) n FROM memories'), e: count('SELECT COUNT(*) n FROM memory_edges'), ent: count('SELECT COUNT(*) n FROM entities') };
  check('refusals wrote nothing (no row, no edge, no new entity "repo-b")', JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  check('B unchanged by the refused update', db.prepare('SELECT mem_state s FROM memories WHERE id = ?').get(B.memory_id).s !== 'superseded');

  // ③ Two clients → two different sources; no clientInfo → unknown.
  check('A source = claude-code via mcp', JSON.stringify(sourceOf(A.memory_id)) === JSON.stringify({ client: 'claude-code', version: '2.1.0', via: 'mcp' }), JSON.stringify(sourceOf(A.memory_id)));
  const c = startServer({ name: 'codex-mcp-client', version: '0.50.0' });
  servers.push(c);
  await c.ready;
  const C = await c.call('remember', { entity_name: 'repo-a', content: 'Codex wrote this: orders API is versioned under /v2.' });
  check('C saved from the second client', C.ok === true);
  check('C source = codex via mcp', JSON.stringify(sourceOf(C.memory_id)) === JSON.stringify({ client: 'codex-mcp-client', version: '0.50.0', via: 'mcp' }), JSON.stringify(sourceOf(C.memory_id)));
  check('sources of A and C differ', JSON.stringify(sourceOf(A.memory_id)) !== JSON.stringify(sourceOf(C.memory_id)));
  const rc = await c.call('recall', { query: 'orders API versioned', mark_accessed: false });
  check('recall shows by: codex-mcp-client', (rc.memories ?? []).find((m) => m.id === C.memory_id)?.by === 'codex-mcp-client');
  const u = startServer(undefined);
  servers.push(u);
  await u.ready.catch(() => {}); // some SDK versions reject a missing clientInfo; either way nothing is guessed
  const U = await u.call('remember', { entity_name: 'repo-a', content: 'written by a client that did not say who it is' }).catch(() => null);
  if (U?.ok) check('no clientInfo → client unknown', JSON.stringify(sourceOf(U.memory_id)) === JSON.stringify({ client: 'unknown', via: 'mcp' }), JSON.stringify(sourceOf(U.memory_id)));
  else console.log('  skip no-clientInfo case (initialize refused without clientInfo)');
  // Old rows are not back-filled: a row with no source stays without one, and recall adds no `by`.
  check('legacy row source stays NULL', db.prepare('SELECT source s FROM memories WHERE id = ?').get(plain).s === null);
  const rl = await a.call('recall', { query: 'RabbitMQ', include_superseded: true, mark_accessed: false });
  const pl = (rl.memories ?? []).find((m) => m.id === plain);
  check('recall adds no by for a legacy row', pl && pl.by === undefined, JSON.stringify(pl).slice(0, 160));

  // ⑤ Failure paths: a write that fails half-way, and a DB another process holds, leave nothing.
  //    (a) the old row's state change fails AFTER the new row and the edge were written.
  db.exec(`CREATE TRIGGER t_fail_mark BEFORE UPDATE ON memories WHEN NEW.content LIKE '%superseded_by%'
           BEGIN SELECT RAISE(ABORT, 'injected mark failure'); END`);
  const D = await a.call('remember', { entity_name: 'repo-a', content: 'target for the injected failure case' });
  const snap = () => JSON.stringify({ m: count('SELECT COUNT(*) n FROM memories'), e: count('SELECT COUNT(*) n FROM memory_edges'), ev: count('SELECT COUNT(*) n FROM events') });
  const s1 = snap();
  const failMid = await a.call('remember', { entity_name: 'repo-a', content: 'this save fails while marking the old row', supersedes: D.memory_id });
  check('injected failure is reported, not ok', failMid.ok === false && /injected mark failure/.test(failMid.error ?? ''), JSON.stringify(failMid).slice(0, 200));
  check('injected failure rolled everything back (row, edge, event)', snap() === s1, `${s1} → ${snap()}`);
  check('old row not marked after the failure', db.prepare('SELECT mem_state s FROM memories WHERE id = ?').get(D.memory_id).s !== 'superseded');
  db.exec('DROP TRIGGER t_fail_mark');
  //    (b) another process holds the write lock → the save errors after the busy timeout; nothing half-written.
  const holder = spawn(process.execPath, [join(process.cwd(), 'test', 'fixtures', 'hold-lock.cjs'), join(dir, 'memory.db'), 'immediate'], { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise((res) => holder.stdout.on('data', (d) => { if (String(d).includes('locked')) res(); }));
  const s2 = snap();
  const locked = await a.call('remember', { entity_name: 'repo-a', content: 'save while another process holds the lock', supersedes: D.memory_id });
  holder.stdin.end();
  await new Promise((res) => holder.on('exit', res));
  check('locked DB: save reported as failed', locked.ok === false, JSON.stringify(locked).slice(0, 200));
  check('locked DB: nothing written', snap() === s2, `${s2} → ${snap()}`);
  const retry = await a.call('remember', { entity_name: 'repo-a', content: 'save while another process holds the lock', supersedes: D.memory_id });
  check('after the lock is released, the same call succeeds', retry.ok === true && count(`SELECT COUNT(*) n FROM memory_edges WHERE from_memory_id=? AND to_memory_id=?`, retry.memory_id, D.memory_id) === 1, JSON.stringify(retry).slice(0, 160));

  // ④ Stop hook (sync-session) → source carries client claude-code via stop-hook.
  const sid = '11111111-2222-3333-4444-555555555555';
  const proj = join(dir, 'hookproj');
  mkdirSync(proj);
  const transcript = join(dir, `${sid}.jsonl`);
  const t0 = '2026-11-05T01:00:00.000Z', t1 = '2026-11-05T01:00:05.000Z';
  writeFileSync(transcript, [
    { type: 'user', sessionId: sid, cwd: proj, uuid: 'u1', timestamp: t0, message: { role: 'user', content: 'Add retry with exponential backoff to the orders webhook handler' } },
    { type: 'assistant', sessionId: sid, cwd: proj, uuid: 'a1', timestamp: t1, message: { role: 'assistant', content: [{ type: 'text', text: 'Added retry with backoff.' }] } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  const hook = spawnSync(process.execPath, ['dist/bin/sync-session.js'], {
    input: JSON.stringify({ session_id: sid, transcript_path: transcript, cwd: proj }), env, encoding: 'utf8', timeout: 60000,
  });
  check('Stop hook exits 0', hook.status === 0, `status=${hook.status} ${hook.stderr?.slice(0, 200)}`);
  const hookRows = db.prepare(`SELECT id, source FROM memories WHERE source LIKE ?`).all(`%"session_id":"${sid}"%`);
  check('Stop hook imported at least one row', hookRows.length > 0, String(hookRows.length));
  const hs = hookRows[0] ? JSON.parse(hookRows[0].source) : {};
  check('Stop-hook source = claude-code via stop-hook', hs.client === 'claude-code' && hs.via === 'stop-hook' && hs.session_id === sid, JSON.stringify(hs));
  // Re-running the hook (next turn) still finds and replaces the same session's rows.
  spawnSync(process.execPath, ['dist/bin/sync-session.js'], { input: JSON.stringify({ session_id: sid, transcript_path: transcript, cwd: proj }), env, encoding: 'utf8', timeout: 60000 });
  check('re-import does not duplicate (wipe still matches the new source shape)', db.prepare(`SELECT COUNT(*) n FROM memories WHERE source LIKE ?`).get(`%"session_id":"${sid}"%`).n === hookRows.length);

  // A raw Stop-hook row is refused as a supersedes target: the next import gives it a new id.
  const hookEntity = db.prepare('SELECT e.name FROM memories m JOIN entities e ON e.id = m.entity_id WHERE m.id = ?').get(
    db.prepare(`SELECT id FROM memories WHERE source LIKE ? LIMIT 1`).get(`%"session_id":"${sid}"%`).id).name;
  const rawId = db.prepare(`SELECT id FROM memories WHERE source LIKE ? LIMIT 1`).get(`%"session_id":"${sid}"%`).id;
  const raw = await a.call('remember', { entity_name: hookEntity, content: 'replacing a raw session capture directly', supersedes: rawId });
  check('raw session capture refused as supersedes target', raw.ok === false && /raw capture/.test(raw.reason ?? ''), JSON.stringify(raw).slice(0, 200));
} catch (e) {
  console.log('  FAIL harness:', String(e?.stack ?? e));
  failures++;
} finally {
  try { db?.close(); } catch { /* ignore */ }
  for (const s of servers) await s.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
