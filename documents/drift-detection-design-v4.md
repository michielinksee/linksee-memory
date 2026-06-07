# Linksee v1 — Drift Observability (Design Memo v4)

**Increment over [v3](drift-detection-design-v3.md) (which incremented [v2](drift-detection-design-v2.md)
→ [v1](drift-detection-design-v1.md)). Does not replace any.** v1 = locked architecture/schema/theory;
v2 = steps 2–3 (seed + detector); v3 = step 4 (verdict/view layer). This memo records the final
build-order step — **step 5, the Drift View in the dashboard** — and the decisions the dashboard's
constraints forced.

Date: 2026-05-31. Status after this memo: **build order steps 1–5 ALL COMPLETE.** v1 ships end-to-end:
declare → detect → verdict → render → dismiss.

---

## A. What step 5 built — `linksee-dashboard` (5 files: 4 new, 1 edited)

The presentation layer. A fixed `/drift` route that consumes the §7 verdict queries and renders the
Drift View cards + the human dismiss action. Lives in the dashboard repo (the human-optimized view),
not linksee-memory.

- **`lib/drift.ts`** (new) — the dashboard-side data layer. Re-implements the §7 READ queries
  (`getDriftView` / `getDriftCounts` → headline, absences, counts, active_anchor count). SQL is
  byte-for-byte the same intent as `linksee-memory/src/lib/drift-view.ts`. Also holds the single write,
  `dismissDriftEdge`, isolated behind its own short-lived writable connection (see §B③).
- **`app/drift/page.tsx`** (new) — server component (`force-dynamic`). Calls
  `getDriftView({ headlineLimit: 3 })`, renders the header + the Sentry-style count badges
  (Divergence / Absence / Dismissed), hands the rest to the client tab component.
- **`app/drift/drift-view.tsx`** (new, `"use client"`) — the two-tab view (🔴 Divergence primary,
  🟡 Absence secondary), the headline/absence cards, and the dismiss button. Card shape = v1 §7 exactly:
  **[kind + conf% + verdict + dismiss] / [anchor statement + WHY] / [実際のコード file_path + snippet +
  occurred_at + 検出語]**. Clean state is a *positive* signal: "✓ ドリフトは検出されていません — 宣言された
  N件の決定はすべて一致（照合済み・推測なし）".
- **`app/api/drift/dismiss/route.ts`** (new) — `POST { edgeId, status? }`, the one write surface; calls
  `dismissDriftEdge`. Validates edgeId; returns `{ ok, changed }`.
- **`app/page.tsx`** (edited, additive) — a "Drift" badge in the home header: red `🔴 N` when
  `contradicts_open > 0`, else a quiet `✓`, linking to `/drift`. Makes the view discoverable and
  "always in the same place".

---

## B. Three decisions the dashboard's constraints forced

