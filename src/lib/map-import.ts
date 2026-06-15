// ── Current Truth Map importer (Product Drift OS spec v3) ─────────────────────
// map.yaml (git) is the desired-state SOURCE OF TRUTH (anchor #58). This module
// parses it and reconciles it INTO the runtime index (map_nodes / map_edges).
// Import is a full rebuild per project: wipe the project's rows, re-insert. That
// keeps map.yaml authoritative — a node deleted from the file disappears from the
// index, exactly like `terraform apply` converging to the declared state.
import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

export const EDGE_TYPES = new Set(['realizes', 'supports', 'must-stay-consistent-with', 'should-align-with', 'mentions', 'reflux']);
export const EDGE_STRENGTHS = new Set(['hard', 'soft', 'watch']);
export const NODE_LAYERS = new Set(['surface', 'implementation']);
// Recognized statuses — anything else imports but is flagged as a warning (so a
// typo can't silently become a phantom lifecycle the dashboard renders blank).
export const NODE_STATUSES = new Set([
  'active', 'experiment', 'commitment', 'planned', 'paused', 'suspect', 'future_thesis',
]);

export interface MapNode {
  id: string;
  layer: string;
  stage?: string;
  statement: string;
  status?: string;
  facets?: string[];
  role?: string;
  note?: string;
  due?: string;
  paused_reason?: string;
  related_project?: string;
  spinout_candidate?: boolean;
  anchor?: number; // → drift_anchors.id, IFF this node is a normative claim
  review_by?: string;          // ISO date: when a deferred/accounted-for node must be revisited
  revival_condition?: string;  // the release condition that clears a deferral
  reality?: Record<string, unknown>; // how to verify this node from reality (kind/dir/signal/verdict_if_*)
  [k: string]: unknown; // forward-compat fields land in `extra`
}
export interface MapEdge { from: string; to: string; type: string; strength?: string; note?: string }
export interface ParsedMap {
  project: string;
  template?: string;
  product_status?: string;
  job?: string;
  audience?: Record<string, unknown>;
  related_projects?: unknown[];
  stages: Array<{ id: string; label?: string }>;
  nodes: MapNode[];
  edges: MapEdge[];
}

const KNOWN_NODE_COLS = new Set([
  'id', 'layer', 'stage', 'statement', 'status', 'facets', 'role', 'note',
  'due', 'paused_reason', 'related_project', 'spinout_candidate', 'anchor', 'reality',
  'review_by', 'revival_condition',
]);

export function parseMapFile(path: string): ParsedMap {
  const raw = parseYaml(readFileSync(path, 'utf8')) as Partial<ParsedMap> | null;
  if (!raw || typeof raw !== 'object') throw new Error(`map.yaml at ${path} parsed to nothing`);
  if (!raw.project) throw new Error('map.yaml missing required top-level `project`');
  if (!Array.isArray(raw.stages) || raw.stages.length === 0) throw new Error('map.yaml needs a non-empty `stages` spine');
  if (!Array.isArray(raw.nodes)) throw new Error('map.yaml `nodes` must be a list');
  return {
    project: String(raw.project),
    template: raw.template ? String(raw.template) : undefined,
    product_status: raw.product_status ? String(raw.product_status) : undefined,
    job: raw.job ? String(raw.job) : undefined,
    audience: (raw.audience as Record<string, unknown>) ?? undefined,
    related_projects: Array.isArray(raw.related_projects) ? raw.related_projects : undefined,
    stages: raw.stages.map((s: any) => ({ id: String(s.id), label: s.label ? String(s.label) : undefined })),
    nodes: (raw.nodes as MapNode[]) ?? [],
    edges: Array.isArray(raw.edges) ? (raw.edges as MapEdge[]) : [],
  };
}

export interface ImportResult {
  project: string;
  nodes: number;
  edges: number;
  linked_anchors: number;
  warnings: string[];
}

