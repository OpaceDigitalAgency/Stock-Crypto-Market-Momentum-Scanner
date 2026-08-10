import { describe, expect, it } from "vitest";
import { COINBASE_MARKET_ENDPOINT, parseCoinbasePrices } from "./coinbase-feed";

describe("Coinbase public confirmation feed", () => {
  it("uses the official Advanced Trade market-data endpoint", () => {
    expect(COINBASE_MARKET_ENDPOINT).toBe("wss://advanced-trade-ws.coinbase.com");
  });

  it("extracts valid ticker-batch prices", () => {
    const prices = parseCoinbasePrices(JSON.stringify({
      channel: "ticker_batch",
      events: [{ tickers: [{ product_id: "BTC-USD", price: "65012.25" }] }]
    }));
    expect(prices.get("BTC-USD")).toBe(65012.25);
  });

  it("does not treat heartbeat, malformed or non-positive values as prices", () => {
    expect(parseCoinbasePrices('{"channel":"heartbeats"}').size).toBe(0);
    expect(parseCoinbasePrices("not json").size).toBe(0);
    expect(parseCoinbasePrices(JSON.stringify({ channel: "ticker", events: [{ tickers: [{ product_id: "BTC-USD", price: "0" }] }] })).size).toBe(0);
  });
});
