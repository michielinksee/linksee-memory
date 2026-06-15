// ── Reconciler (Product Drift OS spec v3 §6) ──────────────────────────────────
// Overlays a LIVE verdict on Map nodes by checking declared intent against actual
// reality. v1 verifies what is LOCALLY checkable: code signals + file presence.
// Each node opts in via a `reality` declaration; nodes without one (or marked
// `external`) keep their hand-declared status — the scanner does not guess.
//
// This is where a hand-declared suspect meets the ground truth: declare
// "telemetry-contract: not implemented", scan the code, find sendTelemetry →
// the suspect is REFUTED (convergence). The Map self-corrects.
import type Database from 'better-sqlite3';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

export type Verdict = 'convergence' | 'divergence' | 'absence';
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.sql', '.py', '.go', '.rs', '.java', '.rb', '.php', '.sh']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.next', 'coverage', 'build']);
const COMMENT_PREFIXES = ['//', '*', '/*', '#', '<!--', '--'];
const MAX_FILES = 4000;

type CheckKind = 'signal_present' | 'signal_absent' | 'regex_present' | 'regex_absent' | 'file_present' | 'file_absent' | 'section_contains';
interface Check {
  claim: string;           // human-readable claim this check verifies (shown in `explain`)
  kind: CheckKind;
  dir?: string;            // subtree to scan (code; comments skipped)
  path?: string;           // single file to scan or test for existence (any type; e.g. README.md)
  signal?: string[];       // terms to look for (signal_* / section_contains)
  pattern?: string;        // JS regex source (regex_*) — for "string present but meaning differs"
  section?: string;        // (section_contains) markdown header to scope the search to (e.g. "Tools")
}
interface Reality {
  kind?: CheckKind | 'external';   // single-check shorthand (back-compat)
  dir?: string;
  path?: string;
  signal?: string[];
  checks?: Check[];        // NEW: multiple named claims, each → ✓/✗ with evidence
  why?: string;            // authored one-line WHY (else derived from failing checks)
  fix?: string[];          // authored FIX options
  expected?: string;       // (external) what a passing state looks like
  check?: string;          // (external) the manual step to verify it
}
export interface CheckResult { claim: string; ok: boolean; file: string | null; line: number | null; detail: string }
export interface NodeVerdict {
  id: string;
  status: string;          // declared status
  verdict: Verdict | null; // null = not locally checkable (external / no reality)
  reason: string;
  why: string | null;      // one-line WHY (authored or derived from failing checks)
  fix: string[];           // FIX options
  checks: CheckResult[];   // per-claim ✓/✗ breakdown (for `explain`)
  evidence: Record<string, unknown>;
  flipped: boolean;        // declared suspect but reality disagrees (or vice-versa)
}
export interface ReconcileResult {
  project: string;
  checked: number;
  external: number;
  verdicts: NodeVerdict[];
  refuted: NodeVerdict[];  // hand-declared suspect → reality says convergence
  confirmed: NodeVerdict[]; // hand-declared suspect → reality agrees (divergence/absence)
}

