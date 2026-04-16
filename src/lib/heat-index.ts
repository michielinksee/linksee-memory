// Ported from sales-intelligence-os/lib/heat-index.ts (human-facing names → agent-memory names).
// Drives "importance hierarchy" (Michie's memory principle 3).

export type HeatBand = 'hot' | 'warm' | 'cold' | 'frozen';

export interface HeatInput {
  accessesLast30d: number;
  accessesLast90d: number;
  daysSinceLastAccess: number;
  totalAccesses: number;
  baseImportance?: number; // 0.0-1.0 user-specified importance override
}

export interface HeatResult {
  score: number; // 0-100
  band: HeatBand;
}

export function computeHeat(input: HeatInput): HeatResult {
  const last30 = Math.min(input.accessesLast30d * 3, 30);
  const last90 = Math.min(input.accessesLast90d * 1, 20);

  let recencyBonus = 0;
  if (input.daysSinceLastAccess <= 7) recencyBonus = 20;
  else if (input.daysSinceLastAccess <= 30) recencyBonus = 10;
  else if (input.daysSinceLastAccess <= 90) recencyBonus = 0;
  else recencyBonus = -10;

  const tenureBonus = Math.min(input.totalAccesses * 0.5, 15);
  const importanceBoost = (input.baseImportance ?? 0.5) * 15; // 0-15 extra from user mark

  const score = Math.max(0, Math.min(100, last30 + last90 + recencyBonus + tenureBonus + importanceBoost));

  let band: HeatBand;
  if (score >= 70) band = 'hot';
  else if (score >= 40) band = 'warm';
  else if (score >= 20) band = 'cold';
  else band = 'frozen';

  return { score, band };
}
