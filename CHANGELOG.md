# Changelog

## Unreleased

- **`recall` understands Japanese sentences.** A question such as 「山田のエディタは何？」 has no spaces, so up to 0.19.1 it was one query word and matched only memories containing that exact string. A query word that contains Han / Hiragana / Katakana is now cut into pieces with no dictionary (no new dependency): at punctuation (、。？！「」・ …) and at script boundaries (kanji | hiragana | katakana | letters and digits — `v0.19.1` stays one piece). Only function words are dropped — one list in the code (particles, auxiliaries, question endings, question words: の / は / ですか / 何 …); every other Hiragana run of 2+ characters stays a piece (みずほの口座 → みずほ + 口座, ひとり旅 → ひとり + 旅), and kanji + okurigana gives both pieces (決める → 決 + 決める). Pieces of 3+ characters go to the trigram index (OR, as before); 1–2 character pieces (山田, 東京, 車) are matched with LIKE, and LIKE candidates are ordered by how many pieces they contain. The 0.19.1 term coverage (IDF-weighted) is counted per piece. A memory that contains the whole question (edge punctuation off) gets full relevance, so what 0.19.1 found is not ranked below rows sharing only some pieces. At most 16 pieces per query (longest kept): a 500-kanji question used to hit SQLite's "Expression tree is too large". A query word with no CJK character is split exactly as before, so English and space-separated queries get the same words and ranking. **Also fixed (since before 0.19.1):** `%` `_` `\` in the query and in `entity_name` are literal in LIKE (`50%` no longer matches `500`, `snake_case` no longer matches `snake-case`). `test/recall-ranking.mjs` cases 9–10: one fictional person with several items asked in natural Japanese → the asked item is rank 1 (kanji / katakana / alphanumeric mixes such as 「v0.19.1 の公開日は？」, full-width punctuation, 1–2 character questions, another person's same item); みずほの口座 / ひとり旅 / 決める against a higher-importance row sharing a piece; a 500-kanji question; `50%` / `snake_case`. **Known limits (updated):** a long kanji-only run (a Chinese sentence) is still one piece; a kanji run does not know word boundaries (「公開日」 does not match 「公開した日」); a Hiragana content word made only of function-word characters can be cut (はなし → なし; the whole-question floor keeps an exact match); an English 1–2 character word with `?` (`CI?`) still finds nothing. Cost on a 3,000-memory DB (median): a Japanese sentence ~8 ms (returned nothing) → ~25–40 ms; 10 pieces ~45 ms, 16 pieces ~65 ms, a 500-kanji question ~56 ms (capped); English unchanged (~8 ms).

## v0.19.1 — 2026-11-10 (recall ranks the asked words first; MCP registry publishes from the tag)

