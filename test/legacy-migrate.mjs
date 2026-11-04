#!/usr/bin/env node
// Regression: `linksee-memory migrate` (0.17.2, L-1-068 / L-1-122) and `linksee-memory runtime prune`.
//
// migrate works on a COPY and only swaps at the end (Codex review of #19). The guarantee checked
// here: until the swap, memory.db and every sidecar (-wal, -shm, -journal) are byte-identical and
// the folder listing is unchanged — after --dry, after every injected failure, after a refusal.
// Fixtures: schema 5 in four on-disk states (fixtures/make-legacy-db.cjs) + one schema 4 file.
//
// runtime prune: referenced / unreferenced / could-not-confirm, including other-repo references,
// `\/` JSON escapes, broken TOML and TOML lines it cannot read, and the --scope-confirmed gate.
//
// Run: node test/legacy-migrate.mjs   (needs `pnpm build`; throwaway dirs, temp HOME)

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'dist', 'mcp', 'server.js');
const MAKE = join(HERE, 'fixtures', 'make-legacy-db.cjs');
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
const { pruneRuntimes, defaultSources, tomlStrings } = await import('../dist/bin/runtime.js');
const TARGET = String(currentSchemaVersion());

const filesOf = (dir) => readdirSync(dir).sort();
const LIVE = /^memory\.db(-wal|-shm|-journal)?$/;
/** memory.db and EVERY sidecar, -shm included. */
const liveSha = (dir) => JSON.stringify(Object.fromEntries(filesOf(dir).filter((f) => LIVE.test(f)).map((f) => [f, sha(join(dir, f))])));
const make = (state, schema = 5) => {
  const dir = tmp(`linksee-migrate-${state}-`);
  const file = join(dir, 'memory.db');
  spawnSync(process.execPath, [MAKE, file, join(HERE, 'fixtures', `schema-v${schema}.sql`), state], { encoding: 'utf8' });
  return { dir, file };
};
const versionOf = (file) => {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { return db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get()?.value; } finally { db.close(); }
};
const cli = (args, env = {}) => spawnSync(process.execPath, [SERVER, ...args], { encoding: 'utf8', timeout: 60000, input: '', env: { ...baseEnv, ...env } });
/** Untouched = same bytes for memory.db + every sidecar, same listing, no work/backup folder. */
const untouched = (label, dir, shaBefore, listBefore) => {
  check(`${label}: memory.db + -wal/-shm/-journal byte-identical`, liveSha(dir) === shaBefore);
  check(`${label}: folder listing unchanged (no work folder, no backup)`, filesOf(dir).join(',') === listBefore, `${listBefore} → ${filesOf(dir).join(',')}`);
};

const STATES = ['rollback', 'walclean', 'wal', 'hot'];

