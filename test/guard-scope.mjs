#!/usr/bin/env node
// Regression: an explicit violation_signal must reach the gate even on a path-scoped anchor.
//
// Guards the 2026-09-07 finding. `affects` says WHERE a decision applies; `violation_signal`
// says WHAT is forbidden. The gate used to require a path match for any anchor that had
// `affects`, so a Bash command — which carries no file path — could never trip one. On a real
// machine that silenced 21 of 42 active anchors, including "ALTER TABLE memories DROP" on the
// anchor whose whole purpose is preventing that. Bash is where the destructive things run.
//
// Run: node test/guard-scope.mjs   (throwaway DB, never touches ~/.linksee-memory)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'linksee-scope-'));
process.env.LINKSEE_MEMORY_DIR = dir;

const { openDb, runMigrations } = await import('../dist/db/migrate.js');
const { gateAction } = await import('../dist/lib/guard.js');

const db = openDb();
runMigrations(db);

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); failures++; }
};

let n = 0;
const declare = ({ affects = [], terms = [], signals = [] }) =>
  Number(db.prepare(
    `INSERT INTO drift_anchors (kind, statement, rationale, affects, detect_terms, violation_signal,
                                status, lifecycle, confidence, card_policy, created_at, updated_at)
     VALUES ('constraint', ?, 'test', ?, ?, ?, 'active', 'active', 0.8, '{}', unixepoch(), unixepoch())`
  ).run(`anchor ${++n}`, JSON.stringify(affects), JSON.stringify(terms), JSON.stringify(signals)).lastInsertRowid);

const hit = (r, id) => (r.matched ?? []).some((m) => m.anchor_id === id);
const contradicted = (r, id) => (r.matched ?? []).some((m) => m.anchor_id === id && m.verdict === 'contradicts');

const bash = (command) => gateAction(db, { tool: 'Bash', command }, { sessionId: 'test' });
const edit = (file_path, diff) => gateAction(db, { tool: 'Edit', file_path, diff }, { sessionId: 'test' });

console.log('guard-scope regression');

const scoped = declare({
  affects: ['src/db/schema.sql', 'src/db/migrate.ts'],
  terms: ['schema', 'migration'],
  signals: ['ALTER TABLE memories DROP', 'DROP TABLE memories'],
});

// The case that was silently missed.
const onBash = bash('sqlite3 memory.db "ALTER TABLE memories DROP COLUMN layer"');
check('a signal hit fires on Bash even though the anchor is path-scoped',
  onBash.gate === 'warn' && contradicted(onBash, scoped), `gate=${onBash.gate}`);

// Path scoping still works on its own for file edits. Uses a fresh anchor: a pure path match
// is only 'inform', and inform is cooldown-suppressed once that anchor has already fired.
const scoped2 = declare({ affects: ['src/db/schema.sql'], terms: ['schema'], signals: ['DROP TABLE memories'] });
const inPath = edit('src/db/schema.sql', 'CREATE TABLE whatever (id INT);');
check('an in-scope file still brings the anchor in without a signal',
  inPath.gate === 'inform' && hit(inPath, scoped2), `gate=${inPath.gate}`);

// And scoping still limits topical noise: same topical words, unrelated file, no signal.
const outOfPath = edit('docs/notes.md', 'notes about schema and migration planning');
check('an out-of-scope file with only topical words stays quiet', outOfPath.gate === 'allow', `gate=${outOfPath.gate}`);

// A completely unrelated action must never trip it.
check('unrelated Bash stays quiet', bash('ls -la').gate === 'allow');
check('unrelated edit stays quiet', edit('README.md', '# Hello world').gate === 'allow');

// An unscoped anchor keeps firing on its topical terms (behaviour must not regress).
const unscoped = declare({ terms: ['mongodb'], signals: ['mongoose'] });
check('unscoped anchor still fires on a topical term',
  hit(edit('src/other.ts', 'we should consider mongodb here'), unscoped));
const unscoped2 = declare({ terms: ['mongodb'], signals: ['mongoose'] });
check('unscoped anchor still fires on its signal in Bash',
  contradicted(bash('npm install mongoose'), unscoped2));

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
