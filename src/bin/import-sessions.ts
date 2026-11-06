#!/usr/bin/env node
// Batch importer: scan Claude Code session JSONL files and populate linksee-memory.
// Usage:
//   node dist/bin/import-sessions.js [project_dir ...]
//   node dist/bin/import-sessions.js --dry-run [project_dir ...]
//   node dist/bin/import-sessions.js --all                   (scans all ~/.claude/projects/*)
//   node dist/bin/import-sessions.js --session-file <path>   (single jsonl — used by hook)
//
// Re-imports are idempotent and delete no memory (0.18.1): rows are matched by a stable key and
// updated in place, in one BEGIN IMMEDIATE transaction per session — see lib/session-import.ts.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDb, runMigrations } from '../db/migrate.js';
import { parseSessionFile, projectNameFromCwd, detectProjectName } from '../lib/session-parser.js';
import { extractSession, type ExtractedFileEdit } from '../lib/session-extractor.js';
import { normalizeEntityName } from '../lib/normalize.js';
import { importSession } from '../lib/session-import.js';

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

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) { usage(); return; }
  const dryRun = args.includes('--dry-run');
  const scanAll = args.includes('--all');
  const sessionFileIdx = args.indexOf('--session-file');
  const sessionFile = sessionFileIdx >= 0 ? args[sessionFileIdx + 1] : null;
  // --via stop-hook is passed by sync-session (the Claude Code Stop hook). Anything else is a
  // manual or batch import. Recorded in memories.source next to the session keys (0.18.0).
  const viaIdx = args.indexOf('--via');
  const via = viaIdx >= 0 && args[viaIdx + 1] === 'stop-hook' ? 'stop-hook' : 'import';
  const projectArgs = args.filter((a, i) => !a.startsWith('--')
    && (sessionFileIdx < 0 || i !== sessionFileIdx + 1)
    && (viaIdx < 0 || i !== viaIdx + 1));
  // The session keys are kept as they were: importSession finds these rows by the substring
  // `"session_id":"…"` (position does not matter, the exact text does).
  const sourceJson = (src: object): string => JSON.stringify({ ...src, client: 'claude-code', via });

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

    const projectName = detectProjectName(parsed) || 'unknown';
    const result = extractSession(parsed, projectName);

    if (dryRun) {
      console.log(`[dry] session ${result.session_id.slice(0, 8)} (${projectName}): ${result.memories.length} memories, ${result.file_edits.length} file_edits`);
      return;
    }

    if (!db) return;

    // Resolve project entity (canonical_key = project:<name>, so same project across
    // different sessions/cwds collapses to one entity)
    let projectEntityId: number;
    const canonicalKey = `project:${projectName.toLowerCase()}`;
    const normalized = normalizeEntityName(projectName);
    const existing = db.prepare('SELECT id FROM entities WHERE canonical_key = ? OR (kind = ? AND normalized_name = ?) OR (kind = ? AND LOWER(name) = LOWER(?))').get(canonicalKey, 'project', normalized, 'project', projectName) as { id: number } | undefined;
    if (existing) {
      projectEntityId = existing.id;
      // Backfill normalized_name if missing
      db.prepare('UPDATE entities SET normalized_name = ? WHERE id = ? AND normalized_name IS NULL').run(normalized, projectEntityId);
    } else {
      const ins = db.prepare('INSERT INTO entities (kind, name, normalized_name, canonical_key) VALUES (?, ?, ?, ?)').run('project', projectName, normalized, canonicalKey);
      projectEntityId = Number(ins.lastInsertRowid);
    }

    // created_at = the source turn's true timestamp (a re-import must not restamp old content).
    let r;
    try {
      r = importSession(db, result, { entityId: projectEntityId, sourceJson, startedAt: parsed.started_at || Math.floor(Date.now() / 1000) });
    } catch (e: any) {
      // The transaction rolled back: the session's earlier rows are as they were.
      console.error(`[error] ${result.session_id.slice(0, 8)} (${projectName}): ${e?.message ?? e} — nothing written`);
      db.close();
      process.exit(1);
    }
    console.log(`[ok] ${result.session_id.slice(0, 8)} (${projectName}): inserted ${r.inserted}m, updated ${r.updated}m, unchanged ${r.unchanged}m, left ${r.leftInPlace}m, ${r.edits}e (0 deleted)`);
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

    // Decode Claude Code's project-dir encoding: "C--Users-HP-KanseiLINK" → "KanseiLINK"
    // (the encoding replaces `/` with `--`, so the last segment is the actual project name)
    const rawDirName = projectDir.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'unknown';
    const decodedParts = rawDirName.split('--').filter(Boolean);
    const dirName = decodedParts.length > 1 ? decodedParts[decodedParts.length - 1] : rawDirName;
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

      // Detect project name from actual file edits (majority vote), falling back
      // to cwd-based detection. Previously used cwd alone, which collapsed many
      // distinct projects under one entity (e.g. "Card_Navi" for everything).
      const projectName = detectProjectName(parsed) || dirName;
      const result = extractSession(parsed, projectName);
      agg.sessions_parsed++;
      agg.memories_planned += result.memories.length;

      if (dryRun) {
        console.log(`  [dry] session ${result.session_id.slice(0, 8)} (${projectName}): ${result.memories.length} memories, ${result.file_edits.length} file_edits, stats=${JSON.stringify(result.stats)}`);
        continue;
      }

      if (!db) continue;

      // Resolve entity per-SESSION (not per-project-dir) since each session may
      // belong to a different project based on its file ops.
      const canonicalKey = `project:${projectName.toLowerCase()}`;
      const normalized = normalizeEntityName(projectName);
      const existing = db.prepare('SELECT id FROM entities WHERE canonical_key = ? OR (kind = ? AND normalized_name = ?) OR (kind = ? AND LOWER(name) = LOWER(?))').get(canonicalKey, 'project', normalized, 'project', projectName) as { id: number } | undefined;
      if (existing) {
        projectEntityId = existing.id;
        db.prepare('UPDATE entities SET normalized_name = ? WHERE id = ? AND normalized_name IS NULL').run(normalized, projectEntityId);
      } else {
        const ins = db.prepare('INSERT INTO entities (kind, name, normalized_name, canonical_key) VALUES (?, ?, ?, ?)').run('project', projectName, normalized, canonicalKey);
        projectEntityId = Number(ins.lastInsertRowid);
      }

      try {
        const r = importSession(db, result, { entityId: projectEntityId, sourceJson, startedAt: parsed.started_at || Math.floor(Date.now() / 1000) });
        agg.memories_inserted += r.inserted;
        agg.file_edits_inserted += r.edits;
      } catch (e: any) {
        agg.errors++;
        console.warn(`  [tx error] ${f}: ${e?.message ?? e} (rolled back; earlier rows kept)`);
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
