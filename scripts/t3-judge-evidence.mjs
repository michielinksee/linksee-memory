// T3 Judge — Stage 2: deterministic evidence assembly (NO LLM). For each declared strategy direction, pack the
// context the judge needs (per t3-judge-contract-v1.md INPUT). The judge never touches the DB; it only sees this.
import { openDb, runMigrations } from '../dist/db/migrate.js';

const db = openDb();
runMigrations(db);
const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const trunc = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s);

const dirs = db.prepare("SELECT id, statement, confidence, status, lifecycle, domain, evidence_refs FROM drift_anchors WHERE owner='founding-strategy-doc' AND node_type='strategy_direction' ORDER BY id").all();
const t3res = J((db.prepare("SELECT value FROM meta WHERE key='t3_resolutions'").get() || {}).value, {});
const t2res = J((db.prepare("SELECT value FROM meta WHERE key='t2_resolutions'").get() || {}).value, {});

function resolutionFor(id) {
  for (const [aid, r] of Object.entries(t3res)) {
    if (r && (r.superseded_node === id || r.superseded_by === id || r.node === id || r.direction_node === id || r.constraint_node === id)) {
      return { tier: 'T3', aid, action: r.action, at: r.at };
    }
  }
  for (const [aid, r] of Object.entries(t2res)) {
    if (r && (r.node === id || r.constraint_node === id)) return { tier: 'T2', aid, action: r.action, verified: r.verified };
  }
  return null;
}

const dossiers = dirs.map((d) => {
  const aid = (J(d.evidence_refs, []).map((r) => r.ref || '').join(' ').match(/#(A\d+)/) || [])[1] || ('#' + d.id);
  const related = db.prepare("SELECT id, decision_mode, lifecycle, statement FROM drift_anchors WHERE status='active' AND domain=? AND id!=? LIMIT 6")
    .all(d.domain, d.id).map((n) => ({ id: n.id, decision_mode: n.decision_mode, lifecycle: n.lifecycle, statement: trunc(n.statement, 70) }));
  const recent_reality = db.prepare("SELECT source_type, summary, occurred_at FROM reality_events ORDER BY occurred_at DESC LIMIT 5")
    .all().map((e) => ({ source_type: e.source_type, summary: trunc(e.summary, 56), occurred_at: e.occurred_at }));
  const recorded_resolution = resolutionFor(d.id);
  const card = db.prepare("SELECT proposed_node, status FROM memory_write_candidates WHERE target_node_id=? AND proposed_node LIKE '%\"src\":\"t3\"%'").get(d.id);
  const prior_verdict = card ? { verdict: J(card.proposed_node, {}).verdict, status: card.status } : null;
  return {
    direction: { aid, statement: d.statement, confidence: d.confidence, lifecycle: d.lifecycle, status: d.status },
    related_nodes: related, recent_reality, recorded_resolution, prior_verdict,
  };
});

// compact summary (validation) + one full sample so the dossier shape is visible
const summary = dossiers.map((x) => ({
  aid: x.direction.aid, lifecycle: x.direction.lifecycle, status: x.direction.status,
  related: x.related_nodes.length, resolution: x.recorded_resolution ? `${x.recorded_resolution.tier}:${x.recorded_resolution.action}` : null,
  prior: x.prior_verdict ? `${x.prior_verdict.verdict}/${x.prior_verdict.status}` : null,
}));
const sample = dossiers.find((x) => x.direction.aid === 'A4') || dossiers[0];
console.log(JSON.stringify({ assembled: dossiers.length, summary, sample_full_dossier: sample }, null, 2));
db.close();
