// session-import — write one extracted Claude Code session into the DB, APPEND-ONLY
// (0.18.1, Codex reviews 1–2 of #23).
//
// Up to 0.18.0 every re-import (the Stop hook runs one per turn) DELETEd the session's
// undistilled memory rows, its session_file_edits and every event mentioning it, and inserted
// them again — the memory DELETE outside the insert transaction. A failed insert lost the rows;
// a successful one renumbered them; deleting session_file_edits cascaded (ON DELETE CASCADE)
// into drift_edges and erased the user's dismiss/ack verdicts.
//
// The first 0.18.1 draft UPDATEd rows in place by a stable key. Review 2 showed that this
// overwrote what a user had corrected with remember({ memory_id, content }) (the fresh
// extraction won on same-named fields), and that replacing session_file_edits still dropped
// drift verdicts. So, by design decision: a re-import only ADDS.
//
//   memories            key = source.kind | turn_uuid | layer | file path (file_edit rows, from
//                       content.affects[0]) or the ordinal among same kind/turn/layer rows.
//                       A key the DB already has → the row is not touched (no UPDATE, no
//                       DELETE). A new key → INSERT.
//   session_file_edits  key = turn_uuid | file_path | operation | occurred_at | ordinal.
//                       Same rule: existing rows (and the drift_edges that point at them) are
//                       not touched; new ones are INSERTed.
//   events              one `session_imported` row per session; its payload (counts) is
//                       updated in place, or the row is inserted. Other events are not touched.
//
// Accepted cost (CHANGELOG, known limits): an improved extraction does not reach rows already
// imported — e.g. a file_edit row keeps the op count of the turn it was first imported in.
// Distilled rewrites still suppress the raw turn. Everything is one BEGIN IMMEDIATE transaction.

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
  /** Extracted memories whose key the DB already had: left exactly as they are. */
  kept: number;
  /** Stored undistilled rows whose key the new extraction did not produce. Left in place. */
  leftInPlace: number;
  edits: number;
  editsKept: number;
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

function memKeyer() {
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

function editKeyer() {
  const ordinals = new Map<string, number>();
  return (turn: string | null, path: string, op: string, at: number): string => {
    const base = `${turn ?? ''}|${path}|${op}|${at}`;
    const n = ordinals.get(base) ?? 0;
    ordinals.set(base, n + 1);
    return `${base}|#${n}`;
  };
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
  const selEdits = db.prepare('SELECT turn_uuid, file_path, operation, occurred_at FROM session_file_edits WHERE session_id = ? ORDER BY id');
  const insMem = db.prepare('INSERT INTO memories (entity_id, layer, content, importance, source, thread_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insEdit = db.prepare(`INSERT INTO session_file_edits (session_id, memory_id, file_path, operation, turn_uuid, context_snippet, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const selEvt = db.prepare(`SELECT id FROM events WHERE kind = 'session_imported' AND json_valid(payload) AND json_extract(payload, '$.session_id') = ? ORDER BY id LIMIT 1`);
  const updEvt = db.prepare('UPDATE events SET payload = ? WHERE id = ?');
  const insEvt = db.prepare('INSERT INTO events (entity_id, kind, payload, occurred_at) VALUES (?, ?, ?, ?)');

  const run = db.transaction((): SessionImportResult => {
    const res: SessionImportResult = { inserted: 0, kept: 0, leftInPlace: 0, edits: 0, editsKept: 0 };

    const distilledTurns = new Set<string>();
    for (const r of selDistilledTurns.all(sidNeedle) as Array<{ source: string }>) {
      const u = parseObj(r.source)?.turn_uuid;
      if (u) distilledTurns.add(String(u));
    }

    // Keys of the stored rows. Rows whose source has no kind (a much older version) get no key:
    // they are never matched and never touched. The key is computed from the stored row as it
    // is now (a user edit of `affects` changes it; the extraction is then inserted once more,
    // the edited row is still not touched).
    const storedByKey = new Map<string, Stored>();
    const storedKey = memKeyer();
    const stored = selStored.all(sidNeedle) as Stored[];
    for (const r of stored) {
      const src = parseObj(r.source);
      if (!src?.kind || src.session_id !== sid) continue;
      const k = storedKey(String(src.kind), String(src.turn_uuid ?? ''), r.layer, r.content);
      if (!storedByKey.has(k)) storedByKey.set(k, r);
    }

    const freshKey = memKeyer();
    const matched = new Set<number>();
    const memContentToId = new Map<string, number>();
    const now = Math.floor(Date.now() / 1000);
    for (const m of input.memories) {
      if (m.source.turn_uuid && distilledTurns.has(m.source.turn_uuid)) continue; // distilled rewrite wins
      const k = freshKey(m.source.kind, m.source.turn_uuid ?? '', m.layer, m.content);
      const prev = storedByKey.get(k);
      if (prev && !matched.has(prev.id)) {
        matched.add(prev.id); // already imported: not touched
        memContentToId.set(m.content, prev.id);
        res.kept++;
        continue;
      }
      const r = insMem.run(opts.entityId, m.layer, m.content, m.importance, opts.sourceJson(m.source), m.thread_id ?? null, m.occurred_at ?? now);
      memContentToId.set(m.content, Number(r.lastInsertRowid));
      res.inserted++;
    }
    res.leftInPlace = stored.length - matched.size;

    faultPoint('import-after-memories');

    // session_file_edits: existing rows (and the drift_edges pointing at them) are not touched.
    const haveEdits = new Set<string>();
    const storedEditKey = editKeyer();
    for (const e of selEdits.all(sid) as Array<{ turn_uuid: string | null; file_path: string; operation: string; occurred_at: number }>) {
      haveEdits.add(storedEditKey(e.turn_uuid, e.file_path, e.operation, e.occurred_at));
    }
    const freshEditKey = editKeyer();
    for (const fe of input.file_edits) {
      const k = freshEditKey(fe.turn_uuid ?? null, fe.file_path, fe.operation, fe.occurred_at);
      if (haveEdits.has(k)) { res.editsKept++; continue; }
      const memId = fe.memory_content ? memContentToId.get(fe.memory_content) ?? null : null;
      insEdit.run(fe.session_id, memId, fe.file_path, fe.operation, fe.turn_uuid ?? null, fe.context_snippet, fe.occurred_at);
      res.edits++;
    }

    // One session_imported event per session, kept current. No other event is touched.
    const payload = JSON.stringify({
      session_id: sid,
      memories: input.memories.length,
      file_edits: input.file_edits.length,
      stats: input.stats,
    });
    const evt = selEvt.get(sid) as { id: number } | undefined;
    if (evt) updEvt.run(payload, evt.id);
    else insEvt.run(opts.entityId, 'session_imported', payload, opts.startedAt);
    faultPoint('import-after-edits');
    return res;
  });
  // IMMEDIATE: take the write lock before reading the stored keys, so another writer cannot
  // add the same rows between the read and the insert.
  return run.immediate();
}
