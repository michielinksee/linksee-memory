// ── Current Truth Map read-side (Product Drift OS spec v3) ────────────────────
// Two queries the topology exists to answer:
//   blastRadius(node) — "if THIS drifts out-of-band, what is now suspect?"  (the
//     thing flat anchors could not compute — it needs node↔node edges)
//   getBlueprint()    — stages × nodes with status color, the dashboard home.
import type Database from 'better-sqlite3';

export interface NodeRow {
  id: string; project: string; layer: string; stage: string | null;
  statement: string; status: string; facets: string; role: string | null;
  note: string | null; due: string | null; paused_reason: string | null;
  related_project: string | null; spinout_candidate: number; anchor_id: number | null;
  live_verdict?: string | null; verdict_evidence?: string | null;
}
export interface EdgeRow { from_id: string; to_id: string; type: string; strength: string | null; note: string | null }

// Edge strength controls AFFECTS noise: hard = mismatch is a clear problem · soft =
// should align · watch = informational (shown in AFFECTS, never in Needs attention).
export type EdgeStrength = 'hard' | 'soft' | 'watch';
const DEFAULT_STRENGTH: Record<string, EdgeStrength> = {
  'must-stay-consistent-with': 'hard',
  realizes: 'hard',
  'should-align-with': 'soft',
  supports: 'soft',
  mentions: 'watch',
  reflux: 'watch',
};
export const edgeStrength = (e: { type: string; strength?: string | null }): EdgeStrength =>
  (e.strength as EdgeStrength) || DEFAULT_STRENGTH[e.type] || 'soft';

// Verdict color = Reflexion vocabulary (spec v2): convergence / divergence / absence.
// We can't know the live verdict without running the reconciler, so the dashboard
// colors by declared STATUS as the resting state; the reconciler overlays verdicts.
export type StatusColor = 'green' | 'red' | 'gray' | 'amber' | 'blue';
export function statusColor(status: string): StatusColor {
  switch (status) {
    case 'active': case 'commitment': return 'green';   // convergence (realized / on the hook)
    case 'suspect': return 'red';                       // divergence (reality may contradict)
    case 'paused': case 'planned': case 'future_thesis': return 'gray'; // absence (declared, not realized)
    case 'experiment': return 'amber';                  // in flight, allowed to wobble
    default: return 'blue';
  }
}
// A live reconciler verdict (when present) OVERRIDES the declared-status color —
// reality wins over what we hand-declared.
export function verdictColor(verdict: string): StatusColor {
  switch (verdict) {
    case 'convergence': return 'green';
    case 'divergence': return 'red';
    case 'absence': return 'gray';
    default: return 'blue';
  }
}
export function nodeColor(n: { status: string; live_verdict?: string | null }): StatusColor {
  return n.live_verdict ? verdictColor(n.live_verdict) : statusColor(n.status);
}

export interface ProjectMeta {
  project: string; job: string | null; audience: Record<string, unknown>;
  product_status: string | null; template: string | null;
  stages: Array<{ id: string; label?: string }>; related_projects: unknown[];
}
export function getProjectMeta(db: Database.Database, project: string): ProjectMeta | undefined {
  const r = db.prepare('SELECT * FROM map_projects WHERE project = ?').get(project) as any;
  if (!r) return undefined;
  const j = (s: string, dflt: unknown) => { try { return JSON.parse(s); } catch { return dflt; } };
  return {
    project: r.project, job: r.job, audience: j(r.audience, {}), product_status: r.product_status,
    template: r.template, stages: j(r.stages, []), related_projects: j(r.related_projects, []),
  };
}
export function listMapProjects(db: Database.Database): string[] {
  return (db.prepare('SELECT project FROM map_projects ORDER BY project').all() as Array<{ project: string }>).map((r) => r.project);
}

export function getNode(db: Database.Database, project: string, id: string): NodeRow | undefined {
  return db.prepare('SELECT * FROM map_nodes WHERE project = ? AND id = ?').get(project, id) as NodeRow | undefined;
}
export function getSuspects(db: Database.Database, project: string): NodeRow[] {
  return db.prepare("SELECT * FROM map_nodes WHERE project = ? AND status = 'suspect' ORDER BY stage, id").all(project) as NodeRow[];
}

export interface BlastHit { id: string; statement: string; status: string; via: string; relation: string; strength: EdgeStrength }

// 1-hop blast radius. Propagation rules, by edge type:
//   must-stay-consistent-with — SYMMETRIC: touch either end, the other is suspect.
//   realizes / supports       — DIRECTIONAL: an out-of-band change to the SOURCE
//     threatens the TARGET (the thing it realizes/supports). We also surface the
//     reverse for `realizes` (changing a surface's intent implicates its impl).
//   reflux                    — informational only (expand→discover feedback), not
//     a breakage path; excluded from the suspect set.
export function blastRadius(db: Database.Database, project: string, id: string): BlastHit[] {
  const edges = db.prepare('SELECT from_id, to_id, type, strength, note FROM map_edges WHERE project = ? AND (from_id = ? OR to_id = ?)')
    .all(project, id, id) as EdgeRow[];
  const hits = new Map<string, BlastHit>();
  const rank: Record<EdgeStrength, number> = { hard: 0, soft: 1, watch: 2 };
  const add = (other: string, relation: string, strength: EdgeStrength) => {
    if (other === id) return;
    const existing = hits.get(other);
    if (existing && rank[existing.strength] <= rank[strength]) return; // keep the stronger edge
    const n = getNode(db, project, other);
    if (!n) return;
    hits.set(other, { id: n.id, statement: n.statement, status: n.status, via: id, relation, strength });
  };
  for (const e of edges) {
    if (e.type === 'reflux') continue; // feedback loop, not a dependency path
    const s = edgeStrength(e);
    if (e.type === 'must-stay-consistent-with') add(e.from_id === id ? e.to_id : e.from_id, e.type, s);
    else if (e.type === 'should-align-with') add(e.from_id === id ? e.to_id : e.from_id, e.type, s);
    else if (e.type === 'mentions') add(e.from_id === id ? e.to_id : e.from_id, e.type, s);
    else if (e.type === 'realizes') {
      if (e.from_id === id) add(e.to_id, 'realizes→ (impl change threatens surface)', s);
      else add(e.from_id, '←realizes (surface intent change implicates impl)', s);
    } else if (e.type === 'supports') {
      if (e.from_id === id) add(e.to_id, 'supports→ (this underpins it)', s);
    }
  }
  // hard first, then soft, then watch
  return [...hits.values()].sort((a, b) => rank[a.strength] - rank[b.strength]);
}

