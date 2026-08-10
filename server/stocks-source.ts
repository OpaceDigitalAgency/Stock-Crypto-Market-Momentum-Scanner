import { fetchNasdaqCandles, fetchNasdaqStocks } from "./nasdaq";
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
      return await fetchNasdaqStocks();
    } catch {
      throw yahooError instanceof Error ? yahooError : new Error("No stock source responded");
    }
  }
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
