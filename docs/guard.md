# Re-injection guard

Moved out of the README on 2026-11-04 so its first screen fits on one screen. Back to the [README](../README.md).

## 🛡 Re-injection Guard — enforce decisions *before* the action

Drift detection (above) is **post-hoc** — it tells you reality diverged *after* the change lands. The re-injection guard is the **pre-action** half: it re-surfaces the decision you locked **before** the agent runs the tool that would break it.

It exists for one specific, infuriating failure mode ([anthropics/claude-code#15443](https://github.com/anthropics/claude-code/issues/15443)): *"Claude read the rule, understood it, and still used `cp`."* Having the rule in context isn't enough — so the guard runs **outside the agent's volition**, as a Claude Code hook:

| Hook event | Fires on | What it does |
|---|---|---|
| **`PreToolUse`** | `Edit` / `Write` / `Bash` | Checks the pending action against your accepted anchors. A `gate_mode:'hard'` contradiction is **denied**; a softer match re-injects the decision as a reminder; no match → nothing happens. |
| **`SessionStart`** | `startup` / `resume` / `compact` | Replays your locked decisions + open forks into the fresh session — killing the "groundhog day" amnesia where a new agent repeats last week's call. |

It is **fail-open by construction**: any parse / DB / logic error surfaces nothing and lets the action through. The *only* thing that ever blocks is an explicit `hard` contradiction on a decision **you** declared.

### Enable it

`npx -y linksee-memory setup` wires this into `~/.claude/settings.json` (Step 4), so it is on in **every** repo — the same scope your memory already lives at. One SQLite file holds the anchors for all your projects; enforcing them per-repo meant declaring a decision once and having it enforced nowhere.

- `--project-guard` — this repo only, the old behaviour
- `--no-guard` — skip it

Anchors with `affects` globs fire only on matching paths; an unscoped anchor fires on its own `detect_terms` / `violation_signal`. Nothing is ever **blocked** unless you explicitly hardened it (`resolve_drift(action:'harden')`) — everything else re-injects the decision as context.

To wire it by hand instead, drop this block into `.claude/settings.json` (project root, or `~/.claude/settings.json` for every repo). The `npx -y` form below needs no install, but costs several seconds per call (7.4–8.6 s measured on Windows, close to the 8 s `PreToolUse` timeout — a timed-out guard simply does not fire). `setup` writes a direct `node` call instead; you can do the same with `"<path to node>" "<package>/dist/bin/guard-hook.js"` (paths quoted; Claude Code runs hooks through cmd.exe on Windows and sh elsewhere, and a path containing `$`, a backtick, `%` or `"` cannot be quoted safely — setup keeps the npx form for those):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|compact",
        "hooks": [
          { "type": "command", "command": "npx -y linksee-memory guard", "timeout": 15 }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Write|Bash",
        "hooks": [
          { "type": "command", "command": "npx -y linksee-memory guard", "timeout": 8 }
        ]
      }
    ]
  }
}
```

Where it applies is the settings file it lives in: `~/.claude/settings.json` (what `setup` writes) covers every repo; a project's `.claude/settings.json` (`setup --project-guard`) covers that repo only. Declare what it should watch with `declare_anchor(...)`; set `card_policy.gate_mode:'hard'` on an anchor to make a contradiction **block** instead of just warn (the soft default only re-injects). Anchors that are stale (`at_risk`), superseded, or card-disabled never gate.

> Developing linksee-memory itself? The repo dogfoods the guard via a (gitignored) `.claude/settings.json` that points at the local build (`node ${CLAUDE_PROJECT_DIR}/dist/bin/guard-hook.js`) so it runs against your uncommitted changes. End-user projects should use the published `npx -y linksee-memory guard` form above.

---

