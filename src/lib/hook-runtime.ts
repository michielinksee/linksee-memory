// hook-runtime — decide what command setup writes into the Claude Code hooks.
//
// 0.17.1 (L-1-106 / audit F11): hooks call `node <abs>/dist/bin/<bin>.js` directly instead of
// `npx -y linksee-memory <sub>` (6–9 s per call, against an 8 s PreToolUse timeout).
//
// The catch is WHERE that dist lives. `npx -y linksee-memory setup` runs out of npm's npx cache,
// which npm may rebuild or wipe at any time. So when setup runs from such a temporary place, it
// installs this exact version once into <memory dir>/runtime/<version>/ with
//   npm install --prefix <memory dir>/runtime/<version> --no-save --omit=dev linksee-memory@<version>
// (the only network call, and only during setup) and points the hooks there. A global install or
// a git clone is already stable and is used where it is.
//
// Codex review of #15: copying npx's node_modules tree was replaced by this install — a real
// install has no links back into the cache, its size is known, and old versions are removed.
//   • the new runtime must load better-sqlite3 before anything else happens;
//   • older runtime/<version> folders are deleted by setup's last step, only after every settings
//     write succeeded and no settings file still points at them (pruneOldRuntimes);
//   • on any failure the existing runtime is left as it was and the hooks keep the npx form.
// The node path written is process.execPath at setup time. If Node is later upgraded to another
// major, the guard hook catches the driver load failure, says "re-run setup" on stderr and exits 0.

import { existsSync, readFileSync, readdirSync, renameSync, rmSync, mkdirSync, realpathSync, statSync, lstatSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { NPX_HOOK_COMMANDS, nodeHookCommands, shellSafePath, type HookCommands } from './guard-wiring.js';

export type HookRuntime = {
  commands: HookCommands;
  /** 'direct' = this install is stable; 'pinned' = installed under runtime/; 'npx' = fallback. */
  mode: 'direct' | 'pinned' | 'npx';
  root?: string;
  note?: string;
  /** runtime/ folder and the version kept there, when pinned (for setup's final prune). */
  runtimeBase?: string;
  version?: string;
  /** Size of the pinned runtime in bytes, when one is in use. */
  bytes?: number;
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
    ['-e', `const r=require('node:module').createRequire(${JSON.stringify(pkg)});const D=r('better-sqlite3');new D(':memory:').close()`],
    { encoding: 'utf8', timeout: 30000 },
  );
  return r.status === 0;
}

/** Locate npm's CLI script so it can be run with this node, without a shell. */
export function findNpmCli(nodePath: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const cands: string[] = [];
  const ep = env.npm_execpath;
  if (ep) {
    if (/npm-cli\.js$/.test(ep)) cands.push(ep);
    if (/npx-cli\.js$/.test(ep)) cands.push(join(dirname(ep), 'npm-cli.js'));
  }
  const nodeDir = dirname(nodePath);
  cands.push(join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));          // Windows installer
  cands.push(join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')); // POSIX layout
  return cands.find((c) => existsSync(c)) ?? null;
}

export type Installer = (spec: string, prefix: string, nodePath: string) => { ok: boolean; detail?: string };

