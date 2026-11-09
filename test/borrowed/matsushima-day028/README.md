# Borrowed benchmark: matsushima_a "Day 028" (24 questions)

## Source and permission

- Article: matsushima_a, "Day 028" — https://zenn.dev/matsushima_a/articles/day-028-naive-rag-vs-mutating-memory
- Data and code: https://github.com/Matsushima-A-830/ai-100days/tree/2a325e42bf91/experiments/day-028
  (`datasets.py`, `memory_methods.py`, `run_experiment.py`, `results.md`)
- Permission: on 2026-11-06 the author agreed, in a Zenn comment, that Linksee may borrow these as
  test cases provided the article is cited as the source.
- The repository has **no licence**, so nothing from it is copied here. `run.mjs` downloads the
  three files it needs from the pinned commit `2a325e42bf918b1d70ac54f815941c89a1eac6fa` into a
  temp folder at run time, refuses to continue if any sha256 differs from the value pinned in
  `run.mjs`, and deletes the folder afterwards.

## Run (opt-in, not in CI)

```
pnpm run build
pnpm run bench:day028
```

Needs network access and Python 3 (`python` on Windows, `python3` elsewhere; override with
`PYTHON=`). Not listed in `test/suite.json`: it fetches external files. Every Linksee server it
starts gets `LINKSEE_MEMORY_DIR`, `HOME` and `USERPROFILE` pointed at a fresh temp folder, so
`~/.linksee-memory` and `~/.claude` are never read or written. Output: `results.md` here.

## What the original measures

Three made-up conversations (Aki, Ben, Chi; 20–25 turns) in which four facts change over time:
home city, job, pet, favourite food. 24 questions: 12 `current` (the latest value) and 12
`historical` (a value that was later replaced). The author's point is "same extraction, only the
storage differs":

- `MutatingSummaryMemory` — regex extraction, a new value overwrites the old one.
- `AppendOnlyMemory` — the same extraction, every value kept; `historical` returns all values
  except the latest.
- Scoring (`run_experiment.py`, `fuzzy_match`): case-insensitive substring either way
  (`gold in answer or answer in gold`); for a list, any element matching counts.

Author's results: Mutating current 66.67% / historical 16.67%; AppendOnly current 66.67% /
historical 100%. The current-question misses in both are extraction misses (e.g. Ben's
"data engineering" turn is not caught by the regex; pet lists are formatted
"two cats, Mochi, Tofu" against gold "two cats, Mochi and Tofu").

## How it is mapped onto Linksee (decided before the first run)

1. **Extraction is the author's, not the gold facts.** `bridge.py` imports the downloaded
   `memory_methods.py` and calls `process_conversation_facts()`, the function both of the
   author's structured memories are built from. The stream of (turn, category, value) it
   produces is what Linksee stores. The `facts` answer key in `datasets.py` is used only as
   `gold` for scoring. So Linksee inherits the author's extraction misses — on purpose: only the
   storage differs, as in the original.
2. **One fresh Linksee DB per conversation** (the original builds one memory object per
   conversation). The server is the real `dist/mcp/server.js`, spawned as a child process and
   driven over stdio JSON-RPC, like the other server tests in `test/`.
3. **Each extracted fact is one memory**: `remember({ content: "<Person>'s <category> (turn N): <value>",
   entity_name: <Person>, entity_kind: "person", layer: "context" })`.
4. **When a category already has a memory, two ways of storing the new value:**
   - **(a) supersedes** — `remember({ ...same, supersedes: <old id> })`: a new memory, the old one
     marked superseded. This is how Linksee is meant to be used.
   - **(b) overwrite** — `remember({ memory_id: <old id>, content })`: the explicit update path,
     which replaces the content in place. Expected to behave like `MutatingSummaryMemory` and lose
     every historical value; reported as it comes out.
