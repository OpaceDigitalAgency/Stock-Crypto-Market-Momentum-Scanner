import { createMemoryCatalystCache, lookupOfficialCatalysts, type CatalystSourceCache } from "../src/catalyst-service";
import type { CatalystReport } from "../src/catalyst-types";
import { fetchGoogleNews } from "./google-news";
import { classifyHeadline, isRoundupHeadline } from "./headlines";
import { fetchNasdaqNews } from "./nasdaq";
import { fetchSymbolNews } from "./yahoo";
import type { NewsMentions } from "../src/catalyst-types";

type NewsResult = Omit<NewsMentions, "source" | "confidence"> & { source: NewsMentions["source"] };

async function fetchNewsAnySource(symbol: string): Promise<NewsResult> {
  try {
    const news = await fetchGoogleNews(`${symbol} stock`);
    if (news.count > 0) return { ...news, source: "google-news" };
  } catch {
    // Fall through to the quote-provider news feeds.
  }
  try {
    const news = await fetchSymbolNews(symbol);
    return { ...annotate(news, symbol), source: "yahoo-news" };
  } catch {
    const news = await fetchNasdaqNews(symbol);
    return { ...annotate(news, symbol), source: "nasdaq-news" };
  }
}

function annotate<T extends { topTitle?: string }>(news: T, symbol: string): T & { kind?: string } {
  if (!news.topTitle) return { ...news, kind: undefined };
  const namesSubject = new RegExp(`(^|[^A-Za-z0-9])${symbol}([^A-Za-z0-9]|$)`, "i").test(news.topTitle);
  if (isRoundupHeadline(news.topTitle) || !namesSubject) return { ...news, kind: "Market roundup" };
  return { ...news, kind: classifyHeadline(news.topTitle) ?? undefined };
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
        report.news = { ...news, confidence: "reported" };
      }
    } catch {
      // Headlines are best-effort; official states are never affected.
    }
  }));
  return reports;
}
