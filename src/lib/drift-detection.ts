// Drift detection (v8) — the "照合" engine: declared intent (drift_anchors) vs. actual
// reality (session_file_edits). Sibling to edge-detection.ts; must NOT touch it.
//
// Deductive, NOT inferential. A 'contradicts' edge is emitted ONLY when a declared
// violation_signal literally appears inside a file edit that falls within the anchor's
// declared path scope — a citation-backed match, never a gap-guess. Lexical/glob/FTS only:
// there is no embedding layer in this stack (retrieval = trigram FTS5 + BM25), so all
// matching here is substring + path-glob + trigram-FTS by construction.
//
// Verdict vocabulary (Software Reflexion Models, Murphy-Notkin-Sullivan 1995):
//   contradicts = divergence | absent = absence | implements = convergence.
//
// v1 emits contradicts + absent only. 'implements' (low-priority convergence) is part of
// the design but deliberately NOT emitted here: at ~6k edits it would flood the view, and
// its match_strength is underspecified without a violation-signal to ground it. The FTS
// topical scope is still computed — it correctly suppresses false 'absent' for an anchor
// whose reality is reachable only by topic, not path.
//
// Idempotent: contradicts upserts, refreshing confidence/evidence for OPEN rows only, so a
// user's dismissal is never resurrected; absent is INSERT OR IGNORE under the partial unique
// index idx_drift_absent (one open absence per anchor). Run inside the consolidation sweep
// or on a manual trigger.

import type Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';

// ── tuning knobs (design §5) ────────────────────────────────────────────────
const TIER_WEIGHT: Record<string, number> = { human: 1.0, explicit: 0.8 };
const REALITY_TIER_WEIGHT = 0.8; // a real session_file_edit demonstrably happened
const SCOPE_WEIGHT_GLOB = 1.0; // path-glob hit — structural scope, trusted
const SCOPE_WEIGHT_FTS = 0.6; // topical (detect_terms via FTS) scope only
const EMIT_THRESHOLD_DEFAULT = 0.5;
const STALE_DAYS_DEFAULT = 14; // "not done yet ≠ drift" — suppress young anchors' absence
const SECONDS_PER_DAY = 86_400;
const MAX_SAMPLES = 25;
const SAMPLE_BUFFER = 500; // cap collection before the final sort+slice (bounds memory)

export interface DriftSample {
  anchor_id: number;
  kind: string;
  statement: string;
  verdict: 'contradicts' | 'absent';
  confidence: number;
  file_path: string | null;
  hit_term: string | null;
  scope: 'glob' | 'fts' | null;
  occurred_at: number | null;
}

export interface DriftAnchorTally {
  anchor_id: number;
  kind: string;
  statement: string;
  contradicts: number;
  absent: number;
}

export interface DriftDetectionResult {
  anchorsScanned: number;
  editsScanned: number;
  contradicts: number;
  absent: number;
  edgesEmitted: number;
  persisted: boolean;
  byAnchor: DriftAnchorTally[];
  samples: DriftSample[];
}

interface AnchorRow {
  id: number;
  kind: string;
  statement: string;
  affects: string;
  detect_terms: string;
  violation_signal: string;
  tier: string;
  created_at: number;
}

interface EditRow {
  id: number;
  file_path: string;
  context_snippet: string | null;
  memory_id: number | null;
  memory_content: string | null;
  occurred_at: number;
}

function parseArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

// Normalize a path or glob to the detector's canonical form so Windows reality
// (mixed `C:\Users\...` and `C:/Users/...`, mixed case) matches the lowercase forward-slash
// anchor fragments. SQLite GLOB is case-sensitive Unix-glob (no `**`, `*` crosses slashes)
// and unreliable on these paths, so ALL path matching happens here in JS instead.
function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

// Compile an affects glob into a matcher over a normalized path. A glob with no wildcard is
// a plain substring (e.g. "sake_navi", "linksee-memory/src/mcp/server.ts"); `*` matches
// within a path segment, `**` crosses segments — tested unanchored so a fragment matches
// anywhere in the absolute path.
function compileGlob(glob: string): (path: string) => boolean {
  const g = normPath(glob.trim());
  if (!g) return () => false;
  if (!/[*?]/.test(g)) {
    return (path) => path.includes(g);
  }
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const rx = new RegExp(re);
  return (path) => rx.test(path);
}

