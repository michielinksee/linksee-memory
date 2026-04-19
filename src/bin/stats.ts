#!/usr/bin/env node
// linksee-memory-stats — summary of the local memory DB.
// Usage:
//   npx linksee-memory-stats
//   npx linksee-memory-stats --json
//   npx linksee-memory-stats --per-entity 10
//
// Safe to run anytime (read-only).

import { statSync } from 'node:fs';
import { openDb, getDbPath } from '../db/migrate.js';

interface Args {
  json: boolean;
  perEntity: number;
  help: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const a: Args = { json: false, perEntity: 5, help: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--json') a.json = true;
    else if (v === '--per-entity') a.perEntity = Math.max(0, Number(argv[++i] || 5));
    else if (v === '-h' || v === '--help') a.help = true;
  }
  return a;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function humanDate(unix: number | null | undefined): string {
  if (!unix) return '-';
  return new Date(unix * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

function humanAge(unix: number | null | undefined): string {
  if (!unix) return '-';
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / 86400 / 30)}mo ago`;
}

function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(`linksee-memory-stats — summary of the local memory DB

  --json             Output machine-readable JSON
  --per-entity N     Show top N entities (default 5, 0 to skip)
  -h, --help         This message
`);
    return;
  }

  const dbPath = getDbPath();
  let sizeBytes = 0;
  try { sizeBytes = statSync(dbPath).size; } catch { /* no db yet */ }

  const db = openDb();

  const counts = {
    entities: (db.prepare('SELECT COUNT(*) as c FROM entities').get() as any).c as number,
    memories: (db.prepare('SELECT COUNT(*) as c FROM memories').get() as any).c as number,
    file_edits: (db.prepare('SELECT COUNT(*) as c FROM session_file_edits').get() as any).c as number,
    unique_files: (db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM session_file_edits').get() as any).c as number,
    sessions_seen: (db.prepare('SELECT COUNT(DISTINCT session_id) as c FROM session_file_edits').get() as any).c as number,
    consolidations: (db.prepare('SELECT COUNT(*) as c FROM consolidations').get() as any).c as number,
    events: (db.prepare('SELECT COUNT(*) as c FROM events').get() as any).c as number,
  };

  const layerBreakdown = db
    .prepare("SELECT layer, COUNT(*) as c FROM memories GROUP BY layer ORDER BY c DESC")
    .all() as Array<{ layer: string; c: number }>;

  const entityKinds = db
    .prepare("SELECT kind, COUNT(*) as c FROM entities GROUP BY kind ORDER BY c DESC")
    .all() as Array<{ kind: string; c: number }>;

  const pinned = (db.prepare('SELECT COUNT(*) as c FROM memories WHERE importance >= 1.0').get() as any).c as number;
  const protectedCount = (db.prepare('SELECT COUNT(*) as c FROM memories WHERE protected = 1').get() as any).c as number;

  const oldest = (db.prepare('SELECT MIN(created_at) as t FROM memories').get() as any).t as number | null;
  const newest = (db.prepare('SELECT MAX(created_at) as t FROM memories').get() as any).t as number | null;

  const topEntities = args.perEntity > 0
    ? db.prepare(`
        SELECT e.name, e.kind, e.momentum_score, COUNT(m.id) as memory_count,
               MAX(m.last_accessed_at) as last_access
        FROM entities e
        LEFT JOIN memories m ON m.entity_id = e.id
        GROUP BY e.id
        ORDER BY memory_count DESC, e.momentum_score DESC
        LIMIT ?
      `).all(args.perEntity) as any[]
    : [];

  const topFiles = db.prepare(`
    SELECT file_path, COUNT(*) as edits, COUNT(DISTINCT session_id) as in_sessions
    FROM session_file_edits
    WHERE operation IN ('edit', 'write')
    GROUP BY file_path
    ORDER BY edits DESC
    LIMIT 5
  `).all() as any[];

  const result = {
    db_path: dbPath,
    db_size: sizeBytes,
    db_size_human: humanBytes(sizeBytes),
    counts,
    pinned,
    caveat_protected: protectedCount,
    layer_breakdown: layerBreakdown,
    entity_kinds: entityKinds,
    date_range: {
      oldest: oldest ? new Date(oldest * 1000).toISOString() : null,
      newest: newest ? new Date(newest * 1000).toISOString() : null,
    },
    top_entities: topEntities.map((e) => ({
      name: e.name,
      kind: e.kind,
      momentum: Number((e.momentum_score ?? 0).toFixed(2)),
      memory_count: e.memory_count,
      last_access: e.last_access ? new Date(e.last_access * 1000).toISOString() : null,
    })),
    top_files: topFiles.map((f) => ({
      path: f.file_path,
      edits: f.edits,
      in_sessions: f.in_sessions,
    })),
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    db.close();
    return;
  }

  // Human-readable output
  console.log('');
  console.log('  linksee-memory — local brain status');
  console.log('  ' + '═'.repeat(55));
  console.log(`  DB:            ${dbPath}`);
  console.log(`  Size:          ${humanBytes(sizeBytes)}`);
  console.log(`  Oldest memory: ${humanAge(oldest)}`);
  console.log(`  Newest memory: ${humanAge(newest)}`);
  console.log('');
  console.log('  Counts');
  console.log(`    entities:       ${counts.entities}`);
  console.log(`    memories:       ${counts.memories}  (${pinned} pinned, ${protectedCount} caveat-protected)`);
  console.log(`    file edits:     ${counts.file_edits}  across ${counts.unique_files} unique files`);
  console.log(`    sessions seen:  ${counts.sessions_seen}`);
  console.log(`    consolidations: ${counts.consolidations}`);
  console.log('');
  if (layerBreakdown.length > 0) {
    console.log('  Memories by layer');
    for (const r of layerBreakdown) {
      const bar = '█'.repeat(Math.min(40, Math.round((r.c / counts.memories) * 40)));
      console.log(`    ${r.layer.padEnd(15)} ${String(r.c).padStart(5)}  ${bar}`);
    }
    console.log('');
  }
  if (entityKinds.length > 0) {
    console.log('  Entities by kind');
    for (const r of entityKinds) {
      console.log(`    ${r.kind.padEnd(15)} ${r.c}`);
    }
    console.log('');
  }
  if (topEntities.length > 0) {
    console.log(`  Top ${topEntities.length} entities by memory count`);
    for (const e of topEntities) {
      console.log(`    ${String(e.memory_count).padStart(4)}  ${e.name.padEnd(30)} [${e.kind}]  momentum ${Number(e.momentum_score ?? 0).toFixed(1)}  last ${humanAge(e.last_access)}`);
    }
    console.log('');
  }
  if (topFiles.length > 0) {
    console.log('  Top 5 most-edited files');
    for (const f of topFiles) {
      const p = f.file_path || '';
      const shortPath = p.length > 65 ? '…' + p.slice(-64) : p;
      console.log(`    ${String(f.edits).padStart(4)} edits  ${shortPath}`);
    }
    console.log('');
  }
  console.log('  Run with --json for machine-readable output.');
  console.log('');

  db.close();
}

main();
