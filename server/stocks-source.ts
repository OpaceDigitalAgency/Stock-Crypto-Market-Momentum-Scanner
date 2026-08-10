import { fetchNasdaqStocks } from "./nasdaq";
import { fetchTopStocks, type StocksPayload } from "./yahoo";

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
