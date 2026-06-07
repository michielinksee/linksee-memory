# Linksee v1 — Drift Observability (Design Memo v9)

**Increment over [v8](drift-detection-design-v8.md) (v8 = the reframe: 最初の設計≠正義, belief revision,
②=drift-map, ①→② order). Does not replace any.** v8 set the *direction*; **v9 is the BUILD** of the
first piece — the **3-way belief-revision resolution** in ① — so the product stops being a scold and
starts generating ②'s raw material.

Date: 2026-06-01. Status: 3-way resolution shipped + verified end-to-end + corpus torn down to baseline.

---

## A. What shipped — 3 files in `linksee-dashboard` (additive, NO schema change)

The dismiss loop generalized from binary (open→dismissed) to a **3-way belief-revision** choice. The key
realization: the three outcomes map onto **existing** statuses + the existing anchor retire — so this is
purely additive, zero migration.

- **`lib/drift.ts`** — new `resolveDriftEdge(edgeId, resolution)` + `DriftResolution` type. One short-lived
  writable connection, one transaction. Mapping:
  | resolution | meaning | edge status | anchor |
  |---|---|---|---|
  | `fix_code` | reality is wrong → anchor STANDS, user fixes code | `ack` | unchanged |
  | `reality_won` | anchor is stale → reality is more grounded | `resolved` | **retired** (superseded; NOT deleted) |
  | `noise` | false positive | `dismissed` | unchanged |
- **`app/api/drift/dismiss/route.ts`** — now accepts `{edgeId, resolution}` → `resolveDriftEdge`; returns
  `{ok, edgeChanged, anchorRetired}`. Legacy `{edgeId, status}` path kept for back-compat.
- **`app/drift/drift-view.tsx`** — the single ✕dismiss replaced by a 3-button control
  (**「直す」/「現実が正」/「✕」**) + a neutral framing line under the verdict row:
  **「宣言と現実がズレています — どちらが今の正解？」**. This is 最初の設計≠正義 made literal in the UI:
  a drift is a *question*, not a verdict.

## B. Why `reality_won` = retire, not delete (AGM minimal change)
"Reality won" supersedes the anchor by **retiring** it (`status='retired'`), never deleting — the WHY
history is preserved (AGM minimal change; entrenchment resolved in reality's favor). Retired anchors drop
out of detection (active count falls), so the same drift won't re-fire. This is the supersede signal v8
§E identified as **②'s raw material**: an edge with `status='resolved'` whose anchor is `retired` =
"here I drifted, and the drift was right" — a recorded unconscious direction-shift. (For v1 that signal is
*inferable* from status+anchor-status; an explicit `resolution` column can be added later if ② needs it.)

## C. Verification — controlled dogfood (declared → detected → rendered → all 3 exercised → torn down)
Live corpus has 0 drift, so a positive control (as before, then hard-deleted):
1. **Declared** throwaway anchor **#12** via the real `declare-anchor` CLI (the known-firing TODO/secrets.ts
   prohibition; clean Japanese, `source=declare`).
2. **Detected** via the `detect-drift` bin → 1 `contradicts` edge **#3** (anchor 12, conf 0.8, open).
3. **Rendered:** `GET /drift` → 200; HTML contained the anchor statement + **「直す」+「現実が正」+
   framing「どちらが今の正解？」** — the 3-way control renders on the real card.
4. **Exercised all 3 over the real API** (`POST /api/drift/dismiss`), DB checked after each:
   - `fix_code` → edge `ack`, anchor active, `anchorRetired:false` ✓
   - `noise` → edge `dismissed`, anchor active ✓
   - `reality_won` → edge `resolved` **AND anchor 12 `retired`**, `anchorRetired:true`, active 10 / retired 1 ✓
5. **Teardown:** deleted edge #3 + anchor #12 → **baseline: drift_anchors active = 10, drift_edges = 0**,
   no retired residue. Temp helper deleted, preview stopped. Engine + schema untouched throughout.

## D. Revert path (still trivial)
- `lib/drift.ts` — delete `resolveDriftEdge` + `DriftResolution` + `RESOLUTION_TO_STATUS`.
- `app/api/drift/dismiss/route.ts` — drop the `resolution` branch (legacy `status`/`dismissDriftEdge` stays).
- `app/drift/drift-view.tsx` — restore the single dismiss button (revert to the v7 card).
- 3-file revert; engine, schema, and the read view are untouched.

## E. Known limits (v1 of the 3-way; revisit with ② / real usage)
- An `ack`'d-but-still-violating drift does not auto-resurface (ack = "I know, leave it"). Acceptable for v1.
- `ack`/`resolved` edges aren't counted in the header badges (only open/absent/dismissed are). A
  "解決済み (resolved)" count could be added when the funnel needs it.
- `reality_won` retires the old anchor but does **not** auto-create the superseding new anchor — the user
  re-declares via the CLI if the new reality should itself become an anchor. (Auto-supersede-with-new-version
  = a later enhancement.)

## F. Where we are
- ① now embodies 最初の設計≠正義 (neutral question + 3-way belief-revision). **Next: Michie confirms the
  導線 on her own single-user dashboard**, then **② (free/paid line)** gets decided (deferred per her call).
- **②** (drift-neighborhood memory-Map) stays design-only (v8 §D) until ① accumulates real
  `reality_won` resolution history to map.
- (d) `implements`/`absent` recompute — still deferred.

Status: 100% additive / reversible; engine + schema never touched.
