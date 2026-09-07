// Truth Engine — drift state derivation (engine-side, P0).
//
// Migrated from linksee-dashboard/lib/truth.ts into the MCP engine so that
// agents can query drift status via MCP tools. The dashboard can later import
// from here instead of duplicating the logic.
//
// Make-or-break rule: a divergence accounted for by a recorded resolution
// (supersede/fix/acknowledge) is NOT drift. Only unaccounted gaps are flagged.
//
// 4-species taxonomy (display-layer classification):
//   hypothesis  → Decision Cards (decision journal format)
//   constraint  → Rules (compact pass/fail checklist)
//   commitment  → Heartbeats (cadence monitoring, alive/dead)
//   source_of_truth → Reference (quiet, rarely changes)

import type Database from 'better-sqlite3';

// ── Types ────────────────────────────────────────────────────────────────────

// unverified (2026-09-07): an active anchor with no evidence either way — no edges, no
// resolution. It used to render as 🔵 aligned "reality matches intent"; on a real machine
// that was 35 of 45 anchors. Different colour, different meaning: the detector has no eyes here.
export type DriftState = 'drift' | 'review' | 'held' | 'aligned' | 'unverified';
export type Species = 'hypothesis' | 'constraint' | 'commitment' | 'source_of_truth';

export interface TruthNode {
  id: number;
  node_type: string | null;
  domain: string | null;
  decision_mode: string | null;
  species: Species;
  statement: string;
  rationale: string | null;
  confidence: number;
  lifecycle: string;
  cadence_days: number | null;
  review_after: number | null;
  // derived state:
  state: DriftState;
  accounted: boolean;
  accountedBy: string | null;
  reality: string | null;
  reviewDate: string | null;
  overdue: boolean;
}

export interface TruthCandidate {
  id: number;
  candidate_type: string;
  target_node_id: number | null;
  target_statement: string | null;
  rationale: string;
  confidence: number;
  status: string;
}

export interface TruthCounts {
  nodes: number;
  by_mode: Record<string, number>;
  by_species: Record<Species, number>;
  by_state: Record<DriftState, number>;
  auto: number;
  suppressed: number;
}

export interface TruthView {
  attention: TruthNode[];
  /** Active anchors the detector has no evidence about — neither aligned nor drifting. */
  unverifiedByDomain: Array<{ domain: string; nodes: TruthNode[] }>;
  alignedByDomain: Array<{ domain: string; nodes: TruthNode[] }>;
  candidates: { auto: TruthCandidate[]; suppressed: TruthCandidate[] };
  counts: TruthCounts;
  nextReopen: string | null;
}

