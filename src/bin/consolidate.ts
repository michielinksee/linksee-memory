#!/usr/bin/env node
// linksee-memory consolidate --dry-run | --apply [--min-age-days N] [--json]   (0.18.1)
//
// Runs sleep-mode consolidation by hand. Since 0.18.1 it never deletes a row: each cluster of
// cold, unprotected, JSON-content memories (same entity, same layer, older than N days, 2 or
// more) gets one `learning`-layer summary, and the originals are marked
// `consolidated_into: <summary id>` in their content JSON. `recall` hides marked rows by
// default and says how many (`consolidated_hidden`); `include_consolidated: true` shows them.
//
// --dry-run   prints what --apply would fold (counts, then up to 3 example clusters). Writes
//             nothing. Also prints how many rows the forget-sweep of 0.18.0 and earlier would
//             have deleted, so the user can see what those versions were doing.
// --apply     folds. Rows marked, 0 deleted. Prints the result.
// No flag     prints this usage and exits 1 — nothing is read or written.
//
// The server's own run at start-up stays off unless LINKSEE_AUTO_CONSOLIDATE=1.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, runMigrations, getDbPath, DbRefusedError } from '../db/migrate.js';
import { planConsolidate, consolidate, countSweepCandidates } from '../lib/consolidate.js';

const USAGE = `linksee-memory consolidate — fold cold memories into summaries (nothing is deleted)

  --dry-run            show what --apply would fold; writes nothing
  --apply              fold: one learning-layer summary per cluster, originals marked
                       consolidated_into and kept (recall hides them by default)
  --min-age-days N     only rows older than N days are candidates (default 7)
  --json               machine-readable output
  -h, --help           this message

Exactly one of --dry-run / --apply is required.
DB: ${getDbPath()}
`;

interface Args { dryRun: boolean; apply: boolean; minAgeDays?: number; json: boolean; help: boolean; bad?: string }

export function parseArgs(argv: readonly string[]): Args {
  const a: Args = { dryRun: false, apply: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--dry-run' || v === '--dry') a.dryRun = true;
    else if (v === '--apply') a.apply = true;
    else if (v === '--json') a.json = true;
    else if (v === '-h' || v === '--help') a.help = true;
    else if (v === '--min-age-days') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0) { a.bad = `--min-age-days needs a number >= 0, got "${argv[i] ?? ''}"`; }
      else a.minAgeDays = n;
    } else a.bad = `unknown argument "${v}"`;
  }
  return a;
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(USAGE); return 0; }
  if (args.bad) { process.stderr.write(`${args.bad}\n\n${USAGE}`); return 1; }
  if (args.dryRun === args.apply) {
    // neither, or both: refuse before touching the DB
    process.stderr.write(`consolidate: pass exactly one of --dry-run or --apply (nothing was done)\n\n${USAGE}`);
    return 1;
  }

  let db: ReturnType<typeof openDb>;
  try {
    db = openDb();
    runMigrations(db);
  } catch (e) {
    if (e instanceof DbRefusedError) { process.stderr.write(`${e.message}\n`); return 1; }
    throw e;
  }

  try {
    const before = (db.prepare('SELECT COUNT(*) AS c FROM memories').get() as any).c as number;

    if (args.dryRun) {
      const plan = planConsolidate(db, { min_age_days: args.minAgeDays });
      const sweepWouldHaveDropped = countSweepCandidates(db);
      if (args.json) {
        process.stdout.write(JSON.stringify({
          dry_run: true,
          memories: before,
          scanned: plan.scanned,
          clusters: plan.clusters.length,
          would_fold: plan.wouldFold,
          would_delete: 0,
          cold_unclustered: plan.coldUnclustered,
          skipped_plain_text: plan.skippedPlainText,
          sweep_pre_0_18_1_would_have_deleted: sweepWouldHaveDropped,
          examples: plan.clusters.slice(0, 3).map((c) => ({ entity: c.entity_name, layer: c.layer, ids: c.ids, examples: c.examples })),
        }, null, 2) + '\n');
        return 0;
      }
      const lines = [
        `consolidate --dry-run (nothing written)`,
        `  memories in DB:            ${before}`,
        `  scanned (candidates):      ${plan.scanned}`,
        `  clusters:                  ${plan.clusters.length}`,
        `  rows --apply would mark:   ${plan.wouldFold}   (consolidated_into; rows stay)`,
        `  rows --apply would delete: 0`,
        `  cold but unclustered:      ${plan.coldUnclustered}   (left alone)`,
        `  plain-text, skipped:       ${plan.skippedPlainText}   (the mark needs JSON content)`,
        `  the forget-sweep of 0.18.0 and earlier would have deleted: ${sweepWouldHaveDropped}`,
      ];
      if (plan.clusters.length > 0) {
        lines.push('', `  examples (${Math.min(3, plan.clusters.length)} of ${plan.clusters.length} clusters):`);
        for (const c of plan.clusters.slice(0, 3)) {
          lines.push(`    ${c.entity_name} / ${c.layer}: ${c.ids.length} rows (ids ${c.ids.slice(0, 5).join(', ')}${c.ids.length > 5 ? ', …' : ''})`);
          for (const ex of c.examples) lines.push(`      - ${ex}`);
        }
      }
      lines.push('', `  to fold: npx linksee-memory consolidate --apply`);
      process.stdout.write(lines.join('\n') + '\n');
      return 0;
    }

    // --apply
    const r = consolidate(db, { scope: 'all', min_age_days: args.minAgeDays });
    const after = (db.prepare('SELECT COUNT(*) AS c FROM memories').get() as any).c as number;
    // A row count that went down is a bug in this version; say so loudly.
    const lost = before + r.learningIdsCreated.length - after;
    if (args.json) {
      process.stdout.write(JSON.stringify({ applied: true, memories_before: before, memories_after: after, rows_lost: lost, ...r }, null, 2) + '\n');
    } else {
      process.stdout.write([
        `consolidate --apply`,
        `  summaries written:         ${r.clustersCompressed}   (learning layer, ids ${r.learningIdsCreated.slice(0, 5).join(', ')}${r.learningIdsCreated.length > 5 ? ', …' : ''})`,
        `  rows marked consolidated_into: ${r.memoriesFolded}   (still in the DB; recall({ include_consolidated: true }) shows them)`,
        `  rows deleted:              ${r.memoriesDropped}`,
        `  memories before / after:   ${before} / ${after}`,
        `  in_progress → stalled:     ${r.stalledTransitions}`,
        `  decision edges detected:   ${r.memoryEdgesCreated} (superseded marked: ${r.decisionsSuperseded})`,
      ].join('\n') + '\n');
    }
    if (lost !== 0) {
      process.stderr.write(`consolidate: row count moved by ${lost} beyond the summaries written — this must not happen; please report it\n`);
      return 2;
    }
    return 0;
  } finally {
    db.close();
  }
}

const isMain = (() => {
  try {
    const a = process.argv[1] ? realpathSync(process.argv[1]) : '';
    const b = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch { return false; }
})();
if (isMain) process.exit(main(process.argv.slice(2)));
