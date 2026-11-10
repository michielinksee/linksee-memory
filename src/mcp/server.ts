#!/usr/bin/env node
// linksee-memory MCP server (stdio transport).
// Tools: remember / recall / read_smart / drift_status / check_decision / declare_anchor / resolve_drift / flag_proposals / dream / resolve_proposal / share_draft
// v0.10.0 — Re-injection layer: pre-action guard (PreToolUse/SessionStart hooks) + extraction
//           quality gate + distillation routine (dream distill_queue) + harden/soften escalation

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { openDb, runMigrations, DbRefusedError } from '../db/migrate.js';
import { NoSqliteDriverError } from '../db/sqlite.js';
import { computeHeat } from '../lib/heat-index.js';
import { refreshMomentumForEntity } from '../lib/momentum.js';
import { consolidate as runConsolidate, autoConsolidateEnabled, planConsolidate, CONSOLIDATED_SQL } from '../lib/consolidate.js';
import { isPastedExternalContent } from '../lib/session-parser.js';
import { inferAltitude, inferType, inferState } from '../lib/session-extractor.js';
import { normalizeEntityName } from '../lib/normalize.js';
import { handleReadSmart as handleReadSmartImpl } from './read-smart.js';
import { STATIC_RESOURCES, RESOURCE_TEMPLATES, readResource } from './resources.js';
import { PROMPTS, getPrompt } from './prompts.js';
import { fetchRoots, isInsideRoots, rootPathFromUri } from './roots.js';
import { sampleConsolidation } from './sampling.js';
import { confirmForget } from './elicitation.js';
import { getTruthView, getDecisionDetail, resolveDrift } from '../lib/truth-engine.js';
import { declareAnchor, setNodeFields } from '../lib/drift-anchors.js';
import { getReinjectionFriction, setGateMode, type FrictionItem } from '../lib/guard.js';
import { logAnchorTouch } from '../lib/anchor-touch.js';
import { triageDistillQueue, distillPending } from '../lib/distill-triage.js';
import { whereAmI, listMapProjects } from '../lib/map-view.js';
import { buildShareDraft, KINDS, RUNTIMES } from '../lib/share-draft.js';
import { parseSupersedesArg, checkSupersedes, applySupersedes, SupersedeRefused, mcpSource, byFromSource } from '../lib/supersede.js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Single source of truth: read our own version from package.json so the MCP
// serverInfo can never drift from the published package version. (We catch
// doc/code drift for a living — our own version string shouldn't drift.)
function readServerVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    // dist/mcp/server.js → ../../package.json
    const pkgPath = join(dirname(dirname(dirname(here))), 'package.json');
    if (existsSync(pkgPath)) {
      return String(JSON.parse(readFileSync(pkgPath, 'utf8')).version || '0.0.0');
    }
  } catch { /* fall through */ }
  return '0.0.0';
}

const SERVER_VERSION = readServerVersion();

// ── Subcommand dispatch ───────────────────────────────────────────────────────
// Each CLI ships as its own bin (linksee-memory-setup, …) AND as a subcommand of
// the main bin, so `npx -y linksee-memory <sub>` works for a cold user: npx can
// only resolve the package name (linksee-memory), not sibling bin names like
// linksee-memory-setup. Run as the MCP server (no subcommand / stdio) → skip this.
const SUBCOMMANDS: Record<string, string> = {
  setup: 'setup.js',
  map: 'map-import.js',
  sync: 'sync-session.js',
  guard: 'guard-hook.js',
  stats: 'stats.js',
  import: 'import-sessions.js',
  'install-skill': 'install-skill.js',
  declare: 'declare-anchor.js',
  detect: 'detect-drift.js',
  export: 'export-report.js',
  'share-draft': 'share-draft.js',
  migrate: 'migrate-legacy.js',   // 0.17.2: schema 1–5 → current, without starting the server
  runtime: 'runtime.js',          // 0.17.2: runtime list | prune
  consolidate: 'consolidate.js',  // 0.18.1: consolidate --dry-run | --apply (marks, never deletes)
};
const subcommand = process.argv[2];
if (subcommand && Object.prototype.hasOwnProperty.call(SUBCOMMANDS, subcommand)) {
  // Spawn the target bin as a child (shebang-safe, argv/stdio correct) and exit with its code.
  const binPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', SUBCOMMANDS[subcommand]);
  const r = spawnSync(process.execPath, [binPath, ...process.argv.slice(3)], { stdio: 'inherit' });
  process.exit(r.status ?? (r.signal ? 1 : 0));
}

let db!: ReturnType<typeof openDb>;
try {
  db = openDb();
  runMigrations(db);
} catch (e) {
  // A pre-June-2026 DB (schema < 6) is refused before any write; print what to do
  // instead of a stack trace. MCP clients show the server's stderr in their logs.
  if (e instanceof DbRefusedError) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
  // 0.19.0: no SQLite driver at all (Node < 22.16 and better-sqlite3 not built, e.g. npm 12 blocked
  // its install script) → one line saying how to get one, not a bindings stack trace.
  if (e instanceof NoSqliteDriverError) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
  throw e;
}

// Distill triage runs on EVERY start, before the first request. It is one indexed scan and a
// handful of JSON rewrites — cheap — and 0.16.0 had tucked it inside the auto-consolidate block
// below, which runs at most once a week and only after a 3-second timer. So it never ran.
try {
  const t = triageDistillQueue(db);
  if (t.noise + t.stale > 0) {
    process.stderr.write(`[linksee-memory] distill triage: archived ${t.noise} noise + ${t.stale} stale, ${t.remaining} remain\n`);
  }
} catch { /* never block startup */ }

// Auto-maintenance: consolidate stale memories on startup (non-blocking).
//
// OFF by default (0.17.1 intended this; 0.18.1 makes it hold and takes the delete out):
// up to 0.18.0 consolidate deleted the original rows after writing a summary that kept only the
// top 3 × 200 characters, then a forget-sweep deleted every other cold row — reasons and history
// lost with no action from the user (1,360 rows on 2026-10-29, 559 on 2026-11-05 on the
// maintainer's DB). Since 0.18.1 nothing is deleted: originals are marked `consolidated_into`
// and hidden from the default recall. It still runs only when asked: LINKSEE_AUTO_CONSOLIDATE=1
// (or `--auto-consolidate` on the server command line); by hand: `npx linksee-memory consolidate
// --dry-run | --apply`. When off, one stderr line says how many rows a run would fold, so a
// growing database is noticed without anything being touched. There is no `consolidate` MCP tool
// (merged away in 0.7.0). Rows already removed by earlier versions are not restored.
const autoConsolidateOn = autoConsolidateEnabled(process.env, process.argv.slice(2));
setTimeout(() => {
  try {
    if (!autoConsolidateOn) {
      // Read-only: count what a run would fold. Never throws out of here, never writes.
      const plan = planConsolidate(db, { min_age_days: 7 });
      process.stderr.write(
        `[linksee-memory] auto-consolidate is off (set LINKSEE_AUTO_CONSOLIDATE=1 to enable); ${plan.wouldFold} cold memories would be folded` +
        ` (run: npx linksee-memory consolidate --dry-run)\n`
      );
      return;
    }
    let shouldRun = true;
    try {
      // Check if consolidations table exists before querying
      const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='consolidations'").get();
      if (tableExists) {
        const lastRow = db.prepare('SELECT MAX(created_at) as ts FROM consolidations').get() as any;
        if (lastRow?.ts && (Date.now() / 1000 - lastRow.ts) / 86400 < 7) shouldRun = false;
      }
    } catch { shouldRun = false; /* genuinely unexpected — skip to be safe */ }
    if (shouldRun) {
      const r = runConsolidate(db, { scope: 'all', min_age_days: 7 });
      process.stderr.write(`[linksee-memory] auto-consolidate complete: ${r.clustersCompressed} summaries, ${r.memoriesFolded} rows marked consolidated_into (0 deleted)\n`);
    }
  } catch { /* non-fatal */ }
}, 3000);

const server = new Server(
  { name: 'linksee-memory', version: SERVER_VERSION },
  {
    capabilities: {
      tools: {},
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
      // Sampling, Roots, Elicitation are CLIENT capabilities the server consumes.
      // We don't declare them under "capabilities" — we just call them via server.request
      // and gracefully degrade when the client doesn't support them.
    },
  }
);

// ============================================================
// Layer alias map — natural language → canonical layer
// (agents can say layer="decisions" and we resolve to "learning")
// ============================================================
const LAYER_ALIASES: Record<string, string> = {
  // canonical — identity
  goal: 'goal', context: 'context', emotion: 'emotion',
  implementation: 'implementation', caveat: 'caveat', learning: 'learning',
  // natural-language aliases
  why: 'goal', goals: 'goal', target: 'goal', targets: 'goal', intent: 'goal',
  background: 'context', reason: 'context', situation: 'context', timing: 'context',
  tone: 'emotion', feelings: 'emotion', mood: 'emotion',
  impl: 'implementation', success: 'implementation', failure: 'implementation',
  how: 'implementation', tried: 'implementation', attempts: 'implementation',
  warning: 'caveat', warnings: 'caveat', pain: 'caveat', rule: 'caveat',
  rules: 'caveat', pitfall: 'caveat', pitfalls: 'caveat', dont: 'caveat',
  decision: 'learning', decisions: 'learning', learned: 'learning',
  insight: 'learning', insights: 'learning', growth: 'learning',
};

function resolveLayer(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const k = String(input).toLowerCase().trim();
  return LAYER_ALIASES[k] ?? k;
}

const LAYER_ENUM = ['goal', 'context', 'emotion', 'implementation', 'caveat', 'learning'] as const;

// ============================================================
// Tool schema declarations
// ============================================================

