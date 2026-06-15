#!/usr/bin/env node
// linksee-memory-map — load the Current Truth Map (map.yaml) into the runtime index
// and answer topology questions. map.yaml is the desired-state source of truth (anchor
// #58); this reconciles it into map_nodes/map_edges (full rebuild per project).
//
// Usage (CLI-first triage, not a list):
//   linksee-memory-map status                # health % + what needs attention now (the triage)
//   linksee-memory-map explain <node>        # WHY this status + ✓/✗ evidence + FIX + AFFECTS (the hero)
//   linksee-memory-map affects <node>        # what to change together if you touch this node
//   linksee-memory-map next                  # the prioritized next fix candidate(s)
//   linksee-memory-map reconcile             # check the hand-written Map against real code/files
//   linksee-memory-map inspect --json        # machine-readable dump (CI / tooling)
//   linksee-memory-map blueprint             # stage×node board (dashboard data)
//   linksee-memory-map [--file map.yaml] [--root <repo>]

import { join } from 'node:path';
import { openDb, runMigrations } from '../db/migrate.js';
import { parseMapFile, importMap } from '../lib/map-import.js';
import { blastRadius, getSuspects, getBlueprint, getNode, getProjectMeta } from '../lib/map-view.js';
import { reconcile } from '../lib/map-reconcile.js';