5. **Answering, with no LLM:**
   - `current`: `recall({ query: <the original question text> })` (default: superseded hidden).
     The answer is the highest-ranked returned memory whose content parses (the regex in
     `run.mjs`, the exact shape written in step 3) to the asked person and category. Knowing the
     category matches the original, whose `answer()` is handed the category.
   - `historical`: `recall({ query: <question>, include_superseded: true })`. The answer is the
     list of values, for that person and category, that come back carrying `superseded_by` —
     Linksee's own marker for "replaced", the analogue of the original "all values except the
     latest".
   - `mark_accessed: false` on every recall, so asking does not change later ranking.
6. **Scoring is the author's `fuzzy_match`**, called unchanged through `bridge.py`.

Any later change to this mapping is to be written here with the reason and the numbers before
and after; see the change log below.

## Change log

- **2026-11-09, run 1 → run 2: read-back bug in the harness fixed (the mapping is unchanged).**
  `remember()` in create mode stores plain text as structured JSON
  (`{altitude, type, state, what}`) and `recall` returns that object, so the regex in step 5
  never saw the text and every created memory read as "no answer". An update via `memory_id`
  keeps plain text, which is why (b) was hit only partly. Fix: read the text from `what` when
  `content` is an object. Run 1 (bug): (a) current 0/12, historical 0/12; (b) current 7/12,
  historical 0/12. Run 2 (fixed): (a) 8/12, 12/12; (b) 8/12, 0/12. Store, query and answer
  selection were not touched.
- 2026-11-09: a rank column added to the per-question table (display only).

## Results (Linksee 0.19.0, 2026-11-09) — full table in `results.md`

| | current (12) | historical (12) |
|---|---|---|
| original MutatingSummaryMemory (author's code, re-run here) | 8 (66.67%) | 2 (16.67%) |
| original AppendOnlyMemory (author's code, re-run here) | 8 (66.67%) | 12 (100%) |
| **Linksee (a) supersedes** | **8 (66.67%)** | **12 (100%)** |
| Linksee (b) overwrite via `memory_id` | 8 (66.67%) | 0 (0%) |

Re-running the author's code reproduces the published numbers exactly.

Why each miss happened:

- **Extraction (all 4 current misses, in both (a) and (b), identical to the original's 4):**
  - Q6 / Q22 pets: the author's `format_pet_value` writes "two cats, Mochi, Tofu"; gold is
    "two cats, Mochi and Tofu" — neither is a substring of the other.
  - Q12 Ben's job: the regex does not catch "now I'm doing data engineering instead of backend";
    the last extracted value is "backend engineer".
  - Q20 Chi's job: extracted "pediatrics specialist", gold "pediatric nurse".
  Linksee returned the latest stored value for every one of them; the stored value was wrong.
- **Linksee's spec, (b) historical 0/12:** an update via `memory_id` replaces the content in
  place and keeps no previous version, so nothing carries `superseded_by` and
  `include_superseded` has nothing to add. This is the overwrite behaviour the original
  attributes to mutating memory. (b) scores below the original Mutating (0 vs 2) because the
  original's two hits (Ben's job, Q13/Q14) come from answering every historical question with
  the current value "backend engineer", which is a substring of both golds; our historical
  answer is only what Linksee marks as replaced, which in (b) is nothing.
- **Search ranking: no miss.** For every question the memory about the asked category came
  back (the store holds 4–5 live memories per conversation). It was not always first: in (a)
  it was rank 1 for 6 of the 12 current questions and rank 2–4 for the rest. The question text
  goes to FTS as an OR of its words, and "Aki's" matches every memory, so relevance is nearly
  flat. A reader that took only the top hit would score 6/12 on current in (a), not 8/12. The
  mapping picks the first hit with the asked category (as the original is handed the category),
  so this does not change the score above, but it is the weak spot this benchmark shows.

Side observation: create mode stores plain text as structured JSON while an update via
`memory_id` stores the new text as plain text, so the same kind of fact comes back in two shapes
depending on how it was last written.
