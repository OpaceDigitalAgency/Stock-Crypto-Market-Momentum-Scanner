import { fetchNasdaqCandles, fetchNasdaqStocks, fetchNasdaqSummary } from "./nasdaq";
import { fetchStockCandles, fetchTopStocks, type CandlePayload, type StocksPayload } from "./yahoo";

/**
 * Yahoo first (richer fields: relative volume, exact shares outstanding),
 * Nasdaq's own screener as the fallback when Yahoo rate-limits the caller —
 * common from shared datacenter IPs.
 */
export async function fetchStocksAnySource(): Promise<StocksPayload> {
  try {
    return await fetchTopStocks();
  } catch (yahooError) {
    try {
      return await enrichWithSummaries(await fetchNasdaqStocks());
    } catch {
      throw yahooError instanceof Error ? yahooError : new Error("No stock source responded");
    }
  }
}

// The Nasdaq screener lacks average volume, sector and industry; the quote
// summary provides all three, so the strongest candidates are enriched.
async function enrichWithSummaries(payload: StocksPayload): Promise<StocksPayload> {
  await Promise.all(payload.quotes.slice(0, 20).map(async (quote) => {
    try {
      const summary = await fetchNasdaqSummary(quote.symbol);
      if (summary.averageVolume && summary.averageVolume > 0) {
        quote.averageVolume = summary.averageVolume;
        quote.relativeVolume = quote.volume / summary.averageVolume;
      }
      quote.sector = summary.sector;
      quote.industry = summary.industry;
    } catch {
      // Enrichment is best-effort; the row still works without it.
    }
  }));
  return payload;
}

export async function fetchCandlesAnySource(symbol: string): Promise<CandlePayload> {
  try {
    return await fetchStockCandles(symbol);
  } catch (yahooError) {
    try {
      return await fetchNasdaqCandles(symbol);
    } catch {
      throw yahooError instanceof Error ? yahooError : new Error("No candle source responded");
    }
  }
}
