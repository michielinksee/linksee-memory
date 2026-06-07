// P1c — reconcile: intent (Current Truth Map nodes) × reality (reality_events + session_file_edits)
// → memory_write_candidates. Hard facts → auto_accepted; Soft interpretations → pending_review.
// decision_mode is the router: commitment→heartbeat, hypothesis→review-date, source_of_truth→conflict.
// constraint nodes are handled by the file-scan detector, not here. Idempotent (clears prior auto cands).
import { openDb, runMigrations } from '../dist/db/migrate.js';
import { getCurrentTruth, getAlertPolicy } from '../dist/lib/drift-anchors.js';

const db = openDb();
runMigrations(db);
const now = Math.floor(Date.now() / 1000);
const DAY = 86400;
const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
const J = (s, d) => { try { const v = JSON.parse(s || ''); return v ?? d; } catch { return d; } };

const nodes = db.prepare(
  "SELECT id, node_type, domain, decision_mode, statement, affects, card_policy, review_after FROM drift_anchors WHERE status='active'"
).all();
const edits = db.prepare('SELECT file_path, occurred_at FROM session_file_edits').all().map((e) => ({ p: norm(e.file_path), t: e.occurred_at }));
const npmLast = (db.prepare("SELECT MAX(occurred_at) m FROM reality_events WHERE source_type='npm'").get() || {}).m || null;
const gitLast = (db.prepare("SELECT MAX(occurred_at) m FROM reality_events WHERE source_type='git_commit'").get() || {}).m || null;

// idempotent: drop prior MACHINE-generated candidates so repeated pulses don't accumulate.
// keep human-touched real candidates (accepted/rejected on a create_card/update_node), but
// machine-suppressed no_write (status='rejected') IS regenerable → clear it too, else auto-trigger leaks rows.
// NOTE: preserve T3 direction cards (proposed_node.src='t3') — they're owned by t3-pilot.mjs, not this pass.
db.prepare("DELETE FROM memory_write_candidates WHERE (status IN ('pending_review','auto_accepted') OR candidate_type='no_write') AND COALESCE(proposed_node,'') NOT LIKE '%\"src\":\"t3\"%'").run();
const ins = db.prepare(`INSERT INTO memory_write_candidates
  (scope, candidate_type, target_node_id, proposed_node, rationale, confidence, evidence_refs, status)
  VALUES (@scope,@candidate_type,@target_node_id,@proposed_node,@rationale,@confidence,@evidence_refs,@status)`);

function lastActivity(node, affects) {
  if (node.node_type === 'asset') return { ts: npmLast, src: 'npm' };
  if (affects.length) {
    let m = 0;
    for (const e of edits) if (affects.some((a) => e.p.includes(norm(a)))) m = Math.max(m, e.t);
    return { ts: m || null, src: 'file_edits' };
  }
  return { ts: gitLast, src: 'git_commit' };
}

const policy = getAlertPolicy(db);
let softUsed = 0;
let counts = { create_card: 0, update_node: 0, pending: 0, auto: 0, suppressed: 0 };
db.transaction(() => {
  for (const n of nodes) {
    const affects = J(n.affects, []);
    const cp = J(n.card_policy, {});
    const mode = n.decision_mode;
    if (mode === 'commitment' || cp.cadence_days) {
      const { ts, src } = lastActivity(n, affects);
      if (!ts) continue;
      const days = Math.floor((now - ts) / DAY);
      const cad = cp.cadence_days ?? 14;
      const thr = cp.stale_threshold_days ?? cad * 2;
      const ev = JSON.stringify([{ source_type: src, captured_at: now }]);
      if (days > thr) {
        ins.run({ scope: 'KanseiLINK', candidate_type: 'create_card', target_node_id: n.id, proposed_node: null,
          rationale: `commitment STALE: 最終活動${days}日前 vs cadence ${cad}日（停止か pivot か確認）`, confidence: 0.9, evidence_refs: ev, status: 'auto_accepted' });
        counts.create_card++; counts.auto++;
      } else {
        ins.run({ scope: 'KanseiLINK', candidate_type: 'update_node', target_node_id: n.id, proposed_node: JSON.stringify({ last_confirmed_at: now }),
          rationale: `fresh: 最終活動${days}日前（cadence ${cad}日内）→ last_confirmed更新`, confidence: 0.85, evidence_refs: ev, status: 'auto_accepted' });
        counts.update_node++; counts.auto++;
      }
    } else if (mode === 'hypothesis') {
      if (n.review_after && now > n.review_after) {
        ins.run({ scope: 'KanseiLINK', candidate_type: 'create_card', target_node_id: n.id, proposed_node: null,
          rationale: `hypothesis REVIEW DUE: 仮説の再確認期日が到来`, confidence: 0.8, evidence_refs: JSON.stringify([{ source_type: 'manual_declare', captured_at: now }]), status: 'auto_accepted' });
        counts.create_card++; counts.auto++;
      }
    } else if (mode === 'source_of_truth') {
      if (/vercel/i.test(n.statement) && /railway/i.test(n.statement)) {
        const conf = 0.5;
        const twoSided = false; // intent=node, reality=deploy event — NO deploy reality_event captured yet → one-sided
        const passes =
          conf >= policy.min_confidence_for_soft_card &&
          (!policy.require_two_sided_evidence || twoSided) &&
          softUsed < policy.max_soft_cards_per_week;
        if (passes) {
          ins.run({ scope: 'KanseiLINK', candidate_type: 'create_card', target_node_id: n.id, proposed_node: null,
            rationale: `SOURCE-OF-TRUTH conflict?: 正本の分裂リスク（Vercel/Railway）`, confidence: conf, evidence_refs: JSON.stringify([{ source_type: 'manual_declare', captured_at: now }]), status: 'pending_review' });
          counts.create_card++; counts.pending++; softUsed++;
        } else {
          // AlertPolicy suppresses an under-evidenced / low-confidence Soft card → candidate box, not a card.
          ins.run({ scope: 'KanseiLINK', candidate_type: 'no_write', target_node_id: n.id, proposed_node: null,
            rationale: `Soft SUPPRESSED by AlertPolicy（両側引用不足/低信頼）: Vercel/Railway conflict — deploy reality未取得で片側のみ・conf<${policy.min_confidence_for_soft_card}`, confidence: conf, evidence_refs: JSON.stringify([{ source_type: 'manual_declare', captured_at: now }]), status: 'rejected' });
          counts.suppressed++;
        }
      }
    }
  }
})();

const byStatus = db.prepare('SELECT status, count(*) c FROM memory_write_candidates GROUP BY status').all();
const byType = db.prepare('SELECT candidate_type, count(*) c FROM memory_write_candidates GROUP BY candidate_type').all();
const samples = db.prepare("SELECT candidate_type, status, target_node_id, substr(rationale,1,70) r FROM memory_write_candidates ORDER BY id DESC LIMIT 8").all();
console.log('=== RECONCILE → memory_write_candidates ===');
console.log(JSON.stringify({ nodes: nodes.length, generated: counts, by_status: byStatus, by_type: byType, samples }, null, 2));

// ⑧ read_smart demo — "current truth for monetization"
console.log('\n=== read_smart("current truth for monetization") ===');
console.log(JSON.stringify(getCurrentTruth(db, { domain: 'monetization' }).map((n) => ({ node_type: n.node_type, decision_mode: n.decision_mode, statement: n.statement })), null, 2));
db.close();