const TOOLS = [
  {
    name: 'remember',
    description:
      'Persist knowledge across sessions and AI tools (Claude, GPT, Cursor, Codex, Gemini). The only cross-agent memory that survives session boundaries.\n\nWHEN TO CALL:\n• The moment an error or failure occurs → layer: "caveat" (auto-protected, never forgotten)\n• When a decision is made or approved → content + anchor: {} (remembered AND enforced in one call)\n• When a goal is set or updated → layer: "goal"\n• When something new is learned → layer: "learning"\n• When the user says "remember this" / "覚えておいて"\n• After completing a task or receiving user approval\n\nMODES:\n• Create (default): content is the only required field. entity defaults to the project you are in; layer defaults to "context" (or "learning" when anchor is set).\n• Create + enforce: add anchor: {} — the memory also becomes a decision the guard re-injects before Edit/Write/Bash and on session start. Give anchor.violation_signal (forbidden strings) to make contradictions detectable; anchor.affects (path globs) to scope it.\n• Update: memory_id (+ optional content, layer, importance). content replaces the stored content; add merge: true to change only the JSON keys you send (the other keys are kept, a key sent as null is removed)\n• Delete: memory_id + forget: true\n\nImportance ≥ 0.9 pins the memory (protected from auto-forgetting). Supports Japanese (日本語) and English.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_name: { type: 'string', description: 'What this memory is about. Optional — defaults to the project you are working in (from workspace roots, else the files edited recently).' },
        entity_kind: { type: 'string', enum: ['person', 'company', 'project', 'concept', 'file', 'other'], description: 'Optional — defaults to "project".' },
        anchor: {
          description: 'Also declare this as an enforceable decision. Pass {} for defaults, or an object: { kind?: "decision"|"prohibition"|"constraint", violation_signal?: string[] (forbidden strings — needed for the gate to detect a contradiction), affects?: string[] (path globs that scope it), detect_terms?: string[], domain?: string, rationale?: string }. Without violation_signal the anchor is a constraint: re-injected on session start and when its scope is touched, but no contradiction can be detected.',
          anyOf: [
            { type: 'boolean' },
            {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['decision', 'prohibition', 'constraint'] },
                violation_signal: { type: 'array', items: { type: 'string' } },
                affects: { type: 'array', items: { type: 'string' } },
                detect_terms: { type: 'array', items: { type: 'string' } },
                domain: { type: 'string' },
                rationale: { type: 'string' },
              },
            },
          ],
        },
        entity_key: { type: 'string', description: 'Optional canonical key (email, domain, file path)' },
        layer: { type: 'string', description: 'One of: goal / context / emotion / implementation / caveat / learning. Aliases accepted (why→goal, warnings→caveat, decisions→learning, how→implementation). Optional — defaults to "context", or "learning" when anchor is set.' },
        content: { type: 'string', description: 'The memory content (plain text or structured JSON with altitude/type/state/what/why). The only required field for create.' },
        importance: { type: 'number', minimum: 0, maximum: 1, description: '0.0-1.0. Set ≥0.9 to pin (protects from forgetting).' },
        thread_id: { type: 'string', description: 'Optional thread ID to group related memories (decision chains, session groups).' },
        force: { type: 'boolean', default: false, description: 'Bypass the paste-back quality check and the broken-JSON check: content that starts like JSON but does not parse is then stored as text.' },
        memory_id: { type: 'number', description: 'Set to update an existing memory instead of creating. Only content/layer/importance are changed.' },
        merge: { type: 'boolean', default: false, description: 'Update mode only (with memory_id): merge the keys of content (a JSON object) into the stored JSON object instead of replacing it. Keys you send win; a key sent as null is removed — except the provenance keys (title, evidence_refs, session_id, restored_from, original_id, original_created_at, restored_verdict, supersedes, superseded_by, consolidated_into, distilled, altitude, type, state), where null refuses the merge; every other stored key (title, affects, evidence_refs, session_id, …) is kept. Refused, and nothing is written, when the stored content or the new content is not a JSON object. Without merge, content replaces the whole stored content.' },
        forget: { type: 'boolean', default: false, description: 'Set true + memory_id to delete a memory. Caveat-layer and pinned memories cannot be deleted.' },
        supersedes: {
          description: 'Create mode only: the memory id(s) this new memory replaces (a reversed or updated decision). Writes a supersedes link and marks the old memory superseded; recall then hides it unless include_superseded is true. Refused — and nothing is saved — if an id does not exist, belongs to another entity, or is a raw session capture — and when content is JSON missing any of altitude/type/state (send plain text or all three).',
          anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' } }],
        },
      },
    },
  },
  {
    name: 'recall',
    description:
      'Your persistent memory across all AI tools. CALL THIS BEFORE STARTING ANY TASK to check for past caveats (pain records), decisions, and learnings — prevents repeating mistakes across sessions.\n\nTypical usage: recall({ query: "keywords" }) for search, recall({ path: "file.ts" }) for file history, recall() for overview.\n\nWHEN TO CALL:\n• Before starting any new task or touching a file\n• When the user mentions "before" / "前に" / "last time" / "remember when"\n• When an error occurs — check if you\'ve seen it before\n• When making a decision — check for prior decisions on the same topic\n\nTHREE MODES (auto-detected):\n• Search (default): provide query → returns memories ranked by relevance + heat\n• File history: provide path → returns complete edit history with user-intent context\n• Session brief: omit all params → what needs attention (🔴/🟡), where you are on the Map, open loops (proposals / distill queue / friction), top entities. CALL THIS FIRST in a new session.\n• Locate: where: "<topic>" → your position on the Current Truth Map + blast radius (what else moves if you touch this). where: true → auto-locate from recent edits\n• Dream: dream: true → North Star + orphaned proposals to triage + distill_queue + friction (the full triage session; the brief carries only the counts)\n• Entity list: overview: true (the old no-arg behaviour)\n\nWorks across Claude, GPT, Cursor, Codex, Gemini — one local SQLite file, nothing leaves your machine.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to remember. Use keywords, entity names, or FTS5 expressions. Omit for entity overview.' },
        entity_name: { type: 'string', description: 'Narrow to a specific entity' },
        layer: { type: 'string', description: 'Layer filter. Accepts aliases (decisions/warnings/how/etc.).' },
        altitude: { type: 'string', enum: ['mission', 'strategy', 'architecture', 'implementation'], description: 'Filter by cognitive altitude.' },
        mem_type: { type: 'string', enum: ['question', 'comparison', 'decision', 'work', 'outcome', 'learning', 'note'], description: 'Filter by memory type.' },
        mem_state: { type: 'string', enum: ['open', 'decided', 'in_progress', 'done', 'stalled', 'parked', 'superseded'], description: 'Filter by lifecycle state.' },
        thread_id: { type: 'string', description: 'Filter by thread ID for decision chains.' },
        band: { type: 'string', enum: ['hot', 'warm', 'cold', 'frozen'], description: 'Filter by heat band.' },
        max_tokens: { type: 'number', description: 'Token budget. Default 2000.', default: 2000 },
        limit: { type: 'number', description: 'Hard cap on results.' },
        offset: { type: 'number', description: 'Skip N results (pagination).', default: 0 },
        mark_accessed: { type: 'boolean', default: true, description: 'Set false for preview queries.' },
        path: { type: 'string', description: 'File path or substring. When set, returns file edit history with per-edit user-intent context instead of memory search.' },
        max_intents: { type: 'number', description: 'For file mode: max user-intent snippets. Default 10.', default: 10 },
        scope_to_roots: { type: 'boolean', default: false, description: 'For file mode: filter to client-provided roots.' },
        include_superseded: { type: 'boolean', default: false, description: 'Also return memories that a newer memory superseded (hidden by default; each carries superseded_by).' },
        include_consolidated: { type: 'boolean', default: false, description: 'Also return memories that consolidate folded into a summary (hidden by default, still in the DB; each carries consolidated_into = the summary id).' },
        explain: { type: 'boolean', default: false, description: 'Include ranking internals (composite, heat, band, momentum, match_reasons, score_breakdown). Off by default so more memories fit the token budget.' },
        where: { description: 'Locate on the Current Truth Map. A topic string, or true to auto-locate from the files you edited recently. Returns your node, journey stage, blast radius, and the decision behind it.', anyOf: [{ type: 'string' }, { type: 'boolean' }] },
        project: { type: 'string', description: 'With where: the Map project slug, when several maps are imported.' },
        dream: { type: 'boolean', default: false, description: 'Return the full triage set: North Star, orphaned proposals (each with candidate_id), distill_queue, friction. Resolve proposals with resolve_drift({ candidate_id, action }); rewrite distill items with remember({ memory_id, merge: true, content }) — merge keeps the keys you do not send.' },
        distill: { type: 'number', description: 'With dream: how many raw memories to return for rewriting (default 8, max 25). The queue is value-ordered; rule-verdicted items never appear.' },
        overview: { type: 'boolean', default: false, description: 'Return the entity list instead of the session brief when no query is given.' },
        kind: { type: 'string', enum: ['person', 'company', 'project', 'concept', 'file', 'other'], description: 'For overview mode: filter by entity kind.' },
        min_memories: { type: 'number', description: 'For overview mode: minimum memory count. Default 1.', default: 1 },
      },
    },
  },
  {
    name: 'read_smart',
    description:
      'Token-saving file reader with AST-aware diff caching. Use INSTEAD of the standard Read tool for ALL file reads — even first reads gain chunk metadata for future savings.\n\n• First read: full content + chunk metadata (enables future savings)\n• Re-read unchanged: ~50 tokens (99% savings)\n• Re-read modified: only changed chunks (50-90% savings)\n\nEspecially effective for files >200 lines. Always prefer this over Read.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
        force: { type: 'boolean', description: 'Return full content regardless of cache', default: false },
      },
      required: ['path'],
    },
  },

  // ── Drift tools (v0.8.0) ─────────────────────────────────────────────────
  {
    name: 'drift_status',
    description:
      'Check what\'s drifting right now — the "Intent Datadog" for your product decisions.\n\nReturns a structured truth map showing which decisions/constraints/hypotheses are:\n🔴 drift (unaccounted divergence from intent)\n🟡 review (soft signal, awaiting human decision)\n⚪ held (acknowledged, time-boxed, not forgotten)\n🔵 aligned (reality matches intent)\n\nNodes are classified into 4 species:\n• hypothesis → Decision Cards (decision journal format)\n• constraint → Rules (pass/fail checklist)\n• commitment → Heartbeats (cadence monitoring)\n• source_of_truth → Reference (stable anchors)\n\nWHEN TO CALL:\n• At session start — "what needs my attention?"\n• Before making a decision — check for existing anchors on the topic\n• After completing work — verify drift state changed\n• When the user asks about product health / what\'s broken / what\'s stale',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Filter by domain (strategy, product, engineering, growth, etc.)' },
        decision_mode: { type: 'string', description: 'Filter by decision_mode (hypothesis, constraint, commitment, source_of_truth)' },
        verbose: { type: 'boolean', default: false, description: 'Return full aligned nodes and all candidates. Default is compact: attention items in full, aligned as id+statement per domain, candidates as counts.' },
        anchor_id: { type: 'number', description: 'Deep-dive into ONE decision instead of the map: its state, premises, drift edges, pending candidates. (Absorbs check_decision.)' },
      },
    },
  },
  {
    name: 'where_am_i',
    description:
      'Locate the current topic on the Current Truth Map and report "you are here" + blast radius — the per-turn re-anchor.\n\nReturns the matching Map node(s) + journey stage (discover → … → expand), the BLAST RADIUS (what becomes suspect if you change this — the must-stay-consistent-with / should-align-with / realizes dependents; e.g. editing the README implicates the LP), and the decision behind the node (linked anchor), if any.\n\nThree ways to call:\n• NO ARGS → auto-locates from the files you JUST edited this session (the zero-effort re-anchor — call it freely as you work).\n• query: "<topic>" → lexical locate by topic.\n• node_id: "<id>" → exact node.\n\nThis is how you avoid optimizing one node while silently breaking its neighbors (change the spec → npm/Docs/LP must move too). Matching is lexical (no embeddings).\n\nWHEN TO CALL:\n• Right after editing files — call with no args to see what you just touched + its blast radius.\n• When the topic shifts — re-anchor to the new node.\n• When the user asks "what does changing X affect?" / "where does this fit?"',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Topic to locate (e.g. "changing the telemetry contract"). Omit to auto-locate from your recent edits.' },
        node_id: { type: 'string', description: 'Exact Map node id, if known (e.g. "readme") — bypasses lexical match' },
        project: { type: 'string', description: 'Map project slug (defaults to the most recently imported Map)' },
        limit: { type: 'number', description: 'Max matches (default 3)' },
      },
    },
  },
  {
    name: 'check_decision',
    description:
      'Deep-dive into a specific decision/anchor — its state, premises, drift edges, and pending candidates.\n\nReturns the full context for one truth-map node: what was decided, why, what reality says, whether it\'s drifting, and what actions are pending.\n\nWHEN TO CALL:\n• When the user asks about a specific decision ("what happened with X?")\n• Before resolving a drift signal — understand the full picture first\n• When reviewing premises of a decision ("is this still true?")',
    inputSchema: {
      type: 'object',
      properties: {
        anchor_id: { type: 'number', description: 'The drift_anchor ID to inspect' },
      },
      required: ['anchor_id'],
    },
  },
  {
    name: 'declare_anchor',
    description:
      'Declare a new decision, constraint, or prohibition as a truth-map anchor.\n\nAnchors are NORMATIVE claims: "we decided X", "Y is forbidden", "Z must always hold."\nThe drift detector later checks these against committed reality.\n\ndeclare-don\'t-mine: anchors come ONLY from explicit human declaration, never from pattern extraction.\n\nWHEN TO CALL:\n• When the user makes a product decision ("let\'s go with approach A")\n• When a constraint is established ("never do X")\n• When a commitment is made ("we ship weekly")\n• When the user says "anchor this" / "record this decision"',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['prohibition', 'decision', 'constraint', 'proposal'], description: "Anchor type. 'proposal' = an option you presented that the user never addressed (an orphaned fork) — it lands as a review item and can be triaged later via recall({ dream: true }). (Absorbs flag_proposals.)" },
        decided: { type: 'string', description: "For kind 'proposal': what the user chose or engaged with instead." },
        siblings: { type: 'array', items: { type: 'string' }, description: "For kind 'proposal': the other options from the same set, for context." },
        session_context: { type: 'string', description: "For kind 'proposal': one line on the conversation it came from." },
        statement: { type: 'string', description: 'The normative claim (>= 8 chars)' },
        rationale: { type: 'string', description: 'Why this was decided' },
        affects: { type: 'array', items: { type: 'string' }, description: 'Path globs that scope this anchor' },
        detect_terms: { type: 'array', items: { type: 'string' }, description: 'Keywords for scoping' },
        violation_signal: { type: 'array', items: { type: 'string' }, description: 'Terms whose presence = violation (required for prohibition/decision)' },
        tier: { type: 'string', enum: ['human', 'explicit'], description: 'Declaration tier (default: human)' },
        // v9 ProjectCoreNode fields
        node_type: { type: 'string', description: 'Node type label' },
        domain: { type: 'string', description: 'Domain (strategy, product, engineering, etc.)' },
        decision_mode: { type: 'string', enum: ['hypothesis', 'constraint', 'commitment', 'source_of_truth'], description: 'Classification for 4-species display' },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Confidence level (0.0-1.0)' },
        lifecycle: { type: 'string', description: 'Lifecycle state (active, at_risk, retired)' },
        review_after: { type: 'string', description: 'ISO date for next review (e.g. "2026-07-04")' },
      },
      required: ['kind', 'statement'],
    },
  },
  {
    name: 'resolve_drift',
    description:
      'Record a resolution for a drifting anchor — the human feedback loop.\n\n6 actions:\n• fix — "we fixed the code/reality to match intent" → state becomes aligned\n• supersede — "intent evolved, this is the new direction" → state becomes aligned\n• acknowledge — "we know, parking it for now" → state becomes held (with optional review date)\n• dismiss — "false positive, not actually drifting" → edges dismissed AND the gate stops firing on it (hit_term: just that word; gate:false: close the edges but keep the gate watching)\n• harden — "re-injected but still violated, enforce it" → card_policy.gate_mode=hard (PreToolUse will BLOCK)\n• soften — "back off to a warning" → gate_mode=soft\n\nWHEN TO CALL:\n• After drift_status shows 🔴 drift or 🟡 review items\n• When the user says "that\'s fixed" / "ignore that" / "we changed direction"\n• When acknowledging a known gap with a review date',
    inputSchema: {
      type: 'object',
      properties: {
        anchor_id: { type: 'number', description: 'The drift_anchor ID to resolve' },
        action: { type: 'string', enum: ['fix', 'supersede', 'acknowledge', 'dismiss', 'harden', 'soften', 'surface'], description: "Resolution action. With candidate_id (an orphaned proposal): 'surface' keeps it visible for the human, 'dismiss' retires it." },
        candidate_id: { type: 'number', description: 'Resolve an orphaned proposal (from recall({ dream: true })) instead of an anchor: pass its candidate_id with action surface | dismiss and a rationale that references the North Star. (Absorbs resolve_proposal.)' },
        gate: { type: 'boolean', default: true, description: "For dismiss: false = these detections were false positives, close them, but KEEP the gate watching this anchor (its signals still fire). Use when the anchor's rule is right and only this evidence was wrong — e.g. a lexical hit in a file that is not what the rule is about. Default true also silences the gate (whole anchor, or just hit_term)." },
        rationale: { type: 'string', description: 'Why this resolution (recorded for audit trail)' },
        review_after: { type: 'string', description: 'For acknowledge: ISO date to re-check (e.g. "2026-07-04")' },
        superseded_by: { type: 'number', description: 'For supersede: the new anchor ID that replaces this one' },
        hit_term: { type: 'string', description: "For dismiss: silence only this match term (the word the gate quoted back at you). Omit to silence the whole anchor at the gate — prefer the term, so the anchor's real detections keep working." },
      },
      required: ['anchor_id', 'action'],
    },
  },
  {
    name: 'flag_proposals',
    description:
      'Record orphaned proposals — options you presented that the user never addressed.\n\n' +
      'Conversations are tree-shaped but experienced linearly. When you present 3 options and the user ' +
      'engages with only 1, the other 2 become "orphaned proposals" — unresolved decision branches that ' +
      'both you and the user lose track of.\n\n' +
      'WHEN TO CALL:\n' +
      '• When you notice the user engaged with only some of the options you presented\n' +
      '• When the conversation shifted topic and earlier proposals were never resolved\n' +
      '• At session end, review what you proposed vs what was addressed\n' +
      '• When the user says "what else did we discuss?" or "何か忘れてない？"\n\n' +
      'Each proposal becomes a review-state anchor on the dashboard — visible until the user decides.\n' +
      'This is declaration, not mining: YOU are the curator recognizing what went unaddressed.',
    inputSchema: {
      type: 'object',
      properties: {
        proposals: {
          type: 'array',
          description: 'Array of unresolved proposals (1-10 items)',
          items: {
            type: 'object',
            properties: {
              statement: { type: 'string', description: 'The proposal itself — what was suggested but not addressed (prefix with [未解決] for dashboard clarity)' },
              rationale: { type: 'string', description: 'Context: what discussion it came from, what the user chose instead, why this matters' },
              domain: { type: 'string', description: 'Topic domain (e.g. monetization, product, engineering, strategy, growth, roadmap)' },
              confidence: { type: 'number', minimum: 0, maximum: 1, description: 'How confident you are this is worth revisiting (0.3-0.7 typical)' },
              siblings: { type: 'array', items: { type: 'string' }, description: 'Other options from the same proposal set (for context)' },
              decided: { type: 'string', description: 'What the user chose or engaged with instead' },
            },
            required: ['statement', 'rationale', 'domain'],
          },
        },
        session_context: { type: 'string', description: 'Brief description of the conversation/session where these proposals arose' },
      },
      required: ['proposals'],
    },
  },
  // ── Dreaming Memory (v0.9.0) ──────────────────────────────
  {
    name: 'dream',
    description:
      'Dreaming Memory — consolidate orphaned proposals against the North Star.\n\n' +
      'Returns the project\'s North Star (direction/goals/ICP/phase) alongside unresolved proposals ' +
      'that agents flagged during conversations. YOUR job as the evaluating agent is to decide:\n\n' +
      '• surface — genuinely important unresolved fork point given the current direction\n' +
      '• dismiss — outdated, already implicitly resolved, or irrelevant to current goals\n\n' +
      'Think like a General Doctor doing triage: the North Star is the patient\'s chart, ' +
      'each proposal is a symptom. Not every symptom needs treatment.\n\n' +
      'WHEN TO CALL:\n' +
      '• At session start to triage accumulated proposals\n' +
      '• When the user asks "何か見落としてない？" or "what should we revisit?"\n' +
      '• Periodically to prevent proposal backlog from growing stale\n\n' +
      'After evaluation, call resolve_proposal for each candidate with your verdict.\n\n' +
      'ALSO RETURNS: `distill_queue` — auto-captured memories whose content is still a RAW user utterance. ' +
      'Rewrite each via remember({ memory_id, merge: true, content }) per the guide in the response (one-line what, true why, ' +
      '"distilled": true). Drain up to 8 per call — the SessionStart digest reminds you while the queue is non-empty. ' +
      'And `friction` — anchors re-surfaced at the gate yet still contradicted (resolve_drift action:"harden" to enforce).',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Filter proposals by domain (e.g. strategy, product, engineering)' },
      },
    },
  },
  {
    name: 'resolve_proposal',
    description:
      'Record your evaluation verdict for an orphaned proposal after dreaming.\n\n' +
      'Call this after `dream` for each candidate you evaluated against the North Star.\n' +
      '• surface — Keep visible on dashboard for human decision\n' +
      '• dismiss — Remove from dashboard (outdated/irrelevant/implicitly resolved)\n\n' +
      'Always reference the North Star criteria in your rationale.',
    inputSchema: {
      type: 'object',
      properties: {
        candidate_id: { type: 'number', description: 'The candidate ID from dream results' },
        verdict: { type: 'string', enum: ['surface', 'dismiss'], description: 'Your evaluation verdict' },
        rationale: { type: 'string', description: 'Why — must reference North Star criteria' },
      },
      required: ['candidate_id', 'verdict', 'rationale'],
    },
  },
  // ── Share a fix (opt-in, link only) ──────────────────────
  {
    name: 'share_draft',
    description:
      'Make a LINK to a reviewed draft of a field note for other agents (KanseiLINK note page). ' +
      'ONLY when the user says they want to share — never call it on your own.\n\n' +
      'Use after a SaaS / MCP / API connection got stuck and was fixed (or was not). You write the fields; ' +
      'this tool only checks them and builds the URL. Linksee sends nothing: the user opens the link, ' +
      'reviews the filled form, and only their click on that page sends it.\n\n' +
      'No values, only kinds: write "401 invalid_token", not the token. A field that looks like a key, ' +
      'token, JWT, e-mail, tenant URL (acme.slack.com), IP, local path (C:\, /Users/, /home/) or a long ' +
      'hex/base64 run stops the build and returns which field. The whole URL must fit in 2,000 characters ' +
      '(a Japanese character takes 9) — if not, it asks you to shorten; it does not cut.\n\n' +
      'Returns { url, notice } — show the user both. Linksee records only that a draft was made (no field text).',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'KanseiLINK service_id, lowercase (e.g. freee, slack, google-drive). ^[a-z0-9_.-]{1,160}$' },
        task: { type: 'string', maxLength: 300, description: 'What you were trying to do (≤300 chars)' },
        symptom: { type: 'string', maxLength: 600, description: 'The KIND of error that came back — no values (≤600 chars)' },
        tried: { type: 'string', maxLength: 2000, description: 'The steps you tried (≤2,000 chars)' },
        result: { type: 'string', maxLength: 1000, description: 'How it was solved, or that it was not (≤1,000 chars)' },
        conditions: { type: 'string', maxLength: 600, description: 'Optional. Tool + version, kind of environment (≤600 chars)' },
        kind: { type: 'string', enum: [...KINDS], description: 'execution = you ran it · documentation = you read it · hypothesis = untested guess' },
        runtime: { type: 'string', enum: [...RUNTIMES], description: 'Optional. Which AI wrote this' },
      },
      required: ['service', 'task', 'symptom', 'tried', 'result', 'kind'],
      additionalProperties: false,
    },
  },
];

// ============================================================
// Handlers
// ============================================================

function upsertEntity(args: { name: string; kind: string; key?: string }): number {
  // 1. Fastest path: canonical_key exact match (e.g. project path)
  if (args.key) {
    const byKey = db.prepare('SELECT id FROM entities WHERE canonical_key = ?').get(args.key) as { id: number } | undefined;
    if (byKey) return byKey.id;
  }

  // 2. Normalized name match (prevents "CockpitMCP" / "Cockpit MCP" / "cockpit-mcp" dups)
  const normalized = normalizeEntityName(args.name);
  const byNorm = db
    .prepare('SELECT id FROM entities WHERE kind = ? AND normalized_name = ?')
    .get(args.kind, normalized) as { id: number } | undefined;
  if (byNorm) {
    if (args.key) {
      db.prepare('UPDATE entities SET canonical_key = ?, updated_at = unixepoch() WHERE id = ? AND canonical_key IS NULL').run(args.key, byNorm.id);
    }
    return byNorm.id;
  }

  // 3. Fallback: exact case-insensitive match (covers names that normalize differently
  //    but the user typed the exact same string — shouldn't happen after v5 migration
  //    but keeps backward compat if normalized_name is NULL for some row)
  const byName = db
    .prepare('SELECT id FROM entities WHERE kind = ? AND LOWER(name) = LOWER(?)')
    .get(args.kind, args.name) as { id: number } | undefined;
  if (byName) {
    // Backfill normalized_name while we're here
    db.prepare('UPDATE entities SET normalized_name = ?, updated_at = unixepoch() WHERE id = ? AND normalized_name IS NULL').run(normalized, byName.id);
    if (args.key) {
      db.prepare('UPDATE entities SET canonical_key = ?, updated_at = unixepoch() WHERE id = ? AND canonical_key IS NULL').run(args.key, byName.id);
    }
    return byName.id;
  }

  // 4. Insert new entity with normalized_name
  const result = db
    .prepare('INSERT INTO entities (kind, name, normalized_name, canonical_key) VALUES (?, ?, ?, ?)')
    .run(args.kind, args.name, normalized, args.key ?? null);
  return Number(result.lastInsertRowid);
}