// For check_decision: single-node deep view
export interface DecisionDetail extends TruthNode {
  kind: string | null;
  affects: string[];
  detect_terms: string[];
  violation_signal: string[];
  tier: string;
  pendingCandidates: TruthCandidate[];
  driftEdges: Array<{
    edge_id: number;
    verdict: string;
    confidence: number;
    status: string;
    detected_at: number;
  }>;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DOMAIN_ORDER = [
  'strategy', 'monetization', 'product', 'engineering',
  'growth', 'operations', 'security', 'roadmap', 'memory', 'other',
];

const STATE_RANK: Record<DriftState, number> = {
  drift: 0, review: 1, held: 2, aligned: 3, unverified: 4,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeJsonParse<T>(s: unknown, fallback: T): T {
  if (s == null) return fallback;
  try { return JSON.parse(String(s)); } catch { return fallback; }
}

function formatDate(ts: number | null): string | null {
  if (ts == null) return null;
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function parseJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a.map(String) : [];
  } catch { return []; }
}

/** Classify a node into one of 4 species based on decision_mode */
function classifySpecies(decision_mode: string | null): Species {
  switch (decision_mode) {
    case 'hypothesis': return 'hypothesis';
    case 'constraint': return 'constraint';
    case 'commitment': return 'commitment';
    case 'source_of_truth': return 'source_of_truth';
    // Fallback: constraints and prohibitions map to 'constraint',
    // metrics to 'hypothesis', anything else to 'hypothesis' (safest default)
    default: return 'hypothesis';
  }
}

// ── Edge summary (one line the agent can act on) ─────────────────────────────

function summarizeEdges(
  verdict: 'contradicts' | 'absent' | 'implements',
  edges: Array<{ confidence: number; evidence: string; detected_at: number }>,
): string {
  const latest = edges[0];
  let ev: any = {};
  try { ev = JSON.parse(latest.evidence || '{}'); } catch { /* ignore */ }
  const file = ev.file_path ? String(ev.file_path).replace(/\\/g, '/').split('/').slice(-2).join('/') : null;
  const hit = ev.hit_term ? ` hit "${ev.hit_term}"` : '';
  const when = new Date(latest.detected_at * 1000).toISOString().slice(0, 10);
  if (verdict === 'implements') {
    return `Observed in reality${file ? ` — ${file}` : ''} (${when}).`;
  }
  const head = verdict === 'contradicts'
    ? `${edges.length} open contradiction${edges.length > 1 ? 's' : ''}`
    : `declared but not found in reality (${edges.length} absent signal${edges.length > 1 ? 's' : ''})`;
  return `${head}${file ? ` — ${file}` : ''}${hit} (${when}). resolve_drift: fix if reality is wrong, dismiss if false positive.`;
}

// ── Resolution lookup ────────────────────────────────────────────────────────

interface ResolutionRecord {
  action: string;
  [key: string]: unknown;
}

function buildResolutionLookup(db: Database.Database): (id: number) => ResolutionRecord | null {
  const t3res = safeJsonParse(
    (db.prepare("SELECT value FROM meta WHERE key='t3_resolutions'").get() as any)?.value,
    {} as Record<string, any>,
  );
  const t2res = safeJsonParse(
    (db.prepare("SELECT value FROM meta WHERE key='t2_resolutions'").get() as any)?.value,
    {} as Record<string, any>,
  );

  // Collect ALL matching resolutions, then pick the most recent one.
  // Without this, an older acknowledge can shadow a newer fix.
  return function resolutionFor(id: number): ResolutionRecord | null {
    const matches: Array<{ action: string; resolved_at?: string; [k: string]: unknown }> = [];
    for (const r of Object.values(t3res)) {
      // A supersede record names both sides. Only the OLD anchor is accounted for by it;
      // the replacement must stay checkable (otherwise a new North Star could never drift,
      // because the supersede branch wins over the contradicts branch).
      if (r && r.action === 'supersede' && r.superseded_by === id && r.superseded_node !== id) continue;
      if (r && (r.superseded_node === id || r.superseded_by === id ||
                r.node === id || r.direction_node === id || r.constraint_node === id)) {
        matches.push(r);
      }
    }
    for (const r of Object.values(t2res)) {
      if (r && (r.node === id || r.constraint_node === id)) {
        matches.push(r);
      }
    }
    if (matches.length === 0) return null;
    if (matches.length === 1) return { action: matches[0].action };
    // Multiple matches → prefer most recent (by resolved_at, falling back to last found)
    matches.sort((a, b) => {
      const ta = a.resolved_at ? new Date(a.resolved_at).getTime() : 0;
      const tb = b.resolved_at ? new Date(b.resolved_at).getTime() : 0;
      return tb - ta; // newest first
    });
    return { action: matches[0].action };
  };
}

// ── Core: getTruthView ───────────────────────────────────────────────────────

/**
 * Anchors that have been explicitly superseded ("intent evolved, this is the new direction").
 *
 * Resolutions live in meta.t3_resolutions keyed `A<anchor_id>`, one record per anchor
 * (a later resolve_drift overwrites the earlier one), so the current resolution for
 * anchor N is simply t3_resolutions["A"+N].
 *
 * NOTE the asymmetry: a supersede record names BOTH sides (superseded_node = the old
 * anchor, superseded_by = the new one). Only the OLD one is retired — the new anchor must
 * keep enforcing, so we match on `superseded_node` and never on `superseded_by`.
 *
 * Used by the gate (guard.ts) so that the enforcement layer honours the same
 * make-or-break rule as the reporting layer: a divergence accounted for by a recorded
 * resolution is NOT drift.
 */
export function supersededAnchorIds(db: Database.Database): Set<number> {
  const out = new Set<number>();
  for (const key of ['t3_resolutions', 't2_resolutions'] as const) {
    const res = safeJsonParse(
      (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as any)?.value,
      {} as Record<string, any>,
    );
    for (const r of Object.values(res)) {
      if (r && r.action === 'supersede' && typeof r.superseded_node === 'number') {
        out.add(r.superseded_node);
      }
    }
  }
  return out;
}

export function getTruthView(
  db: Database.Database,
  opts: { domain?: string; decision_mode?: string } = {},
): TruthView {
  const now = Date.now();
  const resolutionFor = buildResolutionLookup(db);

  // ── Candidates (indexed by target node) ──
  const candRows = db
    .prepare(
      `SELECT id, candidate_type, target_node_id, rationale, confidence, status, proposed_node
       FROM memory_write_candidates ORDER BY id DESC`,
    )
    .all() as any[];

  const pendingByNode = new Map<number, any>();
  const cardByNode = new Map<number, any>();
  for (const c of candRows) {
    if (c.target_node_id == null) continue;
    if (c.status === 'pending_review' && !pendingByNode.has(c.target_node_id)) {
      pendingByNode.set(c.target_node_id, c);
    }
    const pn = String(c.proposed_node || '');
    if ((pn.includes('"src":"t3"') || pn.includes('"src":"t2"')) && !cardByNode.has(c.target_node_id)) {
      cardByNode.set(c.target_node_id, c);
    }
  }

  // ── Open drift edges (what the detector actually observed) ──
  // The detector writes drift_edges; a truth view that never reads them will report 🔵 for
  // anchors it has hard evidence against. (2026-09-05: 11 open `contradicts` edges across 4
  // anchors — one of them the PII constraint — all rendered "reality matches intent".)
  const edgeRows = db
    .prepare(
      `SELECT anchor_id, verdict, confidence, evidence, detected_at
         FROM drift_edges WHERE status = 'open'
        ORDER BY detected_at DESC`,
    )
    .all() as Array<{ anchor_id: number; verdict: string; confidence: number; evidence: string; detected_at: number }>;
  const openEdges = new Map<number, typeof edgeRows>();
  for (const e of edgeRows) {
    if (!openEdges.has(e.anchor_id)) openEdges.set(e.anchor_id, []);
    openEdges.get(e.anchor_id)!.push(e);
  }

  // ── Active nodes + state derivation ──
  let sql =
    `SELECT id, node_type, domain, decision_mode, statement, rationale, confidence, lifecycle,
            card_policy, review_after
     FROM drift_anchors WHERE status = 'active'`;
  const params: any[] = [];
  if (opts.domain) { sql += ' AND domain = ?'; params.push(opts.domain); }
  if (opts.decision_mode) { sql += ' AND decision_mode = ?'; params.push(opts.decision_mode); }
  sql += ' ORDER BY domain, id';

  const rows = db.prepare(sql).all(...params) as any[];

  const nodes: TruthNode[] = rows.map((r) => {
    let cadence: number | null = null;
    try { cadence = JSON.parse(r.card_policy || '{}').cadence_days ?? null; } catch { /* ignore */ }

    const res = resolutionFor(r.id);
    const pending = pendingByNode.get(r.id);
    const card = cardByNode.get(r.id);
    const overdue = r.review_after != null && r.review_after * 1000 < now;
    const edges = openEdges.get(r.id) ?? [];
    const contradicts = edges.filter((e) => e.verdict === 'contradicts');
    const absent = edges.filter((e) => e.verdict === 'absent');
    const implemented = edges.filter((e) => e.verdict === 'implements');

    // ── State derivation (the make-or-break logic) ──
    let state: DriftState;
    let accounted: boolean;
    let accountedBy: string | null;

    if (res?.action === 'acknowledge_validate' || res?.action === 'acknowledge') {
      // ⚪ held — but if time-box expired, escalate to 🔴
      state = overdue ? 'drift' : 'held';
      accounted = !overdue;
      accountedBy = overdue
        ? 'acknowledge (expired → reopened)'
        : 'acknowledge (held, time-boxed)';
    } else if (res?.action === 'fix' || res?.action === 'fix_implemented') {
      state = 'aligned';
      accounted = true;
      accountedBy = 'fix (resolved)';
    } else if (res?.action === 'supersede') {
      state = 'aligned';
      accounted = true;
      accountedBy = 'supersede (intentional evolution)';
    } else if (res?.action === 'dismiss') {
      // 🔵 a human looked at the signal and called it a false positive — that IS an answer.
      state = 'aligned';
      accounted = true;
      accountedBy = 'dismiss (false positive)';
    } else if (contradicts.length > 0) {
      // 🔴 the detector has hard evidence against this anchor and nobody has answered it.
      // resolve_drift(fix|dismiss) closes the edges; supersede/acknowledge are handled above.
      state = 'drift';
      accounted = false;
      accountedBy = null;
    } else if (pending || absent.length > 0) {
      // 🟡 Soft signal awaiting human decision (a pending candidate, or "declared but not
      // found in reality" — absent is weaker than contradicts, so it asks rather than alarms)
      state = 'review';
      accounted = false;
      accountedBy = null;
    } else if (r.lifecycle === 'at_risk') {
      // 🔴 declared-core but unproven / unaccounted
      state = 'drift';
      accounted = false;
      accountedBy = null;
    } else if (implemented.length > 0) {
      // 🔵 the detector saw reality match — this is the only way to be aligned without a verdict
      state = 'aligned';
      accounted = true;
      accountedBy = 'observed (implements)';
    } else {
      // ⚫ nothing checked, nothing decided. Not a problem — but not "fine" either.
      state = 'unverified';
      accounted = false;
      accountedBy = null;
    }

    // Say what was observed. Never claim convergence when nothing was checked — an agent
    // reading "reality matches intent" will trust it; "no signal observed" it will verify.
    const reality = card?.rationale
      ?? pending?.rationale
      ?? (contradicts.length > 0 ? summarizeEdges('contradicts', contradicts) : null)
      ?? (absent.length > 0 ? summarizeEdges('absent', absent) : null)
      ?? (state === 'aligned' && implemented.length > 0 ? summarizeEdges('implements', implemented) : null)
      ?? (state === 'aligned' ? 'Accounted for by recorded resolution' : null)
      ?? (state === 'unverified' ? 'No signal observed (not verified against reality)' : null);

    return {
      id: r.id,
      node_type: r.node_type,
      domain: r.domain,
      decision_mode: r.decision_mode,
      species: classifySpecies(r.decision_mode),
      statement: r.statement,
      rationale: r.rationale ?? null,
      confidence: r.confidence,
      lifecycle: r.lifecycle ?? 'active',
      cadence_days: cadence,
      review_after: r.review_after ?? null,
      state,
      accounted,
      accountedBy,
      reality,
      reviewDate: formatDate(r.review_after),
      overdue,
    };
  });

  // ── Partition: attention (loud) vs aligned (quiet) ──
  const attention = nodes
    .filter((n) => n.state !== 'aligned' && n.state !== 'unverified')
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.confidence - a.confidence);

