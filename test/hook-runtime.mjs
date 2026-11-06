#!/usr/bin/env node
// Regression: where the direct-node hooks point (L-1-106 / audit F11, Codex review of #15).
//
// `npx -y linksee-memory setup` runs out of npm's temporary npx cache. Hooks must not point there.
// setup installs this exact version with `npm install --prefix <memory dir>/runtime/<version>`
// and points the hooks at it. Rules checked here:
//   • a stable install (global, git clone) is used where it is — nothing installed
//   • the new runtime must load before old runtime folders are removed (one is kept)
//   • any failure leaves the existing runtime alone and keeps the npx form
//   • paths with $ ` % " are not written into a hook command
//   • the written command really runs through the shell with spaces in both paths
//   • the guard hook, when its SQLite driver cannot load, says "re-run setup" and exits 0
// npm itself is stubbed here (no network); the real install is exercised by the manual e2e.
//
// Run: node test/hook-runtime.mjs   (needs `pnpm build`; temp folders only)

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, cpSync, readFileSync, symlinkSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { resolveHookRuntime, isEphemeralRoot, findNpmCli } = await import('../dist/lib/hook-runtime.js');
const { NATIVE_HINT } = await import('../dist/lib/native-hint.js');
const { nodeHookCommands } = await import('../dist/lib/guard-wiring.js');
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); failures++; }
};
console.log('hook-runtime regression');

const base = mkdtempSync(join(tmpdir(), 'linksee-hookrt-'));
const npxRoot = join(base, '_npx', 'abc', 'node_modules', 'linksee-memory');

// stub installer: lays out <prefix>/node_modules/linksee-memory like npm would
const calls = [];
const fakeInstall = (version, { ok = true } = {}) => (spec, prefix) => {
  calls.push({ spec, prefix });
  if (!ok) return { ok: false, detail: 'E404 simulated' };
  const root = join(prefix, 'node_modules', 'linksee-memory');
  mkdirSync(join(root, 'dist', 'bin'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'linksee-memory', version }));
  writeFileSync(join(root, 'dist', 'bin', 'guard-hook.js'), 'process.stdout.write("guard ran " + process.argv.slice(2).join(" "))');
  writeFileSync(join(root, 'dist', 'bin', 'sync-session.js'), 'process.stdout.write("sync ran")');
  mkdirSync(join(prefix, 'node_modules', 'better-sqlite3'), { recursive: true });
  return { ok: true };
};
const loads = (root) => existsSync(join(root, 'dist', 'bin', 'guard-hook.js'));

// 1. classification + npm lookup
check('npx cache is ephemeral', isEphemeralRoot('C:/Users/x/AppData/Local/npm-cache/_npx/1a2b/node_modules/linksee-memory'));
check('pnpm dlx cache is ephemeral', isEphemeralRoot('/home/x/.cache/pnpm/dlx/abc/node_modules/linksee-memory'));
check('os temp dir is ephemeral', isEphemeralRoot(join(tmpdir(), 'whatever', 'linksee-memory')));
check('global install is stable', !isEphemeralRoot('C:/Users/x/AppData/Roaming/npm/node_modules/linksee-memory'));
check('git clone is stable', !isEphemeralRoot('/home/x/src/linksee-memory'));
check('npm CLI found next to this node', !!findNpmCli(process.execPath, {}), String(findNpmCli(process.execPath, {})));

// 2. stable root → used directly, nothing installed
{
  calls.length = 0;
  const memoryDir = join(base, 'mem-stable');
  const rt = resolveHookRuntime({ packageRoot: '/home/x/src/linksee-memory', nodePath: '/usr/bin/node', memoryDir, version: '0.17.1', verify: () => true, install: fakeInstall('0.17.1') });
  check('stable root: mode direct', rt.mode === 'direct', rt.mode);
  check('stable root: command points at the clone', rt.commands.guard === '"/usr/bin/node" "/home/x/src/linksee-memory/dist/bin/guard-hook.js" --linksee-managed', rt.commands.guard);
  check('stable root: no install, no runtime folder', calls.length === 0 && !existsSync(join(memoryDir, 'runtime')));
}

