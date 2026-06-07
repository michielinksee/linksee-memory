# Linksee v1 — Drift Observability (Design Memo v3)

**Increment over [v2](drift-detection-design-v2.md) (which incremented [v1](drift-detection-design-v1.md)).
Does not replace either.** v1 = locked architecture/schema/theory; v2 = steps 2–3 (seed corrections +
detector). This memo records build-order **step 4 — the verdict / view layer**.

Date: 2026-05-30. Status after this memo: **steps 1–4 complete; step 5 (Drift View cards in the
dashboard) not yet built.**

---

## A. What step 4 built — [`src/lib/drift-view.ts`](../src/lib/drift-view.ts)

The READ side of drift observability, pairing with `drift-detection.ts` (the WRITE side). It turns
`drift_edges` into Drift View cards (v1 §7) and provides the human feedback action. Pure read except
the one status writer. No schema change — purely additive (a new lib file + a `status` UPDATE on an
existing column), so the revert path from v2 §F is unchanged.

Exports:

- **`getDriftHeadline(db, {limit=3})`** — v1 §7① divergence: `verdict='contradicts' AND status='open'
  AND anchor active`, ordered `confidence DESC, (tier='human') DESC, occurred_at DESC`. Returns
  `DriftHeadlineCard` = anchor `statement` + `rationale` (WHY) + cited reality
  (`file_path`/`context_snippet`/`occurred_at`) + `confidence` + `hit_term` (lifted from evidence JSON).
- **`getDriftAbsences(db, {limit=10})`** — v1 §7② absence: `verdict='absent' AND status='open'`, oldest
  unfulfilled decision first (`a.created_at ASC`). Returns `DriftAbsenceCard` (+ `age_days` from evidence).
- **`getDriftView(db, {headlineLimit, absenceLimit})`** — one-call combiner: `{ headline, absences,
  counts }`, where `counts = { contradicts_open, absent_open, dismissed }` (the badge numbers step 5 needs).
- **`setDriftEdgeStatus(db, edgeId, status)`** — the feedback action; `status ∈ open|ack|dismissed|
  resolved`. `dismissed` is the precision signal.

Card shape matches v1 §7 exactly: **[anchor statement + WHY] / [reality `file_path:snippet` +
`occurred_at`] / [verdict + confidence] / dismiss**.

### Design note — why a dismissal sticks
The detector's contradicts write is `ON CONFLICT … DO UPDATE … WHERE status='open'`. So when the
detector re-runs, it refreshes confidence/evidence on *open* edges only and **never flips a `dismissed`
row back to `open`**. The read layer filters `status='open'`, so a dismissed false positive stays gone
across re-runs. The two modules close the precision loop without extra bookkeeping.

---

## B. Verification (live + rolled-back positive control)

The live corpus has **0 genuine drift** (v2 §D), so the view queries correctly return empty — which on
its own can't prove the view *renders* a card. So the test had two halves:

1. **Live:** `getDriftView` → `{ headline: [], absences: [], counts: {0,0,0} }`. Correct.
2. **Positive control, inside a transaction that is then rolled back:** insert one synthetic
   `contradicts` edge on a real anchor (#1) + a real edit, then:
   - `getDriftView` → **1 headline card**, fully populated (anchor #1 statement + rationale + the real
     edit's `file_path`/`snippet`/`occurred_at` + `confidence 0.8` + `hit_term`); `contradicts_open=1`.
   - `setDriftEdgeStatus(edge, 'dismissed')` → returns `true`; card **leaves the headline**;
     `contradicts_open=0, dismissed=1`.
   - **ROLLBACK** → `SELECT COUNT(*) FROM drift_edges = 0`. Corpus untouched.

So the view + feedback loop demonstrably work, and verifying them cost the live data nothing.

---

## C. Build order — updated status

1. ✅ anchor store + write path (schema v8, lib, CLI).
2. ✅ seed — 10 curated anchors (`scripts/seed-anchors.mjs`).
3. ✅ detector — `src/lib/drift-detection.ts` (lexical/glob/FTS, no embeddings). Dogfooded clean.
4. ✅ **verdict / view layer** — `src/lib/drift-view.ts` (§7① headline, §7② absences, counts, dismiss).
5. ⬜ **Drift View** — top-3 contradiction cards in the dashboard, consuming `getDriftView`.

### Hand-off to step 5
Step 5 is presentation (linksee-dashboard). It should call `getDriftView(db, { headlineLimit: 3 })` and
render: the badge counts, the ≤3 headline cards (statement/WHY/reality/confidence + a dismiss button
wired to `setDriftEdgeStatus(edge, 'dismissed')`), and the absences as a secondary tab. Remember the
dashboard's own anchor #4: **don't re-generate the UI per view** — this is a fixed "always in the same
place" view, not codegen. Also still open from v1 §9: whether a live `declare_anchor` path is worth a
4th MCP tool — decide after dogfooding a real declared-then-violated cycle through the rendered view.
