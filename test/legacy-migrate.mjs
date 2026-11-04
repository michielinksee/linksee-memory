#!/usr/bin/env node
// Regression: `linksee-memory migrate` (0.17.2, L-1-068 / L-1-122) and `linksee-memory runtime prune`.
//
// migrate — schema 5 fixtures in four on-disk states (rollback journal, clean WAL, un-checkpointed
// WAL, hot journal) built by fixtures/make-legacy-db.cjs:
//   • --dry writes nothing (memory.db / -wal / -journal byte-identical, folder listing unchanged)
//   • a real run ends at the current schema, keeps every row, leaves a consistent backup
//     (integrity_check = ok, schema 5, same rows), and the server's openDb accepts the result
//   • a step that throws (injected through onStep) → rolled back: schema still 5, rows and tables
//     as before, rollback-journal file byte-identical, backup present and consistent
//   • a step that deletes a row → the count check refuses to commit
//   • another process holding the lock → refused before anything is written
//   • schema ≥ 6 → "not needed", nothing written
// runtime prune — referenced / unreferenced / could-not-confirm.
//
// Run: node test/legacy-migrate.mjs   (needs `pnpm build`; throwaway dirs, temp HOME)

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync, statSync, writeFileSync, copyFileSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'dist', 'mcp', 'server.js');
const MAKE = join(HERE, 'fixtures', 'make-legacy-db.cjs');
const V5 = join(HERE, 'fixtures', 'schema-v5.sql');
const Database = createRequire(import.meta.url)('better-sqlite3');
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); failures++; }
};
console.log('legacy-migrate regression');

const dirs = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
// Never the real ~/.linksee-memory or ~/.claude: every child gets a temp HOME and memory dir.
const HOME = tmp('linksee-migrate-home-');
const baseEnv = { ...process.env, HOME, USERPROFILE: HOME, LINKSEE_MEMORY_DIR: join(HOME, '.linksee-memory'), LINKSEE_TELEMETRY: 'off' };
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.LINKSEE_MEMORY_DIR = baseEnv.LINKSEE_MEMORY_DIR;

const { migrateLegacy, currentSchemaVersion } = await import('../dist/bin/migrate-legacy.js');
const { pruneRuntimes, defaultSources } = await import('../dist/bin/runtime.js');
const TARGET = String(currentSchemaVersion());

