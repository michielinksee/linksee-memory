-- linksee-memory schema v0.0.4
-- Single-file SQLite store for cross-agent structured memory.
-- Layers: 1=facts (entities), 2=associations (edges), 3=patterns (meanings), 4=events (time-series), 5=file-state (diff cache).
-- v2 adds: FTS5 full-text search, consolidations audit, momentum cache on entities.
-- v6 adds: 3-axis generated columns (altitude/mem_type/mem_state) for queryable classification.
-- v7 adds: thread_id for decision chains, memory_edges for memory→memory relationships.
-- v8 adds: drift observability — drift_anchors (declared intent) + drift_edges (intent×reality verdicts).
--          Purely ADDITIVE: new tables only, no ALTER. Revert = DROP the two tables (no migrate.ts hook).

-- ============================================================
-- Layer 1: Facts — entities (people / companies / projects / concepts)
-- ============================================================
CREATE TABLE IF NOT EXISTS entities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL CHECK (kind IN ('person', 'company', 'project', 'concept', 'file', 'other')),
  name            TEXT NOT NULL,
  normalized_name TEXT,                            -- lowercased, separator-normalized for dedup matching
  canonical_key   TEXT UNIQUE,
  attributes      TEXT,
  momentum_score  REAL NOT NULL DEFAULT 0.0,      -- 0-10 cached; refreshed on event insert
  momentum_at     INTEGER,                         -- when momentum was last computed
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_entities_kind       ON entities(kind);
CREATE INDEX IF NOT EXISTS idx_entities_key        ON entities(canonical_key);
CREATE INDEX IF NOT EXISTS idx_entities_normalized ON entities(kind, normalized_name);

-- ============================================================
-- Layer 3: Meanings — 6-layer structured memory per entity
-- ============================================================
CREATE TABLE IF NOT EXISTS memories (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id       INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  layer           TEXT NOT NULL CHECK (layer IN (
                    'goal', 'context', 'emotion', 'implementation', 'caveat', 'learning'
                  )),
  content         TEXT NOT NULL,
  importance      REAL NOT NULL DEFAULT 0.5,
  protected       INTEGER NOT NULL DEFAULT 0,
  source          TEXT,
  thread_id       TEXT,                                -- groups related memories (e.g. same session, same decision chain)
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  last_accessed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  access_count    INTEGER NOT NULL DEFAULT 0,
  -- 3-axis classification (v0.5.0): auto-extracted from content JSON.
  -- NULL when content is plain text (non-JSON). VIRTUAL = computed on read, indexed.
  altitude        TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(content) THEN json_extract(content, '$.altitude') ELSE NULL END) VIRTUAL,
  mem_type        TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(content) THEN json_extract(content, '$.type') ELSE NULL END) VIRTUAL,
  mem_state       TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(content) THEN json_extract(content, '$.state') ELSE NULL END) VIRTUAL
);

CREATE INDEX IF NOT EXISTS idx_memories_entity     ON memories(entity_id);
CREATE INDEX IF NOT EXISTS idx_memories_layer      ON memories(layer);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_protected  ON memories(protected);
CREATE INDEX IF NOT EXISTS idx_memories_altitude   ON memories(altitude);
CREATE INDEX IF NOT EXISTS idx_memories_mem_type   ON memories(mem_type);
CREATE INDEX IF NOT EXISTS idx_memories_mem_state  ON memories(mem_state);
CREATE INDEX IF NOT EXISTS idx_memories_thread     ON memories(thread_id);

CREATE TRIGGER IF NOT EXISTS trg_protect_caveat
  AFTER INSERT ON memories
  WHEN NEW.layer = 'caveat'
  BEGIN
    UPDATE memories SET protected = 1 WHERE id = NEW.id;
  END;

-- ============================================================
-- FTS5 full-text search over memory content (Day 2)
-- BM25-ranked retrieval; combined with heat + momentum at query time.
-- ============================================================
-- trigram tokenizer indexes 3-character substrings — works for both English (case-insensitive
-- via remove_diacritics) AND Japanese/CJK (no word boundaries needed).
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content='memories',
  content_rowid='id',
  tokenize='trigram remove_diacritics 1'
);

CREATE TRIGGER IF NOT EXISTS trg_memories_fts_ai
  AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (NEW.id, NEW.content);
  END;

