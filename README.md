# linksee-memory

A local MCP memory server: one SQLite file on your machine that Claude Code, Cursor, Windsurf, OpenAI Codex and Gemini CLI all read and write. No account, no credit card, no cloud, no API key. The server makes no network calls; telemetry is opt-in and off by default.

It is for handing a project over — to your next session, to another client, to the person after you — with the reasons attached. Every client can save and search the memory. In Claude Code, hooks also bring a recorded decision back at session start and before an edit. Drift detection shows which recorded decisions the code has since left.

Needs Node.js 22.16 or later (recommended: SQLite with FTS5 is built into Node, nothing is compiled), and Claude Code or Codex to try it (either one is enough). Node 20 and Node 22.0–22.15 still work through `better-sqlite3`, which then has to be built on install — on npm 12 that means allowing its install script (see [troubleshooting](docs/troubleshooting.md)).

## Install

Claude Code, from inside a session (plugin: MCP server and skill, no hooks):

```text
/plugin marketplace add michielinksee/linksee-memory
/plugin install linksee-memory@linksee-memory
```

Or from a shell, which also installs the hooks:

```bash
npx -y linksee-memory setup                       # Claude Code: MCP server, skill, hooks
codex mcp add linksee -- npx -y linksee-memory    # Codex: the same memory
```

The plugin starts the server with `npx -y linksee-memory@latest` and ships the same skill `setup` installs. It has no hooks: the Stop hook (auto-capture) and the [re-injection guard](docs/guard.md) come only from `setup`. One or the other, not both:

- Already ran `setup`? Do not add the plugin. With both, Claude Code runs the server twice (`linksee` and `plugin:linksee-memory:linksee`).
- Installed the plugin and want the hooks? Disable it (`/plugin` → Installed → linksee-memory → disable, or `claude plugin disable linksee-memory@linksee-memory`), then run `npx -y linksee-memory setup`. The memory file is the same; nothing is lost.
- Plugin only: no hooks, so nothing is saved unless the agent calls `remember` (the skill tells it when).
- Windows: after installing the plugin, run `/mcp` and check that `plugin:linksee-memory:linksee` is connected. If it is not, disable the plugin first (previous bullet), then run `npx -y linksee-memory setup` from the shell block above. `setup` registers the server with `claude mcp add`, the form that is known to work on Windows, and it does not disable the plugin for you.

