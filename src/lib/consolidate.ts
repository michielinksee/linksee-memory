// Sleep-mode consolidation: cluster stale low-importance memories and write one
// `learning`-layer summary per cluster. Implements Michie's memory principle 4
// (sleep consolidation).
//
// 0.18.1: NOTHING IS DELETED. Up to 0.18.0 this file deleted the original rows of every
// cluster and then ran a "forget-sweep" that deleted every other cold row — 1,360 rows on
// 2026-10-29 and 559 (11 decisions among them) on 2026-11-05 on the maintainer's own database,
// with no notice and no way to opt out. Rows a hand-over needs, gone for a summary that said
// "N cold observations consolidated during sleep".
//
// Strategy (rule-based, no LLM required):
//   1. Find candidates: layer IN (context, emotion, implementation), protected=0,
//      JSON content, not already folded, cold (heat<30), older than 7 days, cluster size >= 2.
//   2. Group by (entity_id, layer).
//   3. Emit a structured summary into `learning` layer (protected=1), then MARK the originals
//      with `consolidated_into: <summary id>` in their content JSON (json_set). The rows stay.
//      `recall` hides marked rows by default and reports how many (`consolidated_hidden`);
//      `include_consolidated: true` shows them.
//   4. There is no forget-sweep any more. Cold rows that did not cluster are counted
//      (`coldUnclustered`) and left alone.
//
// Plain-text rows (content that is not a JSON object) are never folded: the mark can only be
// written into JSON, and rewriting a user's text to add it is not this module's call. They are
// counted in `skippedPlainText`.

import type Database from 'better-sqlite3';
import { computeHeat } from './heat-index.js';
import { decideForgetting } from './forgetting.js';
import { detectMemoryEdges } from './edge-detection.js';

export interface ConsolidateResult {
  scanned: number;
  clustersCompressed: number;
  /** Rows marked `consolidated_into` (kept in the table; hidden from default recall). */
  memoriesFolded: number;
  /** Always 0 since 0.18.1 — kept so older readers of the result do not break. */
  memoriesDropped: 0;
  /** Cold rows that did not form a cluster. Nothing is done to them. */
  coldUnclustered: number;
  /** Cold rows with plain-text content, left out because the mark needs JSON. */
  skippedPlainText: number;
  learningIdsCreated: number[];
  stalledTransitions: number;
  memoryEdgesCreated: number;
  decisionsSuperseded: number;
}

interface Candidate {
  id: number;
  entity_id: number;
  entity_name: string;
  layer: string;
  content: string;
  importance: number;
  last_accessed_at: number;
  access_count: number;
  created_at: number;
  protected: number;
  altitude: string | null;
  mem_type: string | null;
}

export interface ConsolidatePlanCluster {
  entity_id: number;
  entity_name: string;
  layer: string;
  ids: number[];
  members: Candidate[];
  /** Up to 3 content fragments (first 120 chars), for a dry-run listing. */
  examples: string[];
}

export interface ConsolidatePlan {
  scanned: number;
  clusters: ConsolidatePlanCluster[];
  /** Number of rows that `--apply` would mark. */
  wouldFold: number;
  coldUnclustered: number;
  skippedPlainText: number;
}

const CLUSTER_LAYERS = ['context', 'emotion', 'implementation'] as const;
const DEFAULT_MIN_AGE_DAYS = 7;
const MAX_HEAT = 30;
const MIN_CLUSTER_SIZE = 2;

/** SQL fragment: the row has been folded into a summary (alias `m` for memories). */
export const CONSOLIDATED_SQL = `(json_valid(m.content) AND json_type(m.content) = 'object' AND json_extract(m.content, '$.consolidated_into') IS NOT NULL)`;

function heatOf(now: number, r: { last_accessed_at: number; access_count: number; importance: number }): number {
  const daysSince = (now - r.last_accessed_at) / 86400;
  return computeHeat({
    accessesLast30d: daysSince < 30 ? r.access_count : 0,
    accessesLast90d: daysSince < 90 ? r.access_count : 0,
    daysSinceLastAccess: daysSince,
    totalAccesses: r.access_count,
    baseImportance: r.importance,
  }).score;
}

/**
 * What consolidate would do, without writing. Shared by `consolidate` (which applies it),
 * the `consolidate --dry-run` subcommand, and the start-up notice.
 */
