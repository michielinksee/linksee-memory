#!/usr/bin/env node
// linksee-memory-map — load the Current Truth Map (map.yaml) into the runtime index
// and answer topology questions. map.yaml is the desired-state source of truth (anchor
// #58); this reconciles it into map_nodes/map_edges (full rebuild per project).
//
// Usage (CLI-first triage, not a list):
//   linksee-memory-map status                # health % + what needs attention now (the triage)
//   linksee-memory-map explain <node>        # WHY this status + ✓/✗ evidence + FIX + AFFECTS (the hero)
//   linksee-memory-map affects <node>        # what to change together if you touch this node
//   linksee-memory-map where <file|topic>    # which Map node a file/work-target belongs to
//   linksee-memory-map next                  # the prioritized next fix candidate(s)
//   linksee-memory-map reconcile             # check the hand-written Map against real code/files
//   linksee-memory-map inspect --json        # machine-readable dump (CI / tooling)
//   linksee-memory-map blueprint             # stage×node board (dashboard data)
//   linksee-memory-map [--file map.yaml] [--root <repo>]

import { join } from 'node:path';
import { openDb, runMigrations } from '../db/migrate.js';
import { parseMapFile, importMap } from '../lib/map-import.js';
import { blastRadius, getSuspects, getBlueprint, getNode, getProjectMeta, whereAmI } from '../lib/map-view.js';
import { reconcile } from '../lib/map-reconcile.js';

function flagValue(argv: string[], name: string, dflt: string): string {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

const argv = process.argv.slice(2);
// positional args, skipping flags and their values (so `where --file x` doesn't read "--file" as the target)
const VALUE_FLAGS = new Set(['--file', '--root', '--limit']);
const positionals: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { if (VALUE_FLAGS.has(argv[i])) i++; continue; }
  positionals.push(argv[i]);
}
const sub = positionals[0] ?? 'import';
const arg1 = positionals[1]; // the node-id / file / topic for explain|blast|affects|where
const mapPath = flagValue(argv, 'file', join(process.cwd(), 'map.yaml'));

const db = openDb();
runMigrations(db);

const map = parseMapFile(mapPath);
// Always (re)import first so reads reflect the file — map.yaml is authoritative.
const res = importMap(db, map);

const COLOR_DOT: Record<string, string> = { green: '🟢', red: '🔴', gray: '⚪', amber: '🟡', blue: '🔵' };
const repoRoot = flagValue(argv, 'root', process.cwd());

