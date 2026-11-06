#!/usr/bin/env node
// sqlite-driver — 0.19.0: SQLite moved from better-sqlite3 to node:sqlite (src/db/sqlite.ts).
//
// Why: npm 12 stops dependency install scripts by default, so `npx -y linksee-memory` got
// better-sqlite3 with no native binding and died on "Could not locate the bindings file".
//
//   1. the driver layer behaves the same on both drivers: plain rows, Buffer blobs, Number ids,
//      SQLITE_* error codes, transaction rollback / savepoints / immediate, pragma, fileMustExist,
//      readonly, busy timeout; only node:sqlite's ExperimentalWarning is silenced
//   2. a package with NO better-sqlite3 at all (what npm 12's plain npx leaves usable) starts the
//      MCP server and remember → recall works; forcing better there exits 1 with one line
//   3. round trip: a DB written through better-sqlite3 is read and written through node:sqlite,
//      then read again through better-sqlite3 (same file, same schema, WAL, FTS5)
//
// The node:sqlite parts are skipped (said so, not silently) on a Node without node:sqlite.

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const base = mkdtempSync(join(tmpdir(), 'linksee-sqlite-driver-'));
const layer = await import(pathToFileURL(join(DIST, 'db', 'sqlite.js')).href);

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); failures++; }
};

const hasNode = (() => {
  const prev = process.env.LINKSEE_SQLITE_DRIVER;
  process.env.LINKSEE_SQLITE_DRIVER = 'node';
  try { return layer.driverName() === 'node'; } catch { return false; } finally {
    if (prev === undefined) delete process.env.LINKSEE_SQLITE_DRIVER; else process.env.LINKSEE_SQLITE_DRIVER = prev;
  }
})();
const drivers = hasNode ? ['node', 'better'] : ['better'];
if (!hasNode) console.log(`  skip node:sqlite parts — Node ${process.versions.node} has no node:sqlite`);

