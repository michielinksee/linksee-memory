# T3 Judge Contract v1 (2026-06-05) — productizing the direction-drift judge

Goal: replace "Claude-in-the-conversation hardcodes the verdict" with a **structured, repeatable judge**
(a Claude API call / subagent) that takes (declared direction + assembled evidence) and returns a validated
verdict. The judge is SEMANTIC (intent-vs-reality meaning) — that's why it's an LLM, unlike T2 (mechanical).

## Stage map (build each, validate, then next)
1. **Contract** (this doc) — the judge's input/output schema + decision rules.
2. **Evidence assembly** (`scripts/t3-judge-evidence.mjs`, deterministic) — packs the context per direction.
3. **Judge** (subagent / structured output) — run on ONE direction, compare to ground-truth, then expand.
4. **Gate** — confidence threshold + two-sided-citation + adversarial verify (don't trust a single judgment).
5. **Wire** — replace t3-pilot hardcoded verdicts with the judge output (AlertPolicy + make-or-break still apply).

## INPUT (assembled deterministically — the judge never queries the DB itself)
```json
{
  "direction":   { "aid": "A4", "statement": "...", "confidence": 0.9, "lifecycle": "active|superseded|at_risk|resolved" },
  "related_nodes": [ { "id": 13, "statement": "...", "decision_mode": "constraint", "lifecycle": "active" } ],
  "recent_reality": [ { "source_type": "git_commit", "summary": "docs: VitePress ...", "occurred_at": "2026-05-29" } ],
  "recorded_resolution": { "action": "supersede|fix|acknowledge_validate", "ref": "...", "at": 0 },  // or null
  "prior_verdict":  { "verdict": "divergent", "status": "accepted" }  // or null
}
```

## OUTPUT (forced structured — the judge MUST return exactly this; validated at the tool layer)
```json
{
  "verdict":          "convergent | divergent | absent | at_risk",
  "confidence":       0.0,            // 0-1, the judge's own certainty
  "accounted":        true,           // make-or-break: is any divergence explained by recorded_resolution?
  "accounted_by":     "supersede A20 2026-06-04",  // ref to the recorded decision, or ""
  "intent_citation":  "the direction's claim, quoted",
  "reality_citation": "the confirming/contradicting reality, quoted",
  "rationale":        "<= 2 sentences, cites BOTH sides",
  "surface_card":     false           // true ONLY if unaccounted drift worth the founder's attention
}
```

## DECISION RULES (baked into the judge prompt — the product's discipline)
- **convergent** = current reality/nodes agree with the direction. **divergent** = reality contradicts it.
  **absent** = the direction has no manifestation in nodes or reality. **at_risk** = declared-core but unproven/stalled.
- **make-or-break is decisive**: a divergence/absence is drift ONLY if `recorded_resolution` does NOT account for it.
  If a supersede/fix/acknowledge already explains the shift → `accounted=true`, `surface_card=false` (evolution, not drift).
- **Two-sided or silent**: never `surface_card=true` without BOTH a non-empty `intent_citation` AND `reality_citation`.
- **Precision > volume**: when uncertain, default to `convergent` / `surface_card=false`. A missed card is cheaper than a noisy one. 週に本物1個＞毎日ノイズ20個.
- **Confidence honesty**: report true uncertainty. The gate (Stage 4) drops `confidence < min_confidence_for_soft_card` (AlertPolicy).
- The judge does NOT decide final card volume — that's AlertPolicy (cap/week). The judge decides per-direction truth.

## VALIDATION (Stage 3 — how we trust it)
- Run the judge on the current directions. Expected, given recorded resolutions in the evidence:
  A4 (superseded), A5 (acknowledged), A21 (fixed) → `accounted=true, surface_card=false`; A1/A3/A9/A10 → `convergent`.
  → **the judge should surface ZERO new cards** (matches the current resolved state). If it spuriously flags an
  accounted/convergent direction → judge bug (not respecting evidence). 
- Negative control: inject one fresh UNACCOUNTED divergence → the judge MUST flag it (`surface_card=true`). 
- Productization target: this subagent contract = a Claude API call in the shipped product (same schema, prompt-cached).

Related: [[project_linksee_drift.md]], [[drift-os-dashboard-ui-v1.md]], [[session_drift_os_20260604.md]]
