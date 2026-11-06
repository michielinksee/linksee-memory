# Troubleshooting and FAQ

Moved out of the README on 2026-11-04 so its first screen fits on one screen. Back to the [README](../README.md).

## Troubleshooting

<details>
<summary><b><code>npx -y linksee-memory</code> fails with "Could not locate the bindings file" (npm 12), or says "no SQLite driver could load".</b></summary>

npm 12 no longer runs dependency install scripts by default, so `better-sqlite3` arrives without its compiled part. Up to 0.18.x that was the only SQLite driver and the server stopped on start.

Since 0.19.0 linksee-memory uses the SQLite built into Node (`node:sqlite`) whenever Node has it — **Node 22.13 or later** — and does not need `better-sqlite3` at all. So:

1. **Upgrade Node to 22.13+ (or 24 LTS)** and run the same `npx -y linksee-memory` again. Nothing else to change; the same `~/.linksee-memory/memory.db` is used.
2. If you must stay on Node 20 / 22.0–22.12, `better-sqlite3` has to be built. With npx or a global install, pass the flag: `npx --allow-scripts=better-sqlite3 -y linksee-memory` / `npm i -g linksee-memory --allow-scripts=better-sqlite3`. Inside a project, npm 12 refuses that flag; add `"allowScripts": { "better-sqlite3": true }` to the project's package.json instead. npm 11 and older build it as before.

The server prints one line and exits 1 when neither driver can load. `LINKSEE_SQLITE_DRIVER=node` or `=better` forces one (for testing; the default picks node:sqlite when available).
</details>

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
3. Make sure `~/.claude/settings.json` has a `Stop` hook for linksee. Since 0.17.1 setup writes a direct call ending in `dist/bin/sync-session.js" --linksee-managed`; older installs, and paths that cannot be quoted safely, use `npx -y linksee-memory sync`. Either is fine; the old `-import` form is not. If you upgraded Node to a new major version, re-run `npx -y linksee-memory setup`.
</details>

<details>
<summary><b>The server says my memory.db is at schema 1–5 (I installed 0.11 or earlier, before June 2026).</b></summary>

**Close every Claude Code / Cursor / Codex / other client that uses linksee-memory, and keep them closed until the command finishes.** It cannot detect an idle client on a WAL-mode file (only Windows refuses the final rename then), and nothing here is a lock.

0.17.x refuses these files before writing anything. Then:

```bash
npx -y linksee-memory@0.17.2 migrate --dry   # rehearse on a temporary copy
npx -y linksee-memory@0.17.2 migrate         # migrate a copy, then swap it in
```

What it does: it checks there is free space for 3 × the database (a floor, not a bound: the WAL / journal can grow during the migration), copies `memory.db` (+ `-wal`, `-journal`) and migrates the copy, checking it (no table loses rows, `integrity_check` ok). Up to here it does not write to your files. Then it checks they did not change, and for a rollback-journal file opens a connection once to try a write lock (`BEGIN IMMEDIATE`, then `ROLLBACK`; nothing is written). After that it moves `memory.db` and its `-wal` / `-shm` / `-journal` into `memory.db.pre-migrate-<time>/` (the originals, byte for byte, with a `README.txt`) and puts the migrated copy in their place. If one of those moves fails, it tries to put back what it moved; if something could not be put back, it prints where each original file is now and the exact `move <from> → <to>` lines to reunite the set (also in `README.txt` in that folder) — follow those, not the steps below. If the process is killed or crashes, a `memory.db.migrating-<time>-<pid>/` folder can be left behind; it holds copies only and can be deleted. It does not start the server, consolidate, or merge entities. Keep the version pinned: older versions have no `migrate` and would start their server instead.

**To go back** to the originals after a successful run:

1. Close every client.
2. Move the current `memory.db` **and** every `memory.db-wal` / `-shm` / `-journal` next to it into a new, separate folder, all together.
3. Move all the files from `memory.db.pre-migrate-<time>/` back, as one set.

Never combine a `memory.db` from one set with a `-wal` / `-shm` / `-journal` from the other: SQLite reads them as one database, and a mismatched pair can corrupt it.
</details>

<details>
<summary><b>Upgrading from v0.0.5 or earlier — my recalls are mostly tagged "Card_Navi" or my project-dir name.</b></summary>

