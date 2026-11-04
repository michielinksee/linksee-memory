#!/usr/bin/env node
// Regression: where the direct-node hooks point (L-1-106 / audit F11).
//
// `npx -y linksee-memory setup` runs out of npm's temporary npx cache. Hooks must not point
// there; setup copies the installed tree to <memory dir>/runtime/<version>/ and points at the
// copy, or falls back to the npx form if the copy does not load. A stable install (global,
// git clone) is used where it is. Also checks that the written command really runs when both
// the node path and the package path contain spaces.
//
// Run: node test/hook-runtime.mjs   (needs `pnpm build`; no DB, temp folders only)

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const { resolveHookRuntime, isEphemeralRoot } = await import('../dist/lib/hook-runtime.js');
const { nodeHookCommands } = await import('../dist/lib/guard-wiring.js');

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); failures++; }
};
console.log('hook-runtime regression');

const base = mkdtempSync(join(tmpdir(), 'linksee-hookrt-'));

// fake npx layout: <base>/_npx/abc/node_modules/{linksee-memory, some-dep, .bin}
function fakeNpx(version) {
  const nm = join(base, '_npx', 'abc', 'node_modules');
  const root = join(nm, 'linksee-memory');
  mkdirSync(join(root, 'dist', 'bin'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'linksee-memory', version }));
  writeFileSync(join(root, 'dist', 'bin', 'guard-hook.js'), 'process.stdout.write("guard ran")');
  writeFileSync(join(root, 'dist', 'bin', 'sync-session.js'), 'process.stdout.write("sync ran")');
  mkdirSync(join(nm, 'some-dep'), { recursive: true });
  writeFileSync(join(nm, 'some-dep', 'index.js'), 'module.exports = 1');
  mkdirSync(join(nm, '.bin'), { recursive: true });
  writeFileSync(join(nm, '.bin', 'linksee-memory'), 'shim');
  return root;
}
const exists = (root) => existsSync(join(root, 'dist', 'bin', 'guard-hook.js'));

// 1. classification
check('npx cache is ephemeral', isEphemeralRoot('C:/Users/x/AppData/Local/npm-cache/_npx/1a2b/node_modules/linksee-memory'));
check('pnpm dlx cache is ephemeral', isEphemeralRoot('/home/x/.cache/pnpm/dlx/abc/node_modules/linksee-memory'));
check('os temp dir is ephemeral', isEphemeralRoot(join(tmpdir(), 'whatever', 'linksee-memory')));
check('global install is stable', !isEphemeralRoot('C:/Users/x/AppData/Roaming/npm/node_modules/linksee-memory'));
check('git clone is stable', !isEphemeralRoot('/home/x/src/linksee-memory'));

// 2. stable root → used directly, nothing copied
{
  const memoryDir = join(base, 'mem-stable');
  const rt = resolveHookRuntime({ packageRoot: '/home/x/src/linksee-memory', nodePath: '/usr/bin/node', memoryDir, version: '0.17.1', verify: () => true });
  check('stable root: mode direct', rt.mode === 'direct', rt.mode);
  check('stable root: command points at the clone', rt.commands.guard === '"/usr/bin/node" "/home/x/src/linksee-memory/dist/bin/guard-hook.js"', rt.commands.guard);
  check('stable root: nothing copied', !existsSync(join(memoryDir, 'runtime')));
}

// 3. npx root → pinned copy under <memory dir>/runtime/<version>
{
  const root = fakeNpx('0.17.1');
  const memoryDir = join(base, 'mem with space');
  const rt = resolveHookRuntime({ packageRoot: root, nodePath: process.execPath, memoryDir, version: '0.17.1', verify: (r) => exists(r) });
  const dest = join(memoryDir, 'runtime', '0.17.1', 'node_modules');
  check('npx root: mode copied', rt.mode === 'copied', `${rt.mode} ${rt.note}`);
  check('npx root: hooks do not point into _npx', !rt.commands.guard.includes('_npx') && !rt.commands.sync.includes('_npx'), rt.commands.guard);
  check('npx root: package copied', exists(join(dest, 'linksee-memory')));
  check('npx root: sibling dependency copied', existsSync(join(dest, 'some-dep', 'index.js')));
  check('npx root: .bin shims not copied', !existsSync(join(dest, '.bin')));
  check('npx root: no staging folder left', readdirSync(join(memoryDir, 'runtime')).length === 1, readdirSync(join(memoryDir, 'runtime')).join(','));

  // the written command actually runs through a shell — node path ("Program Files") and memory
  // dir ("mem with space") both contain spaces
  const r = spawnSync(rt.commands.guard, { shell: true, encoding: 'utf8' });
  check('quoted command with spaces runs through the shell', r.status === 0 && r.stdout === 'guard ran', `${r.status} ${r.stdout} ${r.stderr}`);

  // second run reuses the copy
  const rt2 = resolveHookRuntime({ packageRoot: root, nodePath: process.execPath, memoryDir, version: '0.17.1', verify: (r) => exists(r) });
  check('second run: same commands', rt2.commands.guard === rt.commands.guard);
  check('second run: reuses the pinned copy', /pinned copy/.test(rt2.note ?? ''), rt2.note);

  // dry-run never copies
  const dryDir = join(base, 'mem-dry');
  const rt3 = resolveHookRuntime({ packageRoot: root, nodePath: process.execPath, memoryDir: dryDir, version: '0.17.1', dryRun: true, verify: (r) => exists(r) });
  check('dry-run: nothing copied', !existsSync(join(dryDir, 'runtime')) && /dry-run/.test(rt3.note ?? ''));
}

// 4. copy that does not load → npx fallback, nothing left behind
{
  const root = fakeNpx('0.17.1');
  const memoryDir = join(base, 'mem-bad');
  const rt = resolveHookRuntime({ packageRoot: root, nodePath: process.execPath, memoryDir, version: '0.17.1', verify: () => false });
  check('unloadable copy: falls back to npx form', rt.mode === 'npx' && rt.commands.guard === 'npx -y linksee-memory guard', rt.mode);
  check('unloadable copy: no runtime folder left', !existsSync(join(memoryDir, 'runtime', '0.17.1')) && (readdirSync(join(memoryDir, 'runtime')).length === 0));
}

// 5. node form built for this machine's real node path
{
  const c = nodeHookCommands(process.execPath, '/x/linksee-memory');
  check('real execPath is quoted', c.guard.startsWith('"') && c.guard.includes('" "'));
}

try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
