# Product Drift OS — Dashboard / Map UI design (v1, 2026-06-04)

The north-star UI for T3 (direction drift) and the whole Drift OS, decided in discussion with Michie.
This is a VIEW over the Current Truth Map (the center); the map is a swappable projection of data we mostly already have.

## 1. The shape: a living "Drift Map" = Miro Product Map × Obsidian Graph × Canvas
Why it clicks (not arbitrary): the 3 references map onto the 3 things Drift OS reconciles —
- **Miro Product Map** = 宣言した意図 / roadmap (desired-state, altitude, time) = the truth-map
- **Obsidian Graph** = 関係と系譜 (intent↔reality, supersede lineage, deps) = reconcile edges
- **Canvas** = 意図的な配置 (lay out meaning by hand)
- **Drift** = where the map and the territory disagree = highlighted node/edge.
So the map is the product's thesis (intent × reality, 照合 not 推測) made spatial. It restores what the flat
`/truth` list crushes: **altitude (rule→product→strategy via zoom)** and **relationship (which intent contradicts which reality, as edges)**.

## 2. ★ Backbone template = Service Blueprint (the surprise best-fit)
Service Blueprint splits "what the user sees" vs "what happens backstage" across a **line of visibility**. Re-read for us:
- top tier = **意図 (declared truth-map)**
- bottom tier = **現実 (git/deploy/npm/files actual)**
- the line = **照合ライン (reconciliation line)**
- **drift = a vertical mismatch crossing the line.**

```
          戦略         収益化        プロダクト      技術
意図  ┌──────────────────────────────────────────────────┐
(宣言) │ 📍North★    🧪収益化仮説   🔒codegen禁止   🔒tools=3 │
       │ 🟢一致       🟡review期     🟢一致          🟢一致   │
──────┼─── 照合ライン ───────────────────────────────────┤ ← drift = 縦のズレ
現実   │ git/deploy   npm/課金実装   UI生成コード    公開ツール │
(実態) │ 🟢          🔴未実装(放置?)  🟢             🟢       │
       └──────────────────────────────────────────────────┘
```
swimlane = **domain**, two tiers = **intent/reality**, red vertical gap = **drift**.

## 3. Miro template mapping (zoom / decision_mode)
| role | Miro template | why |
|---|---|---|
| backbone (intent vs reality) | **Service Blueprint** | the line-of-visibility = our reconciliation line |
| lane structure | **Product Roadmap (swimlane)** | domain lanes — BUT borrow only the lanes; it's a "future plan" tool, using it whole drifts toward a 予定表 and blurs 照合 |
| hypotheses | **Now-Next-Later Roadmap** | horizons not dates (false-precision avoidance = review-date思想) |
| central anchor | **Product Vision Board** | North Star / source_of_truth at center, nodes hang off it |
| relationship drill | **Concept Map / Mind Map** | Obsidian-graph lens — edges = supersede/deps/contradiction. DRILL-ONLY (never the force-directed hairball home) |
| strategy-altitude (v2 moonshot) | **Wardley Map** | components on evolution×visibility; positioning drift = "should be here, now there." Wardley is literally a map of movement = blood relative of drift. Defer to post-T3. |

decision_mode → natural geometry: **constraint→guardrail band / commitment→Kanban freshness lanes (fresh/stale/abandoned) / hypothesis→Now-Next-Later / source_of_truth→central anchor.**

## 4. The drift lifecycle = a state machine (Michie's red→investigate→red/blue loop, typed)
| state | meaning | condition |
|---|---|---|
| 🔵 整合 | reality matches intent | reality==intent **OR a recorded supersede** |
| 🟡 確認中 | Soft detection, awaiting human | the "調べる" stage; presented **with both-sided citations** |
| 🔴 ドリフト | unaccounted divergence | no recorded decision → proactively surface "○○が未実装ですが、やりますか？" |
| ⚪ 保留 | intentionally deferred (recorded) | nag-suppressed until review-date. **NOT red.** |

**Integrity rule (critical):** 🔴→🔵 only via (a) **reality changed to match** (an impl commit → mechanically auto-blue), or
(b) **a decision was recorded** (supersede/snooze with a reason). **NEVER "an agent thought it was fine"** — else the
dashboard gets gamed green (reward hacking). Blue must always be backed by reality-match OR a recorded decision.
Grey ≠ red: deferred-with-reason is not drift (= the make-or-break discriminator, as UI state).

## 5. Multi-agent = the moat, made visible
Different agents (別Claude / 別Codex) work the same project → all read the SAME truth-map (Linksee's backing memory)
AND see the same dashboard. If A commits something that violates a constraint B declared → drift surfaces for A, B,
AND the human. **Native platform memory cannot do this** (siloed per-platform, never shared to a competitor) =
**cross-agent neutral reconciliation = the structural moat.** Writes go candidate→review (no direct overwrite):
**the human owns INTENT (source of truth); agents only PROPOSE.** B cannot silently green-light A's intent.

## 6. Observability framing (battle-tested mental model + locks positioning)
The red→investigate→red/blue loop IS an observability alert lifecycle: **firing → ack → resolved → flapping**
(= Datadog / PagerDuty). Benefits: (1) proven patterns exist (auto-resolve, dedup, suppress-known); (2) the failure
mode is known = **alert fatigue** (→ precision>volume restated); (3) **flapping (red↔blue churn) is itself a signal**
that the area is unstable or the anchor is wrong. Positioning crystallizes: **"Datadog for product intent."**

## 7. The 4 build disciplines (carry these into T3)
1. **No hairball** — structured backbone (Blueprint/lane grid, deterministic), Graph as drill-down only. Precision>volume applies to PIXELS.
2. **Act, don't decorate** — every drift edge carries the make-or-break action: ［進化として記録=supersede］/［放置=戻す/直す］. The map RESOLVES drift, not just displays it.
3. **Moat in the engine, not the canvas** — canvas is commoditized (Whimsical/Heptabase/tldraw). The magic = live, cited, auto reconciliation feeding it. "Looks like Miro, is Datadog."
4. **Sequence: don't build the cathedral empty** — prove T3 detection (戦略doc↔truth-map, gated, cited, a few REAL drift cards) on the simple `/truth` FIRST → graduate to the map once there's signal worth mapping.

## 8. Encouraging: mostly rendering, not new data
Already in `drift_anchors` v9 + `memory_write_candidates`: domain (swimlanes), decision_mode (glyph/tier),
confidence (opacity), reality_manifestations (edges to the reality tier), candidates (the red glow + its cited reason),
lifecycle (blue/amber/red/grey). The Blueprint-by-domain home is buildable on existing data.
GTM bonus (Michie's weak spot): a shareable "my startup's drift map" = product = demo = ad, screenshot-friendly for X.

Related: [[project_linksee_drift.md]] (canon), [[session_drift_os_20260604.md]] (this session), [[project_linksee_memory.md]], [[project_linksee_gtm.md]]
