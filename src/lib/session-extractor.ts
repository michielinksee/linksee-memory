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
  thread_id: string;                  // groups related memories (session_id for session-extracted)
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
// Structured Content v2 — 3-axis classification helpers
// ============================================================

type Altitude = 'mission' | 'strategy' | 'architecture' | 'implementation';
type MemType = 'question' | 'comparison' | 'decision' | 'work' | 'outcome' | 'learning' | 'note';
type MemState = 'open' | 'decided' | 'in_progress' | 'done' | 'stalled' | 'parked' | 'superseded';

const ALTITUDE_PATTERNS: [RegExp, Altitude][] = [
  [/mission|ミッション|ビジョン|vision|product\s+direction|事業方針/i, 'mission'],
  [/strategy|戦略|方針|positioning|GTM|go.to.market|revenue|pricing|ICP|ターゲット|マーケ/i, 'strategy'],
  [/architect|設計|schema|database|DB設計|migration|API\s+design|system\s+design|layer\s+model|アーキテクチャ/i, 'architecture'],
];

export function inferAltitude(text: string): Altitude {
  for (const [pattern, altitude] of ALTITUDE_PATTERNS) {
    if (pattern.test(text)) return altitude;
  }
  return 'implementation';
}

// ---- Type inference ----
// Infers the cognitive TYPE of a memory from its content text.
// Falls back to layer-based defaults when no pattern matches.
const TYPE_PATTERNS: [RegExp, MemType][] = [
  [/\?|質問|教えて|どう[すし]|how\s+(to|do|should)|what\s+(is|are|should)|why\s+(is|do|does)|can\s+(i|we|you)/i, 'question'],
  [/比較|対|vs\.?|versus|compared?\s+to|より|方がいい|alternative|option[s]?\b|どっちが/i, 'comparison'],
  [/決め[たる]|採用|確定|approve|これでい[いく]|進めて|go\s+with|decided|chosen|settled|commit\s+to/i, 'decision'],
  [/学び|教訓|分かった|判明|発見|learn|realize|discover|find\s+out|turns?\s+out|takeaway|insight/i, 'learning'],
  [/結果|完了|成功|失敗|outcome|result|shipped|deployed|launched|finished|accomplished/i, 'outcome'],
];

export function inferType(text: string, layer: string): MemType {
  for (const [pattern, type] of TYPE_PATTERNS) {
    if (pattern.test(text)) return type;
  }
  // Layer-based defaults when no pattern matches
  if (layer === 'learning') return 'decision';
  if (layer === 'caveat') return 'learning';
  if (layer === 'implementation') return 'work';
  if (layer === 'context') return 'note';
  if (layer === 'goal') return 'work';
  return 'note';
}

// ---- State inference ----
// Infers the lifecycle STATE of a memory from its content text.
const STATE_PATTERNS: [RegExp, MemState][] = [
  [/完了|done|finished|shipped|deployed|resolved|solved|merged|closed/i, 'done'],
  [/決定|decided|settled|approved|confirmed|go\s+with/i, 'decided'],
  [/進行中|working\s+on|implementing|in\s+progress|WIP|作業中|対応中/i, 'in_progress'],
  [/保留|pending|on\s+hold|棚上げ|後で|later|一旦(?:置|おい)|いったん/i, 'parked'],
  [/止まって|stuck|blocked|stalled|ハマ[っり]|行き詰/i, 'stalled'],
  [/取り替え|代わりに|置き換え|replaced|superseded|deprecated|obsolete|旧版|old\s+approach/i, 'superseded'],
];

export function inferState(text: string, layer: string): MemState {
  for (const [pattern, state] of STATE_PATTERNS) {
    if (pattern.test(text)) return state;
  }
  // Layer-based defaults
  if (layer === 'goal') return 'in_progress';
  if (layer === 'learning') return 'decided';
  if (layer === 'caveat') return 'done';
  if (layer === 'implementation') return 'done';
  return 'open';
}

/** Extract a concise title from raw text (first sentence or up to maxLen chars) */
function makeTitle(text: string, maxLen = 80): string {
  const cleaned = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  const firstSentence = cleaned.split(/[。！？!?\n]/)[0].trim();
  if (firstSentence.length <= maxLen) return firstSentence;
  return firstSentence.slice(0, maxLen - 3) + '...';
}

/** Extract file paths from surrounding context */
function extractAffectedPaths(ops: Array<{path: string}>): string[] {
  const unique = new Set(ops.map((o) => o.path));
  return Array.from(unique).slice(0, 10);
}