// Full-rebuild import inside one transaction. Validates topology and collects
// warnings (dangling edge endpoints, unknown stage/status) WITHOUT aborting — a
// map mid-edit should still load so the dashboard can show what IS there.
export function importMap(db: Database.Database, map: ParsedMap): ImportResult {
  const warnings: string[] = [];
  const stageIds = new Set(map.stages.map((s) => s.id));
  const nodeIds = new Set(map.nodes.map((n) => n.id));

  // validate nodes
  for (const n of map.nodes) {
    if (!n.id) { warnings.push('node with no id skipped'); continue; }
    if (!NODE_LAYERS.has(n.layer)) warnings.push(`node ${n.id}: unknown layer "${n.layer}"`);
    if (n.layer === 'surface' && n.stage && !stageIds.has(n.stage)) warnings.push(`node ${n.id}: stage "${n.stage}" not in spine`);
    if (n.layer === 'surface' && !n.stage) warnings.push(`node ${n.id}: surface node has no stage`);
    if (n.status && !NODE_STATUSES.has(n.status)) warnings.push(`node ${n.id}: unrecognized status "${n.status}"`);
  }
  // validate edges
  for (const e of map.edges) {
    if (!EDGE_TYPES.has(e.type)) warnings.push(`edge ${e.from}→${e.to}: unknown type "${e.type}"`);
    if (e.strength && !EDGE_STRENGTHS.has(e.strength)) warnings.push(`edge ${e.from}→${e.to}: unknown strength "${e.strength}"`);
    if (!nodeIds.has(e.from)) warnings.push(`edge endpoint "${e.from}" is not a node (dangling)`);
    if (!nodeIds.has(e.to)) warnings.push(`edge endpoint "${e.to}" is not a node (dangling)`);
  }

  const anchorExists = db.prepare('SELECT 1 FROM drift_anchors WHERE id = ?');
  let linked = 0;

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO map_projects (project, job, audience, product_status, template, stages, related_projects, updated_at)
      VALUES (@project, @job, @audience, @product_status, @template, @stages, @related_projects, unixepoch())
      ON CONFLICT(project) DO UPDATE SET
        job=excluded.job, audience=excluded.audience, product_status=excluded.product_status,
        template=excluded.template, stages=excluded.stages, related_projects=excluded.related_projects,
        updated_at=unixepoch()
    `).run({
      project: map.project,
      job: map.job ?? null,
      audience: JSON.stringify(map.audience ?? {}),
      product_status: map.product_status ?? null,
      template: map.template ?? null,
      stages: JSON.stringify(map.stages),
      related_projects: JSON.stringify(map.related_projects ?? []),
    });

    db.prepare('DELETE FROM map_edges WHERE project = ?').run(map.project);
    db.prepare('DELETE FROM map_nodes WHERE project = ?').run(map.project);

    const insNode = db.prepare(`
      INSERT INTO map_nodes
        (id, project, layer, stage, statement, status, facets, role, note, due,
         paused_reason, related_project, spinout_candidate, anchor_id, review_by, revival_condition, reality, extra, updated_at)
      VALUES
        (@id, @project, @layer, @stage, @statement, @status, @facets, @role, @note, @due,
         @paused_reason, @related_project, @spinout_candidate, @anchor_id, @review_by, @revival_condition, @reality, @extra, unixepoch())
    `);
    for (const n of map.nodes) {
      if (!n.id) continue;
      let anchorId: number | null = null;
      if (n.anchor != null) {
        if (anchorExists.get(n.anchor)) { anchorId = Number(n.anchor); linked++; }
        else warnings.push(`node ${n.id}: anchor #${n.anchor} not found — link skipped`);
      }
      const extra: Record<string, unknown> = {};
      for (const k of Object.keys(n)) if (!KNOWN_NODE_COLS.has(k)) extra[k] = n[k];
      insNode.run({
        id: n.id,
        project: map.project,
        layer: n.layer ?? 'surface',
        stage: n.stage ?? null,
        statement: n.statement ?? '',
        status: n.status ?? 'active',
        facets: JSON.stringify(n.facets ?? []),
        role: n.role ?? null,
        note: n.note ?? null,
        due: n.due ?? null,
        paused_reason: n.paused_reason ?? null,
        related_project: n.related_project ?? null,
        spinout_candidate: n.spinout_candidate ? 1 : 0,
        anchor_id: anchorId,
        review_by: n.review_by ?? null,
        revival_condition: n.revival_condition ?? null,
        reality: JSON.stringify(n.reality ?? {}),
        extra: JSON.stringify(extra),
      });
    }

    const insEdge = db.prepare(`
      INSERT OR IGNORE INTO map_edges (project, from_id, to_id, type, strength, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const e of map.edges) insEdge.run(map.project, e.from, e.to, e.type, e.strength ?? null, e.note ?? null);
  });
  tx();

  return { project: map.project, nodes: map.nodes.filter((n) => n.id).length, edges: map.edges.length, linked_anchors: linked, warnings };
}

export function importMapFile(db: Database.Database, path: string): ImportResult {
  return importMap(db, parseMapFile(path));
}
