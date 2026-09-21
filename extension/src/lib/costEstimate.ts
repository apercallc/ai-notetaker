export type CostTier = "default" | "budget";

// These are deliberately estimates from README/spec, not promises about
// provider billing. Recheck provider pricing before each release.
const COST_PER_45_MINUTE_MEETING: Record<CostTier, number> = {
  default: 0.21,
  budget: 0.03,
};

export function estimateMeetingCost(tier: CostTier, minutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return (minutes / 45) * COST_PER_45_MINUTE_MEETING[tier];
}
