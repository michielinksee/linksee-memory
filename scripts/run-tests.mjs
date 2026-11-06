#!/usr/bin/env node
// run-tests — the only way tests are run: `pnpm test`, ci.yml and publish.yml all call this.
//
//   node scripts/run-tests.mjs                 check the lists, then run every test in test/suite.json
//   node scripts/run-tests.mjs --check         check the lists only (no build needed)
//   node scripts/run-tests.mjs --set packed    run only the `packed` names from test/required-tests.json
//   node scripts/run-tests.mjs --root <dir>    run the tests found in <dir>/test with <dir> as cwd
//                                              (scripts/test-packed.mjs points this at an installed tarball)
//   node scripts/run-tests.mjs --check --base <ref>   also fail if test/required-tests.json names fewer
//                                              tests than on <ref> (PR CI passes the base branch)
//
// Why one list: before this, ci.yml, publish.yml and package.json each enumerated tests by hand and had
// drifted — the 0.18.1 no-delete tests ran on PRs but not before `npm publish` (L-1-284, L-1-322).
//
// Fail-closed: an unreadable or malformed list, a missing file, an unlisted test, a required test that is
// excluded, a workflow that enumerates `node test/...` itself, a timeout or a signal — all exit 1.
//
// Every test runs with a fresh temp HOME / USERPROFILE / LINKSEE_MEMORY_DIR and telemetry off, so even a
// test that forgot to isolate itself cannot reach the real ~/.linksee-memory or ~/.claude.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fail = (msg) => { console.error(`\n✖ run-tests: ${msg}\n`); process.exit(1); };

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; if (!v || v.startsWith('--')) fail(`${name} needs a value`); return v; };
const known = new Set(['--check', '--set', '--root', '--base']);
for (let i = 0; i < args.length; i++) {
  if (!known.has(args[i])) fail(`unknown argument ${args[i]}`);
  if (args[i] === '--set' || args[i] === '--root' || args[i] === '--base') i++;
}

function readJson(rel) {
  const p = join(REPO, rel);
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { fail(`cannot read ${rel}: ${e.message}`); }
}

