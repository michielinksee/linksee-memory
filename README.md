# linksee-memory

> **Claude Code forgets everything when you start a new session. Your successor knows even less.**
>
> **Linksee Memory lets you hand a project over — to your next session, to Cursor or Codex, to the person after you — with the reasons attached.** Record a decision once (`remember({ content, anchor: {} })`) and it comes back *before* the agent acts on it: re-injected on session start and ahead of every Edit / Write / Bash that touches it. Change your mind on the record and it stops nagging; leave it and it keeps the next agent from repeating last week's mistake.
>
> Underneath: **drift detection** across every project you run in parallel — which ones quietly left their goal (🔴), which were checked and hold (🔵), which nobody has looked at yet (⚫). One local SQLite file that **Claude Code, Cursor, Windsurf, OpenAI Codex and Gemini CLI** all read. Nothing leaves your machine.
>
> `npx -y linksee-memory setup` — one command, on in every repo.

[![npm](https://img.shields.io/npm/v/linksee-memory.svg)](https://www.npmjs.com/package/linksee-memory)
[![license](https://img.shields.io/npm/l/linksee-memory.svg)](./LICENSE)
[![mcp-registry](https://img.shields.io/badge/MCP-Official_Registry-6366f1)](https://registry.modelcontextprotocol.io/)
[![glama-score](https://glama.ai/mcp/servers/michielinksee/linksee-memory/badges/score.svg)](https://glama.ai/mcp/servers/michielinksee/linksee-memory)

🌐 **Landing page**: [linksee.app](https://linksee.app) (includes non-developer onboarding for Claude Desktop / Cursor / Claude Code / OpenAI Codex / Gemini CLI)
📖 **Docs**: [docs.linksee.app](https://docs.linksee.app) — full reference: the product map & drift, install, and every tool

<!-- releases: tag-driven, published from CI via npm trusted publishing (OIDC).
     See .github/workflows/publish.yml — no token, no OTP, provenance attached automatically. -->

## Questions this answers

These are the questions people actually type — measured, verbatim (2026-09-04). If yours is here, this is the answer.

**Claude Code forgets everything when I start a new session. How do I make it remember decisions across sessions?**  
Run `npx -y linksee-memory setup`. Every new session opens with `recall()` — a brief of what needs attention, where you are, what's unresolved — and your locked decisions are re-injected before the agent acts. Nothing to re-explain.

**Claude Codeがセッションをまたぐと過去の経緯を忘れてしまいます。記憶を持たせる方法を教えてください。**  
`npx -y linksee-memory setup` の一回で入ります。新しいセッションは `recall()` の brief（注意すべきこと・いまどこか・未解決）から始まり、固定した決定は行動の直前に再注入されます。説明し直す必要はありません。

**What is the best MCP server for persistent memory across AI coding agents?**  
Honest answer: if "remember across sessions" is all you need, a `CLAUDE.md` is enough — we measured it. Linksee is for the three moments it isn't: right before a mistake, when you change your mind, and when you run many projects and need to see which one drifted.

**AIコーディングエージェント用の記憶MCPサーバーでおすすめはありますか？**  
正直に言うと、「セッションを跨いで覚える」だけなら `CLAUDE.md` で足ります（実測しました）。Linksee が要るのは、間違いかけたとき・方針を変えたとき・並行案件のどれが外れたかを知りたいとき、の3場面です。

**I want one shared memory between Claude Code, Cursor, and OpenAI Codex. What tools exist for that?**  
One SQLite file. Claude Code, Cursor, Windsurf, OpenAI Codex and Gemini CLI all read and write the same memory — a decision made in one shows up in the others.

**Claude CodeとCursorとCodexで同じ記憶を共有したいのですが、どうすればいいですか？**  
SQLite ファイル1つを全員で読みます。Claude Code / Cursor / Windsurf / Codex / Gemini CLI のどこで決めた決定も、他のエージェントの行動の直前に出てきます。

**My AI agent keeps re-implementing things we already decided against. How can I detect that a codebase has drifted from past decisions?**  
Declare the decision (`remember({ content, anchor: { violation_signal: [...] } })`). The guard then warns — or blocks, if you hardened it — the moment an edit contradicts it, and `drift_status` shows every decision that reality has quietly left.

**過去に決めた設計方針とコードがずれていないかを検出できるツールはありますか？**  
決定を宣言しておくと（`remember({ content, anchor: {...} })`）、それに反する編集の直前に警告（hardened なら拒否）が出ます。`drift_status` は「宣言と現実がずれた決定」を証拠つきで一覧します。

**Is there a local-first, self-hosted alternative to Mem0 for agent memory?**  
Yes. No account, no API key, no cloud — one local file, MIT licensed. `npx -y linksee-memory setup` and it's on.

**Mem0 vs Zep vs Letta for a coding agent's long-term memory — which should I pick?**  
We installed them and ran one scenario across all of them. Storing and recalling a decision: everyone passes. The difference appears *before a mistake* and *when you change your mind* — Linksee is built for those two moments; the others leave them to you.

**How do I stop Claude Code from repeating the same mistake it made last week?**  
Record it as a caveat (`remember({ content, layer: 'caveat' })`). Caveats are protected from forgetting and come back when the same ground is touched again — and if you anchor it, the guard stops the repeat before it lands.

**開発の意思決定履歴をMCPサーバーで残しておく定番のやり方はありますか？**  
`remember({ content, anchor: {} })` の1回で、記録と強制が同時に入ります。`drift_status` がその台帳で、各決定が いま守られているか（🔵）・ずれているか（🔴）・誰も確かめていないか（⚫）を示します。

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

`npx -y linksee-memory setup` wires this into `~/.claude/settings.json` (Step 4), so it is on in **every** repo — the same scope your memory already lives at. One SQLite file holds the anchors for all your projects; enforcing them per-repo meant declaring a decision once and having it enforced nowhere.

- `--project-guard` — this repo only, the old behaviour
- `--no-guard` — skip it

Anchors with `affects` globs fire only on matching paths; an unscoped anchor fires on its own `detect_terms` / `violation_signal`. Nothing is ever **blocked** unless you explicitly hardened it (`resolve_drift(action:'harden')`) — everything else re-injects the decision as context.

To wire it by hand instead, drop this block into `.claude/settings.json` (project root, or `~/.claude/settings.json` for every repo). The `npx -y` form below needs no install, but costs several seconds per call (7.4–8.6 s measured on Windows, close to the 8 s `PreToolUse` timeout — a timed-out guard simply does not fire). `setup` writes a direct `node` call instead; you can do the same with `"<path to node>" "<package>/dist/bin/guard-hook.js"` (paths quoted; Claude Code runs hooks through cmd.exe on Windows and sh elsewhere, and a path containing `$`, a backtick, `%` or `"` cannot be quoted safely — setup keeps the npx form for those):

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

Where it applies is the settings file it lives in: `~/.claude/settings.json` (what `setup` writes) covers every repo; a project's `.claude/settings.json` (`setup --project-guard`) covers that repo only. Declare what it should watch with `declare_anchor(...)`; set `card_policy.gate_mode:'hard'` on an anchor to make a contradiction **block** instead of just warn (the soft default only re-injects). Anchors that are stale (`at_risk`), superseded, or card-disabled never gate.

> Developing linksee-memory itself? The repo dogfoods the guard via a (gitignored) `.claude/settings.json` that points at the local build (`node ${CLAUDE_PROJECT_DIR}/dist/bin/guard-hook.js`) so it runs against your uncommitted changes. End-user projects should use the published `npx -y linksee-memory guard` form above.

---

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

Every memory is tagged with **exactly one layer**. `caveat`-layer entries are protected from auto-forgetting. Cold low-importance memories are auto-consolidated into `learning` entries on server startup.

---


## Quick Start — One Command

```bash
npx -y linksee-memory setup
```

This sets up **Claude Code**:
1. Registers the MCP server (`claude mcp add -s user linksee -- npx -y linksee-memory`)
2. Installs the agent skill (teaches the agent when to recall/remember)
3. Configures auto-capture — a `Stop` hook, so every session is saved to your local memory
4. Wires the [re-injection guard](#reinjection-guard) for every repo (`--project-guard` for this repo only, `--no-guard` to skip)

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
| `~/.linksee-memory/runtime/<version>/` | only when setup was run through `npx`: setup runs `npm install --prefix ~/.linksee-memory/runtime/<version> --no-save --omit=dev linksee-memory@<version>` once (the only network call, shown with its size), because the hooks call `node` on it directly and npx's cache is temporary. One version is kept; an older one is removed after the new one loads. If the install fails, the hooks stay on the npx form. |
| `~/.linksee-memory/telemetry-consent` | your telemetry answer (`off` unless you said yes) |

Running setup again changes nothing that is already in place. It rewrites only hooks it wrote itself: the exact `npx -y linksee-memory sync` / `npx -y linksee-memory guard` from earlier versions, and the direct form it writes now, which ends in `--linksee-managed`. Anything else that runs our scripts — a wrapper, a path you typed — is left alone and listed at the end of setup. With `--no-guard`, the guard hooks are not touched at all. If you later upgrade Node to a new major version, re-run setup (the guard prints that hint and lets the action through).

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
rm -rf ~/.linksee-memory   # deletes all stored memory — nothing is kept anywhere else
```

Nothing ever leaves your machine, so step 3 fully erases everything Linksee stored.

## What's new in v0.17

| Feature | Detail |
|---|---|
| **`share_draft` (optional)** | When you ask to share how a SaaS / MCP / API connection got stuck and what fixed it, the agent fills fixed fields and gets back a link to a reviewed draft on KanseiLINK. **Linksee sends nothing** — you read the draft in your browser and only your click sends it. Anything that looks like a key, token, e-mail, tenant URL, IP or local path stops the link. See [Share a fix with other agents](#share-a-fix-with-other-agents-optional). |
| **MCP SDK 1.32.2** | `@modelcontextprotocol/sdk` raised to `^1.32.2`; `pnpm audit` 46 → 0. |

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

## 7 Tools: six for memory and drift, one you ask for

Two pillars, one surface. **Memory** and **drift** each get the minimum; nothing else is exposed.
Eleven tools bled model-dependent behaviour across Claude / GPT / Cursor / Codex / Gemini — six
is what an agent can hold without a manual.

| Tool | What it does |
|---|---|
| `recall` | **Start here.** No arguments → the **session brief**: what needs attention, where you are on the Map, open loops, top entities. `query` → search; `path` → a file's edit history with the user intent behind each edit; `where: "<topic>"` → your position on the Current Truth Map + blast radius; `dream: true` → the triage session (North Star, orphaned proposals, distill queue, friction). |
| `remember` | **Save / update / delete.** `content` is the only required field — entity and layer default to the project you're in. Add `anchor: {}` to record a decision **and** enforce it in one call (re-injected before Edit/Write/Bash and on session start). |
| `read_smart` | **Token-saving file reader** with AST diff caching. Re-read unchanged = ~50 tokens; modified = changed chunks only. |
| `drift_status` | **"What's drifting right now?"** The truth map: 🔴 drift / 🟡 review / ⚪ held / 🔵 verified / ⚫ unverified, with the evidence for each. `anchor_id` → deep-dive into one decision. |
| `declare_anchor` | **Record a normative claim** — `decision` / `prohibition` / `constraint` the detector checks against reality, or `proposal`: an option you presented that the user never addressed, parked as a review item. |
| `resolve_drift` | **Close the loop.** `fix` · `supersede` · `acknowledge` · `dismiss` (with `hit_term`, and the gate stops firing on it) · `harden` / `soften`. With `candidate_id`: `surface` or `dismiss` an orphaned proposal. |

The five earlier names — `where_am_i`, `check_decision`, `flag_proposals`, `dream`,
`resolve_proposal` — are folded into the six above. They are hidden from `tools/list` but **still
answer if called**, so a skill or agent written against an older version keeps working.
`LINKSEE_LEGACY_TOOLS=1` lists them.

One more tool sits outside the memory/drift surface and does nothing unless the user asks:
`share_draft` — builds a link to a reviewed draft of a fix for other agents. See
[Share a fix with other agents](#share-a-fix-with-other-agents-optional).

### CLI utilities

| Command | Purpose |
|---|---|
| `npx -y linksee-memory setup` | One-command setup: MCP server + skill + Stop hook + the re-injection guard for every repo (`--project-guard` for this repo only, `--no-guard` to skip). Idempotent — skips what's already done. |
| `npx linksee-memory` | MCP server (stdio) |
| `npx -y linksee-memory sync` | Claude Code Stop-hook entry point |
| `npx -y linksee-memory guard` | Re-injection guard hook: `PreToolUse` gate (`Edit`/`Write`/`Bash`) + `SessionStart` boot digest. Wired by `setup` for every repo (see [Re-injection Guard](#reinjection-guard)); fail-open. |
| `npx -y linksee-memory import` | Batch-import Claude Code session JSONL history |
| `npx -y linksee-memory install-skill` | Install the Claude Code Skill that teaches the agent when to call recall/remember/read_smart |
| `npx -y linksee-memory stats` | Summary of the local DB (entity count / layer breakdown / top entities / top edited files). Add `--json` for machine-readable output. |
| `npx -y linksee-memory share-draft --help` | Print a link to a reviewed draft of a fix (same checks as the `share_draft` tool). Sends nothing. |

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
- ✅ Landing page ([linksee.app](https://linksee.app))
- ✅ Drift detection engine + 4 MCP drift tools — v0.8.0
- ✅ 4-species truth map (hypothesis/constraint/commitment/source_of_truth) — v0.8.0
- ✅ Dashboard with Decision Register visualization
- ✅ `share_draft`: share a fix as a reviewed link, never a send — v0.17.0
- 🔮 Obsidian plugin (read truth map in your vault)
- 🔮 Vector search via `sqlite-vec` (already in deps, embedding backend pending)
- 🔮 Cross-device cloud sync (Pro tier)

## Comparison with Claude Code auto-memory

Claude Code ships a built-in memory feature at `~/.claude/projects/<path>/memory/*.md` — flat markdown notes for user preferences. linksee-memory **complements** it:

- auto-memory = your scrapbook of "remember I prefer X"
- linksee-memory = structured cross-agent brain with file diff cache and per-edit WHY

Use both.

## Share a fix with other agents (optional)

When an agent gets stuck connecting to a SaaS / MCP / API and gets it working (or doesn't), the
user can choose to share what happened so the next agent does not repeat it.

- **What happens:** the agent calls `share_draft` with fixed fields — `service`, `task`, `symptom`,
  `tried`, `result`, optional `conditions`, `kind` (`execution` / `documentation` / `hypothesis`),
  `runtime`. Linksee checks them and returns **a link** to KanseiLINK's draft page
  (`https://kansei-link.com/agents/note/new.html`). The page opens with the fields filled; the user
  reads them, and only their click on that page sends anything.
- **What never goes in:** free text outside those fields, or anything that looks like a key, token,
  JWT, `Bearer` value, e-mail, tenant URL (`acme.slack.com`), IP address, local path
  (`C:\`, `/Users/`, `/home/`) or a long hex / base64 run. Any of these stops the build and names the
  field — no link is made. The whole URL must fit in 2,000 characters; Linksee asks you to shorten
  rather than cut. The URL passes through KanseiLINK's request logs (Cloudflare), so keep secrets out.
- **What Linksee keeps:** one row saying a draft was made, with the time — no field text.
- **How to turn it off:** don't use it. The tool is only called when the user asks to share;
  nothing is sent, suggested or filled from your memory automatically.

<details>
<summary>日本語</summary>

SaaS・MCP・API の接続で詰まって直った（または直らなかった）とき、利用者が望めば、次のエージェントが同じ所で詰まらないよう共有できます。

- **起きること:** エージェントが決まった欄（`service`・`task`・`symptom`・`tried`・`result`・任意の `conditions`・`kind`・`runtime`）で `share_draft` を呼ぶと、Linksee は欄を検査して、KanseiLINK の下書きページへの **リンクを返すだけ** です。開くと欄が埋まった画面が出て、人が確かめてから、そのページで押した時だけ送られます。
- **入らない物:** 決まった欄の外の自由文。キー・トークン・JWT・`Bearer` の値・メールアドレス・テナントの URL（`acme.slack.com`）・IP アドレス・PC の中の道（`C:\`・`/Users/`・`/home/`）・長い 16 進や base64 の塊。どれかがあれば、リンクは作らず、どの欄かを返します。URL 全体は 2,000 字まで。超えたら削らずに「短くしてください」と返します。URL の中身は KanseiLINK の通信の記録（Cloudflare）を通るので、秘密は入れないでください。
- **Linksee に残る物:** 「下書きを作った」ことと時刻だけ。欄の中身は残しません。
- **止め方:** 使わなければ何も起きません。利用者が共有したいと言った時だけ使う道具で、自動の送信・提案・記憶からの書き込みはありません。

</details>

## Security & privacy

linksee-memory runs locally and is built to read — and send — as little as possible.

- **Local-first.** Memory is one SQLite file at `~/.linksee-memory/memory.db`. No account, no cloud, no API key.
- **Telemetry is opt-in and OFF by default.** `setup` asks once; nothing is sent unless you agree there (or set `LINKSEE_TELEMETRY=basic`). Even then it never sends your source code, file contents, prompts, conversation, entity/project names, or the memory DB — only anonymous counters ([details](#telemetry-opt-in-off-by-default)).
- **No automatic repo crawling.** linksee reads: memory you explicitly save, your `map.yaml`, the specific files a map reality-check points at, the local SQLite DB, and — when the Stop hook fires — your Claude Code session transcript (locally, to capture what happened). It does **not** crawl your repo, read `.env`/secrets/`node_modules`, or touch your home directory on its own.
- **`share_draft` makes a link only; Linksee itself never sends it.** The user opens it and decides ([details](#share-a-fix-with-other-agents-optional)).
- **Clean MCP transport.** The server writes only JSON-RPC to stdout; all logs go to stderr.
- **Hooks are documented and removable.** `setup` adds a Stop hook (session capture) and an optional guard hook. They make no network calls by default, are time-bounded, fail-open (a hook error never breaks your session), and are listed under [Uninstall](#uninstall).
- **No shell-injection surface.** Subcommands run via `spawn` with array args and `shell: false`, from a fixed allowlist; `map.yaml` is parsed with the safe `yaml` parser (no arbitrary tag execution).
- **Supply chain.** MIT, published from a single owner. `npx -y linksee-memory` runs the published package — pin a version in CI if you need reproducibility.

Found a security issue? See [SECURITY.md](SECURITY.md).

## Telemetry (opt-in, off by default)

linksee-memory ships with **opt-in** anonymous telemetry that helps us understand which MCP servers and workflows actually work in the wild. **Nothing is sent unless you explicitly enable it.** No conversation content, no file content, no entity names, no project paths — ever.

### Enable

```bash
export LINKSEE_TELEMETRY=basic     # opt in
export LINKSEE_TELEMETRY=off       # opt out (or just unset the variable)
# `linksee-memory setup` also asks once and records your choice in
# ~/.linksee-memory/telemetry-consent (delete that file to be asked again).
```

### Exactly what gets sent (Level 1 contract)

After each Claude Code session ends, the Stop hook sends one POST to `https://linksee-site.vercel.app/api/telemetry/linksee` containing only these fields:

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
- **Claude Desktop**: add to `claude_desktop_config.json` (see [onboarding on the LP](https://linksee.app))
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

See [CHANGELOG.md](./CHANGELOG.md) for every release, and [GitHub Releases](https://github.com/michielinksee/linksee-memory/releases).

## License

MIT — Synapse Arrows PTE. LTD.
