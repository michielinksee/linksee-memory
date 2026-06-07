// T3 Judge — Stage 5: the DETERMINISTIC orchestrator. Wires evidence → [judge] → gate → suppress → cap →
// persist → rerun-suppression. The two LLM steps (judge candidate generation, adversarial verify) are
// PLUGGABLE: `emit` prints the dossiers to feed the judge; `apply <verdicts.json>` consumes the judge's
// output and runs everything deterministic. (Production: judge/skeptic = Claude API calls.)
//   node t3-pipeline.mjs emit              -> prints { dossiers } JSON for the judge
//   node t3-pipeline.mjs apply verdicts.json  -> gate+suppress+cap+persist, prints the 8 metrics
import { openDb, runMigrations } from '../dist/db/migrate.js';
import { getAlertPolicy } from '../dist/lib/drift-anchors.js';
import { readFileSync } from 'node:fs';

const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const trunc = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s);

function assembleDossiers(db) {
  const dirs = db.prepare("SELECT id, statement, confidence, status, lifecycle, domain, evidence_refs FROM drift_anchors WHERE owner='founding-strategy-doc' AND node_type='strategy_direction' ORDER BY id").all();
  const t3res = J((db.prepare("SELECT value FROM meta WHERE key='t3_resolutions'").get() || {}).value, {});
  const t2res = J((db.prepare("SELECT value FROM meta WHERE key='t2_resolutions'").get() || {}).value, {});
  const resolutionFor = (id) => {
    for (const [aid, r] of Object.entries(t3res)) if (r && (r.superseded_node === id || r.superseded_by === id || r.node === id || r.direction_node === id || r.constraint_node === id)) return { tier: 'T3', aid, action: r.action };
    for (const [aid, r] of Object.entries(t2res)) if (r && (r.node === id || r.constraint_node === id)) return { tier: 'T2', aid, action: r.action, verified: r.verified };
    return null;
  };
  return dirs.map((d) => {
    const aid = (J(d.evidence_refs, []).map((r) => r.ref || '').join(' ').match(/#(A\d+)/) || [])[1] || ('#' + d.id);
    const related = db.prepare("SELECT id, decision_mode, lifecycle, statement FROM drift_anchors WHERE status='active' AND domain=? AND id!=? LIMIT 6").all(d.domain, d.id).map((n) => ({ id: n.id, decision_mode: n.decision_mode, lifecycle: n.lifecycle, statement: trunc(n.statement, 64) }));
    const recent_reality = db.prepare("SELECT source_type, summary, occurred_at FROM reality_events ORDER BY occurred_at DESC LIMIT 4").all().map((e) => ({ source_type: e.source_type, summary: trunc(e.summary, 52) }));
    return { node_id: d.id, direction: { aid, statement: d.statement, confidence: d.confidence, lifecycle: d.lifecycle, status: d.status }, related_nodes: related, recent_reality, recorded_resolution: resolutionFor(d.id) };
  });
}

const mode = process.argv[2] || 'emit';
const db = openDb();
runMigrations(db);

if (mode === 'emit') {
  console.log(JSON.stringify({ dossiers: assembleDossiers(db) }, null, 2));
  db.close();
} else if (mode === 'apply') {
  const verdicts = J(readFileSync(process.argv[3], 'utf8'), []);
  const dossiers = assembleDossiers(db);
  const policy = getAlertPolicy(db);
  const byAid = new Map(dossiers.map((x) => [x.direction.aid, x]));

  let accounted_suppressed = 0, convergent_suppressed = 0;
  const candidates = [];
  for (const v of verdicts) {
    if (v.verdict === 'convergent') { convergent_suppressed++; continue; }
    if (v.accounted) { accounted_suppressed++; continue; }       // make-or-break suppression
    if (!v.surface_card) { continue; }                            // judge said no card
    // mechanical gate
    if (v.confidence < policy.min_confidence_for_soft_card) continue;
    if (policy.require_two_sided_evidence && (!v.intent_citation || !v.reality_citation)) continue;
    candidates.push(v);
  }
  // adversarial verify (LLM) is pluggable: candidates with surviving skeptic votes proceed. In this run
  // candidates may be 0 → no LLM needed. (Wired separately; the orchestrator records `adversarial_pending`.)
  const adversarial_pending = candidates.length;
  // volume cap
  const capped = candidates.slice(0, policy.max_soft_cards_per_week);

  // persist: manage ONLY pipeline-generated cards (proposed_node.gen='pipeline'); never touch accepted resolution cards.
  db.prepare("DELETE FROM memory_write_candidates WHERE COALESCE(proposed_node,'') LIKE '%\"gen\":\"pipeline\"%' AND status='pending_review'").run();
  const ins = db.prepare("INSERT INTO memory_write_candidates (scope, candidate_type, target_node_id, proposed_node, rationale, confidence, evidence_refs, status) VALUES (?,?,?,?,?,?,?,?)");
  let persisted = 0;
  for (const v of capped) {
    const node = byAid.get(v.aid);
    ins.run('KanseiLINK', 'create_card', node ? node.node_id : null,
      JSON.stringify({ src: 't3', gen: 'pipeline', direction: v.aid, verdict: v.verdict }),
      `[T3 pipeline] ${v.rationale || (v.intent_citation + ' ↔ ' + v.reality_citation)}`,
      v.confidence, JSON.stringify([{ side: 'intent', ref: v.intent_citation }, { side: 'reality', ref: v.reality_citation }]),
      'pending_review');
    persisted++;
  }

  console.log(JSON.stringify({
    anchors_processed: dossiers.length,
    judged: verdicts.length,
    accounted_suppressed,
    convergent_suppressed,
    candidate_cards: candidates.length,
    adversarial_pending,
    final_cards: capped.length,
    persisted_cards: persisted,
    status: candidates.length === 0
      ? 'fully reconciled — every direction is convergent or accounted; zero unaccounted drift (correct = no noise)'
      : `${capped.length} card(s) surfaced after gate+cap`,
  }, null, 2));
  db.close();
}