function handleRemember(args: any): string {
  // Layer alias → canonical
  const layer = resolveLayer(args.layer);
  if (!layer || !(LAYER_ENUM as readonly string[]).includes(layer)) {
    return JSON.stringify({
      ok: false,
      error: `unknown layer "${args.layer}". Known: ${LAYER_ENUM.join(', ')} (aliases: decisions, warnings, how, why, ...)`,
    });
  }

  // Quality check — reject pasted external content unless force=true
  let rawContent = String(args.content ?? '');
  if (!args.force && isPastedExternalContent(rawContent)) {
    return JSON.stringify({
      ok: false,
      rejected: 'quality_check',
      reason: 'Content looks like pasted assistant output, CI log, or external paste. Pass force:true if this really is original thought worth keeping.',
      hint: 'If you meant to save an extracted insight from that paste, summarize it in your own words first.',
    });
  }

  // supersedes: parse before anything is written; a malformed value refuses the whole call.
  let supersedeIds: number[];
  try { supersedeIds = parseSupersedesArg(args.supersedes); } catch (e) {
    if (e instanceof SupersedeRefused) return JSON.stringify({ ok: false, rejected: 'supersedes', reason: e.message, saved: false });
    throw e;
  }

  const importance = Math.min(1, Math.max(0, Number(args.importance ?? 0.5)));

  // Auto-classify: if content is plain text (not JSON with 3-axis fields),
  // wrap it in structured JSON so VIRTUAL generated columns can extract axes.
  let isAlreadyStructured = false;
  try {
    const parsed = JSON.parse(rawContent);
    if (parsed && typeof parsed === 'object' && parsed.altitude && parsed.type && parsed.state) {
      isAlreadyStructured = true;
    }
  } catch { /* not JSON = needs wrapping */ }

  // With supersedes, a JSON object that lacks any of altitude/type/state is refused before
  // anything is written: it would be re-wrapped as {what: "<the JSON>"} and its state re-guessed,
  // so an explicit state in it could not be honoured or even confirmed. No clever rescue —
  // plain text, or JSON with all three, only.
  if (supersedeIds.length > 0 && !isAlreadyStructured) {
    let parsedObj = false;
    try { const p = JSON.parse(rawContent); parsedObj = p !== null && typeof p === 'object'; } catch { /* plain text */ }
    if (parsedObj) {
      return JSON.stringify({
        ok: false, rejected: 'supersedes', saved: false,
        reason: 'with supersedes, content must be plain text or JSON with all of altitude, type and state. This JSON lacks at least one, so its state cannot be confirmed. Send the content as plain text, or add altitude/type/state, and save again.',
      });
    }
  }

  if (!isAlreadyStructured) {
    const structured = {
      altitude: inferAltitude(rawContent),
      type: inferType(rawContent, layer),
      state: inferState(rawContent, layer),
      what: rawContent,
    };
    rawContent = JSON.stringify(structured);
  }

  // A memory that names what it supersedes IS the current decision.
  //  • State GUESSED from the text (inferState reads 「代わりに」 / "replaced" — words about the
  //    OLD decision — as this row being superseded): corrected to 'decided', and the reply says so.
  //  • State given EXPLICITLY as 'superseded' together with supersedes: the two contradict each
  //    other and we cannot tell which one the caller meant, so nothing is written.
  let stateNote: string | undefined;
  if (supersedeIds.length > 0) {
    let c: any;
    try { c = JSON.parse(rawContent); } catch { c = null; /* structured above, always JSON */ }
    if (c && typeof c === 'object' && c.state === 'superseded') {
      if (isAlreadyStructured) {
        return JSON.stringify({
          ok: false, rejected: 'supersedes', saved: false,
          reason: 'content says state "superseded" but the memory also supersedes another one — a memory that replaces an older one is the current one. Remove state "superseded" (or set the state you mean) and save again.',
        });
      }
      c.state = 'decided';
      rawContent = JSON.stringify(c);
      stateNote = 'the state guessed from the text was "superseded"; stored as "decided" because this memory supersedes another one';
    }
  }

  // Who wrote it: the client name/version the MCP host sent in initialize (self-reported).
  const source = mcpSource(server.getClientVersion());

  // Entity, row, event, supersedes edges and the old rows' state change commit together or not
  // at all: if any supersedes id cannot be confirmed, nothing — not even a new entity — is left.
  let entityId: number, memoryId: number, supersededAnchors: number[] = [];
  try {
    ({ entityId, memoryId, supersededAnchors } = db.transaction(() => {
      const eid = upsertEntity({ name: args.entity_name, kind: args.entity_kind, key: args.entity_key });
      const result = db
        .prepare('INSERT INTO memories (entity_id, layer, content, importance, protected, source, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(eid, layer, rawContent, importance, importance >= 0.9 ? 1 : 0, source, args.thread_id ?? null);
      const mid = Number(result.lastInsertRowid);
      // Checked after the INSERT so a self-reference is seen as one (the id exists only now);
      // a refusal throws and the transaction rolls the INSERT back.
      const oldRows = supersedeIds.length > 0 ? checkSupersedes(db, supersedeIds, eid, mid) : [];
      if (oldRows.length > 0) applySupersedes(db, mid, oldRows);
      db.prepare('INSERT INTO events (entity_id, kind, payload) VALUES (?, ?, ?)').run(
        eid,
        'memory_stored',
        JSON.stringify(supersedeIds.length > 0 ? { layer, memory_id: mid, supersedes: supersedeIds } : { layer, memory_id: mid })
      );
      const anchors: number[] = [];
      for (const r of oldRows) {
        try { const c = JSON.parse(r.content); if (c && Number.isInteger(c.anchor_id)) anchors.push(c.anchor_id); } catch { /* plain text */ }
      }
      return { entityId: eid, memoryId: mid, supersededAnchors: anchors };
    })());
  } catch (e) {
    if (e instanceof SupersedeRefused) {
      return JSON.stringify({ ok: false, rejected: 'supersedes', memory_id: e.memoryId, reason: e.message, saved: false });
    }
    throw e;
  }

  // The memory is committed from here on. Helpers that fail after this point must not turn a
  // saved memory into ok:false — the caller would retry and save it twice.
  const warnings: string[] = [];
  let mom: { score: number; band: string } | null = null;
  try { mom = refreshMomentumForEntity(db, entityId); } catch (e: any) {
    warnings.push(`saved, but the momentum refresh failed: ${String(e?.message ?? e).slice(0, 200)}`);
  }

  const out: Record<string, unknown> = {
    ok: true,
    memory_id: memoryId,
    entity_id: entityId,
    layer,
    pinned: importance >= 0.9,
    ...(mom ? { momentum: { score: mom.score, band: mom.band } } : {}),
  };
  if (warnings.length > 0) out.warnings = warnings;
  if (supersedeIds.length > 0) out.supersedes = supersedeIds;
  if (stateNote) out.state_note = stateNote;
  if (supersededAnchors.length > 0) {
    // The memory link does not touch the gate. Say so instead of retiring an anchor on our own.
    out.anchors_still_enforced = supersededAnchors;
    out.anchor_hint = `The superseded memory is enforced as anchor ${supersededAnchors.map((a) => '#' + a).join(', ')}; the gate still applies it. To retire it: resolve_drift({ anchor_id, action: 'supersede', superseded_by: <new anchor id> }).`;
  }

  // "Remember" and "enforce" used to be two tools with two schemas, and an agent had to pick.
  // Picking remember meant the decision was stored but never re-injected — the exact failure
  // the product exists to prevent. One call now does both when the caller asks for it.
  if (args.anchor) {
    const spec = typeof args.anchor === 'object' && args.anchor !== null ? args.anchor : {};
    let what = rawContent, why: string | undefined = spec.rationale;
    try {
      const c = JSON.parse(rawContent);
      if (c && typeof c === 'object') {
        what = String(c.what ?? c.title ?? rawContent);
        why = why ?? (c.why ? String(c.why) : undefined);
      }
    } catch { /* plain text */ }
    const signals: string[] = Array.isArray(spec.violation_signal) ? spec.violation_signal : [];
    // A decision/prohibition needs forbidden strings for a contradiction to be detectable; without
    // them the honest shape is a constraint (still re-injected on boot and when its scope is touched).
    const kind = spec.kind ?? (signals.length > 0 ? 'decision' : 'constraint');
    try {
      const anchor = declareAnchor(db, {
        kind,
        statement: what.length >= 8 ? what : `${what} (decision)`,
        rationale: why,
        affects: Array.isArray(spec.affects) ? spec.affects : undefined,
        detect_terms: Array.isArray(spec.detect_terms) ? spec.detect_terms : undefined,
        violation_signal: signals.length > 0 ? signals : undefined,
        tier: 'human',
        source_memory_id: memoryId,
      });
      const nodeFields: Record<string, unknown> = {};
      if (spec.domain) nodeFields.domain = spec.domain;
      if (spec.confidence !== undefined) nodeFields.confidence = spec.confidence;
      if (Object.keys(nodeFields).length > 0) setNodeFields(db, anchor.id, nodeFields);
      // Link both ways so recall can show "this memory is enforced as #N" and the anchor can
      // point back at the moment it was decided.
      try {
        const c = JSON.parse(rawContent);
        if (c && typeof c === 'object') {
          c.anchor_id = anchor.id;
          db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(JSON.stringify(c), memoryId);
        }
      } catch { /* leave content as-is */ }
      logAnchorTouch(db, { anchorId: anchor.id, tool: 'remember', interaction: 'create' });
      out.anchor_id = anchor.id;
      out.anchor_kind = kind;
      out.enforced = signals.length > 0
        ? 'contradictions are detected at the gate; re-injected on boot and in scope'
        : 'no violation_signal given — re-injected on boot and when its scope is touched, but contradictions cannot be detected';
    } catch (e: any) {
      out.anchor_error = String(e?.message ?? e);
      out.hint = 'The memory was saved. Fix the anchor spec and call declare_anchor, or remember again with a corrected anchor.';
    }
  }

  return JSON.stringify(out);
}

// Query words for FTS5 MATCH. Strips chars that break the FTS5 grammar, then trims sentence
// punctuation from both ends of each word: "editor?" must search for "editor" — with the "?"
// kept, the trigram "or?" is required and the key word of the question can never match
// (0.19.1; before that only the name in a question matched, see PR #29's bench).
// Inner punctuation is kept (server.ts, eu-north, Varga's). A leading "." is kept (.env).
// Note: with trigram tokenizer, words shorter than 3 chars cannot match anything.
// Such words are dropped here and the caller falls back to LIKE if FTS yields no hits.
const EDGE_PUNCT_RE = /^[\s"'`([{<「『（【〈《]+|[\s"'`)\]}>」』）】〉》?!.,;:、。？！，；：…]+$/gu;

// Japanese / CJK queries (0.19.2). A Japanese sentence has no spaces, so the space split above
// made "山田のエディタは何？" ONE word that matched only rows containing that whole string. No
// dictionary (no new dependency): a space-word that contains Han / Hiragana / Katakana is cut
// into pieces at punctuation and at script boundaries (Han | Hiragana | Katakana | letters+digits).
// Only FUNCTION words are dropped: the one list below (particles, auxiliaries, question endings
// and question words). Every other Hiragana run of 2+ chars is kept as a piece (みずほの口座 →
// みずほ + 口座; ひとり旅 → ひとり + 旅): dropping all Hiragana lost the word that told two
// rows apart (Codex review 1 of #32). Kanji + okurigana gives both the kanji piece and the
// kanji + okurigana piece (決める → 決 + 決める; 使う → 使 + 使う).
// Pieces of 3+ chars go to the trigram index; 1–2 char pieces (山田, 東京) cannot, and are
// matched with LIKE. A space-word with no CJK char is handled exactly as before, so English
// and other space-separated queries get the same words, FTS query and ranking.
// Known limits: a long Han-only run (a Chinese sentence) stays one piece; "公開日" does not
// match "公開した日"; a content word made only of function-word characters inside a longer
// Hiragana run can be split (はなし → は + なし) — the whole-query floor in handleRecall keeps
// what the whole question matched before.
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN_RE = /[\p{Script=Han}々〆ヶ]/u;
const HIRA_RE = /\p{Script=Hiragana}/u;
const KATA_RE = /[\p{Script=Katakana}ーｰ]/u;
// Letters / digits of any other script, plus the inner symbols of names like v0.19.1, eu-north,
// .env, #21, C++, a/b. Everything else (、。？！「」・ spaces …) separates pieces.
const WORDISH_RE = /[\p{L}\p{N}.\-_#+/@&']/u;
// THE list of function words (the only place): dropped as separators, never searched.
const CJK_FUNCTION_WORDS = new Set([
  // particles
  'の', 'は', 'が', 'を', 'に', 'で', 'と', 'も', 'へ', 'や', 'か', 'ね', 'よ',
  'から', 'まで', 'より', 'など', 'って', 'とは', 'には', 'では', 'でも', 'とも', 'のは', 'のが', 'のを', 'だけ',
  // auxiliaries / endings
  'て', 'た', 'だ', 'です', 'ます', 'ですか', 'ますか', 'でしょうか', 'でしょう', 'でした', 'ました', 'だっけ',
  'いる', 'ている', 'ある', 'する', 'した', 'して', 'ない', 'たい', 'れる', 'られる',
  // honorific suffixes
  'さん', 'くん', 'ちゃん',
  // question words
  'なに', 'なん', 'だれ', 'どこ', 'いつ', 'どう', 'どれ', 'どの', '何', '誰', '何処', '何時', '何故',
]);
const HIRA_FUNCTION_WORDS = [...CJK_FUNCTION_WORDS].filter((w) => /^\p{Script=Hiragana}+$/u.test(w));
// Upper bound on pieces per query (after de-duplication). Each piece is one FTS lookup or one
// LIKE scan (coverage) plus two LIKE terms in the candidate SQL, and SQLite refuses an
// expression deeper than 1000 ("Expression tree is too large": 499 pieces from a 500-kanji
// question did, Codex review 1 of #32). Natural questions have well under 10 pieces; 16 leaves
// room and keeps the cost bounded (measured on a 3,000-row store: ~45 ms at 10 pieces, ~65 ms at
// 16). Over the cap, kanji pieces and whole-Hiragana-run pieces are dropped LAST; within each of
// the two groups the LONGEST pieces are kept (longer = rarer), ties in question order; the kept
// pieces go back in question order. Known limit: a short important piece (a name, 税) can still
// fall off a very long question.
const MAX_QUERY_PIECES = 16;

// One Hiragana run → content fragments, function words dropped. Picks the split covering the most
// characters with function words, every content fragment 2+ chars long — except a 1-char fragment
// at the very start right after kanji (okurigana: 使う) or a run that is 1 char in total. Ties go
// to fewer segments, so a word is not cut without a function word. starts: begins the run.
function splitHiragana(run: string, afterHan: boolean): Array<{ text: string; starts: boolean }> {
  const c = Array.from(run);
  const n = c.length;
  const best: Array<{ score: number; prev: number; content: boolean } | null> = new Array(n + 1).fill(null);
  best[0] = { score: 0, prev: -1, content: false };
  for (let i = 0; i < n; i++) {
    const at = best[i];
    if (!at) continue;
    const offer = (j: number, score: number, content: boolean) => {
      const cur = best[j];
      if (!cur || score > cur.score) best[j] = { score, prev: i, content };
    };
    for (const f of HIRA_FUNCTION_WORDS) {
      const len = Array.from(f).length;
      if (i + len <= n && c.slice(i, i + len).join('') === f) offer(i + len, at.score + len * 1000 - 1, false);
    }
    const minLen = (i === 0 && afterHan) || n === 1 ? 1 : 2;
    for (let j = i + minLen; j <= n; j++) offer(j, at.score - 1, true);
  }
  const segs: Array<{ text: string; starts: boolean }> = [];
  for (let j = n; j > 0;) {
    const b = best[j]!;
    if (b.content) segs.unshift({ text: c.slice(b.prev, j).join(''), starts: b.prev === 0 });
    j = b.prev;
  }
  return segs;
}

// Pieces of one CJK space-word. keep: a kanji piece or a whole Hiragana run, dropped last at the cap.
// Every Hiragana run of 2+ chars is also a piece AS IS, besides its split: the function-word split
// can cut a content word made of particle characters (とまと → まと, かもめ → もめ, はなし → なし;
// Codex review 2 of #32), the run itself cannot be wrong — same idea as 決 + 決める.
function cjkPieces(word: string): Array<{ t: string; keep: boolean }> {
  const runs: Array<{ cls: string; text: string; joined: boolean }> = []; // joined: no separator before it
  let cur: { cls: string; text: string; joined: boolean } | null = null;
  let gap = true;
  for (const ch of word) {
    const cls = HAN_RE.test(ch) ? 'han' : HIRA_RE.test(ch) ? 'hira' : KATA_RE.test(ch) ? 'kata' : WORDISH_RE.test(ch) ? 'word' : 'sep';
    if (cls === 'sep') { cur = null; gap = true; continue; }
    if (cur && cur.cls === cls) cur.text += ch;
    else { cur = { cls, text: ch, joined: !gap }; runs.push(cur); }
    gap = false;
  }
  const out: Array<{ t: string; keep: boolean }> = [];
  const push = (t: string, keep = false) => {
    const s = t.replace(EDGE_PUNCT_RE, '');
    if (s && !CJK_FUNCTION_WORDS.has(s)) out.push({ t: s, keep });
  };
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k];
    if (r.cls !== 'hira') { push(r.text, r.cls === 'han'); continue; }
    const prev = runs[k - 1];
    const afterHan = !!prev && prev.cls === 'han' && r.joined;
    if (Array.from(r.text).length >= 2) push(r.text, true); // the run itself (unless a function word)
    const segs = splitHiragana(r.text, afterHan);
    for (const s of segs) {
      if (afterHan && s.starts) {
        if (!CJK_FUNCTION_WORDS.has(prev.text)) push(prev.text + s.text); // 決 + める → 決める
        continue;
      }
      if (Array.from(s.text).length >= 2 || runs.length === 1) push(s.text);
    }
  }
  return out;
}

// fts: words / pieces for the trigram index (3+ chars). like: 1–2 char pieces, only for a query
// that contains CJK (an English query's short words stay out, as before). cjk: the query had CJK.
interface QueryPlan { fts: string[]; like: string[]; cjk: boolean }
function queryPlan(raw: string): QueryPlan {
  const cleaned = String(raw ?? '')
    .replace(/["*:()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const plan: QueryPlan = { fts: [], like: [], cjk: false };
  if (!cleaned) return plan;
  const seen = new Set<string>();
  const shortWords: string[] = [];
  const all: Array<{ t: string; short: boolean; keep: boolean }> = [];
  const add = (t: string, short: boolean, keep = false) => {
    const key = t.toLowerCase();
    if (seen.has(key)) { if (keep) for (const p of all) if (p.t.toLowerCase() === key) p.keep = true; return; }
    seen.add(key);
    all.push({ t, short, keep });
  };
  for (const word of cleaned.split(' ')) {
    if (CJK_RE.test(word)) {
      plan.cjk = true;
      for (const p of cjkPieces(word)) add(p.t, Array.from(p.t).length < 3, p.keep);
      continue;
    }
    const t = word.replace(EDGE_PUNCT_RE, '');
    if (t.length < 3) { if (t) shortWords.push(t); continue; }
    add(t, false);
  }
  if (plan.cjk) {
    for (const t of shortWords) add(t, true); // "CI の設定は？": CI by LIKE
    if (all.length > MAX_QUERY_PIECES) {
      const keep = new Set(all.map((p, i) => ({ i, k: p.keep ? 1 : 0, len: Array.from(p.t).length }))
        .sort((a, b) => b.k - a.k || b.len - a.len || a.i - b.i).slice(0, MAX_QUERY_PIECES).map((x) => x.i));
      const kept = all.filter((_, i) => keep.has(i));
      all.length = 0;
      all.push(...kept);
    }
  }
  for (const p of all) (p.short ? plan.like : plan.fts).push(p.t);
  return plan;
}
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => '\\' + c);
// The whole question without its edge punctuation: a memory containing it is never ranked below
// what the pieces give it (whole-query floor, CJK only; Codex review 1 of #32).
const wholeQuery = (q: string): string => String(q ?? '').trim().replace(EDGE_PUNCT_RE, '');

// Which query words each memory contains, weighted by how rare the word is in the store
// (0.19.1). One FTS5 lookup per word gives both its document frequency and the rows that have
// it — the same trigram semantics as the search itself. Weight = the bm25 IDF,
// ln(1 + (N - df + 0.5) / (df + 0.5)): a word in every row (a person's name on all of their
// memories, the "what" key of every JSON memory) weighs almost nothing; a word in few rows
// weighs a lot. Words found in no row are left out (they cannot tell rows apart).
// coverage(row) = sum of weights of the words the row has / sum of weights of all words.
// For a CJK query (0.19.2) the words are the pieces: 3+ char pieces through FTS as above, 1–2
// char pieces through LIKE on the content or the entity name (the same rows the LIKE search finds).
function termCoverage(plan: QueryPlan): (id: number) => number {
  const terms: Array<{ t: string; like: boolean }> = [
    ...plan.fts.map((t) => ({ t, like: false })),
    ...plan.like.map((t) => ({ t, like: true })),
  ];
  if (terms.length === 0) return () => 0;
  const n = (db.prepare('SELECT COUNT(*) AS c FROM memories').get() as any).c as number;
  const stmt = db.prepare('SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ?');
  const likeStmt = plan.like.length
    ? db.prepare("SELECT m.id AS id FROM memories m JOIN entities e ON e.id = m.entity_id WHERE m.content LIKE ? ESCAPE '\\' OR e.name LIKE ? ESCAPE '\\'")
    : null;
  const sets: Array<{ ids: Set<number>; w: number }> = [];
  let total = 0;
  for (const { t, like } of terms) {
    const pat = `%${likeEscape(t)}%`;
    const found = like ? (likeStmt!.all(pat, pat) as any[]) : (stmt.all(`"${t}"`) as any[]);
    const ids = new Set<number>(found.map((r) => Number(r.id)));
    if (ids.size === 0) continue;
    const w = Math.log(1 + (n - ids.size + 0.5) / (ids.size + 0.5));
    sets.push({ ids, w });
    total += w;
  }
  if (total <= 0) return () => 0;
  return (id: number) => {
    let got = 0;
    for (const s of sets) if (s.ids.has(id)) got += s.w;
    return got / total;
  };
}

interface AxisFilters {
  altitude?: string;
  mem_type?: string;
  mem_state?: string;
  thread_id?: string;
}

function appendAxisFilters(sql: string, params: any[], filters: AxisFilters): string {
  if (filters.altitude) { sql += ' AND m.altitude = ?'; params.push(filters.altitude); }
  if (filters.mem_type) { sql += ' AND m.mem_type = ?'; params.push(filters.mem_type); }
  if (filters.mem_state) { sql += ' AND m.mem_state = ?'; params.push(filters.mem_state); }
  if (filters.thread_id) { sql += ' AND m.thread_id = ?'; params.push(filters.thread_id); }
  return sql;
}

// Superseded rows: a row whose state is 'superseded', or the target of a supersedes edge.
// Applied in SQL, BEFORE the LIMIT — filtering after it let a pile of superseded rows fill the
// candidate pool and return nothing while a current memory existed (Codex review 1 of #21).
type SupersededMode = 'exclude' | 'include' | 'only';
// NULL-safe: plain-text rows and JSON without a state have mem_state NULL, and
// `NOT (NULL = 'superseded' OR …)` is NULL — which would drop them (Codex review 2 of #21).
const SUPERSEDED_SQL = `(COALESCE(m.mem_state, '') = 'superseded' OR EXISTS (SELECT 1 FROM memory_edges me WHERE me.to_memory_id = m.id AND me.relation = 'supersedes'))`;
// Consolidated rows (0.18.1): content JSON carries `consolidated_into: <summary id>`. Hidden by
// default, same as superseded; shown with include_consolidated. `CONSOLIDATED_SQL` is
// `json_valid(...) AND …`, so a plain-text row evaluates to 0, not NULL, and is kept.
type HiddenModes = { sup: SupersededMode; con: SupersededMode };
const SHOW_ALL: HiddenModes = { sup: 'include', con: 'include' };
function appendSupersededFilter(sql: string, mode: SupersededMode): string {
  if (mode === 'exclude') return sql + ` AND NOT ${SUPERSEDED_SQL}`;
  if (mode === 'only') return sql + ` AND ${SUPERSEDED_SQL}`;
  return sql;
}
function appendConsolidatedFilter(sql: string, mode: SupersededMode): string {
  if (mode === 'exclude') return sql + ` AND NOT ${CONSOLIDATED_SQL}`;
  if (mode === 'only') return sql + ` AND ${CONSOLIDATED_SQL}`;
  return sql;
}
function appendHiddenFilters(sql: string, h: HiddenModes): string {
  return appendConsolidatedFilter(appendSupersededFilter(sql, h.sup), h.con);
}

function runFtsQuery(query: string, layer: string | undefined, limit: number, axis?: AxisFilters, hidden: HiddenModes = SHOW_ALL): any[] {
  let sql = `
    SELECT m.id, m.entity_id, e.name as entity_name, e.kind as entity_kind, e.momentum_score,
           m.layer, m.content, m.importance, m.created_at, m.last_accessed_at, m.access_count,
           m.altitude as _altitude, m.mem_type as _mem_type, m.mem_state as _mem_state, m.thread_id as _thread_id,
           m.source as _source, bm25(memories_fts) as bm25_score
    FROM memories_fts
    JOIN memories m ON m.id = memories_fts.rowid
    JOIN entities e ON e.id = m.entity_id
    WHERE memories_fts MATCH ?
  `;
  const params: any[] = [query];
  if (layer) { sql += ' AND m.layer = ?'; params.push(layer); }
  if (axis) sql = appendAxisFilters(sql, params, axis);
  sql = appendHiddenFilters(sql, hidden);
  sql += ' ORDER BY bm25_score ASC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params) as any[];
}

// pieces (0.19.2): the 1–2 char pieces of a CJK query. A row matching any of them is a candidate
// too, and candidates are ordered by how many of (whole query, each piece) they match before
// importance, so a 1-char piece cannot fill the pool with rows that have nothing else asked; the
// whole query is then taken without its edge punctuation (wholeQuery). Without pieces the SQL is
// as before, except that % _ \ in the query / entity name are now literal (ESCAPE; before 0.19.2
// "50%" also matched "500", "snake_case" also matched "snake-case" — Codex review 1 of #32).
function runLikeQuery(query: string | undefined, entityName: string | undefined, layer: string | undefined, limit: number, axis?: AxisFilters, hidden: HiddenModes = SHOW_ALL, pieces: string[] = []): any[] {
  let sql = `
    SELECT m.id, m.entity_id, e.name as entity_name, e.kind as entity_kind, e.momentum_score,
           m.layer, m.content, m.importance, m.created_at, m.last_accessed_at, m.access_count,
           m.altitude as _altitude, m.mem_type as _mem_type, m.mem_state as _mem_state, m.thread_id as _thread_id,
           m.source as _source, 0 as bm25_score
    FROM memories m
    JOIN entities e ON e.id = m.entity_id
    WHERE 1=1
  `;
  const params: any[] = [];
  if (entityName) { sql += " AND e.name LIKE ? ESCAPE '\\'"; params.push(`%${likeEscape(entityName)}%`); }
  if (layer) { sql += ' AND m.layer = ?'; params.push(layer); }
  if (axis) sql = appendAxisFilters(sql, params, axis);
  sql = appendHiddenFilters(sql, hidden);
  const usePieces = !!query && !entityName && pieces.length > 0;
  const one = "(e.name LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\')";
  const pats = query ? [usePieces ? wholeQuery(query) : query, ...(usePieces ? pieces : [])].map((t) => `%${likeEscape(t)}%`) : [];
  if (query && !entityName) {
    sql += ` AND (${pats.map(() => one).join(' OR ')})`;
    for (const pat of pats) params.push(pat, pat);
  }
  if (usePieces) {
    sql += ` ORDER BY (${pats.map(() => one).join(' + ')}) DESC, m.importance DESC, m.last_accessed_at DESC LIMIT ?`;
    for (const pat of pats) params.push(pat, pat);
  } else sql += ' ORDER BY m.importance DESC, m.last_accessed_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params) as any[];
}

// Opportunistically refresh momentum_score cache for entities in a result set.
// Momentum is computed from events but stored in the entities row; without this,
// a row can become stale (e.g. no new remember() for weeks while events decay).
// Only refreshes entries older than MOMENTUM_STALE_SECS to avoid per-call cost.
const MOMENTUM_STALE_SECS = 3600; // 1 hour
function refreshStaleMomentum(entityIds: number[]): void {
  if (entityIds.length === 0) return;
  const unique = Array.from(new Set(entityIds));
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - MOMENTUM_STALE_SECS;
  const placeholders = unique.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id FROM entities WHERE id IN (${placeholders}) AND (momentum_at IS NULL OR momentum_at < ?)`)
    .all(...unique, cutoff) as Array<{ id: number }>;
  for (const r of rows) {
    try { refreshMomentumForEntity(db, r.id); } catch { /* non-fatal */ }
  }
}

// --- recall helpers ---------------------------------------------------------

// Rough token estimate for budgeting. ~3 chars/token is deliberately conservative
// for mixed JP/EN (Japanese is token-dense), so we under-fill rather than blow
// the caller's max_tokens budget.
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 3);
}

// Signature for near-duplicate collapsing in recall results. Extracts the
// meaningful core text (what/title/decision/intent/learned) from the memory's
// content (JSON or plain), normalizes whitespace/case, and keys it by entity so
// the same message stored under two layers collapses to a single result.
function contentSignature(raw: string, entityId: number): string {
  let text: unknown = raw;
  try {
    const o: any = JSON.parse(raw);
    text = o?.what ?? o?.title ?? o?.decision ?? o?.intent ?? o?.learned ?? (typeof o === 'string' ? o : raw);
  } catch { /* plain-text content */ }
  const norm = String(text).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
  if (norm.length < 16) return ''; // too short to dedup safely
  return `${entityId}::${norm}`;
}

// The summary id a folded row points at (0.18.1), or undefined for an unfolded / plain-text row.
function consolidatedIntoOf(parsedContent: unknown): number | undefined {
  if (!parsedContent || typeof parsedContent !== 'object' || Array.isArray(parsedContent)) return undefined;
  const v = (parsedContent as any).consolidated_into;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function handleRecall(args: any): string {
  // max_tokens is enforced for real at assembly time (greedy fill by measured
  // serialized size), not via a crude fixed per-memory estimate. hardLimit caps COUNT.
  const maxTokens = Math.max(100, Number(args.max_tokens ?? 2000));
  const DEFAULT_COUNT_CAP = 50;
  const hardLimit = Number.isFinite(args.limit) ? Math.max(1, Math.min(200, args.limit)) : DEFAULT_COUNT_CAP;
  const offset = Math.max(0, Number(args.offset ?? 0));
  const markAccessed = args.mark_accessed !== false;

  const layer = resolveLayer(args.layer);
  const band = args.band as string | undefined;
  const axis: AxisFilters = {
    altitude: args.altitude,
    mem_type: args.mem_type,
    mem_state: args.mem_state,
    thread_id: args.thread_id,
  };

  // Fetch a generous candidate pool for composite re-rank, dedup, pagination, band filter.
  // Token-budget trimming happens at assembly, so fetch enough that many small memories can fill it.
  const fetchLimit = Math.max(hardLimit * 3, 90) + offset;

  let rows: any[] = [];
  let searchMethod: 'fts5' | 'like' | 'fts5+like' = 'like';

  const plan = queryPlan(args.query ?? '');
  const ftsQuery = plan.fts.length ? plan.fts.map((t) => `"${t}"`).join(' OR ') : '';
  const canUseFts = !!ftsQuery && !args.entity_name;
  // CJK query (0.19.2): its 1–2 char pieces also go to LIKE, and relevance is the piece
  // coverage for every candidate (FTS- or LIKE-found). An English query has no pieces.
  const likePieces = plan.cjk && !args.entity_name ? plan.like : [];
  const pieceMode = plan.cjk && !args.entity_name && plan.fts.length + plan.like.length > 0;
  const wholeNeedle = pieceMode ? wholeQuery(args.query ?? '').toLowerCase() : '';
  // Whole-question tier only for a Japanese question WITHOUT spaces. A space-separated one
  // (「トマト ジュース」) is ranked like English — one tier — as before (Codex review 3 of #32).
  // tierMode also fetches the whole-question rows on their own before any LIMIT (below), and
  // the LIKE search looks for the question without its edge punctuation (no trailing ？).
  const tierMode = pieceMode && !/\s/.test(String(args.query ?? '').trim());
  const likeQueryText = tierMode ? wholeQuery(args.query ?? '') : args.query;

  // Superseded rows are left out in SQL by default; asking for them (include_superseded, or
  // mem_state:'superseded') keeps them. The hidden ones are counted with the same filters.
  const showSuperseded = args?.include_superseded === true || axis.mem_state === 'superseded';
  // Consolidated rows (0.18.1: marked `consolidated_into`, kept in the table) are hidden the
  // same way; include_consolidated shows them. The two counts do not overlap: a row that is
  // both superseded and consolidated is counted once, under superseded.
  const showConsolidated = args?.include_consolidated === true;
  const sup: SupersededMode = showSuperseded ? 'include' : 'exclude';
  const con: SupersededMode = showConsolidated ? 'include' : 'exclude';
  const hidden: HiddenModes = { sup, con };
  const HIDDEN_COUNT_CAP = 1000;
  const countHidden = (h: HiddenModes): number => {
    const hiddenIds = new Set<number>();
    if (canUseFts) {
      for (const r of runFtsQuery(ftsQuery, layer, HIDDEN_COUNT_CAP, axis, h)) hiddenIds.add(r.id);
      for (const r of runLikeQuery(likeQueryText, undefined, layer, HIDDEN_COUNT_CAP, axis, h, likePieces)) hiddenIds.add(r.id);
    } else {
      for (const r of runLikeQuery(likeQueryText, args.entity_name, layer, HIDDEN_COUNT_CAP, axis, h, likePieces)) hiddenIds.add(r.id);
    }
    return hiddenIds.size;
  };
  const supersededHidden = showSuperseded ? 0 : countHidden({ sup: 'only', con: 'include' });
  const consolidatedHidden = showConsolidated ? 0 : countHidden({ sup, con: 'only' });
  const capped = (n: number) => (n >= HIDDEN_COUNT_CAP ? `${HIDDEN_COUNT_CAP}+` : n);

  if (canUseFts) {
    const ftsRows = runFtsQuery(ftsQuery, layer, fetchLimit, axis, hidden);
    const likeRows = runLikeQuery(likeQueryText, undefined, layer, fetchLimit, axis, hidden, likePieces);
    const seen = new Map<number, any>();
    for (const r of ftsRows) seen.set(r.id, { ...r, _via: 'fts' });
    for (const r of likeRows) {
      if (seen.has(r.id)) {
        seen.get(r.id)._via = 'fts+like'; // both matched
      } else {
        seen.set(r.id, { ...r, _via: 'like' });
      }
    }
    rows = Array.from(seen.values());
    if (ftsRows.length > 0 && likeRows.length > 0) searchMethod = 'fts5+like';
    else if (ftsRows.length > 0) searchMethod = 'fts5';
    else searchMethod = 'like';
  } else {
    rows = runLikeQuery(likeQueryText, args.entity_name, layer, fetchLimit, axis, hidden, likePieces).map((r) => ({ ...r, _via: 'like' }));
    searchMethod = 'like';
  }
  // The whole-question tier is the first sort key, so its rows must be candidates whatever the
  // FTS / LIKE LIMITs kept: one long row with the whole question lost its FTS slot to 160 short
  // rows with the pieces (Codex review 3 of #32). Fetched on their own (escaped LIKE, same
  // hidden / layer / axis filters, at most fetchLimit rows by importance) and merged in.
  if (tierMode) {
    const have = new Set(rows.map((r) => r.id));
    for (const r of runLikeQuery(likeQueryText, undefined, layer, fetchLimit, axis, hidden)) {
      if (!have.has(r.id)) { rows.push({ ...r, _via: 'like' }); have.add(r.id); }
    }
  }

  const useFts = searchMethod !== 'like';
  const now = Math.floor(Date.now() / 1000);

  // Opportunistically refresh momentum for entities about to be surfaced
  refreshStaleMomentum(rows.map((r) => r.entity_id));
  // Re-fetch momentum after refresh (cheap single-pass update)
  if (rows.length > 0) {
    const ids = Array.from(new Set(rows.map((r) => r.entity_id)));
    const ph = ids.map(() => '?').join(',');
    const fresh = db.prepare(`SELECT id, momentum_score FROM entities WHERE id IN (${ph})`).all(...ids) as any[];
    const byId = new Map(fresh.map((f) => [f.id, f.momentum_score]));
    for (const r of rows) r.momentum_score = byId.get(r.entity_id) ?? r.momentum_score;
  }

  // Relevance of an FTS-matched row (0.19.1): mostly WHICH asked words it contains, weighted
  // by rarity (termCoverage above), so a row with every asked word ranks above one with some of
  // them, and a name that is on every memory of a person no longer decides the order. bm25
  // orders rows within the same coverage (0.2 share) through a fixed, bounded transform of its
  // own value, x / (1 + x) with x = -bm25 (FTS5's bm25 is <= 0, lower = better), NOT min-max over
  // the candidates: min-max stretched any spread to the full 0..1, so two rows a few 1e-7 apart
  // (a word present in every row → FTS5 clamps its IDF to 1e-6) got 0.2 of relevance between
  // them and a long pinned caveat lost to a short low-importance note on a one-word query
  // (Codex review 1 of #30). With the fixed transform a tiny bm25 difference stays tiny and
  // heat / importance decide, as they did before. Before 0.19.1 relevance was bm25 alone,
  // normalised against a range forced to include 0 and 1. Rows only the LIKE fallback found
  // keep 0.5, as before.
  const bmNormOf = (bm: number): number => { const x = Math.max(0, -Number(bm) || 0); return x / (1 + x); };
  const coverageOf = useFts || pieceMode ? termCoverage(plan) : () => 0;

  // Composite weights adapt to query specificity:
  //  - broad / no query → importance & heat carry more (relevance is a flat 0.5 anyway)
  //  - focused (1-2 terms) → relevance leads
  //  - narrow (3+ terms) → relevance dominates, so off-topic-but-pinned memories don't crowd in
  const queryTermCount = pieceMode
    ? plan.fts.length + plan.like.length // CJK: count pieces, not space-words
    : String(args.query ?? '').trim().split(/\s+/).filter(Boolean).length;
  let w_rel = 0.45, w_heat = 0.25, w_mom = 0.15, w_imp = 0.15;
  if (useFts || pieceMode) {
    if (queryTermCount >= 3) { w_rel = 0.72; w_heat = 0.12; w_mom = 0.08; w_imp = 0.08; }
    else { w_rel = 0.60; w_heat = 0.18; w_mom = 0.12; w_imp = 0.10; }
  }

  const scored = rows.map((r) => {
    const daysSince = (now - r.last_accessed_at) / 86400;
    const heat = computeHeat({
      accessesLast30d: daysSince < 30 ? r.access_count : 0,
      accessesLast90d: daysSince < 90 ? r.access_count : 0,
      daysSinceLastAccess: daysSince,
      totalAccesses: r.access_count,
      baseImportance: r.importance,
    });

    // Individual weight contributions (for transparency)
    const isFtsRow = pieceMode || (useFts && r._via !== 'like');
    // Whole-question tier (CJK): a row that contains the whole question (edge punctuation off)
    // ranks above every row that does not — the first sort key, not a weight: a relevance of 1
    // inside the weighted sum still lost to a hot, important row sharing one piece (はなし vs
    // 在庫なし, Codex review 2 of #32). Inside each tier the composite decides, as before; such a
    // row also gets relevance 1, so among whole-question rows heat / importance decide.
    const wholeHit = pieceMode && !!wholeNeedle &&
      (String(r.content ?? '').toLowerCase().includes(wholeNeedle) || String(r.entity_name ?? '').toLowerCase().includes(wholeNeedle));
    const coverage = isFtsRow ? coverageOf(r.id) : 0;
    const bmNorm = bmNormOf(r.bm25_score);
    const relevance = wholeHit ? 1 : isFtsRow ? 0.8 * coverage + 0.2 * bmNorm : 0.5;
    const heatNorm = heat.score / 100;
    const momNorm = Math.min(1, (r.momentum_score ?? 0) / 10);
    const importanceBoost = r.importance; // 0-1

    // Composite (weights adapt to query specificity — computed above)
    const composite = w_rel * relevance + w_heat * heatNorm + w_mom * momNorm + w_imp * importanceBoost;

    // match_reasons: human-readable WHY this row is here
    const reasons: string[] = [];
    if (r._via === 'fts' || r._via === 'fts+like') reasons.push(`content_match_${r._via === 'fts+like' ? 'dual' : 'fts'}`);
    if (r._via === 'like' || r._via === 'fts+like') {
      if (args.entity_name || (args.query && String(r.entity_name || '').toLowerCase().includes(String(args.query).toLowerCase()))) {
        reasons.push('entity_name_match');
      } else {
        reasons.push('content_substring');
      }
    }
    if (heat.band === 'hot') reasons.push('heat:hot');
    else if (heat.band === 'warm') reasons.push('heat:warm');
    if (r.momentum_score >= 5) reasons.push('entity_active');
    if (r.importance >= 0.9) reasons.push('pinned');
    else if (r.importance >= 0.8) reasons.push('high_importance');
    if (r.protected === 1 && r.layer === 'caveat') reasons.push('caveat_protected');
    if (wholeHit) reasons.push('whole_query_match');

    return {
      ...r,
      heat_score: heat.score,
      heat_band: heat.band,
      composite_score: composite,
      relevance_score: relevance,
      _whole: wholeHit && tierMode ? 1 : 0,
      _reasons: reasons,
      _breakdown: {
        relevance: Number(relevance.toFixed(3)),
        ...(isFtsRow ? { term_coverage: Number(coverage.toFixed(3)) } : {}),
        heat: Number(heatNorm.toFixed(3)),
        momentum: Number(momNorm.toFixed(3)),
        importance: Number(importanceBoost.toFixed(3)),
      },
    };
  });

  // Supersedes links among the candidates, both directions (indexed on both columns).
  const supersededBy = new Map<number, number>();   // old id → newest id that supersedes it
  const supersedesOf = new Map<number, number[]>(); // new id → old ids
  const allIds = scored.map((r) => r.id);
  for (let i = 0; i < allIds.length; i += 400) { // chunked: offset can make the pool large
    const ids = allIds.slice(i, i + 400);
    const ph = ids.map(() => '?').join(',');
    const links = db.prepare(
      `SELECT from_memory_id AS f, to_memory_id AS t FROM memory_edges
        WHERE relation = 'supersedes' AND (from_memory_id IN (${ph}) OR to_memory_id IN (${ph}))
        ORDER BY from_memory_id ASC`,
    ).all(...ids, ...ids) as Array<{ f: number; t: number }>;
    for (const l of links) {
      if (supersededBy.has(l.t) && (supersedesOf.get(l.f) ?? []).includes(l.t)) continue; // seen in an earlier chunk
      supersededBy.set(l.t, Math.max(supersededBy.get(l.t) ?? 0, l.f));
      supersedesOf.set(l.f, [...(supersedesOf.get(l.f) ?? []), l.t]);
    }
  }
  // Superseded rows were already left out in SQL (before the LIMIT) unless asked for.
  const visible = scored;

  // Apply band filter AFTER scoring (needs heat.band)
  const filtered = band ? visible.filter((s) => s.heat_band === band) : visible;

  // Sort: rows containing the whole CJK question first (always 0 for English / space-separated
  // queries, so their order is unchanged), then by composite (best first).
  filtered.sort((a, b) => b._whole - a._whole || b.composite_score - a.composite_score);

  // Dedup near-identical memories (same entity + near-identical core text).
  // filtered is sorted desc, so the first occurrence kept is the highest-ranked.
  // This collapses the common "same message saved under two layers" duplication.
  const seenSig = new Set<string>();
  const deduped = filtered.filter((r) => {
    const sig = contentSignature(r.content, r.entity_id);
    if (!sig) return true;              // too short / no usable text → never dedup
    if (seenSig.has(sig)) return false; // duplicate → drop
    seenSig.add(sig);
    return true;
  });

  const total = deduped.length;

  // Greedy assembly under a REAL token budget: add memories (deduped + ranked) until
  // including the next would blow max_tokens, capped at hardLimit by COUNT. Always
  // returns at least one memory if anything matched.
  const memoriesOut: any[] = [];
  const returnedIds: number[] = [];
  let accTokens = 0;
  let stoppedBy: 'tokens' | 'limit' | 'end' = 'end';

  for (let i = offset; i < total; i++) {
    if (memoriesOut.length >= hardLimit) { stoppedBy = 'limit'; break; }
    const r = deduped[i];
    let parsedContent: unknown = r.content;
    try { parsedContent = JSON.parse(r.content); } catch { /* leave as string */ }
    const memObj = {
      id: r.id,
      entity: {
        id: r.entity_id,
        name: r.entity_name,
        kind: r.entity_kind,
        momentum: Number((r.momentum_score ?? 0).toFixed(2)),
      },
      layer: r.layer,
      axis: {
        altitude: r._altitude ?? null,
        type: r._mem_type ?? null,
        state: r._mem_state ?? null,
        thread_id: r._thread_id ?? null,
      },
      content: parsedContent,
      importance: r.importance,
      pinned: r.importance >= 0.9,
      // One short field each, only when the row has it (no tokens spent on absence).
      ...(byFromSource(r._source) ? { by: byFromSource(r._source) } : {}),
      ...(supersedesOf.has(r.id) ? { supersedes: supersedesOf.get(r.id)!.map((x) => `#${x}`).join(' ') } : {}),
      ...(supersededBy.has(r.id) ? { superseded_by: supersededBy.get(r.id) } : {}),
      ...(consolidatedIntoOf(parsedContent) !== undefined ? { consolidated_into: consolidatedIntoOf(parsedContent) } : {}),
      // Ranking internals only on request — they roughly double the per-memory cost and an
      // agent acting on the memory needs what/why/state, not the scorer's arithmetic.
      ...(args?.explain ? {
        heat: Number(r.heat_score.toFixed(1)),
        band: r.heat_band,
        composite: Number(r.composite_score.toFixed(3)),
        match_reasons: r._reasons,
        score_breakdown: r._breakdown,
      } : {}),
    };
    if (!args?.explain) delete (memObj as any).entity.momentum;
    const memTokens = estimateTokens(JSON.stringify(memObj));
    if (memoriesOut.length > 0 && accTokens + memTokens > maxTokens) { stoppedBy = 'tokens'; break; }
    accTokens += memTokens;
    memoriesOut.push(memObj);
    returnedIds.push(r.id);
  }

  const hasMore = offset + memoriesOut.length < total;

  // Mark accessed (only the returned set, and only if asked)
  if (markAccessed && returnedIds.length > 0) {
    const mark = db.prepare('UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?');
    const tx = db.transaction((ids: number[]) => { for (const id of ids) mark.run(now, id); });
    tx(returnedIds);
  }

  return JSON.stringify({
    ok: true,
    count: memoriesOut.length,
    total_candidates: total,
    offset,
    has_more: hasMore,
    stopped_by: stoppedBy,
    approx_tokens: accTokens,
    search: searchMethod,
    resolved_layer: layer ?? null,
    resolved_axis: {
      altitude: axis.altitude ?? null,
      type: axis.mem_type ?? null,
      state: axis.mem_state ?? null,
    },
    ...(supersededHidden > 0 ? { superseded_hidden: capped(supersededHidden), superseded_hint: 'include_superseded: true to show them' } : {}),
    ...(consolidatedHidden > 0 ? { consolidated_hidden: capped(consolidatedHidden), consolidated_hint: 'include_consolidated: true to show them (rows folded into a summary; still in the DB)' } : {}),
    memories: memoriesOut,
  });
}