// ── where_am_i: explicit-query positional locate (spec v3) ────────────────────
// The per-turn re-anchor primitive. Given a topic string or a node id, locate it
// on the Map and return "you are here + blast radius + the decision behind it".
// Matching is LEXICAL only (no embeddings) — consistent with the drift detector.
export interface WhereAmIMatch {
  node: NodeRow;
  stage_label: string | null;
  match_reason: string;
  blast: BlastHit[];
  anchor: { id: number; statement: string } | null;
}
export interface WhereAmIResult {
  project: string;
  job: string | null;
  matched: WhereAmIMatch[];
}

function queryTerms(q: string): string[] {
  return q.toLowerCase().split(/[\s、。,.\/_()「」"'`:：]+/).map((t) => t.trim()).filter((t) => t.length >= 2);
}

export function whereAmI(
  db: Database.Database,
  opts: { project?: string; query?: string; node_id?: string; limit?: number }
): WhereAmIResult {
  const project = opts.project
    ?? (db.prepare('SELECT project FROM map_projects ORDER BY updated_at DESC LIMIT 1').get() as { project?: string } | undefined)?.project
    ?? '';
  const meta = project ? getProjectMeta(db, project) : undefined;
  const stageLabel = (stageId: string | null): string | null =>
    stageId ? meta?.stages.find((s) => s.id === stageId)?.label ?? stageId : null;
  const anchorOf = (n: NodeRow) => n.anchor_id != null
    ? (db.prepare('SELECT id, statement FROM drift_anchors WHERE id = ?').get(n.anchor_id) as { id: number; statement: string } | undefined) ?? null
    : null;
  const wrap = (n: NodeRow, reason: string): WhereAmIMatch => ({
    node: n, stage_label: stageLabel(n.stage), match_reason: reason,
    blast: blastRadius(db, project, n.id), anchor: anchorOf(n),
  });

  // 1. exact node id
  if (opts.node_id) {
    const n = getNode(db, project, opts.node_id);
    return { project, job: meta?.job ?? null, matched: n ? [wrap(n, 'exact node id')] : [] };
  }
  // 2. lexical scoring over id + statement + note + facets
  const limit = opts.limit ?? 3;
  const terms = queryTerms(opts.query ?? '');
  const all = db.prepare('SELECT * FROM map_nodes WHERE project = ?').all(project) as NodeRow[];
  const scored = all.map((n) => {
    const hay = `${n.id} ${n.statement} ${n.note ?? ''} ${n.facets}`.toLowerCase();
    let score = 0;
    if (terms.some((t) => n.id.toLowerCase() === t)) score += 10; // id hit dominates
    for (const t of terms) if (hay.includes(t)) score += n.id.toLowerCase().includes(t) ? 3 : 1;
    return { n, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);

  return {
    project, job: meta?.job ?? null,
    matched: scored.map((x) => wrap(x.n, `lexical match (score ${x.score})`)),
  };
}

export interface BlueprintCell { stage: string; label: string; nodes: Array<NodeRow & { color: StatusColor }> }
export interface Blueprint {
  project: string;
  stages: BlueprintCell[];
  implementation: Array<NodeRow & { color: StatusColor }>;
  counts: Record<string, number>;
}

// The dashboard home: surface nodes laid out by journey stage (the columns),
// implementation nodes in their own tray, every node carrying a status color.
export function getBlueprint(db: Database.Database, project: string, stageOrder?: Array<{ id: string; label?: string }>): Blueprint {
  // Fall back to the persisted canonical spine when the caller didn't pass one (the dashboard path).
  const order = stageOrder ?? getProjectMeta(db, project)?.stages ?? [];
  const all = db.prepare('SELECT * FROM map_nodes WHERE project = ? ORDER BY stage, id').all(project) as NodeRow[];
  const withColor = (n: NodeRow) => ({ ...n, color: nodeColor(n) });
  const stages: BlueprintCell[] = order.map((s) => ({
    stage: s.id,
    label: s.label ?? s.id,
    nodes: all.filter((n) => n.layer === 'surface' && n.stage === s.id).map(withColor),
  }));
  const implementation = all.filter((n) => n.layer === 'implementation').map(withColor);
  const counts: Record<string, number> = {};
  for (const n of all) counts[n.status] = (counts[n.status] ?? 0) + 1;
  return { project, stages, implementation, counts };
}
