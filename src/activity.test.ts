import { describe, expect, it } from "vitest";
import { coinbaseProductFor, isCrossVenueConfirmed, SessionActivityTracker } from "./activity";

describe("live market helpers", () => {
  it("warms up before reporting a measured session-activity ratio", () => {
    const tracker = new SessionActivityTracker();
    expect(tracker.observe("ABCUSDT", 100).measured).toBe(false);
    tracker.observe("ABCUSDT", 110);
    tracker.observe("ABCUSDT", 120);
    tracker.observe("ABCUSDT", 130);
    const observation = tracker.observe("ABCUSDT", 180);
    expect(observation.measured).toBe(true);
    expect(observation.ratio).toBeGreaterThan(4);
  });

  it("maps Binance quote symbols to Coinbase USD products", () => {
    expect(coinbaseProductFor("BTCUSDT")).toBe("BTC-USD");
    expect(coinbaseProductFor("USDCUSDT")).toBeUndefined();
    expect(coinbaseProductFor("BTCUPUSDT")).toBeUndefined();
  });

  it("resets session activity when the rolling window volume falls", () => {
    const tracker = new SessionActivityTracker();
    tracker.observe("ABCUSDT", 100);
    tracker.observe("ABCUSDT", 120);
    expect(tracker.observe("ABCUSDT", 90).measured).toBe(false);
  });

  it("only confirms close cross-venue prices", () => {
    expect(isCrossVenueConfirmed(100, 100.5)).toBe(true);
    expect(isCrossVenueConfirmed(100, 103)).toBe(false);
    expect(isCrossVenueConfirmed(100)).toBe(false);
  });
});
