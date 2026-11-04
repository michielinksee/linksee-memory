# Telemetry (opt-in, off by default)

Moved out of the README on 2026-11-04 so its first screen fits on one screen. Back to the [README](../README.md).


linksee-memory ships with **opt-in** anonymous telemetry that helps us understand which MCP servers and workflows actually work in the wild. **Nothing is sent unless you explicitly enable it.** No conversation content, no file content, no entity names, no project paths — ever.

### Turn it on or off

The mode is decided in this order (`src/lib/telemetry.ts`, `getTelemetryMode`):

1. `LINKSEE_TELEMETRY`, after trimming spaces and lower-casing. `basic` / `on` / `1` / `true` turn it on; any other non-empty value (`off`, `0`, `false`, …) turns it off. Unset, empty, or only spaces counts as not set and moves on to step 2.
2. Otherwise, the answer you gave `setup`, saved in `~/.linksee-memory/telemetry-consent`. `basic` or `on` there means on.
3. Otherwise, off.

Unsetting the variable does **not** stop telemetry if you said yes during setup: the saved answer applies again. To stop it, either set `LINKSEE_TELEMETRY=off` explicitly, or change the saved answer. Changing the saved answer works only while `LINKSEE_TELEMETRY` is unset (or empty), because a value of `basic` there wins over the file:

```bash
echo off > ~/.linksee-memory/telemetry-consent   # stop, and keep the answer
rm ~/.linksee-memory/telemetry-consent           # stop; setup asks again next time
export LINKSEE_TELEMETRY=basic                   # turn on without setup
```

Data already sent is not removed by any of these, nor by deleting `~/.linksee-memory`.

### Exactly what gets sent (Level 1 contract)

After each Claude Code session ends, the Stop hook sends one POST to `https://linksee-site.vercel.app/api/telemetry/linksee` with exactly these fields (built in `buildPayload`, `src/lib/telemetry.ts`):

| Field | Example | What it is |
|---|---|---|
| `anon_id` | `d7924ced-3879-…` | Random UUID generated locally on first opt-in. Stored at `~/.linksee-memory/telemetry-id` — delete the file to reset. |
| `linksee_version` | `0.0.3` | Package version |
| `session_turn_count` | `120` | How many turns the session had |
| `session_duration_sec` | `3600` | How long the session lasted |
| `file_ops_edit`, `file_ops_write`, `file_ops_read` | `12, 2, 40` | Counts only |
| `errors_count` | `0` | Always 0 for now (not yet measured) |
| `mcp_servers` | `["kansei-link","freee","slack"]` | Names of MCP servers configured (from `~/.claude.json` and `~/.claude/settings.json`, at most 50). Names only — never command paths. |
| `file_extensions` | `{".ts":60,".md":30}` | Percent distribution of file extensions touched |
| `read_smart_savings_pct`, `read_smart_calls`, `recall_calls`, `recall_file_calls` | `null, 0, 0, 0` | Tool usage counters. Not wired yet: currently always `null` / `0` |
| `anchor_creates` | `1` | How many decisions (anchors) were recorded during the session's edit span — a count, no text |
| `anchor_returns` | `3` | In the session's edit span: the number of guard re-injections plus anchor interactions other than creation. It does not check whether the anchor was made in an earlier session. A count, no text |

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