  const unverifiedGroups = new Map<string, TruthNode[]>();
  for (const n of nodes.filter((n) => n.state === 'unverified')) {
    const d = n.domain ?? 'other';
    if (!unverifiedGroups.has(d)) unverifiedGroups.set(d, []);
    unverifiedGroups.get(d)!.push(n);
  }
  const unverifiedByDomain = [...unverifiedGroups.entries()]
    .sort((a, b) => DOMAIN_ORDER.indexOf(a[0]) - DOMAIN_ORDER.indexOf(b[0]))
    .map(([domain, ns]) => ({ domain, nodes: ns }));

  const alignedGroups = new Map<string, TruthNode[]>();
  for (const n of nodes.filter((n) => n.state === 'aligned')) {
    const d = n.domain ?? 'other';
    if (!alignedGroups.has(d)) alignedGroups.set(d, []);
    alignedGroups.get(d)!.push(n);
  }
  const alignedByDomain = [...alignedGroups.entries()]
    .sort((a, b) => DOMAIN_ORDER.indexOf(a[0]) - DOMAIN_ORDER.indexOf(b[0]))
    .map(([domain, ns]) => ({ domain, nodes: ns }));

  // ── Counts + next reopen ──
  const by_mode: Record<string, number> = {};
  for (const n of nodes) {
    const m = n.decision_mode ?? 'unset';
    by_mode[m] = (by_mode[m] || 0) + 1;
  }