// Triage/diagnosis commands reflect REALITY, so reconcile first (scans repoRoot).
const DIAG_SUBS = new Set(['status', 'explain', 'next', 'inspect', 'where']);
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
const TODAY = new Date().toISOString().slice(0, 10);
// Accounted-for = parked with a reason (paused / external / has a revival plan).
const isAccountedFor = (n: any) => n.status === 'paused' || isExternal(n) || !!n.revival_condition || !!n.review_by;
const isOverdue = (n: any) => !!n.review_by && n.review_by < TODAY;          // promised by a date, now past it
const noExpiry = (n: any) => isAccountedFor(n) && !n.review_by && !n.revival_condition; // graveyard risk
const facetsOf = (n: any): string[] => parseJson(n.facets, []);
// AFFECTS grouped by edge strength so a big blast radius isn't flat noise.
function printAffects(id: string, indent = '  ') {
  const blast = blastRadius(db, map.project, id);
  if (!blast.length) { console.log(`${indent}(none)`); return; }
  const groups: Array<[string, string]> = [['hard', '必ず一緒に直す'], ['soft', 'できれば揃える'], ['watch', '参考（連鎖の可能性）']];
  for (const [s, label] of groups) {
    const hits = blast.filter((b) => b.strength === s);
    if (!hits.length) continue;
    console.log(`${indent}${label} (${s}):`);
    for (const b of hits) console.log(`${indent}  ${b.id}  (${b.relation})`);
  }
}
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
  const id = arg1;
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

  // accounted-for can't become a drift graveyard: overdue deferrals re-escalate, missing expiries are flagged.
  const overdue = nodes.filter(isOverdue);
  if (overdue.length) {
    console.log(`\n⏰ Overdue deferrals (promised by a date, now past ${TODAY}):`);
    for (const n of overdue) console.log(`    ${n.id}  review_by ${n.review_by}${n.revival_condition ? ' — ' + n.revival_condition : ''}`);
  }
  const graveyard = nodes.filter(noExpiry);
  if (graveyard.length) {
    console.log(`\n⚠ Deferrals with no expiry/condition (graveyard risk): ${graveyard.map((n: any) => n.id).join(', ')}`);
    console.log('    → add review_by: <date> or revival_condition: <text> in map.yaml');
  }

  console.log(`\nVerified by reality: ${verified.length}`);
  for (const n of verified) console.log(`  ${n.id.padEnd(20)} ${n.status === 'suspect' ? 'refuted suspect → convergence' : 'verified'}`);
  console.log(`\nNo action: ${nodes.length - attention.length - verified.length}`);
} else if (sub === 'explain') {
  const id = arg1;
  if (!id) { console.error('usage: linksee-memory-map explain <node>'); process.exit(1); }
  const d = diagOf(id);
  if (!d) { console.error(`node not found: ${id}`); process.exit(1); }
  const { node, ev } = d;
  const meta = getProjectMeta(db, map.project);
  const stageLabel = node.stage ? (meta?.stages.find((s: any) => s.id === node.stage)?.label ?? node.stage) : null;
  const v = node.live_verdict as string | null;
  const isExt = parseJson(node.reality, {}).kind === 'external';
  const facets = facetsOf(node);
  console.log(`${node.id}${stageLabel ? `   [${stageLabel}]` : ''}${facets.length ? `   {${facets.join(', ')}}` : ''}`);
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
  if (node.review_by || node.revival_condition) {
    console.log('\nDEFERRED UNTIL');
    if (node.review_by) console.log(`  review_by: ${node.review_by}${isOverdue(node) ? '  ⏰ OVERDUE' : ''}`);
    if (node.revival_condition) console.log(`  condition: ${node.revival_condition}`);
  }
  console.log('\nAFFECTS（変えたら一緒に直す先・強度順）');
  printAffects(id);
  console.log(`\nNEXT\n  linksee-memory-map reconcile          # re-check after a fix\n  linksee-memory-map affects ${id}`);
} else if (sub === 'affects') {
  const id = arg1;
  if (!id) { console.error('usage: linksee-memory-map affects <node>'); process.exit(1); }
  const blast = blastRadius(db, map.project, id);
  console.log(`${id} を変えたら一緒に直す先 (${blast.length}) — 強度順:`);
  printAffects(id);
} else if (sub === 'where') {
  // "I'm about to touch this file — where is it on the Map, and what does it touch?"
  const target = arg1;
  if (!target) {
    // no arg → auto-locate from what you just edited this session
    const res = whereAmI(db, { project: map.project });
    if (!res.matched.length) { console.log('直近の編集からMap上の位置を特定できませんでした。'); }
    else {
      console.log('直近の編集から推定した「今いる場所」:');
      for (const m of res.matched) {
        console.log(`\n  ${m.node.id}${m.stage_label ? `  [${m.stage_label}]` : ''}  ${m.node.live_verdict ?? m.node.status}  (${m.match_reason})`);
        console.log('    変えたら一緒に直す先:');
        printAffects(m.node.id, '      ');
      }
    }
    db.close();
    process.exit(0);
  }
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');
  const t = norm(target);
  const meta = getProjectMeta(db, map.project);
  const stageLabel = (s: string | null) => (s ? meta?.stages.find((x: any) => x.id === s)?.label ?? s : null);
  // Ownership = a node whose reality names this FILE explicitly (check.path / reality.path).
  // `dir:` is a scan SCOPE (e.g. all of src), not ownership — so it does NOT match here.
  const matched = allNodes().filter((n) => {
    const r = parseJson(n.reality, {});
    const paths: string[] = [];
    if (r.path) paths.push(norm(r.path));
    for (const c of (r.checks ?? [])) if (c.path) paths.push(norm(c.path));
    return paths.some((p) => t === p);
  });
  if (matched.length) {
    console.log(`"${target}" は Map 上のこのノードに属します:`);
    for (const n of matched) {
      console.log(`\n  ${n.id}${n.stage ? `  [${stageLabel(n.stage)}]` : ''}  ${n.live_verdict ?? n.status}`);
      console.log(`    ${n.statement}`);
      console.log('    変えたら一緒に直す先:');
      printAffects(n.id, '      ');
    }
  } else {
    // no file match → treat the arg as a topic (lexical locate, like where_am_i)
    const res = whereAmI(db, { project: map.project, query: target });
    if (!res.matched.length) { console.log(`Map上で "${target}" に該当するファイル/トピックは見つかりませんでした。`); }
    else {
      console.log(`ファイル一致なし → トピックとして近いノード:`);
      for (const m of res.matched) console.log(`  ${m.node.id}${m.stage_label ? `  [${m.stage_label}]` : ''}  (${m.match_reason})`);
    }
  }
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
