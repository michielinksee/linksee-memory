// Re-injection guard (the "6th pillar" — active observability). The post-hoc detector
// (drift-detection.ts) answers "did reality drift from a declared anchor?" AFTER the fact, into
// drift_edges. This module answers "is the action ABOUT to be taken in scope of / contradicting an
// accepted anchor?" BEFORE the fact, and re-surfaces that anchor into the agent's context. Pre vs
// post: the gate writes ONLY injection_log, never drift_edges — the two streams stay separate and
// rejoin in `dream`.
//
// Enforcement lives OUTSIDE the agent's volition (a Claude Code PreToolUse hook calls this via the
// guard-hook bin), because the load-bearing pain — "Claude read the rule, understood it, still used
// cp" (anthropics/claude-code#15443) — is precisely the case where the agent will NOT self-check.
//
// FAIL-OPEN by construction: every DB op is best-effort; only an explicit 'hard' contradiction yields
// a block. Lexical only (no embeddings): reuses lexical-match.ts (the same logic as the detector).

import type Database from 'better-sqlite3';
import { normPath, compileGlob, parseArray, matchViolation, SCRAPE_ANCHOR } from './lexical-match.js';

// "accepted = the only thing the gate compares against": declared (status active), still live
// (lifecycle active|experiment — NOT at_risk/superseded/deprecated), and not explicitly card-disabled.
// at_risk(stale) anchors deliberately DON'T gate — we don't enforce a rule we're no longer sure of.
const ACCEPTED_SQL = `status = 'active'
  AND lifecycle IN ('active', 'experiment')
  AND COALESCE(json_extract(card_policy, '$.enabled'), 1) != 0`;

export type GateMode = 'off' | 'soft' | 'hard';
export type GateLevel = 'allow' | 'inform' | 'warn' | 'block';

export interface AcceptedAnchor {
  id: number;
  kind: string;
  statement: string;
  rationale: string | null;
  affects: string;
  detect_terms: string;
  violation_signal: string;
  card_policy: string;
}

export interface GateMatch {
  anchor_id: number;
  statement: string;
  rationale: string | null;
  verdict: 'contradicts' | 'in_scope';
  why: string;
  gate_mode: GateMode;
}

export interface GateResult {
  gate: GateLevel;
  matched: GateMatch[];
  reinject: string;
}

export interface ActionInput {
  tool?: string;
  file_path?: string;
  files?: string[];
  command?: string;
  content?: string;
  diff?: string;
  action?: string;
}

