#!/usr/bin/env node
// release-gate — refuse to publish anything git does not describe.
//
// Runs from `prepublishOnly` (npm publish). Three checks, all cheap:
//   1. the working tree has no modified tracked files (untracked is fine)
//   2. a tag v<version> exists and points at HEAD
//   3. package.json / server.json / .well-known/mcp/server.json agree on the version
//
// Why: 0.11.5 was published from a dirty tree — schema v15, anchor-touch.ts, export-report.ts
// and several server.ts hunks shipped to users but never reached git. A gate is a mechanism;
// "remember to commit first" is not.
//
// Escape hatch (loud, for emergencies only): LINKSEE_RELEASE_GATE=skip

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const fail = (msg) => { console.error(`\n✖ release-gate: ${msg}\n`); process.exit(1); };

if (process.env.LINKSEE_RELEASE_GATE === 'skip') {
  console.error('⚠ release-gate SKIPPED via LINKSEE_RELEASE_GATE=skip — this publish is not backed by git.');
  process.exit(0);
}

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;

// 1. clean tree (modified / staged tracked files only — untracked files are not shipped)
const dirty = sh('git status --porcelain --untracked-files=no');
if (dirty) fail(`working tree has uncommitted changes:\n${dirty}\nCommit them first — what you publish must be what git has.`);

// 2. tag at HEAD
// (no `^{commit}` here: execSync goes through cmd.exe on Windows, where `^` is an escape
// character and the peel syntax silently turns into `v0.12.0{commit}`. rev-list -n 1 peels
// annotated and lightweight tags alike.)
const tag = `v${version}`;
let tagRef = '';
try { sh(`git rev-parse --verify --quiet refs/tags/${tag}`); tagRef = sh(`git rev-list -n 1 refs/tags/${tag}`); }
catch { fail(`tag ${tag} does not exist. Run: git tag ${tag}`); }
const head = sh('git rev-parse HEAD');
if (tagRef !== head) fail(`tag ${tag} points at ${tagRef.slice(0, 7)} but HEAD is ${head.slice(0, 7)}. Publish from the tagged commit.`);

// 3b. the MCP registry rejects a manifest description over 100 characters (learned the hard
//     way on 0.15.2: publish failed with "expected length <= 100"). Check it here, where it
//     is cheap, not at the registry, where it costs a round-trip and someone's evening.
for (const f of ['server.json', '.well-known/mcp/server.json']) {
  const d = String(JSON.parse(readFileSync(f, 'utf8')).description ?? '');
  if (d.length > 100) fail(`${f} description is ${d.length} chars; the MCP registry allows 100.`);
}

// 3. versions agree
const readVersion = (path) => JSON.parse(readFileSync(path, 'utf8')).version;
for (const f of ['server.json', '.well-known/mcp/server.json']) {
  const v = readVersion(f);
  if (v !== version) fail(`${f} says ${v}, package.json says ${version}.`);
}

console.log(`✔ release-gate: clean tree, ${tag} at HEAD (${head.slice(0, 7)}), versions agree.`);
