// Prompts block — reusable prompt templates that agents can pull from the server.
//
// Templates:
//   summarize-session       — turn a chat transcript into structured memories (1 per layer)
//   extract-caveats         — read text and produce caveat-layer entries (pain lessons)
//   weekly-consolidation    — sleep-mode summary of the past week's memories
//   recall-and-write        — recall first, then write — anti-pattern guard
//   entity-handoff          — produce a handoff doc for an entity (name + memories + next steps)
//
// Each prompt accepts arguments and returns a list of messages the client can feed to its LLM.

export const PROMPTS = [
  {
    name: 'summarize-session',
    description:
      'Turn a chat session transcript into structured memories. Produces up to 6 memories (one per layer) capturing goal/context/emotion/implementation/caveat/learning. Use at session end.',
    arguments: [
      { name: 'transcript', description: 'The session transcript text. Free-form.', required: true },
      { name: 'entity_hint', description: 'Optional canonical entity name to attach the memories to.', required: false },
    ],
  },
  {
    name: 'extract-caveats',
    description:
      'Scan a body of text (post-mortem, error log, decision doc) and propose caveat-layer memories — concise pain lessons starting with verbs ("Never", "Always", "Watch out"). Returns JSON list of caveats.',
    arguments: [
      { name: 'text', description: 'Source text (post-mortem, debug session, retro). Free-form.', required: true },
      { name: 'entity_hint', description: 'Optional canonical entity name for the caveats.', required: false },
    ],
  },
  {
    name: 'weekly-consolidation',
    description:
      'Sleep-mode summary of the past week\'s memories for an entity. Produces a single learning-layer entry that captures the trajectory. Use as input to the consolidate tool, or to write a Friday digest.',
    arguments: [
      { name: 'entity_name', description: 'The entity to consolidate.', required: true },
      { name: 'week_offset', description: 'Weeks-ago offset (0 = this week, 1 = last week). Default 0.', required: false },
    ],
  },
  {
    name: 'recall-and-write',
    description:
      'Anti-pattern guard. Before writing code, draft a doc, or making a decision: recall relevant memories first, then produce the answer with explicit citations to the recalled memory_ids. Forces "memory before action" discipline.',
    arguments: [
      { name: 'task', description: 'What you are about to do (code task, decision, doc draft). One sentence.', required: true },
      { name: 'entity_hint', description: 'Optional entity to focus recall on.', required: false },
    ],
  },
  {
    name: 'entity-handoff',
    description:
      'Produce a handoff document for an entity: name, kind, key memories per layer, current open questions, and next steps. Use when transferring context to a new session, a new agent, or a new collaborator.',
    arguments: [
      { name: 'entity_name', description: 'The entity to hand off.', required: true },
      { name: 'audience', description: 'Who receives the handoff (e.g. "new claude session", "human teammate"). Default "new claude session".', required: false },
    ],
  },
];

interface PromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

export function getPrompt(name: string, args: Record<string, string> | undefined): { description?: string; messages: PromptMessage[] } {
  const a = args ?? {};
  switch (name) {
    case 'summarize-session': {
      const transcript = a.transcript ?? '';
      const entityHint = a.entity_hint ? `\n\nFocus entity: ${a.entity_hint}` : '';
      return {
        description: 'Summarize the session into 6-layer structured memories.',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `You are an agent-memory writer. Read the session transcript below and propose memories to save. Output a JSON array; each item has {entity_name, entity_kind, layer, content, importance}.

Layers (use exactly one per memory):
- goal: WHY this work exists, target outcome
- context: WHY THIS NOW, situation, timing
- emotion: USER tone, feelings expressed
- implementation: HOW it was done, what worked, what failed
- caveat: PAIN lesson, "never X" / "always Y" — these are protected from forgetting
- learning: GROWTH, decisions made, insights

Rules:
- Max 6 entries (one per layer). Skip layers with nothing worth saving.
- Importance 0-1. Set 0.9+ to pin (use sparingly).
- Caveats must be 1 sentence and start with a verb.
- Quote nothing verbatim; summarize.

Transcript:
${transcript}${entityHint}`,
            },
          },
        ],
      };
    }

    case 'extract-caveats': {
      const text = a.text ?? '';
      const entityHint = a.entity_hint ? `\n\nFocus entity: ${a.entity_hint}` : '';
      return {
        description: 'Extract caveat-layer pain lessons.',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `You are a caveat extractor. Read the source text below and output a JSON list of caveats. Each caveat:
- Starts with a verb ("Never", "Always", "Watch out", "Reject", "Confirm")
- Is one sentence
- Is concrete (a specific failure mode, not abstract advice)
- Captures something the reader does NOT want to relearn the hard way

Output format: [{"content": "Never X when Y, because Z", "importance": 0.7-1.0}]

Source text:
${text}${entityHint}`,
            },
          },
        ],
      };
    }

    case 'weekly-consolidation': {
      const entityName = a.entity_name ?? '<entity>';
      const weekOffset = a.week_offset ?? '0';
      return {
        description: `Consolidate the last week of memories for ${entityName}.`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Consolidate the past week's memories for entity "${entityName}" (week_offset=${weekOffset}).

Step 1: Call recall(query="${entityName}", entity_name="${entityName}", max_tokens=4000) to retrieve recent memories.
Step 2: Read the returned memories and produce ONE learning-layer summary that captures:
  - What we set out to do (goal trajectory)
  - What actually happened (implementation summary)
  - What we learned (1-3 insights)
  - Any caveats we should never forget (preserve these — do NOT consolidate them away)

Step 3: Output a JSON object {entity_name, layer:"learning", content, importance:0.7}.

Do not write to memory directly — just return the JSON. The user will choose whether to save.`,
            },
          },
        ],
      };
    }

    case 'recall-and-write': {
      const task = a.task ?? '<task>';
      const entityHint = a.entity_hint ?? '';
      const recallCmd = entityHint
        ? `recall(query="${task}", entity_name="${entityHint}", max_tokens=2000)`
        : `recall(query="${task}", max_tokens=2000)`;
      return {
        description: 'Memory-before-action discipline.',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Before doing this task, recall first.

Task: ${task}

Step 1: Call ${recallCmd}.
Step 2: Skim the returned memories. Identify any caveats that apply.
Step 3: Produce your output with INLINE citations to relevant memory_ids: e.g. "Use better-sqlite3 v12+ [memory:1234] because v11 breaks on Node 24 [memory:5678]."
Step 4: If you found NO relevant memories, say so explicitly: "No prior memories on this — proceeding from first principles."

Goal: never solve a problem twice without checking.`,
            },
          },
        ],
      };
    }

    case 'entity-handoff': {
      const entityName = a.entity_name ?? '<entity>';
      const audience = a.audience ?? 'new claude session';
      return {
        description: `Produce a handoff document for ${entityName}.`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Produce a handoff document for entity "${entityName}", aimed at: ${audience}.

Step 1: Call recall(query="${entityName}", entity_name="${entityName}", max_tokens=6000).
Step 2: Skim memories grouped by layer.
Step 3: Output a markdown doc with these sections:
  - **Identity**: name, kind, canonical key (if any)
  - **Goal** (from goal-layer memories): what this entity is for
  - **State** (from latest implementation memories): where things stand right now
  - **Caveats** (from caveat-layer memories): what NEVER to do, with memory_id citations
  - **Open questions**: things the prior session left unresolved
  - **Suggested next steps**: 3 concrete actions for the audience

Keep it under 1 page. Cite memory_ids inline like [memory:1234].`,
            },
          },
        ],
      };
    }

    default:
      throw new Error(`unknown prompt: ${name}`);
  }
}
