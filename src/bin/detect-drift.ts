#!/usr/bin/env node
// linksee-memory-detect — run the drift detector (照合: declared intent vs. actual reality).
//
// The manual-trigger entry point for drift detection (the cadence question). Mirrors
// declare-anchor.ts; purely additive — touches only drift_edges (the feature's own table) and
// ONLY when --persist is passed. SAFE BY DEFAULT: a bare run is a dry-run (reads only, no
// writes), so you can preview drift before committing it to the view. Pass --persist to write
// the edges that /drift renders. No embedding layer: matching is lexical/glob/trigram-FTS only.
//
// Usage:
//   linksee-memory-detect                  # dry-run — preview drift, writes NOTHING (default)
//   linksee-memory-detect --persist         # write contradicts/absent edges into drift_edges
//   linksee-memory-detect --stale-days 30   # override absence staleness gate (default 14)
//   linksee-memory-detect --threshold 0.5   # override emit threshold (default 0.5)

import { openDb, runMigrations } from '../db/migrate.js';
import { detectDrift, detectFileViolations } from '../lib/drift-detection.js';

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = 'true';
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function print(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function main(): void {
  const [, , ...rest] = process.argv;
  const flags = parseFlags(rest);
  const persist = flags.persist === 'true';
  const staleDays = flags['stale-days'] !== undefined ? Number(flags['stale-days']) : undefined;
  const emitThreshold = flags.threshold !== undefined ? Number(flags.threshold) : undefined;

  if (staleDays !== undefined && !Number.isFinite(staleDays)) throw new Error('--stale-days <n> must be a number');
  if (emitThreshold !== undefined && !Number.isFinite(emitThreshold)) throw new Error('--threshold <n> must be a number');

  const db = openDb();
  runMigrations(db); // ensure drift tables exist when run standalone

  try {
    const res = detectDrift(db, { dryRun: !persist, staleDays, emitThreshold });
    const fres = detectFileViolations(db, { dryRun: !persist, emitThreshold });
    print({
      ok: true,
      mode: persist ? 'PERSISTED' : 'DRY RUN (no writes — pass --persist to write)',
      persisted: res.persisted,
      anchorsScanned: res.anchorsScanned,
      editsScanned: res.editsScanned,
      // v1 — edit-snippet scan (what a captured edit's snippet contained)
      editSnippetScan: {
        contradicts: res.contradicts,
        absent: res.absent,
        edgesEmitted: res.edgesEmitted,
        byAnchorHits: res.byAnchor.filter((b) => b.contradicts > 0 || b.absent > 0),
        samples: res.samples.slice(0, 6),
      },
      // v2 — current-file scan (live file:line against violation_signal)
      currentFileScan: {
        filesScanned: fres.filesScanned,
        anchorsCapped: fres.anchorsCapped,
        contradicts: fres.contradicts,
        edgesEmitted: fres.edgesEmitted,
        byAnchorHits: fres.byAnchor,
        samples: fres.samples.slice(0, 14),
      },
      totalEdgesEmitted: res.edgesEmitted + fres.edgesEmitted,
    });
  } catch (err: any) {
    print({ ok: false, error: err?.message ?? String(err) });
    db.close();
    process.exit(1);
  }
  db.close();
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('detect-drift.ts') ||
  process.argv[1]?.endsWith('detect-drift.js')
) {
  main();
}
