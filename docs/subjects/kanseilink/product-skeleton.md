# KanseiLINK — Product Skeleton (abstracted)

> The "living skeleton" across 6 domains — the structural map Drift OS watches for the
> **"quiet death"** (things that should continue but stalled / were forgotten / split). Per A4改,
> **proprietary internals are abstracted out**: no scoring weights, trust mechanics, safeguard
> thresholds, endpoints, or file-level locations. COO/CMO drift observations live in `drift-cases.md`.

## 1. Strategy
- Position = "Ahrefs of the AEO era" — *Agent* Engine Optimization, a distinct market from Answer-EO.
- Monetization model = Google-style: free for agents/users; a **paid B2B intelligence layer** for
  vendors. (Model & pricing specifics are internal.)
- Free public signal → deeper paid intelligence (a flywheel: public visibility drives vendor demand).
- Two-layer posture (evolved — see A4改 / `decision-log.md` D1): public thesis & education vs.
  private proprietary core.
- Prohibitions: competitor-avoidance (no focus-scatter), self-neutrality (no preferential ranking
  of own products).

## 2. Product
- **Recipe layer is the core** (multi-service integration patterns).
- **Agent Insights / collective intelligence** (Agent Logbook: report-outcome → insights →
  service-tips). *Core value, still unproven at N=1 — needs multi-agent scale.*
- **agent-native**: KanseiLINK is itself an MCP server agents query directly.
- **3-layer agent economy**: MCP (free acquisition) / App (paid exit) / KanseiLINK (discovery).
  MCP responses embed app deep-links (see A21).
- **Japan-market focus**: Japanese SaaS coverage.

## 3. Tech (high level)
- Backend: embedded SQL store + full-text search; stdio + remote HTTP. Read-centric, stateless-friendly.
- Search: intent→category mapping via a **voting model** (weights internal) — beats naive FTS on
  intent queries.
- Japanese search: a **Japanese-aware multi-layer search architecture** — a differentiator (internals private).
- Trust scoring: **dynamic, category-specific, evidence-based** (not static; mechanics internal).
- Collective-intelligence: a **distributed discovery model with layered quality controls** (internals private).
- Canonical service IDs; **PII not stored / auto-masked**.
- Public MCP tool surface (search / lookup / report / inspect / analyze, plus others).
- Article generation: a **multi-stage fact-check pipeline** (prep → write → fact-check), grounded
  in the service seed (hallucination-hardened).

## 4. Ops — the "quiet death" zone (highest-value to monitor)
- **Article-publishing routine** = the adoption funnel (cadence-sensitive).
- **npm package** = external-trust signal (version / README freshness matters).
- **GitHub org/repo** = trust signal (issue / release cadence).
- **Remote deploy** (managed host) — watch for split/duplication & stale env.
- Official Registry: published (immutable).
- MCP directory submissions: keep current.
- Web ranking regen is **manual** — watch for staleness after data updates.
- Competitor watch.

## 5. Growth
- GTM channels (by efficiency): technical articles, official Registry, GitHub Topics,
  community/Discord, **direct outreach to Japanese SaaS vendors** (strongest persona contact).
- The **paid B2B intelligence layer** (vendor-facing) = the monetization body — still nascent.
- Public articles disclose tech only, not the strategy framework (strategy shown via results).

## 6. Timeline / Priority
- Phases **P1** (MCP translation / quick revenue) → **P2** (visualization + AEO) → **P3**. Currently ~P1/P2.
- Distribute & gather usage data first → admin dashboards later.
- Bootstrap validated: scenario runs improved search materially.

---
Related: `intent-anchors.md` · `drift-cases.md` · `decision-log.md`
