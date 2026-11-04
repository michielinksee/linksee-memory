#!/usr/bin/env node
// linksee-memory runtime list | prune [--yes --scope-confirmed] [--settings <file>]…   (0.17.2, L-1-148)
//
// setup (run through npx) installs each version under <memory dir>/runtime/<version>/ (about
// 35 MB each) and never deletes older ones. This command lists them and deletes, only when asked
// twice over (--yes AND --scope-confirmed), the versions nothing is confirmed to reference.
//
// Where a reference can be:
//   user:    ~/.claude/settings.json, ~/.claude/settings.local.json, ~/.claude.json, ~/.codex/config.toml
//   project: <cwd>/.claude/settings.json, <cwd>/.claude/settings.local.json
//   extra:   every --settings <file>
// Project settings of OTHER repos (where `setup --project` was run) cannot be found from here.
// So --yes alone deletes nothing: --scope-confirmed says "I checked the other repos' .claude/
// settings*.json, or passed them all with --settings" (Codex review of #19).
//
// How a file is read (Codex review of #19: no raw-text grep as the only test):
//   • JSON: parsed; every string (keys and values, at any depth) is checked for runtime/<version>
//     after normalizing \ → /. Parse failure → could not confirm.
//   • TOML (~/.codex/config.toml): a minimal line parser. Comments, blank lines and [table]
//     headers are skipped; every other line must be `key = value`. For `command` / `args` the
//     value must be a single-line string or array of strings, which is parsed and checked. Any line
//     it cannot read → could not confirm.
//   • In both, the raw text is ALSO searched (a match there only keeps a version, never deletes one).
// A default file that does not exist (ENOENT) references nothing. Anything else that cannot be
// confirmed → nothing is deleted, the reason is printed, exit 1.
// Never touched: .tmp-* (an install in progress), *.old-* (kept from a failed same-version swap),
// any name that is not a version, and the version this command runs from.

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

export const normPath = (t: string) => {
  const s = t.replace(/\\+/g, '/');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};

function jsonStrings(v: unknown, out: string[]): void {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) jsonStrings(x, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); jsonStrings(x, out); }
}

/** Parse one TOML string token at s[i]; returns [value, nextIndex] or null. */
function tomlString(s: string, i: number): [string, number] | null {
  if (s[i] === "'") {
    if (s.startsWith("'''", i)) return null; // multi-line literal: not handled → unconfirmable
    const j = s.indexOf("'", i + 1);
    return j < 0 ? null : [s.slice(i + 1, j), j + 1];
  }
  if (s[i] !== '"' || s.startsWith('"""', i)) return null;
  let out = ''; let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '"') return [out, j + 1];
    if (c === '\\') {
      const n = s[j + 1];
      const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', t: '\t', n: '\n', f: '\f', r: '\r' };
      if (n in map) { out += map[n]; j += 2; continue; }
      if (n === 'u' || n === 'U') {
        const len = n === 'u' ? 4 : 8; const hex = s.slice(j + 2, j + 2 + len);
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) return null;
        out += String.fromCodePoint(parseInt(hex, 16)); j += 2 + len; continue;
      }
      return null;
    }
    out += c; j++;
  }
  return null;
}

/** Minimal TOML reader for the lines that can hold a command. Returns strings, or an error. */
export function tomlCommandStrings(text: string): { strings: string[]; error?: string } {
  const strings: string[] = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (line === '' || line.startsWith('#')) continue;
    if (/^\[\[?[^\]]+\]\]?\s*(#.*)?$/.test(line)) continue;
    const m = line.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.-]+(?:\s*\.\s*[A-Za-z0-9_-]+)*)\s*=\s*(.*)$/);
    if (!m) return { strings, error: `line ${n + 1} is not \`key = value\`` };
    const key = m[1].replace(/^["']|["']$/g, '').split('.').pop()!.trim();
    const rest = m[2];
    if (rest === '') return { strings, error: `line ${n + 1} has no value` };
    if (key !== 'command' && key !== 'args') continue; // other keys: the raw-text check still applies
    let i = 0;
    const skip = () => { while (i < rest.length && /\s/.test(rest[i])) i++; };
    const tail = () => { skip(); return i >= rest.length || rest[i] === '#'; };
    if (rest[0] === '[') {
      i = 1; skip();
      while (rest[i] !== ']') {
        const t = tomlString(rest, i);
        if (!t) return { strings, error: `line ${n + 1}: ${key} is not a one-line array of strings` };
        strings.push(t[0]); i = t[1]; skip();
        if (rest[i] === ',') { i++; skip(); continue; }
        if (rest[i] !== ']') return { strings, error: `line ${n + 1}: ${key} is not a one-line array of strings` };
      }
      i++;
      if (!tail()) return { strings, error: `line ${n + 1}: unexpected text after ${key}` };
    } else {
      const t = tomlString(rest, 0);
      if (!t) return { strings, error: `line ${n + 1}: ${key} is not a one-line string` };
      strings.push(t[0]); i = t[1];
      if (!tail()) return { strings, error: `line ${n + 1}: unexpected text after ${key}` };
    }
  }
  return { strings };
}

