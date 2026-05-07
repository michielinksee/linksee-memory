// Sampling block — server requests text generation from the client's LLM.
//
// MCP semantics: server.request({method: 'sampling/createMessage', params: {messages, ...}})
// Used by:
//   - LLM-assisted consolidate (auto-summarize a memory cluster into a learning entry)
//   - LLM-assisted layer classification (when the agent uses a vague layer alias)
//
// The client may decline (no LLM access, user opted out). All sampling calls are best-effort
// with a graceful fallback to non-LLM behavior.

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CreateMessageRequestSchema } from '@modelcontextprotocol/sdk/types.js';

interface SampleParams {
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

interface SampleResult {
  ok: boolean;
  text?: string;
  reason?: string;
}

export async function sample(server: Server, p: SampleParams): Promise<SampleResult> {
  try {
    const params: any = {
      messages: [{ role: 'user', content: { type: 'text', text: p.userPrompt } }],
      maxTokens: p.maxTokens ?? 800,
      temperature: p.temperature ?? 0.3,
      modelPreferences: {
        // Prefer fast, cheap, good-enough for summarization.
        speedPriority: 0.7,
        costPriority: 0.7,
        intelligencePriority: 0.4,
      },
      includeContext: 'none',
    };
    if (p.systemPrompt) params.systemPrompt = p.systemPrompt;

    const res: any = await (server as any).request({ method: 'sampling/createMessage', params }, CreateMessageRequestSchema);
    const text = res?.content?.text ?? res?.content?.[0]?.text ?? '';
    if (!text) return { ok: false, reason: 'empty response from sampling' };
    return { ok: true, text };
  } catch (err: any) {
    return { ok: false, reason: err?.message ?? String(err) };
  }
}

export async function sampleConsolidation(server: Server, memoryTexts: string[], entityName: string): Promise<SampleResult> {
  if (memoryTexts.length === 0) return { ok: false, reason: 'no input memories' };
  const numbered = memoryTexts.map((t, i) => `[${i + 1}] ${t}`).join('\n\n');
  const userPrompt = `Consolidate these ${memoryTexts.length} memories about "${entityName}" into a single learning-layer summary. The summary must:
- Preserve the trajectory (what was attempted, what worked, what changed)
- Be 2-4 sentences max
- Not invent facts not in the originals
- Not include verbatim quotes

Memories:
${numbered}

Output the summary text only — no preamble, no JSON wrapper.`;
  return sample(server, {
    systemPrompt: 'You are a memory consolidator. Compress without distorting.',
    userPrompt,
    maxTokens: 400,
    temperature: 0.2,
  });
}

export async function sampleLayerClassification(server: Server, content: string): Promise<SampleResult> {
  const userPrompt = `Classify this memory content into exactly one layer:
- goal: WHY this work exists, target outcome
- context: WHY THIS NOW, situation, timing
- emotion: USER tone, feelings expressed
- implementation: HOW it was done, what worked, what failed
- caveat: PAIN lesson, "never X" / "always Y"
- learning: GROWTH, decisions made, insights

Content:
${content}

Output just the layer name — no explanation, no JSON.`;
  return sample(server, {
    systemPrompt: 'You are a layer classifier. Output one word.',
    userPrompt,
    maxTokens: 16,
    temperature: 0,
  });
}
