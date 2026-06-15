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
}
export interface EdgeRow { from_id: string; to_id: string; type: string; note: string | null }

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

export interface BlastHit { id: string; statement: string; status: string; via: string; relation: string }

// 1-hop blast radius. Propagation rules, by edge type:
//   must-stay-consistent-with — SYMMETRIC: touch either end, the other is suspect.
//   realizes / supports       — DIRECTIONAL: an out-of-band change to the SOURCE
//     threatens the TARGET (the thing it realizes/supports). We also surface the
//     reverse for `realizes` (changing a surface's intent implicates its impl).
//   reflux                    — informational only (expand→discover feedback), not
//     a breakage path; excluded from the suspect set.
export function blastRadius(db: Database.Database, project: string, id: string): BlastHit[] {
  const edges = db.prepare('SELECT from_id, to_id, type, note FROM map_edges WHERE project = ? AND (from_id = ? OR to_id = ?)')
    .all(project, id, id) as EdgeRow[];
  const hits = new Map<string, BlastHit>();
  const add = (other: string, relation: string) => {
    if (other === id || hits.has(other)) return;
    const n = getNode(db, project, other);
    if (!n) return;
    hits.set(other, { id: n.id, statement: n.statement, status: n.status, via: id, relation });
  };
  for (const e of edges) {
    if (e.type === 'reflux') continue;
    if (e.type === 'must-stay-consistent-with') {
      add(e.from_id === id ? e.to_id : e.from_id, 'must-stay-consistent-with');
    } else if (e.type === 'realizes') {
      if (e.from_id === id) add(e.to_id, 'realizes→ (impl change threatens surface)');
      else add(e.from_id, '←realizes (surface intent change implicates impl)');
    } else if (e.type === 'supports') {
      if (e.from_id === id) add(e.to_id, 'supports→ (this underpins it)');
    }
  }
  return [...hits.values()];
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
  const withColor = (n: NodeRow) => ({ ...n, color: statusColor(n.status) });
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
