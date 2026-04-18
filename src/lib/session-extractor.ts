// Extract 6-layer memories + file_edit links from a parsed session.
// Core mission: break the Mem0 "flat metatag" wall by attaching each memory
// to its intent context. A memory like "edited server.ts" becomes
// "edited server.ts BECAUSE the user wanted the FTS5 + LIKE merge fix".

import type { ParsedSession, SessionTurn } from './session-parser.js';
import { isMetaOrNoise, isAutomatedSession, isPastedExternalContent } from './session-parser.js';

export interface ExtractedMemory {
  layer: 'goal' | 'context' | 'emotion' | 'implementation' | 'caveat' | 'learning';
  content: string;                    // will be stored as JSON or plain text
  importance: number;                 // 0-1
  source: {
    session_id: string;
    turn_uuid?: string;
    kind: string;                     // 'first_intent' | 'file_edit' | 'error_recovery' | 'decision' | 'session_summary'
  };
}

export interface ExtractedFileEdit {
  session_id: string;
  file_path: string;
  operation: 'read' | 'edit' | 'write' | 'bash' | 'other';
  turn_uuid?: string;
  occurred_at: number;
  context_snippet: string;            // THE anti-Mem0-wall field
  memory_content?: string;            // used to pair with the memory inserted for this edit
}

export interface ExtractionResult {
  project_name: string;
  project_cwd: string;
  session_id: string;
  memories: ExtractedMemory[];
  file_edits: ExtractedFileEdit[];
  stats: {
    turns_total: number;
    turns_meaningful_user: number;
    file_ops_raw: number;
    file_ops_unique_paths: number;
  };
}

// ============================================================
// Intent detection — first non-noise user message in the session.
// ============================================================
function findFirstIntent(session: ParsedSession): SessionTurn | null {
  for (const t of session.turns) {
    if (t.role !== 'user') continue;
    if (t.tool_results && t.tool_results.length > 0) continue; // tool result carriers, not intents
    if (isMetaOrNoise(t.text)) continue;
    if (t.text.trim().length < 20) continue;                    // "ok" / "yes" / "next"
    return t;
  }
  return null;
}