// 3. npx root → npm install of this exact version into runtime/<version>
const memoryDir = join(base, 'mem with space');
{
  calls.length = 0;
  const rt = resolveHookRuntime({ packageRoot: npxRoot, nodePath: process.execPath, memoryDir, version: '0.17.1', verify: loads, install: fakeInstall('0.17.1') });
  check('npx root: mode pinned', rt.mode === 'pinned', `${rt.mode} ${rt.note}`);
  check('npx root: installs linksee-memory@<this version>', calls.length === 1 && calls[0].spec === 'linksee-memory@0.17.1', JSON.stringify(calls));
  check('npx root: hooks do not point into _npx', !rt.commands.guard.includes('_npx'), rt.commands.guard);
  check('npx root: runtime/0.17.1 in place, no staging left', readdirSync(join(memoryDir, 'runtime')).join(',') === '0.17.1', readdirSync(join(memoryDir, 'runtime')).join(','));
  check('npx root: size reported', typeof rt.bytes === 'number' && /(KB|MB)$/.test(rt.note ?? ''), rt.note);

  const r = spawnSync(rt.commands.guard, { shell: true, encoding: 'utf8' });
  check('quoted command with spaces runs through the shell (marker arrives as an ignored arg)', r.status === 0 && r.stdout === 'guard ran --linksee-managed', `${r.status} ${r.stdout} ${r.stderr}`);

  calls.length = 0;
  const rt2 = resolveHookRuntime({ packageRoot: npxRoot, nodePath: process.execPath, memoryDir, version: '0.17.1', verify: loads, install: fakeInstall('0.17.1') });
  check('second run: reuses the runtime without installing', calls.length === 0 && rt2.commands.guard === rt.commands.guard && /pinned runtime/.test(rt2.note ?? ''), rt2.note);

  const dry = resolveHookRuntime({ packageRoot: npxRoot, nodePath: process.execPath, memoryDir: join(base, 'mem-dry'), version: '0.17.1', dryRun: true, verify: loads, install: fakeInstall('0.17.1') });
  check('dry-run: nothing installed', !existsSync(join(base, 'mem-dry', 'runtime')) && /dry-run/.test(dry.note ?? ''));
}

// 4. upgrade: the new runtime is installed and NOTHING is deleted — 0.17.1 never removes old
//    runtimes automatically (Codex fourth review of #15)
{
  const rt = resolveHookRuntime({ packageRoot: npxRoot, nodePath: process.execPath, memoryDir, version: '0.17.2', verify: loads, install: fakeInstall('0.17.2') });
  check('upgrade: pinned to 0.17.2', rt.mode === 'pinned' && rt.root.includes('0.17.2') && rt.version === '0.17.2' && !!rt.runtimeBase);
  check('upgrade: old runtime NOT removed by resolveHookRuntime', readdirSync(join(memoryDir, 'runtime')).sort().join(',') === '0.17.1,0.17.2', readdirSync(join(memoryDir, 'runtime')).join(','));

  // same-version reinstall swaps through dest.old-<pid> and leaves no leftovers
  const again = resolveHookRuntime({ packageRoot: npxRoot, nodePath: process.execPath, memoryDir, version: '0.17.2', verify: (r) => loads(r) && !r.includes(join('runtime', '0.17.2')), install: fakeInstall('0.17.2') });
  check('same-version reinstall: pinned, no .old-/.tmp- leftovers', again.mode === 'pinned' && readdirSync(join(memoryDir, 'runtime')).every((n) => !/\.old-|\.tmp-/.test(n)), readdirSync(join(memoryDir, 'runtime')).join(','));
}

// 5. failures keep what was there and the npx form
{
  const before = readdirSync(join(memoryDir, 'runtime')).join(',');
  const a = resolveHookRuntime({ packageRoot: npxRoot, nodePath: process.execPath, memoryDir, version: '0.17.3', verify: loads, install: fakeInstall('0.17.3', { ok: false }) });
  check('install fails: npx form', a.mode === 'npx' && a.commands.guard === 'npx -y linksee-memory guard', a.note);
  check('install fails: existing runtime untouched, no staging left', readdirSync(join(memoryDir, 'runtime')).join(',') === before, readdirSync(join(memoryDir, 'runtime')).join(','));

  const b = resolveHookRuntime({ packageRoot: npxRoot, nodePath: process.execPath, memoryDir, version: '0.17.3', verify: () => false, install: fakeInstall('0.17.3') });
  check('runtime does not load: npx form', b.mode === 'npx' && /better-sqlite3/.test(b.note ?? ''), b.note);
  check('runtime does not load: existing runtime untouched', readdirSync(join(memoryDir, 'runtime')).join(',') === before, readdirSync(join(memoryDir, 'runtime')).join(','));

  const c = resolveHookRuntime({ packageRoot: npxRoot, nodePath: process.execPath, memoryDir, version: '0.17.3', verify: loads, install: fakeInstall('0.17.0') });
  check('wrong version installed: npx form', c.mode === 'npx', c.note);
}

// 6. paths a hook command cannot quote safely → npx form
{
  const a = resolveHookRuntime({ packageRoot: '/home/a$b/linksee-memory', nodePath: '/usr/bin/node', memoryDir: base, version: '0.17.1', verify: () => true });
  check('$ in package path: npx form', a.mode === 'npx');
  const b = resolveHookRuntime({ packageRoot: npxRoot, nodePath: process.execPath, memoryDir: join(base, '%USERNAME%'), version: '0.17.1', verify: loads, install: fakeInstall('0.17.1') });
  check('% in memory dir: npx form, nothing installed', b.mode === 'npx' && !existsSync(join(base, '%USERNAME%')));
}

