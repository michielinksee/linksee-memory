# Changelog

## v0.13.1 — 2026-09-07 (Fewer false alarms)

Day one of running the guard everywhere produced the noise it was always going to produce, and
two of the three causes were ours.

### Fixed

- **A dismissal now changes the next detection.** `resolve_drift(action:'dismiss')` closed the
  drift edges, but the gate never read the verdict — so the same wrong match fired on the very
  next command. Anchor #13 ("don't favour our own products in rankings", signals = the bare
  product names) fired six times in two minutes because a temp file path contained "Sake-Navi".
  A verdict that does not change what happens next is not a feedback loop. Dismissals are now
  durable (`gate_dismissals`, schema v16) and honoured by the gate. Pass `hit_term` to silence
  one match term and keep the anchor's real detections; omit it to silence the anchor entirely.
- **Scope decides again when the action names files.** 0.13.0 made a signal hit scope-free to
  cure the Bash blind spot, and traded one failure for another: an anchor scoped to one repo
  started firing in every repo containing its term — `insert or ignore` is ordinary SQLite
  everywhere. A signal now stands in for scope only when there is no path to check (Bash); when
  the action names files, the anchor's own `affects` decides. The Bash blind spot stays fixed.

### Changed

- The gate message offers both exits, and names the matched term: supersede if the decision
  changed, dismiss if the match was wrong. Escaping one bad match should not cost you the anchor.

### Added

- `test/guard-dismiss.mjs` — dismissal is honoured, is durable, is scoped to the term, and does
  not disable the rest of the anchor.

## v0.13.0 — 2026-09-07 (On by default)

The guard was the one layer no competing memory tool has, and it was switched off almost
everywhere — including on the author's own machine, which had 42 active anchors and the hook
installed in zero repos. This release is about the gap between "the product can do it" and
"the product does it".

### Changed — the guard is on for every repo

- `setup` wires the re-injection guard into `~/.claude/settings.json`, the scope the MCP
  server is already registered at and the scope the memory itself lives at. One SQLite file
  holds the anchors for all your projects; enforcing them per-repo meant declaring a decision
  once and having it enforced nowhere. `--project-guard` keeps the old behaviour,
  `--no-guard` skips it.
- A non-interactive `setup` now wires it and says so, instead of skipping in silence.

### Fixed

- **A forbidden string now reaches the gate even on a path-scoped anchor.** `affects` says
  where a decision applies, `violation_signal` says what is forbidden — but the gate demanded
  a path match from any anchor that had `affects`, and a Bash command carries no path. 21 of
  42 anchors on a real machine could never fire on Bash, including the one that exists to stop
  destructive migrations: `sqlite3 … "ALTER TABLE memories DROP COLUMN layer"` passed clean.
- **Setup no longer duplicates the Stop hook.** Its probe looked for `linksee-memory-sync` and
  missed `sync-session.js`, so a second copy was appended and sessions were captured twice.
  Both the guard and sync probes now recognise every shape either has been wired in — npx
  subcommand, global bin, dist path, and exec form with the path in `args`.

### Added

- `test/guard-wiring.mjs`, `test/guard-scope.mjs`. Writing to a user's global settings makes
  "merge, don't replace" load-bearing; the wiring tests found the duplicate-guard hole before
  it shipped.

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
