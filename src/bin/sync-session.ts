#!/usr/bin/env node
// Stop-hook entrypoint for Claude Code.
//
// Claude Code invokes this script when an assistant turn finishes (Stop event).
// It receives JSON on stdin like: { session_id, transcript_path, cwd, ... }
// We use transcript_path (the active jsonl) and feed it to the importer.
//
// CONTRACT:
//   - MUST exit 0 on success OR failure — never block Claude Code
//   - MUST be silent on stdout (Claude does not need feedback)
//   - All errors logged to ~/.linksee-memory/hook.log

import { spawnSync } from 'node:child_process';
import { mkdirSync, appendFileSync, existsSync, statSync, renameSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isTelemetryEnabled, buildPayload, sendTelemetry } from '../lib/telemetry.js';
import Database from 'better-sqlite3';

const LOG_DIR = process.env.LINKSEE_MEMORY_DIR ?? join(homedir(), '.linksee-memory');
const LOG_FILE = join(LOG_DIR, 'hook.log');
const LOG_MAX_BYTES = 1024 * 1024; // 1 MB → rotate

function log(msg: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    // Rotate if too big
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      try { renameSync(LOG_FILE, LOG_FILE + '.1'); } catch { /* ignore */ }
    }
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* never throw from log */ }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    // If no stdin within 500ms (e.g. invoked manually), give up — Stop hook always provides JSON
    setTimeout(() => resolve(data), 500);
  });
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  let payload: any = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) payload = JSON.parse(raw);
  } catch (e: any) {
    log(`stdin parse error: ${e?.message ?? e}`);
    process.exit(0);
  }

  const transcriptPath: string | undefined = payload.transcript_path;
  const sessionId: string | undefined = payload.session_id;
  const cwd: string | undefined = payload.cwd;
  const stopHookActive: boolean = !!payload.stop_hook_active;

  if (!transcriptPath) {
    log(`no transcript_path in payload (session=${sessionId ?? '?'}, keys=${Object.keys(payload).join(',')})`);
    process.exit(0);
  }
  if (stopHookActive) {
    // We're in a recursive Stop chain — do nothing
    log(`stop_hook_active=true, skipping (session=${sessionId})`);
    process.exit(0);
  }

  // Find the importer script — it lives next to us in dist/bin/
  const __filename = fileURLToPath(import.meta.url);
  const importerPath = join(dirname(__filename), 'import-sessions.js');

  if (!existsSync(transcriptPath)) {
    log(`transcript missing: ${transcriptPath}`);
    process.exit(0);
  }

  const r = spawnSync(process.execPath, [importerPath, '--session-file', transcriptPath], {
    encoding: 'utf8',
    timeout: 30000,
  });

  const elapsed = Date.now() - startedAt;
  if (r.error) {
    log(`importer spawn error (session=${sessionId}, ${elapsed}ms): ${r.error.message}`);
    process.exit(0);
  } else if (r.status !== 0) {
    log(`importer exited ${r.status} (session=${sessionId}, ${elapsed}ms): ${(r.stderr || '').slice(0, 500)}`);
    process.exit(0);
  }

  const out = (r.stdout || '').trim().split('\n').slice(-1)[0] || '';
  log(`ok (session=${sessionId}, cwd=${cwd}, ${elapsed}ms): ${out}`);

  // ── Opt-in telemetry (LINKSEE_TELEMETRY=basic) ──────────────────
  // Runs ONLY if explicitly enabled. Failures are silent. Never blocks Claude Code.
  if (isTelemetryEnabled() && sessionId) {
    try {
      // Detect MCP servers in use from BOTH ~/.claude.json and ~/.claude/settings.json
      // (Claude Code reads both — names only, never commands or arg paths.)
      const mcpServerSet = new Set<string>();
      for (const confPath of [join(homedir(), '.claude.json'), join(homedir(), '.claude', 'settings.json')]) {
        try {
          if (!existsSync(confPath)) continue;
          const parsed = JSON.parse(readFileSync(confPath, 'utf8'));
          if (parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers) {
            for (const name of Object.keys(parsed.mcpServers)) {
              mcpServerSet.add(String(name).slice(0, 64));
            }
          }
        } catch { /* ignore */ }
      }
      const mcpServers = Array.from(mcpServerSet);

      const dbDir = process.env.LINKSEE_MEMORY_DIR ?? join(homedir(), '.linksee-memory');
      const dbPath = join(dbDir, 'memory.db');
      if (existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true });
        try {
          const payload = buildPayload(db, sessionId, { mcpServersInUse: mcpServers });
          if (payload) {
            const result = await sendTelemetry(payload, { timeoutMs: 3000 });
            if (result.ok) log(`telemetry: sent (anon=${payload.anon_id.slice(0, 8)}, mcp=${mcpServers.length}, exts=${Object.keys(payload.file_extensions).length})`);
            else log(`telemetry: send failed: ${result.error}`);
          }
        } finally {
          db.close();
        }
      }
    } catch (e: any) {
      log(`telemetry: error (non-fatal): ${e?.message ?? e}`);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  log(`unhandled: ${e?.message ?? e}`);
  process.exit(0);
});
