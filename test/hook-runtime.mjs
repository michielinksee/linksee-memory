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

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { resolveHookRuntime, isEphemeralRoot, findNpmCli } = await import('../dist/lib/hook-runtime.js');
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

// 4. upgrade: the old runtime goes only after the new one loads
{
  const rt = resolveHookRuntime({ packageRoot: npxRoot, nodePath: process.execPath, memoryDir, version: '0.17.2', verify: loads, install: fakeInstall('0.17.2') });
  check('upgrade: pinned to 0.17.2', rt.mode === 'pinned' && rt.root.includes('0.17.2'));
  check('upgrade: only the newest runtime kept', readdirSync(join(memoryDir, 'runtime')).join(',') === '0.17.2', readdirSync(join(memoryDir, 'runtime')).join(','));
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

// 7. guard hook without a loadable driver: one line on stderr, exit 0 (fail-open, not silent)
{
  const lone = join(base, 'no-deps', 'linksee-memory');
  cpSync(DIST, join(lone, 'dist'), { recursive: true });
  writeFileSync(join(lone, 'package.json'), JSON.stringify({ name: 'linksee-memory', type: 'module' }));
  const r = spawnSync(process.execPath, [join(lone, 'dist', 'bin', 'guard-hook.js'), '--linksee-managed'], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'x' } }),
    encoding: 'utf8',
    env: { ...process.env, LINKSEE_MEMORY_DIR: join(base, 'mem-nodeps'), NODE_PATH: '' },
    cwd: base,
  });
  check('driver missing: exit 0', r.status === 0, `exit ${r.status} ${r.stderr}`);
  check('driver missing: stderr says re-run setup', /Re-run: npx -y linksee-memory setup/.test(r.stderr), r.stderr.slice(0, 300));
  check('driver missing: nothing on stdout (no block, no injection)', r.stdout === '');
}

// 8. node form built for this machine's real node path
{
  const c = nodeHookCommands(process.execPath, '/x/linksee-memory');
  check('real execPath is quoted', c.guard.startsWith('"') && c.guard.includes('" "'));
}

try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
