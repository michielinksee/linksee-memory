# How the memory is built

Moved out of the README on 2026-11-04 so its first screen fits on one screen. Back to the [README](../README.md).

## What it does

Most "agent memory" services (Mem0, Letta, Zep) save a flat list of facts. Then the agent looks at "edited file X 30 times" and has no idea why. And none of them notice when this week's work contradicts last week's decision. **linksee-memory keeps the WHY — and watches the drift.**

It is a Model Context Protocol (MCP) server with **7 tools** (six for memory and drift, plus the optional `share_draft`) that gives any AI agent structured memory + drift detection:

| | Mem0 / Letta / Zep | Claude Code auto-memory | linksee-memory |
|---|---|---|---|
| **Drift detection** | ❌ | ❌ | ✅ intent ↔ reality divergence tracking |
| Cross-agent | △ (cloud) | ❌ Claude only | ✅ single SQLite file |
| 6-layer WHY structure | ❌ flat | ❌ flat markdown | ✅ goal / context / emotion / impl / caveat / learning |
| File diff cache | ❌ | ❌ | ✅ AST-aware, re-reads return only what changed |
| Active forgetting | △ | ❌ | ✅ Ebbinghaus curve, caveat layer protected |
| Local-first / private | ❌ | ✅ | ✅ |

## Four pillars

1. **Drift detection** — declare decisions as anchors, then the engine automatically detects when committed reality diverges from stated intent. Think "Datadog for product decisions" — unaccounted divergences surface as drift, intentional evolution (recorded as supersede/fix) stays quiet.
2. **Cross-agent portability** — single SQLite file at `~/.linksee-memory/memory.db`. Same brain for Claude Code, Cursor, Windsurf, OpenAI Codex, Gemini CLI.
3. **WHY-first structured memory** — six explicit layers (`goal` / `context` / `emotion` / `implementation` / `caveat` / `learning`). Solves "flat fact memory is useless without goals".
4. **Token savings** via `read_smart` — sha256 + AST/heading/indent chunking. Re-reads return only diffs. An unchanged re-read returns about 50 tokens; `test/smoke-read-smart.mjs` requires at least 60% saved when 1 of 10 functions changes.

## 🧠 The 6-layer structure

```
┌─────────────────────────────────────────────────────────────┐
│ 🎯 goal           ← what the user is working toward         │
├─────────────────────────────────────────────────────────────┤
│ 🧭 context        ← why this, why now — constraints, people │
├─────────────────────────────────────────────────────────────┤
│ 💗 emotion        ← user tone signals (frustration, etc.)   │
├─────────────────────────────────────────────────────────────┤
│ 🛠  implementation ← how it was done (+ what failed)         │
├─────────────────────────────────────────────────────────────┤
│ ⚠️  caveat         ← "never do this again" · auto-protected │
├─────────────────────────────────────────────────────────────┤
│ 🌱 learning       ← patterns distilled from cold memories   │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
           Ranked recall via relevance × heat × momentum × importance
                  Returns match_reasons explaining each hit
```

Every memory is tagged with **exactly one layer**. `caveat`-layer entries are protected from auto-forgetting. Cold low-importance memories can be consolidated into `learning` entries, by hand (`npx -y linksee-memory consolidate --dry-run | --apply`; `--dry-run` is read-only) or by opting in at start-up (exactly `LINKSEE_AUTO_CONSOLIDATE=1`, or `--auto-consolidate`; off by default since 0.17.1).

**Consolidation keeps the originals (0.18.1).** Up to 0.18.0 it deleted them (and a forget-sweep deleted every other cold row); that is gone. Each cluster — 2 or more unprotected, cold, JSON-content memories on the same entity and layer, older than 7 days — gets one `learning`-layer summary, and each original gets `consolidated_into: <summary id>` in its content JSON and stays, with its reasons and edges. Nothing in the package deletes a memory row except `remember({ memory_id, forget: true })`: the Stop-hook re-import updates a session's rows in place by a stable key (one `BEGIN IMMEDIATE` transaction), and the start-up distill triage never archives caveats or protected rows. `recall` hides folded rows by default and reports `consolidated_hidden`; `include_consolidated: true` shows them. Plain-text memories are never folded (the mark needs JSON). Rows that an earlier version deleted are not in the database; only a backup of `~/.linksee-memory/memory.db` taken before that run has them — the `consolidations` table lists their ids under `replaced_ids`.

---


## The 6 memory layers

