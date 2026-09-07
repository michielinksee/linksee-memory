#!/usr/bin/env node
// sync-version — carry package.json's version into the two MCP manifests.
//
// Runs from the `version` lifecycle script, which npm fires after it bumps package.json and
// before it creates the commit and tag. Staging the files here puts them inside that same
// commit, so the tag always points at a tree where all three agree — which is what the
// release gate checks.
//
// Without this, `npm version patch` bumps one file, the gate refuses the publish, and the
// fix is "remember to edit two more files by hand". That is the kind of step a mechanism
// should absorb (it cost us the v0.12.1 release).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const TARGETS = ['server.json', '.well-known/mcp/server.json'];
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

const changed = [];
for (const file of TARGETS) {
  const before = readFileSync(file, 'utf8');
  // Rewrite every "version" field: the MCP manifest carries one at the top level and one per
  // package entry, and they must move together.
  const after = before.replace(/("version"\s*:\s*)"[^"]*"/g, `$1"${version}"`);
  if (after !== before) {
    writeFileSync(file, after);
    changed.push(file);
  }
}

// Stage them so npm's version commit includes them.
execFileSync('git', ['add', ...TARGETS], { stdio: 'inherit' });

console.log(
  changed.length
    ? `sync-version: ${version} → ${changed.join(', ')}`
    : `sync-version: already at ${version}`,
);
