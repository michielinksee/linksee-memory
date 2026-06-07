# Linksee v1 — Drift Observability (Design Memo v5)

**Increment over [v4](drift-detection-design-v4.md) (which incremented [v3](drift-detection-design-v3.md)
→ [v2](drift-detection-design-v2.md) → [v1](drift-detection-design-v1.md)). Does not replace any.**
v1 = locked architecture/schema/theory; v2 = steps 2–3 (seed + detector); v3 = step 4 (verdict/view);
v4 = step 5 (Drift View in the dashboard, dismiss loop). This memo records the **resolution of the first
two v4 §F open questions** — (a) the readonly→writable dismiss sign-off, and (b) a full **CLI dogfood**
of the declare → detect → render loop with a **detector-produced (not injected) edge**.

Date: 2026-05-31. Status after this memo: v1 ships end-to-end **and is now dogfooded organically**.
Open questions (a) and (b) closed; (c) and (d) carry forward.

---

## A. Open question (a) — RESOLVED: keep the isolated writable dismiss connection

**Decision: keep it.** The dashboard's shared `getDb()` stays `readonly`; `dismissDriftEdge` keeps its
own short-lived writable `better-sqlite3` connection (WAL + `busy_timeout=3000`), opened-write-close. No
code change was required — the current step-5 state already implements this; the question was only
*keep vs. strict-readonly revert*, and Michie signed off on **keep**.

**Why keep, not revert.** The dismiss loop *is* the precision / noise-suppression mechanism the whole
v1 thesis rests on ("週に本物1個 ＞ 毎日ノイズ20個"). A strict read-only dashboard would let the **first
false positive stick forever** with no in-product way to clear it. The write is the single architectural
departure in step 5, it is well-isolated (one connection, one route), and the revert path still exists.

**Boundary going forward.** The write surface is now **settled at this one isolated connection** — do not
expand it without Michie's say-so. If we ever do want strict read-only: delete `app/api/drift/` + the
dismiss button = a **2-file revert** that keeps the read view (documented in v4 §B③/§D). The escape hatch
must *exist*; we are choosing not to *take* it.

---

## B. Open question (b) — DOGFOODED: declare → detect → render, with a detector-produced edge

v4 step-5 verification used a **positive control**: the contradicts edge was *injected* directly into
`drift_edges`, which proves the §7 SQL + the card render, but **not** that the detector itself finds a
real violation. This dogfood closes that gap by running the **whole loop for real** through the existing
CLI — no injection.

### B1. Declare (real CLI, declare-don't-mine intact)
A throwaway 11th anchor was declared via the actual `declare-anchor add` CLI (run from PowerShell to keep
Japanese argv free of mojibake — verified clean on readback):

- **kind:** `prohibition`
- **statement:** 本番設定にTODOプレースホルダの秘匿値（freee_client_id等）を残さない
- **rationale (WHY):** TODOのまま出荷するとfreee連携が壊れ、秘匿値が未設定のまま本番に出るリスク。
- **affects:** `["kansei-link-cockpit/packages/cockpit-mcp/src/secrets.ts"]`
- **detect_terms:** `["freee_client_id","secrets"]`
- **violation_signal:** `["TODO:"]`
- **tier:** `human`  → assigned id **#11**, status `active`.

The term `TODO:` was chosen because a prior corpus probe showed it appears in a **real `session_file_edits`
code/config snippet** (cockpit-mcp `secrets.ts`), so the citation would be genuine — not a term that only
lives in the linked conversation memory. (The earlier candidate `console.log` was rejected for exactly
that reason: its hits were in memory content, not the edited code.)

### B2. Detect (real detector, edge produced organically)
Ran the actual `detectDrift(db, { dryRun:false })`. It scoped anchor #11's `affects` glob over reality,
found real edit **#855773** (the `secrets.ts` config edit whose snippet literally contains
`"freee_client_id": "TODO: app 登録時..."` — **all values are placeholders, no real secrets**), matched
`violation_signal` `TODO:` in the haystack, and **emitted one `contradicts` edge**:

- `drift_edges` → `{ id, anchor_id:11, edit_id:855773, verdict:"contradicts", status:"open", confidence:0.8 }`
- confidence **0.8** = `min(tier_human 1.0, reality 0.8) × scope_glob 1.0`; scope `glob`, hit_term `todo:`.