function handleForget(args: any): string {
  if (args.memory_id) {
    // Explicit delete by id — respect protected AND pinned (importance >= 0.9)
    const target = db.prepare('SELECT id, layer, importance, protected FROM memories WHERE id = ?').get(args.memory_id) as any;
    if (!target) {
      return JSON.stringify({ ok: false, error: `memory_id ${args.memory_id} not found` });
    }
    if (target.protected === 1 || target.importance >= 0.9) {
      const isLayerProtected = target.protected === 1;
      return JSON.stringify({
        ok: false,
        preserved: true,
        reason: isLayerProtected ? `${target.layer}-layer is auto-protected` : 'pinned (importance>=0.9)',
        hint: isLayerProtected
          ? `${target.layer} memories are permanently protected (the whole point — pain lessons must not be lost). If you truly need to delete, copy its content to another layer via remember() first, then drop the DB row manually via a SQLite client.`
          : 'Use update_memory to lower importance below 0.9 first, then forget.',
      });
    }
    const res = db.prepare('DELETE FROM memories WHERE id = ?').run(args.memory_id);
    return JSON.stringify({ ok: true, deleted: res.changes, memory_id: args.memory_id });
  }

  // 0.18.1: the id-less auto-sweep that used to follow here (DELETE every row whose forgetting
  // score crossed a threshold) is removed. No caller reached it; it is gone so that the only
  // memory DELETE in the server is the explicit one above.
  return JSON.stringify({ ok: false, error: 'memory_id required: forget deletes one memory by id; there is no sweep' });
}

