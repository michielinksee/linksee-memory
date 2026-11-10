#!/usr/bin/env node
// Regression (0.20.0): four product gaps that cost real data on the maintainer's own DB.
//
//   1. dream's distill_queue returned only a 220-character cut of `what` / `context_hint`, without
//      title / altitude / type / state or the other keys. A rewriter copied the cut text back and lost
//      the tail of 21 memories (2026-11-10). Now each row carries `content_full` (every key, parsed,
//      uncut), the axes and title at the top, and `truncated` names each value that was cut.
//   2. remember({ memory_id, content }) replaced the whole content. A rewrite dropped title / affects /
//      evidence_refs / session_id on every row (2026-11-05). Now `merge: true` merges the JSON keys
//      sent into the stored JSON object (sent keys win, a key sent as null is removed). Without it the
//      update still replaces (unchanged). merge refuses — nothing written — when either side is not a
//      JSON object, or when there is no memory_id.
//   3. Maintenance sessions were captured by the Stop hook (+98 raw rows from 30 headless runs,
//      2026-11-05). Now LINKSEE_NO_CAPTURE=1 makes sync-session (and import-sessions --via stop-hook)
//      write nothing.
//   4. remember stored content that starts like JSON but does not parse, wrapped as a string
//      (136 broken rows). Now it is refused with where it breaks, on create and update. Plain text is
//      stored as before; existing broken rows are only read, never touched.
//
// Everything here is fictional text in a throwaway DB + HOME; ~/.linksee-memory and ~/.claude are
// never touched. Run: node test/four-gaps.mjs   (needs `pnpm build`)

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'linksee-four-gaps-'));
const home = join(dir, 'home');
mkdirSync(home);
const env = { ...process.env, LINKSEE_MEMORY_DIR: dir, LINKSEE_TELEMETRY: 'off', HOME: home, USERPROFILE: home, LINKSEE_AUTO_CONSOLIDATE: '' };
delete env.LINKSEE_NO_CAPTURE;
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

// ---- fixtures (all invented) ---------------------------------------------------------------------
const LONG_WHAT = 'Orbit team decided to keep the lantern cache warm across deploys because cold starts cost the night shift ' +
  'twelve minutes each; the alternative of prewarming from the harbor job was rejected. ' + 'Tail detail that must survive: TAIL-WHAT-7Q.';
const LONG_HINT = 'Context before the decision: the night shift reported slow first requests on three consecutive evenings; ' +
  'the harbor job owner said prewarming would double its runtime; option b was to raise the cache TTL instead, which was ' +
  'also discussed and dropped. ' + 'Tail detail that must survive: TAIL-HINT-3K.';
const DISTILL_ROW = {
  title: 'Lantern cache stays warm',
  altitude: 'implementation',
  type: 'decision',
  state: 'decided',
  what: LONG_WHAT,
  why: 'Decision detected by pattern match — may need agent enrichment',
  needs_distill: 1,
  context_hint: LONG_HINT,
  affects: ['src/lantern/cache.ts'],
  evidence_refs: [{ session: 'fictional-session-01', turn: 4 }],
  session_id: 'fictional-session-01',
};
const BROKEN_STORED = '{"what":"an older row whose JSON was cut off mid-wa';

function seed() {
  const db = openDb();
  runMigrations(db);
  const eid = Number(db.prepare("INSERT INTO entities (kind, name, normalized_name) VALUES ('project', 'orbit-fiction', 'orbit-fiction')").run().lastInsertRowid);
  const ins = db.prepare('INSERT INTO memories (entity_id, layer, content, importance, created_at) VALUES (?, ?, ?, 0.5, unixepoch() - 7200)');
  const distillId = Number(ins.run(eid, 'learning', JSON.stringify(DISTILL_ROW)).lastInsertRowid);
  const brokenId = Number(ins.run(eid, 'context', BROKEN_STORED).lastInsertRowid);
  const plainId = Number(ins.run(eid, 'context', 'a plain-text row, not JSON at all').lastInsertRowid);
  db.close();
  return { distillId, brokenId, plainId };
}
const readRow = (id) => { const db = openDb(); try { return db.prepare('SELECT * FROM memories WHERE id = ?').get(id); } finally { db.close(); } };
const countRows = () => { const db = openDb(); try { return db.prepare('SELECT COUNT(*) AS n FROM memories').get().n; } finally { db.close(); } };

