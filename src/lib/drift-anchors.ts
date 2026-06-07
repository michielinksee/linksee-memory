// Drift anchor write path (v8) — the "intent" side of drift observability.
//
// An anchor is a DECLARED normative claim: a prohibition ("never assert safety"),
// a decision ("we use FTS5, not vector"), or a constraint ("all writes go through
// remember()"). The detector (drift-detection.ts) later checks these against reality
// (session_file_edits) and emits drift_edges.
//
// declare-don't-mine: anchors are clean BY CONSTRUCTION. They come only from explicit
// declaration (CLI / curation / CLAUDE.md), never from the session pattern-extractor.
// The schema's `tier CHECK ('human','explicit')` is the hard boundary; this module adds
// a friendlier error and the structural validation (a prohibition with no violation
// signal can never fire, so we reject it at write time rather than store dead weight).

import type Database from 'better-sqlite3';

export type AnchorKind = 'prohibition' | 'decision' | 'constraint';
export type AnchorTier = 'human' | 'explicit'; // declare-don't-mine floor — agent/inferred forbidden
export type AnchorSource = 'declare' | 'curate' | 'claude_md';
export type AnchorStatus = 'active' | 'retired';

export interface DeclareAnchorInput {
  kind: AnchorKind;
  statement: string;
  rationale?: string;
  affects?: string[]; // path globs that scope reality (e.g. ["**/articles/**"])
  detect_terms?: string[]; // topical terms for FTS/overlap scoping
  violation_signal?: string[]; // terms whose PRESENCE in scope = a violation
  tier?: AnchorTier; // default 'human' (a person declared it)
  source?: AnchorSource; // default 'declare'
  source_memory_id?: number;
}

export interface AnchorRow {
  id: number;
  kind: AnchorKind;
  statement: string;
  rationale: string | null;
  affects: string[];
  detect_terms: string[];
  violation_signal: string[];
  tier: AnchorTier;
  source: AnchorSource;
  source_memory_id: number | null;
  status: AnchorStatus;
  created_at: number;
  updated_at: number;
}

const KINDS = new Set<AnchorKind>(['prohibition', 'decision', 'constraint']);
const TIERS = new Set<AnchorTier>(['human', 'explicit']);
const SOURCES = new Set<AnchorSource>(['declare', 'curate', 'claude_md']);

function toJsonArray(v: unknown): string {
  if (v == null) return '[]';
  if (!Array.isArray(v)) throw new Error('expected an array of strings');
  const clean = v.map((x) => String(x).trim()).filter(Boolean);
  return JSON.stringify(clean);
}

