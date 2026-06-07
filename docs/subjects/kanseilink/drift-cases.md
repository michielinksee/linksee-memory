# KanseiLINK — Drift Cases (the method in action)

> Worked examples of Drift OS on KanseiLINK. Each = **intent ↔ reality ↔ verdict ↔ resolution**.
> The discriminator: a divergence is drift **only if NOT accounted-for** by a recorded decision.
> Evolution (recorded) is suppressed; abandonment (un-owned) is flagged. Implementation locations
> are abstracted per A4改.

## Case 1 — A21 deep-link: absent → fixed → verified (full lifecycle) ✅
- **Intent:** every applicable MCP response embeds a canonical app/deep-link (the App is the paid exit).
- **Reality (initial):** the link was absent in tool outputs.
- **Verdict:** T3 flagged **absent** (unaccounted) → a human declared a T2-verifiable constraint.
- **Resolution:** implemented across 10 applicable tools → committed → T2 sweep on **committed**
  reality = `fully_verified`. Drift OS caught its *own* overclaim twice (partial-verified, then
  working-tree-vs-committed) before allowing `fully_verified`.
- **Lesson:** the clean **detect → declare → fix → verify** loop, grounded in committed reality.

## Case 2 — A4 stealth → A4改 two-layer: evolution, NOT drift ⚪→🔵
- **Intent (old):** full stealth; never publish the framework.
- **Reality:** public docs, README, site, AEO articles exist.
- **Verdict:** looks like divergence — but a recorded **supersede** (A4 → A4改) accounts for it.
- **Resolution:** `accounted = true`, `surface_card = false`. Suppressed as evolution.
- **Lesson:** **make-or-break** in action — a recorded decision turns "divergence" into "convergence
  with the new intent." This is the noise-suppression that makes the product trustworthy.

## Case 3 — A5 focus areas: stalled-core, held ⚠️
- **Intent:** Agent Insights (collective intelligence) is a core focus.
- **Reality:** unproven at single-agent scale (N=1); needs multi-agent adoption.
- **Verdict:** `at_risk` — declared-core but unproven.
- **Resolution:** acknowledged + **time-boxed** (reopens ~2026-07-04). Held, not closed.
- **Lesson:** ⚪保留 — acknowledged ≠ resolved; the clock prevents silent abandonment.

## Case 4 — seed idempotency: a confirmed mechanical drift 🔴 (illustrative)
- **Intent:** seed/ingest must be idempotent so re-ingest refreshes category / tag / trust (UPSERT).
- **Reality:** a seed path used a non-idempotent insert-or-ignore, so re-ingest did **not** refresh
  existing rows.
- **Verdict:** confirmed drift — un-owned (no recorded decision), mechanically detectable.
- **Resolution:** fix the seed path to UPSERT. *(Implementation location abstracted.)*
- **Lesson:** a mechanical **"Hard heartbeat"** drift — code/timestamp-checkable, high-confidence,
  low-noise.

## Case 5 — ops "quiet death" watches ⚠️ (illustrative)
- Article-routine cadence · npm/README freshness · deploy split/duplication · manual ranking-regen
  staleness — all **Hard-heartbeat** checks (timestamp + external API). These are the
  highest-value, lowest-noise signals: *"should continue, but stopped."*

---
Related: `intent-anchors.md` · `decision-log.md` · `product-skeleton.md`