// ---- 1. the layer, on each driver ---------------------------------------------------------------
const savedDriver = process.env.LINKSEE_SQLITE_DRIVER;
for (const drv of drivers) {
  process.env.LINKSEE_SQLITE_DRIVER = drv;
  const p = join(base, `unit-${drv}.db`);
  const db = new layer.Database(p);
  check(`[${drv}] driver chosen`, db.driver === drv, db.driver);
  db.pragma('journal_mode = WAL');
  check(`[${drv}] pragma simple`, db.pragma('journal_mode', { simple: true }) === 'wal');
  check(`[${drv}] pragma rows`, Array.isArray(db.pragma('table_info(sqlite_master)')));
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, b BLOB); CREATE VIRTUAL TABLE f USING fts5(c, tokenize=\'trigram\');');
  const r = db.prepare('INSERT INTO t (v, b) VALUES (?, ?)').run('a', Buffer.from([1, 2, 3]));
  check(`[${drv}] run → numbers`, typeof r.lastInsertRowid === 'number' && r.lastInsertRowid === 1 && r.changes === 1, JSON.stringify(r));
  const row = db.prepare('SELECT * FROM t WHERE id = ?').get(1);
  check(`[${drv}] row is a plain object`, Object.getPrototypeOf(row) === Object.prototype && row.v === 'a');
  check(`[${drv}] blob is a Buffer`, Buffer.isBuffer(row.b) && row.b.equals(Buffer.from([1, 2, 3])));
  check(`[${drv}] named params (bare keys)`, db.prepare('SELECT v FROM t WHERE id = @id').get({ id: 1 })?.v === 'a');
  check(`[${drv}] array params`, db.prepare('SELECT count(*) n FROM t WHERE id IN (?, ?)').get([1, 2]).n === 1);
  check(`[${drv}] get() with no row → undefined`, db.prepare('SELECT * FROM t WHERE id = 99').get() === undefined);
  check(`[${drv}] iterate`, [...db.prepare('SELECT id FROM t').iterate()].length === 1);
  let code = '';
  try { db.prepare('INSERT INTO t (id, v) VALUES (1, ?)').run('dup'); } catch (e) { code = e.code; }
  check(`[${drv}] constraint error code`, code === 'SQLITE_CONSTRAINT_PRIMARYKEY', code);

  // transactions: commit, rollback on throw, nested savepoint, immediate, promise refused
  const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
  const count = () => db.prepare('SELECT count(*) n FROM t').get().n;
  db.transaction((xs) => { for (const x of xs) ins.run(x); })(['b', 'c']);
  check(`[${drv}] transaction commits`, count() === 3);
  try { db.transaction(() => { ins.run('d'); throw new Error('boom'); })(); } catch { /* expected */ }
  check(`[${drv}] transaction rolls back on throw`, count() === 3 && !db.inTransaction);
  db.transaction(() => {
    ins.run('e');
    try { db.transaction(() => { ins.run('f'); throw new Error('inner'); })(); } catch { /* expected */ }
    check(`[${drv}] inTransaction inside`, db.inTransaction === true);
  })();
  check(`[${drv}] nested: inner rolled back, outer kept`, count() === 4 && !db.prepare("SELECT 1 FROM t WHERE v = 'f'").get());
  check(`[${drv}] .immediate returns the value`, db.transaction(() => 42).immediate() === 42);
  let promiseErr = '';
  try { db.transaction(async () => { ins.run('g'); })(); } catch (e) { promiseErr = e.message; }
  check(`[${drv}] promise-returning transaction refused and rolled back`, /cannot return a promise/.test(promiseErr) && count() === 4, promiseErr);
  db.prepare('INSERT INTO f (c) VALUES (?)').run('引き継ぎの理由');
  check(`[${drv}] FTS5 trigram`, db.prepare('SELECT count(*) n FROM f WHERE f MATCH ?').get('引き継ぎ').n === 1);
  check(`[${drv}] foreign keys start ON (better-sqlite3's build default)`, db.pragma('foreign_keys', { simple: true }) === 1);

  // busy: another connection holds the write lock, timeout 0 → SQLITE_BUSY at once
  const other = new layer.Database(p, { timeout: 0 });
  db.exec('BEGIN IMMEDIATE');
  let busy = '';
  try { other.exec('BEGIN IMMEDIATE'); } catch (e) { busy = e.code; }
  db.exec('ROLLBACK');
  other.close();
  check(`[${drv}] busy → SQLITE_BUSY`, busy === 'SQLITE_BUSY', busy);
  db.close();
  check(`[${drv}] closed`, db.open === false);

  const ro = new layer.Database(p, { readonly: true, fileMustExist: true });
  let roErr = '';
  try { ro.exec("INSERT INTO t (v) VALUES ('x')"); } catch (e) { roErr = e.code; }
  ro.close();
  check(`[${drv}] readonly write → SQLITE_READONLY`, roErr === 'SQLITE_READONLY', roErr);
  let cant = '';
  try { new layer.Database(join(base, 'missing.db'), { fileMustExist: true }); } catch (e) { cant = e.code; }
  check(`[${drv}] fileMustExist → SQLITE_CANTOPEN, no file made`, cant === 'SQLITE_CANTOPEN' && !existsSync(join(base, 'missing.db')), cant);
}
if (savedDriver === undefined) delete process.env.LINKSEE_SQLITE_DRIVER; else process.env.LINKSEE_SQLITE_DRIVER = savedDriver;

