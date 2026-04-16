#!/usr/bin/env node
// Batch importer: scan Claude Code session JSONL files and populate linksee-memory.
// Usage:
//   node dist/bin/import-sessions.js [project_dir ...]
//   node dist/bin/import-sessions.js --dry-run [project_dir ...]
//   node dist/bin/import-sessions.js --all                   (scans all ~/.claude/projects/*)
//   node dist/bin/import-sessions.js --session-file <path>   (single jsonl — used by hook)
//
// All inserts are IDEMPOTENT: existing data for a given session_id is wiped before re-insert.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDb, runMigrations } from '../db/migrate.js';
import { parseSessionFile, projectNameFromCwd } from '../lib/session-parser.js';
import { extractSession, type ExtractedFileEdit } from '../lib/session-extractor.js';

const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');

function usage(): void {
  console.log(`Usage:
  node dist/bin/import-sessions.js [--dry-run] [--all | <projectDir> [<projectDir> ...]]
    --all         : scan every project under ~/.claude/projects/*
    --dry-run     : parse + extract but do not write to DB
    projectDir    : absolute path to a project dir (must contain *.jsonl files)`);
}

function collectJsonlFiles(projectDir: string): string[] {
  try {
    return readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(projectDir, f))
      .filter((p) => {
        try { return statSync(p).isFile(); } catch { return false; }
      });
  } catch {
    return [];
  }
}

