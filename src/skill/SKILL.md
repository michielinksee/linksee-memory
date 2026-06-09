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

  Triggers (EN): remember/recall/forget/memory/before/earlier/last time/previously/remember when/same as before/history/use linksee/linksee
  Triggers (JP): 記憶/覚えて/忘れて/過去/前回/前に/そういえば/覚えてる/リンクシー
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

## 🏗️ 3-Axis Classification (v2) — REQUIRED for all `remember()` calls

The 6-layer system tells you WHICH DRAWER. The 3-axis system tells you WHAT KIND of memory goes in it. Every `content` field must be a JSON string containing these 3 axes:

### Axis ① Altitude — where in the abstraction hierarchy

| Level | Description | Survives |
|---|---|---|
| `mission` | Company/product-level direction ("KanseiLINK is the intelligence layer for the Agent Economy") | Permanent |
| `strategy` | Approach to achieving mission ("AEO-first, 引き出しカタログ model") | Permanent |
| `architecture` | System design decisions ("2-layer: Memory=agent-optimized, Dashboard=human-optimized") | Long-lived |
| `implementation` | Specific code/config changes ("Added FTS5 trigram index") | Auto-archives after 30d if untouched |

### Axis ② Type — what kind of information

| Type | Description |
|---|---|
| `question` | User asked something, answer pending or delivered |
| `comparison` | Multiple options analyzed (e.g., Stripe vs Square) |
| `decision` | A choice was made — store agent_proposal + user_approval_scope |
| `work` | Code written, config changed, command run |
| `outcome` | Result of work (success/failure + what happened) |
| `learning` | Insight gained, prior belief updated |
| `note` | General context — **chitchat = DISCARD, do NOT save** |

### Axis ③ State — lifecycle position

```
open → decided → in_progress → done
                              → stalled (blocked, can't proceed)
                              → parked (intentionally paused)
                              → superseded (replaced by newer decision)
```

---

## 📝 Structured Content Format — the JSON schema for `content`

**Every `remember()` call MUST use this JSON format in the `content` field:**

```json
{
  "title": "<one-line: WHAT this memory IS — future-agent skims this>",
  "altitude": "strategy",
  "type": "decision",
  "state": "decided",
  "what": "<the actual content — 5W1H extracted, NOT raw chat>",
  "why": "<why this matters — the reasoning>",
  "affects": ["src/mcp/server.ts", "lib/db.ts"],
  "next_action": "Implement the schema migration next session",
  "supersedes_id": null,
  "evidence_refs": [
    {"type": "session", "id": "b78dc5ba", "label": "Architecture discussion"}
  ]
}
```

### Required fields (ALL memories)

| Field | Type | Description |
|---|---|---|
| `title` | string | One-line summary. Future agents read ONLY this when scanning. Make it specific: "freee OAuth 24h expiry caveat" not "OAuth issue" |
| `altitude` | enum | mission / strategy / architecture / implementation |
| `type` | enum | question / comparison / decision / work / outcome / learning |
| `state` | enum | open / decided / in_progress / done / stalled / parked / superseded |
| `what` | string | The semantic content. Extract 5W1H from conversation — NEVER store raw chat like "そうだね。全部やろう。" |
| `why` | string | Why this matters. Without this, future agents can't judge relevance |

### Required fields (DECISION type only)

| Field | Type | Description |
|---|---|---|
| `agent_proposal` | string | What the agent proposed (the full context the user was responding to) |
| `user_approval_scope` | string | What EXACTLY the user approved — "うん全部やって" → translate to "approved all 6 panels of Agent Brain Dashboard including data layer, API route, and view component" |

### Optional but recommended fields

| Field | Type | Description |
|---|---|---|
| `affects` | string[] | File paths or areas this touches. Critical for future `recall_file` accuracy |
| `next_action` | string / null | What should happen next. Null if done/completed |
| `supersedes_id` | number / null | Memory ID this replaces (builds pivot chains) |
| `prior_belief` | string | What we used to think (for learnings — enables belief-update tracking) |
| `evidence_refs` | object[] | Links to evidence: `{"type": "session"|"file"|"url", "id": "...", "label": "..."}`. Store as REFERENCES, never inline the full content |

### Content quality rules — what NOT to save

