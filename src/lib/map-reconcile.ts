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

interface Reality {
  kind?: 'signal_present' | 'signal_absent' | 'file_present' | 'file_absent' | 'external';
  dir?: string;            // subtree to scan (relative to repoRoot)
  path?: string;           // file for file_present/absent
  signal?: string[];       // terms to look for (code lines; comments skipped)
}
export interface NodeVerdict {
  id: string;
  status: string;          // declared status
  verdict: Verdict | null; // null = not locally checkable (external / no reality)
  reason: string;
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

function signalHit(line: string, signals: string[]): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (COMMENT_PREFIXES.some((p) => trimmed.startsWith(p))) return null; // prose/comments describe, don't realize
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

// Walk a subtree for the first code line matching any signal. Returns evidence or null.
function scanForSignal(root: string, signals: string[]): { file: string; line_no: number; line_text: string; hit: string } | null {
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
      let text: string;
      try { text = readFileSync(full, 'utf8'); } catch { continue; }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const hit = signalHit(lines[i], signals);
        if (hit) return { file: full, line_no: i + 1, line_text: lines[i].trim().slice(0, 200), hit };
      }
    }
  }
  return null;
}

function evaluate(reality: Reality, repoRoot: string): { verdict: Verdict | null; reason: string; evidence: Record<string, unknown> } {
  const kind = reality.kind;
  if (!kind || kind === 'external') {
    return { verdict: null, reason: 'external — not locally verifiable; stays human-confirmed', evidence: {} };
  }
  if (kind === 'file_present' || kind === 'file_absent') {
    const p = reality.path ? join(repoRoot, reality.path) : null;
    const present = p ? existsSync(p) : false;
    if (kind === 'file_present') return present
      ? { verdict: 'convergence', reason: `file present: ${reality.path}`, evidence: { path: reality.path } }
      : { verdict: 'absence', reason: `file absent: ${reality.path}`, evidence: { path: reality.path } };
    return present
      ? { verdict: 'divergence', reason: `file present but expected absent: ${reality.path}`, evidence: { path: reality.path } }
      : { verdict: 'convergence', reason: `file absent as expected: ${reality.path}`, evidence: { path: reality.path } };
  }
  // signal_present / signal_absent
  const signals = (reality.signal ?? []).filter(Boolean);
  if (signals.length === 0) return { verdict: null, reason: 'reality.signal empty — cannot check', evidence: {} };
  const dir = join(repoRoot, reality.dir ?? '.');
  const hit = scanForSignal(dir, signals);
  if (kind === 'signal_present') {
    return hit
      ? { verdict: 'convergence', reason: `code signal found: ${hit.hit}`, evidence: hit }
      : { verdict: 'divergence', reason: `code signal NOT found (declared/contract but unimplemented): ${signals.join(', ')}`, evidence: { searched: reality.dir ?? '.', signals } };
  }
  // signal_absent (prohibition style)
  return hit
    ? { verdict: 'divergence', reason: `forbidden signal present: ${hit.hit}`, evidence: hit }
    : { verdict: 'convergence', reason: `forbidden signal absent as expected: ${signals.join(', ')}`, evidence: { searched: reality.dir ?? '.', signals } };
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
      const { verdict, reason, evidence } = evaluate(reality, repoRoot);
      if (verdict === null) { external++; upd.run(null, JSON.stringify({ reason }), project, r.id); }
      else { checked++; upd.run(verdict, JSON.stringify({ reason, ...evidence }), project, r.id); }

      // "flipped" = hand-declared suspect that reality contradicts (suspect→convergence),
      // or a non-suspect that reality flags (→divergence).
      const flipped = (r.status === 'suspect' && verdict === 'convergence')
        || (r.status !== 'suspect' && verdict === 'divergence');
      verdicts.push({ id: r.id, status: r.status, verdict, reason, evidence, flipped });
    }
  });
  tx();

  const refuted = verdicts.filter((v) => v.status === 'suspect' && v.verdict === 'convergence');
  const confirmed = verdicts.filter((v) => v.status === 'suspect' && (v.verdict === 'divergence' || v.verdict === 'absence'));
  return { project, checked, external, verdicts, refuted, confirmed };
}
