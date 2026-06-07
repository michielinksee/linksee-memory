# Founder Memory / Product Drift OS — Spec v2 (research-grounded)

Increment over [v1](product-drift-os-spec-v1.md). v1 = the product definition (5 types / 6 domains / Hard·Soft /
card format / memory-layer separation / evolution-vs-abandonment). **v2 grounds it in the verified
framework lineage + the engineering "drift detection" discipline the v1 draft missed.** Date: 2026-06-01.

---

## 0. The reframe that changes everything
"Drift detection" is **not a metaphor we invented — it is a mature engineering discipline**, and Product Drift OS
is that discipline **lifted from infrastructure to the whole product/business**:
- **Infrastructure-as-Code (Terraform/Pulumi):** a declared **desired-state file** is continuously/periodically
  diffed against **actual** cloud state; the **diff IS the product**. A delta counts as "drift" **only when it is
  *out-of-band*** — not produced by an applied, recorded change.
- **GitOps (ArgoCD/Flux):** git = the single declared desired state; a controller runs a **continuous
  reconciliation loop** (fetch→compare→apply→verify) pulling reality toward the declared truth.
- **MLOps (data/concept/model drift):** statistical comparison of production vs a baseline window — for the
  *fuzzy* streams where exact diff is meaningless.
- **Software Reflexion Models (Murphy-Notkin-Sullivan, FSE 1995):** declared high-level model vs actual source →
  classify every relation as **convergence / divergence / absence**. The academic formalization of intent×reality.

**→ Product Drift OS = the IaC/GitOps reconciliation pattern, applied to strategy/product/ops/growth, with the
Reflexion output vocabulary, MLOps statistics for fuzzy streams, and a human-orientation (not auto-force) posture.**

