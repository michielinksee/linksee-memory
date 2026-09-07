#!/usr/bin/env node
// Regression: the truth view must read drift_edges.
//
// Guards the 2026-09-05 defect: getTruthView derived state from resolutions, pending
// candidates and lifecycle only — never from drift_edges. The detector had written 11 open
// `contradicts` edges across 4 anchors (one of them the PII constraint) and every one of
// them was rendered 🔵 "Committed reality matches intent (convergent)".
//
// Run: node test/edges-state.mjs   (throwaway DB, never touches ~/.linksee-memory)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'linksee-edges-'));
process.env.LINKSEE_MEMORY_DIR = dir;

const { openDb, runMigrations } = await import('../dist/db/migrate.js');
const { getTruthView, resolveDrift } = await import('../dist/lib/truth-engine.js');

const db = openDb();
runMigrations(db);

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); failures++; }
};

const declare = (statement) =>
  Number(db.prepare(
    `INSERT INTO drift_anchors (kind, statement, rationale, affects, detect_terms, violation_signal,
                                status, lifecycle, confidence, card_policy, created_at, updated_at)
     VALUES ('constraint', ?, 'test', '[]', '[]', '[]', 'active', 'active', 0.8, '{}', unixepoch(), unixepoch())`
  ).run(statement).lastInsertRowid);

const edge = (anchor, verdict, file) =>
  db.prepare(
    `INSERT INTO drift_edges (anchor_id, verdict, confidence, evidence, status, detected_at)
     VALUES (?, ?, 0.8, ?, 'open', unixepoch())`
  ).run(anchor, verdict, JSON.stringify({ file_path: file, hit_term: 'email' }));

const node = (id) => {
  const v = getTruthView(db, {});
  return [...v.attention, ...v.alignedByDomain.flatMap((g) => g.nodes), ...v.unverifiedByDomain.flatMap((g) => g.nodes)].find((n) => n.id === id);
};

console.log('edges-state regression');

const contradicted = declare('PIIを保存しない');
edge(contradicted, 'contradicts', 'C:/repo/src/db/schema.ts');
let n = node(contradicted);
check('open contradicts edge → 🔴 drift', n.state === 'drift', `state=${n.state}`);
check('reality names the evidence, not "convergent"',
  /open contradiction/.test(n.reality) && /schema\.ts/.test(n.reality), n.reality);

const missing = declare('全MCP応答にdeep-linkを含める');
edge(missing, 'absent', null);
n = node(missing);
check('open absent edge → 🟡 review (asks, does not alarm)', n.state === 'review', `state=${n.state}`);

const unchecked = declare('本番はVercel');
n = node(unchecked);
check('no edges, no resolution → ⚫ unverified (not aligned)', n.state === 'unverified', `state=${n.state}`);
check('…and reality says nothing was verified', /No signal observed/.test(n.reality), n.reality);

const observed = declare('CIはGitHub Actions');
edge(observed, 'implements', 'C:/repo/.github/workflows/ci.yml');
n = node(observed);
check('an implements edge → 🔵 aligned (verified)', n.state === 'aligned', `state=${n.state}`);
check('…and reality names where it was observed', /Observed in reality/.test(n.reality) && /ci\.yml/.test(n.reality), n.reality);

// check_decision must agree with drift_status — it had its own copy of the state machine.
{
  const { getDecisionDetail } = await import('../dist/lib/truth-engine.js');
  const d1 = getDecisionDetail(db, contradicted);
  const d2 = getDecisionDetail(db, unchecked);
  const d3 = getDecisionDetail(db, observed);
  check('check_decision mirrors 🔴 on an open contradiction', d1.state === 'drift', `state=${d1.state}`);
  check('check_decision mirrors ⚫ unverified', d2.state === 'unverified', `state=${d2.state}`);
  check('check_decision mirrors 🔵 on implements', d3.state === 'aligned', `state=${d3.state}`);
}

resolveDrift(db, { anchor_id: contradicted, action: 'dismiss', rationale: 'column named email is not user PII' });
n = node(contradicted);
check('dismiss closes the edges → aligned', n.state === 'aligned', `state=${n.state}`);
check('…and says a human answered it', /dismiss/.test(n.accountedBy ?? ''), n.accountedBy);

const contradicted2 = declare('seedはUPSERT');
edge(contradicted2, 'contradicts', 'C:/repo/src/seed.ts');
resolveDrift(db, { anchor_id: contradicted2, action: 'fix', rationale: 'switched to upsert' });
n = node(contradicted2);
check('fix closes the edges → aligned', n.state === 'aligned', `state=${n.state}`);

const oldNs = declare('North Star v1');
const newNs = declare('North Star v2');
resolveDrift(db, { anchor_id: oldNs, action: 'supersede', superseded_by: newNs, rationale: 'v2' });
edge(newNs, 'contradicts', 'C:/repo/README.md');
n = node(newNs);
check('the superseding anchor can still drift', n.state === 'drift', `state=${n.state} by=${n.accountedBy}`);
n = node(oldNs);
check('the superseded anchor stays accounted', n.state === 'aligned' && /supersede/.test(n.accountedBy ?? ''), `state=${n.state} by=${n.accountedBy}`);

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