CREATE TRIGGER IF NOT EXISTS trg_memories_fts_ad
  AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', OLD.id, OLD.content);
  END;

CREATE TRIGGER IF NOT EXISTS trg_memories_fts_au
  AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', OLD.id, OLD.content);
    INSERT INTO memories_fts(rowid, content) VALUES (NEW.id, NEW.content);
  END;

-- ============================================================
-- Layer 2: Associations — graph edges between entities
-- ============================================================
CREATE TABLE IF NOT EXISTS edges (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id       INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_id         INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation      TEXT NOT NULL,
  weight        REAL NOT NULL DEFAULT 1.0,
  attributes    TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(from_id, to_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges(to_id);
CREATE INDEX IF NOT EXISTS idx_edges_rel  ON edges(relation);

-- ============================================================
-- Memory edges — directed relationships between individual memories
-- Enables: decision→implementation→outcome chains, supersedes tracking.
-- ============================================================
CREATE TABLE IF NOT EXISTS memory_edges (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  from_memory_id  INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_memory_id    INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation        TEXT NOT NULL CHECK (relation IN (
                    'supersedes', 'resolves', 'implements', 'contradicts', 'extends'
                  )),
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(from_memory_id, to_memory_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_medge_from ON memory_edges(from_memory_id);
CREATE INDEX IF NOT EXISTS idx_medge_to   ON memory_edges(to_memory_id);
CREATE INDEX IF NOT EXISTS idx_medge_rel  ON memory_edges(relation);

-- ============================================================
-- Layer 4: Events — time-series log with importance markers
-- ============================================================
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id     INTEGER REFERENCES entities(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  payload       TEXT,
  occurred_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_events_entity   ON events(entity_id);
CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind     ON events(kind);

-- ============================================================
-- Layer 5: File snapshots — diff cache for read_smart (Day 3)
-- ============================================================
CREATE TABLE IF NOT EXISTS file_snapshots (
  path           TEXT PRIMARY KEY,
  content_hash   TEXT NOT NULL,
  mtime          INTEGER NOT NULL,
  size_bytes     INTEGER,
  chunks         TEXT,
  last_read_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  read_count     INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_file_mtime ON file_snapshots(mtime);

CREATE TABLE IF NOT EXISTS file_facts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path       TEXT NOT NULL REFERENCES file_snapshots(path) ON DELETE CASCADE,
  chunk_hash      TEXT,
  fact            TEXT NOT NULL,
  layer           TEXT CHECK (layer IN ('goal', 'context', 'emotion', 'implementation', 'caveat', 'learning')),
  extracted_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_file_facts_path ON file_facts(file_path);

-- ============================================================
-- Sessions — track which agent / conversation produced memories
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  agent_kind    TEXT,
  started_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ============================================================
-- Session file edits (v3) — conversation↔file linkage.
-- Each row: "during session S, at turn T, memory M mentions editing file F".
-- This is the table that breaks the Mem0 "flat metatag" wall:
-- memories describe WHY, file_edits tie the WHY to concrete filesystem changes.
-- ============================================================
CREATE TABLE IF NOT EXISTS session_file_edits (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,                    -- Claude Code session uuid
  memory_id       INTEGER REFERENCES memories(id) ON DELETE SET NULL,
  file_path       TEXT NOT NULL,
  operation       TEXT NOT NULL CHECK (operation IN ('read', 'edit', 'write', 'bash', 'other')),
  turn_uuid       TEXT,
  context_snippet TEXT,                             -- 1-2 line distilled "why this edit"
  occurred_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sfe_session ON session_file_edits(session_id);
CREATE INDEX IF NOT EXISTS idx_sfe_file    ON session_file_edits(file_path);
CREATE INDEX IF NOT EXISTS idx_sfe_memory  ON session_file_edits(memory_id);
CREATE INDEX IF NOT EXISTS idx_sfe_when    ON session_file_edits(occurred_at DESC);

-- ============================================================
-- Consolidations audit (Day 2) — trail of what got compressed into what
-- ============================================================
CREATE TABLE IF NOT EXISTS consolidations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  learning_id     INTEGER REFERENCES memories(id) ON DELETE SET NULL,
  replaced_ids    TEXT NOT NULL,         -- JSON array of deleted memory ids
  replaced_count  INTEGER NOT NULL,
  entity_id       INTEGER REFERENCES entities(id) ON DELETE CASCADE,
  original_layer  TEXT NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_consolidations_entity ON consolidations(entity_id);

-- ============================================================
-- v8: Drift observability — declared intent vs. actual reality.
-- Positioned ABOVE the memory engine (Sentry/Datadog-style): surface where a
-- DECLARED constraint/decision (intent) diverges from what the code actually did
-- (reality = session_file_edits). Deductive 照合, NOT 推測.
--
-- declare-don't-mine: anchors come ONLY from explicit declaration
-- (CLI declare / curation / CLAUDE.md), NEVER from the session pattern-extractor.
-- The tier CHECK ('human','explicit') enforces this at the schema level — an
-- agent/inferred memory physically cannot become an anchor.
-- ============================================================
CREATE TABLE IF NOT EXISTS drift_anchors (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  kind             TEXT NOT NULL CHECK (kind IN ('prohibition', 'decision', 'constraint')),
  statement        TEXT NOT NULL,                       -- the normative claim, verbatim
  rationale        TEXT,                                -- WHY (entrenchment context)
  affects          TEXT NOT NULL DEFAULT '[]',          -- JSON array of path globs that scope reality
  detect_terms     TEXT NOT NULL DEFAULT '[]',          -- JSON array of topical terms (FTS/overlap scoping)
  violation_signal TEXT NOT NULL DEFAULT '[]',          -- JSON array: terms whose PRESENCE in scope = violation
  tier             TEXT NOT NULL DEFAULT 'human' CHECK (tier IN ('human', 'explicit')),
  source           TEXT NOT NULL DEFAULT 'declare' CHECK (source IN ('declare', 'curate', 'claude_md')),
  source_memory_id INTEGER REFERENCES memories(id) ON DELETE SET NULL,  -- provenance if curated; anchor outlives it
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  -- v9: ProjectCoreNode extension (Current Truth Map). ADDITIVE columns only — NO CHECK rebuild.
  -- The existing status(active/retired) STAYS the coarse scan-gate (existing detector unaffected);
  -- `lifecycle` carries the rich state. Values validated in the lib (no CHECK on new cols).
  node_type              TEXT,                       -- north_star|active_strategy|business_model|product_architecture|operational_commitment|source_of_truth|experiment|metric|asset|risk|retired_decision
  domain                 TEXT,                       -- strategy|monetization|product|engineering|growth|operations|security|roadmap|memory
  decision_mode          TEXT,                       -- constraint|commitment|hypothesis|preference|source_of_truth|metric  (the ROUTER → which detector + card behavior)
  confidence             REAL NOT NULL DEFAULT 0.8,
  lifecycle              TEXT NOT NULL DEFAULT 'active',  -- active|experiment|paused|superseded|deprecated|unknown
  validity_scope         TEXT NOT NULL DEFAULT '{}',  -- JSON {applies_to[], does_not_apply_to[]}
  card_policy            TEXT NOT NULL DEFAULT '{}',  -- JSON {enabled, severity_if_broken, require_review_before_alert, cooldown_days}
  reality_manifestations TEXT NOT NULL DEFAULT '[]',  -- JSON RealityManifestation[]
  evidence_refs          TEXT NOT NULL DEFAULT '[]',  -- JSON EvidenceRef[]
  review_after           INTEGER,
  last_confirmed_at      INTEGER,
  owner                  TEXT
);

CREATE INDEX IF NOT EXISTS idx_drift_anchors_status ON drift_anchors(status);
CREATE INDEX IF NOT EXISTS idx_drift_anchors_kind   ON drift_anchors(kind);

-- Drift edges connect an ANCHOR (drift_anchors) to a REALITY unit (session_file_edits).
-- NOT reusable as memory_edges: that table FKs both ends to memories(id); these ends don't.
-- edit_id is NULL for a pure 'absent' verdict (decided-but-no-reality).
CREATE TABLE IF NOT EXISTS drift_edges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  anchor_id   INTEGER NOT NULL REFERENCES drift_anchors(id) ON DELETE CASCADE,
  edit_id     INTEGER REFERENCES session_file_edits(id) ON DELETE CASCADE,
  verdict     TEXT NOT NULL CHECK (verdict IN ('contradicts', 'implements', 'absent')),
  confidence  REAL NOT NULL DEFAULT 0.0,                -- min(tier_anchor, tier_reality) × match_strength
  evidence    TEXT NOT NULL DEFAULT '{}',               -- JSON: file_path, context_snippet, shared_terms, hit_term, occurred_at
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ack', 'dismissed', 'resolved')),
  detected_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(anchor_id, edit_id, verdict)
);

CREATE INDEX IF NOT EXISTS idx_drift_edges_anchor  ON drift_edges(anchor_id);
CREATE INDEX IF NOT EXISTS idx_drift_edges_verdict ON drift_edges(verdict, status);
-- 'absent' has edit_id NULL, which UNIQUE treats as distinct — enforce one open absence per anchor.
CREATE UNIQUE INDEX IF NOT EXISTS idx_drift_absent ON drift_edges(anchor_id) WHERE verdict = 'absent';

-- ============================================================
-- v9: Reality events — agent-AGNOSTIC reality signals (the uniform "floor").
-- Generalizes session_file_edits beyond Claude-Code transcripts: git commits, npm
-- publishes, deploys, etc. captured uniformly across ALL agents (git/files = WHAT).
-- ============================================================
CREATE TABLE IF NOT EXISTS reality_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  scope         TEXT,                                -- project / path token
  source_type   TEXT NOT NULL CHECK (source_type IN (
                  'git_commit','git_diff','file_change','npm','github','vercel','railway','article','strategy_doc','agent_summary','other'
                )),
  summary       TEXT NOT NULL,
  file_path     TEXT,
  raw_ref       TEXT,
  hash          TEXT,
  evidence_refs TEXT NOT NULL DEFAULT '[]',          -- JSON EvidenceRef[]
  occurred_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  captured_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_reality_events_scope ON reality_events(scope);
CREATE INDEX IF NOT EXISTS idx_reality_events_src   ON reality_events(source_type);
CREATE INDEX IF NOT EXISTS idx_reality_events_when  ON reality_events(occurred_at DESC);

-- ============================================================
-- v9: Memory write candidates — the candidate→review→node staging.
-- Distillation/agents NEVER write the truth-map directly: they propose candidates.
-- Hard facts auto_accept; Soft interpretations stay pending_review (anti-AI-runaway).
-- ============================================================
CREATE TABLE IF NOT EXISTS memory_write_candidates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  scope          TEXT,
  candidate_type TEXT NOT NULL CHECK (candidate_type IN (
                   'create_node','update_node','pause_node','supersede_node','deprecate_node','create_card','no_write'
                 )),
  target_node_id INTEGER REFERENCES drift_anchors(id) ON DELETE SET NULL,
  proposed_node  TEXT,                               -- JSON Partial<ProjectCoreNode>
  rationale      TEXT NOT NULL,
  confidence     REAL NOT NULL DEFAULT 0.0,
  evidence_refs  TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN (
                   'pending_review','auto_accepted','accepted','rejected'
                 )),
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_mwc_status ON memory_write_candidates(status);
CREATE INDEX IF NOT EXISTS idx_mwc_scope  ON memory_write_candidates(scope);

-- ============================================================
-- v10: Re-injection log — the ACTIVE-observability stream (pre-action gate hits).
-- Separate from drift_edges (POST-action reality): the gate (guard.ts, fired by a Claude Code
-- PreToolUse hook) writes here when an accepted anchor is re-surfaced into context BEFORE an action.
-- Feeds `dream` — "re-injected N times, still contradicted (heeded=0)" is the machine evidence behind
-- #15443. trigger: boot=SessionStart · cue=prompt · gate=PreToolUse.
-- ============================================================
CREATE TABLE IF NOT EXISTS injection_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  anchor_id   INTEGER REFERENCES drift_anchors(id) ON DELETE CASCADE,
  session_id  TEXT,
  trigger     TEXT NOT NULL CHECK (trigger IN ('boot', 'cue', 'gate')),
  surface     TEXT NOT NULL CHECK (surface IN ('inform', 'warn', 'block', 'allow')),
  tool_name   TEXT,
  action_snip TEXT,                                   -- first ~120 chars of the attempted action
  verdict     TEXT,                                   -- contradicts | in_scope | none
  heeded      INTEGER,                                -- NULL=unknown / 1=followed / 0=ignored (dream backfills)
  occurred_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_injlog_anchor  ON injection_log(anchor_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_injlog_session ON injection_log(session_id, occurred_at);

-- ============================================================
-- v11: Current Truth Map — journey-spine topology (Product Drift OS spec v3).
-- map.yaml (git) is the desired-state SOURCE OF TRUTH (anchor #58); these tables
-- are the runtime index the importer reconciles INTO. A map_node is product
-- STRUCTURE (surface | implementation) — a SUPERSET of drift_anchors, which hold
-- only NORMATIVE claims. A normative node links out via anchor_id; descriptive
-- surfaces ("README exists") leave it NULL, so the violation scanner never sees
-- them. Full-rebuild import: the importer wipes a project's rows and re-inserts.
-- ============================================================
CREATE TABLE IF NOT EXISTS map_nodes (
  id              TEXT PRIMARY KEY,                  -- stable slug from map.yaml (e.g. 'readme')
  project         TEXT NOT NULL,
  layer           TEXT NOT NULL,                     -- surface | implementation
  stage           TEXT,                              -- journey stage id (NULL for implementation layer)
  statement       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',    -- active|experiment|commitment|planned|paused|suspect|future_thesis
  facets          TEXT NOT NULL DEFAULT '[]',        -- JSON array (the demoted old domains, as tags)
  role            TEXT,                              -- e.g. 'diffusion'
  note            TEXT,
  due             TEXT,                              -- ISO date (commitments)
  paused_reason   TEXT,
  related_project TEXT,
  spinout_candidate INTEGER NOT NULL DEFAULT 0,
  anchor_id       INTEGER REFERENCES drift_anchors(id) ON DELETE SET NULL,  -- link IFF normative
  extra           TEXT NOT NULL DEFAULT '{}',        -- JSON catch-all (forward-compat fields)
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_map_nodes_project ON map_nodes(project);
CREATE INDEX IF NOT EXISTS idx_map_nodes_stage   ON map_nodes(stage);
CREATE INDEX IF NOT EXISTS idx_map_nodes_status  ON map_nodes(status);
CREATE INDEX IF NOT EXISTS idx_map_nodes_layer   ON map_nodes(layer);

-- Node↔node typed edges — the topology that makes blast-radius computable.
-- type: realizes (impl→surface) | supports | must-stay-consistent-with | reflux (expand→discover).
-- Endpoints are map_nodes slugs (validated in the lib, not FK-constrained, to keep
-- the wipe+reinsert import order trivial).
CREATE TABLE IF NOT EXISTS map_edges (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  project   TEXT NOT NULL,
  from_id   TEXT NOT NULL,
  to_id     TEXT NOT NULL,
  type      TEXT NOT NULL,                           -- realizes|supports|must-stay-consistent-with|reflux
  note      TEXT,
  UNIQUE(from_id, to_id, type)
);
CREATE INDEX IF NOT EXISTS idx_map_edges_from ON map_edges(from_id);
CREATE INDEX IF NOT EXISTS idx_map_edges_to   ON map_edges(to_id);
CREATE INDEX IF NOT EXISTS idx_map_edges_type ON map_edges(type);

-- Project-level Map meta — the spine order/labels + the Job statement live in map.yaml,
-- NOT derivable from nodes alone. Persist them so any reader (dashboard) can render the
-- canonical journey order and the Job headline without parsing the YAML.
CREATE TABLE IF NOT EXISTS map_projects (
  project          TEXT PRIMARY KEY,
  job              TEXT,
  audience         TEXT NOT NULL DEFAULT '{}',   -- JSON
  product_status   TEXT,
  template         TEXT,
  stages           TEXT NOT NULL DEFAULT '[]',   -- JSON [{id,label}] — canonical spine order
  related_projects TEXT NOT NULL DEFAULT '[]',   -- JSON
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ============================================================
-- Meta — schema version tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS meta (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);

INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '11');
INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at', CAST(unixepoch() AS TEXT));
UPDATE meta SET value = '11' WHERE key = 'schema_version' AND value IN ('1', '2', '3', '4', '5', '6', '7', '8', '9', '10');
