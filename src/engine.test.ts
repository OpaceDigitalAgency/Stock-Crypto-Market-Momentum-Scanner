import { describe, expect, it } from "vitest";
import { calculatePlan, defaultFilters, matchesFilters, scoreCandidate } from "./engine";

const candidate = {
  symbol: "TEST",
  name: "Test",
  assetClass: "stocks" as const,
  venue: "demo",
  price: 8,
  changePercent: 30,
  relativeVolume: 8,
  activityBasis: "demo" as const,
  volume: 10_000_000,
  floatOrMarketCap: 10,
  catalyst: "confirmed" as const,
  spreadPercent: 0.2,
  crossVenue: false,
  sourceTime: Date.now(),
  receiptTime: Date.now(),
  coverage: "demo" as const
};

describe("candidate engine", () => {
  it("scores a strong stock above a weak threshold", () => {
    expect(scoreCandidate(candidate, defaultFilters.stocks)).toBeGreaterThanOrEqual(80);
  });

  it("filters candidates outside the float ceiling", () => {
    expect(matchesFilters({ ...candidate, score: 80, floatOrMarketCap: 30 }, defaultFilters.stocks)).toBe(false);
  });

  it("calculates size and a two-R target", () => {
    expect(calculatePlan(10, 9.5, 50, 2)).toEqual({ valid: true, units: 100, target: 11, riskPerUnit: 0.5 });
  });

  it("rejects a stop above the entry", () => {
    expect(calculatePlan(10, 10.1, 50, 2).valid).toBe(false);
  });

  it("rejects a plan that cannot buy one unit inside the risk limit", () => {
    expect(calculatePlan(100, 1, 50, 2).valid).toBe(false);
  });

  it("rejects non-positive entries, negative stops and overflowing targets", () => {
    expect(calculatePlan(0, -1, 50, 2).valid).toBe(false);
    expect(calculatePlan(10, -1, 50, 2).valid).toBe(false);
    expect(calculatePlan(1e308, 0, 1e308, 2).valid).toBe(false);
  });

  it("rejects non-finite candidate data instead of allowing it through comparisons", () => {
    const malformed = { ...candidate, score: 0, price: Number.NaN };
    expect(matchesFilters(malformed, defaultFilters.stocks)).toBe(false);
    expect(scoreCandidate(malformed, defaultFilters.stocks)).toBe(0);
  });

  it("applies crypto liquidity and spread gates", () => {
    const crypto = { ...candidate, assetClass: "crypto" as const, score: 70, volume: 10_000_000, spreadPercent: 0.2 };
    expect(matchesFilters(crypto, { ...defaultFilters.crypto, minChange: 0, minRelativeVolume: 0 })).toBe(true);
    expect(matchesFilters({ ...crypto, spreadPercent: 2 }, defaultFilters.crypto)).toBe(false);
  });

  it("caps crypto at 80 when catalyst evidence is absent", () => {
    const crypto = {
      ...candidate,
      assetClass: "crypto" as const,
      score: 0,
      catalyst: "none" as const,
      crossVenue: true,
      changePercent: 50,
      relativeVolume: 20,
      volume: 1_000_000_000,
      spreadPercent: 0.01
    };
    expect(scoreCandidate(crypto, defaultFilters.crypto)).toBe(80);
  });
});
