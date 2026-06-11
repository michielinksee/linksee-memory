// Demo: A — one-call escalation closes the loop end-to-end. dream recommends escalate_to_hard;
// resolve_drift(action:'harden') flips the gate (setGateMode); the NEXT attempt is BLOCKED.
//
//   LINKSEE_MEMORY_DIR=/tmp/linksee-esc npx tsx scripts/demo-escalate.mts

import { openDb, runMigrations } from '../src/db/migrate.js';
import { gateAction, setGateMode } from '../src/lib/guard.js';

const db = openDb();
runMigrations(db);
db.prepare(`DELETE FROM drift_anchors`).run();
db.prepare(`DELETE FROM injection_log`).run();

const id = Number(
  db
    .prepare(
      `INSERT INTO drift_anchors (kind, statement, affects, detect_terms, violation_signal, tier, lifecycle, card_policy)
       VALUES ('prohibition', 'Never use cp for tracked files; use git mv', '[]', '[]', ?, 'human', 'active', ?)`
    )
    .run(JSON.stringify(['cp']), JSON.stringify({ enabled: true, gate_mode: 'soft' })).lastInsertRowid
);

const cp = { tool: 'Bash', command: 'cp a.ts b.ts' };

console.log(`1) declared soft anchor #${id} (gate_mode=soft)`);
console.log(`   gate "cp a.ts b.ts"  →  ${gateAction(db, cp, { sessionId: 's1' }).gate}   (expect: warn)`);

console.log(`\n2) dream said escalate_to_hard → resolve_drift(anchor_id:${id}, action:"harden")`);
const res = setGateMode(db, id, 'hard'); // exactly what handleResolveDrift('harden') calls
console.log(`   card_policy → ${JSON.stringify(res.card_policy)}`);

console.log(`\n3) gate "cp a.ts b.ts" again  →  ${gateAction(db, cp, { sessionId: 's2' }).gate}   (expect: block)`);
db.close();