interface ActionCtx {
  tool: string;
  files: string[];
  lines: string[]; // raw, trimmed, non-empty — fed to matchViolation
  haystack: string; // lowercased blob — fed to detect_terms substring scoping
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

function jsonGet<T>(json: string | null | undefined, key: string, def: T): T {
  try {
    const o = JSON.parse(json || '{}');
    return o && o[key] !== undefined && o[key] !== null ? (o[key] as T) : def;
  } catch {
    return def;
  }
}

function bestEffort(fn: () => void): void {
  try {
    fn();
  } catch {
    /* logging/telemetry must NEVER block the gate */
  }
}

export function acceptedAnchors(db: Database.Database): AcceptedAnchor[] {
  return db
    .prepare(
      `SELECT id, kind, statement, rationale, affects, detect_terms, violation_signal, card_policy
         FROM drift_anchors WHERE ${ACCEPTED_SQL}`
    )
    .all() as AcceptedAnchor[];
}

function buildActionCtx(input: ActionInput): ActionCtx {
  const files: string[] = [];
  if (input.file_path) files.push(input.file_path);
  if (Array.isArray(input.files)) files.push(...input.files);

  const rawParts = [input.command, input.diff, input.content, input.action].filter(
    (x): x is string => typeof x === 'string' && x.length > 0
  );

  const lines: string[] = [];
  for (const part of rawParts) {
    for (const ln of part.split(/\r?\n/)) {
      const t = ln.trim();
      if (t) lines.push(t);
    }
  }

  const haystack = [...files.map(normPath), ...rawParts].join('\n').toLowerCase();
  return { tool: input.tool ?? 'unknown', files, lines, haystack };
}

export function matchAction(db: Database.Database, act: ActionCtx): GateMatch[] {
  const out: GateMatch[] = [];

  for (const a of acceptedAnchors(db)) {
    const gate_mode = jsonGet<GateMode>(a.card_policy, 'gate_mode', 'soft');
    if (gate_mode === 'off') continue;

    const globs = parseArray(a.affects).map(compileGlob);
    const terms = parseArray(a.detect_terms)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const signals = parseArray(a.violation_signal)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const hasScope = globs.length > 0;

    const pathHit = hasScope && act.files.some((f) => {
      const p = normPath(f);
      return globs.some((g) => g(p));
    });
    const termHit = terms.length > 0 && terms.some((t) => act.haystack.includes(t));

    const isScrape = SCRAPE_ANCHOR.test(a.statement);
    let sigHit: string | null = null;
    if (signals.length > 0) {
      for (const line of act.lines) {
        const hit = matchViolation(line, line.toLowerCase(), signals, isScrape);
        if (hit) {
          sigHit = hit;
          break;
        }
      }
    }

    // Scope (mirrors the detector): a path-scoped anchor requires the action to touch an in-scope
    // file; a global anchor (no affects) fires on topical-term OR forbidden-signal relevance.
    const inScope = hasScope ? pathHit : termHit || sigHit != null;
    if (!inScope) continue;

    out.push({
      anchor_id: a.id,
      statement: a.statement,
      rationale: a.rationale,
      verdict: sigHit ? 'contradicts' : 'in_scope',
      why: sigHit
        ? `your action contains \`${sigHit}\``
        : pathHit
          ? `touches a file under this decision's scope`
          : `matches this decision's topic`,
      gate_mode,
    });
  }

  // contradicts first (the headline), then in_scope.
  return out.sort(
    (x, y) => (y.verdict === 'contradicts' ? 1 : 0) - (x.verdict === 'contradicts' ? 1 : 0)
  );
}

function withinCooldown(db: Database.Database, anchorId: number, sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  const minutes = jsonGet<number>(
    (db.prepare(`SELECT card_policy FROM drift_anchors WHERE id = ?`).get(anchorId) as { card_policy?: string } | undefined)
      ?.card_policy,
    'reinject_cooldown_min',
    30
  );
  const cutoff = nowSec() - minutes * 60;
  const row = db
    .prepare(
      `SELECT 1 FROM injection_log WHERE anchor_id = ? AND session_id = ? AND occurred_at >= ? LIMIT 1`
    )
    .get(anchorId, sessionId, cutoff);
  return !!row;
}

function logInjection(
  db: Database.Database,
  matches: GateMatch[],
  act: ActionCtx,
  surface: GateLevel,
  sessionId: string | undefined
): void {
  const ins = db.prepare(
    `INSERT INTO injection_log (anchor_id, session_id, trigger, surface, tool_name, action_snip, verdict)
     VALUES (?, ?, 'gate', ?, ?, ?, ?)`
  );
  const snip = (act.lines[0] ?? '').slice(0, 120);
  const tx = db.transaction(() => {
    for (const m of matches) ins.run(m.anchor_id, sessionId ?? null, surface, act.tool, snip, m.verdict);
  });
  tx();
}

export function gateAction(db: Database.Database, input: ActionInput, opts: { sessionId?: string } = {}): GateResult {
  const act = buildActionCtx(input);
  let matches = matchAction(db, act);
  if (matches.length === 0) return { gate: 'allow', matched: [], reinject: '' };

  const contradictions = matches.filter((m) => m.verdict === 'contradicts');
  let gate: GateLevel = contradictions.length > 0 ? 'warn' : 'inform';
  if (contradictions.some((m) => m.gate_mode === 'hard')) gate = 'block';

  // Cooldown applies ONLY to pure-informational re-injection (no contradiction). A real contradiction
  // is surfaced every single time — an ignored rule must not be silenced by a timer.
  if (gate === 'inform') {
    matches = matches.filter((m) => !withinCooldown(db, m.anchor_id, opts.sessionId));
    if (matches.length === 0) return { gate: 'allow', matched: [], reinject: '' };
  }

  const shown = matches.slice(0, 4);
  const reinject = formatReinject(shown, gate);
  bestEffort(() => logInjection(db, shown, act, gate, opts.sessionId));
  return { gate, matched: shown, reinject };
}

export function formatReinject(matches: GateMatch[], gate: GateLevel): string {
  const head =
    gate === 'block'
      ? '⛔ Blocked — this action breaks a decision you locked earlier.'
      : gate === 'warn'
        ? '⚠ Heads up — this action contradicts a decision you locked earlier.'
        : 'ℹ Reminder — you have an active decision covering what you are about to touch.';

  const body = matches.map((m) => {
    const rationale = m.rationale ? ` — ${m.rationale}` : '';
    const tail = m.verdict === 'contradicts' ? `${m.why} → contradicts it.` : `${m.why}.`;
    return `• [#${m.anchor_id}] "${m.statement}"${rationale}\n  ↳ ${tail}`;
  });

  const firstContra = matches.find((m) => m.verdict === 'contradicts');
  const foot = firstContra
    ? `\nIf you are intentionally changing this decision, supersede it on the record:\n  resolve_drift(anchor_id: ${firstContra.anchor_id}, action: 'supersede', superseded_by: <new anchor>).`
    : '';

  return [head, ...body, foot].filter(Boolean).join('\n');
}

// SessionStart boot digest — re-load the accepted anchors + open forks into a fresh session, killing
// cross-session amnesia ("groundhog day"). Kept small (top-N) and budget-bounded by caller.
export function buildBootDigest(
  db: Database.Database,
  opts: { maxAnchors?: number; maxForks?: number } = {}
): { text: string; anchors: number; forks: number; distill: number } {
  const maxAnchors = opts.maxAnchors ?? 8;
  const maxForks = opts.maxForks ?? 5;

  const anchors = db
    .prepare(
      `SELECT id, statement, rationale FROM drift_anchors
         WHERE ${ACCEPTED_SQL} AND kind IN ('prohibition', 'decision', 'constraint')
         ORDER BY confidence DESC, updated_at DESC LIMIT ?`
    )
    .all(maxAnchors) as Array<{ id: number; statement: string; rationale: string | null }>;

  const forks = db
    .prepare(
      `SELECT c.id, c.rationale, a.statement
         FROM memory_write_candidates c
         LEFT JOIN drift_anchors a ON a.id = c.target_node_id
         WHERE c.scope = 'orphaned_proposal' AND c.status = 'pending_review'
         ORDER BY c.created_at DESC LIMIT ?`
    )
    .all(maxForks) as Array<{ id: number; rationale: string; statement: string | null }>;

  // Distillation pressure — the routine's structural trigger. The drain must not depend on
  // the agent remembering to dream (#15443 lesson): while raw auto-captured memories exist,
  // EVERY session boot says so. Inflow (new sessions) vs drain (8/dream) stays visible.
  let distill = 0;
  try {
    distill = (
      db.prepare(
        `SELECT COUNT(*) AS n FROM memories
          WHERE layer IN ('learning', 'caveat') AND json_valid(content)
            AND (json_extract(content, '$.needs_distill') = 1
                 OR json_extract(content, '$.why') = 'Decision detected by pattern match — may need agent enrichment'
                 OR json_extract(content, '$.why') = 'User-stated warning/prohibition — auto-extracted by caveat pattern match')`
      ).get() as { n: number }
    ).n;
  } catch {
    /* digest must never fail on the nudge */
  }

  if (anchors.length === 0 && forks.length === 0 && distill === 0)
    return { text: '', anchors: 0, forks: 0, distill: 0 };

  const parts: string[] = [];
  if (anchors.length > 0) {
    parts.push('📌 Linksee — decisions you locked (still in force):');
    for (const a of anchors) parts.push(`• [#${a.id}] "${a.statement}"${a.rationale ? ` — ${a.rationale}` : ''}`);
  }
  if (forks.length > 0) {
    parts.push('', '🔀 Open forks still awaiting your call:');
    for (const f of forks) parts.push(`• ${f.statement ?? f.rationale}`);
  }
  if (distill > 0) {
    parts.push(
      '',
      `🧪 ${distill} auto-captured memories are still raw utterances — call dream() and rewrite the distill_queue via remember(memory_id, content) with "distilled": true.`
    );
  }
  if (anchors.length > 0)
    parts.push('', 'Honor these unless you explicitly supersede them (resolve_drift action=supersede).');
  return { text: parts.join('\n'), anchors: anchors.length, forks: forks.length, distill };
}

// ── Loop closure: re-injection friction → reflection (dream) ───────────────────
// The active-observability stream (injection_log, PRE-action intent) rejoins the post-action reality
// (drift_edges) HERE — so `dream` can see "re-surfaced N×, yet STILL contradicted in the code". That
// co-occurrence is the machine evidence behind #15443: a rule read, re-injected, still ignored.

export interface FrictionItem {
  anchor_id: number;
  statement: string;
  gate_mode: GateMode;
  lifecycle: string;
  gate_contradicts: number; // times re-injected as a contradiction (pre-action intent)
  gate_blocks: number; // times hard-blocked
  ignored: number; // coarse: soft re-injections reality later confirmed as violated (see backfillHeeded)
  reality_contradicts: number; // open drift_edges contradicts for this anchor (post-action reality)
  last_at: string | null;
  signal: 'violated_for_real' | 'gate_holding';
  suggested_action: 'escalate_to_hard' | 'review_or_supersede' | 'none';
  recommendation: string;
}

// Coarse, best-effort heeded backfill (idempotent — only touches heeded IS NULL). heeded=0 when a soft
// re-injection failed to prevent the violation (the anchor still has an OPEN reality contradiction);
// heeded=1 for blocks (the tool was denied) and for soft injections whose anchor's reality is clean.
// Intentionally NOT timestamp-correlated — it powers the "ignored" tally only, never a gating decision.
export function backfillHeeded(db: Database.Database): void {
  bestEffort(() => {
    const live = `SELECT anchor_id FROM drift_edges WHERE verdict = 'contradicts' AND status = 'open'`;
    db.prepare(
      `UPDATE injection_log SET heeded = 0
         WHERE heeded IS NULL AND surface IN ('warn', 'inform') AND verdict = 'contradicts'
           AND anchor_id IN (${live})`
    ).run();
    db.prepare(
      `UPDATE injection_log SET heeded = 1
         WHERE heeded IS NULL AND surface IN ('warn', 'inform')
           AND anchor_id NOT IN (${live})`
    ).run();
    db.prepare(`UPDATE injection_log SET heeded = 1 WHERE heeded IS NULL AND surface = 'block'`).run();
  });
}

// Surface anchors the gate keeps re-injecting. PRIMARY signal = two directly-queryable counts (no fragile
// inference): gate_contradicts (pre-action) × reality_contradicts (post-action). Both > 0 ⇒ re-injection
// isn't holding ⇒ escalate (soft→hard) or review/supersede (if reality has outrun the rule).
export function getReinjectionFriction(
  db: Database.Database,
  opts: { minContradicts?: number } = {}
): FrictionItem[] {
  const minC = opts.minContradicts ?? 3;
  backfillHeeded(db);

  const rows = db
    .prepare(
      `SELECT i.anchor_id,
              SUM(CASE WHEN i.verdict = 'contradicts' THEN 1 ELSE 0 END) AS gate_contradicts,
              SUM(CASE WHEN i.surface = 'block' THEN 1 ELSE 0 END)       AS gate_blocks,
              SUM(CASE WHEN i.heeded = 0 THEN 1 ELSE 0 END)              AS ignored,
              datetime(MAX(i.occurred_at), 'unixepoch')                 AS last_at,
              a.statement, a.lifecycle, a.card_policy
         FROM injection_log i
         JOIN drift_anchors a ON a.id = i.anchor_id
        WHERE a.status = 'active'
        GROUP BY i.anchor_id
       HAVING gate_contradicts >= ?`
    )
    .all(minC) as Array<{
    anchor_id: number;
    gate_contradicts: number;
    gate_blocks: number;
    ignored: number;
    last_at: string | null;
    statement: string;
    lifecycle: string;
    card_policy: string;
  }>;

  const realityStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM drift_edges WHERE anchor_id = ? AND verdict = 'contradicts' AND status = 'open'`
  );

  const out: FrictionItem[] = [];
  for (const r of rows) {
    const gate_mode = jsonGet<GateMode>(r.card_policy, 'gate_mode', 'soft');
    const reality_contradicts = (realityStmt.get(r.anchor_id) as { n: number }).n;

    let signal: FrictionItem['signal'];
    let suggested_action: FrictionItem['suggested_action'];
    let recommendation: string;

    if (reality_contradicts > 0) {
      signal = 'violated_for_real';
      if (gate_mode !== 'hard') {
        suggested_action = 'escalate_to_hard';
        recommendation = `Re-surfaced ${r.gate_contradicts}× yet ${reality_contradicts} contradiction(s) are still live in the code — soft warnings aren't holding. Escalate to gate_mode:'hard', or supersede the anchor if reality has outrun the rule.`;
      } else {
        suggested_action = 'review_or_supersede';
        recommendation = `Hard-gated yet ${reality_contradicts} contradiction(s) persist (pre-existing or overridden) — the rule is fighting reality. Review whether it is still correct; supersede if not.`;
      }
    } else {
      signal = 'gate_holding';
      const heavy = gate_mode !== 'hard' && r.gate_contradicts >= minC * 2;
      suggested_action = heavy ? 'escalate_to_hard' : 'none';
      recommendation = `The gate caught ${r.gate_contradicts} attempt(s) and reality stayed clean — working as intended.${heavy ? " It keeps firing — consider gate_mode:'hard' to stop the attempts at the source." : ''}`;
    }

    out.push({
      anchor_id: r.anchor_id,
      statement: r.statement,
      gate_mode,
      lifecycle: r.lifecycle,
      gate_contradicts: r.gate_contradicts,
      gate_blocks: r.gate_blocks,
      ignored: r.ignored,
      reality_contradicts,
      last_at: r.last_at,
      signal,
      suggested_action,
      recommendation,
    });
  }

  return out.sort(
    (x, y) => y.reality_contradicts - x.reality_contradicts || y.gate_contradicts - x.gate_contradicts
  );
}

