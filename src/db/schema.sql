-- linksee-memory schema v0.0.2
-- Single-file SQLite store for cross-agent structured memory.
-- Layers: 1=facts (entities), 2=associations (edges), 3=patterns (meanings), 4=events (time-series), 5=file-state (diff cache).
-- v2 adds: FTS5 full-text search, consolidations audit, momentum cache on entities.

-- ============================================================
-- Layer 1: Facts — entities (people / companies / projects / concepts)
-- ============================================================
CREATE TABLE IF NOT EXISTS entities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL CHECK (kind IN ('person', 'company', 'project', 'concept', 'file', 'other')),
  name            TEXT NOT NULL,
  canonical_key   TEXT UNIQUE,
  attributes      TEXT,
  momentum_score  REAL NOT NULL DEFAULT 0.0,      -- 0-10 cached; refreshed on event insert
  momentum_at     INTEGER,                         -- when momentum was last computed
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);
CREATE INDEX IF NOT EXISTS idx_entities_key  ON entities(canonical_key);

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
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  last_accessed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  access_count    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_memories_entity     ON memories(entity_id);
CREATE INDEX IF NOT EXISTS idx_memories_layer      ON memories(layer);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_protected  ON memories(protected);

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
-- Meta — schema version tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS meta (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);

INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '4');
INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at', CAST(unixepoch() AS TEXT));
UPDATE meta SET value = '4' WHERE key = 'schema_version' AND value IN ('1', '2', '3');
