---
name: linksee-memory
description: |
  The bridge to the agent's "past self". Before any new task, file edit, decision, or right after a failure, recall past caveats (pain records) / learnings (growth log) / implementation history from linksee-memory.
  This is the only way to solve Claude Code's "memory amnesia every session" problem. The "never repeat the same mistake" mechanism that Mem0 / Letta / Zep can't provide.
  エージェントの「過去の自分」への橋。新しい作業・ファイル編集・意思決定・失敗の前後で、linksee-memory から過去の caveat（痛みの記録）/ learning（成長ログ）/ implementation（成功失敗）を recall する。

  ALWAYS use this skill at the following moments / 以下のタイミングで必ずこのスキルを使うこと:
  ① Task start / new task begins — "let's implement...", "let's start", "build a new...", 「実装しよう」「始めよう」「新しく〜作る」
  ② Before editing a file — same file may have been touched before / 同じファイルを過去に触ってる可能性がある
  ③ The moment an error/failure happens — remember as caveat / エラー・失敗した瞬間
  ④ The moment something succeeds or is learned — remember as learning / 成功した瞬間・学んだ瞬間
  ⑤ When the user says "before", "earlier", "last time", "same as", "remember?", "remember this" / 「前に」「同じ」「覚えてる？」「覚えておいて」
  ⑥ When asked "why did we do that", "when was this decided", "where did we discuss this" / 「なぜそうした」「いつ決めた」「どこで議論した」
  ⑦ Returning from another project / switching sessions / 別プロジェクトから戻ってきたとき

  Triggers (EN): remember/recall/forget/memory/before/earlier/last time/previously/remember when/same as before/history
  Triggers (JP): 記憶/覚えて/忘れて/過去/前回/前に/そういえば/覚えてる
  Error keywords (EN): failed/broken/stuck/error/bug/doesn't work/not working/same error again/again/repeated/debug
  Error keywords (JP): 失敗/エラー/うまくいかない/ハマった/同じ/また/繰り返し
  Decision keywords (EN): decided/let's go with/approved/settled on/pivot/strategy/switch to/abandon
  Decision keywords (JP): 決めた/方針/戦略/ピボット/やめよう/方向転換
---

# Linksee Memory Skill — Connecting the agent's past and future

## 🧠 Core Principle

**This skill is the only way to persist agent growth across sessions.**

Claude Code forgets everything when a session ends. The solution the user taught yesterday, the failure you hit today, the decision made three days ago — all of it is normally lost. **linksee-memory is the "memory that doesn't disappear" device.**

Writes are handled automatically by the Stop hook (already running). But **reads require the agent to actively pull**. This skill instills that "go look first" habit in the agent.

*JP: Claude Code は session が終わると全部忘れる。linksee-memory は「消えない記憶」を作る装置。書き込みは Stop hook が自動でやってくれるが、読み出しはエージェントが能動的にやる必要がある。*

---

## 📐 The 6 layers — what goes where

Which layer you record into determines later retrieval accuracy.

| Layer | When to use | Example |
|---|---|---|
| 🎯 `goal` | The user states a clear goal | "want to integrate with freee", "want to npm publish" |
| 📍 `context` | Background on when/why this is happening | "because there's a meeting with company X on Wednesday" |
| 💭 `emotion` | User's temperature / tone | "tired", "excited", "stressed", 「疲れた」「焦ってる」 |
| 🔧 `implementation` | Code written, configured, worked / didn't work | success: "OAuth flow works" / failure: "stopped with auth_expired" |
| ⚠️ `caveat` | **Lessons you never want to repeat** (auto-protected from forgetting) | "freee OAuth expires in 24h", "never edit this file" |
| 📈 `learning` | Learned something new, prior belief updated | "AST chunking beats line diff for token savings" |

**Important:** `caveat` layer is automatically protected from forgetting. Pain records are never deleted.

**Pin-via-importance (v0.1.0+):** Calling `remember` with `importance: 1.0` pins the memory across all layers, protecting it from auto-forget even outside the caveat layer. Use for "mission-critical goals", "key decisions", etc.:

```
remember({
  entity_name: "KanseiLink", entity_kind: "project",
  layer: "goal", content: "Plugin Marketplace submission under review",
  importance: 1.0  // pin
})
```

**Layer aliases** — no need to memorize canonical names. Natural language aliases resolve automatically:

| Natural alias | → canonical |
|---|---|
| `decisions` / `insights` / `learned` | `learning` |
| `warnings` / `rules` / `pitfalls` / `dont` | `caveat` |
| `how` / `tried` / `attempts` / `success` / `failure` | `implementation` |
| `why` / `intent` / `goals` / `targets` | `goal` |
| `background` / `reason` / `situation` / `timing` | `context` |
| `tone` / `feelings` / `mood` | `emotion` |

