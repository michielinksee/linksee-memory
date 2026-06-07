// T2 verification of the A21 deep-link constraint (node = res.A21.constraint_node).
// JUDGE=Claude: read src/tools response builders → no canonical KanseiLINK app/deep-link emitted.
// Records a T2 card (proposed_node.src='t2') + annotates the constraint node's evidence. Idempotent.
import { openDb, runMigrations } from '../dist/db/migrate.js';

const db = openDb();
runMigrations(db);
const now = Math.floor(Date.now() / 1000);
let res = {};
try { const r = db.prepare("SELECT value FROM meta WHERE key='t3_resolutions'").get(); if (r) res = JSON.parse(r.value); } catch { /* none */ }
const nodeId = res?.A21?.constraint_node;
if (!nodeId) { console.log('A21 constraint node not found'); db.close(); process.exit(0); }

const rationale = '[T2/実装検証] A21制約「tool/score/recommendation/diagnosis応答に canonical KanseiLINK app/deep-link 必須」を src/tools の応答ビルダーで照合: search_services(推薦)・get-service-detail(profile)・get-insights(score) いずれも app/deep-link を埋め込まず。出力linkは per-service mcp_endpoint/api_url(service-side) ＋ _meta.registry(MCP registry URL) ＋ _meta.tip(npm install) のみ。kansei-link.com は src/tools 内 0ヒット。→ 制約は宣言済みだが実装は不在。判断要: 出口deep-linkを実装する / もしくは制約を緩める。';
const refs = [
  { source_type: 'code', ref: 'src/tools/search-services.ts:125-143 (_meta.registry/tip — no app deep-link)' },
  { source_type: 'code', ref: 'src/tools/get-service-detail.ts:113-115 (同_meta, no app deep-link)' },
  { source_type: 'code', ref: 'src/tools/get-insights.ts:63-65 (同_meta, no app deep-link)' },
  { source_type: 'grep', ref: 'kansei-link.com: 0 hits across src/tools' },
];

// idempotent: clear prior T2 card for this node
db.prepare("DELETE FROM memory_write_candidates WHERE COALESCE(proposed_node,'') LIKE '%\"src\":\"t2\"%' AND target_node_id=?").run(nodeId);
db.prepare(`INSERT INTO memory_write_candidates (scope, candidate_type, target_node_id, proposed_node, rationale, confidence, evidence_refs, status)
  VALUES (?,?,?,?,?,?,?,?)`).run('KanseiLINK', 'create_card', nodeId, JSON.stringify({ src: 't2', constraint: 'A21', verdict: 'absent_implementation' }), rationale, 0.85, JSON.stringify(refs), 'pending_review');

// annotate the constraint node so the Resolution Panel reflects the T2 result
const node = db.prepare('SELECT evidence_refs FROM drift_anchors WHERE id=?').get(nodeId);
let ev = []; try { ev = JSON.parse(node.evidence_refs) || []; } catch { /* */ }
ev.push({ source_type: 't2', ref: `2026-06-04 implementation ABSENT in src/tools (search_services/get-service-detail/get-insights); kansei-link.com 0 hits` });
db.prepare('UPDATE drift_anchors SET evidence_refs=? WHERE id=?').run(JSON.stringify(ev), nodeId);

console.log(JSON.stringify({ t2_card: 'pending_review', target_node: nodeId, verdict: 'absent_implementation', cited: refs.length }, null, 2));
db.close();
