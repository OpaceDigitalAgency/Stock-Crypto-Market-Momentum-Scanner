import type { StockQuote, StocksPayload, SymbolNews } from "./yahoo";

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
