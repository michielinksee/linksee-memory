# Troubleshooting and FAQ

Moved out of the README on 2026-11-04 so its first screen fits on one screen. Back to the [README](../README.md).

## Troubleshooting

<details>
<summary><b>The skill isn't firing — Claude Code doesn't call <code>recall</code> when I ask about past work.</b></summary>

1. Verify the skill was installed:
   ```bash
   ls ~/.claude/skills/linksee-memory/SKILL.md
   ```
   If absent, run `npx -y linksee-memory install-skill`.
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
   echo '{"session_id":"test","transcript_path":"/path/to/some.jsonl"}' | npx -y linksee-memory sync
   ```
3. Make sure the `Stop` hook in `~/.claude/settings.json` points to `npx -y linksee-memory sync` (not the old `-import`).
</details>

<details>
<summary><b>Upgrading from v0.0.5 or earlier — my recalls are mostly tagged "Card_Navi" or my project-dir name.</b></summary>

v0.0.6+ fixed the entity detection bug that collapsed all memories into the session's starting cwd. To re-index existing history with correct project attribution, run:

```bash
npx -y linksee-memory import --all
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

Or delete individual memories via `remember({ forget: true, memory_id: <id> })`.
</details>

<details>
<summary><b>DB is getting large (>100 MB). How do I trim it?</b></summary>

Since 0.17.1 nothing is consolidated automatically: consolidation deletes the original rows (keeping a short summary), so it runs only if you start the server with `LINKSEE_AUTO_CONSOLIDATE=1` (then at most weekly, 7-day threshold). When enabled it clusters old cold memories into compressed learning-layer summaries and deletes the originals; caveat and active-goal layers are always preserved. Back up `~/.linksee-memory/` before turning it on. There is no `consolidate` tool to call.
</details>

## FAQ

<details>
<summary><strong>What is drift detection and why do I need it?</strong></summary>

Drift = when your code reality silently diverges from what you decided. Example: Last week you decided "FTS5, not vector search" but this week a new agent session installs pgvector without knowing the history.

Linksee Memory tracks this by letting you declare decisions as "anchors" and then automatically checking committed code against them. The make-or-break rule: **intentional evolution (recorded as fix/supersede) stays quiet, while unaccounted gaps get flagged.** It's like Datadog but for product decisions instead of server metrics.

You don't need to use drift detection to benefit from linksee-memory — the 3 memory tools (remember/recall/read_smart) work independently. Drift tools are an additional layer for teams and solo devs managing multiple projects.
</details>

<details>
<summary><strong>How is this different from Mem0 / Letta / Zep?</strong></summary>

Three axes:
1. **Local-first**: those tools require cloud accounts and send your data to their servers. linksee-memory runs entirely on your machine — one SQLite file, no network calls by default.
2. **WHY-layered**: they store flat facts or knowledge-graph nodes. linksee-memory has 6 explicit layers (`goal`/`context`/`emotion`/`implementation`/`caveat`/`learning`) so retrieval returns structured reasoning, not just data.
3. **File diff cache**: `read_smart` tool saves 86–99% of tokens on file re-reads via AST-aware chunking. None of the memory services do this — it's a feature usually shipped in IDEs.
</details>

<details>
<summary><strong>Why not just use Claude's built-in auto-memory?</strong></summary>

Claude Code's auto-memory is Claude-only (doesn't help if you switch to Cursor, OpenAI Codex, or Gemini CLI) and stores flat markdown with no structure. linksee-memory is the same local-first principle but:
- Works across Claude Code, Cursor, OpenAI Codex, Gemini CLI (shared SQLite)
- Structured 6-layer format makes recall explainable
- Consolidation of cold memories is opt-in (`LINKSEE_AUTO_CONSOLIDATE=1`, deletes originals); caveats are permanently protected
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
2. **Consolidation (opt-in)**: off by default since 0.17.1. With `LINKSEE_AUTO_CONSOLIDATE=1` on the server it runs at start-up at most weekly (7-day threshold), compressing clusters of cold low-importance memories by entity into a single `learning`-layer summary and deleting the originals.

In practice a solo developer hits ~100MB after 6 months of heavy use. A year-old DB I tested with 80K memories still recalls in <10ms.
</details>

<details>
<summary><strong>Can I use this without Claude Code?</strong></summary>

Yes — any MCP-compatible client works:
- **Claude Code**: `claude mcp add -s user linksee -- npx -y linksee-memory`
- **Claude Desktop**: add to `claude_desktop_config.json` (see [onboarding on the LP](https://linksee.app))
- **Cursor**: add to MCP settings in Cursor → Settings → Features → Model Context Protocol
- **OpenAI Codex**: `codex mcp add linksee -- npx -y linksee-memory` (or `~/.codex/config.toml` with `[mcp_servers.linksee]` block)
- **Gemini CLI**: add to `~/.gemini/settings.json` mcpServers section
- **ChatGPT (web/mobile app)**: stdio MCP not supported by the consumer app — requires Remote MCP server over HTTPS (not yet available).
- **Custom agent**: the MCP stdio protocol is documented at modelcontextprotocol.io
</details>

<details>
<summary><strong>What telemetry does it send?</strong></summary>

**By default: zero network calls, zero telemetry.** There is an optional Level-1 mode: after a Claude Code session ends, the Stop hook sends anonymous counters (session length, edit/read counts, tool-usage counters, the names of configured MCP servers) — never memory content, file contents, paths or queries. The full field list is in [telemetry.md](telemetry.md).
</details>

<details>
<summary><strong>How do I verify it's actually working?</strong></summary>

After install, in a new Claude session ask: *"Can you remember that I prefer TypeScript over JavaScript? Use Linksee Memory."* Claude should confirm it called `mcp__linksee__remember` and stored this. Then in a **different session** ask: *"What languages do I prefer? Use Linksee Memory."* It should recall via `mcp__linksee__recall` and return the preference with `match_reasons` showing why.
</details>

