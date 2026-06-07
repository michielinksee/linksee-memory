# Linksee v1 — Drift Observability (Design Memo v2)

**Increment over [v1](drift-detection-design-v1.md). Does not replace it** — v1 holds the locked
architecture, schema, and theory grounding (§0–§10). This memo records what we *learned and built*
executing build-order **steps 2 (seed) and 3 (detector)**, and the corrections those steps forced.

Date: 2026-05-30. Status after this memo: **steps 1–3 complete; steps 4–5 (verdict view, Drift View
cards) not yet built.**

---

## A. Correction to §8 — the "17 clean `rule_or_warning` prohibitions" was optimistic

v1 §8 planned to seed by promoting the 17 rows carrying a `rule_or_warning` shape. Hand-review of the
real pool (≈2k memories) found that estimate too generous:

- **Only ~5** `rule_or_warning` rows were genuine, violatable, code-linked norms.
- **9** were raw conversation / task text mis-classified as `rule_or_warning` (e.g. 56501, 33509–33505,
  29822, the "順番を逆にすると死ぬ" fragment 273166, observation 278223).
- **3** were marginal/stale (11671 recall-first workflow, 163883 a supabase workaround, 24339 a closed
  bug ticket).

**Seeding those as anchors would have manufactured false drift alerts — the exact opposite of the brand
promise (照合, not 推測).** So we *rejected* the noise and curated **10 pristine anchors** from
*structured keys* (`decision` / `caveat` / `rule_or_warning`) of hand-picked memory rows instead. The
declare-don't-mine principle held: a human reviewed every anchor and attached its lexical bridge
(`affects` / `detect_terms` / `violation_signal`). The curated set lives in
[`scripts/seed-anchors.mjs`](../scripts/seed-anchors.mjs) (re-runnable UPSERT, not published).

The 10 anchors (all `tier='explicit'`, `source='curate'`):

| id | src | kind | gist |
|----|-----|------|------|
| 1 | 334815 | decision | MCP public tools = 3 (remember/recall/read_smart); don't add a 4th |
| 2 | 293075 | constraint | Don't rebuild the 6-layer memories schema; additive-only (= Michie's revert constraint) |
| 3 | 293549 | constraint | session-extractor stores 5W1H/3-axis structure, never raw chat |
| 4 | 273165 | prohibition | Dashboard UI is not re-generated per view (V0/Lovable rejected) |
| 5 | 275326 | prohibition | No auto-crawl / robots-ignore / VPN scrape of Cosmetic-Info.jp |
| 6 | 167980 | prohibition | No token/NFT/P2E rewards in ScaNavi (Michie absolute-NG) |
| 7 | 276250 | constraint | New cosmetic ingredient → `check_new_ingredient()` INCI/alias dedup |
| 8 | 58911 | decision | SakeNavi brand links via explicit 【推薦銘柄】 LLM output, not text-scan |
| 9 | 367707 | constraint | KanseiLink reliability splits live telemetry from seed/eval estimate |
| 10 | 68316 | decision | Expo mobile pinned to SDK 54; don't bump to 55 (Expo Go incompat) |

---

## B. Path calibration — why the detector normalizes in JS, not SQL `GLOB`

`session_file_edits` = **6218 rows / 1721 distinct file_paths**. Reality on this machine is *absolute
Windows paths with mixed separators* — both `C:\Users\HP\...` and `C:/Users/HP/...` appear, mixed case.
SQLite `GLOB` is case-sensitive, Unix-glob (no `**`, and `*` crosses slashes), and unreliable here.

Real project roots (the `affects` fragments were calibrated to these): `linksee-memory/`,
`linksee-dashboard/`, `KanseiLINK/kansei-link-mcp/` (also a stale `Kansei LINK/` variant),
`Sake_Navi/` (NOT `sakenavi`/`vinox` — 0 matches), `Card_Navi/`,
`ReviewLens@Cosme@sensitiveskin/`, `ReviewLens-App/apps/mobile/` (Expo).

