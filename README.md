# linksee-memory

> Local-first agent memory MCP. A cross-agent brain for Claude Code, Cursor, and ChatGPT Desktop — with a token-saving file diff cache that nobody else does.
>
> **v0.2.0** makes the package English-first for global launch: the bundled auto-invocation skill is now bilingual (EN + JP), session-extractor patterns cover common English keywords (`let's go`, `pivot`, `doesn't work`, `same error again`, etc.), and the install CLI shows test examples in both languages. No API changes. See [CHANGELOG](#changelog).

[![npm](https://img.shields.io/npm/v/linksee-memory.svg)](https://www.npmjs.com/package/linksee-memory)
[![license](https://img.shields.io/npm/l/linksee-memory.svg)](./LICENSE)
[![mcp-registry](https://img.shields.io/badge/MCP-Official_Registry-6366f1)](https://registry.modelcontextprotocol.io/)
[![glama-score](https://glama.ai/mcp/servers/michielinksee/linksee-memory/badges/score.svg)](https://glama.ai/mcp/servers/michielinksee/linksee-memory)

🌐 **Landing page**: [linksee-site.vercel.app](https://linksee-site.vercel.app) (includes non-developer onboarding for Claude Desktop / Cursor / Claude Code)

---

## 🎬 See it in action

**Without linksee-memory** — Monday morning, new Claude session:

```
You:    We deployed last week but it crashed. How did we fix it?
Claude: I don't have access to previous sessions. Can you describe
        what happened and walk me through the problem?

[30 minutes of log-spelunking and re-explanation]
```

**With linksee-memory** — Same question, different outcome:

```
You:    We deployed last week but it crashed. How did we fix it?
Claude: Let me check my caveats...

        🧠 [caveat] NextAuth sessions invalidate when JWT_SECRET
           rotates — redeploy all affected projects in parallel.
           (from session 2026-04-13, importance: 0.9)

        Is this the deploy you're asking about? We hit it when
        we rotated secrets mid-flow.

You:    Yes, exactly. Let's not repeat that.
```

That single `caveat` memory is what separates "flat fact storage" from "the agent actually remembers the WHY". linksee-memory stores it across **six explicit layers** so retrieval stays explainable.

---

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

Every memory is tagged with **exactly one layer**. `caveat`-layer entries are protected from auto-forgetting. Cold low-importance memories get compressed into `learning` entries via `consolidate()`.

---

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

## FAQ

<details>
<summary><strong>How is this different from Mem0 / Letta / Zep?</strong></summary>

Three axes:
1. **Local-first**: those tools require cloud accounts and send your data to their servers. linksee-memory runs entirely on your machine — one SQLite file, no network calls by default.
2. **WHY-layered**: they store flat facts or knowledge-graph nodes. linksee-memory has 6 explicit layers (`goal`/`context`/`emotion`/`implementation`/`caveat`/`learning`) so retrieval returns structured reasoning, not just data.
3. **File diff cache**: `read_smart` tool saves 86–99% of tokens on file re-reads via AST-aware chunking. None of the memory services do this — it's a feature usually shipped in IDEs.
</details>

<details>
<summary><strong>Why not just use Claude's built-in auto-memory?</strong></summary>

Claude Code's auto-memory is Claude-only (doesn't help if you switch to Cursor or ChatGPT Desktop) and stores flat markdown with no structure. linksee-memory is the same local-first principle but:
- Works across Claude Code, Cursor, ChatGPT Desktop (shared SQLite)
- Structured 6-layer format makes recall explainable
- Provides explicit forget/consolidate primitives rather than the agent guessing
</details>

<details>
<summary><strong>Is 86% token savings real? Where does it come from?</strong></summary>

Yes — see `tools/bench-read-smart.ts` in the repo. The `read_smart` tool:
1. Hashes file content on first read, returns full content + chunk metadata (AST/heading/indent boundaries).
2. On re-read with unchanged mtime+sha256, returns `~50 tokens` of "unchanged" confirmation instead of re-sending the file.
3. On real edits, returns only the changed chunks as full content + unchanged chunks as metadata-only references.

For a typical TypeScript file edit in an agentic loop, this cuts round-trip token costs by ~86%. On pure re-reads (user navigating back to a previously-read file), savings exceed 99%.
</details>

<details>
<summary><strong>Does "local-first" mean no way to sync across my machines?</strong></summary>

The default is no sync — the SQLite file lives at `~/.linksee-memory/memory.db` and stays there. If you want multi-machine sync, put that directory under Syncthing / iCloud Drive / Dropbox / Google Drive — it's a single file, so any file-sync tool works. (Avoid simultaneous edits from two machines while the MCP server is running on both; SQLite's WAL mode handles single-writer well but multi-writer conflicts can corrupt.)
</details>

<details>
<summary><strong>What happens when the DB gets huge?</strong></summary>

Two mechanisms:
1. **Ebbinghaus forgetting**: cold low-importance memories decay naturally, eligible for auto-forget sweeps. `caveat` layer and memories with `importance ≥ 0.9` are always protected.
2. **`consolidate()`**: compresses clusters of cold low-importance memories by entity into a single `learning`-layer summary, then deletes the originals. Run via `linksee-memory-consolidate` CLI (or schedule weekly).

In practice a solo developer hits ~100MB after 6 months of heavy use. A year-old DB I tested with 80K memories still recalls in <10ms.
</details>

<details>
<summary><strong>Can I use this without Claude Code?</strong></summary>

Yes — any MCP-compatible client works:
- **Claude Code**: `claude mcp add -s user linksee -- npx -y linksee-memory`
- **Claude Desktop**: add to `claude_desktop_config.json` (see [onboarding on the LP](https://linksee-site.vercel.app))
- **Cursor**: add to MCP settings in Cursor
- **ChatGPT Desktop**: same pattern once MCP support ships
- **Custom agent**: the MCP stdio protocol is documented at modelcontextprotocol.io
</details>

<details>
<summary><strong>What telemetry does it send?</strong></summary>

**By default: zero network calls, zero telemetry.** There's an optional Level-1 telemetry mode you can enable that sends anonymized aggregate metrics (tool call counts, error rates, latency percentiles — never memory content, never file paths, never queries). The exact payload schema is documented in the [Telemetry section](#telemetry-opt-in-off-by-default) and you see every byte before opting in.
</details>

<details>
<summary><strong>How do I verify it's actually working?</strong></summary>

After install, in a new Claude session ask: *"Can you remember that I prefer TypeScript over JavaScript?"* Claude should confirm it called `mcp__linksee__remember` and stored this. Then in a **different session** ask: *"What languages do I prefer?"* It should recall via `mcp__linksee__recall` and return the preference with `match_reasons` showing why.
</details>

## Support

- **Issues & bug reports**: [github.com/michielinksee/linksee-memory/issues](https://github.com/michielinksee/linksee-memory/issues)
- **Feature requests**: open an issue with the `enhancement` label
- **Security concerns**: see [SECURITY.md](./SECURITY.md) if present, or file a private advisory on GitHub
- **Company**: Synapse Arrows PTE. LTD. (Singapore)

## Changelog

### v0.2.0 — English-first launch readiness (2026-04-20)

Prepares the package for a broader (primarily English-speaking) audience on Reddit, Hacker News, and Anthropic Discord. No breaking API changes.

- **Bilingualized `SKILL.md`** (auto-invocation skill). The bundled skill that `linksee-memory-install-skill` copies into `~/.claude/skills/linksee-memory/SKILL.md` was Japanese-first; it is now English-primary with Japanese trigger phrases preserved inline. English speakers now get the skill firing on natural English phrases ("how did we solve this before?", "same error again", "remember this") in addition to the existing JP triggers.
- **Install-skill CLI output is bilingual**: example test phrases shown after installation include both English and Japanese.
- **Session-extractor EN coverage** (`linksee-memory-import`): expanded regex patterns for decisions, failures, and caveats so English Claude Code session logs get auto-tagged correctly. Additions include `let's go`, `pivot`, `switch to`, `settled on`, `approved`, `doesn't work`, `stuck`, `same error again`, `hit an error`, `debug`, `broke`, `revert`.
- **Clearer caveat-forget error hint**: the previous message said "lower importance below 0.9 first, then forget" which was misleading — caveat-layer memories are permanently protected regardless of importance. The hint now correctly distinguishes layer-protection from pin-protection.
- **README rework** for launch readiness: added a "See it in action" before/after scenario, ASCII 6-layer diagram, MCP Official Registry + Glama score badges, landing-page link, and an 8-item FAQ covering questions that surface during public launches.
- Internal: SKILL.md now documents pairing with KanseiLink skill as an English workflow example.

No code changes to the MCP protocol surface; all existing MCP clients continue to work unchanged.

### v0.1.1 — Pin threshold tweak (2026-04-19)

Based on real-world feedback that `importance=0.95` memories were not
being treated as pinned despite intent.

- **Pin threshold lowered from `>= 1.0` to `>= 0.9`.** Memories with
  `importance >= 0.9` are now exempt from the auto-forget sweep and
  surface `pinned: true` in `recall` and `remember` responses. This
  matches the natural mental model ("0.9 = high importance = should
  survive cleanup") without requiring exact `1.0`.
- All existing memories with `importance >= 0.9` (including older ones
  set to `0.9` or `0.95`) become pinned automatically — no migration
  needed.
- Updated tool descriptions and error messages to reflect the new
  threshold.

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