  const by_species: Record<Species, number> = {
    hypothesis: 0, constraint: 0, commitment: 0, source_of_truth: 0,
  };
  for (const n of nodes) by_species[n.species]++;

  const by_state: Record<DriftState, number> = { drift: 0, review: 0, held: 0, aligned: 0, unverified: 0 };
  for (const n of nodes) by_state[n.state]++;

  const reopenDates = nodes
    .filter((n) => n.state === 'held' && n.reviewDate)
    .map((n) => n.reviewDate!)
    .sort();
  const nextReopen = reopenDates[0] ?? null;

  // ── Candidate mapping ──
  const stmtById = new Map(nodes.map((n) => [n.id, n.statement]));
  const mapCand = (c: any): TruthCandidate => ({
    id: c.id,
    candidate_type: c.candidate_type,
    target_node_id: c.target_node_id,
    target_statement: c.target_node_id != null ? stmtById.get(c.target_node_id) ?? null : null,
    rationale: c.rationale,
    confidence: c.confidence,
    status: c.status,
  });
  const auto = candRows.filter((c) => c.status === 'auto_accepted').map(mapCand);
  const suppressed = candRows.filter((c) => c.status === 'rejected').map(mapCand);

  return {
    attention,
    alignedByDomain,
    unverifiedByDomain,
    candidates: { auto, suppressed },
    counts: {
      nodes: nodes.length,
      by_mode,
      by_species,
      by_state,
      auto: auto.length,
      suppressed: suppressed.length,
    },
    nextReopen,
  };
}

