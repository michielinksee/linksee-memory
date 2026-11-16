#!/usr/bin/env node
// Regression (0.20.2): remember on a NEW memory whose content is a JSON object with a string `what`
// and no title (or an empty one) makes a title from `what` and marks it title_auto: true.
// 63 of the untitled memories of the last 14 days on one DB came from agents that sent such JSON.
//   - first sentence / line of `what`, trimmed; cut at a newline or 。．！？ (and . ! ? before whitespace / the end)
//   - over 60 code points -> 57 + "…"
//   - a title the caller sent is kept as is, with no title_auto
//   - updates (replace and merge: true) never add one; plain text never gets one
// Fictional text, throwaway DB + HOME. Run: node test/auto-title.mjs   (needs `pnpm build`)

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'linksee-auto-title-'));
const home = join(dir, 'home');
mkdirSync(home);
const env = { ...process.env, LINKSEE_MEMORY_DIR: dir, LINKSEE_TELEMETRY: 'off', HOME: home, USERPROFILE: home, LINKSEE_AUTO_CONSOLIDATE: '' };
delete env.LINKSEE_NO_CAPTURE;
process.env.LINKSEE_MEMORY_DIR = dir;

const { openDb } = await import('../dist/db/migrate.js');

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' - ' + extra : ''}`); failures++; }
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


const readContent = (id) => { const db = openDb(); try { return JSON.parse(db.prepare('SELECT content FROM memories WHERE id = ?').get(id).content); } finally { db.close(); } };
const ax = { altitude: 'implementation', type: 'decision', state: 'decided' };
let server;
try {
  console.log('auto-title (0.20.2)');
  server = startServer();
  await server.ready;
  const { call } = server;
  const create = async (obj, extra = {}) => {
    const r = await call('remember', { entity_name: 'orbit-fiction', entity_kind: 'project', content: typeof obj === 'string' ? obj : JSON.stringify(obj), ...extra });
    return { r, id: r.memory_id, c: r.ok ? readContent(r.memory_id) : null };
  };
  const dump = (t) => JSON.stringify(t.c ?? t.r).slice(0, 240);

  let t = await create({ ...ax, what: 'Keep the lantern cache warm across deploys' });
  check('what only -> title is what, title_auto true', t.c?.title === 'Keep the lantern cache warm across deploys' && t.c?.title_auto === true, dump(t));
  check('the other keys are kept', t.c?.what === 'Keep the lantern cache warm across deploys' && t.c?.type === 'decision', dump(t));

  const long = 'Harbor job prewarming was rejected because it would double the runtime of the nightly harbor batch for no gain';
  t = await create({ ...ax, what: long });
  check('long what is cut: first 57 code points + ellipsis', t.c?.title === Array.from(long).slice(0, 57).join('') + '…', dump(t));
  check('the cut title is flagged auto and is 58 code points', t.c?.title_auto === true && Array.from(t.c?.title ?? '').length === 58, dump(t));

  const exact = 'x'.repeat(60);
  t = await create({ ...ax, what: exact });
  check('exactly 60 characters is kept whole', t.c?.title === exact, dump(t));
  const jp61 = 'あ'.repeat(61);
  t = await create({ ...ax, what: jp61 });
  check('61 Japanese characters -> 57 + ellipsis', t.c?.title === 'あ'.repeat(57) + '…', dump(t));
  const emoji = '\u{1F600}'.repeat(61);
  t = await create({ ...ax, what: emoji });
  check('counted in code points, not UTF-16 units', t.c?.title === '\u{1F600}'.repeat(57) + '…', dump(t));

  t = await create({ ...ax, what: 'First line of the note\nsecond line stays out' });
  check('cut at a newline', t.c?.title === 'First line of the note', dump(t));
  t = await create({ ...ax, what: 'Cache stays warm. The reason follows here.' });
  check('cut at an English full stop', t.c?.title === 'Cache stays warm', dump(t));
  t = await create({ ...ax, what: 'Is the cache warm? Yes it is' });
  check('cut at a question mark', t.c?.title === 'Is the cache warm', dump(t));
  t = await create({ ...ax, what: 'Pinned lantern v0.19.1 for the night shift' });
  check('a dot inside a version number does not cut', t.c?.title === 'Pinned lantern v0.19.1 for the night shift', dump(t));

  const jpHead = 'ランタンのキャッシュを温めたままにする';
  t = await create({ ...ax, what: '  ' + jpHead + '。理由は夜勤の待ち時間。 ' });
  check('Japanese: trimmed and cut at the ideographic full stop', t.c?.title === jpHead && t.c?.title_auto === true, dump(t));
  t = await create({ ...ax, what: '本当に温める！理由は後で' });
  check('Japanese: cut at a full-width exclamation mark', t.c?.title === '本当に温める', dump(t));
  t = await create({ ...ax, what: 'Empty title string gets one', title: '' });
  check('title: "" counts as no title', t.c?.title === 'Empty title string gets one' && t.c?.title_auto === true, dump(t));

  t = await create({ ...ax, what: 'Some what text here', title: 'My own title' });
  check('a given title is kept as is', t.c?.title === 'My own title', dump(t));
  check('no title_auto when the title was given', t.c && !('title_auto' in t.c), dump(t));

  t = await create({ what: 'Bare what without axes' });
  check('what-only JSON (no axes) gets a top-level title too', t.r.ok && t.c?.title === 'Bare what without axes' && t.c?.title_auto === true, dump(t));

  t = await create('Plain sentence about the lantern cache. Nothing structured.');
  check('plain text gets no title', t.r.ok && t.c && !('title' in t.c) && !('title_auto' in t.c), dump(t));

  // updates never add one
  const base = await create({ ...ax, what: 'Base row for update tests', title: 'Base title' });
  const old = await create({ ...ax, what: 'Row that will be made untitled' });
  { const db = openDb(); try { db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(JSON.stringify({ ...ax, what: 'Old untitled row' }), old.id); } finally { db.close(); } }
  let u = await call('remember', { memory_id: old.id, importance: 0.6 });
  check('an update without content leaves it untitled', u.ok && !('title' in readContent(old.id)), JSON.stringify(readContent(old.id)));
  u = await call('remember', { memory_id: old.id, content: JSON.stringify({ ...ax, what: 'Replaced content without a title' }) });
  check('update (replace) does not add a title', u.ok && !('title' in readContent(old.id)) && !('title_auto' in readContent(old.id)), JSON.stringify(u).slice(0, 200) + JSON.stringify(readContent(old.id)));
  u = await call('remember', { memory_id: old.id, merge: true, content: JSON.stringify({ what: 'Merged what without a title' }) });
  check('update (merge: true) does not add a title', u.ok && readContent(old.id).what === 'Merged what without a title' && !('title' in readContent(old.id)) && !('title_auto' in readContent(old.id)), JSON.stringify(u).slice(0, 200) + JSON.stringify(readContent(old.id)));
  check('the given title of another row is untouched', readContent(base.id).title === 'Base title');
} finally {
  if (server) await server.stop();
}
if (failures) { console.log(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('\nall auto-title checks passed');
