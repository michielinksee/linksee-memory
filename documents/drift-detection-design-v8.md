# Linksee v1 — Drift Observability (Design Memo v8)

**Increment over [v7](drift-detection-design-v7.md) (v7 = on-load live cadence; v1–v7 = the shipped
①-pipeline). Does not replace any.** This memo is NOT a build record — it captures **Michie's strategic
reframe (2026-06-01)** that changes *what ① means*, *defines ②*, and *locks the ①→② order + coupling*.
It is the conceptual bridge from the working ① pipeline to the larger product.

Date: 2026-06-01.

---

## A. Real-case snapshot — the 10 anchors ARE her real decisions, all currently honored

`declare list` confirms the 10 active anchors are genuine, code-linked, cross-project decisions curated
from real memories (`source=curate`, real `source_memory_id`) — not synthetic test data:

| # | kind | her decision (abridged) | project |
|---|---|---|---|
| 1 | decision | linksee-memory MCP public tools = 3 (remember/recall/read_smart); don't add a 4th | linksee-memory |
| 2 | constraint | don't rebuild the 6-layer schema; additive JSON fields only, no destructive migration | linksee-memory |
| 3 | constraint | session-extractor stores 5W1H+3-axis structured, never raw chat | linksee-memory |
| 4 | prohibition | dashboard UI is not per-render codegen (propose→lock→tweak; "いつもの場所") | linksee-dashboard |
| 5 | prohibition | no crawl / robots-ignore / VPN-scrape of Cosmetic-Info.jp | ReviewLens |
| 6 | prohibition | no token/crypto/NFT/P2E rewards in ScaNavi (絶対NG) | ScaNavi |
| 7 | constraint | new cosmetic ingredient → must run check_new_ingredient() INCI/alias dedup | ReviewLens |
| 8 | decision | SakeNavi brand links via explicit 【推薦銘柄】 LLM output, not text-scan | ScaNavi |
| 9 | constraint | KanseiLink reliability = live-only headline; don't blend seed estimates | KanseiLink |
| 10 | decision | Expo mobile app stays on SDK 54 (55 breaks Expo Go) | mobile |

**Result: 0 drift — her real code currently honors all 10.** That is a real, meaningful clean signal,
not an empty demo. **Honest caveat:** anchor #7 has an empty `violation_signal[]`, so it can *never*
produce a `contradicts` edge — the detector can't lexically catch "you FAILED to call X" (an
absence-of-action), only "you DID a forbidden thing." 'Always-DO' constraints are a known detector gap
(candidates for the `absent`/convergence work in deferred (d)).

---

## B. The reframe — 「最初の設計＝正義ではない」: a drift is a QUESTION, not a verdict

Michie's first refinement, and it is load-bearing. ① is **fact-based** (citation-backed 照合), BUT a
`contradicts` edge must NOT moralize. As work progresses and reality becomes clearer, code may *look*
drifted from the original design while actually heading somewhere **more grounded**. So:

> A `contradicts` edge means: *"What you declared and what you did diverged — which is true now?"*
> NOT *"you violated your rule."*

The original design is not automatically right. The product's job is to **surface the divergence
neutrally and let the human adjudicate** — never to scold.

---

## C. Resolution = belief revision (AGM — already in our theory grounding)

This reframe maps exactly onto **AGM belief revision** (Alchourrón-Gärdenfors-Makinson 1985), which is
*already* one of the three cited foundations (entrenchment = which belief wins; revise/contract; minimal
change = don't delete history). So the resolution of a drift is a 3-way belief-revision choice, not a
binary dismiss:

1. **Reality is wrong → fix the code.** The anchor wins; the edge resolves when reality re-aligns.
2. **The anchor is stale → reality won.** Your understanding got more grounded. **Supersede** the anchor
   (new version, old one marked superseded) — *don't hard-delete* (AGM minimal change; preserves the WHY
   chain). This is "I drifted, and the drift was right."
3. **Noise → dismiss.** (today's only action)

The current dismiss loop is binary (`open → dismissed`). The 3-way is **additive**: the schema already
has `drift_edges.status ∈ {open, ack, dismissed, resolved}` and anchor retire/supersede + `mem_state
'superseded'`. No destructive change.

---

## D. ② defined — the drift-neighborhood memory-Map (not generic serendipity)

Michie's second refinement sharpens ② from "Obsidian-type spark" to something specific and coupled to ①:

> ② = when ① detects a drift, **visualize the conceptual connections *around* that drift** — what KIND
> of drift it is, and what direction/pattern is emerging *beyond* it. A second-brain memory-Map that
> makes the drift *interpretable*.

It answers the §B question ("which is true now?") by showing the mental neighborhood: *was an image you
never consciously designed quietly welling up, and did you drift toward it without noticing?* ② is the
**interpretive layer on top of ①'s detection**, not a free-floating serendipity engine.

---

## E. ①→② coupling + locked order

The two are not just sequential — **② is fed by ①.** Every "reality won" resolution (§C path 2) is a
recorded supersede-chain: documented evidence of an unconscious direction-shift
(「知らぬ間にわいてきたイメージ」). ② **maps those chains** into an emergent-direction picture. Therefore:

- **① must be strong first** (the core/核) and must start *accumulating belief-revision data* — that
  data is ②'s raw material.
- **Order locked: ①→②.** Build ② only once ① embodies neutrality (§B/§C) and has produced real
  resolution history to map.

---

## F. Next steps (proposed; no build without Michie's green light per the "confirm-first" caveat)

1. **① "突き進む":** add the **3-way belief-revision resolution** (fix-reality / supersede-anchor /
   dismiss) so ① stops being a scold and starts generating ②'s raw material. Open semantic choices for
   Michie: does "reality won" *supersede* (new anchor version, history kept) vs. *edit-in-place* vs.
   *retire*? (Recommend supersede — AGM minimal change.)
2. **Real-case widening (optional):** the 10 are a strong real set; add more genuine constraints from the
   ~15–25 candidate pool if richer coverage is wanted. Keeps declare-don't-mine.
3. **② is design-only for now** — defined here, built after ①.

Status: still 100% additive / reversible; the engine remains untouched.
