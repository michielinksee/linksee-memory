# Changelog

## v0.12.0 — 2026-09-05 (Trust)

Found by using the server as the agent for a day. The theme is one sentence:
**aligned no longer claims convergence it did not check.**

### Fixed — two layers that were not talking to each other

- **Gate honours supersede.** `resolve_drift(action:'supersede')` recorded the resolution
  but the PreToolUse gate selected anchors by status/lifecycle only, so a superseded
  decision kept blocking — while the block text told you to supersede it.
- **Truth view reads `drift_edges`.** The detector had been writing `contradicts` edges since
  June; `drift_status` / `check_decision` never read them and reported 🔵 "Committed reality
  matches intent (convergent)" over open contradictions (one of them the PII constraint).
  Now: open `contradicts` → 🔴 drift, open `absent` → 🟡 review, `dismiss` → 🔵 accounted.
  `reality` names the evidence (file, hit term, date, what to do) or says
  *No signal observed (not verified against reality)*.
- **A supersede record retires the old anchor only.** The replacement inherited the
  "supersede" resolution and could never be shown drifting.

### Changed — less noise for the agent

- `drift_status` is compact by default: attention items in full, aligned as
  id + statement + reality per domain, candidates as counts. `verbose: true` restores the
  previous shape.
- `recall` omits ranking internals (heat / band / composite / momentum / match_reasons /
  score_breakdown) unless `explain: true`. Roughly halves the cost per memory.
- `dream` distill queue skips memories younger than 30 minutes — the Stop hook extracts
  every turn, so it was asking the agent to distill the conversation it was still in.
- `where_am_i` infers the map from files edited in the last 24h when the host sends no
  roots, before declaring the project ambiguous.

### Housekeeping

- Git now contains the tree 0.11.5 was actually published from (schema v15,
  `anchor_touch_log`, `src/lib/anchor-touch.ts`, `src/bin/export-report.ts`, the `export`
  subcommand). Entries for 0.4–0.11 were not kept in this file.
- Regression tests: `test/supersede-gate.mjs`, `test/edges-state.mjs` (throwaway DB).


## v0.3.0 — 2026-05-07 (Five Blocks)

Linksee Memory now implements **5 of the 5 MCP capability blocks**, plus the
newer Elicitation primitive. Most public MCP servers ship Tools only — v0.3.0
moves Linksee Memory into the small set that exposes the full surface.

### Added — Resources block

The memory store is now browseable via `memory://` URIs. Clients (Claude Code,
Cursor, ChatGPT) that support `@-mention` of resources can drop memories into
context without making a tool call.

Static resources:
- `memory://stats` — entity / memory counts, layer + kind breakdown, pinned count
- `memory://hot` — top memories by access_count + recency (proxy for heat)
- `memory://recent` — memories accessed in the last 7 days
- `memory://caveats` — every caveat-layer memory (the protected pile)

Resource templates:
- `memory://entity/{name}` — all memories for an entity
- `memory://layer/{layer}` — all memories in one layer
- `memory://memory/{id}` — single memory by ID

### Added — Prompts block

Five reusable prompt templates that agents can pull from the server:

- `summarize-session` — turn a transcript into 6-layer structured memories
- `extract-caveats` — pull caveat-layer pain lessons from text
- `weekly-consolidation` — sleep-mode summary for an entity
- `recall-and-write` — anti-pattern guard: recall before action with citations
- `entity-handoff` — produce a handoff doc with caveats + open questions

### Added — Sampling (client-side, opt-in)

`consolidate` gains a `use_llm: true` flag. When set, the server pre-snapshots
candidate memories, runs the existing rule-based consolidation, then asks the
client's LLM (via `sampling/createMessage`) to rewrite each cluster's summary
into prose. Clients without sampling support fall back to the heuristic
summary silently.

### Added — Roots (client-side, opt-in)

`recall_file` gains a `scope_to_roots: true` flag. The server fetches the
client's working roots via `roots/list` and filters path-substring matches to
files inside any root. Clients without roots support skip filtering.

### Added — Elicitation (client-side, opt-in)

`forget` gains an `interactive: true` flag. When set with a specific
`memory_id`, the server asks the user to confirm via `elicitation/create`
before deleting. Clients without elicitation support return a graceful
"unsupported" decline.

### Backward compatibility

- All 8 existing tools retain their original signatures and default behavior.
- DB schema unchanged (no migration).
- New flags default to `false`. Existing callers see no behavior change.
- The smoke test from v0.2.x still passes unmodified.

### Why this matters

Anthropic and the MCP working group have repeatedly highlighted that ~99% of
public MCP servers implement only the Tools block. Resources, Prompts,
Sampling, Roots, and Elicitation each unlock a different agent UX:

- **Resources** → @-mentionable browseable memory in the IDE
- **Prompts** → discoverable reusable templates
- **Sampling** → server-side intelligence without a local LLM
- **Roots** → context-aware recall scoped to current work
- **Elicitation** → user-in-the-loop on destructive ops

Linksee Memory v0.3.0 ships all of them.

## v0.2.x

Glama listing saga (HEALTHCHECK / better-sqlite3 v12 / pnpm onlyBuiltDependencies
/ ip-address override / GitHub Actions). Final score: A · A · B (Maintenance B
is the structural "no issues in 6 months" floor for new repos).

## v0.1.x

Initial public release: 8 tools (remember, recall, update_memory, list_entities,
forget, consolidate, recall_file, read_smart). 6-layer structured memory with
caveat protection, FTS5 full-text search, momentum scoring, file diff cache.