// 1. --dry, then a real run: migrated in place, originals byte for byte in the backup folder
for (const state of STATES) {
  const { dir, file } = make(state);
  if (state === 'wal') check(`[${state}] fixture has an un-checkpointed -wal and a -shm`, existsSync(file + '-wal') && statSync(file + '-wal').size > 0 && existsSync(file + '-shm'), filesOf(dir).join(','));
  if (state === 'hot') check(`[${state}] fixture has a hot -journal`, existsSync(file + '-journal') && statSync(file + '-journal').size > 0, filesOf(dir).join(','));
  const listBefore = filesOf(dir).join(',');
  const shaBefore = liveSha(dir);
  const perFile = Object.fromEntries(filesOf(dir).filter((f) => LIVE.test(f)).map((f) => [f, sha(join(dir, f))]));

  const dry = cli(['migrate', '--dry', '--db', file]);
  check(`[${state}] --dry exits 0, rehearses 5 → ${TARGET}`, dry.status === 0 && /\[dry\].*schema 5/.test(dry.stdout) && new RegExp(`rehearsal: schema 5 → ${TARGET}`).test(dry.stdout), `${dry.status} ${dry.stdout}${dry.stderr}`);
  check(`[${state}] --dry lists the steps`, /v5→v6/.test(dry.stdout) && /drift_anchors/.test(dry.stdout), dry.stdout);
  untouched(`[${state}] --dry`, dir, shaBefore, listBefore);

  const run = cli(['migrate', '--db', file]);
  check(`[${state}] migrate exits 0`, run.status === 0, `${run.status} ${run.stdout}${run.stderr}`);
  check(`[${state}] now at schema ${TARGET}`, versionOf(file) === TARGET, versionOf(file));
  check(`[${state}] report shows the four tables`, ['memories', 'entities', 'memory_edges', 'drift_anchors'].every((t) => run.stdout.includes(t)), run.stdout);
  check(`[${state}] nothing consolidated`, /Nothing was consolidated or deleted/.test(run.stdout), run.stdout);
  check(`[${state}] restore steps printed (current set aside first, never mix)`, /Move the CURRENT memory\.db/.test(run.stdout) && /Never combine/.test(run.stdout), run.stdout);
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
  const bks = filesOf(dir).filter((f) => /^memory\.db\.pre-migrate-\d{8}T\d{6}Z$/.test(f));
  check(`[${state}] one backup folder, no work folder left`, bks.length === 1 && !filesOf(dir).some((f) => /migrating/.test(f)), filesOf(dir).join(','));
  if (bks.length === 1) {
    const bdir = join(dir, bks[0]);
    const inBackup = Object.fromEntries(filesOf(bdir).filter((f) => f !== 'README.txt').map((f) => [f, sha(join(bdir, f))]));
    const readme = existsSync(join(bdir, 'README.txt')) ? readFileSync(join(bdir, 'README.txt'), 'utf8') : '';
    check(`[${state}] backup README.txt lists the files and says: move the current set aside, restore as one set, never mix`,
      /as one set/.test(readme) && /Move the CURRENT memory\.db and every memory\.db-wal/.test(readme) && /Never combine/.test(readme) && readme.includes('memory.db'), readme.slice(0, 300));
    check(`[${state}] backup = the original files byte for byte (sha256, sidecars included)`, JSON.stringify(inBackup) === JSON.stringify(perFile), `${JSON.stringify(Object.keys(inBackup))} vs ${JSON.stringify(Object.keys(perFile))}`);
  }
  check(`[${state}] live folder now has memory.db alone (no stale -wal/-journal)`, filesOf(dir).filter((f) => LIVE.test(f)).join(',') === 'memory.db', filesOf(dir).join(','));
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
}