// an unknown driver name is refused, not guessed
{
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(pathToFileURL(join(DIST, 'db', 'sqlite.js')).href)}); try { new m.Database(':memory:'); } catch (e) { console.log(e.code); }`], {
    encoding: 'utf8', env: { ...process.env, LINKSEE_SQLITE_DRIVER: 'sqlite3' },
  });
  check('unknown LINKSEE_SQLITE_DRIVER refused', r.stdout.trim() === layer.NO_DRIVER_CODE, r.stdout + r.stderr);
}

// only the SQLite ExperimentalWarning is silenced
if (hasNode) {
  const code = `const m = await import(${JSON.stringify(pathToFileURL(join(DIST, 'db', 'sqlite.js')).href)}); new m.Database(':memory:').close(); process.emitWarning('other thing', 'ExperimentalWarning');`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, LINKSEE_SQLITE_DRIVER: 'node' } });
  check('SQLite ExperimentalWarning silenced', !/SQLite is an experimental/.test(r.stderr), r.stderr);
  check('other warnings still shown', /other thing/.test(r.stderr), r.stderr);
}

// ---- MCP helper ----------------------------------------------------------------------------------
function startServer(serverJs, env, cwd) {
  const projectDir = join(base, 'proj');
  mkdirSync(projectDir, { recursive: true });
  const child = spawn(process.execPath, [serverJs], { stdio: ['pipe', 'pipe', 'pipe'], env, cwd });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
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
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { roots: [{ uri: pathToFileURL(projectDir).href, name: 'proj' }] } }) + '\n');
        continue;
      }
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((res, rej) => {
    const my = ++id;
    const t = setTimeout(() => { pending.delete(my); rej(new Error(`timeout: ${method} — stderr: ${stderr.slice(0, 300)}`)); }, 30000);
    pending.set(my, (m) => { clearTimeout(t); res(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n');
  });
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const text = r.result?.content?.[0]?.text ?? '';
    try { return JSON.parse(text); } catch { return { _raw: text, _error: r.error }; }
  };
  const init = async () => {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: { roots: { listChanged: false } }, clientInfo: { name: 'test', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  };
  const stop = () => new Promise((res) => { child.once('exit', res); child.stdin.end(); setTimeout(() => child.kill(), 5000); });
  return { child, rpc, call, init, stop, stderr: () => stderr };
}
const baseEnv = (dir, extra = {}) => {
  const env = { ...process.env, LINKSEE_MEMORY_DIR: dir, HOME: base, USERPROFILE: base, LINKSEE_TELEMETRY: 'off', LINKSEE_AUTO_CONSOLIDATE: '', ...extra };
  if (!('LINKSEE_SQLITE_DRIVER' in extra)) delete env.LINKSEE_SQLITE_DRIVER;
  return env;
};
const recalled = (r, token) => JSON.stringify(r).includes(token);

// ---- 2. a package with no better-sqlite3 (npm 12's plain npx) ---------------------------------------
if (hasNode) {
  const nm = join(base, 'nobs', 'node_modules');
  const pkgRoot = join(nm, 'linksee-memory');
  mkdirSync(pkgRoot, { recursive: true });
  cpSync(DIST, join(pkgRoot, 'dist'), { recursive: true });
  const pj = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'linksee-memory', version: pj.version, type: 'module' }));
  for (const dep of Object.keys(pj.dependencies)) {
    const target = realpathSync(join(ROOT, 'node_modules', dep));
    const link = join(nm, dep);
    mkdirSync(dirname(link), { recursive: true });
    if (!existsSync(link)) symlinkSync(target, link, 'junction');
  }
  const probe = spawnSync(process.execPath, ['-e', 'try{require.resolve("better-sqlite3");console.log("found")}catch{console.log("absent")}'], { cwd: pkgRoot, encoding: 'utf8' });
  check('fixture: better-sqlite3 cannot be resolved from the package', probe.stdout.trim() === 'absent', probe.stdout);

  const dir = join(base, 'mem-nobs');
  const s = startServer(join(pkgRoot, 'dist', 'mcp', 'server.js'), baseEnv(dir), pkgRoot);
  try {
    await s.init();
    const rem = await s.call('remember', { content: 'nobs-token-7f3: chose node:sqlite so npm 12 npx starts' });
    check('no better-sqlite3: remember ok', rem.ok === true, JSON.stringify(rem).slice(0, 200));
    const rec = await s.call('recall', { query: 'nobs-token-7f3' });
    check('no better-sqlite3: recall finds it', recalled(rec, 'nobs-token-7f3'), JSON.stringify(rec).slice(0, 200));
  } catch (e) { check('no better-sqlite3: server answered', false, e.message); }
  await s.stop();
  check('no better-sqlite3: "MCP server ready" on stderr', /MCP server ready/.test(s.stderr()), s.stderr().slice(0, 300));
  check('no better-sqlite3: no ExperimentalWarning, no bindings error', !/ExperimentalWarning|bindings/.test(s.stderr()), s.stderr().slice(0, 300));

  // forcing the missing driver: exit 1, one line, nothing on stdout
  const f = spawnSync(process.execPath, [join(pkgRoot, 'dist', 'mcp', 'server.js')], { input: '', encoding: 'utf8', env: baseEnv(join(base, 'mem-forced'), { LINKSEE_SQLITE_DRIVER: 'better' }), cwd: pkgRoot, timeout: 30000 });
  const lines = f.stderr.split(/\r?\n/).filter(Boolean);
  check('forced better, absent: exit 1', f.status === 1, `exit ${f.status}`);
  check('forced better, absent: one stderr line with the way out', lines.length === 1 && lines[0].startsWith(layer.NO_DRIVER_HINT), JSON.stringify(f.stderr.slice(0, 400)));
  check('forced better, absent: stdout empty (MCP stdio not polluted)', f.stdout === '');
  check('forced better, absent: no DB created', !existsSync(join(base, 'mem-forced', 'memory.db')));
}

// ---- 3. round trip better → node → better on one file ------------------------------------------------
if (hasNode) {
  const dir = join(base, 'mem-roundtrip');
  const serverJs = join(DIST, 'mcp', 'server.js');
  const phase = async (drv, write, expect) => {
    const s = startServer(serverJs, baseEnv(dir, { LINKSEE_SQLITE_DRIVER: drv }), ROOT);
    try {
      await s.init();
      if (write) {
        const r = await s.call('remember', { content: `${write}: written through ${drv}` });
        check(`[${drv}] remember ${write}`, r.ok === true, JSON.stringify(r).slice(0, 200));
      }
      for (const tok of expect) {
        const rec = await s.call('recall', { query: tok });
        check(`[${drv}] recall finds ${tok}`, recalled(rec, tok), JSON.stringify(rec).slice(0, 200));
      }
    } catch (e) { check(`[${drv}] server answered`, false, e.message); }
    await s.stop();
  };
  await phase('better', 'rt-alpha-41c', []);
  await phase('node', 'rt-beta-9e2', ['rt-alpha-41c']);
  await phase('better', null, ['rt-alpha-41c', 'rt-beta-9e2']);
  for (const drv of drivers) {
    process.env.LINKSEE_SQLITE_DRIVER = drv;
    const db = new layer.Database(join(dir, 'memory.db'), { readonly: true, fileMustExist: true });
    check(`[${drv}] integrity_check ok after round trip`, db.pragma('integrity_check', { simple: true }) === 'ok');
    check(`[${drv}] journal_mode still wal`, db.pragma('journal_mode', { simple: true }) === 'wal');
    const n = db.prepare("SELECT count(*) n FROM memories_fts WHERE memories_fts MATCH ?").get('"rt-beta-9e2"').n;
    check(`[${drv}] FTS index sees the node:sqlite row`, n >= 1, String(n));
    db.close();
  }
  if (savedDriver === undefined) delete process.env.LINKSEE_SQLITE_DRIVER; else process.env.LINKSEE_SQLITE_DRIVER = savedDriver;
}

if (!process.env.KEEP) { try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp */ } } else console.log('kept', base);
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
