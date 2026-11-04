# History: release notes, roadmap, articles

Moved out of the README on 2026-11-04 so its first screen fits on one screen. Back to the [README](../README.md).

## 📣 As featured on

- **Zenn**: [あなたの Claude Code、 実は前回のセッションを完全に忘れている](https://zenn.dev/kanseilink/articles/linksee-memory-claude-code-recall-20260508) — 73 ♡ on Zenn, **165+ users on Hatena Bookmark**, picked up by tech blogs + YouTube shorts (May 2026)
- **Zenn**: [あなたの MCP server、 実は Tools しか使ってない (5 blocks 全実装 / v0.3.0)](https://zenn.dev/kanseilink/articles/linksee-memory-mcp-five-blocks-20260507) — the 1% of MCP servers that implement all 5 blocks
- **Zenn**: [あなたの Claude memory、 実は Claude にしか残らない (5 LLM 横断する方法)](https://zenn.dev/kanseilink/articles/linksee-memory-claude-cross-llm-20260511) — cross-LLM memory pattern (May 12, 2026)
- **Zenn**: [Glama listing で 3 週間止まった話 (5 つの罠と解決策)](https://zenn.dev/michielinksee/articles/linksee-memory-mcp-publish-glama-traps-20260506) — npm + Glama deployment retrospective

> 「Cordex/Cursor/Code/Gemini 全部につなげられるから、 横断的にできてる MCP ってところがこれのすごいところ」
> — [Hatena Bookmark, May 2026](https://b.hatena.ne.jp/entry/s/zenn.dev/kanseilink/articles/linksee-memory-claude-code-recall-20260508) (165+ users)

---

## What's new in v0.17

| Feature | Detail |
|---|---|
| **`share_draft` (optional)** | When you ask to share how a SaaS / MCP / API connection got stuck and what fixed it, the agent fills fixed fields and gets back a link to a reviewed draft on KanseiLINK. **Linksee sends nothing** — you read the draft in your browser and only your click sends it. Anything that looks like a key, token, e-mail, tenant URL, IP or local path stops the link. See [Share a fix with other agents](../README.md#share-a-fix-with-other-agents-optional). |
| **MCP SDK 1.32.2** | `@modelcontextprotocol/sdk` raised to `^1.32.2`; `pnpm audit` 46 → 0. |

## What's new in v0.9

| Feature | Detail |
|---|---|
| **Re-injection guard** | The pre-action half of drift detection. A Claude Code `PreToolUse` hook re-surfaces (or, on a `hard` contradiction, blocks) an accepted decision *before* the agent runs `Edit`/`Write`/`Bash`; a `SessionStart` boot digest replays your locked decisions into each fresh session. Fail-open by design. See [Re-injection Guard](guard.md). |
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
| **3-tool unified surface** | At 0.7.0, eight tools became three (today there are 7 — see the README): `remember` (create + update + delete), `recall` (search + file history + overview), `read_smart` (token-saving reads). Fewer tools = better cross-LLM consistency. Follows Context7's proven pattern. |
| **Auto-consolidate** | Consolidation runs automatically on server startup (non-blocking, 7-day threshold). No manual `consolidate()` calls needed. *(Off by default since 0.17.1 — opt in with `LINKSEE_AUTO_CONSOLIDATE=1`.)* |
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

## Roadmap

- ✅ 3-tool unified surface (remember / recall / read_smart) — v0.7.0
- ✅ Auto-consolidate on server startup — v0.7.0 (opt-in since 0.17.1)
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