// One-call enforcement change — applies the friction "escalate_to_hard" recommendation. Merges gate_mode
// into the anchor's card_policy (preserving other keys). Exposed via resolve_drift(action:'harden'|'soften'),
// NOT a new tool — honoring anchor #1 ("public tools = 3, don't add a 4th"; the surface already drifted to 10).
export function setGateMode(
  db: Database.Database,
  anchorId: number,
  mode: GateMode
): { ok: boolean; anchor_id: number; gate_mode: GateMode; card_policy: Record<string, unknown> } {
  const row = db.prepare(`SELECT card_policy FROM drift_anchors WHERE id = ?`).get(anchorId) as
    | { card_policy?: string }
    | undefined;
  if (!row) throw new Error(`anchor #${anchorId} not found`);
  let policy: Record<string, unknown> = {};
  try {
    policy = JSON.parse(row.card_policy || '{}') || {};
  } catch {
    policy = {};
  }
  policy.gate_mode = mode;
  if (policy.enabled === undefined) policy.enabled = true;
  db.prepare(`UPDATE drift_anchors SET card_policy = ?, updated_at = unixepoch() WHERE id = ?`).run(
    JSON.stringify(policy),
    anchorId
  );
  return { ok: true, anchor_id: anchorId, gate_mode: mode, card_policy: policy };
}