One command for Claude Code. `setup --dry-run` prints what it would change. It edits `~/.claude/settings.json`, so the hooks apply in every repo, and keeps the old file as `settings.json.bak-<timestamp>` ([what it writes](#what-setup-writes)).

## First round trip

A new install has an empty memory, so "how did we solve this before?" finds nothing yet. Try this instead:

1. In Claude Code or Codex, say: *"Remember: in this repo we decided to use X, because Y. Use Linksee."*
2. Open a **new** session — in either one — and ask: *"What did we decide about X? Use Linksee."*
3. Two repos: record a decision in repo A, then in repo B (e.g. Codex) ask the same. It **does** come back — the memory is per machine, not per repo — labelled `entity: repo-a` and `by: <client>`; `entity_name` on the recall narrows by a part of the entity name (`repo-a` also matches `repo-a-backup`).
4. Reverse it: `remember` the new decision with `supersedes: <old memory_id>`. `recall` then shows only the new one (`supersedes #<id>`); `include_superseded: true` shows both.

## Works for me

Where the [first round trip](#first-round-trip) is known to work. Most cells are empty because nobody has tried them yet, not because they fail.

| Client | Windows | macOS | Linux |
|---|---|---|---|
| Claude Code | verified | reported | untested |
| Codex | untested | untested | untested |
| Cursor | untested | untested | untested |
| Windsurf | untested | untested | untested |
| Gemini CLI | untested | untested | untested |

- **verified**: run by the maintainer with a record. Claude Code on Windows: remember in one session, recall in a new one, on 0.18.1 ([record](docs/works-for-me/claude-code-windows-2026-11-06.md)). The plugin install path connected on 2026-11-05; its round trip is not in the record.
- **reported**: someone said it works, without a version or log. Claude Code on macOS: the maintainer on one Mac ([#16](https://github.com/michielinksee/linksee-memory/discussions/16)); the hooks there are not checked.
- **untested**: nobody has reported it either way.

If you fill one cell, your name goes in the weekly report under "Added by others". [Report your client and OS](https://github.com/michielinksee/linksee-memory/issues/new?template=works-for-me.yml) — five fields, no database contents.

Weekly report: [Discussion #16](https://github.com/michielinksee/linksee-memory/discussions/16).

## What it does not do

- Reminders and blocks before an edit are Claude Code hooks. Cursor, Windsurf, Codex and Gemini CLI share the memory but get no warning before an edit.
- Saving every session automatically is also Claude Code only. Other clients save when the agent calls `remember`.
- The memory is shared on one machine. There is no sync to another machine; to hand it over, copy `~/.linksee-memory/` (with every client closed).
- A database from a very early version (schema 1–5) is refused without being changed. Close every client and keep them closed while it runs, then `npx -y linksee-memory@0.17.2 migrate --dry` and `npx -y linksee-memory@0.17.2 migrate`: it migrates a copy and moves the original files, as one set, into `memory.db.pre-migrate-<time>/` ([details and how to go back](docs/troubleshooting.md)).

[![npm](https://img.shields.io/npm/v/linksee-memory.svg)](https://www.npmjs.com/package/linksee-memory)
[![license](https://img.shields.io/npm/l/linksee-memory.svg)](./LICENSE)
[![mcp-registry](https://img.shields.io/badge/MCP-Official_Registry-6366f1)](https://registry.modelcontextprotocol.io/)
[![glama-score](https://glama.ai/mcp/servers/michielinksee/linksee-memory/badges/score.svg)](https://glama.ai/mcp/servers/michielinksee/linksee-memory)

Docs: [docs.linksee.app](https://docs.linksee.app) · Site: [linksee.app](https://linksee.app) (setup guides for non-developers) · Free, MIT, local only — there is no paid tier you need.

<!-- releases: tag-driven, published from CI via npm trusted publishing (OIDC).
     See .github/workflows/publish.yml — no token, no OTP, provenance attached automatically.
     The same tag push also publishes server.json to the official MCP registry
     (io.github.michielinksee/linksee-memory), after npm succeeds: a pinned, Sigstore-verified
     mcp-publisher runs validate → login github-oidc → publish. A dry run stops at validate. If the
     registry step fails, npm is already published and the job goes red with a notice — then publish
     by hand from the tagged commit: `mcp-publisher login github` → `mcp-publisher publish`. -->

<a id="what-setup-writes"></a>

## What setup writes, and how to undo it

`setup` registers the MCP server (`claude mcp add -s user linksee -- npx -y linksee-memory`), installs the agent skill, adds a `Stop` hook that saves each session, and wires the [re-injection guard](docs/guard.md) for every repo (`--project-guard` for this repo only, `--no-guard` to skip). Running it again changes nothing that is already in place.

| File | What |
|---|---|
| `~/.claude.json` | the `linksee` MCP server (via `claude mcp add`) — undo with `claude mcp remove linksee` |
| `~/.claude/skills/linksee-memory/SKILL.md` | the agent skill |
| `~/.claude/settings.json` | the `Stop` hook (auto-capture) and the `SessionStart` / `PreToolUse` guard hooks. Merged into what is there — other hooks and settings are kept. If the file does not parse, setup leaves it untouched and says so. Before changing it, setup keeps the previous file as `settings.json.bak-<timestamp>`: to undo, copy that file back over `settings.json`. |
| `~/.linksee-memory/runtime/<version>/` | only when setup ran from a temporary location (`npx`, `pnpm dlx`, `bunx`, or the system temp directory): setup runs `npm install --prefix ~/.linksee-memory/runtime/<version> --no-save --omit=dev linksee-memory@<version>` once (shown with its size; this downloads from the npm registry), because the hooks call `node` on it directly and those locations are temporary. Older versions are not removed automatically (about 35 MB each): setup prints the folder, and `npx -y linksee-memory runtime prune` lists them with what references each. With `--yes --scope-confirmed` it deletes only versions no settings file references; it cannot see other repos where you ran `setup --project` (pass their `.claude/settings.json` with `--settings`), and if a settings file cannot be read or parsed it deletes nothing. If the install fails, the hooks stay on the npx form. |
| `~/.linksee-memory/telemetry-consent` | your telemetry answer (`off` unless you said yes) |

To remove everything: `claude mcp remove linksee`, delete the linksee hooks from `settings.json` (or copy the `.bak` back), then `rm -rf ~/.claude/skills/linksee-memory ~/.linksee-memory` — the last one deletes the memory stored in that folder. It does not reach copies you made yourself (for example to hand the memory over) or telemetry already sent if you opted in. Linksee itself never sends memory text anywhere. Step by step, with manual setup: [docs/install.md](docs/install.md).

**Sessions that should not be captured.** Set `LINKSEE_NO_CAPTURE=1` in the environment of a session you do not want in memory — scripted or headless maintenance runs, for example (`LINKSEE_NO_CAPTURE=1 claude -p "…"`). The Stop hook then exits without writing anything (no rows, no `hook.log` line, no telemetry) and prints one line on stderr. The guard hooks and the MCP tools are not affected: `remember` called by the agent still saves.

## Other clients

Every client points at the same stdio command and the same `~/.linksee-memory/memory.db`. A decision made in Claude Code is recalled in Cursor.

| Client | Where |
|---|---|
| OpenAI Codex | `codex mcp add linksee -- npx -y linksee-memory` |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Gemini CLI | `~/.gemini/settings.json` |
| Claude Desktop | `claude_desktop_config.json` |

The JSON clients take the same block:

```json
{ "mcpServers": { "linksee": { "command": "npx", "args": ["-y", "linksee-memory"] } } }
```

Full configs, including Codex's `config.toml`: [docs/install.md](docs/install.md#other-editors--clis).

## Everyday use

| Say this | What happens |
|---|---|
| **"use linksee"** | Recalls relevant memories before acting |
| **"linksee this"** | Saves the decision or lesson now |
| **"what's drifting?"** | Checks reality against the decisions you recorded |

Adding **"Use Linksee Memory"** to your system prompt or `CLAUDE.md` prompts the agent to call `recall` more often; whether it does is still up to the agent.

What each part does, and where:

- **Shared (every client):** `remember` saves to the one SQLite file; `recall` searches it when the agent calls it.
- **Re-injected (Claude Code only, hooks):** `remember({ content, anchor: {} })` also records the decision as an anchor. At session start the guard hook adds a short digest of recorded decisions (up to 8). Before an `Edit` / `Write` / `Bash`, a decision comes back only if it matches: with `affects` globs, the edited path must match (a `Bash` command that names no file can still match on a `violation_signal`); without `affects`, a `detect_terms` or `violation_signal` hit is needed. An empty `anchor: {}` has none of these, so it appears only in the session-start digest, never before an edit.
- **Contradiction warned or blocked (Claude Code only):** the guard can only tell that an edit contradicts a decision if you give it the strings that mean "contradiction": `anchor: { violation_signal: ["pgvector"] }`. An empty `anchor: {}` is stored as a constraint and is re-injected, never matched as a contradiction. A match warns; after `resolve_drift(action: "harden")` it blocks. The guard fails open: its own errors never block anything. Details: [docs/guard.md](docs/guard.md).

## Tools: seven, six for memory and drift and one you ask for

Three for memory, three for drift, and `share_draft`, which runs only when the user asks.
Earlier versions exposed more, and how agents used them varied from model to model; six is what
an agent can hold without a manual.

| Tool | What it does |
|---|---|
| `recall` | **Start here.** No arguments → the **session brief**: what needs attention, where you are on the Map, open loops, top entities. `query` → search; `path` → a file's edit history with the user intent behind each edit; `where: "<topic>"` → your position on the Current Truth Map + blast radius; `dream: true` → the triage session (North Star, orphaned proposals, distill queue, friction). |
| `remember` | **Save / update / delete.** `content` is the only required field — entity and layer default to the project you're in. Add `anchor: {}` to also record it as a decision (in Claude Code, re-injected on session start and before a matching Edit/Write/Bash); add `violation_signal` to it so a contradicting edit can be detected. `supersedes: <id>` replaces an older memory of the same entity (recall hides the old one). |
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

**CLI**

| Command | Purpose |
|---|---|
| `npx -y linksee-memory setup` | One-command setup: MCP server + skill + Stop hook + the re-injection guard for every repo (`--project-guard` for this repo only, `--no-guard` to skip). Idempotent — skips what's already done. |
| `npx linksee-memory` | MCP server (stdio) |
| `npx -y linksee-memory sync` | Claude Code Stop-hook entry point |
| `npx -y linksee-memory guard` | Re-injection guard hook: `PreToolUse` gate (`Edit`/`Write`/`Bash`) + `SessionStart` boot digest. Wired by `setup` for every repo (see [Re-injection Guard](docs/guard.md)); fail-open. |
| `npx -y linksee-memory import` | Batch-import Claude Code session JSONL history |
| `npx -y linksee-memory install-skill` | Install the Claude Code Skill that teaches the agent when to call recall/remember/read_smart |
| `npx -y linksee-memory stats` | Summary of the local DB (entity count / layer breakdown / top entities / top edited files). Add `--json` for machine-readable output. |
| `npx -y linksee-memory share-draft --help` | Print a link to a reviewed draft of a fix (same checks as the `share_draft` tool). Sends nothing. |

## Drift and the product map

Drift is a recorded decision that the code has quietly left — last week you chose FTS5 over vector search, this week a new session installs `pgvector`. `drift_status` lists each decision as 🔴 drift, 🟡 review, ⚪ held, 🔵 verified or ⚫ unverified, with evidence. A change you recorded as `fix` or `supersede` stays quiet; only unaccounted gaps are flagged.

`linksee-memory map` lifts this to the whole product: a `map.yaml` of how the pieces fit, checked against the code with file:line evidence.

![linksee-memory map catching doc/code drift in 30 seconds](demo/where-demo.gif)

In the demo the README promises `--export` and the code does not implement it; the map flags it and lists what else a change would touch.

```bash
npx -y linksee-memory map where README.md   # which map node this file belongs to, and what it touches
npx -y linksee-memory map explain readme    # why the node is in its state, with evidence
npx -y linksee-memory map affects readme    # what else a change here must move
```

States, resolutions, the four species and the full map CLI: [docs/drift-and-map.md](docs/drift-and-map.md).

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

## Security and privacy

linksee-memory runs locally and is built to read — and send — as little as possible.

- **Local-first.** Memory is one SQLite file at `~/.linksee-memory/memory.db`. No account, no cloud, no API key.
- **Telemetry is opt-in and OFF by default.** `setup` asks once; nothing is sent unless you agree there (or set `LINKSEE_TELEMETRY=basic`). Even then it never sends your source code, file contents, prompts, conversation, entity/project names, or the memory DB — only anonymous counters ([details](docs/telemetry.md)).
- **No automatic repo crawling.** linksee reads: memory you explicitly save, your `map.yaml`, the specific files a map reality-check points at, the local SQLite DB, and — when the Stop hook fires — your Claude Code session transcript (locally, to capture what happened). It does **not** crawl your repo, read `.env`/secrets/`node_modules`, or touch your home directory on its own.
- **`share_draft` makes a link only; Linksee itself never sends it.** The user opens it and decides ([details](#share-a-fix-with-other-agents-optional)).
- **Clean MCP transport.** The server writes only JSON-RPC to stdout; all logs go to stderr.
- **Hooks are documented and removable.** `setup` adds a Stop hook (session capture) and the guard hooks (skip them with `--no-guard`). They send nothing unless you opted in to telemetry (then the Stop hook posts one set of counters per session). Hooks written in the `npx -y` form — the fallback when setup cannot write a direct `node` call — start npm, which checks the registry. They are time-bounded, fail-open (a hook error never breaks your session), and are listed under [Uninstall](docs/install.md#uninstall).
- **No shell-injection surface.** Subcommands run via `spawn` with array args and `shell: false`, from a fixed allowlist; `map.yaml` is parsed with the safe `yaml` parser (no arbitrary tag execution).
- **Supply chain.** MIT, published from a single owner. `npx -y linksee-memory` runs the published package — pin a version in CI if you need reproducibility.

Found a security issue? See [SECURITY.md](./SECURITY.md).

Every telemetry field, and what is never sent: [docs/telemetry.md](docs/telemetry.md).

## Questions this answers

These are the questions people actually type — measured, verbatim (2026-09-04). If yours is here, this is the answer.

**Claude Code forgets everything when I start a new session. How do I make it remember decisions across sessions?**  
Run `npx -y linksee-memory setup`. In Claude Code, each new session starts with a short digest of your recorded decisions and open items, injected by the SessionStart hook; the agent can call `recall()` (no arguments) for the full brief — what needs attention, where you are, what's unresolved. Decisions whose paths or terms an edit touches come back before that edit.

**Claude Codeがセッションをまたぐと過去の経緯を忘れてしまいます。記憶を持たせる方法を教えてください。**  
`npx -y linksee-memory setup` の一回で入ります。Claude Code では、新しいセッションの最初に SessionStart フックが記録済みの決定と未解決の要約を差し込みます。全体の brief（注意すべきこと・いまどこか・未解決）は、エージェントが `recall()` を引数なしで呼んだときに出ます。編集が決定の対象のパスや語に触れると、その編集の直前にも出ます。

**What is the best MCP server for persistent memory across AI coding agents?**  
Honest answer: if "remember across sessions" is all you need, a `CLAUDE.md` is enough — we measured it. Linksee is for the three moments it isn't: right before a mistake, when you change your mind, and when you run many projects and need to see which one drifted.

**AIコーディングエージェント用の記憶MCPサーバーでおすすめはありますか？**  
正直に言うと、「セッションを跨いで覚える」だけなら `CLAUDE.md` で足ります（実測しました）。Linksee が要るのは、間違いかけたとき・方針を変えたとき・並行案件のどれが外れたかを知りたいとき、の3場面です。

**I want one shared memory between Claude Code, Cursor, and OpenAI Codex. What tools exist for that?**  
One SQLite file. Claude Code, Cursor, Windsurf, OpenAI Codex and Gemini CLI all read and write the same memory — a decision recorded in one can be recalled in the others. Only Claude Code brings it back automatically before an edit (hooks).

**Claude CodeとCursorとCodexで同じ記憶を共有したいのですが、どうすればいいですか？**  
SQLite ファイル1つを全員で読み書きします。Claude Code / Cursor / Windsurf / Codex / Gemini CLI のどこで記録した決定も、他のクライアントから `recall` で引けます。行動の直前に自動で出るのは Claude Code だけです（フックのため）。

**My AI agent keeps re-implementing things we already decided against. How can I detect that a codebase has drifted from past decisions?**  
Declare the decision (`remember({ content, anchor: { violation_signal: [...] } })`). In Claude Code the guard then warns — or blocks, if you hardened it — the moment an edit contradicts it, and `drift_status` shows every decision that reality has quietly left.

**過去に決めた設計方針とコードがずれていないかを検出できるツールはありますか？**  
決定を「反したと分かる語」つきで宣言しておくと（`remember({ content, anchor: { violation_signal: [...] } })`）、Claude Code ではそれに反する編集の直前に警告（hardened なら拒否）が出ます。`drift_status` は「宣言と現実がずれた決定」を証拠つきで一覧します。

**Is there a local-first, self-hosted alternative to Mem0 for agent memory?**  
Yes. No account, no API key, no cloud — one local file, MIT licensed. `npx -y linksee-memory setup` and it's on.

**Mem0 vs Zep vs Letta for a coding agent's long-term memory — which should I pick?**  
We installed them and ran one scenario across all of them. Storing and recalling a decision: everyone passes. The difference appears *before a mistake* and *when you change your mind* — Linksee is built for those two moments; the others leave them to you.

**How do I stop Claude Code from repeating the same mistake it made last week?**  
Record it as a caveat (`remember({ content, layer: 'caveat' })`). Caveats are protected from forgetting and come back when `recall` touches the same ground again. To have Claude Code stop the repeat before it lands, record it as an anchor with a `violation_signal`, then harden it (`resolve_drift(action: "harden")`); without hardening, a match only warns.

**Does Linksee delete old memories on its own?**
Not since 0.18.1. Earlier versions had a "sleep" pass (`consolidate`) that folded cold memories into a short summary and deleted the originals — on the maintainer's own database it removed 1,360 rows on 2026-10-29 and 559 on 2026-11-05 without saying so. Now the only thing that removes a memory row is `remember({ memory_id, forget: true })`, by request — the Stop-hook re-import only adds rows (never touches ones it already wrote) and the start-up triage leaves caveats and protected rows alone. (Before importing, the normal schema migration runs; it can raise `protected` from 0 to 1 for rows with importance ≥ 0.9 and fill columns an older schema lacks, but it does not change a memory's text, relations or verdicts.) Consolidation still exists, by hand (`npx -y linksee-memory consolidate --dry-run` to see, `--apply` to fold) or opt-in at start-up (`LINKSEE_AUTO_CONSOLIDATE=1`); it writes one summary per cluster and marks the originals `consolidated_into`, which `recall` hides by default (`consolidated_hidden` says how many; `include_consolidated: true` shows them). Rows that an earlier version deleted come back only from a backup of `~/.linksee-memory/`.

**Linksee は古い記憶を勝手に消しますか？**
0.18.1 からは消しません。それ以前の版には「睡眠中の整理」（`consolidate`）があり、冷えた記憶を短い要約に畳んで原本を削除していました（開発者自身の DB で 2026-10-29 に 1,360 行、2026-11-05 に 559 行が、知らせも無く消えています）。いまは `remember({ memory_id, forget: true })` で頼んだ 1 行以外、記憶の行を消す処理はありません（Stop フックの再取り込みは追記だけで既存の行に触らず、起動時の整理は caveat と保護行に触りません。取り込みの前に通常の schema 移行が走り、保護フラグの補正（importance 0.9 以上の行の protected を 0→1 にする方向だけ）と旧 schema の列補完が起き得ますが、記憶の本文・関係・判定は変えません）。整理そのものは残っています。手で回す（`npx -y linksee-memory consolidate --dry-run` で中身を見て、`--apply` で畳む）か、起動時に走らせたい時だけ `LINKSEE_AUTO_CONSOLIDATE=1` を付けます。畳んだ原本には `consolidated_into` が付いて残り、`recall` は既定でそれを隠して件数（`consolidated_hidden`）だけ返します（`include_consolidated: true` で出ます）。前の版が消した行は、`~/.linksee-memory/` のバックアップからしか戻りません。

**開発の意思決定履歴をMCPサーバーで残しておく定番のやり方はありますか？**  
`remember({ content, anchor: {} })` の1回で、記録と決定の登録が同時に入ります（Claude Code では再注入も）。反する編集で警告を出すには `violation_signal` を足し、拒否まで行うにはさらに `resolve_drift(action: "harden")` で hard にします。`drift_status` がその台帳で、各決定が いま守られているか（🔵）・ずれているか（🔴）・誰も確かめていないか（⚫）を示します。

## More

- [docs/README.md](docs/README.md) — index of the pages moved out of this README
- [Troubleshooting and FAQ](docs/troubleshooting.md) — skill not firing, Stop hook not recording, recall too long, resetting, DB size
- [How the memory is built](docs/memory.md) — the six layers, `read_smart` token savings, SQLite layout, comparison with Mem0 / Letta / Zep and Claude Code auto-memory
- [History](docs/history.md) — release highlights, roadmap, articles about the project
- [CHANGELOG.md](./CHANGELOG.md) — every release · [GitHub Releases](https://github.com/michielinksee/linksee-memory/releases)

## Support and license

- Issues: [github.com/michielinksee/linksee-memory/issues](https://github.com/michielinksee/linksee-memory/issues) (feature requests: the `enhancement` label)
- Security: [SECURITY.md](./SECURITY.md), or a private advisory on GitHub
- MIT — Synapse Arrows PTE. LTD. (Singapore)

<!-- Old section links, kept so deep links still land somewhere. -->
<a id="the-map"></a>The Map moved to [docs/drift-and-map.md](docs/drift-and-map.md).
<a id="reinjection-guard"></a>Re-injection Guard moved to [docs/guard.md](docs/guard.md).
<a id="uninstall"></a>Uninstall moved to [docs/install.md](docs/install.md#uninstall).
<a id="telemetry-opt-in-off-by-default"></a>Telemetry moved to [docs/telemetry.md](docs/telemetry.md).
<a id="other-editors--clis"></a>Other editors / CLIs moved to [docs/install.md](docs/install.md#other-editors--clis).
<a id="database-location"></a>Database location moved to [docs/install.md](docs/install.md#database-location).
<a id="architecture"></a>Architecture moved to [docs/memory.md](docs/memory.md#architecture).
<a id="troubleshooting"></a>Troubleshooting moved to [docs/troubleshooting.md](docs/troubleshooting.md#troubleshooting).
<a id="faq"></a>FAQ moved to [docs/troubleshooting.md](docs/troubleshooting.md#faq).
