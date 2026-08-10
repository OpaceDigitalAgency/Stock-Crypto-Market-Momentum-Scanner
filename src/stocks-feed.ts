import type { Candidate } from "./types";

export interface StockQuotePayload {
  symbol: string;
  name: string;
  price: number;
  changePercent: number;
  volume: number;
  averageVolume: number;
  relativeVolume: number;
  sharesOutstandingMillions: number | null;
  marketCapMillions: number | null;
  exchange: string;
  marketState: string;
  delayMinutes: number;
  sourceTime: number;
  quoteSource: string;
}

export interface StocksResponse {
  quotes: StockQuotePayload[];
  fetchedAt: number;
  screens: string[];
}

export type StocksStatus = "loading" | "live" | "error";

const POLL_MS = 45_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export function mapStockQuote(quote: StockQuotePayload, receiptTime: number): Omit<Candidate, "score"> {
  return {
    symbol: quote.symbol,
    name: quote.name,
    assetClass: "stocks",
    venue: quote.exchange,
    price: quote.price,
    changePercent: quote.changePercent,
    relativeVolume: quote.relativeVolume,
    activityBasis: "historical",
    volume: quote.volume,
    floatOrMarketCap: quote.sharesOutstandingMillions,
    catalyst: "none",
    spreadPercent: 0,
    crossVenue: false,
    sourceTime: quote.sourceTime || receiptTime,
    receiptTime,
    coverage: quote.delayMinutes > 0 ? "delayed" : "single-venue",
    dataMode: quote.delayMinutes > 0 ? `Delayed ${quote.delayMinutes} min` : quote.quoteSource,
    marketState: quote.marketState
  };
}

export class StocksFeed {
  private timer?: number;
  private stopped = false;
  private delay = POLL_MS;

  constructor(
    private readonly onQuotes: (quotes: StockQuotePayload[], fetchedAt: number) => void,
    private readonly onStatus: (status: StocksStatus, detail?: string) => void
  ) {}

  start() {
    this.stopped = false;
    this.onStatus("loading");
    void this.poll();
  }

  stop() {
    this.stopped = true;
    if (this.timer) window.clearTimeout(this.timer);
  }

  private async poll() {
    if (this.stopped) return;
    try {
      const response = await fetch("/api/stocks");
      if (!response.ok) throw new Error(`Stock source responded ${response.status}`);
      const payload = await response.json() as StocksResponse;
      if (!Array.isArray(payload.quotes)) throw new Error("Stock source returned an unexpected shape");
      this.onQuotes(payload.quotes, payload.fetchedAt ?? Date.now());
      this.onStatus("live");
      this.delay = POLL_MS;
    } catch (error) {
      this.onStatus("error", error instanceof Error ? error.message : "Stock source unavailable");
      this.delay = Math.min(this.delay * 2, MAX_BACKOFF_MS);
    }
    if (!this.stopped) this.timer = window.setTimeout(() => void this.poll(), this.delay);
  }
}

export async function fetchCandles(symbol: string) {
  const response = await fetch(`/api/candles?symbol=${encodeURIComponent(symbol)}`);
  if (!response.ok) throw new Error(`Candle source responded ${response.status}`);
  return await response.json() as { symbol: string; candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[] };
}