function signalHit(line: string, signals: string[], skipComments: boolean): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // For CODE scans, a comment MENTIONS a term but doesn't realize it — skip. For DOC
  // scans (README etc.) the content IS in those lines, so don't skip.
  if (skipComments && COMMENT_PREFIXES.some((p) => trimmed.startsWith(p))) return null;
  const lower = trimmed.toLowerCase();
  for (const s of signals) {
    const sl = s.toLowerCase();
    if (/^[\x20-\x7e]+$/.test(sl)) {
      const esc = sl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?<![a-z0-9_])${esc}(?![a-z0-9_])`).test(lower)) return s;
    } else if (lower.includes(sl)) return s;
  }
  return null;
}

type Hit = { file: string; line_no: number; line_text: string; hit: string };

// Scan a single file (any type; e.g. README.md) for the first signal match.
function scanFileForSignal(file: string, signals: string[], skipComments: boolean): Hit | null {
  return scanFile(file, (line) => signalHit(line, signals, skipComments));
}
// Scan a single file for the first regex match (meaning-aware: "where_am_i\s+.*(tool|MCP)").
function scanFileForRegex(file: string, re: RegExp, skipComments: boolean): Hit | null {
  return scanFile(file, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    if (skipComments && COMMENT_PREFIXES.some((p) => trimmed.startsWith(p))) return null;
    const m = re.exec(trimmed);
    return m ? m[0].slice(0, 60) : null;
  });
}
function scanFile(file: string, match: (line: string) => string | null): Hit | null {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const hit = match(lines[i]);
    if (hit) return { file, line_no: i + 1, line_text: lines[i].trim().slice(0, 200), hit };
  }
  return null;
}

// Walk a code subtree, applying a per-file matcher (comments skipped). Returns first hit or null.
function scanDir(root: string, perFile: (file: string) => Hit | null): Hit | null {
  let scanned = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) stack.push(full); continue; }
      if (!CODE_EXT.has(extname(name))) continue;
      if (++scanned > MAX_FILES) return null;
      const hit = perFile(full);
      if (hit) return hit;
    }
  }
  return null;
}
const scanForSignal = (root: string, signals: string[]) => scanDir(root, (f) => scanFileForSignal(f, signals, true));
const scanForRegex = (root: string, re: RegExp) => scanDir(root, (f) => scanFileForRegex(f, re, true));

// Scan ONLY within a named markdown section (header containing `section`, until the next
// same-or-higher header). Beats a bare substring: "where_am_i" must be IN the Tools section,
// not merely somewhere in the file (e.g. next to "未対応です").
function scanSection(file: string, section: string, signals: string[]): Hit | null {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  const want = section.toLowerCase();
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i].trim());
    if (m && m[2].toLowerCase().includes(want)) { start = i; level = m[1].length; break; }
  }
  if (start < 0) return null; // section not found at all
  for (let i = start + 1; i < lines.length; i++) {
    const h = /^(#{1,6})\s+/.exec(lines[i].trim());
    if (h && h[1].length <= level) break; // reached the end of this section
    const hit = signalHit(lines[i], signals, false);
    if (hit) return { file, line_no: i + 1, line_text: lines[i].trim().slice(0, 200), hit };
  }
  return null;
}

// Run ONE check → ✓/✗ with evidence. path-targeted scans don't skip comments (docs).
function runCheck(check: Check, repoRoot: string): CheckResult {
  if (check.kind === 'file_present' || check.kind === 'file_absent') {
    const present = check.path ? existsSync(join(repoRoot, check.path)) : false;
    const ok = check.kind === 'file_present' ? present : !present;
    return { claim: check.claim, ok, file: check.path ?? null, line: null, detail: present ? 'file present' : 'file absent' };
  }
  // regex check — meaning-aware ("where_am_i\s+.*(tool|MCP)"), beats a bare substring
  if (check.kind === 'regex_present' || check.kind === 'regex_absent') {
    let re: RegExp;
    try { re = new RegExp(check.pattern ?? '', 'i'); } catch { return { claim: check.claim, ok: false, file: null, line: null, detail: `bad regex: ${check.pattern}` }; }
    const hit = check.path ? scanFileForRegex(join(repoRoot, check.path), re, false) : scanForRegex(join(repoRoot, check.dir ?? '.'), re);
    const found = hit != null;
    const ok = check.kind === 'regex_present' ? found : !found;
    return {
      claim: check.claim, ok, file: hit ? hit.file : (check.path ?? check.dir ?? null), line: hit ? hit.line_no : null,
      detail: found ? `matched /${check.pattern}/` : `/${check.pattern}/ not matched`,
    };
  }
  const signals = (check.signal ?? []).filter(Boolean);
  // section_contains — the signal must appear inside a named markdown section
  if (check.kind === 'section_contains') {
    const hit = check.path ? scanSection(join(repoRoot, check.path), check.section ?? '', signals) : null;
    return {
      claim: check.claim, ok: hit != null, file: hit ? hit.file : (check.path ?? null), line: hit ? hit.line_no : null,
      detail: hit ? `found "${hit.hit}" in section "${check.section}"` : `"${signals.join(', ')}" not in section "${check.section}"`,
    };
  }
  // signal scan: a single path (doc, no comment-skip) or a code subtree (comment-skip)
  const hit = check.path
    ? scanFileForSignal(join(repoRoot, check.path), signals, false)
    : scanForSignal(join(repoRoot, check.dir ?? '.'), signals);
  const found = hit != null;
  const ok = check.kind === 'signal_present' ? found : !found;
  return {
    claim: check.claim, ok,
    file: hit ? hit.file : (check.path ?? check.dir ?? null), line: hit ? hit.line_no : null,
    detail: found ? `found "${hit!.hit}"` : `"${signals.join(', ')}" not found`,
  };
}

interface EvalResult { verdict: Verdict | null; reason: string; why: string | null; fix: string[]; checks: CheckResult[]; expected: string | null; check: string | null }

function evaluate(reality: Reality, repoRoot: string): EvalResult {
  if (!reality.kind && !reality.checks) {
    return { verdict: null, reason: 'no reality declaration — stays human-declared', why: null, fix: [], checks: [], expected: null, check: null };
  }
  if (reality.kind === 'external') {
    return {
      verdict: null, reason: 'external state — not locally verifiable; human-confirmed',
      why: reality.why ?? null, fix: reality.fix ?? [], checks: [],
      expected: reality.expected ?? null, check: reality.check ?? null,
    };
  }
  // Multiple named checks, or one check from the single-kind shorthand (back-compat).
  const checks: Check[] = reality.checks ?? [{
    claim: reality.kind === 'signal_present' ? `code implements: ${(reality.signal ?? []).join(', ')}`
      : reality.kind === 'signal_absent' ? `forbidden absent: ${(reality.signal ?? []).join(', ')}`
      : reality.kind === 'file_present' ? `file present: ${reality.path}`
      : `file absent: ${reality.path}`,
    kind: reality.kind as CheckKind, dir: reality.dir, path: reality.path, signal: reality.signal,
  }];

  const results = checks.map((c) => runCheck(c, repoRoot));
  const failed = results.filter((r) => !r.ok);
  const verdict: Verdict = failed.length === 0 ? 'convergence' : 'divergence';
  const why = reality.why ?? (failed.length === 0
    ? 'all checks pass — reality matches the declaration'
    : `${failed.length} check(s) fail: ${failed.map((f) => f.claim).join('; ')}`);
  const reason = failed.length === 0 ? `verified: ${results.length} check(s) pass` : `${failed.length}/${results.length} checks failed`;
  return { verdict, reason, why, fix: reality.fix ?? [], checks: results, expected: null, check: null };
}

export function reconcile(db: Database.Database, project: string, repoRoot: string): ReconcileResult {
  const rows = db.prepare('SELECT id, status, reality FROM map_nodes WHERE project = ?').all(project) as Array<{ id: string; status: string; reality: string }>;
  const upd = db.prepare('UPDATE map_nodes SET live_verdict = ?, verdict_evidence = ?, reconciled_at = unixepoch() WHERE project = ? AND id = ?');

  const verdicts: NodeVerdict[] = [];
  let checked = 0, external = 0;

  const tx = db.transaction(() => {
    for (const r of rows) {
      let reality: Reality = {};
      try { reality = JSON.parse(r.reality || '{}'); } catch { /* malformed → treat as none */ }
      const { verdict, reason, why, fix, checks, expected, check } = evaluate(reality, repoRoot);
      const firstShown = checks.find((c) => !c.ok) ?? checks[0];
      const evidence: Record<string, unknown> = {
        reason, why, fix, checks, expected, check,
        file: firstShown?.file ?? null, line_no: firstShown?.line ?? null, // compact convenience for the dashboard
      };
      if (verdict === null) { external++; upd.run(null, JSON.stringify(evidence), project, r.id); }
      else { checked++; upd.run(verdict, JSON.stringify(evidence), project, r.id); }

      // "flipped" = hand-declared suspect that reality contradicts (suspect→convergence),
      // or a non-suspect that reality flags (→divergence).
      const flipped = (r.status === 'suspect' && verdict === 'convergence')
        || (r.status !== 'suspect' && verdict === 'divergence');
      verdicts.push({ id: r.id, status: r.status, verdict, reason, why, fix, checks, evidence, flipped });
    }
  });
  tx();

  const refuted = verdicts.filter((v) => v.status === 'suspect' && v.verdict === 'convergence');
  const confirmed = verdicts.filter((v) => v.status === 'suspect' && (v.verdict === 'divergence' || v.verdict === 'absence'));
  return { project, checked, external, verdicts, refuted, confirmed };
}