let server;
try {
  console.log('four-gaps regression (0.20.0)');
  const { distillId, brokenId, plainId } = seed();
  server = startServer();
  await server.ready;
  const { call } = server;

  // ---- 1. dream returns every key, uncut, and marks what it cut ---------------------------------
  console.log(' 1. dream distill_queue');
  const dream = await call('recall', { dream: true, distill: 25 });
  const item = (dream.distill_queue ?? []).find((r) => r.memory_id === distillId);
  check('the seeded row is in distill_queue', !!item, JSON.stringify(dream).slice(0, 200));
  check('row carries title', item?.title === DISTILL_ROW.title, JSON.stringify(item?.title));
  check('row carries altitude / type / state', item?.altitude === 'implementation' && item?.type === 'decision' && item?.state === 'decided',
    JSON.stringify([item?.altitude, item?.type, item?.state]));
  check('content_full holds every stored key, uncut', JSON.stringify(item?.content_full) === JSON.stringify(DISTILL_ROW),
    JSON.stringify(item?.content_full)?.slice(0, 200));
  check('content_full keeps the tail of what and context_hint',
    String(item?.content_full?.what ?? '').endsWith('TAIL-WHAT-7Q.') && String(item?.content_full?.context_hint ?? '').endsWith('TAIL-HINT-3K.'));
  check('the short raw_what is still cut (≤ 220) and marked as cut',
    typeof item?.raw_what === 'string' && item.raw_what.length <= 220 && Array.isArray(item?.truncated) && item.truncated.includes('raw_what'),
    JSON.stringify(item?.truncated));
  check('context_hint is marked as cut', Array.isArray(item?.truncated) && item.truncated.includes('context_hint'), JSON.stringify(item?.truncated));
  check('the dream response tells the rewriter to use merge: true', /merge:\s*true/.test(String(dream.distill_hint ?? '') + String(dream.guide ?? '')),
    String(dream.distill_hint ?? '').slice(0, 200));

  // ---- 2. remember merge ------------------------------------------------------------------------
  console.log(' 2. remember merge: true');
  const m1 = await call('remember', {
    memory_id: distillId, merge: true,
    content: JSON.stringify({ what: 'Keep the lantern cache warm across deploys.', why: 'Cold starts cost the night shift 12 minutes.', distilled: true, needs_distill: null, context_hint: null }),
  });
  check('merge update ok', m1.ok === true, JSON.stringify(m1).slice(0, 200));
  const merged = JSON.parse(readRow(distillId).content);
  check('sent keys win', merged.what === 'Keep the lantern cache warm across deploys.' && merged.distilled === true);
  check('keys not sent are kept (title, affects, evidence_refs, session_id, axes)',
    merged.title === DISTILL_ROW.title && JSON.stringify(merged.affects) === JSON.stringify(DISTILL_ROW.affects)
      && JSON.stringify(merged.evidence_refs) === JSON.stringify(DISTILL_ROW.evidence_refs) && merged.session_id === DISTILL_ROW.session_id
      && merged.altitude === 'implementation' && merged.type === 'decision' && merged.state === 'decided',
    JSON.stringify(merged).slice(0, 300));
  check('a key sent as null is removed', !('needs_distill' in merged) && !('context_hint' in merged), JSON.stringify(Object.keys(merged)));

  // default stays replace (compatibility)
  const r1 = await call('remember', { content: JSON.stringify({ altitude: 'detail', type: 'note', state: 'open', what: 'replace me', title: 'Fictional title' }) });
  const r2 = await call('remember', { memory_id: r1.memory_id, content: JSON.stringify({ what: 'replaced' }) });
  const replaced = JSON.parse(readRow(r1.memory_id).content);
  check('without merge the update still replaces the whole content', r2.ok === true && JSON.stringify(replaced) === '{"what":"replaced"}', JSON.stringify(replaced));

  // non-object on either side: refused, nothing written
  const beforePlain = readRow(plainId).content;
  const e1 = await call('remember', { memory_id: plainId, merge: true, content: JSON.stringify({ what: 'x' }) });
  check('merge into a stored plain-text row is refused', e1.ok === false && e1.saved === false, JSON.stringify(e1).slice(0, 200));
  check('…and the stored row is unchanged', readRow(plainId).content === beforePlain);
  const beforeMerged = readRow(distillId).content;
  const e2 = await call('remember', { memory_id: distillId, merge: true, content: 'plain text is not a JSON object' });
  check('merge with plain-text content is refused', e2.ok === false && e2.saved === false, JSON.stringify(e2).slice(0, 200));
  const e3 = await call('remember', { memory_id: distillId, merge: true, content: '["an","array"]' });
  check('merge with a JSON array is refused', e3.ok === false && e3.saved === false, JSON.stringify(e3).slice(0, 200));
  check('…and the stored row is unchanged after both', readRow(distillId).content === beforeMerged);
  const n0 = countRows();
  const e4 = await call('remember', { merge: true, content: JSON.stringify({ altitude: 'detail', type: 'note', state: 'open', what: 'no id' }) });
  check('merge without memory_id is refused (nothing created)', e4.ok === false && countRows() === n0, JSON.stringify(e4).slice(0, 200));

  // ---- 4. broken JSON is refused --------------------------------------------------------------
  console.log(' 4. broken JSON content');
  const n1 = countRows();
  const b1 = await call('remember', { content: '{"altitude":"detail","type":"note","state":"open","what":"cut off in the mid' });
  check('create with broken JSON is refused', b1.ok === false && b1.saved === false, JSON.stringify(b1).slice(0, 200));
  check('…the refusal says where it breaks', Number.isInteger(b1.position) && b1.position > 0 && /character/.test(String(b1.error ?? '')), JSON.stringify(b1).slice(0, 300));
  check('…and no row was added', countRows() === n1);
  const b2 = await call('remember', { content: '[{"what":"an array cut off' });
  check('create with a broken JSON array is refused', b2.ok === false && countRows() === n1, JSON.stringify(b2).slice(0, 200));
  const beforeUpd = readRow(distillId).content;
  const b3 = await call('remember', { memory_id: distillId, content: '{"what":"update cut off' });
  check('update with broken JSON is refused', b3.ok === false && b3.saved === false, JSON.stringify(b3).slice(0, 200));
  check('…and the stored row is unchanged', readRow(distillId).content === beforeUpd);
  const p1 = await call('remember', { content: 'Plain sentence about the fictional lantern cache, saved as before.' });
  check('plain text is still saved', p1.ok === true && countRows() === n1 + 1, JSON.stringify(p1).slice(0, 200));
  const p2 = await call('remember', { content: '[WIP] bracketed plain text is still saved' });
  check('text starting with "[" that is not a JSON array is still saved', p2.ok === true && countRows() === n1 + 2, JSON.stringify(p2).slice(0, 200));
  const v1 = await call('remember', { content: JSON.stringify({ altitude: 'detail', type: 'note', state: 'open', what: 'valid JSON is saved' }) });
  check('valid JSON is saved', v1.ok === true && countRows() === n1 + 3, JSON.stringify(v1).slice(0, 200));
  const rec = await call('recall', { query: 'older row whose JSON was cut' });
  check('recall still reads with an old broken row present', rec.ok !== false, JSON.stringify(rec).slice(0, 200));
  check('the old broken row is untouched', readRow(brokenId).content === BROKEN_STORED);

  await server.stop();
  server = undefined;

  // ---- 3. LINKSEE_NO_CAPTURE ---------------------------------------------------------------
  console.log(' 3. LINKSEE_NO_CAPTURE=1 on the Stop hook');
  const SID = '11111111-2222-3333-4444-555555555555';
  const proj = join(dir, 'fictionproj');
  mkdirSync(proj);
  const transcript = join(dir, `${SID}.jsonl`);
  const T = (s) => `2026-11-10T02:00:${String(s).padStart(2, '0')}.000Z`;
  writeFileSync(transcript, [
    { type: 'user', sessionId: SID, cwd: proj, uuid: 'u1', timestamp: T(0), message: { role: 'user', content: 'Add a retry to the fictional lantern fetcher in src/lantern.ts' } },
    { type: 'assistant', sessionId: SID, cwd: proj, uuid: 'a1', timestamp: T(5), message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: join(proj, 'src', 'lantern.ts'), old_string: 'fetch()', new_string: 'retry(fetch)' } },
    ] } },
    { type: 'user', sessionId: SID, cwd: proj, uuid: 'u1r', timestamp: T(6), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'user', sessionId: SID, cwd: proj, uuid: 'u2', timestamp: T(10), message: { role: 'user', content: 'We decided to use a dead-letter queue for failed lantern fetches instead of dropping them' } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  const hookInput = JSON.stringify({ session_id: SID, transcript_path: transcript, cwd: proj });
  const runHook = (extra) => spawnSync(process.execPath, ['dist/bin/sync-session.js'], { env: { ...env, ...extra }, input: hookInput, encoding: 'utf8', timeout: 60000 });
  const runImport = (extra) => spawnSync(process.execPath, ['dist/bin/import-sessions.js', '--session-file', transcript, '--via', 'stop-hook'], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60000 });

  const c0 = countRows();
  const h1 = runHook({ LINKSEE_NO_CAPTURE: '1' });
  check('sync-session exits 0 with LINKSEE_NO_CAPTURE=1', h1.status === 0, `${h1.status} ${h1.stderr}`);
  check('…prints one line on stderr', /LINKSEE_NO_CAPTURE/.test(h1.stderr ?? ''), JSON.stringify(h1.stderr));
  check('…and adds no rows', countRows() === c0, `${c0} → ${countRows()}`);
  check('…and writes no hook.log line', !existsSync(join(dir, 'hook.log')));
  const i1 = runImport({ LINKSEE_NO_CAPTURE: '1' });
  check('import-sessions --via stop-hook with LINKSEE_NO_CAPTURE=1 adds no rows', i1.status === 0 && countRows() === c0, `${i1.status} ${c0} → ${countRows()} ${i1.stderr}`);
  const h2 = runHook({});
  check('without it the hook captures (rows increase)', h2.status === 0 && countRows() > c0, `${c0} → ${countRows()} ${h2.stderr}`);
} catch (e) {
  console.log(`  FAIL unexpected error: ${e?.stack ?? e}`);
  failures++;
} finally {
  if (server) await server.stop();
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp */ }
}

if (failures > 0) { console.log(`\n✖ four-gaps: ${failures} failure(s)`); process.exit(1); }
console.log('\n✓ four-gaps: all checks passed');
