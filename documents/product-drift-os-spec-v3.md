# Product Drift OS — Spec v3 (the Map: journey spine × edges × where-am-i)

Increment over [v2](product-drift-os-spec-v2.md). v2 = the reconciliation discipline (IaC/GitOps lineage,
out-of-band test, convergence/divergence/absence, 3-way resolve). **v3 gives the Current Truth Map the
topology v2 left implicit: a business-journey spine, typed node↔node edges, and a session-time "you are
here" primitive.** Date: 2026-06-12. Decisions 1–3 approved by both cofounders (anchors #57–59).

---

## 0. The diagnosis that triggered this
The dashboard felt like a meaningless list ("ゴミ羅列"). Root cause, not a display bug:
- **Drift is a diff, and a diff is only defined against a structure.** The dashboard was showing the LOG
  (memory layer, L2) without the MAP (Current Truth Map, L3). v2 already said "the diff IS the product" —
  we were shipping the log, not the diff.
- **The LLM has no per-turn re-anchoring.** CLAUDE.md = static context; memory = log. Neither gives
  *position* ("you are touching node X; its blast radius is Y,Z"). Hence the observed drift pattern:
  options offered → none selected → tangent deep-dive → divergence. The missing role is the Head/COO —
  the one who sees 誰に何をどう売るか and treats implementation as the pipeline that serves it.

## 1. Five-framework synthesis → ONE data model (not five maps)
| Framework | Contribution to the Map |
|---|---|
| **Porter Value Chain** | spine = the flow value travels (create→deliver→capture), NOT departments |
| **Business Process Map / EA** | the COO altitude: "where is the business process stuck" |
| **Service Blueprint (NN/g)** | the two-layer topology: frontstage (customer steps) × backstage (artifacts/impl) |
| **JTBD (Strategyn)** | the root node = the customer's job, not a feature list |
| **Requirements Traceability** | typed edges + impact propagation, extended business-ward |

**Rule: the frameworks are justification; the implementation artifact is ONE graph.** Building five views
of five models is the failure mode.

The traceability chain, extended business-ward (this is the differentiation — ordinary traceability links
code↔requirements; Linksee links **business intent ↔ LLM implementation ↔ market 導線**):
`Customer Job → Product Promise → Requirement → Implementation → Interface/CLI → Docs/README →
Distribution Surface → Revenue/Pricing → Evidence/Demo`
⚠️ This 9-hop chain is **edge vocabulary, not mandatory layers**. Forcing every node through 9 typed
layers makes authoring a chore → map rot (anti-self-drift, v2 §6). **v1 = 3 layers only:** journey stage /
surface / implementation.

## 2. The data model
- **Root** = the Job statement (1 node). Linksee's own (also the pitch copy):
  > 複数プロジェクトで判断・実装・導線が散らばる中、自分とLLMが「今どこを触っているか」を失わず、
  > 次に直すべき破損箇所を判断できるようにする。