## 1. The core mechanism (borrowed, precise)
**Three-state model (Pulumi's, the cleanest):**
| IaC | Product Drift OS |
|---|---|
| **desired** state (program/`.tf`) | **Current Truth Map** (active strategy/decisions/commitments/sources-of-truth) |
| **current** state (state file/snapshot) | last-known snapshot of the project |
| **actual** state (live cloud) | live reality (code/deploy/npm/content/metrics/feedback) |

**The discriminator = the "out-of-band" test (this IS the make-or-break, now rigorously grounded):**
> A divergence is **drift** only if it is NOT accounted for by a recorded/applied decision.
- Accounted-for (a recorded **supersede** = IaC's recorded `apply`) → **healthy evolution → don't flag.**
- Out-of-band (no decision explains it) → **real drift → flag.**
The **ADR `superseded_by` link plays the role of the recorded `apply`.** (Lineage: ADR = Nygard/Fowler; the
"is reality drift or intentional" test = IaC out-of-band-change test.)

**Output vocabulary = Reflexion's (we already emit it):** every gap resolves to **convergence** (truth realized —
healthy), **divergence** (reality contradicts truth — conflict/security/rule-violation), or **absence** (truth
declared but no longer realized — decay/hollowing). Our existing verdicts `implements / contradicts / absent`
ARE convergence/divergence/absence. → Map onto the 5 drift types: convergence=Healthy Evolution; divergence=
Rule-violation/Conflict/Security; absence=Decay/Hollowing; + Unmanaged-Pivot & Opportunity sit across them.

**Remediation trichotomy = IaC's = our 3-way:** **apply** (fix reality to match truth = "直す") / **import/adopt**
(pull reality into the truth = "現実が正"=supersede) / **update state**. Our belief-revision 3-way IS this.

## 2. Framework lineage (verified) — and what each contributes
| Product Drift OS part | Framework | Contribution | Source note |
|---|---|---|---|
| Core diff mechanism | **IaC drift detection** (Terraform/Pulumi) | desired↔actual diff; 3-state; out-of-band test; apply/import/update | hashicorp / pulumi blogs |
| Continuous reconciler | **GitOps** (ArgoCD/Flux) | controller loop; git=source-of-truth; central-vs-agent choice | rafay/oneuptime |
| Output classes | **Reflexion Models** (Murphy-Notkin-Sullivan '95) | convergence/divergence/absence (= our verdicts) | cs.ubc.ca |
| Fuzzy streams | **ML drift** (data/concept/model; Evidently) | statistical baseline-vs-production for metrics/feedback | evidentlyai |
| Decay/security class | **Config drift** | "systems diverge from baseline; lose visibility" | puppet/ibm |
| Decision memory | **ADR** (Nygard/Fowler) | context/decision/consequences/**status/superseded_by** | fowler |
| Hypotheses change | **Lean Startup** | Build-Measure-Learn; pivot; innovation accounting | leanstartup |
| Explore vs commit | **March 1991** exploration/exploitation | experiment (揺れてよい) vs commitment (止まったら decay) | March, Org Sci |
| Healthy evolution | **Dynamic Capabilities** — sense/seize/transform | reconfigure to match change | ⚠️ sense/seize/transform = **Teece 2007**, not the 1997 paper |
| Macro decay name | **Strategic Drift** (Johnson&Scholes; Sammut-Bonnici) | gradual unacknowledged deterioration | um.edu.mt |
| Center metric | **North Star** (Ellis/Amplitude) | single value-metric to diff against | a16z/amplitude |
| Metric reality | **a16z 16 metrics** / **PG Default-Alive** | CAC/LTV/MRR/burn; "reach profit before $0?" | a16z / paulgraham |
| PMF stream | **Superhuman PMF** (Vohra) / Ellis 40% test | continuous PMF measurement | firstround |
| Multi-perspective | **Balanced Scorecard** (Kaplan-Norton) | financial/customer/process/learning | balancedscorecard.org |
| Situational map | **Wardley** / **OODA** (Boyd) | evolution axis; Observe-Orient-Decide-Act | wikipedia |
| Persona/posture | **Cynefin** (Snowden) + **Westrum/DORA** | sense-maker (complex domain); inquiry-not-blame | wikipedia / dora.dev |
| Prioritization | **Theory of Constraints** (Goldratt) | surface the binding-constraint drift first, not all equally | tocinstitute |
| Truth = customer job | **JTBD** (Ulwick/Christensen) | define truth by the job-to-be-done | strategyn |
| Decision↔outcome | **Decision Intelligence** (Pratt/Kozyrkov) | link a decision to the outcome it predicted | lorienpratt |
| Buyer stance | **Founder Mode** (PG 2024) | founder/COO's direct ground-truth instrument | paulgraham |

**Market pain (the quantified problem — strong for VC):** the **strategy-execution gap** — firms deliver only
~63% of promised strategy value; ~67% of strategies fail on execution (PMI / Marakon-EIU / HBR). Product Drift OS
is the instrument that closes it for fast-moving AI-era teams.

## 3. Current Truth Map (the center — the "desired-state file")
Not the full past log — **what is true & active NOW**: A North Star · B Active Strategy · C Active Business Model ·
D Active Product Architecture · E Active GTM/Growth · F Engineering Source-of-Truth · G Operational Commitments
(cadence/owner/stale-threshold/last-confirmed) · H Experiments (hypothesis/metric/review-date) · I Paused/Deprecated
(reason/revival-condition/cleanup) · J Key Metrics/Health. Every node carries a **status**
(active/experiment/paused/superseded/deprecated/retired/unknown) + ADR fields (context/why/consequences/
superseded_by) — else past decisions become zombies.

## 4. The 8-layer whole map (her v2, kept)
1 North Star/Value Thesis · 2 Decision & Memory Layer (ADR-extended) · 3 **Current Truth Map** · 4 Reality
Monitoring · 5 Interpretation Engine (7 classes: Healthy-Evolution / Operational-Decay / Source-of-Truth-Conflict /
Strategic-Hollowing / Unmanaged-Pivot / Opportunity / Security) · 6 Card & Governance · 7 **Memory Revision Flow**
(confirm/pause/deprecate/supersede/→experiment/→commitment/update-source-of-truth — the differentiator) ·
8 Investor/Board View.

## 5. Card contract (Reflexion + ADR + the 照合 discipline)
Every card: **Active Intent (cited) · Reality (cited) · Classification (convergence-evolution / divergence-conflict /
absence-decay / opportunity / security) · Evidence (URL/file/date/metric) · Risk · Recommended Action
(fix/pause/deprecate/update-memory/create-task/confirm-source-of-truth)**. Soft (LLM-judge) cards REQUIRE both-side
evidence — "証拠なしのAI判断はただの小姑."

## 6. Architecture choices (inherited from the analogs)
- **Cadence:** continuous auto-reconcile (GitOps) vs on-demand "show me the plan" (Terraform). → Given the
  COO/CMO sense-maker persona (Cynefin complex / Westrum inquiry), **surface the plan for human orientation (OODA),
  do NOT silently force reality back.** = our 3-way (present → human decides → map self-updates).
- **Topology:** central truth-server (ArgoCD) vs per-project autonomous agent (Flux) — a real product choice
  (Linksee local-first → per-project agent, optional sync).
- **Anti-self-drift:** Product Drift OS itself needs a North Star or it drifts — ミイラ取りがミイラ.

## 7. What we've ALREADY built (the baby version) + roadmap
**Built = a working T1/divergence reconciler:** drift_anchors (clean desired-state, declare-don't-mine) ×
session_file_edits/current-files (actual) → contradicts/absent (divergence/absence) → 3-way (apply/import/update) →
`/drift`. The skeleton-v1 doc = the first Current Truth Map instance. v2 file-scan = the reconciliation diff.
**Roadmap (her Phase order, confirmed):** P1 **Current Truth Map v1** (manual, correct map first) → P2 **Hard
heartbeat** (npm/Vercel/GitHub-Actions/article-cadence staleness — IaC/SRE-style, mechanical, fast value) → P3
**Soft judge** (LLM, intent=Current Truth Map, reality=LP/DB/metrics, evidence-required) → P4 **Memory Revision
Flow** (the differentiator) → P5 **Autonomous COO/Board dashboard**.

## 8. Final definition
> Product Drift OS is a **governance + memory system** for fast-moving (AI-era) product teams. It does **not** force a
> product back to its original plan. It maintains a **Current Truth Map** of active strategy, experiments, operational
> commitments, and sources-of-truth, and continuously **reconciles** it against reality (code, deploys, packages,
> content, metrics, feedback, business ops). Its core job is to **distinguish intentional evolution (an accounted-for,
> superseded change) from unmanaged decay / conflict / hollowing / missed opportunity (out-of-band drift)** — then
> help the team update memory, commitments, and execution. It is the IaC/GitOps reconciliation discipline lifted from
> infrastructure to the whole business, with a human-orientation posture.
