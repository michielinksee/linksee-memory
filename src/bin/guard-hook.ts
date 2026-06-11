#!/usr/bin/env node
// linksee-memory-guard — Claude Code hook adapter for the re-injection layer.
//
// Reads a hook event JSON from stdin and emits hook-control JSON to stdout:
//   • PreToolUse  (matcher Edit|Write|Bash) → gateAction → block (hard) / soft-inject (warn|inform)
//   • SessionStart (startup|resume|compact)  → buildBootDigest → additionalContext
//
// FAIL-OPEN by construction: any parse/DB/logic error → NO output, exit 0 → the tool/session proceeds
// unblocked. The ONLY thing that ever blocks is an explicit `gate_mode:'hard'` contradiction. This is
// intentional — a guard that breaks the user's workflow on its own bug is a footgun.
//
// Wire it (project or ~/.claude/settings.json), exec form so Windows .cmd shims are bypassed:
//   { "hooks": { "PreToolUse": [ { "matcher": "Edit|Write|Bash",
//       "hooks": [ { "type": "command", "command": "node",
//                    "args": ["${CLAUDE_PROJECT_DIR}/dist/bin/guard-hook.js"], "timeout": 8 } ] } ] } }

import { pathToFileURL } from 'node:url';
import { openDb, runMigrations } from '../db/migrate.js';
import { gateAction, buildBootDigest } from '../lib/guard.js';

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c) => chunks.push(c as Buffer));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj));
}

async function main(): Promise<void> {
  let ev: Record<string, any>;
  try {
    ev = JSON.parse(await readStdin());
  } catch {
    process.exit(0); // unparseable stdin → fail-open
  }
  if (!ev || typeof ev !== 'object') process.exit(0);

  let db;
  try {
    db = openDb();
    db.pragma('busy_timeout = 2000'); // MCP server may hold a write lock; wait briefly, else fail-open
    runMigrations(db); // ensures injection_log exists even when run standalone
  } catch {
    process.exit(0); // can't open DB → never block
  }

  try {
    if (ev.hook_event_name === 'PreToolUse') {
      const ti = (ev.tool_input ?? {}) as Record<string, any>;
      const r = gateAction(
        db,
        {
          tool: ev.tool_name,
          file_path: ti.file_path,
          command: ti.command,
          content: ti.content,
          diff: ti.new_string ?? ti.diff, // Edit passes new_string; some tools pass diff
        },
        { sessionId: ev.session_id }
      );

      if (r.gate === 'block') {
        emit({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: r.reinject,
          },
        });
      } else if (r.gate === 'warn' || r.gate === 'inform') {
        emit({
          hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: r.reinject },
        });
      }
      // 'allow' → emit nothing
    } else if (ev.hook_event_name === 'SessionStart') {
      const d = buildBootDigest(db);
      if (d.text) {
        emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: d.text } });
      }
    }
  } catch {
    /* fail-open: surface nothing rather than risk blocking on a guard bug */
  }

  try {
    db.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

const invoked = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) main();
