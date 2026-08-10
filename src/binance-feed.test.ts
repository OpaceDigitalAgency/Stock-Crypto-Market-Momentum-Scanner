import { describe, expect, it } from "vitest";
import { BINANCE_MARKET_ENDPOINTS, parseBinanceMessage, selectMomentumSymbols, type BinanceCoverage } from "./binance-feed";
import { defaultFilters } from "./engine";

describe("Binance public market feed", () => {
  it("uses only current official WebSocket hosts", () => {
    expect(BINANCE_MARKET_ENDPOINTS).toContain("wss://data-stream.binance.vision/ws");
    expect(BINANCE_MARKET_ENDPOINTS.every((endpoint) => !endpoint.includes("!ticker@arr"))).toBe(true);
  });

  it("parses the supported all-market one-day ticker payload", () => {
    const message = parseBinanceMessage(JSON.stringify([
      { e: "1dTicker", E: 1_700_000_000_000, s: "BTCUSDT", c: "65000", P: "5.2", q: "500000000" }
    ]));
    expect(message.kind).toBe("universe");
  });

  it("parses per-symbol ticker bid and ask data", () => {
    const message = parseBinanceMessage(JSON.stringify({
      e: "24hrTicker", E: 1_700_000_000_000, s: "BTCUSDT", c: "65000", P: "5.2",
      q: "500000000", b: "64999.9", a: "65000.1"
    }));
    expect(message.kind).toBe("detail");
  });

  it("prioritises liquid movers and excludes stable and leveraged tokens", () => {
    const tickers = [
      { E: 1, s: "BTCUSDT", c: "65000", P: "6", q: "500000000" },
      { E: 1, s: "ETHUSDT", c: "3000", P: "2", q: "300000000" },
      { E: 1, s: "USDCUSDT", c: "1", P: "7", q: "800000000" },
      { E: 1, s: "BTCUPUSDT", c: "2", P: "40", q: "900000000" }
    ];
    expect(selectMomentumSymbols(tickers, defaultFilters.crypto, 2)).toEqual(["BTCUSDT", "ETHUSDT"]);
  });

  it("defines explicit whole-universe and capped-detail coverage", () => {
    const coverage: BinanceCoverage = { eligiblePairs: 420, detailPairs: 160, maximumDetailPairs: 160 };
    expect(coverage.detailPairs).toBeLessThan(coverage.eligiblePairs);
    expect(coverage.maximumDetailPairs).toBe(160);
  });
});
