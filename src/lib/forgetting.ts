// Ported from linksee-app/setup-learning-box.cjs:62-99 (Ebbinghaus forgetting curve).
// Implements Michie's memory principle 6: active forgetting.
// Protected memories (caveat layer) and goal layer bypass decay.

export interface ForgettingInput {
  daysSinceLastAccess: number;
  importance: number; // 0.0-1.0
  heatScore: number;  // 0-100
  protected: boolean;
  layer: string;
}

// Returns true if this memory should be forgotten (compressed to summary or deleted).
// Higher forgettingRisk → more likely to forget.
export function forgettingRisk(input: ForgettingInput): number {
  if (input.protected) return 0;
  if (input.layer === 'goal') return 0; // Goals are WHY-anchors, never auto-forget while active

  // Original formula from setup-learning-box.cjs:
  //   daysSinceContact * (heatScore/100) * (1 + daysSinceContact/30)
  // We INVERT: high heat = low risk (hot memories should be kept).
  const heatFactor = 1 - (input.heatScore / 100); // 0.0 = keep, 1.0 = drop
  const importanceFactor = 1 - input.importance;
  const timeFactor = input.daysSinceLastAccess * (1 + input.daysSinceLastAccess / 30);

  return heatFactor * importanceFactor * timeFactor;
}

// Risk threshold above which memory is compressed (→ learning layer summary) and the original deleted.
export const COMPRESS_THRESHOLD = 50;

// Risk threshold above which memory is entirely dropped.
export const DROP_THRESHOLD = 200;

export type ForgettingAction = 'keep' | 'compress' | 'drop';

export function decideForgetting(input: ForgettingInput): ForgettingAction {
  const risk = forgettingRisk(input);
  if (risk >= DROP_THRESHOLD) return 'drop';
  if (risk >= COMPRESS_THRESHOLD) return 'compress';
  return 'keep';
}