function flagValue(argv: string[], name: string, dflt: string): string {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

const argv = process.argv.slice(2);
const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'import';
const mapPath = flagValue(argv, 'file', join(process.cwd(), 'map.yaml'));

const db = openDb();
runMigrations(db);

const map = parseMapFile(mapPath);
// Always (re)import first so reads reflect the file — map.yaml is authoritative.
const res = importMap(db, map);

const COLOR_DOT: Record<string, string> = { green: '🟢', red: '🔴', gray: '⚪', amber: '🟡', blue: '🔵' };
const repoRoot = flagValue(argv, 'root', process.cwd());

// Triage/diagnosis commands reflect REALITY, so reconcile first (scans repoRoot).
const DIAG_SUBS = new Set(['status', 'explain', 'next', 'inspect']);
if (DIAG_SUBS.has(sub)) reconcile(db, map.project, repoRoot);

interface VerdictEvidence { reason?: string; why?: string; fix?: string[]; expected?: string; check?: string; checks?: Array<{ claim: string; ok: boolean; file: string | null; line: number | null; detail: string }> }
function diagOf(id: string): { node: any; ev: VerdictEvidence } | null {
  const node = getNode(db, map.project, id);
  if (!node) return null;
  let ev: VerdictEvidence = {};
  try { ev = JSON.parse((node as any).verdict_evidence || '{}'); } catch { /* none */ }
  return { node, ev };
}
// A node "needs attention" if reality flags it (divergence/absence) or it's a hand-declared
// suspect reality hasn't cleared. A suspect REFUTED by reality (→convergence) does NOT.
function needsAttention(n: any): boolean {
  if (n.live_verdict === 'divergence' || n.live_verdict === 'absence') return true;
  if (n.status === 'suspect' && n.live_verdict !== 'convergence') return true;
  return false;
}
const allNodes = () => db.prepare('SELECT * FROM map_nodes WHERE project = ?').all(map.project) as any[];
const parseJson = (s: string, dflt: any) => { try { return JSON.parse(s || ''); } catch { return dflt; } };
const truncate = (s: string, n: number) => (s && s.length > n ? s.slice(0, n) + '…' : s ?? '');
const shortPath = (p: string | null) => (p ? p.split(/[\\/]/).slice(-2).join('/') : '');
// External = verified outside the repo (network/human); not fixable in code right now.
const isExternal = (n: any) => parseJson(n.reality, {}).kind === 'external';
const STATUS_JP: Record<string, string> = {
  active: '健全（稼働中）', commitment: '約束（締切あり）', suspect: '要確認（ズレの疑い）',
  planned: '計画', paused: '保留', future_thesis: '将来構想', experiment: '実験中',
};
const declaredJP = (s: string) => STATUS_JP[s] ?? s;

function printSuspectsWithBlast() {
  const suspects = getSuspects(db, map.project);
  if (suspects.length === 0) { console.log('\nNo suspect nodes. (Map declares all surfaces converged.)'); return; }
  console.log(`\n🔴 ${suspects.length} suspect node(s) — out-of-band drift candidates:`);
  for (const s of suspects) {
    console.log(`\n  ${s.id} — ${s.statement}`);
    if (s.note) console.log(`    note: ${s.note}`);
    const blast = blastRadius(db, map.project, s.id);
    if (blast.length === 0) { console.log('    blast radius: (none — isolated node)'); continue; }
    console.log(`    blast radius (${blast.length}): touching this implicates —`);
    for (const b of blast) console.log(`      • ${b.id} [${b.status}] via ${b.relation}`);
  }
}

if (sub === 'import') {
  console.log(`[map] imported ${map.project} from ${mapPath}`);
  console.log(`      ${res.nodes} nodes · ${res.edges} edges · ${res.linked_anchors} anchor link(s)`);
  if (res.warnings.length) {
    console.log(`      ⚠ ${res.warnings.length} warning(s):`);
    for (const w of res.warnings) console.log(`        - ${w}`);
  } else {
    console.log('      ✓ no topology warnings');
  }
  printSuspectsWithBlast();
} else if (sub === 'suspects') {
  printSuspectsWithBlast();
} else if (sub === 'reconcile') {
  // Check declared intent against actual reality (local code/files). Scans process.cwd().
  const flagRoot = flagValue(argv, 'root', process.cwd());
  const res = reconcile(db, map.project, flagRoot);
  console.log(`[reconcile] ${map.project} — ${res.checked} checked · ${res.external} external (human-confirmed)`);
  if (res.refuted.length) {
    console.log(`\n✓ ${res.refuted.length} suspect(s) REFUTED by reality (declared suspect → reality says convergence):`);
    for (const v of res.refuted) console.log(`  🟢 ${v.id} — ${v.reason}\n     ${(v.evidence as any).file ?? ''}${(v.evidence as any).line_no ? ':' + (v.evidence as any).line_no : ''}`);
  }
  if (res.confirmed.length) {
    console.log(`\n🔴 ${res.confirmed.length} suspect(s) CONFIRMED by reality:`);
    for (const v of res.confirmed) console.log(`  🔴 ${v.id} — ${v.reason}`);
  }
  const newDiv = res.verdicts.filter((v) => v.flipped && v.verdict === 'divergence');
  if (newDiv.length) {
    console.log(`\n⚠ ${newDiv.length} node(s) reality flags as divergence (declared OK, reality disagrees):`);
    for (const v of newDiv) console.log(`  🔴 ${v.id} — ${v.reason}`);
  }
  console.log(`\nVerdicts: ${res.verdicts.filter(v => v.verdict === 'convergence').length} convergence · ${res.verdicts.filter(v => v.verdict === 'divergence').length} divergence · ${res.verdicts.filter(v => v.verdict === 'absence').length} absence · ${res.external} external`);
} else if (sub === 'blast') {
  const id = argv[1];
  if (!id) { console.error('usage: linksee-memory-map blast <node-id>'); process.exit(1); }
  const blast = blastRadius(db, map.project, id);
  console.log(`blast radius for ${id} (${blast.length}):`);
  for (const b of blast) console.log(`  • ${b.id} [${b.status}] via ${b.relation}\n    ${b.statement}`);
} else if (sub === 'blueprint') {
  const bp = getBlueprint(db, map.project, map.stages);
  console.log(`Blueprint — ${bp.project}`);
  console.log(`status counts: ${Object.entries(bp.counts).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  for (const cell of bp.stages) {
    console.log(`\n▌${cell.label} (${cell.stage})`);
    if (cell.nodes.length === 0) { console.log('   (empty — absence)'); continue; }
    for (const n of cell.nodes) console.log(`   ${COLOR_DOT[n.color]} ${n.id} — ${n.statement}`);
  }
  console.log('\n▌implementation');
  for (const n of bp.implementation) console.log(`   ${COLOR_DOT[n.color]} ${n.id} — ${n.statement}`);
} else if (sub === 'status') {
  // Triage, not a list. Local-actionable first (fixable now, has evidence), then external.
  const nodes = allNodes();
  const attention = nodes.filter(needsAttention);
  const local = attention.filter((n) => !isExternal(n));
  const external = attention.filter(isExternal);
  const verified = nodes.filter((n) => n.live_verdict === 'convergence');
  const health = nodes.length ? Math.round(100 * (nodes.length - attention.length) / nodes.length) : 100;
  console.log(`Product: ${map.project}`);
  console.log(`Health:  ${health}%`);
  console.log(`\nNeeds attention: ${attention.length}`);

  if (local.length) {
    console.log('\n  Actionable now (local, fixable):');
    local.forEach((n, i) => {
      const ev = parseJson(n.verdict_evidence, {});
      const failed = (ev.checks ?? []).find((c: any) => !c.ok);
      const evidence = failed ? `${shortPath(failed.file)}${failed.line ? ':' + failed.line : ''} (${failed.detail})` : '—';
      console.log(`    ${i + 1}. ${n.id}  ${n.live_verdict ?? n.status}`);
      console.log(`       ${truncate(ev.why || n.note || n.statement, 88)}`);
      console.log(`       evidence: ${evidence}`);
      console.log(`       next: linksee-memory-map explain ${n.id}`);
    });
  }
  if (external.length) {
    console.log('\n  External checks (verify outside the repo):');
    external.forEach((n, i) => {
      const ev = parseJson(n.verdict_evidence, {});
      console.log(`    ${local.length + i + 1}. ${n.id}  ${n.status}`);
      console.log(`       ${truncate(ev.why || n.note || n.statement, 88)}`);
      if (ev.expected) console.log(`       expected: ${ev.expected}`);
      if (ev.check) console.log(`       check:    ${ev.check}`);
    });
  }

  console.log(`\nVerified by reality: ${verified.length}`);
  for (const n of verified) console.log(`  ${n.id.padEnd(20)} ${n.status === 'suspect' ? 'refuted suspect → convergence' : 'verified'}`);
  console.log(`\nNo action: ${nodes.length - attention.length - verified.length}`);
} else if (sub === 'explain') {
  const id = argv[1];
  if (!id) { console.error('usage: linksee-memory-map explain <node>'); process.exit(1); }
  const d = diagOf(id);
  if (!d) { console.error(`node not found: ${id}`); process.exit(1); }
  const { node, ev } = d;
  const meta = getProjectMeta(db, map.project);
  const stageLabel = node.stage ? (meta?.stages.find((s: any) => s.id === node.stage)?.label ?? node.stage) : null;
  const v = node.live_verdict as string | null;
  const isExt = parseJson(node.reality, {}).kind === 'external';
  console.log(`${node.id}${stageLabel ? `   [${stageLabel}]` : ''}`);
  console.log(node.statement);
  // declared state and reality verdict are DIFFERENT things — show them separately.
  console.log('\nSTATUS');
  console.log(`  宣言状態: ${declaredJP(node.status)}`);
  if (v) {
    const realityJP = v === 'convergence' ? '実装あり / 一致' : v === 'divergence' ? 'ズレあり' : '未実現';
    const concl = node.status === 'suspect' && v === 'convergence' ? '要確認は現実により反証 (refuted suspect → convergence)'
      : v === 'divergence' ? '宣言と現実がズレている (drift)'
      : v === 'convergence' ? '宣言と現実が一致 (verified)'
      : '宣言が現実に未実現 (absence)';
    console.log(`  現実判定: ${realityJP}`);
    console.log(`  結論:     ${concl}`);
  } else {
    console.log(`  現実判定: ${isExt ? '外部確認待ち（自動確認なし）' : '自動チェック未設定'}`);
  }
  console.log(`\nWHY\n  ${ev.why || node.note || '宣言ベース（現実の自動チェックは未設定）'}`);
  console.log('\nEVIDENCE');
  if (ev.checks && ev.checks.length) {
    for (const c of ev.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.claim}\n      ${shortPath(c.file)}${c.line ? ':' + c.line : ''} — ${c.detail}`);
  } else if (isExt) {
    console.log('  外部状態のため自動確認なし（人が確認）');
    if (ev.expected) console.log(`  expected: ${ev.expected}`);
    if (ev.check) console.log(`  check:    ${ev.check}`);
  } else {
    console.log('  自動チェック未設定（宣言ベース）');
  }
  if (ev.fix && ev.fix.length) { console.log('\nFIX'); ev.fix.forEach((f: string, i: number) => console.log(`  ${i + 1}. ${f}`)); }
  const blast = blastRadius(db, map.project, id);
  console.log(`\nAFFECTS${blast.length ? '' : '  (none)'}`);
  for (const b of blast) console.log(`  ${b.id}  (${b.relation})`);
  console.log(`\nNEXT\n  linksee-memory-map reconcile          # re-check after a fix\n  linksee-memory-map affects ${id}`);
} else if (sub === 'affects') {
  const id = argv[1];
  if (!id) { console.error('usage: linksee-memory-map affects <node>'); process.exit(1); }
  const blast = blastRadius(db, map.project, id);
  console.log(`${id} を変えたら一緒に直す先 (${blast.length}):`);
  for (const b of blast) console.log(`  • ${b.id} [${b.status}] — ${b.relation}\n    ${b.statement}`);
} else if (sub === 'next') {
  // local-first: what you can fix in code now, then what to verify externally.
  const attention = allNodes().filter(needsAttention);
  const local = attention.filter((n) => !isExternal(n))
    .sort((a, b) => blastRadius(db, map.project, b.id).length - blastRadius(db, map.project, a.id).length);
  const external = attention.filter(isExternal);
  if (!attention.length) { console.log('✓ Nothing needs attention — the Map matches reality.'); }
  else {
    if (local.length) {
      console.log('Next local fix:');
      local.slice(0, 3).forEach((n, i) => {
        const ev = parseJson(n.verdict_evidence, {});
        console.log(`  ${i + 1}. ${n.id}  — ${truncate(ev.why || n.note || n.statement, 88)}`);
        console.log(`     → linksee-memory-map explain ${n.id}`);
      });
    }
    if (external.length) {
      console.log(`${local.length ? '\n' : ''}Next external checks:`);
      external.forEach((n) => {
        const ev = parseJson(n.verdict_evidence, {});
        console.log(`  • ${n.id}${ev.check ? `  — ${ev.check}` : ''}`);
      });
    }
  }
} else if (sub === 'inspect') {
  const nodes = allNodes();
  const out = {
    project: map.project,
    health: nodes.length ? Math.round(100 * (nodes.length - nodes.filter(needsAttention).length) / nodes.length) : 100,
    nodes: nodes.map((n) => {
      const ev = parseJson(n.verdict_evidence, {});
      return {
        id: n.id, stage: n.stage, layer: n.layer, status: n.status, live_verdict: n.live_verdict,
        why: ev.why ?? null, checks: ev.checks ?? [], fix: ev.fix ?? [],
        affects: blastRadius(db, map.project, n.id).map((b) => b.id), needs_attention: needsAttention(n),
      };
    }),
  };
  console.log(JSON.stringify(out, null, 2));
} else {
  console.error(`unknown subcommand: ${sub}`);
  process.exit(1);
}

db.close();
