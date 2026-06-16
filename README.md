# linksee-memory

> **Your agent forgets everything when a session ends. Worse — it silently drifts from what you decided last week.**
>
> **Linksee Memory catches when your project drifts from its own decisions** — the option abandoned at a fork, the pipeline that quietly stalled, the code that contradicts what you agreed — and a re-injection guard re-surfaces the locked decision **before** the agent acts. Rules you've explicitly hardened get blocked.
>
> Underneath sits a local-first cross-LLM memory MCP — one SQLite file that **Claude Code, Cursor, Windsurf, OpenAI Codex, and Gemini CLI** all read from. Not just "what happened" but **WHY**: 6-layer structured memory with precision recall and an AST-aware diff cache (50–99% token savings on re-reads).
>
> `npx -y linksee-memory setup` — one command, done.

[![npm](https://img.shields.io/npm/v/linksee-memory.svg)](https://www.npmjs.com/package/linksee-memory)
[![license](https://img.shields.io/npm/l/linksee-memory.svg)](./LICENSE)
[![mcp-registry](https://img.shields.io/badge/MCP-Official_Registry-6366f1)](https://registry.modelcontextprotocol.io/)
[![glama-score](https://glama.ai/mcp/servers/michielinksee/linksee-memory/badges/score.svg)](https://glama.ai/mcp/servers/michielinksee/linksee-memory)

🌐 **Landing page**: [linksee-site.vercel.app](https://linksee-site.vercel.app) (includes non-developer onboarding for Claude Desktop / Cursor / Claude Code / OpenAI Codex / Gemini CLI)
📖 **Docs**: [docs.linksee.app](https://docs.linksee.app) — full reference: the product map & drift, install, and all 11 tools

## 🪄 Three spells to remember

| Say this | What happens |
|---|---|
| **"use linksee"** | Recalls relevant memories before acting |
| **"linksee this"** | Saves the decision / lesson right now |
| **"what's drifting?"** | Reconciles reality against your locked decisions |

> Make it automatic: add **"Use Linksee Memory"** to your system prompt / `CLAUDE.md`.

## 🗺️ Not just memory — a product map

Memory is the entry point. Tie it to a `map.yaml` of how your product fits together, and the `linksee-memory map` CLI catches drift with file:line evidence:

![linksee-memory-map catching doc/code drift in 30 seconds](demo/where-demo.gif)

**The 30-second demo above:** the README says `--export`. The code doesn't. Linksee catches it — and shows what else a change would touch.

```bash
npx -y linksee-memory map where README.md   # this file belongs to the README node — and what it touches
npx -y linksee-memory map explain readme    # README promises --export; the code doesn't implement it — drift, with evidence
npx -y linksee-memory map affects readme    # changing the README also touches docs, the CLI help, and the npm listing
```

→ see [The Map](#the-map) for the full flow.

## 📣 As featured on

- **Zenn**: [あなたの Claude Code、 実は前回のセッションを完全に忘れている](https://zenn.dev/kanseilink/articles/linksee-memory-claude-code-recall-20260508) — 73 ♡ on Zenn, **165+ users on Hatena Bookmark**, picked up by tech blogs + YouTube shorts (May 2026)
- **Zenn**: [あなたの MCP server、 実は Tools しか使ってない (5 blocks 全実装 / v0.3.0)](https://zenn.dev/kanseilink/articles/linksee-memory-mcp-five-blocks-20260507) — the 1% of MCP servers that implement all 5 blocks
- **Zenn**: [あなたの Claude memory、 実は Claude にしか残らない (5 LLM 横断する方法)](https://zenn.dev/kanseilink/articles/linksee-memory-claude-cross-llm-20260511) — cross-LLM memory pattern (May 12, 2026)
- **Zenn**: [Glama listing で 3 週間止まった話 (5 つの罠と解決策)](https://zenn.dev/michielinksee/articles/linksee-memory-mcp-publish-glama-traps-20260506) — npm + Glama deployment retrospective

> 「Cordex/Cursor/Code/Gemini 全部につなげられるから、 横断的にできてる MCP ってところがこれのすごいところ」
> — [Hatena Bookmark, May 2026](https://b.hatena.ne.jp/entry/s/zenn.dev/kanseilink/articles/linksee-memory-claude-code-recall-20260508) (165+ users)

---

## 🎬 See it in action

**Drift, caught.** Decisions don't survive session boundaries — but their consequences do. Ask any session:

```
You:    What's drifting right now?
Agent:  [calls drift_status]

        28 anchors: ⚪ 1 held · 🔵 27 aligned

        Needs attention:
        ⚪ HELD — "Focus on 4 areas: Recipe layer, agent-native API,
           Japanese market, Agent Insights"
           ↻ Reopens 2026-07-04

        Everything else is aligned — no unaccounted divergence.
```

**The memory underneath.** Drift detection only works because the *why* survives the session boundary:

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

## 🔍 Drift Detection — "Intent Datadog"

Most teams make decisions, then forget them. The agent from last week decided "we'll use FTS5 instead of vector search" — but this week a new session installs `pgvector` without knowing why that was rejected. **That's drift.** Not a bug. Not malice. Just forgotten context.

Memory tools remember what you did. Nothing notices when you drift from what you decided — that's the layer Linksee Memory adds. Think **"Datadog for product decisions"**: unaccounted divergences surface as drift, intentional evolution (recorded as supersede/fix) stays quiet.

### How it works

1. **Declare** decisions as anchors: `declare_anchor({ kind: "decision", statement: "We use FTS5, not vector search", violation_signal: ["pgvector", "embedding"] })`
2. **The engine detects** when committed code reality diverges from these anchors
3. **State derivation** classifies each anchor:
   - 🔴 **Drift** — reality diverges with no recorded resolution
   - 🟡 **Review** — a soft signal awaits your decision
   - ⚪ **Held** — you acknowledged the gap, parked it with a review date
   - 🔵 **Aligned** — reality matches intent, or a recorded resolution explains the change
4. **Resolve** with `fix`, `supersede`, `acknowledge`, or `dismiss` — plus two gates: `harden` (PreToolUse will block) and `soften` (back to a warning)

The **make-or-break rule**: a divergence accounted for by a recorded resolution (supersede/fix/acknowledge) is NOT drift. Only unaccounted gaps are flagged. This means intentional evolution stays quiet while silent abandonment gets caught.

### 4-species taxonomy

Anchors are classified into four species with different display formats:

| Species | Icon | Display Format | Example |
|---|---|---|---|
| Hypothesis | 🧪 | Decision Card (journal format) | "We'll launch English-first on HN" |
| Constraint | 🔒 | Rule (pass/fail checklist) | "All writes go through remember()" |
| Commitment | 🔁 | Heartbeat (alive/dead) | "Ship a new version every week" |
| Source of Truth | 📍 | Reference (stable anchor) | "MCP server runs on stdio, single SQLite" |

---

<a id="the-map"></a>

## 🗺️ The Map — `linksee-memory map`

Drift detection (above) checks individual anchors. The **Map** lifts it to the whole product: a `map.yaml` describing how value reaches your user (`discover → understand → try → adopt → retain → monetize → expand`), with typed dependencies between the pieces — README, npm listing, onboarding, the engine that powers them. The reconciler checks that map against your real code, and the CLI answers the question an engineer actually has:

> *I'm touching this file — where is it on the map, and what else must move?*

**1. Where am I?** — locate a file (or, with no argument, infer from your recent edits):

```
$ npx -y linksee-memory map where README.md
"README.md" belongs to this Map node:

  readme  [understand]  convergence
    changes ripple to:
      must fix together (hard):  lp, docs-site
      should align (soft):       onboarding, client-configs
      fyi (may ripple):          telemetry-contract
```

The blast radius is **graded** — `must fix together` vs `should align` vs `fyi` — so a wide ripple isn't flat noise.

**2. Why is it in this state?** — the diagnosis, with file:line evidence:

```
$ npx -y linksee-memory map explain readme

STATUS
  declared: healthy (active)
  reality:  implemented / matches
  verdict:  declared and reality agree (verified)

EVIDENCE
  ✓ README's Tools section lists where_am_i
      README.md:424 — found "where_am_i" in section "Tools"
```

Declared state and the reality verdict are shown **separately** — a hand-declared `suspect` the scanner refutes reads as *"declared suspect, refuted by reality (→ convergence)"*, not a confusing mix.

**3. Whole-project triage:** `npx -y linksee-memory map status` — a health %, what is *fixable now in code* vs *external checks*, and any deferral with no expiry (so "accounted-for" can't quietly become a drift graveyard).

**How it works**
- **`map.yaml`** (repo root) is the desired-state source of truth: a journey spine × surface/implementation layers × typed edges (`must-stay-consistent-with` / `should-align-with` / `realizes`).
- **`reconcile`** checks each node's declared `reality` against the code (`signal` / `regex` / `section_contains` / file checks) and overlays a verdict — reality overrides what you hand-declared, with evidence.
- `where_am_i` is also an **MCP tool**, so a coding agent can re-anchor itself mid-task.

Commands: `where` · `affects` · `explain` · `status` · `next` · `reconcile` · `inspect --json` · `blueprint`. Add `--lang ja` for Japanese labels.

---

<a id="reinjection-guard"></a>

## 🛡 Re-injection Guard — enforce decisions *before* the action

Drift detection (above) is **post-hoc** — it tells you reality diverged *after* the change lands. The re-injection guard is the **pre-action** half: it re-surfaces the decision you locked **before** the agent runs the tool that would break it.

It exists for one specific, infuriating failure mode ([anthropics/claude-code#15443](https://github.com/anthropics/claude-code/issues/15443)): *"Claude read the rule, understood it, and still used `cp`."* Having the rule in context isn't enough — so the guard runs **outside the agent's volition**, as a Claude Code hook:

| Hook event | Fires on | What it does |
|---|---|---|
| **`PreToolUse`** | `Edit` / `Write` / `Bash` | Checks the pending action against your accepted anchors. A `gate_mode:'hard'` contradiction is **denied**; a softer match re-injects the decision as a reminder; no match → nothing happens. |
| **`SessionStart`** | `startup` / `resume` / `compact` | Replays your locked decisions + open forks into the fresh session — killing the "groundhog day" amnesia where a new agent repeats last week's call. |

It is **fail-open by construction**: any parse / DB / logic error surfaces nothing and lets the action through. The *only* thing that ever blocks is an explicit `hard` contradiction on a decision **you** declared.

### Enable it

`npx -y linksee-memory setup` offers to wire this into your **project's** `.claude/settings.json` (Step 4). To do it by hand, drop this block into `.claude/settings.json` at your project root — it points at the globally-installed `linksee-memory-guard` bin, so no build step is needed:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|compact",
        "hooks": [
          { "type": "command", "command": "npx -y linksee-memory guard", "timeout": 15 }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Write|Bash",
        "hooks": [
          { "type": "command", "command": "npx -y linksee-memory guard", "timeout": 8 }
        ]
      }
    ]
  }
}
```

It's **project-scoped on purpose** — the guard enforces *this* repo's decisions, and you opt in per project rather than letting it deny tool calls everywhere (the Stop hook from setup, by contrast, is user-global). Declare what it should watch with `declare_anchor(...)`; set `card_policy.gate_mode:'hard'` on an anchor to make a contradiction **block** instead of just warn (the soft default only re-injects). Anchors that are stale (`at_risk`), superseded, or card-disabled never gate.

> Developing linksee-memory itself? The repo dogfoods the guard via a (gitignored) `.claude/settings.json` that points at the local build (`node ${CLAUDE_PROJECT_DIR}/dist/bin/guard-hook.js`) so it runs against your uncommitted changes. End-user projects should use the published `npx -y linksee-memory guard` form above.

---

## What it does

Most "agent memory" services (Mem0, Letta, Zep) save a flat list of facts. Then the agent looks at "edited file X 30 times" and has no idea why. And none of them notice when this week's work contradicts last week's decision. **linksee-memory keeps the WHY — and watches the drift.**

It is a Model Context Protocol (MCP) server with **11 tools** that gives any AI agent structured memory + drift detection:

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

Every memory is tagged with **exactly one layer**. `caveat`-layer entries are protected from auto-forgetting. Cold low-importance memories are auto-consolidated into `learning` entries on server startup.

---


## Quick Start — One Command

```bash
npx -y linksee-memory setup
```

This does everything:
1. Registers the MCP server with Claude Code
2. Installs the agent skill (teaches the agent when to recall/remember)
3. Configures auto-capture (every session saved to your local brain)
4. Offers to wire the [re-injection guard](#reinjection-guard) into this project (pre-action decision enforcement)

Restart Claude Code, then just chat normally. Add **"Use Linksee"** to any prompt to trigger memory recall.

### Manual setup (if you prefer step-by-step)

<details>
<summary>Click to expand manual installation</summary>

**Install & register:**

```bash
claude mcp add -s user linksee -- npx -y linksee-memory
```

Tools appear as `mcp__linksee__remember`, `mcp__linksee__recall`, `mcp__linksee__read_smart`.

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

Each turn end takes ~100 ms. Failures are silent. Logs at `~/.linksee-memory/hook.log`.

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

All editors share the same `~/.linksee-memory/memory.db`. A decision made in Claude Code is recalled in Cursor. A caveat recorded in Windsurf prevents the same mistake in Codex.

### Database location

Default: `~/.linksee-memory/memory.db`. Override with `LINKSEE_MEMORY_DIR` env var.

### Uninstall

```bash
# 1. Remove the MCP server registration
claude mcp remove linksee

# 2. Remove the hooks from settings.json (edit the file, delete the linksee entries):
#    ~/.claude/settings.json          → the Stop hook running "npx -y linksee-memory sync"
#    <project>/.claude/settings.json  → the SessionStart/PreToolUse hooks running "npx -y linksee-memory guard"

# 3. Remove the installed skill and all local memory (optional)
rm -rf ~/.claude/skills/linksee-memory
rm -rf ~/.linksee-memory   # deletes all stored memory — nothing is kept anywhere else
```

Nothing ever leaves your machine, so step 3 fully erases everything Linksee stored.

## What's new in v0.9

| Feature | Detail |
|---|---|
| **Re-injection guard** | The pre-action half of drift detection. A Claude Code `PreToolUse` hook re-surfaces (or, on a `hard` contradiction, blocks) an accepted decision *before* the agent runs `Edit`/`Write`/`Bash`; a `SessionStart` boot digest replays your locked decisions into each fresh session. Fail-open by design. See [Re-injection Guard](#reinjection-guard). |
| **Shippable hook wiring** | `linksee-memory-setup` now offers to merge the guard hooks into your project's `.claude/settings.json` (pointing at the published `linksee-memory-guard` bin), and the block is documented for copy-paste. Previously the wiring lived only in a gitignored dogfood config. |

## What's new in v0.8

| Feature | Detail |
|---|---|
| **4 drift detection tools** | `drift_status`, `check_decision`, `declare_anchor`, `resolve_drift` — agents can now query and act on intent ↔ reality divergence. The biggest gap in agent memory (decisions are forgotten across sessions) is now closed. |
| **Truth engine** | State derivation logic (drift/review/held/aligned) now lives in the MCP engine, not just the dashboard. Any MCP client can query drift status. |
| **4-species taxonomy** | Anchors classified as hypothesis/constraint/commitment/source_of_truth with species-appropriate display formats. |
| **Resolution priority** | When multiple resolutions exist for an anchor, the most recent one wins (prevents stale acknowledge from shadowing a newer fix). |

<details>
<summary>What's new in v0.7</summary>

| Feature | Detail |
|---|---|
| **3-tool unified surface** | 8 tools → 3: `remember` (create + update + delete), `recall` (search + file history + overview), `read_smart` (token-saving reads). Fewer tools = better cross-LLM consistency. Follows Context7's proven pattern. |
| **Auto-consolidate** | Consolidation runs automatically on server startup (non-blocking, 7-day threshold). No manual `consolidate()` calls needed. |
| **Deprecation guidance** | Old tool names (`forget`, `recall_file`, etc.) return specific migration examples instead of silent failures. |
| **"Use Linksee Memory" trigger** | Add "Use Linksee Memory" to any prompt to force memory recall — same adoption pattern as Context7. |
| **Claude Code Plugin** | `claude plugin add -- linksee-memory` — ships MCP server + auto-invocation skill in one install. |

</details>

<details>
<summary>What's new in v0.4</summary>

| Feature | Detail |
|---|---|
| **One-command setup** | `npx -y linksee-memory setup` — registers MCP server, installs skill, configures auto-capture hook. One command instead of three. |
| **Structured memory v2** | 3-axis classification (altitude × type × state) for every memory. Auto-extraction from sessions produces machine-scannable JSON, not raw chat dumps. |
| **Precision recall guide** | SKILL.md now teaches agents HOW to write effective queries, WHEN to recall vs skip, and WHEN to proactively surface caveats before risky actions. |
| **Five MCP Blocks** | Tools + Resources + Prompts + Sampling + Roots + Elicitation. Most MCP servers expose only Tools; linksee-memory implements all five primitives. |

</details>

## 11 Tools

### Memory tools

| Tool | What it does |
|---|---|
| `remember` | **Save / update / delete** memories. Auto-classifies into 6 layers. Modes: create (default), update (`memory_id` + fields), delete (`forget: true` + `memory_id`). |
| `recall` | **Search / file history / overview.** Modes: search (`query`), file history (`path`), entity overview (no params). FTS5 + heat × momentum ranking with `match_reasons`. |
| `read_smart` | **Token-saving file reader** with AST diff caching. First read = full content. Re-read unchanged = ~50 tokens. Re-read modified = changed chunks only. |

### Drift tools (v0.8.0)

| Tool | What it does |
|---|---|
| `drift_status` | **"What's drifting right now?"** Returns the truth map with 4-species classification (hypothesis/constraint/commitment/source_of_truth) and per-node state (🔴 drift / 🟡 review / ⚪ held / 🔵 aligned). |
| `check_decision` | **Deep-dive into a specific decision.** Returns the full context: what was decided, why, what reality says, pending candidates, and drift edges. |
| `declare_anchor` | **Record a decision as a truth-map anchor.** The drift detector checks these against committed reality. Supports v9 fields (domain, confidence, lifecycle, review_after). |
| `resolve_drift` | **Close the loop.** Record a resolution: `fix` (reality now matches), `supersede` (intent evolved), `acknowledge` (parking with review date), or `dismiss` (false positive). |
| `where_am_i` | **"Where on the Map am I, and what else does this touch?"** Locates the current topic/file on the Current Truth Map and returns its journey stage + blast radius (the `must-stay-consistent-with` / `should-align-with` dependents) + the decision behind it. The per-turn re-anchor that stops you optimizing one node while silently breaking its neighbors. |

### Fork-point tools (v0.10)

| Tool | What it does |
|---|---|
| `flag_proposals` | **Record orphaned proposals** — options you presented that the user never addressed. Conversations are tree-shaped but experienced linearly; the branches nobody engaged with become unresolved fork points that both you and the user lose track of. |
| `dream` | **Consolidate orphaned proposals against the North Star.** Returns the project's direction/goals/ICP alongside unresolved proposals; the evaluating agent decides per candidate: surface (genuinely important fork) or dismiss (outdated / irrelevant / implicitly resolved). |
| `resolve_proposal` | **Record the verdict** for each dreamed proposal: `surface` (keep visible on the dashboard for human decision) or `dismiss` (remove from the dashboard). |

Previous versions exposed 3 tools — v0.8.0 added 4 drift tools that let agents query and act on product-level intent ↔ reality divergence; v0.10 added the fork-point trio for orphaned-proposal triage; `where_am_i` adds the Current Truth Map's per-turn positional re-anchor. The memory tools are unchanged.

### CLI utilities

| Command | Purpose |
|---|---|
| `npx -y linksee-memory setup` | One-command setup: MCP server + skill + Stop hook, then offers to wire the re-injection guard into this project. Idempotent — skips what's already done. |
| `npx linksee-memory` | MCP server (stdio) |
| `npx -y linksee-memory sync` | Claude Code Stop-hook entry point |
| `npx -y linksee-memory guard` | Re-injection guard hook: `PreToolUse` gate (`Edit`/`Write`/`Bash`) + `SessionStart` boot digest. Wired per-project (see [Re-injection Guard](#reinjection-guard)); fail-open. |
| `npx -y linksee-memory import` | Batch-import Claude Code session JSONL history |
| `npx -y linksee-memory install-skill` | Install the Claude Code Skill that teaches the agent when to call recall/remember/read_smart |
| `npx -y linksee-memory stats` | Summary of the local DB (entity count / layer breakdown / top entities / top edited files). Add `--json` for machine-readable output. |

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

## Roadmap

- ✅ 3-tool unified surface (remember / recall / read_smart) — v0.7.0
- ✅ Auto-consolidate on server startup — v0.7.0
- ✅ Claude Code Plugin (`claude plugin add -- linksee-memory`)
- ✅ Five MCP Blocks (Tools + Resources + Prompts + Sampling + Roots + Elicitation)
- ✅ Stop-hook auto-capture for Claude Code
- ✅ JP/EN trigram FTS5
- ✅ One-command setup (`npx -y linksee-memory setup`)
- ✅ Structured memory v2 (3-axis classification: altitude × type × state)
- ✅ Cross-LLM: Claude Code, Cursor, Windsurf, OpenAI Codex, Gemini CLI
- ✅ Landing page ([linksee-site.vercel.app](https://linksee-site.vercel.app))
- ✅ Drift detection engine + 4 MCP drift tools — v0.8.0
- ✅ 4-species truth map (hypothesis/constraint/commitment/source_of_truth) — v0.8.0
- ✅ Dashboard with Decision Register visualization
- 🔮 Obsidian plugin (read truth map in your vault)
- 🔮 Vector search via `sqlite-vec` (already in deps, embedding backend pending)
- 🔮 Cross-device cloud sync (Pro tier)

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

Consolidation runs automatically on server startup (7-day threshold). It clusters old cold memories into compressed learning-layer summaries. Caveat and active-goal layers are always preserved.

If you want to force a manual consolidation, restart the MCP server — auto-consolidate triggers on every startup.
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
- Auto-consolidation compresses cold memories on startup; caveats are permanently protected
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
2. **Auto-consolidation**: runs on every server startup (7-day threshold). Compresses clusters of cold low-importance memories by entity into a single `learning`-layer summary, then deletes the originals. No manual scheduling needed.

In practice a solo developer hits ~100MB after 6 months of heavy use. A year-old DB I tested with 80K memories still recalls in <10ms.
</details>

<details>
<summary><strong>Can I use this without Claude Code?</strong></summary>

Yes — any MCP-compatible client works:
- **Claude Code**: `claude mcp add -s user linksee -- npx -y linksee-memory`
- **Claude Desktop**: add to `claude_desktop_config.json` (see [onboarding on the LP](https://linksee-site.vercel.app))
- **Cursor**: add to MCP settings in Cursor → Settings → Features → Model Context Protocol
- **OpenAI Codex**: `codex mcp add linksee -- npx -y linksee-memory` (or `~/.codex/config.toml` with `[mcp_servers.linksee]` block)
- **Gemini CLI**: add to `~/.gemini/settings.json` mcpServers section
- **ChatGPT (web/mobile app)**: stdio MCP not supported by the consumer app — requires Remote MCP server over HTTPS (not yet available).
- **Custom agent**: the MCP stdio protocol is documented at modelcontextprotocol.io
</details>

<details>
<summary><strong>What telemetry does it send?</strong></summary>

**By default: zero network calls, zero telemetry.** There's an optional Level-1 telemetry mode you can enable that sends anonymized aggregate metrics (tool call counts, error rates, latency percentiles — never memory content, never file paths, never queries). The exact payload schema is documented in the [Telemetry section](#telemetry-opt-in-off-by-default) and you see every byte before opting in.
</details>

<details>
<summary><strong>How do I verify it's actually working?</strong></summary>

After install, in a new Claude session ask: *"Can you remember that I prefer TypeScript over JavaScript? Use Linksee Memory."* Claude should confirm it called `mcp__linksee__remember` and stored this. Then in a **different session** ask: *"What languages do I prefer? Use Linksee Memory."* It should recall via `mcp__linksee__recall` and return the preference with `match_reasons` showing why.
</details>

## Support

- **Issues & bug reports**: [github.com/michielinksee/linksee-memory/issues](https://github.com/michielinksee/linksee-memory/issues)
- **Feature requests**: open an issue with the `enhancement` label
- **Security concerns**: see [SECURITY.md](./SECURITY.md) if present, or file a private advisory on GitHub
- **Company**: Synapse Arrows PTE. LTD. (Singapore)

## Changelog

### v0.11.2 — More cold-start hardening (2026-06-16)

- **`stats` works on a fresh database** instead of crashing with `no such table` — it ensures the schema exists first (it may be the first command a new user runs).
- **`map --help`** prints usage instead of trying to import a map.

### v0.11.1 — Cold-start fixes (2026-06-16)

- **Run any CLI through the package name:** `npx -y linksee-memory setup` (and `map`, `sync`, `guard`, `stats`, `import`, `install-skill`). A fresh user couldn't reach the standalone bins (`linksee-memory-setup`, …) via `npx` — npx resolves package names, not sibling bin names — so the one-command install 404'd. The main bin now dispatches subcommands; the standalone bins remain as aliases.
- **`map` exits gracefully** with a next-step message when there's no `map.yaml` yet (was a raw stack trace — the exact state of a first-time user).
- **serverInfo** now reports the real package version (was pinned to an old string).

### v0.11.0 — The Map: `where_am_i` + `linksee-memory map` (2026-06-15)

**Memory is the entry point; the product map is the new surface.** Drift detection grows up from individual anchors into a whole-product map you navigate from the CLI.

- **`where_am_i`** (11th MCP tool) — locate the current topic/file on the Current Truth Map and get its blast radius. Call it with no args to auto-locate from your recent edits.
- **`linksee-memory map`** CLI — `where` · `affects` · `explain` · `status` · `next` · `reconcile` · `inspect --json` · `blueprint`. A `map.yaml` (git source of truth) describes how value reaches your user; the reconciler checks it against your code with file:line evidence. Bilingual: add `--lang ja`.
- Graded blast radius (`must fix together` / `should align` / `fyi`), declared-vs-reality verdicts, and an anti-graveyard guard for accounted-for drift.
- Per-project keys so the Map handles many projects at once.

### v0.8.0 — Drift Detection MCP Tools (2026-06-08)

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

### v0.7.2 — Recall ergonomics + auto-edge detection + classifier precision (2026-05-30)

Quality pass on v0.7.0 / v0.7.1 — sharper day-to-day agent UX and cleaner data for the dashboard:

- **`recall` token discipline**: drops the redundant `content_raw` from the response (parsed `content` was already there — it was a 2× duplicate), and actually enforces `max_tokens` by greedy assembly that measures real serialized size (was a flat ~100 tok/memory estimate). Adds `approx_tokens` to the response so the agent can see its budget usage. The same query that previously returned ~15,800 tokens for a 1200 budget now stays inside it.
- **`recall` precision**: near-duplicate memories — same entity + near-identical core text, e.g. the same message captured under both `goal` and `learning` — collapse to one in the result set. Composite weights adapt to query specificity: multi-term queries weight relevance higher so off-topic-but-pinned memories don't crowd narrow recalls.
- **Capture dedup (write side)**: `session-extractor` now produces AT MOST one memory per user turn, with priority `goal[first_intent] > caveat > decision > context`. A first-intent message containing decision words (e.g. "決めた" / "これで進めよう") is no longer double-saved as both `goal` and `learning`.
- **`memory_edges` auto-detection**: the previously-empty `memory_edges` table is now populated during the sleep-mode consolidation sweep. `detectMemoryEdges()` links a later DECISION memory to the most-recent earlier same-topic decision within an entity (chain, not clique) so the dashboard can render Pivot Chains. The default relation is `extends` — a same-topic later decision builds on, but does NOT deactivate, the earlier one. Explicit reversal markers (やめる / revert / instead of) produce `contradicts`; explicit replacement markers (の代わり / replaces / deprecate) produce `supersedes`. Prevents silent deactivation of still-valid decisions.
- **`inferType` / `inferState` precision**: chitchat acknowledgements ("そうだね" / "ありがとう"), pasted terminal/git/email content, and meta-noise no longer classify as `decision` — they return `note` / `open` before pattern matching. The learning-layer default → `decision` is gated by this guard. Real decisions (採用 / 決めた, even after an acknowledgement opener) survive.

No schema migration, no breaking API changes. Existing rows keep their stored content; the classifier improvements apply to new captures going forward.

### v0.7.1 — Review fixes (2026-05-29)

Based on Opus 4.7 design review of v0.7.0:

- **P0 — Required params guidance**: `remember` tool description now includes "REQUIRED PARAMS BY MODE" section so LLMs know exactly which fields are needed for create vs update vs delete.
- **P0 — Migration guidance**: Deprecated tool names (`forget`, `recall_file`, etc.) now return specific migration examples instead of generic errors.
- **P1 — recall path+query merge**: When both `path` and `query` are provided to `recall`, results from file history and memory search are merged into a single response.
- **P2 — Auto-consolidate safety**: Table existence check via `sqlite_master` before querying `consolidations` table, preventing errors on fresh databases.

### v0.7.0 — 3-Tool Unified Surface (2026-05-29)

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
- `npx -y linksee-memory stats` — local DB summary CLI.

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
