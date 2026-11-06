// Ported from linksee-app/setup-learning-box.cjs:62-99 (Ebbinghaus forgetting curve).
// Implements Michie's memory principle 6: active forgetting.
// Protected memories (caveat layer) and goal layer bypass decay.

export interface ForgettingInput {
  daysSinceLastAccess: number;
  importance: number; // 0.0-1.0
  heatScore: number;  // 0-100
  protected: boolean;
  layer: string;
  altitude?: string;  // mission/strategy/architecture/implementation — higher altitude = slower decay
}

// Risk score for forgetting. Since 0.18.1 nothing in the server acts on 'drop' by deleting:
// consolidate marks clustered rows and only counts the rest (see consolidate.ts).
// Higher forgettingRisk → more likely to forget.
export function forgettingRisk(input: ForgettingInput): number {
  if (input.protected) return 0;
  if (input.layer === 'goal') return 0; // Goals are WHY-anchors, never auto-forget while active

  // Altitude-based decay: higher altitude memories decay much slower.
  // mission = permanent (why we exist), strategy = very slow, architecture = slow,
  // implementation = normal speed.
  if (input.altitude === 'mission') return 0;
  let altitudeMultiplier = 1.0;
  if (input.altitude === 'strategy') altitudeMultiplier = 0.1;
  else if (input.altitude === 'architecture') altitudeMultiplier = 0.3;

  // Original formula from setup-learning-box.cjs:
  //   daysSinceContact * (heatScore/100) * (1 + daysSinceContact/30)
  // We INVERT: high heat = low risk (hot memories should be kept).
  const heatFactor = 1 - (input.heatScore / 100); // 0.0 = keep, 1.0 = drop
  const importanceFactor = 1 - input.importance;
  const timeFactor = input.daysSinceLastAccess * (1 + input.daysSinceLastAccess / 30);

  return heatFactor * importanceFactor * timeFactor * altitudeMultiplier;
}

// Risk threshold above which memory is compressed (→ learning layer summary; the original is kept and marked).
export const COMPRESS_THRESHOLD = 50;

// Risk threshold that earlier versions used to delete a row outright. Reported only, since 0.18.1.
export const DROP_THRESHOLD = 200;

export type ForgettingAction = 'keep' | 'compress' | 'drop';

export function decideForgetting(input: ForgettingInput): ForgettingAction {
  const risk = forgettingRisk(input);
  if (risk >= DROP_THRESHOLD) return 'drop';
  if (risk >= COMPRESS_THRESHOLD) return 'compress';
  return 'keep';
}
