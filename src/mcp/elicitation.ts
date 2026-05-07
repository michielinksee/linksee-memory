// Elicitation block — server asks the client (and ultimately the user) a structured question.
//
// MCP semantics: server.request({method: 'elicitation/create', params: {message, requestedSchema}})
// The user responds via the client UI. Used by:
//   - Stale-memory cleanup (forget candidates require confirmation)
//   - Pin/unpin confirmation when importance crosses 0.9
//
// Clients without elicitation support fail gracefully — caller falls back to "decline = skip".

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

interface ElicitResult {
  action: 'accept' | 'decline' | 'cancel' | 'unsupported';
  content?: Record<string, unknown>;
  reason?: string;
}

interface ElicitParams {
  message: string;
  requestedSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export async function elicit(server: Server, p: ElicitParams): Promise<ElicitResult> {
  try {
    const res: any = await (server as any).request({ method: 'elicitation/create', params: p }, ElicitRequestSchema);
    return {
      action: (res?.action as ElicitResult['action']) ?? 'decline',
      content: res?.content,
    };
  } catch (err: any) {
    return { action: 'unsupported', reason: err?.message ?? String(err) };
  }
}

export async function confirmForget(
  server: Server,
  candidate: { id: number; entity: string; layer: string; importance: number; preview: string }
): Promise<boolean> {
  const res = await elicit(server, {
    message: `Forget memory #${candidate.id} for "${candidate.entity}"?\n\nLayer: ${candidate.layer}  Importance: ${candidate.importance.toFixed(2)}\nPreview: ${candidate.preview.slice(0, 200)}`,
    requestedSchema: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          title: 'Forget this memory',
          description: 'Yes = delete permanently. No = keep.',
        },
      },
      required: ['confirm'],
    },
  });
  if (res.action === 'accept' && res.content && typeof res.content.confirm === 'boolean') {
    return res.content.confirm;
  }
  return false;
}

export async function confirmPin(
  server: Server,
  memoryId: number,
  preview: string,
  newImportance: number
): Promise<boolean> {
  const res = await elicit(server, {
    message: `Pin memory #${memoryId}? (importance ${newImportance.toFixed(2)})\n\nPreview: ${preview.slice(0, 200)}\n\nPinned memories survive forget-sweeps and consolidation.`,
    requestedSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', title: 'Pin this memory', description: 'Yes = pin. No = save without pinning.' },
      },
      required: ['confirm'],
    },
  });
  if (res.action === 'accept' && res.content && typeof res.content.confirm === 'boolean') {
    return res.content.confirm;
  }
  return false;
}