**Decision:** the detector does *all* path matching in JS — `normPath` lowercases and converts `\`→`/`,
then a compiled matcher does substring (no-wildcard fragment) or a `**`/`*`/`?` → regex test, unanchored
so a fragment matches anywhere in the absolute path. `affects` in the seed were rewritten to lowercase
forward-slash fragments accordingly (e.g. `sake_navi`, `linksee-memory/src/mcp/server.ts`).

---

## C. The detector as built — [`src/lib/drift-detection.ts`](../src/lib/drift-detection.ts)

Sibling to `edge-detection.ts` (which was **not** touched). Pure library (no CLI); run from the
consolidation sweep or a manual trigger. `detectDrift(db, { dryRun?, staleDays?, emitThreshold? })`.

- **Scope** (per v1 §6): an edit is in scope for an anchor if its normalized path hits any `affects`
  glob **OR** its linked memory is in the anchor's topical FTS set (`detect_terms` ≥3 chars, trigram).
- **contradicts**: emitted when a `violation_signal` term is literally present in the scope text
  (`path + context_snippet + linked-memory content`, lowercased) **and** confidence ≥ threshold.
- **confidence** = `min(tierW_anchor, 0.8) × scopeWeight` with `signalWeight = 1.0` (binary presence).
  `scopeWeight` = 1.0 (path-glob hit) / 0.6 (FTS-only). **Consequence worth noting:** reality tier is
  always 0.8, so under the 0.5 threshold an **FTS-only scope hit (0.8×0.6 = 0.48) can never emit a
  contradicts** — a contradiction *requires a declared path hit*. This is the precision-first stance,
  not a bug. FTS scope still matters: it correctly *suppresses false 'absent'* for a topically-reachable
  anchor. (For a future `tier='human'` anchor the math is identical — reality still caps at 0.8 — so the
  human/explicit distinction affects only *sort order* in §7, not the gate.)
- **absent**: emitted when an active anchor has **zero** scoped reality **and** `age ≥ STALE_DAYS`
  (default 14) — "not built yet ≠ drift". Not confidence-gated; confidence is sort/display only.
- **implements** (convergence): **deliberately deferred in v1.** At ~6k edits it would flood, and its
  `match_strength` is underspecified without a violation-signal to ground it (v1 §5 says `signalWeight=0`
  with no hit → conf 0, which contradicts §6's intent to emit it). Left unbuilt rather than half-built.
- **Idempotency / feedback loop:** contradicts uses `ON CONFLICT … DO UPDATE … WHERE status='open'`
  (refreshes confidence/evidence on re-run but **never resurrects a dismissed row**); absent uses
  `INSERT OR IGNORE` under the partial unique index `idx_drift_absent` (one open absence per anchor).

---

## D. Dogfood result (live DB, 2026-05-30) — a clean true negative, *proven* clean

Ran against 10 anchors × 6218 edits.

1. **Scope sees reality.** Per-anchor scoped-edit counts: 137, 44, 92, 78, 297, 1877, 241, 154, 154, 527.
   Every anchor matches real edits — the detector is *not* blind.
2. **Positive control passes.** Feeding known-present tokens through the identical `includes()` path:
   `sake`→1877, `memory`→688, `expo`→104 hits. So the signal pipeline demonstrably fires when a term *is*
   present.
3. **0 contradicts, 0 absent.** With (1)+(2) established, **0 is a genuine true negative**: across 4000+
   scoped edits, *no forbidden signal appears* — the codebase honored all 10 decisions (no
   `DROP TABLE memories`, no `expo@55`, no `NFT` in sake_navi, no `v0.dev`/`streamUI` in the dashboard).
   0 absent is also correct: all anchors are 0 days old, under the 14-day staleness gate.
4. **The detector makes zero false accusations at scale** — which *is* the precision-first promise.

### Calibration note surfaced by the control
Even the *correct* string `sdk 54` returns 0 hits — the Expo version lives as a number in `app.json`
(`"expo": "~54.x"`), never the literal phrase "sdk 54". This validates seeding the targeted signal
variants (`"expo": "^55`, `sdkversion: 55`) over a bare `SDK 55`. Same reasoning retired the
false-positive-prone `V0` → `v0.dev` (a bare `v0` would have matched semver strings like `v0.7.2`).

---

## E. Known v1 limitations (carry into step 4+ tuning)

- **Lexical FP risk** on generic single-word signals (`forget`, `consolidate`, `mint`). Mitigated by:
  narrow path scope, citation-backed evidence, and the `status='dismissed'` human feedback loop. A
  dismissed FP is a *teaching signal*, not a failure.
- **No 'absent' recomputation.** If an anchor later gains scoped reality, a previously-emitted open
  'absent' is not auto-cleared. Moot today (0 absents); revisit when anchors age past STALE_DAYS.
- **'implements' unbuilt** (see §C) — needs a defined convergence score before it ships.
- **No temporal gating** (per v1 §6): a pre-declaration contradiction would surface as existing
  divergence. None today.

---

## F. Revert path (Michie's locked constraint — reaffirmed)

The only drift objects in the DB are **2 additive tables** (`drift_anchors`, `drift_edges`) + 5 indexes.
`DROP TABLE drift_edges; DROP TABLE drift_anchors;` (CASCADE) restores schema v7 exactly. Verified intact
post-run: memories 2047, entities 41, session_file_edits 6218, memory_edges 1, schema_version 8. Nothing
in the existing engine was modified.

---

## G. Build order — updated status

1. ✅ anchor store + write path (schema v8, lib, CLI).
2. ✅ **seed** — 10 curated anchors (corrected down from the §8 "17" estimate). `scripts/seed-anchors.mjs`.
3. ✅ **detector** — `src/lib/drift-detection.ts`. Lexical/glob/FTS, no embeddings. Dogfooded clean.
4. ⬜ **verdict view** — divergence headline + absence secondary (v1 §7 SQL; queries already validated
   empty against the live DB).
5. ⬜ **Drift View** — top-3 contradiction cards.

**Open for step 4+:** whether to expose the detector as a manual trigger / consolidation-sweep hook, and
whether a live `declare_anchor` path is worth a 4th MCP tool (v1 §9 open question — decide after the view
exists and we can dogfm a real declared-then-violated cycle).
