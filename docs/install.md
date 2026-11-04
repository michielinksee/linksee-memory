# Install and uninstall

Moved out of the README on 2026-11-04 so its first screen fits on one screen. Back to the [README](../README.md).

## Quick Start — One Command

```bash
npx -y linksee-memory setup
```

This sets up **Claude Code**:
1. Registers the MCP server (`claude mcp add -s user linksee -- npx -y linksee-memory`)
2. Installs the agent skill (teaches the agent when to recall/remember)
3. Configures auto-capture — a `Stop` hook, so every session is saved to your local memory
4. Wires the [re-injection guard](guard.md) for every repo (`--project-guard` for this repo only, `--no-guard` to skip)

**What is shared, and what is Claude Code only.** The memory itself (the MCP tools `remember` / `recall` / …) works from any MCP client — Claude Code, Cursor, Windsurf, OpenAI Codex, Gemini CLI — and they all use the same `~/.linksee-memory/memory.db`. Auto-capture and the guard are Claude Code hooks: other clients save and recall only when the agent calls the tools.

**Using Codex too?** One line registers the same memory there:

```bash
codex mcp add linksee -- npx -y linksee-memory
```

(Cursor, Windsurf and Gemini CLI: see [Other editors / CLIs](#other-editors--clis).)

**Try it — one round trip.** A new install has an empty memory, so "how did we solve this before?" has nothing to find yet. Instead:
1. In Claude Code, say: *"Remember: in this repo we decided to use X, because Y."*
2. Open a **new** session and ask: *"What did we decide about X?"*

Add **"Use Linksee"** to any prompt to force a recall.

**What setup writes, and how to undo it.**

| File | What |
|---|---|
| `~/.claude.json` | the `linksee` MCP server (via `claude mcp add`) — undo with `claude mcp remove linksee` |
| `~/.claude/skills/linksee-memory/SKILL.md` | the agent skill |
| `~/.claude/settings.json` | the `Stop` hook (auto-capture) and the `SessionStart` / `PreToolUse` guard hooks. Merged into what is there — other hooks and settings are kept. If the file does not parse, setup leaves it untouched and says so. Before changing it, setup keeps the previous file as `settings.json.bak-<timestamp>`: to undo, copy that file back over `settings.json`. |
| `~/.linksee-memory/runtime/<version>/` | only when setup ran from a temporary location (`npx`, `pnpm dlx`, `bunx`, or the system temp directory): setup runs `npm install --prefix ~/.linksee-memory/runtime/<version> --no-save --omit=dev linksee-memory@<version>` once (shown with its size; this downloads from the npm registry), because the hooks call `node` on it directly and those locations are temporary. Older versions are not removed automatically (about 35 MB each): setup prints the folder, you can delete old ones by hand, and `linksee-memory runtime prune` is planned for 0.17.2. If the install fails, the hooks stay on the npx form. |
| `~/.linksee-memory/telemetry-consent` | your telemetry answer (`off` unless you said yes) |

Running setup again changes nothing that is already in place. It rewrites only hooks it wrote itself: the exact `npx -y linksee-memory sync` / `npx -y linksee-memory guard` from earlier versions, and the direct form it writes now, which ends in `--linksee-managed`. Anything else that runs our scripts — a wrapper, a path you typed — is left alone and listed at the end of setup. With `--no-guard`, the guard hooks are not touched at all. If you later upgrade Node to a new major version, re-run setup (the hooks print one line saying so and let the action through).

### Manual setup (if you prefer step-by-step)

<details>
<summary>Click to expand manual installation</summary>

**Install & register:**

```bash
claude mcp add -s user linksee -- npx -y linksee-memory
```

Tools appear as `mcp__linksee__recall`, `mcp__linksee__remember`, `mcp__linksee__read_smart` and four more — 7 in all.

**Install the skill (auto-invocation):**

```bash
npx -y linksee-memory install-skill
```

Copies `SKILL.md` to `~/.claude/skills/linksee-memory/`. Agent auto-fires on phrases like "前に…", "また同じエラー", "覚えておいて", new task starts, file edits, etc.

**Configure auto-capture (Stop hook):**

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "npx -y linksee-memory sync" }
        ]
      }
    ]
  }
}
```

This `npx -y` form works anywhere, but every call starts npm and checks the registry: on the author's Windows machine one call took 7.4–8.6 s (3 runs, warm cache). `setup` writes a direct call instead — `"<path to node>" "<package>/dist/bin/sync-session.js" --linksee-managed` — which took 0.20–0.27 s on the same machine. Your numbers will differ; measure with your own hook log. Failures are silent. Logs at `~/.linksee-memory/hook.log`.

</details>

### Other editors / CLIs

Linksee Memory is a standard MCP server (stdio). Any tool that speaks MCP can connect:

<details>
<summary><strong>Cursor</strong></summary>

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "linksee": {
      "command": "npx",
      "args": ["-y", "linksee-memory"]
    }
  }
}
```

Restart Cursor. Memory tools appear in the agent panel.

</details>

<details>
<summary><strong>Windsurf</strong></summary>

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "linksee": {
      "command": "npx",
      "args": ["-y", "linksee-memory"]
    }
  }
}
```

</details>

<details>
<summary><strong>OpenAI Codex CLI</strong></summary>

```bash
codex mcp add linksee -- npx -y linksee-memory
```

Or add to `~/.codex/config.toml`:

```toml
[mcp_servers.linksee]
command = "npx"
args = ["-y", "linksee-memory"]
```

</details>

<details>
<summary><strong>Gemini CLI</strong></summary>

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "linksee": {
      "command": "npx",
      "args": ["-y", "linksee-memory"]
    }
  }
}
```

</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

Add the same stdio command to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "linksee": {
      "command": "npx",
      "args": ["-y", "linksee-memory"]
    }
  }
}
```

Config file: macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`. Restart Claude Desktop.

</details>

All editors share the same `~/.linksee-memory/memory.db`. A decision made in Claude Code is recalled in Cursor. A caveat recorded in Windsurf prevents the same mistake in Codex.

### Database location

Default: `~/.linksee-memory/memory.db`. Override with `LINKSEE_MEMORY_DIR` env var.

### Uninstall

```bash
# 1. Remove the MCP server registration
claude mcp remove linksee

# 2. Remove the hooks from settings.json (edit the file, delete the linksee entries),
#    or copy back the settings.json.bak-<timestamp> that setup left next to it:
#    ~/.claude/settings.json          → the Stop hook (…sync-session.js, or "npx -y linksee-memory sync")
#                                       and the SessionStart/PreToolUse hooks (…guard-hook.js, or "npx -y linksee-memory guard")
#    <project>/.claude/settings.json  → the same guard hooks, if you used --project-guard

# 3. Remove the installed skill and all local memory (optional)
rm -rf ~/.claude/skills/linksee-memory
rm -rf ~/.linksee-memory   # deletes the memory stored in this folder
```

Step 3 deletes what is inside `~/.linksee-memory/`. It does not reach copies you made yourself, and if you opted in to telemetry, the counters already sent are not deleted by this. Linksee itself never sends memory text anywhere. While installed, the only other traffic is npm itself: `npx` fetching the package, the one `npm install` setup runs for the hook runtime, and hooks left in the `npx -y` form checking the registry on each call.