**① Query replication, not import (anchor #2 made literal).** The dashboard has no dependency on
linksee-memory, so `drift-view.ts` cannot be imported. Per anchor #2 ("Memory and Dashboard are two
views of the SAME data"), `lib/drift.ts` re-runs the identical §7 SQL against the same `memory.db`. Two
readers of one schema — exactly the additive-only stance. (Timestamps: the dashboard SELECTs
`datetime(occurred_at,'unixepoch')` so the existing `new Date(s+"Z")` formatter applies unchanged.)

**② anchor #4 honored — the Drift View is fixed, not generated.** anchor #4 ("ダッシュボードUIは毎回
コードを新規生成しない … 第二の脳は『いつもの場所にある』べき") is already *literal code* in
`overview.tsx`: a comment reads *"Layout is data, not JSX … the widgets never change, only the spec."*
The Drift View obeys it — a hand-written route with fixed cards at a fixed URL. No per-view codegen,
no V0/Lovable. It is the same view every time; only the *data* (which edges) changes.

**③ Readonly dashboard + one isolated writable connection (the only architectural departure — wants
Michie's sign-off).** The dashboard's shared `getDb()` is deliberately `readonly`. The §7 dismiss loop
needs a write. Resolution: `dismissDriftEdge` opens its **own** short-lived `better-sqlite3` connection
(WAL + `busy_timeout=3000`), writes, closes — `getDb()` stays readonly and untouched. This is safe for a
local single-user tool (WAL = 1 writer + N readers, even across the MCP-server process). It is the
minimal way to honor v3's hand-off ("a dismiss button wired to setDriftEdgeStatus"). **If you'd rather
the dashboard stay strictly read-only for v1, we delete the API route + the dismiss button and keep the
read view — a 2-file revert.**

---

## C. Verification — browser positive control (live + injected, then torn down)

Live corpus has **0 genuine drift**, so the page correctly renders the clean state — which alone can't
prove a *card* renders. So, as in v3, a positive control (this time through the running dashboard, since
a rolled-back tx can't cross the HTTP boundary — inject → screenshot → hard-delete):

1. **Clean state (live):** `/drift` → badges `0 / 0 / 0`, "✓ ドリフトは検出されていません — 宣言された
   **10** 件…". The `10` confirms the active-anchor query. Home badge shows `✓`.
2. **Injected 1 synthetic `contradicts`** (anchor #1 × the real `server.ts` edit #847926, conf 0.8,
   evidence `{_synthetic, hit_term:'recall_file'}`): `/drift` re-render → **Divergence 1**, tab
   `🔴 Divergence (1)`, and the card fully populated from the real join — 💡決定 · conf 80% · CONTRADICTS,
   the anchor statement + WHY, `C:\…\src\mcp\server.ts`, the real snippet, `2026/5/29`, 検出語 `recall_file`.
   **The replicated §7 SQL works.**
3. **Dismiss loop:** clicked ✕ dismiss → server logs `POST /api/drift/dismiss 200` → `GET /drift 200` →
   card **leaves**, **Divergence 1→0, Dismissed 0→1**. The readonly+writable split works end-to-end over
   real HTTP, and the `status='open'` filter makes the dismissal stick.
4. **Teardown:** hard-deleted the synthetic edge → `drift_edges = 0`. Corpus intact: anchors 10,
   `drift_edges` 0; `memories` / `session_file_edits` never written by this work (their counts drift
   upward only from the live engine recording other activity). Revert = unchanged.

(Note: `preview_screenshot` timed out twice — a Turbopack dev-overlay capture quirk, not a page error;
console was clean. Verified via the accessibility snapshot + server logs, which are authoritative for
text/structure/HTTP.)

---

## D. Revert path (Michie's locked constraint — still holds)

- **linksee-memory:** unchanged from v3 — `DROP TABLE drift_edges; DROP TABLE drift_anchors;` (CASCADE)
  restores schema v8→v7. The engine was never modified.
- **linksee-dashboard:** all step-5 changes are additive — delete `lib/drift.ts`, `app/drift/`,
  `app/api/drift/`, and revert the one home-header block in `app/page.tsx`. No existing file's behavior
  changed; `lib/db.ts` (the readonly path) was not touched.
- **tooling (outside both products):** a `dashboard` entry was added to `Card_Navi/.claude/launch.json`
  (the session's preview registry, alongside the 5 existing sibling-project entries) so the dashboard
  can be previewed via `cmd /c cd /d …linksee-dashboard && npx next dev`. Remove that one entry to revert.

---

## E. Build order — COMPLETE

1. ✅ anchor store + write path (schema v8, lib, CLI).
2. ✅ seed — 10 curated anchors (`scripts/seed-anchors.mjs`).
3. ✅ detector — `src/lib/drift-detection.ts` (lexical/glob/FTS, no embeddings). Dogfooded clean.
4. ✅ verdict / view layer — `src/lib/drift-view.ts`.
5. ✅ **Drift View** — `/drift` route in linksee-dashboard, consuming the §7 queries; dismiss loop live.

v1 is a working loop: **declare (curate) → detect (lexical/glob/FTS) → verdict (§7) → render (/drift) →
dismiss (precision feedback).** The deductive 照合 promise holds end-to-end: every card cites a real
file + snippet + term; nothing is inferred.

## F. Open questions (carry past v1)

- **Readonly→writable sign-off** (§B③) — keep the dismiss write, or make the dashboard strictly read-only
  for v1? Awaiting Michie.
- **4th MCP tool / live `declare_anchor`** (v1 §9, still open) — now decidable: we have the rendered view
  to dogfood a real *declared-then-violated* cycle. Until then anchors come only from `seed-anchors.mjs`
  (declare-don't-mine intact). Watch against anchor #1 (MCP public tools = 3; don't add a 4th lightly).
- **Detector trigger cadence** (v2 §G) — manual run vs. consolidation-sweep hook. Unchanged; no live
  drift means no urgency yet.
- **'implements' convergence + 'absent' recompute** (v2 §C/§E) — still deferred; revisit when anchors
  age past STALE_DAYS or convergence gets a defined score.
