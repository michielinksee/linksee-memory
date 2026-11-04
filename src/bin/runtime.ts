#!/usr/bin/env node
// linksee-memory runtime list | prune [--yes] [--settings <file>]…   (0.17.2, L-1-148)
//
// setup (run through npx) installs each version under <memory dir>/runtime/<version>/ (about
// 35 MB each) and never deletes older ones. This command lists them and, only with --yes,
// deletes the versions that nothing is confirmed to reference.
//
// "Confirmed" means: every place a hook or MCP entry could point at a runtime was read and
// parsed, and none mentions runtime/<version>/. The places are
//   user:    ~/.claude/settings.json, ~/.claude/settings.local.json, ~/.claude.json, ~/.codex/config.toml
//   project: <cwd>/.claude/settings.json, <cwd>/.claude/settings.local.json
//   extra:   every --settings <file> (e.g. other repos where you ran `setup --project`)
// A default file that does not exist (ENOENT) references nothing. Any other read error, a JSON
// file that does not parse, or a --settings file that is missing makes every version
// "could not confirm" — nothing is deleted, and the reason is printed.
// Never touched: .tmp-* (an install in progress) and *.old-* (kept for a failed same-version swap).

import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirBytes, formatBytes } from '../lib/hook-runtime.js';

export type SettingsSource = { path: string; explicit: boolean };
export type RuntimeEntry = {
  version: string;
  dir: string;
  bytes: number;
  referencedBy: string[];
  decision: 'keep-referenced' | 'keep-unconfirmed' | 'keep-running' | 'delete' | 'deleted' | 'delete-failed';
  reason?: string;
};

const VERSION_DIR = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

export function defaultSources(home: string, cwd: string): SettingsSource[] {
  return [
    join(home, '.claude', 'settings.json'),
    join(home, '.claude', 'settings.local.json'),
    join(home, '.claude.json'),
    join(home, '.codex', 'config.toml'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
  ].map((path) => ({ path, explicit: false }));
}

const normText = (t: string) => {
  const s = t.replace(/\\+/g, '/');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};

/** Read every source. Returns the normalized texts, or the reasons some could not be confirmed. */
export function readSources(sources: SettingsSource[]): { texts: Array<{ path: string; text: string }>; problems: string[] } {
  const texts: Array<{ path: string; text: string }> = [];
  const problems: string[] = [];
  for (const s of sources) {
    let raw: string;
    try {
      raw = readFileSync(s.path, 'utf8');
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === 'ENOENT' && !s.explicit) continue; // absent → references nothing
      problems.push(`${s.path}: ${code === 'ENOENT' ? 'not found (passed with --settings)' : `could not read (${code ?? (e as Error)?.message})`}`);
      continue;
    }
    if (/\.json$/i.test(s.path)) {
      try { JSON.parse(raw.replace(/^﻿/, '')); } catch (e) {
        problems.push(`${s.path}: not valid JSON (${(e as Error)?.message?.split('\n')[0]})`);
        continue;
      }
    }
    texts.push({ path: s.path, text: normText(raw) });
  }
  return { texts, problems };
}

export type PruneOpts = {
  memoryDir: string;
  sources: SettingsSource[];
  yes: boolean;
  /** Package root this command runs from (a runtime in use by this very process is kept). */
  selfRoot?: string;
  log?: (l: string) => void;
};

export function listRuntimes(memoryDir: string): { base: string; versions: string[]; others: string[]; error?: string } {
  const base = join(memoryDir, 'runtime');
  if (!existsSync(base)) return { base, versions: [], others: [] };
  let names: string[];
  try { names = readdirSync(base); } catch (e) { return { base, versions: [], others: [], error: (e as Error)?.message }; }
  const versions: string[] = []; const others: string[] = [];
  for (const n of names.sort()) {
    let dir = false;
    try { dir = statSync(join(base, n)).isDirectory(); } catch { /* treat as other */ }
    (dir && VERSION_DIR.test(n) ? versions : others).push(n);
  }
  return { base, versions, others };
}