function handleConsolidate(args: any): string {
  const dryRun = !!args?.dry_run;
  if (dryRun) {
    // Read-only preview, the same plan `--apply` would act on (0.18.1).
    const plan = planConsolidate(db, { min_age_days: typeof args?.min_age_days === 'number' ? args.min_age_days : undefined });
    return JSON.stringify({
      ok: true,
      dry_run: true,
      clusters: plan.clusters.length,
      memories_folded_if_run: plan.wouldFold,
      deleted_if_run: 0,
      preview: plan.clusters.slice(0, 20).map((c) => ({
        entity: c.entity_name,
        layer: c.layer,
        count: c.ids.length,
      })),
      hint: 'Set dry_run=false to consolidate (originals are kept and marked consolidated_into).',
    });
  }
  const result = runConsolidate(db, {
    scope: args?.scope ?? 'session',
    min_age_days: typeof args?.min_age_days === 'number' ? args.min_age_days : undefined,
  });
  return JSON.stringify({ ok: true, ...result });
}

/**
 * merge: true (0.20.0). Shallow merge of the keys in `incoming` into the stored JSON object:
 * a key sent wins, a key sent as null is removed, every other stored key is kept.
 * Both sides must be JSON objects (not arrays, not null, not plain text); otherwise refused.
 */
// Keys a merge may overwrite but never remove with null (Codex review 1 of #34): they carry where a
// memory came from and how it relates to others. The one list; sending null for any of them refuses
// the whole merge.
const MERGE_UNREMOVABLE_KEYS: readonly string[] = [
  'title', 'evidence_refs', 'session_id',
  'restored_from', 'original_id', 'original_created_at', 'restored_verdict',
  'supersedes', 'superseded_by', 'consolidated_into',
  'distilled', 'altitude', 'type', 'state',
];

function mergeJsonObject(stored: string, incoming: string):
  | { ok: true; content: string; kept: number; set: string[]; removed: string[] }
  | { ok: false; reason: string; keys?: string[] } {
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  let next: unknown;
  try { next = JSON.parse(incoming); } catch {
    return { ok: false, reason: 'merge: true needs content to be a JSON object; this content is not JSON. Nothing was written. To replace the whole content with text, send it without merge.' };
  }
  if (!isObj(next)) {
    return { ok: false, reason: 'merge: true needs content to be a JSON object (not an array, a string or null). Nothing was written.' };
  }
  let base: unknown;
  try { base = JSON.parse(stored); } catch { base = undefined; }
  if (!isObj(base)) {
    return { ok: false, reason: 'merge: true needs the stored content to be a JSON object; this memory is stored as plain text (or as JSON that is not an object). Nothing was written. Send the full content without merge to replace it.' };
  }
  const blocked = Object.entries(next).filter(([k, v]) => v === null && MERGE_UNREMOVABLE_KEYS.includes(k)).map(([k]) => k);
  if (blocked.length > 0) {
    return {
      ok: false,
      keys: blocked,
      reason: `merge cannot remove ${blocked.join(', ')} (null): these keys record where the memory came from and how it relates to others. Nothing was written. Send a value to change them, or leave them out to keep them.`,
    };
  }
  const out: Record<string, unknown> = { ...base };
  const set: string[] = [], removed: string[] = [];
  for (const [k, v] of Object.entries(next)) {
    if (v === null) { if (k in out) removed.push(k); delete out[k]; }
    else { out[k] = v; set.push(k); }
  }
  const kept = Object.keys(out).filter((k) => !set.includes(k)).length;
  return { ok: true, content: JSON.stringify(out), kept, set, removed };
}

// The read and the write of an update happen in one IMMEDIATE transaction, so a merge cannot be
// computed from a row another connection changes in between (0.20.0).
function handleUpdateMemory(args: any): string {
  return db.transaction(() => updateMemoryInTx(args)).immediate();
}

function updateMemoryInTx(args: any): string {
  const memoryId = Number(args.memory_id);
  if (!Number.isFinite(memoryId)) {
    return JSON.stringify({ ok: false, error: 'memory_id (number) required' });
  }
  const existing = db.prepare('SELECT id, entity_id, layer, content, importance, protected FROM memories WHERE id = ?').get(memoryId) as any;
  if (!existing) {
    return JSON.stringify({ ok: false, error: `memory_id ${memoryId} not found` });
  }

  const patch: Record<string, any> = {};
  let mergeNote: { kept: number; set: string[]; removed: string[] } | undefined;
  if (args.merge === true) {
    // merge: true — change only the keys sent (0.20.0). Both sides must be JSON objects; anything
    // else is refused with nothing written (no guessing how to merge text into JSON or vice versa).
    if (typeof args.content !== 'string') {
      return JSON.stringify({ ok: false, rejected: 'merge', saved: false, memory_id: memoryId, reason: 'merge: true needs content: a JSON object with the keys to change.' });
    }
    const merged = mergeJsonObject(existing.content, args.content);
    if (!merged.ok) {
      return JSON.stringify({ ok: false, rejected: 'merge', saved: false, memory_id: memoryId, reason: merged.reason, ...(merged.keys ? { keys: merged.keys } : {}) });
    }
    patch.content = merged.content;
    mergeNote = { kept: merged.kept, set: merged.set, removed: merged.removed };
  } else if (typeof args.content === 'string') patch.content = args.content;
  if (typeof args.layer === 'string') {
    const resolved = resolveLayer(args.layer);
    if (!resolved || !(LAYER_ENUM as readonly string[]).includes(resolved)) {
      return JSON.stringify({ ok: false, error: `unknown layer "${args.layer}"` });
    }
    // Cannot demote a caveat out of caveat (caveat is auto-protected by trigger)
    if (existing.layer === 'caveat' && resolved !== 'caveat' && existing.protected === 1) {
      return JSON.stringify({
        ok: false,
        error: 'Cannot move a protected caveat memory to another layer. Create a new memory in the target layer instead.',
      });
    }
    patch.layer = resolved;
  }
  if (args.importance !== undefined) {
    const imp = Math.min(1, Math.max(0, Number(args.importance)));
    patch.importance = imp;
    patch.protected = imp >= 0.9 || existing.protected === 1 ? 1 : 0;
  }

  const keys = Object.keys(patch);
  if (keys.length === 0) {
    return JSON.stringify({ ok: false, error: 'no fields to update (provide content, layer, or importance)' });
  }
  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => patch[k]);
  db.prepare(`UPDATE memories SET ${setClause} WHERE id = ?`).run(...values, memoryId);

  // Record the update as an event for audit trail
  db.prepare('INSERT INTO events (entity_id, kind, payload) VALUES (?, ?, ?)').run(
    existing.entity_id,
    'memory_updated',
    JSON.stringify({ memory_id: memoryId, changed: keys })
  );

  return JSON.stringify({
    ok: true,
    memory_id: memoryId,
    updated_fields: keys,
    ...(mergeNote ? { merged: { keys_set: mergeNote.set, keys_removed: mergeNote.removed, keys_kept: mergeNote.kept } } : {}),
    pinned: (patch.importance ?? existing.importance) >= 0.9,
  });
}

