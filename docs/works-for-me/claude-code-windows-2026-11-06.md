# Works-for-me record: Claude Code on Windows (2026-11-06)

| Field | Value |
|---|---|
| Client | Claude Code 2.1.318 |
| OS | Windows 11 |
| linksee-memory | 0.18.1 (a local build of `main` at f7886f2, the commit tagged v0.18.1) |
| Install path | `claude mcp add` pointing at `node <checkout>/dist/mcp/server.js` |
| Memory folder | an empty temporary folder, via `LINKSEE_MEMORY_DIR` (the maintainer's real memory was not used) |

Steps, each a separate headless session (`claude -p`):

1. Session 1 (03:15:57 UTC): asked the agent to call `remember` with the content `Works-for-me check: the deploy key lives in vault path kv/rt-check-7731`. The agent replied `STORED`.
2. Session 2 (03:16:30 UTC), a new process: asked the agent to call `recall` with the query `deploy key vault path` and reply with the path it found. The agent replied `kv/rt-check-7731`.

Result: the first round trip works. After both sessions the temporary database held the stored text. The maintainer's real database had the same row count before and after, and did not contain the string.

Not covered by this record: the plugin install path (`/plugin install`), and whether the hooks fire (the headless sessions were started with only the two tools allowed).
