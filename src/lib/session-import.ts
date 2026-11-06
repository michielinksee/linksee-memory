// session-import — write one extracted Claude Code session into the DB without deleting
// memories (0.18.1, Codex review 1 of #23).
//
// Up to 0.18.0 every re-import (the Stop hook runs one per turn) first DELETEd the session's
// undistilled memory rows and then re-inserted them, and the DELETE ran outside the insert
// transaction: a failed insert left the session's memories gone, and a successful one gave every
// row a new id (dropping anything that pointed at the old one).
//
// Now: one BEGIN IMMEDIATE transaction per session, and memories are matched by a stable key
// instead of being deleted —
//   key = source.kind | source.turn_uuid | layer | discriminator
//   discriminator = the file path for `file_edit` rows (content.affects[0]), else the row's
//                   ordinal among rows with the same kind/turn/layer (extraction order for new,
//                   id order for stored).
// A stored row with the same key is UPDATEd in place (id kept) when its content changed; keys
// the DB has not seen are INSERTed; stored rows whose key is no longer produced are LEFT AS THEY
// ARE (nothing is deleted — the cost is that an extractor change can leave an old row next to
// a new one). Fields the stored JSON has and the new extraction does not (distill_verdict,
// distill_reason, consolidated_into, anything written later) are carried over; when triage has
// archived a row (distill_verdict), its type/state are kept too.
// Distilled rewrites are untouched and still suppress re-insertion of their raw turn.
// session_file_edits and the session's events are still replaced (they are derived link rows,
// not memories), inside the same transaction.

import type Database from 'better-sqlite3';
import type { ExtractedFileEdit, ExtractedMemory } from './session-extractor.js';
import { faultPoint } from './test-faults.js';

export interface SessionImportInput {
  session_id: string;
  memories: ExtractedMemory[];
  file_edits: ExtractedFileEdit[];
  stats: unknown;
}

export interface SessionImportResult {
  inserted: number;
  updated: number;
  unchanged: number;
  /** Stored undistilled rows whose key the new extraction did not produce. Left in place. */
  leftInPlace: number;
  edits: number;
}

type Stored = { id: number; layer: string; content: string; source: string };

function parseObj(s: string): Record<string, any> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

function discriminatorOf(kind: string, content: string): string | null {
  if (kind !== 'file_edit') return null;
  const o = parseObj(content);
  const a = Array.isArray(o?.affects) ? o!.affects[0] : undefined;
  return typeof a === 'string' ? a : null;
}

function keyer() {
  const ordinals = new Map<string, number>();
  return (kind: string, turn: string, layer: string, content: string): string => {
    const base = `${kind}|${turn}|${layer}`;
    const d = discriminatorOf(kind, content);
    if (d !== null) return `${base}|p:${d}`;
    const n = ordinals.get(base) ?? 0;
    ordinals.set(base, n + 1);
    return `${base}|#${n}`;
  };
}

/** New content, with the stored row's later additions carried over. */
function mergeContent(stored: string, fresh: string): string {
  const s = parseObj(stored);
  const f = parseObj(fresh);
  if (!s || !f) return fresh;
  const out: Record<string, any> = { ...f };
  for (const [k, v] of Object.entries(s)) if (!(k in f)) out[k] = v;
  if (s.distill_verdict !== undefined) { out.type = s.type; out.state = s.state; }
  return JSON.stringify(out);
}

