#!/usr/bin/env node
// Regression: the human's "that was a false positive" must change the NEXT detection.
//
// Guards the 2026-09-07 finding, the third instance of one pattern: a layer records the human's
// verdict and the enforcement layer ignores it. `resolve_drift(action:'dismiss')` closed the
// drift edges and the gate never read the verdict, so the same wrong match fired on the very
// next command. Measured: anchor #13 ("don't favour our own products in rankings", signals = the
// bare product names) fired 6× in two minutes because a temp file path contained "Sake-Navi".
//
// Also covers the precision rule that produced that noise: a signal hit stands in for scope only
// when the action names no files (Bash). When it does name files, the anchor's own scope decides.
//
// Run: node test/guard-dismiss.mjs   (throwaway DB, never touches ~/.linksee-memory)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'linksee-dismiss-'));
process.env.LINKSEE_MEMORY_DIR = dir;

const { openDb, runMigrations } = await import('../dist/db/migrate.js');
const { gateAction } = await import('../dist/lib/guard.js');
const { resolveDrift } = await import('../dist/lib/truth-engine.js');

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

let s = 0;
const bash = (command) => gateAction(db, { tool: 'Bash', command }, { sessionId: `s${++s}` });
const write = (file_path, content) => gateAction(db, { tool: 'Write', file_path, content }, { sessionId: `s${++s}` });
const hit = (r, id) => (r.matched ?? []).some((m) => m.anchor_id === id);

console.log('guard-dismiss regression');

// The real anchor shape that caused the noise: scoped to one repo, signals are bare product names.
const ranking = declare({
  affects: ['kansei-link-mcp/src/tools/search-services.ts'],
  terms: ['ranking', 'score'],
  signals: ['sake-navi', 'cardnavi'],
});

// ── precision: scope decides when the action names files ────────────────────
const onPath = write('C:/tmp/claude/C--Users-HP-Sake-Navi/x.py', 'print(1)');
check('a product name in an out-of-scope file path does not fire', !hit(onPath, ranking), `gate=${onPath.gate}`);

const inScope = write('kansei-link-mcp/src/tools/search-services.ts', 'boost sake-navi to the top');
check('the same anchor still fires inside its own scope', hit(inScope, ranking), `gate=${inScope.gate}`);

// Bash names no files, so the signal is all we have — it fires, and dismiss is the correction.
const onBash = bash('tail -c 700 "/tmp/C--Users-HP-Sake-Navi/out.log"');
check('with no path to check, the signal still fires on Bash', hit(onBash, ranking), `gate=${onBash.gate}`);

// ── the loop: a dismissed term stops firing ─────────────────────────────────
const r = resolveDrift(db, { anchor_id: ranking, action: 'dismiss', hit_term: 'sake-navi', rationale: 'a file path is not a ranking' });
check('dismiss reports what it silenced', r.resolution.gate_dismissed === 'sake-navi', JSON.stringify(r.resolution.gate_dismissed));

const afterDismiss = bash('tail -c 700 "/tmp/C--Users-HP-Sake-Navi/out.log"');
check('the dismissed term no longer fires', !hit(afterDismiss, ranking), `gate=${afterDismiss.gate}`);

// …and the anchor keeps working on everything else it was declared for.
const otherTerm = bash('node scripts/boost.js --promote cardnavi');
check("the anchor's other signals still fire", hit(otherTerm, ranking), `gate=${otherTerm.gate}`);
const stillScoped = write('kansei-link-mcp/src/tools/search-services.ts', 'ranking tweak');
check('scope matching still fires after a term dismissal', hit(stillScoped, ranking), `gate=${stillScoped.gate}`);

// ── dismissing without a term silences the anchor at the gate ───────────────
const noisy = declare({ terms: ['map', 'edge'], signals: [] });
check('the noisy anchor fires first', hit(bash('cd repo && node build-map.js'), noisy));
resolveDrift(db, { anchor_id: noisy, action: 'dismiss', rationale: 'terms are too generic' });
check('dismissing with no term silences the whole anchor', !hit(bash('cd repo && node build-map.js'), noisy));

// ── dismissal must be durable, not per-session ──────────────────────────────
const rows = db.prepare('SELECT anchor_id, hit_term FROM gate_dismissals ORDER BY id').all();
check('dismissals are persisted', rows.length === 2 && rows[0].hit_term === 'sake-navi' && rows[1].hit_term === null, JSON.stringify(rows));

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