This is the detector deciding on its own — exactly the deductive 照合 the product promises.

### B3. Render (/drift, real card from the real edge)
`/drift` re-rendered from the produced edge (verified via accessibility snapshot — the authoritative
text/structure source given the known Turbopack screenshot-timeout quirk):

- count badges **DIVERGENCE 1 / ABSENCE 0 / DISMISSED 0**; tab **🔴 Divergence (1)**;
- card fully populated: **🚫 禁止 · conf 80% · CONTRADICTS · ✕dismiss**, the statement + WHY, header
  **実際のコード**, file path `C:\…\kansei-link-cockpit\packages\cockpit-mcp\src\secrets.ts`, the real
  config snippet, date **2026/5/11**, and **検出語**.

**This is strictly stronger proof than v4 step 5:** step 5 injected the edge; here the detector *found* it
from a live-declared anchor, and every field on the card traces to a real file + snippet + term.

### B4. Teardown — baseline restored (corpus integrity, Michie's locked constraint)
Hard-deleted the produced edge **and** anchor #11 (`teardown 11` → `deleted edges=1 anchorRows=1`),
then confirmed counts: **drift_anchors active = 10, drift_edges = 0** — the exact pre-dogfood state. The
temp runner (`_dogfood.ts`) was deleted; the preview server was stopped. **No dashboard or engine file was
modified** — the dogfood only added one anchor row + one edge row (both now gone) and read everything else.
Revert path unchanged. (`session_file_edits`/`memories` counts sit higher than the 2026-05-30 probe because
the live engine keeps recording other activity; this work never wrote to those tables.)

### B5. Consequence for the 4th MCP tool (v4 §F sub-question)
The dogfood proves the loop runs end-to-end **via the existing CLI**. So a 4th MCP `declare_anchor` tool
is **not needed for v1** — anchors stay CLI/seed-declared (declare-don't-mine intact; MCP public tools
stay at **3**, honoring anchor #1: "don't add a 4th MCP tool lightly"). Defer live in-agent `declare_anchor`
until there's real demand for an agent to declare-then-watch a constraint mid-session.

---

## C. Revert path (still holds — unchanged from v4 §D)

- **linksee-memory:** unchanged — `DROP TABLE drift_edges; DROP TABLE drift_anchors;` restores schema
  v8→v7. The engine was never modified by any drift work, including this dogfood.
- **linksee-dashboard:** all step-5 changes additive — delete `lib/drift.ts`, `app/drift/`,
  `app/api/drift/`, revert the one home-header block in `app/page.tsx`. Readonly path (`lib/db.ts`) untouched.
- **tooling:** the one `dashboard` entry in `Card_Navi/.claude/launch.json` (preview registry) — remove to revert.

---

## D. Open questions carried past v5

- **(c) Detector trigger cadence** — manual run vs. a consolidation-sweep hook (run `detectDrift` whenever
  the engine consolidates, or on a schedule). **This is the next decision.** No live drift on the real
  corpus means no urgency, but cadence determines whether the Drift View is "live" or "on-demand".
- **(d) 'implements' convergence + 'absent' recompute** — still deferred; revisit when anchors age past
  `STALE_DAYS` (14) or convergence gets a defined score. (v1 emits `contradicts` + `absent` only;
  `implements` is not scored yet.)

## E. Build order — COMPLETE + DOGFOODED

1. ✅ anchor store + write path (schema v8, lib, CLI).
2. ✅ seed — 10 curated anchors (`scripts/seed-anchors.mjs`).
3. ✅ detector — `src/lib/drift-detection.ts` (lexical/glob/FTS, no embeddings).
4. ✅ verdict / view layer — `src/lib/drift-view.ts`.
5. ✅ Drift View — `/drift` in linksee-dashboard; dismiss loop live.
6. ✅ **Organic dogfood (this memo)** — declared a real anchor via CLI → detector produced a real
   `contradicts` edge → rendered in `/drift` → torn down to baseline. The deductive 照合 promise holds
   for the *full* loop, not just the render: **declare → detect → verdict → render → dismiss**, every card
   cites a real file + snippet + term; nothing inferred.
