// Opt-in, privacy-preserving telemetry for linksee-memory.
//
// PRIVACY CONTRACT (also documented in README):
//   - DEFAULT OFF. Activated only when LINKSEE_TELEMETRY=basic.
//   - Sends only Level 1 fields: aggregated counts and signal distributions.
//   - NEVER sends conversation content, user messages, file content,
//     entity names, project paths, or any layer text (goal/context/emotion/
//     impl/caveat/learning content is not included).
//   - Anonymous UUID generated locally on first opt-in; stored at
//     ~/.linksee-memory/telemetry-id. User can delete it any time.
//   - Disable any time: LINKSEE_TELEMETRY=off (or unset the variable).

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, join as pathJoin, dirname as pathDirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const DEFAULT_ENDPOINT = 'https://kansei-link.com/api/telemetry/linksee';
// Allow override for testing or self-hosting
const ENDPOINT = process.env.LINKSEE_TELEMETRY_URL || DEFAULT_ENDPOINT;

const TELEMETRY_DIR = process.env.LINKSEE_MEMORY_DIR ?? join(homedir(), '.linksee-memory');
const TELEMETRY_ID_FILE = join(TELEMETRY_DIR, 'telemetry-id');

export type TelemetryMode = 'off' | 'basic';

export function getTelemetryMode(): TelemetryMode {
  const v = (process.env.LINKSEE_TELEMETRY || '').toLowerCase().trim();
  if (v === 'basic' || v === 'on' || v === '1' || v === 'true') return 'basic';
  return 'off';
}

export function getOrCreateAnonId(): string {
  try {
    if (existsSync(TELEMETRY_ID_FILE)) {
      const id = readFileSync(TELEMETRY_ID_FILE, 'utf8').trim();
      if (/^[A-Za-z0-9_-]{8,64}$/.test(id)) return id;
    }
  } catch { /* ignore */ }
  // Generate a fresh one
  const id = randomUUID();
  try {
    mkdirSync(TELEMETRY_DIR, { recursive: true });
    writeFileSync(TELEMETRY_ID_FILE, id);
  } catch { /* best-effort */ }
  return id;
}

// Read package version from our own package.json (best-effort, ESM-safe)
function getLinkseeVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    // dist/lib/telemetry.js → ../../package.json
    const pkgPath = pathJoin(pathDirname(pathDirname(pathDirname(here))), 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      return String(pkg.version || 'unknown');
    }
  } catch { /* ignore */ }
  return 'unknown';
}

interface TelemetryPayload {
  anon_id: string;
  linksee_version: string;
  session_turn_count: number;
  session_duration_sec: number;
  file_ops_edit: number;
  file_ops_write: number;
  file_ops_read: number;
  errors_count: number;
  mcp_servers: string[];
  file_extensions: Record<string, number>;
  read_smart_savings_pct: number | null;
  read_smart_calls: number;
  recall_calls: number;
  recall_file_calls: number;
}

// Build a payload from a single just-imported session.
// All inputs come from session_file_edits + events; nothing reads memories.content.
export function buildPayload(
  db: Database.Database,
  sessionId: string,
  options: { mcpServersInUse?: string[] } = {}
): TelemetryPayload | null {
  const eventRow = db.prepare(`SELECT payload, occurred_at FROM events WHERE kind = 'session_imported' AND payload LIKE ? ORDER BY id DESC LIMIT 1`).get(`%"session_id":"${sessionId}"%`) as { payload: string; occurred_at: number } | undefined;

  // Aggregate file ops
  const opsRows = db.prepare(`SELECT operation, COUNT(*) as c FROM session_file_edits WHERE session_id = ? GROUP BY operation`).all(sessionId) as Array<{ operation: string; c: number }>;
  const opCounts: Record<string, number> = { edit: 0, write: 0, read: 0 };
  for (const r of opsRows) opCounts[r.operation] = (opCounts[r.operation] || 0) + r.c;

  // File extension distribution (anonymized — just extensions, never paths/names)
  const extRows = db.prepare(`SELECT file_path FROM session_file_edits WHERE session_id = ?`).all(sessionId) as Array<{ file_path: string }>;
  const extCounts: Record<string, number> = {};
  for (const r of extRows) {
    const ext = (extname(r.file_path) || '(none)').toLowerCase().slice(0, 12);
    extCounts[ext] = (extCounts[ext] || 0) + 1;
  }
  // Convert to percent distribution, drop low-count extensions to save space
  const total = extRows.length || 1;
  const extPct: Record<string, number> = {};
  for (const [ext, count] of Object.entries(extCounts)) {
    const pct = Math.round((count / total) * 100);
    if (pct >= 1) extPct[ext] = pct;
  }

  // Pull session metadata from the recorded event
  let stats: any = {};
  let durationSec = 0;
  if (eventRow) {
    try { stats = JSON.parse(eventRow.payload).stats || {}; } catch {}
  }
  const turnsTotal = stats.turns_total || 0;
  // session start/end approximation
  const tsRow = db.prepare(`SELECT MIN(occurred_at) as start, MAX(occurred_at) as end FROM session_file_edits WHERE session_id = ?`).get(sessionId) as { start: number; end: number };
  if (tsRow && tsRow.start && tsRow.end) durationSec = Math.max(0, tsRow.end - tsRow.start);

  return {
    anon_id: getOrCreateAnonId(),
    linksee_version: getLinkseeVersion(),
    session_turn_count: turnsTotal,
    session_duration_sec: durationSec,
    file_ops_edit: opCounts.edit || 0,
    file_ops_write: opCounts.write || 0,
    file_ops_read: opCounts.read || 0,
    errors_count: 0, // session_extractor doesn't surface this currently; safe default
    mcp_servers: (options.mcpServersInUse || []).slice(0, 50),
    file_extensions: extPct,
    read_smart_savings_pct: null, // wired up later when we track this per session
    read_smart_calls: 0,
    recall_calls: 0,
    recall_file_calls: 0,
  };
}

// Fire-and-forget POST. Any failure is silent (logged by caller).
export async function sendTelemetry(payload: TelemetryPayload, opts: { timeoutMs?: number } = {}): Promise<{ ok: boolean; error?: string }> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': `linksee-memory/${payload.linksee_version}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      return { ok: false, error: `http_${res.status}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.name || e?.message || e).slice(0, 100) };
  }
}

// Convenience: helper for caller to know if it should bother building a payload
export function isTelemetryEnabled(): boolean {
  return getTelemetryMode() !== 'off';
}
