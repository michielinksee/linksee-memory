// P1b — populate the Current Truth Map for KanseiLINK from skeleton-v1.
// (1) backfill the 13 existing anchors with node_type/domain/decision_mode (+ #14 validity_scope).
// (2) add 7 skeleton nodes not yet anchored (commitments/source-of-truth/strategy w/ cadence/review).
// Idempotent on the new nodes (skips by statement). Run after `npm run build` against the live DB.
import { openDb, runMigrations } from '../dist/db/migrate.js';
import { declareAnchor, setNodeFields, listAnchors } from '../dist/lib/drift-anchors.js';

const db = openDb();
runMigrations(db);
const now = Math.floor(Date.now() / 1000);
const DAY = 86400;

// (1) Backfill existing anchors by id (node_type / domain / decision_mode [+ extras]).
const BACKFILL = {
  1:  { node_type: 'product_architecture', domain: 'engineering', decision_mode: 'constraint' },
  2:  { node_type: 'product_architecture', domain: 'engineering', decision_mode: 'constraint' },
  3:  { node_type: 'product_architecture', domain: 'engineering', decision_mode: 'constraint' },
  4:  { node_type: 'product_architecture', domain: 'product',     decision_mode: 'constraint' },
  5:  { node_type: 'risk',                 domain: 'security',    decision_mode: 'constraint' },
  6:  { node_type: 'active_strategy',      domain: 'product',     decision_mode: 'constraint' },
  7:  { node_type: 'operational_commitment', domain: 'engineering', decision_mode: 'constraint' },
  8:  { node_type: 'product_architecture', domain: 'product',     decision_mode: 'constraint' },
  9:  { node_type: 'product_architecture', domain: 'engineering', decision_mode: 'constraint' },
  10: { node_type: 'source_of_truth',      domain: 'engineering', decision_mode: 'source_of_truth' },
  13: { node_type: 'active_strategy',      domain: 'strategy',    decision_mode: 'constraint' },
  14: { node_type: 'product_architecture', domain: 'engineering', decision_mode: 'constraint',
        validity_scope: { applies_to: ['services'], does_not_apply_to: ['service_stats','service_changelog','service_api_guides','infrastructure_tips','crawl_queue'] } },
  15: { node_type: 'risk',                 domain: 'security',    decision_mode: 'constraint' },
};
const active = listAnchors(db, { status: 'active' });
let backfilled = 0;
for (const a of active) {
  const f = BACKFILL[a.id];
  if (f) { setNodeFields(db, a.id, f); backfilled++; }
}

// (2) New skeleton nodes (kind='constraint' = permissive on violation_signal; not file-scan-fired).
const have = new Set(listAnchors(db, { status: 'active' }).map((a) => a.statement));
const NEW = [
  { statement: 'KanseiLINK = AIエージェント時代のSaaS/MCP発見・選定・可視性インフラ（Agent Engine Optimization）', rationale: 'North Star。頻繁に変えない。変えるならRevision Card。',
    affects: [], fields: { node_type: 'north_star', domain: 'strategy', decision_mode: 'source_of_truth', confidence: 0.95 } },
  { statement: '収益化はSaaS企業向けAEO Analytics / Agent Visibility Reportで課金（エージェント/ユーザーは無料）', rationale: 'Googleモデル。仮説なのでreview対象。',
    affects: [], fields: { node_type: 'business_model', domain: 'monetization', decision_mode: 'hypothesis', confidence: 0.7, review_after: now + 30*DAY,
      reality_manifestations: [{ expected_in: 'pricing_page', expected_signal: 'SaaS向け料金/レポートサンプル', check_method: 'url_scan' }] } },
  { statement: 'Recipe層（複数MCP連携パターン）がプロダクトの中核差別化', rationale: '電話帳→食べログ→Uberの食べログ層。service一覧だけ厚くなる骨格drift要警戒。',
    affects: ['kansei-link-mcp/src'], fields: { node_type: 'product_architecture', domain: 'product', decision_mode: 'commitment', confidence: 0.9 } },
  { statement: '導入導線として記事を継続配信する（週次想定）', rationale: '記事＝外部流入と信頼形成の導線。止まると静かに死ぬ。',
    affects: ['kansei-link-mcp/public/insights'], fields: { node_type: 'operational_commitment', domain: 'operations', decision_mode: 'commitment', confidence: 0.85,
      card_policy: { enabled: true, cadence_days: 7, stale_threshold_days: 14, severity_if_broken: 'medium' },
      reality_manifestations: [{ expected_in: 'article', expected_signal: 'new insights html', check_method: 'file_scan' }] } },
  { statement: 'npm @kansei-link/mcp-server を最新に保つ（外部信頼の証）', rationale: '放置すると開発者から死んだプロジェクトに見える。',
    affects: [], fields: { node_type: 'asset', domain: 'operations', decision_mode: 'commitment', confidence: 0.85,
      card_policy: { enabled: true, cadence_days: 30, stale_threshold_days: 60, severity_if_broken: 'low' },
      reality_manifestations: [{ expected_in: 'npm', expected_signal: 'recent publish', check_method: 'api_check' }] } },
  { statement: '本番はVercel、Railwayはbackground jobsのみ（正本の分裂を許さない）', rationale: 'Vercel/Railway split-brainは修正先/env/ログの分裂を生む。',
    affects: [], fields: { node_type: 'source_of_truth', domain: 'engineering', decision_mode: 'source_of_truth', confidence: 0.8,
      reality_manifestations: [{ expected_in: 'deploy', expected_signal: 'single production host', check_method: 'api_check' }] } },
  { statement: 'Agent Insights（集合知/Agent Logbook）が中核価値だが未実証（単一ローカル=N=1）', rationale: 'マルチエージェントで初めて意味。最大の未解決リスク。',
    affects: [], fields: { node_type: 'experiment', domain: 'product', decision_mode: 'hypothesis', confidence: 0.6, lifecycle: 'experiment', review_after: now + 30*DAY } },
];
let added = 0;
for (const n of NEW) {
  if (have.has(n.statement)) continue;
  const a = declareAnchor(db, { kind: 'constraint', statement: n.statement, rationale: n.rationale, affects: n.affects, tier: 'human', source: 'curate' });
  setNodeFields(db, a.id, { ...n.fields, last_confirmed_at: now });
  added++;
}

// Report the populated map
const all = listAnchors(db, { status: 'active' });
const rows = all.map((a) => db.prepare('SELECT node_type, domain, decision_mode FROM drift_anchors WHERE id=?').get(a.id));
const byMode = {}; const byDomain = {};
for (const r of rows) { byMode[r.decision_mode ?? 'null'] = (byMode[r.decision_mode ?? 'null'] || 0) + 1; byDomain[r.domain ?? 'null'] = (byDomain[r.domain ?? 'null'] || 0) + 1; }
console.log(JSON.stringify({ backfilled, added, active_nodes: all.length, by_decision_mode: byMode, by_domain: byDomain }, null, 2));
db.close();