| ❌ DO NOT | ✅ INSTEAD |
|---|---|
| Store raw chat: `"決めた。それでいこう"` | Extract: `"Decided to use 2-layer architecture splitting Memory (agent-optimized) from Dashboard (human-optimized)"` |
| Store ambient chat: `"書斎で無糖のサイダー飲んでる"` | Discard. Not a memory. |
| Store vague approval: `"うん全部やって"` | Extract the SCOPE: `"Approved: (1) agent-brain data layer, (2) API route, (3) 6-panel view component implementation"` |
| Paste back assistant output as memory | Summarize the KEY INSIGHT from the output in YOUR words |
| Store without `why` | Always include WHY — without it, memory is noise |

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

#### ⚡ Writing effective recall queries

The recall engine uses FTS5 full-text search + heat_score ranking. Your query determines what comes back.

| Pattern | Query style | Example |
|---|---|---|
| Entity + topic | `"<entity> <topic keyword>"` | `"KanseiLink OAuth"` |
| Error recall | `"<error message core> <technology>"` | `"401 freee token expired"` |
| Decision recall | `"<entity> decided strategy approach"` | `"Linksee Memory plugin vs MCP"` |
| File-related | Use `recall_file` instead | `recall_file({ path_substring: "server.ts" })` |
| Cross-entity | Call recall TWICE for each entity | `recall({ query: "KanseiLink" })` then `recall({ query: "Linksee Memory" })` |

**Anti-patterns:**
- ❌ `recall({ query: "what happened" })` — too vague, FTS5 matches everything
- ❌ `recall({ query: "the user said to fix the bug in the auth flow" })` — natural language sentences score poorly in FTS5
- ✅ `recall({ query: "auth bug fix caveat", layer: "caveat" })` — keywords + layer filter = precise

#### 🔇 When NOT to recall (save tokens)

