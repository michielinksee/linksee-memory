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
| File diff cache | ❌ | ❌ | ✅ AST-aware, 50-99% token savings on re-reads |
| Active forgetting | △ | ❌ | ✅ Ebbinghaus curve, caveat layer protected |
| Local-first / private | ❌ | ✅ | ✅ |

## Four pillars

1. **Drift detection** — declare decisions as anchors, then the engine automatically detects when committed reality diverges from stated intent. Think "Datadog for product decisions" — unaccounted divergences surface as drift, intentional evolution (recorded as supersede/fix) stays quiet.
2. **Cross-agent portability** — single SQLite file at `~/.linksee-memory/memory.db`. Same brain for Claude Code, Cursor, Windsurf, OpenAI Codex, Gemini CLI.
3. **WHY-first structured memory** — six explicit layers (`goal` / `context` / `emotion` / `implementation` / `caveat` / `learning`). Solves "flat fact memory is useless without goals".
4. **Token savings** via `read_smart` — sha256 + AST/heading/indent chunking. Re-reads return only diffs. **Measured 86% saved on a typical TS file edit, 99% saved on unchanged re-reads.**

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

Every memory is tagged with **exactly one layer**. `caveat`-layer entries are protected from auto-forgetting. Cold low-importance memories can be consolidated into `learning` entries, but only if you opt in (`LINKSEE_AUTO_CONSOLIDATE=1` on the server — it deletes the originals; off by default since 0.17.1).

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

