// Sleep-mode consolidation: cluster stale low-importance memories,
// summarize into a single `learning`-layer entry, delete originals.
// Implements Michie's memory principle 4 (sleep consolidation).
//
// Strategy (rule-based, no LLM required):
//   1. Find candidates: layer IN (context, emotion, implementation),
//      protected=0, cold (heat<30), older than 7 days, cluster size >= 2.
//   2. Group by (entity_id, layer).
//   3. Emit a structured summary into `learning` layer (protected=1),
//      then delete originals.
//   4. Per-run forget-sweep drops expired memories that didn't cluster.

import type Database from 'better-sqlite3';
import { computeHeat } from './heat-index.js';
import { decideForgetting } from './forgetting.js';

export interface ConsolidateResult {
  scanned: number;
  clustersCompressed: number;
  memoriesReplaced: number;
  memoriesDropped: number;
  learningIdsCreated: number[];
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
}

const CLUSTER_LAYERS = ['context', 'emotion', 'implementation'] as const;
const DEFAULT_MIN_AGE_DAYS = 7;
const MAX_HEAT = 30;
const MIN_CLUSTER_SIZE = 2;

export function consolidate(
  db: Database.Database,
  opts: { scope?: 'all' | 'session'; min_age_days?: number } = {}
): ConsolidateResult {
  const now = Math.floor(Date.now() / 1000);
  const minAgeDays = opts.min_age_days ?? DEFAULT_MIN_AGE_DAYS;
  const ageCutoff = now - minAgeDays * 86400;

  // Fetch candidates with age threshold. 'session' scope → same query currently
  // (Day 2: session filter needs session_id plumbing; will add when sessions
  // table is actually populated by the MCP server).
  const layerPlaceholders = CLUSTER_LAYERS.map(() => '?').join(',');
  const rows = db
    .prepare(
      `
      SELECT m.id, m.entity_id, m.layer, m.content, m.importance,
             m.last_accessed_at, m.access_count, m.created_at, m.protected,
             e.name as entity_name
      FROM memories m
      JOIN entities e ON e.id = m.entity_id
      WHERE m.protected = 0
        AND m.layer IN (${layerPlaceholders})
        AND m.created_at <= ?
      ORDER BY m.entity_id, m.layer, m.created_at
      `
    )
    .all(...CLUSTER_LAYERS, ageCutoff) as Candidate[];

  // Filter to cold-heat memories
  const cold = rows.filter((r) => {
    const daysSince = (now - r.last_accessed_at) / 86400;
    const heat = computeHeat({
      accessesLast30d: daysSince < 30 ? r.access_count : 0,
      accessesLast90d: daysSince < 90 ? r.access_count : 0,
      daysSinceLastAccess: daysSince,
      totalAccesses: r.access_count,
      baseImportance: r.importance,
    });
    return heat.score < MAX_HEAT;
  });

  // Group by (entity_id, layer)
  const groups = new Map<string, Candidate[]>();
  for (const r of cold) {
    const key = `${r.entity_id}::${r.layer}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  const result: ConsolidateResult = {
    scanned: rows.length,
    clustersCompressed: 0,
    memoriesReplaced: 0,
    memoriesDropped: 0,
    learningIdsCreated: [],
  };

  const insertLearning = db.prepare(
    `INSERT INTO memories (entity_id, layer, content, importance, protected, source)
     VALUES (?, 'learning', ?, ?, 1, ?)`
  );
  const deleteMemory = db.prepare('DELETE FROM memories WHERE id = ?');
  const insertAudit = db.prepare(
    `INSERT INTO consolidations (learning_id, replaced_ids, replaced_count, entity_id, original_layer)
     VALUES (?, ?, ?, ?, ?)`
  );
  const insertEvent = db.prepare(
    'INSERT INTO events (entity_id, kind, payload) VALUES (?, ?, ?)'
  );

  const tx = db.transaction(() => {
    for (const [key, cluster] of groups) {
      if (cluster.length < MIN_CLUSTER_SIZE) continue;

      const [entityIdStr, layer] = key.split('::');
      const entityId = Number(entityIdStr);
      const entityName = cluster[0].entity_name;

      // Sort by importance desc, take top 3 as exemplars
      const byImp = [...cluster].sort((a, b) => b.importance - a.importance);
      const exemplars = byImp.slice(0, 3).map((c) => ({
        fragment: c.content.length > 200 ? c.content.slice(0, 200) + '…' : c.content,
        when: new Date(c.created_at * 1000).toISOString().slice(0, 10),
        importance: c.importance,
      }));

      const timestamps = cluster.map((c) => c.created_at);
      const earliest = new Date(Math.min(...timestamps) * 1000).toISOString().slice(0, 10);
      const latest = new Date(Math.max(...timestamps) * 1000).toISOString().slice(0, 10);

      const avgImp = cluster.reduce((s, c) => s + c.importance, 0) / cluster.length;

      const summary = {
        source: 'consolidate',
        original_layer: layer,
        count: cluster.length,
        period: { from: earliest, to: latest },
        pattern: `${cluster.length} cold observations on "${entityName}" (${layer}) consolidated during sleep`,
        exemplars,
        replaced_ids: cluster.map((c) => c.id),
      };

      const learningImportance = Math.max(avgImp, 0.55); // summaries are slightly more important than their avg source
      const sourceMeta = JSON.stringify({ origin: 'consolidate', replaced: cluster.length });

      const ins = insertLearning.run(
        entityId,
        JSON.stringify(summary, null, 2),
        learningImportance,
        sourceMeta
      );
      const learningId = Number(ins.lastInsertRowid);
      result.learningIdsCreated.push(learningId);

      insertAudit.run(
        learningId,
        JSON.stringify(cluster.map((c) => c.id)),
        cluster.length,
        entityId,
        layer
      );

      for (const c of cluster) deleteMemory.run(c.id);
      insertEvent.run(entityId, 'memory_consolidated', JSON.stringify({ learning_id: learningId, count: cluster.length, layer }));

      result.clustersCompressed++;
      result.memoriesReplaced += cluster.length;
    }
  });
  tx();

  // Post-consolidate: forget-sweep remaining non-clustered cold memories
  const remaining = db
    .prepare('SELECT id, layer, importance, access_count, last_accessed_at, protected FROM memories WHERE protected = 0')
    .all() as any[];

  const toDrop: number[] = [];
  for (const r of remaining) {
    const daysSince = (now - r.last_accessed_at) / 86400;
    const heat = computeHeat({
      accessesLast30d: daysSince < 30 ? r.access_count : 0,
      accessesLast90d: daysSince < 90 ? r.access_count : 0,
      daysSinceLastAccess: daysSince,
      totalAccesses: r.access_count,
      baseImportance: r.importance,
    });
    const action = decideForgetting({
      daysSinceLastAccess: daysSince,
      importance: r.importance,
      heatScore: heat.score,
      protected: r.protected === 1,
      layer: r.layer,
    });
    if (action === 'drop') toDrop.push(r.id);
  }

  if (toDrop.length > 0) {
    const del = db.prepare('DELETE FROM memories WHERE id = ?');
    const tx2 = db.transaction((ids: number[]) => {
      for (const id of ids) del.run(id);
    });
    tx2(toDrop);
    result.memoriesDropped = toDrop.length;
  }

  return result;
}
