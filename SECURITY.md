# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

- Email: **security@synapsearrows.com**
- Or use GitHub's [private vulnerability reporting](https://github.com/michielinksee/linksee-memory/security/advisories/new)

We aim to acknowledge within 72 hours and to ship a fix or mitigation before any public disclosure.

## Local-first guarantee

linksee-memory runs entirely on your machine. Your memory is one SQLite file in your home directory (`~/.linksee-memory/memory.db`). **By default there are zero network calls** — no cloud account, no sync, no telemetry. (`setup` asks once whether to enable anonymous telemetry; it stays off unless you say yes.)

The only code that can ever make a network request is the **opt-in telemetry** module (`src/lib/telemetry.ts`), and only when you've enabled it — by setting `LINKSEE_TELEMETRY=basic` or by agreeing to the one-time prompt during `setup`.

## Telemetry (opt-in, off by default)

When — and only when — you've enabled telemetry (`LINKSEE_TELEMETRY=basic`, or agreeing to the one-time `setup` prompt):

- After each session, one POST is sent to `https://linksee-site.vercel.app/api/telemetry/linksee` (endpoint operated by the linksee project).
- The payload contains **only**: an anonymous local UUID, the linksee version, per-session counts (turns, file-op counts, errors), a file-**extension** distribution (e.g. `40% .ts` — never paths or names), and the **names** of MCP servers in your config (names only — never commands, args, or paths).
- It **never** sends: conversation content, user messages, file content, file paths, entity names, project names, or any memory-layer text.
- Your choice is recorded at `~/.linksee-memory/telemetry-consent` (delete it to be asked again). The anonymous id lives at `~/.linksee-memory/telemetry-id`; delete the file to reset, or set `LINKSEE_TELEMETRY=off` to stop.
- The full payload schema is the `TelemetryPayload` type in `src/lib/telemetry.ts` — read it to verify exactly what would leave your machine.

## Hooks

The optional re-injection guard (`SessionStart` / `PreToolUse`) and the capture hook (`Stop`) read structured JSON from stdin and are **fail-open**: any parse/DB/logic error produces no output and never blocks your tool call. They make no network calls.

## Secrets

linksee-memory has no secrets of its own (no API keys, no auth). It reads only `LINKSEE_*` configuration environment variables.