// Idempotent wipe: remove all rows tied to a given session_id BEFORE re-inserting.
// Uses LIKE matching on the JSON-encoded source field for memories/events.
function wipeSession(db: any, sessionId: string): { memories: number; edits: number; events: number } {
  const sidNeedle = `%"session_id":"${sessionId}"%`;
  const editDel = db.prepare('DELETE FROM session_file_edits WHERE session_id = ?').run(sessionId);
  const memDel = db.prepare('DELETE FROM memories WHERE source LIKE ?').run(sidNeedle);
  const evtDel = db.prepare('DELETE FROM events WHERE payload LIKE ?').run(sidNeedle);
  return { memories: memDel.changes, edits: editDel.changes, events: evtDel.changes };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) { usage(); return; }
  const dryRun = args.includes('--dry-run');
  const scanAll = args.includes('--all');
  const sessionFileIdx = args.indexOf('--session-file');
  const sessionFile = sessionFileIdx >= 0 ? args[sessionFileIdx + 1] : null;
  const projectArgs = args.filter((a, i) => !a.startsWith('--') && (sessionFileIdx < 0 || i !== sessionFileIdx + 1));

  // Single-file mode (used by the Stop hook)
  if (sessionFile) {
    const db = dryRun ? null : openDb();
    if (db) runMigrations(db);

    let parsed;
    try { parsed = parseSessionFile(sessionFile); } catch (e: any) {
      console.error(`[error] cannot parse ${sessionFile}: ${e?.message ?? e}`);
      process.exit(1);
    }
    if (!parsed) {
      console.log(`[skip] empty or invalid session: ${sessionFile}`);
      return;
    }

    const projectName = projectNameFromCwd(parsed.project_cwd) || 'unknown';
    const result = extractSession(parsed, projectName);

    if (dryRun) {
      console.log(`[dry] session ${result.session_id.slice(0, 8)} (${projectName}): ${result.memories.length} memories, ${result.file_edits.length} file_edits`);
      return;
    }

    if (!db) return;

    // Idempotent: wipe any prior data for THIS session before re-inserting
    const wiped = wipeSession(db, result.session_id);

    // Resolve project entity
    let projectEntityId: number;
    const canonicalKey = parsed.project_cwd;
    const existing = db.prepare('SELECT id FROM entities WHERE canonical_key = ? OR (kind = ? AND LOWER(name) = LOWER(?))').get(canonicalKey, 'project', projectName) as { id: number } | undefined;
    if (existing) {
      projectEntityId = existing.id;
    } else {
      const ins = db.prepare('INSERT INTO entities (kind, name, canonical_key) VALUES (?, ?, ?)').run('project', projectName, canonicalKey);
      projectEntityId = Number(ins.lastInsertRowid);
    }

    const insMem = db.prepare('INSERT INTO memories (entity_id, layer, content, importance, source) VALUES (?, ?, ?, ?, ?)');
    const insEdit = db.prepare(`INSERT INTO session_file_edits (session_id, memory_id, file_path, operation, turn_uuid, context_snippet, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insEvt = db.prepare('INSERT INTO events (entity_id, kind, payload, occurred_at) VALUES (?, ?, ?, ?)');

    let inserted = { memories: 0, edits: 0 };
    db.transaction(() => {
      const memContentToId = new Map<string, number>();
      for (const m of result.memories) {
        const res = insMem.run(projectEntityId, m.layer, m.content, m.importance, JSON.stringify(m.source));
        memContentToId.set(m.content, Number(res.lastInsertRowid));
        inserted.memories++;
      }
      for (const fe of result.file_edits) {
        const memId = fe.memory_content ? memContentToId.get(fe.memory_content) ?? null : null;
        insEdit.run(fe.session_id, memId, fe.file_path, fe.operation, fe.turn_uuid ?? null, fe.context_snippet, fe.occurred_at);
        inserted.edits++;
      }
      insEvt.run(projectEntityId, 'session_imported', JSON.stringify({
        session_id: result.session_id,
        memories: result.memories.length,
        file_edits: result.file_edits.length,
        stats: result.stats,
      }), parsed.started_at || Math.floor(Date.now() / 1000));
    })();

    console.log(`[ok] ${result.session_id.slice(0, 8)} (${projectName}): wiped ${wiped.memories}m/${wiped.edits}e/${wiped.events}ev → inserted ${inserted.memories}m/${inserted.edits}e`);
    db.close();
    return;
  }

  let projectDirs: string[] = [];
  if (scanAll) {
    try {
      projectDirs = readdirSync(CLAUDE_PROJECTS)
        .map((d) => join(CLAUDE_PROJECTS, d))
        .filter((p) => {
          try { return statSync(p).isDirectory(); } catch { return false; }
        });
    } catch (e) {
      console.error(`Cannot scan ${CLAUDE_PROJECTS}:`, e);
      process.exit(1);
    }
  } else {
    projectDirs = projectArgs;
  }

  if (projectDirs.length === 0) {
    usage();
    process.exit(1);
  }

  const db = dryRun ? null : openDb();
  if (db) runMigrations(db);

  const agg = {
    projects: 0,
    sessions_parsed: 0,
    sessions_skipped: 0,
    memories_planned: 0,
    memories_inserted: 0,
    file_edits_inserted: 0,
    errors: 0,
  };

  for (const projectDir of projectDirs) {
    const files = collectJsonlFiles(projectDir);
    if (files.length === 0) { console.log(`[skip] no .jsonl in ${projectDir}`); continue; }
    agg.projects++;

    const dirName = projectDir.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'unknown';
    console.log(`\n=== Project: ${dirName} (${files.length} session files) ===`);

    let projectEntityId: number | null = null;

    for (const f of files) {
      let parsed;
      try { parsed = parseSessionFile(f); } catch (e: any) {
        agg.errors++;
        console.warn(`  [error] ${f}: ${e?.message ?? e}`);
        continue;
      }
      if (!parsed) { agg.sessions_skipped++; continue; }

      const projectName = projectNameFromCwd(parsed.project_cwd) || dirName;
      const result = extractSession(parsed, projectName);
      agg.sessions_parsed++;
      agg.memories_planned += result.memories.length;

      if (dryRun) {
        console.log(`  [dry] session ${result.session_id.slice(0, 8)} (${projectName}): ${result.memories.length} memories, ${result.file_edits.length} file_edits, stats=${JSON.stringify(result.stats)}`);
        continue;
      }

      if (!db) continue;

      // Ensure entity exists (once per project)
      if (projectEntityId === null) {
        const canonicalKey = parsed.project_cwd;
        const existing = db.prepare('SELECT id FROM entities WHERE canonical_key = ? OR (kind = ? AND LOWER(name) = LOWER(?))').get(canonicalKey, 'project', projectName) as { id: number } | undefined;
        if (existing) {
          projectEntityId = existing.id;
        } else {
          const ins = db.prepare('INSERT INTO entities (kind, name, canonical_key) VALUES (?, ?, ?)').run('project', projectName, canonicalKey);
          projectEntityId = Number(ins.lastInsertRowid);
        }
      }

      // Idempotent: wipe any prior data for THIS session before re-inserting (Phase B)
      wipeSession(db, result.session_id);

      // Insert memories + file_edits in a single transaction per session
      const insMem = db.prepare('INSERT INTO memories (entity_id, layer, content, importance, source) VALUES (?, ?, ?, ?, ?)');
      const insEdit = db.prepare(`INSERT INTO session_file_edits (session_id, memory_id, file_path, operation, turn_uuid, context_snippet, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const insEvt = db.prepare('INSERT INTO events (entity_id, kind, payload, occurred_at) VALUES (?, ?, ?, ?)');

      const tx = db.transaction(() => {
        const memContentToId = new Map<string, number>();

        for (const m of result.memories) {
          const srcJson = JSON.stringify(m.source);
          const res = insMem.run(projectEntityId, m.layer, m.content, m.importance, srcJson);
          memContentToId.set(m.content, Number(res.lastInsertRowid));
          agg.memories_inserted++;
        }

        for (const fe of result.file_edits) {
          const memId = fe.memory_content ? memContentToId.get(fe.memory_content) ?? null : null;
          insEdit.run(fe.session_id, memId, fe.file_path, fe.operation, fe.turn_uuid ?? null, fe.context_snippet, fe.occurred_at);
          agg.file_edits_inserted++;
        }

        insEvt.run(projectEntityId, 'session_imported', JSON.stringify({
          session_id: result.session_id,
          memories: result.memories.length,
          file_edits: result.file_edits.length,
          stats: result.stats,
        }), parsed.started_at || Math.floor(Date.now() / 1000));
      });

      try {
        tx();
      } catch (e: any) {
        agg.errors++;
        console.warn(`  [tx error] ${f}: ${e?.message ?? e}`);
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  projects:           ${agg.projects}`);
  console.log(`  sessions parsed:    ${agg.sessions_parsed}`);
  console.log(`  sessions skipped:   ${agg.sessions_skipped}`);
  console.log(`  memories planned:   ${agg.memories_planned}`);
  console.log(`  memories inserted:  ${agg.memories_inserted}${dryRun ? ' (DRY RUN — nothing written)' : ''}`);
  console.log(`  file_edits inserted:${agg.file_edits_inserted}${dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`  errors:             ${agg.errors}`);

  if (db) db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