// ── check_decision: single-node deep view ────────────────────────────────────

export function getDecisionDetail(
  db: Database.Database,
  anchorId: number,
): DecisionDetail | null {
  const row = db
    .prepare(
      `SELECT id, kind, node_type, domain, decision_mode, statement, rationale, confidence,
              lifecycle, card_policy, review_after, affects, detect_terms, violation_signal, tier
       FROM drift_anchors WHERE id = ? AND status = 'active'`,
    )
    .get(anchorId) as any;
  if (!row) return null;

  // Get full truth view for this single node (reuse state derivation)
  const resolutionFor = buildResolutionLookup(db);
  const now = Date.now();

  let cadence: number | null = null;
  try { cadence = JSON.parse(row.card_policy || '{}').cadence_days ?? null; } catch { /* */ }

  const res = resolutionFor(row.id);
  const overdue = row.review_after != null && row.review_after * 1000 < now;

  // State derivation — MUST mirror getTruthView. It had drifted: this branch never looked at
  // drift_edges, so check_decision could say "aligned" on the anchor drift_status flagged 🔴.
  const openEdgesHere = db
    .prepare(`SELECT verdict, confidence, evidence, detected_at FROM drift_edges WHERE anchor_id = ? AND status = 'open' ORDER BY detected_at DESC`)
    .all(anchorId) as Array<{ verdict: string; confidence: number; evidence: string; detected_at: number }>;
  const contradictsHere = openEdgesHere.filter((e) => e.verdict === 'contradicts');
  const absentHere = openEdgesHere.filter((e) => e.verdict === 'absent');
  const implementedHere = openEdgesHere.filter((e) => e.verdict === 'implements');
  let state: DriftState, accounted: boolean, accountedBy: string | null;
  const pendingCand = db
    .prepare(
      `SELECT id, candidate_type, target_node_id, rationale, confidence, status
       FROM memory_write_candidates
       WHERE target_node_id = ? AND status = 'pending_review'
       ORDER BY id DESC`,
    )
    .all(anchorId) as any[];

  const cardCand = db
    .prepare(
      `SELECT rationale FROM memory_write_candidates
       WHERE target_node_id = ? AND proposed_node LIKE '%"src":"t%'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(anchorId) as any;

  const hasPending = pendingCand.length > 0;

  if (res?.action === 'acknowledge_validate' || res?.action === 'acknowledge') {
    state = overdue ? 'drift' : 'held';
    accounted = !overdue;
    accountedBy = overdue ? 'acknowledge (expired → reopened)' : 'acknowledge (held, time-boxed)';
  } else if (res?.action === 'fix' || res?.action === 'fix_implemented') {
    state = 'aligned'; accounted = true; accountedBy = 'fix (resolved)';
  } else if (res?.action === 'supersede') {
    state = 'aligned'; accounted = true; accountedBy = 'supersede (intentional evolution)';
  } else if (res?.action === 'dismiss') {
    state = 'aligned'; accounted = true; accountedBy = 'dismiss (false positive)';
  } else if (contradictsHere.length > 0) {
    state = 'drift'; accounted = false; accountedBy = null;
  } else if (hasPending || absentHere.length > 0) {
    state = 'review'; accounted = false; accountedBy = null;
  } else if (row.lifecycle === 'at_risk') {
    state = 'drift'; accounted = false; accountedBy = null;
  } else if (implementedHere.length > 0) {
    state = 'aligned'; accounted = true; accountedBy = 'observed (implements)';
  } else {
    state = 'unverified'; accounted = false; accountedBy = null;
  }

  const reality = cardCand?.rationale ?? (hasPending ? pendingCand[0].rationale : null)
    ?? (contradictsHere.length > 0 ? summarizeEdges('contradicts', contradictsHere) : null)
    ?? (absentHere.length > 0 ? summarizeEdges('absent', absentHere) : null)
    ?? (state === 'aligned' && implementedHere.length > 0 ? summarizeEdges('implements', implementedHere) : null)
    ?? (state === 'aligned' ? 'Accounted for by recorded resolution' : null)
    ?? (state === 'unverified' ? 'No signal observed (not verified against reality)' : null);

  // Drift edges for this anchor
  const edges = db
    .prepare(
      `SELECT id AS edge_id, verdict, confidence, status, detected_at
       FROM drift_edges WHERE anchor_id = ? ORDER BY detected_at DESC`,
    )
    .all(anchorId) as any[];

  return {
    id: row.id,
    kind: row.kind,
    node_type: row.node_type,
    domain: row.domain,
    decision_mode: row.decision_mode,
    species: classifySpecies(row.decision_mode),
    statement: row.statement,
    rationale: row.rationale ?? null,
    confidence: row.confidence,
    lifecycle: row.lifecycle ?? 'active',
    cadence_days: cadence,
    review_after: row.review_after ?? null,
    state,
    accounted,
    accountedBy,
    reality,
    reviewDate: formatDate(row.review_after),
    overdue,
    // Deep fields
    affects: parseJsonArray(row.affects),
    detect_terms: parseJsonArray(row.detect_terms),
    violation_signal: parseJsonArray(row.violation_signal),
    tier: row.tier,
    pendingCandidates: pendingCand.map((c: any) => ({
      id: c.id,
      candidate_type: c.candidate_type,
      target_node_id: c.target_node_id,
      target_statement: row.statement,
      rationale: c.rationale,
      confidence: c.confidence,
      status: c.status,
    })),
    driftEdges: edges,
  };
}

// ── resolve_drift: record a resolution in meta ───────────────────────────────

export type ResolutionAction = 'fix' | 'supersede' | 'acknowledge' | 'dismiss';

export interface ResolveInput {
  /** For dismiss: silence only this match term. Omitted → silence the anchor at the gate. */
  hit_term?: string;
  anchor_id: number;
  action: ResolutionAction;
  rationale?: string;
  review_after?: string; // ISO date for acknowledge (e.g. "2026-07-04")
  superseded_by?: number; // for supersede: the new anchor
}

export function resolveDrift(db: Database.Database, input: ResolveInput): { ok: boolean; resolution: any } {
  const ACTIONS = new Set<ResolutionAction>(['fix', 'supersede', 'acknowledge', 'dismiss']);
  if (!ACTIONS.has(input.action)) {
    throw new Error(`invalid action "${input.action}" — one of: fix, supersede, acknowledge, dismiss`);
  }

  // Verify anchor exists and is active
  const anchor = db
    .prepare("SELECT id, statement FROM drift_anchors WHERE id = ? AND status = 'active'")
    .get(input.anchor_id) as any;
  if (!anchor) {
    throw new Error(`anchor ${input.anchor_id} not found or not active`);
  }

  // Build resolution record
  const resolution: Record<string, unknown> = {
    action: input.action,
    node: input.anchor_id,
    rationale: input.rationale ?? null,
    resolved_at: new Date().toISOString(),
  };

  if (input.action === 'acknowledge' && input.review_after) {
    resolution.action = 'acknowledge_validate';
    const ts = Math.floor(new Date(input.review_after).getTime() / 1000);
    resolution.review_after = ts;
    // Also set review_after on the anchor itself
    db.prepare('UPDATE drift_anchors SET review_after = ?, updated_at = unixepoch() WHERE id = ?')
      .run(ts, input.anchor_id);
  }

  if (input.action === 'supersede' && input.superseded_by != null) {
    resolution.superseded_node = input.anchor_id;
    resolution.superseded_by = input.superseded_by;
  }

  // Write to meta (t3_resolutions) — additive, keyed by anchor id
  const key = 't3_resolutions';
  const existing = safeJsonParse(
    (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as any)?.value,
    {} as Record<string, any>,
  );
  existing[`A${input.anchor_id}`] = resolution;
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?")
    .run(key, JSON.stringify(existing), JSON.stringify(existing));

  // 'dismiss' must change what happens NEXT time, not just tidy the current edges — otherwise
  // the same wrong match fires on the next command and the verdict was theatre. Record it where
  // the gate reads (gate_dismissals), keyed to the exact term when one was given so the anchor's
  // real detections survive.
  if (input.action === 'dismiss') {
    db.prepare(
      "UPDATE drift_edges SET status = 'dismissed' WHERE anchor_id = ? AND status = 'open'",
    ).run(input.anchor_id);
    try {
      db.prepare(
        `INSERT INTO gate_dismissals (anchor_id, hit_term, rationale) VALUES (?, ?, ?)
         ON CONFLICT(anchor_id, COALESCE(hit_term, '')) DO UPDATE SET rationale = excluded.rationale`,
      ).run(input.anchor_id, input.hit_term ? input.hit_term.toLowerCase() : null, input.rationale ?? null);
      resolution.gate_dismissed = input.hit_term ? input.hit_term.toLowerCase() : 'all matches';
    } catch { /* pre-v16 DB → edges-only dismiss, as before */ }
  }

  // If action is 'fix', mark open edges as resolved
  if (input.action === 'fix') {
    db.prepare(
      "UPDATE drift_edges SET status = 'resolved' WHERE anchor_id = ? AND status = 'open'",
    ).run(input.anchor_id);
  }

  return { ok: true, resolution };
}
