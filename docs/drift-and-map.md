# Drift detection and the product map

Moved out of the README on 2026-11-04 so its first screen fits on one screen. Back to the [README](../README.md).

## 🎬 See it in action

**Drift, caught.** Decisions don't survive session boundaries — but their consequences do. Ask any session:

```
You:    What's drifting right now?
Agent:  [calls drift_status]

        28 anchors: ⚪ 1 held · 🔵 27 aligned

        Needs attention:
        ⚪ HELD — "Focus on 4 areas: Recipe layer, agent-native API,
           Japanese market, Agent Insights"
           ↻ Reopens 2026-07-04

        Everything else is aligned — no unaccounted divergence.
```

**The memory underneath.** Drift detection only works because the *why* survives the session boundary:

**Without linksee-memory** — Monday morning, new Claude session:

```
You:    We deployed last week but it crashed. How did we fix it?
Claude: I don't have access to previous sessions. Can you describe
        what happened and walk me through the problem?

[30 minutes of log-spelunking and re-explanation]
```

**With linksee-memory** — Same question, different outcome:

```
You:    We deployed last week but it crashed. How did we fix it?
Claude: Let me check my caveats...

        🧠 [caveat] NextAuth sessions invalidate when JWT_SECRET
           rotates — redeploy all affected projects in parallel.
           (from session 2026-04-13, importance: 0.9)

        Is this the deploy you're asking about? We hit it when
        we rotated secrets mid-flow.

You:    Yes, exactly. Let's not repeat that.
```

That single `caveat` memory is what separates "flat fact storage" from "the agent actually remembers the WHY". linksee-memory stores it across **six explicit layers** so retrieval stays explainable.

---

## 🔍 Drift Detection — "Intent Datadog"

Most teams make decisions, then forget them. The agent from last week decided "we'll use FTS5 instead of vector search" — but this week a new session installs `pgvector` without knowing why that was rejected. **That's drift.** Not a bug. Not malice. Just forgotten context.

Memory tools remember what you did. Nothing notices when you drift from what you decided — that's the layer Linksee Memory adds. Think **"Datadog for product decisions"**: unaccounted divergences surface as drift, intentional evolution (recorded as supersede/fix) stays quiet.

### How it works

1. **Declare** decisions as anchors: `declare_anchor({ kind: "decision", statement: "We use FTS5, not vector search", violation_signal: ["pgvector", "embedding"] })`
2. **The engine detects** when committed code reality diverges from these anchors
3. **State derivation** classifies each anchor:
   - 🔴 **Drift** — reality diverges with no recorded resolution
   - 🟡 **Review** — a soft signal awaits your decision
   - ⚪ **Held** — you acknowledged the gap, parked it with a review date
   - 🔵 **Aligned** — reality matches intent, or a recorded resolution explains the change
4. **Resolve** with `fix`, `supersede`, `acknowledge`, or `dismiss` — plus two gates: `harden` (PreToolUse will block) and `soften` (back to a warning)

The **make-or-break rule**: a divergence accounted for by a recorded resolution (supersede/fix/acknowledge) is NOT drift. Only unaccounted gaps are flagged. This means intentional evolution stays quiet while silent abandonment gets caught.

### 4-species taxonomy

Anchors are classified into four species with different display formats:

| Species | Icon | Display Format | Example |
|---|---|---|---|
| Hypothesis | 🧪 | Decision Card (journal format) | "We'll launch English-first on HN" |
| Constraint | 🔒 | Rule (pass/fail checklist) | "All writes go through remember()" |
| Commitment | 🔁 | Heartbeat (alive/dead) | "Ship a new version every week" |
| Source of Truth | 📍 | Reference (stable anchor) | "MCP server runs on stdio, single SQLite" |

---

<a id="the-map"></a>

## 🗺️ The Map — `linksee-memory map`

Drift detection (above) checks individual anchors. The **Map** lifts it to the whole product: a `map.yaml` describing how value reaches your user (`discover → understand → try → adopt → retain → monetize → expand`), with typed dependencies between the pieces — README, npm listing, onboarding, the engine that powers them. The reconciler checks that map against your real code, and the CLI answers the question an engineer actually has:

> *I'm touching this file — where is it on the map, and what else must move?*

**1. Where am I?** — locate a file (or, with no argument, infer from your recent edits):

```
$ npx -y linksee-memory map where README.md
"README.md" belongs to this Map node:

  readme  [understand]  convergence
    changes ripple to:
      must fix together (hard):  lp, docs-site
      should align (soft):       onboarding, client-configs
      fyi (may ripple):          telemetry-contract
```

The blast radius is **graded** — `must fix together` vs `should align` vs `fyi` — so a wide ripple isn't flat noise.

**2. Why is it in this state?** — the diagnosis, with file:line evidence:

```
$ npx -y linksee-memory map explain readme

STATUS
  declared: healthy (active)
  reality:  implemented / matches
  verdict:  declared and reality agree (verified)

EVIDENCE
  ✓ README's Tools section lists where_am_i
      README.md:424 — found "where_am_i" in section "Tools"
```

Declared state and the reality verdict are shown **separately** — a hand-declared `suspect` the scanner refutes reads as *"declared suspect, refuted by reality (→ convergence)"*, not a confusing mix.

**3. Whole-project triage:** `npx -y linksee-memory map status` — a health %, what is *fixable now in code* vs *external checks*, and any deferral with no expiry (so "accounted-for" can't quietly become a drift graveyard).

**How it works**
- **`map.yaml`** (repo root) is the desired-state source of truth: a journey spine × surface/implementation layers × typed edges (`must-stay-consistent-with` / `should-align-with` / `realizes`).
- **`reconcile`** checks each node's declared `reality` against the code (`signal` / `regex` / `section_contains` / file checks) and overlays a verdict — reality overrides what you hand-declared, with evidence.
- `where_am_i` is also an **MCP tool**, so a coding agent can re-anchor itself mid-task.

Commands: `where` · `affects` · `explain` · `status` · `next` · `reconcile` · `inspect --json` · `blueprint`. Add `--lang ja` for Japanese labels.

---

<a id="reinjection-guard"></a>