// 2. injected failures: the live files must stay byte-identical (sidecars included)
const STAMP = new Date('2026-11-04T00:00:00Z');
const injections = {
  'a migrate.ts step throws (v6-v7)': () => (step) => { if (step === 'v6-v7') throw new Error('injected failure at v6-v7'); },
  'VACUUM INTO fails (output exists)': (file) => (step) => { if (step === 'vacuum-into') writeFileSync(join(`${file}.migrating-20261104T000000Z-${process.pid}`, 'replica.db'), 'not empty'); },
  'replica check fails (row removed from the replica)': () => (step, db) => { if (step === 'verify-replica') db.prepare('DELETE FROM memories').run(); },
  'a step loses a row (count check)': () => (step, db) => { if (step === 'schema.sql') db.prepare('DELETE FROM memories').run(); },
  'COMMIT fails (deferred foreign key)': () => (step, db) => {
    if (step === 'commit') { db.pragma('defer_foreign_keys = ON'); db.prepare(`INSERT INTO memories (entity_id, layer, content, importance) VALUES (99999, 'learning', '{}', 0.5)`).run(); }
  },
};
const expectLine = {
  'a migrate.ts step throws (v6-v7)': /injected failure at v6-v7/,
  'VACUUM INTO fails (output exists)': /Making a clean copy failed/,
  'replica check fails (row removed from the replica)': /did not match the original \(row counts differ/,
  'a step loses a row (count check)': /rows would be lost in: memories 1→0/,
  'COMMIT fails (deferred foreign key)': /Migration failed \(rolled back in the copy\): .*FOREIGN KEY/i,
};
for (const [label, mk] of Object.entries(injections)) {
  for (const state of STATES) {
    const { dir, file } = make(state);
    const listBefore = filesOf(dir).join(','); const shaBefore = liveSha(dir);
    const lines = [];
    const r = migrateLegacy({ dbPath: file, now: STAMP, log: (l) => lines.push(l), onStep: mk(file) });
    check(`[${state}] ${label} → exit 1`, r.code === 1 && r.outcome === 'failed', JSON.stringify(r));
    check(`[${state}] ${label} → says why`, lines.some((l) => expectLine[label].test(l)), lines.join(' | '));
    check(`[${state}] ${label} → says the live files were not changed`, lines.some((l) => /This command did not write to .*memory\.db or its -wal \/ -shm \/ -journal \(the work happened on a copy/.test(l)), lines.join(' | '));
    untouched(`[${state}] ${label}`, dir, shaBefore, listBefore);
  }
}
{ // and a clean retry after a failure migrates
  const { file } = make('wal');
  migrateLegacy({ dbPath: file, now: STAMP, log: () => {}, onStep: injections['a migrate.ts step throws (v6-v7)']() });
  const r2 = migrateLegacy({ dbPath: file, now: new Date('2026-11-04T00:00:01Z'), log: () => {} });
  check('after a failure, a clean retry migrates', r2.code === 0 && versionOf(file) === TARGET, JSON.stringify(r2));
}

// 3. another process holds the write lock (BEGIN IMMEDIATE) → not swapped, nothing changed
{
  const { dir, file } = make('rollback');
  const holder = spawn(process.execPath, [join(HERE, 'fixtures', 'hold-lock.cjs'), file, 'immediate'], { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise((res) => holder.stdout.on('data', (d) => { if (String(d).includes('locked')) res(); }));
  const listBefore = filesOf(dir).join(','); const shaBefore = liveSha(dir);
  const r = cli(['migrate', '--db', file]);
  check('write lock held: exit 1, says another client holds it, no stack trace', r.status === 1 && /Another client holds memory\.db/.test(r.stdout) && !/\n\s+at /.test(r.stderr), `${r.status} ${r.stdout}${r.stderr}`);
  untouched('write lock held', dir, shaBefore, listBefore);
  holder.stdin.end();
  await new Promise((res) => holder.on('exit', res));
  check('write lock held: version still 5 after the holder let go', versionOf(file) === '5');
}

// 3b. a rename in the swap fails (explicit injection). The guidance is generated from where the
//     files really are; following it must restore the original set byte for byte.
{
  // 'wal' state: renames are memory.db, -wal, -shm, then the replica. #3 (-shm) fails, all put back.
  const { dir, file } = make('wal');
  const listBefore = filesOf(dir).join(','); const shaBefore = liveSha(dir);
  const r = cli(['migrate', '--db', file], { LINKSEE_TEST_FAIL_RENAME: '3' });
  check('swap rename fails → exit 1, every original moved back', r.status === 1 && /Every original file was moved back: memory\.db, memory\.db-wal, memory\.db-shm/.test(r.stdout), r.stdout + r.stderr);
  untouched('swap rename fails, all put back', dir, shaBefore, listBefore);
}
/** Run the "move A → B" lines the command printed, exactly, and nothing else. */
const followMoves = (stdout) => {
  const moves = [...stdout.matchAll(/^\s*move (.+) → (.+)$/gm)].map((m) => [m[1].trim(), m[2].trim()]);
  for (const [a, b] of moves) renameSync(a, b);
  return moves;
};
const SPLIT = {
  // [state, injected renames] — originals split between the live folder and pre-migrate/
  wal: '3,5',          // -shm fails; put-back: -wal ok (#4), memory.db fails (#5) → memory.db stuck
};
for (const state of STATES) {
  const { dir, file } = make(state);
  const n = filesOf(dir).filter((f) => LIVE.test(f)).length;
  // generic split: the replica rename (#n+1) fails and the first put-back (#n+2, the last file moved)
  // fails too; for 'wal' also the case above where memory.db itself stays behind
  const specs = state === 'wal' ? [SPLIT.wal, `${n + 1},${n + 2}`] : [`${n + 1},${n + 2}`];
  for (const spec of specs) {
    const { dir: d, file: f } = spec === specs[0] ? { dir, file } : make(state);
    const shaBefore = liveSha(d);
    const r = cli(['migrate', '--db', f], { LINKSEE_TEST_FAIL_RENAME: spec });
    const bk = filesOf(d).find((x) => /pre-migrate/.test(x));
    const readme = bk && existsSync(join(d, bk, 'README.txt')) ? readFileSync(join(d, bk, 'README.txt'), 'utf8') : '';
    check(`[${state} ${spec}] split → exit 1, says FAILED, lists where each original is`, r.status === 1 && /This migration FAILED during the swap/.test(r.stdout) && /in place/.test(r.stdout) && /move .+ → /.test(r.stdout), r.stdout + r.stderr);
    check(`[${state} ${spec}] split → no one-set "move the CURRENT set aside" advice`, !/Move the CURRENT/.test(r.stdout) && !/Move the CURRENT/.test(readme), r.stdout);
    check(`[${state} ${spec}] split → README.txt in the backup folder has the same moves`, /This migration FAILED/.test(readme) && /move .+ → /.test(readme), readme.slice(0, 300));
    const moves = followMoves(r.stdout);
    check(`[${state} ${spec}] following the printed moves (${moves.length}) restores memory.db + every sidecar byte for byte`, moves.length > 0 && liveSha(d) === shaBefore, `${filesOf(d).join(',')}`);
    check(`[${state} ${spec}] after that, migrate works on the restored set`, cli(['migrate', '--db', f]).status === 0 && versionOf(f) === TARGET);
  }
}

// 3c. same second, run twice (Date fixed): the second run is "not needed"; and a backup folder
//     name that already exists stops the swap without touching anything
{
  const { file } = make('rollback');
  const r1 = migrateLegacy({ dbPath: file, now: STAMP, log: () => {} });
  const r2 = migrateLegacy({ dbPath: file, now: STAMP, log: () => {} });
  check('same second twice: first migrates, second is "not needed"', r1.code === 0 && r2.code === 0 && r2.outcome === 'not-needed', JSON.stringify([r1.outcome, r2.outcome]));
  const { dir: d2, file: f2 } = make('rollback');
  mkdirSync(`${f2}.pre-migrate-20261104T000000Z`);
  const listBefore = filesOf(d2).join(','); const shaBefore = liveSha(d2);
  const lines = [];
  const r3 = migrateLegacy({ dbPath: f2, now: STAMP, log: (l) => lines.push(l) });
  check('backup folder name taken → refused, says so', r3.code === 1 && lines.some((l) => /Could not create .*pre-migrate/.test(l)), lines.join(' | '));
  untouched('backup folder name taken', d2, shaBefore, listBefore);
}

// 4. schema 4 with duplicate entities: migrated, duplicates kept (not merged), no rows lost
{
  const { dir, file } = make('rollback', 4);
  const db = new Database(file);
  db.prepare(`INSERT INTO entities (name, kind) VALUES ('Proj', 'project')`).run();
  db.close();
  const r = migrateLegacy({ dbPath: file, log: () => {} });
  const m = new Database(file, { readonly: true });
  const ents = m.prepare(`SELECT name, normalized_name FROM entities ORDER BY id`).all();
  const mem = m.prepare(`SELECT COUNT(*) c FROM memories`).get().c;
  m.close();
  check(`schema 4: migrated to ${TARGET}`, r.code === 0 && r.from === 4 && versionOf(file) === TARGET, JSON.stringify(r));
  check('schema 4: both duplicate entities kept, normalized_name filled', ents.length === 2 && ents.every((e) => e.normalized_name) && ents[0].normalized_name === ents[1].normalized_name, JSON.stringify(ents));
  check('schema 4: memory kept', mem === 1);
  check('schema 4: backup folder holds the original', filesOf(dir).some((f) => /pre-migrate/.test(f)));
}

// 5. schema ≥ 6 → not needed, nothing written; no file → nothing to do
{
  const dir = tmp('linksee-migrate-v7-');
  const file = join(dir, 'memory.db');
  const db = new Database(file);
  db.exec(readFileSync(join(HERE, 'fixtures', 'schema-v7.sql'), 'utf8'));
  db.close();
  const listBefore = filesOf(dir).join(','); const shaBefore = liveSha(dir);
  const r = cli(['migrate', '--db', file]);
  check('schema 7: "not needed", exit 0', r.status === 0 && /schema 7: migrate is not needed/.test(r.stdout), r.stdout + r.stderr);
  untouched('schema 7', dir, shaBefore, listBefore);
  const none = cli(['migrate', '--db', join(dir, 'nope.db')]);
  check('no file: exit 0, nothing created', none.status === 0 && !existsSync(join(dir, 'nope.db')), none.stdout);
  mkdirSync(join(dir, 'gone.db.pre-migrate-20261104T000000Z'));
  const half = cli(['migrate', '--db', join(dir, 'gone.db')]);
  check('no file but a backup folder (a run stopped half-way): exit 1, points at the folder', half.status === 1 && /stopped half-way/.test(half.stdout) && /gone\.db\.pre-migrate-/.test(half.stdout), half.stdout);
}

// 6. runtime prune
{
  const mem = tmp('linksee-prune-mem-');
  const home = tmp('linksee-prune-home-');
  const proj = tmp('linksee-prune-proj-');
  const other = tmp('linksee-prune-other-');
  const VERS = ['0.14.0', '0.15.0', '0.16.0', '0.17.0', '0.17.1', '0.17.2'];
  for (const v of VERS) {
    mkdirSync(join(mem, 'runtime', v, 'node_modules', 'linksee-memory'), { recursive: true });
    writeFileSync(join(mem, 'runtime', v, 'node_modules', 'linksee-memory', 'package.json'), JSON.stringify({ version: v }));
  }
  mkdirSync(join(mem, 'runtime', '.tmp-0.17.3-999'), { recursive: true });
  mkdirSync(join(mem, 'runtime', '0.17.1.old-123'), { recursive: true });
  const root = (v) => join(mem, 'runtime', v, 'node_modules', 'linksee-memory');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(proj, '.claude'), { recursive: true });
  mkdirSync(join(other, '.claude'), { recursive: true });
  // user settings, as setup writes it: forward slashes inside JSON → 0.17.2
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `"node" "${root('0.17.2').replace(/\\/g, '/')}/dist/bin/sync-session.js" --linksee-managed` }] }] } }, null, 2));
  // project settings with JSON-escaped backslashes → 0.17.1
  writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `"node" "${root('0.17.1')}\\dist\\bin\\guard-hook.js"` }] }] } }));
  // project settings.local.json written with `\/` escapes (valid JSON) → 0.15.0
  const esc = root('0.15.0').replace(/\\/g, '/').replace(/\//g, '\\/');
  writeFileSync(join(proj, '.claude', 'settings.local.json'), `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node ${esc}\\/dist\\/bin\\/sync-session.js"}]}]}}`);
  // Codex config: a valid one-line args array → 0.14.0
  const goodToml = `# codex\nmodel = "gpt-5"\n\n[mcp_servers.linksee]\ncommand = "node"\nargs = ["${root('0.14.0').replace(/\\/g, '\\\\')}\\\\dist\\\\mcp\\\\server.js"]\nstartup_timeout_ms = 20000\nenabled = true\n`;
  writeFileSync(join(home, '.codex', 'config.toml'), goodToml);
  // another repo only (setup --project there) → 0.16.0
  writeFileSync(join(other, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `"node" "${root('0.16.0').replace(/\\/g, '/')}/dist/bin/sync-session.js"` }] }] } }));
  const sources = defaultSources(home, proj);
  const otherSrc = { path: join(other, '.claude', 'settings.json'), explicit: true };
  const present = (...v) => v.map((x) => existsSync(join(mem, 'runtime', x)));
  const all = () => present(...VERS).every(Boolean);
  const run = (extra, yes, scopeConfirmed) => { const lines = []; const r = pruneRuntimes({ memoryDir: mem, sources: [...sources, ...extra], yes, scopeConfirmed, log: (l) => lines.push(l) }); return { r, lines, text: lines.join(' | ') }; };

  check('toml reader accepts the plain file and reads the args array (escaped backslashes)', tomlStrings(goodToml).strings.some((s) => s.replace(/\\/g, '/').includes('runtime/0.14.0/')) && !tomlStrings(goodToml).error, JSON.stringify(tomlStrings(goodToml)));

  const a = run([otherSrc], false, false);
  check('list: deletes nothing, shows each reference', all() && a.r.code === 0
    && /0\.17\.2 .*keep — referenced by .*settings\.json/.test(a.text) && /0\.17\.1 .*keep — referenced/.test(a.text)
    && /0\.15\.0 .*keep — referenced by .*settings\.local\.json/.test(a.text) && /0\.14\.0 .*keep — referenced by .*config\.toml/.test(a.text)
    && /0\.16\.0 .*keep — referenced by .*other/.test(a.text) && /0\.17\.0 .*no reference found/.test(a.text), a.text);

  const b = run([], true, false);
  check('--yes without --scope-confirmed: nothing deleted, exit 1, says why (other repo not passed)', all() && b.r.code === 1 && /add --scope-confirmed/.test(b.text), b.text);

  const c = run([otherSrc], true, false);
  check('--yes with the other repo passed but no --scope-confirmed: nothing deleted', all() && c.r.code === 1, c.text);

  // could not confirm → nothing deleted, even with --yes --scope-confirmed
  const broken = join(proj, 'broken.json');
  writeFileSync(broken, '{ "hooks": [');
  const d = run([otherSrc, { path: broken, explicit: true }], true, true);
  check('broken JSON: nothing deleted, exit 1, reason shown', all() && d.r.code === 1 && /not valid JSON/.test(d.text), d.text);
  const e = run([otherSrc, { path: join(proj, 'missing.json'), explicit: true }], true, true);
  check('--settings file missing: nothing deleted', all() && e.r.code === 1 && /not found/.test(e.text), e.text);
  writeFileSync(join(home, '.codex', 'config.toml'), `[mcp_servers.linksee]\ncommand = "node\n`);
  const f = run([otherSrc], true, true);
  check('broken TOML (unterminated string): nothing deleted', all() && f.r.code === 1 && /could not read as TOML/.test(f.text), f.text);
  writeFileSync(join(home, '.codex', 'config.toml'), `[mcp_servers.linksee]\ncommand = "node"\nargs = [\n  "x"\n]\n`);
  const g = run([otherSrc], true, true);
  check('TOML line it cannot read (multi-line array): nothing deleted', all() && g.r.code === 1 && /could not read as TOML \(line 3/.test(g.text), g.text);
  writeFileSync(join(home, '.codex', 'config.toml'), goodToml);

  // TOML the small reader does not accept → could not confirm → nothing deleted (Codex review 2)
  const tomlCases = {
    'quoted key with escapes (Codex example)': `[mcp_servers.linksee]\ncommand = "node"\n"ar\\u0067s" = ["${root('0.17.0').replace(/\\/g, '/').replace('runtime/', 'runtime\\u002f')}/dist/mcp/server.js"]\n`,
    'inline table': `[mcp_servers.linksee]\ncommand = "node"\nenv = { A = "b" }\n`,
    'bad value on another key': `model = "unterminated\n[mcp_servers.linksee]\ncommand = "node"\n`,
    'quoted table header': `[mcp_servers."linksee"]\ncommand = "node"\n`,
  };
  for (const [label, text] of Object.entries(tomlCases)) {
    writeFileSync(join(home, '.codex', 'config.toml'), text);
    const t = run([otherSrc], true, true);
    check(`TOML ${label}: could not confirm, nothing deleted, exit 1`, all() && t.r.code === 1 && /could not read as TOML/.test(t.text), t.text);
  }
  check('the Codex example really hides the path from a raw-text search', !tomlCases['quoted key with escapes (Codex example)'].replace(/\\+/g, '/').includes('runtime/0.17.0'));
  writeFileSync(join(home, '.codex', 'config.toml'), goodToml);

  // deletion that fails (explicit injection; Windows locking is not reliable for this) → exit 1,
  // not recorded as deleted
  const pruneCli = (env) => spawnSync(process.execPath, [SERVER, 'runtime', 'prune', '--yes', '--scope-confirmed', '--settings', otherSrc.path], { cwd: proj, encoding: 'utf8', input: '', env: { ...baseEnv, HOME: home, USERPROFILE: home, LINKSEE_MEMORY_DIR: mem, ...env } });
  const h1 = pruneCli({ LINKSEE_TEST_FAIL_RENAME: '1' });
  check('deletion fails at the rename → exit 1, "could not delete 0.17.0", folder still there', h1.status === 1 && /could not delete 0\.17\.0/.test(h1.stdout) && !/deleted 0\.17\.0/.test(h1.stdout) && present('0.17.0')[0], h1.stdout + h1.stderr);
  const h2 = pruneCli({ LINKSEE_TEST_FAIL_RM: '1' });
  const aside = filesOf(join(mem, 'runtime')).find((n) => n.startsWith('.pruning-0.17.0-'));
  check('deletion fails at the remove → exit 1, says where it is, not "deleted"', h2.status === 1 && /not fully removed/.test(h2.stdout) && !/deleted 0\.17\.0/.test(h2.stdout) && !!aside, h2.stdout + h2.stderr);
  if (aside) { rmSync(join(mem, 'runtime', aside), { recursive: true, force: true }); }
  for (const v of ['0.17.0']) { mkdirSync(join(root(v)), { recursive: true }); writeFileSync(join(root(v), 'package.json'), JSON.stringify({ version: v })); }

  // the real thing via the CLI: only the unreferenced version goes
  const r4 = spawnSync(process.execPath, [SERVER, 'runtime', 'prune', '--yes', '--scope-confirmed', '--settings', otherSrc.path], { cwd: proj, encoding: 'utf8', input: '', env: { ...baseEnv, HOME: home, USERPROFILE: home, LINKSEE_MEMORY_DIR: mem } });
  check('prune --yes --scope-confirmed exits 0', r4.status === 0, `${r4.status} ${r4.stdout}${r4.stderr}`);
  check('every referenced version kept (user JSON, project backslashes, \\/ escapes, TOML, other repo)', present('0.17.2', '0.17.1', '0.15.0', '0.14.0', '0.16.0').every(Boolean), r4.stdout);
  check('unreferenced 0.17.0 deleted', !present('0.17.0')[0], r4.stdout);
  check('.tmp-* and *.old-* left alone, no .pruning- leftovers', present('.tmp-0.17.3-999', '0.17.1.old-123').every(Boolean) && !filesOf(join(mem, 'runtime')).some((n) => n.startsWith('.pruning-')), filesOf(join(mem, 'runtime')).join(','));
}

for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
