// T3-α — DIRECTION DRIFT: founding-strategy directions (curated from kansei-link-knowledge-extracted-v1.md)
// × current truth-map + reality → Reflexion verdict (convergent / divergent / absent / at_risk), make-or-break gated.
//
// JUDGE = Claude (this session), conservative + cited BOTH sides. Productization = a structured per-direction
// LLM/subagent judge. convergent → NO card (precision>volume). Only unaccounted drift surfaces, AlertPolicy-gated.
// Additive + reversible: 7 direction nodes tagged owner='founding-strategy-doc'; T3 cards marked proposed_node.src='t3'
// (reconcile-once preserves them; this script clears+reinserts only its own src:t3 cards = idempotent).
import { openDb, runMigrations } from '../dist/db/migrate.js';
import { declareAnchor, setNodeFields, listAnchors, getAlertPolicy } from '../dist/lib/drift-anchors.js';

const db = openDb();
runMigrations(db);
const now = Math.floor(Date.now() / 1000);
const DOC = 'documents/kansei-link-knowledge-extracted-v1.md';

// (1) The 7 human-curated founding directions (declare-don't-mine).
const DIRECTIONS = [
  { aid: 'A1',  conf: 0.92, statement: '[方向] コア価値＝エージェントのcontext/token節約→ユーザーのAPIコスト削減（negawatt/ESCOモデル）' },
  { aid: 'A3',  conf: 0.90, statement: '[方向] 課金構造＝3フェーズfunnel（P1 MCP翻訳+登録 / P2 token節約可視化+AEO analytics / P3 client embedding+referral）' },
  { aid: 'A4',  conf: 0.90, statement: '[方向] 二層戦略：水面下=ステルスのagent-facing MCP / 水面上=human-facing AEOダッシュ。戦略フレームワークは公開しない' },
  { aid: 'A5',  conf: 0.92, statement: '[方向] 注力4領域＝Recipe層 / agent-native API設計 / 日本市場特化 / Agent Insights（体験共有）' },
  { aid: 'A9',  conf: 0.95, statement: '[方向] 進化パス＝電話帳(検索)→食べログ+交通情報(tips/insights)→Uber(知的ルーティング)' },
  { aid: 'A10', conf: 0.92, statement: '[方向] ビジネス＝KanseiLINK自体をAEO格付け機関に（無料AEOスコア公開→AEO最適化コンサル需要）' },
  { aid: 'A21', conf: 0.95, statement: '[方向] 3層＝MCP(無料獲得)/App(出口)/KanseiLINK(発見+品質)。全MCP応答にapp/deep-linkを必須で埋め込む' },
];

// recorded resolutions (make-or-break "apply") — accounted drifts are suppressed on re-run.
let RES = {};
try { const rr = db.prepare("SELECT value FROM meta WHERE key='t3_resolutions'").get(); if (rr) RES = JSON.parse(rr.value); } catch { /* none */ }
const active0 = listAnchors(db, { status: 'active' });
const byStmt = new Map(active0.map((a) => [a.statement, a.id]));
const idByAid = {};
let added = 0;
for (const d of DIRECTIONS) {
  if (RES[d.aid] && RES[d.aid].action === 'supersede') { idByAid[d.aid] = 'superseded'; continue; }
  let id = byStmt.get(d.statement);
  if (!id) {
    const a = declareAnchor(db, { kind: 'constraint', statement: d.statement, rationale: `founding-strategy direction ${d.aid} (T3 pilot intent). Source: ${DOC}`, affects: [], tier: 'human', source: 'curate' });
    setNodeFields(db, a.id, { node_type: 'strategy_direction', domain: 'strategy', decision_mode: 'hypothesis', confidence: d.conf, owner: 'founding-strategy-doc', last_confirmed_at: now });
    db.prepare('UPDATE drift_anchors SET evidence_refs=? WHERE id=?').run(JSON.stringify([{ source_type: 'strategy_doc', ref: `${DOC}#${d.aid}`, captured_at: now }]), a.id);
    id = a.id; added++;
  }
  idByAid[d.aid] = id;
}

