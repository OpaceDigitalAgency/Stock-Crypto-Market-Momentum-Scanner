import type { CatalystEvidence } from "./catalyst-types";

export const NASDAQ_HALTS_URL = "https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts";
export const NASDAQ_HALTS_PAGE = "https://www.nasdaqtrader.com/Trader.aspx?id=TradeHalts";

function decodeXml(value: string) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .trim();
}

function field(item: string, name: string) {
  const match = item.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${name}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

export function parseNasdaqHalts(xml: string, receivedAt: string): CatalystEvidence[] {
  if (!/<rss\b/i.test(xml) || !/<channel>/i.test(xml)) throw new Error("Nasdaq halt feed is not valid RSS");
  const evidence: CatalystEvidence[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = match[1];
    const symbol = field(item, "ndaq:IssueSymbol").toUpperCase();
    const publishedAt = field(item, "pubDate");
    const haltDate = field(item, "ndaq:HaltDate");
    const haltTime = field(item, "ndaq:HaltTime");
    const reasonCode = field(item, "ndaq:ReasonCode");
    const issueName = field(item, "ndaq:IssueName");
    const market = field(item, "ndaq:Market");
    if (!/^[A-Z0-9.-]{1,15}$/.test(symbol) || !publishedAt || Number.isNaN(Date.parse(publishedAt))) continue;
    evidence.push({
      id: `nasdaq-halt-${symbol}-${haltDate}-${haltTime}`,
      symbol,
      source: "nasdaq-halts",
      sourceLabel: "Nasdaq Trader",
      kind: "trading-halt",
      title: `${symbol} trading halt`,
      summary: `${issueName || symbol} · ${market || "US market"} · reason ${reasonCode || "not supplied"}`,
      url: NASDAQ_HALTS_PAGE,
      publishedAt: new Date(publishedAt).toISOString(),
      receivedAt,
      confidence: "official",
      metadata: { haltDate, haltTime, reasonCode, market }
    });
  }
  return evidence;
}