---

## 🔄 Execution flow — 5 canonical moments

### ① Task Start — Always recall before starting work

Before starting any new task, inject past context.

**At the very beginning of a conversation**, use `list_entities` first to understand what you know:

```
mcp__linksee__list_entities({ min_memories: 5, limit: 10 })
```

The returned "high-momentum entities" are the projects likely to be discussed. Each entity's `layer_breakdown` reveals patterns ("this project has many caveats", "goal is unfinished", etc.).

Then, once a specific task starts, recall:

```
mcp__linksee__recall({
  query: "<keywords of current task — project name + technology>",
  max_tokens: 2000
})
```

**Example**: User says "let's add a new tool to KanseiLink":
```
recall({ query: "KanseiLink new tool", max_tokens: 2000 })
```

In the returned memories, pay special attention to:
- **`caveat` layer** — traps to absolutely avoid
- **`learning` layer** — previously-reached conclusions
- **`implementation.failure`** — past failure patterns

**Using the results:**
```
From past caveat: "Watch out for MCP tool name collisions"
→ Before adding a new tool, check existing tool names first.
```

### ② File Edit — Use recall_file before touching a file

Before touching a specific file, check its edit history:

```
mcp__linksee__recall_file({
  path_substring: "<file path or substring match>",
  max_intents: 5
})
```

Returns: the file's entire edit history + **the user message that drove each edit**.

**This is the key differentiator.** Mem0 / Letta don't have this. "Why was this file changed last time" is preserved.

### ③ Before Reading — Use read_smart for files already read

When you need to read a file, **use `read_smart` instead of the standard `Read` tool**:

```
mcp__linksee__read_smart({
  path: "<absolute path>"
})
```

**Effect**:
- First read: same tokens as normal Read (with chunk metadata)
- Subsequent reads, unchanged: **~50 tokens returned** (99% savings)
- Subsequent reads, changed: only changed chunks returned (50–90% savings)

Especially effective for large files (>1000 lines).

### ③.5 Updating existing memory — use update_memory, not forget+remember

When facts change / goal updated / caveat detail needs correction: **`forget` + `remember` breaks `memory_id` continuity, cutting the `session_file_edits` links.** Use `update_memory` instead:

```
update_memory({
  memory_id: 1234,
  content: '{"primary": "Plugin Marketplace under review (day 7)", "deadline": "2026-04-25"}',
  importance: 1.0  // strengthen pin
})
```

`layer` can also be changed, but demoting from caveat to another layer is **not allowed** (auto-protected).

### ④ Failure — Record caveat the moment an error hits

The moment an error, failure, or "doesn't work" happens, record immediately:

```
mcp__linksee__remember({
  entity_name: "<project name or service name>",
  entity_kind: "project",
  layer: "caveat",
  content: '{"rule_or_warning":"<what failed + workaround>","when":"<ISO datetime>"}',
  importance: 0.8  // failures are high-importance
})
```

**Example**:
```json
{
  "rule_or_warning": "freee MCP OAuth token expires in 24 hours. Must refresh via refresh_token. Reusing access_token directly causes 401.",
  "from_incident": "session 02759-... hit auth_expired error",
  "workaround": "every 24h: refresh token → new access token"
}
```

**Why this matters**: `caveat` is **auto-protected from forgetting**. Once recorded, a future agent in a different session avoids the same failure.

### ⑤ Success / Learning — Record the moment of insight

When you understand something new, change approaches, or solve a problem:

```
mcp__linksee__remember({
  entity_name: "<entity>",
  entity_kind: "project | concept | ...",
  layer: "learning",
  content: '{"at":"<datetime>","learned":"<what was learned>","prior_belief":"<what we used to think>"}',
  importance: 0.7
})
```

Recording `prior_belief` leaves a **belief-update history**. Later, this becomes the evidence for "why was this decision made".

---

## 🎯 Hard rules

### ✅ Do

