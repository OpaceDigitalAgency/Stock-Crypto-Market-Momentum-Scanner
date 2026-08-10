import type { AssetClass, Candidate, Filters } from "./types";

export const defaultFilters: Record<AssetClass, Filters> = {
  stocks: {
    minPrice: 2,
    maxPrice: 20,
    minChange: 10,
    minChange5m: -100,
    minChange1h: -100,
    minRelativeVolume: 5,
    maxFloatMillions: 20,
    minQuoteVolumeMillions: 1,
    maxSpreadPercent: 2,
    requireCatalyst: false
  },
  crypto: {
    minPrice: 0,
    maxPrice: 1_000_000,
    minChange: 4,
    minChange5m: -100,
    minChange1h: -100,
    minRelativeVolume: 1,
    maxFloatMillions: 50_000,
    minQuoteVolumeMillions: 5,
    maxSpreadPercent: 0.8,
    requireCatalyst: false
  }
};

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));

export function scoreCandidate(candidate: Omit<Candidate, "score">, filters: Filters): number {
  const candidateValues = [candidate.price, candidate.changePercent, candidate.relativeVolume, candidate.volume, candidate.spreadPercent];
  const filterValues = [filters.minPrice, filters.maxPrice, filters.minChange, filters.minChange5m, filters.minChange1h, filters.minRelativeVolume, filters.maxFloatMillions, filters.minQuoteVolumeMillions, filters.maxSpreadPercent];
  if (![...candidateValues, ...filterValues].every(Number.isFinite)) return 0;
  const price = candidate.price >= filters.minPrice && candidate.price <= filters.maxPrice ? 10 : 0;
  const movementRatio = clamp(candidate.changePercent / Math.max(filters.minChange, 1), 0, 1);
  const activityRatio = clamp(candidate.relativeVolume / Math.max(filters.minRelativeVolume, 0.1), 0, 1);
  if (candidate.assetClass === "stocks") {
    const movement = movementRatio * 20;
    const volume = activityRatio * 20;
    const float = candidate.floatOrMarketCap !== null && candidate.floatOrMarketCap <= filters.maxFloatMillions ? 20 : 0;
    const catalyst = candidate.catalyst === "confirmed" ? 30 : candidate.catalyst === "unverified" ? 5 : 0;
    return Math.round(clamp(price + movement + volume + float + catalyst));
  }
  const movement = movementRatio * 25;
  const activity = activityRatio * 20;
  const liquidity = candidate.volume >= filters.minQuoteVolumeMillions * 1_000_000 && candidate.spreadPercent <= filters.maxSpreadPercent ? 15 : 0;
  const catalyst = candidate.catalyst === "confirmed" ? 20 : candidate.catalyst === "unverified" ? 5 : 0;
  const confirmation = candidate.crossVenue ? 10 : 0;
  return Math.round(clamp(price + movement + activity + liquidity + catalyst + confirmation));
}

export function matchesFilters(candidate: Candidate, filters: Filters): boolean {
  const candidateValues = [candidate.price, candidate.changePercent, candidate.relativeVolume, candidate.volume, candidate.spreadPercent];
  const filterValues = [filters.minPrice, filters.maxPrice, filters.minChange, filters.minChange5m, filters.minChange1h, filters.minRelativeVolume, filters.maxFloatMillions, filters.minQuoteVolumeMillions, filters.maxSpreadPercent];
  if (![...candidateValues, ...filterValues].every(Number.isFinite)) return false;
  if (candidate.price < filters.minPrice || candidate.price > filters.maxPrice) return false;
  if (candidate.changePercent < filters.minChange) return false;
  if (candidate.relativeVolume < filters.minRelativeVolume) return false;
  if (filters.requireCatalyst && candidate.catalyst !== "confirmed") return false;
  if (candidate.assetClass === "stocks" && candidate.floatOrMarketCap !== null && candidate.floatOrMarketCap > filters.maxFloatMillions) return false;
  if (candidate.assetClass === "crypto") {
    if (candidate.momentum5m !== null && candidate.momentum5m !== undefined && candidate.momentum5m < filters.minChange5m) return false;
    if (candidate.momentum1h !== null && candidate.momentum1h !== undefined && candidate.momentum1h < filters.minChange1h) return false;
    if (candidate.volume < filters.minQuoteVolumeMillions * 1_000_000) return false;
    if (candidate.spreadPercent > filters.maxSpreadPercent) return false;
  }
  return true;
}

export function calculatePlan(entry: number, stop: number, accountRisk: number, rewardMultiple = 2) {
  const riskPerUnit = entry - stop;
  if (![entry, stop, accountRisk, rewardMultiple, riskPerUnit].every(Number.isFinite) || entry <= 0 || stop < 0 || riskPerUnit <= 0 || accountRisk <= 0 || rewardMultiple <= 0) {
    return { valid: false, units: 0, target: 0, riskPerUnit: 0 };
  }
  const units = Math.floor(accountRisk / riskPerUnit);
  const target = entry + riskPerUnit * rewardMultiple;
  if (!Number.isFinite(units) || units < 1 || !Number.isFinite(target)) return { valid: false, units: 0, target: 0, riskPerUnit };
  return {
    valid: true,
    units,
    target,
    riskPerUnit
  };
}