/** `npm install --prefix <prefix> --no-save --omit=dev <spec>` with this node, no shell. */
export const npmInstall: Installer = (spec, prefix, nodePath) => {
  const cli = findNpmCli(nodePath);
  if (!cli) return { ok: false, detail: 'npm not found next to this node' };
  const r = spawnSync(
    nodePath,
    [cli, 'install', '--prefix', prefix, '--no-save', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error', spec],
    { encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (r.status === 0) return { ok: true };
  return { ok: false, detail: (r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n').slice(-2).join(' ') };
};

export function dirBytes(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else total += st.size;
    }
  };
  walk(dir);
  return total;
}

export function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(0)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** File under runtime/ listing every settings file setup pointed at a pinned runtime. */
export const REFS_FILE = '.settings-refs.json';

/** Remember that `settingsPath` now has hooks pointing into `base` (so pruning checks it later). */
export function recordSettingsRef(base: string, settingsPath: string): void {
  try {
    const f = join(base, REFS_FILE);
    let list: string[] = [];
    try { list = JSON.parse(readFileSync(f, 'utf8')); } catch { /* first one */ }
    if (!Array.isArray(list)) list = [];
    if (!list.includes(settingsPath)) {
      list.push(settingsPath);
      mkdirSync(base, { recursive: true });
      writeFileSync(f, JSON.stringify(list, null, 2));
    }
  } catch { /* best effort: pruning then only checks the paths it is given */ }
}

function readRefs(base: string): string[] {
  try {
    const list = JSON.parse(readFileSync(join(base, REFS_FILE), 'utf8'));
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

const normRef = (t: string) => {
  const fwd = t.replace(/\\\\/g, '/').replace(/\\/g, '/');
  return process.platform === 'win32' ? fwd.toLowerCase() : fwd;
};

export type PruneResult = { removed: string[]; kept: Array<{ dir: string; referencedBy: string }> };

/**
 * Remove runtime/<x> folders other than `keep` — called by setup only as its LAST step, after
 * every settings write succeeded (Codex re-review of #15). A folder is kept, and reported, if any
 * settings file still mentions its path: the given ones (user + project), plus every settings file
 * setup has ever pointed at a runtime (REFS_FILE) — e.g. another repo set up with --project-guard,
 * a hook left on the old runtime by --no-guard, or a hand-made wrapper.
 */
export function pruneOldRuntimes(base: string, keep: string, settingsPaths: string[]): PruneResult {
  const out: PruneResult = { removed: [], kept: [] };
  let names: string[] = [];
  try { names = readdirSync(base); } catch { return out; }
  const files = [...new Set([...settingsPaths, ...readRefs(base)])];
  const texts = files.map((f) => {
    try { return { f, t: normRef(readFileSync(f, 'utf8')) }; } catch { return { f, t: '' }; }
  });
  const nbase = normRef(base).replace(/\/$/, '');
  for (const n of names) {
    if (n === keep || n === REFS_FILE) continue;
    const dir = join(base, n);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    const needle = `${nbase}/${normRef(n)}`;
    const hit = texts.find(({ t }) => t.includes(needle + '/') || t.includes(needle + '"'));
    if (hit) { out.kept.push({ dir, referencedBy: hit.f }); continue; }
    try { rmSync(dir, { recursive: true, force: true }); out.removed.push(n); } catch { /* leave it */ }
  }
  return out;
}

export type ResolveOpts = {
  packageRoot: string;
  nodePath: string;
  memoryDir: string;
  version: string;
  /** What to install; defaults to linksee-memory@<version>. */
  spec?: string;
  dryRun?: boolean;
  /** Injected in tests; default = real child-process load check. */
  verify?: (root: string, nodePath: string) => boolean;
  /** Injected in tests; default = npm install with this node. */
  install?: Installer;
};

export function resolveHookRuntime(o: ResolveOpts): HookRuntime {
  const verify = o.verify ?? verifyRoot;
  const install = o.install ?? npmInstall;
  const npx = (note: string): HookRuntime => ({ commands: NPX_HOOK_COMMANDS, mode: 'npx', note });

  if (!shellSafePath(o.nodePath)) return npx(`the node path contains a character a hook command cannot quote safely (${o.nodePath})`);

  if (!isEphemeralRoot(o.packageRoot)) {
    if (!shellSafePath(o.packageRoot)) return npx(`the package path contains a character a hook command cannot quote safely (${o.packageRoot})`);
    return { commands: nodeHookCommands(o.nodePath, o.packageRoot), mode: 'direct', root: o.packageRoot };
  }

  const base = join(o.memoryDir, 'runtime');
  const dest = join(base, o.version);
  const destRoot = join(dest, 'node_modules', 'linksee-memory');
  if (!shellSafePath(destRoot)) return npx(`the memory folder path contains a character a hook command cannot quote safely (${destRoot})`);

  const pinned = (note: string): HookRuntime => {
    const bytes = dirBytes(dest);
    return { commands: nodeHookCommands(o.nodePath, destRoot), mode: 'pinned', root: destRoot, runtimeBase: base, version: o.version, bytes, note: `${note}; ${formatBytes(bytes)}` };
  };
  const versionAt = (root: string) => {
    try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version; } catch { return null; }
  };

  // Already installed and loadable → reuse, no network.
  if (versionAt(destRoot) === o.version && verify(destRoot, o.nodePath)) {
    return pinned(`using the pinned runtime at ${dest}`);
  }
  if (o.dryRun) {
    return { commands: nodeHookCommands(o.nodePath, destRoot), mode: 'pinned', root: destRoot, note: `[dry-run] would run npm install into ${dest}` };
  }

  const spec = o.spec ?? `linksee-memory@${o.version}`;
  const staging = join(base, `.tmp-${o.version}-${process.pid}`);
  const stagingRoot = join(staging, 'node_modules', 'linksee-memory');
  const fail = (why: string) => {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
    return npx(`${why}; kept the npx form, existing runtime left as it was`);
  };
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
  } catch (e) {
    return fail(`could not create ${staging} (${(e as Error)?.message ?? e})`);
  }
  const res = install(spec, staging, o.nodePath);
  if (!res.ok) return fail(`npm install ${spec} failed (${res.detail ?? 'unknown error'})`);
  if (versionAt(stagingRoot) !== o.version) return fail(`npm installed ${versionAt(stagingRoot) ?? 'nothing'} instead of ${o.version}`);
  if (!verify(stagingRoot, o.nodePath)) return fail(`the installed runtime could not load better-sqlite3`);
  // Same-version replacement must be undoable: move the old folder aside, move the new one in,
  // and only then delete the old one. If the second move fails, put the old one back.
  const aside = `${dest}.old-${process.pid}`;
  let movedAside = false;
  try {
    if (existsSync(dest)) { renameSync(dest, aside); movedAside = true; }
    renameSync(staging, dest);
  } catch (e) {
    if (movedAside) { try { renameSync(aside, dest); } catch { /* reported below */ } }
    const restored = !movedAside || existsSync(dest);
    return fail(`could not move the runtime into ${dest} (${(e as Error)?.message ?? e})${restored ? '' : `; the previous one is at ${aside}`}`);
  }
  if (movedAside) { try { rmSync(aside, { recursive: true, force: true }); } catch { /* harmless leftover */ } }
  // Older versions are NOT removed here: setup calls pruneOldRuntimes() at the very end, after
  // every settings write succeeded and nothing still points at them.
  return pinned(`installed ${spec} into ${dest}`);
}

