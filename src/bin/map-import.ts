#!/usr/bin/env node
// linksee-memory-map — load the Current Truth Map (map.yaml) into the runtime index
// and answer topology questions. map.yaml is the desired-state source of truth (anchor
// #58); this reconciles it into map_nodes/map_edges (full rebuild per project).
//
// Usage:
//   linksee-memory-map                       # import ./map.yaml, print summary + suspects
//   linksee-memory-map --file path/to/map.yaml
//   linksee-memory-map blast <node-id>       # show 1-hop blast radius for a node
//   linksee-memory-map blueprint             # print the stage×node blueprint (dashboard data)
//   linksee-memory-map suspects              # list suspect nodes + their blast radius

import { join } from 'node:path';
import { openDb, runMigrations } from '../db/migrate.js';
import { parseMapFile, importMap } from '../lib/map-import.js';
import { blastRadius, getSuspects, getBlueprint } from '../lib/map-view.js';
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
} else {
  console.error(`unknown subcommand: ${sub}`);
  process.exit(1);
}

db.close();
