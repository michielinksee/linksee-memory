# Linksee Drift — Founder Memory / Product Drift OS (Spec v1)

Date: 2026-06-01. Status: **canonical product definition** (Michie). The build memos (drift-detection-design-v1..v9)
are the engine; THIS is what the engine is FOR. Increment, don't overwrite.

---

## 0. One line
**Not a code-rule linter. A Founder Memory / Product Drift OS.**
> drift = 「決めた未来」と「今の現実」のズレ — past-agreed direction (strategy/product/tech/ops/monetization/schedule) vs the current actual state.

## 1. WHY this must exist (the problem it solves)
LLM-driven development runs **session-by-session on in-the-moment agreement**. Each new session the agent may
present a slightly-drifted structure; the founder **doesn't hold the whole map**, so they nod and proceed.
Drift therefore **compounds silently — nobody notices, because nobody holds the whole map.** The product IS the
persistent whole-map holder that catches per-session drift. (It solves a problem that LLM coding itself creates.)

The real failure of startups / solo-dev is NOT "one line of code is wrong." It is: forgetting what you were
building for, drifting from the original winning path, the monetization funnel quietly disappearing, outreach
stopping, npm/GitHub/Vercel left to rot — **"looks alive, but dead as a business."** プロダクトの墓場はだいたいここ。
誰も葬式を出さないだけ。 ← that silent death is the headline value.

## 2. THE LINCHPIN — separate "project-core memory" from "conversation memory"
For product development, **"memory" = observing where/how the skeleton (骨組み) was decided and what state it is in now.**
This REQUIRES two distinct memory layers:
- **Project-core / skeleton memory** — the decided structure (strategy/design/tech/ops/growth/schedule) + each node's
  current state. **Clean, declared, the intent side of drift.** Drift detection reads ONLY this.
- **Conversation memory** — chitchat, the founder's philosophy, ambient discussion. Kept for recall / the
  second-brain map (②), but **insulated from drift** (never used as drift intent).

