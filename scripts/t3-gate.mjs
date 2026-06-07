// T3 Judge — Stage 4: the GATE (don't trust a single judgment).
// Layer 1 (this script, DETERMINISTIC + cheap): drop verdicts that fail confidence / two-sided-citation /
//   make-or-break(accounted) / volume-cap, per AlertPolicy. Survivors go to Layer 2 (adversarial skeptic, LLM).
import { openDb, runMigrations } from '../dist/db/migrate.js';
import { getAlertPolicy } from '../dist/lib/drift-anchors.js';

const db = openDb();
runMigrations(db);
const policy = getAlertPolicy(db);
db.close();

// VALIDATION INPUTS: 1 real drift, 1 judge-error(actually accounted), 1 low-confidence, 1 one-sided.
// Each carries the evidence the skeptic (Layer 2) will independently re-check.
const VERDICTS = [
  { aid: 'SYNTH-FREE', verdict: 'divergent', confidence: 0.93, accounted: false, surface_card: true,
    intent_citation: 'KanseiLINKのコア機能はすべて無料・いかなる課金もしない',
    reality_citation: "git 'feat: Stripe billing + Pro/Team price IDs'; node 収益化=AEO Analytics課金",
    recorded_resolution: null },
  { aid: 'A4改-ERR', verdict: 'divergent', confidence: 0.70, accounted: false, surface_card: true,
    intent_citation: 'A4改 公開/非公開 二層（公開=docs/README/articles）',
    reality_citation: 'VitePress / README / AEO記事 公開',
    recorded_resolution: { tier: 'T3', action: 'supersede', note: 'old fully-stealth A4 superseded by this two-layer direction' } },
  { aid: 'LOW-CONF', verdict: 'divergent', confidence: 0.40, accounted: false, surface_card: true,
    intent_citation: 'x', reality_citation: 'y', recorded_resolution: null },
  { aid: 'ONE-SIDED', verdict: 'absent', confidence: 0.80, accounted: false, surface_card: true,
    intent_citation: 'declared X', reality_citation: '', recorded_resolution: null },
];

const toVerify = [];
const droppedMechanical = [];
for (const v of VERDICTS) {
  if (!v.surface_card) continue; // judge already said no card
  const reasons = [];
  if (v.confidence < policy.min_confidence_for_soft_card) reasons.push(`low_confidence(${v.confidence}<${policy.min_confidence_for_soft_card})`);
  if (policy.require_two_sided_evidence && (!v.intent_citation || !v.reality_citation)) reasons.push('one_sided');
  if (v.accounted) reasons.push('accounted(make-or-break)');
  if (reasons.length) droppedMechanical.push({ aid: v.aid, reasons });
  else toVerify.push(v);
}

console.log(JSON.stringify({
  policy: { min_conf: policy.min_confidence_for_soft_card, two_sided: policy.require_two_sided_evidence, max_per_week: policy.max_soft_cards_per_week },
  to_adversarial_verify: toVerify.map((v) => ({ aid: v.aid, confidence: v.confidence, recorded_resolution: v.recorded_resolution })),
  dropped_mechanical: droppedMechanical,
}, null, 2));
