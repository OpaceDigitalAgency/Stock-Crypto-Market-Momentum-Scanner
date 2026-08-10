const YAHOO_HOSTS = ["https://query2.finance.yahoo.com", "https://query1.finance.yahoo.com"];
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function fetchWithHostFallback(path: string): Promise<Response> {
  let lastError: Error = new Error("No Yahoo host responded");
  for (const host of YAHOO_HOSTS) {
    try {
      const response = await fetch(`${host}${path}`, { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } });
      if (response.ok) return response;
      lastError = new Error(`Yahoo responded ${response.status}`);
      if (response.status !== 429 && response.status < 500) return response;
    } catch (error) {
      lastError = error instanceof Error ? error : lastError;
    }
  }
  throw lastError;
}

export interface StockQuote {
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

export interface StocksPayload {
  quotes: StockQuote[];
  fetchedAt: number;
  screens: string[];
  source: "yahoo-finance";
}

export interface CandlePayload {
  symbol: string;
  candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[];
  fetchedAt: number;
}

interface RawQuote { [key: string]: unknown }

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normaliseQuote(raw: RawQuote): StockQuote | null {
  const symbol = typeof raw.symbol === "string" ? raw.symbol : null;
  const price = toNumber(raw.regularMarketPrice);
  const changePercent = toNumber(raw.regularMarketChangePercent);
  if (!symbol || price === null || changePercent === null) return null;
  if (raw.quoteType !== "EQUITY" || raw.region !== "US") return null;
  const volume = toNumber(raw.regularMarketVolume) ?? 0;
  const averageVolume = toNumber(raw.averageDailyVolume3Month) ?? toNumber(raw.averageDailyVolume10Day) ?? 0;
  const shares = toNumber(raw.sharesOutstanding) ?? toNumber(raw.impliedSharesOutstanding);
  const marketCap = toNumber(raw.marketCap);
  return {
    symbol,
    name: typeof raw.shortName === "string" ? raw.shortName : typeof raw.longName === "string" ? raw.longName : symbol,
    price,
    changePercent,
    volume,
    averageVolume,
    relativeVolume: averageVolume > 0 ? volume / averageVolume : 0,
    sharesOutstandingMillions: shares !== null ? shares / 1_000_000 : null,
    marketCapMillions: marketCap !== null ? marketCap / 1_000_000 : null,
    exchange: typeof raw.fullExchangeName === "string" ? raw.fullExchangeName : "US",
    marketState: typeof raw.marketState === "string" ? raw.marketState : "UNKNOWN",
    delayMinutes: toNumber(raw.exchangeDataDelayedBy) ?? 0,
    sourceTime: (toNumber(raw.regularMarketTime) ?? 0) * 1_000,
    quoteSource: typeof raw.quoteSourceName === "string" ? raw.quoteSourceName : "Yahoo Finance"
  };
}

async function fetchScreen(screenId: string, count: number): Promise<RawQuote[]> {
  const response = await fetchWithHostFallback(`/v1/finance/screener/predefined/saved?formatted=false&scrIds=${screenId}&count=${count}`);
  if (!response.ok) throw new Error(`Yahoo screen ${screenId} responded ${response.status}`);
  const payload = await response.json() as { finance?: { result?: { quotes?: RawQuote[] }[] } };
  return payload.finance?.result?.[0]?.quotes ?? [];
}

const SCREENS = ["day_gainers", "small_cap_gainers"];

export async function fetchTopStocks(): Promise<StocksPayload> {
  const results = await Promise.allSettled(SCREENS.map((screen) => fetchScreen(screen, 100)));
  const merged = new Map<string, StockQuote>();
  const succeeded: string[] = [];
  results.forEach((result, index) => {
    if (result.status !== "fulfilled") return;
    succeeded.push(SCREENS[index]);
    for (const raw of result.value) {
      const quote = normaliseQuote(raw);
      if (quote && !merged.has(quote.symbol)) merged.set(quote.symbol, quote);
    }
  });
  if (!succeeded.length) throw new Error("No Yahoo screen responded");
  const quotes = [...merged.values()].sort((a, b) => b.changePercent - a.changePercent);
  return { quotes, fetchedAt: Date.now(), screens: succeeded, source: "yahoo-finance" };
}

export interface SymbolNews {
  count: number;
  topTitle?: string;
  topUrl?: string;
  publisher?: string;
  publishedAt?: string;
}

const NEWS_MAX_AGE_MS = 36 * 3_600_000;

export async function fetchSymbolNews(symbol: string): Promise<SymbolNews> {
  const clean = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(clean)) throw new Error("Invalid symbol");
  const response = await fetchWithHostFallback(`/v1/finance/search?q=${encodeURIComponent(clean)}&newsCount=8&quotesCount=0&enableFuzzyQuery=false`);
  if (!response.ok) throw new Error(`Yahoo news responded ${response.status}`);
  const payload = await response.json() as { news?: { title?: string; link?: string; publisher?: string; providerPublishTime?: number }[] };
  const now = Date.now();
  const recent = (payload.news ?? []).filter((item) =>
    typeof item.title === "string"
    && typeof item.providerPublishTime === "number"
    && now - item.providerPublishTime * 1_000 < NEWS_MAX_AGE_MS
  );
  const top = recent[0];
  return {
    count: recent.length,
    topTitle: top?.title,
    topUrl: typeof top?.link === "string" ? top.link : undefined,
    publisher: top?.publisher,
    publishedAt: top?.providerPublishTime ? new Date(top.providerPublishTime * 1_000).toISOString() : undefined
  };
}

export async function fetchStockCandles(symbol: string): Promise<CandlePayload> {
  if (!/^[A-Z0-9.\-]{1,12}$/i.test(symbol)) throw new Error("Invalid symbol");
  const response = await fetchWithHostFallback(`/v8/finance/chart/${encodeURIComponent(symbol.toUpperCase())}?interval=1m&range=1d&includePrePost=true`);
  if (!response.ok) throw new Error(`Yahoo chart responded ${response.status}`);
  const payload = await response.json() as {
    chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] } }[] };
  };
  const result = payload.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  const candles: CandlePayload["candles"] = [];
  timestamps.forEach((time, index) => {
    const open = quote?.open?.[index];
    const high = quote?.high?.[index];
    const low = quote?.low?.[index];
    const close = quote?.close?.[index];
    const volume = quote?.volume?.[index];
    if ([open, high, low, close].every((value) => typeof value === "number" && Number.isFinite(value))) {
      candles.push({ time: time * 1_000, open: open as number, high: high as number, low: low as number, close: close as number, volume: typeof volume === "number" ? volume : 0 });
    }
  });
  return { symbol: symbol.toUpperCase(), candles, fetchedAt: Date.now() };
}
