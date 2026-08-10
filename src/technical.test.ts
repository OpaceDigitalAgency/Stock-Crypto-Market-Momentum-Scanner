import { describe, expect, it } from "vitest";
import { analysePullback, emaOf, vwapOf, type Candle } from "./technical";

function candle(open: number, high: number, low: number, close: number, volume: number, index: number): Candle {
  return { time: index * 60_000, open, high, low, close, volume };
}

function flatBase(count: number, price: number, volume = 1_000): Candle[] {
  return Array.from({ length: count }, (_, index) => candle(price, price + 0.02, price - 0.02, price, volume, index));
}

describe("vwapOf", () => {
  it("weights price by volume", () => {
    const candles: Candle[] = [candle(10, 10, 10, 10, 100, 0), candle(20, 20, 20, 20, 300, 1)];
    expect(vwapOf(candles)).toBeCloseTo(17.5);
  });
});

describe("emaOf", () => {
  it("converges towards recent closes", () => {
    const closes = [...Array.from({ length: 20 }, () => 10), ...Array.from({ length: 20 }, () => 12)];
    const ema = emaOf(closes, 9);
    expect(ema).toBeGreaterThan(11.5);
    expect(ema).toBeLessThanOrEqual(12);
  });
});

describe("analysePullback", () => {
  it("reports not enough data for short histories", () => {
    const result = analysePullback(flatBase(5, 10));
    expect(result.ready).toBe(false);
  });

  it("flags a healthy pullback resuming higher as an entry", () => {
    const candles = [
      ...flatBase(15, 10),
      candle(10, 10.6, 10, 10.6, 5_000, 15),
      candle(10.6, 11.2, 10.6, 11.2, 6_000, 16),
      candle(11.2, 11.9, 11.2, 11.9, 6_500, 17),
      candle(11.9, 11.9, 11.6, 11.65, 900, 18),
      candle(11.65, 11.7, 11.55, 11.6, 800, 19),
      candle(11.6, 11.85, 11.6, 11.8, 4_000, 20)
    ];
    const result = analysePullback(candles);
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.retracementPercent).toBeLessThanOrEqual(50);
      expect(result.breakingHigher).toBe(true);
      expect(result.verdict).toBe("entry");
      expect(result.pullbackLow).toBeCloseTo(11.55);
    }
  });

  it("flags a deep retracement as avoid", () => {
    const candles = [
      ...flatBase(15, 10),
      candle(10, 11, 10, 11, 5_000, 15),
      candle(11, 12, 11, 12, 6_000, 16),
      candle(12, 12, 10.4, 10.5, 7_000, 17),
      candle(10.5, 10.6, 10.3, 10.4, 6_000, 18)
    ];
    const result = analysePullback(candles);
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.retracementPercent).toBeGreaterThan(50);
      expect(result.verdict).toBe("avoid");
    }
  });

  it("detects a topping tail", () => {
    const candles = [
      ...flatBase(15, 10),
      candle(10, 10.5, 10, 10.5, 5_000, 15),
      candle(10.5, 11, 10.5, 11, 6_000, 16),
      candle(11, 12.5, 10.95, 11.05, 8_000, 17)
    ];
    const result = analysePullback(candles);
    expect(result.ready).toBe(true);
    if (result.ready) expect(result.toppingTail).toBe(true);
  });
});
