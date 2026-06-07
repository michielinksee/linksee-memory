// T3 LOOP CLOSE — apply the founder's rulings on the 3 drift cards → the truth-map EVOLVES, and the decision is
// RECORDED (meta.t3_resolutions = the make-or-break "apply") so the next T3 run won't re-flag it as noise.
//   A4  → supersede / split-intent (retire A4, create two-layer A4')
//   A5  → keep at_risk + create validation task (don't delete; review in 30d)
//   A21 → fix drift / add conditional implementation constraint
// Additive + reversible (retire is reversible; new nodes retire-able; meta key clearable).
import { openDb, runMigrations } from '../dist/db/migrate.js';
import { declareAnchor, setNodeFields, listAnchors } from '../dist/lib/drift-anchors.js';

const db = openDb();
runMigrations(db);
const now = Math.floor(Date.now() / 1000);
const DAY = 86400;
const DOC = 'documents/kansei-link-knowledge-extracted-v1.md';

const active = listAnchors(db, { status: 'active' });
const find = (sub) => active.find((a) => a.statement.includes(sub));
const a4 = find('二層戦略');
const a5 = find('注力4領域');
const a21 = find('全MCP応答にapp/deep-link');
const res = {};

// ── A4: SUPERSEDE / SPLIT INTENT ──────────────────────────────────────────
if (a4) {
  db.prepare("UPDATE drift_anchors SET status='retired' WHERE id=?").run(a4.id);
  setNodeFields(db, a4.id, { lifecycle: 'superseded' });
  const a4p = declareAnchor(db, {
    kind: 'constraint',
    statement: '[方向/A4改] 完全ステルスではなく公開/非公開を二層に分ける。公開=思想・市場教育(AEO/MCP discovery/agent economy)・docs・README・public score concept・articles ／ 非公開=evaluation logic・scoring weights・proprietary framework・accumulated MCP intelligence・ranking/recommendation logic',
    rationale: `A4 superseded (split-intent) per founder ruling 2026-06-04: 完全ステルスだと市場教育できない→公開教育レイヤー＋非公開評価ロジックへ進化。supersedes A4 node ${a4.id}.`,
    affects: [], tier: 'human', source: 'curate',
  });
  setNodeFields(db, a4p.id, { node_type: 'strategy_direction', domain: 'strategy', decision_mode: 'constraint', confidence: 0.9, owner: 'founding-strategy-doc', last_confirmed_at: now });
  db.prepare('UPDATE drift_anchors SET evidence_refs=? WHERE id=?').run(JSON.stringify([{ source_type: 'strategy_doc', ref: `${DOC}#A4` }, { source_type: 'decision', ref: 'founder ruling 2026-06-04: split intent (public education / private logic)' }]), a4p.id);
  res.A4 = { action: 'supersede', superseded_node: a4.id, superseded_by: a4p.id, at: now };
}

// ── A5: KEEP at_risk + CREATE VALIDATION TASK ─────────────────────────────
if (a5) {
  setNodeFields(db, a5.id, {
    lifecycle: 'at_risk', review_after: now + 30 * DAY,
    card_policy: { validation_task: true, severity_if_unmet: 'medium', conditions: [
      '3〜5件のMCP/SaaS事例で Agent Insights を実際に出す',
      'その Insight が記事・スコア・推薦に使えるか確認',
      'ユーザーが「意思決定に使える」と感じるか確認',
    ] },
  });
  db.prepare("UPDATE drift_anchors SET rationale = rationale || ? WHERE id=?").run(' [T3 resolve 2026-06-04: keep at_risk, validation task created (review +30d). 削除でなく実証。]', a5.id);
  res.A5 = { action: 'acknowledge_validate', node: a5.id, review_after: now + 30 * DAY, at: now };
}

// ── A21: FIX DRIFT / ADD CONDITIONAL IMPLEMENTATION CONSTRAINT ─────────────
const a21c = declareAnchor(db, {
  kind: 'constraint',
  statement: '[制約/A21] tool・score・recommendation・diagnosis を返すMCP応答には、該当時に canonical な KanseiLINK app/deep-link を必ず含める。条件: 推薦を返す時 / スコアを返す時 / MCPプロファイル参照時 / 選択肢比較が必要な時 / KanseiLINK app に次アクションがある時。',
  rationale: 'A21 fix per founder ruling 2026-06-04: app-link=収益化・回遊・KanseiLINK発見の出口（ビジネスモデルの血管）。全応答スパムは避け条件付き。未実装なら是正対象（T2で実装検証）。',
  affects: ['kansei-link-mcp/src/tools'], tier: 'human', source: 'curate',
});
setNodeFields(db, a21c.id, { node_type: 'product_architecture', domain: 'monetization', decision_mode: 'constraint', confidence: 0.9, owner: 'founding-strategy-doc', last_confirmed_at: now });
db.prepare('UPDATE drift_anchors SET evidence_refs=? WHERE id=?').run(JSON.stringify([{ source_type: 'strategy_doc', ref: `${DOC}#A21` }, { source_type: 'decision', ref: 'founder ruling 2026-06-04: fix drift, add conditional constraint' }]), a21c.id);
if (a21) setNodeFields(db, a21.id, { lifecycle: 'resolved' });
res.A21 = { action: 'fix', direction_node: a21 ? a21.id : null, constraint_node: a21c.id, note: 'implementation may still be absent → now a T2 constraint to verify', at: now };

// ── record resolutions (the make-or-break "apply") + accept the 3 cards (kept as audit trail) ──
db.prepare("INSERT INTO meta (key,value) VALUES ('t3_resolutions',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(res));
for (const aid of ['A4', 'A5', 'A21']) {
  const card = db.prepare("SELECT id, proposed_node FROM memory_write_candidates WHERE proposed_node LIKE ? AND status='pending_review'").get(`%"direction":"${aid}"%`);
  if (card) {
    let pn = {}; try { pn = JSON.parse(card.proposed_node); } catch { /* keep */ }
    pn.resolution = res[aid] ? res[aid].action : 'resolved';
    db.prepare("UPDATE memory_write_candidates SET status='accepted', proposed_node=? WHERE id=?").run(JSON.stringify(pn), card.id);
  }
}

console.log(JSON.stringify({ resolved: res, active_nodes: listAnchors(db, { status: 'active' }).length }, null, 2));
db.close();
