# KanseiLINK — Subject Profile

> **Drift OS subject package (PUBLIC abstraction).** This is the source-of-truth for what
> KanseiLINK *intends to be*, so drift = (this declared intent) vs (committed reality).
> Proprietary internals — evaluation logic, scoring weights, ranking/recommendation logic,
> accumulated MCP intelligence — are deliberately **excluded** here, per the project's own
> public/private rule (see `intent-anchors.md` → A4改). Internal pricing, revenue, ops
> runbooks and raw conversation history are kept local, never in this repo.

## One line
KanseiLINK = discovery / selection / visibility infrastructure for SaaS & MCP services in the
agent era — **AEO (Agent Engine Optimization)**, the "Ahrefs of the AEO era."

## Why it exists
AI agents increasingly decide *which* SaaS/API to call. KanseiLINK helps agents discover and
select services (and helps SaaS vendors stay visible to agents) using **real agent-usage
signals** rather than human-SEO heuristics.

## Vocabulary
- **AEO** — *Agent* Engine Optimization (NOT Answer Engine Optimization). Optimizing for agent
  discovery/selection.
- **MCP** — Model Context Protocol surface; KanseiLINK is itself an MCP server agents query
  directly (**agent-native**).
- **Recipe** — a multi-service integration pattern (the product core).
- **Agent Insights** — collective-intelligence layer: agents report outcomes, others benefit
  (the "Agent Logbook").
- **Agent economy (3-layer)** — MCP (free acquisition) / App (the paid "exit") / KanseiLINK
  (discovery + quality).

## Differentiation (4 layers)
Recipe layer · Agent Insights (collective intelligence) · Japan-market focus · agent-native API design.

## Domains tracked
Strategy · Product · Tech · Ops · Growth · Timeline/Priority — see `product-skeleton.md`.

## Public vs private (the governing rule)
Per anchor **A4改**: **PUBLIC** = thesis, market education (AEO / MCP discovery / agent economy),
docs/README, the public-score *concept*, articles. **PRIVATE** = evaluation logic, scoring
weights, proprietary framework, accumulated MCP intelligence, ranking/recommendation logic.
This package contains only the public layer.

---
Files: `intent-anchors.md` (declared directions) · `product-skeleton.md` (structural map) ·
`decision-log.md` (recorded evolution) · `drift-cases.md` (the method in action).
