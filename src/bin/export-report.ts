#!/usr/bin/env node
// linksee-memory-export — export a project's memory as a shareable Markdown report.
// Usage:
//   npx -y linksee-memory export <project>              → Markdown to stdout
//   npx -y linksee-memory export <project> --out file.md
//
// The point (cold-start killer + quiet team sharing): pull your decisions + the WHY
// behind them + what's drifting OUT as a readable artifact you can paste into Notion or
// Slack — for a team that never opens the dashboard. Read-only. Surfaces drift on
// purpose, so the day-1 value pulls toward the core instead of away from it.

import { writeFileSync } from 'node:fs';
import { openDb, runMigrations } from '../db/migrate.js';
import { getAnchorRetention } from '../lib/anchor-touch.js';

interface Args { project: string | null; out: string | null; help: boolean }

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const a: Args = { project: null, out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--out' || v === '-o') a.out = argv[++i] ?? null;
    else if (v === '-h' || v === '--help') a.help = true;
    else if (!v.startsWith('-') && a.project === null) a.project = v;
  }
  return a;
}

const fmtDate = (unix?: number | null): string => (unix ? new Date(unix * 1000).toISOString().slice(0, 10) : '—');
const clip = (s: string, n = 240): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// memories.content is either plain text or a JSON blob {what, why, title, …}. Pull the
// human-meaningful pair (what + why) so the report reads like prose, not a data dump.
function parseContent(raw: string): { what: string; why: string | null } {
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') {
      const what = String(j.what ?? j.title ?? j.learned ?? j.rule_or_warning ?? '').trim();
      const whyRaw = j.why ?? j.from_incident ?? null;
      const why = whyRaw ? String(whyRaw).trim() : null;
      if (what) return { what, why };
      // pure machine log (intent/session capture) with no human field → empty → dropped as noise
      if (j.intent || j.when || j.session_id || j.at) return { what: '', why: null };
    }
  } catch { /* plain text — fall through */ }
  return { what: raw.replace(/\s+/g, ' ').trim(), why: null };
}