export function planConsolidate(
  db: Database.Database,
  opts: { min_age_days?: number } = {},
  now: number = Math.floor(Date.now() / 1000),
): ConsolidatePlan {
  const minAgeDays = opts.min_age_days ?? DEFAULT_MIN_AGE_DAYS;
  const ageCutoff = now - minAgeDays * 86400;

  const layerPlaceholders = CLUSTER_LAYERS.map(() => '?').join(',');
  const rows = db
    .prepare(
      `
      SELECT m.id, m.entity_id, m.layer, m.content, m.importance,
             m.last_accessed_at, m.access_count, m.created_at, m.protected,
             m.altitude, m.mem_type,
             e.name as entity_name
      FROM memories m
      JOIN entities e ON e.id = m.entity_id
      WHERE m.protected = 0
        AND m.layer IN (${layerPlaceholders})
        AND m.created_at <= ?
        AND NOT ${CONSOLIDATED_SQL}
      ORDER BY m.entity_id, m.layer, m.created_at
      `
    )
    .all(...CLUSTER_LAYERS, ageCutoff) as Candidate[];

  // Cold-heat rows only; plain-text rows cannot carry the mark and are set aside.
  const cold: Candidate[] = [];
  let skippedPlainText = 0;
  for (const r of rows) {
    if (heatOf(now, r) >= MAX_HEAT) continue;
    if (!isJsonObject(r.content)) { skippedPlainText++; continue; }
    cold.push(r);
  }

  const groups = new Map<string, Candidate[]>();
  for (const r of cold) {
    const key = `${r.entity_id}::${r.layer}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  const clusters: ConsolidatePlanCluster[] = [];
  let coldUnclustered = 0;
  for (const members of groups.values()) {
    if (members.length < MIN_CLUSTER_SIZE) { coldUnclustered += members.length; continue; }
    clusters.push({
      entity_id: members[0].entity_id,
      entity_name: members[0].entity_name,
      layer: members[0].layer,
      ids: members.map((c) => c.id),
      members,
      examples: members.slice(0, 3).map((c) => fragment(c.content, 120)),
    });
  }

  return {
    scanned: rows.length,
    clusters,
    wouldFold: clusters.reduce((s, c) => s + c.ids.length, 0),
    coldUnclustered,
    skippedPlainText,
  };
}

function isJsonObject(content: string): boolean {
  try {
    const v = JSON.parse(content);
    return !!v && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
}

function fragment(content: string, max: number): string {
  let text = content;
  try {
    const o: any = JSON.parse(content);
    const core = o?.what ?? o?.title ?? o?.decision ?? o?.intent ?? o?.learned ?? o?.summary;
    if (typeof core === 'string') text = core;
  } catch { /* plain text */ }
  text = String(text).replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}

export function consolidate(
  db: Database.Database,
  opts: { scope?: 'all' | 'session'; min_age_days?: number } = {}
): ConsolidateResult {
  const now = Math.floor(Date.now() / 1000);
  // 'session' scope → same query currently (session filter needs session_id plumbing).
  const plan = planConsolidate(db, { min_age_days: opts.min_age_days }, now);

  const result: ConsolidateResult = {
    scanned: plan.scanned,
    clustersCompressed: 0,
    memoriesFolded: 0,
    memoriesDropped: 0,
    coldUnclustered: plan.coldUnclustered,
    skippedPlainText: plan.skippedPlainText,
    learningIdsCreated: [],
    stalledTransitions: 0,
    memoryEdgesCreated: 0,
    decisionsSuperseded: 0,
  };

  const insertLearning = db.prepare(
    `INSERT INTO memories (entity_id, layer, content, importance, protected, source)
     VALUES (?, 'learning', ?, ?, 1, ?)`
  );
  // The mark, not a delete. Guarded so a row that is no longer a JSON object (changed since the
  // plan) or already folded is left as it is: json_set on non-JSON would throw, and a throw
  // inside the transaction rolls the whole run back — which is what we want for "unknown".
  const markFolded = db.prepare(
    `UPDATE memories
       SET content = json_set(content, '$.consolidated_into', ?)
     WHERE id = ?
       AND json_valid(content) AND json_type(content) = 'object'
       AND json_extract(content, '$.consolidated_into') IS NULL`
  );
  const insertAudit = db.prepare(
    `INSERT INTO consolidations (learning_id, replaced_ids, replaced_count, entity_id, original_layer)
     VALUES (?, ?, ?, ?, ?)`
  );
  const insertEvent = db.prepare(
    'INSERT INTO events (entity_id, kind, payload) VALUES (?, ?, ?)'
  );

  // Order inside the transaction: summary row first, then the audit row, then the marks on the
  // originals. If any step throws, the transaction rolls back and no original is marked while
  // no summary exists (and the reverse). Nothing is deleted at any step.
  const tx = db.transaction(() => {
    for (const cluster of plan.clusters) {
      const { entity_id: entityId, entity_name: entityName, layer, members } = cluster;

      // Sort by importance desc, take top 3 as exemplars
      const byImp = [...members].sort((a, b) => b.importance - a.importance);
      const exemplars = byImp.slice(0, 3).map((c) => ({
        id: c.id,
        fragment: c.content.length > 200 ? c.content.slice(0, 200) + '…' : c.content,
        when: new Date(c.created_at * 1000).toISOString().slice(0, 10),
        importance: c.importance,
      }));

      const timestamps = members.map((c) => c.created_at);
      const earliest = new Date(Math.min(...timestamps) * 1000).toISOString().slice(0, 10);
      const latest = new Date(Math.max(...timestamps) * 1000).toISOString().slice(0, 10);

      const avgImp = members.reduce((s, c) => s + c.importance, 0) / members.length;

      // Dominant altitude from cluster members (most frequent non-null value), so decay rates
      // are preserved on the summary.
      const altCounts = new Map<string, number>();
      for (const c of members) {
        if (c.altitude) altCounts.set(c.altitude, (altCounts.get(c.altitude) ?? 0) + 1);
      }
      let dominantAltitude = 'implementation';
      let maxCount = 0;
      for (const [alt, count] of altCounts) {
        if (count > maxCount) { dominantAltitude = alt; maxCount = count; }
      }

      const summary = {
        source: 'consolidate',
        altitude: maxCount > 0 ? dominantAltitude : 'implementation',
        type: 'learning' as const,
        state: 'done' as const,
        original_layer: layer,
        count: members.length,
        period: { from: earliest, to: latest },
        pattern: `${members.length} cold observations on "${entityName}" (${layer}) folded into this summary; the originals are kept (recall({ include_consolidated: true }) shows them)`,
        exemplars,
        // Kept under the old key so readers of pre-0.18.1 summaries still find the ids.
        replaced_ids: members.map((c) => c.id),
        folded_ids: members.map((c) => c.id),
      };

      const learningImportance = Math.max(avgImp, 0.55); // summaries are slightly more important than their avg source
      const sourceMeta = JSON.stringify({ origin: 'consolidate', folded: members.length });

      const ins = insertLearning.run(
        entityId,
        JSON.stringify(summary, null, 2),
        learningImportance,
        sourceMeta
      );
      const learningId = Number(ins.lastInsertRowid);

      insertAudit.run(
        learningId,
        JSON.stringify(members.map((c) => c.id)),
        members.length,
        entityId,
        layer
      );

      let marked = 0;
      for (const c of members) marked += markFolded.run(learningId, c.id).changes;
      if (marked !== members.length) {
        // A member changed under us (no longer JSON, or folded by a concurrent run). Unknown
        // state → stop; the transaction rolls back everything, including the summary row.
        throw new Error(
          `consolidate: cluster ${entityName}/${layer} marked ${marked} of ${members.length} rows; rolled back, nothing written`
        );
      }
      insertEvent.run(entityId, 'memory_consolidated', JSON.stringify({ learning_id: learningId, count: members.length, layer, deleted: 0 }));

      result.learningIdsCreated.push(learningId);
      result.clustersCompressed++;
      result.memoriesFolded += members.length;
    }
  });
  tx();

  // State transition sweep: in_progress memories untouched for 30+ days → stalled.
  // Uses json_set() to update the state field in content JSON atomically.
  const STALLED_THRESHOLD_DAYS = 30;
  const stalledCutoff = now - STALLED_THRESHOLD_DAYS * 86400;
  const stalledResult = db.prepare(`
    UPDATE memories SET content = json_set(content, '$.state', 'stalled')
    WHERE json_valid(content)
      AND json_extract(content, '$.state') = 'in_progress'
      AND last_accessed_at < ?
      AND protected = 0
  `).run(stalledCutoff);
  result.stalledTransitions = stalledResult.changes;

  // Memory→memory edge detection: link superseding/contradicting decisions so the
  // dashboard can render Pivot Chains and recall can surface superseded decisions.
  const edgeRes = detectMemoryEdges(db);
  result.memoryEdgesCreated = edgeRes.edgesCreated;
  result.decisionsSuperseded = edgeRes.supersededMarked;

  // 0.18.1: the forget-sweep that deleted every remaining cold row is gone. Nothing below this
  // line touches `memories`.
  return result;
}

/**
 * How many rows the (removed) forget-sweep would have dropped — reported, never acted on.
 * Kept for `consolidate --dry-run` so the user can see what earlier versions were deleting.
 */
export function countSweepCandidates(db: Database.Database, now: number = Math.floor(Date.now() / 1000)): number {
  const remaining = db
    .prepare('SELECT id, layer, importance, access_count, last_accessed_at, protected, altitude FROM memories WHERE protected = 0')
    .all() as any[];
  let n = 0;
  for (const r of remaining) {
    const daysSince = (now - r.last_accessed_at) / 86400;
    const action = decideForgetting({
      daysSinceLastAccess: daysSince,
      importance: r.importance,
      heatScore: heatOf(now, r),
      protected: r.protected === 1,
      layer: r.layer,
      altitude: r.altitude ?? undefined,
    });
    if (action === 'drop') n++;
  }
  return n;
}

/**
 * Should the MCP server run consolidate on its own at start-up? (0.17.1, L-1-106 / audit F1)
 *
 * No, unless the user asked. Opt in with LINKSEE_AUTO_CONSOLIDATE=1|true|on|yes|weekly, or
 * `--auto-consolidate` on the server command line. The weekly gate inside the server still
 * applies once enabled. Since 0.18.1 consolidate marks rows instead of deleting them, but it
 * still rewrites content and hides rows from the default recall, so it stays opt-in.
 */
export function autoConsolidateEnabled(env: Record<string, string | undefined>, argv: readonly string[]): boolean {
  if (argv.includes('--auto-consolidate')) return true;
  const v = (env.LINKSEE_AUTO_CONSOLIDATE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes' || v === 'weekly';
}
