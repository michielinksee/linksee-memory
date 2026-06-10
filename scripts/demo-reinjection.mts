// Demo: anthropics/claude-code#15443 — "Claude read the rule, understood it, still used cp."
// The re-injection gate catches it BEFORE the tool runs. Run against a throwaway DB:
//
//   LINKSEE_MEMORY_DIR=/tmp/linksee-demo npx tsx scripts/demo-reinjection.mts        (bash)
//   $env:LINKSEE_MEMORY_DIR="$env:TEMP\linksee-demo"; npx tsx scripts/demo-reinjection.mts   (pwsh)
//
// Expected: `cp ...` → block · `git mv ...` → allow · `scp ...` → allow (precision guard: no FP on "cp" in "scp").

import { openDb, runMigrations } from '../src/db/migrate.js';
import { gateAction } from '../src/lib/guard.js';

const db = openDb();
runMigrations(db);

const STATEMENT = 'Always use `git mv`, never plain `cp`, when moving tracked files';
db.prepare(`DELETE FROM drift_anchors WHERE statement = ?`).run(STATEMENT);

const info = db
  .prepare(
    `INSERT INTO drift_anchors (kind, statement, rationale, affects, detect_terms, violation_signal, tier, lifecycle, card_policy)
     VALUES ('prohibition', ?, ?, '[]', '[]', ?, 'human', 'active', ?)`
  )
  .run(
    STATEMENT,
    'history must survive the move — cp orphans git blame',
    JSON.stringify(['cp']),
    JSON.stringify({ enabled: true, gate_mode: 'hard', reinject_cooldown_min: 30 })
  );

console.log(`declared accepted anchor #${info.lastInsertRowid}  (gate_mode: hard)\n${'─'.repeat(72)}`);

for (const command of ['cp src/a.ts src/b.ts', 'git mv src/a.ts src/b.ts', 'scp host:/x .']) {
  const r = gateAction(db, { tool: 'Bash', command }, { sessionId: 'demo-session' });
  console.log(`\n$ ${command}`);
  console.log(`  gate = ${r.gate.toUpperCase()}`);
  if (r.reinject) console.log(r.reinject.split('\n').map((l) => '  │ ' + l).join('\n'));
}

console.log(`\n${'─'.repeat(72)}\ninjection_log rows: ${(db.prepare('SELECT COUNT(*) AS n FROM injection_log').get() as { n: number }).n}`);
db.close();
