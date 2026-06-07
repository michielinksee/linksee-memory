# Linksee v1 — Drift Observability (Design Memo v6)

**Increment over [v5](drift-detection-design-v5.md) (v5 closed open-questions (a)+(b); v4 = step 5
dashboard; v3 = view layer; v2 = seed+detector; v1 = locked architecture). Does not replace any.**
This memo records the **first concrete move on open-question (c) — detector trigger cadence**: a small,
additive `detect` CLI bin so the loop is runnable without a temp file.

Date: 2026-05-31. Status: v1 loop now has a real, built run-command. The *live-cadence* sub-decision
(auto-trigger vs. stay manual) is still open and is the remaining piece of (c).

---

## A. What was added — `linksee-memory-detect` (1 new file + 1 package.json line)

The manual-trigger entry point for the detector. Mirrors `declare-anchor.ts` exactly (same `parseFlags`,
same `openDb()+runMigrations()` standalone guard, same JSON print). Up to v5 the detector could only be
run through the now-deleted `_dogfood.ts` temp runner; this replaces that with a permanent, safe command.

- **`src/bin/detect-drift.ts`** (new) — calls `detectDrift(db, { dryRun, staleDays, emitThreshold })`,
  prints a curated summary (`mode`, counts, `byAnchorHits` filtered to real hits, first 10 `samples`).
- **`package.json`** (edited, additive) — registered `"linksee-memory-detect": "dist/bin/detect-drift.js"`
  alongside the other six bins. (Built into `dist/bin/detect-drift.js` via the standard `npm run build`.)

### CLI surface
```
linksee-memory-detect                  # DRY RUN — preview drift, writes NOTHING (default)
linksee-memory-detect --persist         # write contradicts/absent edges into drift_edges
linksee-memory-detect --stale-days 30   # override absence staleness gate (default 14)
linksee-memory-detect --threshold 0.5   # override emit threshold (default 0.5)
```

**Safe by default = dry-run.** A bare run reads only — you preview drift before committing it to the
view; writes require an explicit `--persist`. This matches the additive/revert posture: running the
command can't dirty the corpus by accident, and the only table it ever writes is `drift_edges` (the
feature's own table), only on `--persist`.

**This is a CLI bin, NOT a 4th MCP tool.** Anchor #1 ("don't add a 4th MCP public tool lightly") is about
the MCP server's public tool surface, which **stays at 3**. CLI bins are a separate surface (6 → 7) and
don't touch the MCP tool count. declare-don't-mine is also untouched: `detect` only *reads* anchors and
*writes edges*; it never creates an anchor.

---

## B. Verification (live corpus, 2026-05-31)

1. **Dry-run (default):** `anchorsScanned 10, editsScanned ~6.28k, contradicts 0, absent 0, edgesEmitted
   0, persisted false`, `byAnchorHits []`. Clean baseline — no live drift.
2. **`--persist` on the clean corpus:** same counts, `edgesEmitted 0`, `persisted true`. It wrote nothing
   because there is nothing to write → `drift_edges` stays at baseline **0**. (Confirms the write path
   runs without error and is a no-op on a clean corpus.)
3. **Numeric flag passthrough — `--stale-days 0`** (forces the absence gate fully open): still
   `absent 0`. Meaningful signal: **every one of the 10 active anchors has reality in scope** (none is
   orphaned), so no false absence fires even with the staleness gate disabled.
4. **Type-check + build:** `tsc --noEmit` exit 0 (whole project clean, including the new file);
   `npm run build` emitted `dist/bin/detect-drift.js`; running it via `node dist/bin/detect-drift.js`
   reproduced the clean dry-run output. Both dev (`tsx src/bin/detect-drift.ts`) and built (`node dist/...`)
   paths work.

Corpus integrity: unchanged. `drift_anchors` active = 10, `drift_edges` = 0. (`session_file_edits` ticks
upward only from the live engine recording other activity.)

---

## C. Revert path (still trivial, Michie's locked constraint)

- Delete `src/bin/detect-drift.ts` and the built `dist/bin/detect-drift.js` (+ `.d.ts`).
- Remove the one `"linksee-memory-detect"` line from `package.json` `bin`.
- No existing file's behavior changed; the detector lib, schema, engine, and dashboard are all untouched.

---

## D. Where open-question (c) stands now

- **Manual run: DONE** — `linksee-memory-detect [--persist]` is the permanent, safe trigger. The loop no
  longer needs a temp file.
- **Live cadence: STILL OPEN** — should detection *auto-run*, and if so where?
  - **Option 1 — consolidation-sweep hook:** call `detectDrift` inside the engine's `consolidate()`. Makes
    `/drift` truly live, but is the **first code-touch into the existing engine path** (a small departure
    from "purely additive" — would want it guarded/opt-in).
  - **Option 2 — on-`/drift`-load (dashboard side):** run `--persist`-equivalent when the page is opened.
    Stays engine-untouched (additive; the dashboard already has a writable-connection pattern), but only
    updates when someone looks.
  - **Option 3 — leave it manual** for v1: run the CLI (or a scheduled task) on demand. Zero new coupling.
- **No urgency:** the live corpus has 0 genuine drift, so any cadence renders the same clean state today.
  The decision is about freshness, not correctness.

## E. Build order — COMPLETE + DOGFOODED + RUNNABLE

1. ✅ anchor store + write path.   2. ✅ seed (10 anchors).   3. ✅ detector lib.
4. ✅ verdict/view layer.   5. ✅ Drift View (`/drift`) + dismiss loop.   6. ✅ organic dogfood (v5).
7. ✅ **`detect` CLI bin (this memo)** — the loop is now runnable as a real command, dry-run-safe by default.

Remaining: open-question (c) *live cadence* sub-decision (above), and (d) `implements`/`absent` recompute
(still deferred until anchors age past STALE_DAYS or convergence gets a defined score).
