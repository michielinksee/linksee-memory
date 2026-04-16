// read_smart handler: the flagship token-saving feature.
// Returns full content on first read, "unchanged" metadata on re-read (~50 tokens),
// or only the changed chunks + unchanged summary on real modifications.

import { readFileSync, statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { chunkFile, hashFile, type Chunk } from '../lib/file-chunker.js';

interface SnapshotRow {
  path: string;
  content_hash: string;
  mtime: number;
  size_bytes: number;
  chunks: string;
  last_read_at: number;
  read_count: number;
}

interface StoredChunkMeta {
  id: string;
  kind: string;
  start_line: number;
  end_line: number;
  hash: string;
}

// Rough estimate: 1 token ≈ 4 chars for English+code, closer to 2-3 for JP.
// Use 0.3 as a blended average.
const TOKENS_PER_CHAR = 0.3;
function estimateTokens(content: string): number {
  return Math.ceil(content.length * TOKENS_PER_CHAR);
}

function toMeta(c: Chunk): StoredChunkMeta {
  return { id: c.id, kind: c.kind, start_line: c.start_line, end_line: c.end_line, hash: c.hash };
}

export function handleReadSmart(
  db: Database.Database,
  args: { path: string; force?: boolean }
): string {
  const { path, force = false } = args;

  let stat;
  try {
    stat = statSync(path);
  } catch (e: any) {
    return JSON.stringify({ ok: false, error: `File not found: ${path}` });
  }

  const mtime = Math.floor(stat.mtimeMs / 1000);
  const size = stat.size;

  const prior = db.prepare('SELECT * FROM file_snapshots WHERE path = ?').get(path) as SnapshotRow | undefined;

  // --- CASE A: first read or force ---
  if (!prior || force) {
    const content = readFileSync(path, 'utf8');
    const fileHash = hashFile(content);
    const chunks = chunkFile(path, content);
    const chunkMeta = chunks.map(toMeta);

    db.prepare(
      `INSERT INTO file_snapshots (path, content_hash, mtime, size_bytes, chunks, last_read_at, read_count)
       VALUES (?, ?, ?, ?, ?, unixepoch(), 1)
       ON CONFLICT(path) DO UPDATE SET
         content_hash = excluded.content_hash,
         mtime = excluded.mtime,
         size_bytes = excluded.size_bytes,
         chunks = excluded.chunks,
         last_read_at = unixepoch(),
         read_count = read_count + 1`
    ).run(path, fileHash, mtime, size, JSON.stringify(chunkMeta));

    return JSON.stringify({
      ok: true,
      status: force ? 'forced_full' : 'first_read',
      path,
      content,
      chunks: chunkMeta,
      bytes: size,
      tokens_approx: estimateTokens(content),
      tokens_saved: 0,
    });
  }

  // --- CASE B: mtime unchanged → content guaranteed unchanged (fast path) ---
  if (prior.mtime === mtime) {
    db.prepare('UPDATE file_snapshots SET last_read_at = unixepoch(), read_count = read_count + 1 WHERE path = ?').run(path);

    const storedChunks = JSON.parse(prior.chunks) as StoredChunkMeta[];
    const factRows = db.prepare('SELECT fact, layer, chunk_hash FROM file_facts WHERE file_path = ?').all(path);

    // Token savings = what a full read would have cost
    const savedTokens = Math.round(size * TOKENS_PER_CHAR);

    return JSON.stringify({
      ok: true,
      status: 'unchanged',
      path,
      last_read_at: new Date(prior.last_read_at * 1000).toISOString(),
      chunk_count: storedChunks.length,
      chunks: storedChunks,
      file_facts: factRows,
      tokens_saved: savedTokens,
      note: 'File unchanged since last read. Call with force:true if full content is needed.',
    });
  }

  // --- CASE C: mtime changed → compute hash, maybe false alarm ---
  const content = readFileSync(path, 'utf8');
  const fileHash = hashFile(content);

  if (fileHash === prior.content_hash) {
    db.prepare('UPDATE file_snapshots SET mtime = ?, last_read_at = unixepoch(), read_count = read_count + 1 WHERE path = ?').run(mtime, path);
    return JSON.stringify({
      ok: true,
      status: 'unchanged_content',
      path,
      note: 'mtime changed but sha256 identical (file was touched but not modified).',
      tokens_saved: Math.round(size * TOKENS_PER_CHAR),
    });
  }

  // --- CASE D: real diff ---
  const newChunks = chunkFile(path, content);
  const oldChunks = JSON.parse(prior.chunks) as StoredChunkMeta[];
  const oldById = new Map(oldChunks.map((c) => [c.id, c]));

  const changedChunks: Array<{ id: string; kind: string; status: 'added' | 'modified'; start_line: number; end_line: number; content: string }> = [];
  const unchangedChunks: StoredChunkMeta[] = [];
  const seenIds = new Set<string>();

  for (const c of newChunks) {
    seenIds.add(c.id);
    const prev = oldById.get(c.id);
    if (!prev) {
      changedChunks.push({ id: c.id, kind: c.kind, status: 'added', start_line: c.start_line, end_line: c.end_line, content: c.content });
    } else if (prev.hash !== c.hash) {
      changedChunks.push({ id: c.id, kind: c.kind, status: 'modified', start_line: c.start_line, end_line: c.end_line, content: c.content });
    } else {
      unchangedChunks.push({ id: c.id, kind: c.kind, start_line: c.start_line, end_line: c.end_line, hash: c.hash });
    }
  }

  const removedChunks = oldChunks
    .filter((c) => !seenIds.has(c.id))
    .map((c) => ({ id: c.id, kind: c.kind, prev_lines: `${c.start_line}-${c.end_line}` }));

  const newChunkMeta = newChunks.map(toMeta);
  db.prepare(
    `UPDATE file_snapshots SET content_hash = ?, mtime = ?, size_bytes = ?, chunks = ?, last_read_at = unixepoch(), read_count = read_count + 1 WHERE path = ?`
  ).run(fileHash, mtime, size, JSON.stringify(newChunkMeta), path);

  const fullTokens = estimateTokens(content);
  const returnedTokens = changedChunks.reduce((s, c) => s + estimateTokens(c.content), 0) + 80; // ~80 for the envelope
  const savedTokens = Math.max(0, fullTokens - returnedTokens);
  const pctSaved = fullTokens > 0 ? Math.round((savedTokens / fullTokens) * 100) : 0;

  return JSON.stringify({
    ok: true,
    status: 'modified',
    path,
    changed_chunks: changedChunks,
    unchanged_chunks: unchangedChunks,
    removed_chunks: removedChunks,
    summary: {
      changed: changedChunks.length,
      unchanged: unchangedChunks.length,
      removed: removedChunks.length,
      tokens_full: fullTokens,
      tokens_returned: returnedTokens,
      tokens_saved: savedTokens,
      pct_saved: pctSaved,
    },
  });
}