// 7. the native addon itself is broken (what a Node major upgrade does to a pinned runtime):
//    better-sqlite3's JS loads fine, the .node fails at `new Database()`. Guard and Stop hooks must
//    print exactly one line (the hint) and exit 0 (Codex re-review of #15).
{
  const req = createRequire(import.meta.url);
  const realBs = dirname(req.resolve('better-sqlite3/package.json'));      // .pnpm/better-sqlite3@x/node_modules/better-sqlite3
  const rtNm = join(base, 'broken-rt', 'node_modules');
  mkdirSync(rtNm, { recursive: true });
  // a real copy of better-sqlite3 and its own deps (bindings, file-uri-to-path), links resolved
  cpSync(dirname(realBs), rtNm, { recursive: true, dereference: true });
  const realBindings = realpathSync(join(dirname(realBs), 'bindings'));
  if (!existsSync(join(rtNm, 'file-uri-to-path'))) cpSync(join(dirname(realBindings), 'file-uri-to-path'), join(rtNm, 'file-uri-to-path'), { recursive: true, dereference: true });
  const addon = join(rtNm, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  check('broken addon: fixture has the real .node to break', existsSync(addon));
  writeFileSync(addon, 'this is not a native module');
  // our package: dist copied, every other dependency linked to the repo's install
  const pkgRoot = join(rtNm, 'linksee-memory');
  cpSync(DIST, join(pkgRoot, 'dist'), { recursive: true });
  const pj = JSON.parse(readFileSync(join(DIST, '..', 'package.json'), 'utf8'));
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'linksee-memory', version: pj.version, type: 'module' }));
  for (const dep of Object.keys(pj.dependencies)) {
    if (dep === 'better-sqlite3') continue;
    const target = realpathSync(join(DIST, '..', 'node_modules', dep));
    const link = join(rtNm, dep);
    mkdirSync(dirname(link), { recursive: true });
    if (!existsSync(link)) symlinkSync(target, link, 'junction');
  }
  // 0.19.0: this case is about the better-sqlite3 driver (Node < 22.16, or forced). With node:sqlite
  // available a broken better-sqlite3 is never touched — that path is checked in test/sqlite-driver.mjs.
  const env = { ...process.env, LINKSEE_MEMORY_DIR: join(base, 'mem-broken'), HOME: base, USERPROFILE: base, LINKSEE_TELEMETRY: 'off', LINKSEE_SQLITE_DRIVER: 'better' };
  const lines = (t) => t.split(/\r?\n/).filter((l) => l.length > 0);

  const g = spawnSync(process.execPath, [join(pkgRoot, 'dist', 'bin', 'guard-hook.js'), '--linksee-managed'], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'x' } }),
    encoding: 'utf8', env, cwd: base,
  });
  check('broken addon, guard: exit 0', g.status === 0, `exit ${g.status}`);
  check('broken addon, guard: exactly one stderr line, the hint', lines(g.stderr).length === 1 && lines(g.stderr)[0] === NATIVE_HINT, JSON.stringify(g.stderr.slice(0, 300)));
  check('broken addon, guard: nothing on stdout (no block, no injection)', g.stdout === '');
  check('broken addon, guard: detail written to hook.log', /guard: open:/.test(readFileSync(join(base, 'mem-broken', 'hook.log'), 'utf8')));

  const transcript = join(base, 'transcript.jsonl');
  writeFileSync(transcript, '');
  const s = spawnSync(process.execPath, [join(pkgRoot, 'dist', 'bin', 'sync-session.js'), '--linksee-managed'], {
    input: JSON.stringify({ session_id: 's', transcript_path: transcript, cwd: base }),
    encoding: 'utf8', env, cwd: base,
  });
  check('broken addon, Stop hook: exit 0', s.status === 0, `exit ${s.status}`);
  check('broken addon, Stop hook: exactly one stderr line, the hint', lines(s.stderr).length === 1 && lines(s.stderr)[0] === NATIVE_HINT, JSON.stringify(s.stderr.slice(0, 300)));

  // a failure that is NOT the addon stays silent on stderr (hook.log only)
  writeFileSync(join(base, 'not-a-dir.txt'), 'x');
  const q = spawnSync(process.execPath, [join(DIST, 'bin', 'guard-hook.js')], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'x' } }),
    encoding: 'utf8', env: { ...env, LINKSEE_MEMORY_DIR: join(base, 'not-a-dir.txt') }, cwd: base,
  });
  check('other open failure: exit 0 and silent on stderr', q.status === 0 && q.stderr === '', `${q.status} ${q.stderr.slice(0, 200)}`);
}

// 8. node form built for this machine's real node path
{
  const c = nodeHookCommands(process.execPath, '/x/linksee-memory');
  check('real execPath is quoted', c.guard.startsWith('"') && c.guard.includes('" "'));
}

if (!process.env.KEEP) { try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ } } else console.log("kept", base);
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
