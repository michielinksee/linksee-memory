// T2 mechanical detector — rule A21_APP_DEEPLINK_REQUIRED.
// Auto-discovers registered MCP tools in KanseiLINK, applies a CURATED applicability classification
// (declare-don't-mine: which tools return recommendation/score/profile/diagnosis = A21-applicable),
// then MECHANICALLY checks each applicable tool's source for the kansei_link injection (presence, not
// correctness). Unclassified tools → needs_review (auto-surfaced; catches new tools / regressions).
// fully_verified ONLY when: all tools classified AND every applicable tool emits the link AND this sweep passes.
import { openDb, runMigrations } from '../dist/db/migrate.js';
import { execSync } from 'node:child_process';

// T2 verifies the COMMITTED reality (git HEAD), NOT the working tree — uncommitted edits are ephemeral and
// could be lost/reverted. This keeps the fully_verified claim DURABLE (it reflects what is actually shipped),
// and makes "overclaim from uncommitted work" structurally impossible. (= Drift OS core: reality = committed git.)
const KANSEI_REPO = 'C:\\Users\\HP\\KanseiLINK\\kansei-link-mcp';
const git = (args) => execSync(`git -C "${KANSEI_REPO}" ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

// CURATED classification (human-declared; reason recorded so "why no link here?" never recurs).
const APPLICABLE = {
  search_services: 'recommendation list',
  lookup: 'recommendation/profile/score (unified surface)',
  get_service_detail: 'service profile',
  get_insights: 'service score',
  get_recipe: 'workflow recommendation',
  find_combinations: 'combination recommendation / comparison',
  generate_aeo_report: 'per-service AEO score + recommendation',
  get_service_tips: 'per-service profile/guidance',
  analyze: 'cost recommendation / aeo score (per-service modes)',
  audit_cost: 'cost recommendation',
};
const NOT_APPLICABLE = {
  report: 'feedback write', submit_feedback: 'write', read_feedback: 'reads feedback, not a per-service rec',
  submit_inspection: 'admin write', get_inspection_queue: 'admin queue', propose_update: 'admin write',
  review_update: 'admin', list_pending_updates: 'admin',
  check_updates: 'per-service changelog/events (monitoring) — returns no recommendation/score/diagnosis/comparison/next-action, per the A21 condition',
  report_outcome: 'telemetry write', inspect: 'colony admin', generate_aeo_article: 'publishable article/ranking content (app-links belong in the article body, not the _meta exit)',
  analyze_token_savings: 'aggregate analytics (which services benefit from coverage) — not a per-service exit',
};
// Deliberately borderline (read it, genuinely ambiguous → human/LLM judge). The detector also auto-routes
// any NEWLY-discovered (unclassified) tool here, so new tools / regressions surface automatically.
const NEEDS_REVIEW = {}; // check_updates resolved → not_applicable (changelog/monitoring). Empty now; the detector
// still auto-routes any NEWLY-discovered (unclassified) tool to needs_review, so new tools/regressions surface.

const fileList = git('ls-tree HEAD --name-only src/tools/').split(/\r?\n/).filter((p) => p.endsWith('.ts'));
const tools = [];
for (const path of fileList) {
  const src = git(`show HEAD:${path}`); // committed content, not working tree
  const hasLink = /kanseiAppLink|kansei_link/.test(src);
  const re = /registerTool\(\s*["']([a-z_0-9]+)["']/g;
  let m;
  while ((m = re.exec(src))) tools.push({ name: m[1], file: path, hasLink });
}

const verified = [], absent = [], notApplicable = [], needsReview = [], unclassified = [];
for (const t of tools) {
  if (APPLICABLE[t.name]) (t.hasLink ? verified : absent).push(t.name);
  else if (NOT_APPLICABLE[t.name]) notApplicable.push(t.name);
  else if (NEEDS_REVIEW[t.name]) needsReview.push(t.name);
  else unclassified.push(t.name); // newly-discovered / never-classified — auto-surfaced (new tool or regression)
}
const applicableTotal = verified.length + absent.length;
// fully_verified ONLY when: all classified (no unclassified, no needs_review) AND every applicable emits the link.
const overall = (absent.length === 0 && needsReview.length === 0 && unclassified.length === 0) ? 'fully_verified'
  : absent.length ? 'partial_verified' : 'needs_review';

// ── write to the truth-map (meta.t2_resolutions + the T2 card) ──
const db = openDb(); runMigrations(db);
const now = Math.floor(Date.now() / 1000);
let res = {}; try { const r = db.prepare("SELECT value FROM meta WHERE key='t3_resolutions'").get(); if (r) res = JSON.parse(r.value); } catch { /* */ }
const nodeId = res?.A21?.constraint_node;

let t2res = {}; try { const r = db.prepare("SELECT value FROM meta WHERE key='t2_resolutions'").get(); if (r) t2res = JSON.parse(r.value); } catch { /* */ }
t2res.A21 = {
  rule: 'A21_APP_DEEPLINK_REQUIRED', action: 'fix_implemented',
  verified: overall === 'fully_verified' ? true : 'partial',
  overall, covered: verified, pending: absent, not_applicable: notApplicable, needs_review: needsReview,
  unclassified, applicable_total: applicableTotal, registered_total: tools.length, swept_at: now,
};
db.prepare("INSERT INTO meta (key,value) VALUES ('t2_resolutions',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(t2res));

if (nodeId) {
  const card = db.prepare("SELECT id, proposed_node FROM memory_write_candidates WHERE proposed_node LIKE '%\"src\":\"t2\"%' AND target_node_id=?").get(nodeId);
  const rationale = `[T2 sweep A21_APP_DEEPLINK_REQUIRED 2026-06-05] applicable ${applicableTotal} / verified ${verified.length} (${verified.join(', ')}) / absent ${absent.length} (${absent.join(', ')}) / not_applicable ${notApplicable.length} / needs_review ${needsReview.length}${needsReview.length ? ' (' + needsReview.join(', ') + ')' : ''}. overall=${overall}. fully_verified は applicable全件がlinkを出した時のみ（最終sweep時点・回帰で降格）。`;
  if (card) {
    let pn = {}; try { pn = JSON.parse(card.proposed_node); } catch { /* */ }
    pn.verdict = overall;
    db.prepare('UPDATE memory_write_candidates SET proposed_node=?, rationale=? WHERE id=?').run(JSON.stringify(pn), rationale, card.id);
  }
}
db.close();

console.log(JSON.stringify({ rule: 'A21_APP_DEEPLINK_REQUIRED', registered: tools.length, applicable: applicableTotal, verified, absent, not_applicable: notApplicable.length, needs_review: needsReview, unclassified, overall }, null, 2));