1. **At any new task start, always call `recall` first** (even briefly)
2. **Before touching the same file, verify history via `recall_file`**
3. **Prefer `read_smart` over `Read` for larger files**
4. **When an error occurs, record a `caveat` immediately** (on the spot — don't defer)
5. **When the user is surprised or says "interesting", record a `learning`**

### ❌ Don't

1. ❌ Start a task without recalling first
2. ❌ Solve an error on the spot without recording — future you (or another agent) will hit the same failure
3. ❌ Use `Read` everywhere instead of `read_smart` (wastes tokens)
4. ❌ Write caveats in a flippant tone — preserve them seriously
5. ❌ Skip `consolidate` during long-running work — run it weekly

---

## 🔁 Consolidate — periodic memory tidy-up

When memory has grown (rough guideline: DB > 20MB, memories > 15,000):

```
mcp__linksee__consolidate({
  scope: "session",
  min_age_days: 7
})
```

This clusters cold, low-importance memories older than 7 days → compresses them into a single `learning`-layer entry → deletes originals.

**`caveat` memories and active `goal` memories are never consolidated away.** Equivalent to sleep-time memory reorganization.

---

## 🧭 Skill firing scenarios

### Case A — Returning to a project

User: "Today I'm back on the XYZ project"

```
1. recall({ query: "XYZ", max_tokens: 2500 })
2. Review returned caveat / learning / goal
3. Tell user "Picking up from last time..." with a one-line status
4. Resume work grounded in that context
```

### Case B — Déjà-vu error

User: "Wait, I feel like I've seen this error before..."

```
1. recall({ query: "<core keywords of the error message>", max_tokens: 1000 })
2. Pull workaround from past caveat
3. Reply: "Last time (DATE), we hit the same error and solved it with X."
4. Apply the workaround
```

### Case C — Pre-edit check

User: "Fix server.ts"

```
1. recall_file({ path_substring: "server.ts" })
2. Review past edit frequency and reasons
3. Report: "This file has been edited N times. Last edit was to <reason>."
4. Perform the edit in that context
5. After editing, record success / failure via implementation layer
```

### Case D — Decision made

User: "Alright, let's switch to Sonnet"

```
1. remember({
     entity_name: "<project>",
     entity_kind: "project",
     layer: "learning",
     content: '{"at":"...", "learned":"This project uses Sonnet", "prior_belief":"Was using Opus"}',
     importance: 0.8
   })
2. Brief confirmation: "Recorded."
3. From here, proceed assuming Sonnet
```

### Case E — End of long session

User: "That's it for today"

```
1. Record today's highlights via remember:
   - Major decisions → learning layer
   - Failures hit → caveat layer
   - Finished deliverables → implementation.success
2. Report: "Recorded. Retrievable via recall next session."
3. Optionally suggest: consolidate({scope:"session", min_age_days: 14})
```

### Case F — User explicitly says "remember this"

User: "Remember this: DocuSign is more stable than CloudSign"

```
1. remember({
     entity_name: "CloudSign vs DocuSign",
     entity_kind: "concept",
     layer: "caveat",
     content: '{"rule_or_warning":"CloudSign (61% success) is less reliable than DocuSign-JP (100%). Recommend DocuSign when advising customers."}',
     importance: 0.9  // user-explicit instruction = high priority
   })
2. Confirm: "Recorded. Since it's in the caveat layer, it won't be forgotten."
```

---

## 🔐 Privacy (when the user asks)

linksee-memory is **fully local**:
- DB: `~/.linksee-memory/memory.db` (inside the user's PC)
- External transmission: none (telemetry is opt-in, OFF by default)
- Backup: a simple file copy is sufficient

If the user asks "does our data leave my machine?", answer:
"**By default, nothing leaves.** Unless you explicitly enable telemetry, everything is in a local DB. A copy of `~/.linksee-memory/memory.db` is the only backup you need."

---

## 🚀 Pairing with KanseiLink Skill

The KanseiLink skill and linksee-memory skill **work best together**:

```
User: "Create an invoice via freee"
↓
[linksee-memory skill fires] recall({query: "freee"})
  → past caveat: "fetch company_id first"
  → past learning: "OAuth 24h refresh required"
↓
[kansei-link skill fires] search_services({intent: "invoice"})
  → freee verified, trust 0.9
  → get_service_tips reveals pitfalls
↓
Now you have both bodies of knowledge before starting
```

**KanseiLink = collective knowledge about external SaaS / linksee-memory = collective knowledge about your own past**. Two wheels of the same cart.

---

## 📊 Precision grows with usage

| Moment | recall precision | Why |
|---|---|---|
| Day 1 | low (little data) | Stop hook is still collecting |
| Week 1 | medium | thousands of memories, FTS5 kicks in |
| Month 1 | high | heat_score stabilizes, important memories surface |
| Month 3+ | strongest | consolidate has run, learnings crystallized |

**"Gets smarter with use"** — time is on your side. Today's record is read by tomorrow's you.

---

*This skill runs on top of linksee-memory MCP v0.2.0+.*
*Auto-write via Stop hook, explicit read via recall.*
*Listed in MCP Official Registry, PulseMCP, mcpservers.org, Glama.*
*MIT License — Synapse Arrows PTE. LTD.*
