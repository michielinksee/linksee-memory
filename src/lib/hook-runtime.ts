// hook-runtime — decide what command setup writes into the Claude Code hooks.
//
// 0.17.1 (L-1-106 / audit F11): hooks call `node <abs>/dist/bin/<bin>.js` directly instead of
// `npx -y linksee-memory <sub>` (6–9 s per call, against an 8 s PreToolUse timeout).
//
// The catch is WHERE that dist lives. `npx -y linksee-memory setup` runs out of npm's npx cache
// (…/_npx/<hash>/node_modules/linksee-memory), which npm may rebuild or wipe at any time — a hook
// pointing there would break silently some day. So when setup runs from such a temporary place,
// the installed tree is copied once to <memory dir>/runtime/<version>/ and the hooks point at the
// copy. A global install or a git clone is already stable and is used where it is.
//
// If the copy cannot be made or does not load, setup falls back to the npx form (slow but
// correct) and says so — it never writes a hook that points at nothing.

import { cpSync, existsSync, readFileSync, renameSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { NPX_HOOK_COMMANDS, nodeHookCommands, type HookCommands } from './guard-wiring.js';

export type HookRuntime = {
  commands: HookCommands;
  /** 'direct' = this install is stable; 'copied' = pinned copy under runtime/; 'npx' = fallback. */
  mode: 'direct' | 'copied' | 'npx';
  root?: string;
  note?: string;
};

function norm(p: string): string {
  let r = resolve(p);
  try { r = realpathSync(r); } catch { /* keep resolved */ }
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** Is this package root inside a cache that npm / pnpm / bun may rebuild or delete? */
export function isEphemeralRoot(packageRoot: string): boolean {
  const p = norm(packageRoot);
  const parts = p.split(/[\\/]+/);
  if (parts.includes('_npx') || parts.includes('dlx') || parts.some((s) => s.startsWith('bunx-'))) return true;
  const t = norm(tmpdir());
  return p === t || p.startsWith(t + sep) || p.startsWith(t + '/');
}

/** Can a node process load the native dependency from this root? (the part most likely to break) */
export function verifyRoot(root: string, nodePath: string): boolean {
  const pkg = join(root, 'package.json');
  if (!existsSync(join(root, 'dist', 'bin', 'guard-hook.js')) || !existsSync(pkg)) return false;
  const r = spawnSync(
    nodePath,
    ['-e', `const r=require('node:module').createRequire(${JSON.stringify(pkg)});const D=r('better-sqlite3');new D(':memory:').close();r.resolve('@modelcontextprotocol/sdk/package.json')`],
    { encoding: 'utf8', timeout: 20000 },
  );
  return r.status === 0;
}

export type ResolveOpts = {
  packageRoot: string;
  nodePath: string;
  memoryDir: string;
  version: string;
  dryRun?: boolean;
  /** Injected in tests; defaults to a real child-process load check. */
  verify?: (root: string, nodePath: string) => boolean;
};

export function resolveHookRuntime(o: ResolveOpts): HookRuntime {
  const verify = o.verify ?? verifyRoot;
  const npx: HookRuntime = { commands: NPX_HOOK_COMMANDS, mode: 'npx' };

  if (!isEphemeralRoot(o.packageRoot)) {
    return { commands: nodeHookCommands(o.nodePath, o.packageRoot), mode: 'direct', root: o.packageRoot };
  }

  // npx installs flat: <cache>/_npx/<hash>/node_modules/{linksee-memory, better-sqlite3, …}.
  // Copy that node_modules folder whole, so every dependency resolves from the copy.
  const nm = dirname(o.packageRoot);
  if (basename(nm) !== 'node_modules') {
    return { ...npx, note: `running from a temporary folder with an unexpected layout (${o.packageRoot}); kept the npx form` };
  }
  const dest = join(o.memoryDir, 'runtime', o.version);
  const destRoot = join(dest, 'node_modules', basename(o.packageRoot));

  const sameVersion = () => {
    try { return JSON.parse(readFileSync(join(destRoot, 'package.json'), 'utf8')).version === o.version; } catch { return false; }
  };
  if (sameVersion() && verify(destRoot, o.nodePath)) {
    return { commands: nodeHookCommands(o.nodePath, destRoot), mode: 'copied', root: destRoot, note: `using the pinned copy at ${dest}` };
  }
  if (o.dryRun) {
    return { commands: nodeHookCommands(o.nodePath, destRoot), mode: 'copied', root: destRoot, note: `[dry-run] would copy ${nm} → ${dest}` };
  }

  const staging = `${dest}.tmp-${process.pid}`;
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    // .bin holds shims/symlinks for the npx cache's own layout; the hooks never use them.
    cpSync(nm, join(staging, 'node_modules'), {
      recursive: true,
      filter: (src) => basename(src) !== '.bin',
    });
    if (!verify(join(staging, 'node_modules', basename(o.packageRoot)), o.nodePath)) {
      rmSync(staging, { recursive: true, force: true });
      return { ...npx, note: `the copy at ${staging} did not load; kept the npx form` };
    }
    rmSync(dest, { recursive: true, force: true });
    renameSync(staging, dest);
  } catch (e) {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ...npx, note: `could not copy to ${dest} (${(e as Error)?.message ?? e}); kept the npx form` };
  }
  return { commands: nodeHookCommands(o.nodePath, destRoot), mode: 'copied', root: destRoot, note: `copied this version to ${dest} (npx's cache is temporary)` };
}
