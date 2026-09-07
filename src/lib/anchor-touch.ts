// Decision-trajectory instrumentation — the D7 retention metric for decision-writers.
//
// The bridge metric (Linksee Memory strategy): of installs that record a decision
// (an anchor), what fraction COME BACK and interact with a PRIOR decision within
// 7 days. This single number gates cross-tool expansion.
//
// What nothing else captured: the READ/inspect signals (check_decision, drift_status).
// Creations live in drift_anchors.created_at; guard re-surfaces live in injection_log;
// this table fills the gap and unifies them for the metric.
//
// PRIVACY: logs only {anchor_id, optional session_id, a verb, a timestamp}. NEVER any
// statement text, rationale, or content. Best-effort: a failure here must NEVER break
// the tool call that triggered it.

import type Database from 'better-sqlite3';

export type AnchorInteraction = 'create' | 'inspect' | 'review' | 'resolve' | 'resurface';

const DAY = 86400;

/** Record one interaction with a decision/anchor. Best-effort — never throws. */
export function logAnchorTouch(
  db: Database.Database,
  t: { anchorId?: number | null; sessionId?: string | null; tool: string; interaction: AnchorInteraction },
): void {
  try {
    db.prepare(
      `INSERT INTO anchor_touch_log (anchor_id, session_id, tool, interaction) VALUES (?, ?, ?, ?)`,
    ).run(t.anchorId ?? null, t.sessionId ?? null, t.tool, t.interaction);
  } catch {
    /* instrumentation must never break a tool call */
  }
}

/**
 * Per-session counts for telemetry — COUNTS ONLY, no content.
 * Window = [startSec, endSec] (unix seconds, the session's edit span).
 * The server turns these per-session counts into the fleet D7 rate by ordering an
 * install's sessions: D0 = first session with anchor_creates>0; retained if a later
 * session within 7 days has anchor_returns>0.
 */
export function getSessionAnchorCounts(
  db: Database.Database,
  startSec: number,
  endSec: number,
): { anchor_creates: number; anchor_returns: number } {
  try {
    if (!startSec || !endSec || endSec < startSec) return { anchor_creates: 0, anchor_returns: 0 };
    const creates = (db.prepare(
      `SELECT COUNT(*) AS c FROM drift_anchors WHERE created_at BETWEEN ? AND ?`,
    ).get(startSec, endSec) as { c: number }).c;
    const touchReturns = (db.prepare(
      `SELECT COUNT(*) AS c FROM anchor_touch_log WHERE interaction != 'create' AND occurred_at BETWEEN ? AND ?`,
    ).get(startSec, endSec) as { c: number }).c;
    const gateReturns = (db.prepare(
      `SELECT COUNT(*) AS c FROM injection_log WHERE occurred_at BETWEEN ? AND ?`,
    ).get(startSec, endSec) as { c: number }).c;
    return { anchor_creates: creates, anchor_returns: touchReturns + gateReturns };
  } catch {
    return { anchor_creates: 0, anchor_returns: 0 };
  }
}

export interface AnchorRetention {
  totalAnchors: number;
  firstAnchorAt: number | null;
  lastAnchorAt: number | null;
  returnInteractions: number;   // return touches (incl. guard re-surfaces) after a decision was recorded
  activeDays: number;           // distinct calendar days with any decision activity
  retainedAnchors: number;      // decisions revisited on a LATER day within 7d of their OWN creation
  retentionRate: number;        // retainedAnchors / totalAnchors (0..1) — this install's per-decision D7
  mostRevisited: { anchor_id: number; statement: string; touches: number } | null;
}

/**
 * Local, single-install decision-trajectory view. The source for `stats` (the
 * founder-sales 1:1 read-out) and the seed of the "your decision trajectory" digest.
 *
 * The local readout is PER-DECISION retention (recency-independent): of the decisions
 * you've recorded, what fraction did you come back to within 7 days of recording each.
 * The fleet GATE rate (install-cohort "returned within 7d of the FIRST decision") is a
 * different, cohort-entry metric — computed server-side from the per-session telemetry
 * counts in getSessionAnchorCounts(), not here.
 */
export function getAnchorRetention(db: Database.Database, opts: { windowDays?: number } = {}): AnchorRetention {
  const windowDays = opts.windowDays ?? 7;
  const empty: AnchorRetention = {
    totalAnchors: 0, firstAnchorAt: null, lastAnchorAt: null, returnInteractions: 0,
    activeDays: 0, retainedAnchors: 0, retentionRate: 0, mostRevisited: null,
  };
  try {
    const creates = (db.prepare(
      `SELECT created_at FROM drift_anchors ORDER BY created_at`,
    ).all() as Array<{ created_at: number | null }>).map((r) => r.created_at).filter((t): t is number => t != null);
    if (creates.length === 0) return empty;

    const first = creates[0];
    const last = creates[creates.length - 1];

    // "Came back" activity = non-create touches + guard re-surfaces.
    const touchTs = (db.prepare(
      `SELECT occurred_at FROM anchor_touch_log WHERE interaction != 'create'`,
    ).all() as Array<{ occurred_at: number }>).map((r) => r.occurred_at);
    const gateTs = (db.prepare(
      `SELECT occurred_at FROM injection_log`,
    ).all() as Array<{ occurred_at: number }>).map((r) => r.occurred_at);
    const returnTs = [...touchTs, ...gateTs].filter((t) => t != null);
    const returnInteractions = returnTs.filter((t) => t > first).length;

    // Per-decision D7: a decision is "retained" if any activity (a return interaction
    // OR recording a LATER decision) falls on a later calendar day within 7d of it.
    const day = (t: number) => Math.floor(t / DAY);
    const activity = [...returnTs, ...creates].sort((a, b) => a - b);
    let retainedAnchors = 0;
    for (const t0 of creates) {
      const horizon = t0 + windowDays * DAY;
      if (activity.some((e) => e <= horizon && day(e) > day(t0))) retainedAnchors++;
    }

    const activeDays = (db.prepare(
      `SELECT COUNT(*) AS c FROM (
         SELECT DISTINCT CAST(created_at / 86400 AS INT) AS d FROM drift_anchors
         UNION
         SELECT DISTINCT CAST(occurred_at / 86400 AS INT) FROM anchor_touch_log WHERE interaction != 'create'
         UNION
         SELECT DISTINCT CAST(occurred_at / 86400 AS INT) FROM injection_log
       )`,
    ).get() as { c: number }).c;

    let mostRevisited: AnchorRetention['mostRevisited'] = null;
    const mv = db.prepare(
      `SELECT anchor_id, COUNT(*) AS touches FROM (
         SELECT anchor_id FROM anchor_touch_log WHERE interaction != 'create' AND anchor_id IS NOT NULL
         UNION ALL
         SELECT anchor_id FROM injection_log WHERE anchor_id IS NOT NULL
       ) GROUP BY anchor_id ORDER BY touches DESC LIMIT 1`,
    ).get() as { anchor_id: number; touches: number } | undefined;
    if (mv && mv.touches > 0) {
      const a = db.prepare(`SELECT statement FROM drift_anchors WHERE id = ?`).get(mv.anchor_id) as { statement: string } | undefined;
      if (a) mostRevisited = { anchor_id: mv.anchor_id, statement: a.statement, touches: mv.touches };
    }

    return {
      totalAnchors: creates.length,
      firstAnchorAt: first,
      lastAnchorAt: last,
      returnInteractions,
      activeDays,
      retainedAnchors,
      retentionRate: creates.length ? retainedAnchors / creates.length : 0,
      mostRevisited,
    };
  } catch {
    return empty;
  }
}
