# linksee-memory

> Local-first agent memory MCP. A cross-agent brain for Claude Code, Cursor, and ChatGPT Desktop — with a token-saving file diff cache that nobody else does.
>
> **v0.1.0** adds `update_memory`, `list_entities`, `match_reasons` on recall, pagination, pin-via-importance, layer aliases, consolidate dry-run, `linksee-memory-stats` CLI, and a momentum-refresh fix. See [CHANGELOG](#changelog).

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

### Recommended: install the skill (auto-invocation)

Installing the MCP alone doesn't teach Claude Code *when* to call `recall` / `remember`. The bundled skill fixes that:

```bash
npx -y linksee-memory-install-skill
```

This copies a `SKILL.md` to `~/.claude/skills/linksee-memory/`. Claude Code auto-discovers it and fires the skill on phrases like "前に…", "また同じエラー", "覚えておいて", new task starts, file edits, and so on — no need to say "use linksee-memory".

Flags: `--dry-run`, `--force`, `--help`.

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
| `remember` | Store memory in 1 of 6 layers for an entity. Rejects pasted assistant output / CI logs unless `force=true`. Set `importance=1.0` to pin (survives auto-forget). |
| `recall` | FTS5 + heat × momentum × importance composite ranking with `match_reasons` explaining WHY each row matched. Supports pagination (`offset`/`has_more`), `band` filter, layer aliases (`decisions`/`warnings`/`how`/...), and `mark_accessed=false` for passive previews. |
| `recall_file` | Complete edit history of a file across all sessions, with per-edit user-intent context. |
| `update_memory` | **v0.1.0** Atomic edit of an existing memory. Preserves `memory_id` (session_file_edits links stay intact). Prefer over forget+remember. |
| `list_entities` | **v0.1.0** List what the memory knows about — cheapest "what do I know?" primitive. Filter by `kind`/`min_memories`; returns layer breakdown per entity. |
| `read_smart` | Diff-only file read. Returns full content on first read, ~50 tokens on unchanged re-reads, only changed chunks on real edits. |
| `forget` | Explicit delete OR auto-sweep based on `forgettingRisk`. Pinned (`importance>=1.0`) and caveat-layer memories are always preserved. |
| `consolidate` | Sleep-mode compression: cluster cold low-importance memories → protected learning-layer summary. Supports `dry_run` preview. |

### CLI utilities

| Command | Purpose |
|---|---|
| `npx linksee-memory` | MCP server (stdio) |
| `npx linksee-memory-sync` | Claude Code Stop-hook entry point |
| `npx linksee-memory-import` | Batch-import Claude Code session JSONL history |
| `npx linksee-memory-install-skill` | Install the Claude Code Skill that teaches the agent when to call recall/remember/read_smart |
| `npx linksee-memory-stats` | **v0.1.0** Summary of the local DB (entity count / layer breakdown / top entities / top edited files). Add `--json` for machine-readable output. |

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

## Telemetry (opt-in, off by default)

linksee-memory ships with **opt-in** anonymous telemetry that helps us understand which MCP servers and workflows actually work in the wild. **Nothing is sent unless you explicitly enable it.** No conversation content, no file content, no entity names, no project paths — ever.

### Enable

```bash
export LINKSEE_TELEMETRY=basic     # opt in
export LINKSEE_TELEMETRY=off       # opt out (or just unset the variable)
```

### Exactly what gets sent (Level 1 contract)

After each Claude Code session ends, the Stop hook sends one POST to `https://kansei-link-mcp-production.up.railway.app/api/telemetry/linksee` containing only these fields:

| Field | Example | What it is |
|---|---|---|
| `anon_id` | `d7924ced-3879-…` | Random UUID generated locally on first opt-in. Stored at `~/.linksee-memory/telemetry-id` — delete the file to reset. |
| `linksee_version` | `0.0.3` | Package version |
| `session_turn_count` | `120` | How many turns the session had |
| `session_duration_sec` | `3600` | How long the session lasted |
| `file_ops_edit/write/read` | `12, 2, 40` | Counts only |
| `mcp_servers` | `["kansei-link","freee","slack"]` | Names of MCP servers configured (from `~/.claude.json`). Names only — never command paths. |
| `file_extensions` | `{".ts":60,".md":30}` | Percent distribution of file extensions touched |
| `read_smart_*`, `recall_*` | counts | Tool usage counters |

**What is NEVER sent**:
- ❌ Conversation messages (user or assistant)
- ❌ File contents
- ❌ Entity names, project names, file paths, URLs
- ❌ Memory-layer text (goal / context / emotion / impl / caveat / learning)
- ❌ Authentication tokens, API keys, secrets
- ❌ Your IP address (only a one-way hash for abuse detection)

### Why we ask

Aggregated MCP-usage data helps the [KanseiLink](https://kansei-link.com) project rank which agent integrations actually work for real developers. If you're happy to contribute, `LINKSEE_TELEMETRY=basic` takes 1 second to set and helps the entire MCP ecosystem improve.

The full payload schema and validation logic is open-source — read `src/lib/telemetry.ts` if you want to verify exactly what leaves your machine.

## Pricing

**Free forever.**

linksee-memory is local-first and runs entirely on your machine. There is no hosted component you need to pay for. The SQLite DB lives in your home directory; backup = file copy.

No account, no credit card, no API key. Just install and use.

## Troubleshooting

<details>
<summary><b>The skill isn't firing — Claude Code doesn't call <code>recall</code> when I ask about past work.</b></summary>

1. Verify the skill was installed:
   ```bash
   ls ~/.claude/skills/linksee-memory/SKILL.md
   ```
   If absent, run `npx -y linksee-memory-install-skill`.
2. Restart Claude Code. Skills are indexed on session start.
3. Check that the MCP is registered under the name `linksee` (the skill expects `mcp__linksee__*` tool names):
   ```bash
   claude mcp list | grep linksee
   ```
   If it's registered as something else, either re-register or edit `~/.claude/skills/linksee-memory/SKILL.md` to match.
</details>

<details>
<summary><b>Stop hook isn't recording my sessions.</b></summary>

1. Check the hook log: `cat ~/.linksee-memory/hook.log`
2. Run a manual test:
   ```bash
   echo '{"session_id":"test","transcript_path":"/path/to/some.jsonl"}' | npx linksee-memory-sync
   ```
3. Make sure the `Stop` hook in `~/.claude/settings.json` points to `npx -y linksee-memory-sync` (not the old `-import`).
</details>

<details>
<summary><b>Upgrading from v0.0.5 or earlier — my recalls are mostly tagged "Card_Navi" or my project-dir name.</b></summary>

v0.0.6+ fixed the entity detection bug that collapsed all memories into the session's starting cwd. To re-index existing history with correct project attribution, run:

```bash
npx linksee-memory-import --all
```

The importer is idempotent (wipes existing session data before re-inserting). Typical runtime: a few minutes for hundreds of sessions. Expect a dramatic improvement in `recall` precision afterward.
</details>

<details>
<summary><b><code>recall</code> returns too much — the context window fills up fast.</b></summary>

Reduce `max_tokens`:
```
recall({ query: "...", max_tokens: 800 })   // default is 2000
```
Or narrow with `entity_name` and `layer`:
```
recall({ query: "...", entity_name: "my-project", layer: "caveat" })
```
</details>

<details>
<summary><b>How do I reset / delete all memory?</b></summary>

```bash
rm -rf ~/.linksee-memory   # nuke everything; next run creates a fresh DB
```

Or delete individual memories via the `forget` tool with a specific `memory_id`.
</details>

<details>
<summary><b>DB is getting large (>100 MB). How do I trim it?</b></summary>

Run consolidate — it clusters old cold memories into compressed learning-layer summaries:
```
consolidate({ scope: "all", min_age_days: 7 })
```
Caveat and active-goal layers are always preserved. Consider scheduling a weekly run via cron / Task Scheduler.
</details>

## Support

- **Issues & bug reports**: [github.com/michielinksee/linksee-memory/issues](https://github.com/michielinksee/linksee-memory/issues)
- **Feature requests**: open an issue with the `enhancement` label
- **Security concerns**: see [SECURITY.md](./SECURITY.md) if present, or file a private advisory on GitHub
- **Company**: Synapse Arrows PTE. LTD. (Singapore)

## Changelog

### v0.1.0 — Major UX update (2026-04-18)

Based on one week of dogfooding, here's what changed:

**New tools**
- `update_memory` — atomic edit with preserved `memory_id`. Solves the "forget+remember breaks session_file_edits links" bug.
- `list_entities` — fast "what do I know about?" primitive for session init. Supports `kind`/`min_memories` filters and returns layer breakdown.
- `npx linksee-memory-stats` — local DB summary CLI.

**`recall` enhancements**
- `match_reasons` array on each memory: e.g. `["content_match_fts", "heat:hot", "pinned"]`.
- `score_breakdown` with per-dimension scores (relevance / heat / momentum / importance).
- Pagination via `offset` / `has_more` / `stopped_by`.
- `limit` parameter (hard cap, complements `max_tokens` budget).
- `band` filter to request only hot/warm/cold/frozen memories.
- `mark_accessed=false` for preview queries that shouldn't bump heat.
- **Layer aliases**: `decisions` → `learning`, `warnings` → `caveat`, `how` → `implementation`, etc.
- **Fix**: opportunistic refresh of stale entity momentum scores. Entities recalled >1 h after last remember() no longer return stale momentum.

**`remember` enhancements**
- Quality check: rejects pasted assistant output / CI logs / stack traces unless `force=true`.
- `importance=1.0` now implicitly pins the memory (survives auto-forget).
- Layer aliases accepted.

**`forget` changes**
- Pinned memories (importance=1.0) now preserved alongside caveat-layer memories.
- Clear error response when attempting to delete a protected or missing memory.
- dry-run now includes `sample_ids_to_drop`.

**`consolidate` changes**
- `dry_run: true` preview mode — reports cluster count + candidates without writing.

**Infra**
- Fixed fresh-DB migration bug (was querying `meta` table before it existed).
- Bumped to Node 20+ for structured language feature usage.

All changes are **backward compatible** — existing integrations continue to work. Server.ts version banner now reports `v0.1.0`.

### Older versions
See [GitHub Releases](https://github.com/michielinksee/linksee-memory/releases).

## License

MIT — Synapse Arrows PTE. LTD.
