import { describe, expect, it } from "vitest";
import {
  BINANCE_PUBLIC_REST_ENDPOINT,
  buildBinanceDetailStreams,
  buildBinanceKlinesUrl,
  buildCryptoMarketSnapshot,
  calculateLiquidity,
  calculateMeasuredActivity,
  calculateMomentum,
  confirmAcrossVenues,
  parseBinanceKlines,
  parseBinancePartialBook,
  type BinanceCandle,
  type VenueQuote
} from "./crypto-market-data";

const now = Date.UTC(2026, 7, 10, 12, 0, 0);
const interval = 5 * 60 * 1_000;

function candles(count = 301): BinanceCandle[] {
  return Array.from({ length: count }, (_, index) => {
    const openTime = now - (count - index) * interval;
    const close = 100 + index;
    return {
      openTime,
      closeTime: openTime + interval - 1,
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      baseVolume: 10 + index,
      quoteVolume: index === count - 1 ? 2_000 : 1_000
    };
  });
}

function quote(venue: "Binance" | "Coinbase", price: number, ageMs = 500): VenueQuote {
  return {
    venue,
    pair: venue === "Binance" ? "BTCUSDT" : "BTC-USD",
    price,
    sourceTime: now - ageMs,
    receiptTime: now - Math.max(0, ageMs - 100)
  };
}