- **`recall` ranks the memory that has the asked words first.** Two causes, both fixed: (1) sentence punctuation stayed glued to the last word, so in "…editor?" the word `editor?` could never match under the trigram index and only the person's name matched — every memory about that person tied, and bm25's short-row bonus picked the order; edge punctuation is now trimmed from each query word (inner punctuation such as `server.ts`, `eu-north` is kept). (2) Relevance was bm25 alone, normalised against a range forced to include 0 and 1. Relevance is now 0.8 × term coverage (which asked words the memory contains, each weighted by its bm25 IDF, so a word on every memory — a name, the `what` key — counts for almost nothing) + 0.2 × a fixed bounded transform of bm25 (x / (1 + x), x = −bm25 — not min-max over the candidates, which turned a 1e-7 bm25 difference into 0.2 of relevance and let a short low-importance note pass a pinned caveat on a one-word query; Codex review 1 of #30). The heat / momentum / importance weights, the LIKE fallback (0.5), and the default hiding of superseded and consolidated memories are unchanged. On the borrowed Day 028 benchmark the asked person + item is now rank 1 on 12/12 current questions (was 6/12); current / historical answers stay 8/12 / 12/12 (the 4 current misses are the original extraction). New required test `test/recall-ranking.mjs` (item rank, all-words over some-words, supersede, symbols `v0.19.0` `#21` `.env` `C++`, Japanese one-word queries with and without `？`, superseded/consolidated hidden counts, importance on near-equal bm25). **Known limit:** a Japanese sentence has no spaces, so it is one query word and matches only where that exact string appears; this change mainly helps English and space-separated queries (a Japanese sentence ending in `？` that is a substring of a memory now hits; one that is not still returns nothing, as before). Better CJK word splitting is a separate PR (done in Unreleased, see above). Words of 1–2 characters (`東京`, `CI`) still go through the LIKE fallback, which matches the whole query as one substring: they are found as before, but with a trailing `？`/`?` they are not (unchanged known limit, pinned in the test). Because `？`/`?` is now trimmed, `superseded_hidden` / `consolidated_hidden` can be higher than before for the same query — they count the hidden rows that contain an asked word, which now includes the key word. Cost: one FTS lookup per query word; median recall on a 3,000-memory DB went from ~51 ms to ~59 ms.

- **Release CI:** a version tag now also publishes `server.json` to the official MCP registry after the npm publish succeeds (pinned, Sigstore-verified `mcp-publisher`, `login github-oidc`, no secret; server.json is re-checked against the published tarball first). A dry run stops at `validate`. If the registry step fails, the job goes red with a "publish by hand" notice.

## v0.19.0 — 2026-11-06 (SQLite from Node itself: npm 12's `npx` starts again)

No new tools, no schema change, same `memory.db`. The SQLite driver underneath changed.

### What was happening

npm 12 stops dependency install scripts by default. `npx -y linksee-memory` then got
`better-sqlite3` without its native binding, and the server died on start with
"Could not locate the bindings file". npm 11 still built it, so it depended on the user's npm.

### What changed

- **`node:sqlite` is the default driver** when the running Node has it with FTS5 (22.16+; 24 LTS). Node 22.13–22.15
  ship node:sqlite without FTS5; that is detected (not version-matched) and they use better-sqlite3. Nothing is
  compiled on install, so npm 12's script blocking no longer matters. All SQLite access goes through
  one layer, `src/db/sqlite.ts`, which gives node:sqlite better-sqlite3's behaviour where the code
  relies on it: plain-object rows, Buffer blobs, Number `changes` / `lastInsertRowid`, `SQLITE_*`
  string error codes (e.g. `SQLITE_READONLY_ROLLBACK`, `SQLITE_BUSY`), a 5 s busy timeout,
  `transaction()` with `.immediate` and savepoints when nested, `pragma(…, { simple })`, foreign keys
  on and a 16 MB page cache as in better-sqlite3's build.
- **`better-sqlite3` is now an optionalDependency**, used only on a Node without node:sqlite
  (Node 20, 22.0–22.15). If it cannot be built either, the server prints one line (upgrade Node, or
  allow better-sqlite3's install script) and exits 1 — no stack trace, nothing on stdout.
- node:sqlite's own `ExperimentalWarning` is silenced; every other warning is kept. Output stays on stderr.
- `LINKSEE_SQLITE_DRIVER=node | better` forces a driver. CI runs the whole test list under each.
- setup's runtime check (`verifyRoot`) now opens a database through the same layer instead of
  loading better-sqlite3 directly.

### Known differences that do not change results

- node:sqlite's SQLite (3.50.x in Node 22.19) can be older than the one bundled in better-sqlite3
  (3.53.x). The file format is the same; a DB written by either opens in the other (tested both ways).
- In WAL mode node:sqlite's build syncs with `synchronous=FULL`, better-sqlite3's with `NORMAL`:
  slightly slower writes, never less durable.

## v0.18.1 — unreleased (Consolidate stops deleting)

No new MCP tools (still 7), no schema change. One optional argument on `recall`
(`include_consolidated`), one CLI subcommand (`consolidate --dry-run | --apply`), and one
change in what the package does to your rows: **no memory row is deleted any more except the
one you name in `remember({ memory_id, forget: true })`.** Three paths deleted or hid rows on
their own: consolidate, the Stop-hook re-import, and the start-up distill triage.

### What was happening

Up to 0.18.0, `consolidate` — the "sleep" pass — did two things to every memory that was
unprotected, in the `context` / `emotion` / `implementation` layer, older than 7 days and not
accessed lately ("cold"):

1. Rows that clustered (2 or more on the same entity and layer) were replaced by one
   `learning`-layer summary that kept three 200-character fragments and the sentence
   "N cold observations on X consolidated during sleep". The originals were **DELETEd**, and
   their `memory_edges` went with them (ON DELETE CASCADE).
2. A forget-sweep then **DELETEd** every remaining cold row whose forgetting score crossed a
   threshold — no summary at all.

On the maintainer's own database this removed 1,360 rows on 2026-10-29 and 559 rows (11 of
them `type: decision`) on 2026-11-05, with no notice to the user and no way to opt out other
than the `LINKSEE_AUTO_CONSOLIDATE` switch that 0.17.1 added (0.17.1 made the start-up run
opt-in; whatever still ran it — an older runtime, an explicit opt-in — deleted). A memory
server whose point is "hand over with the reasons attached" and "do not repeat the same
mistake" was quietly discarding the reasons.

**Rows that earlier versions deleted are not in the database and this version cannot bring
them back.** They come back only from a backup of `~/.linksee-memory/memory.db` (and its
`-wal` file) taken before the run. The `consolidations` table still lists the deleted ids per
summary (`replaced_ids`), and the summaries keep three fragments each — that is all that is
left of them.

### Changed

- **The Stop-hook re-import is append-only.** Every re-import (one per turn) used to DELETE the
  session's undistilled rows (outside the insert transaction), its `session_file_edits` — which
  cascaded into `drift_edges` and erased dismiss/ack verdicts — and every event mentioning the
  session, then insert them again: a failed insert lost the rows, a successful one renumbered
  them, and a user's `remember({ memory_id, content })` correction of a captured row was undone
  at the next turn. Now a re-import only adds: memories are keyed by source kind, turn id, layer
  and the file path (file-edit rows) or ordinal; `session_file_edits` by turn, path, operation,
  time and ordinal. A row the DB already has is **not touched** — no UPDATE, no DELETE — so user
  edits, ids, `memory_edges` and drift verdicts stay. New keys are inserted; a row whose key the
  extractor no longer produces is left. The one `session_imported` event per session is updated
  in place. All of it is one `BEGIN IMMEDIATE` transaction; a failure leaves every table as it
  was. Before importing, the normal schema migration runs: it can raise `protected` (0 → 1
  only, for rows with importance ≥ 0.9) and fill columns an older schema lacks; it does not
  change the text, relations or verdicts of a memory.
- **The start-up distill triage skips caveats and protected rows.** It runs at every server
  start and archives short or stale raw captures as `state: superseded`, which the default
  `recall` hides — so a short caveat ("never X") was hidden at every start. Protected rows and
  the `caveat` layer are now left in the queue. Rows archived by earlier versions are not
  un-archived automatically; `recall({ include_superseded: true })` shows them.
- **`consolidate` never deletes.** A cluster still gets one summary (now listing `folded_ids`
  as well as the old `replaced_ids` key, and the exemplars carry their ids); the originals get
  `consolidated_into: <summary id>` added to their content JSON (`json_set`) and stay in the
  table with everything else they had. The whole run — reading the plan, summaries, audit rows,
  marks, the `in_progress → stalled` sweep and decision-edge detection — is one
  `BEGIN IMMEDIATE` transaction: the write lock is taken before the plan is read, and a failure
  at any step (including a row count other than before + summaries, checked inside it) rolls
  everything back. A member that is no longer a JSON object, or already marked, aborts the run
  rather than guess. Plain-text memories (content that is not a JSON object) are never folded —
  the mark can only go into JSON — and are counted as `skippedPlainText`.
- **The forget-sweep is gone**, not replaced by a `cold: true` mark. Reasons: heat is computed
  from access data at read time, so a stored `cold` flag would be stale the moment the row was
  read again and nothing would clear it; and it would rewrite rows nothing summarised, for no
  reader. The count is still visible: `consolidate --dry-run` prints how many rows the sweep of
  earlier versions would have deleted, and the result reports `coldUnclustered`.
- **Default `recall` hides folded rows** the same way it hides superseded ones (in SQL, before
  the limit) and reports `consolidated_hidden: <n>` (number, or `"1000+"`) with a hint;
  `include_consolidated: true` shows them, each carrying `consolidated_into`. A row that is both
  superseded and folded is counted once, under `superseded_hidden`. The filter is NULL-safe:
  plain-text rows are kept.
- **Start-up stays off** unless `LINKSEE_AUTO_CONSOLIDATE=1` exactly (`true` / `on` / `yes` /
  `weekly`, accepted since 0.17.1, no longer turn it on), or `--auto-consolidate` on the server
  command line (kept for compatibility). When
  off, the server prints one stderr line 3 s after start: `auto-consolidate is off (set
  LINKSEE_AUTO_CONSOLIDATE=1 to enable); N cold memories would be folded` — a read-only count,
  so a growing database is noticed without anything being touched. When on, the weekly gate is
  unchanged and the completion line now says how many rows were marked and `0 deleted`.
- **`consolidations.replaced_ids`** keeps its name and now lists the ids that were marked, not
  deleted. `events` rows of kind `memory_consolidated` carry `deleted: 0`.

### Added

- **`npx -y linksee-memory consolidate --dry-run`** — counts (rows in the DB, candidates,
  clusters, rows `--apply` would mark, `0` it would delete, cold-but-unclustered, plain-text
  skipped, what the old sweep would have deleted) and up to 3 example clusters with ids and a
  fragment each. Opens the DB read-only and does not run migrations, so `memory.db` is not
  written; a database at an older schema is refused ("migrate first", exit 1). `--json` for
  machine output; `--min-age-days N` (default 7).
- **`npx -y linksee-memory consolidate --apply`** — the fold described above. Prints the row
  count before and after (read inside the transaction). Any failure: rolled back, exit 2.
  **No flag, or both flags: the DB is not opened, exit 1.**
- `pnpm test` — runs the regression suites that use a throwaway DB (`share-draft`, `live-check`,
  `supersede-source`, `session-import`, `distill-triage`, `consolidate-no-delete`,
  `auto-consolidate`).
- The id-less "auto-sweep" branch of the internal forget handler (unreachable from any tool) is
  removed; `src/` now has one `DELETE FROM memories` — the explicit `forget` by id.

### Not changed (limits)

- `remember({ memory_id, forget: true })` still deletes that one row on request (unchanged;
  caveats refuse). Nothing else in the server deletes a memory row.
- A raw Stop-hook capture is still refused as a `supersedes` target (the reason given — its id
  changes at the next import — no longer holds; the refusal is left as it is for now).
- **A re-import does not refresh rows it already wrote.** A file-edit memory keeps the op count
  of the turn it was first imported in, a summary-type row keeps its first text, and an improved
  extractor does not reach old rows. Accepted to keep user edits and drift verdicts safe;
  0.18.2 will look at updating only rows that are still raw and untouched since import.
- If the extractor changes how it splits a session, a re-import can leave an old row next to its
  new form (nothing is deleted to make room).
- The summary text is the same rule-based one as before (three fragments, no LLM). It is a
  pointer to the originals now, not a replacement for them.
- Rows folded by this version are hidden from the default `recall`; a reader who does not pass
  `include_consolidated` sees the summary (learning layer) and the count, not the rows.

## v0.18.0 — 2026-11-05 (Reversal and who-wrote-it)

No new MCP tools (still 7) and no schema change (the `memory_edges` table and the
`memories.source` column were already there; nothing wrote them). Two optional arguments on
existing tools — **and one change to what a default `recall` returns: superseded memories are
hidden, including the ones earlier versions already marked `state: superseded`** (about 112 on the
maintainer's database; still in the DB, `include_superseded: true` shows them).

### Added

- **Claude Code plugin marketplace** — `/plugin marketplace add michielinksee/linksee-memory` then
  `/plugin install linksee-memory@linksee-memory` registers the MCP server (`npx -y linksee-memory@latest`)
  and the agent skill. No hooks: `setup` still installs those. `.claude-plugin/` only; nothing in the
  npm package changes.
- **`remember({ content, supersedes: <id> | [<id>, …] })`** — the new memory replaces older ones.
  Writes a `supersedes` edge (new → old) and sets the old memory's `state` to `superseded` with
  `superseded_by` (plain-text memories keep their text; the edge marks them). The new row, the
  edges and the state change are one transaction. Refused — and nothing is saved — when an id does
  not exist, is the new memory itself, belongs to another entity, or is an undistilled raw capture
  from a Claude Code session (the next import of that session would give it a new id and drop the
  link). Also refused, with nothing written: content that is a JSON object or array missing any of
  `altitude` / `type` / `state` (it would be re-wrapped and its state re-guessed, so an explicit
  state in it could not be confirmed) — send plain text, or JSON with all three. A JSON string or number is treated as plain text (it carries no state to lose). Without
  `supersedes` such JSON is re-wrapped as before. Not accepted together with `memory_id` (update). If the old memory was enforced as an
  anchor, the reply names it; the anchor is not retired automatically (`resolve_drift` does that).
- **`recall({ include_superseded })`** — superseded memories are hidden by default
  (`superseded_hidden` says how many); `include_superseded: true` shows them. `mem_state:
  "superseded"` shows the ones whose state says so — a plain-text memory marked only by a link is
  not among them. A memory that is the target of a link carries `superseded_by` (rows marked
  superseded by earlier versions, with no link, do not). The newer memory carries
  `supersedes: "#<id>"`.
- **`memories.source` for new rows.** Through MCP: `{"client","version","via":"mcp"}` from the
  `clientInfo` the host sent in `initialize` (`{"client":"unknown","via":"mcp"}` without one). Stop
  hook: the session keys plus `"client":"claude-code","via":"stop-hook"` (`"via":"import"` for a
  manual import). `recall` adds `by: <client>` to rows that have one. The client name is
  self-reported, not verified. Rows written before 0.18.0 are not back-filled.

### Changed

- **Default `recall` hides superseded memories** — rows that are the target of a `supersedes` link
  and rows already marked `state: superseded` by earlier versions (distill triage, the opt-in
  consolidate). They are left out in SQL before the result limit, so a pile of them cannot crowd a
  current memory out. They are still in the database; `include_superseded: true` shows them.
- A memory saved with `supersedes` is the current one (content: plain text, or JSON with all of
  altitude/type/state — partial JSON is refused). Only when its state was **guessed from the
  text** as `superseded` (「代わりに」, "replaced" describe the old decision) is it stored as
  `decided`, and the reply says so (`state_note`). A state given **explicitly** in the content is
  kept; an explicit `state: "superseded"` together with `supersedes` contradicts itself and is
  refused, with nothing written.
- The superseded filter is NULL-safe: plain-text memories and JSON without a `state` stay visible.
- `remember` no longer reports a saved memory as failed when the momentum refresh after the save
  fails; the save stands and `warnings` says what failed (a retry would have saved it twice).
- README "First round trip": a two-repo step (a decision recorded in repo A **is** returned in
  repo B — memory is per machine, labelled by entity; `entity_name` narrows by a part of the entity
  name, so `repo-a` also matches `repo-a-backup`) and a reversal step.

### Not changed (limits)

- Nothing detects a reversal for you: the agent must pass the old id.
- The Stop-hook re-import still deletes a session's raw rows outside the transaction that
  re-inserts them (unchanged from 0.17.x). Next version.
- After-save problems are reported three ways: `warnings` (momentum), `anchor_error` (anchor
  declaration), and nothing when writing the anchor id back into the memory fails; the existing
  "remember again" hint can lead to a second save. Next version: one `warnings` field.
- `superseded_hidden` is a number, or the string `"1000+"` when the count reaches the cap. It
  costs one or two extra searches per recall (they read row content). Next version: one type and
  a cheaper count.
- Two writers in the same moment: SQLite WAL with better-sqlite3's 5 s busy timeout. A save that
  times out is reported as failed and writes nothing (tested with a held write lock); a real
  two-client collision has not been reproduced beyond that.

## v0.17.2 — 2026-11-04 (Old databases, runtime cleanup)

No new MCP tools (still 7). Two CLI subcommands, both run by hand.

### Added

- **`npx -y linksee-memory@0.17.2 migrate [--dry] [--db <path>]`** — brings a schema 1–5 memory.db
  (0.11 and earlier, up to May 2026; 0.17.1 refuses these) to the current schema without starting
  the server. **Every client must be closed for the whole run:** nothing here is a lock, a WAL-mode
  file is never probed for writers, and an idle client on it is detected only on Windows (the final
  rename is refused). What it does:
  - checks free space for 3 × (memory.db + sidecars); if it cannot check, it stops. 3 × is a floor,
    not a bound: WAL / journal growth during the migration comes on top;
  - copies `memory.db` (+ `-wal`, `-journal`) byte for byte into `memory.db.migrating-<time>-<pid>/`
    and stops if the live files' size or mtime change meanwhile;
  - lets SQLite recover the copy (hot journal rolled back / WAL read, in the copy), requires
    `integrity_check` = ok, makes a single-file replica with `VACUUM INTO` and checks it (same
    schema, same row count in every table);
  - migrates the replica in one transaction and commits only if no table lost rows, the schema is
    current and `quick_check` is ok. Any failure up to here: this command has not written to the
    live files (`memory.db`, `-wal`, `-shm`, `-journal` byte-identical in the tests);
  - swap: if the live size and mtime are unchanged and — for a rollback-journal file without a
    `-journal` / `-wal` — one writable connection's `BEGIN IMMEDIATE` + `ROLLBACK` probe finds no
    writer (it writes nothing), it renames `memory.db` and its sidecars into
    `memory.db.pre-migrate-<time>/` (the original set, byte for byte, with a `README.txt` on how to
    go back) and renames the replica into place. If a rename fails it tries to put back what was
    already moved. If something could not be put back, it prints (and writes to `README.txt`) where
    each original file is now and the exact `move <from> → <to>` lines that reunite the set;
  - removes the work folder, and says so if it cannot. If the process itself is killed or crashes,
    `memory.db.migrating-<time>-<pid>/` can be left behind; it holds copies only and can be deleted.
  To go back after a successful run: move the current `memory.db` and all its sidecars aside
  together, then move the whole backup set back — never mix a database and sidecars from different
  sets. (After a failed swap, follow the printed moves instead.) `--dry` rehearses in a
  temporary folder and swaps nothing. Schema 6 and newer: "not needed" (a schema 6+ file with a hot
  journal is recovered the same way, since 0.17.1 refuses it). It never consolidates or merges
  duplicate entities (0.11's v5 merge deleted rows; they are kept). The server's refusal messages
  point at this command pinned to this exact version (if the version cannot be read, the fixed
  `@0.17.2` is printed — never an unpinned command, which could start an older version's server).
- **`npx -y linksee-memory runtime list | prune [--yes --scope-confirmed] [--settings <file>]…`** —
  lists `~/.linksee-memory/runtime/<version>/` with sizes and what references each. References are
  looked for in `~/.claude/settings.json`, `settings.local.json`, `~/.claude.json`,
  `~/.codex/config.toml`, the current folder's `.claude/settings*.json` and every `--settings`:
  JSON is parsed and every string checked (so `\/` escapes and backslashes count). The TOML file is
  read by a deliberately small reader that accepts only blank lines, comments, `[table]` headers of
  bare keys and `bare.key = ` a string, a one-line array of strings, a number or true/false; every
  string it read is checked. Anything else (a quoted key, an inline table, a multi-line value, …)
  makes the file "could not confirm". A JSON file that does not parse, a TOML file the reader does
  not fully accept, an unreadable file or a missing `--settings` file → nothing is deleted and the
  reason is printed. Other repos where `setup --project` was run cannot be found from here, so
  `--yes` alone deletes nothing: `--scope-confirmed` states that those were checked or passed with
  `--settings`. A deletion that fails exits 1 and is not reported as deleted. The version this
  command runs from, `.tmp-*`, `*.old-*` and non-version names are never touched.

### Fixed

- Same-version runtime swap: when the old runtime could not be moved back, setup's note said both
  "existing runtime left as it was" and "the previous one is at …". It now says only where the
  previous runtime is and how to restore it.
- The server's read-only check (0.17.1) cleans up a `-shm` it created only when the `-wal` did not
  change while it looked, and renames the `-shm` before deleting it. This narrows the race with a
  client opening the file at the same moment; it does not close it. On Windows an open `-shm`
  cannot be renamed, so it stays; on macOS / Linux it can, and that race remains (0.17.3).

## v0.17.1 — unreleased (Fixes only)

Fixes for what a new user runs into on the first day. No new features, no new tools (still 7).

### Fixed

- **setup no longer overwrites a `settings.json` it cannot read.** The Stop-hook step treated a
  parse failure (including a UTF-8 BOM, Notepad's default) as `{}` and wrote it back, wiping the
  user's other hooks and settings. Both settings steps now strip the BOM, refuse to write when the
  file does not parse, keep one `settings.json.bak-<timestamp>` before changing it, write via a
  temp file + rename, and write nothing when nothing changed.
- **Hooks call `node` directly instead of `npx -y`.** Each `npx -y linksee-memory guard|sync` call
  took 7.4–8.6 s on a warm cache (npm start-up + registry check; measured on Windows), against an
  8 s `PreToolUse` timeout — so the guard could time out and silently not fire. setup now writes
  `"<node>" "<package>/dist/bin/<bin>.js" --linksee-managed` (0.20–0.27 s on the same machine).
  Run through `npx`, setup installs this version once with `npm install --prefix
  ~/.linksee-memory/runtime/<version> --no-save --omit=dev` (npx's cache is temporary), shows its
  size. Older runtime versions are never removed automatically (each is about 35 MB): setup prints
  where they are, they can be deleted by hand, and `linksee-memory runtime prune` is planned for
  0.17.2. A same-version reinstall swaps through `<dest>.old-<pid>` so it can
  be undone. On failure the existing runtime stays and the hooks keep the npx form. Re-running setup rewrites only hooks it
  wrote: the exact `npx -y linksee-memory sync|guard` strings and the `--linksee-managed` form.
  Wrappers and hand edits are left alone and listed; `--no-guard` leaves the guard hooks untouched.
  Paths with `$`, backticks, `%` or `"` keep the npx form. If the SQLite native addon cannot load
  (e.g. after a Node major upgrade — it fails when the DB is opened), the guard and Stop hooks print
  one line, "linksee-memory: native module failed to load (Node changed?). Re-run: npx -y
  linksee-memory setup", and let the action through; other failures stay silent (hook.log).
  Rewriting `settings.json` keeps its permission bits, writes through a symlink, and refuses a
  symlink whose target is missing.
- **The server no longer consolidates memories on its own.** Start-up consolidation deleted the
  original rows (keeping a 3 × 200-character summary) without the user asking. It is now off
  unless `LINKSEE_AUTO_CONSOLIDATE=1` (or `--auto-consolidate`). There is no `consolidate` tool
  (merged away in 0.7.0); the old hint that it "auto-runs on server startup" is corrected, and so
  are the README FAQ and the bundled agent skill (which told agents to run a `consolidate` tool
  weekly). Rows removed by earlier versions are not restored.
- **Old databases.** Every DB older than schema 8 stopped with `no such table: drift_anchors`
  (0.8.0 – 0.17.0), after partly altering the file. Schema 6–8 now migrate. Schema 1–5 is refused
  before anything is written — the schema is read on a read-only connection before any writable
  one exists, so a leftover WAL is not checkpointed and memory.db / -wal / -journal stay
  byte-identical (a file with a hot rollback journal is refused the same way; if the read-only
  check cannot run at all — e.g. another process holds a lock — it refuses too and says to close
  other clients, rather than guessing) — with one message: back up the folder, and do not open it with another
  linksee-memory version meanwhile. No older version is suggested as a stepping stone (0.7.2,
  for one, has no subcommands: any `npx linksee-memory@0.7.2 …` starts its server, whose start-up
  consolidate can delete rows). A migration command for these files is planned for 0.17.2.

### Docs

- README: the "~100 ms per turn" claim is replaced by measured numbers for both hook forms; the
  Quick Start says what setup writes, how to undo it (`.bak`), that the memory is shared over MCP by
  five clients while auto-capture and the guard are Claude Code only, the one-line Codex
  registration, and a first try that works on an empty memory. The guard's scope (every repo by
  default) is stated consistently. The README's Changelog section now points here; its v0.4–v0.11
  entries were moved into this file.
- setup's closing message says the same, and on an empty memory suggests "remember X" → new
  session → "what did we decide about X?" instead of a recall that cannot find anything yet.

## v0.17.0 — 2026-10-30 (Share a fix as a link)

### Added — `share_draft`: share a fix as a link, never a send

- New MCP tool `share_draft` (and `npx -y linksee-memory share-draft`). For use only when the
  user wants to share how a SaaS / MCP / API connection got stuck and what fixed it. Takes fixed
  fields only (`service`, `task`, `symptom`, `tried`, `result`, `conditions`, `kind`, `runtime`),
  checks them, and returns a link to KanseiLINK's reviewed draft page. Linksee makes no network
  call; the user opens the link and sends from that page.
- A field that looks like a key / token / JWT / Bearer value, an e-mail, a tenant URL, an IP, a
  local path or a long hex / base64 run stops the build and names the field. Patterns ported from
  KanseiLINK `secret-mask.ts` (2026-10-30). URL capped at 2,000 characters — it asks to shorten,
  it does not cut. `kind` is required, so the draft never claims "executed" by default.
- Records only that a draft was made (`events.kind = 'share_draft_created'`, no payload). No
  telemetry added. The six memory/drift tools are unchanged; `tools/list` now shows 7.

### Security

- `@modelcontextprotocol/sdk` raised from `^1.0.0` (locked at 1.29.0) to `^1.32.2`, and the lockfile re-resolved within the existing ranges. `pnpm audit --audit-level moderate` goes from 46 findings (hono, qs, express, zod and others, mostly through the SDK) to 0. This change alone does not touch the tool surface (same handshake).

### Fixed

- `test/live-check.mjs` no longer writes to the real `~/.linksee-memory`. It now runs the server against a throwaway DB in a temp folder (`LINKSEE_MEMORY_DIR`) and removes it afterwards; CI runs it the same way.

## v0.16.1 — 2026-09-07

### Fixed

- **The 0.16.0 triage never ran.** It was tucked inside the auto-consolidate block, which
  runs at most once a week and only after a 3-second timer — so on the machine it was built
  for, the queue was still 389 with no verdicts. Triage now runs on every start, before the
  first request. One indexed scan; it cannot block startup.
- `recall({ dream: true })` reported the page size as `distill_total` on the main path (the
  0.16.0 change had landed on the no-North-Star branch only). `distill_total` is now the real
  remainder everywhere, `distill_shown` is the page, and `distill: N` is actually passed through.
- `test/tool-surface.mjs` now seeds a raw backlog before the server starts and asserts the
  sweep ran, the page is capped, and the total is real — the test that would have caught this.

## v0.16.0 — 2026-09-07 (A queue you can actually drain)

The Stop hook captures raw utterances for the agent to rewrite later (anchor #70). On the
author's machine that queue had reached 389 and nobody drained it — because most of it was
never a decision. "OK. Aからいこう", a pasted file path, "はい。そうしましょう". Asking an agent
to distill those is asking it to find meaning that is not there, and the honest response to a
nag like that is to ignore it, which is how the queue reached 389.

### Added — rule-based triage, before anyone is asked to think

- On startup (with the consolidation sweep) every raw memory outside the 30-minute settle window
  is classified. Two verdicts need no intelligence: **auto-noise** (under 40 chars, a bare
  acknowledgement or imperative, a path/URL/attachment reference) and **auto-stale** (never
  recalled and older than 90 days). Both are archived — `type: note`, `state: superseded`,
  `distill_verdict` says why — never deleted, layer and protection untouched, and
  `needs_distill` stays true because it is still true: no agent rewrote it. Reversible by
  removing the verdict. Measured on the real backlog before shipping: 389 → 88 noise, 51 stale,
  **250 left for judgement**; the noise sample was read by a human first.
- The queue is **value-ordered**: caveats first, then memories on a named entity, then longer
  text, then recency. `recall({ dream: true, distill: N })` returns up to 25 for a deliberate
  drain. `distill_total` is the real remaining count, not the page size.
- The session-start digest asks for three, not for everything, and says what the rules already
  handled.

## v0.15.2 — 2026-09-07 (Say what it's for)

No code. The product changed a great deal between 0.12 and 0.15; the sentence describing it
had not. This release puts the positioning decided on 2026-09-05 — **hand a project over, with
the reasons attached**; drift detection as the second pillar, not the headline — into every
place an agent or a person reads first: the npm description and keywords, the MCP registry
manifest, and the README hero.

It also adds a **"Questions this answers"** section to the README: the twelve questions people
actually type, verbatim, each with its answer. In the AI-recommendation measurement that
started all this (2 of 36 unprompted answers named us), the only two hits were the queries
whose phrasing matched this README. Wording is the mechanism.

## v0.15.1 — 2026-09-07

### Added

- `resolve_drift({ action: 'dismiss', gate: false })` — close the drift edges as false positives
  but **keep the gate watching**. Two verdicts had been hiding behind "dismiss": *this detection
  was wrong* and *stop detecting this*. Anchor #2 ("no destructive migrations") had a lexical
  false positive from `migrate.ts`; dismissing it the old way would have silenced the one string
  the anchor exists to catch — `ALTER TABLE memories DROP`. Now the edge closes and the gate
  keeps its eyes.

## v0.15.0 — 2026-09-07 (Six tools)

Roadmap 5, and the end of the trust arc that started at 0.12.0: the surface an agent has to
hold is now six tools, one per thing it needs to do, and nothing it used to call is broken.

### Changed — six tools on the surface

`recall` · `remember` · `read_smart` · `drift_status` · `declare_anchor` · `resolve_drift`.

Anchor #1 ("3 tools, never a 4th") had a real reason — eight tools bled model-dependent
behaviour across Claude / GPT / Cursor / Codex / Gemini — and the surface had crept to eleven.
Five are folded into the six:

| Was | Now |
|---|---|
| `where_am_i` | `recall({ where: "<topic>" })` — or `recall()` for the session brief |
| `check_decision` | `drift_status({ anchor_id })` |
| `flag_proposals` | `declare_anchor({ kind: 'proposal', … })` — returns `candidate_id` |
| `dream` | `recall({ dream: true })` — the brief already carries the counts |
| `resolve_proposal` | `resolve_drift({ candidate_id, action: 'surface' \| 'dismiss', rationale })` |

The five old names are hidden from `tools/list` but **still answer when called**, so a skill or
agent written against 0.14 keeps working. `LINKSEE_LEGACY_TOOLS=1` lists them, each labelled
with its replacement.

### Added — the session brief

`recall()` with no arguments now returns what an agent needs in the first call of a session:
the triage line and 🔴/🟡 items in full, where you are on the Map, open loops as counts
(proposals, distill queue, friction), the top entities, and the exact next calls. On
2026-09-05 this took four calls, ~20k tokens, and one of them failed. `recall({ overview: true })`
is the old entity list.

### Added

- `test/tool-surface.mjs` — the surface is exactly six, the hidden five still answer, and every
  absorbed path round-trips against the real server.

## v0.14.0 — 2026-09-07 (Remember and enforce; verified and unverified)

Two roadmap items about the same thing: the product should not make the agent do the product's
job. Picking a taxonomy before you can say "remember this", and choosing between two tools to
record one decision, were both that. So was painting "nobody checked" the same colour as
"checked and fine".

### Changed — `remember`

- **`content` is the only required field.** `entity_name` / `entity_kind` default to the project
  you are in (workspace roots, else the files edited recently); `layer` defaults to `context`.
  The taxonomy is for the dashboard, not for the agent.
- **`anchor: {}` records and enforces in one call.** The memory is stored as before, and a
  drift anchor is declared from it — re-injected on session start and before Edit/Write/Bash.
  Give `anchor.violation_signal` (forbidden strings) for contradictions to be detectable, and
  `anchor.affects` (path globs) to scope it. Without signals the anchor is a constraint, and the
  response says so rather than pretending it can catch anything. Memory and anchor link both
  ways (`content.anchor_id`, `source_memory_id`). An invalid anchor spec never loses the memory.

  Before, "remember" and "declare_anchor" were two tools with two schemas and the agent had to
  choose. Choosing remember stored the decision and never re-injected it — the exact failure
  this product exists to prevent.

### Changed — a fifth state: ⚫ unverified

- An active anchor with no evidence either way — no drift edges, no resolution — is now
  **`unverified`**, not `aligned`. On the author's machine that is 35 of 45 anchors; 3 are
  actually verified. They were all the same colour. Different colour, different meaning: the
  detector has no eyes here. Give the anchor `affects` / `violation_signal` so it can look, or
  leave it as a note — but do not read it as "fine".
- `aligned` now requires evidence: a recorded resolution, or an `implements` edge (the detector
  saw reality match). `reality` names where it was observed.
- `drift_status` triage reads `🔵 N verified · ⚫ N unverified`; the compact form lists
  unverified anchors one line each, grouped by domain.
- `check_decision` had its own copy of the state machine and had drifted from `drift_status`
  — it never looked at drift edges, so it could say "aligned" on the anchor the other tool
  flagged 🔴. It now mirrors the view exactly, including dismiss and unverified.

### Fixed

- **Workspace roots were never read.** `fetchRoots` validated the client's reply against the
  *request* schema instead of the *result* schema, so every reply failed, was swallowed, and was
  cached as "no roots" for a minute — since the day it was written. `where_am_i`'s root-based
  project inference (June's "Fix ①") had never once fired; that is why a no-arg call returned
  `ambiguous_project`. Found because the new remember test drives a real roots round-trip.

### Added

- `test/remember-anchor.mjs` — drives the real MCP server over stdio, including the roots
  round-trip that infers the entity. `test/edges-state.mjs` now covers implements → aligned,
  no evidence → unverified, and check_decision agreeing with drift_status.

## v0.13.1 — 2026-09-07 (Fewer false alarms)

Day one of running the guard everywhere produced the noise it was always going to produce, and
two of the three causes were ours.

### Fixed

- **A dismissal now changes the next detection.** `resolve_drift(action:'dismiss')` closed the
  drift edges, but the gate never read the verdict — so the same wrong match fired on the very
  next command. Anchor #13 ("don't favour our own products in rankings", signals = the bare
  product names) fired six times in two minutes because a temp file path contained "Sake-Navi".
  A verdict that does not change what happens next is not a feedback loop. Dismissals are now
  durable (`gate_dismissals`, schema v16) and honoured by the gate. Pass `hit_term` to silence
  one match term and keep the anchor's real detections; omit it to silence the anchor entirely.
- **Scope decides again when the action names files.** 0.13.0 made a signal hit scope-free to
  cure the Bash blind spot, and traded one failure for another: an anchor scoped to one repo
  started firing in every repo containing its term — `insert or ignore` is ordinary SQLite
  everywhere. A signal now stands in for scope only when there is no path to check (Bash); when
  the action names files, the anchor's own `affects` decides. The Bash blind spot stays fixed.

### Changed

- The gate message offers both exits, and names the matched term: supersede if the decision
  changed, dismiss if the match was wrong. Escaping one bad match should not cost you the anchor.

### Added

- `test/guard-dismiss.mjs` — dismissal is honoured, is durable, is scoped to the term, and does
  not disable the rest of the anchor.

## v0.13.0 — 2026-09-07 (On by default)

The guard was the one layer no competing memory tool has, and it was switched off almost
everywhere — including on the author's own machine, which had 42 active anchors and the hook
installed in zero repos. This release is about the gap between "the product can do it" and
"the product does it".

### Changed — the guard is on for every repo

- `setup` wires the re-injection guard into `~/.claude/settings.json`, the scope the MCP
  server is already registered at and the scope the memory itself lives at. One SQLite file
  holds the anchors for all your projects; enforcing them per-repo meant declaring a decision
  once and having it enforced nowhere. `--project-guard` keeps the old behaviour,
  `--no-guard` skips it.
- A non-interactive `setup` now wires it and says so, instead of skipping in silence.

### Fixed

- **A forbidden string now reaches the gate even on a path-scoped anchor.** `affects` says
  where a decision applies, `violation_signal` says what is forbidden — but the gate demanded
  a path match from any anchor that had `affects`, and a Bash command carries no path. 21 of
  42 anchors on a real machine could never fire on Bash, including the one that exists to stop
  destructive migrations: `sqlite3 … "ALTER TABLE memories DROP COLUMN layer"` passed clean.
- **Setup no longer duplicates the Stop hook.** Its probe looked for `linksee-memory-sync` and
  missed `sync-session.js`, so a second copy was appended and sessions were captured twice.
  Both the guard and sync probes now recognise every shape either has been wired in — npx
  subcommand, global bin, dist path, and exec form with the path in `args`.

### Added

- `test/guard-wiring.mjs`, `test/guard-scope.mjs`. Writing to a user's global settings makes
  "merge, don't replace" load-bearing; the wiring tests found the duplicate-guard hole before
  it shipped.

## v0.12.0 — 2026-09-05 (Trust)

Found by using the server as the agent for a day. The theme is one sentence:
**aligned no longer claims convergence it did not check.**

### Fixed — two layers that were not talking to each other

- **Gate honours supersede.** `resolve_drift(action:'supersede')` recorded the resolution
  but the PreToolUse gate selected anchors by status/lifecycle only, so a superseded
  decision kept blocking — while the block text told you to supersede it.
- **Truth view reads `drift_edges`.** The detector had been writing `contradicts` edges since
  June; `drift_status` / `check_decision` never read them and reported 🔵 "Committed reality
  matches intent (convergent)" over open contradictions (one of them the PII constraint).
  Now: open `contradicts` → 🔴 drift, open `absent` → 🟡 review, `dismiss` → 🔵 accounted.
  `reality` names the evidence (file, hit term, date, what to do) or says
  *No signal observed (not verified against reality)*.
- **A supersede record retires the old anchor only.** The replacement inherited the
  "supersede" resolution and could never be shown drifting.

### Changed — less noise for the agent

- `drift_status` is compact by default: attention items in full, aligned as
  id + statement + reality per domain, candidates as counts. `verbose: true` restores the
  previous shape.
- `recall` omits ranking internals (heat / band / composite / momentum / match_reasons /
  score_breakdown) unless `explain: true`. Roughly halves the cost per memory.
- `dream` distill queue skips memories younger than 30 minutes — the Stop hook extracts
  every turn, so it was asking the agent to distill the conversation it was still in.
- `where_am_i` infers the map from files edited in the last 24h when the host sends no
  roots, before declaring the project ambiguous.

### Housekeeping

- Git now contains the tree 0.11.5 was actually published from (schema v15,
  `anchor_touch_log`, `src/lib/anchor-touch.ts`, `src/bin/export-report.ts`, the `export`
  subcommand). Entries for 0.4–0.11 were not kept in this file.
- Regression tests: `test/supersede-gate.mjs`, `test/edges-state.mjs` (throwaway DB).


<!-- v0.4–v0.11: moved here from the README's old Changelog section in 0.17.1 -->

## v0.11.3 — Robustness + MCP hygiene (2026-06-16)

- **Corrupt-database recovery:** if `~/.linksee-memory/memory.db` is unreadable, linksee preserves it as `memory.db.corrupt-<timestamp>` and starts a fresh one (with a clear message) instead of crashing with a raw SQLite error. Old memories stay recoverable in the backup.
- **`recall` tool description** no longer suggests editing your system prompt — cleaner MCP citizenship.

## v0.11.2 — More cold-start hardening (2026-06-16)

- **`stats` works on a fresh database** instead of crashing with `no such table` — it ensures the schema exists first (it may be the first command a new user runs).
- **`map --help`** prints usage instead of trying to import a map.

## v0.11.1 — Cold-start fixes (2026-06-16)

- **Run any CLI through the package name:** `npx -y linksee-memory setup` (and `map`, `sync`, `guard`, `stats`, `import`, `install-skill`). A fresh user couldn't reach the standalone bins (`linksee-memory-setup`, …) via `npx` — npx resolves package names, not sibling bin names — so the one-command install 404'd. The main bin now dispatches subcommands; the standalone bins remain as aliases.
- **`map` exits gracefully** with a next-step message when there's no `map.yaml` yet (was a raw stack trace — the exact state of a first-time user).
- **serverInfo** now reports the real package version (was pinned to an old string).

## v0.11.0 — The Map: `where_am_i` + `linksee-memory map` (2026-06-15)

**Memory is the entry point; the product map is the new surface.** Drift detection grows up from individual anchors into a whole-product map you navigate from the CLI.

- **`where_am_i`** (11th MCP tool) — locate the current topic/file on the Current Truth Map and get its blast radius. Call it with no args to auto-locate from your recent edits.
- **`linksee-memory map`** CLI — `where` · `affects` · `explain` · `status` · `next` · `reconcile` · `inspect --json` · `blueprint`. A `map.yaml` (git source of truth) describes how value reaches your user; the reconciler checks it against your code with file:line evidence. Bilingual: add `--lang ja`.
- Graded blast radius (`must fix together` / `should align` / `fyi`), declared-vs-reality verdicts, and an anti-graveyard guard for accounted-for drift.
- Per-project keys so the Map handles many projects at once.

## v0.8.0 — Drift Detection MCP Tools (2026-06-08)

**3 tools → 7 tools.** The biggest update since launch — agents can now detect, query, and resolve intent ↔ reality drift.

**New tools:**
- **`drift_status`** — returns the truth map with 4-species classification and per-node drift state
- **`check_decision`** — deep-dive into a single anchor: state, edges, pending candidates
- **`declare_anchor`** — record a decision/constraint/prohibition as a truth-map node (with v9 ProjectCoreNode fields)
- **`resolve_drift`** — close the feedback loop: fix / supersede / acknowledge / dismiss

**New engine module:**
- **`truth-engine.ts`** — state derivation logic migrated from the dashboard into the MCP engine. Any MCP client can now query drift status without a dashboard.
- **Resolution priority fix**: when multiple resolutions reference the same anchor, the most recent one wins (by `resolved_at` timestamp). Prevents a stale acknowledge from shadowing a newer fix.
- **4-species classification**: nodes classified by `decision_mode` into hypothesis / constraint / commitment / source_of_truth with display format guidance.

No breaking changes to existing memory tools. All 3 memory tools (remember, recall, read_smart) are unchanged.

## v0.7.2 — Recall ergonomics + auto-edge detection + classifier precision (2026-05-30)

Quality pass on v0.7.0 / v0.7.1 — sharper day-to-day agent UX and cleaner data for the dashboard:

- **`recall` token discipline**: drops the redundant `content_raw` from the response (parsed `content` was already there — it was a 2× duplicate), and actually enforces `max_tokens` by greedy assembly that measures real serialized size (was a flat ~100 tok/memory estimate). Adds `approx_tokens` to the response so the agent can see its budget usage. The same query that previously returned ~15,800 tokens for a 1200 budget now stays inside it.
- **`recall` precision**: near-duplicate memories — same entity + near-identical core text, e.g. the same message captured under both `goal` and `learning` — collapse to one in the result set. Composite weights adapt to query specificity: multi-term queries weight relevance higher so off-topic-but-pinned memories don't crowd narrow recalls.
- **Capture dedup (write side)**: `session-extractor` now produces AT MOST one memory per user turn, with priority `goal[first_intent] > caveat > decision > context`. A first-intent message containing decision words (e.g. "決めた" / "これで進めよう") is no longer double-saved as both `goal` and `learning`.
- **`memory_edges` auto-detection**: the previously-empty `memory_edges` table is now populated during the sleep-mode consolidation sweep. `detectMemoryEdges()` links a later DECISION memory to the most-recent earlier same-topic decision within an entity (chain, not clique) so the dashboard can render Pivot Chains. The default relation is `extends` — a same-topic later decision builds on, but does NOT deactivate, the earlier one. Explicit reversal markers (やめる / revert / instead of) produce `contradicts`; explicit replacement markers (の代わり / replaces / deprecate) produce `supersedes`. Prevents silent deactivation of still-valid decisions.
- **`inferType` / `inferState` precision**: chitchat acknowledgements ("そうだね" / "ありがとう"), pasted terminal/git/email content, and meta-noise no longer classify as `decision` — they return `note` / `open` before pattern matching. The learning-layer default → `decision` is gated by this guard. Real decisions (採用 / 決めた, even after an acknowledgement opener) survive.

No schema migration, no breaking API changes. Existing rows keep their stored content; the classifier improvements apply to new captures going forward.

## v0.7.1 — Review fixes (2026-05-29)

Based on Opus 4.7 design review of v0.7.0:

- **P0 — Required params guidance**: `remember` tool description now includes "REQUIRED PARAMS BY MODE" section so LLMs know exactly which fields are needed for create vs update vs delete.
- **P0 — Migration guidance**: Deprecated tool names (`forget`, `recall_file`, etc.) now return specific migration examples instead of generic errors.
- **P1 — recall path+query merge**: When both `path` and `query` are provided to `recall`, results from file history and memory search are merged into a single response.
- **P2 — Auto-consolidate safety**: Table existence check via `sqlite_master` before querying `consolidations` table, preventing errors on fresh databases.

## v0.7.0 — 3-Tool Unified Surface (2026-05-29)

**8 tools → 3 tools.** Following Context7's proven pattern of fewer tools = better cross-LLM consistency.

**Breaking change**: The following tools are removed from the MCP surface. Calling them returns a migration guide:

| Old tool | New equivalent |
|---|---|
| `forget` | `remember({ forget: true, memory_id: <id> })` |
| `update_memory` | `remember({ memory_id: <id>, content: "..." })` |
| `recall_file` | `recall({ path: "server.ts" })` |
| `list_entities` | `recall({})` (no params = entity overview) |
| `consolidate` | Auto-runs on server startup (7-day threshold) |

**New unified tools:**
- **`remember`** — create + update + delete in one tool. Mode is inferred from params.
- **`recall`** — search + file history + overview in one tool. Mode is inferred from params.
- **`read_smart`** — unchanged.

**Other changes:**
- Auto-consolidate on server startup (non-blocking `setTimeout`, 7-day threshold, `sqlite_master` safety check)
- Claude Code Plugin bundle (`claude plugin add -- linksee-memory`)
- Deprecation errors include specific migration examples

All internal handler functions are preserved — this is a surface change, not a logic rewrite.

## v0.3.0 — 2026-05-07 (Five Blocks)

Linksee Memory now implements **5 of the 5 MCP capability blocks**, plus the
newer Elicitation primitive. Most public MCP servers ship Tools only — v0.3.0
moves Linksee Memory into the small set that exposes the full surface.

### Added — Resources block

The memory store is now browseable via `memory://` URIs. Clients (Claude Code,
Cursor, ChatGPT) that support `@-mention` of resources can drop memories into
context without making a tool call.

Static resources:
- `memory://stats` — entity / memory counts, layer + kind breakdown, pinned count
- `memory://hot` — top memories by access_count + recency (proxy for heat)
- `memory://recent` — memories accessed in the last 7 days
- `memory://caveats` — every caveat-layer memory (the protected pile)

Resource templates:
- `memory://entity/{name}` — all memories for an entity
- `memory://layer/{layer}` — all memories in one layer
- `memory://memory/{id}` — single memory by ID

### Added — Prompts block

Five reusable prompt templates that agents can pull from the server:

- `summarize-session` — turn a transcript into 6-layer structured memories
- `extract-caveats` — pull caveat-layer pain lessons from text
- `weekly-consolidation` — sleep-mode summary for an entity
- `recall-and-write` — anti-pattern guard: recall before action with citations
- `entity-handoff` — produce a handoff doc with caveats + open questions

### Added — Sampling (client-side, opt-in)

`consolidate` gains a `use_llm: true` flag. When set, the server pre-snapshots
candidate memories, runs the existing rule-based consolidation, then asks the
client's LLM (via `sampling/createMessage`) to rewrite each cluster's summary
into prose. Clients without sampling support fall back to the heuristic
summary silently.

### Added — Roots (client-side, opt-in)

`recall_file` gains a `scope_to_roots: true` flag. The server fetches the
client's working roots via `roots/list` and filters path-substring matches to
files inside any root. Clients without roots support skip filtering.

### Added — Elicitation (client-side, opt-in)

`forget` gains an `interactive: true` flag. When set with a specific
`memory_id`, the server asks the user to confirm via `elicitation/create`
before deleting. Clients without elicitation support return a graceful
"unsupported" decline.

### Backward compatibility

- All 8 existing tools retain their original signatures and default behavior.
- DB schema unchanged (no migration).
- New flags default to `false`. Existing callers see no behavior change.
- The smoke test from v0.2.x still passes unmodified.

### Why this matters

Anthropic and the MCP working group have repeatedly highlighted that ~99% of
public MCP servers implement only the Tools block. Resources, Prompts,
Sampling, Roots, and Elicitation each unlock a different agent UX:

- **Resources** → @-mentionable browseable memory in the IDE
- **Prompts** → discoverable reusable templates
- **Sampling** → server-side intelligence without a local LLM
- **Roots** → context-aware recall scoped to current work
- **Elicitation** → user-in-the-loop on destructive ops

Linksee Memory v0.3.0 ships all of them.

## v0.2.x

Glama listing saga (HEALTHCHECK / better-sqlite3 v12 / pnpm onlyBuiltDependencies
/ ip-address override / GitHub Actions). Final score: A · A · B (Maintenance B
is the structural "no issues in 6 months" floor for new repos).

## v0.1.x

Initial public release: 8 tools (remember, recall, update_memory, list_entities,
forget, consolidate, recall_file, read_smart). 6-layer structured memory with
caveat protection, FTS5 full-text search, momentum scoring, file diff cache.
