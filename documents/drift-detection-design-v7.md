# Linksee v1 — Drift Observability (Design Memo v7)

**Increment over [v6](drift-detection-design-v6.md) (v6 = the `detect` CLI bin / manual-run path;
v5 = (a)+(b) closures; v4 = dashboard step 5). Does not replace any.** This memo **closes
open-question (c) — detector trigger cadence** by shipping the **on-`/drift`-load** live cadence
(Michie's chosen option), built on top of the v6 bin.

Date: 2026-05-31. Status: the Drift View is now **live** — opening `/drift` runs the detector and
renders fresh. (a), (b), (c) all closed; only (d) `implements`/`absent` recompute remains deferred.

---

## A. What shipped — on-load live cadence (2 edits in `linksee-dashboard`, additive)

The detector now runs automatically when the `/drift` page is loaded, so the view always reflects the
current corpus — no manual run, no cron, no engine hook.

- **`lib/drift.ts`** (edited, additive) — new `refreshDrift()`: shells out to the **v6 built bin**
  (`node <linksee-memory>/dist/bin/detect-drift.js --persist`) via `execFile`, then returns. Key
  properties:
  - **No detector duplication.** The dashboard does NOT import or re-implement the detector (it has zero
    source dependency on linksee-memory — anchor #2). It invokes the *single* built bin. There is exactly
    one detector; a second copy could itself drift — fitting for this product to avoid.
  - **Throttled** — module-level `lastRefresh`; skips if run < 4s ago. A burst of rapid reloads collapses
    to one detector run (verified: 3 rapid loads → 1 run).
  - **Fail-safe** — wrapped in try/catch; a detector error logs and returns, the page still renders the
    last-known edges. Detection failure can never 500 the view.
  - **Bin path** — `process.env.LINKSEE_MEMORY_BIN` or default `~/linksee-memory/dist/bin/detect-drift.js`.
  - Logs a one-line summary per run: `[drift] on-load detect ran contradicts=N absent=N edges=N`.
- **`app/drift/page.tsx`** (edited, additive) — `DriftPage` is now an `async` server component; it
  `await refreshDrift()` before `getDriftView(...)`. `force-dynamic` already guaranteed no caching.

### Why on-load (not the consolidation hook)
On-load keeps the engine **completely untouched** — it's purely additive in the dashboard, which already
owns a writable-connection pattern (the dismiss path). The consolidation-sweep hook was the other live
option but would have been the *first* code-touch into linksee-memory's existing `consolidate()` path — a
departure from the locked additive stance. On-load gets "always fresh when you look" with zero new
coupling to the engine. (The third option, leave-manual, stays available via the v6 bin.)

### Concurrency (why this is safe)
The bin runs in a **separate process** and opens its own writable WAL connection; the dashboard's
`getDb()` stays readonly and the dismiss path opens its own short-lived writable connection. WAL = 1
writer + N readers across processes. The detector **upserts OPEN rows only**
(`ON CONFLICT … WHERE status='open'`), so an on-load re-detect **never resurrects a dismissed edge** —
dismiss + on-load compose correctly. (Theoretical bin-writer vs. dismiss-writer collision is covered by
the fail-safe; on a local single-user tool the two rarely overlap.)

---

## B. Verification (live, 2026-05-31)

1. **Renders:** `GET /drift` → **200**, ~18 KB HTML, drift markers present (照合 / Divergence / ドリフト).
2. **Detector fires on load:** server log `[drift] on-load detect ran contradicts=0 absent=0 edges=0`.
   The clean corpus yields 0 drift; `edges=0` → nothing written → `drift_edges` stays at baseline **0**.
3. **Throttle:** a tight burst of 3 `/drift` requests produced only **1** additional detector run.
4. **No errors:** server error log clean. (The detect→render of a *real* card was already proven in the
   v5 dogfood; v7 proves the on-load *trigger*. Together: open `/drift` → detect → render, fresh.)

Corpus integrity: `drift_anchors` active = 10, `drift_edges` = 0 — unchanged.

---

## C. Revert path (still trivial)

- **`app/drift/page.tsx`** — remove `await refreshDrift()` and the `refreshDrift` import; revert `async`.
- **`lib/drift.ts`** — delete the `refreshDrift` function + its 3 consts + the 2 added imports
  (`execFile`, `promisify`).
- 2-edit revert; the read view + dismiss are untouched, and linksee-memory is untouched (v6 bin stays as
  the manual run path). No engine code was ever modified across the whole drift feature.

---

## D. Open-question status after v7

- **(a) dismiss write** — CLOSED (v5): keep the isolated writable connection.
- **(b) declare→detect→render loop** — CLOSED (v5): organically dogfooded.
- **(c) detector trigger cadence** — **CLOSED (v6 + v7):** manual-run bin (v6) + on-`/drift`-load live
  cadence (v7). The view is live.
- **(d) `implements` convergence + `absent` recompute** — still DEFERRED; revisit when anchors age past
  STALE_DAYS or convergence gets a defined score.

## E. Build order — COMPLETE, DOGFOODED, RUNNABLE, LIVE

1. ✅ anchor store + write path.   2. ✅ seed (10).   3. ✅ detector lib.   4. ✅ verdict/view layer.
5. ✅ Drift View + dismiss.   6. ✅ organic dogfood (v5).   7. ✅ `detect` CLI bin (v6).
8. ✅ **on-load live cadence (this memo)** — `/drift` runs the detector on every visit.

v1 is a **live loop**: declare (curate) → **detect (on view load)** → verdict (§7) → render (/drift) →
dismiss (precision feedback). Every card cites a real file + snippet + term — 照合, never 推測.