- **Spine** = journey stages (template-dependent; OSS dev-tool default):
  発見 → 理解 → 試用 → 導入 → 継続 → 課金 → 拡張
  (An empty 課金 stage rendering as *absence* is correct and useful — the funnel's missing tail, honestly.)
- **Nodes** = existing anchors/ProjectCoreNodes (v9), each assigned a journey stage. No new node table.
- **Edges (NEW)** = typed anchor↔anchor links: `realizes` / `supports` / `must-stay-consistent-with`.
  Today's drift_edges are anchor↔reality only; node↔node edges are what enable **impact propagation**:
  an out-of-band change at node X marks dependents Y,Z *suspect* — "仕様を変えたらLP/Doc/npmも怪しい"
  becomes computable.
- **Old 6 domains** (Strategy/Product/Engineering/Monetization/Operations/Security) → **facet tags,
  not the spine.** Security/Ops cut across journey stages. Demoted, not deleted (cheap migration).
- **The v2 engine is UNCHANGED and runs over the new topology:** out-of-band test, convergence/
  divergence/absence verdicts, 3-way resolve (apply/import/update). Topology is what the engine walks.

## 3. Source of truth = map.yaml in git (Decision 2 = option a, anchor #58)
GitOps principle (v2 §6): git = the single declared desired state. Therefore:
- `map.yaml` (repo root) = the human/LLM-editable, git-diff-reviewable desired-state file. Its visible
  presence in the repo is itself product surface (read like CLAUDE.md).
- SQLite = runtime sync/index only. Importer reconciles map.yaml → DB.
- **30–60 nodes max.** Hand-written first, for Linksee itself (dogfood; P1 "manual, correct map first").
  Hand-writing IS the first customer test of authoring cost.

## 4. where_am_i — the session-time positional push (NEW primitive)
`read_smart` is pull. where_am_i is **push**: locate the current conversation/question on the Map, inject
"you are at node X; blast radius = {dependents}" each time the topic shifts. This is the "install the Map
into the LLM" mechanism — the per-turn re-anchor that prevents options-ignored→tangent drift, for the
human AND the model.

## 5. Map Wizard + archetype templates (P1.5)
Invocation: 「Linksee Map」(candidate 4th spell alongside use linksee /「これ覚えて」/ what's drifting?)
→ "どのプロジェクトの骨格を設定しますか？" → interview → map.yaml generated → committed.
- **scan-first, confirm-second.** Don't ask 10 cold questions. Pre-fill a draft map from the repo
  (package.json→npm surface, README, LP links, Stripe, CI...) — per the 70/30 principle (source-scan 70%
  + human declaration 30%). The interview covers only what code cannot tell: the Job statement, 誰に,
  stage emphasis, paused/deprecated intent, revenue intent. ≈5–7 confirmations; 10-question hard budget.
  The questions that remain human are exactly the business-intent ones — which is the Map's whole point.
- **Templates = stage presets + typical surfaces + default edge patterns**, shipped as `templates/*.yaml`
  (community-contributable — new archetypes arrive as PRs):

| Template | Center of gravity |
|---|---|
| OSS Developer Tool | CLI / MCP / npm / GitHub |
| B2B SaaS | LP / demo / sales / onboarding |
| AI Agent Product | tool call / memory / workflow / evaluation |
| Content / Subscription | 記事 / SEO-AEO / paywall / Stripe |
| Consulting / Agency | lead / proposal / delivery / renewal |
| Internal Tool | 業務フロー / 権限 / 運用 / 保守 |

- **Hand-writing stays first-class** (map.yaml is just a file; the wizard is sugar).
- **The wizard's last act = run the reconciler** → present the user's FIRST drift card minutes after
  setup. That is the onboarding aha-moment ("it already knows what's inconsistent").
- **Sequencing: wizard ships AFTER we hand-write 1–2 maps.** The interview questions are extracted from
  what was actually hard to answer by hand. Does not block 6/23. (Sibling pattern: bantou
  onboarding-interview.)

## 6. P1 completion redefined + dashboard (Decisions 1 & 3, anchors #57, #59)
- **P1 done =** journey spine introduced + all anchors stage-assigned + typed anchor↔anchor edges +
  where_am_i v0. P2–P5 unchanged (Hard heartbeat → Soft judge → Memory Revision Flow → COO/Board).
- **Dashboard home = blueprint view:** stages as columns, nodes colored green=convergence /
  red=divergence / gray=absence·stale. Log list demoted to drill-down. Minimal version before **6/23 HN**;
  launch dates unmoved (base exists: drift-map.html).
- **Narrative shift this buys:** from "another memory tool" (crowded: Mem0/Letta/Zep) to "the Map that
  knows where your project is broken" (empty slot — nearest neighbors are spec-driven dev tools
  [Spec Kit/OpenSpec/Kiro: spec↔code, feature-level] and Jama's enterprise requirements-graph MCP;
  nobody spans business journey → GTM artifacts → code).

## 7. Anti-rot guards (the Map must not become the second CLAUDE.md)
- Map updates happen **in the same motion as recording** (the 3-way resolve flow writes back to map.yaml).
- map.yaml regions carry `stale_threshold` / `last_confirmed`; the Map itself is a node with
  `review_after` — ミイラ取りがミイラ guard (v2 §6) applies to the Map file itself.
- Node budget 30–60 enforced socially: the wizard warns past 60.

## 8. Week plan (agreed 2026-06-12)
spec v3 (this doc) → hand-write Linksee's own map.yaml (together — stage-name/granularity friction is the
data) → edges + where_am_i in MCP → blueprint dashboard view → 6/23 HN.
