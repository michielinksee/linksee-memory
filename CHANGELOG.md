# Changelog

## v0.17.1 — unreleased (Fixes only)

Fixes for what a new user runs into on the first day. No new features, no new tools (still 7).

### Fixed

- **setup no longer overwrites a `settings.json` it cannot read.** The Stop-hook step treated a
  parse failure (including a UTF-8 BOM, Notepad's default) as `{}` and wrote it back, wiping the
  user's other hooks and settings. Both settings steps now strip the BOM, refuse to write when the
  file does not parse, keep one `settings.json.bak-<timestamp>` before changing it, write via a
  temp file + rename, and write nothing when nothing changed.
- **Hooks call `node` directly instead of `npx -y`.** Each `npx -y linksee-memory guard|sync` call
  took 7.4–8.6 s on a warm cache (npm start-up + registry check; measured on Windows), against an
  8 s `PreToolUse` timeout — so the guard could time out and silently not fire. setup now writes
  `"<node>" "<package>/dist/bin/<bin>.js" --linksee-managed` (0.20–0.27 s on the same machine).
  Run through `npx`, setup installs this version once with `npm install --prefix
  ~/.linksee-memory/runtime/<version> --no-save --omit=dev` (npx's cache is temporary), shows its
  size, and keeps one version: an older runtime is removed only as setup's last step, after every
  settings write succeeded, and never while any settings file (user, project, or one setup wrote
  before) still points at it; if those references cannot be verified (unreadable list or settings
  file), nothing is removed and setup says why. A same-version reinstall swaps through `<dest>.old-<pid>` so it can
  be undone. On failure the existing runtime stays and the hooks keep the npx form. Re-running setup rewrites only hooks it
  wrote: the exact `npx -y linksee-memory sync|guard` strings and the `--linksee-managed` form.
  Wrappers and hand edits are left alone and listed; `--no-guard` leaves the guard hooks untouched.
  Paths with `$`, backticks, `%` or `"` keep the npx form. If the SQLite native addon cannot load
  (e.g. after a Node major upgrade — it fails when the DB is opened), the guard and Stop hooks print
  one line, "linksee-memory: native module failed to load (Node changed?). Re-run: npx -y
  linksee-memory setup", and let the action through; other failures stay silent (hook.log).
  Rewriting `settings.json` keeps its permission bits, writes through a symlink, and refuses a
  symlink whose target is missing.
- **The server no longer consolidates memories on its own.** Start-up consolidation deleted the
  original rows (keeping a 3 × 200-character summary) without the user asking. It is now off
  unless `LINKSEE_AUTO_CONSOLIDATE=1` (or `--auto-consolidate`). There is no `consolidate` tool
  (merged away in 0.7.0); the old hint that it "auto-runs on server startup" is corrected, and so
  are the README FAQ and the bundled agent skill (which told agents to run a `consolidate` tool
  weekly). Rows removed by earlier versions are not restored.
- **Old databases.** Every DB older than schema 8 stopped with `no such table: drift_anchors`
  (0.8.0 – 0.17.0), after partly altering the file. Schema 6–8 now migrate. Schema 1–5 is refused
  before anything is written — the schema is read on a read-only connection before any writable
  one exists, so a leftover WAL is not checkpointed and memory.db / -wal / -journal stay
  byte-identical (a file with a hot rollback journal is refused the same way; if the read-only
  check cannot run at all — e.g. another process holds a lock — it refuses too and says to close
  other clients, rather than guessing) — with one message: back up the folder, and do not open it with another
  linksee-memory version meanwhile. No older version is suggested as a stepping stone (0.7.2,
  for one, has no subcommands: any `npx linksee-memory@0.7.2 …` starts its server, whose start-up
  consolidate can delete rows). A migration command for these files is planned for 0.17.2.

### Docs

- README: the "~100 ms per turn" claim is replaced by measured numbers for both hook forms; the
  Quick Start says what setup writes, how to undo it (`.bak`), that the memory is shared over MCP by
  five clients while auto-capture and the guard are Claude Code only, the one-line Codex
  registration, and a first try that works on an empty memory. The guard's scope (every repo by
  default) is stated consistently. The README's Changelog section now points here; its v0.4–v0.11
  entries were moved into this file.
- setup's closing message says the same, and on an empty memory suggests "remember X" → new
  session → "what did we decide about X?" instead of a recall that cannot find anything yet.

## v0.17.0 — 2026-10-30 (Share a fix as a link)

### Added — `share_draft`: share a fix as a link, never a send

- New MCP tool `share_draft` (and `npx -y linksee-memory share-draft`). For use only when the
  user wants to share how a SaaS / MCP / API connection got stuck and what fixed it. Takes fixed
  fields only (`service`, `task`, `symptom`, `tried`, `result`, `conditions`, `kind`, `runtime`),
  checks them, and returns a link to KanseiLINK's reviewed draft page. Linksee makes no network
  call; the user opens the link and sends from that page.
- A field that looks like a key / token / JWT / Bearer value, an e-mail, a tenant URL, an IP, a
  local path or a long hex / base64 run stops the build and names the field. Patterns ported from
  KanseiLINK `secret-mask.ts` (2026-10-30). URL capped at 2,000 characters — it asks to shorten,
  it does not cut. `kind` is required, so the draft never claims "executed" by default.
- Records only that a draft was made (`events.kind = 'share_draft_created'`, no payload). No
  telemetry added. The six memory/drift tools are unchanged; `tools/list` now shows 7.

### Security

- `@modelcontextprotocol/sdk` raised from `^1.0.0` (locked at 1.29.0) to `^1.32.2`, and the lockfile re-resolved within the existing ranges. `pnpm audit --audit-level moderate` goes from 46 findings (hono, qs, express, zod and others, mostly through the SDK) to 0. This change alone does not touch the tool surface (same handshake).

### Fixed

- `test/live-check.mjs` no longer writes to the real `~/.linksee-memory`. It now runs the server against a throwaway DB in a temp folder (`LINKSEE_MEMORY_DIR`) and removes it afterwards; CI runs it the same way.

## v0.16.1 — 2026-09-07

### Fixed

- **The 0.16.0 triage never ran.** It was tucked inside the auto-consolidate block, which
  runs at most once a week and only after a 3-second timer — so on the machine it was built
  for, the queue was still 389 with no verdicts. Triage now runs on every start, before the
  first request. One indexed scan; it cannot block startup.
- `recall({ dream: true })` reported the page size as `distill_total` on the main path (the
  0.16.0 change had landed on the no-North-Star branch only). `distill_total` is now the real
  remainder everywhere, `distill_shown` is the page, and `distill: N` is actually passed through.
- `test/tool-surface.mjs` now seeds a raw backlog before the server starts and asserts the
  sweep ran, the page is capped, and the total is real — the test that would have caught this.

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


<!-- v0.4–v0.11: moved here from the README's old Changelog section in 0.17.1 -->

## v0.11.3 — Robustness + MCP hygiene (2026-06-16)

- **Corrupt-database recovery:** if `~/.linksee-memory/memory.db` is unreadable, linksee preserves it as `memory.db.corrupt-<timestamp>` and starts a fresh one (with a clear message) instead of crashing with a raw SQLite error. Old memories stay recoverable in the backup.
- **`recall` tool description** no longer suggests editing your system prompt — cleaner MCP citizenship.

## v0.11.2 — More cold-start hardening (2026-06-16)

- **`stats` works on a fresh database** instead of crashing with `no such table` — it ensures the schema exists first (it may be the first command a new user runs).
- **`map --help`** prints usage instead of trying to import a map.

## v0.11.1 — Cold-start fixes (2026-06-16)

- **Run any CLI through the package name:** `npx -y linksee-memory setup` (and `map`, `sync`, `guard`, `stats`, `import`, `install-skill`). A fresh user couldn't reach the standalone bins (`linksee-memory-setup`, …) via `npx` — npx resolves package names, not sibling bin names — so the one-command install 404'd. The main bin now dispatches subcommands; the standalone bins remain as aliases.
- **`map` exits gracefully** with a next-step message when there's no `map.yaml` yet (was a raw stack trace — the exact state of a first-time user).
- **serverInfo** now reports the real package version (was pinned to an old string).

## v0.11.0 — The Map: `where_am_i` + `linksee-memory map` (2026-06-15)

**Memory is the entry point; the product map is the new surface.** Drift detection grows up from individual anchors into a whole-product map you navigate from the CLI.

- **`where_am_i`** (11th MCP tool) — locate the current topic/file on the Current Truth Map and get its blast radius. Call it with no args to auto-locate from your recent edits.
- **`linksee-memory map`** CLI — `where` · `affects` · `explain` · `status` · `next` · `reconcile` · `inspect --json` · `blueprint`. A `map.yaml` (git source of truth) describes how value reaches your user; the reconciler checks it against your code with file:line evidence. Bilingual: add `--lang ja`.
- Graded blast radius (`must fix together` / `should align` / `fyi`), declared-vs-reality verdicts, and an anti-graveyard guard for accounted-for drift.
- Per-project keys so the Map handles many projects at once.

## v0.8.0 — Drift Detection MCP Tools (2026-06-08)

**3 tools → 7 tools.** The biggest update since launch — agents can now detect, query, and resolve intent ↔ reality drift.

**New tools:**
- **`drift_status`** — returns the truth map with 4-species classification and per-node drift state
- **`check_decision`** — deep-dive into a single anchor: state, edges, pending candidates
- **`declare_anchor`** — record a decision/constraint/prohibition as a truth-map node (with v9 ProjectCoreNode fields)
- **`resolve_drift`** — close the feedback loop: fix / supersede / acknowledge / dismiss

**New engine module:**
- **`truth-engine.ts`** — state derivation logic migrated from the dashboard into the MCP engine. Any MCP client can now query drift status without a dashboard.
- **Resolution priority fix**: when multiple resolutions reference the same anchor, the most recent one wins (by `resolved_at` timestamp). Prevents a stale acknowledge from shadowing a newer fix.
- **4-species classification**: nodes classified by `decision_mode` into hypothesis / constraint / commitment / source_of_truth with display format guidance.

No breaking changes to existing memory tools. All 3 memory tools (remember, recall, read_smart) are unchanged.

## v0.7.2 — Recall ergonomics + auto-edge detection + classifier precision (2026-05-30)

Quality pass on v0.7.0 / v0.7.1 — sharper day-to-day agent UX and cleaner data for the dashboard:

- **`recall` token discipline**: drops the redundant `content_raw` from the response (parsed `content` was already there — it was a 2× duplicate), and actually enforces `max_tokens` by greedy assembly that measures real serialized size (was a flat ~100 tok/memory estimate). Adds `approx_tokens` to the response so the agent can see its budget usage. The same query that previously returned ~15,800 tokens for a 1200 budget now stays inside it.
- **`recall` precision**: near-duplicate memories — same entity + near-identical core text, e.g. the same message captured under both `goal` and `learning` — collapse to one in the result set. Composite weights adapt to query specificity: multi-term queries weight relevance higher so off-topic-but-pinned memories don't crowd narrow recalls.
- **Capture dedup (write side)**: `session-extractor` now produces AT MOST one memory per user turn, with priority `goal[first_intent] > caveat > decision > context`. A first-intent message containing decision words (e.g. "決めた" / "これで進めよう") is no longer double-saved as both `goal` and `learning`.
- **`memory_edges` auto-detection**: the previously-empty `memory_edges` table is now populated during the sleep-mode consolidation sweep. `detectMemoryEdges()` links a later DECISION memory to the most-recent earlier same-topic decision within an entity (chain, not clique) so the dashboard can render Pivot Chains. The default relation is `extends` — a same-topic later decision builds on, but does NOT deactivate, the earlier one. Explicit reversal markers (やめる / revert / instead of) produce `contradicts`; explicit replacement markers (の代わり / replaces / deprecate) produce `supersedes`. Prevents silent deactivation of still-valid decisions.
- **`inferType` / `inferState` precision**: chitchat acknowledgements ("そうだね" / "ありがとう"), pasted terminal/git/email content, and meta-noise no longer classify as `decision` — they return `note` / `open` before pattern matching. The learning-layer default → `decision` is gated by this guard. Real decisions (採用 / 決めた, even after an acknowledgement opener) survive.

No schema migration, no breaking API changes. Existing rows keep their stored content; the classifier improvements apply to new captures going forward.

## v0.7.1 — Review fixes (2026-05-29)

Based on Opus 4.7 design review of v0.7.0:

- **P0 — Required params guidance**: `remember` tool description now includes "REQUIRED PARAMS BY MODE" section so LLMs know exactly which fields are needed for create vs update vs delete.
- **P0 — Migration guidance**: Deprecated tool names (`forget`, `recall_file`, etc.) now return specific migration examples instead of generic errors.
- **P1 — recall path+query merge**: When both `path` and `query` are provided to `recall`, results from file history and memory search are merged into a single response.
- **P2 — Auto-consolidate safety**: Table existence check via `sqlite_master` before querying `consolidations` table, preventing errors on fresh databases.

## v0.7.0 — 3-Tool Unified Surface (2026-05-29)

**8 tools → 3 tools.** Following Context7's proven pattern of fewer tools = better cross-LLM consistency.

**Breaking change**: The following tools are removed from the MCP surface. Calling them returns a migration guide:

| Old tool | New equivalent |
|---|---|
| `forget` | `remember({ forget: true, memory_id: <id> })` |
| `update_memory` | `remember({ memory_id: <id>, content: "..." })` |
| `recall_file` | `recall({ path: "server.ts" })` |
| `list_entities` | `recall({})` (no params = entity overview) |
| `consolidate` | Auto-runs on server startup (7-day threshold) |

**New unified tools:**
- **`remember`** — create + update + delete in one tool. Mode is inferred from params.
- **`recall`** — search + file history + overview in one tool. Mode is inferred from params.
- **`read_smart`** — unchanged.

**Other changes:**
- Auto-consolidate on server startup (non-blocking `setTimeout`, 7-day threshold, `sqlite_master` safety check)
- Claude Code Plugin bundle (`claude plugin add -- linksee-memory`)
- Deprecation errors include specific migration examples

All internal handler functions are preserved — this is a surface change, not a logic rewrite.

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
