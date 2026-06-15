# `where`-first demo — notekeeper

A tiny throwaway project that shows `linksee-memory-map` in ~30 seconds. The README
documents a `--export` flag that the code never implemented — and the Map catches it.

> Building this demo caught **two real multi-project bugs** in the tool itself
> (`map_nodes`/`map_edges` were globally keyed, so two projects couldn't both have a
> `readme` node). Fixed. The tool's whole job is finding that kind of drift — it found
> its own.

## Run it

```bash
cd demo
linksee-memory-map where README.md   # where am I, and what does this file touch?
linksee-memory-map explain readme    # why this state? — reality says DRIFT, with evidence
linksee-memory-map status            # whole-project triage
```

## The 30-second story

**1. Where am I?** — locate the file + its graded blast radius:

```
$ linksee-memory-map where README.md
"README.md" belongs to this Map node:

  readme  [understand]  divergence
    changes ripple to:
      must fix together (hard):  cli-engine, docs-site
      should align (soft):       npm, onboarding
```

**2. Why is it drifting?** — declared vs reality, with file:line evidence:

```
$ linksee-memory-map explain readme

STATUS
  declared: healthy (active)
  reality:  drifted
  verdict:  declared vs reality disagree (drift)

WHY
  The README documents an --export flag, but src/cli.js does not implement it.

EVIDENCE
  ✓ README documents the --export flag      demo/README.md:11 — found "--export"
  ✗ src/cli.js implements --export          src — "--export" not found

FIX
  1. implement --export in src/cli.js
  2. or drop the --export claim from the README
```

**3. Triage:** `status` → `Health: 80%`, one node `Actionable now`. Fix the drift (implement
`--export` or drop the claim) and `reconcile` turns it green.

## Record it

- **GIF (best for Show HN / README):** install [vhs](https://github.com/charmbracelet/vhs),
  then `cd demo && vhs where-demo.tape` → `where-demo.gif`.
- **asciinema:** `asciinema rec where-demo.cast`, run the three commands, `Ctrl-D`, then
  `asciinema upload where-demo.cast`.
- Add `--lang ja` to any command for Japanese labels.
