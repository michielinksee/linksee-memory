#!/usr/bin/env node
// linksee-memory-declare — declare / list / retire drift anchors (v8).
//
// The explicit write path for drift observability. Anchors declared here are clean
// by construction (declare-don't-mine): a human typed them. The bulk seeding script
// (curate the existing candidate pool) reuses curateAnchorFromMemory() from the lib.
//
// Usage:
//   linksee-memory-declare list [--status active|retired] [--kind prohibition|decision|constraint]
//   linksee-memory-declare add --kind <k> --statement "<text>" [--rationale "<text>"]
//        [--affects "glob1,glob2"] [--terms "t1,t2"] [--violation "v1,v2"] [--tier human|explicit]
//   linksee-memory-declare retire --id <n>

import { openDb, runMigrations } from '../db/migrate.js';
import {
  declareAnchor, listAnchors, retireAnchor, setNodeFields, getCurrentTruth, getAlertPolicy, setAlertPolicy,
  type AnchorKind, type AnchorTier,
} from '../lib/drift-anchors.js';

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

function splitList(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function print(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function main(): void {
  const [, , sub, ...rest] = process.argv;
  const flags = parseFlags(rest);
  const db = openDb();
  runMigrations(db); // ensure drift tables exist when run standalone

  try {
    switch (sub) {
      case 'add': {
        const anchor = declareAnchor(db, {
          kind: flags.kind as AnchorKind,
          statement: flags.statement ?? '',
          rationale: flags.rationale,
          affects: splitList(flags.affects),
          detect_terms: splitList(flags.terms),
          violation_signal: splitList(flags.violation),
          tier: (flags.tier as AnchorTier) || undefined,
        });
        // v9 ProjectCoreNode fields (minimal input — only what's given):
        //   --node-type --domain --mode --confidence --cadence --stale-days --applies --not-applies
        const nf: Record<string, unknown> = {};
        if (flags['node-type']) nf.node_type = flags['node-type'];
        if (flags.domain) nf.domain = flags.domain;
        if (flags.mode) nf.decision_mode = flags.mode;
        if (flags.confidence) nf.confidence = Number(flags.confidence);
        if (flags.cadence || flags['stale-days']) {
          const cp: Record<string, unknown> = { enabled: true };
          if (flags.cadence) cp.cadence_days = Number(flags.cadence);
          if (flags['stale-days']) cp.stale_threshold_days = Number(flags['stale-days']);
          nf.card_policy = cp;
        }
        if (flags.applies || flags['not-applies']) {
          const vs: Record<string, unknown> = {};
          if (flags.applies) vs.applies_to = splitList(flags.applies);
          if (flags['not-applies']) vs.does_not_apply_to = splitList(flags['not-applies']);
          nf.validity_scope = vs;
        }
        if (Object.keys(nf).length) setNodeFields(db, anchor.id, nf);
        print({ ok: true, declared: anchor, node_fields: Object.keys(nf).length ? nf : null });
        break;
      }
      case 'retire': {
        const id = Number(flags.id);
        if (!Number.isFinite(id)) throw new Error('--id <n> required');
        const ok = retireAnchor(db, id);
        print({ ok, retired: ok ? id : null });
        break;
      }
      case 'list':
      case undefined: {
        const anchors = listAnchors(db, {
          status: flags.status as any,
          kind: flags.kind as AnchorKind,
        });
        print({ ok: true, count: anchors.length, anchors });
        break;
      }
      case 'truth': {
        // ⑧ read_smart-style scoped read: active Current-Truth slice only.
        const nodes = getCurrentTruth(db, { domain: flags.domain, decision_mode: flags.mode });
        print({ ok: true, scope: { domain: flags.domain ?? 'all', decision_mode: flags.mode ?? 'all' }, count: nodes.length, current_truth: nodes });
        break;
      }
      case 'policy': {
        const p: Record<string, unknown> = {};
        if (flags['max-cards-per-day']) p.max_cards_per_day = Number(flags['max-cards-per-day']);
        if (flags['max-soft-per-week']) p.max_soft_cards_per_week = Number(flags['max-soft-per-week']);
        if (flags['min-soft-confidence']) p.min_confidence_for_soft_card = Number(flags['min-soft-confidence']);
        if (flags['two-sided']) p.require_two_sided_evidence = flags['two-sided'] !== 'false';
        const policy = Object.keys(p).length ? setAlertPolicy(db, p) : getAlertPolicy(db);
        print({ ok: true, alert_policy: policy });
        break;
      }
      default:
        throw new Error(`unknown subcommand "${sub}" — use: add | list | retire | truth | policy`);
    }
  } catch (err: any) {
    print({ ok: false, error: err?.message ?? String(err) });
    db.close();
    process.exit(1);
  }
  db.close();
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('declare-anchor.ts') ||
  process.argv[1]?.endsWith('declare-anchor.js')
) {
  main();
}
