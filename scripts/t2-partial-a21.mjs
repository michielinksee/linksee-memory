// Honesty fix: A21 is PARTIALLY verified (lookup/detail/insights implemented; search_services pending due to
// reliability-provenance WIP overlap). Don't overclaim "fully verified" in the internal truth-map.
import { openDb, runMigrations } from '../dist/db/migrate.js';

const db = openDb();
runMigrations(db);
const now = Math.floor(Date.now() / 1000);
let res = {};
try { const r = db.prepare("SELECT value FROM meta WHERE key='t3_resolutions'").get(); if (r) res = JSON.parse(r.value); } catch { /* */ }
const nodeId = res?.A21?.constraint_node;

let t2res = {};
try { const r = db.prepare("SELECT value FROM meta WHERE key='t2_resolutions'").get(); if (r) t2res = JSON.parse(r.value); } catch { /* */ }
t2res.A21 = { action: 'fix_implemented', node: nodeId, verified: 'partial', covered: ['lookup', 'get_service_detail', 'get_insights'], pending: ['search_services'], at: now };
db.prepare("INSERT INTO meta (key,value) VALUES ('t2_resolutions',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(t2res));

const card = db.prepare("SELECT id, proposed_node FROM memory_write_candidates WHERE proposed_node LIKE '%\"src\":\"t2\"%' AND target_node_id=?").get(nodeId);
if (card) {
  let pn = {}; try { pn = JSON.parse(card.proposed_node); } catch { /* */ }
  pn.verdict = 'partial_verified';
  const r2 = '[T2/再検証 2026-06-05] A21 = partially implemented & verified。lookup(統一窓口) / get_service_detail / get_insights に kansei_link 注入、config駆動 app-link.ts、tsc green、コミット a4c3de7（PR #14）。**search_services は founder の reliability-provenance WIP と同一importハンクで混在のため保留**。→ 公開サーフェスは概ねcovered、search_services 対応で fully へ昇格予定。';
  db.prepare('UPDATE memory_write_candidates SET proposed_node=?, rationale=? WHERE id=?').run(JSON.stringify(pn), r2, card.id);
}

const node = db.prepare('SELECT evidence_refs FROM drift_anchors WHERE id=?').get(nodeId);
let ev = []; try { ev = JSON.parse(node.evidence_refs) || []; } catch { /* */ }
ev.push({ source_type: 't2', ref: '2026-06-05 PARTIAL — lookup/detail/insights implemented (PR #14 a4c3de7); search_services pending (WIP overlap)' });
db.prepare('UPDATE drift_anchors SET evidence_refs=? WHERE id=?').run(JSON.stringify(ev), nodeId);

console.log(JSON.stringify({ a21_t2: 'partial_verified', covered: 3, pending: ['search_services'] }, null, 2));
db.close();
