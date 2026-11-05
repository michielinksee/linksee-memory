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
import { pathToFileURL } from 'node:url';

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
function startServer(clientInfo, rootDir) {
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
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { roots: rootDir ? [{ uri: pathToFileURL(rootDir).href }] : [] } }) + '\n');
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
    const params = { protocolVersion: '2024-11-05', capabilities: rootDir ? { roots: { listChanged: false } } : {} };
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
  const snap = () => JSON.stringify({ m: count('SELECT COUNT(*) n FROM memories'), e: count('SELECT COUNT(*) n FROM memory_edges'), ev: count('SELECT COUNT(*) n FROM events') });
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

  // ①b Reversal wording must not hide the NEW row: "instead of" / 「代わりに」 / "replaced" make the
  //     text-based guess say "superseded", but a memory that supersedes another is the current one.
  for (const [oldText, newText] of [
    ['注文の保存先は MongoDB にする', 'MongoDB の代わりに Postgres で注文を保存する'],
    ['Orders cache: use Memcached for sessions', 'Use Redis for sessions instead of Memcached'],
    ['Billing DB: use MySQL for billing tables', 'Replaced Postgres with MySQL: billing moved back to MySQL'],
  ]) {
    const o = await a.call('remember', { entity_name: 'repo-a', content: oldText });
    const n = await a.call('remember', { entity_name: 'repo-a', content: newText, supersedes: o.memory_id });
    const st = db.prepare('SELECT mem_state s FROM memories WHERE id = ?').get(n.memory_id)?.s;
    check(`reversal text keeps the new row current: "${newText.slice(0, 28)}…"`, n.ok === true && st !== 'superseded', `state=${st} ${JSON.stringify(n).slice(0, 120)}`);
    const rr = await a.call('recall', { query: newText.slice(0, 20), mark_accessed: false });
    const got = (rr.memories ?? []).map((m) => m.id);
    check(`…and recall returns it, not the old one`, got.includes(n.memory_id) && !got.includes(o.memory_id), JSON.stringify(got));
  }
  // Without supersedes the guess is unchanged (no silent behaviour change for plain saves).
  const noSup = await a.call('remember', { entity_name: 'repo-a', content: 'Replaced the old cron with a queue worker' });
  check('without supersedes the text guess still applies', db.prepare('SELECT mem_state s FROM memories WHERE id = ?').get(noSup.memory_id).s === 'superseded');

  // ①c 150 superseded rows (high importance) + 1 current row (low importance) in one entity:
  //     the current row must come back — superseded rows are left out before the LIMIT.
  const bulkEnt = Number(db.prepare(`INSERT INTO entities (kind, name, normalized_name) VALUES ('project', 'bulk-proj', 'bulk-proj')`).run().lastInsertRowid);
  const insB = db.prepare(`INSERT INTO memories (entity_id, layer, content, importance) VALUES (?, 'learning', ?, ?)`);
  db.transaction(() => {
    for (let i = 0; i < 150; i++) insB.run(bulkEnt, JSON.stringify({ altitude: 'implementation', type: 'decision', state: 'superseded', what: `bulkdecision old variant ${i}` }), 0.95);
  })();
  const live = Number(insB.run(bulkEnt, JSON.stringify({ altitude: 'implementation', type: 'decision', state: 'decided', what: 'bulkdecision current variant' }), 0.1).lastInsertRowid);
  const rb1 = await a.call('recall', { entity_name: 'bulk-proj', mark_accessed: false });
  check('150 superseded + 1 current (entity search): the current row is returned', (rb1.memories ?? []).some((m) => m.id === live), JSON.stringify({ count: rb1.count, hidden: rb1.superseded_hidden }));
  check('…and the 150 are counted as hidden', rb1.superseded_hidden === 150, String(rb1.superseded_hidden));
  const rb2 = await a.call('recall', { query: 'bulkdecision variant', mark_accessed: false });
  check('150 superseded + 1 current (text search): the current row is returned', (rb2.memories ?? []).some((m) => m.id === live), JSON.stringify({ count: rb2.count, hidden: rb2.superseded_hidden }));
  const rb3 = await a.call('recall', { query: 'bulkdecision variant', include_superseded: true, limit: 200, mark_accessed: false });
  check('include_superseded brings them back', (rb3.memories ?? []).filter((m) => m.content?.state === 'superseded').length > 0);

  // ①e NULL-safe exclusion. Five kinds of row, both search paths: plain text (mem_state NULL),
  //     JSON without a state (NULL), state 'decided', state 'superseded', and a plain-text row
  //     replaced by an edge only. The first three must come back, the last two must not.
  {
    const ent = Number(db.prepare(`INSERT INTO entities (kind, name, normalized_name) VALUES ('project', 'nullsafe-proj', 'nullsafe-proj')`).run().lastInsertRowid);
    const ins = (content) => Number(db.prepare(`INSERT INTO memories (entity_id, layer, content, importance) VALUES (?, 'context', ?, 0.5)`).run(ent, content).lastInsertRowid);
    const kinds = {
      plain: ins('nsfx plain row q7 then omega'),
      nostate: ins(JSON.stringify({ what: 'nsfx nostate row q7 then omega' })),
      decided: ins(JSON.stringify({ altitude: 'implementation', type: 'decision', state: 'decided', what: 'nsfx decided row q7 then omega' })),
      superseded: ins(JSON.stringify({ altitude: 'implementation', type: 'decision', state: 'superseded', what: 'nsfx superseded row q7 then omega' })),
      edgeonly: ins('nsfx edgeonly row q7 then omega'),
    };
    db.prepare(`INSERT INTO memory_edges (from_memory_id, to_memory_id, relation) VALUES (?, ?, 'supersedes')`).run(kinds.decided, kinds.edgeonly);
    check('fixture: plain and no-state rows have mem_state NULL', db.prepare('SELECT COUNT(*) n FROM memories WHERE id IN (?, ?) AND mem_state IS NULL').get(kinds.plain, kinds.nostate).n === 2);
    const want = [kinds.plain, kinds.nostate, kinds.decided].sort((x, y) => x - y);
    const all = Object.values(kinds).sort((x, y) => x - y);
    const ours = (r) => (r.memories ?? []).map((m) => m.id).filter((id) => all.includes(id)).sort((x, y) => x - y);
    for (const [label, args, method] of [
      ['FTS only ("nsfx omega": tokens not adjacent, LIKE cannot match)', { query: 'nsfx omega' }, 'fts5'],
      ['LIKE only ("q7": too short for the trigram index)', { query: 'q7' }, 'like'],
      ['LIKE by entity_name', { entity_name: 'nullsafe-proj' }, 'like'],
    ]) {
      const r = await a.call('recall', { ...args, mark_accessed: false, limit: 50 });
      check(`${label}: search path is ${method}`, r.search === method, String(r.search));
      check(`${label}: plain / no-state / decided returned, superseded / edge-only not`, JSON.stringify(ours(r)) === JSON.stringify(want), `${JSON.stringify(ours(r))} want ${JSON.stringify(want)} kinds=${JSON.stringify(kinds)}`);
      check(`${label}: superseded_hidden counts exactly the 2`, r.superseded_hidden === 2, String(r.superseded_hidden));
      const ri = await a.call('recall', { ...args, include_superseded: true, mark_accessed: false, limit: 50 });
      check(`${label}: include_superseded returns all 5`, JSON.stringify(ours(ri)) === JSON.stringify(all), JSON.stringify(ours(ri)));
    }
  }

  // ①f Explicit state vs supersedes. Explicit "superseded" + supersedes contradict → refused, nothing
  //     written. An explicit "decided" is kept as given. (Guessed "superseded" → decided is ①b.)
  {
    const target = await a.call('remember', { entity_name: 'repo-a', content: 'explicit-state target: use tabs' });
    const before = snap();
    const contra = await a.call('remember', { entity_name: 'repo-a', supersedes: target.memory_id,
      content: JSON.stringify({ altitude: 'implementation', type: 'decision', state: 'superseded', what: 'explicit-state: use spaces' }) });
    check('explicit state "superseded" + supersedes → refused', contra.ok === false && contra.rejected === 'supersedes' && /state "superseded"/.test(contra.reason ?? ''), JSON.stringify(contra).slice(0, 200));
    check('…and nothing was written', snap() === before && db.prepare('SELECT mem_state s FROM memories WHERE id = ?').get(target.memory_id).s !== 'superseded', `${before} → ${snap()}`);
    const exp = await a.call('remember', { entity_name: 'repo-a', supersedes: target.memory_id,
      content: JSON.stringify({ altitude: 'implementation', type: 'decision', state: 'in_progress', what: 'explicit-state: moving to spaces' }) });
    check('explicit state other than superseded is kept as given (no state_note)', exp.ok === true && exp.state_note === undefined && db.prepare('SELECT mem_state s FROM memories WHERE id = ?').get(exp.memory_id).s === 'in_progress', JSON.stringify(exp).slice(0, 160));
    const guessed = await a.call('remember', { entity_name: 'repo-a', content: '旧版の設定を置き換え、新しい lint 設定にする', supersedes: exp.memory_id });
    check('guessed "superseded" + supersedes → stored as decided, with state_note', guessed.ok === true && typeof guessed.state_note === 'string' && db.prepare('SELECT mem_state s FROM memories WHERE id = ?').get(guessed.memory_id).s === 'decided', JSON.stringify(guessed).slice(0, 200));
  }

  // ①d momentum refresh fails AFTER the commit → still ok:true (with a warning), saved exactly once.
  db.exec(`CREATE TRIGGER t_fail_mom BEFORE UPDATE OF momentum_score ON entities BEGIN SELECT RAISE(ABORT, 'injected momentum failure'); END`);
  const momText = 'saved even though the momentum refresh fails';
  const M = await a.call('remember', { entity_name: 'repo-a', content: momText });
  db.exec('DROP TRIGGER t_fail_mom');
  check('momentum failure after the save: ok:true', M.ok === true && typeof M.memory_id === 'number', JSON.stringify(M).slice(0, 200));
  check('…with a warning naming it', Array.isArray(M.warnings) && /momentum/.test(M.warnings[0] ?? ''), JSON.stringify(M.warnings));
  check('…and the memory exists exactly once', count(`SELECT COUNT(*) n FROM memories WHERE content LIKE ?`, `%${momText}%`) === 1);

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
  let initErr = null;
  await u.ready.catch((e) => { initErr = e; });
  check('initialize without clientInfo is accepted by this SDK', initErr === null, String(initErr));
  const U = await u.call('remember', { entity_name: 'repo-a', content: 'written by a client that did not say who it is' });
  check('no clientInfo → saved with client unknown (nothing guessed)', U.ok === true && JSON.stringify(sourceOf(U.memory_id)) === JSON.stringify({ client: 'unknown', via: 'mcp' }), JSON.stringify(U).slice(0, 160));

  // Two real repos (different workspace roots, different clients): the entity comes from each
  // root, and a decision recorded in repo-x IS returned in repo-y, labelled with its entity.
  const rx = join(dir, 'repo-x'), ry = join(dir, 'repo-y');
  mkdirSync(rx); mkdirSync(ry);
  const sx = startServer({ name: 'claude-code', version: '2.1.0' }, rx); servers.push(sx); await sx.ready;
  const sy = startServer({ name: 'codex-mcp-client', version: '0.50.0' }, ry); servers.push(sy); await sy.ready;
  const X = await sx.call('remember', { content: 'tworepo decision: this repo uses pnpm workspaces' });
  check('repo-x memory keyed to the repo-x root', X.ok === true && X.entity_inferred_from === 'workspace_root', JSON.stringify(X).slice(0, 160));
  const Y = await sy.call('remember', { content: 'tworepo decision: this repo uses npm' });
  check('repo-y memory keyed to the repo-y root', Y.ok === true && Y.entity_inferred_from === 'workspace_root' && Y.entity_id !== X.entity_id);
  const ryr = await sy.call('recall', { query: 'tworepo decision', mark_accessed: false });
  const xr = (ryr.memories ?? []).find((m) => m.id === X.memory_id);
  check('repo-x decision IS returned in repo-y (memory is per machine)', !!xr, JSON.stringify((ryr.memories ?? []).map((m) => m.entity?.name)));
  check('…labelled entity repo-x, by claude-code', xr?.entity?.name === 'repo-x' && xr?.by === 'claude-code', JSON.stringify(xr?.entity));
  // entity_name narrows by a PART of the name (LIKE) — what the README now says.
  const XB = await sx.call('remember', { entity_name: 'repo-x-backup', content: 'tworepo decision in the backup repo' });
  const nar = await sy.call('recall', { entity_name: 'repo-x', mark_accessed: false });
  const narIds = (nar.memories ?? []).map((m) => m.id);
  check('entity_name "repo-x" leaves repo-y out', !narIds.includes(Y.memory_id), JSON.stringify(narIds));
  check('entity_name "repo-x" also matches "repo-x-backup" (partial match, documented)', narIds.includes(X.memory_id) && narIds.includes(XB.memory_id), JSON.stringify(narIds));
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
  // Next turn: append a new user turn, run the hook again. The new turn must be saved and the
  // earlier turns must not be duplicated (a second run that did nothing would fail here).
  const turnRows = () => db.prepare(`SELECT json_extract(source, '$.turn_uuid') t, json_extract(source, '$.kind') k, json_extract(source, '$.via') v FROM memories WHERE source LIKE ?`).all(`%"session_id":"${sid}"%`);
  const runHook = () => spawnSync(process.execPath, ['dist/bin/sync-session.js'], { input: JSON.stringify({ session_id: sid, transcript_path: transcript, cwd: proj }), env, encoding: 'utf8', timeout: 60000 });
  const firstRun = turnRows();
  const appendTurn = (u, a2, text, ts) => writeFileSync(transcript, [
    { type: 'user', sessionId: sid, cwd: proj, uuid: u, timestamp: ts, message: { role: 'user', content: text } },
    { type: 'assistant', sessionId: sid, cwd: proj, uuid: a2, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n', { flag: 'a' });
  appendTurn('u2', 'a2', 'We decided to use a dead-letter queue for failed webhook deliveries', '2026-11-05T01:01:00.000Z');
  const hook2 = runHook();
  const secondRun = turnRows();
  check('second hook run exits 0', hook2.status === 0);
  check('second hook run saved the new turn (u2)', secondRun.some((r) => r.t === 'u2' && r.v === 'stop-hook'), JSON.stringify(secondRun));
  const keys = secondRun.map((r) => `${r.t}|${r.k}`);
  check('…and no turn is duplicated', new Set(keys).size === keys.length, JSON.stringify(keys));
  check('…and every first-run turn is still there once', firstRun.every((r) => keys.filter((k) => k === `${r.t}|${r.k}`).length === 1), JSON.stringify({ firstRun, keys }));

  // A raw Stop-hook row is refused as a supersedes target: the next import gives it a new id.
  const hookEntity = db.prepare('SELECT e.name FROM memories m JOIN entities e ON e.id = m.entity_id WHERE m.id = ?').get(
    db.prepare(`SELECT id FROM memories WHERE source LIKE ? LIMIT 1`).get(`%"session_id":"${sid}"%`).id).name;
  const rawId = db.prepare(`SELECT id FROM memories WHERE source LIKE ? LIMIT 1`).get(`%"session_id":"${sid}"%`).id;
  const s3 = snap();
  const rawContentBefore = db.prepare('SELECT content c FROM memories WHERE id = ?').get(rawId).c;
  const raw = await a.call('remember', { entity_name: hookEntity, content: 'replacing a raw session capture directly', supersedes: rawId });
  check('raw session capture refused as supersedes target', raw.ok === false && /raw capture/.test(raw.reason ?? ''), JSON.stringify(raw).slice(0, 200));
  check('…and nothing was written (rows, edges, events, the raw row)', snap() === s3 && db.prepare('SELECT content c FROM memories WHERE id = ?').get(rawId).c === rawContentBefore, `${s3} → ${snap()}`);

  // Distill the raw row (the documented way), supersede it, re-run the Stop hook: the distilled
  // row, its superseded state and the edge must all survive the re-import.
  const rawObj = JSON.parse(rawContentBefore);
  const rawTurn = JSON.parse(db.prepare('SELECT source s FROM memories WHERE id = ?').get(rawId).s).turn_uuid;
  const dist = await a.call('remember', { memory_id: rawId, content: JSON.stringify({ ...rawObj, distilled: true, what: 'Webhook handler retries with exponential backoff' }) });
  check('raw row distilled', dist.ok === true, JSON.stringify(dist).slice(0, 160));
  const DS = await a.call('remember', { entity_name: hookEntity, content: 'Webhook handler: no retries; failures go to the dead-letter queue', supersedes: rawId });
  check('distilled row can be superseded', DS.ok === true, JSON.stringify(DS).slice(0, 200));
  appendTurn('u3', 'a3', 'We decided to log every webhook failure as well', '2026-11-05T01:02:00.000Z');
  const hook3 = runHook();
  check('third hook run exits 0 and saved u3', hook3.status === 0 && turnRows().some((r) => r.t === 'u3'));
  const kept = db.prepare(`SELECT mem_state s, json_extract(content, '$.distilled') d FROM memories WHERE id = ?`).get(rawId);
  check('after re-import the distilled row still exists and is still superseded', kept?.s === 'superseded' && kept?.d === 1, JSON.stringify(kept));
  check('…and the supersedes edge survived', count(`SELECT COUNT(*) n FROM memory_edges WHERE relation='supersedes' AND from_memory_id=? AND to_memory_id=?`, DS.memory_id, rawId) === 1);
  check('…and its turn was not re-inserted as a raw copy', turnRows().filter((r) => r.t === rawTurn).length === 1, JSON.stringify(turnRows()));
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