describe("crypto public market-data integration helpers", () => {
  it("builds no-key Binance candle and detail stream requests", () => {
    expect(buildBinanceKlinesUrl("btcusdt", 300)).toBe(`${BINANCE_PUBLIC_REST_ENDPOINT}/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=300`);
    expect(buildBinanceDetailStreams("BTCUSDT")).toEqual([
      "btcusdt@bookTicker",
      "btcusdt@depth20@100ms",
      "btcusdt@kline_5m",
      "btcusdt@ticker_1h",
      "btcusdt@ticker_1d"
    ]);
  });

  it("rejects unsafe symbols and clamps the REST limit", () => {
    expect(() => buildBinanceKlinesUrl("BTC/USDT")).toThrow("Invalid Binance symbol");
    expect(buildBinanceKlinesUrl("BTCUSDT", 9)).toContain("limit=14");
    expect(buildBinanceKlinesUrl("BTCUSDT", 2_000)).toContain("limit=1000");
  });

  it("parses valid Binance klines and discards malformed rows", () => {
    const parsed = parseBinanceKlines([
      [300_000, "101", "103", "99", "102", "7", 599_999, "710", 4, "3", "0", "0"],
      [0, "bad", "2", "1", "1", "1", 299_999, "1"]
    ]);
    expect(parsed).toEqual([expect.objectContaining({ openTime: 300_000, close: 102, quoteVolume: 710 })]);
    expect(parseBinanceKlines({ error: "rate limited" })).toEqual([]);
  });

  it("measures 5-minute, 1-hour and 24-hour momentum from completed candles", () => {
    const rows = candles();
    const current = quote("Binance", 405);
    const fiveMinutes = calculateMomentum(rows, current, interval, now);
    const oneHour = calculateMomentum(rows, current, 60 * 60 * 1_000, now);
    const oneDay = calculateMomentum(rows, current, 24 * 60 * 60 * 1_000, now);
    expect(fiveMinutes.state).toBe("available");
    expect(oneHour.state).toBe("available");
    expect(oneDay.state).toBe("available");
    expect(fiveMinutes.value?.measuredWindowMs).toBeGreaterThan(0);
    expect(oneHour.value!.percent).toBeGreaterThan(fiveMinutes.value!.percent);
    expect(oneDay.value!.referenceTime).toBeLessThan(oneHour.value!.referenceTime);
  });

  it("fails closed when momentum history is insufficient or the quote is stale", () => {
    expect(calculateMomentum(candles(3), quote("Binance", 103), 24 * 60 * 60 * 1_000, now).state).toBe("unavailable");
    const result = calculateMomentum(candles(), quote("Binance", 405, 20_000), interval, now);
    expect(result.state).toBe("stale");
    expect(result.reason).toContain("seconds old");
  });

  it("reports measured activity against completed candle history, not session RVOL", () => {
    const result = calculateMeasuredActivity(candles(14), now, { activityBaselineCandles: 12, candleStaleAfterMs: 10 * 60 * 1_000 });
    expect(result.state).toBe("available");
    expect(result.value).toEqual(expect.objectContaining({ ratio: 2, baselineCandles: 12, intervalMinutes: 5 }));
    expect(result.methodology).toContain("median");
  });

  it("does not fabricate an activity ratio without enough valid history", () => {
    const result = calculateMeasuredActivity(candles(5), now, { activityBaselineCandles: 12, candleStaleAfterMs: 10 * 60 * 1_000 });
    expect(result.state).toBe("unavailable");
    expect(result.value).toBeUndefined();
  });

  it("parses and measures visible Binance depth within a stated band", () => {
    const book = parseBinancePartialBook({
      lastUpdateId: 42,
      bids: [["99.99", "200"], ["99.70", "500"]],
      asks: [["100.01", "220"], ["100.30", "500"]]
    }, "BTCUSDT", now - 300, now - 200);
    const result = calculateLiquidity(book, now, {
      bookStaleAfterMs: 5_000,
      maximumSpreadPercent: 0.1,
      minimumDepthPerSideQuote: 10_000,
      depthBandBasisPoints: 25
    });
    expect(result.state).toBe("available");
    expect(result.value?.passes).toBe(true);
    expect(result.value?.bidDepthQuote).toBeCloseTo(19_998);
    expect(result.value?.askDepthQuote).toBeCloseTo(22_002.2);
    expect(result.methodology).toContain("not full-market depth");
  });

  it("marks old depth stale and a crossed book unavailable", () => {
    const stale = parseBinancePartialBook({ bids: [["99", "10"]], asks: [["101", "10"]] }, "BTCUSDT", now - 10_000, now - 9_900);
    expect(calculateLiquidity(stale, now).state).toBe("stale");
    const crossed = parseBinancePartialBook({ bids: [["102", "10"]], asks: [["101", "10"]] }, "BTCUSDT", now, now);
    expect(calculateLiquidity(crossed, now).state).toBe("unavailable");
  });

  it("confirms only fresh, close cross-venue prices", () => {
    const confirmed = confirmAcrossVenues(quote("Binance", 100), quote("Coinbase", 100.4), now);
    expect(confirmed.state).toBe("available");
    expect(confirmed.value).toEqual(expect.objectContaining({ confirmed: true, differenceBasisPoints: expect.closeTo(40, 6) }));

    const divergent = confirmAcrossVenues(quote("Binance", 100), quote("Coinbase", 102), now);
    expect(divergent.state).toBe("available");
    expect(divergent.value?.confirmed).toBe(false);

    const stale = confirmAcrossVenues(quote("Binance", 100), quote("Coinbase", 100, 30_000), now);
    expect(stale.state).toBe("stale");
    expect(confirmAcrossVenues(quote("Binance", 100), undefined, now).state).toBe("unavailable");
  });

  it("builds a complete snapshot while keeping catalyst and market cap unavailable", () => {
    const book = parseBinancePartialBook({ bids: [["404", "50"]], asks: [["406", "50"]] }, "BTCUSDT", now - 300, now - 200);
    const snapshot = buildCryptoMarketSnapshot({
      symbol: "BTCUSDT",
      now,
      candles: candles(),
      binanceQuote: quote("Binance", 405),
      coinbaseQuote: quote("Coinbase", 405.5),
      binanceBook: book
    });
    expect(snapshot.momentum.fiveMinutes.state).toBe("available");
    expect(snapshot.activity.state).toBe("available");
    expect(snapshot.liquidity.state).toBe("available");
    expect(snapshot.crossVenue.state).toBe("available");
    expect(snapshot.marketCap.state).toBe("unavailable");
    expect(snapshot.marketCap.value).toBeUndefined();
    expect(snapshot.catalyst.state).toBe("unavailable");
    expect(snapshot.catalyst.value).toBeUndefined();
  });
});
