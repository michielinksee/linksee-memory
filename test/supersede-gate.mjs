#!/usr/bin/env node
// Regression: harden → BLOCK → supersede → PASS, and the superseding anchor keeps gating.
//
// Guards the 2026-09-04 defect: the gate selected anchors by status/lifecycle only, so an
// anchor the user had explicitly superseded kept blocking — while the block text told them
// to supersede it. The reporting layer (truth-engine) already treated it as accounted for;
// the enforcement layer did not.
//
// Run: node test/supersede-gate.mjs   (uses a throwaway DB, never touches ~/.linksee-memory)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'linksee-supersede-'));
process.env.LINKSEE_MEMORY_DIR = dir;

const { openDb, runMigrations } = await import('../dist/db/migrate.js');
const { gateAction, buildBootDigest } = await import('../dist/lib/guard.js');
const { resolveDrift } = await import('../dist/lib/truth-engine.js');

const db = openDb();
runMigrations(db);

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); failures++; }
};

const declare = (statement, signals) =>
  db.prepare(
    `INSERT INTO drift_anchors (kind, statement, rationale, affects, detect_terms, violation_signal,
                                status, lifecycle, confidence, card_policy, created_at, updated_at)
     VALUES ('prohibition', ?, 'test', '[]', '[]', ?, 'active', 'active', 0.8,
             json('{"gate_mode":"hard","enabled":true}'), unixepoch(), unixepoch())`
  ).run(statement, JSON.stringify(signals)).lastInsertRowid;

const edit = (text) =>
  gateAction(db, { tool: 'Edit', file_path: 'src/db.ts', diff: text }, { sessionId: 'test' });

console.log('supersede-gate regression');

const oldAnchor = declare('MongoDBを採用しない', ['mongoose']);
check('hardened anchor blocks a contradicting edit', edit('import mongoose from "mongoose";').gate === 'block');

const newAnchor = declare('MongoDBを採用する', ['postgres']);
resolveDrift(db, { anchor_id: Number(oldAnchor), action: 'supersede', superseded_by: Number(newAnchor) });

const after = edit('import mongoose from "mongoose";');
check('superseded anchor no longer blocks', after.gate !== 'block', `gate=${after.gate}`);

// The asymmetry that makes this non-trivial: the supersede record names both anchors.
// Only the retired one may stop gating.
const other = edit('import { Pool } from "postgres";');
check('the superseding anchor still gates', other.gate === 'block', `gate=${other.gate}`);

const digest = buildBootDigest(db, {});
check('boot digest drops the superseded anchor', !digest.text.includes('MongoDBを採用しない'));
check('boot digest keeps the current anchor', digest.text.includes('MongoDBを採用する'));

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