export function importSession(
  db: Database.Database,
  input: SessionImportInput,
  opts: { entityId: number; sourceJson: (src: object) => string; startedAt: number },
): SessionImportResult {
  const sid = input.session_id;
  const sidNeedle = `%"session_id":"${sid}"%`;

  const selDistilledTurns = db.prepare(
    `SELECT source FROM memories
      WHERE source LIKE ? AND json_valid(content) AND json_extract(content, '$.distilled') = 1`,
  );
  const selStored = db.prepare(
    `SELECT id, layer, content, source FROM memories
      WHERE source LIKE ?
        AND (NOT json_valid(content) OR COALESCE(json_extract(content, '$.distilled'), 0) != 1)
      ORDER BY id`,
  );
  const insMem = db.prepare('INSERT INTO memories (entity_id, layer, content, importance, source, thread_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const updMem = db.prepare('UPDATE memories SET content = ?, importance = ?, source = ?, thread_id = ?, created_at = ? WHERE id = ?');
  const delEdits = db.prepare('DELETE FROM session_file_edits WHERE session_id = ?');
  const delEvents = db.prepare('DELETE FROM events WHERE payload LIKE ?');
  const insEdit = db.prepare(`INSERT INTO session_file_edits (session_id, memory_id, file_path, operation, turn_uuid, context_snippet, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insEvt = db.prepare('INSERT INTO events (entity_id, kind, payload, occurred_at) VALUES (?, ?, ?, ?)');

  const run = db.transaction((): SessionImportResult => {
    const res: SessionImportResult = { inserted: 0, updated: 0, unchanged: 0, leftInPlace: 0, edits: 0 };

    const distilledTurns = new Set<string>();
    for (const r of selDistilledTurns.all(sidNeedle) as Array<{ source: string }>) {
      const u = parseObj(r.source)?.turn_uuid;
      if (u) distilledTurns.add(String(u));
    }

    // Index the stored rows by key. Rows whose source has no kind (written by a much older
    // version) get no key: they are never matched and never touched.
    const storedByKey = new Map<string, Stored>();
    const storedKey = keyer();
    const stored = selStored.all(sidNeedle) as Stored[];
    for (const r of stored) {
      const src = parseObj(r.source);
      if (!src?.kind || src.session_id !== sid) continue;
      const k = storedKey(String(src.kind), String(src.turn_uuid ?? ''), r.layer, r.content);
      if (!storedByKey.has(k)) storedByKey.set(k, r);
    }

    const freshKey = keyer();
    const matched = new Set<number>();
    const memContentToId = new Map<string, number>();
    const now = Math.floor(Date.now() / 1000);
    for (const m of input.memories) {
      if (m.source.turn_uuid && distilledTurns.has(m.source.turn_uuid)) continue; // distilled rewrite wins
      const k = freshKey(m.source.kind, m.source.turn_uuid ?? '', m.layer, m.content);
      const src = opts.sourceJson(m.source);
      const createdAt = m.occurred_at ?? now;
      const prev = storedByKey.get(k);
      if (prev && !matched.has(prev.id)) {
        matched.add(prev.id);
        const merged = mergeContent(prev.content, m.content);
        if (merged === prev.content) res.unchanged++;
        else { updMem.run(merged, m.importance, src, m.thread_id ?? null, createdAt, prev.id); res.updated++; }
        memContentToId.set(m.content, prev.id);
      } else {
        const r = insMem.run(opts.entityId, m.layer, m.content, m.importance, src, m.thread_id ?? null, createdAt);
        memContentToId.set(m.content, Number(r.lastInsertRowid));
        res.inserted++;
      }
    }
    res.leftInPlace = stored.length - matched.size;

    faultPoint('import-after-memories');

    // Derived link rows for this session: replaced (not memories).
    delEdits.run(sid);
    for (const fe of input.file_edits) {
      const memId = fe.memory_content ? memContentToId.get(fe.memory_content) ?? null : null;
      insEdit.run(fe.session_id, memId, fe.file_path, fe.operation, fe.turn_uuid ?? null, fe.context_snippet, fe.occurred_at);
      res.edits++;
    }
    delEvents.run(sidNeedle);
    insEvt.run(opts.entityId, 'session_imported', JSON.stringify({
      session_id: sid,
      memories: input.memories.length,
      file_edits: input.file_edits.length,
      stats: input.stats,
    }), opts.startedAt);
    return res;
  });
  // IMMEDIATE: take the write lock before reading the stored rows, so another writer cannot
  // change them between the read and the update.
  return run.immediate();
}
