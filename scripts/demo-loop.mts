// Demo: the loop closes. The re-injection layer (pre-action, injection_log) feeds `dream` via
// getReinjectionFriction, rejoining the post-action reality (drift_edges). When an anchor is re-surfaced
// at the gate AND still contradicted in the code, it recommends escalation — the machine evidence for #15443.
//
//   LINKSEE_MEMORY_DIR=/tmp/linksee-loop npx tsx scripts/demo-loop.mts

import { openDb, runMigrations } from '../src/db/migrate.js';
import { gateAction, getReinjectionFriction } from '../src/lib/guard.js';

const db = openDb();
runMigrations(db);
db.prepare(`DELETE FROM drift_anchors`).run();
db.prepare(`DELETE FROM injection_log`).run();
db.prepare(`DELETE FROM drift_edges`).run();

function declareSoft(statement: string, signal: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO drift_anchors (kind, statement, affects, detect_terms, violation_signal, tier, lifecycle, card_policy)
         VALUES ('prohibition', ?, '[]', '[]', ?, 'human', 'active', ?)`
      )
      .run(statement, JSON.stringify([signal]), JSON.stringify({ enabled: true, gate_mode: 'soft' })).lastInsertRowid
  );
}

const aReal = declareSoft('Never use `cp` for tracked files — use `git mv`', 'cp'); // will be violated in reality
const aHold = declareSoft('Never use `eval` in source', 'eval'); // gate keeps catching, reality stays clean

// Re-surface each at the gate 4× (soft → warn). Distinct sessions so the cooldown never suppresses.
for (let i = 0; i < 4; i++) {
  gateAction(db, { tool: 'Bash', command: 'cp a.ts b.ts' }, { sessionId: `s${i}` });
  gateAction(db, { tool: 'Bash', command: 'eval(userInput)' }, { sessionId: `s${i}` });
}

// The post-hoc detector confirms the cp rule is ACTUALLY broken in the code (an open reality contradiction).
db.prepare(
  `INSERT INTO drift_edges (anchor_id, edit_id, verdict, confidence, evidence, status)
   VALUES (?, NULL, 'contradicts', 0.8, '{"reason":"demo: cp landed in real code"}', 'open')`
).run(aReal);

console.log(`aReal=#${aReal} (re-injected + reality broken)   aHold=#${aHold} (re-injected, reality clean)`);
console.log('─'.repeat(78));
for (const f of getReinjectionFriction(db, { minContradicts: 3 })) {
  console.log(`\n#${f.anchor_id} "${f.statement}"`);
  console.log(
    `  signal=${f.signal}  →  suggested_action=${f.suggested_action}`
  );
  console.log(
    `  gate×${f.gate_contradicts}  reality×${f.reality_contradicts}  ignored×${f.ignored}  mode=${f.gate_mode}`
  );
  console.log(`  ${f.recommendation}`);
}
db.close();