v0.0.6+ fixed the entity detection bug that collapsed all memories into the session's starting cwd. To re-index existing history with correct project attribution, run:

```bash
npx -y linksee-memory import --all
```

This needs a database at schema 6 or later: migrate a schema 1–5 file first (see the next entry). The importer is idempotent (wipes existing session data before re-inserting). Typical runtime: a few minutes for hundreds of sessions. Expect a dramatic improvement in `recall` precision afterward.
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

Since 0.18.1 consolidation does not trim it: it writes one learning-layer summary per cluster of cold memories and marks the originals `consolidated_into` (they stay; `recall` hides them by default). Nothing in the server deletes a memory row except `remember({ memory_id, forget: true })`. Run `npx -y linksee-memory consolidate --dry-run` to see what a fold would touch, `--apply` to do it; or start the server with `LINKSEE_AUTO_CONSOLIDATE=1` (off by default; then at most weekly, 7-day threshold). Caveat and active-goal layers are never candidates. To actually shrink the file, delete rows by id with `remember({ memory_id, forget: true })` after taking a backup, then `VACUUM` with a SQLite client. Up to 0.18.0 consolidation deleted the originals and swept other cold rows; those rows come back only from a backup. There is no `consolidate` MCP tool.
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
1. **Local-first**: those tools require cloud accounts and send your data to their servers. linksee-memory keeps the memory on your machine — one SQLite file. The server itself makes no network calls; npm contacts the registry to install or update it, and telemetry is sent only if you opt in.
2. **WHY-layered**: they store flat facts or knowledge-graph nodes. linksee-memory has 6 explicit layers (`goal`/`context`/`emotion`/`implementation`/`caveat`/`learning`) so retrieval returns structured reasoning, not just data.
3. **File diff cache**: `read_smart` returns only what changed on a re-read (AST-aware chunking), so re-reads cost far fewer tokens. None of the memory services do this — it's a feature usually shipped in IDEs.
</details>

<details>
<summary><strong>Why not just use Claude's built-in auto-memory?</strong></summary>

Claude Code's auto-memory is Claude-only (doesn't help if you switch to Cursor, OpenAI Codex, or Gemini CLI) and stores flat markdown with no structure. linksee-memory is the same local-first principle but:
- Works across Claude Code, Cursor, OpenAI Codex, Gemini CLI (shared SQLite)
- Structured 6-layer format makes recall explainable
- Consolidation of cold memories is opt-in (`LINKSEE_AUTO_CONSOLIDATE=1`, deletes originals); caveats are permanently protected
</details>

<details>
<summary><strong>How much does <code>read_smart</code> save, and where does it come from?</strong></summary>

The check in the repo is `test/smoke-read-smart.mjs`: it builds a 300-line TypeScript file with 10 functions, changes one, and requires at least 60% saved on the re-read (it prints the measured figure). The `read_smart` tool:
1. Hashes file content on first read, returns full content + chunk metadata (AST/heading/indent boundaries).
2. On re-read with unchanged mtime+sha256, returns `~50 tokens` of "unchanged" confirmation instead of re-sending the file.
3. On real edits, returns only the changed chunks as full content + unchanged chunks as metadata-only references.

How much you save depends on the file and how much of it changed; an unchanged re-read returns about 50 tokens instead of the file.
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

**By default: no telemetry, and Linksee never sends memory text.** npm itself still talks to the registry: `npx` fetching the package, the one `npm install` setup runs for the hook runtime, and hooks left in the `npx -y` form checking the registry on each call. Deleting `~/.linksee-memory/` does not delete telemetry already sent. There is an optional Level-1 mode: after a Claude Code session ends, the Stop hook sends anonymous counters (session length, edit/read counts, tool-usage counters, the names of configured MCP servers) — never memory content, file contents, paths or queries. The full field list is in [telemetry.md](telemetry.md).
</details>

<details>
<summary><strong>How do I verify it's actually working?</strong></summary>

After install, in a new Claude session ask: *"Can you remember that I prefer TypeScript over JavaScript? Use Linksee Memory."* Claude should confirm it called `mcp__linksee__remember` and stored this. Then in a **different session** ask: *"What languages do I prefer? Use Linksee Memory."* It should recall via `mcp__linksee__recall` and return the preference with `match_reasons` showing why.
</details>