// ---- 1. the lists themselves -------------------------------------------------------------------
function checkLists() {
  const suite = readJson('test/suite.json');
  const req = readJson('test/required-tests.json');
  const problems = [];

  if (!Array.isArray(suite.tests) || suite.tests.length === 0) fail('test/suite.json: `tests` must be a non-empty array');
  if (!suite.excluded || typeof suite.excluded !== 'object' || Array.isArray(suite.excluded)) fail('test/suite.json: `excluded` must be an object of file → reason');
  if (!Array.isArray(req.required) || req.required.length === 0) fail('test/required-tests.json: `required` must be a non-empty array');
  if (!Array.isArray(req.packed) || req.packed.length === 0) fail('test/required-tests.json: `packed` must be a non-empty array');

  const listed = new Map();
  for (const t of suite.tests) {
    if (!t || typeof t.file !== 'string' || !/^[\w.-]+\.mjs$/.test(t.file)) { problems.push(`bad entry in tests: ${JSON.stringify(t)}`); continue; }
    if (!Number.isFinite(t.timeout) || t.timeout <= 0) problems.push(`${t.file}: timeout must be a positive number of seconds`);
    if (listed.has(t.file)) problems.push(`${t.file} is listed twice`);
    listed.set(t.file, t);
  }
  for (const [f, why] of Object.entries(suite.excluded)) {
    if (typeof why !== 'string' || why.trim().length < 10) problems.push(`excluded ${f}: give the reason it cannot run in CI`);
    if (listed.has(f)) problems.push(`${f} is both listed and excluded`);
  }

  // every test file on disk is accounted for — a new test cannot be silently left out
  const onDisk = readdirSync(join(REPO, 'test')).filter((f) => f.endsWith('.mjs'));
  for (const f of onDisk) if (!listed.has(f) && !(f in suite.excluded)) problems.push(`test/${f} is in neither \`tests\` nor \`excluded\` of test/suite.json`);
  for (const f of listed.keys()) if (!onDisk.includes(f)) problems.push(`test/suite.json lists ${f}, which does not exist`);
  for (const f of Object.keys(suite.excluded)) if (!onDisk.includes(f)) problems.push(`test/suite.json excludes ${f}, which does not exist (drop the entry)`);

  // the floor: required names must be run, packed ⊆ required
  for (const f of req.required) {
    if (f in suite.excluded) problems.push(`${f} is required (test/required-tests.json) but excluded in test/suite.json`);
    else if (!listed.has(f)) problems.push(`${f} is required (test/required-tests.json) but missing from test/suite.json`);
  }
  for (const f of req.packed) if (!req.required.includes(f)) problems.push(`packed test ${f} must also be in \`required\``);

  // nobody else keeps a list: package.json and both workflows must go through this script
  const pkg = readJson('package.json');
  if (!/^node scripts\/run-tests\.mjs(\s|$)/.test(pkg.scripts?.test ?? '')) problems.push('package.json "test" must be `node scripts/run-tests.mjs`');
  for (const wf of ['.github/workflows/ci.yml', '.github/workflows/publish.yml']) {
    let text;
    try { text = readFileSync(join(REPO, wf), 'utf8'); } catch (e) { problems.push(`cannot read ${wf}: ${e.message}`); continue; }
    const lines = text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
    if (lines.some((l) => /\bnode\s+(\.\/)?test\//.test(l))) problems.push(`${wf} runs \`node test/...\` directly; use scripts/run-tests.mjs`);
    if (!lines.some((l) => /scripts\/run-tests\.mjs/.test(l))) problems.push(`${wf} does not call scripts/run-tests.mjs`);
  }
  if (!readFileSync(join(REPO, '.github/workflows/publish.yml'), 'utf8').split(/\r?\n/).some((l) => !/^\s*#/.test(l) && /scripts\/test-packed\.mjs/.test(l))) {
    problems.push('.github/workflows/publish.yml does not run scripts/test-packed.mjs before publishing');
  }
  // publish the tested tarball, never a fresh pack: a bare `npm publish` re-runs prepublishOnly + pack
  if (readFileSync(join(REPO, '.github/workflows/publish.yml'), 'utf8').split(/\r?\n/).some((l) => !/^\s*#/.test(l) && /\bnpm publish(\s*$|\s+-)/.test(l))) {
    problems.push('.github/workflows/publish.yml has a bare `npm publish`; publish the tested tarball (`npm publish <file>.tgz`)');
  }

  if (problems.length) fail(`test lists are inconsistent:\n  - ${problems.join('\n  - ')}`);
  return { suite, req, listed };
}

// ---- 1b. the floor may not shrink within a PR --------------------------------------------------
// Compared with the base branch, so one PR cannot lower the floor and pass — unless it also edits
// this script or ci.yml, which is what CODEOWNERS is for once review by code owners is enforced.
function checkAgainstBase(ref, req) {
  const git = (a) => spawnSync('git', a, { cwd: REPO, encoding: 'utf8' });
  if (git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status !== 0) fail(`--base ${ref}: not a commit here (fetch it first)`);
  if (git(['cat-file', '-e', `${ref}:test/required-tests.json`]).status !== 0) {
    console.log(`○ ${ref} has no test/required-tests.json yet — nothing to compare (the PR that introduces it)`);
    return;
  }
  const shown = git(['show', `${ref}:test/required-tests.json`]);
  let old;
  try { if (shown.status !== 0) throw new Error(shown.stderr); old = JSON.parse(shown.stdout); } catch (e) { fail(`cannot read ${ref}:test/required-tests.json: ${e.message}`); }
  const lost = [];
  for (const key of ['required', 'packed']) {
    if (!Array.isArray(old[key])) fail(`${ref}:test/required-tests.json has no "${key}" array`);
    for (const f of old[key]) if (!req[key].includes(f)) lost.push(`${key}: ${f}`);
  }
  if (lost.length) fail(`test/required-tests.json drops names that ${ref} requires:\n  - ${lost.join('\n  - ')}\nLowering the floor is its own owner-approved PR that says why.`);
  console.log(`✓ floor not lowered vs ${ref}: required ${old.required.length}→${req.required.length}, packed ${old.packed.length}→${req.packed.length}`);
}

// ---- 2. run ------------------------------------------------------------------------------------
function rmQuiet(p) { try { rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp; leave it */ } }

// (top level on purpose — no "am I main?" guard, which could silently skip every test on a path mismatch)
{
  const { req, listed } = checkLists();
  console.log(`✓ test lists consistent: ${listed.size} tests, ${req.required.length} required, ${req.packed.length} packed`);
  const base = opt('--base');
  if (base) checkAgainstBase(base, req);
  if (flag('--check')) process.exit(0);

  const set = opt('--set') ?? 'all';
  if (set !== 'all' && set !== 'packed') fail(`--set must be all or packed, not ${set}`);
  const root = resolve(opt('--root') ?? REPO);
  const names = set === 'all' ? [...listed.keys()] : req.packed;

  if (!existsSync(join(root, 'dist', 'mcp', 'server.js'))) fail(`${root}/dist/mcp/server.js not found — run \`pnpm build\` first`);

  const failed = [];
  const started = Date.now();
  for (const name of names) {
    const file = join(root, 'test', name);
    if (!existsSync(file)) { failed.push(`${name} (missing under ${root})`); continue; }
    const { timeout } = listed.get(name);
    const home = mkdtempSync(join(tmpdir(), 'linksee-runtests-'));
    const env = {
      ...process.env,
      HOME: home, USERPROFILE: home,
      LINKSEE_MEMORY_DIR: join(home, '.linksee-memory'),
      LINKSEE_TELEMETRY: 'off',
      LINKSEE_AUTO_CONSOLIDATE: '',
    };
    delete env.LINKSEE_TEST_FAULT;
    console.log(`\n▶ ${name}`);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [file], { cwd: root, env, stdio: 'inherit', timeout: timeout * 1000, killSignal: 'SIGKILL' });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    rmQuiet(home);
    if (r.error || r.status !== 0 || r.signal) {
      const why = r.error?.code === 'ETIMEDOUT' ? `timed out after ${timeout}s` : r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
      console.error(`✖ ${name}: ${why} (${secs}s)`);
      failed.push(`${name} — ${why}`);
    } else {
      console.log(`✓ ${name} (${secs}s)`);
    }
  }

  const total = ((Date.now() - started) / 1000).toFixed(0);
  if (failed.length) fail(`${failed.length}/${names.length} failed in ${total}s (root ${root}):\n  - ${failed.join('\n  - ')}`);
  console.log(`\n✓ ${names.length}/${names.length} passed in ${total}s (set ${set}, root ${root})`);
}