function handleListEntities(args: any): string {
  const kind = args?.kind as string | undefined;
  const minMemories = Math.max(1, Number(args?.min_memories ?? 1));
  const limit = Math.max(1, Math.min(200, Number(args?.limit ?? 30)));
  const offset = Math.max(0, Number(args?.offset ?? 0));

  let sql = `
    SELECT e.id, e.name, e.kind, e.canonical_key, e.momentum_score,
           e.updated_at, e.created_at,
           COUNT(m.id) as memory_count,
           MAX(m.last_accessed_at) as last_memory_access,
           SUM(CASE WHEN m.layer = 'goal' THEN 1 ELSE 0 END) as goal_count,
           SUM(CASE WHEN m.layer = 'caveat' THEN 1 ELSE 0 END) as caveat_count,
           SUM(CASE WHEN m.layer = 'learning' THEN 1 ELSE 0 END) as learning_count,
           SUM(CASE WHEN m.layer = 'implementation' THEN 1 ELSE 0 END) as impl_count,
           SUM(CASE WHEN m.importance >= 0.9 THEN 1 ELSE 0 END) as pinned_count
    FROM entities e
    LEFT JOIN memories m ON m.entity_id = e.id
    WHERE 1=1
  `;
  const params: any[] = [];
  if (kind) { sql += ' AND e.kind = ?'; params.push(kind); }
  sql += ' GROUP BY e.id';
  if (minMemories > 1) sql += ' HAVING memory_count >= ?';
  if (minMemories > 1) params.push(minMemories);
  // Sort: active (high momentum) first, then most memories, then most recent
  sql += ' ORDER BY (COALESCE(e.momentum_score,0) * 10 + memory_count * 0.5 + (last_memory_access / 86400.0 / 365) * 2) DESC';
  sql += ' LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as any[];

  const totalRow = db.prepare(
    kind ? 'SELECT COUNT(*) as c FROM entities WHERE kind = ?' : 'SELECT COUNT(*) as c FROM entities'
  ).get(...(kind ? [kind] : [])) as { c: number };

  return JSON.stringify({
    ok: true,
    total: totalRow.c,
    returned: rows.length,
    offset,
    has_more: offset + rows.length < totalRow.c,
    entities: rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      canonical_key: r.canonical_key,
      momentum: Number((r.momentum_score ?? 0).toFixed(2)),
      memory_count: r.memory_count,
      last_memory_access: r.last_memory_access ? new Date(r.last_memory_access * 1000).toISOString() : null,
      layer_breakdown: {
        goal: r.goal_count,
        caveat: r.caveat_count,
        learning: r.learning_count,
        implementation: r.impl_count,
      },
      pinned_count: r.pinned_count,
    })),
  });
}

function handleRecallFile(args: any): string {
  const sub = String(args.path_substring ?? '').trim();
  if (!sub) return JSON.stringify({ ok: false, error: 'path_substring required' });
  const maxIntents = Math.max(1, Math.min(50, args.max_intents ?? 10));

  const totalRow = db.prepare(`SELECT COUNT(*) as c, MIN(occurred_at) as first_at, MAX(occurred_at) as last_at, COUNT(DISTINCT session_id) as sessions FROM session_file_edits WHERE file_path LIKE ?`).get(`%${sub}%`) as any;
  if (!totalRow || totalRow.c === 0) {
    return JSON.stringify({ ok: true, count: 0, note: 'No edits found for that path substring.' });
  }

  // Daily breakdown
  const daily = db.prepare(`
    SELECT DATE(occurred_at, 'unixepoch') as day, operation, COUNT(*) as edits
    FROM session_file_edits WHERE file_path LIKE ?
    GROUP BY day, operation ORDER BY day
  `).all(`%${sub}%`) as any[];

  // Distinct context_snippets (intents) — deduped, ordered by recency
  const intents = db.prepare(`
    SELECT DISTINCT context_snippet, MAX(occurred_at) as last_at, COUNT(*) as freq
    FROM session_file_edits
    WHERE file_path LIKE ? AND context_snippet IS NOT NULL AND LENGTH(context_snippet) > 20
    GROUP BY context_snippet
    ORDER BY last_at DESC
    LIMIT ?
  `).all(`%${sub}%`, maxIntents) as any[];

  // Linked memories
  const memories = db.prepare(`
    SELECT DISTINCT m.id, m.layer, m.content, m.importance, e.name as entity_name
    FROM session_file_edits sfe
    JOIN memories m ON m.id = sfe.memory_id
    JOIN entities e ON e.id = m.entity_id
    WHERE sfe.file_path LIKE ?
    ORDER BY m.importance DESC
    LIMIT 20
  `).all(`%${sub}%`) as any[];

  // Distinct file paths matched (the substring may match multiple files)
  const paths = db.prepare(`SELECT file_path, COUNT(*) as edits FROM session_file_edits WHERE file_path LIKE ? GROUP BY file_path ORDER BY edits DESC`).all(`%${sub}%`) as any[];

  return JSON.stringify({
    ok: true,
    path_substring: sub,
    paths_matched: paths,
    summary: {
      total_edits: totalRow.c,
      first_edit_at: new Date(totalRow.first_at * 1000).toISOString(),
      last_edit_at: new Date(totalRow.last_at * 1000).toISOString(),
      sessions_involved: totalRow.sessions,
    },
    daily_breakdown: daily,
    user_intents: intents.map((i) => ({
      when: new Date(i.last_at * 1000).toISOString(),
      occurrences: i.freq,
      intent: i.context_snippet,
    })),
    linked_memories: memories.map((m) => ({
      id: m.id,
      entity: m.entity_name,
      layer: m.layer,
      importance: m.importance,
      preview: m.content.length > 300 ? m.content.slice(0, 300) + '...' : m.content,
    })),
  });
}

function handleReadSmart(args: any): string {
  return handleReadSmartImpl(db, { path: args.path, force: args.force });
}

// ============================================================
// v0.3.0 — five-blocks helpers (sampling / roots / elicitation in handlers)
// ============================================================

async function handleRecallFileWithRoots(args: any): Promise<string> {
  const baseJson = handleRecallFile(args);
  if (!args?.scope_to_roots) return baseJson;
  let parsed: any;
  try {
    parsed = JSON.parse(baseJson);
  } catch {
    return baseJson;
  }
  if (!parsed?.ok || !Array.isArray(parsed.paths_matched)) return baseJson;
  const roots = await fetchRoots(server);
  if (roots.length === 0) {
    parsed.roots_filter = { applied: false, reason: 'client provided no roots' };
    return JSON.stringify(parsed);
  }
  const filtered = parsed.paths_matched.filter((p: any) => isInsideRoots(p.file_path, roots));
  parsed.roots_filter = { applied: true, root_count: roots.length, before: parsed.paths_matched.length, after: filtered.length };
  parsed.paths_matched = filtered;
  return JSON.stringify(parsed);
}

async function handleConsolidateWithSampling(args: any): Promise<string> {
  // Sampling only applies on a real run (not dry-run) and only when explicitly opted in.
  if (!args?.use_llm || args?.dry_run) return handleConsolidate(args);

  // 1. Snapshot all candidate memories BEFORE consolidate runs so we can recover
  //    their content (the originals are deleted by consolidate).
  const ageCutoff = Math.floor(Date.now() / 1000) - (typeof args?.min_age_days === 'number' ? args.min_age_days : 7) * 86400;
  const snapshot = new Map<number, { id: number; content: string; entity_name: string }>();
  const candidateRows = db
    .prepare(
      `SELECT m.id, m.content, e.name as entity_name
       FROM memories m JOIN entities e ON e.id = m.entity_id
       WHERE m.protected = 0
         AND m.layer IN ('context','emotion','implementation')
         AND m.created_at <= ?`
    )
    .all(ageCutoff) as any[];
  for (const r of candidateRows) snapshot.set(r.id, r);

  // 2. Run the normal heuristic consolidate (creates learning entries, deletes source).
  const baseJson = handleConsolidate(args);
  let parsed: any;
  try {
    parsed = JSON.parse(baseJson);
  } catch {
    return baseJson;
  }
  if (!parsed?.ok || !Array.isArray(parsed.learningIdsCreated)) {
    parsed = parsed ?? {};
    parsed.sampling = { applied: false, reason: 'consolidate returned no learning entries' };
    return JSON.stringify(parsed);
  }

  // 3. For each new learning entry, look up its replaced_ids from the audit table,
  //    gather source contents from the snapshot, and request a sampled summary.
  let upgraded = 0;
  let declined = 0;
  const declineReasons: string[] = [];
  for (const learningId of parsed.learningIdsCreated as number[]) {
    const audit = db.prepare('SELECT replaced_ids FROM consolidations WHERE learning_id = ?').get(learningId) as any;
    if (!audit) {
      declined++;
      continue;
    }
    let replaced: number[];
    try {
      replaced = JSON.parse(audit.replaced_ids);
    } catch {
      declined++;
      continue;
    }
    if (!Array.isArray(replaced) || replaced.length < 2) {
      declined++;
      continue;
    }
    const sources = replaced
      .map((id) => snapshot.get(id))
      .filter((s): s is NonNullable<typeof s> => Boolean(s));
    if (sources.length < 2) {
      declined++;
      continue;
    }
    const entityName = sources[0]?.entity_name ?? '<entity>';
    const result = await sampleConsolidation(server, sources.map((s) => s.content), entityName);
    if (result.ok && result.text) {
      db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(result.text.trim(), learningId);
      upgraded++;
    } else {
      declined++;
      if (result.reason && declineReasons.length < 3) declineReasons.push(result.reason);
    }
  }
  parsed.sampling = {
    applied: true,
    upgraded,
    declined,
    ...(declineReasons.length ? { decline_reasons: declineReasons } : {}),
  };
  return JSON.stringify(parsed);
}

async function handleForgetInteractive(args: any): Promise<string> {
  if (!args?.interactive || !args?.memory_id) return handleForget(args);
  const id = Number(args.memory_id);
  const row = db
    .prepare(`SELECT m.id, m.layer, m.content, m.importance, e.name as entity FROM memories m JOIN entities e ON e.id = m.entity_id WHERE m.id = ?`)
    .get(id) as any;
  if (!row) return JSON.stringify({ ok: false, error: `memory ${id} not found` });
  const ok = await confirmForget(server, {
    id: row.id,
    entity: row.entity,
    layer: row.layer,
    importance: row.importance,
    preview: row.content,
  });
  if (!ok) return JSON.stringify({ ok: false, declined: true, memory_id: id, reason: 'user declined elicitation' });
  return handleForget({ memory_id: id });
}

// ============================================================
// Unified dispatchers (v0.7.0 — 3-tool surface)
// ============================================================

/**
 * Refusal for content that is meant as JSON but is broken (0.20.0), else null.
 * "Meant as JSON" (narrowed after Codex review 1 of #34) — after spaces:
 *   • `{` followed by `"` or `}`                       ({"what": … / {} )
 *   • `[` followed by `{` `[` `"` or `]`               ([{"what": … / [] )
 *   • `[` followed by a number, then `,` or the end, or `]` that ends the content  ([1, 2 / [3] )
 * Anything else starting with `{` / `[` is text and saved as before: "{tenant} is the placeholder",
 * "{ retry(); }", "{x}", "[TODO] …", "[2026-11-10] …" (2026 is followed by "-"), "[3] steps left".
 * force: true skips this check — the explicit way to store such content as text.
 */