// (2) T3 verdicts — JUDGE=Claude, conservative, cited both-sides. convergent => no card.
const VERDICTS = [
  { aid: 'A1',  verdict: 'convergent', note: 'token節約価値は製品ポジショニング/MCP説明に反映。ドリフトなし。' },
  { aid: 'A3',  verdict: 'convergent', note: 'P1(MCP Registry登録 v1.0.0)完了→P2(AEO analytics=収益化hypothesis node)進行中。フェーズ順に沿う。' },
  { aid: 'A9',  verdict: 'convergent', note: '現在地=検索+初期tips(食べログ層)。パス上、ドリフトなし。' },
  { aid: 'A10', verdict: 'convergent', note: 'AEOスコア/格付けはNorth Star・収益化と整合。ドリフトなし。' },
  { aid: 'A4',  verdict: 'divergent', conf: 0.62,
    rationale: '[T3/方向ドリフト] A4「戦略FWは非公開・水面下で蓄積」↔ 現実: 直近gitで VitePress docs化 / README全面公開(v1.0.0) / Mintlify docs site / AEO記事(articles/*.md)多数公開。さらに founding内 A20「毎日記事公開」と方向対立。A4は明示的にretireされていない＝未調整の方向対立。判断要: A4をA20で正式supersede(公開戦略へ進化)と記録 / もしくは公開範囲を絞る。',
    refs: [{ source_type: 'strategy_doc', ref: `${DOC}#A4` }, { source_type: 'strategy_doc', ref: `${DOC}#A20` }, { source_type: 'git', ref: 'docs: VitePress / README v1.0.0 / Mintlify docs site; articles/*.md' }] },
  { aid: 'A5',  verdict: 'at_risk', conf: 0.60,
    rationale: '[T3/方向ドリフト] A5の注力4領域の1つ Agent Insights が、現truth-mapでは experiment・未実証(N=1, conf60%)のまま。中核と宣言した方向に実証進捗の痕跡が薄い＝停滞/放置の疑い。判断要: 実証を進める / 4領域から外す(縮小をsupersedeで記録)。',
    refs: [{ source_type: 'strategy_doc', ref: `${DOC}#A5` }, { source_type: 'truth_node', ref: 'Agent Insights node (experiment, 未実証, conf60%)' }] },
  { aid: 'A21', verdict: 'absent', conf: 0.60,
    rationale: '[T3/方向ドリフト] A21「全MCP応答にapp/deep-linkを必須で埋め込む(出口)」に対し、現truth-mapに該当ノードが無く直近realityにも痕跡なし＝absent。出口=収益化の要だが未追跡。判断要: 実装済みなら制約ノードとして宣言 / 未実装なら方向の放置として是正。',
    refs: [{ source_type: 'strategy_doc', ref: `${DOC}#A21` }, { source_type: 'absence', ref: 'no enforcing node + no recent git evidence' }] },
];

// (3) idempotent: clear prior T3 cards, then insert with AlertPolicy gate.
db.prepare("DELETE FROM memory_write_candidates WHERE COALESCE(proposed_node,'') LIKE '%\"src\":\"t3\"%' AND status != 'accepted'").run();
const policy = getAlertPolicy(db);
const ins = db.prepare(`INSERT INTO memory_write_candidates (scope, candidate_type, target_node_id, proposed_node, rationale, confidence, evidence_refs, status) VALUES (?,?,?,?,?,?,?,?)`);
let soft = 0, pending = 0, suppressed = 0, convergent = 0, resolved = 0;
const out = [];
for (const v of VERDICTS) {
  if (v.verdict === 'convergent') { convergent++; out.push({ aid: v.aid, verdict: 'convergent', card: false }); continue; }
  const r = RES[v.aid];
  if (r && (r.action === 'supersede' || r.action === 'fix' || (r.action === 'acknowledge_validate' && r.review_after && now < r.review_after))) {
    // acknowledged != resolved: A5 is time-boxed (reopens after review_after if still unvalidated), NOT closed.
    const state = r.action === 'acknowledge_validate' ? 'acknowledged' : 'resolved';
    resolved++; out.push({ aid: v.aid, verdict: v.verdict, card: state, via: r.action, reopen_after: r.review_after ?? null }); continue;
  }
  const twoSided = true; // each cites strategy_doc + current-state (node/git/absence)
  const passes = v.conf >= policy.min_confidence_for_soft_card && (!policy.require_two_sided_evidence || twoSided) && soft < policy.max_soft_cards_per_week;
  const proposed = JSON.stringify({ src: 't3', direction: v.aid, verdict: v.verdict });
  ins.run('KanseiLINK', passes ? 'create_card' : 'no_write', idByAid[v.aid], proposed, v.rationale, v.conf, JSON.stringify(v.refs), passes ? 'pending_review' : 'rejected');
  if (passes) { soft++; pending++; } else { suppressed++; }
  out.push({ aid: v.aid, verdict: v.verdict, conf: v.conf, card: passes ? 'pending' : 'suppressed' });
}

const totalNodes = listAnchors(db, { status: 'active' }).length;
console.log(JSON.stringify({
  directions_added: added, directions_total: DIRECTIONS.length, active_nodes_total: totalNodes,
  judge: 'Claude (pilot stand-in)', convergent, resolved, pending_cards: pending, suppressed,
  policy: { min_conf: policy.min_confidence_for_soft_card, max_soft_per_week: policy.max_soft_cards_per_week, two_sided_required: policy.require_two_sided_evidence },
  cards: out,
}, null, 2));
db.close();