Today linksee-memory **mixes them** (chitchat + the founder's philosophy + project-core in one `memories` pool) —
"あとあと結構面倒になる." **We are already part-way to the fix:**
- `drift_anchors` (declare-don't-mine) = the **first project-core layer** — clean, declared, schema-enforced.
- The docx→LLM-extraction pipeline (`kansei-link-knowledge-extracted-v1.md`) = the **distillation** that pulls
  project-core (decisions/strategy/design) OUT of raw conversation — its `kind` field already separates
  decision/constraint/strategy (project-core) from user_profile/chitchat (conversation).
- **Next:** make project-core a first-class layer (the skeleton map across the 6 domains below); leave the
  conversation `memories` as-is, insulated.

## 2.5 The make-or-break: evolution vs abandonment — COO/CMO, not auditor
The single thing that KILLS this product: nagging on HEALTHY drift. The initial 骨格 is NOT sacred — the more you
build, the more reality reveals itself, and the final form legitimately lands elsewhere than the original concept
(良いことも多い). If the product keeps crying "you deviated from the original structure!" it becomes the rigid,
clueless engineer nobody wants. **本質的に「方向はずれてもいい」。**

**The discriminator (the core detection rule).** Divergence (reality ≠ declared) has the SAME surface whether it is
healthy evolution or real drift. They are told apart by ONE question:
> **Is the gap ACCOUNTED FOR by a decision?**
- **Evolution → DON'T flag:** the divergence is the result of a conscious, RECORDED supersession ("we decided X→Y,
  here, why"). The map was UPDATED. This is belief-revision / 最初の設計≠正義 — healthy. Once acknowledged it is just
  the map moving; it must NEVER nag again.
- **Abandonment / incoherence → DO flag:** the divergence has NO superseding decision — a dangling/forgotten/stalled
  commitment, or fragmentation. Michie's examples: a routine that should continue just stopped; "Railwayで作って
  たのに忘れてVercelで作り始めた" (forgot one, fragmented onto another, no decision picking the canonical one). The map
  was NOT updated; nobody closed the loop.

So the detector's question is **not** "does reality match the original?" (that nags on every evolution). It is:
> **"Is there any divergence the founder has neither FIXED nor consciously DECIDED INTO?"**
Healthy drift is invisible (absorbed as a supersede); only **un-owned** drift surfaces. = a **COO/CMO** surveying the
whole and finding what is genuinely OFF (stalled / forgotten / fragmented / incoherent), not an auditor flagging
plan-deviations.

**Reverse-engineered memory layer — the living skeleton map:**
- **Skeleton node** = a decision/commitment: `{ statement, why, domain(6), state: active|superseded|stalled|fulfilled,
  supersedes / superseded_by (lineage), expected_cadence (for ongoing commitments), reality_manifestations (where it
  lives: file / repo / deploy / url / job) }`.
- **Conversation layer** stays separate + insulated (§2).
- **The COO/CMO sweep** over active nodes: (a) diverging reality? (b) accounted by a superseding decision? →
  un-accounted + diverging = card. PLUS **heartbeat** (committed + cadence exceeded + no "we stopped" decision =
  stalled) and **fragmentation** (one intent, multiple competing reality_manifestations, no deciding node = "which is
  canonical?").
- **Resolution updates the map — the anti-nag valve (ALREADY BUILT):** the 3-way — "I meant it" → record supersede
  (node evolves, lineage kept, never nags again); "it slipped" → fix; "noise" → dismiss. The map self-updates, so the
  SAME divergence never nags twice. **The drift loop IS the mechanism that keeps the founder's map honest without
  nagging.**

**Have vs need:** the 3-way reality-won=supersede valve is BUILT (the evolution-not-nag mechanism) — the detector must
now RESPECT it (skip superseded/resolved nodes). `absent` + heartbeat = the stall detector. NEW: supersession lineage
as first-class + the "unaccounted-divergence" discriminator + intent→reality_manifestation mapping (fragmentation).

## 3. The 5 drift types (Michie's canonical taxonomy)
1. **ルール違反型 (rule violation)** — decided a rule, code breaks it. e.g. services UPSERT decided but
   `INSERT OR IGNORE` remains; no-own-product-boost decided but ranking boosts; no-PII decided but logs keep email.
   → easy: grep / static analysis. **(BUILT — v2 file-scan)**
2. **事業戦略 drift (business strategy)** — monetization/positioning quietly changes. e.g. "SaaS pays for AEO
   analytics" → drifted into a free consumer search site; stealth-then-publish → premature public; agent-native infra
   → ordinary human directory; "AEO-era Ahrefs" → just an MCP list site. → can't see from code; cross-cut
   README/LP/articles/pricing/screens/DB/event-logs/implementation-priority.
3. **プロダクト設計 drift (product design)** — features grow but the SKELETON drifts. e.g. Recipe was the core but
   only the service list grows; Agent Insights planned but only UI work happens; trust_score "evidence-based"
   decided but it's hand-entered/vibe scores; JP search was the differentiator but JP FTS sits un-built;
   "agent-usable" was the axis but only human-readable cards get made. **Most dangerous — it LOOKS like progress.**
4. **運用・継続 drift (ops / continuity)** — design exists, operations are dead. e.g. the article routine stopped;
   GitHub Actions failing unwatched; npm not updated; Vercel deploy/env stale; data jobs stopped; the weekly report
   nobody opens; competitor-watch lapsed. **The startup graveyard.**
5. **時間軸・優先順位 drift (timeline / priority)** — e.g. 2-week MVP → 3 months tweaking internals; "ship &
   collect usage data first" → building an admin panel; "validate monetization" → only free features grow;
   "test the SaaS dashboard hypothesis first" → sunk into crawler tuning; now-vs-later inverted. Invisible in code
   alone — needs plan × current GitHub/articles/deploy/DB/funnel laid side by side.

## 4. The 6 domains observed
| 領域 | 見るもの |
|---|---|
| 戦略 | 収益化モデル、ターゲット、ポジショニング |
| プロダクト | 機能、導線、UI、体験 |
| 技術 | DB、API、スコアリング、crawler、MCP |
| 運用 | 記事、更新ジョブ、デプロイ、npm、GitHub Actions |
| 成長 | SEO/AEO、導入導線、メール、分析 |
| 時間軸 | 今やるべきこと、止まっていること、後回しになったこと |

## 5. Two anchor classes → two detection engines
- **A. Hard anchor** — mechanically detectable: `INSERT OR IGNORE INTO services` 禁止 / PII保存禁止 / 自社boost禁止 /
  env未設定 / GitHub Actions failure / npm version stale / Vercel deploy stale. → deterministic engine:
  **file-scan (v2, BUILT)** + external-asset **heartbeat checks** (npm/Vercel/GitHub API, edit-timestamp staleness).
  照合 is trivially clean (mechanical).
- **B. Soft anchor** — strategy/design/ops/direction: heading toward AEO-analytics monetization? SaaS-facing funnel
  present? Recipe growing? article funnel continuing? agent-native experience? roadmap stalled? → **LLM-judge engine**:
  intent = clean project-core memory; reality = LP/README/DB stats/deploy/implementation-priority/recent decisions;
  the judge MUST cite both sides.

## 6. The drift card format (canonical)
Every card — Hard or Soft — has four parts:
1. **過去の決定** (the declared intent, cited)
2. **現在の実態** (the observed reality, cited)
3. **drift** (the gap, stated neutrally — a question, not a verdict; 最初の設計≠正義)
4. **次の修正** (the concrete next fix — must follow deductively from 1–3, not be invented advice)

**Discipline (non-negotiable):** every type stays **照合, not 推測**. Even "articles stopped" cites declared-routine
[here] + last-occurrence-date [here]. Soft cards are the riskiest (slip to 推測) — the 4-part card with citations on
both sides IS the contract that keeps them honest; resolution is the 3-way (fix-code / reality-won / dismiss).

## 7. Build status + roadmap
- ✅ **T1 / Hard file-scan** — v2 detector scans current files for precise violation_signals (proven: surfaced
  `INSERT OR IGNORE INTO services`, `ALTER TABLE memories DROP`). Precision rule learned: signals must be
  precise/multi-word + exclude the rule's own definition file + string-literal/data lines.
- ⬜ **Hard heartbeat** — npm/Vercel/GitHub-Actions/ routine staleness (edit-timestamp vs declared cadence + external
  API). Detectable NOW from existing timestamps; the easy high-value next.
- ⬜ **Soft LLM-judge** — the T2–T5 engine; intent from project-core memory (the extraction pipeline), reality from
  LP/DB/code/deploy/priority. The real prize.
- ⬜ **Project-core / skeleton memory layer** (§2) — first-class, separated from conversation memory.

## 8. Positioning
**Founder Memory / Product Drift OS** — detects the gap between founder intent, past decisions, and the product's
current state across code, DB, articles, deploy, GitHub, npm, Vercel, LP, and implementation history. The
`INSERT OR IGNORE` catch was the small, easy, mechanical on-ramp. The body of value is the silent
strategy/design/ops/timeline death that code-linters can never see.