interface StructuredContent {
  title: string;
  altitude: Altitude;
  type: MemType;
  state: MemState;
  what: string;
  why?: string;
  affects?: string[];
  next_action?: string | null;
  evidence_refs?: Array<{type: string; id: string; label?: string}>;
  [key: string]: unknown;
}

function buildStructuredContent(opts: StructuredContent): string {
  const obj: Record<string, unknown> = {
    title: opts.title,
    altitude: opts.altitude,
    type: opts.type,
    state: opts.state,
    what: opts.what,
  };
  if (opts.why) obj.why = opts.why;
  if (opts.affects && opts.affects.length > 0) obj.affects = opts.affects;
  if (opts.next_action !== undefined) obj.next_action = opts.next_action;
  if (opts.evidence_refs && opts.evidence_refs.length > 0) obj.evidence_refs = opts.evidence_refs;
  // Merge any extra fields (session_id, git_branch, etc.)
  for (const [k, v] of Object.entries(opts)) {
    if (!(k in obj) && v !== undefined) obj[k] = v;
  }
  return JSON.stringify(obj, null, 2);
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
  /learn(ed)?|decid(?:e|ed|ing)|chose|picked|going with|let'?s\s+go|pivot(?:ing|ed)?|switch(?:ing)?\s+to|settled\s+on|approved|we'?ll\s+use|commit(?:ting)?\s+to/i,
];
const FAILURE_PATTERNS = [
  /失敗|バグ|エラー|直して|修正|戻して|うまくいかない|ハマった/,
  /error|bug|fail(?:ed|ing|ure)?|broken|broke|revert|rollback|doesn'?t\s+work|not\s+working|stuck|same\s+error\s+again|hit\s+(?:an?\s+|the\s+)?(?:error|bug|issue)|debug/i,
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
  // 心配し・気にし・遠慮し are reassurance ("don't worry / don't mind / don't hesitate")
  // — semantically opposite to a caveat. Lookbehind excludes them.
  /気をつけて|注意して|[！!]注意[！!]|避けて(?!いる|いない)|(?<!心配|気に|遠慮)[ぁ-ん一-龯]ないで(?=[。！!、\s]|ください|ね[^い]|よ[^う]|$)|やめて(?!おく|ほし)|禁止|ダメだ(?!った|ろうと|と思)|危険[だです]/,
  // English: require a concrete action after avoid/don't/never — a bare
  // "Avoiding rebuild of unchanged files" in a Vercel log is not a caveat.
  /\b(?:don'?t|do\s+not)\s+(?:do|use|run|call|forget|try|send|share|commit|push|paste|edit)\b|\bnever\s+(?:do|use|call|share|commit|paste|run|push|edit)\b|\bavoid\s+(?:using|running|calling|committing|pushing|sharing|pasting|editing|creating|modifying)\b|\bwatch\s+out\b/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * Check if a message is mostly chitchat with a decision keyword buried in it.
 * The サイダー problem: "おお！そうだね。書斎で無糖のサイダーでした。…決めた"
 * matches DECISION_PATTERNS because of "決めた" at the end, but the message
 * is primarily casual conversation, not a project decision.
 *
 * Heuristic: if the decision keyword appears ONLY in the last 30% of a long
 * message (>100 chars) AND the first 50 chars match chitchat patterns, skip it.
 */
const CHITCHAT_OPENERS = /^(?:おお|うん|そう(?:だね|だよね)|ありがと|はは|笑|www|OK|おー|へー|なるほど|ちなみに|そういえば|あー|えー|まぁ|まあ|ああ)/;

function isChitchatWithBuriedDecision(text: string, patterns: RegExp[]): boolean {
  if (text.length < 100) return false; // short messages are fine
  if (!CHITCHAT_OPENERS.test(text.trim())) return false; // doesn't open with chitchat

  // Check if any pattern matches in the first 40% of the text
  const earlyPortion = text.slice(0, Math.floor(text.length * 0.4));
  if (patterns.some((p) => p.test(earlyPortion))) return false; // decision is early = legitimate

  return true; // chitchat opening + decision keyword only appears late = noise
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
  // Turn-level dedup: a single user turn should yield at most ONE memory.
  // Priority: goal(first_intent) > caveat > decision > context. capturedTurns
  // tracks caveat-claimed turns so the decision pass skips them.
  const capturedTurns = new Set<string>();

  // Detect fully-automated sessions (e.g. scheduled cron tasks) — no user intent to extract
  const firstRawUserText = session.turns.find((t) => t.role === 'user' && !t.tool_results)?.text ?? '';
  const automated = isAutomatedSession(firstRawUserText);

  // 1) Goal layer — the first REAL intent (or synthetic marker for automated sessions)
  const firstIntent = findFirstIntent(session);
  if (firstIntent) {
    const intentText = firstIntent.text.slice(0, 1000);
    memories.push({
      layer: 'goal',
      content: buildStructuredContent({
        title: makeTitle(intentText),
        altitude: inferAltitude(intentText),
        type: inferType(intentText, 'goal'),
        state: inferState(intentText, 'goal'),
        what: intentText,
        why: 'Session intent — first user message',
        evidence_refs: [{ type: 'session', id: session.session_id, label: 'source session' }],
        session_id: session.session_id,
        git_branch: session.git_branch,
      }),
      importance: automated ? 0.3 : 0.8,
      thread_id: session.session_id,
      source: { session_id: session.session_id, turn_uuid: firstIntent.uuid, kind: 'first_intent' },
    });
  } else if (automated) {
    const match = firstRawUserText.match(/<scheduled-task\s+name="([^"]+)"/);
    const taskName = match ? match[1] : 'unknown';
    memories.push({
      layer: 'goal',
      content: buildStructuredContent({
        title: `Automated: ${taskName}`,
        altitude: 'implementation',
        type: 'work',
        state: 'in_progress',
        what: `Automated scheduled task run: ${taskName}`,
        why: 'Scheduled automation',
        session_id: session.session_id,
        git_branch: session.git_branch,
      }),
      importance: 0.2,
      thread_id: session.session_id,
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
    // Defer to the caveat/decision passes when they WOULD capture this turn,
    // so a clarification that is really a warning/decision isn't double-saved as context.
    const wouldBeCaveat = matchesAny(t.text, CAVEAT_PATTERNS) && t.text.length > 20 && !isChitchatWithBuriedDecision(t.text, CAVEAT_PATTERNS);
    const wouldBeDecision = matchesAny(t.text, DECISION_PATTERNS) && t.text.length > 15 && !isChitchatWithBuriedDecision(t.text, DECISION_PATTERNS);
    if (wouldBeCaveat || wouldBeDecision) continue;
    clarifyCount++;
    const msgText = t.text.slice(0, 600);
    memories.push({
      layer: 'context',
      content: buildStructuredContent({
        title: makeTitle(msgText, 60),
        altitude: inferAltitude(msgText),
        type: inferType(msgText, 'context'),
        state: inferState(msgText, 'context'),
        what: msgText,
        why: 'Clarification during session',
        evidence_refs: [{ type: 'session', id: session.session_id, label: 'source session' }],
        session_id: session.session_id,
      }),
      importance: 0.5,
      thread_id: session.session_id,
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
    const userIntent = (first.preceding_user_text || '').slice(0, 400);
    const contentSnippet = ops.map((o) => o.tool_input_preview).slice(0, 2).join(' | ').slice(0, 500);
    const fileName = path.replace(/\\/g, '/').split('/').pop() || path;

    const memoryContent = buildStructuredContent({
      title: `${opsKinds} ${fileName} (${ops.length} ops)`,
      altitude: 'implementation',
      type: 'work',
      state: 'done',
      what: userIntent || `File operation: ${opsKinds} on ${path}`,
      why: userIntent ? `User intent: ${makeTitle(userIntent, 120)}` : '(no explicit preceding intent)',
      affects: [path],
      next_action: null,
      evidence_refs: [{ type: 'session', id: session.session_id, label: 'source session' }],
      sample_change: contentSnippet,
      op_count: ops.length,
      session_id: session.session_id,
    });

    memories.push({
      layer: 'implementation',
      content: memoryContent,
      importance: 0.6,
      thread_id: session.session_id,
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
    if (t === firstIntent) continue; // already captured as the goal/first-intent memory
    if (t.tool_results && t.tool_results.length > 0) continue;
    if (isPastedExternalContent(t.text)) continue;
    if (matchesAny(t.text, CAVEAT_PATTERNS) && t.text.length > 20 && !isChitchatWithBuriedDecision(t.text, CAVEAT_PATTERNS)) {
      const caveatText = t.text.slice(0, 500);
      memories.push({
        layer: 'caveat',
        content: buildStructuredContent({
          title: makeTitle(caveatText, 70),
          altitude: inferAltitude(caveatText),
          type: inferType(caveatText, 'caveat'),
          state: inferState(caveatText, 'caveat'),
          what: caveatText,
          why: 'User-stated warning/prohibition — auto-extracted by caveat pattern match',
          affects: extractAffectedPaths(session.file_ops),
          next_action: null,
          evidence_refs: [{ type: 'session', id: session.session_id, label: 'caveat source' }],
          session_id: session.session_id,
        }),
        importance: 0.75,
        thread_id: session.session_id,
        source: { session_id: session.session_id, turn_uuid: t.uuid, kind: 'caveat' },
      });
      if (t.uuid) capturedTurns.add(t.uuid); // claim this turn so the decision pass skips it
    }
  }

  // 5) Learning layer — messages matching decision patterns
  //    Same strict filter applies.
  //    NOTE: Without LLM, we store the raw user text as `what` — this is the best
  //    heuristic extraction can do. Agent-initiated `remember()` calls should use
  //    the full structured format with agent_proposal + user_approval_scope.
  for (const t of session.turns) {
    if (t.role !== 'user' || isMetaOrNoise(t.text)) continue;
    if (t === firstIntent) continue; // already captured as the goal/first-intent memory
    if (t.uuid && capturedTurns.has(t.uuid)) continue; // already captured as a caveat
    if (t.tool_results && t.tool_results.length > 0) continue;
    if (isPastedExternalContent(t.text)) continue;
    if (matchesAny(t.text, DECISION_PATTERNS) && t.text.length > 15 && !isChitchatWithBuriedDecision(t.text, DECISION_PATTERNS)) {
      const decisionText = t.text.slice(0, 500);
      memories.push({
        layer: 'learning',
        content: buildStructuredContent({
          title: makeTitle(decisionText, 70),
          altitude: inferAltitude(decisionText),
          type: inferType(decisionText, 'learning'),
          state: inferState(decisionText, 'learning'),
          what: decisionText,
          why: 'Decision detected by pattern match — may need agent enrichment',
          affects: extractAffectedPaths(session.file_ops),
          next_action: null,
          evidence_refs: [{ type: 'session', id: session.session_id, label: 'decision source' }],
          session_id: session.session_id,
        }),
        importance: 0.7,
        thread_id: session.session_id,
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
      content: buildStructuredContent({
        title: `High error session (${session.errors_count} errors / ${session.turns.length} turns)`,
        altitude: 'implementation',
        type: 'outcome',
        state: 'done',
        what: `This session had ${session.errors_count} tool errors across ${session.turns.length} turns.`,
        why: 'High error rate may indicate environmental or configuration issues worth investigating',
        affects: extractAffectedPaths(session.file_ops),
        evidence_refs: [{ type: 'session', id: session.session_id, label: 'error session' }],
        session_id: session.session_id,
      }),
      importance: 0.4,
      thread_id: session.session_id,
      source: { session_id: session.session_id, kind: 'error_recovery' },
    });
  }

  // 7) Session summary — one meta-implementation memory per session for overview
  if (memories.length > 0) {
    const durationMin = Math.round((session.ended_at - session.started_at) / 60);
    const firstGoalTitle = firstIntent ? makeTitle(firstIntent.text, 60) : 'automated task';
    memories.push({
      layer: 'implementation',
      content: buildStructuredContent({
        title: `Session: ${firstGoalTitle} (${durationMin}min, ${byPath.size} files)`,
        altitude: 'implementation',
        type: 'outcome',
        state: 'done',
        what: `Session completed: ${durationMin} minutes, ${session.turn_count_user} user turns, ${byPath.size} files touched, ${session.errors_count} errors`,
        why: 'Session overview for timeline and activity tracking',
        affects: extractAffectedPaths(session.file_ops),
        next_action: null,
        evidence_refs: [{ type: 'session', id: session.session_id, label: 'session overview' }],
        summary_kind: 'session_overview',
        session_id: session.session_id,
        started_at: new Date(session.started_at * 1000).toISOString(),
        ended_at: new Date(session.ended_at * 1000).toISOString(),
        duration_min: durationMin,
        turns_user: session.turn_count_user,
        turns_assistant: session.turn_count_assistant,
        files_touched: byPath.size,
        errors: session.errors_count,
        git_branch: session.git_branch,
      }),
      importance: 0.4,
      thread_id: session.session_id,
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
