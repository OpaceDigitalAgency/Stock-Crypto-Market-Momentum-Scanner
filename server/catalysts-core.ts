import { createMemoryCatalystCache, lookupOfficialCatalysts, type CatalystSourceCache } from "../src/catalyst-service";
import type { CatalystReport } from "../src/catalyst-types";
import { fetchNasdaqNews } from "./nasdaq";
import { fetchSymbolNews } from "./yahoo";

async function fetchNewsAnySource(symbol: string) {
  try {
    return await fetchSymbolNews(symbol);
  } catch {
    return await fetchNasdaqNews(symbol);
  }
}

export interface CatalystHandlerOptions {
  secUserAgent?: string;
  cache: CatalystSourceCache;
}

export function createCatalystCache() {
  return createMemoryCatalystCache();
}

/**
 * Shared implementation for the Netlify function and the local dev server:
 * official SEC/Nasdaq evidence first, then recent news headlines for any
 * symbol without confirmed official evidence. News is labelled "reported",
 * never promoted to a confirmed official catalyst.
 */
export async function runCatalystLookup(body: unknown, options: CatalystHandlerOptions): Promise<CatalystReport[]> {
  const reports = await lookupOfficialCatalysts(body, {
    secUserAgent: options.secUserAgent,
    cache: options.cache
  });
  await Promise.all(reports.map(async (report) => {
    if (report.state === "confirmed") return;
    try {
      const news = await fetchNewsAnySource(report.symbol);
      if (news.count > 0) {
        report.news = { ...news, source: "yahoo-news", confidence: "reported" };
      }
    } catch {
      // Headlines are best-effort; official states are never affected.
    }
  }));
  return reports;
}