function parseArray(s: string): string[] {
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

function hydrate(r: any): AnchorRow {
  return {
    id: r.id,
    kind: r.kind,
    statement: r.statement,
    rationale: r.rationale ?? null,
    affects: parseArray(r.affects),
    detect_terms: parseArray(r.detect_terms),
    violation_signal: parseArray(r.violation_signal),
    tier: r.tier,
    source: r.source,
    source_memory_id: r.source_memory_id ?? null,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/**
 * Declare a drift anchor from explicit input. Clean by construction — validates the
 * declare-don't-mine tier floor and the "can this anchor ever fire?" structural rule.
 */
export function declareAnchor(db: Database.Database, input: DeclareAnchorInput): AnchorRow {
  if (!KINDS.has(input.kind)) {
    throw new Error(`invalid kind "${input.kind}" — one of: prohibition, decision, constraint`);
  }
  const statement = String(input.statement ?? '').trim();
  if (statement.length < 8) {
    throw new Error('statement is required — a real normative claim (>= 8 chars)');
  }
  const tier = input.tier ?? 'human';
  if (!TIERS.has(tier)) {
    throw new Error(
      `invalid tier "${tier}" — declare-don't-mine: anchors must be 'human' or 'explicit', never agent/inferred`
    );
  }
  const source = input.source ?? 'declare';
  if (!SOURCES.has(source)) {
    throw new Error(`invalid source "${source}" — one of: declare, curate, claude_md`);
  }

  const violation = toJsonArray(input.violation_signal);
  // A prohibition/decision is only useful if the detector can deduce a violation from it.
  // Without a violation_signal the anchor is dead weight — reject at write time.
  if ((input.kind === 'prohibition' || input.kind === 'decision') && parseArray(violation).length === 0) {
    throw new Error(
      `${input.kind} anchors need at least one violation_signal term (the forbidden act / rejected alternative) — otherwise the detector can never deduce a contradiction`
    );
  }

  const info = db
    .prepare(
      `INSERT INTO drift_anchors
         (kind, statement, rationale, affects, detect_terms, violation_signal, tier, source, source_memory_id)
       VALUES
         (@kind, @statement, @rationale, @affects, @detect_terms, @violation_signal, @tier, @source, @source_memory_id)`
    )
    .run({
      kind: input.kind,
      statement,
      rationale: input.rationale?.trim() || null,
      affects: toJsonArray(input.affects),
      detect_terms: toJsonArray(input.detect_terms),
      violation_signal: violation,
      tier,
      source,
      source_memory_id: input.source_memory_id ?? null,
    });

  return getAnchor(db, Number(info.lastInsertRowid))!;
}

/**
 * Promote an existing memory into an anchor (the seeding/curation path). Pulls a
 * candidate statement/rationale from the memory's structured content, but the curator
 * must still supply the lexical bridge (affects / detect_terms / violation_signal) —
 * that human review is what keeps the anchor pool clean.
 */
export function curateAnchorFromMemory(
  db: Database.Database,
  memoryId: number,
  overrides: Partial<DeclareAnchorInput> & { kind: AnchorKind }
): AnchorRow {
  const mem = db.prepare('SELECT id, content FROM memories WHERE id = ?').get(memoryId) as
    | { id: number; content: string }
    | undefined;
  if (!mem) throw new Error(`memory ${memoryId} not found`);

  let statement = overrides.statement;
  let rationale = overrides.rationale;
  if (!statement) {
    try {
      const o: any = JSON.parse(mem.content);
      statement = o?.rule_or_warning ?? o?.title ?? o?.what ?? o?.decision ?? o?.learned ?? '';
      rationale = rationale ?? o?.why;
    } catch {
      statement = mem.content;
    }
  }

  return declareAnchor(db, {
    ...overrides,
    statement: String(statement ?? '').trim(),
    rationale,
    tier: overrides.tier ?? 'explicit',
    source: 'curate',
    source_memory_id: memoryId,
  });
}

export function getAnchor(db: Database.Database, id: number): AnchorRow | null {
  const r = db.prepare('SELECT * FROM drift_anchors WHERE id = ?').get(id);
  return r ? hydrate(r) : null;
}

export function listAnchors(
  db: Database.Database,
  opts: { status?: AnchorStatus; kind?: AnchorKind } = {}
): AnchorRow[] {
  let sql = 'SELECT * FROM drift_anchors WHERE 1=1';
  const params: any[] = [];
  if (opts.status) {
    sql += ' AND status = ?';
    params.push(opts.status);
  }
  if (opts.kind) {
    sql += ' AND kind = ?';
    params.push(opts.kind);
  }
  // Most entrenched first (human > explicit), then newest.
  sql += " ORDER BY (tier = 'human') DESC, created_at DESC";
  return (db.prepare(sql).all(...params) as any[]).map(hydrate);
}

/** Retire an anchor so the detector stops firing it, without losing history (minimal change). */
export function retireAnchor(db: Database.Database, id: number): boolean {
  const r = db
    .prepare("UPDATE drift_anchors SET status = 'retired', updated_at = unixepoch() WHERE id = ? AND status = 'active'")
    .run(id);
  return r.changes > 0;
}

// ── v9: ProjectCoreNode write-path (Current Truth Map) ────────────────────────
// An anchor IS a ProjectCoreNode. setNodeFields writes the v9 fields (node_type, domain,
// decision_mode, lifecycle, validity_scope, card_policy[incl cadence_days/stale_threshold_days],
// reality_manifestations, review_after, last_confirmed_at, owner, confidence) onto an existing
// node — used to backfill legacy anchors + to set fields on freshly-declared nodes. Only the
// provided fields are written (partial update). decision_mode is the ROUTER (constraint→file-scan,
// commitment→heartbeat, hypothesis→review-date, source_of_truth→conflict, metric→threshold).
export interface NodeFields {
  node_type?: string;
  domain?: string;
  decision_mode?: string;
  confidence?: number;
  lifecycle?: string;
  validity_scope?: Record<string, unknown>;
  card_policy?: Record<string, unknown>; // incl cadence_days, stale_threshold_days, severity_if_broken, cooldown_days
  reality_manifestations?: unknown[];
  review_after?: number;
  last_confirmed_at?: number;
  owner?: string;
}

// ⑧ read side: the active Current-Truth slice for read_smart("current truth for X").
// Returns ONLY active nodes (the desired-state), token-cheap, optionally scoped by domain/mode.
export function getCurrentTruth(
  db: Database.Database,
  opts: { domain?: string; decision_mode?: string } = {}
): any[] {
  let sql =
    "SELECT id, node_type, domain, decision_mode, statement, rationale, confidence, lifecycle, card_policy, review_after FROM drift_anchors WHERE status = 'active'";
  const p: any[] = [];
  if (opts.domain) { sql += ' AND domain = ?'; p.push(opts.domain); }
  if (opts.decision_mode) { sql += ' AND decision_mode = ?'; p.push(opts.decision_mode); }
  sql += " ORDER BY (decision_mode = 'source_of_truth') DESC, domain, id";
  return db.prepare(sql).all(...p) as any[];
}

export function setNodeFields(db: Database.Database, id: number, f: NodeFields): boolean {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  const put = (col: string, val: unknown) => { sets.push(`${col} = @${col}`); params[col] = val; };
  if (f.node_type !== undefined) put('node_type', f.node_type);
  if (f.domain !== undefined) put('domain', f.domain);
  if (f.decision_mode !== undefined) put('decision_mode', f.decision_mode);
  if (f.confidence !== undefined) put('confidence', f.confidence);
  if (f.lifecycle !== undefined) put('lifecycle', f.lifecycle);
  if (f.validity_scope !== undefined) put('validity_scope', JSON.stringify(f.validity_scope));
  if (f.card_policy !== undefined) put('card_policy', JSON.stringify(f.card_policy));
  if (f.reality_manifestations !== undefined) put('reality_manifestations', JSON.stringify(f.reality_manifestations));
  if (f.review_after !== undefined) put('review_after', f.review_after);
  if (f.last_confirmed_at !== undefined) put('last_confirmed_at', f.last_confirmed_at);
  if (f.owner !== undefined) put('owner', f.owner);
  if (sets.length === 0) return false;
  const r = db
    .prepare(`UPDATE drift_anchors SET ${sets.join(', ')}, updated_at = unixepoch() WHERE id = @id`)
    .run(params);
  return r.changes > 0;
}

// ── AlertPolicy — the noise/precision floor (the "ユーザーが逃げない" guardrail) ──
// Stored in meta (key='alert_policy'). The reconcile/judge MUST honor it: a Soft card that
// can't cite BOTH sides, or is below min confidence, is NOT surfaced — it goes to the
// candidate box. Volume is capped. 週に本物1個 ＞ 毎日ノイズ20個.
export interface AlertPolicy {
  max_cards_per_day: number;
  max_soft_cards_per_week: number;
  min_confidence_for_soft_card: number;
  require_two_sided_evidence: boolean;
}
const DEFAULT_ALERT_POLICY: AlertPolicy = {
  max_cards_per_day: 5,
  max_soft_cards_per_week: 3,
  min_confidence_for_soft_card: 0.55,
  require_two_sided_evidence: true,
};
export function getAlertPolicy(db: Database.Database): AlertPolicy {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'alert_policy'").get() as { value: string } | undefined;
  if (!row) return { ...DEFAULT_ALERT_POLICY };
  try {
    return { ...DEFAULT_ALERT_POLICY, ...JSON.parse(row.value) };
  } catch {
    return { ...DEFAULT_ALERT_POLICY };
  }
}
export function setAlertPolicy(db: Database.Database, partial: Partial<AlertPolicy>): AlertPolicy {
  const merged = { ...getAlertPolicy(db), ...partial };
  db.prepare("INSERT INTO meta (key, value) VALUES ('alert_policy', @v) ON CONFLICT(key) DO UPDATE SET value = @v").run({
    v: JSON.stringify(merged),
  });
  return merged;
}
