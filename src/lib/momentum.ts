// Ported from sales-intelligence-os/lib/momentum-calculator-v3.ts
// Original: detects "this company has momentum" from news/signal bursts.
// Agent-memory adaptation: detects "this entity is currently active in the agent's context."
// Drives "context-dependent retrieval" (Michie's memory principle 5).

import type Database from 'better-sqlite3';

export interface MomentumInput {
  eventsLast24h: number;
  eventsLast7d: number;
  eventsHistorical: number;      // total events observed
  daysObserved: number;          // age of the entity in days (for historical avg)
  avgImportanceRecent: number;   // avg importance of last-7d memories, 0.0-1.0
}

export interface MomentumResult {
  score: number;   // 0-10
  band: 'surging' | 'active' | 'quiet' | 'dormant';
  breakdown: {
    quality: number;
    velocity: number;
    relativeVolume: number;
  };
}

export function computeMomentum(input: MomentumInput): MomentumResult {
  // --- velocity (30%): how fast is activity arriving ---
  let velocity = 0;
  if (input.eventsLast24h >= 3) velocity = 10;
  else if (input.eventsLast24h >= 1) velocity = 7;
  else if (input.eventsLast7d >= 3) velocity = 4;
  else if (input.eventsLast7d >= 1) velocity = 2;
  else velocity = 0;

  // --- relativeVolume (30%): recent vs historical baseline ---
  const weeklyAvg = input.daysObserved > 0 ? (input.eventsHistorical / input.daysObserved) * 7 : 0;
  let relativeVolume = 0;
  if (weeklyAvg === 0 && input.eventsLast7d > 0) relativeVolume = 5; // brand-new activity
  else if (weeklyAvg > 0) {
    const ratio = input.eventsLast7d / weeklyAvg;
    if (ratio >= 3) relativeVolume = 10;
    else if (ratio >= 2) relativeVolume = 7;
    else if (ratio >= 1) relativeVolume = 4;
    else relativeVolume = Math.max(0, ratio * 4);
  }

  // --- quality (40%): avg importance of what's arriving ---
  const quality = Math.min(10, input.avgImportanceRecent * 10);

  const weighted = quality * 0.4 + velocity * 0.3 + relativeVolume * 0.3;
  const score = Math.max(0, Math.min(10, weighted));

  let band: MomentumResult['band'];
  if (score >= 7) band = 'surging';
  else if (score >= 4) band = 'active';
  else if (score >= 1.5) band = 'quiet';
  else band = 'dormant';

  return { score, band, breakdown: { quality, velocity, relativeVolume } };
}

// Compute and cache momentum for an entity using DB state.
export function refreshMomentumForEntity(db: Database.Database, entityId: number): MomentumResult {
  const now = Math.floor(Date.now() / 1000);
  const dayAgo = now - 86400;
  const weekAgo = now - 7 * 86400;

  const stats = db
    .prepare(
      `
      SELECT
        (SELECT COUNT(*) FROM events WHERE entity_id = ? AND occurred_at >= ?) as e24,
        (SELECT COUNT(*) FROM events WHERE entity_id = ? AND occurred_at >= ?) as e7d,
        (SELECT COUNT(*) FROM events WHERE entity_id = ?) as eAll,
        (SELECT created_at FROM entities WHERE id = ?) as createdAt,
        (SELECT COALESCE(AVG(importance), 0.5) FROM memories WHERE entity_id = ? AND created_at >= ?) as avgImpRecent
      `
    )
    .get(entityId, dayAgo, entityId, weekAgo, entityId, entityId, entityId, weekAgo) as {
      e24: number; e7d: number; eAll: number; createdAt: number | null; avgImpRecent: number;
    };

  const daysObserved = stats.createdAt ? Math.max(1, (now - stats.createdAt) / 86400) : 1;

  const result = computeMomentum({
    eventsLast24h: stats.e24,
    eventsLast7d: stats.e7d,
    eventsHistorical: stats.eAll,
    daysObserved,
    avgImportanceRecent: stats.avgImpRecent,
  });

  db.prepare('UPDATE entities SET momentum_score = ?, momentum_at = ? WHERE id = ?').run(
    result.score,
    now,
    entityId
  );

  return result;
}