Each entity (person / company / project / file / concept) can have memories across six layers. Since v0.4, each memory uses the **3-axis structured format** (altitude × type × state):

```json
{
  "title": "freee OAuth token expires in 24h",
  "altitude": "implementation",
  "type": "outcome",
  "state": "done",
  "what": "freee OAuth token expires in 24 hours. Must refresh proactively.",
  "why": "freee uses short-lived tokens unlike most SaaS (usually 30-90 day expiry)",
  "affects": ["src/integrations/freee/auth.ts"],
  "next_action": null
}
```

- `caveat` memories are auto-protected from forgetting (pain lessons, never lost).
- `goal` memories bypass decay while the goal is active.
- `state` tracks lifecycle: `open` → `decided` → `in_progress` → `done` / `stalled` / `superseded`.

### Replacing a memory (`supersedes`, 0.18.0)

`remember({ content, supersedes: <id> | [<id>, …] })` saves the new memory, writes a `supersedes` row in `memory_edges` (new → old) and sets the old memory's `state` to `superseded` with `superseded_by: <new id>` (a plain-text memory keeps its text; the edge alone marks it). It is refused, and nothing is saved, if an id does not exist, is the new memory itself, belongs to another entity, or is a raw capture from a Claude Code session that has not been distilled (the next import of that session gives it a new id). It works only when creating, not with `memory_id`, and only with plain text or JSON that has all of `altitude` / `type` / `state` — a JSON object or array missing any of them is refused (its state could not be confirmed); a JSON string or number is treated as plain text, since it carries no state to lose; without `supersedes` it is re-wrapped as before. `recall` hides superseded memories by default and says how many (`superseded_hidden`); `include_superseded: true` shows them; a memory that is the target of a link carries `superseded_by` (`mem_state: "superseded"` shows the ones whose state says so; a plain-text memory marked only by the link is not among them). The newer memory carries `supersedes: "#<id>"`. If its state was guessed from the text as `superseded` (「代わりに」, "replaced" describe the old decision), it is stored as `decided`; an explicit `state: "superseded"` together with `supersedes` is refused. Older memories that earlier versions marked `superseded` (distill triage, the opt-in consolidate) are hidden the same way. Superseding a memory does not retire an anchor declared from it — the reply names the anchor, and `resolve_drift({ action: 'supersede' })` retires it. Nothing finds the old memory for you: the agent has to pass its id.

### Who wrote it (`source`, 0.18.0)

Each memory saved through MCP records the client the host named in `initialize`: `source = {"client": "<name>", "version": "<v>", "via": "mcp"}`, or `{"client": "unknown", "via": "mcp"}` when the host sent none. Memories imported by the Claude Code Stop hook add `"client": "claude-code", "via": "stop-hook"` to their session keys (`"via": "import"` for a manual import); consolidate keeps `{"origin": "consolidate"}`. `recall` adds `by: <client>` to each memory that has one. The name is what the client says about itself — it is not verified, and it says which program wrote the memory, not which model or person. Memories saved before 0.18.0 have no client and are not back-filled.

## Architecture

A single SQLite file (`better-sqlite3` + FTS5 trigram tokenizer for JP/EN) contains five layers:

- **Layer 1** — `entities` (facts: people / companies / projects / concepts / files)
- **Layer 2** — `edges` (associations, graph adjacency)
- **Layer 3** — `memories` (6-layer structured meanings per entity)
- **Layer 4** — `events` (time-series log for heat / momentum computation)
- **Layer 5** — `file_snapshots` + `session_file_edits` (diff cache + conversation↔file linkage)

The conversation↔file linkage is the key. Every file edit captured by the Stop hook is stored alongside the **user message that drove the edit**. So `recall({ path: "server.ts" })` returns "this file was edited 30 times across 3 days, and here are the actual user instructions that motivated each change".

## Why the design choices

- **Local-first** — your conversation history is private. Nothing leaves your machine.
- **Single file** — `memory.db` is one portable artifact. Backup = file copy.
- **MCP stdio** — works with every agent that speaks MCP, no plugins per host.
- **Reuses proven schemas** — `heat_score` / `momentum_score` ported from a production sales-intelligence codebase. Rule-based, no LLM dependency in the hot path.

## Comparison with Claude Code auto-memory

Claude Code ships a built-in memory feature at `~/.claude/projects/<path>/memory/*.md` — flat markdown notes for user preferences. linksee-memory **complements** it:

- auto-memory = your scrapbook of "remember I prefer X"
- linksee-memory = structured cross-agent brain with file diff cache and per-edit WHY

Use both.