- Same entity already recalled in this session AND no new context arrived → **skip**
- User is just chatting / thinking aloud / no task yet → **skip** (wait for concrete task)
- You just wrote a memory 2 turns ago → **skip** (it's still in your context window)
- The answer is already in your conversation context → **skip** (don't waste a tool call)

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
  content: JSON.stringify({
    title: "<one-line: what failed + the rule>",
    altitude: "implementation",
    type: "outcome",
    state: "done",
    what: "<what failed + workaround found>",
    why: "<root cause analysis>",
    affects: ["<file paths where the error occurred>"],
    next_action: null
  }),
  importance: 0.8  // failures are high-importance
})
```

**Example**:
```json
{
  "title": "freee OAuth token expires in 24h — must refresh proactively",
  "altitude": "implementation",
  "type": "outcome",
  "state": "done",
  "what": "freee MCP OAuth token expires in 24 hours. Reusing access_token directly causes 401. Must call refresh_token endpoint proactively.",
  "why": "freee's OAuth implementation uses short-lived tokens unlike most SaaS (usually 30-90 day expiry)",
  "affects": ["src/integrations/freee/auth.ts"],
  "next_action": null,
  "evidence_refs": [{"type":"session", "id":"02759...", "label":"freee auth_expired incident"}]
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
  content: JSON.stringify({
    title: "<one-line: what was learned>",
    altitude: "<strategy|architecture|implementation>",
    type: "learning",
    state: "done",
    what: "<the insight>",
    why: "<why this changes how we work>",
    prior_belief: "<what we used to think>",
    affects: ["<file paths if applicable>"],
    next_action: "<follow-up action if any>"
  }),
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
6. **Before risky/irreversible actions, proactively recall caveats** (Case H)
7. **Before finalizing a decision, check for prior decisions on the same topic** (Case D)
8. **Use keywords + layer filter in recall queries**, not natural language sentences

### ❌ Don't

1. ❌ Start a task without recalling first
2. ❌ Solve an error on the spot without recording — future you (or another agent) will hit the same failure
3. ❌ Use `Read` everywhere instead of `read_smart` (wastes tokens)
4. ❌ Write caveats in a flippant tone — preserve them seriously
5. ❌ Skip `consolidate` during long-running work — run it weekly
6. ❌ Recall the same entity twice in one session without new context (wastes tokens)
7. ❌ Write `recall({ query: "what happened last time" })` — use specific keywords

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

### Case D — Before finalizing a decision (pre-decision check)

User: "Let's switch to Stripe for payments"

**Key: BEFORE recording a decision, check if a past decision on the same topic exists. This prevents flip-flopping and builds on prior reasoning.**

```
1. recall({ query: "<entity> <topic> decided strategy", layer: "learning", max_tokens: 1000 })
   → Look for: type="decision", state="decided" memories on the same topic
2. If past decision found:
   a. Tell user: "Previously we decided <X> because <reason>. Override?"
   b. If user confirms override → use supersedes_id to link to old decision
   c. If user says "oh right, keep it" → no new memory needed, proceed
3. If no past decision found → proceed to record (see Case E below)
```

**Example**: Past memory says "Decided: Square over Stripe due to SG tax handling". When user now says "switch to Stripe", surface that context FIRST. The user may not remember the original reasoning.

### Case E — Decision made (recording)

User: "Alright, let's switch to Sonnet"

**Key: capture WHAT was decided, WHY, and what the user was responding to — not the raw chat.**

```
1. remember({
     entity_name: "<project>",
     entity_kind: "project",
     layer: "learning",
     content: JSON.stringify({
       title: "Model switch: Opus → Sonnet for this project",
       altitude: "architecture",
       type: "decision",
       state: "decided",
       what: "Switched default model from Opus to Sonnet for this project",
       why: "Sonnet is faster and cheaper for implementation-heavy work; Opus reserved for architecture decisions",
       agent_proposal: "Suggested Sonnet for faster iteration on implementation tasks",
       user_approval_scope: "Approved switching default model to Sonnet for all tasks in this project",
       prior_belief: "Was using Opus for everything",
       affects: [".claude/settings.json"],
       next_action: null
     }),
     importance: 0.8
   })
2. Brief confirmation: "Recorded."
3. From here, proceed assuming Sonnet
```

### Case F — End of long session

User: "That's it for today"

**Key: extract the SEMANTIC decisions and outcomes, not raw chat dumps.**

```
1. For each major decision made during the session:
   remember({
     entity_name: "<project>",
     entity_kind: "project",
     layer: "learning",
     content: JSON.stringify({
       title: "<one-line: what was decided>",
       altitude: "<strategy|architecture|implementation>",
       type: "decision",
       state: "decided",
       what: "<5W1H extraction of the decision>",
       why: "<reasoning behind it>",
       agent_proposal: "<what you proposed>",
       user_approval_scope: "<what exactly user approved>",
       affects: ["<file paths>"],
       next_action: "<what's next>",
       evidence_refs: [{"type":"session", "id":"<current_session_id>", "label":"<topic>"}]
     }),
     importance: 0.85
   })

2. For each failure/lesson:
   remember({
     ...,
     layer: "caveat",
     content: JSON.stringify({
       title: "<one-line: what went wrong and the fix>",
       altitude: "implementation",
       type: "outcome",
       state: "done",
       what: "<what failed + workaround found>",
       why: "<root cause>",
       affects: ["<file paths>"],
       next_action: null
     }),
     importance: 0.8
   })

3. Report: "Recorded N decisions, M caveats. Retrievable via recall."
4. Optionally suggest: consolidate({scope:"session", min_age_days: 14})
```

### Case F2 — Flag orphaned proposals at session end

**Conversations are tree-shaped but experienced linearly.** When you present multiple options and the user engages with only some, the rest become "orphaned proposals" — unresolved decision branches that both you and the user lose track of.

**WHEN TO FLAG:**
- At session end, review what you proposed vs what was addressed
- When the conversation shifted topic and earlier proposals were never resolved
- When the user engaged with only 1 out of N options you presented

```
1. Review the session: which proposals did you make that the user never addressed?
2. flag_proposals({
     session_context: "GTM channel strategy discussion",
     proposals: [
       {
         statement: "[未解決] LinkedIn B2B: SaaS企業のCTO/VPE向けDMアウトリーチ",
         rationale: "3つのGTMチャネルを提示したがX/Twitterのみ採用。LinkedIn経由の検討が未着手",
         domain: "growth",
         confidence: 0.5,
         decided: "X/Twitter data-driven growth",
         siblings: ["X/Twitter", "LinkedIn B2B", "Dev Community"]
       },
       ...
     ]
   })
3. Report: "Flagged N unresolved proposals for dashboard review."
```

Each proposal becomes a review-state anchor on the Linksee Dashboard — visible until the user decides. This is **declaration, not mining**: you are the curator recognizing what went unaddressed.

### Case F3 — Dream: triage orphaned proposals against the North Star

**Not all orphaned proposals are worth surfacing.** Many are outdated, already implicitly resolved, or irrelevant to the current direction. The `dream` tool returns the project's **North Star** (direction/goals/ICP/phase) alongside accumulated proposals so you can evaluate each one.

Think like a General Doctor doing triage: the North Star is the patient's chart, each proposal is a symptom. Not every symptom needs treatment.

**When to dream:**
- At session start, if there are accumulated proposals
- When the user asks "何か見落としてない？" or "what should we revisit?"
- Periodically (weekly) to prevent proposal backlog from growing stale

```
1. dream()
   → Returns: north_star + candidates[]

2. For each candidate, evaluate against North Star:
   - Does this affect the current phase/goals? → surface
   - Is this for a different ICP or future phase? → dismiss
   - Already implicitly resolved by later decisions? → dismiss

3. resolve_proposal({
     candidate_id: <id>,
     verdict: "surface" | "dismiss",
     rationale: "North Star says ICP = solo devs; this is enterprise-only → dismiss"
   })
```

**Example evaluation against North Star:**
```
North Star: "local-first agent memory for solo devs, HN Launch phase"

Candidate A: "CLI-first onboarding wizard"
  → SURFACE: directly improves DX for ICP, relevant to HN launch

Candidate B: "AR glasses integration (2027-28)"
  → DISMISS: outside current phase, future vision only

Candidate C: "kintone enterprise integration"
  → DISMISS: ICP mismatch (enterprise B2B vs solo devs)
```

The North Star is declared via `declare_anchor(node_type: "north_star")` and should be updated when the project enters a new phase (e.g., post-HN → growth phase). This keeps the Doctor's judgment frame current.

### Case G — User explicitly says "remember this"

User: "Remember this: DocuSign is more stable than CloudSign"

```
1. remember({
     entity_name: "CloudSign vs DocuSign",
     entity_kind: "concept",
     layer: "caveat",
     content: JSON.stringify({
       title: "DocuSign-JP >> CloudSign for reliability",
       altitude: "strategy",
       type: "comparison",
       state: "decided",
       what: "CloudSign (61% success) is significantly less reliable than DocuSign-JP (100% success). Recommend DocuSign when advising customers.",
       why: "Based on KanseiLINK agent success rate data across multiple integrations",
       affects: [],
       next_action: null
     }),
     importance: 0.9  // user-explicit instruction = high priority
   })
2. Confirm: "Recorded. Since it's in the caveat layer, it won't be forgotten."
```

### Case H — Proactive caveat surfacing (the "間違えたらやばい" pattern)

**This is the precision memory killer feature.** When you're about to take an action that could go wrong, check for past caveats BEFORE acting — even if the user didn't ask.

**Trigger**: You are about to do something risky or irreversible:
- Deploy / publish / push to production
- Delete / overwrite / destructive operation
- External API call (payment, email send, etc.)
- Architecture change affecting multiple files
- Changing auth/security configuration

```
1. recall({ query: "<entity> <action keyword>", layer: "caveat", max_tokens: 800 })
2. If caveat found:
   a. STOP before acting
   b. Tell user: "⚠️ Past caveat: <title>. <what>. Proceed anyway?"
   c. Wait for confirmation
3. If no caveat → proceed normally
```

**Example**: About to run `npm publish`:
```
recall({ query: "npm publish", layer: "caveat", max_tokens: 500 })
→ Caveat found: "npm token rotation — always verify token validity before publish"
→ "⚠️ Past caveat: npm token may need rotation. Want me to check `npm whoami` first?"
```

**Why this matters**: This is what separates precision memory from ambient memory. Ambient memory passively injects everything. Precision memory **actively intervenes at the moment it matters most** — when you're about to make the same mistake twice.

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

*This skill runs on top of linksee-memory MCP v0.4.0+.*
*Auto-write via Stop hook, explicit read via recall.*
*Listed in MCP Official Registry, PulseMCP, mcpservers.org, Glama.*
*MIT License — Synapse Arrows PTE. LTD.*
