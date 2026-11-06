#!/usr/bin/env node
// test-packed — run the preservation tests against what npm would actually ship.
//
//   node scripts/test-packed.mjs                    pack, install into a throwaway project, run `packed` tests
//   node scripts/test-packed.mjs --integrity-out f  also write the tarball's integrity to f (publish.yml compares)
//
// Why: the working tree can pass while the tarball does not — a file missing from package.json "files",
// a dist that was not rebuilt, a dependency that only resolves through devDependencies. The 0.18.1
// no-delete guarantees (test/required-tests.json `packed`) are checked here on the installed package.
//
// Steps (all inside one temp dir, removed on success, kept and printed on failure):
//   1. `npm pack` the repo (dist must already be built) → linksee-memory-<v>.tgz
//   2. `npm install <tgz>` into an empty consumer project — the path a user's `npm i` takes
//   3. copy this repo's test/ (tests + fixtures) into consumer/node_modules/linksee-memory/test
//   4. scripts/run-tests.mjs --set packed --root <installed package>
// Tests reach dist through `../dist/...` and `dist/...` relative to that root, so they exercise the
// tarball's dist and the consumer's node_modules, never the repo's.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let work;
const fail = (msg) => {
  console.error(`\n✖ test-packed: ${msg}`);
  if (work) console.error(`  (work dir kept for inspection: ${work})`);
  process.exit(1);
};

const args = process.argv.slice(2);
let integrityOut;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--integrity-out' && args[i + 1]) integrityOut = resolve(args[++i]);
  else fail(`unknown argument ${args[i]}`);
}

const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
const npm = (cmdArgs, cwd) => {
  const r = spawnSync(`npm ${cmdArgs}`, { cwd, shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 300_000, env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' } });
  if (r.error || r.status !== 0) fail(`npm ${cmdArgs} failed (${r.error?.message ?? `exit ${r.status}`})\n${r.stdout ?? ''}`);
  return r.stdout;
};

const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
if (!existsSync(join(REPO, 'dist', 'mcp', 'server.js'))) fail('dist/ is not built — run `pnpm build` first');

work = mkdtempSync(join(tmpdir(), 'linksee-packed-'));

// 1. pack (no lifecycle scripts of ours run on pack; prepublishOnly is publish-only)
const packOut = npm(`pack --json --pack-destination ${q(work)}`, REPO);
let packed;
// npm <= 11 prints [ {...} ]; npm 12 prints { "<name>": {...} }. Accept exactly one entry of either shape.
try {
  const j = JSON.parse(packOut);
  const entries = Array.isArray(j) ? j : Object.values(j);
  if (entries.length !== 1) throw new Error(`expected one package, got ${entries.length}`);
  packed = entries[0];
} catch (e) { fail(`could not parse npm pack --json output: ${e.message}\n${packOut}`); }
if (!packed?.filename || !/^sha512-/.test(packed?.integrity ?? '')) fail(`npm pack --json gave no filename/integrity:\n${packOut}`);
const tgz = join(work, packed.filename);
if (!existsSync(tgz)) fail(`npm pack reported ${packed.filename} but it is not in ${work}`);
console.log(`✓ packed ${packed.filename} · ${packed.entryCount} files · ${packed.integrity}`);

// 2. install into an empty consumer project
const consumer = join(work, 'consumer');
mkdirSync(consumer);
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'linksee-packed-consumer', version: '0.0.0', private: true }, null, 2));
npm(`install --no-save ${q(tgz)}`, consumer);
const installed = join(consumer, 'node_modules', 'linksee-memory');
if (!existsSync(installed) || lstatSync(installed).isSymbolicLink()) fail(`${installed} is missing or a symlink — not a real install of the tarball`);
const real = realpathSync(installed);
const rel = relative(realpathSync(REPO), real);
if (!rel.startsWith('..') && !isAbsolute(rel)) fail(`installed package resolves inside the repo (${real}); refusing to call that a tarball test`);
const got = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version;
if (got !== pkg.version) fail(`installed version ${got} != package.json ${pkg.version}`);
for (const must of ['dist/mcp/server.js', 'dist/db/schema.sql', 'dist/lib/test-faults.js']) {
  if (!existsSync(join(installed, must))) fail(`tarball is missing ${must}`);
}
if (existsSync(join(installed, 'test'))) fail('tarball unexpectedly ships a test/ folder; refusing to overwrite it');
console.log(`✓ installed linksee-memory@${got} into ${consumer}`);

// 3. bring the tests (and fixtures) to the installed package
cpSync(join(REPO, 'test'), join(installed, 'test'), { recursive: true });

// 4. run the packed set there
const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'run-tests.mjs'), '--set', 'packed', '--root', installed], { stdio: 'inherit' });
if (r.error || r.status !== 0) fail(`packed tests failed against the tarball (${r.error?.message ?? `exit ${r.status}`})`);

if (integrityOut) writeFileSync(integrityOut, `${packed.integrity}\n`);
try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp */ }
work = undefined;
console.log(`\n✓ tarball ${packed.filename} passed the packed preservation tests (${packed.integrity})`);