// Build an FTS5 MATCH query from detect_terms: trigram needs >= 3 chars, each term quoted
// (handles spaces / punctuation / CJK), OR-joined. Returns '' when no term qualifies.
function ftsQuery(terms: string[]): string {
  return terms
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .map((t) => '"' + t.replace(/"/g, '""') + '"')
    .join(' OR ');
}

function tierWeight(tier: string): number {
  return TIER_WEIGHT[tier] ?? REALITY_TIER_WEIGHT;
}

export function detectDrift(
  db: Database.Database,
  opts: { dryRun?: boolean; staleDays?: number; emitThreshold?: number } = {}
): DriftDetectionResult {
  const staleDays = opts.staleDays ?? STALE_DAYS_DEFAULT;
  const emitThreshold = opts.emitThreshold ?? EMIT_THRESHOLD_DEFAULT;
  const now = Math.floor(Date.now() / 1000);

  const res: DriftDetectionResult = {
    anchorsScanned: 0,
    editsScanned: 0,
    contradicts: 0,
    absent: 0,
    edgesEmitted: 0,
    persisted: !opts.dryRun,
    byAnchor: [],
    samples: [],
  };

  const anchors = db
    .prepare(
      `SELECT id, kind, statement, affects, detect_terms, violation_signal, tier, created_at
         FROM drift_anchors WHERE status = 'active'`
    )
    .all() as AnchorRow[];
  res.anchorsScanned = anchors.length;
  if (anchors.length === 0) return res;

  // Reality, loaded once. LEFT JOIN the linked memory so violation_signal matching can see
  // the "why this edit" text, not just path + snippet. (session_file_edits.memory_id →
  // memories.id; memories_fts.rowid = memories.id.)
  const edits = db
    .prepare(
      `SELECT e.id, e.file_path, e.context_snippet, e.memory_id, m.content AS memory_content, e.occurred_at
         FROM session_file_edits e
         LEFT JOIN memories m ON m.id = e.memory_id`
    )
    .all() as EditRow[];
  res.editsScanned = edits.length;

  const editsNorm = edits.map((e) => {
    const pathNorm = normPath(e.file_path);
    return {
      row: e,
      pathNorm,
      haystack: `${pathNorm}\n${e.context_snippet ?? ''}\n${e.memory_content ?? ''}`.toLowerCase(),
    };
  });

  const ftsStmt = db.prepare(`SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?`);

  // Write paths prepared only when persisting — keeps dryRun safe on a readonly connection.
  const upsertContradicts = opts.dryRun
    ? null
    : db.prepare(`
        INSERT INTO drift_edges (anchor_id, edit_id, verdict, confidence, evidence, status)
        VALUES (@anchor_id, @edit_id, 'contradicts', @confidence, @evidence, 'open')
        ON CONFLICT(anchor_id, edit_id, verdict) DO UPDATE SET
          confidence = excluded.confidence,
          evidence   = excluded.evidence
        WHERE drift_edges.status = 'open'
      `);
  const insertAbsent = opts.dryRun
    ? null
    : db.prepare(`
        INSERT OR IGNORE INTO drift_edges (anchor_id, edit_id, verdict, confidence, evidence, status)
        VALUES (@anchor_id, NULL, 'absent', @confidence, @evidence, 'open')
      `);

  const apply = () => {
    for (const a of anchors) {
      const globs = parseArray(a.affects).map(compileGlob);
      const signals = parseArray(a.violation_signal)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const terms = parseArray(a.detect_terms);
      const aW = tierWeight(a.tier);
      const tally: DriftAnchorTally = {
        anchor_id: a.id,
        kind: a.kind,
        statement: a.statement.slice(0, 80),
        contradicts: 0,
        absent: 0,
      };

      // Topical scope: memory rowids whose content matches the anchor's detect_terms.
      let ftsRowids: Set<number> | null = null;
      const q = ftsQuery(terms);
      if (q) {
        try {
          ftsRowids = new Set((ftsStmt.all(q) as Array<{ rowid: number }>).map((r) => r.rowid));
        } catch {
          ftsRowids = null; // malformed query → fall back to glob-only scope
        }
      }

      let scopedCount = 0;
      for (const e of editsNorm) {
        const globHit = globs.length > 0 && globs.some((m) => m(e.pathNorm));
        const ftsHit =
          !globHit && ftsRowids != null && e.row.memory_id != null && ftsRowids.has(e.row.memory_id);
        if (!globHit && !ftsHit) continue;
        scopedCount++;

        // Deduce a contradiction: a declared forbidden term literally present in scope text.
        if (signals.length === 0) continue; // e.g. a constraint with no signal — can't deduce contradicts
        const hit = signals.find((s) => e.haystack.includes(s));
        if (!hit) continue;

        const scopeWeight = globHit ? SCOPE_WEIGHT_GLOB : SCOPE_WEIGHT_FTS;
        // confidence = min(tierWeight_anchor, tierWeight_reality) × scopeWeight × signalWeight.
        // signalWeight = 1.0 (the forbidden term is literally present — binary presence).
        const confidence = Math.min(aW, REALITY_TIER_WEIGHT) * scopeWeight;
        if (confidence < emitThreshold) continue; // FTS-only scope (0.48) never clears 0.5 — path scope required

        const evidence = JSON.stringify({
          file_path: e.row.file_path,
          context_snippet: (e.row.context_snippet ?? '').slice(0, 280),
          occurred_at: e.row.occurred_at,
          hit_term: hit,
          scope: globHit ? 'glob' : 'fts',
          matched_terms: terms.slice(0, 8),
          memory_id: e.row.memory_id,
        });

        if (!opts.dryRun) {
          upsertContradicts!.run({ anchor_id: a.id, edit_id: e.row.id, confidence, evidence });
        }
        res.contradicts++;
        tally.contradicts++;
        res.edgesEmitted++;
        if (res.samples.length < SAMPLE_BUFFER) {
          res.samples.push({
            anchor_id: a.id,
            kind: a.kind,
            statement: tally.statement,
            verdict: 'contradicts',
            confidence,
            file_path: e.row.file_path,
            hit_term: hit,
            scope: globHit ? 'glob' : 'fts',
            occurred_at: e.row.occurred_at,
          });
        }
      }

      // Absence: a declared anchor with zero reality in scope, but only once it is old enough
      // that "not built yet" can be ruled out (staleness gate). Confidence is for sort/display
      // only — absence is not confidence-gated (see design §6/§7).
      if (scopedCount === 0) {
        const ageDays = (now - a.created_at) / SECONDS_PER_DAY;
        if (ageDays >= staleDays) {
          const ageFactor = Math.min(1, ageDays / (2 * staleDays));
          const confidence = aW * ageFactor;
          const evidence = JSON.stringify({
            reason: 'no reality in declared scope',
            age_days: Math.round(ageDays),
            stale_days: staleDays,
          });
          if (!opts.dryRun) {
            insertAbsent!.run({ anchor_id: a.id, confidence, evidence });
          }
          res.absent++;
          tally.absent++;
          res.edgesEmitted++;
          if (res.samples.length < SAMPLE_BUFFER) {
            res.samples.push({
              anchor_id: a.id,
              kind: a.kind,
              statement: tally.statement,
              verdict: 'absent',
              confidence,
              file_path: null,
              hit_term: null,
              scope: null,
              occurred_at: null,
            });
          }
        }
      }

      res.byAnchor.push(tally);
    }
  };

  if (opts.dryRun) apply();
  else db.transaction(apply)();

  // contradicts first (the headline verdict), then by descending confidence.
  res.samples.sort((x, y) => {
    if (x.verdict !== y.verdict) return x.verdict === 'contradicts' ? -1 : 1;
    return y.confidence - x.confidence;
  });
  res.samples = res.samples.slice(0, MAX_SAMPLES);
  return res;
}

// ── v2: current-file scan ─────────────────────────────────────────────────────
// detectDrift (above) sees only what a captured edit's SNIPPET window contained — a
// violation whose line was never in a captured snippet is invisible to it (proven on the
// real corpus: `INSERT OR IGNORE INTO services` sat in current files yet returned 0). This
// pass closes the gap: for each anchor it reads the CURRENT contents of the files under its
// affects scope and flags any (non-comment) line containing a violation_signal — the
// strongest citation possible: the live file:line. Candidate files are grounded in
// session_file_edits (so we know where the affects files actually live on disk); code
// extensions only; most-recent first; capped per anchor. Purely additive — detectDrift is
// untouched. Comment lines are skipped so a doc-mention of a forbidden term isn't a hit.
// Prose (.md/.html) DESCRIBES rules; it is not where a code/operational constraint is *violated*.
// Scanning it produced false positives (a SKILL.md line literally saying "NOT raw chat"). Code only.
const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.sql', '.py', '.go', '.rs',
  '.java', '.rb', '.php', '.sh', '.yml', '.yaml', '.toml', '.env',
]);
const MAX_FILES_PER_ANCHOR = 400;
const COMMENT_PREFIXES = ['//', '*', '/*', '#', '<!--', '--'];

