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
): { text: string; anchors: number; forks: number } {
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

  if (anchors.length === 0 && forks.length === 0) return { text: '', anchors: 0, forks: 0 };

  const parts: string[] = ['📌 Linksee — decisions you locked (still in force):'];
  for (const a of anchors) parts.push(`• [#${a.id}] "${a.statement}"${a.rationale ? ` — ${a.rationale}` : ''}`);
  if (forks.length > 0) {
    parts.push('', '🔀 Open forks still awaiting your call:');
    for (const f of forks) parts.push(`• ${f.statement ?? f.rationale}`);
  }
  parts.push('', 'Honor these unless you explicitly supersede them (resolve_drift action=supersede).');
  return { text: parts.join('\n'), anchors: anchors.length, forks: forks.length };
}