function main(): void {
  const args = parseArgs();
  if (args.help) {
    console.log(`linksee-memory-export — export a project's memory as a Markdown report

  <project>          Entity/project name to export (default: highest-momentum project)
  --out, -o <file>   Write to a file instead of stdout
  -h, --help         This message
`);
    return;
  }

  const db = openDb();
  runMigrations(db);

  // Resolve the project entity (by name / normalized name / canonical key; else top project).
  let entity = args.project
    ? (db.prepare(
        `SELECT id, name, kind, momentum_score FROM entities
         WHERE name = ? OR normalized_name = ? OR canonical_key = ? LIMIT 1`,
      ).get(args.project, args.project.toLowerCase(), args.project) as any)
    : null;
  if (!entity) {
    entity = db.prepare(
      `SELECT id, name, kind, momentum_score FROM entities WHERE kind = 'project'
       ORDER BY momentum_score DESC LIMIT 1`,
    ).get() as any;
  }
  if (!entity) {
    console.error('No project found. Pass a project name:  linksee export <project>');
    db.close();
    process.exitCode = 1;
    return;
  }

  const nowS = Math.floor(Date.now() / 1000);

  // Decisions & WHY. Scope to THIS project when its Map links anchors to nodes
  // (map_nodes.anchor_id); otherwise fall back to the project-wide truth map. No schema
  // change — we reuse the existing map↔anchor linkage so the report isn't polluted by
  // other projects' decisions (B fix, 2026-06-18).
  const SELECT_ANCHORS = 'SELECT id, kind, statement, rationale, decision_mode, domain, lifecycle, confidence, review_after, updated_at FROM drift_anchors';
  const ORDER_ANCHORS = "ORDER BY (lifecycle != 'active') DESC, updated_at DESC";
  const mapProject = (db.prepare(
    'SELECT project FROM map_projects WHERE project = ? OR LOWER(project) = LOWER(?) LIMIT 1',
  ).get(entity.name, entity.name) as any)?.project as string | undefined;
  const scopedIds = mapProject
    ? (db.prepare('SELECT DISTINCT anchor_id FROM map_nodes WHERE project = ? AND anchor_id IS NOT NULL')
        .all(mapProject) as any[]).map((r) => r.anchor_id as number)
    : [];
  const scopedAnchors = scopedIds.length
    ? db.prepare(`${SELECT_ANCHORS} WHERE status = 'active' AND id IN (${scopedIds.map(() => '?').join(',')}) ${ORDER_ANCHORS}`).all(...scopedIds) as any[]
    : [];
  // Use the project-scoped set ONLY if the Map wires enough decisions to it. A hand-written
  // map links just a handful of anchors → too sparse to scope by → fall back to the
  // project-wide truth map (clearly labeled). The proper fix is a `project` column on anchors.
  const anchorScoped = scopedAnchors.length >= 4;
  const anchors = (anchorScoped
    ? scopedAnchors
    : db.prepare(`${SELECT_ANCHORS} WHERE status = 'active' ${ORDER_ANCHORS}`).all()) as any[];
  const needsAttention = anchors.filter((a) =>
    ['at_risk', 'experiment', 'superseded', 'paused', 'deprecated'].includes(a.lifecycle)
    || (a.review_after && a.review_after < nowS));

  // Key memories for this entity, grouped by layer — filtered to what's worth SHARING.
  // Drop the two noise sources a shareable report must not leak: raw session-intent pastes
  // (un-distilled first-message captures) and auto edit-logs ("edit foo.ts (4 ops)").
  const SESSION_INTENT = 'Session intent — first user message';
  const EDIT_LOG = /^(edit|write|read|write\+edit)\b.*\(\d+\s*ops?\)/i;
  const isNoise = (what: string, why: string | null): boolean =>
    !what.trim()
    || why === SESSION_INTENT
    || EDIT_LOG.test(what)
    || /\(\d+\s*ops?\)\s*$/.test(what)
    || /^\{[\s\S]*"(intent|session_id|when)"/.test(what);
  const mems = (db.prepare(
    `SELECT layer, content, importance, protected, created_at FROM memories
     WHERE entity_id = ? ORDER BY importance DESC, created_at DESC`,
  ).all(entity.id) as any[])
    .map((m) => ({ ...m, parsed: parseContent(m.content) }))
    .filter((m) => !isNoise(m.parsed.what, m.parsed.why))
    // internal layers (implementation/context) only surface their explicitly-pinned notes here
    .filter((m) => !['implementation', 'context'].includes(m.layer) || m.protected || m.importance >= 0.9);
  const byLayer: Record<string, any[]> = {};
  for (const m of mems) (byLayer[m.layer] ??= []).push(m);

  const retention = getAnchorRetention(db);

  // ── Render Markdown ──────────────────────────────────────────────────────────
  const L: string[] = [];
  L.push(`# ${entity.name} — Memory Report`);
  L.push('');
  L.push(`> A snapshot of the decisions, the *why* behind them, and what's drifting — exported from `
    + `Linksee Memory on ${fmtDate(nowS)}. Paste it into Notion / Slack to share with anyone who never `
    + `opens the dashboard.`);
  L.push('');

  // Attention FIRST — the core-dependent hook (day-1 value points at the moat, not away).
  L.push(`## ⚠️ Needs attention (${needsAttention.length})`);
  if (needsAttention.length === 0) {
    L.push('Nothing drifting right now — every active decision still matches reality. ✅');
  } else {
    for (const a of needsAttention) {
      const overdue = a.review_after && a.review_after < nowS ? ', review overdue' : '';
      L.push(`- **#${a.id} ${clip(a.statement, 160)}**  _(${a.lifecycle}${overdue})_`);
      if (a.rationale) L.push(`  - why: ${clip(a.rationale, 200)}`);
    }
  }
  L.push('');

  // Decisions & the why.
  const modeLabel: Record<string, string> = {
    constraint: 'constraint', commitment: 'commitment', hypothesis: 'hypothesis',
    source_of_truth: 'source-of-truth', preference: 'preference', metric: 'metric',
  };
  L.push(`## Decisions & the why (${anchors.length})${anchorScoped ? '' : '  _— project-wide truth map (this project has no scoped Map)_'}`);
  for (const a of anchors) {
    const tag = a.decision_mode ? (modeLabel[a.decision_mode] ?? a.decision_mode) : a.kind;
    L.push(`- \`${tag}\` **${clip(a.statement, 200)}**`);
    if (a.rationale) L.push(`  - why: ${clip(a.rationale, 240)}`);
  }
  L.push('');

  // Memory by layer.
  const layerOrder = ['goal', 'learning', 'caveat', 'implementation', 'context', 'emotion'];
  const layerTitle: Record<string, string> = {
    goal: '🎯 Goals', learning: '💡 Learnings & decisions', caveat: '⚠️ Caveats (hard-won)',
    implementation: '🔧 Implementation notes', context: '📎 Context', emotion: '🫧 Signals',
  };
  L.push('## Memory by layer');
  for (const layer of layerOrder) {
    const items = byLayer[layer];
    if (!items || items.length === 0) continue;
    L.push('');
    L.push(`### ${layerTitle[layer] ?? layer} (${items.length})`);
    for (const m of items.slice(0, 12)) {
      const { what, why } = m.parsed;
      const pin = m.protected || m.importance >= 0.9 ? '📌 ' : '';
      L.push(`- ${pin}${clip(what, 220)}`);
      if (why) L.push(`  - why: ${clip(why, 200)}`);
    }
    if (items.length > 12) L.push(`- …and ${items.length - 12} more`);
  }
  L.push('');

  // Decision trajectory (the D7 bridge metric — proof the memory is being used, not just stored).
  L.push('## Decision trajectory');
  if (retention.totalAnchors === 0) {
    L.push('No decisions recorded yet.');
  } else {
    const pct = Math.round(retention.retentionRate * 100);
    L.push(`- ${retention.totalAnchors} decisions across ${retention.activeDays} active day(s)`);
    L.push(`- ${retention.retainedAnchors}/${retention.totalAnchors} revisited within 7 days (${pct}%)`);
    L.push(`- first: ${fmtDate(retention.firstAnchorAt)} · last: ${fmtDate(retention.lastAnchorAt)}`);
  }
  L.push('');
  L.push('---');
  L.push(`_Generated by **Linksee Memory** · \`linksee export ${entity.name}\` · local-first — your data never left your machine._`);
  if (needsAttention.length > 0) {
    L.push(`_⚠️ ${needsAttention.length} decision(s) need attention — ask your agent "what's drifting?" or run \`linksee drift\`._`);
  }

  const md = L.join('\n') + '\n';
  if (args.out) {
    writeFileSync(args.out, md, 'utf8');
    console.error(`Wrote ${md.length} chars → ${args.out}`);
  } else {
    process.stdout.write(md);
  }
  db.close();
}

main();
