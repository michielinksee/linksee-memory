# Linksee v1 — Drift Observability (Design Memo v1)

**Status:** 2026-05-30 · Architecture LOCKED (additive) · Build order step 1 SHIPPED (schema v8 + write path)
**Scope:** the "intent vs. reality" detector that sits *on top of* the linksee-memory engine.

---

## 0. What this is (and what it is not)

Linksee v1 is **drift observability**, not another memory engine. It is positioned *above* memory
engines (Mem0/Zep/Letta become observation targets) the way Sentry/Datadog sit above the app and the
cloud. The headline feature is the **Drift View**: surface where a **declared decision (intent)**
diverges from **what the code actually did (reality)**.

The product promise is **deductive 照合 (decided-vs-actual matching), NOT 推測 (gap-guessing).**
"I found code that violates *your own stated rule*, here is the file and line" is promise-able.
"I sense what you're missing" always betrays. Every design choice below biases toward
explicit × explicit matching with citations.

This lives as a **purely additive layer** on the existing `linksee-memory` DB. Existing
`memories` / extraction / recall are untouched; the revert path is to drop two tables.

---

## 1. Correction that shaped the design: there is no embedding layer

`sqlite-vec@^0.1.6` is a dependency in `package.json` but is **unused anywhere in `src`** — no
`loadExtension`, no `vec0` virtual table, no `embedding` column, no import. Retrieval today is
**FTS5 trigram + BM25 + heat_score** (`src/db/schema.sql` "BM25-ranked retrieval"; `src/skill/SKILL.md`
"FTS5 full-text search + heat_score ranking").

Consequence: the detector's similarity **must be lexical/structural**, not semantic. This is not a
downgrade — it is *on-brand*. A lexical/structural match is auditable (照合): "your declared term `X`
appears in `file:line`." An embedding cosine score is opaque (推測). The whole pitch is deduction with
a citation, so FTS5 + term-overlap + path globs + a declared violation signal is the *right* engine,
not a fallback. (sqlite-vec stays a Phase-2 recall booster; v1 does not touch it.)

---

## 2. Architecture (LOCKED 2026-05-30, chosen over retrofit & greenfield)

- **New** tables `drift_anchors` (intent) + `drift_edges` (verdicts) + **new** module
  `src/lib/drift-detection.ts` (a sibling to `src/lib/edge-detection.ts`, which it does **not** modify).
- **Reuse** `session_file_edits` (the 6k-row reality corpus), `memories_fts` (FTS5/BM25), and the
  Reflexion relation vocabulary.
- **Untouched**: `memories`, the extraction pipeline, recall. Pollution lives in *extraction*
  (`session-extractor.ts` pattern-matching), not in the schema — so declare-don't-mine side-steps it
  regardless, and greenfield would only discard the working capture pipeline for no benefit.
- **Revert** = `DROP TABLE drift_edges; DROP TABLE drift_anchors;` (+ undo the v7→v8 meta bump). One
  byte of existing structural schema changed = zero.

### Why `drift_edges` is a new table, not `memory_edges`
`memory_edges` FKs *both* ends to `memories(id)`. A drift edge connects an **anchor**
(`drift_anchors`) to a **reality unit** (`session_file_edits`). The FKs don't fit, so it is its own
table. (`memory_edges` also remains intent×intent only — the "Pivot Chain" supersession graph from
`edge-detection.ts`. That is a different relationship and stays as-is.)

---

## 3. The intent store — `drift_anchors` (clean by construction)

An anchor is a **declared normative claim**. Three kinds:

| kind | shape | violation = | headline? |
|------|-------|-------------|-----------|
| `prohibition` | "never do X" | presence of X in scope | yes (cleanest) |
| `decision` | "chose A over B" | presence of B in scope | yes |
| `constraint` | "must always do X" | absence of X within the act | hard — v1 leans on the absence verdict |

```sql
CREATE TABLE drift_anchors (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  kind             TEXT NOT NULL CHECK (kind IN ('prohibition','decision','constraint')),
  statement        TEXT NOT NULL,                  -- the normative claim, verbatim
  rationale        TEXT,                           -- WHY (entrenchment context)
  affects          TEXT NOT NULL DEFAULT '[]',     -- JSON array of path globs that scope reality
  detect_terms     TEXT NOT NULL DEFAULT '[]',     -- JSON array: topical terms (FTS/overlap scoping)
  violation_signal TEXT NOT NULL DEFAULT '[]',     -- JSON array: terms whose PRESENCE in scope = violation
  tier             TEXT NOT NULL DEFAULT 'human'   CHECK (tier IN ('human','explicit')),
  source           TEXT NOT NULL DEFAULT 'declare' CHECK (source IN ('declare','curate','claude_md')),
  source_memory_id INTEGER REFERENCES memories(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'active'  CHECK (status IN ('active','retired')),
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);
```