const filesOf = (dir) => readdirSync(dir).sort();
const dbFiles = (dir) => filesOf(dir).filter((f) => /^memory\.db(-wal|-journal)?$/.test(f));
const shaAll = (dir) => JSON.stringify(Object.fromEntries(dbFiles(dir).map((f) => [f, sha(join(dir, f))])));
const make = (state) => {
  const dir = tmp(`linksee-migrate-${state}-`);
  const file = join(dir, 'memory.db');
  spawnSync(process.execPath, [MAKE, file, V5, state], { encoding: 'utf8' });
  return { dir, file };
};
/** Logical state through a throwaway copy of every memory.db* file (opening it may recover it). */
const logical = (dir) => {
  const c = tmp('linksee-migrate-copy-');
  for (const f of filesOf(dir).filter((f) => /^memory\.db(-wal|-journal)?$/.test(f))) copyFileSync(join(dir, f), join(c, f));
  const db = new Database(join(c, 'memory.db'));
  try {
    return JSON.stringify({
      master: db.prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`).all(),
      meta: db.prepare(`SELECT * FROM meta ORDER BY key`).all(),
      memories: db.prepare(`SELECT id, content FROM memories ORDER BY id`).all(),
      entities: db.prepare(`SELECT * FROM entities ORDER BY id`).all(),
    });
  } finally { db.close(); }
};
const versionOf = (file) => {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { return db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get()?.value; } finally { db.close(); }
};
const backupsIn = (dir) => filesOf(dir).filter((f) => /^memory\.db\.pre-migrate-\d{8}T\d{6}Z$/.test(f));
const backupOk = (path) => {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return {
      ic: db.pragma('integrity_check', { simple: true }),
      v: db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get()?.value,
      mem: db.prepare(`SELECT COUNT(*) c FROM memories`).get().c,
      ent: db.prepare(`SELECT COUNT(*) c FROM entities`).get().c,
    };
  } finally { db.close(); }
};
const cli = (args, env = {}) => spawnSync(process.execPath, [SERVER, ...args], { encoding: 'utf8', timeout: 60000, input: '', env: { ...baseEnv, ...env } });

const STATES = ['rollback', 'walclean', 'wal', 'hot'];

// 1. --dry writes nothing, then a real run migrates and keeps every row
for (const state of STATES) {
  const { dir, file } = make(state);
  if (state === 'wal') check(`[${state}] fixture has an un-checkpointed -wal`, existsSync(file + '-wal') && statSync(file + '-wal').size > 0, filesOf(dir).join(','));
  if (state === 'hot') check(`[${state}] fixture has a hot -journal`, existsSync(file + '-journal') && statSync(file + '-journal').size > 0, filesOf(dir).join(','));
  const listBefore = filesOf(dir).join(',');
  const shaBefore = shaAll(dir);
  const logicalBefore = logical(dir);

  const dry = cli(['migrate', '--dry', '--db', file]);
  check(`[${state}] --dry exits 0 and says schema 5`, dry.status === 0 && /\[dry\].*schema 5/.test(dry.stdout), `${dry.status} ${dry.stdout}${dry.stderr}`);
  check(`[${state}] --dry lists the steps and the backup it would make`, /would back up/.test(dry.stdout) && /v5→v6/.test(dry.stdout) && /drift_anchors/.test(dry.stdout), dry.stdout);
  check(`[${state}] --dry: memory.db / -wal / -journal byte-identical`, shaAll(dir) === shaBefore);
  check(`[${state}] --dry: folder listing unchanged (no -shm, no backup)`, filesOf(dir).join(',') === listBefore, `${listBefore} → ${filesOf(dir).join(',')}`);

  const run = cli(['migrate', '--db', file]);
  check(`[${state}] migrate exits 0`, run.status === 0, `${run.status} ${run.stdout}${run.stderr}`);
  check(`[${state}] now at schema ${TARGET}`, versionOf(file) === TARGET, versionOf(file));
  check(`[${state}] report shows the four tables`, ['memories', 'entities', 'memory_edges', 'drift_anchors'].every((t) => run.stdout.includes(t)), run.stdout);
  check(`[${state}] no consolidate, no server`, !/consolidat(ed|ing) \d|MCP server running/i.test(run.stdout + run.stderr) && /Nothing was consolidated or deleted/.test(run.stdout), run.stdout);
  {
    const db = new Database(file, { readonly: true });
    const mem = db.prepare(`SELECT content FROM memories ORDER BY id`).all();
    const ent = db.prepare(`SELECT COUNT(*) c FROM entities`).get().c;
    const da = db.prepare(`SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='drift_anchors'`).get().c;
    const xcols = db.prepare(`PRAGMA table_xinfo(memories)`).all().map((c) => c.name);
    db.close();
    check(`[${state}] rows kept (1 memory, 1 entity — the hot journal's uncommitted rows are not data)`, mem.length === 1 && JSON.parse(mem[0].content).why === 'the reason' && ent === 1, JSON.stringify(mem).slice(0, 120));
    check(`[${state}] drift_anchors created, v6/v7 columns present`, da === 1 && ['altitude', 'mem_type', 'thread_id'].every((c) => xcols.includes(c)));
  }
  const bks = backupsIn(dir);
  check(`[${state}] one backup memory.db.pre-migrate-<ts>`, bks.length === 1, filesOf(dir).join(','));
  if (bks.length === 1) {
    const b = backupOk(join(dir, bks[0]));
    check(`[${state}] backup: integrity_check ok, schema 5, same rows`, b.ic === 'ok' && b.v === '5' && b.mem === 1 && b.ent === 1, JSON.stringify(b));
  }
  if (state === 'hot') {
    const raw = filesOf(dir).filter((f) => /-hot(-journal)?$/.test(f));
    check(`[hot] raw copy of memory.db + -journal kept byte for byte`, raw.length === 2, filesOf(dir).join(','));
  }
  // the 0.17.x server path accepts the migrated file
  {
    process.env.LINKSEE_MEMORY_DIR = dir;
    const mod = await import(`../dist/db/migrate.js?after=${encodeURIComponent(dir)}`);
    let err = null;
    try { const db = mod.openDb(); mod.runMigrations(db); db.close(); } catch (e) { err = e; }
    check(`[${state}] openDb + runMigrations accept the migrated file`, err === null, String(err));
    process.env.LINKSEE_MEMORY_DIR = baseEnv.LINKSEE_MEMORY_DIR;
  }
  const again = cli(['migrate', '--db', file]);
  check(`[${state}] second run: not needed, exit 0`, again.status === 0 && /not needed/.test(again.stdout), again.stdout + again.stderr);
  if (state === 'rollback') check('logical state before migrate was readable', logicalBefore.includes('keep me'));
}

// 2. a step throws half-way → rolled back: schema 5, same tables/rows, backup kept
for (const state of STATES) {
  const { dir, file } = make(state);
  const logicalBefore = logical(dir);
  const shaBefore = sha(file);
  const lines = [];
  const r = migrateLegacy({
    dbPath: file, now: new Date('2026-11-04T00:00:00Z'), log: (l) => lines.push(l),
    onStep: (step) => { if (step === 'v6-v7') throw new Error('injected failure at v6-v7'); },
  });
  check(`[${state}] injected failure → outcome failed, exit code 1`, r.code === 1 && r.outcome === 'failed', JSON.stringify(r));
  check(`[${state}] failure message + restore steps`, lines.some((l) => /injected failure/.test(l)) && lines.some((l) => /rolled back/.test(l)) && lines.some((l) => /copy .*pre-migrate/.test(l)), lines.join(' | '));
  check(`[${state}] schema version not advanced (5)`, versionOf(file) === '5', versionOf(file));
  check(`[${state}] tables and rows exactly as before`, logical(dir) === logicalBefore);
  if (state === 'rollback') check(`[${state}] memory.db byte-identical after the rollback`, sha(file) === shaBefore);
  check(`[${state}] no -journal left behind`, !existsSync(file + '-journal'), filesOf(dir).join(','));
  const bk = join(dir, 'memory.db.pre-migrate-20261104T000000Z');
  check(`[${state}] backup exists`, existsSync(bk), filesOf(dir).join(','));
  if (existsSync(bk)) { const b = backupOk(bk); check(`[${state}] backup integrity_check ok, schema 5`, b.ic === 'ok' && b.v === '5', JSON.stringify(b)); }
  // and the file still migrates afterwards
  const r2 = migrateLegacy({ dbPath: file, now: new Date('2026-11-04T00:00:01Z'), log: () => {} });
  check(`[${state}] a clean retry then migrates`, r2.code === 0 && versionOf(file) === TARGET, JSON.stringify(r2));
}

// 3. a step that loses a row → the count check refuses to commit
{
  const { dir, file } = make('rollback');
  const before = logical(dir);
  const lines = [];
  const r = migrateLegacy({
    dbPath: file, log: (l) => lines.push(l),
    onStep: (step, db) => { if (step === 'schema.sql') db.prepare('DELETE FROM memories').run(); },
  });
  check('row loss → failed, names the table', r.code === 1 && lines.some((l) => /rows would be lost in: memories 1→0/.test(l)), lines.join(' | '));
  check('row loss → schema 5 and the memory still there', versionOf(file) === '5' && logical(dir) === before);
}

// 4. another process holds the lock → refused before anything is written
{
  const { dir, file } = make('rollback');
  const holder = spawn(process.execPath, [join(HERE, 'fixtures', 'hold-lock.cjs'), file], { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise((res) => holder.stdout.on('data', (d) => { if (String(d).includes('locked')) res(); }));
  const listBefore = filesOf(dir).join(',');
  const shaBefore = sha(file);
  const r = cli(['migrate', '--db', file]);
  check('busy: exit 1, says close other clients, no stack trace', r.status === 1 && /Another client may have it open|write lock/.test(r.stderr + r.stdout) && !/\n\s+at /.test(r.stderr), `${r.status} ${r.stdout}${r.stderr}`);
  check('busy: nothing written, no backup', filesOf(dir).join(',') === listBefore && sha(file) === shaBefore, `${listBefore} → ${filesOf(dir).join(',')}`);
  holder.stdin.end();
  await new Promise((res) => holder.on('exit', res));
}

// 5. schema ≥ 6 → not needed, nothing written; no file → nothing to do
{
  const dir = tmp('linksee-migrate-v7-');
  const file = join(dir, 'memory.db');
  const db = new Database(file);
  db.exec(readFileSync(join(HERE, 'fixtures', 'schema-v7.sql'), 'utf8'));
  db.close();
  const listBefore = filesOf(dir).join(','); const shaBefore = sha(file);
  const r = cli(['migrate', '--db', file]);
  check('schema 7: "not needed", exit 0', r.status === 0 && /schema 7: migrate is not needed/.test(r.stdout), r.stdout + r.stderr);
  check('schema 7: nothing written', filesOf(dir).join(',') === listBefore && sha(file) === shaBefore, `${listBefore} → ${filesOf(dir).join(',')}`);
  const none = cli(['migrate', '--db', join(dir, 'nope.db')]);
  check('no file: exit 0, nothing created', none.status === 0 && !existsSync(join(dir, 'nope.db')), none.stdout);
}

// 6. runtime prune: referenced / unreferenced / could not confirm
{
  const mem = tmp('linksee-prune-mem-');
  const home = tmp('linksee-prune-home-');
  const proj = tmp('linksee-prune-proj-');
  const mkRt = () => {
    for (const v of ['0.16.0', '0.17.0', '0.17.1']) {
      mkdirSync(join(mem, 'runtime', v, 'node_modules', 'linksee-memory'), { recursive: true });
      writeFileSync(join(mem, 'runtime', v, 'node_modules', 'linksee-memory', 'package.json'), JSON.stringify({ version: v }));
    }
    mkdirSync(join(mem, 'runtime', '.tmp-0.17.2-999'), { recursive: true });
    mkdirSync(join(mem, 'runtime', '0.17.1.old-123'), { recursive: true });
  };
  mkRt();
  mkdirSync(join(home, '.claude'), { recursive: true });
  // as setup writes it on Windows: forward slashes in the command, inside JSON
  const rtRoot = join(mem, 'runtime', '0.17.1', 'node_modules', 'linksee-memory').replace(/\\/g, '/');
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `"node" "${rtRoot}/dist/bin/sync-session.js" --linksee-managed` }] }] } }, null, 2));
  // a project settings file with backslashes (JSON-escaped) referencing 0.16.0
  mkdirSync(join(proj, '.claude'), { recursive: true });
  writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `"node" "${join(mem, 'runtime', '0.16.0', 'node_modules', 'linksee-memory')}\\dist\\bin\\guard-hook.js"` }] }] } }));
  const sources = defaultSources(home, proj);
  const rt = (...v) => v.map((x) => existsSync(join(mem, 'runtime', x)));

  const lines = [];
  const list = pruneRuntimes({ memoryDir: mem, sources, yes: false, log: (l) => lines.push(l) });
  check('prune without --yes deletes nothing', rt('0.16.0', '0.17.0', '0.17.1').every(Boolean) && list.code === 0, lines.join(' | '));
  check('prune lists sizes and the referencing file', lines.some((l) => /0\.17\.1 .*keep — referenced by .*settings\.json/.test(l)) && lines.some((l) => /0\.17\.0 .*can be deleted/.test(l)), lines.join(' | '));

  // could not confirm: a broken settings file passed with --settings → nothing deleted
  const broken = join(proj, 'broken.json');
  writeFileSync(broken, '{ "hooks": [');
  const l2 = [];
  const r2 = pruneRuntimes({ memoryDir: mem, sources: [...sources, { path: broken, explicit: true }], yes: true, log: (l) => l2.push(l) });
  check('unconfirmable (broken JSON): nothing deleted, exit 1, reason shown', rt('0.16.0', '0.17.0', '0.17.1').every(Boolean) && r2.code === 1 && l2.some((l) => /not valid JSON/.test(l)), l2.join(' | '));
  const l3 = [];
  const r3 = pruneRuntimes({ memoryDir: mem, sources: [...sources, { path: join(proj, 'missing.json'), explicit: true }], yes: true, log: (l) => l3.push(l) });
  check('unconfirmable (--settings file missing): nothing deleted', rt('0.16.0', '0.17.0', '0.17.1').every(Boolean) && r3.code === 1 && l3.some((l) => /not found/.test(l)), l3.join(' | '));

  // referenced kept, unreferenced deleted, in-progress / aside folders untouched (via the CLI)
  const r4 = spawnSync(process.execPath, [SERVER, 'runtime', 'prune', '--yes'], { cwd: proj, encoding: 'utf8', input: '', env: { ...baseEnv, HOME: home, USERPROFILE: home, LINKSEE_MEMORY_DIR: mem } });
  check('prune --yes exits 0', r4.status === 0, `${r4.status} ${r4.stdout}${r4.stderr}`);
  check('referenced 0.17.1 (user settings) and 0.16.0 (project settings, backslashes) kept', rt('0.17.1', '0.16.0').every(Boolean), r4.stdout);
  check('unreferenced 0.17.0 deleted', !rt('0.17.0')[0], r4.stdout);
  check('.tmp-* and *.old-* left alone', rt('.tmp-0.17.2-999', '0.17.1.old-123').every(Boolean) && !filesOf(join(mem, 'runtime')).some((f) => f.startsWith('.pruning-')), filesOf(join(mem, 'runtime')).join(','));
}

for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