function brokenJsonRefusal(content: unknown): string | null {
  if (typeof content !== 'string') return null;
  const t = content.trim();
  const meantAsJson = /^\{\s*["}]/.test(t)
    || /^\[\s*[{["\]]/.test(t)
    || /^\[\s*-?\d+(\.\d+)?([eE][+-]?\d+)?\s*(,|$|\]$)/.test(t);
  if (!meantAsJson) return null;
  try { JSON.parse(content); return null; } catch (e: any) {
    const msg = String(e?.message ?? e);
    const m = /position (\d+)/.exec(msg);
    const at = m ? Number(m[1]) : content.length; // "Unexpected end of JSON input" → it ends early
    const position = Math.min(at, content.length) + 1;
    return JSON.stringify({
      ok: false,
      rejected: 'broken_json',
      saved: false,
      position,
      length: content.length,
      error: `content starts like JSON but is broken at character ${position} of ${content.length} (${msg.split('\n')[0].slice(0, 160)}). Nothing was saved. Send the complete JSON, or pass force: true to store it as text.`,
      near: content.slice(Math.max(0, at - 30), at + 10),
    });
  }
}

async function handleRememberUnified(args: any): Promise<string> {
  // Delete mode
  if (args.forget) {
    if (!args.memory_id) {
      return JSON.stringify({ ok: false, error: 'memory_id required for forget mode' });
    }
    return handleForgetInteractive({ memory_id: args.memory_id, interactive: !!args.interactive });
  }
  // Content that starts like JSON but does not parse is refused, on create and update alike
  // (0.20.0). It used to be wrapped as a string and stored — 136 cut-off rows on one DB.
  const broken = args.force === true ? null : brokenJsonRefusal(args.content);
  if (broken) return broken;
  if (args.merge === true && !args.memory_id) {
    return JSON.stringify({ ok: false, rejected: 'merge', saved: false, reason: 'merge: true applies to an update (memory_id). To create a memory, send content without merge.' });
  }
  // Update mode
  if (args.memory_id) {
    if (args.supersedes !== undefined && args.supersedes !== null) {
      return JSON.stringify({ ok: false, rejected: 'supersedes', reason: 'supersedes applies when creating a memory, not when updating one (memory_id). Remember the new decision without memory_id and pass supersedes: <old id>.', saved: false });
    }
    return handleUpdateMemory(args);
  }
  // Create mode (default). Only content is required; everything an agent used to have to
  // invent is defaulted. Inventing an entity name and picking a layer were the two places a
  // "remember this" call stalled — the taxonomy is for the dashboard, not for the agent.
  if (!args.content || !String(args.content).trim()) {
    return JSON.stringify({
      ok: false,
      error: 'content is required. (entity/layer are optional now.) To update, provide memory_id. To delete, set forget: true + memory_id.',
    });
  }
  const a = { ...args };
  let entityInferred: string | undefined;
  if (!a.entity_name) {
    const inferred = await inferDefaultEntity();
    a.entity_name = inferred.name;
    a.entity_kind = a.entity_kind ?? inferred.kind;
    entityInferred = inferred.from;
  }
  if (!a.entity_kind) a.entity_kind = 'project';
  if (!a.layer) a.layer = a.anchor ? 'learning' : 'context';
  const out = handleRemember(a);
  if (!entityInferred) return out;
  try {
    const parsed = JSON.parse(out);
    if (parsed.ok) parsed.entity_inferred_from = entityInferred;
    return JSON.stringify(parsed);
  } catch { return out; }
}

/**
 * The entity a memory is about when the caller did not say: the project they are in.
 * Same evidence chain as where_am_i — workspace roots first, then the files edited recently.
 */
async function inferDefaultEntity(): Promise<{ name: string; kind: string; from: string }> {
  try {
    const roots = await fetchRoots(server);
    if (roots.length === 1) {
      const base = rootPathFromUri(roots[0].uri).replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop();
      if (base) return { name: base, kind: 'project', from: 'workspace_root' };
    }
  } catch { /* roots unsupported by this host */ }
  try {
    const rows = db
      .prepare(`SELECT file_path FROM session_file_edits WHERE occurred_at > unixepoch() - 86400 ORDER BY occurred_at DESC LIMIT 40`)
      .all() as Array<{ file_path: string }>;
    const paths = rows.map((r) => r.file_path.replace(/\\/g, '/').split('/').filter(Boolean));
    if (paths.length > 0) {
      // longest common directory prefix of what was touched → its basename is the project
      let prefix = paths[0].slice(0, -1);
      for (const p of paths.slice(1)) {
        let i = 0;
        while (i < prefix.length && i < p.length - 1 && prefix[i].toLowerCase() === p[i].toLowerCase()) i++;
        prefix = prefix.slice(0, i);
        if (prefix.length === 0) break;
      }
      const base = prefix[prefix.length - 1];
      if (base && !/^(c:|users|home|[a-z])$/i.test(base)) return { name: base, kind: 'project', from: 'recent_edits' };
    }
  } catch { /* fall through */ }
  return { name: 'workspace', kind: 'project', from: 'fallback' };
}

/**
 * The session brief: what an agent needs in the first call of a session, in one call.
 *
 * On 2026-09-05 this took four calls (recall / drift_status / dream / where_am_i), ~20k tokens,
 * and one of them failed. The brief carries the attention items in full and everything else as
 * counts plus a hint for the drill-down — small enough to call freely, complete enough that the
 * agent does not have to know which of five tools holds which fact.
 */
async function handleSessionBrief(): Promise<string> {
  const view = getTruthView(db, {});
  const bs = view.counts.by_state;
  const triage = `${view.counts.nodes} anchors: ` + [
    bs.drift > 0 ? `🔴 ${bs.drift} drifting` : null,
    bs.review > 0 ? `🟡 ${bs.review} needs review` : null,
    bs.held > 0 ? `⚪ ${bs.held} held` : null,
    `🔵 ${bs.aligned} verified`,
    bs.unverified > 0 ? `⚫ ${bs.unverified} unverified` : null,
  ].filter(Boolean).join(' · ');
  const attention = view.attention.slice(0, 8).map((n) => ({
    id: n.id, state: n.state, statement: n.statement.slice(0, 160), reality: (n.reality ?? '').slice(0, 160),
  }));

  let where: unknown = null;
  try {
    const w = JSON.parse(await handleWhereAmI({}));
    where = w.located
      ? { project: w.project, you_are_here: w.you_are_here }
      : w.reason
        ? { reason: w.reason, available_projects: w.available_projects }
        : null;
  } catch { /* no map, or roots unavailable — the brief still stands */ }

  let open_loops: unknown = null;
  try {
    const d = JSON.parse(handleDream({}));
    open_loops = {
      north_star: d.north_star ? { id: d.north_star.id, statement: String(d.north_star.statement).slice(0, 160) } : null,
      proposals: d.total ?? 0,
      proposals_top: (d.candidates ?? []).slice(0, 3).map((c: any) => ({ candidate_id: c.candidate_id ?? c.id, statement: String(c.statement ?? c.target_statement ?? '').slice(0, 120) })),
      distill_queue: d.distill_total ?? 0, // rows still needing a rewrite; rule-verdicted rows are not counted
      friction: d.friction_total ?? 0,
    };
  } catch { /* fine */ }

  let entities: unknown = [];
  try {
    entities = (JSON.parse(handleListEntities({ limit: 8 })).entities ?? []).map((e: any) => ({ name: e.name, kind: e.kind, memories: e.memory_count }));
  } catch { /* fine */ }

  return JSON.stringify({
    ok: true,
    brief: true,
    triage,
    attention,
    where,
    open_loops,
    entities,
    next: [
      'recall({ query }) to search; recall({ path }) for a file\'s history',
      'drift_status() for the full truth map; drift_status({ anchor_id }) for one decision',
      'recall({ dream: true }) to triage proposals and drain the distill queue',
      'remember({ content, anchor: {} }) to record a decision and enforce it',
    ],
  });
}

async function handleRecallUnified(args: any): Promise<string> {
  // Folded surfaces (roadmap 5): locating yourself and the triage session are ways of
  // recalling, not separate tools.
  if (args?.dream) return handleDream({ domain: args.domain, distill: args.distill });
  if (args?.where !== undefined && args?.where !== false) {
    return handleWhereAmI({ query: args.where === true ? undefined : String(args.where), project: args.project, limit: args.limit });
  }
  // File history mode (path takes priority; if query also provided, include it as context)
  if (args.path) {
    const fileResult = await handleRecallFileWithRoots({
      path_substring: args.path,
      max_intents: args.max_intents,
      scope_to_roots: args.scope_to_roots,
    });
    // If query was also provided, merge with memory search for richer context
    if (args.query && String(args.query).trim().length > 0) {
      const memResult = handleRecall({ ...args, limit: 5, max_tokens: 500 });
      const fileParsed = JSON.parse(fileResult);
      const memParsed = JSON.parse(memResult);
      return JSON.stringify({
        ...fileParsed,
        related_memories: memParsed.memories ?? [],
        note: 'Combined file history + memory search (both path and query were provided)',
      });
    }
    return fileResult;
  }
  // No search criteria at all → the session brief (or the entity list on request).
  const hasQuery = args.query && String(args.query).trim().length > 0;
  const hasFilters = args.entity_name || args.layer || args.altitude ||
    args.mem_type || args.mem_state || args.thread_id || args.band;
  if (!hasQuery && !hasFilters) {
    if (args.overview || args.kind || args.min_memories !== undefined || args.offset) {
      return handleListEntities({ kind: args.kind, min_memories: args.min_memories, limit: args.limit, offset: args.offset });
    }
    return handleSessionBrief();
  }
  // Search mode (default)
  return handleRecall(args);
}

// ============================================================
// Drift tool handlers (v0.8.0)
// ============================================================

function handleDriftStatus(args: any): string {
  if (args?.anchor_id) return handleCheckDecision({ anchor_id: args.anchor_id });
  const view = getTruthView(db, {
    domain: args?.domain,
    decision_mode: args?.decision_mode,
  });
  logAnchorTouch(db, { tool: 'drift_status', interaction: 'review' });

  // Build a concise triage line
  const { by_state, nodes } = view.counts;
  const triage = [
    by_state.drift > 0 ? `🔴 ${by_state.drift} drifting` : null,
    by_state.review > 0 ? `🟡 ${by_state.review} needs review` : null,
    by_state.held > 0 ? `⚪ ${by_state.held} held` : null,
    `🔵 ${by_state.aligned} verified`,
    by_state.unverified > 0 ? `⚫ ${by_state.unverified} unverified` : null,
  ].filter(Boolean).join(' · ');

  if (args?.verbose) {
    return JSON.stringify({
      ok: true,
      triage: `${nodes} anchors: ${triage}`,
      nextReopen: view.nextReopen,
      attention: view.attention,
      alignedByDomain: view.alignedByDomain,
      candidates: view.candidates,
      counts: view.counts,
    });
  }
  // Compact by default. The agent asked "what needs attention" — answer that in full and keep
  // the rest to one line per node. (Full form was ~15k tokens for 43 anchors; the 2 drifting
  // items were buried under 41 aligned ones with rationale.)
  const aligned = view.alignedByDomain.map((g) => ({
    domain: g.domain,
    count: g.nodes.length,
    nodes: g.nodes.map((n) => ({ id: n.id, statement: n.statement, reality: n.reality })),
  }));
  // Unverified is the quiet majority on most machines. One line each, grouped by domain —
  // enough to see where the detector has no eyes, not enough to bury the six that matter.
  const unverified = view.unverifiedByDomain.map((g) => ({
    domain: g.domain,
    count: g.nodes.length,
    nodes: g.nodes.map((n) => ({ id: n.id, statement: n.statement })),
  }));
  const cand = view.candidates as any;
  return JSON.stringify({
    ok: true,
    triage: `${nodes} anchors: ${triage}`,
    nextReopen: view.nextReopen,
    attention: view.attention,
    aligned,
    unverified,
    candidates: { auto: cand?.auto?.length ?? 0, suppressed: cand?.suppressed?.length ?? 0 },
    counts: view.counts,
    hint: 'verbose:true for full nodes and candidate details; check_decision(anchor_id) for one node. ⚫ unverified = declared, never checked against reality: give it affects/violation_signal so the detector can see it, or leave it as a note.',
  });
}

// Fix ① (2026-06-17): infer the Map project from the client's workspace roots when the
// caller didn't name one — pick the project whose slug matches the repo you're working in,
// so the no-arg "per-turn re-anchor" lands on the right map (not a stale/demo one).
// map_projects has no path column, so we match the slug as a path segment of a root.
async function resolveProjectFromRoots(): Promise<string | undefined> {
  const projects = listMapProjects(db);
  if (projects.length <= 1) return projects[0]; // 0 → undefined ("no map"); 1 → use it
  const roots = await fetchRoots(server);
  if (roots.length === 0) return undefined; // client gave no roots → let ② disambiguate
  const segs = roots.map((r) => rootPathFromUri(r.uri).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, ''));
  const matches = projects.filter((p) => {
    const slug = p.toLowerCase();
    return segs.some((path) => path === slug || path.endsWith('/' + slug) || path.split('/').includes(slug));
  });
  return matches.length === 1 ? matches[0] : undefined; // unique repo match only; else ② handles it
}

// ①b (2026-09-05): when the client sends no roots (common — not every MCP host implements
// roots), infer the map from the files edited most recently. The DB already knows what you
// touched; the map slug is a path segment of those files.
function resolveProjectFromRecentEdits(): { project?: string; from?: string } {
  const projects = listMapProjects(db);
  if (projects.length <= 1) return { project: projects[0] };
  const rows = db
    .prepare(
      `SELECT file_path FROM session_file_edits
        WHERE occurred_at > unixepoch() - 86400
        ORDER BY occurred_at DESC LIMIT 50`,
    )
    .all() as Array<{ file_path: string }>;
  if (rows.length === 0) return {};
  const hits = new Map<string, number>();
  for (const r of rows) {
    const segs = r.file_path.toLowerCase().replace(/\\/g, '/').split('/');
    for (const p of projects) if (segs.includes(p.toLowerCase())) hits.set(p, (hits.get(p) ?? 0) + 1);
  }
  if (hits.size === 0) return {};
  const [best, second] = [...hits.entries()].sort((a, b) => b[1] - a[1]);
  if (second && second[1] === best[1]) return {}; // tie → still ambiguous
  return { project: best[0], from: 'recent_edits' };
}

async function handleWhereAmI(args: any): Promise<string> {
  // ① roots; ①b recent edits; ② (inside whereAmI) is the last fallback.
  let project: string | undefined = args?.project ?? (await resolveProjectFromRoots());
  if (!project) project = resolveProjectFromRecentEdits().project;
  const res = whereAmI(db, {
    query: args?.query, node_id: args?.node_id, project, limit: args?.limit,
  });
  if (res.ambiguous) {
    return JSON.stringify({
      ok: true, located: false, reason: 'ambiguous_project',
      available_projects: res.ambiguous.available,
      hint: `Multiple maps imported and none matched your workspace roots or the files you edited in the last 24h — pass project: one of [${res.ambiguous.available.join(', ')}].`,
    });
  }
  if (res.matched.length === 0) {
    return JSON.stringify({
      ok: true, project: res.project, located: false,
      hint: res.project ? 'No node matched. Try a node id or a topical keyword.' : 'No Map imported yet — run linksee-memory-map.',
    });
  }
  const located = res.matched.map((m) => ({
    node: m.node.id,
    stage: m.stage_label,
    status: m.node.status,
    statement: m.node.statement,
    why: m.match_reason,
    // the whole point: what else moves if you touch this
    blast_radius: m.blast.map((b) => `${b.id} (${b.relation})`),
    decision: m.anchor ? `#${m.anchor.id}: ${m.anchor.statement}` : null,
  }));
  const top = res.matched[0];
  const youAreHere = `You are at "${top.node.id}"`
    + (top.stage_label ? ` in stage 「${top.stage_label}」` : '')
    + `. Touching it implicates ${top.blast.length} node(s)`
    + (top.blast.length ? `: ${top.blast.map((b) => b.id).join(', ')}` : ' (isolated)')
    + '.';
  return JSON.stringify({ ok: true, project: res.project, located: true, you_are_here: youAreHere, job: res.job, matched: located });
}

function handleCheckDecision(args: any): string {
  if (!args?.anchor_id) throw new Error('anchor_id is required');
  const detail = getDecisionDetail(db, args.anchor_id);
  if (!detail) {
    return JSON.stringify({ ok: false, error: `Anchor ${args.anchor_id} not found or not active` });
  }
  logAnchorTouch(db, { anchorId: args.anchor_id, tool: 'check_decision', interaction: 'inspect' });
  return JSON.stringify({ ok: true, decision: detail });
}

function handleDeclareAnchor(args: any): string {
  if (!args?.kind || !args?.statement) {
    throw new Error('kind and statement are required');
  }
  // An orphaned proposal is a fork the user never took. Same tool as any other declaration —
  // the agent should not need a separate verb for "I noticed something went unaddressed".
  if (args.kind === 'proposal') {
    const r = JSON.parse(handleFlagProposals({
      session_context: args.session_context,
      proposals: [{
        statement: args.statement, rationale: args.rationale, domain: args.domain ?? 'general',
        confidence: args.confidence, decided: args.decided, siblings: args.siblings,
      }],
    }));
    const anchorId = r.proposals?.[0]?.anchor_id;
    if (!r.ok || !anchorId) {
      return JSON.stringify({ ok: false, error: r.error ?? 'proposal was not recorded (statement must be >= 10 chars)' });
    }
    const cand = db.prepare(
      `SELECT id FROM memory_write_candidates WHERE target_node_id = ? AND scope = 'orphaned_proposal' ORDER BY id DESC LIMIT 1`,
    ).get(anchorId) as { id: number } | undefined;
    return JSON.stringify({
      ok: true, anchor_id: anchorId, candidate_id: cand?.id ?? null, kind: 'proposal', statement: args.statement,
      message: `Proposal recorded as review item #${anchorId}. Triage later: recall({ dream: true }) → resolve_drift({ candidate_id: ${cand?.id ?? '<id>'}, action: 'surface' | 'dismiss', rationale }).`,
    });
  }

  // Create the base anchor
  const anchor = declareAnchor(db, {
    kind: args.kind,
    statement: args.statement,
    rationale: args.rationale,
    affects: args.affects,
    detect_terms: args.detect_terms,
    violation_signal: args.violation_signal,
    tier: args.tier ?? 'human',
  });

  // Apply v9 ProjectCoreNode fields if provided
  const nodeFields: Record<string, unknown> = {};
  if (args.node_type !== undefined) nodeFields.node_type = args.node_type;
  if (args.domain !== undefined) nodeFields.domain = args.domain;
  if (args.decision_mode !== undefined) nodeFields.decision_mode = args.decision_mode;
  if (args.confidence !== undefined) nodeFields.confidence = args.confidence;
  if (args.lifecycle !== undefined) nodeFields.lifecycle = args.lifecycle;
  if (args.review_after !== undefined) {
    nodeFields.review_after = Math.floor(new Date(args.review_after).getTime() / 1000);
  }

  if (Object.keys(nodeFields).length > 0) {
    setNodeFields(db, anchor.id, nodeFields);
  }

  logAnchorTouch(db, { anchorId: anchor.id, tool: 'declare_anchor', interaction: 'create' });

  return JSON.stringify({
    ok: true,
    anchor_id: anchor.id,
    statement: anchor.statement,
    kind: anchor.kind,
    message: `Anchor #${anchor.id} declared: "${anchor.statement.substring(0, 80)}"`,
  });
}

function handleResolveDrift(args: any): string {
  // A proposal verdict is a resolution like any other; it just targets a candidate row.
  if (args?.candidate_id) {
    if (!['surface', 'dismiss'].includes(args.action)) {
      return JSON.stringify({ ok: false, error: `candidate_id takes action 'surface' or 'dismiss' (got '${args.action}')` });
    }
    if (!args.rationale) {
      return JSON.stringify({ ok: false, error: 'rationale is required for a proposal verdict — say what in the North Star decided it' });
    }
    try {
      return handleResolveProposal({ candidate_id: args.candidate_id, verdict: args.action, rationale: args.rationale });
    } catch (e: any) {
      return JSON.stringify({ ok: false, error: String(e?.message ?? e) });
    }
  }
  if (!args?.anchor_id || !args?.action) {
    throw new Error('anchor_id and action are required');
  }
  logAnchorTouch(db, { anchorId: args.anchor_id, tool: 'resolve_drift', interaction: 'resolve' });
  // Enforcement-policy actions — apply the dream "escalate_to_hard" recommendation in ONE call.
  // Folded into resolve_drift (not a new tool) to honor anchor #1. Intercepted here so the WIP
  // truth-engine.ts resolveDrift() stays untouched.
  if (args.action === 'harden' || args.action === 'soften') {
    const mode = args.action === 'harden' ? 'hard' : 'soft';
    const res = setGateMode(db, args.anchor_id, mode);
    return JSON.stringify({
      ...res,
      action: args.action,
      message: `anchor #${args.anchor_id} gate_mode → '${mode}'${args.rationale ? ` (${args.rationale})` : ''}. Future PreToolUse on this anchor will ${mode === 'hard' ? 'BLOCK' : 'soft-warn'}.`,
    });
  }
  const result = resolveDrift(db, {
    anchor_id: args.anchor_id,
    action: args.action,
    rationale: args.rationale,
    review_after: args.review_after,
    superseded_by: args.superseded_by,
    hit_term: args.hit_term,
    gate: args.gate,
  });
  return JSON.stringify(result);
}

// ============================================================
// flag_proposals — orphaned proposal detection (v0.9.0 prototype)
// Agent explicitly declares unresolved proposals from the conversation.
// Each proposal → anchor(hypothesis) + pending_review candidate → "review" state on dashboard.
// ============================================================

function handleFlagProposals(args: any): string {
  const proposals = args?.proposals;
  if (!Array.isArray(proposals) || proposals.length === 0) {
    return JSON.stringify({ ok: false, error: 'proposals array is required (1-10 items)' });
  }
  if (proposals.length > 10) {
    return JSON.stringify({ ok: false, error: 'Max 10 proposals per call (batch in multiple calls if needed)' });
  }

  const sessionContext = args.session_context ?? 'conversation session';
  const PROPOSAL_TAG = 'orphaned_proposal';
  const now = Math.floor(Date.now() / 1000);

  const insertAnchor = db.prepare(`
    INSERT INTO drift_anchors (
      kind, statement, rationale, domain, decision_mode,
      confidence, lifecycle, status, owner,
      evidence_refs, created_at, updated_at
    ) VALUES (
      'decision', ?, ?, ?, 'hypothesis',
      ?, 'active', 'active', 'agent',
      ?, ?, ?
    )
  `);

  const insertCandidate = db.prepare(`
    INSERT INTO memory_write_candidates (
      scope, candidate_type, target_node_id, rationale,
      confidence, evidence_refs, status, created_at
    ) VALUES (
      'orphaned_proposal', 'update_node', ?, ?,
      ?, ?, 'pending_review', ?
    )
  `);

  const results: Array<{ anchor_id: number; statement: string; domain: string }> = [];

  const txn = db.transaction(() => {
    for (const p of proposals) {
      const statement = String(p.statement ?? '').trim();
      if (statement.length < 10) continue;  // skip junk

      const rationale = String(p.rationale ?? '').trim();
      const domain = String(p.domain ?? 'general').trim();
      const confidence = Math.max(0, Math.min(1, Number(p.confidence) || 0.5));

      const evidenceRefs = JSON.stringify([{
        type: 'proposal_set',
        tag: PROPOSAL_TAG,
        session_context: sessionContext,
        decided: p.decided ?? null,
        siblings: p.siblings ?? [],
        flagged_at: new Date().toISOString(),
      }]);

      // 1. Create anchor
      const anchorResult = insertAnchor.run(
        statement, rationale, domain,
        confidence, evidenceRefs, now, now,
      );
      const anchorId = Number(anchorResult.lastInsertRowid);

      // 2. Create pending_review candidate → triggers "review" state
      insertCandidate.run(
        anchorId,
        `Orphaned proposal: ${sessionContext}`,
        confidence,
        evidenceRefs,
        now,
      );

      results.push({ anchor_id: anchorId, statement, domain });
    }
  });
  txn();

  return JSON.stringify({
    ok: true,
    flagged: results.length,
    proposals: results,
    message: `Flagged ${results.length} orphaned proposal(s) for review. They will appear as "review" items on the dashboard.`,
    tag: PROPOSAL_TAG,
    hint: 'User can resolve each via resolve_drift(anchor_id, action) or on the dashboard.',
  });
}

// ============================================================
// dream — Dreaming Memory: North Star + orphaned proposals for agent evaluation
// The agent IS the Doctor. MCP just provides data + update path.
// ============================================================

// content_full budget of one dream reply (bytes, UTF-8). Reasoning next to its use in handleDream.
const DISTILL_CONTENT_BUDGET = 200 * 1024;
// Cap on each top-level field of a dream row other than raw_what / context_hint (bytes, UTF-8).
const DISTILL_FIELD_MAX = 2 * 1024;

/** The longest prefix of text that is at most maxBytes in UTF-8 (never splits a character). */
function cutToBytes(text: string, maxBytes: number): string {
  let out = '', n = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (n + b > maxBytes) break;
    out += ch; n += b;
  }
  return out;
}

function handleDream(args: any): string {
  const domainFilter = args?.domain;

  // 1. Fetch active North Star anchor(s)
  const northStars = db.prepare(`
    SELECT id, statement, rationale, domain, confidence, lifecycle,
           datetime(review_after, 'unixepoch') as review_date,
           datetime(created_at, 'unixepoch') as declared_at
    FROM drift_anchors
    WHERE node_type = 'north_star' AND status = 'active'
    ORDER BY created_at DESC
  `).all() as any[];

  // Re-injection friction — the active-observability loop closing back into reflection.
  // "Re-surfaced N×, yet still contradicted in reality" is the machine evidence behind #15443.
  let friction: FrictionItem[] = [];
  try {
    friction = getReinjectionFriction(db, { minContradicts: 3 });
  } catch {
    /* additive — never break dream on a friction-query error */
  }

  // Distillation queue — the quality gate's LLM half. The hook-path extractor stores RAW
  // utterances (no LLM there); the agent rewrites them here into clean what/why via
  // remember(memory_id, content). Matches needs_distill (new) AND the legacy hardcoded
  // why-strings so the existing backlog is drainable without a backfill write.
  const distillLimit = Math.max(1, Math.min(25, Number(args?.distill ?? 8) || 8));
  let distillQueue: any[] = [];
  let distillMoreCount = 0;
  try {
    // One WHERE for the page and for the total, so more_count is the true number left (Codex R2 of #34).
    const DISTILL_FROM_WHERE = `
        FROM memories m JOIN entities e ON e.id = m.entity_id
       WHERE m.layer IN ('learning', 'caveat')
         AND json_valid(m.content)
         -- settle window: the Stop hook extracts every turn, so the newest rows belong to a
         -- session still in motion. Don't ask the agent to distill the conversation it is in.
         AND m.created_at < unixepoch() - 1800
         AND json_extract(m.content, '$.distill_verdict') IS NULL
         AND (json_extract(m.content, '$.needs_distill') = 1
              OR json_extract(m.content, '$.why') = 'Decision detected by pattern match — may need agent enrichment'
              OR json_extract(m.content, '$.why') = 'User-stated warning/prohibition — auto-extracted by caveat pattern match')`;
    const rows = db.prepare(`
      SELECT m.id, m.layer, m.content, datetime(m.created_at, 'unixepoch') AS created, e.name AS entity
      ${DISTILL_FROM_WHERE}
       ORDER BY (m.layer = 'caveat') DESC,
                (e.name <> 'Local') DESC,
                length(json_extract(m.content, '$.what')) DESC,
                m.created_at DESC
       LIMIT ${distillLimit}
    `).all() as any[];
    const distillMatching = Number((db.prepare(`SELECT COUNT(*) AS n ${DISTILL_FROM_WHERE}`).get() as any)?.n ?? rows.length);
    // 0.20.0: each row also carries the axes, the title and `content_full` — every stored key,
    // parsed, uncut. raw_what / context_hint are cut at 220 characters for reading; every other
    // top-level value is capped at DISTILL_FIELD_MAX bytes (Codex R2 of #34: a 300 KiB `affects`
    // went out whole). `truncated` names each value that was cut — never copy one back.
    const CUT = 220;
    const all = rows.map((r) => {
      let c: any = {};
      try { c = JSON.parse(r.content); } catch { /* keep empty */ }
      if (c === null || typeof c !== 'object' || Array.isArray(c)) c = {};
      const truncated: string[] = [];
      const short = (key: string, v: unknown): string => {
        const s = String(v);
        if (s.length > CUT) { truncated.push(key); return s.slice(0, CUT); }
        return s;
      };
      const capped = (key: string, v: unknown): unknown => {
        if (v === undefined || v === null) return v;
        const text = typeof v === 'string' ? v : JSON.stringify(v);
        if (Buffer.byteLength(text, 'utf8') <= DISTILL_FIELD_MAX) return v;
        truncated.push(key);
        return cutToBytes(text, DISTILL_FIELD_MAX); // a cut non-string becomes its cut JSON text
      };
      return {
        memory_id: r.id,
        layer: r.layer,
        entity: capped('entity', r.entity),
        title: capped('title', c.title),
        altitude: capped('altitude', c.altitude),
        type: capped('type', c.type),
        state: capped('state', c.state),
        raw_what: short('raw_what', c.what ?? ''),
        context_hint: c.context_hint ? short('context_hint', c.context_hint) : undefined,
        affects: capped('affects', c.affects),
        created: r.created,
        truncated,
        content_full: c as any,
      } as Record<string, any>;
    });
    // Size budget of one reply (Codex reviews 1 and 2 of #34): without one, 25 rows of 1 MiB each
    // made a 25 MiB reply. Counted on each row's WHOLE JSON (top-level fields + content_full), not
    // on content_full alone. 200 KiB keeps the worst case ~125× smaller while a normal queue —
    // captured rows are a few KiB each, 8 per call by default — never reaches it. Rows are kept in
    // queue order until the next one would pass the budget. A row whose content_full alone would
    // pass it is listed without content_full (content_full_omitted: <bytes>) — its other fields are
    // capped, so the row itself stays small. more / more_count come from the COUNT above.
    let used = 0;
    for (const row of all) {
      if (row.truncated.length === 0) delete row.truncated;
      let bytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
      if (bytes > DISTILL_CONTENT_BUDGET) {
        const full = Buffer.byteLength(JSON.stringify(row.content_full), 'utf8');
        delete row.content_full;
        row.content_full_omitted = full;
        row.content_full_hint = `content is ${full} bytes, over the ${DISTILL_CONTENT_BUDGET}-byte budget of one dream reply: read it from the database file directly (memory.db in the linksee memory directory: SELECT content FROM memories WHERE id = ${row.memory_id}) before rewriting, and rewrite with merge: true.`;
        bytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
      }
      if (used + bytes > DISTILL_CONTENT_BUDGET) break;
      used += bytes;
      distillQueue.push(row);
    }
    distillMoreCount = Math.max(0, distillMatching - distillQueue.length);
  } catch {
    /* additive — never break dream on a distill-query error */
  }
  const moreFields = distillMoreCount > 0 ? { more: true, more_count: distillMoreCount } : {};

  if (northStars.length === 0) {
    return JSON.stringify({
      ok: true,
      north_star: null,
      candidates: [],
      friction,
      friction_total: friction.length,
      distill_queue: distillQueue,
      distill_total: distillPending(db),
      distill_shown: distillQueue.length, ...moreFields,
      distill_hint: 'Ordered by value (caveats first, named entities, longer text). Pass distill: N (max 25) for a longer drain. Rules already set a distill_verdict on acknowledgements, bare paths and 90-day-old never-recalled items — you only see what needs judgement. Rewrite with remember({ memory_id, merge: true, content: { only the keys you change } }) — the other keys stay; read content_full, never copy a value listed in truncated.',
      message:
        friction.length > 0
          ? 'No North Star declared yet — but the re-injection layer surfaced friction below: anchors being violated despite being re-surfaced. Declare a North Star (declare_anchor node_type:"north_star"), and act on the friction items.'
          : 'No North Star declared yet. Declare one with declare_anchor(node_type: "north_star") before dreaming.',
    });
  }

  // 2. Fetch pending orphaned proposals
  const candidateQuery = domainFilter
    ? `SELECT mc.id as candidate_id, mc.target_node_id as anchor_id,
              mc.rationale as candidate_rationale, mc.confidence,
              mc.evidence_refs, mc.status,
              datetime(mc.created_at, 'unixepoch') as flagged_at,
              da.statement, da.rationale as anchor_rationale, da.domain,
              da.evidence_refs as anchor_evidence
       FROM memory_write_candidates mc
       JOIN drift_anchors da ON mc.target_node_id = da.id
       WHERE mc.scope = 'orphaned_proposal' AND mc.status = 'pending_review'
         AND da.domain = ?
       ORDER BY mc.created_at DESC`
    : `SELECT mc.id as candidate_id, mc.target_node_id as anchor_id,
              mc.rationale as candidate_rationale, mc.confidence,
              mc.evidence_refs, mc.status,
              datetime(mc.created_at, 'unixepoch') as flagged_at,
              da.statement, da.rationale as anchor_rationale, da.domain,
              da.evidence_refs as anchor_evidence
       FROM memory_write_candidates mc
       JOIN drift_anchors da ON mc.target_node_id = da.id
       WHERE mc.scope = 'orphaned_proposal' AND mc.status = 'pending_review'
       ORDER BY mc.created_at DESC`;

  const candidates = domainFilter
    ? db.prepare(candidateQuery).all(domainFilter) as any[]
    : db.prepare(candidateQuery).all() as any[];

  // 3. Enrich with proposal context from evidence_refs
  const enrichedCandidates = candidates.map(c => {
    let context: Record<string, unknown> = {};
    try {
      const refs = JSON.parse(c.anchor_evidence || '[]');
      const proposalRef = refs.find((r: any) => r.tag === 'orphaned_proposal');
      if (proposalRef) {
        context = {
          decided: proposalRef.decided,
          siblings: proposalRef.siblings,
          session_context: proposalRef.session_context,
        };
      }
    } catch { /* malformed JSON — skip enrichment */ }

    return {
      candidate_id: c.candidate_id,
      anchor_id: c.anchor_id,
      statement: c.statement,
      rationale: c.anchor_rationale,
      domain: c.domain,
      confidence: c.confidence,
      flagged_at: c.flagged_at,
      ...context,
    };
  });

  const guideParts: string[] = [];
  if (enrichedCandidates.length > 0) {
    guideParts.push(
      'Evaluate each candidate against the North Star: "Given our current direction/ICP/phase, is this ' +
        'unresolved branch still important?" Then call resolve_proposal(candidate_id, verdict, rationale) for each.'
    );
  }
  if (friction.length > 0) {
    guideParts.push(
      `⚠ FRICTION: ${friction.length} accepted anchor(s) keep being re-surfaced at the gate (see "friction"). ` +
        'For each suggested_action="escalate_to_hard", call resolve_drift(anchor_id, action:"harden") to make the ' +
        'gate BLOCK it; for "review_or_supersede", call resolve_drift(anchor_id, action:"supersede", …) if the rule ' +
        'has outrun reality.'
    );
  }
  if (distillQueue.length > 0) {
    guideParts.push(
      `🧪 DISTILL: ${distillQueue.length} auto-extracted memories hold RAW user utterances (see "distill_queue"). ` +
        'For each: read content_full (every stored key, uncut — raw_what / context_hint are cut at 220 characters ' +
        'when listed in `truncated`, never copy them back) and rewrite into ONE clean decision/warning (resolve ' +
        'references like "option a"). Save with remember({ memory_id, merge: true, content }) where content is a ' +
        'JSON object with ONLY the keys you change — merge keeps every other key (title, affects, evidence_refs, ' +
        'session_id, axes): a one-line `what` (the actual decision, not the chat), a true `why`, `"distilled": true` ' +
        '(REQUIRED — this marker is what protects your rewrite from the next session re-import; omit it and the raw ' +
        'utterance resurrects), and `"needs_distill": null, "context_hint": null` (null removes a key). ' +
        'If raw_what carries no real decision/warning, set its type to "note" and state to "superseded" instead.'
    );
  }
  if (guideParts.length === 0) guideParts.push('No pending proposals, no gate friction, nothing to distill. The dream is clear.');

  return JSON.stringify({
    ok: true,
    north_star: northStars[0],
    all_north_stars: northStars.length > 1 ? northStars : undefined,
    candidates: enrichedCandidates,
    total: enrichedCandidates.length,
    friction,
    friction_total: friction.length,
    distill_queue: distillQueue,
    distill_total: distillPending(db),
    distill_shown: distillQueue.length, ...moreFields,
    distill_hint: 'Ordered by value (caveats first, named entities, longer text). Pass distill: N (max 25) for a longer drain. Rules already set a distill_verdict on acknowledgements, bare paths and 90-day-old never-recalled items — you only see what needs judgement. Rewrite with remember({ memory_id, merge: true, content: { only the keys you change } }) — the other keys stay; read content_full, never copy a value listed in truncated.',
    guide: guideParts.join(' '),
  });
}

// ============================================================
// resolve_proposal — Agent writes back surface/dismiss verdict
// ============================================================

function handleResolveProposal(args: any): string {
  const candidateId = args?.candidate_id;
  const verdict = args?.verdict;
  const rationale = args?.rationale;

  if (!candidateId || !verdict || !rationale) {
    throw new Error('candidate_id, verdict, and rationale are required');
  }
  if (!['surface', 'dismiss'].includes(verdict)) {
    throw new Error('verdict must be "surface" or "dismiss"');
  }

  // Verify candidate exists and is pending
  const candidate = db.prepare(`
    SELECT mc.id, mc.target_node_id, mc.status, mc.evidence_refs,
           da.statement
    FROM memory_write_candidates mc
    JOIN drift_anchors da ON mc.target_node_id = da.id
    WHERE mc.id = ? AND mc.scope = 'orphaned_proposal'
  `).get(candidateId) as { id: number; target_node_id: number; status: string; evidence_refs: string; statement: string } | undefined;

  if (!candidate) {
    throw new Error(`Candidate #${candidateId} not found or not an orphaned proposal`);
  }
  if (candidate.status !== 'pending_review') {
    return JSON.stringify({
      ok: false,
      error: `Candidate #${candidateId} is already "${candidate.status}" — cannot re-evaluate`,
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const doctorNote = {
    type: 'doctor_evaluation',
    verdict,
    rationale,
    evaluated_at: new Date().toISOString(),
  };

  // Append doctor evaluation to evidence trail
  let refs: any[] = [];
  try { refs = JSON.parse(candidate.evidence_refs || '[]'); } catch { /* keep empty */ }
  refs.push(doctorNote);
  const updatedRefs = JSON.stringify(refs);

  const txn = db.transaction(() => {
    if (verdict === 'dismiss') {
      // Reject candidate + retire anchor (removes from dashboard)
      db.prepare(
        'UPDATE memory_write_candidates SET status = ?, evidence_refs = ? WHERE id = ?',
      ).run('rejected', updatedRefs, candidateId);

      db.prepare(
        'UPDATE drift_anchors SET status = ?, lifecycle = ?, updated_at = ? WHERE id = ?',
      ).run('retired', 'deprecated', now, candidate.target_node_id);
    } else {
      // Surface: keep pending_review, record doctor's endorsement
      db.prepare(
        'UPDATE memory_write_candidates SET evidence_refs = ? WHERE id = ?',
      ).run(updatedRefs, candidateId);
    }
  });
  txn();

  const shortStmt = candidate.statement.substring(0, 60);
  return JSON.stringify({
    ok: true,
    candidate_id: candidateId,
    anchor_id: candidate.target_node_id,
    verdict,
    statement: candidate.statement,
    message: verdict === 'dismiss'
      ? `Dismissed: "${shortStmt}…" — removed from dashboard`
      : `Surfaced: "${shortStmt}…" — kept for human review on dashboard`,
  });
}

// ============================================================
// MCP wiring
// ============================================================

// Six tools on the surface (2026-09-07, roadmap 5). Anchor #1's reason for "3 tools, never a
// 4th" was real — eight tools bled model-dependent behaviour across Claude/GPT/Cursor/Codex/
// Gemini — and the surface had crept to eleven. The five below are folded into the six
// (see LEGACY_TOOLS) and hidden from tools/list, but a call to any of them still works: an
// agent or a SKILL.md written against 0.14 does not break. LINKSEE_LEGACY_TOOLS=1 lists them.
const LEGACY_TOOLS: Record<string, string> = {
  where_am_i: 'recall({ where: "<topic>" }) — or recall() with no arguments for the session brief',
  check_decision: 'drift_status({ anchor_id })',
  flag_proposals: "declare_anchor({ kind: 'proposal', statement, rationale, domain, decided?, siblings? })",
  dream: 'recall({ dream: true }) — recall() with no arguments already includes the counts',
  resolve_proposal: "resolve_drift({ candidate_id, action: 'surface' | 'dismiss', rationale })",
};
// share_draft: check fields + build the link. No network. Records only that a draft was made.
function handleShareDraft(args: any): string {
  const r = buildShareDraft(args);
  if (!r.ok) return JSON.stringify(r, null, 2);
  try {
    // events row with no entity and no payload: the fact and the time, nothing from the fields.
    db.prepare('INSERT INTO events (entity_id, kind, payload) VALUES (NULL, ?, NULL)').run('share_draft_created');
  } catch { /* the record must never break the tool */ }
  return JSON.stringify(r, null, 2);
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const showLegacy = process.env.LINKSEE_LEGACY_TOOLS === '1';
  const tools = TOOLS
    .filter((t) => showLegacy || !(t.name in LEGACY_TOOLS))
    .map((t) => (t.name in LEGACY_TOOLS
      ? { ...t, description: `(legacy — folded into ${LEGACY_TOOLS[t.name]}. Still works.)\n\n${t.description}` }
      : t));
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let text: string;
    switch (name) {
      case 'remember': text = await handleRememberUnified(args); break;
      case 'recall': text = await handleRecallUnified(args); break;
      case 'read_smart': text = handleReadSmart(args); break;
      // Drift tools (v0.8.0)
      case 'drift_status': text = handleDriftStatus(args); break;
      case 'where_am_i': text = await handleWhereAmI(args); break;
      case 'check_decision': text = handleCheckDecision(args); break;
      case 'declare_anchor': text = handleDeclareAnchor(args); break;
      case 'resolve_drift': text = handleResolveDrift(args); break;
      case 'flag_proposals': text = handleFlagProposals(args); break;
      // Dreaming Memory (v0.9.0)
      case 'dream': text = handleDream(args); break;
      case 'resolve_proposal': text = handleResolveProposal(args); break;
      // Share a fix (link only)
      case 'share_draft': text = handleShareDraft(args); break;
      default: {
        const migrations: Record<string, string> = {
          update_memory: 'remember({ memory_id: <id>, content: "...", importance: 0.8 })',
          forget: 'remember({ forget: true, memory_id: <id> })',
          list_entities: 'recall() with no params',
          recall_file: 'recall({ path: "<file_path>" })',
          consolidate: 'No longer a tool, and since 0.17.1 it does not run on server start either (it deletes the original rows). Opt in on the server with LINKSEE_AUTO_CONSOLIDATE=1 if you want the old weekly start-up run.',
        };
        if (name in migrations) {
          throw new Error(`Tool "${name}" was merged in v0.7.0. Migration: ${migrations[name]}`);
        }
        throw new Error(`Unknown tool: ${name}`);
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (err: any) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err?.message ?? String(err) }) }],
      isError: true,
    };
  }
});

// ============================================================
// Resources block
// ============================================================
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: STATIC_RESOURCES }));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: RESOURCE_TEMPLATES }));
server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const { uri } = req.params;
  const result = readResource(db, uri);
  return { contents: [result] };
});

// ============================================================
// Prompts block
// ============================================================
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const { name, arguments: promptArgs } = req.params;
  return getPrompt(name, promptArgs as Record<string, string> | undefined);
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[linksee-memory] MCP server ready on stdio (v${SERVER_VERSION})\n`);