// ── precision guards ─────────────────────────────────────────────────────────
// A raw substring of a forbidden term is too weak a notion of "violation". On the real corpus
// the bare-substring match produced ~90% false positives in three classes; reject each deductively:
//   1. sub-token — "forget" inside "forgetting" / "decideForgetting"        → word-boundary match
//   2. negated   — the line FORBIDS the term ("...NOT raw chat", "…禁止")     → negation window before
//   3. citation  — a scrape-prohibition's host appears only as a stored value → require a real net call
//                  ('cosmetic-info.jp' as a provenance label is not a fetch of it)
const NEGATION_NEAR = /\b(?:not|never|no\s+longer|don'?t|do\s+not|avoid|without)\b|禁止|しない|させない|不可|避け|してはいけない|ではなく/i;
const SCRAPE_ANCHOR = /crawl|scrap|robots|クロール|スクレイピング|スクレイプ|自動収集|自動巡回/i;
const NET_CALL = /\b(?:fetch|axios|requests?|urllib|httpx|curl|wget|got|puppeteer|playwright|cheerio|beautifulsoup|selenium|crawl|scrape|scraping)\b|クロール|スクレイピング/i;

// Locate a signal: ASCII signals must hit on a word boundary; CJK (no boundaries) stays substring.
function signalIndex(lowerLine: string, signal: string): number {
  if (/^[\x20-\x7e]+$/.test(signal)) {
    const esc = signal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?<![a-z0-9_])${esc}(?![a-z0-9_])`).exec(lowerLine);
    return m ? m.index : -1;
  }
  return lowerLine.indexOf(signal);
}

// Deductive violation match with the three precision guards applied (returns the hit term or null).
function matchViolation(rawLine: string, lowerLine: string, signals: string[], isScrapeAnchor: boolean): string | null {
  for (const s of signals) {
    const idx = signalIndex(lowerLine, s);
    if (idx < 0) continue;                                                          // 1. word-boundary
    if (NEGATION_NEAR.test(rawLine.slice(Math.max(0, idx - 24), idx))) continue;    // 2. negated context
    if (isScrapeAnchor && !NET_CALL.test(rawLine)) continue;                        // 3. citation, no net call
    return s;
  }
  return null;
}

export interface FileViolationSample {
  anchor_id: number;
  kind: string;
  statement: string;
  file_path: string;
  line_no: number;
  line_text: string;
  hit_term: string;
  confidence: number;
}

export interface FileViolationResult {
  persisted: boolean;
  anchorsScanned: number;
  filesScanned: number;
  anchorsCapped: number;
  contradicts: number;
  edgesEmitted: number;
  byAnchor: Array<{ anchor_id: number; statement: string; contradicts: number }>;
  samples: FileViolationSample[];
}

export function detectFileViolations(
  db: Database.Database,
  opts: { dryRun?: boolean; emitThreshold?: number } = {}
): FileViolationResult {
  const emitThreshold = opts.emitThreshold ?? EMIT_THRESHOLD_DEFAULT;
  const res: FileViolationResult = {
    persisted: !opts.dryRun,
    anchorsScanned: 0,
    filesScanned: 0,
    anchorsCapped: 0,
    contradicts: 0,
    edgesEmitted: 0,
    byAnchor: [],
    samples: [],
  };

  const anchors = db
    .prepare(
      `SELECT id, kind, statement, affects, violation_signal, detect_terms, tier FROM drift_anchors WHERE status = 'active'`
    )
    .all() as Array<{ id: number; kind: string; statement: string; affects: string; violation_signal: string; detect_terms: string; tier: string }>;
  res.anchorsScanned = anchors.length;
  if (anchors.length === 0) return res;

  // Distinct edited file paths + latest edit id per path. edit_id grounds the edge in a real
  // row (FK + occurred_at); the CURRENT violating line lives in the evidence (current_file).
  const pathRows = db
    .prepare(`SELECT file_path, MAX(id) AS latest_edit_id FROM session_file_edits GROUP BY file_path`)
    .all() as Array<{ file_path: string; latest_edit_id: number }>;

  const upsert = opts.dryRun
    ? null
    : db.prepare(`
        INSERT INTO drift_edges (anchor_id, edit_id, verdict, confidence, evidence, status)
        VALUES (@anchor_id, @edit_id, 'contradicts', @confidence, @evidence, 'open')
        ON CONFLICT(anchor_id, edit_id, verdict) DO UPDATE SET
          confidence = excluded.confidence,
          evidence   = excluded.evidence
        WHERE drift_edges.status = 'open'
      `);

  const apply = () => {
    for (const a of anchors) {
      const globs = parseArray(a.affects).map(compileGlob);
      if (globs.length === 0) continue;
      const signals = parseArray(a.violation_signal).map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (signals.length === 0) continue; // no signal → can't deduce a contradiction
      const terms = parseArray(a.detect_terms);
      const isScrapeAnchor = SCRAPE_ANCHOR.test(a.statement);
      const aW = tierWeight(a.tier);
      const confidence = Math.min(aW, REALITY_TIER_WEIGHT) * SCOPE_WEIGHT_GLOB;
      if (confidence < emitThreshold) continue;

      let candidates = pathRows.filter((r) => {
        const p = normPath(r.file_path);
        return CODE_EXT.has(extname(p)) && globs.some((g) => g(p));
      });
      candidates.sort((x, y) => y.latest_edit_id - x.latest_edit_id);
      if (candidates.length > MAX_FILES_PER_ANCHOR) {
        res.anchorsCapped++;
        candidates = candidates.slice(0, MAX_FILES_PER_ANCHOR);
      }

      const tally = { anchor_id: a.id, statement: a.statement.slice(0, 80), contradicts: 0 };
      for (const c of candidates) {
        if (!existsSync(c.file_path)) continue; // deleted since the edit
        let content: string;
        try {
          content = readFileSync(c.file_path, 'utf8');
        } catch {
          continue;
        }
        res.filesScanned++;
        const lines = content.split(/\r?\n/);
        let found: { line_no: number; line_text: string; hit: string } | null = null;
        for (let i = 0; i < lines.length; i++) {
          const trimmed = lines[i].trim();
          if (!trimmed) continue;
          if (COMMENT_PREFIXES.some((p) => trimmed.startsWith(p))) continue; // skip comments
          const ll = trimmed.toLowerCase();
          const hit = matchViolation(trimmed, ll, signals, isScrapeAnchor);
          if (hit) {
            found = { line_no: i + 1, line_text: trimmed.slice(0, 280), hit };
            break; // one edge per (anchor, file): first real hit
          }
        }
        if (!found) continue;

        const evidence = JSON.stringify({
          file_path: c.file_path,
          line_no: found.line_no,
          context_snippet: found.line_text,
          current_file: true,
          hit_term: found.hit,
          scope: 'file',
          matched_terms: terms.slice(0, 8),
        });
        if (!opts.dryRun) {
          upsert!.run({ anchor_id: a.id, edit_id: c.latest_edit_id, confidence, evidence });
        }
        res.contradicts++;
        tally.contradicts++;
        res.edgesEmitted++;
        if (res.samples.length < 60) {
          res.samples.push({
            anchor_id: a.id,
            kind: a.kind,
            statement: tally.statement,
            file_path: c.file_path,
            line_no: found.line_no,
            line_text: found.line_text,
            hit_term: found.hit,
            confidence,
          });
        }
      }
      if (tally.contradicts > 0) res.byAnchor.push(tally);
    }
  };

  if (opts.dryRun) apply();
  else db.transaction(apply)();
  return res;
}