// ============================================================
// Decisions & learnings — user messages containing explicit commitment words.
// ============================================================
const DECISION_PATTERNS = [
  /決めた|採用|確定|これで(いい|進め)|OK進めて|やろう|行こう/,
  /learn(ed)?|decide|chose|picked|going with/i,
];
const FAILURE_PATTERNS = [
  /失敗|バグ|エラー|直して|修正|戻して/,
  /error|bug|fail|broken|revert|rollback/i,
];
// Caveats must be EXPLICIT warnings/prohibitions the user wants preserved.
// Previous bare patterns (/注意/ /やらない/ /避けて/) caught descriptive usage
// like「一般ユーザーはやらない」「Anthropicがやらない範囲」and turned
// opinions into protected caveats. Tightened to imperative/prohibitive forms
// only. Loses some recall, but precision matters more for the "never forget"
// layer.
// Imperative negations: `[ぁ-ん一-龯]ないで` reads as "don't do X" only when
// what follows is NOT part of a polite negation (「ないです」 = "it is not"),
// a probability form (「ないでしょう」), a request (「ないでほしい」), or a
// continuation (「ないでいる」). The negative lookahead `(?![すしいほ])`
// catches all four cases in one filter (す: です, し: しょう, い: いる/いない,
// ほ: ほしい). 「ないでください」 still passes because "く" is not excluded.
const CAVEAT_PATTERNS = [
  // `ダメだ(?!った|ろうと|と思)` excludes 過去形 (ダメだった = "it failed") and
  // speculation (ダメだろうと) which are descriptive, not prescriptive.
  // `ないで` only counts as imperative when it ends the clause. We accept:
  //   sentence terminators 。！!、 / particles ね・よ / whitespace / ください
  // Anything else (e.g. も = concessive「〜ないでも」, 止まる・いる・ほしい etc.)
  // is treated as descriptive and excluded.
  /気をつけて|注意して|[！!]注意[！!]|避けて(?!いる|いない)|[ぁ-ん一-龯]ないで(?=[。！!、\s]|ください|ね[^い]|よ[^う]|$)|やめて(?!おく|ほし)|禁止|ダメだ(?!った|ろうと|と思)|危険[だです]/,
  // English: require a concrete action after avoid/don't/never — a bare
  // "Avoiding rebuild of unchanged files" in a Vercel log is not a caveat.
  /\b(?:don'?t|do\s+not)\s+(?:do|use|run|call|forget|try|send|share|commit|push|paste|edit)\b|\bnever\s+(?:do|use|call|share|commit|paste|run|push|edit)\b|\bavoid\s+(?:using|running|calling|committing|pushing|sharing|pasting|editing|creating|modifying)\b|\bwatch\s+out\b/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

// Dedupe successive file edits to the same path within N seconds —
// they're usually the same logical change.
// NOTE: this only dedupes for memory CREATION (1 implementation memory per file
// per logical edit cluster). The session_file_edits table preserves ALL physical
// edits with their individual timestamps so cross-file/cross-session queries stay accurate.
function dedupeEdits(edits: ParsedSession['file_ops']): ParsedSession['file_ops'] {
  const WINDOW = 10; // sec — tighter so legitimate sequential edits are preserved
  const seen = new Map<string, number>(); // path → last timestamp kept
  const out: ParsedSession['file_ops'] = [];
  for (const e of edits) {
    const key = `${e.operation}::${e.path}`;
    const last = seen.get(key);
    if (last && Math.abs(e.timestamp - last) < WINDOW) continue;
    seen.set(key, e.timestamp);
    out.push(e);
  }
  return out;
}

export function extractSession(session: ParsedSession, projectName: string): ExtractionResult {
  const memories: ExtractedMemory[] = [];
  const file_edits: ExtractedFileEdit[] = [];

  // Detect fully-automated sessions (e.g. scheduled cron tasks) — no user intent to extract
  const firstRawUserText = session.turns.find((t) => t.role === 'user' && !t.tool_results)?.text ?? '';
  const automated = isAutomatedSession(firstRawUserText);

  // 1) Goal layer — the first REAL intent (or synthetic marker for automated sessions)
  const firstIntent = findFirstIntent(session);
  if (firstIntent) {
    memories.push({
      layer: 'goal',
      content: JSON.stringify({
        intent: firstIntent.text.slice(0, 1000),
        when: new Date(firstIntent.timestamp * 1000).toISOString(),
        session_id: session.session_id,
        git_branch: session.git_branch,
      }, null, 2),
      importance: automated ? 0.3 : 0.8,  // lower for automated runs
      source: { session_id: session.session_id, turn_uuid: firstIntent.uuid, kind: 'first_intent' },
    });
  } else if (automated) {
    // Synthetic goal so the session is still discoverable
    const match = firstRawUserText.match(/<scheduled-task\s+name="([^"]+)"/);
    const taskName = match ? match[1] : 'unknown';
    memories.push({
      layer: 'goal',
      content: JSON.stringify({
        intent: `Automated scheduled task run: ${taskName}`,
        automated: true,
        when: new Date(session.started_at * 1000).toISOString(),
        session_id: session.session_id,
        git_branch: session.git_branch,
      }, null, 2),
      importance: 0.2,
      source: { session_id: session.session_id, kind: 'automated_task' },
    });
  }

  // 2) Context layer — subsequent clarifying user messages (up to 3 more)
  let clarifyCount = 0;
  for (const t of session.turns) {
    if (clarifyCount >= 3) break;
    if (t === firstIntent) continue;
    if (t.role !== 'user') continue;
    if (t.tool_results && t.tool_results.length > 0) continue;
    if (isMetaOrNoise(t.text)) continue;
    if (t.text.trim().length < 40) continue;
    clarifyCount++;
    memories.push({
      layer: 'context',
      content: JSON.stringify({
        message: t.text.slice(0, 600),
        when: new Date(t.timestamp * 1000).toISOString(),
        session_id: session.session_id,
      }),
      importance: 0.5,
      source: { session_id: session.session_id, turn_uuid: t.uuid, kind: 'clarification' },
    });
  }

  // 3) Implementation layer + file_edits — one memory per unique file touched
  const uniqueOps = dedupeEdits(session.file_ops).filter((e) => e.operation === 'edit' || e.operation === 'write');
  const byPath = new Map<string, typeof uniqueOps>();
  for (const e of uniqueOps) {
    const arr = byPath.get(e.path) ?? [];
    arr.push(e);
    byPath.set(e.path, arr);
  }

  for (const [path, ops] of byPath) {
    const first = ops[0];
    const opsKinds = Array.from(new Set(ops.map((o) => o.operation))).join('+');
    const why = (first.preceding_user_text || '(no explicit preceding intent)').slice(0, 400);
    const contentSnippet = ops.map((o) => o.tool_input_preview).slice(0, 2).join(' | ').slice(0, 500);

    const memoryContent = JSON.stringify({
      file: path,
      ops: opsKinds,
      op_count: ops.length,
      why_extracted: why,
      sample_change: contentSnippet,
      when: new Date(first.timestamp * 1000).toISOString(),
      session_id: session.session_id,
    }, null, 2);

    memories.push({
      layer: 'implementation',
      content: memoryContent,
      importance: 0.6,
      source: { session_id: session.session_id, turn_uuid: first.turn_uuid, kind: 'file_edit' },
    });

    // Create a file_edit link record for EACH physical op (NOT deduped),
    // all pointing at this memory's content. This preserves the TRUE timeline
    // of edits (session_file_edits) while keeping memories at a useful granularity.
    const allOpsForPath = session.file_ops.filter((o) => o.path === path && (o.operation === 'edit' || o.operation === 'write'));
    for (const op of allOpsForPath) {
      file_edits.push({
        session_id: session.session_id,
        file_path: op.path,
        operation: op.operation,
        turn_uuid: op.turn_uuid,
        occurred_at: op.timestamp,
        context_snippet: (op.preceding_user_text || '').slice(0, 300),
        memory_content: memoryContent, // linker will resolve to memory_id after insert
      });
    }
  }

  // 4) Caveat layer — user messages matching caveat/failure patterns
  //    Stricter filter: must NOT be pasted external content.
  for (const t of session.turns) {
    if (t.role !== 'user' || isMetaOrNoise(t.text)) continue;
    if (t.tool_results && t.tool_results.length > 0) continue;
    if (isPastedExternalContent(t.text)) continue;
    if (matchesAny(t.text, CAVEAT_PATTERNS) && t.text.length > 20) {
      memories.push({
        layer: 'caveat',
        content: JSON.stringify({
          rule_or_warning: t.text.slice(0, 500),
          when: new Date(t.timestamp * 1000).toISOString(),
          session_id: session.session_id,
        }),
        importance: 0.75,
        source: { session_id: session.session_id, turn_uuid: t.uuid, kind: 'caveat' },
      });
    }
  }

  // 5) Learning layer — messages matching decision patterns
  //    Same strict filter applies.
  for (const t of session.turns) {
    if (t.role !== 'user' || isMetaOrNoise(t.text)) continue;
    if (t.tool_results && t.tool_results.length > 0) continue;
    if (isPastedExternalContent(t.text)) continue;
    if (matchesAny(t.text, DECISION_PATTERNS) && t.text.length > 15) {
      memories.push({
        layer: 'learning',
        content: JSON.stringify({
          decision: t.text.slice(0, 500),
          when: new Date(t.timestamp * 1000).toISOString(),
          session_id: session.session_id,
        }),
        importance: 0.7,
        source: { session_id: session.session_id, turn_uuid: t.uuid, kind: 'decision' },
      });
    }
  }

  // 6) Error-recovery patterns — only if NOT already covered by an extracted caveat,
  //    and skip the boilerplate wording. Now writes to 'context' layer (not caveat)
  //    so caveat stays reserved for genuine user-stated rules.
  if (session.errors_count > 3) {
    memories.push({
      layer: 'context',
      content: JSON.stringify({
        why_now: `This session had ${session.errors_count} tool errors across ${session.turns.length} turns.`,
        triggering_event: 'high_error_rate',
        when: new Date(session.started_at * 1000).toISOString(),
        session_id: session.session_id,
      }),
      importance: 0.4,
      source: { session_id: session.session_id, kind: 'error_recovery' },
    });
  }

  // 7) Session summary — one meta-implementation memory per session for overview
  if (memories.length > 0) {
    memories.push({
      layer: 'implementation',
      content: JSON.stringify({
        summary_kind: 'session_overview',
        session_id: session.session_id,
        started_at: new Date(session.started_at * 1000).toISOString(),
        ended_at: new Date(session.ended_at * 1000).toISOString(),
        duration_min: Math.round((session.ended_at - session.started_at) / 60),
        turns_user: session.turn_count_user,
        turns_assistant: session.turn_count_assistant,
        files_touched: byPath.size,
        errors: session.errors_count,
        git_branch: session.git_branch,
      }, null, 2),
      importance: 0.4,
      source: { session_id: session.session_id, kind: 'session_summary' },
    });
  }

  return {
    project_name: projectName,
    project_cwd: session.project_cwd,
    session_id: session.session_id,
    memories,
    file_edits,
    stats: {
      turns_total: session.turns.length,
      turns_meaningful_user: session.turns.filter((t) => t.role === 'user' && !isMetaOrNoise(t.text)).length,
      file_ops_raw: session.file_ops.length,
      file_ops_unique_paths: byPath.size,
    },
  };
}