**declare-don't-mine is enforced by the schema.** `tier CHECK ('human','explicit')` means an
`agent`/`inferred` memory *physically cannot* become an anchor. Verified: a raw
`INSERT ... tier='agent'` is rejected at the DB level, not just by the lib. Anchors come only from
explicit declaration (CLI declare / curation / CLAUDE.md), never from the session pattern-extractor.

`violation_signal` is what makes a verdict **deductive**. A prohibition carries both the topical
`detect_terms` (scoping) and the `violation_signal` (the forbidden act). "Your anchor prohibits
asserting safety; `articles/x.md` contains 'is safe'" needs no guessing.

`source_memory_id` is `ON DELETE SET NULL` so an anchor **outlives** the memory it was curated from
(forgetting the origin must not silently kill the rule).

---

## 4. The verdict store — `drift_edges`

```sql
CREATE TABLE drift_edges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  anchor_id   INTEGER NOT NULL REFERENCES drift_anchors(id) ON DELETE CASCADE,
  edit_id     INTEGER REFERENCES session_file_edits(id) ON DELETE CASCADE,  -- NULL for pure 'absent'
  verdict     TEXT NOT NULL CHECK (verdict IN ('contradicts','implements','absent')),
  confidence  REAL NOT NULL DEFAULT 0.0,
  evidence    TEXT NOT NULL DEFAULT '{}',   -- JSON: file_path, context_snippet, shared_terms, hit_term, occurred_at
  status      TEXT NOT NULL DEFAULT 'open'  CHECK (status IN ('open','ack','dismissed','resolved')),
  detected_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(anchor_id, edit_id, verdict)
);
-- 'absent' has edit_id NULL (UNIQUE treats NULLs as distinct) → one open absence per anchor:
CREATE UNIQUE INDEX idx_drift_absent ON drift_edges(anchor_id) WHERE verdict = 'absent';
```

`status='dismissed'` is the precision feedback loop: a user dismissing a false positive is a teaching
signal for tuning. Verdict vocabulary is from Software Reflexion Models (Murphy-Notkin-Sullivan 1995):
**convergence (`implements`) / divergence (`contradicts`) / absence (`absent`)**.

---

## 5. Tier & confidence

```
tierWeight:  human = 1.0,  explicit = 0.8
reality tier = explicit (0.8)            # a real session_file_edit demonstrably happened
match_strength ∈ [0,1] = scopeWeight × signalWeight
    scopeWeight  : path-glob hit = 1.0 / FTS-term-only = 0.6
    signalWeight : violation_signal presence, BM25-normalized by hit count (no hit = 0)

confidence = min(tierWeight_anchor, tierWeight_reality) × match_strength
emit ⇔ confidence ≥ EMIT_THRESHOLD (start 0.5) AND both ends ≥ explicit
```

The "both ends ≥ explicit" gate is automatically satisfied: the anchor side is guaranteed by the
schema CHECK, and the reality side is a real edit. Grounded in AGM entrenchment (human > explicit)
and TMS justification graphs (belief + WHY + auto-contradiction).

---

## 6. The detector — `src/lib/drift-detection.ts` (NOT yet built; build order step 3)

```
for anchor in (SELECT * FROM drift_anchors WHERE status='active'):
    globs, terms, signals = JSON(anchor.affects / detect_terms / violation_signal)

    # (1) scope reality — precision pre-filter, existing infra only
    scoped = session_file_edits WHERE
        file_path GLOB any(globs)                                    -- structural scope
        OR memory_id IN (SELECT rowid FROM memories_fts              -- topical scope (BM25)
                         WHERE memories_fts MATCH ftsQuery(terms))

    if scoped is empty:
        if ageOf(anchor) ≥ STALE_DAYS:                               # suppress "not done yet ≠ drift"
            upsert drift_edges(anchor_id, NULL, 'absent', conf = tierW(anchor)*ageFactor)
        continue

    # (2) classify each reality unit — deductive
    for e in scoped:
        text = e.file_path + ' ' + e.context_snippet + ' ' + linkedMemoryText(e.memory_id)
        hit  = firstMatch(signals, text)            # presence of a forbidden act
        ms   = matchStrength(globHit, terms, text, hit)
        conf = min(tierW(anchor), 0.8) * ms
        if hit and conf ≥ EMIT_THRESHOLD:
            upsert drift_edges(anchor_id, e.id, 'contradicts', conf, evidence{file,snippet,hit,terms})
        elif scopeHit and not hit and conf ≥ EMIT_THRESHOLD:
            upsert drift_edges(anchor_id, e.id, 'implements', conf, evidence)   # convergence, low priority
```

