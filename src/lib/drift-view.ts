// Drift view (v8) — the READ side of drift observability (build order step 4).
//
// Pairs with drift-detection.ts (which WRITES drift_edges). This module turns those edges
// into Drift View cards and provides the human feedback action. It is the §7 verdict layer,
// consumed by step 5 (the top-3 contradiction cards in the dashboard) and by any CLI/MCP
// surface later. Read-only except setDriftEdgeStatus (the dismiss/ack loop).
//
// A card = [anchor statement + WHY] / [reality file_path:snippet + occurred_at] /
//          [verdict + confidence] / dismiss → status='dismissed' (the precision feedback loop).

import type Database from 'better-sqlite3';
import type { AnchorKind } from './drift-anchors.js';

export type DriftEdgeStatus = 'open' | 'ack' | 'dismissed' | 'resolved';
const EDGE_STATUSES = new Set<DriftEdgeStatus>(['open', 'ack', 'dismissed', 'resolved']);

export interface DriftHeadlineCard {
  edge_id: number;
  anchor_id: number;
  kind: AnchorKind;
  statement: string;
  rationale: string | null;
  // reality (the cited divergence)
  file_path: string;
  context_snippet: string | null;
  occurred_at: number;
  // verdict
  confidence: number;
  hit_term: string | null; // the forbidden term that was found present (from evidence)
  evidence: Record<string, unknown>;
}

export interface DriftAbsenceCard {
  edge_id: number;
  anchor_id: number;
  kind: AnchorKind;
  statement: string;
  rationale: string | null;
  confidence: number;
  age_days: number | null; // from evidence (how stale the unfulfilled decision is)
  detected_at: number;
}

export interface DriftViewCounts {
  contradicts_open: number;
  absent_open: number;
  dismissed: number;
}

export interface DriftView {
  headline: DriftHeadlineCard[]; // contradicts (decided-but-violated), highest confidence first
  absences: DriftAbsenceCard[]; // absent (decided-but-no-reality), oldest unfulfilled first
  counts: DriftViewCounts;
}

function parseEvidence(s: string | null | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * §7①  Headline: divergence (decided-but-violated). Confidence, then entrenchment
 * (human > explicit), then recency. Only OPEN edges on ACTIVE anchors — a dismissed card
 * stays gone, a retired anchor stops surfacing.
 */
export function getDriftHeadline(db: Database.Database, opts: { limit?: number } = {}): DriftHeadlineCard[] {
  const limit = opts.limit ?? 3;
  const rows = db
    .prepare(
      `SELECT d.id AS edge_id, d.anchor_id, a.kind, a.statement, a.rationale,
              e.file_path, e.context_snippet, e.occurred_at,
              d.confidence, d.evidence
         FROM drift_edges d
         JOIN drift_anchors a ON a.id = d.anchor_id
         JOIN session_file_edits e ON e.id = d.edit_id
        WHERE d.verdict = 'contradicts' AND d.status = 'open' AND a.status = 'active'
        ORDER BY d.confidence DESC, (a.tier = 'human') DESC, e.occurred_at DESC
        LIMIT ?`
    )
    .all(limit) as any[];
  return rows.map((r) => {
    const evidence = parseEvidence(r.evidence);
    return {
      edge_id: r.edge_id,
      anchor_id: r.anchor_id,
      kind: r.kind,
      statement: r.statement,
      rationale: r.rationale ?? null,
      file_path: r.file_path,
      context_snippet: r.context_snippet ?? null,
      occurred_at: r.occurred_at,
      confidence: r.confidence,
      hit_term: typeof evidence.hit_term === 'string' ? evidence.hit_term : null,
      evidence,
    };
  });
}

/**
 * §7②  Secondary: absence (decided-but-no-reality), staleness-gated at write time.
 * Oldest unfulfilled decision first.
 */
export function getDriftAbsences(db: Database.Database, opts: { limit?: number } = {}): DriftAbsenceCard[] {
  const limit = opts.limit ?? 10;
  const rows = db
    .prepare(
      `SELECT d.id AS edge_id, d.anchor_id, a.kind, a.statement, a.rationale,
              d.confidence, d.evidence, d.detected_at
         FROM drift_edges d
         JOIN drift_anchors a ON a.id = d.anchor_id
        WHERE d.verdict = 'absent' AND d.status = 'open' AND a.status = 'active'
        ORDER BY a.created_at ASC
        LIMIT ?`
    )
    .all(limit) as any[];
  return rows.map((r) => {
    const evidence = parseEvidence(r.evidence);
    return {
      edge_id: r.edge_id,
      anchor_id: r.anchor_id,
      kind: r.kind,
      statement: r.statement,
      rationale: r.rationale ?? null,
      confidence: r.confidence,
      age_days: typeof evidence.age_days === 'number' ? evidence.age_days : null,
      detected_at: r.detected_at,
    };
  });
}

function countOpen(db: Database.Database, verdict: 'contradicts' | 'absent'): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM drift_edges d JOIN drift_anchors a ON a.id = d.anchor_id
          WHERE d.verdict = ? AND d.status = 'open' AND a.status = 'active'`
      )
      .get(verdict) as { n: number }
  ).n;
}

/** The whole Drift View in one call — headline + absences + the badge counts step 5 needs. */
export function getDriftView(
  db: Database.Database,
  opts: { headlineLimit?: number; absenceLimit?: number } = {}
): DriftView {
  const dismissed = (
    db.prepare(`SELECT COUNT(*) AS n FROM drift_edges WHERE status = 'dismissed'`).get() as { n: number }
  ).n;
  return {
    headline: getDriftHeadline(db, { limit: opts.headlineLimit }),
    absences: getDriftAbsences(db, { limit: opts.absenceLimit }),
    counts: {
      contradicts_open: countOpen(db, 'contradicts'),
      absent_open: countOpen(db, 'absent'),
      dismissed,
    },
  };
}

/**
 * The feedback action behind a Drift View card. `dismissed` is the precision signal — a user
 * marking a false positive teaches us to tune. (The detector's contradicts upsert never
 * resurrects a non-open row, so a dismissal sticks across re-runs.) Returns true if it changed.
 */
export function setDriftEdgeStatus(db: Database.Database, edgeId: number, status: DriftEdgeStatus): boolean {
  if (!EDGE_STATUSES.has(status)) {
    throw new Error(`invalid status "${status}" — one of: open, ack, dismissed, resolved`);
  }
  const r = db
    .prepare(`UPDATE drift_edges SET status = ? WHERE id = ? AND status <> ?`)
    .run(status, edgeId, status);
  return r.changes > 0;
}
