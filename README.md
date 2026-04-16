# linksee-memory

> Local-first agent memory MCP. A cross-agent brain for Claude Code, Cursor, and ChatGPT Desktop — with a token-saving file diff cache that nobody else does.

[![npm](https://img.shields.io/npm/v/linksee-memory.svg)](https://www.npmjs.com/package/linksee-memory)
[![license](https://img.shields.io/npm/l/linksee-memory.svg)](./LICENSE)

## What it does

Most "agent memory" services (Mem0, Letta, Zep) save a flat list of facts. Then the agent looks at "edited file X 30 times" and has no idea why. **linksee-memory keeps the WHY.**

It is a Model Context Protocol (MCP) server that gives any AI agent four superpowers:

| | Mem0 / Letta / Zep | Claude Code auto-memory | linksee-memory |
|---|---|---|---|
| Cross-agent | △ (cloud) | ❌ Claude only | ✅ single SQLite file |
| 6-layer WHY structure | ❌ flat | ❌ flat markdown | ✅ goal / context / emotion / impl / caveat / learning |
| File diff cache | ❌ | ❌ | ✅ AST-aware, 50-99% token savings on re-reads |
| Active forgetting | △ | ❌ | ✅ Ebbinghaus curve, caveat layer protected |
| Local-first / private | ❌ | ✅ | ✅ |

## Three pillars

1. **Token savings** via `read_smart` — sha256 + AST/heading/indent chunking. Re-reads return only diffs. **Measured 86% saved on a typical TS file edit, 99% saved on unchanged re-reads.**
2. **Cross-agent portability** — single SQLite file at `~/.linksee-memory/memory.db`. Same brain for Claude Code, Cursor, ChatGPT Desktop.
3. **WHY-first structured memory** — six explicit layers (`goal` / `context` / `emotion` / `implementation` / `caveat` / `learning`). Solves "flat fact memory is useless without goals".

## Install

```bash
npm install -g linksee-memory
linksee-memory-import --help   # bundled importer for Claude Code session history
```

Or use `npx` ad hoc:

```bash
npx linksee-memory             # starts the MCP server on stdio
```

The default database lives at `~/.linksee-memory/memory.db`. Override with the `LINKSEE_MEMORY_DIR` environment variable.

## Register with Claude Code

```bash
claude mcp add -s user linksee -- npx -y linksee-memory
```

Restart Claude Code. Tools appear as `mcp__linksee__remember`, `mcp__linksee__recall`, `mcp__linksee__recall_file`, `mcp__linksee__read_smart`, `mcp__linksee__forget`, `mcp__linksee__consolidate`.

### Optional: auto-capture every session (Stop hook)

Add to `~/.claude/settings.json` to record every Claude Code session to your local brain automatically:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "npx -y linksee-memory-sync" }
        ]
      }
    ]
  }
}
```

Each turn end takes ~100 ms. Failures are silent (Claude Code never blocks). Logs at `~/.linksee-memory/hook.log`.

## Tools

| Tool | Purpose |
|---|---|
| `remember` | Store memory in 1 of 6 layers for an entity |
| `recall` | FTS5 + heat-score + momentum composite ranking, JP/EN trigram search |
| `recall_file` | Get the COMPLETE edit history of a file across all sessions, with per-edit user-intent context |
| `read_smart` | Diff-only file read. Returns full content on first read, ~50 tokens on unchanged re-reads, only changed chunks on real edits |
| `forget` | Explicit delete OR auto-sweep based on forgettingRisk (importance × heat × age) |
| `consolidate` | Sleep-mode compression: cluster cold low-importance memories → protected learning-layer summary |

## The 6 memory layers

Each entity (person / company / project / file / concept) can have memories across six layers. The layer encodes meaning, not category:

```json
{
  "goal":    { "primary": "...", "sub_tasks": [], "deadline": "..." },
  "context": { "why_now": "...", "triggering_event": "...", "when": "..." },
  "emotion": { "temperature": "hot|warm|cold", "user_tone": "..." },
  "implementation": {
    "success": [{ "what": "...", "evidence": "..." }],
    "failure": [{ "what": "...", "why_failed": "..." }]
  },
  "caveat":  [{ "rule": "...", "reason": "...", "from_incident": "..." }],
  "learning":[{ "at": "...", "learned": "...", "prior_belief": "..." }]
}
```

- `caveat` memories are auto-protected from forgetting (pain lessons, never lost).
- `goal` memories bypass decay while the goal is active.

## Architecture

A single SQLite file (`better-sqlite3` + FTS5 trigram tokenizer for JP/EN) contains five layers:

- **Layer 1** — `entities` (facts: people / companies / projects / concepts / files)
- **Layer 2** — `edges` (associations, graph adjacency)
- **Layer 3** — `memories` (6-layer structured meanings per entity)
- **Layer 4** — `events` (time-series log for heat / momentum computation)
- **Layer 5** — `file_snapshots` + `session_file_edits` (diff cache + conversation↔file linkage)

The conversation↔file linkage is the key. Every file edit captured by the Stop hook is stored alongside the **user message that drove the edit**. So `recall_file("server.ts")` returns "this file was edited 30 times across 3 days, and here are the actual user instructions that motivated each change".

## Why the design choices

- **Local-first** — your conversation history is private. Nothing leaves your machine.
- **Single file** — `memory.db` is one portable artifact. Backup = file copy.
- **MCP stdio** — works with every agent that speaks MCP, no plugins per host.
- **Reuses proven schemas** — `heat_score` / `momentum_score` ported from a production sales-intelligence codebase. Rule-based, no LLM dependency in the hot path.

## Roadmap

- ✅ Core 6 MCP tools (`remember` / `recall` / `recall_file` / `forget` / `consolidate` / `read_smart`)
- ✅ Stop-hook auto-capture for Claude Code
- ✅ JP/EN trigram FTS5
- 🚧 `PreToolUse` hook to auto-intercept `Read` (zero-config token savings)
- 🚧 Cursor + ChatGPT Desktop adapters
- 🔮 Vector search via `sqlite-vec` once an embedding backend is chosen (Ollama / API / etc.)
- 🔮 Optional anonymized telemetry → MCP-quality intelligence layer

## Comparison with Claude Code auto-memory

Claude Code ships a built-in memory feature at `~/.claude/projects/<path>/memory/*.md` — flat markdown notes for user preferences. linksee-memory **complements** it:

- auto-memory = your scrapbook of "remember I prefer X"
- linksee-memory = structured cross-agent brain with file diff cache and per-edit WHY

Use both.

## License

MIT — Synapse Arrows PTE. LTD.