`linkedMemoryText(memory_id)` pulls the implementation memory's content via `session_file_edits.memory_id`
→ `memories.id`, joinable through `memories_fts` (rowid = memories.id). Run inside the
consolidation sweep or on a manual trigger; idempotent via the `UNIQUE` constraint.

---

## 7. Verdict SQL — the Drift View

```sql
-- ① Headline: divergence (decided-but-violated). Confidence, then entrenchment, then recency.
SELECT a.kind, a.statement, a.rationale,
       e.file_path, e.context_snippet, e.occurred_at,
       d.confidence, d.evidence
FROM drift_edges d
JOIN drift_anchors a ON a.id = d.anchor_id
JOIN session_file_edits e ON e.id = d.edit_id
WHERE d.verdict='contradicts' AND d.status='open' AND a.status='active'
ORDER BY d.confidence DESC, (a.tier='human') DESC, e.occurred_at DESC
LIMIT 3;

-- ② Secondary tab: absence (decided-but-no-reality), staleness-gated.
SELECT a.kind, a.statement, a.rationale, d.confidence
FROM drift_edges d
JOIN drift_anchors a ON a.id = d.anchor_id
WHERE d.verdict='absent' AND d.status='open' AND a.status='active'
ORDER BY a.created_at ASC      -- oldest unfulfilled decision first
LIMIT 10;
```

A Drift View card = [anchor statement + WHY] / [reality `file_path:snippet` + `occurred_at`
(+ commit/line when available)] / [verdict + confidence] / dismiss → `status='dismissed'`.

---

## 8. Seeding (build order step 2; no cold authoring)

Empirical probe (2026-05-30, ~2k memories): the clean-anchor pool DB-wide is ≈ **49 candidates**,
~15–25 genuinely violatable, 20 code-linked. **Curate them down to ~20 anchors** — do not hand-author
from scratch. Start with the **17 rows that carry a `rule_or_warning` structured shape** (e.g. the WELQ
"never assert ingredient safety" rule) — these are the cleanest prohibitions.

Curation = the human attaches `affects` + `detect_terms` + `violation_signal` to each (the lexical
bridge). This bulk step drives `curateAnchorFromMemory()` from the lib via a seeding script (to be
added); doing it in a script rather than CLI args also avoids shell encoding issues for Japanese
statements. Note: `memory_edges` is effectively empty (1 row) and the reality side is abundant
(6.2k `session_file_edits`) — the scarce/dirty side is **intent**, which is exactly what curation fixes.

---

## 9. Build order & current status

1. ✅ **anchor store + write path** — `drift_anchors` + `drift_edges` (schema v8), `declareAnchor` /
   `curateAnchorFromMemory` / `listAnchors` / `retireAnchor` lib, `linksee-memory-declare` CLI.
   Migrated live (additive; 2k memories + 6.2k edits intact).
2. ⬜ **seed** — curate 49 candidates (start with 17 `rule_or_warning`) → ~20 anchors.
3. ⬜ **detector** — `drift-detection.ts` (§6). Lexical/FTS/glob, **no embeddings**.
4. ⬜ **verdict** — divergence headline + absence secondary (§7).
5. ⬜ **Drift View** — top-3 contradiction cards.

### Open question for step 1.5
The write path is a lib + CLI (respecting the deliberate 3-tool MCP surface from v0.7.0). A live
`declare_anchor` MCP tool — or a `remember({ declare_anchor: true })` mode — would let an agent declare
an anchor mid-session. Decide after dogfooding whether that live-declaration UX is worth a 4th tool.

---

## 10. Files

- `src/db/schema.sql` — v8 drift tables (search "v8: Drift observability").
- `src/lib/drift-anchors.ts` — the write path.
- `src/bin/declare-anchor.ts` — the `linksee-memory-declare` CLI.
- `src/lib/drift-detection.ts` — the detector (step 3, not yet created).

## Theory grounding
- **TMS** (Doyle 1979; de Kleer 1986) — justification graph: belief + WHY + auto-contradiction.
- **AGM belief revision** (Alchourrón-Gärdenfors-Makinson 1985) — entrenchment / revise / minimal change.
- **Software Reflexion Models** (Murphy-Notkin-Sullivan 1995) — convergence / divergence / absence.
