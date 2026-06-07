// T2 LOOP CLOSE for A21 — implementation landed + re-verified → flip the T2 card to accepted (implemented),
// annotate the constraint node as verified, record meta.t2_resolutions. This closes:
//   T3 absent → human fix (constraint) → T2 absent → code fixed → T2 verified convergent → map updated.
import { openDb, runMigrations } from '../dist/db/migrate.js';

const db = openDb();
runMigrations(db);
const now = Math.floor(Date.now() / 1000);
let res = {};
try { const r = db.prepare("SELECT value FROM meta WHERE key='t3_resolutions'").get(); if (r) res = JSON.parse(r.value); } catch { /* */ }
const nodeId = res?.A21?.constraint_node;
if (!nodeId) { console.log('A21 constraint node not found'); db.close(); process.exit(0); }

const implRationale = '[T2/再検証 2026-06-05] A21制約 = 実装済み・検証済み（convergent）。canonical kansei_link object（app_url + deep_link + reason + intent）を search_services(recommendation) / get-service-detail(profile) / get-insights(score) / lookup(mode別) に条件付き注入。config駆動 src/utils/app-link.ts（KANSEI_APP_BASE_URL / KANSEI_DEEP_LINK_SCHEME、ハードコード回避）。tsc build green。→ pending 解消。';
const implRefs = [
  { source_type: 'code', ref: 'src/utils/app-link.ts (config-driven kanseiAppLink helper)' },
  { source_type: 'code', ref: 'src/tools/search-services.ts:126,133,141 (kansei_link)' },
  { source_type: 'code', ref: 'src/tools/get-service-detail.ts:117 / get-insights.ts:67 / lookup.ts:328-336' },
  { source_type: 'build', ref: 'tsc build passed' },
];

const card = db.prepare("SELECT id, proposed_node FROM memory_write_candidates WHERE proposed_node LIKE '%\"src\":\"t2\"%' AND target_node_id=?").get(nodeId);
if (card) {
  let pn = {}; try { pn = JSON.parse(card.proposed_node); } catch { /* */ }
  pn.verdict = 'implemented'; pn.resolution = 'fix_implemented';
  db.prepare("UPDATE memory_write_candidates SET status='accepted', proposed_node=?, rationale=?, evidence_refs=? WHERE id=?")
    .run(JSON.stringify(pn), implRationale, JSON.stringify(implRefs), card.id);
}

// annotate the constraint node as verified-implemented
const node = db.prepare('SELECT evidence_refs FROM drift_anchors WHERE id=?').get(nodeId);
let ev = []; try { ev = JSON.parse(node.evidence_refs) || []; } catch { /* */ }
ev.push({ source_type: 't2', ref: '2026-06-05 IMPLEMENTED & VERIFIED — kansei_link injected (app-link.ts + 4 tools), tsc green' });
db.prepare('UPDATE drift_anchors SET evidence_refs=?, last_confirmed_at=? WHERE id=?').run(JSON.stringify(ev), now, nodeId);

// record the T2 resolution (the recorded "apply" for the implementation tier)
let t2res = {};
try { const r = db.prepare("SELECT value FROM meta WHERE key='t2_resolutions'").get(); if (r) t2res = JSON.parse(r.value); } catch { /* */ }
t2res.A21 = { action: 'fix_implemented', node: nodeId, verified: true, at: now };
db.prepare("INSERT INTO meta (key,value) VALUES ('t2_resolutions',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(t2res));

const pending = db.prepare("SELECT count(*) c FROM memory_write_candidates WHERE status='pending_review'").get().c;
console.log(JSON.stringify({ a21_t2: 'implemented & verified', card_status: 'accepted', pending_total: pending }, null, 2));
db.close();
