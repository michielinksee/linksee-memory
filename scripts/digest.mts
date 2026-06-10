// linksee digest — a glanceable, developer-axis view of recent memory. READ-ONLY (no writes).
// "Did today get recorded, and can I see what matters?" along: decided / did / learned / bit-me /
// still-open / drifting.
//
//   npx tsx scripts/digest.mts             # today (since local midnight)
//   npx tsx scripts/digest.mts --hours 48  # last 48h

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';

const hiArg = process.argv.indexOf('--hours');
const hours = hiArg >= 0 ? Number(process.argv[hiArg + 1]) : null;
const dbPath = process.env.LINKSEE_MEMORY_DIR
  ? join(process.env.LINKSEE_MEMORY_DIR, 'memory.db')
  : join(homedir(), '.linksee-memory', 'memory.db');

const db = new Database(dbPath, { readonly: true });
const now = Math.floor(Date.now() / 1000);
const cutoff = hours != null ? now - hours * 3600 : Math.floor(new Date(new Date().setHours(0, 0, 0, 0)).getTime() / 1000);
const label = hours != null ? `last ${hours}h` : 'today';

const parse = (c: string): any => {
  try {
    return JSON.parse(c);
  } catch {
    return null;
  }
};
const what = (c: string): string => {
  const o = parse(c);
  return (o?.what ?? (typeof c === 'string' ? c : '')).toString().replace(/\s+/g, ' ').slice(0, 150);
};
const why = (c: string): string => (parse(c)?.why ?? '').toString().replace(/\s+/g, ' ').slice(0, 120);
const pin = (imp: number): string => (imp >= 0.9 ? '📌' : '  ');

const mems = db
  .prepare(
    `SELECT m.id, m.layer, m.content, m.importance, m.source, m.created_at, m.thread_id,
            m.altitude, m.mem_type, m.mem_state, e.name AS entity
       FROM memories m JOIN entities e ON e.id = m.entity_id
      WHERE m.created_at >= ? ORDER BY m.created_at`
  )
  .all(cutoff) as any[];

const editRows = db
  .prepare(
    `SELECT file_path, COUNT(*) n FROM session_file_edits WHERE occurred_at >= ? GROUP BY file_path ORDER BY n DESC LIMIT 12`
  )
  .all(cutoff) as any[];
const editTotal = db.prepare(`SELECT COUNT(*) n FROM session_file_edits WHERE occurred_at >= ?`).get(cutoff) as any;

const tally = (col: string) => {
  const out: Record<string, number> = {};
  for (const m of mems) {
    const k = (m as any)[col] ?? '∅';
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.entries(out)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');
};

const section = (title: string, rows: any[], render: (m: any) => string, cap = 8) => {
  console.log(`\n${title} (${rows.length})`);
  if (rows.length === 0) {
    console.log('  —');
    return;
  }
  for (const m of rows.slice(0, cap)) console.log(render(m));
  if (rows.length > cap) console.log(`  …+${rows.length - cap} more`);
};

// source is a per-turn JSON blob for session-captured rows — collapse to its `kind` (or "explicit").
const sourceKind = (s: string | null): string => {
  if (!s) return 'explicit(remember)';
  const o = parse(s);
  return o?.kind ? `session:${o.kind}` : String(s).slice(0, 16);
};
const srcTally = (): string => {
  const out: Record<string, number> = {};
  for (const m of mems) {
    const k = sourceKind(m.source);
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.entries(out).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ');
};

const decisions = mems.filter((m) => m.mem_type === 'decision');
const learnings = mems.filter((m) => m.layer === 'learning' || m.mem_type === 'learning');
const caveats = mems.filter((m) => m.layer === 'caveat');
const workItems = mems.filter((m) => m.layer === 'implementation' || m.mem_type === 'work');
const openMems = mems.filter((m) => ['open', 'stalled', 'parked'].includes(m.mem_state) || m.mem_type === 'question');

// standing open forks (cross-session, not just today)
const forks = db
  .prepare(
    `SELECT a.id, a.statement FROM memory_write_candidates c
       JOIN drift_anchors a ON a.id = c.target_node_id
      WHERE c.scope = 'orphaned_proposal' AND c.status = 'pending_review' ORDER BY c.created_at DESC LIMIT 8`
  )
  .all() as any[];

// drift snapshot (read-only)
const openContra = db
  .prepare(
    `SELECT a.id, a.statement, COUNT(*) n FROM drift_edges d JOIN drift_anchors a ON a.id = d.anchor_id
      WHERE d.verdict = 'contradicts' AND d.status = 'open' GROUP BY a.id ORDER BY n DESC LIMIT 6`
  )
  .all() as any[];
const injToday = db.prepare(`SELECT COUNT(*) n FROM injection_log WHERE occurred_at >= ?`).get(cutoff) as any;
const northStars = db
  .prepare(`SELECT id, statement FROM drift_anchors WHERE node_type = 'north_star' AND status = 'active' ORDER BY created_at DESC`)
  .all() as any[];

console.log('═'.repeat(82));
console.log(`  LINKSEE DIGEST — ${label}`);
console.log('═'.repeat(82));
console.log(`captured: ${mems.length} memories · ${editTotal.n} file-edits · ${editRows.length} files touched`);
console.log(`how recorded:  ${srcTally()}`);
console.log(`by layer:  ${tally('layer')}`);
console.log(`by type:   ${tally('mem_type')}`);
console.log(`by state:  ${tally('mem_state')}`);

section('🎯 DECISIONS — what I committed to', decisions, (m) => `  ${pin(m.importance)}[${m.entity}] ${what(m.content)}${why(m.content) ? `\n       ↳ why: ${why(m.content)}` : ''}`);
section('🔧 WORK — what I did', workItems, (m) => `  ${pin(m.importance)}[${m.entity}] ${what(m.content)}`);
section('💡 LEARNINGS', learnings, (m) => `  ${pin(m.importance)}[${m.entity}] ${what(m.content)}`);
section('⚠️  CAVEATS — what bit me (auto-protected)', caveats, (m) => `  ${pin(m.importance)}[${m.entity}] ${what(m.content)}`);
section('🔀 OPEN LOOPS — unresolved (today + standing forks)', [...openMems, ...forks.map((f) => ({ entity: 'fork', content: f.statement, importance: 0, mem_state: 'open' }))], (m) => `  • ${what(m.content)}`);

console.log(`\n🧭 DRIFT & ALIGNMENT`);
console.log(`  open contradictions: ${openContra.reduce((s, r) => s + r.n, 0)} across ${openContra.length} anchor(s)${injToday.n ? ` · re-injections ${label}: ${injToday.n}` : ''}`);
for (const c of openContra) console.log(`    🔴 #${c.id} ×${c.n}  ${String(c.statement).slice(0, 64)}`);
for (const ns of northStars) console.log(`  📌 North Star #${ns.id}: ${String(ns.statement).slice(0, 72)}`);
console.log('\n' + '═'.repeat(82));
db.close();
