# KanseiLINK — Decision Log (recorded resolutions)

> ADR-style record of **accounted** changes — evolution, NOT drift. Drift OS suppresses these
> (make-or-break: a divergence explained by a recorded decision is not flagged). Each =
> context / decision / consequence + the Drift OS action.

## D1 — A4: full-stealth → public/private split  *(supersede)*
- **Context:** original A4 = fully-stealth agent-facing MCP + human-facing dashboard; the strategy
  framework was not to be published at all.
- **Decision:** superseded by **A4改** — split public vs private instead of hiding everything.
  PUBLIC = thesis / market education / docs / README / public-score concept / articles.
  PRIVATE = evaluation logic / scoring weights / proprietary framework / accumulated MCP
  intelligence / ranking-recommendation logic.
- **Consequence:** public docs & articles are *expected*, not a leak.
- **Drift OS action:** **T3 supersede** (anchor 25 → 30). A4 retired; A4改 active as the governing
  constraint. Reality matching the public layer = convergent, not divergent.

## D2 — A5: focus-areas at risk  *(acknowledge + validate, time-boxed)*
- **Context:** the four focus areas (Recipe / agent-native / Japan / Agent Insights). Agent
  Insights especially is core but unproven at single-agent scale (N=1).
- **Decision:** acknowledge as `at_risk` and **time-box** validation — neither flag-as-drift nor
  silently drop.
- **Consequence:** ⚪ **held, NOT resolved.** Auto-reopens for review **~2026-07-04** if still unvalidated.
- **Drift OS action:** **T3 acknowledge_validate** (`review_after` set). acknowledged ≠ resolved.

## D3 — A21: app/deep-link mandate  *(fix → verified)*
- **Context:** the 3-layer model needs MCP responses to route users to the App (the paid exit), but
  the deep-link was **absent** in implementation.
- **Decision:** declare a **T2-verifiable constraint** (responses returning tool/score/recommendation/
  diagnosis must include a canonical app/deep-link when applicable) and implement it.
- **Consequence:** implemented across **all 10 applicable tools**; 13 tools classified not-applicable;
  0 pending / 0 needs-review.
- **Drift OS action:** **T3 fix** (direction 29 + constraint 31) → **T2 mechanical sweep on committed
  reality** → `fully_verified` (10/10 applicable emit the link). Auto-demotes if a new tool or a
  regression appears — `fully_verified` is a checked state, not a permanent badge.

---
Related: `intent-anchors.md` · `drift-cases.md`
