import type { CandlePayload, StockQuote, StocksPayload, SymbolNews } from "./yahoo";

const NASDAQ_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "application/json",
  Origin: "https://www.nasdaq.com",
  Referer: "https://www.nasdaq.com/"
};

interface NasdaqRow {
  symbol?: string;
  name?: string;
  lastsale?: string;
  pctchange?: string;
  volume?: string;
  marketCap?: string;
}

function parseNumber(value: string | undefined): number | null {
  if (typeof value !== "string") return null;
  const cleaned = Number(value.replace(/[$,%\s,]/g, ""));
  return Number.isFinite(cleaned) ? cleaned : null;
}

function parsePercent(value: string | undefined): number | null {
  if (typeof value !== "string" || !/^-?[\d,]+(\.\d+)?%$/.test(value.trim())) return null;
  const percent = parseNumber(value);
  // Reject implausible day moves — some screener rows carry corrupt fields.
  return percent !== null && percent > -100 && percent < 2_000 ? percent : null;
}

/**
 * Fallback movers source: Nasdaq's own screener, which lists every US-listed
 * stock with intraday last sale, day change, volume and market cap. Average
 * volume is not provided, so relative volume is reported as unknown, and
 * shares in issue are estimated from market cap divided by price.
 */
export async function fetchNasdaqStocks(): Promise<StocksPayload> {
  const response = await fetch("https://api.nasdaq.com/api/screener/stocks?tableonly=false&limit=25&download=true", {
    headers: NASDAQ_HEADERS,
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`Nasdaq screener responded ${response.status}`);
  const payload = await response.json() as { data?: { rows?: NasdaqRow[] } };
  const rows = payload.data?.rows ?? [];
  const now = Date.now();
  const quotes: StockQuote[] = [];
  for (const row of rows) {
    const symbol = typeof row.symbol === "string" ? row.symbol.trim().toUpperCase() : "";
    const price = parseNumber(row.lastsale);
    const changePercent = parsePercent(row.pctchange);
    if (!symbol || !/^[A-Z0-9.-]{1,10}$/.test(symbol) || price === null || price <= 0 || changePercent === null) continue;
    const volume = parseNumber(row.volume) ?? 0;
    const marketCap = parseNumber(row.marketCap);
    quotes.push({
      symbol,
      name: typeof row.name === "string" ? row.name.replace(/ Common Stock$| Class [A-Z].*$/i, "") : symbol,
      price,
      changePercent,
      volume,
      averageVolume: 0,
      relativeVolume: 0,
      sharesOutstandingMillions: marketCap !== null && marketCap > 0 ? marketCap / price / 1_000_000 : null,
      marketCapMillions: marketCap !== null ? marketCap / 1_000_000 : null,
      exchange: "US",
      marketState: "REGULAR",
      delayMinutes: 0,
      sourceTime: now,
      quoteSource: "Nasdaq screener"
    });
  }
  quotes.sort((a, b) => b.changePercent - a.changePercent);
  return { quotes: quotes.slice(0, 150), fetchedAt: now, screens: ["nasdaq-screener"], source: "nasdaq" };
}

export interface NasdaqSummary {
  averageVolume: number | null;
  sector?: string;
  industry?: string;
}

const summaryCache = new Map<string, { value: NasdaqSummary; at: number }>();
const SUMMARY_CACHE_MS = 60 * 60_000;

/**
 * Per-symbol context from Nasdaq's quote summary: recent average volume
 * (restores the relative-volume pillar) plus sector and industry.
 */
export async function fetchNasdaqSummary(symbol: string): Promise<NasdaqSummary> {
  const clean = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,12}$/.test(clean)) throw new Error("Invalid symbol");
  const cached = summaryCache.get(clean);
  if (cached && Date.now() - cached.at < SUMMARY_CACHE_MS) return cached.value;
  const response = await fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(clean)}/summary?assetclass=stocks`, {
    headers: NASDAQ_HEADERS,
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`Nasdaq summary responded ${response.status}`);
  const payload = await response.json() as { data?: { summaryData?: { AverageVolume?: { value?: string }; Sector?: { value?: string }; Industry?: { value?: string } } } };
  const summary = payload.data?.summaryData;
  const value: NasdaqSummary = {
    averageVolume: parseNumber(summary?.AverageVolume?.value),
    sector: summary?.Sector?.value || undefined,
    industry: summary?.Industry?.value || undefined
  };
  summaryCache.set(clean, { value, at: Date.now() });
  return value;
}

/**
 * Nasdaq's intraday chart provides price points without OHLC or volume, so
 * candles are synthesised (open = previous point) and marked "price-only".
 */
export async function fetchNasdaqCandles(symbol: string): Promise<CandlePayload> {
  const clean = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,12}$/.test(clean)) throw new Error("Invalid symbol");
  const response = await fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(clean)}/chart?assetclass=stocks`, {
    headers: NASDAQ_HEADERS,
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Nasdaq chart responded ${response.status}`);
  const payload = await response.json() as { data?: { chart?: { x?: number; y?: number }[] } };
  const points = (payload.data?.chart ?? []).filter((point): point is { x: number; y: number } =>
    typeof point.x === "number" && typeof point.y === "number" && Number.isFinite(point.y) && point.y > 0);
  const candles: CandlePayload["candles"] = [];
  for (let index = 1; index < points.length; index += 1) {
    const open = points[index - 1].y;
    const close = points[index].y;
    candles.push({
      time: points[index].x,
      open,
      close,
      high: Math.max(open, close),
      low: Math.min(open, close),
      volume: 0
    });
  }
  return { symbol: clean, candles, fetchedAt: Date.now(), precision: "price-only" };
}

interface NasdaqNewsRow {
  title?: string;
  ago?: string;
  publisher?: string;
  url?: string;
}

const RECENT_AGO = /^(\d+)\s+(minute|hour)s?\s+ago$/i;

export async function fetchNasdaqNews(symbol: string): Promise<SymbolNews> {
  const clean = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,12}$/.test(clean)) throw new Error("Invalid symbol");
  const response = await fetch(`https://api.nasdaq.com/api/news/topic/articlebysymbol?q=${encodeURIComponent(clean)}|STOCKS&offset=0&limit=8`, {
    headers: NASDAQ_HEADERS,
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Nasdaq news responded ${response.status}`);
  const payload = await response.json() as { data?: { rows?: NasdaqNewsRow[] } };
  // Only same-day stories count as a possible reason for today's move.
  const recent = (payload.data?.rows ?? []).filter((row) => typeof row.title === "string" && typeof row.ago === "string" && RECENT_AGO.test(row.ago.trim()));
  const top = recent[0];
  return {
    count: recent.length,
    topTitle: top?.title,
    topUrl: typeof top?.url === "string" && top.url.startsWith("/") ? `https://www.nasdaq.com${top.url}` : top?.url,
    publisher: top?.publisher,
    publishedAt: undefined
  };
}