export function pruneRuntimes(o: PruneOpts): { code: 0 | 1; entries: RuntimeEntry[]; problems: string[] } {
  const log = o.log ?? ((l: string) => console.log(l));
  const { base, versions, others, error } = listRuntimes(o.memoryDir);
  if (error) { log(`Could not list ${base}: ${error}. Nothing deleted.`); return { code: 1, entries: [], problems: [error] }; }
  if (versions.length === 0) {
    log(`No runtime versions under ${base}.`);
    for (const n of others) log(`  (left alone) ${n}`);
    return { code: 0, entries: [], problems: [] };
  }
  const { texts, problems } = readSources(o.sources);
  const self = o.selfRoot ? normText(safeReal(o.selfRoot)) : '';
  const entries: RuntimeEntry[] = versions.map((v) => {
    const dir = join(base, v);
    const needle = `runtime/${normText(v)}/`;
    const referencedBy = texts.filter((t) => t.text.includes(needle) || t.text.endsWith(`runtime/${normText(v)}`)).map((t) => t.path);
    const e: RuntimeEntry = { version: v, dir, bytes: dirBytes(dir), referencedBy, decision: 'delete' };
    const dirNorm = normText(safeReal(dir)) + '/';
    if (self && (self + '/').startsWith(dirNorm)) { e.decision = 'keep-running'; e.reason = 'this command is running from it'; }
    else if (referencedBy.length) { e.decision = 'keep-referenced'; e.reason = `referenced by ${referencedBy.join(', ')}`; }
    else if (problems.length) { e.decision = 'keep-unconfirmed'; e.reason = 'could not confirm that nothing references it (see below)'; }
    return e;
  });

  log(`Runtimes under ${base}:`);
  for (const e of entries) {
    const what = e.decision === 'delete' ? (o.yes ? 'delete' : 'can be deleted (add --yes)') : `keep — ${e.reason}`;
    log(`  ${e.version.padEnd(10)} ${formatBytes(e.bytes).padStart(7)}  ${what}`);
  }
  for (const n of others) log(`  (left alone) ${n}`);
  if (problems.length) {
    log(`Could not confirm references, so nothing unreferenced is deleted:`);
    for (const p of problems) log(`  • ${p}`);
  }
  log(`Checked: ${o.sources.map((s) => s.path).join(', ')}.`);
  log(`Project settings of other repos are not checked: if you ran \`setup --project\` elsewhere, pass that repo's .claude/settings.json with --settings.`);

  let code: 0 | 1 = problems.length ? 1 : 0;
  if (o.yes) {
    for (const e of entries.filter((x) => x.decision === 'delete')) {
      // Rename first so the version disappears at once (no half-deleted runtime under its own
      // name), then remove the renamed folder.
      const aside = join(base, `.pruning-${e.version}-${process.pid}`);
      try {
        renameSync(e.dir, aside);
      } catch (err) {
        e.decision = 'delete-failed'; e.reason = (err as Error)?.message; code = 1;
        log(`  could not delete ${e.version} (${e.reason}); left as it was`);
        continue;
      }
      try { rmSync(aside, { recursive: true, force: true }); } catch (err) {
        log(`  ${e.version} moved to ${aside} but not fully removed (${(err as Error)?.message}); delete that folder by hand`);
      }
      e.decision = 'deleted';
      log(`  deleted ${e.version} (${formatBytes(e.bytes)})`);
    }
  }
  return { code, entries, problems };
}

function safeReal(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

function usage(): string {
  return `Usage: npx -y linksee-memory runtime list
       npx -y linksee-memory runtime prune [--yes] [--settings <file>]...

Lists <memory dir>/runtime/<version> (installed by setup when run through npx) with sizes.
prune deletes, only with --yes, the versions that no settings file references. If any settings
file cannot be read or parsed, nothing is deleted.`;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || (cmd !== 'list' && cmd !== 'prune')) {
    console.log(usage());
    return cmd && cmd !== '--help' && cmd !== '-h' ? 1 : 0;
  }
  const extra: SettingsSource[] = [];
  let yes = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--yes' && cmd === 'prune') yes = true;
    else if (rest[i] === '--settings' && rest[i + 1]) extra.push({ path: resolve(rest[++i]), explicit: true });
    else { console.error(`Unknown argument: ${rest[i]}\n\n${usage()}`); return 1; }
  }
  const home = homedir();
  const memoryDir = process.env.LINKSEE_MEMORY_DIR ?? join(home, '.linksee-memory');
  const selfRoot = join(fileURLToPath(import.meta.url), '..', '..', '..');
  return pruneRuntimes({ memoryDir, sources: [...defaultSources(home, process.cwd()), ...extra], yes, selfRoot }).code;
}

const isMain = (() => {
  try {
    const a = process.argv[1] ? realpathSync(process.argv[1]) : '';
    const b = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch { return false; }
})();
if (isMain) process.exit(main(process.argv.slice(2)));
