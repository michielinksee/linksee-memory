# Changelog

## v0.16.0 — 2026-09-07 (A queue you can actually drain)

The Stop hook captures raw utterances for the agent to rewrite later (anchor #70). On the
author's machine that queue had reached 389 and nobody drained it — because most of it was
never a decision. "OK. Aからいこう", a pasted file path, "はい。そうしましょう". Asking an agent
to distill those is asking it to find meaning that is not there, and the honest response to a
nag like that is to ignore it, which is how the queue reached 389.

### Added — rule-based triage, before anyone is asked to think

- On startup (with the consolidation sweep) every raw memory outside the 30-minute settle window
  is classified. Two verdicts need no intelligence: **auto-noise** (under 40 chars, a bare
  acknowledgement or imperative, a path/URL/attachment reference) and **auto-stale** (never
  recalled and older than 90 days). Both are archived — `type: note`, `state: superseded`,
  `distill_verdict` says why — never deleted, layer and protection untouched, and
  `needs_distill` stays true because it is still true: no agent rewrote it. Reversible by
  removing the verdict. Measured on the real backlog before shipping: 389 → 88 noise, 51 stale,
  **250 left for judgement**; the noise sample was read by a human first.
- The queue is **value-ordered**: caveats first, then memories on a named entity, then longer
  text, then recency. `recall({ dream: true, distill: N })` returns up to 25 for a deliberate
  drain. `distill_total` is the real remaining count, not the page size.
- The session-start digest asks for three, not for everything, and says what the rules already
  handled.

## v0.15.2 — 2026-09-07 (Say what it's for)

No code. The product changed a great deal between 0.12 and 0.15; the sentence describing it
had not. This release puts the positioning decided on 2026-09-05 — **hand a project over, with
the reasons attached**; drift detection as the second pillar, not the headline — into every
place an agent or a person reads first: the npm description and keywords, the MCP registry
manifest, and the README hero.

It also adds a **"Questions this answers"** section to the README: the twelve questions people
actually type, verbatim, each with its answer. In the AI-recommendation measurement that
started all this (2 of 36 unprompted answers named us), the only two hits were the queries
whose phrasing matched this README. Wording is the mechanism.

## v0.15.1 — 2026-09-07

### Added

- `resolve_drift({ action: 'dismiss', gate: false })` — close the drift edges as false positives
  but **keep the gate watching**. Two verdicts had been hiding behind "dismiss": *this detection
  was wrong* and *stop detecting this*. Anchor #2 ("no destructive migrations") had a lexical
  false positive from `migrate.ts`; dismissing it the old way would have silenced the one string
  the anchor exists to catch — `ALTER TABLE memories DROP`. Now the edge closes and the gate
  keeps its eyes.

## v0.15.0 — 2026-09-07 (Six tools)

Roadmap 5, and the end of the trust arc that started at 0.12.0: the surface an agent has to
hold is now six tools, one per thing it needs to do, and nothing it used to call is broken.

### Changed — six tools on the surface

`recall` · `remember` · `read_smart` · `drift_status` · `declare_anchor` · `resolve_drift`.

Anchor #1 ("3 tools, never a 4th") had a real reason — eight tools bled model-dependent
behaviour across Claude / GPT / Cursor / Codex / Gemini — and the surface had crept to eleven.
Five are folded into the six:

| Was | Now |
|---|---|
| `where_am_i` | `recall({ where: "<topic>" })` — or `recall()` for the session brief |
| `check_decision` | `drift_status({ anchor_id })` |
| `flag_proposals` | `declare_anchor({ kind: 'proposal', … })` — returns `candidate_id` |
| `dream` | `recall({ dream: true })` — the brief already carries the counts |
| `resolve_proposal` | `resolve_drift({ candidate_id, action: 'surface' \| 'dismiss', rationale })` |

The five old names are hidden from `tools/list` but **still answer when called**, so a skill or
agent written against 0.14 keeps working. `LINKSEE_LEGACY_TOOLS=1` lists them, each labelled
with its replacement.

### Added — the session brief

`recall()` with no arguments now returns what an agent needs in the first call of a session:
the triage line and 🔴/🟡 items in full, where you are on the Map, open loops as counts
(proposals, distill queue, friction), the top entities, and the exact next calls. On
2026-09-05 this took four calls, ~20k tokens, and one of them failed. `recall({ overview: true })`
is the old entity list.

### Added

- `test/tool-surface.mjs` — the surface is exactly six, the hidden five still answer, and every
  absorbed path round-trips against the real server.

## v0.14.0 — 2026-09-07 (Remember and enforce; verified and unverified)

Two roadmap items about the same thing: the product should not make the agent do the product's
job. Picking a taxonomy before you can say "remember this", and choosing between two tools to
record one decision, were both that. So was painting "nobody checked" the same colour as
"checked and fine".

### Changed — `remember`

- **`content` is the only required field.** `entity_name` / `entity_kind` default to the project
  you are in (workspace roots, else the files edited recently); `layer` defaults to `context`.
  The taxonomy is for the dashboard, not for the agent.
- **`anchor: {}` records and enforces in one call.** The memory is stored as before, and a
  drift anchor is declared from it — re-injected on session start and before Edit/Write/Bash.
  Give `anchor.violation_signal` (forbidden strings) for contradictions to be detectable, and
  `anchor.affects` (path globs) to scope it. Without signals the anchor is a constraint, and the
  response says so rather than pretending it can catch anything. Memory and anchor link both
  ways (`content.anchor_id`, `source_memory_id`). An invalid anchor spec never loses the memory.

  Before, "remember" and "declare_anchor" were two tools with two schemas and the agent had to
  choose. Choosing remember stored the decision and never re-injected it — the exact failure
  this product exists to prevent.

### Changed — a fifth state: ⚫ unverified

- An active anchor with no evidence either way — no drift edges, no resolution — is now
  **`unverified`**, not `aligned`. On the author's machine that is 35 of 45 anchors; 3 are
  actually verified. They were all the same colour. Different colour, different meaning: the
  detector has no eyes here. Give the anchor `affects` / `violation_signal` so it can look, or
  leave it as a note — but do not read it as "fine".
- `aligned` now requires evidence: a recorded resolution, or an `implements` edge (the detector
  saw reality match). `reality` names where it was observed.
- `drift_status` triage reads `🔵 N verified · ⚫ N unverified`; the compact form lists
  unverified anchors one line each, grouped by domain.
- `check_decision` had its own copy of the state machine and had drifted from `drift_status`
  — it never looked at drift edges, so it could say "aligned" on the anchor the other tool
  flagged 🔴. It now mirrors the view exactly, including dismiss and unverified.

### Fixed

- **Workspace roots were never read.** `fetchRoots` validated the client's reply against the
  *request* schema instead of the *result* schema, so every reply failed, was swallowed, and was
  cached as "no roots" for a minute — since the day it was written. `where_am_i`'s root-based
  project inference (June's "Fix ①") had never once fired; that is why a no-arg call returned
  `ambiguous_project`. Found because the new remember test drives a real roots round-trip.

### Added

- `test/remember-anchor.mjs` — drives the real MCP server over stdio, including the roots
  round-trip that infers the entity. `test/edges-state.mjs` now covers implements → aligned,
  no evidence → unverified, and check_decision agreeing with drift_status.

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