/** Read every source into normalized strings, or say why it could not be confirmed. */
export function readSources(sources: SettingsSource[]): { texts: Array<{ path: string; strings: string[] }>; problems: string[] } {
  const texts: Array<{ path: string; strings: string[] }> = [];
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
    const strings: string[] = [raw];
    if (/\.toml$/i.test(s.path)) {
      const t = tomlCommandStrings(raw);
      if (t.error) { problems.push(`${s.path}: could not read as TOML (${t.error})`); continue; }
      strings.push(...t.strings);
    } else {
      let parsed: unknown;
      try { parsed = JSON.parse(raw.replace(/^﻿/, '')); } catch (e) {
        problems.push(`${s.path}: not valid JSON (${(e as Error)?.message?.split('\n')[0]})`);
        continue;
      }
      jsonStrings(parsed, strings);
    }
    texts.push({ path: s.path, strings: strings.map(normPath) });
  }
  return { texts, problems };
}

export type PruneOpts = {
  memoryDir: string;
  sources: SettingsSource[];
  yes: boolean;
  /** The caller confirmed other repos' project settings were checked or passed with --settings. */
  scopeConfirmed?: boolean;
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
  const self = o.selfRoot ? normPath(safeReal(o.selfRoot)) : '';
  const entries: RuntimeEntry[] = versions.map((v) => {
    const dir = join(base, v);
    const needle = `runtime/${normPath(v)}`;
    const hit = (s: string) => s.includes(needle + '/') || s.endsWith(needle) || s.includes(needle + '"') || s.includes(needle + "'");
    const referencedBy = texts.filter((t) => t.strings.some(hit)).map((t) => t.path);
    const e: RuntimeEntry = { version: v, dir, bytes: dirBytes(dir), referencedBy, decision: 'delete' };
    const dirNorm = normPath(safeReal(dir)) + '/';
    if (self && (self + '/').startsWith(dirNorm)) { e.decision = 'keep-running'; e.reason = 'this command is running from it'; }
    else if (referencedBy.length) { e.decision = 'keep-referenced'; e.reason = `referenced by ${referencedBy.join(', ')}`; }
    else if (problems.length) { e.decision = 'keep-unconfirmed'; e.reason = 'could not confirm that nothing references it (see below)'; }
    return e;
  });

  const willDelete = o.yes && !!o.scopeConfirmed && problems.length === 0;
  log(`Runtimes under ${base}:`);
  for (const e of entries) {
    const what = e.decision === 'delete'
      ? (willDelete ? 'delete' : 'no reference found (deletable with --yes --scope-confirmed)')
      : `keep — ${e.reason}`;
    log(`  ${e.version.padEnd(10)} ${formatBytes(e.bytes).padStart(7)}  ${what}`);
  }
  for (const n of others) log(`  (left alone) ${n}`);
  if (problems.length) {
    log(`Could not confirm references, so nothing is deleted:`);
    for (const p of problems) log(`  • ${p}`);
  }
  log(`Checked: ${o.sources.map((s) => s.path).join(', ')}.`);
  log(`Not checked: project settings of other repos. If you ran \`setup --project\` elsewhere, pass each repo's .claude/settings.json (and settings.local.json) with --settings.`);

  let code: 0 | 1 = problems.length ? 1 : 0;
  if (o.yes && !o.scopeConfirmed) {
    log(`Nothing deleted: add --scope-confirmed once you have checked (or passed with --settings) the .claude/settings*.json of every other repo where you ran setup --project.`);
    return { code: 1, entries, problems };
  }
  if (willDelete) {
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
      try {
        rmSync(aside, { recursive: true, force: true });
        if (existsSync(aside)) throw new Error('folder still there');
      } catch (err) {
        e.decision = 'delete-failed'; e.reason = `moved to ${aside} but not fully removed (${(err as Error)?.message})`; code = 1;
        log(`  ${e.version}: ${e.reason}; delete that folder by hand`);
        continue;
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
  return `Usage: npx -y linksee-memory runtime list [--settings <file>]...
       npx -y linksee-memory runtime prune [--yes --scope-confirmed] [--settings <file>]...

Lists <memory dir>/runtime/<version> (installed by setup when run through npx) with sizes and
what references each one. prune deletes only versions no settings file references, and only with
both --yes and --scope-confirmed (= you checked, or passed with --settings, the .claude/settings*.json
of every other repo where you ran setup --project). If any settings file cannot be read or parsed,
nothing is deleted.`;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || (cmd !== 'list' && cmd !== 'prune')) {
    console.log(usage());
    return cmd && cmd !== '--help' && cmd !== '-h' ? 1 : 0;
  }
  const extra: SettingsSource[] = [];
  let yes = false; let scopeConfirmed = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--yes' && cmd === 'prune') yes = true;
    else if (rest[i] === '--scope-confirmed' && cmd === 'prune') scopeConfirmed = true;
    else if (rest[i] === '--settings' && rest[i + 1]) extra.push({ path: resolve(rest[++i]), explicit: true });
    else { console.error(`Unknown argument: ${rest[i]}\n\n${usage()}`); return 1; }
  }
  const home = homedir();
  const memoryDir = process.env.LINKSEE_MEMORY_DIR ?? join(home, '.linksee-memory');
  const selfRoot = join(fileURLToPath(import.meta.url), '..', '..', '..');
  return pruneRuntimes({ memoryDir, sources: [...defaultSources(home, process.cwd()), ...extra], yes, scopeConfirmed, selfRoot }).code;
}

const isMain = (() => {
  try {
    const a = process.argv[1] ? realpathSync(process.argv[1]) : '';
    const b = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch { return false; }
})();
if (isMain) process.exit(main(process.argv.slice(2)));
